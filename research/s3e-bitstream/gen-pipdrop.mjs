// Routing switches (PIPs) measured in batches on a design routed by ISE: every variant is the routed
// XDL with some PIPs removed (the nets keep their pins, so bitgen still programs the rest). Each PIP
// gets a codeword of `w` ones out of `L` variants (different codewords in the same tile, chosen at
// random per tile); a PIP's bits change in exactly the variants of its codeword, so L variants
// measure every PIP of the design at once (ana-pipdrop.mjs).
//
//   node gen-pipdrop.mjs routed.xdl outdir [L=20] [w=3] [seed=1]
import fs from 'node:fs';

const [src, out, Ls = '20', ws = '3', seeds = '1'] = process.argv.slice(2);
const L = +Ls, w = +ws;
let seed = +seeds;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
fs.mkdirSync(out, { recursive: true });
const text = fs.readFileSync(src, 'utf8');
const lines = text.split('\n');
// the PIP lines, by tile
const byTile = new Map();
lines.forEach((l, i) => {
  const m = /^\s*pip (\S+) (\S+) (\S+) (\S+)\s*,\s*$/.exec(l);
  if (m) { if (!byTile.has(m[1])) byTile.set(m[1], []); byTile.get(m[1]).push({ line: i, from: m[2], dir: m[3], to: m[4] }); }
});
// every codeword of weight w
const words = [];
const rec = (start, acc) => { if (acc.length === w) { words.push(acc.slice()); return; } for (let j = start; j < L; j++) { acc.push(j); rec(j + 1, acc); acc.pop(); } };
rec(0, []);
const key = {};
for (const [tile, ps] of byTile) {
  if (ps.length > words.length) throw new Error(`${tile}: ${ps.length} PIPs, only ${words.length} codewords`);
  // a random choice of distinct codewords for the tile's PIPs
  const pool = words.map((x, i) => i);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  key[tile] = ps.map((p, k) => ({ from: p.from, dir: p.dir, to: p.to, code: words[pool[k]] }));
  ps.forEach((p, k) => { p.code = words[pool[k]]; });
}
fs.writeFileSync(`${out}/BASE.xdl`, text);
for (let v = 0; v < L; v++) {
  const drop = new Set();
  for (const ps of byTile.values()) for (const p of ps) if (p.code.includes(v)) drop.add(p.line);
  fs.writeFileSync(`${out}/V${String(v).padStart(2, '0')}.xdl`, lines.filter((l, i) => !drop.has(i)).join('\n'));
}
fs.writeFileSync(`${out}/key.json`, JSON.stringify({ src, L, w, tiles: key }));
console.log(`${byTile.size} tiles, ${[...byTile.values()].reduce((a, p) => a + p.length, 0)} PIPs, ${L} variants`);
