// Command line (bin/silinx-ise.js): every subcommand, help, exit codes and error messages.
// Each run is a real `node bin/silinx-ise.js ...` with HOME, SILINX_WORKSPACE and SILINX_CONFIG_DIR in a
// scratch directory and a PATH of fake tools only, so nothing touches ~/Silinx-projects or ~/.silinx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { scratchEnv, makeFakes, isolatedPath, startApp, sleep, ROOT, POSIX_ONLY } from './server-helpers.js';

const CLI = path.join(ROOT, 'bin', 'silinx-ise.js');
// lets a killed `serve` exit normally (so its coverage is written)
const EXIT_ON_TERM = `--import=data:text/javascript,process.on('SIGTERM',()=>process.exit(0))`;

let tmp, fakes, home, env;
before(async () => {
  tmp = await scratchEnv('silinx-cli-test-');
  fakes = await makeFakes(tmp);
  home = path.join(tmp, 'home');
  await fs.mkdir(home, { recursive: true });
  env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    SILINX_WORKSPACE: process.env.SILINX_WORKSPACE, SILINX_CONFIG_DIR: process.env.SILINX_CONFIG_DIR,
    PATH: isolatedPath(fakes.open),
    FAKE_OPEN_LOG: path.join(tmp, 'open.log'),
  };
  delete env.XILINX;
  delete env.PORT;
});
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

/** Run the CLI to completion: { code, out, err }. */
function cli(args, { extraEnv = {}, cwd = tmp, nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [...nodeArgs, CLI, ...args], { cwd, env: { ...env, ...extraEnv } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, out, err }));
  });
}

