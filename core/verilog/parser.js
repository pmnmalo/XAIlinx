// Verilog-2001 (+ a few SystemVerilog conveniences) recursive-descent parser producing the Silinx IR.
// See docs/IR.md.
import { tokenize, basedToBits } from './lexer.js';

const GATES = new Set(['and', 'or', 'nand', 'nor', 'xor', 'xnor', 'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1']);
// net types with their own resolution (wired and / or, pull-down / pull-up when undriven)
const WIRED = { wand: 'and', triand: 'and', wor: 'or', trior: 'or', tri0: 'tri0', tri1: 'tri1' };
const BIN_PREC = [
  ['||'], ['&&'], ['|'], ['^', '~^'], ['&'], ['==', '!=', '===', '!=='],
  ['<', '<=', '>', '>='], ['<<', '>>', '<<<', '>>>'], ['+', '-'], ['*', '/', '%'], ['**'],
];
const UNARY = new Set(['!', '~', '-', '+', '&', '|', '^', '~&', '~|', '~^']);

class Sync extends Error {}

// opts.include(name): the text of a project file for `include (null when there is none)
export function parse(source, file = 'input', opts = {}) {
  const errors = [];
  const { tokens, timescale } = tokenize(source, file, errors, { include: opts.include });
  const p = new Parser(tokens, file, errors, timescale);
  const units = p.parseFile();
  return { file, lang: 'verilog', units, errors };
}

class Parser {
  constructor(tokens, file, errors, timescale) {
    this.toks = tokens; this.i = 0; this.file = file; this.errors = errors; this.timescale = timescale;
  }
  get tok() { return this.toks[this.i]; }
  peek(k = 1) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  loc(t = this.tok) { return { line: t.line, col: t.col }; }
  is(v, t = this.tok) { return (t.t === 'op' || t.t === 'kw') && t.v === v; }
  isAny(...vs) { return vs.some(v => this.is(v)); }
  next() { const t = this.tok; if (t.t !== 'eof') this.i++; return t; }
  accept(v) { if (this.is(v)) { return this.next(); } return null; }
  error(msg, t = this.tok, sev = 'error') {
    this.errors.push({ file: this.file, line: t.line, col: t.col, message: msg, severity: sev });
  }
  expect(v) {
    if (this.is(v)) return this.next();
    // a ';' missing at the end of a line: reported after the last token of that line, and parsing
    // goes on as if it were there (no cascade of errors)
    const prev = this.i > 0 ? this.toks[this.i - 1] : null;
    if (v === ';' && prev && this.tok.line > prev.line) {
      this.error(`expected ';' after '${prev.v ?? prev.t}'`, { line: prev.line, col: prev.col + String(prev.v ?? '').length });
      return prev;
    }
    this.error(`expected '${v}' but found '${this.tok.v || this.tok.t}'`);
    throw new Sync();
  }
  ident() {
    const t = this.tok;
    if (t.t === 'id') { this.next(); return t.v; }
    this.error(`expected identifier but found '${t.v || t.t}'`);
    throw new Sync();
  }
  // skip to after the next ';' (or stop before one of the stop keywords)
  sync(stops = []) {
    while (this.tok.t !== 'eof') {
      if (this.is(';')) { this.next(); return; }
      if (stops.some(s => this.is(s))) return;
      this.next();
    }
  }

  parseFile() {
    const units = [];
    while (this.tok.t !== 'eof') {
      if (this.is('module') || this.is('macromodule')) {
        try { units.push(this.module()); }
        catch (e) {
          if (!(e instanceof Sync)) throw e;
          while (this.tok.t !== 'eof' && !this.is('endmodule')) this.next();
          this.accept('endmodule');
        }
      } else {
        this.error(`unexpected '${this.tok.v}' outside module`);
        this.next();
      }
    }
    return units;
  }

  // ---------------- module ----------------
  module() {
    const start = this.next();
    const name = this.ident();
    const mod = {
      kind: 'module', name, lang: 'verilog', file: this.file, loc: this.loc(start),
      params: [], ports: [], decls: [], items: [], uses: [],
    };
    if (this.timescale) mod.timescale = this.timescale;
    this.cur = mod;
    this.portNames = new Map();
    if (this.accept('#')) {
      this.expect('(');
      if (!this.is(')')) {
        let kind = 'parameter';
        do {
          if (this.is('parameter') || this.is('localparam')) kind = this.next().v;
          const { type } = this.paramType();
          const pn = this.ident();
          this.expect('=');
          mod.params.push({ name: pn, type, default: this.expr(), local: kind === 'localparam' });
        } while (this.accept(','));
      }
      this.expect(')');
    }
    if (this.accept('(')) {
      if (!this.is(')')) {
        if (this.isAny('input', 'output', 'inout')) this.ansiPorts(mod);
        else {
          do {
            if (this.is('.')) { this.error('explicit port expressions not supported'); throw new Sync(); }
            const pn = this.ident();
            const port = { name: pn, dir: 'in', type: { kind: 'logic', range: null, signed: false }, default: null, loc: this.loc(), declared: false };
            mod.ports.push(port); this.portNames.set(pn, port);
          } while (this.accept(','));
        }
      }
      this.expect(')');
    }
    this.expect(';');
    while (!this.is('endmodule') && this.tok.t !== 'eof') this.moduleItem(mod.items, mod.decls, true);
    this.expect('endmodule');
    for (const p of mod.ports) {
      if (p.declared === false) this.error(`port '${p.name}' has no direction declaration`, { line: p.loc.line, col: p.loc.col });
      delete p.declared;
    }
    return mod;
  }

