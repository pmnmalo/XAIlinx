// Analysis of gen-iob.mjs --sparse: the I/O settings themselves. In each design the pads of one index
// are used in every other I/O tile, all with the same direction and standard. What the database does
// not explain in the I/O rows and columns belongs to a used pad in the same tile or in the tile next
// to it (an I/O tile also configures its pads with bits in the neighbouring tile's frames): bits with
// one candidate pad first, then the others by the patterns found. Result: per I/O tile type, the
// feature IOB<k>:<O|I>:<standard> with bits "df,db" or "df,db@dx,dy" (in the tile dx, dy away).
//   node ana-io2.mjs dir [more dirs…] > io-features.json
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { frameData, tileOf } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const db = loadDb();
const L = db.layout;
// where a bit is in the I/O ring: side, the x / y of its tile, df / db inside that tile
const colOf = f => { for (const [x, b] of Object.entries(L.cols)) { const n = +x === 0 || +x === 27 ? 21 : 19; if (f >= b && f < b + n) return { x: +x, df: f - b }; } return null; };
const rowOf = b => { for (const [y, s] of Object.entries(L.rows)) { const n = +y === 0 || +y === 35 ? 80 : 64; if (b >= s && b < s + n) return { y: +y, db: b - s }; } return null; };
function where(f, b) {
  const c = colOf(f), r = rowOf(b);
  if (!c || !r) return null;
  if (c.x === 0) return { side: 'L', ...c, ...r };
  if (c.x === 27) return { side: 'R', ...c, ...r };
  if (r.y === 35) return { side: 'T', ...c, ...r };
  if (r.y === 0) return { side: 'B', ...c, ...r };
  return null;
}
const sideOf = t => (t.x === 0 ? 'L' : t.x === 27 ? 'R' : t.y === 35 ? 'T' : 'B');
const samples = [];   // { key, tile, bits: Map(spec -> 1) }
const amb = [];       // [bit, candidates]
let other = 0;
for (const dir of process.argv.slice(2)) for (const f of fs.readdirSync(dir).filter(f => /^[OI]_P\d_K\d_\w+\.bit$/.test(f)).sort()) {
  const [, mode, , k, std] = /^([OI])_P(\d)_K(\d)_(\w+)\.bit$/.exec(f);
  const design = parseXdl(fs.readFileSync(`${dir}/${f.replace('.bit', '.xdl')}`, 'utf8'));
  const res = diffFrames(frameData(design, db).frames, readBit(fs.readFileSync(`${dir}/${f}`)).frames);
  const used = design.insts.filter(i => /^(IOB|IBUF)$/.test(i.type)).map(i => {
    const t = tileOf(i.tile, db);
    const s = { key: `${t.type}\tIOB${k}:${i.type === 'IBUF' ? 'I' : mode}:${std}`, tile: i.tile, t, side: sideOf(t), bits: new Map() };
    samples.push(s);
    return s;
  });
  for (const x of res) {
    const w = where(x.frame, x.bit);
    if (!w) { other++; continue; }
    const cands = used.filter(u => u.side === w.side && (w.side === 'L' || w.side === 'R' ? Math.abs(u.t.y - w.y) <= 1 : Math.abs(u.t.x - w.x) <= 1)).map(u => {
      const dx = w.x - u.t.x, dy = w.y - u.t.y;
      return { u, spec: `${x.value ? '' : '!'}${w.df},${w.db}${dx || dy ? `@${dx},${dy}` : ''}` };
    });
    if (cands.length === 1) cands[0].u.bits.set(cands[0].spec, 1);
    else if (cands.length) amb.push(cands);
    else other++;
  }
}
// the patterns from the bits with one candidate; then each ambiguous bit to the candidate whose
// pattern has it
const stat = new Map();
const count = () => { stat.clear(); for (const s of samples) { if (!stat.has(s.key)) stat.set(s.key, { n: 0, specs: new Map() }); const e = stat.get(s.key); e.n++; for (const b of s.bits.keys()) e.specs.set(b, (e.specs.get(b) || 0) + 1); } };
count();
let unresolved = 0;
for (const cands of amb) {
  const score = c => (stat.get(c.u.key).specs.get(c.spec) || 0) / stat.get(c.u.key).n;
  const best = cands.map(c => [c, score(c)]).sort((a, b) => b[1] - a[1]);
  if (best[0][1] >= 0.5 && (best.length < 2 || best[1][1] < 0.5)) best[0][0].u.bits.set(best[0][0].spec, 1);
  else unresolved++;
}
count();
const out = { types: {} };
for (const [key, e] of [...stat].sort()) {
  const [type, feat] = key.split('\t');
  const specs = [...e.specs].filter(([, n]) => n * 2 > e.n).map(([s]) => s).sort();
  const weak = [...e.specs].filter(([, n]) => n * 2 <= e.n).map(([s, n]) => `${s}(${n})`);
  console.error(`${type.padEnd(16)} ${feat.padEnd(22)} x${e.n} [${specs.join(' ')}]${weak.length ? `  weak: ${weak.join(' ')}` : ''}`);
  ((out.types[type] ||= { features: {} }).features[feat] = specs);
}
console.error(`${amb.length} bits with two candidate pads (${unresolved} not resolved), ${other} bits elsewhere`);
console.log(JSON.stringify(out));
