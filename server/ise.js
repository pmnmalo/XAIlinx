// Xilinx ISE 14.7 command-line flow for the FPGA families ISE supports (see UG628 "Command Line Tools User Guide").
//
// generateBuild() creates <project>/build/ containing:
//   src/...            copies of the design sources (so the dir is self-contained for docker/ssh)
//   <top>.prj          XST mixed-language project file
//   <top>.xst          XST script
//   <top>.ucf          constraints (copied from project.constraints)
//   <top>.ut           bitgen options
//   run.sh             full flow: xst -> ngdbuild -> map -> par -> trce -> bitgen (steps selectable)
//
// runImplementation() runs run.sh in the configured toolchain mode (local/docker/ssh) inside a
// job, then parses the reports into build/reports.json.

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { deviceFamily } from '../core/family.js';
import { compile, elaborate } from '../core/compile.js';
import { parseUcf, bitName } from '../core/ucf.js';
import { clocksOf, latchGates } from '../core/schematic.js';
import { primitiveSources } from '../core/unisim.js';
import { spawn } from 'node:child_process';
import { runCommand, JobCancelled } from './jobs.js';
import { loadConfig, detectIse, iseStatus, which } from './toolchain.js';
import { validateDevice } from './devices.js';
import { parseBitHeader } from './programmer.js';

// the default flow (an empty request runs these)
export const STEPS = ['synth', 'translate', 'map', 'par', 'trce', 'bitgen', 'prombit'];
// every step, in execution order: the default flow plus the optional ones
//   postsynth / posttrans / postmap / postpar : simulation models (netgen -sim, VHDL) of each stage
//   pin2ucf : back-annotated pin locations (the pins the tools chose) ; xpwr : text power report
export const ALL_STEPS = ['synth', 'postsynth', 'translate', 'posttrans', 'map', 'postmap', 'par', 'trce', 'postpar', 'pin2ucf', 'xpwr', 'bitgen', 'prombit', 'fpgaview'];
const STEP_ALIASES = { xst: 'synth', synthesize: 'synth', ngdbuild: 'translate', place: 'par', route: 'par', timing: 'trce', bit: 'bitgen', bitstream: 'bitgen', prom: 'prombit', netgen: 'postsynth', power: 'xpwr', xdl: 'fpgaview' };
/** Simulation model written by each netgen step (relative to the build directory). */
export const SIM_MODELS = {
  postsynth: (top) => `netgen/synthesis/${top}_synthesis.vhd`,
  posttrans: (top) => `netgen/translate/${top}_translate.vhd`,
  postmap: (top) => `netgen/map/${top}_map.vhd`,
  postpar: (top) => `netgen/par/${top}_timesim.vhd`,
};

