// The fully open flow for a Silinx project, no Xilinx tool in it: Silinx's front end + Yosys compiled
// to WebAssembly (core/synth-open.js) -> pack -> place -> route on the PIPs whose bits are known ->
// Silinx's bitgen. Needs the device cache (~/.silinx/devices, built from the user's own
// device report: research/s3e-route/build-device.mjs).
//   node research/s3e-route/open-flow.mjs <project folder> <out folder> [--json netlist.json] [--seed N] [--effort E] [--timing T] [--timing-route 0|1] [--no-crc]
// (seed, effort, timing: the placer's options, core/fpga/place.js; --timing-route 0: route for
// wirelength only, without the timing-driven router (default 1)). After routing, the static timing
// analysis of core/fpga/timing.js prints the critical path of each clock (also in timing.txt). Writes into the out folder: <top>.json (Yosys), placed.xdl, routed.xdl, <top>.bit. Fails (exit 1)
// listing the nets that cannot be routed on known PIPs, or the features of the design the bit
// database does not know: the .bit is written only when it is complete.
import fs from 'node:fs';
import path from 'node:path';
import { compile, elaborate } from '../../core/compile.js';
import { primitiveSources } from '../../core/unisim.js';
import { synthesizeOpen } from '../../core/synth-open.js';
import { yosysNode } from '../../core/synth-open-node.js';
import { parseXdl, writeXdl } from '../../core/xdl.js';
import { readYosysJson } from '../../core/fpga/netlist.js';
import { pack } from '../../core/fpga/pack.js';
import { deviceSites, place, placedXdl } from '../../core/fpga/place.js';
import { loadDeviceCache } from '../../core/fpga/device-node.js';
import { routeDesign, checkRouting, clockReach } from '../../core/fpga/route.js';
import { bitgen, knownRouting } from '../../core/fpga/bitgen.js';
import { analyzeTiming, timingReport, checkPeriods } from '../../core/fpga/timing.js';
import { parseUcf } from '../../core/ucf.js';
import { loadDb } from '../s3e-bitstream/db.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = name => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const json = opt('--json', null), seed = +opt('--seed', '1'), effort = +opt('--effort', '1'), timing = +opt('--timing', '1'), timingRoute = opt('--timing-route', '1') !== '0', noCrc = flag('--no-crc');
const [projDir, outDir] = args;
if (!projDir || !outDir) { console.error('usage: open-flow.mjs <project folder> <out folder> [--json netlist.json] [--seed N] [--effort E] [--timing T] [--timing-route 0|1] [--no-crc]'); process.exit(2); }
const proj = JSON.parse(fs.readFileSync(path.join(projDir, 'silinx.json'), 'utf8'));
const top = proj.top;
const part = `${proj.device.part}${proj.device.package}${proj.device.speed}`;
fs.mkdirSync(outDir, { recursive: true });
const step = (what, t) => console.log(`${what}: ${Date.now() - t} ms`);
const fail = (msg, list = []) => { console.error(`open-flow: ${msg}`); for (const x of list) console.error(`  ${x}`); process.exit(1); };

// synthesis: Silinx's front end + Yosys (WebAssembly), as the Synthesize - Yosys (open) process
let t = Date.now();
let netFile = json;
if (!netFile) {
  const srcs = proj.files.filter(f => (f.role || 'design') === 'design' && (f.lang === 'vhdl' || f.lang === 'verilog'))
    .map(f => ({ path: f.path, lang: f.lang, text: fs.readFileSync(path.join(projDir, f.path), 'utf8') }));
  const lib = compile([...primitiveSources(srcs), ...srcs]);
  const design = elaborate(lib, top);
  const errs = [...lib.errors, ...design.diags].filter(d => d.severity === 'error');
  if (errs.length) fail('the design has errors', errs.map(e => `${e.file}:${e.line} ${e.message}`));
  const r = await synthesizeOpen(design, { family: proj.device.family || 'spartan3e', run: yosysNode, onLine: l => { if (/^(Warning|ERROR)/.test(l)) console.log(`  ${l}`); } });
  for (const [name, text] of Object.entries(r.files)) fs.writeFileSync(path.join(outDir, name), text);
  netFile = path.join(outDir, `${top}.json`);
  step(`synthesis (${r.util.cells} cells)`, t);
}
// pack: a carry out read by logic leaves through an XOR stage, not XB / YB (not in the database)
t = Date.now();
const ucf = proj.constraints ? fs.readFileSync(path.join(projDir, proj.constraints), 'utf8') : null;
const packed = pack(readYosysJson(fs.readFileSync(netFile, 'utf8')), { ucf, part, carryOut: 'xor' });
step(`pack (${packed.stats.slices} slices)`, t);
// place, on the sites of the device cache
t = Date.now();
const device = loadDeviceCache(part);
const db = loadDb();
const known = knownRouting(db);
// each clock's flip-flops on the slices its global line reaches through switches of known bits
const r = place(packed, deviceSites(device), { seed, effort, timing, clockSites: site => clockReach(device, site, known.allowPip) });
console.log(`place: estimated critical path ${r.delay.toFixed(1)} ns`);
fs.writeFileSync(path.join(outDir, 'placed.xdl'), writeXdl(placedXdl(packed, r)));
step('place', t);
// route on the PIPs the bit database knows
t = Date.now();
const design = parseXdl(fs.readFileSync(path.join(outDir, 'placed.xdl'), 'utf8'));
const routed = routeDesign(design, device, { ...known, timing: timingRoute });
const routedText = writeXdl(routed.design);
fs.writeFileSync(path.join(outDir, 'routed.xdl'), routedText);
step(`route (${routed.routed} nets, ${routed.pips} PIPs, ${routed.iterations} passes)`, t);
if (routed.errors.length) fail('routing errors', routed.errors);
if (routed.failed.length) fail(`${routed.failed.length} nets cannot be routed on PIPs of known bits`, routed.unreached.map(u => `${u.net} -> ${u.inst}.${u.pin}`));
const check = checkRouting(parseXdl(routedText), device);
if (!check.ok) fail('routing check', check.problems.slice(0, 50));
// static timing analysis of the routed design (the delay model of core/fpga/timing.js)
// against the PERIOD constraints of the project's UCF
const routedDesign = parseXdl(routedText);
const sta0 = analyzeTiming(routedDesign, device);
const checks = checkPeriods(sta0, routedDesign, ucf ? parseUcf(ucf).clocks : []);
const sta = timingReport(sta0, checks);
fs.writeFileSync(path.join(outDir, 'timing.txt'), `${sta.join('\n')}\n`);
for (const l of sta) if (/^(clock|constraint)/.test(l)) console.log(`timing: ${l}`);
// the bitstream
t = Date.now();
const { bytes, unknown } = bitgen(routedText, db, { name: `${top}.ncd`, crc: !noCrc, startupClk: proj.impl?.startupClk || 'JtagClk' });
if (unknown.length) fail(`${unknown.length} features not in the bit database: no bitstream`, unknown.map(u => `${u.tile} ${u.feature}`));
fs.writeFileSync(path.join(outDir, `${top}.bit`), bytes);
step(`bitgen (${bytes.length} bytes)`, t);
console.log(`${path.join(outDir, `${top}.bit`)}: complete (every feature in the bit database)`);
