// The carry connections (COUT -> CIN) of placed XDL designs: which slice rows they cross.
//   node carry-rows.mjs a.xdl b.xdl …
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
const cross = new Map();
for (const f of process.argv.slice(2)) {
  const d = parseXdl(fs.readFileSync(f, 'utf8'));
  const site = new Map(d.insts.map(i => [i.name, i.site]));
  for (const n of d.nets) if (n.outpins[0]?.pin === 'COUT') {
    const a = /X(\d+)Y(\d+)/.exec(site.get(n.outpins[0].inst)), b = /X(\d+)Y(\d+)/.exec(site.get(n.inpins[0].inst));
    const k = `${a[2]}->${b[2]}${a[1] !== b[1] ? ' (other column!)' : ''}`;
    cross.set(k, (cross.get(k) || 0) + 1);
  }
}
console.log([...cross].sort((a, b) => parseInt(a[0]) - parseInt(b[0])).map(([k, v]) => `${k}:${v}`).join(' '));
