// REST API: projects CRUD, files (read / write / rename / delete, folders), sources, templates,
// devices, toolchain config, .xise export / import / sync, zip export / import (ISE and Silinx kinds),
// the security guard (foreign Host, cross-origin writes), error statuses and path traversal attempts.
// In-process server on a random port; workspace and config in a scratch directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { scratchEnv, startApp, makeFakes, sleep, HERE, POSIX_ONLY } from './server-helpers.js';
import { createZip, readZip, textOf } from '../core/zip.js';

const codec = { deflate: d => zlib.deflateRawSync(d), inflate: d => zlib.inflateRawSync(d) };
const zip = async files => Buffer.from(await createZip(files, codec));
const unzip = async buf => Object.fromEntries((await readZip(new Uint8Array(buf), codec)).map(e => [e.path, textOf(e)]));

let tmp, app, P;
before(async () => {
  tmp = await scratchEnv('silinx-api-test-');
  P = await import('../server/projects.js');
  app = await startApp();
});
after(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
});
const call = (...a) => app.call(...a);

// ------------------------------------------------------------------------------------------------
// projects
// ------------------------------------------------------------------------------------------------

test('projects: create (empty + template), list, read with file tree, write, delete to .trash', async () => {
  let r = await call('GET', '/projects');
  assert.deepEqual(r.body, []);   // the workspace is created on demand
  r = await call('POST', '/projects', { name: 'Alpha' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Alpha');
  assert.deepEqual(r.body.device, { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' });
  assert.equal(r.body.board, null);
  assert.equal(r.body.constraints, 'constraints/top.ucf');
  for (const d of ['src', 'sim', 'constraints']) assert.ok(fss.statSync(path.join(P.projectDir('Alpha'), d)).isDirectory());

  const tpl = await call('GET', '/templates');
  assert.ok(tpl.body.includes('blinky'));
  r = await call('POST', '/projects', { name: 'Blink', template: 'blinky', device: { family: 'spartan3e', part: 'xc3s100e', package: 'cp132', speed: '-4' }, board: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.top, 'top');
  assert.equal(r.body.device.part, 'xc3s100e');
  assert.equal(r.body.board, null);
  r = await call('POST', '/projects', { name: 'Blink2', template: 'blinky' });
  assert.equal(r.body.board, 'basys2');   // the template's own settings are kept

  r = await call('GET', '/projects/Blink');
  assert.equal(r.status, 200);
  assert.ok(r.body.fileTree.includes('src/top.vhd'));
  assert.ok(!r.body.fileTree.includes('silinx.json'));

  // not projects: a dot folder, a folder without silinx.json, a broken silinx.json, a plain file
  const ws = P.workspaceDir();
  await fs.mkdir(path.join(ws, '.hidden'), { recursive: true });
  await fs.mkdir(path.join(ws, 'NotAProject'), { recursive: true });
  await fs.mkdir(path.join(ws, 'Broken'), { recursive: true });
  await fs.writeFile(path.join(ws, 'Broken', 'silinx.json'), '{oops');
  await fs.writeFile(path.join(ws, 'stray.txt'), 'x');
  r = await call('GET', '/projects');
  assert.deepEqual(r.body.map(p => p.name), ['Alpha', 'Blink', 'Blink2']);
  assert.deepEqual(r.body[1], { name: 'Blink', device: { family: 'spartan3e', part: 'xc3s100e', package: 'cp132', speed: '-4' }, top: 'top', board: null });
  assert.equal((await call('GET', '/projects/Broken')).status, 404);

  // PUT replaces silinx.json (name forced, fileTree dropped)
  r = await call('PUT', '/projects/Alpha', { name: 'Other', top: 'x', files: [], fileTree: ['junk'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Alpha');
  const saved = JSON.parse(await fs.readFile(path.join(P.projectDir('Alpha'), 'silinx.json'), 'utf8'));
  assert.equal(saved.top, 'x');
  assert.equal(saved.fileTree, undefined);
  for (const bad of [[1, 2], '"text"']) {
    r = await call('PUT', '/projects/Alpha', typeof bad === 'string' ? bad : bad, typeof bad === 'string' ? { 'content-type': 'text/plain' } : {});
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /expected a JSON project object/);
  }

  // delete moves the folder to .trash
  r = await call('DELETE', '/projects/Blink2');
  assert.deepEqual(r.body, { ok: true });
  assert.equal((await call('GET', '/projects/Blink2')).status, 404);
  assert.ok((await fs.readdir(path.join(ws, '.trash'))).some(n => n.startsWith('Blink2-')));
  r = await call('DELETE', '/projects/Blink2');
  assert.equal(r.status, 404);
});

test('projects: invalid names, duplicates and unknown templates', async () => {
  for (const name of ['', '1abc', 'a b', '../x', 'x'.repeat(65), 'a.b']) {
    const r = await call('POST', '/projects', { name });
    assert.equal(r.status, 400, name);
    assert.match(r.body.error, /invalid project name/);
  }
  assert.equal((await call('POST', '/projects', {})).status, 400);
  await call('POST', '/projects', { name: 'Dup' });
  const d = await call('POST', '/projects', { name: 'Dup' });
  assert.equal(d.status, 409);
  assert.match(d.body.error, /already exists/);
  for (const template of ['nope', '../examples/blinky', 'a/b']) {
    const r = await call('POST', '/projects', { name: 'Tpl', template });
    assert.equal(r.status, 400, template);
    assert.match(r.body.error, /unknown template/);
  }
  assert.equal((await call('GET', '/projects/Nope')).status, 404);
  assert.equal((await call('GET', '/projects/no%20pe')).status, 400);
  assert.equal((await call('DELETE', '/projects/..')).status, 404);   // never reaches the router as a name
});

// ------------------------------------------------------------------------------------------------
// files
// ------------------------------------------------------------------------------------------------

test('files: write (text and JSON bodies) registers HDL with a role, read back, sources', async () => {
  await call('POST', '/projects', { name: 'Files' });
  let r = await call('PUT', '/projects/Files/file?path=src/top.v', 'module top; endmodule\n');
  assert.deepEqual(r.body, { ok: true });
  r = await call('PUT', '/projects/Files/file?path=src/pkg.vhd', { text: 'package p is end;\n' });
  assert.equal(r.status, 200);
  await call('PUT', '/projects/Files/file?path=sim/check.v', 'module check; endmodule\n');
  await call('PUT', '/projects/Files/file?path=src/tb_top.vhd', 'entity tb_top is end;\n');
  await call('PUT', '/projects/Files/file?path=src/top_tb.v', 'module top_tb; endmodule\n');
  await call('PUT', '/projects/Files/file?path=notes/readme.txt', 'hello\n');
  await call('PUT', '/projects/Files/file?path=src/empty.v', {});   // JSON without text: empty file
  await call('PUT', '/projects/Files/file?path=src/top.v', 'module top(); endmodule\n');   // rewrite: registered once
  const pj = await P.readProject('Files');
  assert.deepEqual(pj.files, [
    { path: 'src/top.v', lang: 'verilog', role: 'design' },
    { path: 'src/pkg.vhd', lang: 'vhdl', role: 'design' },
    { path: 'sim/check.v', lang: 'verilog', role: 'sim' },
    { path: 'src/tb_top.vhd', lang: 'vhdl', role: 'sim' },
    { path: 'src/top_tb.v', lang: 'verilog', role: 'sim' },
    { path: 'src/empty.v', lang: 'verilog', role: 'design' },
  ]);
  r = await call('GET', '/projects/Files/file?path=notes/readme.txt');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'hello\n');
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.equal((await call('GET', '/projects/Files/file?path=src/empty.v')).body, '');

  await fs.rm(path.join(P.projectDir('Files'), 'src/pkg.vhd'));
  r = await call('GET', '/projects/Files/sources');
  assert.equal(r.body.length, 6);
  assert.equal(r.body[0].text, 'module top(); endmodule\n');
  assert.deepEqual(r.body.find(f => f.path === 'src/pkg.vhd'), { path: 'src/pkg.vhd', lang: 'vhdl', role: 'design', text: '', missing: true });
  assert.equal((await call('GET', '/projects/Nope/sources')).status, 404);
});

test('files: missing / traversing / absolute paths are refused, missing files are 404, I/O errors are 500', async () => {
  await call('POST', '/projects', { name: 'Trav' });
  const bad = ['../Files/src/top.v', '../../etc/passwd', '/etc/passwd', 'src/../../x', '..'];
  for (const p of bad) {
    for (const [m, body] of [['GET'], ['PUT', 'x'], ['DELETE']]) {
      const r = await call(m, `/projects/Trav/file?path=${encodeURIComponent(p)}`, body);
      assert.equal(r.status, 400, `${m} ${p}`);
      assert.match(String(r.body.error), /path escapes project/, `${m} ${p} ${String(r.body)}`);
    }
    const r = await call('POST', '/projects/Trav/rename', { from: p, to: 'x.v' });
    assert.equal(r.status, 400, `rename from ${p}`);
    const r2 = await call('POST', '/projects/Trav/rename', { from: 'src', to: p });
    assert.equal(r2.status, 400, `rename to ${p}`);
  }
  let r = await call('GET', '/projects/Trav/file');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /missing path/);
  assert.equal((await call('PUT', '/projects/Trav/file', 'x')).status, 400);
  assert.equal((await call('DELETE', '/projects/Trav/file')).status, 400);
  r = await call('GET', '/projects/Trav/file?path=src/none.v');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /file 'src\/none.v' not found/);
  assert.equal((await call('GET', '/projects/Trav/file?path=src')).status, 404);   // a folder is not a file
  // writing over a folder is an internal error (500), reported as JSON
  r = await call('PUT', '/projects/Trav/file?path=src', 'x');
  assert.equal(r.status, 500);
  assert.match(r.body.error, /EISDIR|EPERM|illegal operation/i);
  // deleting a file that is not there is fine (idempotent)
  assert.equal((await call('DELETE', '/projects/Trav/file?path=nothing.txt')).status, 200);
  // nothing escaped the project
  assert.ok(!fss.existsSync(path.join(P.workspaceDir(), 'x')));
});

test('files: rename files and folders (registration, language, constraints, conflicts, case-only rename)', async () => {
  await call('POST', '/projects', { name: 'Mv' });
  await call('PUT', '/projects/Mv/file?path=src/a.v', 'module a; endmodule\n');
  await call('PUT', '/projects/Mv/file?path=src/b.v', 'module b; endmodule\n');
  await call('PUT', '/projects/Mv/file?path=constraints/top.ucf', '\n');
  let r = await call('POST', '/projects/Mv/rename', { from: 'src/a.v', to: 'src/a.vhd' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files[0], { path: 'src/a.vhd', lang: 'vhdl', role: 'design' });
  r = await call('POST', '/projects/Mv/rename', { from: 'src/a.vhd', to: 'docs/a.txt' });
  assert.deepEqual(r.body.files[0], { path: 'docs/a.txt', lang: 'vhdl', role: 'design' });   // non-HDL extension keeps the language
  r = await call('POST', '/projects/Mv/rename', { from: 'constraints/top.ucf', to: 'pins.ucf' });
  assert.equal(r.body.constraints, 'pins.ucf');
  r = await call('POST', '/projects/Mv/rename', { from: 'src/b.v', to: 'src/B.v' });   // case only
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.files.some(f => f.path === 'src/B.v'));
  r = await call('POST', '/projects/Mv/rename', { from: 'src/B.v', to: 'src/B.v' });   // no-op
  assert.equal(r.status, 200);

  await call('PUT', '/projects/Mv/file?path=src/c.v', 'module c; endmodule\n');
  r = await call('POST', '/projects/Mv/rename', { from: 'src/c.v', to: 'src/B.v' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already exists/);
  r = await call('POST', '/projects/Mv/rename', { from: 'src/zzz.v', to: 'src/y.v' });
  assert.equal(r.status, 404);
  for (const body of [{}, { from: 'src/c.v' }, { to: 'x' }]) assert.equal((await call('POST', '/projects/Mv/rename', body)).status, 400);
  for (const [from, to] of [['silinx.json', 'x.json'], ['src/c.v', 'silinx.json'], ['.', 'x'], ['src', '.'], ['src', 'src/sub']]) {
    r = await call('POST', '/projects/Mv/rename', { from, to });
    assert.equal(r.status, 400, `${from} -> ${to}`);
  }
  // a folder with the project's constraints inside
  await call('PUT', '/projects/Mv/file?path=pins/board.ucf', '\n');
  await P.updateProject('Mv', pj => { pj.constraints = 'pins/board.ucf'; });
  r = await call('POST', '/projects/Mv/rename', { from: 'pins', to: 'ucf' });
  assert.equal(r.body.constraints, 'ucf/board.ucf');
  r = await call('POST', '/projects/Mv/rename', { from: 'src', to: 'rtl' });
  assert.deepEqual(r.body.files.map(f => f.path).sort(), ['docs/a.txt', 'rtl/B.v', 'rtl/c.v']);
  assert.equal(r.body.constraints, 'ucf/board.ucf');
  assert.equal((await call('POST', '/projects/Nope/rename', { from: 'a', to: 'b' })).status, 404);
});

test('files: delete a file and a folder; silinx.json and the root are protected', async () => {
  await call('POST', '/projects', { name: 'Rm' });
  await call('PUT', '/projects/Rm/file?path=src/a.v', 'module a; endmodule\n');
  await call('PUT', '/projects/Rm/file?path=src/deep/b.v', 'module b; endmodule\n');
  await call('PUT', '/projects/Rm/file?path=docs/x.txt', 'x');
  let r = await call('DELETE', '/projects/Rm/file?path=src/a.v');
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual((await P.readProject('Rm')).files.map(f => f.path), ['src/deep/b.v']);
  r = await call('DELETE', '/projects/Rm/file?path=docs');   // no registered file inside: silinx.json untouched
  assert.equal(r.status, 200);
  r = await call('DELETE', '/projects/Rm/file?path=src');
  assert.deepEqual((await P.readProject('Rm')).files, []);
  assert.deepEqual(await P.fileTree('Rm'), []);
  for (const p of ['silinx.json', '.', 'src/..', './']) {
    r = await call('DELETE', `/projects/Rm/file?path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 400, p);
  }
  assert.ok(fss.existsSync(path.join(P.projectDir('Rm'), 'silinx.json')));
});

// ------------------------------------------------------------------------------------------------
// devices / toolchain config
// ------------------------------------------------------------------------------------------------

test('devices DB and toolchain configuration', async () => {
  const d = await call('GET', '/devices');
  assert.equal(d.status, 200);
  assert.ok(d.body.parts.length > 5 && d.body.boards.some(b => b.id === 'basys2'));
  assert.ok(d.body.families.some(f => f.id === 'spartan6'));

  let r = await call('GET', '/toolchain');
  assert.equal(r.status, 200);
  assert.equal(r.body.config.mode, 'local');
  assert.equal(r.body.configPath, path.join(process.env.SILINX_CONFIG_DIR, 'config.json'));
  assert.equal(r.body.platform, process.platform);
  assert.ok('openFPGALoader' in r.body.programmers && 'adepttool' in r.body.programmers);
  r = await call('PUT', '/toolchain', { mode: 'ssh', ssh: { host: 'box.lan', user: 'me' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.mode, 'ssh');
  assert.equal(r.body.config.ssh.port, 22);   // merged over the defaults
  assert.equal(JSON.parse(await fs.readFile(path.join(process.env.SILINX_CONFIG_DIR, 'config.json'), 'utf8')).ssh.host, 'box.lan');
  for (const [body, re] of [
    [{ mode: 'cloud' }, /invalid mode 'cloud'/],
    [{ ssh: { host: 'a b' } }, /ssh.host contains invalid characters/],
    [{ ssh: { user: 'me;rm' } }, /ssh.user contains invalid characters/],
    [{ ssh: { sshArgs: '-v' } }, /ssh.sshArgs must be an array/],
    [{ docker: { extraArgs: '--privileged' } }, /docker.extraArgs must be an array/],
  ]) {
    r = await call('PUT', '/toolchain', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  r = await call('PUT', '/toolchain');   // no body: nothing changes
  assert.equal(r.status, 200);
  assert.equal(r.body.config.mode, 'ssh');
  await call('PUT', '/toolchain', { mode: 'local' });
});

// ------------------------------------------------------------------------------------------------
// security guard
// ------------------------------------------------------------------------------------------------

test('security: foreign Host headers and cross-origin writes are refused', async () => {
  const port = app.port;
  let r = await app.raw('GET', '/api/projects', { headers: { host: `evil.example:${port}` } });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'forbidden host' });
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'LOCALHOST']) {
    r = await app.raw('GET', '/api/projects', { headers: { host } });
    assert.equal(r.status, 200, host);
  }
  // no Host header at all (HTTP/1.0 style) is accepted
  r = await app.raw('GET', '/api/templates', { headers: { host: '' } });
  assert.equal(r.status, 200);
  // the static UI is not guarded
  r = await app.raw('GET', '/', { headers: { host: 'evil.example' } });
  assert.equal(r.status, 200);

  const body = JSON.stringify({ name: 'Evil' });
  const json = { 'content-type': 'application/json' };
  r = await app.raw('POST', '/api/projects', { headers: { ...json, origin: 'http://evil.example' }, body });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: 'cross-origin request refused' });
  r = await app.raw('POST', '/api/projects', { headers: { ...json, origin: 'not a url' }, body });
  assert.equal(r.status, 403);
  r = await app.raw('DELETE', '/api/projects/Alpha', { headers: { origin: `http://localhost:${port + 1}` } });
  assert.equal(r.status, 403);
  r = await app.raw('PUT', '/api/toolchain', { headers: { ...json, origin: 'null' }, body: '{"mode":"docker"}' });
  assert.equal(r.status, 403);
  assert.ok(!fss.existsSync(path.join(P.workspaceDir(), 'Evil')));
  // GET with a foreign Origin is a read: allowed (same-origin policy protects the response)
  r = await app.raw('GET', '/api/projects', { headers: { origin: 'http://evil.example' } });
  assert.equal(r.status, 200);
  // same origin write: allowed
  r = await app.raw('POST', '/api/projects', { headers: { ...json, origin: app.origin }, body: JSON.stringify({ name: 'SameOrigin' }) });
  assert.equal(r.status, 200);
});

test('security: bound to all interfaces any Host is accepted; bound to a name, that name is', async () => {
  const any = await startApp({ host: '0.0.0.0' });
  try {
    assert.equal((await any.raw('GET', '/api/templates', { headers: { host: 'fpga-lab.local:8642' } })).status, 200);
    // cross-origin writes are still refused
    assert.equal((await any.raw('POST', '/api/projects', { headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  } finally { await any.close(); }
  const named = await startApp({ host: 'FPGA-Box' });
  try {
    assert.equal((await named.raw('GET', '/api/templates', { headers: { host: 'fpga-box:8642' } })).status, 200);
    assert.equal((await named.raw('GET', '/api/templates', { headers: { host: 'localhost' } })).status, 200);
    assert.equal((await named.raw('GET', '/api/templates', { headers: { host: 'other-box' } })).status, 403);
  } finally { await named.close(); }
});

test('static files: the web UI and the shared core modules are served', async () => {
  let r = await fetch(app.origin + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<html/i);
  r = await fetch(app.origin + '/core/zip.js');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /export async function createZip/);
  assert.equal((await fetch(app.origin + '/api/no-such-route')).status, 404);
});

// ------------------------------------------------------------------------------------------------
// .xise
// ------------------------------------------------------------------------------------------------

const XISE = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<project xmlns="http://www.xilinx.com/XMLSchema" xmlns:xil_pn="http://www.xilinx.com/XMLSchema">
  <files>
    <file xil_pn:name="rtl/top.vhd" xil_pn:type="FILE_VHDL">
      <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="1"/>
      <association xil_pn:name="Implementation" xil_pn:seqID="1"/>
    </file>
    <file xil_pn:name="..\\shared\\util.v" xil_pn:type="FILE_VERILOG">
      <association xil_pn:name="Implementation" xil_pn:seqID="2"/>
    </file>
    <file xil_pn:name="C:\\work\\tb.vhd" xil_pn:type="FILE_VHDL">
      <association xil_pn:name="BehavioralSimulation" xil_pn:seqID="3"/>
    </file>
    <file xil_pn:name="ipcore_dir/fifo.xco" xil_pn:type="FILE_COREGEN"/>
    <file xil_pn:name="board.ucf" xil_pn:type="FILE_UCF">
      <association xil_pn:name="Implementation" xil_pn:seqID="0"/>
    </file>
  </files>
  <properties>
    <property xil_pn:name="Device" xil_pn:value="xc3s500e" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Device Family" xil_pn:value="Spartan3E" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Package" xil_pn:value="fg320" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Speed Grade" xil_pn:value="5" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Implementation Top" xil_pn:value="Architecture|top|rtl" xil_pn:valueState="non-default"/>
    <property xil_pn:name="PROP_BehavioralSimTop" xil_pn:value="Architecture|tb|beh" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Optimization Goal" xil_pn:value="Area" xil_pn:valueState="non-default"/>
    <property xil_pn:name="Optimization Effort" xil_pn:value="High" xil_pn:valueState="non-default"/>
    <property xil_pn:name="FPGA Start-Up Clock" xil_pn:value="User Clock" xil_pn:valueState="non-default"/>
  </properties>
</project>
`;
const TOP_VHD = 'library ieee; use ieee.std_logic_1164.all;\nentity top is port(a : in std_logic; y : out std_logic); end top;\narchitecture rtl of top is begin y <= a; end rtl;\n';

test('xise: import with provided / missing files (unsafe paths mapped into the project), export, sync', async () => {
  let r = await call('POST', '/projects/import-xise', { name: 'X1', xise: XISE, files: { 'rtl/top.vhd': TOP_VHD, 'util.v': 'module util; endmodule\n', 'board.ucf': 'NET "a" LOC = "P1";\n' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pj = r.body.project;
  assert.deepEqual(pj.files, [
    { path: 'rtl/top.vhd', lang: 'vhdl', role: 'design' },
    { path: 'src/util.v', lang: 'verilog', role: 'impl' },   // only Implementation in the .xise: implementation only
    { path: 'sim/tb.vhd', lang: 'vhdl', role: 'sim' },
  ]);
  assert.deepEqual(r.body.missing, ['C:/work/tb.vhd']);
  assert.ok(r.body.warnings.some(w => /fifo.xco: CORE Generator IP/.test(w)));
  assert.deepEqual(pj.device, { family: 'spartan3e', part: 'xc3s500e', package: 'fg320', speed: '-5' });
  assert.deepEqual(pj.impl, { optMode: 'Area', optLevel: 2, startupClk: 'UserClk' });
  assert.equal(pj.top, 'top');
  assert.equal(pj.simTop, 'tb');
  assert.equal(pj.constraints, 'board.ucf');
  assert.equal(await P.readFile('X1', 'src/util.v'), 'module util; endmodule\n');
  assert.equal(await P.readFile('X1', 'board.ucf'), 'NET "a" LOC = "P1";\n');

  // errors
  for (const [body, status, re] of [
    [{ xise: XISE }, 400, /missing project name/],
    [{ name: 'X2' }, 400, /missing xise text/],
    [{ name: 'X2', xise: '   ' }, 400, /missing xise text/],
    [{ name: 'X2', xise: '<nothing/>' }, 400, /not an ISE .xise project file/],
    [{ name: 'X1', xise: XISE }, 409, /already exists/],
    [{ name: '9bad', xise: XISE }, 400, /invalid project name/],
  ]) {
    r = await call('POST', '/projects/import-xise', body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  // no files object at all: everything is missing, constraints default stays when the .xise has none
  r = await call('POST', '/projects/import-xise', { name: 'X3', xise: XISE.replace(/<file xil_pn:name="board.ucf"[\s\S]*?<\/file>/, ''), files: 'nope' });
  assert.equal(r.status, 200);
  assert.equal(r.body.missing.length, 3);
  assert.equal(r.body.project.constraints, 'constraints/top.ucf');

  // export.xise: written into the project and sent as an attachment
  r = await call('GET', '/projects/X1/export.xise');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/xml/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="X1.xise"/);
  assert.match(r.body, /xil_pn:name="Implementation Top" xil_pn:value="Architecture\|top\|rtl"/);
  assert.match(r.body, /xil_pn:name="FPGA Start-Up Clock" xil_pn:value="User Clock"/);
  assert.equal(await fs.readFile(path.join(P.projectDir('X1'), 'X1.xise'), 'utf8'), r.body);
  assert.equal((await call('GET', '/projects/Nope/export.xise')).status, 404);
});

test('xise sync: auto picks the newer side, explicit import/export, unsafe paths skipped, errors', async () => {
  await call('POST', '/projects', { name: 'Sy' });
  await call('PUT', '/projects/Sy/file?path=src/top.vhd', TOP_VHD);
  await P.updateProject('Sy', pj => { pj.top = 'top'; });
  const dir = P.projectDir('Sy');
  const xfile = path.join(dir, 'Sy.xise');
  let r = await call('POST', '/projects/Sy/sync-xise', { direction: 'import' });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /Sy.xise not found/);
  r = await call('POST', '/projects/Sy/sync-xise', {});   // auto, no .xise yet -> export
  assert.equal(r.body.direction, 'export');
  assert.equal(r.body.file, xfile);
  assert.ok(fss.existsSync(xfile));
  // older .xise -> export again
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(xfile, past, past);
  r = await call('POST', '/projects/Sy/sync-xise');
  assert.equal(r.body.direction, 'export');
  // the .xise edited in ISE (newer) -> import
  await fs.writeFile(xfile, XISE);
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(xfile, future, future);
  r = await call('POST', '/projects/Sy/sync-xise', { direction: 'auto' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.direction, 'import');
  assert.deepEqual(r.body.skipped, ['../shared/util.v', 'C:/work/tb.vhd']);
  assert.deepEqual(r.body.project.files.map(f => f.path), ['rtl/top.vhd']);
  assert.equal(r.body.project.device.part, 'xc3s500e');
  assert.equal(r.body.project.constraints, 'board.ucf');
  assert.ok(r.body.warnings.some(w => /fifo.xco/.test(w)));
  // constraints outside the project and an .xise without device / top keep the current values
  await fs.writeFile(xfile, '<project><files><file xil_pn:name="../x.ucf" xil_pn:type="FILE_UCF"/></files></project>');
  r = await call('POST', '/projects/Sy/sync-xise', { direction: 'import' });
  assert.equal(r.body.project.constraints, 'board.ucf');
  assert.equal(r.body.project.device.part, 'xc3s500e');
  assert.equal(r.body.project.top, 'top');
  // broken .xise / bad direction
  await fs.writeFile(xfile, 'garbage');
  r = await call('POST', '/projects/Sy/sync-xise', { direction: 'import' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not an ISE/);
  r = await call('POST', '/projects/Sy/sync-xise', { direction: 'sideways' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /direction must be auto, import or export/);
  assert.equal((await call('POST', '/projects/Nope/sync-xise', {})).status, 404);
});

// ------------------------------------------------------------------------------------------------
// zip export / import
// ------------------------------------------------------------------------------------------------

test('zip: Xilinx export (.xise + sources, no Silinx-only files) and re-import', async () => {
  await call('POST', '/projects', { name: 'Zx', board: 'basys2' });
  await call('PUT', '/projects/Zx/file?path=src/top.vhd', TOP_VHD);
  await call('PUT', '/projects/Zx/file?path=sim/tb_top.v', 'module tb_top; endmodule\n');
  await call('PUT', '/projects/Zx/file?path=constraints/top.ucf', 'NET "a" LOC = "P11";\n');
  await call('PUT', '/projects/Zx/file?path=src/fsm.asm.json', '{"states":[]}');
  await call('PUT', '/projects/Zx/file?path=mem/rom.hex', '00\nff\n');
  await call('PUT', '/projects/Zx/file?path=Zx.xise', '<stale/>');
  await P.updateProject('Zx', pj => { pj.top = 'top'; pj.simTop = 'tb_top'; });
  const r = await call('GET', '/projects/Zx/export.zip');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/zip/);
  assert.match(r.headers.get('content-disposition'), /filename="Zx.zip"/);
  const files = await unzip(r.body);
  assert.deepEqual(Object.keys(files).sort(), ['Zx.xise', 'constraints/top.ucf', 'mem/rom.hex', 'sim/tb_top.v', 'src/top.vhd']);
  assert.match(files['Zx.xise'], /xil_pn:name="PROP_BehavioralSimTop" xil_pn:value="Module\|tb_top"/);
  assert.equal(r.headers.get('x-silinx-warnings'), null);

  const imp = await call('POST', '/projects/import-zip?name=Zx2', new Uint8Array(r.body));
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.missing, []);
  assert.deepEqual(imp.body.extra, ['mem/rom.hex']);
  assert.equal(imp.body.project.top, 'top');
  assert.equal(imp.body.project.board, null);   // ISE does not know about boards
  assert.deepEqual(await P.fileTree('Zx2'), ['constraints/top.ucf', 'mem/rom.hex', 'sim/tb_top.v', 'src/top.vhd']);
});

test('zip: Silinx export keeps silinx.json and every file; import restores board, stimuli and settings', async () => {
  await call('POST', '/projects', { name: 'Zs', board: 'nexys2' });
  await call('PUT', '/projects/Zs/file?path=src/top.v', 'module top(input a, output y); assign y = a; endmodule\n');
  await call('PUT', '/projects/Zs/file?path=src/fsm.asm.json', '{"states":[]}');
  await call('PUT', '/projects/Zs/file?path=Zs.xise', '<stale/>');
  await fs.mkdir(path.join(P.projectDir('Zs'), 'build'), { recursive: true });
  await fs.writeFile(path.join(P.projectDir('Zs'), 'build', 'top.bit'), 'x');
  await P.updateProject('Zs', pj => { pj.top = 'top'; pj.stimuli = { a: [1, 0] }; pj.preferredLanguage = 'verilog'; });
  const r = await call('GET', '/projects/Zs/export.zip?kind=silinx');
  assert.match(r.headers.get('content-disposition'), /filename="Zs-silinx.zip"/);
  const files = await unzip(r.body);
  assert.deepEqual(Object.keys(files).sort(), ['silinx.json', 'src/fsm.asm.json', 'src/top.v']);
  const imp = await call('POST', '/projects/import-zip?name=Zs2', new Uint8Array(r.body));
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.project.name, 'Zs2');
  assert.equal(imp.body.project.board, 'nexys2');
  assert.deepEqual(imp.body.project.stimuli, { a: [1, 0] });
  assert.equal(imp.body.project.preferredLanguage, 'verilog');
  assert.deepEqual(imp.body.missing, ['constraints/top.ucf']);   // the default UCF was never written
  assert.deepEqual(imp.body.extra.sort(), ['src/fsm.asm.json', 'src/top.v']);
  assert.equal((await call('GET', '/projects/Nope/export.zip')).status, 404);
});

test('zip import: nested root folder, ISE outputs and traversal entries skipped, silinx.json merged into an ISE import', async () => {
  const pjSaved = { name: 'Orig', board: 'basys2', stimuli: { clk: 'clock' }, preferredLanguage: 'vhdl', impl: { optLevel: 2 }, top: 'ignored' };
  const z = await zip([
    { path: 'MyProj/MyProj.xise', data: XISE },
    { path: 'MyProj/rtl/top.vhd', data: TOP_VHD },
    { path: 'MyProj/board.ucf', data: 'NET "a" LOC = "P1";\n' },
    { path: 'MyProj/silinx.json', data: JSON.stringify(pjSaved) },
    { path: 'MyProj/docs/notes.md', data: '# notes\n' },
    { path: 'MyProj/top.ngc', data: 'netlist' },
    { path: 'MyProj/_xmsgs/xst.xmsgs', data: 'x' },
    { path: 'MyProj/build/top.bit', data: 'x' },
    { path: 'MyProj/.hidden', data: 'x' },
    { path: 'MyProj/old/other.xise', data: XISE },
    { path: 'Elsewhere/readme.txt', data: 'outside the project root' },
    { path: 'MyProj/../../evil.txt', data: 'pwned' },
    { path: 'MyProj/shared/util.v', data: 'module util; endmodule\n' },
  ]);
  const r = await call('POST', '/projects/import-zip?name=Zn', new Uint8Array(z));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.extra.sort(), ['docs/notes.md', 'shared/util.v']);
  assert.deepEqual(r.body.missing, ['C:/work/tb.vhd']);   // util.v was found by its file name
  const pj = r.body.project;
  assert.equal(pj.board, 'basys2');
  assert.deepEqual(pj.stimuli, { clk: 'clock' });
  assert.equal(pj.top, 'top');   // from the .xise, not from silinx.json
  assert.deepEqual(pj.impl, { optMode: 'Area', optLevel: 2, startupClk: 'UserClk' });
  assert.deepEqual(await P.fileTree('Zn'), ['board.ucf', 'docs/notes.md', 'rtl/top.vhd', 'shared/util.v', 'src/util.v']);
  assert.ok(!fss.existsSync(path.join(P.workspaceDir(), 'evil.txt')));
  assert.ok(!fss.existsSync(path.join(path.dirname(P.workspaceDir()), 'evil.txt')));
});

test('zip import: a broken silinx.json is ignored; a Silinx zip with a traversal entry stays inside', async () => {
  const z = await zip([{ path: 'silinx.json', data: '{broken' }, { path: 'src/a.v', data: 'module a; endmodule\n' }, { path: '../x.v', data: 'no' }]);
  const r = await call('POST', '/projects/import-zip?name=Zb', new Uint8Array(z));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.extra, ['src/a.v']);
  assert.deepEqual(r.body.missing, []);
  assert.equal(r.body.project.top, '');
  // silinx.json that is an array / with a file list naming files the zip lacks
  const z2 = await zip([{ path: 'silinx.json', data: '[1,2]' }]);
  assert.equal((await call('POST', '/projects/import-zip?name=Zb2', new Uint8Array(z2))).status, 200);
  const z3 = await zip([{ path: 'silinx.json', data: JSON.stringify({ files: [{ path: 'src/gone.v' }, null, { path: '../../out.v' }], constraints: '' }) }]);
  const r3 = await call('POST', '/projects/import-zip?name=Zb3', new Uint8Array(z3));
  assert.deepEqual(r3.body.missing, ['src/gone.v', '../../out.v']);
});

test('zip import: error paths', async () => {
  let r = await call('POST', '/projects/import-zip', new Uint8Array(await zip([{ path: 'silinx.json', data: '{}' }])));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /missing project name/);
  r = await call('POST', '/projects/import-zip?name=E1', new Uint8Array(0));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /empty upload/);
  r = await call('POST', '/projects/import-zip?name=E1', new Uint8Array(Buffer.from('this is not a zip file at all, really not')));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot read zip: not a zip file/);
  r = await call('POST', '/projects/import-zip?name=E1', new Uint8Array(await zip([{ path: 'readme.txt', data: 'x' }])));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no .xise \(ISE project\) and no silinx.json/);
  r = await call('POST', '/projects/import-zip?name=Zs', new Uint8Array(await zip([{ path: 'silinx.json', data: '{}' }])));
  assert.equal(r.status, 409);
  r = await call('POST', '/projects/import-zip?name=a%20b', new Uint8Array(await zip([{ path: 'silinx.json', data: '{}' }])));
  assert.equal(r.status, 400);
  r = await call('POST', '/projects/import-zip?name=E2', new Uint8Array(await zip([{ path: 'p.xise', data: '<notxise/>' }])));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not an ISE/);
});

test('zip: ISE schematics are converted on import and exported back as .sch (with warnings header)', async () => {
  const F = path.join(HERE, 'fixtures', 'ise-sch');
  const xise = `<project xmlns:xil_pn="x"><files>
<file xil_pn:name="MyAND2b4.sch" xil_pn:type="FILE_SCHEMATIC"><association xil_pn:name="Implementation" xil_pn:seqID="1"/></file>
<file xil_pn:name="Mux4to1b4.sch" xil_pn:type="FILE_SCHEMATIC"><association xil_pn:name="Implementation" xil_pn:seqID="2"/></file>
<file xil_pn:name="gone.sch" xil_pn:type="FILE_SCHEMATIC"><association xil_pn:name="Implementation" xil_pn:seqID="3"/></file>
</files><properties><property xil_pn:name="Device" xil_pn:value="xc3s250e"/><property xil_pn:name="Package" xil_pn:value="cp132"/><property xil_pn:name="Speed Grade" xil_pn:value="-4"/>
<property xil_pn:name="Implementation Top" xil_pn:value="Module|Mux4to1b4"/><property xil_pn:name="Preferred Language" xil_pn:value="VHDL"/></properties></project>`;
  const z = await zip([
    { path: 'S.xise', data: xise },
    { path: 'MyAND2b4.sch', data: await fs.readFile(path.join(F, 'MyAND2b4.sch')) },
    { path: 'Mux4to1b4.sch', data: await fs.readFile(path.join(F, 'Mux4to1b4.sch')) },
  ]);
  const r = await call('POST', '/projects/import-zip?name=Sch', new Uint8Array(z));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.missing, ['gone.sch']);
  const tree = await P.fileTree('Sch');
  assert.ok(tree.includes('MyAND2b4.sch.json') && tree.includes('Mux4to1b4.sch.json'), tree.join(','));
  const hdl = r.body.project.files.map(f => f.path);
  assert.ok(hdl.some(p => /Mux4to1b4\.vhd$/.test(p)), hdl.join(','));

  // export: the schematics go out as ISE .sch files listed in the .xise instead of their HDL
  const ex = await call('GET', '/projects/Sch/export.zip');
  assert.equal(ex.status, 200);
  const files = await unzip(ex.body);
  assert.ok(files['Mux4to1b4.sch'], Object.keys(files).join(','));
  assert.ok(!Object.keys(files).some(p => p.endsWith('.sch.json') || p === 'silinx.json'));
  assert.match(files['Sch.xise'], /"Mux4to1b4\.sch" xil_pn:type="FILE_SCHEMATIC"/);
  assert.doesNotMatch(files['Sch.xise'], /Mux4to1b4\.vhd"/);

  // export warnings (here: a symbol of the ISE project imported as an HDL block) go out in X-Silinx-Warnings;
  // an unreadable .sch.json is skipped
  const { importIseSch } = await import('../core/isesch.js');
  const custom = importIseSch((await fs.readFile(path.join(F, 'MyAND2b4.sch'), 'utf8')).replace(/symbolname="and2"/g, 'symbolname="myand"'), { name: 'm' }).doc;
  await P.writeFile('Sch', 'blk/m.vhd', 'entity m is end;\narchitecture a of m is begin end;\n');
  await P.writeFile('Sch', 'blk/m.sch.json', JSON.stringify({ ...custom, generatedFile: 'blk/m.vhd' }));
  await P.writeFile('Sch', 'blk/junk.sch.json', '{not json');
  const ex2 = await call('GET', '/projects/Sch/export.zip');
  assert.equal(ex2.status, 200);
  const warnings = JSON.parse(decodeURIComponent(ex2.headers.get('x-silinx-warnings')));
  assert.ok(warnings.some(w => /^blk\/m\.sch: .*myand/.test(w)), warnings.join('\n'));
  const files2 = await unzip(ex2.body);
  assert.ok(files2['blk/m.sch'] && files2['blk/myand.sym']);
  assert.ok(!('blk/junk.sch.json' in files2));
});

// ------------------------------------------------------------------------------------------------
// server start / browser
// ------------------------------------------------------------------------------------------------

test('startServer listens (and rejects a used port); openBrowser runs the platform opener', { skip: POSIX_ONLY }, async () => {
  const { startServer, openBrowser } = await import('../server/server.js');
  const log = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  let srv;
  try { srv = await startServer({ port: 0, host: '127.0.0.1' }); } finally { console.log = log; }
  assert.match(out.join('\n'), /Silinx running at http:\/\/127.0.0.1:0 {2}\(workspace: /);
  const port = srv.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/templates`)).status, 200);
  await assert.rejects(startServer({ port, host: '127.0.0.1' }), /EADDRINUSE/);
  srv.closeAllConnections?.();
  await new Promise(r => srv.close(r));

  const fakes = await makeFakes(tmp);
  const oldPath = process.env.PATH;
  process.env.FAKE_OPEN_LOG = path.join(tmp, 'open.log');
  process.env.PATH = `${fakes.open}${path.delimiter}${oldPath}`;
  try {
    await openBrowser('http://127.0.0.1:8642');
    for (let i = 0; i < 300 && !fss.existsSync(process.env.FAKE_OPEN_LOG); i++) await sleep(10);
    assert.match(await fs.readFile(process.env.FAKE_OPEN_LOG, 'utf8'), /(open|xdg-open) http:\/\/127.0.0.1:8642/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.FAKE_OPEN_LOG;
  }
  // no opener at all: no exception (the URL is printed instead)
  process.env.PATH = path.join(tmp, 'empty-dir');
  try { await openBrowser('http://127.0.0.1:1'); } finally { process.env.PATH = oldPath; }
  await sleep(50);
});

test('fpga-view: the implemented design inside the FPGA from build/<top>.xdl + device.xdlrc (states, model, cache)', async () => {
  const FIX = path.join(HERE, 'fixtures', 'fpga');
  let r = await call('POST', '/projects', { name: 'Fv' });
  assert.equal(r.status, 200);
  const pj = JSON.parse(await fs.readFile(path.join(P.projectDir('Fv'), 'silinx.json'), 'utf8'));
  const get = async () => (await call('GET', '/projects/Fv/fpga-view')).body;
  if (pj.top) { pj.top = null; await fs.writeFile(path.join(P.projectDir('Fv'), 'silinx.json'), JSON.stringify(pj)); }
  assert.deepEqual(await get(), { available: false, reason: 'no-top' });
  pj.top = 'top';
  await fs.writeFile(path.join(P.projectDir('Fv'), 'silinx.json'), JSON.stringify(pj));
  const build = path.join(P.projectDir('Fv'), 'build');
  await fs.mkdir(build, { recursive: true });
  assert.deepEqual(await get(), { available: false, reason: 'no-ncd' }, 'not placed and routed');
  const at = async (f, t) => fs.utimes(path.join(build, f), t, t);
  await fs.writeFile(path.join(build, 'top.ncd'), 'NCD');
  assert.deepEqual(await get(), { available: false, reason: 'no-xdl' });
  await fs.copyFile(path.join(FIX, 'top.xdl'), path.join(build, 'top.xdl'));
  await fs.copyFile(path.join(FIX, 'device.xdlrc'), path.join(build, 'device.xdlrc'));
  await at('top.ncd', new Date(2026, 0, 2)); await at('top.xdl', new Date(2026, 0, 1));
  assert.deepEqual(await get(), { available: false, reason: 'stale' }, 'routed again after the XDL export');
  await at('top.xdl', new Date(2026, 0, 3));
  const m = await get();
  assert.equal(m.available, true);
  assert.equal(m.design.name, 'top');
  assert.equal(m.device.part, 'xc3s50etq144-4');
  assert.equal(m.insts.length, 8);
  assert.equal(m.nets.find(n => n.name === 'clk_BUFGP').kind, 'clock');
  // cached until one of the files changes
  const cache = JSON.parse(await fs.readFile(path.join(build, 'fpga-view.json'), 'utf8'));
  assert.equal(cache.model.design.name, 'top');
  cache.model.design.name = 'cached';
  await fs.writeFile(path.join(build, 'fpga-view.json'), JSON.stringify(cache));
  assert.equal((await get()).design.name, 'cached');
  await at('device.xdlrc', new Date(2026, 0, 4));
  assert.equal((await get()).design.name, 'top', 'rebuilt after a change');
});
