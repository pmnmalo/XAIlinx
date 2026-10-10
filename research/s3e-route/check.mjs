// Check the routing of an XDL design against the device graph (every PIP exists, every sink reached,
// no antenna, no shared node). Used on ISE's own routed designs to validate the graph.
//   node research/s3e-route/check.mjs design.xdl [part]
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
import { loadDeviceCache } from '../../core/fpga/device-node.js';
import { checkRouting } from '../../core/fpga/route.js';

const [file, part] = process.argv.slice(2);
const design = parseXdl(fs.readFileSync(file, 'utf8'));
const device = loadDeviceCache(part || design.part);
const r = checkRouting(design, device);
console.log(`${file}: ${r.nets} nets, ${design.nets.reduce((n, x) => n + x.pips.length, 0)} PIPs, ${r.ok ? 'OK' : r.problems.length + ' problems'}`);
for (const p of r.problems.slice(0, 40)) console.log('  ' + p);
process.exit(r.ok ? 0 : 1);
