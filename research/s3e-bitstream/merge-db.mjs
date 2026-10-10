// Merges feature tables ({ types: { TYPE: { features: { feature: [bits] } } } }) into
// db/xc3s250e-tiles.json. Later files win for a feature they both have, unless --keep.
//   node merge-db.mjs [--keep] a.json b.json …
import fs from 'node:fs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const file = new URL('./db/xc3s250e-tiles.json', import.meta.url);
const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
  device: 'xc3s250e-4-cp132',
  source: 'research/s3e-bitstream (see README.md): slice settings from the harnesses (gen-harness.mjs, gen-hvar.mjs, gen-slicedb.mjs), routing switches from gen-pipdrop.mjs / gen-pipcover.mjs + ana-pipdrop.mjs, other settings from ana-residual.mjs; ISE 14.7 xdl P.20131013 + bitgen; 2026-10-10',
  note: 'Per tile type: features -> bits set, "df,db" = frame offset from the tile column\'s first frame, bit offset from the tile row\'s first bit ("!df,db" = bit cleared). PIP features are "from->to" (wire names of the tile); site settings "<SITE><index>:<ATTR>:<VALUE>".',
  types: {},
};
let n = 0;
for (const f of args.filter(a => a !== '--keep')) {
  const add = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [type, t] of Object.entries(add.types || {})) {
    const dst = (db.types[type] ||= { features: {} });
    if (t.sameAs) dst.sameAs = t.sameAs;
    for (const [k, v] of Object.entries(t.features || {})) {
      if (keep && dst.features[k]) continue;
      dst.features[k] = [...v].sort();
      n++;
    }
  }
  if (add.padFeatures) for (const [p, f] of Object.entries(add.padFeatures)) db.padFeatures = { ...(db.padFeatures || {}), [p]: { ...(db.padFeatures?.[p] || {}), ...f } };
}
for (const t of Object.values(db.types)) t.features = Object.fromEntries(Object.entries(t.features).sort(([a], [b]) => a.localeCompare(b)));
fs.writeFileSync(file, JSON.stringify(db, null, 0).replace(/("[^"]+":\[[^\]]*\]),/g, '$1,\n'));
console.log(`${n} features merged`);
