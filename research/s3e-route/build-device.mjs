// Build the routing graph cache of a device from its full report (see README.md).
//   node research/s3e-route/build-device.mjs dev-full.xdlrc [out.json.gz]
import { buildDeviceCache, loadDeviceCache } from '../../core/fpga/device-node.js';

const [src, out] = process.argv.slice(2);
if (!src) { console.error('usage: build-device.mjs dev-full.xdlrc [out.json.gz]'); process.exit(1); }
let t = Date.now();
const r = await buildDeviceCache(src, out);
console.log(`parsed + packed in ${((Date.now() - t) / 1000).toFixed(1)} s -> ${r.path} (${(r.bytes / 1e6).toFixed(2)} MB gz)`);
console.log(JSON.stringify(r.packed.counts));
t = Date.now();
const d = loadDeviceCache(r.path);
const tl = Date.now() - t;
t = Date.now();
const e = d.routingEdges();
console.log(`load ${tl} ms, routing edges ${Date.now() - t} ms (${e.edgeTo.length} edges, ${d.nodeCount} nodes), heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
