// REST API / project storage regressions (in-process server on a random port, scratch workspace).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { POSIX_ONLY } from './server-helpers.js';

let tmp, srv, base, P, jobs;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'silinx-server-test-'));
  process.env.SILINX_WORKSPACE = path.join(tmp, 'ws');
  process.env.SILINX_CONFIG_DIR = path.join(tmp, 'cfg');
  P = await import('../server/projects.js');
  jobs = await import('../server/jobs.js');
  const { createApp } = await import('../server/server.js');
  const app = await createApp();
  await new Promise(r => { srv = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(async () => {
  for (const j of jobs.listJobs()) if (j.status === 'running') jobs.cancelJob(j.id);
  for (let i = 0; i < 250 && jobs.listJobs().some(j => j.status === 'running'); i++) await new Promise(r => setTimeout(r, 20));
  srv.closeAllConnections?.();
  await new Promise(r => srv.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

const call = async (method, url, body, headers = {}) => {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === 'string') { init.body = body; init.headers['content-type'] ||= 'text/plain'; }
    else if (body instanceof Uint8Array) { init.body = body; init.headers['content-type'] ||= 'application/zip'; }
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(base + url, init);
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
};

test('Silinx zip export/import restores every file, including the default UCF and ISE-like extensions', async () => {
  assert.equal((await call('POST', '/projects', { name: 'Exp1' })).status, 200);
  await P.writeFile('Exp1', 'src/top.v', 'module top(input a, output y); assign y = a; endmodule\n');
  await P.writeFile('Exp1', 'constraints/top.ucf', 'NET "a" LOC = "P11" ;\n');
  await P.writeFile('Exp1', 'mem/init.bin', '0101\n');
  await P.writeFile('Exp1', 'docs/notes.log', 'notes\n');
  await P.writeFile('Exp1', 'docs/report.html', '<p>x</p>\n');
  await P.updateProject('Exp1', pj => { pj.top = 'top'; });
  const zip = await call('GET', '/projects/Exp1/export.zip?kind=silinx');
  assert.equal(zip.status, 200);
  const imp = await call('POST', '/projects/import-zip?name=Imp1', zip.body);
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.missing, []);
  assert.deepEqual(await P.fileTree('Imp1'), ['constraints/top.ucf', 'docs/notes.log', 'docs/report.html', 'mem/init.bin', 'src/top.v']);
  assert.equal(await P.readFile('Imp1', 'constraints/top.ucf'), 'NET "a" LOC = "P11" ;\n');
  const pj = await P.readProject('Imp1');
  assert.equal(pj.constraints, 'constraints/top.ucf');
  assert.equal(pj.top, 'top');
  assert.deepEqual(pj.files.map(f => f.path), ['src/top.v']);
});

test('Silinx zip import reports a constraints file the zip does not contain', async () => {
  const { createZip } = await import('../core/zip.js');
  const zlib = await import('node:zlib');
  const codec = { deflate: d => zlib.deflateRawSync(d), inflate: d => zlib.inflateRawSync(d) };
  const pj = { name: 'x', version: 1, device: { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' }, top: '', files: [], constraints: 'constraints/board.ucf' };
  const zip = await createZip([{ path: 'silinx.json', data: JSON.stringify(pj) }], codec);
  const imp = await call('POST', '/projects/import-zip?name=Imp2', new Uint8Array(zip));
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.missing, ['constraints/board.ucf']);
});

test('concurrent file writes all register in silinx.json (per-project lock, atomic write)', async () => {
  await P.createProject({ name: 'Conc' });
  await Promise.all(Array.from({ length: 20 }, (_, i) => P.writeFile('Conc', `src/m${i}.v`, `module m${i}; endmodule\n`)));
  const pj = await P.readProject('Conc');
  assert.equal(pj.files.length, 20);
  // concurrent read-modify-writes through the API also keep every change
  await Promise.all(Array.from({ length: 10 }, (_, i) => call('PUT', `/projects/Conc/file?path=sim/tb_${i}.v`, `module tb_${i}; endmodule\n`, { 'content-type': 'text/plain' })));
  assert.equal((await P.readProject('Conc')).files.length, 30);
  const left = (await fs.readdir(P.projectDir('Conc'))).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(left, []);
});

test('renaming a folder remaps the registered files and the constraints path', async () => {
  await P.createProject({ name: 'Ren' });
  await P.writeFile('Ren', 'rtl/a.v', 'module a; endmodule\n');
  await P.writeFile('Ren', 'rtl/sub/b.vhd', 'entity b is end;\n');
  await P.writeFile('Ren', 'rtlx/c.v', 'module c; endmodule\n');
  await P.writeFile('Ren', 'pins/top.ucf', '\n');
  await P.updateProject('Ren', pj => { pj.constraints = 'pins/top.ucf'; });
  let r = await call('POST', '/projects/Ren/rename', { from: 'rtl', to: 'hdl' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.files.map(f => f.path).sort(), ['hdl/a.v', 'hdl/sub/b.vhd', 'rtlx/c.v']);
  r = await call('POST', '/projects/Ren/rename', { from: 'pins', to: 'constraints/pins' });
  assert.equal(r.body.constraints, 'constraints/pins/top.ucf');
  assert.deepEqual(await P.fileTree('Ren'), ['constraints/pins/top.ucf', 'hdl/a.v', 'hdl/sub/b.vhd', 'rtlx/c.v']);
  r = await call('POST', '/projects/Ren/rename', { from: 'hdl', to: 'hdl/inner' });
  assert.equal(r.status, 400);
  r = await call('POST', '/projects/Ren/rename', { from: 'hdl/a.v', to: 'hdl/a2.v' });
  assert.ok(r.body.files.some(f => f.path === 'hdl/a2.v'));
});

test('deleting a folder removes it and unregisters its files; the project root cannot be deleted', async () => {
  await P.createProject({ name: 'Del' });
  await P.writeFile('Del', 'rtl/a.v', 'module a; endmodule\n');
  await P.writeFile('Del', 'rtl/sub/b.v', 'module b; endmodule\n');
  await P.writeFile('Del', 'rtl2/c.v', 'module c; endmodule\n');
  let r = await call('DELETE', '/projects/Del/file?path=rtl');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await P.readProject('Del')).files.map(f => f.path), ['rtl2/c.v']);
  assert.deepEqual(await P.fileTree('Del'), ['rtl2/c.v']);
  for (const bad of ['.', 'rtl2/..', 'silinx.json']) {
    r = await call('DELETE', `/projects/Del/file?path=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, bad);
  }
  assert.ok((await P.readProject('Del')).files.length === 1);
});

test('a second implementation of the same project is refused with 409 while the first runs', { skip: POSIX_ONLY }, async () => {
  // fake "docker" that just waits: the first job stays running, nothing real is executed
  const fake = path.join(tmp, 'fake-docker.sh');
  await fs.writeFile(fake, '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
  await fs.mkdir(process.env.SILINX_CONFIG_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.SILINX_CONFIG_DIR, 'config.json'), JSON.stringify({ mode: 'docker', docker: { command: fake, image: 'fake/ise:0' } }));
  await P.createProject({ name: 'Impl' });
  await P.writeFile('Impl', 'src/top.v', 'module top(input a, output y); assign y = a; endmodule\n');
  await P.updateProject('Impl', pj => { pj.top = 'top'; });
  const a = await call('POST', '/projects/Impl/implement', {});
  assert.equal(a.status, 200, JSON.stringify(a.body));
  let job;
  for (let i = 0; i < 100; i++) {   // wait until the fake tool runs
    job = jobs.getJob(a.body.job);
    if (job.status !== 'running' || job.lines.some(l => /Running ISE flow/.test(l))) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(job.status, 'running', job.lines.join('\n'));
  const b = await call('POST', '/projects/Impl/implement', { generateOnly: true });
  assert.equal(b.status, 409);
  assert.match(b.body.error, /already running/);
  // another project is not blocked
  await P.createProject({ name: 'Impl2' });
  await P.writeFile('Impl2', 'src/top.v', 'module top(input a, output y); assign y = a; endmodule\n');
  await P.updateProject('Impl2', pj => { pj.top = 'top'; });
  assert.equal((await call('POST', '/projects/Impl2/implement', { generateOnly: true })).status, 200);
  // after cancelling, a new run is accepted
  jobs.cancelJob(a.body.job);
  for (let i = 0; i < 200 && jobs.getJob(a.body.job).status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await call('POST', '/projects/Impl/implement', { generateOnly: true })).status, 200);
});

test('a file removed from the project (excluded) is back in it when it is written again; the file itself is kept', async () => {
  await P.createProject({ name: 'Excl1', template: 'empty' });
  await P.writeFile('Excl1', 'src/ctrl.asm.json', '{"name":"ctrl"}');
  await P.updateProject('Excl1', pj => { pj.excluded = ['src/ctrl.asm.json']; });
  let pj = await P.readProject('Excl1');
  assert.deepEqual(pj.excluded, ['src/ctrl.asm.json']);
  await P.writeFile('Excl1', 'src/ctrl.asm.json', '{"name":"ctrl2"}');
  pj = await P.readProject('Excl1');
  assert.deepEqual(pj.excluded, []);
  assert.equal(await P.readFile('Excl1', 'src/ctrl.asm.json'), '{"name":"ctrl2"}');
});
