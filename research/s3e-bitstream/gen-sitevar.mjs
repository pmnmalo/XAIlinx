// Settings of the sites of one type (block RAM, multiplier, DCM…) in a design implemented by ISE: base
// designs (the design with some settings changed on every instance of the type) and variants (a
// base with one more change), so that ana-sitevar.mjs finds the bits of each setting per instance.
//   node gen-sitevar.mjs design.xdl outdir spec.json
// spec.json: { type: 'RAMB16', bases: { B: { ATTR: value, … } }, variants: [{ name, base, set: { ATTR:
// value | null (removed) }, code?: [attr, k] }] }; a hexadecimal value may be written "@code:<width>:<k>":
// bit i set when bit k of i + 1 is 1 (binary codes: ceil(log2(width + 1)) variants find every bit),
// or "@code:<width>:-1": all ones. A variant with site: 'RAMB16_X0Y4' changes that instance only
// (adjacent instances' bits may be near each other).
import fs from 'node:fs';

const [src, out, specFile] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const text = fs.readFileSync(src, 'utf8');
const value = v => {
  const m = /^@code:(\d+):(-?\d+)$/.exec(v ?? '');
  if (!m) return v;
  const w = +m[1], k = +m[2];
  let n = 0n;
  for (let i = 0; i < w; i++) if (k < 0 || (((i + 1) >> k) & 1)) n |= 1n << BigInt(i);
  return n.toString(16).toUpperCase().padStart(Math.ceil(w / 4), '0');
};
const apply = (sets, more = {}, only = null) => text.replace(new RegExp(`(inst "[^"]*" "${spec.type}",placed \\S+ (\\S+)\\s*,\\s*cfg ")([^"]*)(")`, 'g'), (m, a, site, cfg, b) => {
  let c = cfg;
  if (!only || site === only) sets = { ...sets, ...more };
  for (const [attr, v0] of Object.entries(sets)) {
    const v = value(v0);
    const re = new RegExp(`(^|\\s)${attr}::\\S*`);
    if (re.test(c)) c = c.replace(re, (s, sp) => (v === null ? sp : `${sp}${attr}::${v}`));
    else if (v !== null) c += ` ${attr}::${v} `;
  }
  return a + c + b;
});
fs.mkdirSync(out, { recursive: true });
for (const [name, sets] of Object.entries(spec.bases)) fs.writeFileSync(`${out}/${name}.xdl`, apply(sets));
for (const v of spec.variants) fs.writeFileSync(`${out}/${v.name}.xdl`, apply(spec.bases[v.base], v.set, v.site || null));
fs.writeFileSync(`${out}/key.json`, JSON.stringify(spec));
console.log(`${Object.keys(spec.bases).length} bases, ${spec.variants.length} variants`);
