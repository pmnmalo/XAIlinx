// Shared helpers of the bitstream experiments.
const lits = a => [1, 2, 3, 4].map(k => ((a >> (k - 1)) & 1 ? `A${k}` : `~A${k}`)).join('*');
/** XDL LUT equation from its 16 bits (bit a = output for address a = A4A3A2A1). */
export function eqOf(bits) {
  const ones = bits.map((b, a) => (b ? a : -1)).filter(a => a >= 0);
  if (!ones.length) return 'D=(A1*~A1)';
  if (ones.length === 16) return 'D=(A1+~A1)';
  return `D=(${ones.map(a => `(${lits(a)})`).join('+')})`;
}

/** Artefacts among different patterns of one PIP: a LUT turned to the constant 0 when its output
 *  lost its only route (8 or more bits of one 16-bit LUT block), a cleared bit (the pin's input
 *  multiplexer falling back to another setting), no bits while others have bits (bits given to a
 *  neighbouring tile). Each filter applies only when it leaves a pattern.
 *  pats: [[pattern ("df,db df,db …"), tiles], …] sorted by count; returns the patterns left, same order. */
export function resolvePatterns(pats) {
  const lutRun = p => { const n = new Map(); for (const s of p.split(' ')) { const [f, b] = s.replace('!', '').split(',').map(Number); const k = `${f}:${Math.floor(b / 16)}`; n.set(k, (n.get(k) || 0) + 1); } return [...n.values()].some(c => c >= 8); };
  for (const bad of [p => p && lutRun(p), p => p.includes('!'), p => !p]) {
    const keep = pats.filter(([p]) => !bad(p));
    if (keep.length) pats = keep;
  }
  return pats;
}

/** A PIP's measured bits without a LUT turned into the constant 0 (8 or more bits of one 16-bit LUT
 *  block of one frame): removing the only route of a LUT's output makes bitgen clear the LUT, which
 *  is not the PIP's. bits: ["df,db" | "!df,db", …] (relative or absolute). */
export function stripLutRuns(bits) {
  const key = s => { const [f, b] = s.replace('!', '').split(',').map(Number); return `${f}:${Math.floor(b / 16)}`; };
  const n = new Map();
  for (const s of bits) n.set(key(s), (n.get(key(s)) || 0) + 1);
  return bits.filter(s => n.get(key(s)) < 8);
}