  ansiPorts(mod) {
    let dir = 'in', type = null, net = 'wire';
    do {
      if (this.isAny('input', 'output', 'inout')) {
        const d = this.next().v;
        dir = d === 'input' ? 'in' : d === 'output' ? 'out' : 'inout';
        net = 'wire';
        if (this.isAny('wire', 'reg', 'logic', 'tri')) net = this.next().v;
        if (this.is('integer')) { this.next(); type = { kind: 'integer', range: null }; }
        else {
          const signed = !!this.accept('signed');
          type = { kind: 'logic', range: this.optRange(), signed };
        }
      }
      const loc = this.loc();
      const pn = this.ident();
      let def = null;
      if (this.accept('=')) def = this.expr();
      const port = { name: pn, dir, type, default: def, loc, net };
      if (this.portNames.has(pn)) { this.error(`port '${pn}' is declared twice`, this.toks[this.i - 1]); continue; }
      mod.ports.push(port); this.portNames.set(pn, port);
    } while (this.accept(','));
  }

  paramType() {
    if (this.is('integer')) { this.next(); return { type: { kind: 'integer', range: null } }; }
    if (this.is('real')) { this.next(); return { type: { kind: 'real' } }; }
    const signed = !!this.accept('signed');
    const range = this.optRange();
    return { type: range || signed ? { kind: 'logic', range, signed } : null };
  }

  optRange() {
    if (!this.is('[')) return null;
    this.next();
    const left = this.expr(); this.expect(':'); const right = this.expr();
    this.expect(']');
    return { left, right, dir: null };
  }

  // Parses one module/generate item, appending to items/decls.
  moduleItem(items, decls, topLevel) {
    const t = this.tok;
    try {
      if (this.accept(';')) return;
      if (this.isAny('input', 'output', 'inout')) return this.portDecl();
      if (this.isAny('wire', 'reg', 'logic', 'integer', 'tri', 'supply0', 'supply1', 'genvar', 'time', 'real', 'realtime', ...Object.keys(WIRED)))
        return this.netDecl(items, decls);
      if (this.is('specify')) {   // specify blocks (path delays, timing checks): ignored by simulation
        while (!this.is('endspecify') && this.tok.t !== 'eof') this.next();
        this.expect('endspecify');
        return;
      }
      if (this.is('event')) {   // named events: 1-bit variables toggled by `-> e`
        this.next();
        do { const loc = this.loc(); decls.push({ kind: 'signal', name: this.ident(), type: { kind: 'logic', range: null, signed: false }, init: { op: 'lit', bits: '0', signed: false, sized: true }, net: 'reg', loc }); } while (this.accept(','));
        this.expect(';');
        return;
      }
      if (this.isAny('parameter', 'localparam')) {
        const local = this.next().v === 'localparam' || !topLevel;
        const { type } = this.paramType();
        do {
          const pn = this.ident(); this.expect('=');
          const value = this.expr();
          if (local) decls.push({ kind: 'const', name: pn, type, value, loc: this.loc(t) });
          else this.cur.params.push({ name: pn, type, default: value, local: false });
        } while (this.accept(','));
        this.expect(';');
        return;
      }
      if (this.is('assign')) {
        this.next();
        let delay = null;
        if (this.accept('#')) delay = this.delayValue();
        do {
          const loc = this.loc();
          const target = this.lvalue(); this.expect('=');
          items.push({ kind: 'assign', target, value: this.expr(), delay, loc });
        } while (this.accept(','));
        this.expect(';');
        return;
      }
      if (this.isAny('always', 'always_ff', 'always_comb', 'always_latch')) return items.push(this.always());
      if (this.is('initial')) {
        const loc = this.loc(); this.next();
        return items.push({ kind: 'process', label: null, sens: null, initial: true, decls: [], body: [this.stmt()], loc });
      }
      if (this.is('generate')) {
        this.next();
        while (!this.is('endgenerate') && this.tok.t !== 'eof') this.moduleItem(items, decls, false);
        this.expect('endgenerate');
        return;
      }
      if (this.is('for')) return items.push(this.genFor());
      if (this.is('if')) return items.push(this.genIf());
      if (this.is('case')) return items.push(this.genCase());
      if (this.is('begin')) { // bare generate block
        const blk = this.genBlock();
        items.push({ kind: 'generate_if', label: blk.label, cond: { op: 'int', value: '1' }, then: blk.items, else: [], decls: blk.decls, loc: this.loc(t) });
        return;
      }
      if (this.is('function') || this.is('task')) return decls.push(this.funcDecl());
      if (this.is('defparam')) {   // defparam u1.P = v, u1.u2.Q = w;
        this.next();
        do {
          const loc = this.loc();
          const path = this.hierName(); this.expect('=');
          items.push({ kind: 'defparam', path, value: this.expr(), loc });
        } while (this.accept(','));
        this.expect(';');
        return;
      }
      if (t.t === 'kw' && GATES.has(t.v)) return this.gateInst(items);
      if (t.t === 'id') return this.instance(items);
      this.error(`unexpected '${t.v || t.t}' in module body`);
      throw new Sync();
    } catch (e) {
      if (!(e instanceof Sync)) throw e;
      if (this.i === this.toks.indexOf(t)) this.next();
      this.sync(['endmodule', 'end', 'endgenerate']);
    }
  }

