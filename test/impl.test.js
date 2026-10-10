import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'ise');

let tmp;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'silinx-impl-test-'));
  // Isolate the toolchain config from the user's ~/.silinx.
  process.env.SILINX_CONFIG_DIR = path.join(tmp, 'cfg');
});
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const ise = await import('../server/ise.js');
const prog = await import('../server/programmer.js');
const dev = await import('../server/devices.js');
const jobs = await import('../server/jobs.js');
const xise = await import('../server/xise.js');
const tc = await import('../server/toolchain.js');
const { generateUcf, parseUcf } = await import('../core/ucf.js');

const DEVICE = { family: 'spartan3e', part: 'xc3s500e', package: 'fg320', speed: '-4' };

// ------------------------------------------------------------------------------------------
// Devices / boards
// ------------------------------------------------------------------------------------------

test('device database: resources + package validation', () => {
  const p = dev.findPart('xc3s500e');
  assert.equal(p.slices, 4656);
  assert.equal(p.brams, 20);
  assert.equal(p.packages.fg320.userIo, 232);
  assert.deepEqual(dev.validateDevice(DEVICE), []);
  assert.equal(dev.validateDevice({ part: 'xc3s100e', package: 'fg320', speed: '-4' }).length, 1);
  assert.equal(dev.validateDevice({ part: 'xc3s500e', package: 'vq100', speed: '-5' }).length, 1);
  assert.equal(dev.validateDevice({ part: 'xc3s1600e', package: 'fg484', speed: '-5' }).length, 0);
  const legacy = dev.getDeviceDb({ all: false });   // Spartan-3E-only view
  assert.equal(legacy.parts.length, 5);
  assert.equal(legacy.boards.length, 3);
  const db = dev.getDeviceDb();                        // default: every ISE WebPACK family
  assert.ok(db.parts.length > 5 && db.boards.length > 3 && db.families.length >= 10);
});

test('boards: valid devices, unique pins, expected key pins', () => {
  for (const b of dev.BOARDS) {
    for (const d of [b.device, ...(b.variants || []).map(v => v.device)]) assert.deepEqual(dev.validateDevice(d), [], b.id);
    const pins = b.resources.flatMap(r => r.pins);
    assert.equal(new Set(pins).size, pins.length, `duplicate pin on ${b.id}`);
    assert.ok(b.programmer.preferred);
  }
  const s3e = dev.resolveBoard('s3e-starter');
  assert.deepEqual(s3e.resources.find(r => r.name === 'clk').pins, ['C9']);
  assert.deepEqual(s3e.resources.find(r => r.name === 'led').pins, ['F12', 'E12', 'E11', 'F11', 'C11', 'D11', 'E9', 'F9']);
  const b2 = dev.resolveBoard('basys2', { part: 'xc3s100e' });
  assert.equal(b2.device.part, 'xc3s100e');
  assert.deepEqual(b2.resources.find(r => r.name === 'led').pins, ['M5', 'M11', 'P7', 'P6', 'N5', 'N4', 'P4', 'G1']);
  const n500 = dev.resolveBoard('nexys2');
  const n1200 = dev.resolveBoard('nexys2', { variant: '1200' });
  assert.equal(n500.resources.find(r => r.name === 'led').pins[4], 'E17');
  assert.equal(n1200.resources.find(r => r.name === 'led').pins[4], 'E16');
  assert.equal(n1200.device.part, 'xc3s1200e');
});

test('board resources -> UCF -> parse', () => {
  const b = dev.resolveBoard('basys2');
  const led = b.resources.find(r => r.name === 'led');
  const assignments = {};
  led.pins.forEach((pin, i) => { assignments[`led<${i}>`] = { loc: pin, iostandard: led.iostandard }; });
  const text = generateUcf({ ports: ['led[7:0]'], assignments });
  assert.equal(parseUcf(text).assignments['led<7>'].loc, 'G1');
});

// ------------------------------------------------------------------------------------------
// Script generation
// ------------------------------------------------------------------------------------------

test('part strings', () => {
  assert.deepEqual(ise.partStrings(DEVICE), { xst: 'xc3s500e-4-fg320', impl: 'xc3s500e-fg320-4', speedNum: '4', speed: '-4', bitPart: '3s500efg320' });
});

