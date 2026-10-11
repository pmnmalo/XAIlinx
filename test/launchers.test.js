// The launchers users double-click (start-silinx-ise.sh on Linux, Start Silinx-ISE.command on macOS,
// Start Silinx-ISE.bat on Windows): each one of this platform starts Silinx from the repository on
// the port it is given, and the files keep the line endings and modes their systems need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchersOf, startLauncher } from './launch.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const launcher of launchersOf()) {
  test(`${launcher} starts Silinx on the port given (PORT) and the API answers`, { timeout: 90000 }, async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'silinx-launch-'));
    let srv;
    try {
      srv = await startLauncher(ROOT, launcher, tmp);
      const templates = await (await fetch(`${srv.url}/api/templates`)).json();
      assert.ok(templates.includes('blinky'), JSON.stringify(templates));
      assert.match(srv.output(), new RegExp(`http://127\\.0\\.0\\.1:${srv.port}`));
      // the workspace given, not the user's
      assert.deepEqual(await fsp.readdir(srv.workspace), []);
    } finally {
      srv?.stop();
      await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  });
}

test('launchers: CRLF for the Windows one, LF for the others, which git keeps executable', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'Start Silinx-ISE.bat'), 'latin1');
  assert.equal(bat.split('\n').length - 1, bat.split('\r\n').length - 1, '.bat: every line ends with CRLF');
  for (const f of ['Start Silinx-ISE.command', 'start-silinx-ise.sh']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'latin1');
    assert.ok(!text.includes('\r'), `${f}: LF line endings`);
    assert.match(text, /^#!\/bin\/(ba)?sh\n/, `${f}: shebang`);
  }
  const modes = execFileSync('git', ['ls-files', '-s', '--', 'Start Silinx-ISE.command', 'start-silinx-ise.sh', 'Start Silinx-ISE.bat'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(modes, /^100755 \S+ 0\tStart Silinx-ISE\.command$/m);
  assert.match(modes, /^100755 \S+ 0\tstart-silinx-ise\.sh$/m);
});
