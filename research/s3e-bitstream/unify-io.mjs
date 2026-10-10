// The I/O tile types of one side of the chip have the same switch box (the PIPs measured in both
// have the same bits): their PIP features are shared. When two measurements disagree, the one with
// bits wins (a PIP measured without bits is usually a bit given to a neighbouring tile).
//   node unify-io.mjs      (rewrites db/xc3s250e-tiles.json)
import fs from 'node:fs';

const file = new URL('./db/xc3s250e-tiles.json', import.meta.url);
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const groups = [
  ['LIOIS', 'LIOIS_PCI', 'LIOIS_CLK_PCI', 'LIOIS_BRK', 'LIBUFS', 'LIBUFS_PCI', 'LIBUFS_CLK_PCI'],
  ['RIOIS', 'RIOIS_PCI', 'RIOIS_CLK_PCI', 'RIBUFS', 'RIBUFS_PCI', 'RIBUFS_CLK_PCI', 'RIBUFS_BRK'],
  ['TIOIS', 'TIBUFS'], ['BIOIS', 'BIBUFS'],
];
let changed = 0;
for (const g of groups) {
  const votes = new Map();   // feature -> Map(pattern -> count)
  for (const t of g) for (const [f, bits] of Object.entries(db.types[t]?.features || {})) {
    if (!/->|=-/.test(f)) continue;
    if (!votes.has(f)) votes.set(f, new Map());
    const p = bits.join(' ');
    votes.get(f).set(p, (votes.get(f).get(p) || 0) + 1);
  }
  for (const [f, m] of votes) {
    const best = [...m].sort((a, b) => (b[0] !== '') - (a[0] !== '') || b[1] - a[1])[0][0];
    for (const t of g) {
      if (!db.types[t]) db.types[t] = { features: {} };
      const cur = db.types[t].features[f];
      if (!cur || cur.join(' ') !== best) { db.types[t].features[f] = best ? best.split(' ') : []; changed++; }
    }
  }
}
for (const t of Object.values(db.types)) t.features = Object.fromEntries(Object.entries(t.features).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(file, JSON.stringify(db, null, 0).replace(/("[^"]+":\[[^\]]*\]),/g, '$1,\n'));
console.log(`${changed} I/O PIP features shared`);
