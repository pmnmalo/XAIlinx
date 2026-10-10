// The whole check for one design: open synthesis (Silinx front end + Yosys) -> Silinx's packer and
// placer -> placed XDL -> ISE (xdl -xdl2ncd, par -p, bitgen, netgen -sim) -> the routed netgen
// model simulated against the RTL. Needs yosys on PATH and the private ISE Docker image.
//
//   node validate.mjs <sims/name.json> <work folder> [seed] [effort]
//
// The spec (sims/*.json): { dir, files, top, ucf?, sim } (see compare.mjs). Results in <work folder>:
// <top>.json (netlist), <name>.xdl (placed), <name>_r.xdl (routed), <name>_sim.vhd, logs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [specFile, workArg, seed = '1', effort = '1'] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const name = path.basename(specFile, '.json');
const work = path.resolve(workArg);
fs.mkdirSync(work, { recursive: true });
const dir = path.resolve(path.dirname(specFile), (spec.dir || '.').replace(/^~(?=\/)/, process.env.HOME));
const node = (script, args) => execFileSync(process.execPath, [path.join(HERE, script), ...args], { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const step = (what, f) => { const t = Date.now(); const r = f(); console.log(`${what}: ${((Date.now() - t) / 1000).toFixed(1)} s`); return r; };

step('synthesis', () => node('synth.mjs', [...spec.files.map(f => path.join(dir, f)), spec.top, work]));
const ucf = spec.ucf ? path.join(dir, spec.ucf) : '-';
console.log(step('pack + place', () => node('flow.mjs', [path.join(work, `${spec.top}.json`), ucf, process.env.XDLRC || '/tmp/claude-501/xdl/dev.xdlrc', path.join(work, `${name}.xdl`), seed, effort])).trim());
fs.copyFileSync(path.join(HERE, 'ise-route.sh'), path.join(work, 'ise-route.sh'));
const ise = step('ISE (xdl2ncd, par -p, bitgen, netgen)', () => spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '-v', `${work}:/w`, '-w', '/w', 'xilinx/ise:14.7', 'bash', '/w/ise-route.sh', name], { encoding: 'utf8' }));
console.log(ise.stdout.split('\n').filter(l => !/PhysDesignRules:10 - The network/.test(l) && !/^Phase/.test(l)).join('\n').trim());
const clock = fs.existsSync(path.join(work, `${name}.par.log`)) ? fs.readFileSync(path.join(work, `${name}.par.log`), 'utf8').split('\n').filter(l => /\| SETUP /.test(l)).map(l => l.split('|')[3].trim()) : [];
console.log(`par -p: best achievable clock period ${clock.join(', ') || '?'}`);
console.log(step('simulation', () => node('compare.mjs', [specFile, path.join(work, `${name}_sim.vhd`)])).trim());
