// What the device report says about the slice grid: node devinfo.mjs dev.xdlrc
import fs from 'node:fs';
import { parseXdlrc } from '../../core/xdl.js';
const dev = parseXdlrc(fs.readFileSync(process.argv[2], 'utf8'));
console.log(dev.part, dev.family, dev.rows, dev.cols);
const types = {};
for (const t of dev.tiles) for (const s of t.sites) types[s.type] = (types[s.type] || 0) + 1;
console.log(types);
// slice columns: X -> list of Y; tile rows of each slice
const cols = new Map();
for (const t of dev.tiles) for (const s of t.sites) {
  const m = /^SLICE_X(\d+)Y(\d+)$/.exec(s.name);
  if (!m) continue;
  if (!cols.has(+m[1])) cols.set(+m[1], []);
  cols.get(+m[1]).push([+m[2], t.r, t.c, t.name, s.type]);
}
for (const [x, l] of [...cols].sort((a, b) => a[0] - b[0])) {
  l.sort((a, b) => a[0] - b[0]);
  const ys = l.map(e => e[0]);
  const gaps = ys.filter((y, i) => i && y !== ys[i - 1] + 1);
  const rowsJump = l.filter((e, i) => i && e[0] % 2 === 0 && e[1] !== l[i - 1][1] - 1).map(e => `${e[0]}@r${e[1]}`);
  console.log(`X${x} ${l[0][4]} col c${l[0][2]} Y ${ys[0]}..${ys.at(-1)} n=${ys.length} gaps=${gaps} rowjumps=${rowsJump.join(',')}`);
}
for (const t of dev.tiles) if (t.sites.some(s => /BUFGMUX|IOB|IBUF|RAMB|MULT|DCM/.test(s.type)) && /CLK|BRAM|DCM/.test(t.type)) console.log(t.r, t.c, t.name, t.type, t.sites.map(s => `${s.name}:${s.type}`).join(' '));
