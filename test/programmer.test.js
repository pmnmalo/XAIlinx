// Board programming through the REST API with fake programmer binaries (openFPGALoader, xc3sprog,
// djtgcfg, iMPACT, adepttool + Platform Flash PROM): JTAG scan, SRAM programming, PROM operations,
// tool resolution / board defaults, failure detection, and the toolchain detection report.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scratchEnv, makeFakes, isolatedPath, startApp, waitJob, writeConfig, makeBit, POSIX_ONLY } from './server-helpers.js';

let tmp, fakes, app, jobs, P, prog, tc, oldPath;
const FAKE_ENV = ['FAKE_PROG_FAIL', 'FAKE_IMPACT_MODE', 'FAKE_PROG_LOG', 'FAKE_ADEPT_NODONE', 'FAKE_XCF_NOVERIFY', 'FAKE_ADEPT_FAIL', 'XILINX'];

before(async () => {
  tmp = await scratchEnv('silinx-prog-test-');
  fakes = await makeFakes(tmp);
  oldPath = process.env.PATH;
  process.env.PATH = isolatedPath(fakes.prog);
  delete process.env.XILINX;
  await writeConfig({ paths: { adepttool: fakes.adept } });
  jobs = await import('../server/jobs.js');
  P = await import('../server/projects.js');
  prog = await import('../server/programmer.js');
  tc = await import('../server/toolchain.js');
  app = await startApp();
  // a project with a bitstream for the Basys2 (xc3s250e-cp132)
  await P.createProject({ name: 'Prog', board: 'basys2' });
  await P.updateProject('Prog', pj => { pj.top = 'top'; });
  await fs.mkdir(path.join(P.projectDir('Prog'), 'build'), { recursive: true });
  await fs.writeFile(path.join(P.projectDir('Prog'), 'build', 'top.bit'), makeBit());
  await fs.writeFile(path.join(P.projectDir('Prog'), 'build', 'top_prom.bit'), makeBit());
});
afterEach(async () => {
  for (const k of FAKE_ENV) delete process.env[k];
  process.env.PATH = isolatedPath(fakes.prog);
  await writeConfig({ paths: { adepttool: fakes.adept } });
});
after(async () => {
  await app.close();
  process.env.PATH = oldPath;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function run(url, body) {
  const r = await app.call('POST', url, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return waitJob(jobs, r.body.job);
}
const bitPath = name => path.join(P.projectDir('Prog'), 'build', name);

// ------------------------------------------------------------------------------------------------
// JTAG scan
// ------------------------------------------------------------------------------------------------

test('scan: every tool runs and its chain listing is parsed', { skip: POSIX_ONLY }, async () => {
  let j = await run('/jtag/scan', { tool: 'openFPGALoader', cable: 'digilent_hs2' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result.devices, [{ idcode: '0x41c22093', name: 'xc3s500e' }]);
  assert.deepEqual(j.result.commands, [{ cmd: 'openFPGALoader', args: ['-c', 'digilent_hs2', '--detect'], code: 0 }]);
  assert.equal(j.meta.board, null);

  j = await run('/jtag/scan', { tool: 'xc3sprog', cable: 'xpc' });
  assert.deepEqual(j.result.devices, [{ position: 0, idcode: '0x41c22093', name: 'XC3S500E' }, { position: 1, idcode: '0xf5046093', name: 'XCF04S' }]);

  j = await run('/jtag/scan', { board: 'nexys2' });   // board default: djtgcfg enum + init -d Nexys2
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.equal(j.result.options.tool, 'djtgcfg');
  assert.deepEqual(j.result.devices, [{ adeptDevice: 'Nexys2' }, { position: 0, name: 'XC3S500E' }, { position: 1, name: 'XCF04S' }]);
  assert.ok(j.lines.some(l => /JTAG scan with djtgcfg \(device Nexys2\)/.test(l)));

  j = await run('/jtag/scan', { tool: 'impact', board: 's3e-starter' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result.devices, [{ name: 'xc3s500e' }, { position: 1, name: 'Xilinx xc3s500e', version: 1 }]);
  assert.ok(j.lines.includes('iMPACT batch script:'));
  assert.ok(j.lines.includes('  setCable -port auto'));

  j = await run('/jtag/scan', { tool: 'adepttool', board: 'basys2' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result.devices, [{ position: 0, idcode: '0x11c1a093', name: 'XC3S250E' }, { position: 1, idcode: '0xf5045093', name: 'XCF02S' }]);
  assert.ok(j.lines.some(l => /^NOTE: Open-source driver/.test(l)));
});

test('scan: failures (exit code, missing tool, bad options, unknown board)', { skip: POSIX_ONLY }, async () => {
  process.env.FAKE_PROG_FAIL = 'xc3sprog';
  let j = await run('/jtag/scan', { tool: 'xc3sprog', cable: 'xpc' });
  assert.equal(j.status, 'error');
  assert.equal(j.error, 'xc3sprog exited with code 1');
  assert.deepEqual(j.result.commands.map(c => c.code), [1]);
  delete process.env.FAKE_PROG_FAIL;

  j = await run('/jtag/scan', { tool: 'xc3sprog' });
  assert.match(j.error, /xc3sprog needs a cable/);
  j = await run('/jtag/scan', { tool: 'teleport' });
  assert.match(j.error, /unknown programming tool 'teleport'/);
  j = await run('/program', { project: 'Prog', tool: 'openFPGALoader', position: 99 });
  assert.match(j.error, /invalid chain position '99'/);

  await writeConfig({ paths: { openFPGALoader: path.join(tmp, 'nope', 'openFPGALoader'), adepttool: path.join(tmp, 'no-adepttool') } });
  j = await run('/jtag/scan', { tool: 'openFPGALoader' });
  assert.match(j.error, /openFPGALoader not found on PATH \(configured path .* is not executable\)/);
  j = await run('/jtag/scan', { tool: 'adepttool' });
  assert.match(j.error, /adepttool is not installed/);
  process.env.PATH = isolatedPath();
  j = await run('/jtag/scan', { tool: 'xc3sprog', cable: 'xpc' });
  assert.match(j.error, /^xc3sprog not found on PATH\. Install it/);

  const r = await app.call('POST', '/jtag/scan', { board: 'atari2600' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown board 'atari2600'/);
});

// ------------------------------------------------------------------------------------------------
// SRAM programming
// ------------------------------------------------------------------------------------------------

test('program: board default tool, bit header checks, explicit tools and positions', { skip: POSIX_ONLY }, async () => {
  process.env.FAKE_PROG_LOG = path.join(tmp, 'prog.log');
  let j = await run('/program', { project: 'Prog' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.equal(j.result.options.tool, 'djtgcfg');
  assert.equal(j.result.bitfile, bitPath('top.bit'));
  assert.deepEqual(j.result.warnings, []);
  assert.deepEqual(j.result.commands, [{ cmd: 'djtgcfg', args: ['prog', '-d', 'Basys2', '-i', '0', '-f', bitPath('top.bit')], code: 0 }]);
  assert.ok(j.lines.some(l => /device family: Spartan-3E/.test(l)));
  assert.ok(j.lines.includes('Programming finished.'));
  assert.deepEqual(j.meta, { project: 'Prog', bitfile: bitPath('top.bit'), board: 'basys2' });

  // the project's device differs from the bitstream part: warned, still programmed
  await P.updateProject('Prog', pj => { pj.device = { family: 'spartan3e', part: 'xc3s100e', package: 'cp132', speed: '-4' }; });
  j = await run('/program', { project: 'Prog', tool: 'openFPGALoader', cable: 'digilent_hs2', position: 1 });
  assert.equal(j.status, 'ok');
  assert.match(j.result.warnings[0], /built for '3s250ecp132' but the target device is 'xc3s100e-cp132'/);
  assert.deepEqual(j.result.commands[0].args, ['-c', 'digilent_hs2', '--index-chain', '1', bitPath('top.bit')]);
  assert.ok(j.lines.some(l => /defaults for this board are not verified/.test(l)));
  // explicit expected device (board-less) overrides the project's
  j = await run('/program', { project: 'Prog', tool: 'xc3sprog', cable: 'jtaghs1', expectDevice: { part: 'xc3s250e', package: 'cp132' } });
  assert.deepEqual(j.result.warnings, []);
  await P.updateProject('Prog', pj => { pj.device = { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' }; });

  // relative bitfile inside the project; unrecognised part in the header
  await fs.writeFile(bitPath('odd.bit'), makeBit({ part: 'weird123' }));
  j = await run('/program', { project: 'Prog', bitfile: 'build/odd.bit', tool: 'xc3sprog', cable: 'xpc' });
  assert.equal(j.status, 'ok');
  assert.ok(j.result.warnings.includes("unrecognised part 'weird123' in the bitstream header"));
  // absolute bitfile without a project, board from the request
  j = await run('/program', { bitfile: bitPath('top.bit'), board: 'nexys2', device: 'Nexys2b' });
  assert.equal(j.result.options.tool, 'djtgcfg');
  assert.deepEqual(j.result.commands[0].args.slice(0, 3), ['prog', '-d', 'Nexys2b']);
  assert.match(j.result.warnings[0] || '', /target device is 'xc3s500e-fg320'/);
  // absolute bitfile with a project
  j = await run('/program', { project: 'Prog', bitfile: bitPath('top.bit'), tool: 'djtgcfg', device: 'Basys2' });
  assert.equal(j.status, 'ok');
  const log = await fs.readFile(process.env.FAKE_PROG_LOG, 'utf8');
  assert.match(log, /^djtgcfg prog -d Basys2 -i 0 -f .*top\.bit$/m);
});

test('program: iMPACT success / silent failure / error message; adepttool DONE check; tool exit code', { skip: POSIX_ONLY }, async () => {
  let j = await run('/program', { project: 'Prog', tool: 'impact' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.ok(j.lines.some(l => /assignFile -p 1 -file ".*top\.bit"/.test(l)));
  process.env.FAKE_IMPACT_MODE = 'silent';
  j = await run('/program', { project: 'Prog', tool: 'impact' });
  assert.equal(j.status, 'error');
  assert.equal(j.error, 'iMPACT did not report "Programmed successfully"');
  assert.equal(j.result.options.tool, 'impact');
  process.env.FAKE_IMPACT_MODE = 'error';
  j = await run('/program', { project: 'Prog', tool: 'impact', position: 2 });
  assert.equal(j.error, 'iMPACT reported an error');
  delete process.env.FAKE_IMPACT_MODE;

  j = await run('/program', { project: 'Prog', tool: 'adepttool' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result.commands[0].args, ['--device', '0', bitPath('top.bit')]);
  process.env.FAKE_ADEPT_NODONE = '1';
  j = await run('/program', { project: 'Prog', tool: 'adepttool', device: '1' });
  assert.equal(j.error, 'the FPGA did not assert DONE (configuration failed)');
  delete process.env.FAKE_ADEPT_NODONE;

  process.env.FAKE_PROG_FAIL = 'djtgcfg';
  j = await run('/program', { project: 'Prog' });
  assert.equal(j.error, 'djtgcfg exited with code 1');
  assert.deepEqual(j.result.commands.map(c => c.code), [1]);
});

test('program: iMPACT not on PATH is run through settings64.sh in a bash wrapper (or refused)', { skip: POSIX_ONLY }, async () => {
  // an ISE install whose settings script puts impact on PATH; impact itself is not on PATH
  const root = path.join(tmp, 'Xilinx', '14.7', 'ISE_DS');
  const impactDir = path.join(tmp, 'impact-only');
  await fs.mkdir(impactDir, { recursive: true });
  await fs.copyFile(path.join(fakes.prog, 'impact'), path.join(impactDir, 'impact'));
  await fs.chmod(path.join(impactDir, 'impact'), 0o755);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'settings64.sh'), `export PATH="${impactDir}:$PATH"\n`);
  process.env.PATH = isolatedPath();
  await writeConfig({ local: { settings: path.join(root, 'settings64.sh') } });
  let j = await run('/program', { project: 'Prog', tool: 'impact' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.ok(j.lines.some(l => l.startsWith('$ ') && /bash -c/.test(l) && l.includes('settings64.sh')));

  await writeConfig({ local: { settings: '' } });
  j = await run('/program', { project: 'Prog', tool: 'impact' });
  assert.match(j.error, /iMPACT not found: install ISE 14.7/);
});

test('program: request errors', async () => {
  await P.createProject({ name: 'NoTop', board: 'basys2' });
  for (const [body, status, re] of [
    [{}, 400, /give a project or a bitfile/],
    [{ bitfile: 'build/top.bit' }, 400, /must be an absolute path when no project is given/],
    [{ project: 'NoTop' }, 400, /project has no top module/],
    [{ project: 'Prog', bitfile: 'build/top.ucf' }, 400, /only .bit files can be programmed/],
    [{ project: 'Prog', bitfile: 'build/none.bit' }, 404, /bitstream not found/],
    [{ project: 'Prog', bitfile: '../../escape.bit' }, 400, /path escapes project/],
    [{ project: 'Prog', board: 'nope' }, 400, /unknown board 'nope'/],
    [{ project: 'Ghost' }, 404, /not found/],
    [{ bitfile: path.join(tmp, 'missing.bit') }, 404, /run the implementation first/],
  ]) {
    const r = await app.call('POST', '/program', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  // the bitstream disappears between the request and the job
  const f = path.join(tmp, 'vanish.bit');
  await fs.writeFile(f, makeBit());
  const job = jobs.createJob('program', jj => prog.programJob(jj, { bitfile: f, tool: 'xc3sprog', cable: 'xpc' }));
  await fs.rm(f);
  const j = await waitJob(jobs, job.id);
  assert.match(j.error, /bitstream not found/);
});

// ------------------------------------------------------------------------------------------------
// Platform Flash PROM
// ------------------------------------------------------------------------------------------------

test('prom: program (+verify, +reconfigure), verify, erase, read backup, reconfigure', { skip: POSIX_ONLY }, async () => {
  process.env.FAKE_PROG_LOG = path.join(tmp, 'prom.log');
  let j = await run('/prom', { project: 'Prog', op: 'program', reconfigure: true });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result, { op: 'program', outfile: null });
  assert.ok(j.lines.some(l => /Platform Flash: program \+ reload FPGA from PROM/.test(l)));
  j = await run('/prom', { project: 'Prog', op: 'program', verify: false, device: '2' });
  assert.equal(j.status, 'ok');
  j = await run('/prom', { project: 'Prog', op: 'verify', bitfile: 'build/top.bit' });
  assert.equal(j.status, 'ok');
  assert.ok(j.lines.some(l => /does not look like a PROM bitstream/.test(l)));
  j = await run('/prom', { project: 'Prog', op: 'erase' });
  assert.equal(j.status, 'ok');
  j = await run('/prom', { project: 'Prog', op: 'read' });
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.match(j.result.outfile, /build[/\\]prom-backup[/\\]prom-.*\.bin$/);
  assert.equal(await fs.readFile(j.result.outfile, 'utf8'), 'PROMDATA');
  j = await run('/prom', { project: 'Prog', op: 'reconfigure' });
  assert.equal(j.status, 'ok');
  const log = await fs.readFile(process.env.FAKE_PROG_LOG, 'utf8');
  assert.match(log, /^python xcf_prog.py --device 0 program .*top_prom\.bit --reconfigure$/m);
  assert.match(log, /^python xcf_prog.py --device 2 program .*top_prom\.bit --no-verify$/m);
  // project device differs from the PROM image: warned
  await P.updateProject('Prog', pj => { pj.device = { family: 'spartan3e', part: 'xc3s100e', package: 'cp132', speed: '-4' }; });
  j = await run('/prom', { project: 'Prog', op: 'verify' });
  assert.ok(j.lines.some(l => /^WARNING: bitstream was built for/.test(l)));
  await P.updateProject('Prog', pj => { pj.device = { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' }; });
});

test('prom: failures and request errors', { skip: POSIX_ONLY }, async () => {
  process.env.FAKE_XCF_NOVERIFY = '1';
  let j = await run('/prom', { project: 'Prog', op: 'verify' });
  assert.equal(j.error, 'verification did not complete');
  delete process.env.FAKE_XCF_NOVERIFY;
  process.env.FAKE_ADEPT_NODONE = '1';
  j = await run('/prom', { project: 'Prog', op: 'reconfigure' });
  assert.match(j.error, /did not load from the PROM/);
  delete process.env.FAKE_ADEPT_NODONE;
  process.env.FAKE_ADEPT_FAIL = '1';
  j = await run('/prom', { project: 'Prog', op: 'erase' });
  assert.equal(j.error, 'xcf_prog exited with code 3');
  assert.deepEqual(j.result, { op: 'erase', code: 3 });
  delete process.env.FAKE_ADEPT_FAIL;
  j = await run('/prom', { project: 'Prog', op: 'format' });
  assert.match(j.error, /unknown PROM operation 'format'/);
  j = await run('/prom', { project: 'Prog', op: 'program', bitfile: 'build/none.bit' });
  assert.match(j.error, /bitstream not found/);
  const job = jobs.createJob('prom', jj => prog.promJob(jj, { op: 'read' }));
  assert.match((await waitJob(jobs, job.id)).error, /no output file/);
  await writeConfig({ paths: { adepttool: path.join(tmp, 'no-adepttool') } });
  j = await run('/prom', { project: 'Prog', op: 'erase' });
  assert.match(j.error, /PROM programming uses adepttool, which is not installed/);

  await P.createProject({ name: 'PromNoTop' });
  for (const [body, re] of [
    [{ op: 'erase' }, /give a project/],
    [{ project: 'Prog', op: 'erase', board: 'nope' }, /unknown board/],
    [{ project: 'PromNoTop', op: 'program' }, /project has no top module/],
    [{ project: 'Prog', op: 'program', bitfile: 'build/top.txt' }, /only .bit files/],
    [{ project: 'Prog', op: 'program', bitfile: '../x.bit' }, /path escapes project/],
  ]) {
    const r = await app.call('POST', '/prom', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
});

// ------------------------------------------------------------------------------------------------
// toolchain detection (programmers, ISE install, versions)
// ------------------------------------------------------------------------------------------------

test('toolchain report: programmers found with versions, adepttool, ISE via settings64.sh / $XILINX', { skip: POSIX_ONLY }, async () => {
  let r = await app.call('GET', '/toolchain');
  const pr = r.body.programmers;
  assert.deepEqual([pr.openFPGALoader.found, pr.openFPGALoader.version], [true, '0.12.1']);
  assert.deepEqual([pr.xc3sprog.found, pr.xc3sprog.version], [true, '$Rev: 795 $']);
  assert.deepEqual([pr.djtgcfg.found, pr.djtgcfg.version], [true, '2.4.3']);
  assert.equal(pr.impact.found, true);
  assert.equal(pr.impact.version, null);
  assert.equal(pr.adepttool.found, true);
  assert.equal(pr.adepttool.path, path.join(fakes.adept, 'src', 'basys2_prog.py'));
  assert.equal(r.body.ise.mode, 'local');

  // an ISE install found through $XILINX: version from the path, impact in its bin dir
  const root = path.join(tmp, 'opt', 'Xilinx', '14.7', 'ISE_DS');
  const bin = path.join(root, 'ISE', 'bin', 'lin64');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(root, 'settings64.sh'), '# fake\n');
  await fs.copyFile(path.join(fakes.prog, 'impact'), path.join(bin, 'impact'));
  await fs.chmod(path.join(bin, 'impact'), 0o755);
  process.env.XILINX = path.join(root, 'ISE');
  process.env.PATH = isolatedPath();
  r = await app.call('GET', '/toolchain');
  assert.equal(r.body.ise.found, true);
  assert.equal(r.body.ise.root, root);
  assert.equal(r.body.ise.binDir, bin);
  assert.equal(r.body.ise.version, '14.7');
  assert.equal(r.body.ise.available, true);
  assert.match(r.body.ise.reason, /ISE found via .*settings64.sh/);
  assert.deepEqual([r.body.programmers.impact.found, r.body.programmers.impact.path, r.body.programmers.impact.version], [true, path.join(bin, 'impact'), '14.7']);
  assert.equal(r.body.programmers.openFPGALoader.found, false);
  // configured impact path that is not executable: found through settings64.sh instead
  await writeConfig({ paths: { impact: path.join(tmp, 'nope'), adepttool: fakes.adept } });
  r = await app.call('GET', '/toolchain');
  assert.deepEqual(r.body.programmers.impact, { found: true, path: path.join(bin, 'impact'), version: '14.7', viaSettings: true });
  // $XILINX pointing at ISE_DS itself, settings32.sh only
  await fs.rm(path.join(root, 'settings64.sh'));
  await fs.writeFile(path.join(root, 'settings32.sh'), '# fake\n');
  process.env.XILINX = root;
  const ise = tc.detectIse({ local: { settings: '' } });
  assert.equal(ise.settings, path.join(root, 'settings32.sh'));
});

test('pure helpers: resolveOptions fallbacks, command builders, scan parsing, expected device', () => {
  const cfg = { programmer: { tool: '', cable: '' }, paths: { adepttool: fakes.adept } };
  // Basys2 prefers djtgcfg; when it is not installed the on-board adepttool is used
  process.env.PATH = isolatedPath();
  assert.equal(prog.resolveOptions({}, cfg, 'basys2').tool, 'adepttool');
  assert.equal(prog.resolveOptions({}, { ...cfg, paths: { adepttool: path.join(tmp, 'x') } }, 'basys2').tool, 'djtgcfg');
  process.env.PATH = isolatedPath(fakes.prog);
  assert.equal(prog.resolveOptions({}, cfg, 'basys2').tool, 'djtgcfg');
  assert.equal(prog.toolAvailable('xc3sprog', cfg), true);
  // global config defaults
  const g = prog.resolveOptions({}, { programmer: { tool: 'xc3sprog', cable: 'ftdi' } }, null);
  assert.deepEqual([g.tool, g.cable, g.position, g.board, g.fromBoard], ['xc3sprog', 'ftdi', 0, null, false]);
  assert.equal(prog.resolveOptions({}, {}, null).tool, 'openFPGALoader');
  assert.equal(prog.resolveOptions({ tool: 'impact' }, {}, null).cable, 'auto');
  assert.equal(prog.resolveOptions({ tool: 'impact', position: 3 }, {}, 'nexys2').position, 3);
  assert.equal(prog.resolveOptions({ tool: 'djtgcfg' }, {}, 'nexys2').fromBoard, true);
  assert.equal(prog.resolveOptions({ tool: 'impact' }, {}, 'nexys2').fromBoard, false);
  assert.throws(() => prog.resolveOptions({}, { programmer: { tool: 'magic' } }, null), e => e.status === 400 && /unknown programming tool 'magic'/.test(e.message));

  assert.deepEqual(prog.buildCommands('scan', { tool: 'openFPGALoader' }), [{ cmd: 'openFPGALoader', args: ['--detect'] }]);
  assert.deepEqual(prog.buildCommands('program', { tool: 'openFPGALoader', bitfile: '/b.bit' }), [{ cmd: 'openFPGALoader', args: ['/b.bit'] }]);
  assert.deepEqual(prog.buildCommands('scan', { tool: 'djtgcfg' }), [{ cmd: 'djtgcfg', args: ['enum'] }]);
  assert.deepEqual(prog.buildCommands('scan', { tool: 'adepttool' }), [{ cmd: 'adepttool', script: 'list.py', args: [] }]);
  assert.deepEqual(prog.buildCommands('program', { tool: 'adepttool', device: 'x', bitfile: '/b.bit' }), [{ cmd: 'adepttool', script: 'basys2_prog.py', args: ['--device', '0', '/b.bit'] }]);
  assert.deepEqual(prog.buildCommands('program', { tool: 'xc3sprog', cable: 'xpc', bitfile: '/b.bit', position: '' }), [{ cmd: 'xc3sprog', args: ['-c', 'xpc', '-v', '-p', '0', '/b.bit'] }]);
  assert.match(prog.buildCommands('scan', { tool: 'impact', cable: 'usb21' })[0].impactScript, /setCable -port usb21\n/);
  assert.throws(() => prog.buildCommands('program', { tool: 'impact' }), /no bitstream file/);
  for (const position of [-1, 32, 'x']) assert.throws(() => prog.buildCommands('scan', { tool: 'impact', position }), /invalid chain position/);
  assert.throws(() => prog.impactScript({ cable: 'usb; rm -rf /' }), /invalid iMPACT cable port/);
  assert.throws(() => prog.impactScript({ bitfile: '/a"b.bit' }), /unsupported characters/);
  assert.match(prog.impactScript({ bitfile: '/a.bit', position: 'x' }), /assignFile -p 1 /);

  const lines = [
    'index 0:', '\tmodel  stray',   // a model line before any idcode is ignored
    '\tidcode 0x41c22093', '\tmodel  xc3s500e',
  ];
  assert.deepEqual(prog.parseScanOutput('openFPGALoader', lines), [{ idcode: '0x41c22093', name: 'xc3s500e' }]);
  assert.deepEqual(prog.parseScanOutput('unknown', lines), []);

  assert.deepEqual(prog.expectedDevice({ device: { part: 'xc3s500e' } }, 'basys2'), { part: 'xc3s500e' });
  assert.equal(prog.expectedDevice({ device: {} }, 'basys2').part, 'xc3s250e');
  assert.equal(prog.expectedDevice(null, null), null);
  assert.equal(prog.expectedDevice(null, 'nope'), null);
  assert.equal(prog.checkBitPart(null, { part: 'x' }), null);
  assert.equal(prog.checkBitPart({ part: '3s250ecp132' }, {}), null);
  assert.equal(prog.checkBitPart({ part: 'xc3s250ecp132' }, { part: 'XC3S250E', package: 'CP132' }), null);
  assert.throws(() => prog.parseBitHeader(makeBit().subarray(0, 13)), /no part name/);
  const weird = makeBit();
  weird[13] = 'z'.charCodeAt(0);
  assert.throws(() => prog.parseBitHeader(weird), /unexpected .bit header field 'z'/);
  const badMagic = makeBit();
  badMagic[5] = 0;
  assert.throws(() => prog.parseBitHeader(badMagic), /bad magic/);
  assert.equal(prog.parseBitHeader(new Uint8Array(makeBit({ design: 'top.ncd' }))).userId, null);
  assert.deepEqual(prog.adepttoolPaths({ paths: { adepttool: path.join(tmp, 'x'), adepttoolPython: '/usr/bin/false' } }), { root: path.join(tmp, 'x'), src: path.join(tmp, 'x'), py: '/usr/bin/false', ok: false });
});
