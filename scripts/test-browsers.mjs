#!/usr/bin/env node
// UI tests in other browsers than Chrome: Firefox and WebKit (Safari's engine), Playwright's builds
// (npx playwright install firefox webkit), through the same harness (SILINX_UI_BROWSER).
//   npm run test:browsers                         the cross-browser set below, in Firefox and WebKit
//   npm run test:browsers -- webkit               one browser (firefox, webkit, chromium, chrome)
//   npm run test:browsers -- --all                every UI test
//   npm run test:browsers -- firefox test/ui/fsm.test.js   some files
// Tests that need the Chrome DevTools Protocol are skipped there (memory, print page, update stub).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// what users do most, and what depends most on the browser: the shell (menus, dialogs, keys), the
// modern / classic interface, dark theme and command palette, the HDL editor (CodeMirror), schematic,
// ASM and FSM editors, ISim and the board emulator, projects from the examples, and Yosys
// (WebAssembly in a Web Worker)
const CROSS_BROWSER = ['app', 'modern', 'editing', 'diagrams', 'fsm', 'focus', 'sim-emu', 'projects', 'synth-open']
  .map((n) => `test/ui/${n}.test.js`);

const args = process.argv.slice(2);
const browsers = args.filter((a) => /^(firefox|webkit|chromium|chrome)$/.test(a));
let files = args.filter((a) => a.endsWith('.js'));
if (args.includes('--all')) files = fs.readdirSync(path.join(root, 'test/ui')).filter((f) => f.endsWith('.test.js')).map((f) => `test/ui/${f}`);
if (!files.length) files = CROSS_BROWSER;
let failed = false;
for (const b of browsers.length ? browsers : ['firefox', 'webkit']) {
  console.log(`\n# UI tests in ${b}: ${files.length} files`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, SILINX_UI_BROWSER: b } });
  if (r.status !== 0) { failed = true; console.log(`# UI tests in ${b}: FAILED`); }
}
process.exit(failed ? 1 : 0);
