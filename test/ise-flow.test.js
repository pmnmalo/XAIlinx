// End-to-end ISE implementation flow through the REST API, with fake ISE tools / docker / ssh on PATH
// (see server-helpers.js): docker, local and ssh modes, step tracking, failures, cancel, job log
// streaming, reports (utilization / timing / power / pins / simulation models) and bitstream info.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { scratchEnv, makeFakes, isolatedPath, startApp, waitJob, waitLine, writeConfig, makeBit } from './server-helpers.js';

let tmp, fakes, app, jobs, P, oldPath;
const FAKE_ENV = ['FAKE_ISE_FAIL', 'FAKE_ISE_SLEEP', 'FAKE_ISE_LOG', 'FAKE_DOCKER_NO_IMAGE', 'FAKE_DOCKER_LOG', 'FAKE_SSH_LOG', 'FAKE_SSH_FAIL'];

before(async () => {
  tmp = await scratchEnv('silinx-flow-test-');
  fakes = await makeFakes(tmp);
  oldPath = process.env.PATH;
  process.env.PATH = isolatedPath(fakes.ise, fakes.docker, fakes.ssh);
  process.env.FAKE_ISE_FIXTURES = fakes.fix;
  process.env.FAKE_SSH_HOME = path.join(tmp, 'remote-home');
  jobs = await import('../server/jobs.js');
  P = await import('../server/projects.js');
  app = await startApp();
});
afterEach(() => { for (const k of FAKE_ENV) delete process.env[k]; });
after(async () => {
  for (const j of jobs.listJobs()) if (j.status === 'running') jobs.cancelJob(j.id);
  for (let i = 0; i < 300 && jobs.listJobs().some(j => j.status === 'running'); i++) await new Promise(r => setTimeout(r, 10));
  await app.close();
  process.env.PATH = oldPath;
  await fs.rm(tmp, { recursive: true, force: true });
});

const TOP_V = 'module top(input clk, input [1:0] sw, output reg [1:0] led);\n  always @(posedge clk) led <= sw;\nendmodule\n';
const UCF = 'NET "clk" LOC = "B8" ;\nNET "sw<0>" LOC = "P11" ;\nNET "sw<1>" LOC = "L3" ;\nNET "led<0>" LOC = "M5" ;\nNET "led<1>" LOC = "M11" ;\n';

