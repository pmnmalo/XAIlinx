// Block RAM contents: every one of the 18432 memory bits of every block RAM, located by binary codes.
// Memory bit i (i < 16384: bit i % 256 of INIT_<i / 256>, i >= 16384: the parity bits, INITP_xx) is
// set in variant k when bit k of i + 1 is 1 (k = 0…14), so a frame bit that changes in exactly the
// variants of a code is memory bit code - 1 (ana-bram.mjs). All 12 block RAMs, same codes.
//   node gen-bram.mjs dev-full.xdlrc outdir
import fs from 'node:fs';
import { loadGraph } from './xdlrc-graph.mjs';

const [xdlrc, out] = process.argv.slice(2);
const g = loadGraph(xdlrc);
const sites = [];
for (const tile of g.tiles) for (const s of tile.sites) if (s.type === 'RAMB16') sites.push({ site: s.name, tile: tile.name });
const K = 15, N = 18432;
// INIT strings of a variant: 64 hex digits each, the most significant first
const inits = on => {
  const cfg = [];
  for (const [name, n, off] of [['INIT', 64, 0], ['INITP', 8, 16384]]) for (let x = 0; x < n; x++) {
    let hex = '';
    for (let d = 63; d >= 0; d--) {
      let v = 0;
      for (let j = 0; j < 4; j++) if (on(off + 256 * x + 4 * d + j)) v |= 1 << j;
      hex += v.toString(16).toUpperCase();
    }
    cfg.push(`${name}_${x.toString(16).padStart(2, '0')}::${hex}`);   // (xdl wants INIT_0a, lower case)
  }
  return cfg.join(' ');
};
const write = (name, on) => {
  const txt = [`design "bram" xc3s250ecp132-4 v3.2 ,\n  cfg "";`];
  for (const { site, tile } of sites) txt.push(`inst "${site}" "RAMB16",placed ${tile} ${site} ,\n  cfg " RAMB16:${site}_r: PORTA_ATTR::512X36 PORTB_ATTR::512X36 WRITEMODEA::WRITE_FIRST WRITEMODEB::WRITE_FIRST ${inits(on)} "\n  ;`);
  fs.writeFileSync(`${out}/${name}.xdl`, txt.join('\n') + '\n');
};
fs.mkdirSync(out, { recursive: true });
write('BASE', () => false);
write('ONES', () => true);
for (let k = 0; k < K; k++) write(`V${String(k).padStart(2, '0')}`, i => (((i + 1) >> k) & 1) === 1);
fs.writeFileSync(`${out}/key.json`, JSON.stringify({ K, N, sites }));
console.log(`${sites.length} block RAMs, ${K + 2} designs`);