  portDecl() {
    const d = this.next().v;
    const dir = d === 'input' ? 'in' : d === 'output' ? 'out' : 'inout';
    let net = 'wire';
    if (this.isAny('wire', 'reg', 'logic', 'tri')) net = this.next().v;
    let type;
    if (this.accept('integer')) type = { kind: 'integer', range: null };
    else { const signed = !!this.accept('signed'); type = { kind: 'logic', range: this.optRange(), signed }; }
    do {
      const loc = this.loc();
      const pn = this.ident();
      let port = this.portNames.get(pn);
      if (!port) {
        this.error(`'${pn}' is not in the port list`, this.toks[this.i - 1]);
        port = { name: pn, dir, type, default: null, loc };
      }
      port.dir = dir; port.type = type; port.declared = true; port.net = net;
      if (this.accept('=')) port.default = this.expr();
    } while (this.accept(','));
    this.expect(';');
  }

  // local: a declaration in a function, task or block (never the module port of that name)
  netDecl(items, decls, local = false) {
    const kw = this.next().v;
    if (kw === 'genvar') { do { this.ident(); } while (this.accept(',')); this.expect(';'); return; }
    let type;
    if (kw === 'integer' || kw === 'time') type = { kind: 'integer', range: null };
    else if (kw === 'real' || kw === 'realtime') type = { kind: 'real' };
    else {
      if (this.isAny('reg', 'logic', 'wire')) this.next();
      const signed = !!this.accept('signed'); this.accept('unsigned');
      type = { kind: 'logic', range: this.optRange(), signed };
    }
    const net = kw === 'reg' || kw === 'logic' || kw === 'integer' || kw === 'time' || kw === 'real' ? 'reg' : 'wire';
    const wired = WIRED[kw];
    do {
      const loc = this.loc();
      const name = this.ident();
      let t = type;
      const dims = [];
      while (this.is('[')) dims.push(this.optRange());   // memory dimensions: m [0:1][0:3] is 2 arrays of 4
      for (let k = dims.length - 1; k >= 0; k--) t = { kind: 'array', range: dims[k], elem: t };
      let init = null;
      if (this.accept('=')) init = this.expr();
      const port = local ? null : this.portNames.get(name);
      if (port) {
        // `output q; reg [3:0] q;` -> refine the port declaration
        if (type.range && !port.type.range) port.type = type;
        if (type.signed) port.type = { ...port.type, signed: true };
        port.net = kw === 'logic' ? 'logic' : net;
        if (init) items.push({ kind: 'process', label: null, sens: null, initial: true, decls: [], body: [{ kind: 'assign', target: { op: 'ref', name }, value: init, nonblocking: false, delay: null }], loc });
        continue;
      }
      if (net === 'wire' && init) {
        decls.push({ kind: 'signal', name, type: t, init: null, net, loc, ...(wired ? { wired } : {}) });
        items.push({ kind: 'assign', target: { op: 'ref', name }, value: init, delay: null, loc });
      } else {
        if (kw === 'supply0') init = { op: 'int', value: '0' };
        if (kw === 'supply1') init = { op: 'lit', bits: '1', signed: false, sized: true };
        const d = { kind: 'signal', name, type: t, init, net, loc };
        if (wired) d.wired = wired;
        decls.push(d);
      }
    } while (this.accept(','));
    this.expect(';');
  }

