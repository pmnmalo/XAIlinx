// Random Verilog test modules in the manner of VlogHammer's generator: a JavaScript port of
// scripts/generate.cc of VlogHammer (https://github.com/YosysHQ/VlogHammer), the Verilog synthesis
// regression test by Claire Xenia Wolf:
//
//   VlogHammer -- A Verilog Synthesis Regression Test
//   Copyright (C) 2013  Claire Xenia Wolf <claire@yosyshq.com>
//
//   Permission to use, copy, modify, and/or distribute this software for any
//   purpose with or without fee is hereby granted, provided that the above
//   copyright notice and this permission notice appear in all copies.
//
//   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
//   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
//   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
//   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
//   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
//   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
//   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// The same module families, the same xorshift32 random sequence and seeds (module i of a family
// is seeded as in generate.cc: expression i, wideexpr 1000 + i, partsel 2000 + i), the same
// choices; the arguments of a C call are drawn left to right here (C leaves that order open, so
// the text can differ from VlogHammer's own files). Families:
//   expression  18 outputs, each a random expression (all binary / unary operators, ternaries,
//               concatenations, replications, $signed / $unsigned, constants, local parameters)
//               over 4..6-bit signed and unsigned inputs
//   wideexpr    8 outputs of 16 bits: deep expressions mixing signedness, shifts, comparisons,
//               concatenations, replications, sized binary literals, ternaries on ctrl bits
//   partsel     bit and part selects (constant, indexed +: / -:, out of range) on signed and
//               unsigned vectors with ascending and descending ranges
//   binary / unary / ternary / concat / repeat   one operator over each combination of operand
//               types (the index enumerates the combinations)
//
// Modules are kept as trees (expressions as nodes) so that a failing one can be reduced:
//   const m = generate('expression', 7)   ->  { name, kind, ports, decls, params, assigns }
//   moduleText(m)                         ->  the Verilog text
//   reductions(m)                         ->  smaller variants of m (test/corpus/vloghammer.mjs)

const XORSHIFT_SEED = 20140925;
const BIG_N = 1000;
export const SEED_BASE = { expression: 0, wideexpr: BIG_N, partsel: 2 * BIG_N };

// generate.cc's xorshift32 (static state; a nonzero seed restarts it)
let X = (314159265 + XORSHIFT_SEED) >>> 0;
function xs(seed = 0) {
  if (seed) {
    X = ((seed << 16) + XORSHIFT_SEED) >>> 0;
    for (let i = 0; i < 10; i++) xs();
  }
  X = (X ^ (X << 13)) >>> 0;
  X = (X ^ (X >>> 17)) >>> 0;
  X = (X ^ (X << 5)) >>> 0;
  return X;
}
function reseed(seed) { if (seed) xs(seed); else X = (314159265 + XORSHIFT_SEED) >>> 0; }

const ARG_TYPES = [['', 3, 4], ['', 4, 5], ['', 5, 6], ['signed ', 3, 4], ['signed ', 4, 5], ['signed ', 5, 6]];
const SMALL_ARG_TYPES = [['', 0, 1], ['', 1, 2], ['', 2, 3], ['signed ', 0, 1], ['signed ', 1, 2], ['signed ', 2, 3]];
const decl = (dir, [sg, hi], name) => `${dir} ${sg}[${hi}:0] ${name}`;
const BINARY_OPS = ['+', '-', '*', '/', '%', '**', '>', '>=', '<', '<=', '&&', '||', '==', '!=', '===', '!==', '&', '|', '^', '^~', '<<', '>>', '<<<', '>>>'];
const UNARY_OPS = ['+', '-', '!', '~', '&', '~&', '|', '~|', '^', '~^'];

