// The release zip, as users get it: built by scripts/package-release.mjs (the script the Release
// workflow runs), unzipped into a clean folder, checked (production dependencies only, Yosys's
// WebAssembly, the notices, executable launchers, a size budget), then started with its own launcher
// and used: the page and the API answer, an example project is created, and Synthesize - Yosys (open)
// runs in headless Chrome from the unzipped app, with no request to any other host (offline use; the
// only one allowed is the update check against GitHub at start-up, which fails quietly offline).
//   npm run test:release          (Linux / macOS: needs zip, unzip and npm; Chrome for the browser part)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchersOf, startLauncher } from '../launch.js';
import { setupUi } from '../ui/harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// the zip and the unzipped app (2026-10: about 20 MB and 100 MB, 3/4 of it Yosys's WebAssembly)
const BUDGET = { zipMB: 30, appMB: 140 };

const has = (cmd) => { try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };
const SKIP = process.platform === 'win32' ? 'the release is packaged on Linux (zip): not on Windows'
  : !has('zip') || !has('unzip') ? 'zip / unzip not installed' : false;

let tmp, zip, APP;
before(async () => {
  if (SKIP) return;
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'silinx-release-'));
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/package-release.mjs'), '--app-only', '--out', path.join(tmp, 'out')], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
  } catch (e) { throw new Error(`scripts/package-release.mjs failed:\n${e.stdout}\n${e.stderr}`); }
  zip = path.join(tmp, 'out', `silinx-ise-${VERSION}.zip`);
  // a clean folder, as a user's Downloads
  execFileSync('unzip', ['-q', zip, '-d', path.join(tmp, 'unzipped')]);
  APP = path.join(tmp, 'unzipped', 'silinx-ise');
});
after(async () => { if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

const exists = (rel) => fs.existsSync(path.join(APP, rel));
function sizeOf(p) {
  const st = fs.lstatSync(p);
  return st.isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0) : st.size;
}
/** name@version of every package in node_modules (scoped ones too). */
function packages(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      if (f.startsWith('.')) continue;
      const p = path.join(d, f);
      if (f.startsWith('@')) { walk(p); continue; }
      const pj = path.join(p, 'package.json');
      if (fs.existsSync(pj)) { const j = JSON.parse(fs.readFileSync(pj, 'utf8')); out.push(`${j.name}@${j.version}`); }
      if (fs.existsSync(path.join(p, 'node_modules'))) walk(path.join(p, 'node_modules'));
    }
  };
  walk(dir);
  return out.sort();
}

test('release zip: the app with its production dependencies only, Yosys\'s WebAssembly, the licence and notices', { skip: SKIP }, async () => {
  for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json',
    'bin/silinx-ise.js', 'server/server.js', 'web/index.html', 'core/version.js', 'examples/blinky',
    'node_modules/express', 'node_modules/codemirror', 'node_modules/elkjs', 'node_modules/@yowasp/yosys/gen/bundle.js']) assert.ok(exists(f), `${f} in the zip`);
  const wasm = fs.readdirSync(path.join(APP, 'node_modules/@yowasp/yosys/gen')).filter((f) => f.endsWith('.wasm'));
  const wasmMB = wasm.reduce((n, f) => n + fs.statSync(path.join(APP, 'node_modules/@yowasp/yosys/gen', f)).size, 0) / 1048576;
  assert.ok(wasm.includes('yosys.core.wasm') && wasmMB > 10, `Yosys's WebAssembly: ${wasm} (${wasmMB.toFixed(1)} MB)`);
  // no development dependencies, CI files or build output (an empty folder left by npm is no file)
  const files = (rel) => { const p = path.join(APP, rel); return !fs.existsSync(p) ? [] : fs.statSync(p).isDirectory() ? fs.readdirSync(p, { recursive: true }).filter((f) => fs.statSync(path.join(p, f)).isFile()) : [rel]; };
  for (const f of ['node_modules/playwright', 'node_modules/playwright-core', 'node_modules/esbuild', 'node_modules/@esbuild', 'node_modules/fsevents', '.github', 'dist', 'out'])
    assert.deepEqual(files(f).slice(0, 5), [], `${f} must not be in the release`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version, VERSION);
  // every package shipped has its notice (and nothing listed is missing)
  const { THIRD_PARTY } = await import(pathToFileURL(path.join(APP, 'core/third-party.js')).href);
  const listed = THIRD_PARTY.map((c) => `${c.name}@${c.version}`).sort();
  assert.deepEqual(packages(path.join(APP, 'node_modules')), listed, 'node_modules of the zip = THIRD-PARTY-NOTICES.md (node scripts/third-party.mjs)');
  const notices = fs.readFileSync(path.join(APP, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  for (const c of listed) assert.ok(notices.includes(`## ${c.replace(/@(?=[^@]+$)/, ' ')} `), `${c} in THIRD-PARTY-NOTICES.md`);
});

test('release zip: the launchers are executable (Linux, macOS) and the Windows one has CRLF line endings', { skip: SKIP }, () => {
  for (const f of ['start-silinx-ise.sh', 'Start Silinx-ISE.command']) {
    assert.ok(fs.statSync(path.join(APP, f)).mode & 0o100, `${f} is executable`);
    assert.ok(!fs.readFileSync(path.join(APP, f), 'latin1').includes('\r'), `${f}: LF`);
  }
  const bat = fs.readFileSync(path.join(APP, 'Start Silinx-ISE.bat'), 'latin1');
  assert.equal(bat.split('\n').length - 1, bat.split('\r\n').length - 1, 'Start Silinx-ISE.bat: CRLF');
});

