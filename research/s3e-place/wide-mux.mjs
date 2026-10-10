// How ISE places wide multiplexers: for every F5 / FX -> FXINA / FXINB connection of a placed XDL,
// the slice offsets (driver relative to the FiMUX's slice) and the multiplexer kind (from the
// netlist: MUXF6 / F7 / F8 by cell name).   node wide-mux.mjs placed.xdl netlist.json
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
import { readYosysJson } from '../../core/fpga/netlist.js';
const d = parseXdl(fs.readFileSync(process.argv[2], 'utf8'));
const nl = readYosysJson(fs.readFileSync(process.argv[3], 'utf8'));
const typeOf = new Map(nl.cells.map(c => [c.name, c.type]));
const site = new Map(d.insts.map(i => [i.name, i]));
const xy = s => { const m = /SLICE_X(\d+)Y(\d+)/.exec(s); return [+m[1], +m[2]]; };
const count = new Map();
for (const n of d.nets) for (const ip of n.inpins) if (/^FXIN[AB]$/.test(ip.pin)) {
  const to = site.get(ip.inst), from = site.get(n.outpins[0].inst);
  const fi = to.cfg.find(c => c.attr === 'F6MUX');
  const kind = typeOf.get(fi?.name) || fi?.name;
  const [tx, ty] = xy(to.site), [fx, fy] = xy(from.site);
  const k = `${kind} at (x%2=${tx % 2}, y%2=${ty % 2}) ${ip.pin} <- ${n.outpins[0].pin} of (${fx - tx}, ${fy - ty})`;
  count.set(k, (count.get(k) || 0) + 1);
}
for (const [k, v] of [...count].sort()) console.log(v, k);
// which input of the multiplexer cell is FXINA: compare the net names
const f5 = new Map();
for (const i of d.insts) for (const c of i.cfg) if (c.attr === 'F5MUX') f5.set(c.name, i);
let fIsI1 = 0, fIsI0 = 0;
for (const c of nl.cells) if (c.type === 'MUXF5') {
  const i = f5.get(c.name);
  if (!i) continue;
  const F = i.cfg.find(x => x.attr === 'F'), G = i.cfg.find(x => x.attr === 'G');
  const drv = k => { const dd = nl.nets[c.pins[k]].driver; return dd ? nl.cells[dd.cell].name : null; };
  if (F && drv('I1') === F.name) fIsI1++;
  if (F && drv('I0') === F.name) fIsI0++;
  void G;
}
console.log(`MUXF5: LUT F is I1 in ${fIsI1}, I0 in ${fIsI0}`);
