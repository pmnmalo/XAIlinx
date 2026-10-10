// The tiles around the CLBs (I/O, corners, block-RAM interconnect, DCM) have the CLB's switch box:
// every PIP measured in both has the same bits at a fixed offset (the left I/O column 2 frames later,
// the top I/O row 16 bits further). Those tile types share the CLB's features (sameAs + shift, see
// makeDb in core/fpga/bitgen.js); their own measurements that the CLB's give are dropped, and so are
// own measurements without bits where the CLB's have bits (bits given to a neighbouring tile by
// ana-pipdrop.mjs). A measurement that contradicts the CLB's is reported and kept. The I/O tiles'
// own pin wires are renamed to the CLB's (RENAME).
//   node share-sb.mjs [--check]      (rewrites db/xc3s250e-tiles.json; --check: only the report)
import fs from 'node:fs';
import { shiftBit } from '../../core/fpga/bitgen.js';

export const SHIFTS = {
  '0,0': ['BIOIS', 'BIBUFS', 'RIOIS', 'RIOIS_PCI', 'RIOIS_CLK_PCI', 'RIBUFS', 'RIBUFS_PCI', 'RIBUFS_CLK_PCI', 'RIBUFS_BRK', 'LR',
    'BRAM0_SMALL', 'BRAM1_SMALL', 'BRAM2_SMALL', 'BRAM3_SMALL', 'BRAM3_SMALL_BRK', 'DCM_BL_CENTER', 'DCM_BR_CENTER', 'DCM_TL_CENTER', 'DCM_TR_CENTER'],
  '2,0': ['LIOIS', 'LIOIS_PCI', 'LIOIS_CLK_PCI', 'LIOIS_BRK', 'LIBUFS', 'LIBUFS_PCI', 'LIBUFS_CLK_PCI', 'LL'],
  '0,16': ['TIOIS', 'TIBUFS', 'UR'],
  '2,16': ['UL'],
};
// the I/O tiles' own pin wires are the CLB's with another name (IOIS_X0 = X0, IOIS_F1_B0 = F1_B0,
// IOIS_VCC_WIRE = VCC_PINWIRE): every one measured in both has the same bits
export const RENAME = [['IOIS_VCC_WIRE', 'VCC_PINWIRE'], ['IOIS_', '']];
const renamed = f => RENAME.reduce((x, [a, b]) => x.split(a).join(b), f);

if (process.argv[1] && process.argv[1].endsWith('share-sb.mjs')) {
  const check = process.argv.includes('--check');
  const file = new URL('./db/xc3s250e-tiles.json', import.meta.url);
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const clb = db.types.CENTER_SMALL.features;
  let same = 0, empty = 0, conflict = 0;
  for (const [sh, types] of Object.entries(SHIFTS)) {
    const [sf, sb] = sh.split(',').map(Number);
    for (const type of types) {
      const t = (db.types[type] ||= { features: {} });
      t.sameAs = 'CENTER_SMALL';
      if (sf || sb) t.shift = [sf, sb]; else delete t.shift;
      const io = /IOIS|IBUFS/.test(type);
      if (io) t.rename = RENAME; else delete t.rename;
      for (const [f, bits] of Object.entries(t.features)) {
        const c = clb[io ? renamed(f) : f];
        if (!c || !/->|=-/.test(f)) continue;
        const want = c.map(s => shiftBit(s, sf, sb)).sort().join(' ');
        if (bits.slice().sort().join(' ') === want) { delete t.features[f]; same++; }
        else if (!bits.length && c.length) { delete t.features[f]; empty++; }
        else { conflict++; console.error(`${type} ${f}: [${bits.join(' ')}], the CLB's shifted [${want}]`); }
      }
    }
  }
  // the terminal tiles (…TERM…): their PIPs join the wires at the edges of the chip and set no bits
  // (thousands of measurements without bits; the few with bits were bits of the I/O tile measured
  // in the same frames)
  let term = 0;
  for (const [type, t] of Object.entries(db.types)) {
    if (!/TERM/.test(type)) continue;
    t.pipsWithoutBits = true;
    for (const f of Object.keys(t.features)) if (/->|=-/.test(f)) { if (t.features[f].length) term++; delete t.features[f]; }
  }
  console.log(`terminal tiles: PIPs without bits (${term} measurements with bits dropped)`);
  console.log(`switch boxes shared: ${same} own features as the CLB's, ${empty} without bits dropped, ${conflict} different (kept)`);
  if (!check) fs.writeFileSync(file, JSON.stringify(db, null, 0).replace(/("[^"]+":\[[^\]]*\]),/g, '$1,\n'));
}