test('release zip: within its size budget', { skip: SKIP }, () => {
  const zipMB = fs.statSync(zip).size / 1048576, appMB = sizeOf(APP) / 1048576;
  const biggest = fs.readdirSync(path.join(APP, 'node_modules')).flatMap((f) => (f.startsWith('@') ? fs.readdirSync(path.join(APP, 'node_modules', f)).map((g) => `${f}/${g}`) : [f]))
    .map((f) => [f, sizeOf(path.join(APP, 'node_modules', f)) / 1048576]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, mb]) => `${f} ${mb.toFixed(1)} MB`).join(', ');
  console.log(`# release zip ${zipMB.toFixed(1)} MB, unzipped ${appMB.toFixed(1)} MB (largest dependencies: ${biggest})`);
  const why = `a new dependency or large files in the repository? Largest dependencies: ${biggest}. If the growth is wanted, raise BUDGET in test/release/release.test.js`;
  assert.ok(zipMB <= BUDGET.zipMB, `the release zip is ${zipMB.toFixed(1)} MB, over its budget of ${BUDGET.zipMB} MB: ${why}`);
  assert.ok(appMB <= BUDGET.appMB, `the unzipped release is ${appMB.toFixed(1)} MB, over its budget of ${BUDGET.appMB} MB: ${why}`);
});

for (const launcher of launchersOf()) {
  test(`release zip: ${launcher} starts the unzipped app; the page and the API answer; an example project is created`, { skip: SKIP, timeout: 90000 }, async () => {
    const t = await fsp.mkdtemp(path.join(tmp, 'run-'));
    const srv = await startLauncher(APP, launcher, t);
    try {
      const html = await (await fetch(srv.url)).text();
      assert.match(html, /<title>Silinx ISE Project Navigator<\/title>/);
      for (const asset of ['/js/app.js', '/core/version.js', '/vendor/yowasp-yosys/gen/bundle.js']) assert.equal((await fetch(srv.url + asset)).status, 200, asset);
      assert.ok((await (await fetch(`${srv.url}/api/templates`)).json()).includes('blinky'));
      const r = await fetch(`${srv.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Blinky', template: 'blinky' }) });
      assert.ok(r.ok, `create a project: ${r.status} ${await r.text()}`);
      const pj = await (await fetch(`${srv.url}/api/projects/Blinky`)).json();
      assert.ok(pj.files.some((f) => /\.vhd$/.test(f.path)), JSON.stringify(pj.files));
      assert.ok(fs.existsSync(path.join(srv.workspace, 'Blinky', 'silinx.json')), 'in the workspace given (SILINX_WORKSPACE)');
    } finally { srv.stop(); }
  });
}

test('release zip: Synthesize - Yosys (open) in the browser from the unzipped app, without the Internet', { skip: SKIP, timeout: 180000 }, async (t) => {
  const env = await setupUi({ server: false, offline: true });
  if (env.skip) { t.skip(env.skip); return; }
  const srv = await startLauncher(APP, launchersOf()[0], await fsp.mkdtemp(path.join(tmp, 'browser-')));
  let page;
  try {
    // the check of the check: a request to another host is seen (and refused)
    const probe = await env.newPage('about:blank');
    // (from the page and from a worker, as Yosys runs in one)
    await probe.eval(() => fetch('https://example.com/silinx-offline-probe').then(() => 'answered', () => 'refused'));
    await probe.eval(() => new Promise((res) => {
      const w = new Worker(URL.createObjectURL(new Blob(["fetch('https://example.org/silinx-worker-probe').then(() => postMessage(1), () => postMessage(0));"], { type: 'text/javascript' })));
      w.onmessage = () => { w.terminate(); res(); };
    }));
    assert.ok(env.external.some((r) => /example\.com\/silinx-offline-probe/.test(r)), `requests of the page to other hosts are seen: ${env.external}`);
    assert.ok(env.external.some((r) => /example\.org\/silinx-worker-probe/.test(r)), `requests of a worker to other hosts are seen: ${env.external}`);
    await probe.close();
    env.external.length = 0;

    await fetch(`${srv.url}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'OpenSynth', template: 'blinky' }) });
    page = await env.newPage(srv.url, { updateCheck: true });
    await page.waitFor(() => window.SilinxApp && document.querySelector('#menubar .item'), [], { what: 'app boot', timeout: 30000 });
    await page.openProject('OpenSynth');
    await page.treeRow('#procs', 'Synthesize - Yosys (open)', { dbl: true, exact: true });
    await page.waitConsole(/Process "Synthesize - Yosys \(open\)" (completed successfully|failed|stopped)/, { timeout: 120000 });
    const text = await page.consoleText();
    assert.match(text, /Process "Synthesize - Yosys \(open\)" completed successfully/, text.slice(-2000));
    assert.match(text, /Device utilization \(open synthesis, spartan3e\):\n {2}LUTs: \d+/);
    assert.ok(fs.existsSync(path.join(srv.workspace, 'OpenSynth', 'build', 'open')), 'the netlist in build/open');
    const errs = page.errors.filter((e) => !/api\.github\.com|Failed to fetch|NetworkError|Load failed/.test(e));
    assert.deepEqual(errs, [], 'no page errors');
    // nothing but the start-up update check (refused here: offline) went to another host
    const other = env.external.filter((r) => !/^CONNECT api\.github\.com:443$|^GET https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(r));
    assert.deepEqual(other, [], `requests to other hosts: ${env.external.join(', ')}`);
  } catch (e) {
    if (page) { try { env.keep = true; console.error(`# screenshot: ${await page.screenshot(path.join(env.shotDir, 'release-synth-open.png'))}`); } catch { /* gone */ } }
    throw e;
  } finally {
    await page?.close();
    srv.stop();
    await env.teardown();
  }
});