/** Start a long-running CLI (serve) and wait until stdout matches `re`. */
function cliUntil(args, re, { extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [EXIT_ON_TERM, CLI, ...args], { cwd: tmp, env: { ...env, ...extraEnv } });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout waiting for ${re}\nstdout: ${out}\nstderr: ${err}`)); }, 10000);
    p.stdout.on('data', d => { out += d; if (re.test(out)) { clearTimeout(timer); resolve({ proc: p, out: () => out, err: () => err }); } });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => { clearTimeout(timer); reject(new Error(`exited (${code}) before ${re}\nstdout: ${out}\nstderr: ${err}`)); });
  });
}
const stop = p => new Promise(r => { if (p.exitCode !== null) return r(); p.removeAllListeners('close'); p.on('close', r); p.kill('SIGTERM'); });

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}

const TOP_V = 'module top(input clk, input [1:0] sw, output reg [1:0] led, output dbg);\n  always @(posedge clk) led <= sw;\n  assign dbg = 1\'b0;\nendmodule\n';
const TB_V = (want) => `module tb;\n  reg clk = 0; reg [1:0] sw = 2'b10; wire [1:0] led; wire dbg;\n  top dut(.clk(clk), .sw(sw), .led(led), .dbg(dbg));\n  always #5 clk = ~clk;\n  initial begin #20 $display("led=%b", led); if (led != 2'b${want}) $error("mismatch"); $finish; end\nendmodule\n`;

async function project(name, { tb = TB_V('10'), top = TOP_V, pj = {} } = {}) {
  const dir = path.join(tmp, 'projects', name);
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sim'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'top.v'), top);
  await fs.writeFile(path.join(dir, 'sim', 'tb.v'), tb);
  await fs.writeFile(path.join(dir, 'silinx.json'), JSON.stringify({
    name, device: { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' }, top: 'top', simTop: 'tb',
    files: [{ path: 'src/top.v', lang: 'verilog', role: 'design' }, { path: 'sim/tb.v', lang: 'verilog', role: 'sim' }], ...pj,
  }));
  return dir;
}

// ------------------------------------------------------------------------------------------------
// help / unknown commands
// ------------------------------------------------------------------------------------------------

test('help: `help`, --help, -h and `<command> --help` print the usage and run nothing', async () => {
  const runs = await Promise.all([['help'], ['--help'], ['-h'], ['serve', '--help'], ['check', '--help'], ['sim', '-h'], ['ucf', '--help'], ['toolchain', '--help']].map(a => cli(a)));
  for (const r of runs) {
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^usage:\n {2}silinx-ise serve/);
    for (const c of ['check', 'sim', 'ucf', 'toolchain']) assert.match(r.out, new RegExp(`silinx-ise ${c} `));
    assert.equal(r.err, '');
  }
  assert.ok(!fss.existsSync(path.join(process.env.SILINX_CONFIG_DIR, 'config.json')), 'toolchain --help changed nothing');
});

test('unknown command: error message + usage on stderr, exit code 1', async () => {
  const r = await cli(['frobnicate']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^silinx-ise: unknown command 'frobnicate'\nusage:/);
  assert.equal(r.out, '');
});

// ------------------------------------------------------------------------------------------------
// check / sim
// ------------------------------------------------------------------------------------------------

test('check: OK design (exit 0), --top, errors (exit 1), missing project (exit 1)', async () => {
  const dir = await project('Chk');
  let r = await cli(['check', dir]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^OK: top elaborated \(\d+ signals, \d+ processes\)$/m);
  r = await cli(['check', '--top', 'top', dir]);
  assert.equal(r.code, 0, r.err);
  r = await cli(['check'], { cwd: dir });   // default: the current directory
  assert.equal(r.code, 0, r.err);
  r = await cli(['check', dir, '--top', 'nosuch']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^ERROR: /m);

  const bad = await project('ChkBad', { top: 'module top(input a, output y);\n  assign y = ;\nendmodule\n' });
  r = await cli(['check', bad]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^ERROR: src\/top\.v:2:\d+: /m);

  r = await cli(['check', path.join(tmp, 'nowhere')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^silinx-ise: no Silinx project in .*nowhere \(silinx.json not found\)$/m);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
  await fs.mkdir(path.join(tmp, 'broken'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'broken', 'silinx.json'), '{nope');
  r = await cli(['check', path.join(tmp, 'broken')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^silinx-ise: cannot read .*silinx.json: /);
  r = await cli(['check', path.join(tmp, 'broken')], { extraEnv: { SILINX_DEBUG: '1' } });
  assert.match(r.err, /\n\s+at /, 'SILINX_DEBUG shows the stack');
});

test('sim: passing testbench (exit 0) with VCD, failing assertion (exit 2), --top / --time', async () => {
  const dir = await project('Sim');
  const vcd = path.join(tmp, 'sim.vcd');
  let r = await cli(['sim', dir, '--time', '100', '--vcd', vcd]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /^\[20\.000 ns\] led=10$/m);
  assert.match(r.out, /^Simulation stopped at 20 ns \(finish\)$/m);
  assert.match(r.out, /VCD written to .*sim\.vcd/);
  assert.match(await fs.readFile(vcd, 'utf8'), /\$enddefinitions/);
  // the design top alone: runs until --time
  r = await cli(['sim', dir, '--top', 'top', '--time', '50']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /^Simulation stopped at 50 ns$/m);

  const failing = await project('SimBad', { tb: TB_V('01') });
  r = await cli(['sim', failing]);
  assert.equal(r.code, 2);
  assert.match(r.out, /ERROR: mismatch/);
  // a compile error stops before simulating
  const broken = await project('SimBroken', { tb: 'module tb; initial begin $display("x") end endmodule\n' });
  r = await cli(['sim', broken]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^ERROR: sim\/tb\.v:/m);
});

// ------------------------------------------------------------------------------------------------
// ucf
// ------------------------------------------------------------------------------------------------

test('ucf: pins from a board written to the constraints file and the project updated', async () => {
  const dir = await project('Ucf', { pj: { constraints: '' } });
  let r = await cli(['ucf', dir, '--board', 'basys2']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^constraints\/top\.ucf: clk, sw, led assigned for Digilent Basys2; NOT assigned: dbg$/m);
  const ucf = await fs.readFile(path.join(dir, 'constraints', 'top.ucf'), 'utf8');
  assert.match(ucf, /^# UCF for top 'top' on Digilent Basys2 \(xc3s250e-4-cp132\), generated by Silinx/);
  assert.match(ucf, /NET "led<1>" LOC = "M11"/);
  const pj = JSON.parse(await fs.readFile(path.join(dir, 'silinx.json'), 'utf8'));
  assert.equal(pj.board, 'basys2');
  assert.equal(pj.constraints, 'constraints/top.ucf');
  assert.deepEqual(pj.device, { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' });
  assert.deepEqual((await fs.readdir(dir)).filter(f => f.endsWith('.tmp')), []);
  // --part picks the board variant; the saved board is used when --board is omitted
  r = await cli(['ucf', '--part', 'xc3s100e', dir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'silinx.json'), 'utf8')).device.part, 'xc3s100e');
  // custom constraints path is kept
  const dir2 = await project('Ucf2', { pj: { constraints: 'pins/board.ucf', board: 'nexys2' } });
  r = await cli(['ucf', dir2]);
  assert.equal(r.code, 0, r.err);
  assert.ok(fss.existsSync(path.join(dir2, 'pins', 'board.ucf')));
});

test('ucf: unknown / missing board and a top that does not elaborate exit 1', async () => {
  const dir = await project('UcfBad');
  let r = await cli(['ucf', dir, '--board', 'zx81']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^unknown board 'zx81'$/m);
  r = await cli(['ucf', dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^no board: give --board <id>/m);
  const noTop = await project('UcfNoTop', { pj: { top: 'missing' } });
  r = await cli(['ucf', noTop, '--board', 'basys2']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^cannot elaborate top 'missing'$/m);
});

// ------------------------------------------------------------------------------------------------
// toolchain
// ------------------------------------------------------------------------------------------------

test('toolchain: report, --docker configuration (available / not available)', { skip: POSIX_ONLY }, async () => {
  let r = await cli(['toolchain']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^ISE \(local\): NOT available - Xilinx ISE 14.7 not found/m);
  assert.match(r.out, /^programmers: none$/m);

  const withTools = { PATH: isolatedPath(fakes.prog, fakes.docker) };
  r = await cli(['toolchain'], { extraEnv: withTools });
  const progs = /^programmers: (.*)$/m.exec(r.out)[1].split(', ').sort();
  assert.deepEqual(progs, ['djtgcfg', 'impact', 'openFPGALoader', 'xc3sprog']);

  r = await cli(['toolchain', '--docker', 'silinx/ise:14.7', '--settings', '/opt/ise/settings64.sh'], { extraEnv: withTools });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /^Silinx configured to run Xilinx ISE from docker image 'silinx\/ise:14.7'\.$/m);
  assert.match(r.out, /^ISE \(docker\): available - docker image silinx\/ise:14.7$/m);
  const cfg = JSON.parse(await fs.readFile(path.join(process.env.SILINX_CONFIG_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg.mode, 'docker');
  assert.equal(cfg.docker.image, 'silinx/ise:14.7');
  assert.equal(cfg.docker.settings, '/opt/ise/settings64.sh');
  assert.ok(!fss.existsSync(path.join(home, '.silinx')), 'the real ~/.silinx is never used');

  // the image is not present locally: configured, but exit code 1
  r = await cli(['toolchain', '--docker', 'other/ise:1'], { extraEnv: { ...withTools, FAKE_DOCKER_NO_IMAGE: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /^ISE \(docker\): NOT available - docker image 'other\/ise:1' not present locally/m);
  // no docker at all
  await fs.writeFile(path.join(process.env.SILINX_CONFIG_DIR, 'config.json'), JSON.stringify({ docker: { command: path.join(tmp, 'no-docker') } }));
  r = await cli(['toolchain', '--docker', 'x/y']);
  assert.equal(r.code, 1);
  assert.match(r.out, /command not found/);
  await fs.rm(path.join(process.env.SILINX_CONFIG_DIR, 'config.json'));
});

// ------------------------------------------------------------------------------------------------
// serve
// ------------------------------------------------------------------------------------------------

test('serve: starts on the given port with the scratch workspace and opens the browser with --open', { skip: POSIX_ONLY }, async () => {
  const port = await freePort();
  const s = await cliUntil(['serve', '--port', String(port), '--host', '127.0.0.1', '--open'], /Keep this window open/);
  try {
    assert.match(s.out(), new RegExp(`Silinx running at http://127.0.0.1:${port} {2}\\(workspace: ${process.env.SILINX_WORKSPACE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    const r = await fetch(`http://127.0.0.1:${port}/api/projects`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(await r.json()));
    for (let i = 0; i < 300 && !fss.existsSync(env.FAKE_OPEN_LOG); i++) await sleep(10);
    assert.match(await fs.readFile(env.FAKE_OPEN_LOG, 'utf8'), new RegExp(`(open|xdg-open) http://127.0.0.1:${port}`));
  } finally { await stop(s.proc); }
  await fs.rm(env.FAKE_OPEN_LOG, { force: true });
  // PORT from the environment, host 0.0.0.0 shown as 127.0.0.1 in the URL
  const port2 = await freePort();
  const s2 = await cliUntil(['serve', '--host', '0.0.0.0'], /Keep this window open/, { extraEnv: { PORT: String(port2) } });
  try {
    assert.match(s2.out(), new RegExp(`Silinx running at http://0.0.0.0:${port2}`));
    assert.equal((await fetch(`http://127.0.0.1:${port2}/api/templates`)).status, 200);
  } finally { await stop(s2.proc); }
});

