// Routing switches measured as branches: bitgen programs every PIP of a net that has pins, also a
// PIP that leads nowhere. So a PIP whose input wire is already on a net of a routed design can be
// measured by adding it to that net as a dead-end branch (its output wire unused by any net): no
// sink is needed, which reaches the PIPs the test router cannot finish (pins of sites it does not
// drive, stub wires, clock pins of the I/O tiles, the DCMs' pins…). Variants remove the branches by
// codewords as in gen-pipdrop.mjs (key.json in the same format, so ana-pipdrop.mjs analyses it).
//
//   node gen-branch.mjs dev-full.xdlrc base.xdl outdir --want want.json [--k 30] [--L 12] [--w 2] [--seed 1]
// want.json: { TYPE: ['from->to', …] } the PIPs to measure, per tile type.
import fs from 'node:fs';
import { loadGraph } from './xdlrc-graph.mjs';
import { parseXdl } from '../../core/xdl.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const K = +opt('--k', '30'), L = +opt('--L', '12'), w = +opt('--w', '2');
const want = JSON.parse(fs.readFileSync(opt('--want', null), 'utf8'));
let seed = +opt('--seed', '1');
const [xdlrc, src, out] = args;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const g = loadGraph(xdlrc);
const text = fs.readFileSync(src, 'utf8');
const design = parseXdl(text);

// the nodes of every net (nets with pins only), and every node in use
const netOfNode = new Map(), used = new Set();
for (const [j, net] of design.nets.entries()) {
  const pins = net.outpins.length + net.inpins.length > 0;
  for (const p of net.pips) {
    const t = g.tileByName.get(p.tile);
    if (t === undefined) continue;
    for (const wname of [p.from, p.to]) {
      const n = g.node(t, wname);
      used.add(n);
      if (pins && !netOfNode.has(n)) netOfNode.set(n, j);
    }
  }
}
// the branches: per tile of a wanted type, up to K PIPs whose input is on a net and output is free
const branches = new Map();   // net index -> [{ tile, from, to }]
const key = {};
let count = 0;
const tiles = shuffle([...g.tiles.keys()].filter(t => want[g.tiles[t].type]));
const remaining = new Map(Object.entries(want).map(([t, l]) => [t, new Set(l)]));
for (const t of tiles) {
  const type = g.tiles[t].type;
  const left = remaining.get(type);
  let k = 0;
  for (const i of shuffle(g.pipsOf(t).filter(i => !g.rt[i] || want[g.tiles[t].type].includes(`${g.names[g.pipA[i]]}->${g.names[g.pipB[i]]}`)))) {
    if (k >= K) break;
    const p = g.pip(i), name = `${p.from}->${p.to}`;
    if (!want[type].includes(name)) continue;
    const a = g.node(t, p.from), b = g.node(t, p.to);
    if (!netOfNode.has(a) || used.has(b)) continue;
    // prefer PIPs not yet chosen in another tile of the type
    if (!left.has(name) && left.size) continue;
    used.add(b);
    left.delete(name);
    const j = netOfNode.get(a);
    (branches.get(j) || branches.set(j, []).get(j)).push({ tile: g.tiles[t].name, from: p.from, to: p.to });
    (key[g.tiles[t].name] ||= []).push({ from: p.from, dir: '->', to: p.to });
    k++; count++;
  }
}
// codewords per tile
const words = [];
const rec = (start, acc) => { if (acc.length === w) { words.push(acc.slice()); return; } for (let j = start; j < L; j++) { acc.push(j); rec(j + 1, acc); acc.pop(); } };
rec(0, []);
for (const ps of Object.values(key)) { if (ps.length > words.length) throw new Error(`${ps.length} branches in a tile, ${words.length} codewords`); const pool = shuffle(words.map((x, i) => i)); ps.forEach((p, k) => { p.code = words[pool[k]]; }); }
const codeOf = new Map(Object.entries(key).flatMap(([tile, ps]) => ps.map(p => [`${tile} ${p.from} ${p.to}`, p.code])));
// the designs: each net's text gets its branches before the closing ';'
const netText = [...text.matchAll(/^net "((?:\\.|[^"\\])*)"[^;]*?;/gms)];
const write = (file, v) => {
  let res = '', last = 0;
  netText.forEach((m, j) => {
    const bs = (branches.get(j) || []).filter(b => v === null || !codeOf.get(`${b.tile} ${b.from} ${b.to}`).includes(v));
    const end = m.index + m[0].length - 1;   // the ';'
    res += text.slice(last, end) + bs.map(b => `  pip ${b.tile} ${b.from} -> ${b.to} ,\n`).join('');
    last = end;
  });
  fs.writeFileSync(file, res + text.slice(last));
};
if (netText.length !== design.nets.length) throw new Error(`${netText.length} net texts, ${design.nets.length} nets`);
fs.mkdirSync(out, { recursive: true });
write(`${out}/BASE.xdl`, null);
for (let v = 0; v < L; v++) write(`${out}/V${String(v).padStart(2, '0')}.xdl`, v);
fs.writeFileSync(`${out}/key.json`, JSON.stringify({ src: 'gen-branch', L, w, tiles: key }));
console.log(`${count} branches in ${Object.keys(key).length} tiles; wanted PIPs not reached: ${[...remaining.values()].reduce((a, s) => a + s.size, 0)}`);
