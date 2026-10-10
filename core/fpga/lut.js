// Silinx - LUT contents both ways: a cell's INIT (UNISIM LUT1..LUT4: bit i is the output for the
// inputs I(k-1)..I0 = i) <-> the equation XDL writes for a LUT site ("#LUT:D=((A1*~A2)+A3)").
//
// The XDL equation is written in terms of the LUT's pins A1..A4 of the site (F1..F4 / G1..G4), not
// of the cell's inputs, so both directions take the assignment of cell inputs to site pins:
// pins[j] = the site pin (1..4) cell input Ij sits on (default: I0 -> A1, I1 -> A2, …). The packer
// changes this assignment when an input has to be on a given pin (F1 / F2 for the carry logic).
//
// The equation is built by Shannon expansion on the highest pin first, with the usual
// simplifications (a cofactor that is constant, equal or complementary), so it stays short:
// a 2-input AND is "(A1*A2)", an XOR "(A2@A1)", a buffer "A1".
import { evalLut } from '../xdl.js';

/** The truth table of a LUT on site pins: 16 bits, index = A4 A3 A2 A1 (A1 least significant). */
export function initToTable(init, k, pins = [1, 2, 3, 4]) {
  const bits = typeof init === 'string' ? [...init.trim()].reverse().map(c => (c === '1' ? 1 : 0)) : init;
  const t = new Array(16).fill(0);
  for (let a = 0; a < 16; a++) {
    let i = 0;
    for (let j = 0; j < k; j++) if ((a >> (pins[j] - 1)) & 1) i |= 1 << j;
    t[a] = bits[i] ? 1 : 0;
  }
  return t;
}

// the equation of a truth table over the pins in `vars` (highest first); t is a function of the
// 16-entry address
function expand(t, vars) {
  const all = t.every(b => b === t[0]);
  if (all) return String(t[0]);
  // the highest pin the function still depends on
  for (let n = 0; n < vars.length; n++) {
    const v = vars[n], m = 1 << (v - 1);
    const f0 = t.map((b, a) => t[a & ~m]), f1 = t.map((b, a) => t[a | m]);
    if (f0.every((b, a) => b === f1[a])) continue;   // does not depend on this pin
    const rest = vars.slice(n + 1);
    const x = `A${v}`;
    const c0 = f0.every(b => b === f0[0]) ? f0[0] : null, c1 = f1.every(b => b === f1[0]) ? f1[0] : null;
    if (c0 === 0 && c1 === 1) return x;
    if (c0 === 1 && c1 === 0) return `~${x}`;
    if (f0.every((b, a) => b !== f1[a])) return `(${x}@${expand(f0, rest)})`;   // f = x xor f0
    if (c0 === 0) return `(${x}*${expand(f1, rest)})`;
    if (c1 === 0) return `(~${x}*${expand(f0, rest)})`;
    if (c0 === 1) return `(~${x}+${expand(f1, rest)})`;
    if (c1 === 1) return `(${x}+${expand(f0, rest)})`;
    return `((~${x}*${expand(f0, rest)})+(${x}*${expand(f1, rest)}))`;
  }
  return String(t[0]);
}

/** The XDL equation ("D=…") of a k-input LUT cell with this INIT (string msb first, or bits lsb
 *  first), its inputs on the site pins `pins`. */
export function initToEquation(init, k, pins = [1, 2, 3, 4]) {
  return `D=${expand(initToTable(init, k, pins), [4, 3, 2, 1])}`;
}

/** The INIT of a k-input LUT cell (string msb first, as Yosys and UNISIM write it) from an XDL
 *  equation, the cell's inputs being on the site pins `pins`. */
export function equationToInit(eq, k, pins = [1, 2, 3, 4]) {
  let s = '';
  for (let i = (1 << k) - 1; i >= 0; i--) {
    const v = { A1: 0, A2: 0, A3: 0, A4: 0 };
    for (let j = 0; j < k; j++) v[`A${pins[j]}`] = (i >> j) & 1;
    s += evalLut(eq, v);
  }
  return s;
}

/** The truth table (16 bits by site address) of an XDL equation. */
export function equationTable(eq) {
  const t = [];
  for (let a = 0; a < 16; a++) t.push(evalLut(eq, { A1: a & 1, A2: (a >> 1) & 1, A3: (a >> 2) & 1, A4: (a >> 3) & 1 }));
  return t;
}
