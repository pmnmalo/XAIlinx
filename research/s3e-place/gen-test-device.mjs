// A small made-up device in the format of `xdl -report` (no pips) for the unit tests of the placer
// (test/fixtures/fpga/place-device.xdlrc): a grid of 6 x 6 CLBs (slices X0..X11, Y0..Y11; SLICEM
// on even X), one CLB missing (a hole the carry chains must avoid), pads on the four edges (some
// input-only), and four global clock buffers top and bottom. Not a real chip.
//   node research/s3e-place/gen-test-device.mjs > test/fixtures/fpga/place-device.xdlrc
const C = 6, R = 6;
const rows = R + 2, cols = C + 2;
const out = [];
out.push('# =======================================================');
out.push('# A made-up device in the format of xdl -report (core/fpga/place.js tests). Not a real chip.');
out.push('# =======================================================');
out.push('(xdl_resource_report v0.2 xc3s250ecp132-4 spartan3e');
out.push(`(tiles ${rows} ${cols}`);
let pad = 1;
const tile = (r, c, name, type, sites) => {
  out.push(`\t(tile ${r} ${c} ${name} ${type} ${sites.length}`);
  for (const s of sites) out.push(`\t\t(primitive_site ${s[0]} ${s[1]} ${s[2]} 1)`);
  out.push('\t)');
};
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const cy = rows - 2 - r, cx = c - 1;   // CLB coordinates (row 0 at the bottom)
    if (r === 0 || r === rows - 1) {
      if (c === 0 || c === cols - 1) continue;
      const top = r === 0;
      if (c === 3) { tile(r, c, top ? 'CLKT_X3Y7' : 'CLKB_X3Y0', top ? 'CLKT' : 'CLKB', (top ? ['X1Y10', 'X1Y11', 'X2Y10', 'X2Y11'] : ['X1Y0', 'X1Y1', 'X2Y0', 'X2Y1']).map(n => [`BUFGMUX_${n}`, 'BUFGMUX', 'internal'])); continue; }
      tile(r, c, `${top ? 'TIOIS' : 'BIOIS'}_X${c}Y${top ? rows - 1 : 0}`, top ? 'TIOIS' : 'BIOIS', [[`P${pad++}`, c === 2 ? 'IBUF' : 'IOB', 'bonded'], [`P${pad++}`, 'IOB', 'bonded'], [`P${pad++}`, 'IOB', 'bonded'], [`P${pad++}`, 'IOB', 'bonded']]);
      continue;
    }
    if (c === 0 || c === cols - 1) {
      tile(r, c, `${c === 0 ? 'LIOIS' : 'RIOIS'}_X${c}Y${rows - 1 - r}`, c === 0 ? 'LIOIS' : 'RIOIS', [[`P${pad++}`, 'IOB', 'bonded'], [`P${pad++}`, 'IOB', 'bonded'], [`P${pad++}`, 'IOB', 'bonded'], [`P${pad++}`, 'IOB', 'bonded'], [`NOPAD${pad}`, 'IOB', 'unbonded']]);
      continue;
    }
    if (cx === 2 && cy === 3) continue;   // a hole (as the block RAM columns of a real chip)
    const sites = [];
    for (const [dx, dy] of [[0, 0], [0, 1], [1, 0], [1, 1]]) sites.push([`SLICE_X${2 * cx + dx}Y${2 * cy + dy}`, dx ? 'SLICEL' : 'SLICEM', 'internal']);
    tile(r, c, `CLB_X${c}Y${rows - 1 - r}`, 'CENTER_SMALL', sites);
  }
}
out.push(')');
out.push('(primitive_defs 0');
out.push(')');
out.push(')');
console.log(out.join('\n'));
