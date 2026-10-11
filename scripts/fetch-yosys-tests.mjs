#!/usr/bin/env node
// Fetch Yosys's own test designs (YosysHQ/yosys, ISC licence, Copyright (C) Claire Xenia Wolf and
// the Yosys authors) at a pinned commit, for the corpus test (test/corpus/run-corpus.mjs). They are
// data: downloaded into .cache/yosys-tests/ (git-ignored), never committed.
//
//   node scripts/fetch-yosys-tests.mjs [--force]      (npm run fetch:yosys-tests)
//
// The tarball of the commit comes from GitHub (codeload); only the directories of plain Verilog
// designs are extracted (tests/simple, tests/asicworld, tests/hana, tests/vloghtb, tests/various),
// with the repository's licence (COPYING) beside them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Yosys 0.68: the version YoWASP (@yowasp/yosys 0.68.x) runs
export const YOSYS_TESTS_PIN = { tag: 'v0.68', commit: '38e001a6ff74ca434bf4cc02c053f53619160ab0' };
export const YOSYS_TEST_DIRS = ['tests/simple', 'tests/asicworld', 'tests/hana', 'tests/vloghtb', 'tests/various'];
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = path.join(ROOT, '.cache', 'yosys-tests');

/** The files of a tar archive: [{ name, type, data }] (ustar, GNU long names, pax paths). */
export function untar(buf) {
  const files = [];
  let off = 0, longName = null, paxPath = null;
  const str = (o, n) => { const s = buf.subarray(o, o + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString('utf8'); };
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break;
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = str(off + 345, 155);
    let name = (prefix ? `${prefix}/` : '') + str(off, 100);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8')); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    if (paxPath) name = paxPath; else if (longName) name = longName;
    paxPath = longName = null;
    files.push({ name, type: type === '5' ? 'dir' : type === '0' || type === '\0' ? 'file' : type, data });
  }
  return files;
}

/** Download and extract (once). Returns the directory holding tests/. */
export async function fetchYosysTests({ force = false, log = console.log } = {}) {
  const dest = path.join(CACHE, YOSYS_TESTS_PIN.commit);
  const stamp = path.join(dest, '.complete');
  if (fs.existsSync(stamp) && !force) return dest;
  const url = `https://codeload.github.com/YosysHQ/yosys/tar.gz/${YOSYS_TESTS_PIN.commit}`;
  log(`fetching ${url} (Yosys ${YOSYS_TESTS_PIN.tag})`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  fs.rmSync(dest, { recursive: true, force: true });
  let n = 0;
  for (const f of untar(tar)) {
    if (f.type !== 'file') continue;
    const rel = f.name.split('/').slice(1).join('/');   // strip yosys-<commit>/
    if (rel !== 'COPYING' && !YOSYS_TEST_DIRS.some(d => rel.startsWith(`${d}/`))) continue;
    if (rel.split('/').includes('..')) continue;
    const out = path.join(dest, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.data);
    n++;
  }
  fs.writeFileSync(stamp, JSON.stringify({ ...YOSYS_TESTS_PIN, files: n }) + '\n');
  log(`${n} files in ${path.relative(ROOT, dest)}`);
  return dest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fetchYosysTests({ force: process.argv.includes('--force') }).catch(e => { console.error(e.message); process.exit(1); });
}