test('steps normalisation', () => {
  assert.deepEqual(ise.normalizeSteps(), ['synth', 'translate', 'map', 'par', 'trce', 'bitgen', 'prombit']);
  assert.deepEqual(ise.normalizeSteps(['bitgen', 'par']), ['par', 'trce', 'bitgen', 'prombit']);
  assert.deepEqual(ise.normalizeSteps(['prom']), ['prombit']);
  assert.deepEqual(ise.normalizeSteps(['xst']), ['synth']);
  assert.throws(() => ise.normalizeSteps(['frobnicate']), /unknown step/);
});

test('prj / xst / ut contents', () => {
  const prj = ise.generatePrj([{ lang: 'verilog', buildPath: 'src/src/a.v' }, { lang: 'vhdl', buildPath: 'src/src/b.vhd' }]);
  assert.equal(prj, 'verilog work "src/src/a.v"\nvhdl work "src/src/b.vhd"\n');
  const xst = ise.generateXst({ top: 'top', device: DEVICE, impl: { optMode: 'Area', optLevel: 2 }, includeDirs: ['src/src'] });
  const lines = xst.split('\n');
  assert.equal(lines[0], 'set -tmpdir "xst/projnav.tmp"');
  assert.equal(lines[2], 'run');
  for (const l of ['-ifn top.prj', '-ifmt mixed', '-ofn top', '-ofmt NGC', '-p xc3s500e-4-fg320', '-top top',
    '-opt_mode Area', '-opt_level 2', '-iobuf YES', '-bus_delimiter <>', '-vlgincdir { "src/src" }']) assert.ok(lines.includes(l), l);
  const ut = ise.generateUt({ impl: { startupClk: 'CCLK' } });
  assert.match(ut, /^-w$/m);
  assert.match(ut, /-g StartUpClk:Cclk/);
  assert.match(ut, /-g DONE_cycle:4/);
  assert.match(ise.generateUt(), /-g StartUpClk:JtagClk/);
});

test('run.sh contents and syntax', async () => {
  const sh = ise.generateRunSh({ top: 'top', device: DEVICE, hasUcf: true });
  assert.match(sh, /xst -intstyle xflow -ifn top\.xst -ofn top\.syr/);
  // stale units of earlier runs must not stay in the XST library
  assert.ok(sh.indexOf('rm -rf xst/work') >= 0 && sh.indexOf('rm -rf xst/work') < sh.indexOf('xst -intstyle'));
  assert.match(sh, /ngdbuild -intstyle xflow -dd _ngo -nt timestamp -uc top\.ucf -p xc3s500e-fg320-4 top\.ngc top\.ngd/);
  assert.match(sh, /map -intstyle xflow -p xc3s500e-fg320-4 -cm area -ir off -pr off -c 100 -o top_map\.ncd top\.ngd top\.pcf/);
  assert.match(sh, /par -w -intstyle xflow -ol high -t 1 top_map\.ncd top\.ncd top\.pcf/);
  assert.match(sh, /trce -intstyle xflow -v 3 -s 4 -n 3 -fastpaths -xml top\.twx top\.ncd -o top\.twr top\.pcf -ucf top\.ucf/);
  assert.match(sh, /bitgen -intstyle xflow -f top\.ut top\.ncd/);
  const noUcf = ise.generateRunSh({ top: 'top', device: DEVICE, hasUcf: false });
  assert.doesNotMatch(noUcf, /-uc /);
  assert.throws(() => ise.generateRunSh({ top: 'a;rm', device: DEVICE }), /invalid top/);
  const f = path.join(tmp, 'run.sh');
  await fs.writeFile(f, sh);
  const r = spawnSync('bash', ['-n', f]);
  assert.equal(r.status, 0, r.stderr?.toString());
});