  always() {
    const loc = this.loc();
    const kw = this.next().v;
    let sens = null;
    if (kw === 'always_comb' || kw === 'always_latch') sens = 'all';
    else if (this.is('@')) {
      this.next();
      sens = this.eventList();
    }
    const body = this.stmt();
    return { kind: 'process', label: null, sens, initial: false, decls: [], body: [body], loc };
  }

  eventList() {
    if (this.accept('*')) return 'all';
    if (this.tok.t === 'id' && !this.is('(')) return [{ edge: 'any', expr: this.primary() }];
    this.expect('(');
    if (this.accept('*')) { this.expect(')'); return 'all'; }
    const evs = [];
    do {
      let edge = 'any';
      if (this.accept('posedge')) edge = 'pos';
      else if (this.accept('negedge')) edge = 'neg';
      evs.push({ edge, expr: this.expr() });
    } while (this.accept('or') || this.accept(','));
    this.expect(')');
    return evs;
  }

  genBlock() {
    let label = null;
    if (this.accept('begin')) {
      if (this.accept(':')) label = this.ident();
      const items = [], decls = [];
      while (!this.is('end') && this.tok.t !== 'eof') this.moduleItem(items, decls, false);
      this.expect('end');
      if (this.accept(':')) this.ident();
      return { label, items, decls };
    }
    const items = [], decls = [];
    this.moduleItem(items, decls, false);
    return { label, items, decls };
  }

  genFor() {
    const loc = this.loc();
    this.expect('for'); this.expect('(');
    this.accept('genvar');
    const v = this.ident(); this.expect('='); const init = this.expr(); this.expect(';');
    const cond = this.expr(); this.expect(';');
    const sv = this.ident();
    if (sv !== v) this.error('generate loop step must assign the loop variable');
    const step = this.stepValue(v);
    this.expect(')');
    const blk = this.genBlock();
    return { kind: 'generate_for', label: blk.label || `genblk_${v}`, var: v, init, cond, step, decls: blk.decls, items: blk.items, loc };
  }

  // after `i` in a step: `= expr`, `++`, `--`, `+= e`, `-= e`
  stepValue(v) {
    const ref = { op: 'ref', name: v };
    if (this.accept('=')) return this.expr();
    if (this.accept('++')) return { op: 'binary', o: '+', a: ref, b: { op: 'int', value: '1' } };
    if (this.accept('--')) return { op: 'binary', o: '-', a: ref, b: { op: 'int', value: '1' } };
    if (this.accept('+=')) return { op: 'binary', o: '+', a: ref, b: this.expr() };
    if (this.accept('-=')) return { op: 'binary', o: '-', a: ref, b: this.expr() };
    this.error('expected loop step assignment'); throw new Sync();
  }

  // case generate: a chain of if-generates on `expr == choice`
  genCase() {
    const loc = this.loc();
    this.expect('case'); this.expect('(');
    const sel = this.expr(); this.expect(')');
    const alts = [];
    let def = null;
    while (!this.is('endcase') && this.tok.t !== 'eof') {
      if (this.accept('default')) { this.accept(':'); def = this.genBlock(); continue; }
      const choices = [];
      do { choices.push(this.expr()); } while (this.accept(','));
      this.expect(':');
      alts.push({ choices, blk: this.genBlock() });
    }
    this.expect('endcase');
    const wrap = b => (b.label ? [{ kind: 'generate_if', label: b.label, cond: { op: 'int', value: '1' }, then: b.items, else: [], decls: b.decls, loc }] : b.items);
    let rest = def ? wrap(def) : [];
    let restDecls = def && !def.label ? def.decls : [];
    for (let k = alts.length - 1; k >= 0; k--) {
      const { choices, blk } = alts[k];
      const cond = choices.map(c => ({ op: 'binary', o: '==', a: sel, b: c })).reduce((x, y) => ({ op: 'binary', o: '||', a: x, b: y }));
      const node = { kind: 'generate_if', label: blk.label, cond, then: blk.items, else: rest, decls: blk.decls, loc };
      if (restDecls.length) node.elseDecls = restDecls;
      rest = [node]; restDecls = [];
    }
    if (rest.length === 1 && rest[0].kind === 'generate_if') return rest[0];
    const node = { kind: 'generate_if', label: null, cond: { op: 'int', value: '1' }, then: rest, else: [], decls: restDecls, loc };
    return node;
  }

  genIf() {
    const loc = this.loc();
    this.expect('if'); this.expect('(');
    const cond = this.expr(); this.expect(')');
    const thenB = this.genBlock();
    let elseItems = [], elseDecls = [];
    if (this.accept('else')) {
      if (this.is('if')) elseItems = [this.genIf()];
      else { const b = this.genBlock(); elseItems = b.items; elseDecls = b.decls; if (b.label) elseItems = [{ kind: 'generate_if', label: b.label, cond: { op: 'int', value: '1' }, then: b.items, else: [], decls: b.decls, loc }], elseDecls = []; }
    }
    const node = { kind: 'generate_if', label: thenB.label, cond, then: thenB.items, else: elseItems, decls: thenB.decls, loc };
    if (elseDecls.length) node.elseDecls = elseDecls;
    return node;
  }