async function makeProject(name, { board = 'basys2', ucf = UCF } = {}) {
  const r = await app.call('POST', '/projects', { name, board, device: { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await app.call('PUT', `/projects/${name}/file?path=src/top.v`, TOP_V);
  if (ucf !== null) await app.call('PUT', `/projects/${name}/file?path=constraints/top.ucf`, ucf);
  await P.updateProject(name, pj => { pj.top = 'top'; });
  return P.projectDir(name);
}

async function implement(name, body = {}) {
  const r = await app.call('POST', `/projects/${name}/implement`, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.job;
}

test('docker mode: the whole flow (incl. optional steps) runs, steps are tracked and every report is parsed', async () => {
  await writeConfig({ mode: 'docker', docker: { image: 'silinx/ise:14.7' } });
  const tc = await app.call('GET', '/toolchain');
  assert.equal(tc.body.ise.available, true, tc.body.ise.reason);
  assert.equal(tc.body.dockerImage.present, true);
  const dir = await makeProject('Flow1');
  process.env.FAKE_DOCKER_LOG = path.join(tmp, 'docker.log');
  const id = await implement('Flow1', { steps: ['xst', 'postsynth', 'ngdbuild', 'posttrans', 'map', 'postmap', 'place', 'timing', 'postpar', 'pin2ucf', 'power', 'bitstream'] });
  const j = await waitJob(jobs, id);
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result.completedSteps, ['synth', 'postsynth', 'translate', 'posttrans', 'map', 'postmap', 'par', 'trce', 'postpar', 'pin2ucf', 'xpwr', 'bitgen', 'prombit']);
  assert.equal(j.result.failedStep, null);
  assert.equal(j.result.mode, 'docker');
  assert.ok(j.lines.some(l => /^Bitstream: .*top\.bit$/.test(l)));
  const dlog = await fs.readFile(process.env.FAKE_DOCKER_LOG, 'utf8');
  assert.match(dlog, /run --rm --platform linux\/amd64 -v .*:\/work -w \/work/);
  assert.match(dlog, /-e ISE_SETTINGS=\/opt\/Xilinx\/14.7\/ISE_DS\/settings64.sh silinx\/ise:14.7 bash run.sh synth postsynth/);

  const rep = j.result.reports;
  assert.equal(rep.summary.synthesized, true);
  assert.equal(rep.summary.routed, true);
  assert.equal(rep.summary.timingMet, true);
  assert.equal(rep.summary.bitstream, true);
  assert.equal(rep.summary.maxFreqMHz, 227.739);
  assert.deepEqual(rep.summary.utilization.slices, { used: 16, total: 4656, percent: 1 });
  assert.deepEqual(rep.power, { totalMw: 81.24, dynamicMw: 0.53, staticMw: 80.71, junctionC: 26.8 });
  assert.deepEqual(Object.keys(rep.simModels).sort(), ['postmap', 'postpar', 'postsynth', 'posttrans']);
  assert.equal(rep.simModels.postpar.path, 'build/netgen/par/top_timesim.vhd');
  assert.equal(rep.pinsUcf.path, 'build/top_pins.ucf');
  assert.equal(rep.bit.header.part, '3s250ecp132');
  assert.ok(fss.existsSync(path.join(dir, 'build', 'top_prom.bit')));

  // the reports route serves the saved reports.json
  const r = await app.call('GET', '/projects/Flow1/reports');
  assert.equal(r.status, 200);
  assert.equal(r.body.timing.constraints[0].name, 'TS_clk');
  assert.equal(r.body.synthesis.selectedDevice, '3s500efg320-4');
  // ... and parses the reports itself when reports.json is gone
  await fs.rm(path.join(dir, 'build', 'reports.json'));
  const r2 = await app.call('GET', '/projects/Flow1/reports');
  assert.equal(r2.body.summary.bitstream, true);
  assert.equal(r2.body.map.summary.iobs.used, 9);

  // bitstream information + part check against the project device
  const bi = await app.call('GET', '/projects/Flow1/bitinfo');
  assert.equal(bi.body.available, true);
  assert.equal(bi.body.part, '3s250ecp132');
  assert.equal(bi.body.warning, null);
  await fs.writeFile(path.join(dir, 'build', 'top.bit'), makeBit({ part: '3s500efg320' }));
  assert.match((await app.call('GET', '/projects/Flow1/bitinfo')).body.warning, /built for '3s500efg320'/);
  await fs.writeFile(path.join(dir, 'build', 'top.bit'), 'garbage');
  const bad = await app.call('GET', '/projects/Flow1/bitinfo');
  assert.equal(bad.body.available, false);
  assert.match(bad.body.error, /not a Xilinx/);
  // a corrupt .bit is reported in the parsed reports too
  const r3 = await app.call('GET', '/projects/Flow1/reports');
  assert.match(r3.body.bit.header.error, /not a Xilinx|truncated/);
});

test('docker mode: a failing step stops the flow, is reported, and the reports written so far are parsed', async () => {
  await writeConfig({ mode: 'docker', docker: { image: 'silinx/ise:14.7' } });
  await makeProject('Flow2');
  process.env.FAKE_ISE_FAIL = 'map';
  const id = await implement('Flow2');
  const j = await waitJob(jobs, id);
  assert.equal(j.status, 'error');
  assert.match(j.error, /ISE flow failed in step 'map' \(exit code 2\)/);
  assert.deepEqual(j.result.completedSteps, ['synth', 'translate']);
  assert.equal(j.result.failedStep, 'map');
  assert.ok(j.lines.some(l => /ERROR:map - fake failure/.test(l)));
  assert.equal(j.result.reports.summary.synthesized, true);
  assert.equal(j.result.reports.summary.mapped, false);
  assert.equal(j.result.reports.summary.utilization.slices.used, 15);   // XST estimate
  assert.equal(j.result.reports.summary.maxFreqMHz, 247.525);
});

test('docker mode: a missing image or docker command makes ISE unavailable (scripts still generated)', async () => {
  await writeConfig({ mode: 'docker', docker: { image: 'silinx/ise:14.7' } });
  process.env.FAKE_DOCKER_NO_IMAGE = '1';
  const tc = await app.call('GET', '/toolchain');
  assert.equal(tc.body.ise.available, false);
  assert.match(tc.body.ise.reason, /not present locally/);
  assert.equal(tc.body.dockerImage.present, false);
  await makeProject('Flow3');
  await writeConfig({ mode: 'docker', docker: { command: path.join(tmp, 'no-such-docker'), image: 'x/y' } });
  const j = await waitJob(jobs, await implement('Flow3'));
  assert.equal(j.status, 'error');
  assert.match(j.error, /Xilinx ISE not available \(docker mode\): '.*no-such-docker' command not found/);
  assert.ok(j.result.generated.includes('run.sh'));
  await writeConfig({ mode: 'docker', docker: { image: '' } });
  const j2 = await waitJob(jobs, await implement('Flow3'));
  assert.match(j2.error, /no docker image configured/);
});

test('local mode: run.sh runs the ISE tools found on PATH; ports without LOC get pins from partgen', async () => {
  await writeConfig({ mode: 'local' });
  const tc = await app.call('GET', '/toolchain');
  assert.equal(tc.body.ise.available, true);
  assert.equal(tc.body.ise.reason, 'ISE tools found on PATH');
  const dir = await makeProject('Flow4', { board: null, ucf: 'NET "clk" LOC = "P1" ;\n' });
  process.env.FAKE_ISE_LOG = path.join(tmp, 'ise-local.log');
  const j = await waitJob(jobs, await implement('Flow4', { steps: 'par' }));
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result.steps, ['par', 'trce']);
  assert.deepEqual(j.result.completedSteps, ['par', 'trce']);
  assert.ok(j.result.warnings.some(w => /4 port bit\(s\) have no LOC constraint/.test(w)));
  // autopins only runs with translate: run it now
  const j2 = await waitJob(jobs, await implement('Flow4', { steps: ['translate'] }));
  assert.equal(j2.status, 'ok', j2.lines.join('\n'));
  assert.deepEqual(j2.result.completedSteps, ['autopins', 'translate']);
  const ucf = await fs.readFile(path.join(dir, 'build', 'top.ucf'), 'utf8');
  assert.match(ucf, /NET "sw<0>" LOC = "P2" ; # assigned by Silinx/);
  assert.doesNotMatch(ucf, /LOC = "P1" ; # assigned/);   // P1 is already used by clk
  assert.ok(j2.lines.some(l => /WARNING: led<1> -> pin P\d/.test(l)));
  const calls = await fs.readFile(process.env.FAKE_ISE_LOG, 'utf8');
  assert.match(calls, /^partgen -v xc3s250ecp132$/m);
  assert.match(calls, /^ngdbuild -intstyle xflow -dd _ngo -nt timestamp -uc top.ucf -p xc3s250e-cp132-4 top.ngc top.ngd$/m);
  assert.match(calls, /^par -w -intstyle xflow -ol high -t 1 top_map.ncd top.ncd top.pcf$/m);
  assert.match(calls, /^trce -intstyle xflow -v 3 -s 4 -n 3 -fastpaths -xml top.twx top.ncd -o top.twr top.pcf -ucf top.ucf$/m);
});

test('local mode: a board project with unconstrained ports is refused before running anything', async () => {
  await writeConfig({ mode: 'local' });
  await makeProject('Flow5', { ucf: 'NET "clk" LOC = "B8" ;\n' });
  const j = await waitJob(jobs, await implement('Flow5'));
  assert.equal(j.status, 'error');
  assert.match(j.error, /4 top-level port bit\(s\) have no pin location \(LOC\) for the basys2 board: sw<0>, sw<1>, led<0>, led<1>/);
});

test('ssh mode: build dir is uploaded with tar over ssh, run remotely and the results downloaded', async () => {
  await writeConfig({ mode: 'ssh', ssh: { host: 'build-box', user: 'me', port: 2222, identity: '/k/id', remoteDir: '~/sx/', sshArgs: ['-o', 'StrictHostKeyChecking=no'] } });
  const tc = await app.call('GET', '/toolchain');
  assert.equal(tc.body.ise.available, true, tc.body.ise.reason);
  assert.equal(tc.body.ise.reason, 'remote host me@build-box');
  const dir = await makeProject('Flow6');
  process.env.FAKE_SSH_LOG = path.join(tmp, 'ssh.log');
  const j = await waitJob(jobs, await implement('Flow6', { steps: ['synth'] }));
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.deepEqual(j.result.completedSteps, ['synth']);
  assert.ok(fss.existsSync(path.join(process.env.FAKE_SSH_HOME, 'sx', 'Flow6', 'top.syr')), 'ran remotely');
  assert.ok(fss.existsSync(path.join(dir, 'build', 'top.syr')), 'results downloaded');
  const log = await fs.readFile(process.env.FAKE_SSH_LOG, 'utf8');
  assert.match(log, /^me@build-box rm -rf sx\/Flow6 && mkdir -p sx\/Flow6 && tar -C sx\/Flow6 -xf -$/m);
  assert.match(log, /^me@build-box cd sx\/Flow6 && ISE_SETTINGS=\/opt\/Xilinx\/14.7\/ISE_DS\/settings64.sh bash run.sh synth$/m);
  assert.match(log, /^me@build-box tar -C sx\/Flow6 --exclude=.\/src -cf - .$/m);
  assert.ok(j.lines.some(l => /^\$ tar -C .* -cf - \. \| ssh -o BatchMode=yes -p 2222 -i \/k\/id -o StrictHostKeyChecking=no -- me@build-box/.test(l)));

  // the upload fails: the flow stops with ssh's exit code
  process.env.FAKE_SSH_FAIL = '1';
  const j2 = await waitJob(jobs, await implement('Flow6', { steps: ['synth'] }));
  assert.equal(j2.status, 'error');
  assert.match(j2.error, /ISE flow failed \(exit code 255\)/);
  assert.ok(j2.lines.some(l => /Connection refused/.test(l)));
});

test('ssh mode with a docker image on the remote host: the flow runs in that image there', async () => {
  await writeConfig({ mode: 'ssh', ssh: { host: 'mini', user: 'dev', image: 'xilinx/ise:14.7' } });
  const tc = await app.call('GET', '/toolchain');
  assert.equal(tc.body.ise.available, true, tc.body.ise.reason);
  assert.equal(tc.body.ise.reason, 'remote host dev@mini (docker image xilinx/ise:14.7)');
  const dir = await makeProject('FlowDock');
  process.env.FAKE_SSH_LOG = path.join(tmp, 'ssh-dock.log');
  process.env.FAKE_DOCKER_LOG = path.join(tmp, 'docker-dock.log');
  const j = await waitJob(jobs, await implement('FlowDock', { steps: ['synth'] }));
  assert.equal(j.status, 'ok', j.lines.join('\n'));
  assert.equal(j.result.mode, 'ssh');
  assert.deepEqual(j.result.completedSteps, ['synth']);
  assert.ok(fss.existsSync(path.join(process.env.FAKE_SSH_HOME, 'silinx-build', 'FlowDock', 'top.syr')), 'ran on the remote host');
  assert.ok(fss.existsSync(path.join(dir, 'build', 'top.syr')), 'results downloaded');
  const log = await fs.readFile(process.env.FAKE_SSH_LOG, 'utf8');
  assert.match(log, /^dev@mini rm -rf silinx-build\/FlowDock && mkdir -p silinx-build\/FlowDock && tar -C silinx-build\/FlowDock -xf -$/m);
  assert.match(log, /^dev@mini export PATH="\$PATH:\/usr\/local\/bin:\/opt\/homebrew\/bin"; cd silinx-build\/FlowDock && docker run --rm -v "\$PWD":\/work -w \/work -e ISE_SETTINGS=\/opt\/Xilinx\/14.7\/ISE_DS\/settings64.sh xilinx\/ise:14.7 bash run.sh synth$/m);
  assert.match(await fs.readFile(process.env.FAKE_DOCKER_LOG, 'utf8'), /^run --rm -v .*silinx-build\/FlowDock:\/work -w \/work -e ISE_SETTINGS=\S+ xilinx\/ise:14.7 bash run.sh synth$/m);
});

test('ssh mode: not configured / remote dir rejected', async () => {
  await writeConfig({ mode: 'ssh', ssh: { host: '' } });
  assert.match((await app.call('GET', '/toolchain')).body.ise.reason, /no ssh host configured/);
  await writeConfig({ mode: 'ssh', ssh: { host: 'box', remoteDir: 'a b' } });
  await makeProject('Flow7');
  const j = await waitJob(jobs, await implement('Flow7', { steps: ['synth'] }));
  assert.equal(j.status, 'error');
  assert.match(j.error, /invalid ssh.remoteDir/);
});

test('cancel: a running flow is killed, the job ends cancelled and a new run is accepted', async () => {
  await writeConfig({ mode: 'docker', docker: { image: 'silinx/ise:14.7' } });
  await makeProject('Flow8');
  process.env.FAKE_ISE_SLEEP = 'par';
  const id = await implement('Flow8');
  await waitLine(jobs, id, /fake par waiting/);
  // the job log streams: since= returns only the new lines
  const full = await app.call('GET', `/jobs/${id}`);
  assert.equal(full.body.status, 'running');
  assert.equal(full.body.kind, 'implement');
  assert.deepEqual(full.body.meta, { project: 'Flow8', steps: ['synth', 'translate', 'map', 'par', 'trce', 'bitgen', 'prombit'] });
  assert.equal(full.body.result.currentStep, 'par');
  const tail = await app.call('GET', `/jobs/${id}?since=${full.body.next - 2}`);
  assert.equal(tail.body.lines.length, 2);
  assert.deepEqual(tail.body.lines, full.body.lines.slice(-2));
  assert.deepEqual((await app.call('GET', `/jobs/${id}?since=${full.body.next}`)).body.lines, []);
  assert.ok((await app.call('GET', '/jobs')).body.some(x => x.id === id && x.status === 'running'));
  // a second run of the same project is refused while it runs
  const dup = await app.call('POST', '/projects/Flow8/implement', {});
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already running/);

  const c = await app.call('POST', `/jobs/${id}/cancel`);
  assert.equal(c.status, 200);
  assert.equal(c.body.cancelled, true);
  assert.deepEqual(c.body.lines, []);   // cancel returns the job without its old lines
  const j = await waitJob(jobs, id);
  assert.equal(j.status, 'error');
  assert.equal(j.error, 'cancelled by user');
  assert.ok(j.lines.includes('*** cancel requested ***'));
  // cancelling a finished job changes nothing
  assert.equal((await app.call('POST', `/jobs/${id}/cancel`)).body.status, 'error');
  delete process.env.FAKE_ISE_SLEEP;
  const again = await waitJob(jobs, await implement('Flow8', { steps: ['synth'] }));
  assert.equal(again.status, 'ok');
});

test('implement / reports / bitinfo / jobs: error paths', async () => {
  await P.createProject({ name: 'NoTop' });
  let r = await app.call('POST', '/projects/NoTop/implement', {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /set the top module/);
  r = await app.call('POST', '/projects/NoTop/implement', { steps: ['synth', 'dance'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown step 'dance'/);
  assert.equal((await app.call('POST', '/projects/Ghost/implement', {})).status, 404);
  assert.equal((await app.call('POST', '/projects/..%2Fx/implement', {})).status, 400);
  assert.deepEqual((await app.call('GET', '/projects/NoTop/reports')).body, { available: false });
  assert.deepEqual((await app.call('GET', '/projects/NoTop/bitinfo')).body, { available: false, reason: 'no top module' });
  assert.equal((await app.call('GET', '/projects/Ghost/reports')).status, 404);
  await P.updateProject('NoTop', pj => { pj.top = 'top'; });
  const bi = await app.call('GET', '/projects/NoTop/bitinfo');
  assert.equal(bi.body.available, false);
  assert.match(bi.body.path, /build[/\\]top\.bit$/);
  // generateOnly with no HDL file fails inside the job
  const j = await waitJob(jobs, (await app.call('POST', '/projects/NoTop/implement', { generateOnly: true })).body.job);
  assert.equal(j.status, 'error');
  assert.match(j.error, /no design \(role "design"\) HDL files/);

  r = await app.call('GET', '/jobs/nope');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /job 'nope' not found/);
  assert.equal((await app.call('POST', '/jobs/nope/cancel')).status, 404);
});

test('generateOnly writes the scripts without running any tool', async () => {
  await writeConfig({ mode: 'docker', docker: { command: path.join(tmp, 'no-such-docker'), image: 'x' } });
  const dir = await makeProject('Gen1');
  const j = await waitJob(jobs, await implement('Gen1', { generateOnly: true, steps: ['synth'] }));
  assert.equal(j.status, 'ok');
  assert.equal(j.result.mode, null);
  assert.deepEqual(j.result.generated.sort(), ['run.sh', 'top.prj', 'top.ucf', 'top.ut', 'top.xst', 'top_prom.ut']);
  assert.ok(j.lines.some(l => /Scripts generated only/.test(l)));
  assert.match(await fs.readFile(path.join(dir, 'build', 'top_prom.ut'), 'utf8'), /StartUpClk:Cclk/);
  // reports of a build dir without any report: everything empty, nothing synthesized
  const r = await app.call('GET', '/projects/Gen1/reports');
  assert.equal(r.body.summary.synthesized, false);
  assert.equal(r.body.summary.utilization, null);
  assert.equal(r.body.summary.timingMet, null);
});
