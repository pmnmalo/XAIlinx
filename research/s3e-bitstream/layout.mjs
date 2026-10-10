// Where each tile of the XC3S250E is in the frame data: its frames (a column of the device) and its
// bits (a row). Provisional, from the chip map of stage A (db/xc3s250e-lut.json) and from the
// device grid: CLB rows are 64-bit windows (row k from the bottom: bits 2192 - 64 k …), the I/O rows
// at the top and bottom 80 bits; a CLB column is 19 frames starting at the frame of the LUTs of its
// even slices. Other columns (I/O, clock, block RAM) are filled in when measured (COLS below).
import fs from 'node:fs';

const lut = JSON.parse(fs.readFileSync(new URL('./db/xc3s250e-lut.json', import.meta.url), 'utf8')).lutF;
// columns measured later (grid column -> { frame, frames }), filled in by the experiments
export const COLS = {};

let grid = null;
/** The grid columns of CLB tiles, and the row index of every grid row, from the tile list. */
export function setGrid(tiles) {
  const colX = {}, rowY = {};
  for (const t of tiles) {
    const m = /^CLB_X(\d+)Y(\d+)$/.exec(t.name);
    if (m) { colX[t.c] = +m[1]; rowY[t.r] = +m[2]; }
  }
  grid = { colX, rowY, maxR: Math.max(...tiles.map(t => t.r)) };
}

/** { frame, frames, bit, bits } of a tile (null when not known). */
export function tileWindow(t, tiles) {
  if (!grid && tiles) setGrid(tiles);
  if (!grid) throw new Error('layout: setGrid(tiles) first');
  let frame = null, frames = 0, bit = null, bits = 0;
  const x = grid.colX[t.c];
  if (x !== undefined) { frame = lut.colFrame[2 * (x - 1)]; frames = 19; }
  else if (COLS[t.c]) ({ frame, frames } = COLS[t.c]);
  const y = grid.rowY[t.r];
  if (y !== undefined) { bit = lut.rowBit[2 * (y - 1) + 1] - 16; bits = 64; }
  else if (t.r <= 1) { bit = 0; bits = 80; }
  else if (t.r >= grid.maxR - 1) { bit = 2256; bits = 80; }
  return { frame, frames, bit, bits };
}