  funcDecl() {
    const loc = this.loc();
    const kind = this.next().v;
    this.accept('automatic');
    let returnType = null;
    if (kind === 'function') {
      if (this.accept('integer')) returnType = { kind: 'integer', range: null };
      else { const signed = !!this.accept('signed'); this.accept('reg'); this.accept('logic'); returnType = { kind: 'logic', range: this.optRange(), signed }; }
    }
    const name = this.ident();
    const params = [], decls = [];
    const parseParamGroup = () => {
      const d = this.next().v;
      const dir = d === 'input' ? 'in' : d === 'output' ? 'out' : 'inout';
      this.accept('reg'); this.accept('wire'); this.accept('logic');
      let type;
      if (this.accept('integer')) type = { kind: 'integer', range: null };
      else { const signed = !!this.accept('signed'); type = { kind: 'logic', range: this.optRange(), signed }; }
      return { dir, type };
    };
    if (this.accept('(')) { // ANSI style
      if (!this.is(')')) {
        let cur = { dir: 'in', type: { kind: 'logic', range: null, signed: false } };
        do {
          if (this.isAny('input', 'output', 'inout')) cur = parseParamGroup();
          params.push({ name: this.ident(), ...cur });
        } while (this.accept(','));
      }
      this.expect(')');
    }
    this.expect(';');
    while (this.isAny('input', 'output', 'inout', 'reg', 'integer', 'logic', 'parameter', 'localparam', 'real', 'time')) {
      if (this.isAny('input', 'output', 'inout')) {
        const g = parseParamGroup();
        do { params.push({ name: this.ident(), ...g }); } while (this.accept(','));
        this.expect(';');
      } else if (this.isAny('parameter', 'localparam')) {
        this.next(); const { type } = this.paramType();
        do { const n = this.ident(); this.expect('='); decls.push({ kind: 'const', name: n, type, value: this.expr(), loc: this.loc() }); } while (this.accept(','));
        this.expect(';');
      } else this.netDecl([], decls, true);
    }
    const body = [];
    while (!this.isAny('endfunction', 'endtask', 'endmodule') && this.tok.t !== 'eof') { const i0 = this.i; body.push(this.stmt()); if (this.i === i0) break; }
    if (this.isAny('endfunction', 'endtask')) this.next(); else this.error(`expected '${kind === 'task' ? 'endtask' : 'endfunction'}' but found '${this.tok.v || this.tok.t}'`);
    for (const d of decls) if (d.kind === 'signal') d.net = 'variable';
    const fn = { kind, name, params, returnType, decls, body, loc };
    if (kind === 'function') fn.retVar = name;
    return fn;
  }

  gateInst(items) {
    const loc = this.loc();
    const g = this.next().v;
    let delay = null;
    if (this.is('#')) { this.next(); delay = this.delayValue(); }
    do {
      if (this.tok.t === 'id') this.next(); // instance name (optional)
      this.expect('(');
      const args = [];
      do { args.push(this.expr()); } while (this.accept(','));
      this.expect(')');
      const out = args[0], ins = args.slice(1);
      let value;
      if (g === 'not' || g === 'buf') {
        // not / buf: every terminal but the last is an output (not (o1, o2, i))
        const i = args[args.length - 1];
        for (const o of args.slice(0, -1)) items.push({ kind: 'assign', target: o, value: g === 'not' ? { op: 'unary', o: '~', a: i } : i, delay, loc, gate: true });
        continue;
      } else if (g.includes('if')) {   // bufif1 (out, in, enable): in when enabled, z otherwise
        const d = g.startsWith('not') ? { op: 'unary', o: '~', a: ins[0] } : ins[0];
        const z = { op: 'lit', bits: 'z', signed: false, sized: true };
        value = g.endsWith('1') ? { op: 'cond', cond: ins[1], then: d, else: z } : { op: 'cond', cond: ins[1], then: z, else: d };
      } else {
        const o = { and: '&', or: '|', xor: '^', nand: '&', nor: '|', xnor: '^' }[g];
        value = ins.reduce((acc, e) => ({ op: 'binary', o, a: acc, b: e }));
        if (g[0] === 'n' || g === 'xnor') value = { op: 'unary', o: '~', a: value };
      }
      items.push({ kind: 'assign', target: out, value, delay, loc, gate: true });
    } while (this.accept(','));
    this.expect(';');
  }