// ---------------------------------------------------------------- expression trees
// { k: 'leaf', s }                 identifier, literal or select, printed as is
// { k: 'un', o, a }                (o a)
// { k: 'bin', o, a, b, sp }        (a o b), sp: spaces around o
// { k: 'pow', base, b }            (base ** b)
// { k: 'tern', c, a, b, sp }       (c ? a : b)
// { k: 'cat', xs, sp }             {a, b, …}
// { k: 'rep', n, a }               {n{a}}
// { k: 'call', f, a }              f(a)   f: $signed / $unsigned / '' (parentheses)
// { k: 'wbin', o, a, b }           (a)o(b)  (wideexpr's form)
// { k: 'wun', o, a }               o(a)
export function exprText(n) {
  switch (n.k) {
    case 'leaf': return n.s;
    case 'un': return `(${n.o}${exprText(n.a)})`;
    case 'bin': return n.sp ? `(${exprText(n.a)} ${n.o} ${exprText(n.b)})` : `(${exprText(n.a)}${n.o}${exprText(n.b)})`;
    case 'pow': return `(${n.base} ** ${exprText(n.b)})`;
    case 'tern': return n.sp ? `(${exprText(n.c)} ? ${exprText(n.a)} : ${exprText(n.b)})` : `(${exprText(n.c)}?${exprText(n.a)}:${exprText(n.b)})`;
    case 'cat': return `{${n.xs.map(exprText).join(n.sp ? ', ' : ',')}}`;
    case 'rep': return `{${n.n}{${exprText(n.a)}}}`;
    case 'call': return `${n.f}(${exprText(n.a)})`;
    case 'wbin': return `(${exprText(n.a)})${n.o}(${exprText(n.b)})`;
    case 'wun': return `${n.o}(${exprText(n.a)})`;
    default: throw new Error(`exprText: ${n.k}`);
  }
}
const leaf = s => ({ k: 'leaf', s });

function constant(avoidSigned) {
  const i = (xs() % 4) + 2;
  if (xs() % 2 === 0 && !avoidSigned) {
    const neg = xs() % 2 === 0 ? '-' : '';
    return leaf(`(${neg}${i}'sd${xs() % (1 << (i - 1))})`);
  }
  return leaf(`(${i}'d${xs() % (1 << i)})`);
}

function expression(budget, mask, avoidUndef, avoidSigned, inParam) {
  const nArg = ARG_TYPES.length, nModes = 10;
  let avoidMDM = false;
  if (budget === 0) {
    if (inParam) return constant(avoidSigned);
    let c, idx;
    if (!avoidUndef && (xs() % 256) > (mask >>> 24)) { c = 'p'; idx = xs() % (3 * nArg); }
    else { c = xs() % 2 ? 'b' : 'a'; idx = xs() % nArg; }
    if (avoidSigned && (idx % nArg) >= nArg / 2) idx -= nArg / 2;
    return leaf(`${c}${idx}`);
  }
  while ((mask & ((1 << nModes) - 1)) === 0) mask = (xs() & (inParam ? ~4 : ~0)) >>> 0;
  if ((mask & 3) !== 0) avoidMDM = true;
  let mode;
  do mode = xs() % nModes; while (((1 << mode) & mask) === 0);
  budget--;
  switch (mode) {
    case 0: {
      const i = 1 + (xs() % 3), parts = [];
      for (let j = 0; j < i; j++) parts.push(expression(Math.floor(budget / i), mask, avoidUndef, avoidSigned, inParam));
      return { k: 'cat', xs: parts };
    }
    case 1: {
      const i = (xs() % 4) + 1;
      return { k: 'rep', n: i, a: expression(Math.floor(budget / i), mask, avoidUndef, avoidSigned, inParam) };
    }
    case 2: {
      const f = avoidSigned ? '$unsigned' : xs() % 3 === 0 ? '$signed' : xs() % 2 === 0 ? '$unsigned' : '';
      return { k: 'call', f, a: expression(budget, mask, avoidUndef, false, inParam) };
    }
    case 3: case 4: case 5: {
      let p;
      do p = BINARY_OPS[xs() % BINARY_OPS.length];
      while ((avoidMDM && (p === '*' || p === '/' || p === '%')) || (avoidUndef && (p === '/' || p === '%')));
      if (p === '===' || p === '!==') avoidUndef = true;
      const small = budget < 3 ? Math.max(budget - 1, 0) : 2;
      if (p === '**') {
        const base = `${ARG_TYPES[xs() % nArg][2]}'d2`;
        return { k: 'pow', base, b: expression(small, mask, avoidUndef, true, inParam) };
      }
      if (p === '/' || p === '%') {
        const a = expression(small, mask, avoidUndef, avoidSigned, inParam);
        return { k: 'bin', o: p, a, b: expression(0, mask, avoidUndef, avoidSigned, inParam) };
      }
      if (p === '*') budget = budget < 4 ? budget : 4;
      const a = expression(Math.floor(budget / 2), mask, avoidUndef, avoidSigned, inParam);
      return { k: 'bin', o: p, a, b: expression(Math.floor(budget / 2), mask, avoidUndef, avoidSigned, inParam) };
    }
    case 6: case 7: {
      const o = UNARY_OPS[xs() % UNARY_OPS.length];
      return { k: 'un', o, a: expression(budget, mask, avoidUndef, avoidSigned, inParam) };
    }
    case 8: {
      const c = expression(Math.floor(budget / 3), mask, avoidUndef, avoidSigned, inParam);
      const a = expression(Math.floor(budget / 3), mask, avoidUndef, avoidSigned, inParam);
      return { k: 'tern', c, a, b: expression(Math.floor(budget / 3), mask, avoidUndef, avoidSigned, inParam) };
    }
    default: return constant(avoidSigned);
  }
}