test('run.sh fails cleanly without ISE and runs selected steps with stub tools', async () => {
  const dir = path.join(tmp, 'stub');
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  for (const t of ['xst', 'ngdbuild', 'map', 'par', 'trce', 'bitgen']) {
    await fs.writeFile(path.join(bin, t), `#!/bin/sh\necho "stub ${t} $*"\n`, { mode: 0o755 });
  }
  await fs.writeFile(path.join(dir, 'run.sh'), ise.generateRunSh({ top: 'top', device: DEVICE, hasUcf: true }));
  const env = { PATH: `${bin}:/usr/bin:/bin`, ISE_SETTINGS: '/nonexistent' };
  const r = spawnSync('bash', ['run.sh', 'synth', 'map'], { cwd: dir, env });
  const out = r.stdout.toString();
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(out, /=== SILINX STEP synth ===\nstub xst/);
  assert.match(out, /=== SILINX STEP map ===\nstub map/);
  assert.doesNotMatch(out, /stub par/);
  assert.match(out, /=== SILINX DONE ===/);
  // failing tool
  await fs.writeFile(path.join(bin, 'map'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const r2 = spawnSync('bash', ['run.sh'], { cwd: dir, env });
  assert.equal(r2.status, 3);
  assert.match(r2.stdout.toString(), /=== SILINX FAILED map \(exit 3\) ===/);
  // no ISE at all
  const r3 = spawnSync('bash', ['run.sh'], { cwd: dir, env: { PATH: '/usr/bin:/bin', ISE_SETTINGS: '/nonexistent' } });
  assert.equal(r3.status, 127);
  assert.match(r3.stderr.toString(), /ISE tools \(xst\) not found/);
});

async function makeProject(name) {
  const dir = path.join(tmp, name);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sim'), { recursive: true });
  await fs.mkdir(path.join(dir, 'constraints'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src/counter.v'), '`include "defs.vh"\nmodule counter(input clk, output [7:0] q); endmodule\n');
  await fs.writeFile(path.join(dir, 'src/defs.vh'), '`define W 8\n');
  await fs.writeFile(path.join(dir, 'src/top.vhd'), 'entity top is end top;\narchitecture rtl of top is begin end rtl;\n');
  await fs.writeFile(path.join(dir, 'sim/tb_top.v'), 'module tb_top; endmodule\n');
  await fs.writeFile(path.join(dir, 'constraints/top.ucf'), 'NET "clk" LOC = "C9" | IOSTANDARD = LVCMOS33 ;\n');
  const project = {
    name, version: 1, device: DEVICE, board: 's3e-starter', top: 'top', simTop: 'tb_top',
    files: [
      { path: 'src/counter.v', lang: 'verilog', role: 'design' },
      { path: 'src/top.vhd', lang: 'vhdl', role: 'design' },
      { path: 'sim/tb_top.v', lang: 'verilog', role: 'sim' },
    ],
    constraints: 'constraints/top.ucf',
    impl: { optMode: 'Speed', optLevel: 1, startupClk: 'JtagClk' },
  };
  await fs.writeFile(path.join(dir, 'silinx.json'), JSON.stringify(project));
  return { dir, project };
}

test('generateBuild creates a self-contained build dir', async () => {
  const { dir, project } = await makeProject('blinky');
  const g = await ise.generateBuild(project, dir);
  const b = g.buildDir;
  assert.equal(await fs.readFile(path.join(b, 'top.prj'), 'utf8'), 'verilog work "src/src/counter.v"\nvhdl work "src/src/top.vhd"\n');
  assert.ok(fss.existsSync(path.join(b, 'src/src/counter.v')));
  assert.ok(fss.existsSync(path.join(b, 'src/src/defs.vh')));
  assert.ok(!fss.existsSync(path.join(b, 'src/sim/tb_top.v')), 'sim files are not copied');
  assert.match(await fs.readFile(path.join(b, 'top.ucf'), 'utf8'), /C9/);
  assert.match(await fs.readFile(path.join(b, 'top.xst'), 'utf8'), /-vlgincdir \{ "src\/src" \}/);
  assert.ok((fss.statSync(path.join(b, 'run.sh')).mode & 0o111) !== 0);
  assert.deepEqual(g.warnings, []);
  await assert.rejects(ise.generateBuild({ ...project, top: '' }, dir), /no top module/);
  await assert.rejects(ise.generateBuild({ ...project, device: { part: 'xc3s100e', package: 'fg320', speed: '-4' } }, dir), /not available/);
});

test('implement job without ISE fails with a helpful message but generates scripts', async () => {
  const { dir, project } = await makeProject('noise');
  await tc.saveConfig({ mode: 'ssh', ssh: { host: '' } });   // deterministic "not configured"
  const job = jobs.createJob('implement', j => ise.runImplementation(j, { project, projectDir: dir }));
  while (jobs.getJob(job.id).status === 'running') await new Promise(r => setTimeout(r, 10));
  const j = jobs.getJob(job.id);
  assert.equal(j.status, 'error');
  assert.match(j.error, /Xilinx ISE not available \(ssh mode\): no ssh host configured/);
  assert.ok(j.lines.some(l => l.startsWith('How to fix:')));
  assert.ok(j.result.generated.includes('run.sh'));
  assert.ok(fss.existsSync(path.join(dir, 'build', 'run.sh')));

  const job2 = jobs.createJob('implement', jj => ise.runImplementation(jj, { project, projectDir: dir, generateOnly: true }));
  while (jobs.getJob(job2.id).status === 'running') await new Promise(r => setTimeout(r, 10));
  assert.equal(jobs.getJob(job2.id).status, 'ok');
});

test('ssh mode with a docker image on the remote host: command, validation, status', async () => {
  const tc = await import('../server/toolchain.js');
  assert.equal(tc.DEFAULT_CONFIG.ssh.image, '');
  const ssh = { settings: '/opt/Xilinx/14.7/ISE_DS/settings64.sh', image: 'xilinx/ise:14.7' };
  assert.equal(ise.remoteFlowCommand({ ssh }, 'silinx-build/p', ['synth', 'map']),
    `export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"; cd silinx-build/p && docker run --rm -v "$PWD":/work -w /work -e ISE_SETTINGS=/opt/Xilinx/14.7/ISE_DS/settings64.sh xilinx/ise:14.7 bash run.sh synth map`);
  assert.equal(ise.remoteFlowCommand({ ssh: { ...ssh, settings: '' } }, 'b/p', ['synth']),
    `export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"; cd b/p && docker run --rm -v "$PWD":/work -w /work xilinx/ise:14.7 bash run.sh synth`);
  // no image: run.sh with the ISE installed on the host, as before
  assert.equal(ise.remoteFlowCommand({ ssh: { ...ssh, image: '' } }, 'b/p', ['synth']), 'cd b/p && ISE_SETTINGS=/opt/Xilinx/14.7/ISE_DS/settings64.sh bash run.sh synth');
  assert.equal(ise.remoteFlowCommand({ ssh: { settings: '', image: '' } }, 'b/p', ['synth']), 'cd b/p && bash run.sh synth');
  await assert.rejects(tc.saveConfig({ mode: 'ssh', ssh: { host: 'h', image: 'x y;rm' } }), /ssh.image contains invalid characters/);
  const cfg = await tc.saveConfig({ mode: 'ssh', ssh: { host: 'mini', user: 'dev', image: 'xilinx/ise:14.7' } });
  assert.equal(tc.iseStatus(cfg, { ise: {}, helpers: { ssh: '/x', tar: '/x' } }).reason, 'remote host dev@mini (docker image xilinx/ise:14.7)');
  await tc.saveConfig({ mode: 'local', ssh: { host: '', user: '', image: '' } });
});

test('ssh remote dir sanitising', () => {
  assert.equal(ise.remoteDirFor({ ssh: { remoteDir: '~/builds/' } }, 'p'), 'builds/p');
  assert.equal(ise.remoteDirFor({ ssh: { remoteDir: '/scratch/x' } }, 'p'), '/scratch/x/p');
  assert.throws(() => ise.remoteDirFor({ ssh: { remoteDir: '../etc' } }, 'p'));
  assert.throws(() => ise.remoteDirFor({ ssh: { remoteDir: 'a b;rm' } }, 'p'));
});

// ------------------------------------------------------------------------------------------
// Report parsing
// ------------------------------------------------------------------------------------------

const readFix = f => fs.readFile(path.join(FIX, f), 'utf8');

test('parse .syr', async () => {
  const r = ise.parseSyr(await readFix('top.syr'));
  assert.equal(r.selectedDevice, '3s500efg320-4');
  assert.deepEqual(r.summary.slices, { used: 15, total: 4656, percent: 0 });
  assert.deepEqual(r.summary.ffs, { used: 26, total: 9312, percent: 0 });
  assert.deepEqual(r.summary.iobs, { used: 9, total: 232, percent: 3 });
  assert.deepEqual(r.timing, { minPeriodNs: 4.04, maxFreqMHz: 247.525, estimate: true });
  assert.equal(r.errors, 0);
  assert.equal(r.warnings, 1);
});

test('parse _map.mrp', async () => {
  const r = ise.parseMrp(await readFix('top_map.mrp'));
  assert.deepEqual(r.summary.slices, { used: 16, total: 4656, percent: 1 });
  assert.deepEqual(r.summary.ffs, { used: 26, total: 9312, percent: 1 });
  assert.deepEqual(r.summary.luts, { used: 29, total: 9312, percent: 1 });
  assert.deepEqual(r.summary.iobs, { used: 9, total: 232, percent: 3 });
  assert.deepEqual(r.summary.bram, { used: 1, total: 20, percent: 5 });
  assert.deepEqual(r.summary.mult, { used: 2, total: 20, percent: 10 });
  assert.deepEqual(r.summary.bufg, { used: 1, total: 24, percent: 4 });
  assert.equal(r.errors, 0);
});

test('parse .par', async () => {
  const r = ise.parsePar(await readFix('top.par'));
  assert.deepEqual(r, { routed: true, unroutedSignals: 0, timingScore: 0, constraintsMet: true, done: true });
  const bad = ise.parsePar('Timing Score: 512 (Setup: 512, Hold: 0)\n1 constraint not met.\n3 signals are not completely routed.\nPAR done!');
  assert.equal(bad.routed, false);
  assert.equal(bad.unroutedSignals, 3);
  assert.equal(bad.constraintsMet, false);
});

test('parse .twr', async () => {
  const r = ise.parseTwr(await readFix('top.twr'));
  assert.equal(r.timingErrors, 0);
  assert.equal(r.met, true);
  assert.equal(r.minPeriodNs, 4.391);
  assert.equal(r.maxFreqMHz, 227.739);
  assert.equal(r.paths, 351);
  assert.equal(r.constraints.length, 1);
  assert.equal(r.constraints[0].name, 'TS_clk');
  assert.equal(r.constraints[0].timingErrors, 0);
  assert.equal(r.constraints[0].minPeriodNs, 4.391);
  const failing = ise.parseTwr('Timing errors: 4  Score: 1234  (Setup/Max: 1234, Hold: 0)\n');
  assert.equal(failing.met, false);
});

// ------------------------------------------------------------------------------------------
// Bitstream header
// ------------------------------------------------------------------------------------------

function makeBit({ design = 'top.ncd;UserID=0xFFFFFFFF', part = '3s500efg320', date = '2025/10/01', time = '10:11:20', data = Buffer.from([0xff, 0xff, 0xaa, 0x99]) } = {}) {
  const field = (k, s) => { const b = Buffer.from(s + '\0', 'latin1'); const h = Buffer.alloc(3); h[0] = k.charCodeAt(0); h.writeUInt16BE(b.length, 1); return Buffer.concat([h, b]); };
  const e = Buffer.alloc(5); e[0] = 'e'.charCodeAt(0); e.writeUInt32BE(data.length, 1);
  return Buffer.concat([
    Buffer.from([0x00, 0x09, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x00, 0x00, 0x01]),
    field('a', design), field('b', part), field('c', date), field('d', time), e, data,
  ]);
}

test('bit header parsing', async () => {
  const h = prog.parseBitHeader(makeBit());
  assert.equal(h.designName, 'top.ncd');
  assert.equal(h.userId, '0xFFFFFFFF');
  assert.equal(h.part, '3s500efg320');
  assert.equal(h.date, '2025/10/01');
  assert.equal(h.time, '10:11:20');
  assert.equal(h.dataLength, 4);
  assert.deepEqual(h.device, { part: 'xc3s500e', package: 'fg320' });
  assert.equal(prog.checkBitPart(h, DEVICE), null);
  assert.match(prog.checkBitPart(h, { part: 'xc3s250e', package: 'cp132' }), /built for '3s500efg320'/);
  assert.throws(() => prog.parseBitHeader(Buffer.from('hello world, not a bitstream')), /not a Xilinx/);
  assert.throws(() => prog.parseBitHeader(makeBit().subarray(0, 20)), /truncated/);
  const f = path.join(tmp, 'x.bit');
  await fs.writeFile(f, makeBit({ part: '3s250ecp132' }));
  const info = await prog.readBitInfo(f);
  assert.equal(info.part, '3s250ecp132');
  assert.equal(info.size, fss.statSync(f).size);
});

test('collectReports writes summary incl. bit info', async () => {
  const b = path.join(tmp, 'rep');
  await fs.mkdir(b, { recursive: true });
  for (const f of ['top.syr', 'top_map.mrp', 'top.par', 'top.twr']) await fs.copyFile(path.join(FIX, f), path.join(b, f));
  await fs.writeFile(path.join(b, 'top.bit'), makeBit());
  const r = await ise.collectReports(b, 'top', DEVICE);
  assert.equal(r.summary.routed, true);
  assert.equal(r.summary.timingMet, true);
  assert.equal(r.summary.maxFreqMHz, 227.739);
  assert.equal(r.summary.utilization.slices.used, 16);
  assert.equal(r.bit.header.part, '3s500efg320');
});

// ------------------------------------------------------------------------------------------
// Programmer commands
// ------------------------------------------------------------------------------------------

test('programmer command builders', () => {
  assert.deepEqual(prog.buildCommands('scan', { tool: 'openFPGALoader', cable: 'digilent_hs2' }), [{ cmd: 'openFPGALoader', args: ['-c', 'digilent_hs2', '--detect'] }]);
  assert.deepEqual(prog.buildCommands('program', { tool: 'openFPGALoader', cable: 'ft2232', position: 1, bitfile: '/a/top.bit' }), [{ cmd: 'openFPGALoader', args: ['-c', 'ft2232', '--index-chain', '1', '/a/top.bit'] }]);
  assert.deepEqual(prog.buildCommands('scan', { tool: 'xc3sprog', cable: 'xpc' }), [{ cmd: 'xc3sprog', args: ['-c', 'xpc', '-j'] }]);
  assert.deepEqual(prog.buildCommands('program', { tool: 'xc3sprog', cable: 'xpc', position: 0, bitfile: '/a/top.bit' }), [{ cmd: 'xc3sprog', args: ['-c', 'xpc', '-v', '-p', '0', '/a/top.bit'] }]);
  assert.throws(() => prog.buildCommands('program', { tool: 'xc3sprog', cable: 'xpc', bitfile: '/a:b/top.bit' }), /":"/);
  assert.deepEqual(prog.buildCommands('scan', { tool: 'djtgcfg', device: 'Nexys2' }), [{ cmd: 'djtgcfg', args: ['enum'] }, { cmd: 'djtgcfg', args: ['init', '-d', 'Nexys2'] }]);
  assert.deepEqual(prog.buildCommands('program', { tool: 'djtgcfg', device: 'Basys2', position: 0, bitfile: '/a/top.bit' }), [{ cmd: 'djtgcfg', args: ['prog', '-d', 'Basys2', '-i', '0', '-f', '/a/top.bit'] }]);
  assert.throws(() => prog.buildCommands('program', { tool: 'djtgcfg', bitfile: '/a/top.bit' }), /device name/);
  const [imp] = prog.buildCommands('program', { tool: 'impact', cable: 'auto', position: 1, bitfile: '/a/top.bit' });
  assert.deepEqual(imp.args, ['-batch']);
  assert.equal(imp.impactScript, 'setMode -bs\nsetCable -port auto\nIdentify -inferir\nidentifyMPM\nassignFile -p 1 -file "/a/top.bit"\nProgram -p 1\ncloseCable\nquit\n');
  assert.doesNotMatch(prog.impactScript({}), /Program/);
  assert.throws(() => prog.buildCommands('program', { tool: 'nope', bitfile: 'x' }), /unknown programming tool/);
});

test('programmer option resolution uses board defaults', () => {
  const cfg = { programmer: { tool: '', cable: '' } };
  assert.deepEqual(
    (({ tool, cable, position }) => ({ tool, cable, position }))(prog.resolveOptions({}, cfg, 's3e-starter')),
    { tool: 'impact', cable: 'auto', position: 1 });
  const n2 = prog.resolveOptions({}, cfg, 'nexys2');
  assert.equal(n2.tool, 'djtgcfg');
  assert.equal(n2.device, 'Nexys2');
  const x = prog.resolveOptions({ tool: 'xc3sprog' }, cfg, 's3e-starter');
  assert.equal(x.cable, 'xpc');
  assert.equal(x.position, 0);
  const o = prog.resolveOptions({ tool: 'openFPGALoader', cable: 'digilent_hs2' }, cfg, null);
  assert.equal(o.cable, 'digilent_hs2');
});

test('scan output parsing', () => {
  const d = prog.parseScanOutput('xc3sprog', ['JTAG loc.:   0  IDCODE: 0x41c22093  Desc:                      XC3S500E Rev: E  IR length:  6',
    'JTAG loc.:   1  IDCODE: 0xf5046093  Desc:                        XCF04S Rev: F  IR length:  8']);
  assert.equal(d.length, 2);
});

// ------------------------------------------------------------------------------------------
// Jobs
// ------------------------------------------------------------------------------------------

test('jobs: runCommand streams lines, since offsets, cancel', async () => {
  const job = jobs.createJob('t', async j => {
    const code = await jobs.runCommand(j, 'sh', ['-c', 'echo one; echo two 1>&2; printf "three"']);
    return { code };
  });
  while (jobs.getJob(job.id).status === 'running') await new Promise(r => setTimeout(r, 5));
  const j = jobs.getJob(job.id);
  assert.equal(j.status, 'ok');
  assert.equal(j.result.code, 0);
  assert.ok(j.lines.includes('one') && j.lines.includes('two') && j.lines.includes('three'));
  assert.deepEqual(jobs.getJob(job.id, j.next).lines, []);
  assert.deepEqual(jobs.getJob(job.id, j.next - 1).lines.length, 1);

  const long = jobs.createJob('t', j2 => jobs.runCommand(j2, 'sh', ['-c', 'echo started; sleep 30']));
  while (!jobs.getJob(long.id).lines.includes('started')) await new Promise(r => setTimeout(r, 5));
  jobs.cancelJob(long.id);
  while (jobs.getJob(long.id).status === 'running') await new Promise(r => setTimeout(r, 5));
  assert.equal(jobs.getJob(long.id).status, 'error');
  assert.equal(jobs.getJob(long.id).cancelled, true);

  const missing = jobs.createJob('t', j3 => jobs.runCommand(j3, 'definitely-not-a-command-xyz', []));
  while (jobs.getJob(missing.id).status === 'running') await new Promise(r => setTimeout(r, 5));
  assert.match(jobs.getJob(missing.id).error, /command not found/);
});

// ------------------------------------------------------------------------------------------
// Toolchain config
// ------------------------------------------------------------------------------------------

test('toolchain config save/validate', async () => {
  const cfg = await tc.saveConfig({ mode: 'docker', docker: { image: 'my/ise:14.7' } });
  assert.equal(cfg.docker.image, 'my/ise:14.7');
  assert.equal(cfg.docker.settings, tc.DEFAULT_SETTINGS);
  await assert.rejects(tc.saveConfig({ mode: 'magic' }), /invalid mode/);
  await assert.rejects(tc.saveConfig({ ssh: { host: 'a;b' } }), /invalid characters/);
  const st = tc.iseStatus({ ...cfg, mode: 'docker' }, { ise: {}, helpers: { docker: null } });
  assert.equal(st.available, false);
  await tc.saveConfig({ mode: 'local' });
});

// ------------------------------------------------------------------------------------------
// .xise export / import
// ------------------------------------------------------------------------------------------

test('xise export structure + round trip', async () => {
  const { project } = await makeProject('xprj');
  const sources = { 'src/top.vhd': 'entity top is end top;\narchitecture rtl of top is begin end rtl;\n' };
  const xml = xise.exportXise(project, { sources });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8" standalone="no" \?>\n<project xmlns="http:\/\/www.xilinx.com\/XMLSchema" xmlns:xil_pn="http:\/\/www.xilinx.com\/XMLSchema">/);
  assert.match(xml, /<version xil_pn:ise_version="14.7" xil_pn:schema_version="2"\/>/);
  assert.match(xml, /<file xil_pn:name="src\/counter.v" xil_pn:type="FILE_VERILOG">\n\s+<association xil_pn:name="BehavioralSimulation" xil_pn:seqID="1"\/>\n\s+<association xil_pn:name="Implementation"/);
  assert.match(xml, /<file xil_pn:name="sim\/tb_top.v" xil_pn:type="FILE_VERILOG">\n\s+<association xil_pn:name="BehavioralSimulation" xil_pn:seqID="3"\/>\n\s+<\/file>/);
  assert.match(xml, /xil_pn:type="FILE_UCF"/);
  assert.match(xml, /xil_pn:name="Device Family" xil_pn:value="Spartan3E"/);
  assert.match(xml, /xil_pn:name="Implementation Top" xil_pn:value="Architecture\|top\|rtl"/);
  assert.match(xml, /xil_pn:name="Implementation Top Instance Path" xil_pn:value="\/top"/);
  assert.match(xml, /<bindings\/>[\s\S]*<libraries\/>[\s\S]*<autoManagedFiles>/);

  const back = xise.importXise(xml);
  assert.deepEqual(back.device, DEVICE);
  assert.equal(back.top, 'top');
  assert.equal(back.simTop, 'tb_top');
  assert.deepEqual(back.files, project.files);
  assert.equal(back.constraints, 'constraints/top.ucf');
  assert.deepEqual(back.impl, project.impl);
  assert.deepEqual(back.warnings, []);
});

test('xise import of an ISE-written file', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<project xmlns="http://www.xilinx.com/XMLSchema" xmlns:xil_pn="http://www.xilinx.com/XMLSchema">
  <header><!-- created by Project Navigator --></header>
  <version xil_pn:ise_version="14.7" xil_pn:schema_version="2"/>
  <files>
    <file xil_pn:name="Basys2Project.vhd" xil_pn:type="FILE_VHDL">
      <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="2"/>
      <association xil_pn:name="Implementation" xil_pn:seqID="1"/>
    </file>
    <file xil_pn:name="tb.vhd" xil_pn:type="FILE_VHDL">
      <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="3"/>
    </file>
    <file xil_pn:name="Basys2_100_250General.ucf" xil_pn:type="FILE_UCF">
      <association xil_pn:name="Implementation" xil_pn:seqID="0"/>
    </file>
  </files>
  <properties>
    <property xil_pn:name="Device" xil_pn:value="xc3s100e" xil_pn:valueState="default"/>
    <property xil_pn:name="Device Family" xil_pn:value="Spartan3E" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Implementation Top" xil_pn:value="Architecture|Basys2Project|Structural" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Package" xil_pn:value="cp132" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Speed Grade" xil_pn:value="-5" xil_pn:valueState="default"/>
    <property xil_pn:name="PROP_BehavioralSimTop" xil_pn:value="Architecture|tb|behavior" xil_pn:valueState="non-default"/>
    <property xil_pn:name="FPGA Start-Up Clock" xil_pn:value="CCLK" xil_pn:valueState="default"/>
  </properties>
  <bindings/>
  <libraries/>
  <autoManagedFiles></autoManagedFiles>
</project>`;
  const r = xise.importXise(xml);
  assert.deepEqual(r.device, { family: 'spartan3e', part: 'xc3s100e', package: 'cp132', speed: '-5' });
  assert.equal(r.top, 'Basys2Project');
  assert.equal(r.simTop, 'tb');
  assert.deepEqual(r.files, [
    { path: 'Basys2Project.vhd', lang: 'vhdl', role: 'design' },
    { path: 'tb.vhd', lang: 'vhdl', role: 'sim' },
  ]);
  assert.equal(r.constraints, 'Basys2_100_250General.ucf');
  assert.equal(r.impl.startupClk, 'Cclk');
  assert.throws(() => xise.importXise('<foo/>'), /not an ISE/);
});

test('optional flow steps: simulation models, pin2ucf, xpwr', () => {
  assert.deepEqual(ise.normalizeSteps(['par', 'postsynth', 'xpwr']), ['synth', 'postsynth', 'translate', 'map', 'par', 'trce', 'xpwr'].filter((s) => ['par', 'postsynth', 'xpwr', 'trce'].includes(s)));
  const sh = ise.generateRunSh({ top: 'top', device: DEVICE, hasUcf: true });
  assert.match(sh, /netgen -intstyle xflow -sim -ofmt vhdl -w top\.ngc netgen\/synthesis\/top_synthesis\.vhd/);
  assert.match(sh, /netgen -intstyle xflow -sim -ofmt vhdl -w -pcf top\.pcf top\.ncd netgen\/par\/top_timesim\.vhd/);
  assert.match(sh, /pin2ucf top\.ncd -o top_pins\.ucf/);
  assert.match(sh, /xpwr -intstyle xflow -v -o top\.pwr top\.ncd top\.pcf/);
  const p = ise.parsePwr('| Supply Power (mW)    | 52.46 | 1.50    | 50.96        |\n| Junction Temp (C)   | 27.5 |');
  assert.deepEqual(p, { totalMw: 52.46, dynamicMw: 1.5, staticMw: 50.96, junctionC: 27.5 });
});

test('generateBuild: an implementation-only source is synthesized, a simulation-only one is not', async () => {
  const { dir, project } = await makeProject('blinky');
  const p = { ...project, files: project.files.map(f => (f.path === 'src/counter.v' ? { ...f, role: 'impl' } : f)) };
  const g = await ise.generateBuild(p, dir);
  const prj = await fs.readFile(path.join(g.buildDir, 'top.prj'), 'utf8');
  assert.match(prj, /src\/src\/counter\.v/);
  assert.doesNotMatch(prj, /tb_top/);
});
