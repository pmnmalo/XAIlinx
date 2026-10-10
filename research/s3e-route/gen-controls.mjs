// Control designs for the ISE checks (do ISE's DRC and bitgen really catch bad routing?), made from
// an ISE-routed XDL:
//   <name>-unrouted.xdl   every PIP removed: DRC must report unrouted nets
//   <name>-antenna.xdl    one extra PIP hanging off a net: DRC must report an antenna
//   <name>-flipbidi.xdl   every bidirectional PIP written the other way round ("BX2 =- BY0" for
//                         "BY0 =- BX2"): is the orientation of the text significant? (compare the bitstreams)
//   node research/s3e-route/gen-controls.mjs ise.xdl outdir/name
import fs from 'node:fs';
import { parseXdl, writeXdl } from '../../core/xdl.js';
import { loadDeviceCache } from '../../core/fpga/device-node.js';

const [src, out] = process.argv.slice(2);
const text = fs.readFileSync(src, 'utf8');
const d0 = parseXdl(text);
const device = loadDeviceCache(d0.part);

const unrouted = parseXdl(text);
for (const n of unrouted.nets) n.pips = [];
fs.writeFileSync(`${out}-unrouted.xdl`, writeXdl(unrouted));

// antenna: on the first ordinary net with PIPs, one more PIP from a node of the net to a free wire
const ant = parseXdl(text);
const used = new Set();
for (const n of ant.nets) for (const p of n.pips) { const k = device.tile(p.tile); used.add(device.node(k, p.from)); used.add(device.node(k, p.to)); }
let added = null;
for (const n of ant.nets) {
  if (added || n.type !== 'wire' || !n.pips.length) continue;
  for (const p of n.pips) {
    const k = device.tile(p.tile);
    device.forEachPip(device.node(k, p.to), (to, tk, i, flags) => {
      if (added || flags || used.has(to)) return;
      const q = device.pip(tk, i);
      n.pips.push({ tile: q.tile, from: q.from, dir: q.dir, to: q.to });
      added = `${n.name}: ${q.tile} ${q.from} -> ${q.to}`;
    });
    if (added) break;
  }
}
fs.writeFileSync(`${out}-antenna.xdl`, writeXdl(ant));
console.log('antenna added on', added);

const flip = parseXdl(text);
let flipped = 0;
for (const n of flip.nets) for (const p of n.pips) if (p.dir === '=-') { [p.from, p.to] = [p.to, p.from]; flipped++; }
fs.writeFileSync(`${out}-flipbidi.xdl`, writeXdl(flip));
// and the design itself through Silinx's writer only (parse + write, no routing change)
fs.writeFileSync(`${out}-rewritten.xdl`, writeXdl(parseXdl(text)));
console.log('bidirectional PIPs flipped:', flipped);
