// The fully open flow checked against Xilinx ISE (the oracle), on another machine with the ISE
// Docker image (e.g. an Intel Mac, where ISE runs natively): for each project, the open flow
// (research/s3e-route/open-flow.mjs: no Xilinx tool) writes routed.xdl and its .bit; ISE converts
// the same routed.xdl, runs its design rule check and writes its own .bit (ise-open-check.sh); the
// two .bit files must be byte-identical (CRC on and off) and the DRC must find no error.
//
//   SILINX_ISE_HOST=user@host node scripts/check-open-flow.mjs [project folder …]   (default: examples/blinky)
//   (also: SILINX_ISE_IMAGE, default xilinx/ise:14.7). Needs the device cache (~/.silinx/devices).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.SILINX_ISE_HOST;   // only from the environment, never written in a file
const IMAGE = process.env.SILINX_ISE_IMAGE || 'xilinx/ise:14.7';
if (!HOST) { console.error('set SILINX_ISE_HOST=user@host (a machine with the ISE Docker image, reached by ssh with a key)'); process.exit(2); }
const projects = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(ROOT, 'examples', 'blinky')];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'silinx-open-check-'));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });
const ssh = cmd => run('ssh', ['-o', 'BatchMode=yes', '--', HOST, `export PATH="$PATH:/usr/local/bin"; ${cmd}`]);
const names = [];
let failed = 0;

// 1. the open flow, here
for (const proj of projects) {
  const name = path.basename(path.resolve(proj)).replace(/[^\w.-]/g, '_');
  names.push(name);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'research/s3e-route/open-flow.mjs'), proj, path.join(work, name)], { encoding: 'utf8' });
  console.log(`${name}: open flow ${r.status === 0 ? 'ok' : 'FAILED'}`);
  if (r.status !== 0) { console.log(r.stderr.trim().split('\n').slice(-10).join('\n')); failed++; names.pop(); }
}
if (!names.length) process.exit(1);

// 2. ISE, on the remote host: xdl -xdl2ncd, drc, bitgen (CRC on and off)
const remote = 'silinx-open-check';
fs.copyFileSync(path.join(ROOT, 'research/s3e-route/ise-open-check.sh'), path.join(work, 'ise-open-check.sh'));
ssh(`rm -rf ${remote} && mkdir -p ${remote}`);
run('rsync', ['-a', '-e', 'ssh -o BatchMode=yes', `${work}/`, `${HOST}:${remote}/`]);
const out = ssh(`docker run --rm -v "$HOME/${remote}":/w ${IMAGE} bash /w/ise-open-check.sh /w ${names.join(' ')}`);
process.stdout.write(out.split('\n').map(l => (l ? `  ISE ${l}` : l)).join('\n'));
run('rsync', ['-a', '-e', 'ssh -o BatchMode=yes', '--include=*/', '--include=ise*.bit', '--include=drc.log', '--exclude=*', `${HOST}:${remote}/`, `${work}/`]);

// 3. Silinx's .bit against ISE's, from the same routed.xdl (the header's name, date and time are ISE's)
for (const name of names) {
  const d = path.join(work, name);
  const drc = fs.existsSync(path.join(d, 'drc.log')) ? fs.readFileSync(path.join(d, 'drc.log'), 'utf8') : '';
  const drcOk = /PhysDesignRules results include: <0> errors/.test(drc);
  const check = spawnSync(process.execPath, [path.join(ROOT, 'research/s3e-bitstream/check-writer.mjs'),
    path.join(d, 'routed.xdl'), path.join(d, 'ise.bit'), path.join(d, 'routed.xdl'), path.join(d, 'ise-nocrc.bit')], { encoding: 'utf8' });
  const same = (check.stdout.match(/BYTE-IDENTICAL/g) || []).length === 2;
  console.log(`${name}: DRC ${drcOk ? '0 errors' : 'ERRORS'}; .bit vs ISE's bitgen: ${same ? 'byte-identical (CRC on and off)' : 'DIFFERENT'}`);
  if (!same) console.log(check.stdout.trim());
  if (!drcOk || !same) failed++;
}
if (!process.env.SILINX_KEEP) fs.rmSync(work, { recursive: true, force: true }); else console.log(`kept: ${work}`);
console.log(failed ? `${failed} design(s) failed` : 'the open flow matches ISE');
process.exit(failed ? 1 : 0);
