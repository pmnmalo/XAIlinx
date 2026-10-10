// Unit tests of the server helpers not reached through the API tests: job manager internals
// (log cap, garbage collection, kill errors, capture), ISE script generators and report parsers
// for other families / odd inputs, toolchain status, .xise corner cases, family detection, zip errors.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { scratchEnv, waitJob, sleep, HERE, POSIX_ONLY } from './server-helpers.js';

let tmp;
before(async () => { tmp = await scratchEnv('silinx-units-test-'); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const jobs = await import('../server/jobs.js');
const ise = await import('../server/ise.js');
const tc = await import('../server/toolchain.js');
const xise = await import('../server/xise.js');
const fam = await import('../core/family.js');
const { createZip, readZip } = await import('../core/zip.js');

// ------------------------------------------------------------------------------------------------
// jobs
// ------------------------------------------------------------------------------------------------

test('jobs: the log is capped (old lines dropped, offsets stay absolute)', async () => {
  const job = jobs.createJob('t', async j => { j.log(Array.from({ length: 50_010 }, (_, i) => `l${i}`).join('\n')); j.log('last'); return 7; });
  const j = await waitJob(jobs, job.id);
  assert.equal(j.status, 'ok');
  assert.equal(j.result, 7);
  assert.equal(j.lines.length, 50_000);
  assert.equal(j.next, 50_011);
  assert.equal(j.lines[0], 'l11');
  assert.deepEqual(jobs.getJob(job.id, 50_010).lines, ['last']);
  assert.equal(jobs.getJob(job.id, 3).lines.length, 50_000);   // dropped lines cannot be re-read
  assert.equal(jobs.getJob(job.id, 'junk').lines.length, 50_000);
  assert.equal(jobs.getJob('missing'), null);
  assert.equal(jobs.cancelJob('missing'), null);
});

test('jobs: errors keep a partial result; a job cancelled while its function still returns ends cancelled', async () => {
  const a = jobs.createJob('t', async () => { throw Object.assign(new Error('boom'), { result: { partial: 1 } }); });
  const ja = await waitJob(jobs, a.id);
  assert.deepEqual([ja.status, ja.error, ja.result], ['error', 'boom', { partial: 1 }]);
  assert.equal(ja.lines.at(-1), 'ERROR: boom');
  const b = jobs.createJob('t', async () => { throw 'plain string'; });   // eslint-disable-line no-throw-literal
  assert.equal((await waitJob(jobs, b.id)).error, 'plain string');
  const c = jobs.createJob('t', async () => { await sleep(30); return 'done'; });
  jobs.cancelJob(c.id);
  const jc = await waitJob(jobs, c.id);
  assert.deepEqual([jc.status, jc.error, jc.cancelled], ['error', 'cancelled by user', true]);
  const d = jobs.createJob('t', async j => { await sleep(20); j.checkCancelled(); return 1; });
  jobs.cancelJob(d.id);
  assert.equal((await waitJob(jobs, d.id)).error, 'cancelled by user');
});

test('jobs: kill errors are swallowed (process already gone, no pid)', async () => {
  const gone = { pid: 2 ** 30, exitCode: 0, signalCode: null, kill() { throw new Error('ESRCH'); } };
  const job = jobs.createJob('t', async j => { j.procs.add(gone); j.procs.add({ pid: 0, exitCode: 0, signalCode: null, kill() {} }); await sleep(30); });
  await sleep(5);
  assert.doesNotThrow(() => jobs.cancelJob(job.id));
  assert.equal((await waitJob(jobs, job.id)).status, 'error');
});

test('jobs: a process that survives SIGTERM gets SIGKILL', { skip: POSIX_ONLY }, async () => {
  const job = jobs.createJob('t', j => jobs.runCommand(j, 'sh', ['-c', 'trap "" TERM; echo ready; while :; do sleep 1; done']));
  for (let i = 0; i < 500 && !jobs.getJob(job.id).lines.includes('ready'); i++) await sleep(10);
  // run the 3 s SIGKILL timer at once
  const m = mock.method(globalThis, 'setTimeout', fn => { fn(); return { unref() {} }; });
  try { jobs.cancelJob(job.id); } finally { m.mock.restore(); }
  const j = await waitJob(jobs, job.id);
  assert.equal(j.error, 'cancelled by user');
});

test('jobs: finished jobs are garbage-collected after an hour and beyond 200 jobs', async () => {
  const old = jobs.createJob('t', async () => 1);
  await waitJob(jobs, old.id);
  const realNow = Date.now;
  const m = mock.method(Date, 'now', () => realNow() + 2 * 60 * 60 * 1000);
  try {
    const fresh = jobs.createJob('t', async () => 1);   // creating a job runs the GC
    assert.equal(jobs.getJob(old.id), null);
    await waitJob(jobs, fresh.id);
  } finally { m.mock.restore(); }
  const ids = [];
  for (let i = 0; i < 205; i++) ids.push(jobs.createJob('t', async () => i).id);
  for (const id of ids) await waitJob(jobs, id);
  jobs.createJob('t', async () => 0);
  assert.ok(jobs.listJobs().length <= 201);
  assert.equal(jobs.getJob(ids[0]), null, 'oldest finished jobs go first');
  assert.ok(jobs.getJob(ids.at(-1)));
});

test('runCommand: stdin input, \\r progress lines, prefix, no echo, spawn failures, cancelled job', async () => {
  const lines = [];
  const job = jobs.createJob('t', async j => jobs.runCommand(j, 'sh', ['-c', 'cat; printf "a\\rb\\r\\nc\\r"; echo err >&2'], { input: 'from stdin\n', prefix: 'E: ', echo: false, onLine: (l, s) => lines.push(`${s}:${l}`) }));
  const j = await waitJob(jobs, job.id);
  assert.equal(j.result, 0);
  // stdout and stderr interleave freely: compare as sets, stdout order kept
  assert.deepEqual([...j.lines].sort(), ['E: err', 'a', 'b', 'c', 'from stdin']);
  assert.deepEqual(j.lines.filter(l => l !== 'E: err'), ['from stdin', 'a', 'b', 'c']);
  assert.ok(!j.lines.some(l => l.startsWith('$ ')));
  assert.ok(lines.includes('stderr:err'));
  // exit code / signal
  assert.equal(await jobs.runCommand(null, 'sh', ['-c', 'exit 3']), 3);
  assert.equal(await jobs.runCommand(null, 'sh', ['-c', 'kill -9 $$']), 128);
  // argument with characters that need quoting in the echoed command line
  const q = jobs.createJob('t', async jj => jobs.runCommand(jj, 'sh', ['-c', 'true', "it's"]));
  assert.ok((await waitJob(jobs, q.id)).lines[0].endsWith(`'it'\\''s'`));
  await assert.rejects(jobs.runCommand(null, 'nul\0byte', []), /null bytes|ERR_INVALID_ARG/i);
  await assert.rejects(jobs.runCommand(null, path.join(tmp, 'no-such-dir', 'tool'), []), /command not found/);
  const plain = path.join(tmp, 'not-executable');
  await fs.writeFile(plain, 'x', { mode: 0o644 });
  await assert.rejects(jobs.runCommand(null, plain, []), e => e.code === 'EACCES');
  const c = jobs.createJob('t', async () => sleep(50));
  jobs.cancelJob(c.id);
  const fake = { cancelled: true };
  await assert.rejects(jobs.runCommand(fake, 'sh', ['-c', 'true']), /cancelled by user/);
  await waitJob(jobs, c.id);
});

test('capture: output, missing binary, timeout, spawn error', async () => {
  assert.deepEqual(await jobs.capture('sh', ['-c', 'echo out; echo err >&2']), { code: 0, out: 'out\nerr\n' });
  assert.deepEqual(await jobs.capture('sh', ['-c', 'cat'], { input: 'in' }), { code: 0, out: 'in' });
  assert.equal((await jobs.capture('definitely-missing-binary-xyz')).error, 'not found');
  const t = await jobs.capture('sh', ['-c', 'echo partial; exec sleep 5'], { timeoutMs: 100 });
  assert.equal(t.error, 'timeout');
  assert.equal(t.code, -1);
  const sync = await jobs.capture('sh', [], { cwd: 42 });   // invalid options: spawn throws synchronously
  assert.equal(sync.code, -1);
  assert.match(sync.error, /cwd/);
  const e = await jobs.capture('nul\0byte');
  assert.equal(e.code, -1);
  assert.ok(e.error);
  const notExec = path.join(tmp, 'plain.txt');
  await fs.writeFile(notExec, 'x');
  const pe = await jobs.capture(notExec);
  assert.equal(pe.code, -1);
  assert.match(pe.error, /EACCES|permission/i);
});

// ------------------------------------------------------------------------------------------------
// ISE script generation + report parsing
// ------------------------------------------------------------------------------------------------

const S6 = { family: 'spartan6', part: 'xc6slx9', package: 'csg324', speed: '2' };

test('ISE scripts for Spartan-6 / 7-series: no legacy XST options, MAP placement options, conservative bitgen', () => {
  assert.deepEqual(ise.partStrings(S6), { xst: 'xc6slx9-2-csg324', impl: 'xc6slx9-csg324-2', speedNum: '2', speed: '-2', bitPart: '6slx9csg324' });
  for (const bad of [{ part: 'xc3s250e; rm', package: 'cp132', speed: '-4' }, { part: 'xc3s250e', package: 'cp-132', speed: '-4' }, { part: 'xc3s250e', package: 'cp132', speed: '-4x9' }]) {
    assert.throws(() => ise.partStrings(bad), e => e.status === 400 && /invalid device/.test(e.message));
  }
  const xst = ise.generateXst({ top: 'top', device: S6, impl: { optMode: 'area', optLevel: 2, xstOptions: { keep_hierarchy: 'Yes', register_balancing: 'Yes', newopt: 'x' } } });
  assert.doesNotMatch(xst, /-verilog2001|-slice_packing|-mult_style|-bufg/);
  assert.match(xst, /-opt_mode Area\n-opt_level 2\n/);
  assert.match(xst, /-keep_hierarchy Yes\n/);
  assert.match(xst, /-register_balancing Yes\n/);   // removed as legacy, then added back by the user
  assert.match(xst, /-newopt x\n$/m);
  assert.throws(() => ise.generateXst({ top: 'top', device: S6, impl: { xstOptions: { 'bad key': 1 } } }), /invalid XST option/);
  assert.throws(() => ise.generateXst({ top: 'top', device: S6, impl: { xstOptions: { ok: 'a\nb' } } }), /invalid XST option/);
  assert.match(ise.generateXst({ top: 'top', device: { part: 'xc3s250e', package: 'cp132', speed: '-4' } }), /-verilog2001 YES/);

  const ut = ise.generateUt({ impl: { startupClk: 'UserClk' }, family: 'spartan6' });
  assert.match(ut, /-g StartUpClk:UserClk/);
  assert.doesNotMatch(ut, /ConfigRate|DCMShutdown/);
  assert.match(ise.generateUt({ family: 'virtex5' }), /-g StartUpClk:JtagClk/);
  assert.match(ise.generateUt(), /-g DCMShutdown:Disable/);
  assert.match(ise.generateUt({ impl: { startupClk: 'cclk' }, family: null }), /StartUpClk:Cclk/);

  const sh = ise.generateRunSh({ top: 'top', device: S6, hasUcf: false });
  assert.match(sh, /map -intstyle xflow -p xc6slx9-csg324-2 -w -logic_opt off -ol high -t 1/);
  assert.match(sh, /par -w -intstyle xflow -ol high -mt off top_map.ncd/);
  assert.doesNotMatch(sh, /-uc top\.ucf|-ucf top\.ucf/);
  assert.throws(() => ise.generateRunSh({ top: 'bad name', device: S6, hasUcf: false }), /invalid top module name/);
  assert.equal(ise.shQuote("a b'c"), `'a b'\\''c'`);
  assert.equal(ise.shQuote('plain/path-1.v'), 'plain/path-1.v');
  assert.deepEqual(ise.normalizeSteps('XST'), ['synth']);
  assert.deepEqual(ise.normalizeSteps([]), ise.STEPS);
});

test('generateBuild: invalid top name / device, missing sources, include files, no constraints', async () => {
  const dir = path.join(tmp, 'gb');
  await fs.mkdir(path.join(dir, 'src', 'inc'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'top.v'), '`include "defs.vh"\nmodule top(input a, output y); assign y = a; endmodule\n');
  await fs.writeFile(path.join(dir, 'src', 'inc', 'defs.vh'), '`define X 1\n');
  const base = { name: 'gb', top: 'top', device: { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' }, files: [{ path: 'src/top.v', lang: 'verilog', role: 'design' }, { path: 'src/gone.v', lang: 'verilog' }] };
  const g = await ise.generateBuild({ ...base, constraints: 'constraints/none.ucf' }, dir);
  assert.ok(g.warnings.includes('missing source file src/gone.v (skipped)'));
  assert.ok(g.warnings.some(w => /2 port bit\(s\) have no LOC constraint \(a, y\)/.test(w)));
  assert.match(await fs.readFile(path.join(dir, 'build', 'top.xst'), 'utf8'), /-vlgincdir \{ "src\/src" "src\/src\/inc" \}/);
  // every port constrained, but no constraints file at all is a warning too
  await fs.writeFile(path.join(dir, 'pins.ucf'), 'NET "a" LOC = "P1";\nNET "y" LOC = "P2";\n');
  const g2 = await ise.generateBuild({ ...base, constraints: 'pins.ucf' }, dir);
  assert.ok(!g2.warnings.some(w => /LOC/.test(w)));
  const g3 = await ise.generateBuild({ ...base, top: 'nosuch', constraints: '' }, dir);   // does not elaborate: nothing to place
  assert.ok(g3.warnings.some(w => /no constraints file \(project.constraints not set\)/.test(w)));
  await assert.rejects(ise.generateBuild({ ...base, top: '1bad' }, dir), /invalid top module name/);
  await assert.rejects(ise.generateBuild({ ...base, device: { part: 'xc3s250e', package: 'zz999', speed: '-4' } }, dir), e => e.status === 400);
  await assert.rejects(ise.generateBuild({ ...base, files: [{ path: 'src/gone.v', lang: 'verilog' }] }, dir), /none of the design source files exist/);
  await assert.rejects(ise.generateBuild({ ...base, files: [{ path: '../outside.v', lang: 'verilog' }] }, dir), /file path escapes project/);
  await assert.rejects(ise.generateBuild({ ...base, device: undefined }, dir), e => e.status === 400);
  assert.deepEqual(await ise.unconstrainedPorts([{ path: 'x.v', text: 'module' }], 'x', ''), []);
  assert.deepEqual((await ise.unconstrainedPorts([{ path: 'x.v', lang: 'verilog', text: 'module x(input [1:0] a); endmodule' }], 'x', 'NET "a<0>" LOC = "P1";\nNET garbage')).map(u => u.net), ['a<1>']);
});

test('report parsers: odd and partial inputs', () => {
  const syr = ise.parseSyr('Selected Device : 6slx9csg324-2\nDevice utilization summary:\n Number of Slice Registers:  10  out of  11440     0%\n Number of Slice LUTs:  12  out of  5720     0%\n Minimum period: No path found\n');
  assert.equal(syr.selectedDevice, '6slx9csg324-2');
  assert.deepEqual(syr.summary.ffs, { used: 10, total: 11440, percent: 0 });
  assert.deepEqual(syr.summary.luts, { used: 12, total: 5720, percent: 0 });
  assert.deepEqual(syr.timing, { minPeriodNs: null, maxFreqMHz: null, estimate: true, noPath: true });
  assert.deepEqual(ise.parseSyr('nothing here'), { selectedDevice: null, utilization: [], summary: { slices: null, ffs: null, luts: null, iobs: null, bram: null, mult: null, gclks: null }, timing: null, errors: null, warnings: null });

  const mrp = ise.parseMrp('Number of Slice Registers: 1,234 out of 11,440 10%\nNumber of Slice LUTs: 5 out of 5,720 1%\nNumber of DCMs: 1 out of 4 25%\n');
  assert.deepEqual(mrp.summary.ffs, { used: 1234, total: 11440, percent: 10 });
  assert.deepEqual(mrp.summary.luts, { used: 5, total: 5720, percent: 1 });
  assert.deepEqual(mrp.summary.dcm, { used: 1, total: 4, percent: 25 });
  assert.equal(mrp.equivalentGates, null);

  assert.deepEqual(ise.parsePar('The router encountered 7 unrouted signals'), { routed: false, unroutedSignals: 7, timingScore: null, constraintsMet: null, done: false });
  assert.equal(ise.parsePar('Timing Score: 12\n').constraintsMet, false);

  const twr = ise.parseTwr('Timing constraint: TS_a = PERIOD TIMEGRP "a" 10 ns HIGH 50%;\n 3 timing errors detected.\n 12 paths analyzed\n Minimum period is  12.500ns.\n--------------------------------\nTiming constraint: Unnamed constraint\n 0 timing errors detected.\n');
  assert.equal(twr.met, false);
  assert.deepEqual(twr.constraints.map(c => [c.name, c.timingErrors]), [['TS_a', 3], ['Unnamed constraint', 0]]);
  assert.equal(twr.constraints[0].maxFreqMHz, 80);
  assert.equal(twr.constraints[0].paths, 12);
  assert.equal(ise.parseTwr('All constraints were met.\n').met, true);
  assert.equal(ise.parseTwr('').met, null);

  assert.deepEqual(ise.parsePwr('| Total | 12.5 |\n'), { totalMw: 12.5, dynamicMw: null, staticMw: null, junctionC: null });
  assert.deepEqual(ise.parsePwr(''), { totalMw: null, dynamicMw: null, staticMw: null, junctionC: null });
});

// ------------------------------------------------------------------------------------------------
// toolchain
// ------------------------------------------------------------------------------------------------

test('toolchain: iseStatus for every mode, which(), version probe fallback, config file errors', async () => {
  const cfg = await tc.loadConfig();
  const ok = { bash: '/bin/bash', docker: '/x/docker', ssh: '/x/ssh', tar: '/x/tar' };
  assert.match(tc.iseStatus({ ...cfg, mode: 'local' }, { ise: {}, helpers: { ...ok, bash: null } }).reason, /bash not found/);
  assert.match(tc.iseStatus({ ...cfg, mode: 'local' }, { ise: {}, helpers: ok }).reason, /Xilinx ISE 14.7 not found/);
  assert.equal(tc.iseStatus({ ...cfg, mode: 'local' }, { ise: { onPath: true }, helpers: ok }).available, true);
  assert.equal(tc.iseStatus({ ...cfg, mode: 'docker', docker: { ...cfg.docker, image: 'i' } }, { ise: {}, helpers: ok }).available, true);
  assert.match(tc.iseStatus({ ...cfg, mode: 'docker', docker: { command: '', image: 'i' } }, { ise: {}, helpers: { docker: null } }).reason, /'docker' command not found/);
  assert.match(tc.iseStatus({ ...cfg, mode: 'ssh' }, { ise: {}, helpers: { ...ok, ssh: null } }).reason, /ssh not found/);
  assert.match(tc.iseStatus({ ...cfg, mode: 'ssh' }, { ise: {}, helpers: { ...ok, tar: null } }).reason, /tar not found/);
  assert.equal(tc.iseStatus({ ...cfg, mode: 'ssh', ssh: { ...cfg.ssh, host: 'h' } }, { ise: {}, helpers: ok }).reason, 'remote host h');
  const unk = tc.iseStatus({ ...cfg, mode: 'cloud' }, { ise: {}, helpers: ok });
  assert.deepEqual([unk.available, unk.reason, unk.help], [false, "unknown mode 'cloud'", tc.HELP.local]);

  // which(): explicit paths, extra dirs, non-executable files
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tool'), '#!/bin/sh\necho "some tool without version banner"\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'plain'), 'x', { mode: 0o644 });
  assert.equal(tc.which('tool', [bin]), path.join(bin, 'tool'));
  assert.equal(tc.which(path.join(bin, 'tool')), path.join(bin, 'tool'));
  assert.equal(tc.which(path.join(bin, 'plain')), null);
  assert.equal(tc.which('plain', [bin]), null);
  assert.equal(tc.which('no-such-tool-xyz', [bin]), null);
  assert.equal(tc.resolveTool('djtgcfg', { paths: { djtgcfg: path.join(bin, 'tool') } }, {}), path.join(bin, 'tool'));
  assert.equal(tc.resolveTool('djtgcfg', { paths: { djtgcfg: path.join(bin, 'plain') } }, {}), null);

  // a version probe without a version number reports the first line of output
  await tc.saveConfig({ paths: { openFPGALoader: path.join(bin, 'tool') } });
  const det = await tc.detectToolchain();
  assert.equal(det.programmers.openFPGALoader.version, 'some tool without version banner');
  // a broken config file falls back to the defaults
  await fs.writeFile(tc.configPath(), '{broken');
  assert.equal((await tc.loadConfig()).mode, 'local');
  await assert.rejects(tc.saveConfig(null), /config must be an object/);
  await assert.rejects(tc.saveConfig('x'), /config must be an object/);
  await fs.rm(tc.configPath());
});

// ------------------------------------------------------------------------------------------------
// projects: write failures
// ------------------------------------------------------------------------------------------------

test('projects: HDL files written are registered as sources, but not the generated ones in build/', async () => {
  const P = await import('../server/projects.js');
  await P.createProject({ name: 'Reg' });
  await P.writeFile('Reg', 'src/new.v', 'module n; endmodule\n');
  await P.writeFile('Reg', 'sim/tb_new.vhd', '-- tb\n');
  await P.writeFile('Reg', 'build/open/top_syn.v', 'module top; endmodule\n');   // the open synthesis' netlist
  await P.writeFile('Reg', 'build/top_yosys.v', 'module top; endmodule\n');
  const pj = await P.readProject('Reg');
  assert.deepEqual(pj.files.map(f => [f.path, f.role]), [['src/new.v', 'design'], ['sim/tb_new.vhd', 'sim']]);
  assert.equal(await fs.readFile(path.join(P.projectDir('Reg'), 'build', 'open', 'top_syn.v'), 'utf8'), 'module top; endmodule\n');
});

test('projects: a failed silinx.json write leaves no temp file and the old file intact', async () => {
  const P = await import('../server/projects.js');
  await P.createProject({ name: 'Wr' });
  const before = await fs.readFile(path.join(P.projectDir('Wr'), 'silinx.json'), 'utf8');
  // silinx.json replaced by a non-empty directory: the rename fails
  await fs.rm(path.join(P.projectDir('Wr'), 'silinx.json'));
  await fs.mkdir(path.join(P.projectDir('Wr'), 'silinx.json', 'x'), { recursive: true });
  await assert.rejects(P.writeProject('Wr', { top: 'x' }));
  const left = (await fs.readdir(P.projectDir('Wr'))).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(left, []);
  await fs.rm(path.join(P.projectDir('Wr'), 'silinx.json'), { recursive: true });
  await fs.writeFile(path.join(P.projectDir('Wr'), 'silinx.json'), before);
  // updateProject may return a new object or mutate in place
  assert.equal((await P.updateProject('Wr', () => ({ top: 'n' }))).top, 'n');
  assert.equal(P.langOf('a.SV'), 'verilog');
  assert.equal(P.langOf('a.vhdl'), 'vhdl');
  assert.equal(P.langOf('a.txt'), 'text');
  assert.throws(() => P.safeJoin('/p', ''), /missing path/);
  assert.throws(() => P.safeJoin('/p', 5), /missing path/);
});

// ------------------------------------------------------------------------------------------------
// .xise corner cases
// ------------------------------------------------------------------------------------------------

test('xise: unsupported file kinds, unknown family, work.* sim top, export defaults', () => {
  const xml = `<project>
    <files>
      <file xil_pn:name="core.xco" xil_pn:type="FILE_XCO"/>
      <file xil_pn:name="fsm.dia" xil_pn:type="FILE_OTHER"/>
      <file xil_pn:name="ip.xco" xil_pn:type="FILE_OTHER"/>
      <file xil_pn:name="old.sch" xil_pn:type="FILE_JUNK"/>
      <file xil_pn:name="data.coe" xil_pn:type=""/>
      <file xil_pn:name="" xil_pn:type="FILE_VHDL"/>
      <file xil_pn:name="tb.sv" xil_pn:type="">
        <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="1"/>
      </file>
      <file xil_pn:name='quoted.vhdl' xil_pn:type='FILE_VHDL'/>
    </files>
    <properties>
      <property xil_pn:name="Device Family" xil_pn:value="CoolRunner2"/>
      <property xil_pn:name="Selected Simulation Root Source Node Behavioral" xil_pn:value="work.tb"/>
      <property xil_pn:name="Implementation Top Instance Path" xil_pn:value="/top_inst"/>
      <property xil_pn:name="Preferred Language" xil_pn:value="Verilog"/>
      <property xil_pn:name="PROP_DesignName" xil_pn:value="design &amp; co"/>
      <property xil_pn:value="nameless"/>
    </properties></project>`;
  const r = xise.importXise(xml);
  assert.equal(r.simTop, 'tb');
  assert.equal(r.top, 'top_inst');
  assert.equal(r.lang, 'verilog');
  assert.equal(r.name, 'design & co');
  assert.equal(r.device.family, 'spartan3e');
  assert.equal(r.device.part, null);
  assert.deepEqual(r.files, [{ path: 'tb.sv', lang: 'verilog', role: 'sim' }, { path: 'quoted.vhdl', lang: 'vhdl', role: 'design' }]);
  assert.deepEqual(r.schematics, [{ path: 'old.sch', role: 'design' }]);
  const w = r.warnings.join('\n');
  assert.match(w, /core.xco: CORE Generator IP \(.xco\)/);
  assert.match(w, /fsm.dia: StateCAD state diagram/);
  assert.match(w, /ip.xco: CORE Generator IP/);
  assert.match(w, /data.coe: \? file/);
  assert.match(w, /device family 'CoolRunner2' is not an FPGA family supported by Silinx \(Spartan-3E assumed\)/);

  // export with no device / impl: ISE defaults; Verilog top without a matching source; numeric speed
  const x = xise.exportXise({ name: 'p', top: 'top', simTop: 'tb', files: [{ path: 'a.v', lang: 'verilog' }, { path: 'n.txt', lang: 'text' }] });
  assert.match(x, /"Device" xil_pn:value="xc3s500e"/);
  assert.match(x, /"Speed Grade" xil_pn:value="-4"/);
  assert.match(x, /"Implementation Top" xil_pn:value="Module\|top"/);
  assert.doesNotMatch(x, /Implementation Top File/);
  assert.doesNotMatch(x, /n\.txt/);
  assert.match(x, /"Preferred Language" xil_pn:value="Verilog"/);
  const x2 = xise.exportXise({ name: 'p', device: { part: 'XC6SLX9', package: 'CSG324', speed: '3' }, impl: { startupClk: 'Cclk', optLevel: '2' }, files: [{ path: 'a.vhd', lang: 'vhdl' }] },
    { sources: { 'a.vhd': 'entity other is end;' } });
  assert.match(x2, /"Speed Grade" xil_pn:value="-3"/);
  assert.match(x2, /"Device Family" xil_pn:value="Spartan6"/);
  assert.match(x2, /"FPGA Start-Up Clock" xil_pn:value="CCLK"/);
  assert.match(x2, /"Optimization Effort" xil_pn:value="High"/);
  assert.match(x2, /"Preferred Language" xil_pn:value="VHDL"/);
  assert.doesNotMatch(x2, /Implementation Top"/);
  // an entity whose architecture cannot be found falls back to Module|name
  const x3 = xise.exportXise({ top: 'e', files: [{ path: 'e.vhd', lang: 'vhdl' }] }, { sources: { 'e.vhd': 'entity e is end;' } });
  assert.match(x3, /"Implementation Top" xil_pn:value="Module\|e"/);
  assert.match(x3, /"PROP_DesignName" xil_pn:value="e"/);
});

test('xise: Silinx schematics export: skipped docs, broken docs, duplicated custom symbols', () => {
  const project = { name: 'p', device: { part: 'xc3s250e' }, files: [{ path: 'a.vhd', lang: 'vhdl', role: 'design' }] };
  // no doc whose generated file belongs to the project: nothing to do
  assert.deepEqual(xise.exportIseSchematics(project, { 'x.sch.json': { generatedFile: 'other.vhd' }, 'y.sch.json': null }, {}), { schematics: [], extraFiles: [], files: [], warnings: [] });
  // a doc that cannot be exported: warning, its HDL is exported instead
  const broken = { generatedFile: 'a.vhd', get symbols() { throw new Error('corrupt document'); } };
  const r = xise.exportIseSchematics(project, { 'a.sch.json': broken }, { 'a.vhd': 'garbage that does not compile (' });
  assert.equal(r.schematics.length, 0);
  assert.match(r.warnings[0], /^a\.sch\.json: not exported as an ISE schematic \(corrupt document\); a\.vhd is exported instead$/);
  // an existing .sch.json + its HDL are reused on import; a broken one is converted again
  const out = xise.importIseSchematics({ 'b.sch': '<not a schematic>' }, { existing: p => (p === 'b.sch.json' ? '{broken' : undefined) });
  assert.equal(out.length, 1);
  assert.ok(!out[0].json);
  assert.ok(out[0].warnings.length > 0);
  assert.ok(out[0].warnings.every(w => w.startsWith('b.sch')));
  const reused = xise.importIseSchematics({ 'c.sch': 'x' }, { existing: p => ({ 'c.sch.json': '{"generatedFile":"c.v"}', 'c.v': 'module c; endmodule' })[p] });
  assert.deepEqual(reused, [{ sch: 'c.sch', json: 'c.sch.json', jsonText: '{"generatedFile":"c.v"}', hdl: 'c.v', code: 'module c; endmodule', lang: 'verilog', warnings: [] }]);
});

test('xise: custom symbols of several schematics are exported once; a clash with different pins is reported', async () => {
  const { importIseSch } = await import('../core/isesch.js');
  const sch = (await fs.readFile(path.join(HERE, 'fixtures', 'ise-sch', 'MyAND2b4.sch'), 'utf8')).replace(/symbolname="and2"/g, 'symbolname="myand"');
  const base = importIseSch(sch, { name: 'm' }).doc;   // 'myand' unknown: HDL blocks
  const variant = (file, extra) => {
    const d = JSON.parse(JSON.stringify(base));
    d.generatedFile = file;
    if (extra) for (const s of d.symbols) if (s.type === 'hdlblock') s.params.inputs = [...s.params.inputs, { name: extra, width: 1 }];
    return d;
  };
  const project = { files: ['one', 'two', 'three', 'four'].map(n => ({ path: `${n}.vhd`, lang: 'vhdl', role: 'design' })) };
  const res = xise.exportIseSchematics(project, {
    'one.sch.json': variant('one.vhd'), 'two.sch.json': variant('two.vhd', 'EXTRA'),
    'three.sch.json': variant('three.vhd', 'OTHER'), 'four.sch.json': variant('four.vhd', 'EXTRA'),
  }, {});
  assert.deepEqual(res.schematics.map(x => x.path), ['one.sch', 'two.sch', 'three.sch', 'four.sch']);
  const paths = res.files.map(f => f.path);
  assert.equal(paths.filter(p => p === 'myand.sym').length, 1);
  assert.equal(paths.filter(p => p === 'xl_hdl_myand.vhd').length, 1);
  assert.ok(res.extraFiles.some(f => f.path === 'xl_hdl_myand.vhd' && f.lang === 'vhdl' && f.role === 'design'));
  assert.ok(res.warnings.some(w => /^three\.sch: custom symbol xl_hdl_myand\.(sym|vhd) differs from the one of another schematic/.test(w)), res.warnings.join('\n'));
  assert.ok(!res.warnings.some(w => /^four\.sch: custom symbol .* differs/.test(w)));
});

test('xise: an export that spans a change of second does not report identical custom symbols as different (one time stamp)', async () => {
  const { importIseSch } = await import('../core/isesch.js');
  const sch = (await fs.readFile(path.join(HERE, 'fixtures', 'ise-sch', 'MyAND2b4.sch'), 'utf8')).replace(/symbolname="and2"/g, 'symbolname="myand"');
  const base = importIseSch(sch, { name: 'm' }).doc;
  const docs = Object.fromEntries(['one', 'two'].map(n => [`${n}.sch.json`, { ...JSON.parse(JSON.stringify(base)), generatedFile: `${n}.vhd` }]));
  const project = { files: ['one', 'two'].map(n => ({ path: `${n}.vhd`, lang: 'vhdl', role: 'design' })) };
  // a clock that moves on one second every time it is read (a slow machine)
  const RealDate = globalThis.Date;
  let t = new RealDate(2026, 0, 1, 10, 0, 0).getTime();
  globalThis.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else { super(t); t += 1000; } } static now() { t += 1000; return t; } };
  let res;
  try { res = xise.exportIseSchematics(project, docs, {}); } finally { globalThis.Date = RealDate; }
  assert.deepEqual(res.warnings.filter(w => /differs/.test(w)), []);
  assert.equal(res.files.filter(f => f.path === 'myand.sym').length, 1);
});

// ------------------------------------------------------------------------------------------------
// family detection
// ------------------------------------------------------------------------------------------------

test('family: every family from part names, xise names, bit header parts', () => {
  const parts = {
    xc3s400: 'spartan3', xc3s1000l: 'spartan3', xc3s250e: 'spartan3e', xc3s700a: 'spartan3a', xc3s700an: 'spartan3a', xc3sd1800a: 'spartan3adsp',
    xc6slx9: 'spartan6', xa6slx16: 'spartan6', xq6slx150t: 'spartan6', xc4vlx25: 'virtex4', xc5vlx50t: 'virtex5', xc6vlx75t: 'virtex6',
    xc7a100t: 'artix7', xc7k325t: 'kintex7', xc7v585t: 'virtex7', xc7z020: 'zynq', XC3S500E: 'spartan3e',
  };
  for (const [p, f] of Object.entries(parts)) assert.equal(fam.familyOfPart(p), f, p);
  for (const p of [null, undefined, '', 'xc9572', 'ep4ce22']) assert.equal(fam.familyOfPart(p), null, String(p));
  assert.equal(fam.deviceFamily({ family: 'spartan3e', part: 'xc6slx9' }), 'spartan6');
  assert.equal(fam.deviceFamily({ family: 'Virtex4' }), 'virtex4');
  assert.equal(fam.deviceFamily({}), null);
  assert.equal(fam.deviceFamily(null), null);
  assert.equal(fam.familyName('artix7'), 'Artix-7');
  assert.equal(fam.familyName('custom'), 'custom');
  assert.equal(fam.familyName(''), 'unknown family');
  assert.equal(fam.isSpartan3Like('spartan3adsp'), true);
  assert.equal(fam.isSpartan3Like(null), false);
  for (const [t, f] of [['Spartan3A and Spartan3AN', 'spartan3a'], ['Spartan-3A DSP', 'spartan3adsp'], ['spartan6', 'spartan6'], ['Spartan3AN', 'spartan3a'], ['Zynq', 'zynq'], ['', null], [null, null], ['CoolRunner2', null]]) {
    assert.equal(fam.familyFromXise(t), f, String(t));
  }
  assert.deepEqual(fam.splitBitPart('3s250ecp132'), { part: 'xc3s250e', package: 'cp132' });
  assert.deepEqual(fam.splitBitPart('XC6SLX9CSG324'), { part: 'xc6slx9', package: 'csg324' });
  assert.deepEqual(fam.splitBitPart('7a35tcpg236'), { part: 'xc7a35t', package: 'cpg236' });
  assert.deepEqual(fam.splitBitPart('3s700anfgg484'), { part: 'xc3s700an', package: 'fgg484' });
  assert.equal(fam.splitBitPart('garbage'), null);
  assert.equal(fam.splitBitPart(undefined), null);
});

// ------------------------------------------------------------------------------------------------
// zip error handling
// ------------------------------------------------------------------------------------------------

test('zip: corrupt central directory, encrypted entries, unknown method, size mismatch, foreign names', async () => {
  const codec = { deflate: d => zlib.deflateRawSync(d), inflate: d => zlib.inflateRawSync(d) };
  const good = await createZip([{ path: 'a.txt', data: 'hello' }], codec);
  const cdOffset = new DataView(good.buffer).getUint32(good.length - 22 + 16, true);
  const patch = (fn) => { const b = good.slice(); fn(new DataView(b.buffer)); return b; };
  await assert.rejects(readZip(patch(dv => dv.setUint32(cdOffset, 0x12345678, true)), codec), /corrupt zip central directory/);
  await assert.rejects(readZip(patch(dv => dv.setUint16(cdOffset + 8, 0x0801, true)), codec), /encrypted zip entries are not supported \(a.txt\)/);
  await assert.rejects(readZip(patch(dv => dv.setUint16(cdOffset + 10, 12, true)), codec), /unsupported zip compression method 12 \(a.txt\)/);
  await assert.rejects(readZip(patch(dv => dv.setUint32(cdOffset + 24, 99, true)), codec), /zip entry size mismatch \(a.txt\)/);
  // a name without the UTF-8 flag is read as latin1
  const latin = await readZip(patch(dv => dv.setUint16(cdOffset + 8, 0, true)), codec);
  assert.equal(latin[0].path, 'a.txt');
  // directories, __MACOSX and .DS_Store entries are skipped
  const z = await createZip([{ path: 'dir/', data: '' }, { path: '__MACOSX/._a', data: 'x' }, { path: 'x/.DS_Store', data: 'x' }, { path: 'win\\path.txt', data: new ArrayBuffer(3) }], codec);
  assert.deepEqual((await readZip(z, codec)).map(e => e.path), ['win/path.txt']);
  // a zip with a trailing comment is still found
  const withComment = new Uint8Array(good.length + 5);
  withComment.set(good);
  new DataView(withComment.buffer).setUint16(good.length - 2, 5, true);
  assert.equal((await readZip(withComment, codec)).length, 1);
  // the browser codec (CompressionStream) works in Node too
  const { browserCodec } = await import('../core/zip.js');
  const bz = await createZip([{ path: 'b.txt', data: 'b'.repeat(500) }], browserCodec());
  assert.equal(new TextDecoder().decode((await readZip(bz, browserCodec()))[0].data), 'b'.repeat(500));
  assert.equal((await readZip(bz, codec))[0].data.length, 500);
  // no codec: compressible data is stored
  const stored = await createZip([{ path: 'big.txt', data: 'a'.repeat(1000) }]);
  assert.equal((await readZip(stored)).length, 1);
});

test('unconstrainedPorts: a 1-bit vector port is x<0> in the UCF (VHDL and Verilog), a std_logic stays x', async () => {
  const vhd = { path: 't.vhd', lang: 'vhdl', text: 'library ieee; use ieee.std_logic_1164.all; entity t is port(a : in std_logic; b : in std_logic_vector(0 downto 0); c : out std_logic_vector(1 downto 0)); end t; architecture r of t is begin c <= a & b(0); end r;' };
  assert.deepEqual((await ise.unconstrainedPorts([vhd], 't', '')).map(u => u.net), ['a', 'b<0>', 'c<0>', 'c<1>']);
  assert.deepEqual((await ise.unconstrainedPorts([vhd], 't', 'NET "b<0>" LOC = "P1";')).map(u => u.net), ['a', 'c<0>', 'c<1>']);
  const v = { path: 'm.v', lang: 'verilog', text: 'module m(input a, input [0:0] b, output [1:0] c); assign c = {a, b}; endmodule' };
  assert.deepEqual((await ise.unconstrainedPorts([v], 'm', '')).map(u => u.net), ['a', 'b<0>', 'c<0>', 'c<1>']);
});

test('unconstrainedPorts: latch gates are clocks (GCLK pins); default-then-if logic and muxes are not', async () => {
  const vhd = { path: 't.vhd', lang: 'vhdl', text: `library ieee; use ieee.std_logic_1164.all;
entity t is port(g, d, e, s, a, b, x : in std_logic; q, r, y, z : out std_logic); end t;
architecture a of t is begin
  process (g, d) begin if g = '1' then q <= d; end if; end process;      -- latch, gate g
  r <= d when e = '1';                                                    -- latch, gate e
  y <= a when s = '1' else b;                                             -- mux
  process (x, a) begin z <= '0'; if x = '1' then z <= a; end if; end process;   -- default first: no latch
end a;` };
  const u = await ise.unconstrainedPorts([vhd], 't', '');
  assert.deepEqual(u.filter(p => p.clock).map(p => p.net).sort(), ['e', 'g']);
  const v = { path: 'm.v', lang: 'verilog', text: `module m(input g, input d, input s, input a, input b, output reg q, output reg y);
  always @(g or d) if (g) q = d;
  always @* begin if (s) y = a; else y = b; end
endmodule` };
  assert.deepEqual((await ise.unconstrainedPorts([v], 'm', '')).filter(p => p.clock).map(p => p.net), ['g']);
  const ld = { path: 'l.vhd', lang: 'vhdl', text: `library ieee; use ieee.std_logic_1164.all; library unisim; use unisim.vcomponents.all;
entity l is port(gate, d : in std_logic; q : out std_logic); end l;
architecture a of l is begin u : LD port map (G => gate, D => d, Q => q); end a;` };
  assert.deepEqual((await ise.unconstrainedPorts([ld], 'l', '')).filter(p => p.clock).map(p => p.net), ['gate']);
});

test('xise: implementation-only association round trip (Implementation only <-> role impl)', async () => {
  const { exportXise, importXise } = await import('../server/xise.js');
  const project = { name: 'p', top: 'top', device: { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' },
    files: [{ path: 'src/top.vhd', lang: 'vhdl', role: 'design' }, { path: 'src/syn_only.vhd', lang: 'vhdl', role: 'impl' }, { path: 'sim/tb.vhd', lang: 'vhdl', role: 'sim' }] };
  const x = exportXise(project, {});
  const block = (name) => new RegExp(`<file xil_pn:name="${name.replace(/[./]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</file>`).exec(x)[1];
  assert.match(block('src/top.vhd'), /BehavioralSimulation[\s\S]*Implementation/);
  assert.match(block('src/syn_only.vhd'), /Implementation/);
  assert.doesNotMatch(block('src/syn_only.vhd'), /Simulation/);
  assert.doesNotMatch(block('sim/tb.vhd'), /Implementation/);
  const back = importXise(x);
  assert.deepEqual(back.files.map(f => `${f.path}:${f.role}`), ['src/top.vhd:design', 'src/syn_only.vhd:impl', 'sim/tb.vhd:sim']);
});

test('xise: Top-Level Source Type round trip (Schematic <-> topSourceType sch, otherwise HDL)', async () => {
  const { exportXise, importXise } = await import('../server/xise.js');
  const base = { name: 'p', top: 'top', device: { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' }, files: [{ path: 'src/top.vhd', lang: 'vhdl', role: 'design' }] };
  const sch = exportXise({ ...base, topSourceType: 'sch' }, {});
  assert.match(sch, /<property xil_pn:name="Top-Level Source Type" xil_pn:value="Schematic"/);
  assert.equal(importXise(sch).topSourceType, 'sch');
  for (const t of ['hdl', 'fsm', 'tt', undefined]) {
    const x = exportXise({ ...base, topSourceType: t }, {});
    assert.match(x, /"Top-Level Source Type" xil_pn:value="HDL"/);
    assert.equal(importXise(x).topSourceType, 'hdl');
  }
});
