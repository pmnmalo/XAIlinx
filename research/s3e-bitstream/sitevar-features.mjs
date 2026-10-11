// Features from ana-sitevar.mjs results (one instance, or the same pattern in all): the bits of every
// measured value of every setting, relative to the site with the settings removed.
//   node sitevar-features.mjs spec.json ana.json TYPE KIND [--rm RM_ALL] > features.json
// For a variant setting ATTR to v from the base: A(v) = the bits where the removed state (variant
// --rm, the listed settings removed at once) and the variant differ, with the variant's values; the
// base's own value: the bits of --rm, with the base's values. A setting not removed by --rm: the
// variant's own bits, the base value without bits.
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : d; };
const [specFile, anaFile, type, kind] = args;
const rmName = opt('--rm', 'RM_ALL');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const ana = JSON.parse(fs.readFileSync(anaFile, 'utf8')).feats;
const pats = Object.values(ana)[0];
const one = name => { const p = pats[name]; if (!p || p.length !== 1) return null; return p[0][0] ? p[0][0].split(' ') : []; };
// a pattern as a map position -> value
const asMap = bits => new Map(bits.map(s => [s.replace('!', ''), s[0] === '!' ? 0 : 1]));
const rmVar = spec.variants.find(v => v.name === rmName);
const rm = rmVar && one(rmName) ? asMap(one(rmName)) : new Map();
const removed = new Set(Object.keys(rmVar?.set || {}));
const base = spec.bases[spec.variants[0].base] || {};
const feats = {};
const baseText = fs.readFileSync(opt('--xdl', ''), 'utf8');
const baseVal = attr => (new RegExp(`(?:^|\\s)${attr}::(\\S*)`).exec(baseText) || [])[1];
// the variants of each setting, and the bits of the removed state that belong to it (the positions
// that some value of the setting changes)
const byAttr = new Map();
for (const v of spec.variants) {
  if (v.name === rmName) continue;
  const keys = Object.keys(v.set);
  const attr = keys.includes('PHASE_SHIFT') ? 'PHASE_SHIFT' : keys.length === 1 ? keys[0] : null;
  const bits = one(v.name);
  if (!attr || v.set[attr] === null || !bits) continue;
  (byAttr.get(attr) || byAttr.set(attr, []).get(attr)).push([v.set[attr], asMap(bits)]);
}
const used = new Set();
for (const [attr, vs] of byAttr) {
  const touched = new Set(vs.flatMap(([, d]) => [...d.keys()]));
  const rmX = new Map([...rm].filter(([p]) => touched.has(p) && removed.has(attr)));
  if (!removed.has(attr)) {
    // a setting not removed: each value's bits that are set (the base value is the one that
    // changes nothing; the base's state at a position is the opposite of a variant's)
    const base = new Map([...touched].map(p => [p, 1 - vs.map(([, d]) => d.get(p)).find(x => x !== undefined)]));
    for (const [value, d] of vs) feats[`${kind}:${attr}:${value}`] = [...touched].filter(p => (d.has(p) ? d.get(p) : base.get(p)) === 1).sort();
    const bv = baseVal(attr);
    if (bv !== undefined && bv !== '#OFF' && !feats[`${kind}:${attr}:${bv}`]) feats[`${kind}:${attr}:${bv}`] = [...touched].filter(p => base.get(p) === 1).sort();
    continue;
  }
  for (const p of rmX.keys()) used.add(p);
  for (const [value, d] of vs) {
    const pos = new Set([...rmX.keys(), ...d.keys()]);
    const A = [];
    for (const p of pos) {
      if (rmX.has(p) && d.has(p)) continue;   // the variant has the removed state's value there
      const val = d.has(p) ? d.get(p) : 1 - rmX.get(p);
      A.push(`${val ? '' : '!'}${p}`);
    }
    feats[`${kind}:${attr}:${value}`] = A.sort();
  }
  // the base's value
  const bv = baseVal(attr);
  if (bv !== undefined && bv !== '#OFF' && !feats[`${kind}:${attr}:${bv}`]) feats[`${kind}:${attr}:${bv}`] = [...rmX].map(([p, val]) => `${val ? '!' : ''}${p}`).sort();
}
const rest = [...rm].filter(([p]) => !used.has(p)).map(([p, val]) => `${val ? '!' : ''}${p}`);
console.error(`${Object.keys(feats).length} features; removed-state bits of no setting: [${rest.join(' ')}]`);
console.log(JSON.stringify({ types: { [type]: { features: feats } } }));
