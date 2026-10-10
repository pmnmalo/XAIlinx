// No data that must not be published in the repository (scripts/check-private-data.mjs): personal
// data, computer names and network addresses, logins, passwords, keys and tokens, Xilinx files.
// The examples below are built at run time, so that this file does not hold what it looks for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRepo, scanText } from '../scripts/check-private-data.mjs';

const kinds = (file, text) => scanText(file, text).map((x) => `${x.kind}: ${x.text}`);
const at = '@', dot = (...p) => p.join('.');

test('the tracked files hold no private data, secrets or Xilinx files', () => {
  const found = scanRepo();
  assert.deepEqual(found.map((x) => `${x.file}${x.line ? `:${x.line}` : ''}: ${x.kind}: ${x.text}`), [],
    'remove these (or, for a harmless match, add it with its reason to ALLOW in scripts/check-private-data.mjs)');
});

test('personal data: e-mail addresses, home folders with a user name, logins', () => {
  assert.deepEqual(kinds('a.md', `write to jane.doe${at}${dot('mail', 'pt')}`), [`e-mail address: jane.doe${at}mail.pt`]);
  assert.deepEqual(kinds('a.md', `jane${at}${dot('example', 'com')} and bot${at}${dot('lab', 'test')}`), []);   // example domains
  assert.deepEqual(kinds('THIRD-PARTY-NOTICES.md', `Copyright (c) Some Author <a${at}${dot('b', 'org')}>`), []);   // licence texts
  assert.deepEqual(kinds('a.js', `const p = '${['', 'Users', 'alice', 'x.v'].join('/')}';`), [`home folder with a user name: /Users/alice`]);
  assert.deepEqual(kinds('a.js', `cd ${['', 'home', 'bob', 'proj'].join('/')}`), [`home folder with a user name: /home/bob`]);
  assert.deepEqual(kinds('a.md', `C:${'\\'}Users${'\\'}carol${'\\'}Desktop`), [`home folder with a user name: C:${'\\'}Users${'\\'}carol`]);
  assert.deepEqual(kinds('a.md', `${['', 'Users', '<you>', 'x'].join('/')} ${['', 'home', '$USER'].join('/')} ${['', 'home', 'runner', 'work'].join('/')}`), []);   // placeholders
  assert.deepEqual(kinds('a.sh', `ssh pi${at}${dot(10, 1, 2, 3)}`), [`IP address: ${dot(10, 1, 2, 3)}`, `login (user${at}address): pi${at}${dot(10, 1, 2, 3)}`]);
});

test('computer names and network addresses; versions and local addresses are fine', () => {
  assert.deepEqual(kinds('a.md', `the server at ${dot(192, 168, 1, 20)}`), [`IP address: ${dot(192, 168, 1, 20)}`]);
  assert.deepEqual(kinds('a.md', `public ${dot(8, 8, 4, 4)}`), [`IP address: ${dot(8, 8, 4, 4)}`]);
  assert.deepEqual(kinds('a.md', `${dot(127, 0, 0, 1)}:8642 ${dot(0, 0, 0, 0)} ${dot(192, 0, 2, 7)} v${dot(1, 2, 3, 4)} ${dot(1, 2, 3, 4, 5)} 15.10.1`), []);
  assert.deepEqual(kinds('a.md', `open http://${'Janes-MacBook-Pro'}.local:8642`), ['computer name: Janes-MacBook-Pro.local']);
  assert.deepEqual(kinds('a.js', 'const local = p.local; x.local = 1;'), []);   // code, not names
});

test('passwords, keys and access tokens', () => {
  assert.deepEqual(kinds('a.js', `const password = "${'hunter'}2x";`), [`password or secret: password = "hunter2x"`]);
  assert.deepEqual(kinds('a.json', `{"api_key": "${'k3y'}Value9"}`), [`password or secret: api_key": "k3yValue9"`]);
  assert.deepEqual(kinds('a.md', `password: "<your password>", secret = "\${SECRET}", token: "xxxx"`), []);   // placeholders
  assert.deepEqual(kinds('a.md', `git clone https://me:${'s3cr3t'}${at}example.org/r.git`).map((k) => k.split(':')[0]), ['credentials in a URL']);
  assert.deepEqual(kinds('id', `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`).map((k) => k.split(':')[0]), ['private key']);
  for (const tok of ['gh' + 'p_' + 'A'.repeat(36), 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP', 'sk-' + 'ant-' + 'x'.repeat(30), 'xo' + 'xb-' + '1234567890-abc']) {
    assert.deepEqual(kinds('a.txt', `token ${tok} end`).map((k) => k.split(':')[0]), ['access token'], tok.slice(0, 4));
  }
});

test('files that must not be in the repository: Xilinx outputs and licences, keys, environments', () => {
  for (const f of ['build/top.bit', 'build/top.ncd', 'x/main.ngc', 'Xilinx.lic', 'ssh/id_ed25519', 'cert.pem', '.env', 'config/.env.local', '.npmrc']) {
    assert.equal(scanText(f, '').length, 1, f);
  }
  for (const f of ['src/top.vhd', 'constraints/top.ucf', 'web/js/bitstream.js', 'environment.md']) assert.deepEqual(scanText(f, ''), [], f);
  // a text file written by ISE (its banner); hand-made files in ISE's format and the allowed fixtures are fine
  const banner = `Release 14.7 par P.20131013 (lin64)\nCopyright (c) 1995-2013 ${'Xilinx'}, Inc.  All rights reserved.\n`;
  assert.deepEqual(kinds('build/top.par', banner).map((k) => k.split(':')[0]), ['file written by Xilinx ISE']);
  assert.deepEqual(kinds('test/fixtures/ise/top.par', banner), []);
  assert.deepEqual(kinds('test/fixtures/fpga/d.xdlrc', `# XDL REPORT MODE\n# (a small hand-made device in the format of xdl -report)\n`), []);
});