test('serve: port already used by Silinx -> "already running" (exit 0, opens it); by another program -> exit 1', { skip: POSIX_ONLY }, async () => {
  const app = await startApp();
  try {
    const r = await cli(['serve', '--port', String(app.port), '--open']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`^Silinx is already running at http://127.0.0.1:${app.port}$`, 'm'));
    for (let i = 0; i < 300 && !fss.existsSync(env.FAKE_OPEN_LOG); i++) await sleep(10);
    assert.match(await fs.readFile(env.FAKE_OPEN_LOG, 'utf8'), new RegExp(`http://127.0.0.1:${app.port}`));
    const r2 = await cli(['serve', '--port', String(app.port)]);
    assert.equal(r2.code, 0);
  } finally { await app.close(); }

  const other = http.createServer((req, res) => { res.statusCode = 404; res.end('nope'); });
  await new Promise(r => other.listen(0, '127.0.0.1', r));
  const port = other.address().port;
  try {
    const r = await cli(['serve', '--port', String(port)]);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`Port ${port} is used by another program\\. Start Silinx on another port: node bin/silinx-ise.js serve --port ${port + 1}`));
  } finally {
    other.closeAllConnections?.();
    await new Promise(r => other.close(r));
  }
  // any other listen error is fatal (exit 1, message on stderr)
  const r = await cli(['serve', '--port', '99999']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^silinx-ise: .*(port|99999)/im);
});
