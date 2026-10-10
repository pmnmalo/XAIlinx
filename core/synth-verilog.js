// Silinx - synthesis front end: an elaborated design (core/elaborate.js) written as one flat,
// synthesizable SystemVerilog module, for Yosys (read_verilog -sv; synth_xilinx).
//
// The elaborator has already resolved everything VHDL- or Verilog-specific: generics and
// parameters, generate blocks, types and widths, overloaded operators, the hierarchy (every signal
// of the design has a unique path). What is left is a set of processes over sized values, and each
// one becomes an always block that computes exactly what Silinx's simulator computes:
//   - every vector is declared [w-1:0] (bit 0 = the value's least significant bit), and VHDL
//     indices are turned into bit positions as the simulator does (interp.js bitpos);
//   - every expression is written at the width and with the sign extension the simulator uses
//     (size casts W'(…) and $signed), so no Verilog width rule can change a result;
//   - clocked processes (rising_edge / falling_edge, clk'event, Verilog @(posedge …)), with
//     asynchronous resets before the clock, become edge-triggered always blocks; the others are
//     combinational (always @*); VHDL signal assignments are non-blocking, variables blocking;
//   - integer signals get the width of their range; functions become automatic functions;
//   - initial blocks (and VHDL processes that end in a bare `wait;`) are run once, by the
//     simulator's interpreter, and what they leave in the signals becomes their initial values;
//   - the Xilinx primitives instantiated by name (RAMB16_*, BUFG, DCM_SP, MULT18X18SIO, SRL16E…)
//     stay instances of the primitive, with their generics and ports: Silinx's simulation models
//     of them (core/unisim.js) are not translated.
// What cannot be synthesized (waits with a time, file I/O, reals…) is reported, not guessed.
//
//   const { text, top, warnings, primitives } = toVerilog(design)   // design = elaborate(lib, top)
//   (primitives: the names of the Xilinx primitives the text instantiates; to simulate the text,
//   compile it with core/unisim.js's UNISIM_SOURCE)
import * as V from './values.js';
import { bitpos, psliceLo, exec, applyWrite, SimError } from './interp.js';

export class SynthError extends Error {
  constructor(msg, loc, file) { super(msg); this.loc = loc; this.file = file; }
}

// ------------------------------------------------------------------ names, widths, constants
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const KEYWORDS = new Set('always and assign begin buf case casex casez cmos deassign default defparam disable edge else end endcase endfunction endmodule endprimitive endspecify endtable endtask event for force forever fork function highz0 highz1 if ifnone initial inout input integer join large macromodule medium module nand negedge nmos nor not notif0 notif1 or output parameter pmos posedge primitive pull0 pull1 pulldown pullup rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 scalared small specify specparam strong0 strong1 supply0 supply1 table task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg vectored wait wand weak0 weak1 while wire wor xnor xor logic bit byte int shortint longint unsigned signed return break continue type typedef struct enum always_comb always_ff always_latch final unique priority do foreach'.split(' '));
const esc = n => (IDENT.test(n) && !KEYWORDS.has(n) ? n : `\\${n} `);

/** The width a signal or local gets: integers the width of their range, the rest their own. */
export function synthWidth(t) {
  if (t.kind === 'int' && t.rlo !== undefined && t.rhi !== undefined) {
    const lo = BigInt(t.rlo), hi = BigInt(t.rhi);
    if (lo >= 0n) return Math.max(1, hi.toString(2).length);
    const need = x => (x < 0n ? (-x - 1n).toString(2).length + 1 : x.toString(2).length + 1);
    return Math.max(need(lo), need(hi));
  }
  return t.w;
}
const signedInt = t => t.kind === 'int' && (t.rlo === undefined || t.rlo < 0);
// is a declaration signed: integers by their range, the rest by their type
const sgn = t => (t?.kind === 'int' ? signedInt(t) : !!t?.s);

/** A Verilog literal of a value (x / z bits kept). */
export function lit(v, w = v.w) {
  if (w <= 0) return "1'b0";
  const m = (1n << BigInt(w)) - 1n;
  const vv = BigInt.asUintN(w, v.v ?? 0n) & m, xx = BigInt.asUintN(w, v.x ?? 0n) & m;
  if (!xx) return `${w}'h${vv.toString(16)}`;
  let s = '';
  for (let i = w - 1; i >= 0; i--) {
    const b = 1n << BigInt(i);
    s += xx & b ? (vv & b ? 'z' : 'x') : (vv & b ? '1' : '0');
  }
  return `${w}'b${s}`;
}