/** POSIX single-quote a string for the shell. */
export function shQuote(s) {
  s = String(s);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Normalise a requested step list (default: everything). trce runs whenever par runs. */
export function normalizeSteps(steps) {
  if (typeof steps === 'string') steps = [steps];
  if (!steps || !steps.length) return [...STEPS];
  const set = new Set();
  for (const s of steps) {
    const k = STEP_ALIASES[String(s).toLowerCase()] || String(s).toLowerCase();
    if (!ALL_STEPS.includes(k)) throw Object.assign(new Error(`unknown step '${s}' (valid: ${ALL_STEPS.join(', ')})`), { status: 400 });
    set.add(k);
  }
  if (set.has('par')) set.add('trce');
  if (set.has('bitgen')) set.add('prombit'); // flash-boot bitstream alongside the JTAG one
  return ALL_STEPS.filter(s => set.has(s));
}

/** Part strings: XST wants xc3s500e-4-fg320, ngdbuild/map accept xc3s500e-fg320-4. */
export function partStrings(device) {
  const part = String(device.part).trim().toLowerCase();
  const pkg = String(device.package).trim().toLowerCase();
  const speed = String(device.speed).trim().startsWith('-') ? String(device.speed).trim() : `-${String(device.speed).trim()}`;
  // these strings go into run.sh and the tools' command lines: only well-formed values pass
  if (!/^x[a-z0-9]+$/.test(part) || !/^[a-z]+[0-9]+$/.test(pkg) || !/^-[0-9][a-z0-9]?$/i.test(speed)) {
    throw Object.assign(new Error(`invalid device '${device.part}' / '${device.package}' / '${device.speed}'`), { status: 400 });
  }
  return { xst: `${part}${speed}-${pkg}`, impl: `${part}-${pkg}${speed}`, speedNum: speed.slice(1), speed, bitPart: `${part.replace(/^xc/, '')}${pkg}` };
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Contents of the XST .prj file. `files` = [{ lang, buildPath }] with paths relative to build/. */
export function generatePrj(files) {
  return files.map(f => `${f.lang === 'vhdl' ? 'vhdl' : 'verilog'} work "${f.buildPath}"`).join('\n') + '\n';
}

/** Contents of the XST script. */
export function generateXst({ top, device, impl = {}, includeDirs = [] }) {
  const ps = partStrings(device);
  const optMode = /^area$/i.test(impl.optMode || '') ? 'Area' : 'Speed';
  const optLevel = String(impl.optLevel) === '2' ? 2 : 1;
  const opts = [
    ['ifn', `${top}.prj`],
    ['ifmt', 'mixed'],
    ['ofn', top],
    ['ofmt', 'NGC'],
    ['p', ps.xst],
    ['top', top],
    ['opt_mode', optMode],
    ['opt_level', optLevel],
    ['iuc', 'NO'],
    ['keep_hierarchy', 'No'],
    ['netlist_hierarchy', 'As_Optimized'],
    ['rtlview', 'Yes'],
    ['glob_opt', 'AllClockNets'],
    ['read_cores', 'YES'],
    ['write_timing_constraints', 'NO'],
    ['cross_clock_analysis', 'NO'],
    ['hierarchy_separator', '/'],
    ['bus_delimiter', '<>'],
    ['case', 'Maintain'],
    ['slice_utilization_ratio', 100],
    ['bram_utilization_ratio', 100],
    ['verilog2001', 'YES'],
    ['fsm_extract', 'YES'], ['fsm_encoding', 'Auto'],
    ['safe_implementation', 'No'],
    ['fsm_style', 'LUT'],
    ['ram_extract', 'Yes'], ['ram_style', 'Auto'],
    ['rom_extract', 'Yes'], ['rom_style', 'Auto'],
    ['shreg_extract', 'YES'],
    ['resource_sharing', 'YES'],
    ['async_to_sync', 'NO'],
    ['mult_style', 'Auto'],
    ['iobuf', 'YES'],
    ['max_fanout', 100000],
    ['bufg', 24],
    ['register_duplication', 'YES'],
    ['register_balancing', 'No'],
    ['slice_packing', 'YES'],
    ['optimize_primitives', 'NO'],
    ['use_clock_enable', 'Yes'],
    ['use_sync_set', 'Yes'],
    ['use_sync_reset', 'Yes'],
    ['iob', 'Auto'],
    ['equivalent_register_removal', 'YES'],
  ];
  // Options only the Spartan-3 / Virtex-4 generation of XST accepts (XST:2883 "not available for the
  // selected device family" on Spartan-6, Virtex-5/6 and 7-series).
  const fam = deviceFamily(device) || 'spartan3e';
  if (!/^(spartan3|virtex4)/.test(fam)) {
    const legacyOnly = new Set(['verilog2001', 'slice_packing', 'mult_style', 'bufg', 'slice_utilization_ratio', 'bram_utilization_ratio', 'fsm_style', 'iob', 'optimize_primitives', 'register_balancing', 'async_to_sync', 'safe_implementation', 'ram_style', 'rom_style', 'use_clock_enable', 'use_sync_set', 'use_sync_reset']);
    for (let i = opts.length - 1; i >= 0; i--) if (legacyOnly.has(opts[i][0])) opts.splice(i, 1);
  }
  if (includeDirs.length) opts.push(['vlgincdir', `{ ${includeDirs.map(d => `"${d}"`).join(' ')} }`]);
  // User extras: impl.xstOptions = { "keep_hierarchy": "Yes", ... }
  for (const [k, v] of Object.entries(impl.xstOptions || {})) {
    if (!/^[a-z_0-9]+$/i.test(k) || /[\r\n]/.test(String(v))) throw Object.assign(new Error(`invalid XST option '${k}'`), { status: 400 });
    const i = opts.findIndex(o => o[0] === k);
    if (i >= 0) opts[i] = [k, v]; else opts.push([k, v]);
  }
  return [
    'set -tmpdir "xst/projnav.tmp"',
    'set -xsthdpdir "xst"',
    'run',
    ...opts.map(([k, v]) => `-${k} ${v}`),
    '',
  ].join('\n');
}

/**
 * Contents of the bitgen option file (.ut). The full option set below was verified with the
 * Spartan-3 families (3/3A/3AN/3A DSP/3E); other families get a conservative set of options that
 * bitgen accepts on all of them (everything else keeps ISE's defaults).
 */
export function generateUt({ impl = {}, family = 'spartan3e' } = {}) {
  const startup = /^cclk$/i.test(impl.startupClk || '') ? 'Cclk' : /^userclk$/i.test(impl.startupClk || '') ? 'UserClk' : 'JtagClk';
  if (!/^spartan3/.test(family || '')) {
    return ['-w', '-g DebugBitstream:No', '-g Binary:no', '-g CRC:Enable', '-g UnusedPin:PullDown', '-g UserID:0xFFFFFFFF',
      `-g StartUpClk:${startup}`, '-g DONE_cycle:4', '-g GTS_cycle:5', '-g GWE_cycle:6', '-g Security:None', ''].join('\n');
  }
  return [
    '-w',
    '-g DebugBitstream:No',
    '-g Binary:no',
    '-g CRC:Enable',
    '-g ConfigRate:1',
    '-g ProgPin:PullUp',
    '-g DonePin:PullUp',
    '-g TckPin:PullUp',
    '-g TdiPin:PullUp',
    '-g TdoPin:PullUp',
    '-g TmsPin:PullUp',
    '-g UnusedPin:PullDown',
    '-g UserID:0xFFFFFFFF',
    '-g DCMShutdown:Disable',
    `-g StartUpClk:${startup}`,
    '-g DONE_cycle:4',
    '-g GTS_cycle:5',
    '-g GWE_cycle:6',
    '-g LCK_cycle:NoWait',
    '-g Security:None',
    '-g DonePipe:No',
    '-g DriveDone:No',
    '',
  ].join('\n');
}

/** Contents of run.sh. Usage: ./run.sh [synth translate map par trce bitgen] */
export function generateRunSh({ top, device, hasUcf, defaultSteps = STEPS }) {
  // Spartan-3 / Virtex-4 generation: placement in PAR. Spartan-6, Virtex-5/6 and 7-series:
  // timing-driven placement happens in MAP and PAR rejects "-t" (Par:526) - options as ISE's
  // Project Navigator writes them for those families.
  const legacy = /^(spartan3|virtex4)/.test(deviceFamily(device) || 'spartan3e');
  const mapOpts = legacy ? '-cm area -ir off -pr off -c 100' : '-w -logic_opt off -ol high -t 1 -xt 0 -register_duplication off -r 4 -global_opt off -mt off -ir off -pr off -lc off -power off';
  const parOpts = legacy ? '-ol high -t 1' : '-ol high -mt off';
  if (!IDENT.test(top)) throw new Error(`invalid top module name '${top}'`);
  const ps = partStrings(device);
  const uc = hasUcf ? `-uc ${shQuote(top + '.ucf')} ` : '';
  const devPart = `xc${ps.bitPart}${ps.speed}`;   // xdl -report: xc3s250ecp132-4
  return `#!/usr/bin/env bash
# Generated by Silinx - Xilinx ISE 14.7 flow for ${ps.xst} (top: ${top}).
# Usage: ./run.sh [${ALL_STEPS.join(' ')}]   (no arguments = ${defaultSteps.join(' ')})
# Environment: ISE_SETTINGS=/path/to/ISE_DS/settings64.sh (sourced when xst is not on PATH)

cd "$(dirname "$0")" || exit 1
STEPS="\${*:-${defaultSteps.join(' ')}}"

if ! command -v xst >/dev/null 2>&1; then
  ISE_SETTINGS="\${ISE_SETTINGS:-${DEFAULT_SETTINGS_SH}}"
  if [ -f "$ISE_SETTINGS" ]; then
    # settings64.sh takes $1 as the install dir: source it with no positional arguments.
    set --
    # shellcheck disable=SC1090
    . "$ISE_SETTINGS" >/dev/null 2>&1
  fi
fi
if ! command -v xst >/dev/null 2>&1; then
  echo "ERROR: Xilinx ISE tools (xst) not found. Put ISE 14.7 on PATH or set ISE_SETTINGS to settings64.sh." >&2
  exit 127
fi

has() { case " $STEPS " in *" $1 "*) return 0 ;; esac; return 1; }
run_step() {
  name="$1"; shift
  echo "=== SILINX STEP $name ==="
  "$@"
  rc=$?
  if [ $rc -ne 0 ]; then echo "=== SILINX FAILED $name (exit $rc) ==="; exit $rc; fi
}

if has synth; then
  # fresh XST library: units compiled by earlier runs (e.g. an architecture that was renamed or
  # removed since) would otherwise stay in xst/work and could be picked instead of the new ones
  rm -rf xst/work xst/projnav.tmp
  mkdir -p xst/projnav.tmp
  run_step synth xst -intstyle xflow -ifn ${shQuote(top + '.xst')} -ofn ${shQuote(top + '.syr')}
fi
if has postsynth; then
  mkdir -p netgen/synthesis
  run_step postsynth netgen -intstyle xflow -sim -ofmt vhdl -w ${shQuote(top + '.ngc')} ${shQuote(SIM_MODELS.postsynth(top))}
fi
if has translate && [ -s autopins.txt ]; then
  # Pins for ports without a LOC (no board selected): free general-purpose I/O pins of the package,
  # skipping dual-purpose configuration pins and pins already used in the UCF.
  echo "=== SILINX STEP autopins ==="
  # partgen deletes files in its working directory: run it in its own folder
  rm -rf _partgen && mkdir -p _partgen && ( cd _partgen && partgen -v ${ps.bitPart.replace(/^/, 'xc')} > /dev/null 2>&1 ) || { echo "ERROR: partgen failed"; exit 1; }
  awk -v ucf=${shQuote(top + '.ucf')} '
    FILENAME == ucf { if (match($0, /LOC *= *"?[A-Za-z0-9]+/)) { l = substr($0, RSTART, RLENGTH); sub(/LOC *= *"?/, "", l); used[toupper(l)] = 1 } next }
    FILENAME ~ /\\.pkg$/ {
      if ($1 != "pin" || (toupper($3) in used)) next
      if ($6 ~ /GCLK/ && $6 ~ /^I[OP]/) clk[++nclk] = $3                                    # global clock inputs
      else if ($6 ~ /^IO(_L[0-9]+[NP]_[0-9]+|_[0-9]+)?$/) io[++nio] = $3                   # plain user I/O
      next
    }
    FILENAME == "autopins.txt" && NF {
      pin = ""
      if ($3 == "clock") { while (++kc <= nclk) if (!(clk[kc] in taken)) { pin = clk[kc]; break } }
      if (pin == "")     { while (++ki <= nio)  if (!(io[ki] in taken))  { pin = io[ki];  break } }
      if (pin == "") { print "ERROR: not enough free I/O pins for " $1; exit 1 }
      taken[pin] = 1
      printf "NET \\"%s\\" LOC = \\"%s\\" ; # assigned by Silinx (no LOC given)\\n", $1, pin >> ucf
      if ($3 == "clock" && clk[kc] != pin) printf "NET \\"%s\\" CLOCK_DEDICATED_ROUTE = FALSE ; # no free GCLK pin\\n", $1 >> ucf
      printf "WARNING: %s -> pin %s (assigned automatically%s, no LOC constraint)\\n", $1, pin, ($3 == "clock" ? ", global clock pin" : "")
    }
  ' ${shQuote(top + '.ucf')} _partgen/*.pkg autopins.txt || exit 1
fi
if has translate; then
  run_step translate ngdbuild -intstyle xflow -dd _ngo -nt timestamp ${uc}-p ${ps.impl} ${shQuote(top + '.ngc')} ${shQuote(top + '.ngd')}
fi
if has posttrans; then
  mkdir -p netgen/translate
  run_step posttrans netgen -intstyle xflow -sim -ofmt vhdl -w ${shQuote(top + '.ngd')} ${shQuote(SIM_MODELS.posttrans(top))}
fi
if has map; then
  run_step map map -intstyle xflow -p ${ps.impl} ${mapOpts} -o ${shQuote(top + '_map.ncd')} ${shQuote(top + '.ngd')} ${shQuote(top + '.pcf')}
fi
if has postmap; then
  mkdir -p netgen/map
  run_step postmap netgen -intstyle xflow -sim -ofmt vhdl -w -pcf ${shQuote(top + '.pcf')} ${shQuote(top + '_map.ncd')} ${shQuote(SIM_MODELS.postmap(top))}
fi
if has par; then
  run_step par par -w -intstyle xflow ${parOpts} ${shQuote(top + '_map.ncd')} ${shQuote(top + '.ncd')} ${shQuote(top + '.pcf')}
fi
if has trce; then
  run_step trce trce -intstyle xflow -v 3 -s ${ps.speedNum} -n 3 -fastpaths -xml ${shQuote(top + '.twx')} ${shQuote(top + '.ncd')} -o ${shQuote(top + '.twr')} ${shQuote(top + '.pcf')}${hasUcf ? ` -ucf ${shQuote(top + '.ucf')}` : ''}
fi
if has postpar; then
  mkdir -p netgen/par
  run_step postpar netgen -intstyle xflow -sim -ofmt vhdl -w -pcf ${shQuote(top + '.pcf')} ${shQuote(top + '.ncd')} ${shQuote(SIM_MODELS.postpar(top))}
fi
if has pin2ucf; then
  run_step pin2ucf pin2ucf ${shQuote(top + '.ncd')} -o ${shQuote(top + '_pins.ucf')}
fi
if has xpwr; then
  run_step xpwr xpwr -intstyle xflow -v -o ${shQuote(top + '.pwr')} ${shQuote(top + '.ncd')} ${shQuote(top + '.pcf')}
fi
if has bitgen; then
  run_step bitgen bitgen -intstyle xflow -f ${shQuote(top + '.ut')} ${shQuote(top + '.ncd')}
fi
if has prombit; then
  # same design, StartUpClk:Cclk: for booting from the Platform Flash PROM
  run_step prombit bitgen -intstyle xflow -f ${shQuote(top + '_prom.ut')} ${shQuote(top + '.ncd')} ${shQuote(top + '_prom.bit')}
fi
if has fpgaview; then
  # the implemented design for the FPGA view: the placed and routed design as XDL, and (once per
  # device) the device's tiles and sites
  [ -s ${shQuote(top + '.ncd')} ] || { echo "=== SILINX STEP fpgaview ==="; echo "ERROR: ${top}.ncd not found: run Place & Route first"; echo "=== SILINX FAILED fpgaview (exit 1) ==="; exit 1; }
  run_step fpgaview xdl -ncd2xdl ${shQuote(top + '.ncd')} ${shQuote(top + '.xdl')}
  if ! head -c 2000 device.xdlrc 2>/dev/null | grep -q ' ${devPart} '; then
    rm -f device.xdlrc
    run_step fpgadevice xdl -report ${devPart} device.xdlrc
  fi
fi
echo "=== SILINX DONE ==="
`;
}
const DEFAULT_SETTINGS_SH = '/opt/Xilinx/14.7/ISE_DS/settings64.sh';

// ---------------------------------------------------------------------------------------------
// Build directory generation
// ---------------------------------------------------------------------------------------------

/**
 * Create build/ for a project. Returns { buildDir, top, device, files, sources, hasUcf, warnings }.
 */
/** Top-level port bits ({ net, dir }) that have no LOC in the given UCF text. */
export async function unconstrainedPorts(sources, top, ucfText) {
  let design;
  // with Silinx's UNISIM models when the design instantiates primitives (LD*, BUFG ...)
  try { design = elaborate(compile([...primitiveSources(sources), ...sources]), top); } catch { return []; }
  if (!design?.top) return [];
  let asg = {};
  try { asg = parseUcf(ucfText || '').assignments || {}; } catch { /* unparsable: treat as empty */ }
  const has = net => Object.entries(asg).some(([k, a]) => a.loc && k.toLowerCase() === net.toLowerCase());
  // ports used as clocks anywhere in the hierarchy must go to global-clock (GCLK) pins
  const clocks = new Set();
  const visit = inst => { for (const pr of inst.procs || []) for (const c of clocksOf(pr).clocks) clocks.add(c); (inst.children || []).forEach(visit); };
  visit(design.top);
  // latch gates too: XST puts them on a global buffer, so they need a GCLK pin as well
  for (const g of latchGates(design)) clocks.add(g);
  const out = [];
  for (const p of design.top.ports) {
    const t = p.sig.t;
    // a 1-bit vector (std_logic_vector(0 downto 0), [0:0]) is a bus in the UCF: x<0>
    if (t.w === 1 && (t.scalar || t.kind !== 'logic')) { if (!has(p.name)) out.push({ net: p.name, dir: p.dir, clock: p.dir === 'in' && clocks.has(p.sig) }); continue; }
    const lo = Math.min(t.left, t.right), hi = Math.max(t.left, t.right);
    for (let i = lo; i <= hi; i++) { const n = bitName(p.name, i); if (!has(n)) out.push({ net: n, dir: p.dir }); }
  }
  return out;
}

export async function generateBuild(project, projectDir, { steps } = {}) {
  const warnings = [];
  const top = project.top;
  if (!top) throw Object.assign(new Error('project has no top module set (project.top)'), { status: 400 });
  if (!IDENT.test(top)) throw Object.assign(new Error(`invalid top module name '${top}'`), { status: 400 });
  const device = project.device || {};
  const devErr = validateDevice(device);
  if (devErr.length) throw Object.assign(new Error(devErr.join('; ')), { status: 400 });

  // synthesis: the files of every view and the implementation-only ones (not the simulation-only ones)
  const design = (project.files || []).filter(f => ['design', 'impl'].includes(f.role || 'design') && (f.lang === 'verilog' || f.lang === 'vhdl'));
  if (!design.length) throw Object.assign(new Error('project has no design (role "design") HDL files'), { status: 400 });

  const buildDir = path.join(projectDir, 'build');
  const srcDir = path.join(buildDir, 'src');
  await fs.rm(srcDir, { recursive: true, force: true });
  await fs.mkdir(srcDir, { recursive: true });

  const inside = rel => {
    const full = path.resolve(projectDir, rel);
    if (!full.startsWith(projectDir + path.sep)) throw Object.assign(new Error(`file path escapes project: ${rel}`), { status: 400 });
    return full;
  };

  // Copy sources, preserving their relative layout under build/src/ (paths stay unique).
  const sources = [];
  for (const f of design) {
    const from = inside(f.path);
    if (!fss.existsSync(from)) { warnings.push(`missing source file ${f.path} (skipped)`); continue; }
    const rel = f.path.split(/[\\/]/).join('/');
    const to = path.join(srcDir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    sources.push({ ...f, buildPath: `src/${rel}` });
  }
  if (!sources.length) throw Object.assign(new Error('none of the design source files exist'), { status: 400 });

  // Verilog include files (.vh/.svh/.h/.inc) anywhere in the project are copied too.
  const includeDirs = new Set();
  for (const rel of await walkFiles(projectDir)) {
    if (!/\.(vh|svh|h|inc|vinc)$/i.test(rel)) continue;
    const to = path.join(srcDir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(path.join(projectDir, rel), to);
    includeDirs.add(path.posix.dirname(`src/${rel}`));
  }
  for (const s of sources) if (s.lang === 'verilog') includeDirs.add(path.posix.dirname(s.buildPath));

  // Constraints.
  let hasUcf = false;
  let ucfText = '';
  const ucfOut = path.join(buildDir, `${top}.ucf`);
  if (project.constraints && fss.existsSync(inside(project.constraints))) {
    ucfText = await fs.readFile(inside(project.constraints), 'utf8');
    hasUcf = true;
  }
  // Top-level port bits without a LOC. ISE's placer crashes (segfault in "Design Feasibility Check")
  // when it has to choose I/O sites itself under x86 emulation (Apple Silicon), so Silinx chooses
  // them: run.sh assigns free general-purpose pins from partgen's package file. With a board this
  // would put signals on arbitrary board pins, so it is refused instead.
  const unplaced = await unconstrainedPorts(sources.map(f => ({ ...f, text: fss.readFileSync(path.join(buildDir, f.buildPath), 'utf8') })), top, ucfText);
  await fs.rm(path.join(buildDir, 'autopins.txt'), { force: true });
  if (unplaced.length) {
    if (project.board) throw Object.assign(new Error(`${unplaced.length} top-level port bit(s) have no pin location (LOC) for the ${project.board} board: ${unplaced.slice(0, 12).map(u => u.net).join(', ')}${unplaced.length > 12 ? ', …' : ''}. Assign them in I/O Pin Planning (or remove the board in Design Properties).`), { status: 400 });
    await fs.writeFile(path.join(buildDir, 'autopins.txt'), unplaced.map(u => `${u.net} ${u.dir} ${u.clock ? 'clock' : 'io'}`).join('\n') + '\n');
    warnings.push(`${unplaced.length} port bit(s) have no LOC constraint (${unplaced.slice(0, 8).map(u => u.net).join(', ')}${unplaced.length > 8 ? ', …' : ''}): Silinx assigns free I/O pins automatically - do NOT program real hardware with this bitstream`);
    hasUcf = true;
  } else if (!hasUcf) {
    warnings.push(`no constraints file (${project.constraints || 'project.constraints not set'}) - do NOT program real hardware with this bitstream`);
  }
  if (hasUcf) await fs.writeFile(ucfOut, ucfText); else await fs.rm(ucfOut, { force: true });

  const defaultSteps = normalizeSteps(steps);
  const files = {
    [`${top}.prj`]: generatePrj(sources),
    [`${top}.xst`]: generateXst({ top, device, impl: project.impl || {}, includeDirs: [...includeDirs].sort() }),
    [`${top}.ut`]: generateUt({ impl: project.impl || {}, family: deviceFamily(device) }),
    [`${top}_prom.ut`]: generateUt({ impl: { ...(project.impl || {}), startupClk: 'Cclk' }, family: deviceFamily(device) }),
    'run.sh': generateRunSh({ top, device, hasUcf, defaultSteps: STEPS }),
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(buildDir, name), text);
  await fs.chmod(path.join(buildDir, 'run.sh'), 0o755);
  await fs.mkdir(path.join(buildDir, 'xst', 'projnav.tmp'), { recursive: true });
  return { buildDir, top, device, files: Object.keys(files).concat(hasUcf ? [`${top}.ucf`] : []), sources, hasUcf, warnings, steps: defaultSteps };
}

async function walkFiles(dir, base = '') {
  const out = [];
  let ents = [];
  try { ents = await fs.readdir(path.join(dir, base), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || (base === '' && (e.name === 'build' || e.name === 'node_modules'))) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walkFiles(dir, rel)); else out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

/**
 * Job body for POST /projects/:p/implement.
 * @param {object} job
 * @param {object} o { project, projectDir, steps?, generateOnly? }
 */
export async function runImplementation(job, { project, projectDir, steps, generateOnly = false }) {
  const st = normalizeSteps(steps);
  job.log(`Silinx implementation: ${project.name} top=${project.top} device=${partStrings(project.device || {}).xst}`);
  const gen = await generateBuild(project, projectDir, { steps: st });
  for (const w of gen.warnings) job.log(`WARNING: ${w}`);
  job.log(`Generated ${gen.files.join(', ')} in ${gen.buildDir}`);
  const result = { buildDir: gen.buildDir, generated: gen.files, steps: st, warnings: gen.warnings, mode: null, reports: null, completedSteps: [], failedStep: null };
  if (generateOnly) {
    job.log('Scripts generated only (generateOnly). Run build/run.sh on a machine with ISE 14.7.');
    return result;
  }

  const cfg = await loadConfig();
  const det = { ise: detectIse(cfg), helpers: { bash: which('bash'), docker: which(cfg.docker.command || 'docker'), ssh: which('ssh'), rsync: which('rsync'), scp: which('scp'), tar: which('tar') } };
  const status = iseStatus(cfg, det);
  result.mode = cfg.mode;
  if (!status.available) {
    job.log(`ISE is not available in mode '${cfg.mode}': ${status.reason}`);
    job.log(`How to fix: ${status.help}`);
    job.log(`The build directory and run.sh were still generated: ${gen.buildDir}`);
    throw Object.assign(new Error(`Xilinx ISE not available (${cfg.mode} mode): ${status.reason.replace(/\.$/, '')}. Configure it via the Toolchain settings (PUT /api/toolchain), or run ${path.join(gen.buildDir, 'run.sh')} on a machine with ISE 14.7.`), { result });
  }
  job.log(`Running ISE flow in '${cfg.mode}' mode: ${status.reason}`);

  // Track step progress from run.sh markers.
  const onLine = line => {
    let m = /^=== SILINX STEP (\w+) ===/.exec(line);
    if (m) { if (result.currentStep) result.completedSteps.push(result.currentStep); result.currentStep = m[1]; job.result = result; }
    m = /^=== SILINX FAILED (\w+)/.exec(line);
    if (m) { result.failedStep = m[1]; result.currentStep = null; }
    if (/^=== SILINX DONE ===/.test(line)) { if (result.currentStep) result.completedSteps.push(result.currentStep); result.currentStep = null; }
  };

  let code;
  try {
    if (cfg.mode === 'local') code = await runLocal(job, cfg, det, gen, st, onLine);
    else if (cfg.mode === 'docker') code = await runDocker(job, cfg, gen, st, onLine);
    else code = await runSsh(job, cfg, det, project, gen, st, onLine);
  } finally {
    // Always try to parse whatever reports exist (also after failures / cancel).
    try {
      result.reports = await collectReports(gen.buildDir, gen.top, gen.device);
      await fs.writeFile(path.join(gen.buildDir, 'reports.json'), JSON.stringify(result.reports, null, 2) + '\n');
    } catch (e) { job.log(`WARNING: report parsing failed: ${e.message}`); }
  }
  if (code !== 0) {
    throw Object.assign(new Error(`ISE flow failed${result.failedStep ? ` in step '${result.failedStep}'` : ''} (exit code ${code})`), { result });
  }
  job.log(result.reports?.bit ? `Bitstream: ${result.reports.bit.path}` : 'Flow finished.');
  return result;
}

function runLocal(job, cfg, det, gen, steps, onLine) {
  const settings = cfg.local.settings || det.ise.settings || '';
  const env = settings ? { ISE_SETTINGS: settings } : {};
  return runCommand(job, det.helpers.bash || 'bash', ['run.sh', ...steps], { cwd: gen.buildDir, env, onLine });
}

function runDocker(job, cfg, gen, steps, onLine) {
  const d = cfg.docker;
  const args = ['run', '--rm'];
  if (d.platform) args.push('--platform', d.platform);
  args.push('-v', `${gen.buildDir}:/work`, '-w', '/work');
  // Linux: run as the calling user so build outputs are not owned by root (the Silinx ISE
  // image works under any UID). Docker Desktop on macOS/Windows maps ownership by itself.
  if (process.platform === 'linux' && typeof process.getuid === 'function' && !(d.extraArgs || []).some(a => String(a) === '--user' || String(a).startsWith('--user=')))
    args.push('--user', `${process.getuid()}:${process.getgid()}`);
  if (d.settings) args.push('-e', `ISE_SETTINGS=${d.settings}`);
  args.push(...(d.extraArgs || []).map(String));
  args.push(d.image, 'bash', 'run.sh', ...steps);
  return runCommand(job, d.command || 'docker', args, { onLine });
}

/** ssh target + base options. */
function sshParts(cfg) {
  const s = cfg.ssh;
  const target = s.user ? `${s.user}@${s.host}` : s.host;
  const opts = ['-o', 'BatchMode=yes'];
  if (s.port && +s.port !== 22) opts.push('-p', String(+s.port));
  if (s.identity) opts.push('-i', s.identity);
  opts.push(...(s.sshArgs || []).map(String));
  return { target, opts };
}

/** Remote directory for a project (relative paths are relative to the remote home). */
export function remoteDirFor(cfg, projectName) {
  let base = String(cfg.ssh.remoteDir || 'silinx-build').replace(/^~\/?/, '') || 'silinx-build';
  base = base.replace(/\/+$/, '');
  if (!/^[\w./-]+$/.test(base) || base.split('/').includes('..')) throw new Error(`invalid ssh.remoteDir '${cfg.ssh.remoteDir}'`);
  return `${base}/${projectName}`;
}

async function runSsh(job, cfg, det, project, gen, steps, onLine) {
  const { target, opts } = sshParts(cfg);
  const rdir = remoteDirFor(cfg, project.name);
  const rq = shQuote(rdir);
  job.log(`Uploading build directory to ${target}:${rdir}`);
  // Upload: tar | ssh "rm -rf dir && mkdir -p dir && tar -x"
  let code = await runPipe(job,
    ['tar', ['-C', gen.buildDir, '-cf', '-', '.']],
    ['ssh', [...opts, '--', target, `rm -rf ${rq} && mkdir -p ${rq} && tar -C ${rq} -xf -`]]);
  if (code !== 0) return code;
  const flow = await runCommand(job, 'ssh', [...opts, '--', target, remoteFlowCommand(cfg, rdir, steps)], { onLine });
  job.log(`Downloading results from ${target}:${rdir}`);
  // Download everything except the sources we uploaded.
  code = await runPipe(job,
    ['ssh', [...opts, '--', target, `tar -C ${rq} --exclude=./src -cf - .`]],
    ['tar', ['-C', gen.buildDir, '-xf', '-']]);
  if (code !== 0) job.log('WARNING: downloading results failed');
  return flow;
}

/**
 * The shell command that runs the flow on the ssh host, in `rdir` (relative to the remote home):
 * run.sh with the ISE installed there, or (ssh.image) inside that docker image, folder at /work.
 */
export function remoteFlowCommand(cfg, rdir, steps) {
  const s = cfg.ssh, rq = shQuote(rdir), args = steps.map(shQuote).join(' ');
  if (s.image) {
    // a non-interactive ssh shell may lack Docker Desktop's /usr/local/bin (macOS) on PATH
    const env = s.settings ? `-e ISE_SETTINGS=${shQuote(s.settings)} ` : '';
    return `export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"; cd ${rq} && docker run --rm -v "$PWD":/work -w /work ${env}${shQuote(s.image)} bash run.sh ${args}`;
  }
  const settings = s.settings ? `ISE_SETTINGS=${shQuote(s.settings)} ` : '';
  return `cd ${rq} && ${settings}bash run.sh ${args}`;
}

/** Run `a | b`, logging stderr of both; resolves with the first non-zero exit code. */
function runPipe(job, [cmdA, argsA], [cmdB, argsB]) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new JobCancelled());
    job.log(`$ ${[cmdA, ...argsA].map(shQuote).join(' ')} | ${[cmdB, ...argsB].map(shQuote).join(' ')}`);
    const a = spawn(cmdA, argsA, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const b = spawn(cmdB, argsB, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    job.procs.add(a); job.procs.add(b);
    a.stdout.pipe(b.stdin);
    b.stdin.on('error', () => {});
    for (const s of [a.stderr, b.stderr, b.stdout]) { s.setEncoding('utf8'); s.on('data', d => job.log(d.replace(/\n$/, ''))); }
    let codes = [], failed = false;
    const done = (p, code) => {
      job.procs.delete(p);
      codes.push(code ?? 1);
      if (codes.length === 2) {
        if (job.cancelled) return reject(new JobCancelled());
        resolve(codes.find(c => c !== 0) ?? 0);
      }
    };
    for (const p of [a, b]) {
      p.on('error', e => { if (!failed) { failed = true; reject(new Error(`cannot run ${p === a ? cmdA : cmdB}: ${e.message}`)); } });
      p.on('close', c => done(p, c));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------------------------

const num = s => (s === undefined || s === null ? null : Number(String(s).replace(/,/g, '')));

/** Parse "Number of X: used out of total pct%" style lines. */
function utilLines(text) {
  const items = [];
  const re = /^[ \t]*((?:Total )?Number (?:of|used as) [^:\n]+?)\s*:\s+([\d,]+)(?:\s+out of\s+([\d,]+)\s+(\d+)%)?[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    items.push({ name: m[1].trim(), used: num(m[2]), total: m[3] ? num(m[3]) : null, percent: m[4] ? num(m[4]) : null });
  }
  return items;
}

function pick(items, re) {
  const it = items.find(i => re.test(i.name));
  return it ? { used: it.used, total: it.total, percent: it.percent } : null;
}

/** XST synthesis report (.syr). */
export function parseSyr(text) {
  const out = { selectedDevice: null, utilization: [], summary: {}, timing: null, errors: null, warnings: null };
  const dev = /Selected Device\s*:\s*(\S+)/.exec(text);
  if (dev) out.selectedDevice = dev[1];
  const sec = text.indexOf('Device utilization summary');
  if (sec >= 0) {
    const end = text.indexOf('Partition Resource Summary', sec);
    const chunk = text.slice(sec, end > 0 ? end : sec + 4000);
    out.utilization = utilLines(chunk);
  }
  const u = out.utilization;
  out.summary = {
    slices: pick(u, /^Number of Slices$/i),
    ffs: pick(u, /Slice Flip Flops/i) || pick(u, /Slice Registers/i),
    luts: pick(u, /4 input LUTs/i) || pick(u, /Slice LUTs/i),
    iobs: pick(u, /bonded IOBs/i),
    bram: pick(u, /BRAMs|RAMB16/i),
    mult: pick(u, /MULT18X18/i),
    gclks: pick(u, /GCLKs/i),
  };
  const t = /Minimum period:\s*([\d.]+)ns\s*\(Maximum Frequency:\s*([\d.]+)MHz\)/i.exec(text);
  if (t) out.timing = { minPeriodNs: num(t[1]), maxFreqMHz: num(t[2]), estimate: true };
  else if (/Minimum period:\s*No path found/i.test(text)) out.timing = { minPeriodNs: null, maxFreqMHz: null, estimate: true, noPath: true };
  const e = /Number of errors\s*:\s*(\d+)/.exec(text); if (e) out.errors = +e[1];
  const w = /Number of warnings\s*:\s*(\d+)/.exec(text); if (w) out.warnings = +w[1];
  return out;
}

/** MAP report (_map.mrp). */
export function parseMrp(text) {
  const out = { utilization: [], summary: {}, errors: null, warnings: null, equivalentGates: null };
  const sec = text.indexOf('Design Summary');
  const chunk = sec >= 0 ? text.slice(sec, (text.indexOf('Table of Contents', sec + 1) > 0 ? text.indexOf('Table of Contents', sec + 1) : sec + 8000)) : text;
  out.utilization = utilLines(chunk);
  const u = out.utilization;
  out.summary = {
    slices: pick(u, /occupied Slices/i),
    ffs: pick(u, /Slice Flip Flops/i) || pick(u, /Slice Registers/i),
    luts: pick(u, /^Total Number of 4 input LUTs/i) || pick(u, /4 input LUTs/i) || pick(u, /Number of Slice LUTs/i),
    iobs: pick(u, /bonded IOBs/i),
    bram: pick(u, /RAMB16/i),
    mult: pick(u, /MULT18X18/i),
    bufg: pick(u, /BUFGMUX/i),
    dcm: pick(u, /DCMs/i),
  };
  const e = /Number of errors:\s*(\d+)/.exec(chunk); if (e) out.errors = +e[1];
  const w = /Number of warnings:\s*(\d+)/.exec(chunk); if (w) out.warnings = +w[1];
  const g = /Total equivalent gate count for design:\s*([\d,]+)/.exec(text); if (g) out.equivalentGates = num(g[1]);
  return out;
}

/** PAR report (.par). */
export function parsePar(text) {
  const out = { routed: false, unroutedSignals: null, timingScore: null, constraintsMet: null, done: /PAR done!/.test(text) };
  if (/All signals are completely routed\./.test(text)) { out.routed = true; out.unroutedSignals = 0; }
  const ur = /(\d+)\s+signals? (?:are|is) not completely routed/.exec(text) || /The router encountered (\d+) unrouted/.exec(text);
  if (ur) { out.routed = false; out.unroutedSignals = +ur[1]; }
  const ts = /Timing Score:\s*(\d+)/.exec(text); if (ts) out.timingScore = +ts[1];
  if (/All constraints were met\./.test(text)) out.constraintsMet = true;
  else if (/(\d+)\s+constraints? not met\./.test(text) || /Timing Score:\s*[1-9]/.test(text)) out.constraintsMet = false;
  return out;
}

/** Static timing report (.twr). */
export function parseTwr(text) {
  const out = { timingErrors: null, score: null, met: null, minPeriodNs: null, maxFreqMHz: null, paths: null, constraints: [] };
  const te = /Timing errors:\s*(\d+)\s+Score:\s*(\d+)/.exec(text);
  if (te) { out.timingErrors = +te[1]; out.score = +te[2]; out.met = out.timingErrors === 0; }
  const mp = /Minimum period:\s*([\d.]+)ns(?:\{\d+\})?\s*\(Maximum frequency:\s*([\d.]+)MHz\)/i.exec(text);
  if (mp) { out.minPeriodNs = num(mp[1]); out.maxFreqMHz = num(mp[2]); }
  const cov = /Constraints cover (\d+) paths?, (\d+) nets?, and (\d+) connections?/.exec(text);
  if (cov) out.paths = +cov[1];
  const re = /Timing constraint:\s*(.+?)\s*\n([\s\S]*?)(?=\n\s*-{20,}|\nTiming constraint:|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2];
    const header = m[1].replace(/;$/, '');
    const c = { constraint: header, name: (/^(\S+)\s*=/.exec(header) || [])[1] || header };
    const err = /(\d+) timing errors? detected/.exec(body); if (err) c.timingErrors = +err[1];
    const per = /Minimum period is\s+([\d.]+)ns/.exec(body); if (per) { c.minPeriodNs = num(per[1]); c.maxFreqMHz = +(1000 / c.minPeriodNs).toFixed(3); }
    const pa = /(\d+) paths? analyzed/.exec(body); if (pa) c.paths = +pa[1];
    out.constraints.push(c);
  }
  if (out.met === null && out.constraints.length) out.met = out.constraints.every(c => !c.timingErrors);
  if (/All constraints were met\./.test(text) && out.met === null) out.met = true;
  return out;
}

async function readIf(p) { try { return await fs.readFile(p, 'latin1'); } catch { return null; } }

/** Parse every report present in build/ into one JSON object. */
/** XPower text report (.pwr): on-chip power and junction temperature. */
export function parsePwr(text) {
  const num = (re) => { const m = re.exec(text); return m ? parseFloat(m[1]) : null; };
  const supply = /\|\s*Supply Power \(mW\)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(text);
  return {
    totalMw: supply ? parseFloat(supply[1]) : num(/\|\s*Total\s*\|\s*([\d.]+)/),
    dynamicMw: supply ? parseFloat(supply[2]) : null,
    staticMw: supply ? parseFloat(supply[3]) : null,
    junctionC: num(/Junction Temp \(C\)\s*\|\s*([\d.]+)/),
  };
}

export async function collectReports(buildDir, top, device) {
  const out = { generatedAt: new Date().toISOString(), top, device: device || null };
  const syr = await readIf(path.join(buildDir, `${top}.syr`));
  if (syr) out.synthesis = parseSyr(syr);
  const mrp = await readIf(path.join(buildDir, `${top}_map.mrp`));
  if (mrp) out.map = parseMrp(mrp);
  const par = await readIf(path.join(buildDir, `${top}.par`));
  if (par) out.par = parsePar(par);
  const twr = await readIf(path.join(buildDir, `${top}.twr`));
  if (twr) out.timing = parseTwr(twr);
  const bitPath = path.join(buildDir, `${top}.bit`);
  if (fss.existsSync(bitPath)) {
    const st = await fs.stat(bitPath);
    let header = null;
    try { header = parseBitHeader(await fs.readFile(bitPath)); } catch (e) { header = { error: e.message }; }
    out.bit = { path: bitPath, size: st.size, mtime: st.mtime.toISOString(), header };
  }
  const pwr = await readIf(path.join(buildDir, `${top}.pwr`));
  if (pwr) out.power = parsePwr(pwr);
  // simulation models written by netgen (post-synthesis / translate / map / place & route)
  out.simModels = {};
  for (const [step, rel] of Object.entries(SIM_MODELS)) {
    const f = path.join(buildDir, rel(top));
    if (fss.existsSync(f)) out.simModels[step] = { path: `build/${rel(top)}`, mtime: (await fs.stat(f)).mtime.toISOString() };
  }
  const pins = path.join(buildDir, `${top}_pins.ucf`);
  if (fss.existsSync(pins)) out.pinsUcf = { path: `build/${top}_pins.ucf`, mtime: (await fs.stat(pins)).mtime.toISOString() };
  // A compact headline for the UI.
  out.summary = {
    synthesized: !!syr,
    mapped: !!mrp,
    routed: out.par ? out.par.routed : null,
    timingMet: out.timing ? out.timing.met : (out.par ? out.par.constraintsMet : null),
    maxFreqMHz: out.timing?.maxFreqMHz ?? out.synthesis?.timing?.maxFreqMHz ?? null,
    utilization: out.map?.summary || out.synthesis?.summary || null,
    bitstream: !!out.bit,
  };
  return out;
}
