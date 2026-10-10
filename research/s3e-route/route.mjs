// Route an XDL design with Silinx's router (core/fpga/route.js), after removing all its PIPs.
//   node research/s3e-route/route.mjs in.xdl out.xdl [--known]
// The input is normally a design placed and routed by ISE (xdl -ncd2xdl): its placement is kept,
// its routing thrown away and redone. The output is checked against the device graph.
// --known: only the PIPs (and GND sources) whose bits the bit database knows (bitgen.js
// knownRouting), so that Silinx's bitgen can write the whole bitstream.
import fs from 'node:fs';
import { parseXdl, writeXdl } from '../../core/xdl.js';
import { loadDeviceCache } from '../../core/fpga/device-node.js';
import { routeDesign, checkRouting } from '../../core/fpga/route.js';
import { knownRouting } from '../../core/fpga/bitgen.js';

const args = process.argv.slice(2);
const known = args.includes('--known');
const [src, dst] = args.filter(a => !a.startsWith('--'));
if (!src || !dst) { console.error('usage: route.mjs in.xdl out.xdl'); process.exit(1); }
const design = parseXdl(fs.readFileSync(src, 'utf8'));
const ise = design.nets.reduce((n, x) => n + x.pips.length, 0);
for (const n of design.nets) n.pips = [];
let t = Date.now();
const device = loadDeviceCache(design.part);
console.log(`device ${design.part}: ${device.nodeCount} nodes, loaded in ${Date.now() - t} ms`);
const r = routeDesign(design, device, { log: s => console.log('  ' + s), ...(known ? knownRouting((await import('../s3e-bitstream/db.mjs')).loadDb()) : {}) });
console.log(`routed ${r.routed} nets in ${r.timeMs} ms, ${r.iterations} iterations, ${r.pips} PIPs (ISE: ${ise}), overused ${r.overused}, failed ${r.failed.length}`);
for (const e of r.errors.slice(0, 20)) console.log('  error: ' + e);
for (const f of r.failed.slice(0, 20)) console.log('  failed: ' + f);
for (const u of r.unreached.slice(0, 20)) console.log(`  not reached: ${u.net} -> ${u.inst}.${u.pin}`);
fs.writeFileSync(dst, writeXdl(r.design));
const c = checkRouting(parseXdl(fs.readFileSync(dst, 'utf8')), device);
console.log(`check: ${c.ok ? 'OK' : c.problems.length + ' problems'}`);
for (const p of c.problems.slice(0, 20)) console.log('  ' + p);
process.exit(c.ok && !r.failed.length ? 0 : 1);
