// Runs a Silinx launcher (start-silinx-ise.sh, Start Silinx-ISE.command, Start Silinx-ISE.bat) the
// way a user does (double-click), on a free port, with a temporary workspace, configuration
// directory and HOME, and without opening a browser (SILINX_NO_BROWSER). Used by the launcher test
// (from the repository) and the release test (from the unzipped release).
import { spawn, execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The launchers of this platform (file names, in the app folder). */
export function launchersOf(platform = process.platform) {
  if (platform === 'win32') return ['Start Silinx-ISE.bat'];
  if (platform === 'darwin') return ['Start Silinx-ISE.command', 'start-silinx-ise.sh'];
  return ['start-silinx-ise.sh'];
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/**
 * Start `launcher` of the app in `appDir`; resolves when the server answers. Returns
 * { url, output(), stop(), workspace, configDir }.
 */
export async function startLauncher(appDir, launcher, tmp, { timeout = 60000 } = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    SILINX_NO_BROWSER: '1',
    SILINX_WORKSPACE: path.join(tmp, 'workspace'),
    SILINX_CONFIG_DIR: path.join(tmp, 'config'),
    HOME: path.join(tmp, 'home'),
    USERPROFILE: path.join(tmp, 'home'),
    // the Node.js that runs the tests first on the PATH
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || process.env.Path || ''}`,
  };
  delete env.Path;
  for (const d of [env.SILINX_WORKSPACE, env.SILINX_CONFIG_DIR, env.HOME]) await fsp.mkdir(d, { recursive: true });
  const file = path.join(appDir, launcher);
  const [cmd, args] = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${file}""`]] : [file, []];
  // stdin closed: 'pause' / 'read' at the end of a launcher return at once
  const proc = spawn(cmd, args, { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsVerbatimArguments: process.platform === 'win32' });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const url = `http://127.0.0.1:${port}`;
  const stop = () => {
    if (proc.exitCode != null && process.platform !== 'win32') return;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-proc.pid, 'SIGTERM');
    } catch { /* already gone */ }
    proc.stdout.destroy(); proc.stderr.destroy(); proc.unref();
  };
  const t0 = Date.now();
  for (;;) {
    if (await fetch(`${url}/api/templates`).then((r) => r.ok, () => false)) break;
    if (proc.exitCode != null) throw new Error(`${launcher} exited (${proc.exitCode}) before the server answered:\n${out}`);
    if (Date.now() - t0 > timeout) { stop(); throw new Error(`${launcher}: no server at ${url} after ${timeout} ms:\n${out}`); }
    await sleep(100);
  }
  return { url, port, proc, output: () => out, stop, workspace: env.SILINX_WORKSPACE, configDir: env.SILINX_CONFIG_DIR };
}