function wideexpr(isSigned, maxDepth) {
  const PREFIX = ['+', '-', '!', '~', '&', '~&', '|', '~|', '^', '~^'], COMBINE = ['+', '-', '&', '|', '^', '^~'];
  const SHIFT = ['<<', '<<<', '>>', '>>>'], COMPARE = ['<', '<=', '==', '!=', '>=', '>'];
  const mode = maxDepth <= 0 ? xs() % 2 : isSigned ? xs() % 7 : xs() % 10;
  switch (mode) {
    case 0: {
      const k = (xs() % 6) + 1;
      let s = `${k}'${isSigned || xs() % 2 === 0 ? 's' : ''}b`;
      for (let i = 0; i < k; i++) s += xs() % 2;
      return leaf(s);
    }
    case 1: { const c = isSigned || xs() % 2 === 0 ? 's' : 'u'; return leaf(`${c}${xs() % 8}`); }
    case 2: { const o = PREFIX[xs() % (isSigned ? 2 : PREFIX.length)]; return { k: 'wun', o, a: wideexpr(xs() % 2 === 0, maxDepth - 1) }; }
    case 3: { const a = wideexpr(isSigned, maxDepth - 1); const o = COMBINE[xs() % COMBINE.length]; return { k: 'wbin', o, a, b: wideexpr(isSigned, maxDepth - 1) }; }
    case 4: { const a = wideexpr(isSigned, maxDepth - 1); const o = SHIFT[xs() % SHIFT.length]; return { k: 'wbin', o, a, b: wideexpr(xs() % 2 === 0, maxDepth - 1) }; }
    case 5: { const c = leaf(`ctrl[${xs() % 8}]`); const a = wideexpr(isSigned, maxDepth - 1); return { k: 'tern', c, a, b: wideexpr(isSigned, maxDepth - 1) }; }
    case 6: {
      const f = isSigned || xs() % 2 === 0 ? '$signed' : '$unsigned';
      return { k: 'call', f, a: wideexpr(xs() % 2 === 0, maxDepth - 1) };
    }
    case 7: {
      const sg = xs() % 2 === 0;
      const a = wideexpr(sg, maxDepth - 1); const o = COMPARE[xs() % COMPARE.length];
      return { k: 'wbin', o, a, b: wideexpr(sg, maxDepth - 1) };
    }
    case 8: {
      const k = (xs() % 4) + 1, parts = [];
      for (let i = 0; i < k; i++) parts.push(wideexpr(xs() % 2 === 0, maxDepth - 1));
      return { k: 'cat', xs: parts };
    }
    default: {
      const k = (xs() % 4) + 1;
      return { k: 'rep', n: k, a: wideexpr(xs() % 2 === 0, maxDepth - 1) };
    }
  }
}