// ------------------------------------------------------------------ the translator
export function toVerilog(design, { name } = {}) {
  const top = design.top;
  const warnings = [];
  const prefix = `${top.path}.`;
  const sigName = new Map();     // signal -> Verilog name
  const used = new Set();
  const uniq = n => { let k = n, i = 1; while (used.has(k.toLowerCase())) k = `${n}_${i++}`; used.add(k.toLowerCase()); return k; };
  const portOf = new Map(top.ports.map(p => [p.sig, p]));

  const decls = [], blocks = [], funcs = [];
  const funcName = new Map();    // fn -> Verilog function name
  const where = n => (n?.loc ? ` (line ${n.loc.line})` : '');
  const fail = (msg, n, file) => { throw new SynthError(msg + where(n), n?.loc, file); };

  // ---------------- primitives instantiated by name
  // An instance of a module of Silinx's own UNISIM library (core/unisim.js, file <silinx>/…) is a
  // Xilinx primitive: Yosys knows it as a cell, so it stays an instance, with the generics the
  // design gave it. Its simulation model (signals, processes, sub-instances) is left out; only
  // its port signals remain, with the processes that drive its inputs from their actuals.
  const prims = [], skipSig = new Set(), skipProc = new Set();
  const primDriven = new Set();  // signals driven by a primitive's output: no initial value of their own
  (function walk(inst) {
    for (const c of inst.children || []) {
      if (!String(c.file || '').startsWith('<silinx>/')) { walk(c); continue; }
      if (c.file !== '<silinx>/unisim.vhd') fail(`${c.module} (${c.path}): the primitives of a post-implementation netlist (${c.file}) cannot be synthesized`, c, c.file);
      const portSigs = new Set(c.ports.map(pt => pt.sig));
      const inside = [];
      (function all(i) { inside.push(i); (i.children || []).forEach(all); })(c);
      const keep = [];
      for (const i of inside) {
        for (const sg of i.signals) if (!portSigs.has(sg)) skipSig.add(sg);
        for (const p of i.procs) {
          if (i === c && p.kind === 'glue' && [...(p.writes || [])].every(sg => portSigs.has(sg))) keep.push(p);
          else skipProc.add(p);
        }
      }
      for (const pt of c.ports) if (pt.dir !== 'in') primDriven.add(pt.sig);
      prims.push({ inst: c, driven: new Set(keep.flatMap(p => [...(p.writes || [])])) });
    }
  })(top);
  for (const p of top.ports) sigName.set(p.sig, esc(uniq(p.name)));
  for (const s of design.signals) if (!sigName.has(s) && !skipSig.has(s)) sigName.set(s, esc(uniq(s.path.startsWith(prefix) ? s.path.slice(prefix.length) : s.path)));

  // ---------------- values: every expression as an unsigned, exactly-sized Verilog expression
  // fit(x, wFrom, sFrom, wTo): the value extended (by its own sign) or truncated to wTo bits
  const fit = (x, wf, sf, wt) => (wf === wt ? x : `${wt}'(${sf ? `$signed(${x})` : x})`);
  const S = x => `$signed(${x})`;

  // the widths the translator gives a node: integer signals / locals narrower than 32
  const wOf = t => (t ? synthWidth(t) : 1);

  function ctxFor(proc) {
    return { proc, locals: new Map(), fn: null, flags: [] };
  }
  // the variables of a function are its own (v<slot>); those of processes and inlined procedures
  // become module-level registers named after their process. No dot in these names: Yosys takes a
  // name with a dot for a hierarchical reference in places (as a for loop variable it unrolled the
  // loop wrongly: every iteration wrote element 0 of the memory).
  const localName = (ctx, i, t) => {
    if (!ctx.locals.has(i)) ctx.locals.set(i, { name: ctx.fn && !ctx.parent ? `v${i}` : esc(uniq(`${ctx.base}_v${i}`)), t });
    return ctx.locals.get(i).name;
  };

  // e(n) -> { x: expression string, w, s } (x is w bits; s = the value's signedness)
  function e(n, ctx) {
    const t = n.t || {};
    switch (n.k) {
      case 'c': {
        if (Array.isArray(n.val)) return romRef(n, ctx);
        if (n.val.str !== undefined) fail('a string value cannot be synthesized', n);
        if (n.val.real !== undefined || t.kind === 'real') fail('a real value cannot be synthesized', n);
        const w = n.val.w || 1;
        return { x: lit(n.val, w), w, s: !!n.val.s };
      }
      case 'sig': {
        const s = n.sig;
        if (Array.isArray(s.val) || s.t.kind === 'array') fail(`array ${s.name} used as a whole value`, n);
        const w = wOf(s.t), x = sigName.get(s);
        // integer signals narrower than their 32-bit simulation width: extended back to 32 bits
        if (s.t.kind === 'int' && w !== s.t.w) return { x: fit(x, w, signedInt(s.t), s.t.w), w: s.t.w, s: true };
        return { x, w, s: !!s.t.s };
      }
      case 'loc': {
        if (ctx.subst?.has(n.i)) { const sb = ctx.subst.get(n.i); if (sb.rv) return e(sb.rv, sb.ctx); }
        const w = wOf(t), x = localName(ctx, n.i, t);
        if (t.kind === 'int' && w !== t.w) return { x: fit(x, w, signedInt(t), t.w), w: t.w, s: true };
        return { x, w, s: !!t.s };
      }
      case 'bit': {
        const b = e(n.base, ctx);
        if (n.index.k === 'c') {
          const p = bitpos(n.base.t, V.toNum(n.index.val));
          return { x: p === 0 && b.w === 1 ? b.x : `1'(${b.x} >> ${p})`, w: 1, s: false };
        }
        return { x: `1'(${b.x} >> ${posExpr(n.base.t, n.index, ctx)})`, w: 1, s: false };
      }
      case 'slice': {
        const b = e(n.base, ctx);
        return { x: n.lo === 0 && b.w === t.w ? b.x : `${t.w}'(${b.x} >> ${n.lo})`, w: t.w, s: !!t.s };
      }
      case 'dslice': {
        const b = e(n.base, ctx);
        if (n.left.k === 'c' && n.right.k === 'c') {
          const p1 = bitpos(n.base.t, V.toNum(n.left.val)), p2 = bitpos(n.base.t, V.toNum(n.right.val));
          return { x: `${t.w}'(${b.x} >> ${Math.min(p1, p2)})`, w: t.w, s: !!t.s };
        }
        const lo = n.base.t.desc ? posExpr(n.base.t, n.right, ctx) : posExpr(n.base.t, n.left, ctx);
        return { x: `${t.w}'(${b.x} >> ${lo})`, w: t.w, s: !!t.s };
      }
      case 'pslice': {
        const b = e(n.base, ctx);
        if (n.start.k === 'c') return { x: `${t.w}'(${b.x} >> ${psliceLo(n.base.t, V.toNum(n.start.val), t.w, n.dir)})`, w: t.w, s: !!t.s };
        const st = posExpr(n.base.t, n.start, ctx);
        const up = (n.dir === '+') === !!n.base.t.desc;   // the start is the low bit
        return { x: `${t.w}'(${b.x} >> ${up ? st : `(${st} - ${t.w - 1})`})`, w: t.w, s: !!t.s };
      }
      case 'elem': {
        const base = n.base;
        if (base.k === 'c' && Array.isArray(base.val)) return romRef(n, ctx);
        if (base.k !== 'sig' && base.k !== 'loc') fail('indexing an array expression', n);
        const arrName = base.k === 'sig' ? sigName.get(base.sig) : localName(ctx, base.i, base.t);
        const lo = base.t.lo ?? 0;
        const idx = e(n.index, ctx);
        const ix = idx.s ? S(idx.x) : idx.x;
        const w = wOf(t);
        const x = `${arrName}[${lo ? `${ix} - ${lo}` : ix}]`;
        if (t.kind === 'int' && w !== t.w) return { x: fit(x, w, signedInt(t), t.w), w: t.w, s: true };
        return { x, w, s: !!t.s };
      }
      case 'un': return un(n, ctx);
      case 'bin': return bin(n, ctx);
      case 'cond': {
        // each branch cast to the width, even when it has it already: Yosys can size an operation on
        // a size cast at the width of the cast's operand (4'(d) ^ 4'h3 with an 8-bit d: 8 bits),
        // which made `oe ? (4'(d) ^ …) : 4'bzzzz` an 8-bit multiplexer with 0000zzzz on the other
        // side, no longer a tri-state buffer
        const w = n.ew || t.w, c = truth(n.c, ctx), a = e(n.a, ctx), b = e(n.b, ctx);
        const br = v => { const x = fit(v.x, v.w, v.s, w); return /^\d+'[bh][0-9a-fxz]+$/.test(x) ? x : `${w}'(${x})`; };
        return { x: `(${c} ? ${br(a)} : ${br(b)})`, w, s: !!t.s };
      }
      case 'cat': {
        const parts = n.parts.map(p => { const v = e(p, ctx); return fit(v.x, v.w, v.s, p.t.w); });
        return { x: parts.length === 1 ? parts[0] : `{${parts.join(', ')}}`, w: t.w, s: !!t.s };
      }
      case 'repl': {
        if (n.count.k !== 'c') fail('a replication count that is not constant', n);
        const a = e(n.a, ctx);
        return { x: `{${V.toNum(n.count.val)}{${fit(a.x, a.w, a.s, n.a.t.w)}}}`, w: t.w, s: !!t.s };
      }
      case 'conv': {
        if (t.kind === 'real' || n.rtoi) fail('a conversion to or from REAL cannot be synthesized', n);
        const a = e(n.a, ctx);
        if (n.sres && t.w < a.w) {   // numeric_std resize(signed): sign bit + low bits
          const low = t.w > 1 ? `${t.w - 1}'(${a.x})` : null;
          return { x: low ? `{1'(${a.x} >> ${a.w - 1}), ${low}}` : `1'(${a.x} >> ${a.w - 1})`, w: t.w, s: true };
        }
        return { x: fit(a.x, a.w, n.ext ?? a.s, t.w), w: t.w, s: !!t.s };
      }
      case 'call': return call(n, ctx);
      case 'edge': case 'event': fail('a clock edge outside the clock condition of a process', n); break;
      case 'sys': case 'now': case 'str': case 'image': case 'strcat': case 'chr': case 'strlen': case 'sigattr':
        fail(`'${n.name || n.k}' cannot be synthesized`, n); break;
      default: fail(`expression '${n.k}' not supported by synthesis`, n);
    }
    return null;
  }

  // a VHDL / Verilog index as a bit position (the simulator's bitpos)
  function posExpr(t, idx, ctx) {
    const i = e(idx, ctx);
    const v = i.s ? S(i.x) : i.x;
    return t.desc ? (t.right ? `(${v} - ${t.right})` : v) : `(${t.right} - ${v})`;
  }

  const truth = (n, ctx) => { const v = e(n, ctx); return v.w === 1 ? v.x : `(${v.x} != 0)`; };

  function un(n, ctx) {
    const t = n.t, w = n.ew || t.w, a = e(n.a, ctx);
    if (n.fp) fail('real arithmetic cannot be synthesized', n);
    switch (n.o) {
      // (the operand of a unary operator is parenthesized: Yosys reads ~8'(x) as (~8)'(x))
      case '~': return { x: `${w}'(~(${fit(a.x, a.w, a.s, w)}))`, w, s: !!t.s };
      case '-': return { x: `${w}'(-(${fit(a.x, a.w, a.s, w)}))`, w, s: !!t.s };
      case '!': return { x: `!(${a.w === 1 ? a.x : `${a.x} != 0`})`, w: 1, s: false };
      case 'abs': { const v = fit(a.x, a.w, a.s, w); return { x: `${w}'(${S(v)} < 0 ? -(${S(v)}) : ${S(v)})`, w, s: !!t.s }; }
      case '&': case '|': case '^': case '~&': case '~|': case '~^': case '^~': return { x: `(${n.o}(${a.x}))`, w: 1, s: false };
      default: fail(`operator ${n.o} not supported by synthesis`, n);
    }
    return null;
  }

  function bin(n, ctx) {
    const o = n.o, t = n.t;
    if (n.fp) fail('real arithmetic cannot be synthesized', n);
    if (o === '&&' || o === '||') return { x: `(${truth(n.a, ctx)} ${o} ${truth(n.b, ctx)})`, w: 1, s: false };
    const a = e(n.a, ctx), b = e(n.b, ctx);
    const w = n.ew || t.w, s = !!t.s;
    if (['==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(o)) {
      const os = !!(n.a.t?.s && n.b.t?.s);
      const cw = Math.max(n.cw || 0, a.w, b.w);
      const A = fit(a.x, a.w, a.s, cw), B = fit(b.x, b.w, b.s, cw);
      const op = o === '===' ? '==' : o === '!==' ? '!=' : o;
      if (n.match) fail('std_match / matching comparison not supported by synthesis', n);
      return { x: os ? `(${S(A)} ${op} ${S(B)})` : `(${A} ${op} ${B})`, w: 1, s: false };
    }
    const A = fit(a.x, a.w, a.s, w);
    if (['<<', '<<<', '>>', '>>>', 'rol', 'ror'].includes(o)) {
      const cnt = b.s ? S(b.x) : b.x;
      if (n.vs && n.fill) fail('sla / sra on bit_vector not supported by synthesis', n);
      const constCnt = n.b.k === 'c' ? V.toNum(n.b.val) : null;
      if (n.vs && constCnt !== null && constCnt < 0) fail('a negative shift count', n);
      switch (o) {
        case '<<': case '<<<': return { x: `${w}'(${A} << ${cnt})`, w, s };
        case '>>': return { x: `${w}'(${A} >> ${cnt})`, w, s };
        case '>>>': return { x: `${w}'(${S(A)} >>> ${cnt})`, w, s };
        case 'rol': case 'ror': {
          if (constCnt === null) fail('a rotation by a non-constant amount', n);
          const k = ((constCnt % w) + w) % w;
          if (!k) return { x: A, w, s };
          const l = o === 'rol' ? k : w - k;
          return { x: `${w}'((${A} << ${l}) | (${A} >> ${w - l}))`, w, s };
        }
      }
    }
    const B = fit(b.x, b.w, b.s, w);
    const SA = s ? S(A) : A, SB = s ? S(B) : B;
    switch (o) {
      case '+': case '-': case '*': return { x: `${w}'(${SA} ${o} ${SB})`, w, s };
      case '/': return { x: `${w}'(${SA} / ${SB})`, w, s };
      case '%': case 'rem': return { x: `${w}'(${SA} % ${SB})`, w, s };
      case 'mod': {
        if (!s) return { x: `${w}'(${A} % ${B})`, w, s };
        return { x: `${w}'((${SA} % ${SB} != 0 && ((${SA} % ${SB} < 0) != (${SB} < 0))) ? ${SA} % ${SB} + ${SB} : ${SA} % ${SB})`, w, s };
      }
      case '**': {
        if (n.a.k === 'c' && n.b.k === 'c') return { x: lit(V.pow(V.withSign(n.a.val, s), V.withSign(n.b.val, n.b.t.s), w, s), w), w, s };
        if (n.a.k === 'c' && V.toNum(n.a.val) === 2) return { x: `${w}'(${w}'d1 << ${b.x})`, w, s };
        fail('** with a non-constant base other than 2', n);
        break;
      }
      case '&': return { x: `(${A} & ${B})`, w, s };
      case '|': return { x: `(${A} | ${B})`, w, s };
      case '^': return { x: `(${A} ^ ${B})`, w, s };
      case '~^': return { x: `${w}'(~((${A} ^ ${B})))`, w, s };
      case 'nand': return { x: `${w}'(~(${A} & ${B}))`, w, s };
      case 'nor': return { x: `${w}'(~(${A} | ${B}))`, w, s };
    }
    fail(`operator ${o} not supported by synthesis`, n);
    return null;
  }

  // constant arrays (VHDL ROMs): a function with a case over the index
  const roms = new Map();
  function romRef(n, ctx) {
    const arrNode = n.k === 'elem' ? n.base : n;
    const vals = arrNode.val;
    if (n.k !== 'elem') fail('a constant array used as a whole value', n);
    if (vals.some(v => Array.isArray(v) || v.v === undefined)) fail('a constant array of arrays or records', n);
    const ew = n.t.w;
    const key = `${ew}:${arrNode.t.lo ?? 0}:${vals.map(v => lit(v, ew)).join(',')}`;
    if (!roms.has(key)) {
      const fname = `rom${roms.size}`;
      const lo = arrNode.t.lo ?? 0;
      const iw = 32;
      funcs.push(`  function automatic [${ew - 1}:0] ${fname}(input signed [${iw - 1}:0] i);\n    case (i)\n${vals.map((v, k) => `      ${k + lo}: ${fname} = ${lit(v, ew)};`).join('\n')}\n      default: ${fname} = ${lit(V.allX(ew), ew)};\n    endcase\n  endfunction`);
      roms.set(key, fname);
    }
    const i = e(n.index, ctx);
    return { x: `${roms.get(key)}(${fit(i.x, i.w, i.s, 32)})`, w: ew, s: !!n.t.s };
  }

  // user functions: automatic SystemVerilog functions with the same body
  function call(n, ctx) {
    const f = n.fn;
    if (!f || !f.body) fail(`function ${n.name || ''} cannot be synthesized (no body)`, n);
    if (!funcName.has(f)) {
      const fname = esc(uniq(`fn_${(f.name || 'f').replace(/[^\w]/g, '_')}`));
      funcName.set(f, fname);
      const fctx = { fn: f, locals: new Map(), base: fname, flags: [] };
      const rw = wOf(f.retT);
      const params = f.params.map(p => { fctx.locals.set(p.i, { name: `v${p.i}`, t: p.t, param: true }); return `input ${sgn(p.t) ? 'signed ' : ''}[${wOf(p.t) - 1}:0] v${p.i}`; });
      // Verilog functions return through their own name (a slot of the frame)
      if (f.retSlot != null) fctx.locals.set(f.retSlot, { name: fname, t: f.retT, param: true });
      const body = stmt(f.body, fctx, '    ', 'fn');
      // the variables of the procedures inlined in the function are the function's own too
      for (const l of fctx.extraLocals || []) fctx.locals.set(Symbol('inlined'), l);
      // the local variables start at their declared values on every call
      const init0 = f.frameInit ? f.frameInit() : [];
      const inits = [...fctx.locals.entries()].filter(([i, l]) => !l.param && init0[i] && !Array.isArray(init0[i]) && init0[i].v !== undefined && !init0[i].x)
        .map(([i, l]) => `    ${l.name} = ${lit(V.resize(init0[i], wOf(l.t)), wOf(l.t))};\n`).join('');
      const loc = [...fctx.locals.values()].filter(l => !l.param).map(l => `    reg ${sgn(l.t) ? 'signed ' : ''}[${wOf(l.t) - 1}:0] ${l.name};`);
      funcs.push(`  function automatic ${sgn(f.retT) ? 'signed ' : ''}[${rw - 1}:0] ${fname}(${params.join(', ')});\n${['    reg __ret;', ...loc, ...fctx.flags.map(x => `    reg ${x};`)].join('\n')}\n  begin\n    __ret = 0;\n    ${fname} = 0;\n${inits}${body}  end\n  endfunction`);
    }
    const args = n.args.map((a, k) => { const v = e(a, ctx); const p = f.params[k]; return fit(v.x, v.w, v.s, wOf(p.t)); });
    const rw = wOf(f.retT);
    const x = `${funcName.get(f)}(${args.join(', ')})`;
    if (f.retT?.kind === 'int' && rw !== f.retT.w) return { x: fit(x, rw, signedInt(f.retT), f.retT.w), w: f.retT.w, s: true };
    return { x, w: rw, s: !!f.retT?.s };
  }

  // ---------------- statements
  function lvalue(L, ctx) {
    switch (L.k) {
      case 'sig': return { x: sigName.get(L.sig), w: wOf(L.sig.t) };
      case 'loc': {
        if (ctx.subst?.has(L.i)) { const sb = ctx.subst.get(L.i); if (sb.lv) return lvalue(sb.lv, sb.ctx); }
        return { x: localName(ctx, L.i, L.t), w: wOf(L.t) };
      }
      case 'bit': {
        const b = lvalue(L.base, ctx);
        const p = L.index.k === 'c' ? bitpos(L.base.t, V.toNum(L.index.val)) : posExpr(L.base.t, L.index, ctx);
        return { x: `${b.x}[${p}]`, w: 1 };
      }
      case 'slice': { const b = lvalue(L.base, ctx); return { x: `${b.x}[${L.lo + L.t.w - 1}:${L.lo}]`, w: L.t.w }; }
      case 'dslice': {
        const b = lvalue(L.base, ctx);
        if (L.left.k === 'c' && L.right.k === 'c') {
          const p1 = bitpos(L.base.t, V.toNum(L.left.val)), p2 = bitpos(L.base.t, V.toNum(L.right.val));
          return { x: `${b.x}[${Math.max(p1, p2)}:${Math.min(p1, p2)}]`, w: L.t.w };
        }
        const lo = L.base.t.desc ? posExpr(L.base.t, L.right, ctx) : posExpr(L.base.t, L.left, ctx);
        return { x: `${b.x}[${lo} +: ${L.t.w}]`, w: L.t.w };
      }
      case 'pslice': {
        const b = lvalue(L.base, ctx);
        if (L.start.k === 'c') { const lo = psliceLo(L.base.t, V.toNum(L.start.val), L.t.w, L.dir); return { x: `${b.x}[${lo + L.t.w - 1}:${lo}]`, w: L.t.w }; }
        const st = posExpr(L.base.t, L.start, ctx);
        const up = (L.dir === '+') === !!L.base.t.desc;
        return { x: `${b.x}[${up ? st : `${st} - ${L.t.w - 1}`} +: ${L.t.w}]`, w: L.t.w };
      }
      case 'elem': {
        if (L.base.k !== 'sig' && L.base.k !== 'loc') fail('assignment to an element of an array expression', L);
        const name = L.base.k === 'sig' ? sigName.get(L.base.sig) : localName(ctx, L.base.i, L.base.t);
        const lo = L.base.t.lo ?? 0, i = e(L.index, ctx), ix = i.s ? S(i.x) : i.x;
        return { x: `${name}[${lo ? `${ix} - ${lo}` : ix}]`, w: wOf(L.t) };
      }
      case 'cat': {
        const parts = L.parts.map(p => lvalue(p, ctx));
        return { x: `{${parts.map(p => p.x).join(', ')}}`, w: parts.reduce((s, p) => s + p.w, 0) };
      }
      default: fail(`assignment target '${L.k}' not supported by synthesis`, L);
    }
    return null;
  }

  let flagN = 0;
  // mode: 'proc' | 'fn'; returns text. Control flow out of the middle of a block (return, exit,
  // next) becomes a flag that guards the rest of the block (synthesis needs structured code).
  function stmt(s, ctx, ind, mode, loop = null) {
    if (!s) return '';
    switch (s.k) {
      case 'blk': {
        let out = '';
        let guard = null;
        for (const x of s.stmts) {
          const t = stmt(x, ctx, guard ? `${ind}  ` : ind, mode, loop);
          if (!t) continue;
          out += guard ? `${ind}if (!(${guard})) begin\n${t}${ind}end\n` : t;
          if (!guard && mayLeave(x)) guard = leaveFlags(ctx, loop);
        }
        return out;
      }
      case 'asg': {
        if (s.intra) fail('an intra-assignment delay cannot be synthesized', s);
        const L = lvalue(s.target, ctx);
        if (Array.isArray(s.value?.val) || (s.value.k === 'sig' && Array.isArray(s.value.sig.val))) return arrayCopy(s, ctx, ind);
        const v = e(s.value, ctx);
        const val = s.target.k === 'cat' ? fit(v.x, v.w, v.s, L.w) : fitTarget(v, s.target, L.w);
        return `${ind}${L.x} ${s.nb && mode === 'proc' ? '<=' : '='} ${val};\n`;
      }
      case 'if': {
        const c = truth(s.c, ctx);
        const th = stmt(s.then, ctx, `${ind}  `, mode, loop);
        const el = s.else ? stmt(s.else, ctx, `${ind}  `, mode, loop) : '';
        return `${ind}if (${c}) begin\n${th}${ind}end${el ? ` else begin\n${el}${ind}end` : ''}\n`;
      }
      case 'case': {
        const sel = e(s.sel, ctx);
        const hasRange = s.items.some(it => it.choices.some(ch => ch.range));
        const constChoices = s.items.every(it => it.choices.every(ch => ch.range || ch.k === 'c'));
        if (!hasRange && constChoices && (s.variant === 'case' || !s.variant)) {
          let out = `${ind}case (${sel.x})\n`;
          for (const it of s.items) {
            const labels = it.choices.map(ch => { const w = Math.max(sel.w, ch.val.w); return lit(V.resize(ch.val, w), sel.w); });
            out += `${ind}  ${labels.join(', ')}: begin\n${stmt(it.body, ctx, `${ind}    `, mode, loop)}${ind}  end\n`;
          }
          out += `${ind}  default: begin\n${s.def ? stmt(s.def, ctx, `${ind}    `, mode, loop) : ''}${ind}  end\n${ind}endcase\n`;
          return out;
        }
        if (s.variant === 'casez' || s.variant === 'casex') {
          let out = `${ind}${s.variant} (${sel.x})\n`;
          for (const it of s.items) out += `${ind}  ${it.choices.map(ch => { const v = e(ch, ctx); return fit(v.x, v.w, v.s, sel.w); }).join(', ')}: begin\n${stmt(it.body, ctx, `${ind}    `, mode, loop)}${ind}  end\n`;
          out += `${ind}  default: begin\n${s.def ? stmt(s.def, ctx, `${ind}    `, mode, loop) : ''}${ind}  end\n${ind}endcase\n`;
          return out;
        }
        // range choices: an if / else if chain (the first matching choice wins, as in the simulator)
        const sv = s.sel.t.s ? S(sel.x) : sel.x;
        let out = '', first = true;
        for (const it of s.items) {
          const conds = it.choices.map(ch => {
            if (ch.range) {
              const lo = e(ch.range.lo, ctx), hi = e(ch.range.hi, ctx);
              const a = lo.s ? S(lo.x) : lo.x, b = hi.s ? S(hi.x) : hi.x;
              return `((${sv} >= ${a} && ${sv} <= ${b}) || (${sv} >= ${b} && ${sv} <= ${a}))`;
            }
            const v = e(ch, ctx); const w = Math.max(sel.w, v.w);
            return `(${fit(sel.x, sel.w, sel.s, w)} == ${fit(v.x, v.w, v.s, w)})`;
          });
          out += `${ind}${first ? '' : 'else '}if (${conds.join(' || ')}) begin\n${stmt(it.body, ctx, `${ind}  `, mode, loop)}${ind}end\n`;
          first = false;
        }
        if (s.def) out += `${ind}${first ? '' : 'else '}begin\n${stmt(s.def, ctx, `${ind}  `, mode, loop)}${ind}end\n`;
        return out;
      }
      case 'forrange': {
        if (s.from.k !== 'c' || s.to.k !== 'c') fail('a loop whose bounds are not constant', s);
        const a = V.toNum(s.from.val), b = V.toNum(s.to.val);
        const v = localName(ctx, s.var, { kind: 'int', w: 32, s: true });
        const lp = { brk: `__brk${flagN++}`, cont: `__cont${flagN++}` };
        ctx.flags.push(lp.brk, lp.cont);
        const body = stmt(s.body, ctx, `${ind}    `, mode, lp);
        const usesFlags = body.includes(lp.brk) || body.includes(lp.cont);
        return `${ind}${usesFlags ? `${lp.brk} = 0;\n${ind}` : ''}for (${v} = ${a}; ${s.down ? `${v} >= ${b}` : `${v} <= ${b}`}; ${v} = ${v} ${s.down ? '-' : '+'} 1) begin\n${usesFlags ? `${ind}  ${lp.cont} = 0;\n${ind}  if (!${lp.brk}) begin\n${body}${ind}  end\n` : body}${ind}end\n`;
      }
      case 'for': {
        // Verilog for: init / cond / step on a loop variable, unrolled by Yosys
        const init = stmt(s.init, ctx, '', mode).trim().replace(/;$/, '');
        const step = stmt(s.step, ctx, '', mode).trim().replace(/;$/, '');
        return `${ind}for (${init}; ${truth(s.cond, ctx)}; ${step}) begin\n${stmt(s.body, ctx, `${ind}  `, mode, loop)}${ind}end\n`;
      }
      case 'exit': case 'next': {
        if (!loop) fail(`${s.k} outside a loop`, s);
        const flag = s.k === 'exit' ? loop.brk : loop.cont;
        return s.cond ? `${ind}if (${truth(s.cond, ctx)}) ${flag} = 1;\n` : `${ind}${flag} = 1;\n`;
      }
      case 'ret': {
        if (mode !== 'fn') fail('return outside a function', s);
        if (!s.value) return `${ind}__ret = 1;\n`;
        const v = e(s.value, ctx), rw = wOf(ctx.fn.retT);
        return `${ind}${ctx.base} = ${fitTarget(v, { t: ctx.fn.retT }, rw)};\n${ind}__ret = 1;\n`;
      }
      case 'null': case 'report': case 'assert': return '';
      case 'task': return inlineTask(s, ctx, ind, mode, loop);
      case 'sys':
        if (/^\$(display|write|strobe|monitor|info|warning|error|fatal|finish|stop)/.test(s.name || '')) return '';
        fail(`'${s.name || s.k}' cannot be synthesized`, s);
        break;
      case 'delay': case 'wait': case 'event': case 'forever': case 'while': case 'repeat': case 'fork':
        fail(`'${s.k}' cannot be synthesized here (only one clock edge or sensitivity list per process)`, s);
        break;
      default: fail(`statement '${s.k}' not supported by synthesis`, s);
    }
    return '';
  }
  // a procedure call, inlined: in its body each parameter stands for the actual (an expression for
  // in parameters, the actual signal / variable for out and inout ones); its own variables get
  // names unique to this call
  let taskN = 0;
  function inlineTask(s, ctx, ind, mode, loop) {
    const f = s.fn;
    if (!f?.body) fail(`procedure ${s.name || ''} cannot be synthesized (no body)`, s);
    if (mayLeave(f.body)) fail(`procedure ${f.name}: return inside a procedure is not supported by synthesis`, s);
    const sub = { proc: ctx.proc, fn: ctx.fn, locals: new Map(), base: `${ctx.base}_${(f.name || 'proc').replace(/[^\w]/g, '_')}${taskN++}`, flags: ctx.flags, subst: new Map(), parent: ctx };
    let pre = '';
    f.params.forEach((p, k) => {
      const a = s.args[k], out = s.outTargets?.[k];
      if (p.dir === 'in' || (!out && a)) {
        // in parameter: a copy (the procedure may assign its own copy)
        const v = e(a, ctx);
        const name = localName(sub, p.i, p.t);
        pre += `${ind}${name} = ${fit(v.x, v.w, v.s, wOf(p.t))};\n`;
      } else if (out) sub.subst.set(p.i, { lv: out, rv: p.dir === 'inout' ? out : null, ctx });
    });
    const body = stmt(f.body, sub, ind, mode, loop);
    (ctx.extraLocals ||= []).push(...sub.locals.values(), ...(sub.extraLocals || []));
    return pre + body;
  }

  // the value of an assignment at the width of its target (integers: their range width)
  function fitTarget(v, target, w) {
    return fit(v.x, v.w, v.s, w);
  }
  function mayLeave(s) {
    if (!s) return false;
    switch (s.k) {
      case 'ret': case 'exit': case 'next': return true;
      case 'blk': return s.stmts.some(mayLeave);
      case 'if': return mayLeave(s.then) || mayLeave(s.else);
      case 'case': return s.items.some(it => mayLeave(it.body)) || mayLeave(s.def);
      default: return false;
    }
  }
  const leaveFlags = (ctx, loop) => [ctx.fn ? '__ret' : null, loop?.brk, loop?.cont].filter(Boolean).join(' || ');

  // whole-array assignment (array signal <= constant or another array)
  function arrayCopy(s, ctx, ind) {
    const L = s.target;
    if (L.k !== 'sig' && L.k !== 'loc') fail('assignment of an array to a part of an array', s);
    const name = L.k === 'sig' ? sigName.get(L.sig) : localName(ctx, L.i, L.t);
    const et = (L.k === 'sig' ? L.sig.t : L.t).elem || { w: 1 };
    const op = s.nb ? '<=' : '=';
    if (s.value.k === 'c') return s.value.val.map((v, k) => `${ind}${name}[${k}] ${op} ${lit(v, wOf(et))};\n`).join('');
    const src = sigName.get(s.value.sig);
    return s.value.sig.val.map((_, k) => `${ind}${name}[${k}] ${op} ${src}[${k}];\n`).join('');
  }

  // ---------------- processes
  // the clock condition: rising_edge(clk) / falling_edge(clk) / clk'event and clk = '1'
  function edgeOf(c) {
    if (!c) return null;
    if (c.k === 'edge' && c.sig) return { sig: c.sig, pos: c.pos !== false };
    if (c.k === 'bin' && (c.o === '&' || c.o === '&&')) {
      const ev = [c.a, c.b].find(x => x.k === 'event'), lv = [c.a, c.b].find(x => x.k === 'bin' && x.o === '==');
      if (ev && lv) {
        const s = lv.a.k === 'sig' ? lv.a : lv.b.k === 'sig' ? lv.b : null, k = lv.a.k === 'c' ? lv.a : lv.b.k === 'c' ? lv.b : null;
        if (s && k && s.sig === ev.sig) return { sig: s.sig, pos: V.toNum(k.val) === 1 };
      }
    }
    return null;
  }
  // an asynchronous reset condition: sig = '1' / '0', sig, not sig
  function levelOf(c) {
    if (c.k === 'sig' && c.sig.t.w === 1) return { sig: c.sig, high: true };
    if (c.k === 'un' && (c.o === '!' || c.o === '~') && c.a.k === 'sig' && c.a.sig.t.w === 1) return { sig: c.a.sig, high: false };
    if (c.k === 'bin' && c.o === '==') {
      const s = c.a.k === 'sig' ? c.a : c.b.k === 'sig' ? c.b : null, k = c.a.k === 'c' ? c.a : c.b.k === 'c' ? c.b : null;
      if (s && k && s.sig.t.w === 1 && !k.val.x) return { sig: s.sig, high: V.toNum(k.val) === 1 };
    }
    return null;
  }
  const hasEdge = n => n && typeof n === 'object' && (n.k === 'edge' || n.k === 'event' || Object.entries(n).some(([k, v]) => k !== 't' && k !== 'sig' && k !== 'fn' && v && typeof v === 'object' && (Array.isArray(v) ? v.some(hasEdge) : hasEdge(v))));

  // a concurrent assignment whose value is a condition chain with a clock edge
  // (q <= d when rising_edge(clk); q <= '0' when rst = '1' else d when rising_edge(clk)): the
  // equivalent if statements, without the branches that keep the target's own value
  const sameSig = (a, b) => a && b && a.k === 'sig' && b.k === 'sig' && a.sig === b.sig;
  function condToIf(st) {
    if (!st || st.k !== 'asg' || st.value?.k !== 'cond' || !hasEdge(st.value)) return st;
    const build = v => {
      if (v.k !== 'cond') return sameSig(v, st.target) ? null : { ...st, value: v };
      return { k: 'if', c: v.c, then: build(v.a), else: build(v.b), loc: st.loc };
    };
    return build(st.value);
  }

  let pn = 0;
  function process(p) {
    if (p.mode === 'initial' || p.mode === 'loop') return initialProcess(p);
    const ctx = { proc: p, locals: new Map(), fn: null, base: `p${pn++}`, flags: [] };
    const file = p.file;
    try {
      let head, body;
      if (p.mode === 'wait-first' && p.triggers?.length) {
        // Verilog always @(…): the event list as written
        const edges = p.triggers.filter(t => t.edge === 'pos' || t.edge === 'neg');
        if (edges.length && edges.length !== p.triggers.length) fail('an event list mixing edges and levels', p);
        head = edges.length ? `always @(${edges.map(t => `${t.edge === 'pos' ? 'posedge' : 'negedge'} ${sigName.get(t.sig)}`).join(' or ')})` : 'always @*';
        body = stmt(p.body, ctx, '    ', 'proc');
      } else if (!hasEdge(p.body)) {
        if (p.mode !== 'comb' && p.mode !== 'sens' && p.kind !== 'assign' && p.kind !== 'glue') fail('a process with waits cannot be synthesized', p);
        head = 'always @*';
        body = stmt(p.body, ctx, '    ', 'proc');
      } else {
        // VHDL clocked process: [if reset … elsif] if clock-edge … ; nothing else at the top
        let s = condToIf(p.body);
        while (s.k === 'blk' && s.stmts.length === 1) s = s.stmts[0];
        if (s.k !== 'if') fail('a clocked process must be one if statement on the clock (and asynchronous resets before it)', p);
        const resets = [];
        let clock = null, cur = s;
        while (cur && cur.k === 'if') {
          const ed = edgeOf(cur.c);
          if (ed) { clock = { ...ed, body: cur.then, rest: cur.else }; break; }
          const lv = levelOf(cur.c);
          if (!lv) fail('a condition before the clock edge that is not an asynchronous reset (signal = \'0\' / \'1\')', cur);
          resets.push({ ...lv, body: cur.then });
          cur = cur.else && cur.else.k === 'blk' && cur.else.stmts.length === 1 ? cur.else.stmts[0] : cur.else;
        }
        if (!clock) fail('no clock edge found in this process', p);
        if (clock.rest) fail('statements after the clock edge branch (elsif / else after rising_edge)', p);
        const ev = [`${clock.pos ? 'posedge' : 'negedge'} ${sigName.get(clock.sig)}`, ...resets.map(r => `${r.high ? 'posedge' : 'negedge'} ${sigName.get(r.sig)}`)];
        head = `always @(${ev.join(' or ')})`;
        let txt = '';
        resets.forEach((r, k) => { txt += `    ${k ? 'else ' : ''}if (${r.high ? '' : '!'}${sigName.get(r.sig)}) begin\n${stmt(r.body, ctx, '      ', 'proc')}    end\n`; });
        const cb = stmt(clock.body, ctx, resets.length ? '      ' : '    ', 'proc');
        body = resets.length ? `${txt}    else begin\n${cb}    end\n` : cb;
      }
      if (hasEdge(p.body) && !head.includes('edge')) fail('a clock edge not at the top of the process', p);
      const loc = [...ctx.locals.values(), ...(ctx.extraLocals || [])].map(l => `  reg ${sgn(l.t) ? 'signed ' : ''}${l.t.kind === 'array' ? `[${wOf(l.t.elem) - 1}:0] ${l.name} [0:${l.t.len - 1}]` : `[${wOf(l.t) - 1}:0] ${l.name}`};`);
      let text = body;
      for (const f of ctx.flags) {
        const nm = uniq(`${ctx.base}${f}`);
        loc.push(`  reg ${nm};`);
        text = text.replaceAll(new RegExp(`\\b${f}\\b`, 'g'), nm);
      }
      // process variables first assigned in the process: blocking (as in VHDL)
      blocks.push(`${loc.join('\n')}${loc.length ? '\n' : ''}  // ${p.name || p.kind}${p.loc ? ` (${p.file || ''}:${p.loc.line})` : ''}\n  ${head} begin\n${text}  end`);
    } catch (err) {
      if (err instanceof SynthError) { err.file ||= file; err.proc = p.name; }
      throw err;
    }
  }

  // ---------------- initial blocks
  // An initial block without delays (or a VHDL process that ends in a bare `wait;`) only sets
  // the values the design starts with. It is run here, once, by the simulator's own interpreter
  // (so loops, functions, expressions mean exactly what they mean in simulation), on a stand-in
  // for the simulator that records the assignments; what it leaves in each signal becomes that
  // signal's initial value (the INIT of its flip-flops, the contents of its memory). Messages
  // ($display, report) have no effect; delays, waits on events and file reads cannot be synthesized.
  const initVal = new Map();     // signal -> its value after the initial blocks
  const drivers = new Map();     // signal -> the processes (not initial) that assign it
  for (const p of design.procs) if (p.mode !== 'initial' && p.mode !== 'loop') for (const s of p.writes || []) { if (!drivers.has(s)) drivers.set(s, []); drivers.get(s).push(p); }
  function initialProcess(p) {
    const saved = new Map(), nba = [];
    try {
      // a value read from a signal that another process drives depends on the order the
      // processes start in at time 0: not an initial value
      for (const s of p.reads || []) if (!p.writes?.has(s) && drivers.has(s)) fail(`an initial block that reads ${s.name}, which another process drives`, p);
      const no = what => () => fail(`${what} cannot be synthesized`, p);
      const write = (wr, v) => { const sg = wr.sig; if (!saved.has(sg)) saved.set(sg, sg.val); sg.val = applyWrite(sg.val, wr, v); };
      const sim = {
        now: 0, stamp: 0, write, nba: (wr, v) => nba.push([wr, v]), preempt() {}, print() {}, strobe() {}, monitor() {}, report() {}, finish() {},
        after: no('a delayed assignment in an initial block'), readmem: no('$readmemh / $readmemb (the file is not read by synthesis)'), random: no('$random'),
      };
      const ctx = { frame: p.frameInit ? p.frameInit() : [], sim, depth: 0, timeUnit: p.timeUnit, scopeName: p.inst?.path };
      const r = exec(p.body, ctx).next();
      // it must end (or stop for good: VHDL wait; / $finish) without waiting for time or events;
      // a VHDL process that runs to its end without waiting would start again at once
      if (r.done ? p.mode === 'loop' : !r.value?.forever) fail('a process with waits cannot be synthesized', p);
      for (const [wr, v] of nba) write(wr, v);
      for (const sg of saved.keys()) initVal.set(sg, sg.val);
    } catch (err) {
      if (err instanceof SimError) err = new SynthError(`initial block: ${err.message}${where(p)}`, p.loc);
      if (err instanceof SynthError) { err.file ||= p.file; err.proc = p.name; }
      throw err;
    } finally {
      for (const [sg, v] of saved) sg.val = v;
    }
  }
  for (const p of design.procs) if (!skipProc.has(p) && (p.mode === 'initial' || p.mode === 'loop')) process(p);

  // ---------------- primitive instances
  // A generic as Yosys's cell library (and the Xilinx Verilog UNISIM) declares it: strings and
  // booleans ("TRUE" / "FALSE") as strings, reals with a decimal point, vectors sized.
  function paramLit(prm, inst) {
    const v = prm.value, t = prm.t || {};
    if (v?.str !== undefined) return `"${v.str.replace(/["\\]/g, '\\$&')}"`;
    if (v?.real !== undefined || t.kind === 'real') { const x = v.real ?? V.toNum(v); return Number.isInteger(x) ? x.toFixed(1) : String(x); }
    if (t.kind === 'bool') return V.toNum(v) ? '"TRUE"' : '"FALSE"';
    if (t.kind === 'time' || Array.isArray(v)) fail(`${inst.module} ${inst.name}: generic ${prm.name} has no synthesizable value`, inst, inst.file);
    if (t.kind === 'int') { if (v.x) fail(`${inst.module} ${inst.name}: generic ${prm.name} is undefined`, inst, inst.file); return V.toDec(v, true); }
    return lit(v);
  }
  // (the names of the primitives, their generics and ports are upper case in Yosys's library;
  // VHDL gives them in whatever case the design wrote)
  function instance({ inst, driven }) {
    const params = inst.params.filter(prm => prm.given).map(prm => `    .${prm.name.toUpperCase()}(${paramLit(prm, inst)})`);
    const conns = [];
    for (const pt of inst.ports) {
      let x = sigName.get(pt.sig);
      // an input left unconnected (no actual drives its signal): the port's default value, if any
      if (pt.dir === 'in' && !pt.alias && !driven.has(pt.sig)) {
        const v = pt.sig.init;
        x = v && !Array.isArray(v) && v.str === undefined && v.x !== (1n << BigInt(v.w)) - 1n ? lit(v) : '';
      }
      conns.push(`    .${pt.name.toUpperCase()}(${x})`);
    }
    const rel = inst.path.startsWith(prefix) ? inst.path.slice(prefix.length) : inst.name;
    const iname = esc(uniq(rel.replace(/\./g, '_')));
    const src = inst.parent?.file ? ` (${inst.parent.file})` : '';
    blocks.push(`  // ${inst.path}: ${inst.module}${src}\n  ${inst.module.toUpperCase()}${params.length ? ` #(\n${params.join(',\n')}\n  )` : ''} ${iname} (\n${conns.join(',\n')}\n  );`);
  }

  // ---------------- declarations
  // the value a signal starts with: what the initial blocks left in it, else its declared initial
  // value; none for the outputs of primitives (the primitive gives them their value)
  const startVal = sg => (primDriven.has(sg) ? undefined : initVal.has(sg) ? initVal.get(sg) : sg.hasInit ? sg.init : undefined);
  const allX = v => !v || v.w <= 0 || v.x === (1n << BigInt(v.w)) - 1n;
  const initOf = (sg, w) => { const v = startVal(sg); return v && !Array.isArray(v) && v.str === undefined && !allX(v) ? ` = ${lit(V.resize(v, w), w)}` : ''; };
  const portDecl = [];
  for (const p of top.ports) {
    const s = p.sig, w = wOf(s.t);
    portDecl.push(`  ${p.dir === 'in' ? 'input' : p.dir === 'out' ? 'output' : 'inout'} ${p.dir === 'in' ? 'wire' : 'logic'} ${sgn(s.t) ? 'signed ' : ''}${w > 1 || !s.t.scalar ? `[${w - 1}:0] ` : ''}${sigName.get(s)}${p.dir === 'in' ? '' : initOf(s, w)}`);
  }
  for (const s of design.signals) {
    if (portOf.has(s) || skipSig.has(s)) continue;
    const t = s.t, name = sigName.get(s);
    if (t.kind === 'array' || Array.isArray(s.val)) {
      const et = t.elem || { w: s.val[0]?.w || 1 };
      const len = Array.isArray(s.init) ? s.init.length : (t.len ?? s.val.length);
      decls.push(`  logic ${et.s ? 'signed ' : ''}[${wOf(et) - 1}:0] ${name} [0:${len - 1}];`);
      const v0 = startVal(s);
      if (Array.isArray(v0)) {
        if (v0.some(v => Array.isArray(v))) fail(`the initial value of ${s.name}, an array of arrays`, s, s.file);
        const set = v0.map((v, k) => (allX(v) ? null : `    ${name}[${k}] = ${lit(v, wOf(et))};`)).filter(Boolean);
        if (set.length) blocks.push(`  initial begin\n${set.join('\n')}\n  end`);
      }
      continue;
    }
    if (t.kind === 'real' || t.kind === 'str' || t.kind === 'time') { warnings.push(`signal ${s.path}: ${t.kind} signals are not synthesized`); continue; }
    const w = wOf(t);
    decls.push(`  logic ${sgn(t) ? 'signed ' : ''}[${w - 1}:0] ${name}${initOf(s, w)};`);
  }
  for (const p of design.procs) if (!skipProc.has(p) && p.mode !== 'initial' && p.mode !== 'loop') process(p);
  for (const pr of prims) instance(pr);

  const mod = esc(name || top.name);
  const text = `// Generated by Silinx (core/synth-verilog.js) from the design '${top.name}': one flat module for synthesis.\n`
    + `module ${mod} (\n${portDecl.join(',\n')}\n);\n${decls.join('\n')}\n${funcs.join('\n')}${funcs.length ? '\n' : ''}${blocks.join('\n')}\nendmodule\n`;
  return { text, top: mod.trim(), warnings, primitives: [...new Set(prims.map(pr => pr.inst.module.toUpperCase()))] };
}
