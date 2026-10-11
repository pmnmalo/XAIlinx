// Licence notices: THIRD-PARTY-NOTICES.md and core/third-party.js list every production dependency
// with its licence text (and are up to date), NOTICE carries the copyright, and the standalone
// Silinx-ISE.html embeds the notices of the components it contains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { THIRD_PARTY } from '../core/third-party.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('third-party notices are up to date with the installed production dependencies', () => {
  const out = execFileSync(process.execPath, ['scripts/third-party.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /up to date \(\d+ components\)/);
});

test('every component has a known licence and its full text; CodeMirror and elkjs are marked standalone', () => {
  const md = fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.ok(THIRD_PARTY.length > 10);
  for (const c of THIRD_PARTY) {
    assert.match(c.license, /^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|EPL-2\.0)$/, `${c.name}: licence ${c.license}`);
    const sec = new RegExp(`## ${c.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ${c.version} — [^\\n]*\\n\\n[^\\n]*\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``).exec(md);
    assert.ok(sec, `${c.name} has a section`);
    assert.ok(sec[1].length > 200 && !/no licence file/.test(sec[1]), `${c.name}: the licence text`);
  }
  assert.deepEqual(THIRD_PARTY.filter(c => c.standalone).map(c => `${c.name}:${c.license}`).sort(), ['codemirror:MIT', 'elkjs:EPL-2.0']);
  assert.match(md, /source code of elkjs \(EPL-2\.0\) is available at https:\/\/github\.com\/kieler\/elkjs/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const d of Object.keys(pkg.dependencies)) assert.ok(THIRD_PARTY.some(c => c.name === d), `direct dependency ${d} listed`);
});

test('licence: GNU AGPL-3.0 (LICENSE, package.json), NOTICE with the copyright and the elkjs permission; README has a Licence section', () => {
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  assert.match(notice, /Copyright 2026 Pedro Maló/);
  assert.match(notice, /GNU Affero General Public License, version 3/);
  assert.match(notice, /Additional permission under GNU AGPL version 3 section 7[\s\S]*elkjs[\s\S]*Eclipse Public License 2\.0/);
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).license, 'AGPL-3.0-only');
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /## Licence[\s\S]*THIRD-PARTY-NOTICES\.md/);
});

test('the standalone Silinx-ISE.html embeds the copyright, the Apache licence and the CodeMirror / elkjs licences', () => {
  const dist = path.join(ROOT, 'dist', 'Silinx-ISE.html');
  const before = fs.existsSync(dist) ? fs.readFileSync(dist) : null;
  try {
    execFileSync(process.execPath, ['scripts/build-standalone.mjs'], { cwd: ROOT, stdio: 'pipe' });
    const html = fs.readFileSync(dist, 'utf8');
    const m = /<script type="text\/plain" id="silinx-notices">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, 'notices block');
    assert.match(m[1], /Copyright 2026 Pedro Maló/);
    assert.match(m[1], /GNU AFFERO GENERAL PUBLIC LICENSE/);
    assert.match(m[1], /Additional permission under GNU AGPL version 3 section 7/);
    assert.match(m[1], /## codemirror [\s\S]*MIT/);
    assert.match(m[1], /## elkjs [\s\S]*Eclipse Public License - v 2\.0/);
  } finally {
    if (before) fs.writeFileSync(dist, before);
  }
  assert.ok(os.tmpdir());
});