function partsel(maxVar, depth) {
  const v = xs() % 2 ? `x${xs() % maxVar}` : `p${xs() % 4}`;
  switch (xs() % (depth > 4 ? 5 : 10)) {
    case 0: return leaf(v);
    case 1:
      if (xs() % 2) return leaf(`${v}[${8 + (xs() % 16)}]`);
      { const a = 4 + (xs() % 16); return leaf(`${v}[${a} + s${xs() % 4}]`); }
    case 2: {
      const a = xs() % 32, s = xs() % 4, d = '+-'[xs() % 2], w = (xs() % 8) + 1;
      return leaf(`${v}[${a} + s${s} ${d}: ${w}]`);
    }
    case 3:
      // a constant part select out of the range is an error in most tools: avoided
      if (xs() % 2) { const a = 8 + (xs() % 12); return leaf(`${v}[${a} +: ${1 + (xs() % 4)}]`); }
      { const a = 12 + (xs() % 12); return leaf(`${v}[${a} -: ${1 + (xs() % 4)}]`); }
    case 4: case 5: case 6: {
      const a = partsel(maxVar, depth + 1); const o = '+-|&^'[xs() % 5];
      return { k: 'bin', o, a, b: partsel(maxVar, depth + 1), sp: true };
    }
    case 7: { const a = partsel(maxVar, depth + 1); return { k: 'cat', xs: [a, partsel(maxVar, depth + 1)], sp: true }; }
    case 8: return { k: 'rep', n: 2, a: partsel(maxVar, depth + 1) };
    default: {
      const n = () => (xs() % 2 ? '!' : ''), c = () => xs() % 4, l = () => (xs() % 2 ? '||' : '&&');
      const n1 = n(), c1 = c(), l1 = l(), n2 = n(), c2 = c(), l2 = l(), n3 = n(), c3 = c();
      const cond = leaf(`${n1}ctrl[${c1}] ${l1} ${n2}ctrl[${c2}] ${l2} ${n3}ctrl[${c3}]`);
      const a = partsel(maxVar, depth + 1);
      return { k: 'tern', c: cond, a, b: partsel(maxVar, depth + 1), sp: true };
    }
  }
}

// ---------------------------------------------------------------- modules
// { name, kind, ports: [names], decls: [lines], params: [{ decl, e }], assigns: [{ lhs, e, w }], tail: [lines] }
export const FAMILIES = ['expression', 'wideexpr', 'partsel', 'binary', 'unary', 'ternary', 'concat', 'repeat'];
const COMBOS = {
  binary: ARG_TYPES.length ** 3 * BINARY_OPS.length,
  unary: ARG_TYPES.length ** 2 * UNARY_OPS.length,
  ternary: SMALL_ARG_TYPES.length * ARG_TYPES.length ** 3,
  concat: SMALL_ARG_TYPES.length ** 2 * ARG_TYPES.length,
  repeat: 4 * SMALL_ARG_TYPES.length * ARG_TYPES.length,
};
const pad = (n, k) => String(n).padStart(k, '0');