  instance(items) {
    const loc = this.loc();
    const module = this.ident();
    const params = [];
    if (this.accept('#')) {
      if (this.is('(')) {
        this.next();
        if (!this.is(')')) {
          do {
            if (this.accept('.')) {
              const n = this.ident(); this.expect('(');
              params.push({ name: n, value: this.is(')') ? null : this.expr() });
              this.expect(')');
            } else params.push({ name: null, value: this.expr() });
          } while (this.accept(','));
        }
        this.expect(')');
      } else params.push({ name: null, value: this.primary() });
    }
    do {
      const iloc = this.loc();
      const name = this.ident();
      if (this.is('[')) { this.error('instance arrays are not supported'); throw new Sync(); }
      this.expect('(');
      const conns = [];
      if (!this.is(')')) {
        do {
          if (this.accept('.')) {
            if (this.accept('*')) { conns.push({ port: '*', expr: null }); continue; }
            const port = this.ident();
            if (this.accept('(')) {
              conns.push({ port, expr: this.is(')') ? null : this.expr() });
              this.expect(')');
            } else conns.push({ port, expr: { op: 'ref', name: port } }); // .name shorthand
          } else if (this.is(',') || this.is(')')) conns.push({ port: null, expr: null });
          else conns.push({ port: null, expr: this.expr() });
        } while (this.accept(','));
      }
      this.expect(')');
      items.push({ kind: 'instance', name, module, params, conns, loc: items.length && name !== undefined ? iloc : loc });
    } while (this.accept(','));
    this.expect(';');
  }

  delayValue() {
    if (this.accept('(')) { const e = this.expr(); if (this.accept(',')) { this.expr(); if (this.accept(',')) this.expr(); } this.expect(')'); return e; }
    return this.primary();
  }

  // ---------------- statements ----------------
  stmt() {
    const t = this.tok;
    const loc = this.loc();
    const s = this.stmtInner();
    if (s && !s.loc) s.loc = loc;
    return s;
  }

