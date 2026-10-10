// End-to-end Xilinx ISE 14.7 flow through the Silinx REST API (opt-in: it needs the ISE docker image
// and takes ~15 minutes under x86 emulation).
//
//   SILINX_ISE_TESTS=1 node --test test/ise/*.test.js   (image: SILINX_ISE_IMAGE, default xilinx/ise:14.7)
//   SILINX_ISE_HOST=user@host …                        the image on another machine, over ssh (the SSH
//                                                       mode with a Docker image on the remote host)
//
// A project is created from the blinky template (Basys2, xc3s250e-4-cp132), the toolchain is set to
// docker mode, POST /projects/:p/implement runs the whole flow (synthesis, translate, map, place &
// route, timing, power, pins, simulation model, bitstreams) and the reports are checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IMAGE = process.env.SILINX_ISE_IMAGE || 'xilinx/ise:14.7';
const enabled = process.env.SILINX_ISE_TESTS === '1';
// the host only from the environment (never written in a file)
const HOST = /^(?:([\w.-]+)@)?([\w.:-]+)$/.exec(process.env.SILINX_ISE_HOST || '');
const haveImage = enabled && (HOST
  ? spawnSync('ssh', ['-o', 'BatchMode=yes', '--', process.env.SILINX_ISE_HOST, `export PATH="$PATH:/usr/local/bin"; docker image inspect --format '{{.Id}}' ${IMAGE}`], { encoding: 'utf8' }).status === 0
  : spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE], { encoding: 'utf8' }).status === 0);
const skip = !enabled ? 'set SILINX_ISE_TESTS=1 to run the ISE flow tests'
  : !haveImage ? `docker image ${IMAGE} not available${HOST ? ' on the remote host (ssh)' : ''}` : false;
const TOOLCHAIN = HOST
  ? { mode: 'ssh', ssh: { host: HOST[2], user: HOST[1] || '', remoteDir: 'silinx-ise-tests', image: IMAGE, settings: '/opt/Xilinx/14.7/ISE_DS/settings64.sh' } }
  : { mode: 'docker', docker: { image: IMAGE, platform: 'linux/amd64', settings: '/opt/Xilinx/14.7/ISE_DS/settings64.sh' } };

let tmp, srv, base, jobs;
before(async () => {
  if (skip) return;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'silinx-ise-flow-'));
  process.env.SILINX_WORKSPACE = path.join(tmp, 'ws');
  process.env.SILINX_CONFIG_DIR = path.join(tmp, 'cfg');
  jobs = await import('../../server/jobs.js');
  const { createApp } = await import('../../server/server.js');
  const app = await createApp();
  await new Promise((r) => { srv = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(async () => {
  if (skip) return;
  for (const j of jobs.listJobs()) if (j.status === 'running') jobs.cancelJob(j.id);
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  if (!process.env.SILINX_ISE_KEEP) await fs.rm(tmp, { recursive: true, force: true });
});

const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : await r.text() };
};

test('ISE flow end to end through the API: blinky on the Basys2 (reports, pins, power, bitstreams)', { skip, timeout: 60 * 60 * 1000 }, async () => {
  let r = await call('PUT', '/toolchain', TOOLCHAIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ise.available, true, r.body.ise.reason);

  r = await call('POST', '/projects', { name: 'flow', template: 'blinky' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await call('POST', '/projects/flow/implement', { steps: ['synth', 'translate', 'map', 'par', 'trce', 'postpar', 'pin2ucf', 'xpwr', 'bitgen'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.job;
  let job, since = 0;
  const log = [];
  for (;;) {
    job = (await call('GET', `/jobs/${id}?since=${since}`)).body;
    log.push(...job.lines); since = job.next;
    if (job.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  assert.equal(job.status, 'ok', `${job.error}\n${log.filter((l) => /ERROR/.test(l)).slice(0, 20).join('\n')}`);
  assert.deepEqual(job.result.completedSteps, ['synth', 'translate', 'map', 'par', 'trce', 'postpar', 'pin2ucf', 'xpwr', 'bitgen', 'prombit']);

  const rep = (await call('GET', '/projects/flow/reports')).body;
  // synthesis + map utilization (xc3s250e: 2448 slices, 92 bonded IOBs)
  assert.equal(rep.synthesis.selectedDevice, '3s250ecp132-4');
  assert.equal(rep.synthesis.errors, 0);
  const u = rep.map.summary;
  assert.ok(u.slices.used > 10 && u.slices.total === 2448, JSON.stringify(u.slices));
  assert.ok(u.ffs.used > 10 && u.luts.used > 10);
  assert.deepEqual([u.iobs.used, u.iobs.total], [15, 92]);
  assert.equal(u.bufg.used, 1);
  // place & route, timing (TS_clk: 20 ns)
  assert.equal(rep.par.routed, true);
  assert.equal(rep.timing.met, true);
  assert.ok(rep.timing.maxFreqMHz > 50, `fmax ${rep.timing.maxFreqMHz}`);
  assert.ok(rep.timing.constraints.some((c) => /TS_clk/.test(c.constraint) && !c.timingErrors));
  assert.equal(rep.summary.timingMet, true);
  // power
  assert.ok(rep.power.totalMw > 0 && rep.power.staticMw > 0 && rep.power.junctionC > 20, JSON.stringify(rep.power));
  // pins chosen by the tools = the board's
  assert.ok(rep.pinsUcf);
  const pins = (await call('GET', `/projects/flow/file?path=${encodeURIComponent(rep.pinsUcf.path)}`)).body;
  for (const [net, loc] of [['clk', 'B8'], ['led<0>', 'M5'], ['led<7>', 'G1'], ['sw<0>', 'P11'], ['btn<1>', 'C11']])
    assert.match(pins, new RegExp(`NET "${net.replace(/[<>]/g, '\\$&')}"\\s+LOC\\s*=\\s*"?${loc}"?\\s*[;|]`, 'i'), `${net} on ${loc}`);
  // post-place & route simulation model
  assert.ok(rep.simModels.postpar);
  // bitstreams
  assert.equal(rep.summary.bitstream, true);
  assert.ok(rep.bit.size > 10000 && rep.bit.header.part.startsWith('3s250e'), JSON.stringify(rep.bit));
  const bi = (await call('GET', '/projects/flow/bitinfo')).body;
  assert.equal(bi.available, true);
  assert.ok(!bi.warning, bi.warning);
});