export function generate(kind, index) {
  if (kind === 'expression') {
    reseed(SEED_BASE.expression + index);
    const m = { name: `expression_${pad(index, 5)}`, kind, decls: [], params: [], assigns: [], tail: [] };
    const ins = [];
    for (const v of ['a', 'b']) for (let j = 0; j < 6; j++) ins.push(`${v}${j}`);
    m.ports = [...ins, 'y'];
    for (const v of ['a', 'b']) { for (let j = 0; j < 6; j++) m.decls.push(`  ${decl('input', ARG_TYPES[j], `${v}${j}`)};`); m.decls.push(''); }
    for (let j = 0; j < 18; j++) m.decls.push(`  ${decl('wire', ARG_TYPES[j % 6], `y${j}`)};`);
    m.decls.push('');
    m.decls.push('  output [89:0] y;');
    m.decls.push(`  assign y = {${Array.from({ length: 18 }, (_, j) => `y${j}`).join(',')}};`);
    m.decls.push('');
    for (let j = 0; j < 18; j++) {
      const d = decl('localparam', ARG_TYPES[j % 6], `p${j}`);
      m.params.push({ decl: d, e: expression(1 + (xs() % 15), 0, false, false, true) });
    }
    for (let j = 0; j < 18; j++) {
      const budget = 1 + (xs() % 20);
      m.assigns.push({ lhs: `y${j}`, w: ARG_TYPES[j % 6][2], e: expression(budget, 0, false, false, false) });
    }
    return m;
  }
  if (kind === 'wideexpr') {
    reseed(SEED_BASE.wideexpr + index);
    const m = { name: `wideexpr_${pad(index, 5)}`, kind, decls: [], params: [], assigns: [], tail: [] };
    const us = [];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 8; j++) us.push(`${'us'[i]}${j}`);
    m.ports = ['ctrl', ...us, 'y'];
    m.decls.push('  input [7:0] ctrl;');
    for (let i = 0; i < 2; i++) for (let j = 0; j < 8; j++) m.decls.push(`  input ${i ? 'signed ' : ''}[${j}:0] ${'us'[i]}${j};`);
    m.decls.push('  output [127:0] y;');
    for (let j = 0; j < 8; j++) m.decls.push(`  wire [15:0] y${j};`);
    m.decls.push(`  assign y = {${Array.from({ length: 8 }, (_, j) => `y${j}`).join(',')}};`);
    for (let j = 0; j < 8; j++) {
      const sg = xs() % 2 === 0;
      const depth = 5 + (xs() % 5);
      m.assigns.push({ lhs: `y${j}`, w: 16, e: wideexpr(sg, depth) });
    }
    return m;
  }
  if (kind === 'partsel') {
    reseed(SEED_BASE.partsel + index);
    const m = { name: `partsel_${pad(index, 5)}`, kind, decls: [], params: [], assigns: [], tail: [] };
    m.ports = ['ctrl', 's0', 's1', 's2', 's3', 'x0', 'x1', 'x2', 'x3', 'y'];
    m.decls.push('  input [3:0] ctrl;');
    for (let i = 0; i < 4; i++) m.decls.push(`  input [2:0] s${i};`);
    for (let i = 0; i < 4; i++) m.decls.push(`  input ${xs() % 2 ? 'signed ' : ''}[31:0] x${i};`);
    const range = () => {
      if (xs() % 2) { const sg = xs() % 2 ? 'signed ' : ''; const a = xs() % 8; return `${sg}[${a}:${31 - (xs() % 8)}]`; }
      const sg = xs() % 2 ? 'signed ' : ''; const a = 31 - (xs() % 8); return `${sg}[${a}:${xs() % 8}]`;
    };
    for (let i = 4; i < 16; i++) m.decls.push(`  wire ${range()} x${i};`);
    m.decls.push('  output [127:0] y;');
    for (let i = 0; i < 4; i++) m.decls.push(`  wire ${xs() % 2 ? 'signed ' : ''}[31:0] y${i};`);
    m.decls.push(`  assign y = {${[0, 1, 2, 3].map(i => `y${i}`).join(',')}};`);
    for (let i = 0; i < 4; i++) { const r = range(); m.decls.push(`  localparam ${r} p${i} = ${xs() % 1000000000};`); }
    for (let i = 4; i < 20; i++) {
      const lhs = i < 16 ? `x${i}` : `y${i - 16}`;
      m.assigns.push({ lhs, w: 32, e: partsel(i < 16 ? i : 16, 0), inner: i < 16 });
    }
    return m;
  }
  // the operator families: index -> one combination of the operand types and the operator
  const n = COMBOS[kind];
  if (!n) throw new Error(`vloghammer-gen: unknown family '${kind}'`);
  let k = index % n;
  const digit = base => { const d = k % base; k = Math.floor(k / base); return d; };
  const m = { kind, decls: [], params: [], assigns: [], tail: [] };
  if (kind === 'binary') {
    const oi = digit(24), yi = digit(6), bi = digit(6), ai = digit(6);
    m.name = `binary_ops_${pad(ai, 2)}${pad(bi, 2)}${pad(yi, 2)}${pad(oi, 2)}`;
    m.ports = ['a', 'b', 'y'];
    m.decls.push(`  ${decl('input', ARG_TYPES[ai], 'a')};`, `  ${decl('input', ARG_TYPES[bi], 'b')};`, `  ${decl('output', ARG_TYPES[yi], 'y')};`);
    const e = BINARY_OPS[oi] === '**' ? { k: 'pow', base: `${ARG_TYPES[ai][2]}${ARG_TYPES[ai][0] ? "'sd2" : "'d2"}`, b: leaf('b') } : { k: 'bin', o: BINARY_OPS[oi], a: leaf('a'), b: leaf('b'), sp: true };
    m.assigns.push({ lhs: 'y', w: ARG_TYPES[yi][2], e, bare: true });
  } else if (kind === 'unary') {
    const oi = digit(10), yi = digit(6), ai = digit(6);
    m.name = `unary_ops_${pad(ai, 2)}${pad(yi, 2)}${pad(oi, 2)}`;
    m.ports = ['a', 'y'];
    m.decls.push(`  ${decl('input', ARG_TYPES[ai], 'a')};`, `  ${decl('output', ARG_TYPES[yi], 'y')};`);
    m.assigns.push({ lhs: 'y', w: ARG_TYPES[yi][2], e: { k: 'un', o: `${UNARY_OPS[oi]} `, a: leaf('a') }, bare: true });
  } else if (kind === 'ternary') {
    const yi = digit(6), ci = digit(6), bi = digit(6), ai = digit(6);
    m.name = `ternary_ops_${pad(ai, 2)}${pad(bi, 2)}${pad(ci, 2)}${pad(yi, 2)}`;
    m.ports = ['a', 'b', 'c', 'y'];
    m.decls.push(`  ${decl('input', SMALL_ARG_TYPES[ai], 'a')};`, `  ${decl('input', ARG_TYPES[bi], 'b')};`, `  ${decl('input', ARG_TYPES[ci], 'c')};`, `  ${decl('output', ARG_TYPES[yi], 'y')};`);
    m.assigns.push({ lhs: 'y', w: ARG_TYPES[yi][2], e: { k: 'tern', c: leaf('a'), a: leaf('b'), b: leaf('c'), sp: true }, bare: true });
  } else if (kind === 'concat') {
    const yi = digit(6), bi = digit(6), ai = digit(6);
    m.name = `concat_ops_${pad(ai, 2)}${pad(bi, 2)}${pad(yi, 2)}`;
    m.ports = ['a', 'b', 'y'];
    m.decls.push(`  ${decl('input', SMALL_ARG_TYPES[ai], 'a')};`, `  ${decl('input', SMALL_ARG_TYPES[bi], 'b')};`, `  ${decl('output', ARG_TYPES[yi], 'y')};`);
    m.assigns.push({ lhs: 'y', w: ARG_TYPES[yi][2], e: { k: 'cat', xs: [leaf('a'), leaf('b')], sp: true } });
  } else {
    const yi = digit(6), bi = digit(6), a = digit(4);
    m.name = `repeat_ops_${pad(a, 2)}${pad(bi, 2)}${pad(yi, 2)}`;
    m.ports = ['b', 'y'];
    m.decls.push(`  ${decl('input', SMALL_ARG_TYPES[bi], 'b')};`, `  ${decl('output', ARG_TYPES[yi], 'y')};`);
    // a replication count of 0 is only legal inside a concatenation with other operands
    // (IEEE 1364-2005 5.1.14); kept as generate.cc writes it
    m.assigns.push({ lhs: 'y', w: ARG_TYPES[yi][2], e: { k: 'rep', n: a, a: leaf('b') } });
  }
  return m;
}