  stmtInner() {
    const t = this.tok;
    try {
      if (this.accept(';')) return { kind: 'null' };
      if (this.is('begin')) {
        this.next();
        let label = null;
        if (this.accept(':')) label = this.ident();
        const decls = [], stmts = [];
        while (this.isAny('reg', 'integer', 'logic', 'real', 'time')) this.netDecl([], decls, true);
        for (const d of decls) d.net = 'variable';
        // a missing 'end' must not loop forever: stop at 'endmodule' or a module item (assign, always…)
        // and on a statement that consumes nothing
        while (!this.isAny('end', 'endmodule', 'assign', 'always', 'initial', 'module') && this.tok.t !== 'eof') { const i0 = this.i; stmts.push(this.stmt()); if (this.i === i0) break; }
        this.expect('end');
        if (this.accept(':')) this.ident();
        return { kind: 'block', label, decls, stmts };
      }
      if (this.is('fork')) {
        // fork ... join | join_any | join_none (the last two SystemVerilog): each statement is a thread
        this.next();
        let label = null;
        if (this.accept(':')) label = this.ident();
        const decls = [], stmts = [];
        while (this.isAny('reg', 'integer', 'logic', 'real', 'time')) this.netDecl([], decls, true);
        for (const d of decls) d.net = 'variable';
        const isEnd = () => this.is('join') || (this.tok.t === 'id' && (this.tok.v === 'join_any' || this.tok.v === 'join_none'));
        while (!isEnd() && !this.isAny('end', 'endmodule') && this.tok.t !== 'eof') stmts.push(this.stmt());
        let join = 'all';
        if (this.tok.t === 'id' && this.tok.v === 'join_any') { this.next(); join = 'any'; }
        else if (this.tok.t === 'id' && this.tok.v === 'join_none') { this.next(); join = 'none'; }
        else this.expect('join');
        if (this.accept(':')) this.ident();
        return { kind: 'fork', label, decls, stmts, join };
      }
      if (this.is('if')) {
        this.next(); this.expect('(');
        const cond = this.expr(); this.expect(')');
        const then = this.stmt();
        const els = this.accept('else') ? this.stmt() : null;
        return { kind: 'if', cond, then, else: els };
      }
      if (this.isAny('case', 'casez', 'casex')) {
        const variant = this.next().v;
        this.expect('(');
        const expr = this.expr(); this.expect(')');
        const items = []; let def = null;
        while (!this.is('endcase') && this.tok.t !== 'eof') {
          if (this.accept('default')) { this.accept(':'); def = this.stmt(); continue; }
          const choices = [];
          do { choices.push(this.expr()); } while (this.accept(','));
          this.expect(':');
          items.push({ choices, body: this.stmt() });
        }
        this.expect('endcase');
        return { kind: 'case', expr, variant, items, default: def };
      }
      if (this.is('for')) {
        this.next(); this.expect('(');
        // for (int k = 0; ...) / for (integer k = 0; ...): a loop variable of the loop's own
        const local = !!(this.accept('integer') || (this.tok.t === 'id' && this.tok.v === 'int' && this.peek().t === 'id' && this.next()));
        const iv = this.ident(); this.expect('=');
        const init = { kind: 'assign', target: { op: 'ref', name: iv }, value: this.expr(), nonblocking: false, delay: null };
        this.expect(';');
        const cond = this.expr(); this.expect(';');
        const sv = this.ident();
        const step = { kind: 'assign', target: { op: 'ref', name: sv }, value: this.stepValue(sv), nonblocking: false, delay: null };
        this.expect(')');
        const loop = { kind: 'for', init, cond, step, body: this.stmt() };
        if (!local) return loop;
        return { kind: 'block', label: null, decls: [{ kind: 'signal', name: iv, type: { kind: 'integer', range: null }, init: null, net: 'variable' }], stmts: [loop] };
      }
      if (this.is('while')) { this.next(); this.expect('('); const cond = this.expr(); this.expect(')'); return { kind: 'while', cond, body: this.stmt() }; }
      if (this.is('repeat')) { this.next(); this.expect('('); const count = this.expr(); this.expect(')'); return { kind: 'repeat', count, body: this.stmt() }; }
      if (this.is('forever')) { this.next(); return { kind: 'forever', body: this.stmt() }; }
      if (this.is('#')) {
        this.next();
        const amount = this.delayValue();
        return { kind: 'delay', amount, stmt: this.is(';') ? (this.next(), null) : this.stmt() };
      }
      if (this.is('@')) {
        this.next();
        const events = this.eventList();
        return { kind: 'event', events, stmt: this.is(';') ? (this.next(), null) : this.stmt() };
      }
      if (this.is('wait') && this.is('fork', this.peek())) { this.next(); this.next(); this.expect(';'); return { kind: 'waitfork' }; }
      if (this.is('wait')) {
        this.next(); this.expect('(');
        const until = this.expr(); this.expect(')');
        const w = { kind: 'wait', on: null, until, for: null, level: true };
        if (this.accept(';')) return w;
        return { kind: 'block', label: null, decls: [], stmts: [w, this.stmt()] };
      }
      if (this.is('disable') && this.is('fork', this.peek())) { this.next(); this.next(); this.expect(';'); return { kind: 'disablefork' }; }
      if (this.is('disable')) {   // disable <named block | task>
        this.next();
        const label = this.hierName();
        this.expect(';');
        return { kind: 'disable', label };
      }
      if (this.is('->')) {   // trigger a named event (toggles its variable)
        this.next();
        const name = this.hierName();
        this.expect(';');
        const ref = { op: 'ref', name };
        return { kind: 'assign', target: ref, value: { op: 'unary', o: '~', a: ref }, nonblocking: false, delay: null };
      }
      if (t.t === 'sys') {
        this.next();
        const args = [];
        if (this.accept('(')) {
          if (!this.is(')')) do { args.push(this.is(',') ? { op: 'str', value: '' } : this.expr()); } while (this.accept(','));
          this.expect(')');
        }
        this.expect(';');
        return { kind: 'call', name: t.v, args };
      }
      if (t.t === 'id' && (this.peek().v === ';' || (this.peek().v === '(' && this.isTaskCall()))) {
        const name = this.ident(); const args = [];
        if (this.accept('(')) { if (!this.is(')')) do { args.push(this.expr()); } while (this.accept(',')); this.expect(')'); }
        this.expect(';');
        return { kind: 'call', name, args };
      }
      // assignment
      const target = this.lvalue();
      if (this.is('++') || this.is('--')) {
        const o = this.next().v[0];
        this.expect(';');
        return { kind: 'assign', target, value: { op: 'binary', o, a: target, b: { op: 'int', value: '1' } }, nonblocking: false, delay: null };
      }
      for (const [co, o] of [['+=', '+'], ['-=', '-'], ['|=', '|'], ['&=', '&'], ['^=', '^']]) {
        if (this.accept(co)) { const v = this.expr(); this.expect(';'); return { kind: 'assign', target, value: { op: 'binary', o, a: target, b: v }, nonblocking: false, delay: null }; }
      }
      let nonblocking = false;
      if (this.accept('<=')) nonblocking = true; else this.expect('=');
      let delay = null;
      if (this.accept('#')) delay = this.delayValue();
      if (this.is('@')) { this.error('intra-assignment event control is not supported'); throw new Sync(); }
      const value = this.expr();
      this.expect(';');
      return { kind: 'assign', target, value, nonblocking, delay };
    } catch (e) {
      if (!(e instanceof Sync)) throw e;
      this.sync(['end', 'endcase', 'endmodule', 'endfunction', 'endtask', 'join']);
      return { kind: 'null' };
    }
  }

