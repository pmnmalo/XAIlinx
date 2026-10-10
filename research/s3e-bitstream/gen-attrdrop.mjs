// Slice settings measured in a design routed by ISE: each variant removes one setting from the
// slices of one position in their CLB (SLICE0-3 = 2 * (X odd) + (Y odd)), everything else unchanged,
// so the bits of that setting in that position change in every CLB where it is used (ana-attrdrop.mjs).
//   node gen-attrdrop.mjs routed.xdl outdir ATTR[,ATTR…]
// ATTR=FROM>TO changes the setting's value instead of removing it (F=#RAM>#LUT: a RAM as a LUT).
import fs from 'node:fs';

const [src, out, attrs] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const text = fs.readFileSync(src, 'utf8');
fs.writeFileSync(`${out}/BASE.xdl`, text);
const variants = [];
for (const spec of attrs.split(',')) for (let k = 0; k < 4; k++) {
  const [attr, sub] = spec.split('=');
  const [from, to] = sub ? sub.split('>') : [];
  let n = 0;
  const t = text.replace(/(inst "[^"]*" "SLICE[LM]",placed \S+ SLICE_X(\d+)Y(\d+)\s*,\s*cfg ")([^"]*)(")/g, (m, a, x, y, cfg, b) => {
    if ((+x & 1) * 2 + (+y & 1) !== k) return m;
    // the setting with its value, or a named element ATTR:name: (names may hold escaped characters)
    const re = new RegExp(`(^|\\s)${attr}:(?:\\\\.|[^\\s])*`, 'g');
    const c2 = cfg.replace(re, (s, sp) => (/#OFF$/.test(s) ? s : sub ? (s.includes(from) ? (n++, s.replace(from, to)) : s) : (n++, sp)));
    return a + c2 + b;
  });
  if (!n) continue;
  const name = `${attr}${sub ? `_${to.replace(/\W/g, '')}` : ''}_S${k}`;
  fs.writeFileSync(`${out}/${name}.xdl`, t);
  variants.push({ name, attr, slice: k, count: n });
}
fs.writeFileSync(`${out}/key.json`, JSON.stringify({ src, variants }));
console.log(variants.map(v => `${v.name}:${v.count}`).join(' '));
