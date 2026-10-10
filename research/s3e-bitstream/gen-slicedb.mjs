// Stage B -> database: the slice settings measured in the four slice positions of a CLB (harness
// variants, analyze-slice.mjs: <dir>/slice-bits.json for SLICE_X30Y46, X30Y47 (SLICEM, lower /
// upper), X31Y46, X31Y47 (SLICEL)), as features of the CLB tile: `SLICE<i>:<ATTR>:<VALUE>` with
// i = 2 * (X odd) + (Y odd), bits relative to the tile (frame from the column's first frame, bit from
// the row's first bit).
//   node gen-slicedb.mjs X30Y46.json X30Y47.json X31Y46.json X31Y47.json > slice-features.json
import fs from 'node:fs';

// the harness's settings (gen-harness.mjs) and what each variant changes (gen-hvar.mjs)
const BASE = { CLKINV: 'CLK', CEINV: 'CE', SRINV: 'SR', BXINV: 'BX', BYINV: 'BY', FFX: '#FF', FFY: '#FF', FFX_INIT_ATTR: 'INIT0', FFY_INIT_ATTR: 'INIT0', FFX_SR_ATTR: 'SRLOW', FFY_SR_ATTR: 'SRLOW', SYNC_ATTR: 'ASYNC', DXMUX: '1', DYMUX: '1', FXMUX: 'F', GYMUX: 'G', CYINIT: 'CIN', CYSELF: 'F', CYSELG: 'G', CY0F: 'BX', CY0G: 'BY' };
const VAR = {
  CLKINV_B: { CLKINV: 'CLK_B' }, CEINV_B: { CEINV: 'CE_B' }, SRINV_B: { SRINV: 'SR_B' }, BXINV_B: { BXINV: 'BX_B' }, BYINV_B: { BYINV: 'BY_B' },
  LATCH: { FFX: '#LATCH', FFY: '#LATCH' }, INIT1_X: { FFX_INIT_ATTR: 'INIT1' }, INIT1_Y: { FFY_INIT_ATTR: 'INIT1' },
  SRHIGH_X: { FFX_SR_ATTR: 'SRHIGH' }, SRHIGH_Y: { FFY_SR_ATTR: 'SRHIGH' }, SYNC: { SYNC_ATTR: 'SYNC' },
  CYINIT_BX: { CYINIT: 'BX' }, CYSELF_1: { CYSELF: '1' }, CYSELG_1: { CYSELG: '1' },
  CY0F_0: { CY0F: '0', DXMUX: '0' }, CY0F_1: { CY0F: '1', DXMUX: '0' }, CY0F_F1: { CY0F: 'F1', DXMUX: '0' }, CY0F_F2: { CY0F: 'F2', DXMUX: '0' }, CY0F_PROD: { CY0F: 'PROD', DXMUX: '0' },
  CY0G_0: { CY0G: '0', DYMUX: '0' }, CY0G_1: { CY0G: '1', DYMUX: '0' }, CY0G_G1: { CY0G: 'G1', DYMUX: '0' }, CY0G_G2: { CY0G: 'G2', DYMUX: '0' }, CY0G_PROD: { CY0G: 'PROD', DYMUX: '0' },
  FXMUX_F5: { FXMUX: 'F5' }, FXMUX_FXOR: { FXMUX: 'FXOR' }, GYMUX_FX: { GYMUX: 'FX' }, GYMUX_GXOR: { GYMUX: 'GXOR' },
};
// bits owned by an attribute (variants change several attributes at once: DXMUX with CY0F)
const OWN = { DXMUX: [[4]], DYMUX: [[-12]] };
const features = {};
for (const file of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [, x, y] = /X(\d+)Y(\d+)/.exec(r.site).map(Number);
  const idx = (x & 1) * 2 + (y & 1);
  // the LUT F of the slice relative to its tile: frame 0 (even X) or 3 (odd X), bit 48 (even Y) or 16 (odd Y)
  const lf = (x & 1) ? 3 : 0, lb = (y & 1) ? 16 : 48;
  const bitsOf = {};   // attr -> value -> Map(pos -> value)
  for (const row of r.rows) {
    const ch = VAR[row.variant];
    if (!ch || !row.where) continue;
    const bits = row.where.split(' ').map(s => { const m = /f([+-]\d+):b([+-]\d+)=(\d)/.exec(s); return [+m[1] + lf, +m[2] + lb, +m[3]]; });
    for (const [attr, val] of Object.entries(ch)) {
      // the bits of this attribute: for DXMUX / DYMUX the bit they own, else the rest
      const own = OWN[attr] ? bits.filter(b => OWN[attr].some(([d]) => b[1] - lb === d)) : bits.filter(b => !Object.keys(ch).some(a => a !== attr && OWN[a] && OWN[a].some(([d]) => b[1] - lb === d)));
      ((bitsOf[attr] ||= {})[val] ||= new Map());
      for (const [f, b, v] of own) bitsOf[attr][val].set(`${f},${b}`, v);
    }
  }
  for (const [attr, vals] of Object.entries(bitsOf)) {
    // the base value: every bit of the attribute at the opposite of what the variants set
    const all = new Map();
    for (const m of Object.values(vals)) for (const [p, v] of m) all.set(p, 1 - v);
    const valuesAll = { [BASE[attr]]: all };
    for (const [val, m] of Object.entries(vals)) { const s = new Map(all); for (const [p, v] of m) s.set(p, v); valuesAll[val] = s; }
    for (const [val, m] of Object.entries(valuesAll)) {
      features[`SLICE${idx}:${attr}:${val}`] = [...m].filter(([, v]) => v).map(([p]) => p);
    }
  }
}
console.log(JSON.stringify({ types: { CENTER_SMALL: { features } } }, null, 1));