  // id '(' ... ')' ';' at statement level is a task call (not an assignment target)
  isTaskCall() {
    let depth = 0, k = this.i + 1;
    for (; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.v === '(') depth++;
      else if (t.v === ')') { depth--; if (depth === 0) break; }
      if (t.t === 'eof') return false;
    }
    return this.toks[k + 1]?.v === ';';
  }

  lvalue() {
    if (this.is('{')) {
      this.next();
      const parts = [];
      do { parts.push(this.lvalue()); } while (this.accept(','));
      this.expect('}');
      return { op: 'concat', parts };
    }
    return this.postfix({ op: 'ref', name: this.hierName() });
  }

  hierName() {
    let n = this.ident();
    for (;;) {
      if (this.is('.') && this.peek().t === 'id') { this.next(); n += '.' + this.ident(); continue; }
      // a generate-for block instance: name[3].x
      if (this.is('[') && this.peek().t === 'int' && this.is(']', this.peek(2)) && this.is('.', this.peek(3)) && this.peek(4).t === 'id') {
        this.next(); n += `[${this.next().v}]`; this.next(); continue;
      }
      return n;
    }
  }

  // ---------------- expressions ----------------
  expr() {
    const c = this.binary(0);
    if (this.accept('?')) {
      const a = this.expr(); this.expect(':');
      const b = this.expr();
      return { op: 'cond', cond: c, then: a, else: b };
    }
    return c;
  }

  binary(level) {
    if (level >= BIN_PREC.length) return this.unary();
    let left = this.binary(level + 1);
    const ops = BIN_PREC[level];
    while (this.tok.t === 'op' && ops.includes(this.tok.v)) {
      const o = this.next().v;
      const right = o === '**' ? this.binary(level) : this.binary(level + 1);
      left = { op: 'binary', o, a: left, b: right };
    }
    return left;
  }

  unary() {
    if (this.tok.t === 'op' && UNARY.has(this.tok.v)) {
      const o = this.next().v;
      const a = this.unary();
      if (o === '+') return a;
      if (o === '-' && (a.op === 'int')) return { op: 'int', value: a.value.startsWith('-') ? a.value.slice(1) : '-' + a.value };
      return { op: 'unary', o, a };
    }
    return this.primary();
  }

  primary() {
    const t = this.tok;
    if (t.t === 'int') {
      this.next();
      // SystemVerilog size cast: 8'(expr)
      if (this.tok.t === 'cast') { this.next(); this.expect('('); const e = this.expr(); this.expect(')'); return { op: 'call', name: '$__size_cast', args: [{ op: 'int', value: t.v }, e] }; }
      return { op: 'int', value: t.v };
    }
    if (t.t === 'real') { this.next(); return { op: 'real', value: t.v }; }
    if (t.t === 'based') { this.next(); const { bits, sized } = basedToBits(t); return { op: 'lit', bits, signed: t.signed, sized }; }
    if (t.t === 'fill') { this.next(); return { op: 'fill', bit: t.v }; }
    if (t.t === 'str') { this.next(); return { op: 'str', value: t.v }; }
    if (t.t === 'sys') {
      this.next();
      const args = [];
      if (this.accept('(')) { if (!this.is(')')) do { args.push(this.expr()); } while (this.accept(',')); this.expect(')'); }
      return { op: 'call', name: t.v, args };
    }
    if (this.is('(')) {
      this.next(); const e = this.expr(); this.expect(')');
      return e;
    }
    if (this.is('{')) {
      this.next();
      const first = this.expr();
      if (this.is('{')) { // replication
        this.next();
        const parts = [];
        do { parts.push(this.expr()); } while (this.accept(','));
        this.expect('}'); this.expect('}');
        return { op: 'repl', count: first, value: parts.length === 1 ? parts[0] : { op: 'concat', parts } };
      }
      const parts = [first];
      while (this.accept(',')) parts.push(this.expr());
      this.expect('}');
      return this.postfix({ op: 'concat', parts });
    }
    if (t.t === 'id') {
      const name = this.hierName();
      if (this.is('(')) {
        this.next();
        const args = [];
        if (!this.is(')')) do { args.push(this.expr()); } while (this.accept(','));
        this.expect(')');
        return { op: 'call', name, args };
      }
      return this.postfix({ op: 'ref', name });
    }
    this.error(`unexpected '${t.v || t.t}' in expression`);
    throw new Sync();
  }

  postfix(base) {
    while (this.is('[')) {
      this.next();
      const a = this.expr();
      if (this.accept(':')) {
        const b = this.expr(); this.expect(']');
        base = { op: 'slice', base, left: a, right: b };
      } else if (this.is('+:') || this.is('-:')) {
        const dir = this.next().v[0];
        const width = this.expr(); this.expect(']');
        base = { op: 'pslice', base, start: a, width, dir };
      } else {
        this.expect(']');
        base = { op: 'index', base, index: a };
      }
    }
    return base;
  }
}