/** The module's Verilog text. */
export function moduleText(m) {
  const lines = [`module ${m.name}(${m.ports.join(', ')});`, ...m.decls];
  for (const p of m.params) lines.push(`  ${p.decl} = ${exprText(p.e)};`);
  if (m.params.length) lines.push('');
  for (const a of m.assigns) {
    // the operator families write the operator without parentheses: assign y = a + b;
    const t = exprText(a.e);
    lines.push(`  assign ${a.lhs} = ${a.bare && a.e.k !== 'leaf' ? t.slice(1, -1) : t};`);
  }
  lines.push(...m.tail, 'endmodule', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- reduction
const children = n => (n.k === 'un' || n.k === 'wun' || n.k === 'rep' || n.k === 'call' ? [n.a] : n.k === 'bin' || n.k === 'wbin' ? [n.a, n.b] : n.k === 'pow' ? [n.b] : n.k === 'tern' ? [n.c, n.a, n.b] : n.k === 'cat' ? n.xs : []);
const size = n => 1 + children(n).reduce((s, c) => s + size(c), 0);
export const exprSize = size;

/** Every tree obtained from n by replacing one node with one of its children or with a leaf. */
function* shrink(n, leaves) {
  for (const c of children(n)) yield c;
  if (n.k !== 'leaf') for (const l of leaves) yield l;
  const kids = children(n);
  for (let i = 0; i < kids.length; i++) {
    for (const r of shrink(kids[i], leaves)) {
      const m = { ...n };
      if (n.k === 'cat') m.xs = n.xs.map((x, j) => (j === i ? r : x));
      else if (n.k === 'tern') [m.c, m.a, m.b] = [n.c, n.a, n.b].map((x, j) => (j === i ? r : x));
      else if (n.k === 'bin' || n.k === 'wbin') [m.a, m.b] = [n.a, n.b].map((x, j) => (j === i ? r : x));
      else if (n.k === 'pow') m.b = r;
      else m.a = r;
      yield m;
    }
    // a concatenation can also lose an operand
    if (n.k === 'cat' && n.xs.length > 1) yield { ...n, xs: n.xs.filter((_, j) => j !== i) };
  }
}

/**
 * Smaller variants of a module, the most promising first: one output assignment kept (the others
 * set to 0), then one expression node replaced by a child or by a leaf, then local parameters
 * reduced to constants.
 */
export function* reductions(m) {
  const zero = { k: 'leaf', s: "1'b0" };
  const live = m.assigns.filter(a => !a.inner && !(a.e.k === 'leaf' && a.e.s === "1'b0"));
  if (live.length > 1) for (const keep of live) yield { ...m, assigns: m.assigns.map(a => (a.inner || a === keep ? a : { ...a, e: zero })) };
  const leaves = [zero, { k: 'leaf', s: "1'b1" }];
  for (let i = 0; i < m.assigns.length; i++) {
    for (const e of shrink(m.assigns[i].e, leaves)) yield { ...m, assigns: m.assigns.map((a, j) => (j === i ? { ...a, e } : a)) };
  }
  for (let i = 0; i < m.params.length; i++) {
    for (const e of shrink(m.params[i].e, [{ k: 'leaf', s: '0' }])) yield { ...m, params: m.params.map((p, j) => (j === i ? { ...p, e } : p)) };
  }
}

/** Size of a module (for reporting a reduction). */
export const moduleSize = m => m.assigns.reduce((s, a) => s + size(a.e), 0) + m.params.reduce((s, p) => s + size(p.e), 0);
