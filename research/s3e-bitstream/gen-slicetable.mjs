// db/xc3s250e-slice.json: the slice settings of the database (db/xc3s250e-tiles.json, CLB tile
// features SLICE<i>:…) as a table per slice position, with the formula that places them in any slice.
//   node gen-slicetable.mjs > db/xc3s250e-slice.json
import fs from 'node:fs';

const tiles = JSON.parse(fs.readFileSync(new URL('./db/xc3s250e-tiles.json', import.meta.url), 'utf8'));
const layout = JSON.parse(fs.readFileSync(new URL('./db/xc3s250e-layout.json', import.meta.url), 'utf8'));
const positions = {};
for (const [f, bits] of Object.entries(tiles.types.CENTER_SMALL.features)) {
  const m = /^SLICE(\d):(.*)$/.exec(f);
  if (!m) continue;
  (positions[`SLICE${m[1]}`] ||= {})[m[2]] = bits;
}
console.log(JSON.stringify({
  device: 'xc3s250e-4-cp132',
  source: tiles.source,
  note: 'Slice SLICE_X<x>Y<y> is in tile CLB_X<floor(x/2)+1>Y<floor(y/2)+1> at position i = 2 * (x odd) + (y odd) (0, 1: SLICEM; 2, 3: SLICEL). A setting "<ATTR>:<VALUE>" sets the bits "df,db" (frame cols[X] + df of the tile column, bit rows[Y] + db of the tile row, db/xc3s250e-layout.json; "!" = cleared). <ATTR>:#OFF entries apply when the setting is absent (FXMUX / GYMUX: a used LUT whose X / Y path is unused; CEINV: flip-flops without a clock enable). USED: every used slice. LUT contents: db/xc3s250e-lut.json.',
  cols: layout.cols, rows: layout.rows,
  positions,
}, null, 1).replace(/\[\n\s+("[^"]*"(?:,\n\s+"[^"]*")*)\n\s+\]/g, (m, a) => `[${a.replace(/,\n\s+/g, ', ')}]`));
