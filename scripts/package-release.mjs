#!/usr/bin/env node
// Packages the files of a GitHub release (used by .github/workflows/release.yml, and by the release
// test, test/release/, which unzips the app and runs it: the two cannot drift apart).
//   node scripts/package-release.mjs [version] [--out out] [--app-only]
//     silinx-ise-<version>.zip             full app: the tracked files + production node_modules
//     silinx-ise-docker-kit-<version>.zip  builder kit of the private Xilinx ISE 14.7 Docker image
//     Silinx-ISE.html                      the single-file edition (copied from dist/, built before
//                                          with npm run build:standalone; left out when not built)
// --app-only: only the app zip. The version defaults to package.json's. Needs `zip` (Linux, macOS)
// and npm (the production dependencies are installed from package-lock.json: npm ci --omit=dev).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const version = String(argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out') || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error('usage: node scripts/package-release.mjs [version] [--out dir] [--app-only]'); process.exit(2); }
const out = path.resolve(opt('out', path.join(root, 'out')));
const appOnly = argv.includes('--app-only');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' && cmd === 'npm' });

/**
 * The tracked files (as `git archive HEAD` gives them in a clean checkout, the release's case) with
 * the file modes of the repository: the start scripts stay executable.
 */
function copyTracked(dest) {
  const list = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  for (const entry of list.split('\0').filter(Boolean)) {
    const [, mode, rel] = /^(\d+) \S+ \d+\t(.*)$/s.exec(entry);
    const src = path.join(root, rel), dst = path.join(dest, rel);
    if (!fs.existsSync(src)) continue;            // deleted in the working tree
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (mode === '120000') fs.symlinkSync(fs.readlinkSync(src), dst);
    else { fs.copyFileSync(src, dst); fs.chmodSync(dst, mode === '100755' ? 0o755 : 0o644); }
  }
}

/** The full app: tracked files + production dependencies, in a folder silinx-ise/. */
function packageApp() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'silinx-pkg-'));
  try {
    const app = path.join(work, 'silinx-ise');
    copyTracked(app);
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], app);
    fs.rmSync(path.join(app, '.github'), { recursive: true, force: true });
    const zip = path.join(out, `silinx-ise-${version}.zip`);
    fs.rmSync(zip, { force: true });
    run('zip', ['-qr', zip, 'silinx-ise'], work);
    return zip;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

fs.mkdirSync(out, { recursive: true });
const made = [packageApp()];
if (!appOnly) {
  // no Xilinx software or licence inside: only the scripts that build the image from the user's own
  const kit = path.join(out, `silinx-ise-docker-kit-${version}.zip`);
  fs.rmSync(kit, { force: true });
  run('zip', ['-qr', kit, 'ise'], path.join(root, 'docker'));
  made.push(kit);
  const html = path.join(root, 'dist', 'Silinx-ISE.html');
  if (fs.existsSync(html)) { fs.copyFileSync(html, path.join(out, 'Silinx-ISE.html')); made.push(path.join(out, 'Silinx-ISE.html')); }
}
for (const f of made) console.log(`${f}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
