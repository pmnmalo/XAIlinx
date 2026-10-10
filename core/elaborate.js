// Elaboration: builds the instance hierarchy from parsed units, evaluates parameters/generics,
// unrolls generate blocks, resolves names and binds IR expressions/statements into executable
// nodes (see interp.js). Works for Verilog, VHDL and mixed designs.
//
// Bound expression nodes:  { k, t, ... }
//   c(val) sig(sig) loc(i) bit(base,index) elem(base,index) slice(base,lo) dslice(base,left,right)
//   pslice(base,start,dir) un(o,a) bin(o,a,b) cond(c,a,b) cat(parts) repl(count,a) conv(a,ext)
//   call(fn,args) sys(name,args) edge(sig,pos) event(sig) str(value) image(a) strcat(parts) arr(elems) now
// Bound statements: blk asg if case for forrange while repeat forever exit next ret null delay event wait task sys report assert
import * as V from './values.js';
import { evalE, runSync, exec, SimError, strToVal, bitpos } from './interp.js';
import { nativePrimitive } from './native.js';
import { mapBits } from './vhdl/parser.js';

export const INT = { kind: 'int', w: 32, s: true, left: 31, right: 0, desc: true };
export const BOOL = { kind: 'bool', w: 1, s: false, left: 0, right: 0, desc: true, scalar: true };
export const BIT = { kind: 'logic', w: 1, s: false, left: 0, right: 0, desc: true, scalar: true };
export const TIME = { kind: 'time', w: 64, s: true, left: 63, right: 0, desc: true };
export const REAL = { kind: 'real', w: 64, s: true, left: 63, right: 0, desc: true };
export const STR = { kind: 'str', w: 0, s: false };
// VHDL CHARACTER: an enumeration of the 256 ISO 8859-1 characters (values: the character codes)
export const CHAR = { kind: 'enum', name: 'character', char: true, names: Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)), w: 8, s: false, left: 7, right: 0, desc: true };
const charConst = ch => ({ k: 'c', val: V.fromInt(ch.charCodeAt(0) & 255, 8, false), t: CHAR });
// a character literal of a user enumeration type (type abc is ('A', 'B', 'C'))
function enumChar(t, ch) {
  const i = t.names.indexOf(`'${ch}'`);
  return i < 0 ? null : { k: 'c', val: V.fromInt(i, t.w, false), t };
}
export const vecT = (w, s = false) => ({ kind: 'logic', w, s, left: w - 1, right: 0, desc: true });

const PHYS = { fs: 0.001, ps: 1, ns: 1e3, us: 1e6, ms: 1e9, sec: 1e12, s: 1e12 };

class ElabError extends Error {
  constructor(msg, loc) { super(msg); this.loc = loc; }
}

class Scope {
  constructor(parent = null) { this.map = new Map(); this.parent = parent; }
  def(name, entry) { this.map.set(name, entry); return entry; }
  lookup(name) {
    for (let s = this; s; s = s.parent) { const e = s.map.get(name); if (e) return e; }
    return null;
  }
  local(name) { return this.map.get(name) || null; }
}

class FrameBuilder {
  constructor() { this.inits = []; this.types = []; }
  alloc(t, init) { this.inits.push(init); this.types.push(t); return this.inits.length - 1; }
  makeInit() {
    const inits = this.inits;
    return () => inits.map(v => (Array.isArray(v) ? v.slice() : v));
  }
  probe() { return this.inits.map(v => (Array.isArray(v) ? v.slice() : v)); }
}

// ---------------------------------------------------------------- library
export function buildLibrary(parsedFiles) {
  const lib = { modules: new Map(), packages: new Map(), errors: [], files: new Map() };
  const archs = [];
  for (const pf of parsedFiles) {
    lib.errors.push(...(pf.errors || []));
    for (const u of pf.units) {
      if (u.kind === 'module') {
        if (lib.modules.has(u.name) && !lib.modules.get(u.name).entityOnly)
          lib.errors.push({ file: u.file, line: u.loc?.line || 1, col: 1, severity: 'warning', message: `module '${u.name}' redefined (previous in ${lib.modules.get(u.name).file})` });
        lib.modules.set(u.name, u);
      } else if (u.kind === 'package') lib.packages.set(u.name, u);
      else if (u.kind === 'architecture') archs.push(u);
    }
  }
  for (const a of archs) {
    const ent = findModule(lib, a.entity);
    if (!ent) { lib.errors.push({ file: a.file, line: a.loc?.line || 1, col: 1, severity: 'error', message: `architecture '${a.name}' of unknown entity '${a.entity}'` }); continue; }
    ent.decls = [...(ent.decls || []), ...a.decls];
    ent.items = a.items;
    ent.uses = [...new Set([...(ent.uses || []), ...(a.uses || [])])];
    ent.archFile = a.file;
    if (a.slvArith) ent.slvArith = a.slvArith;
    delete ent.entityOnly;
  }
  return lib;
}

export function findModule(lib, name) {
  if (lib.modules.has(name)) return lib.modules.get(name);
  const ln = name.toLowerCase();
  for (const [k, m] of lib.modules) if (k.toLowerCase() === ln) return m;
  return null;
}

// Modules that are never instantiated by another module (top-level candidates).
export function topCandidates(lib) {
  const used = new Set();
  const visit = items => {
    for (const it of items || []) {
      if (it.kind === 'instance') used.add(it.module.toLowerCase());
      if (it.items) visit(it.items);
      if (it.then) visit(it.then);
      if (it.else) visit(it.else);
    }
  };
  for (const m of lib.modules.values()) visit(m.items);
  return [...lib.modules.values()].filter(m => !used.has(m.name.toLowerCase())).map(m => m.name);
}

// ---------------------------------------------------------------- elaboration entry
export function elaborate(lib, topName, opts = {}) {
  const design = {
    top: null, signals: [], procs: [], diags: [], lib,
    maxDepth: opts.maxDepth || 64,
  };
  const top = findModule(lib, topName);
  if (!top) {
    design.diags.push({ file: '', line: 1, col: 1, severity: 'error', message: `top module '${topName}' not found` });
    return design;
  }
  const ctx = { design, lib, pkgScopes: new Map() };
  try {
    // opts.generics: { NAME: integer } overrides the top module's generics / parameters
    const ov = new Map(Object.entries(opts.generics || {}).flatMap(([k, v]) => { const e = { val: V.fromInt(v, 32, true), t: INT }; return [[k, e], [k.toLowerCase(), e]]; }));
    design.top = elabInstance(ctx, top, top.name, top.name, ov, new Map(), null, 0);
  } catch (e) {
    if (!(e instanceof ElabError)) throw e;
    design.diags.push({ file: top.file, line: e.loc?.line || 1, col: e.loc?.col || 1, severity: 'error', message: e.message });
  }
  return design;
}

function diag(E, msg, loc, sev = 'error') {
  E.ctx.design.diags.push({ file: E.file, line: loc?.line || 1, col: loc?.col || 1, severity: sev, message: msg });
}

// ---------------------------------------------------------------- scopes for packages
const BUILTIN_VHDL = new Scope();
BUILTIN_VHDL.def('true', { kind: 'const', val: V.ONE, t: BOOL });
BUILTIN_VHDL.def('false', { kind: 'const', val: V.ZERO, t: BOOL });
for (const [n, sev] of [['note', 0], ['warning', 1], ['error', 2], ['failure', 3]]) BUILTIN_VHDL.def(n, { kind: 'const', val: V.fromInt(sev, 2, false), t: INT });
const BUILTIN_VLOG = new Scope();

function packageScope(ctx, name, file, loc, diagE) {
  if (ctx.pkgScopes.has(name)) return ctx.pkgScopes.get(name);
  const pkg = ctx.lib.packages.get(name) || [...ctx.lib.packages.values()].find(p => p.name.toLowerCase() === name.toLowerCase());
  if (!pkg) {
    if (diagE) diag(diagE, `package '${name}' not found`, loc);
    return null;
  }
  const sc = new Scope(usesScope(ctx, pkg, 'vhdl'));
  ctx.pkgScopes.set(name, sc);
  // package-level signals (e.g. SIMPRIM's GSR / GTS) belong to the package: one per design
  const pinst = { name: pkg.name, path: pkg.name, signals: [], procs: [], children: [], params: [], ports: [] };
  const E = { ctx, lang: 'vhdl', sc, inst: pinst, file: pkg.file, timeUnit: 1, fb: null, prefix: '', slvArith: pkg.slvArith };
  for (const d of pkg.decls) {
    try { bindDecl(E, d); } catch (e) { if (!(e instanceof ElabError)) throw e; diag(E, e.message, e.loc || d.loc); }
  }
  return sc;
}

function usesScope(ctx, mod, lang) {
  const base = lang === 'vhdl' ? BUILTIN_VHDL : BUILTIN_VLOG;
  if (!mod.uses || !mod.uses.length) return base;
  const sc = new Scope(base);
  for (const u of mod.uses) {
    const ps = packageScope(ctx, u, mod.file, mod.loc, { ctx, file: mod.file });
    if (ps) for (const [k, v] of ps.map) sc.def(k, v);
  }
  return sc;
}

// ---------------------------------------------------------------- instances
function elabInstance(ctx, mod, name, path, paramOverrides, portConns, parentInst, depth) {
  if (depth > ctx.design.maxDepth) throw new ElabError(`instance hierarchy too deep at ${path} (recursive instantiation?)`);
  const inst = {
    name, path, module: mod.name, lang: mod.lang, file: mod.archFile || mod.file, loc: mod.loc,
    params: [], ports: [], signals: [], children: [], procs: [], parent: parentInst, mod,
  };
  const E = {
    ctx, lang: mod.lang, sc: new Scope(usesScope(ctx, mod, mod.lang)), inst,
    file: inst.file, timeUnit: mod.timescale?.unit ?? (mod.lang === 'vhdl' ? 1 : 1000), fb: null, prefix: '', depth,
    timePrec: mod.lang === 'verilog' ? mod.timescale?.precision : undefined,   // delays round to the precision
    slvArith: mod.slvArith,   // VHDL: std_logic_vector arithmetic of std_logic_unsigned / std_logic_signed
  };
  // parameters / generics
  for (const p of mod.params) {
    let entry, given = false;   // given: set by the instance (generic map / #(…)), not the default
    try {
      const ov = paramOverrides.get(p.name) ?? paramOverrides.get(p.name.toLowerCase());
      const ptype = p.type ? elabType(E, p.type) : null;
      if (ov && !p.local) {
        given = true;
        entry = { kind: 'const', val: ov.val, t: ov.t };
        // a VHDL boolean generic set from Verilog: "TRUE" / "FALSE", as Xilinx writes boolean attributes
        if (ptype?.kind === 'bool' && /^(true|false)$/i.test(ov.val?.str ?? '')) entry = { kind: 'const', val: V.fromBool(/^true$/i.test(ov.val.str)), t: ptype };
        // an unconstrained generic (INIT : std_logic_vector) takes the actual's width
        else if (ptype && ptype.unconstrained && ov.t && ov.t.kind === ptype.kind) entry = { kind: 'const', val: ov.val, t: { ...ov.t, s: ptype.s } };
        else if (ptype && ptype.kind !== 'str') entry = { kind: 'const', val: fitVal(ov.val, ptype), t: ptype };
        else if (ptype && ov.text !== undefined) entry = { kind: 'const', val: { str: ov.text }, t: STR };   // NAME => "u1"
      } else if (p.default) {
        const n = bindExpr(E, p.default, ptype);
        const val = constOf(E, n, p.loc);
        entry = { kind: 'const', val: ptype && ptype.kind !== 'str' ? fitVal(val, ptype) : val, t: ptype || n.t };
      } else throw new ElabError(`generic '${p.name}' has no value`, mod.loc);
    } catch (e) {
      if (!(e instanceof ElabError)) throw e;
      diag(E, e.message, e.loc || mod.loc);
      entry = { kind: 'const', val: V.fromInt(0), t: INT };
    }
    E.sc.def(p.name, entry);
    inst.params.push({ name: p.name, value: entry.val, t: entry.t, given });
  }
  // declarations: types & constants first (they may size ports), then ports, then the rest
  // Functions are only registered here (bodies bind at call time), so constants may call them.
  const funcs = mod.decls.filter(d => d.kind === 'function' || d.kind === 'task');
  const early = mod.decls.filter(d => d.kind === 'type' || d.kind === 'const');
  const late = mod.decls.filter(d => !['type', 'const', 'function', 'task'].includes(d.kind));
  for (const d of funcs) safe(E, d.loc, () => bindDecl(E, d));
  for (const d of early) safe(E, d.loc, () => bindDecl(E, d));
  for (const p of mod.ports) safe(E, p.loc, () => elabPort(E, p, portConns.get(p.name)));
  // Silinx's own netlist primitives (core/unisim.js) run as native processes (core/native.js)
  if (String(mod.file || '').startsWith('<silinx>/')) {
    const nat = nativePrimitive(mod.name, inst.params, inst.ports);
    if (nat) {
      // (an output connected to a whole Verilog net is that net: it starts at the primitive's
      // INIT, not at the x of a driven net)
      for (const [sig, v] of nat.init) { sig.init = v; sig.val = v; sig.netZ = false; }
      const proc = addProc(E, { name: mod.name.toUpperCase(), kind: 'native', mode: 'native', native: nat.fn, body: { k: 'null' },
        triggers: nat.inputs.map((sig) => ({ sig, edge: 'any' })), lang: 'vhdl', loc: mod.loc, file: inst.file, inst });
      proc.writes = new Set(nat.outputs);
      return inst;
    }
  }
  for (const d of late) safe(E, d.loc, () => bindDecl(E, d));
  // Verilog defparam: overrides for the parameters of instances below this one (path, value)
  E.defparams = [...(paramOverrides.defparams || [])];
  for (const it of mod.items || []) {
    if (it.kind !== 'defparam') continue;
    safe(E, it.loc, () => {
      const n = bindExpr(E, it.value, null, it.loc);
      E.defparams.push({ path: it.path.split('.'), val: constOf(E, n, it.loc), t: n.t });
    });
  }
  elabItems(E, mod.items);
  return inst;
}

function safe(E, loc, fn) {
  try { return fn(); }
  catch (e) {
    if (e instanceof ElabError || e instanceof SimError) { diag(E, e.message, e.loc || loc); return null; }
    throw e;
  }
}

function newSignal(E, name, t, init, kind, loc) {
  const d = E.ctx.design;
  const sig = {
    id: d.signals.length, name, path: `${E.inst.path}.${name}`, t, inst: E.inst, kind,
    init, val: init, prev: null, evStamp: -1, lastT: undefined, waiters: null, wave: null, loc, file: E.file,
  };
  d.signals.push(sig);
  E.inst.signals.push(sig);
  return sig;
}

function elabPort(E, p, conn) {
  const t = elabType(E, p.type);
  let init = defaultValue(t, E.lang);
  if (p.default) init = fitAny(constOf(E, bindExpr(E, p.default, t), p.loc), t);
  if (conn && conn.node && conn.node.k === 'sig' && conn.node.t.w === t.w && (t.kind === 'array') === (conn.node.t.kind === 'array') && p.dir !== undefined) {
    const sig = conn.node.sig;
    // VHDL: the driver of an out port starts at the port's default; with the port aliased to its
    // actual that is the actual's initial value (unless the actual was given one itself)
    if (p.default && p.dir !== 'in' && E.lang === 'vhdl' && !sig.portInitSet && !sig.hasInit) {
      sig.init = init; sig.val = init; sig.portInitSet = true;
    }
    E.sc.def(p.name, { kind: 'sig', sig, t });
    E.inst.ports.push({ name: p.name, dir: p.dir, sig, t, alias: true, conn: conn.text });
    return;
  }
  const sig = newSignal(E, p.name, t, init, 'port', p.loc);
  sig.portDir = p.dir;
  E.sc.def(p.name, { kind: 'sig', sig, t });
  E.inst.ports.push({ name: p.name, dir: p.dir, sig, t, alias: false, conn: conn?.text ?? null });
  if (!conn) return;
  const pE = conn.E;
  if (conn.parts) {
    // sub-element associations: one connection per formal part (formal bound in this instance)
    for (const part of conn.parts) {
      const loc = conn.loc;
      if (p.dir === 'in' || (p.dir === 'inout' && !part.lnode)) {
        if (!part.node) continue;
        const target = bindLvalue(E, part.formal, loc);
        const value = part.node;
        if (pE.lang === 'verilog') ctxSize(value, target.t.w);
        const body = { k: 'asg', target, value, nb: false, delay: null, loc };
        addProc(E, { name: `${exprText(part.formal)}<=`, kind: 'glue', mode: 'comb', body, triggers: triggersOfReads(body), lang: 'verilog', loc, file: pE.file, inst: E.inst, glueOf: p.name });
      } else if (part.lnode) {
        const value = bindExpr(E, part.formal, null, loc);
        const body = { k: 'asg', target: part.lnode, value, nb: false, delay: null, loc };
        addProc(pE, { name: `${exprText(part.formal)}=>`, kind: 'glue', mode: 'comb', body, triggers: [{ sig, edge: 'any', pos: null }], lang: 'verilog', loc, file: pE.file, inst: pE.inst, glueOf: `${E.inst.name}.${p.name}` });
      }
    }
    return;
  }
  if (p.dir === 'in' || (p.dir === 'inout' && !conn.lnode)) {
    if (!conn.node) return;
    if (p.dir === 'inout') diag(E, `inout port '${p.name}' connected to an expression is treated as input`, p.loc, 'warning');
    let value = conn.node;
    if (pE.lang === 'verilog') ctxSize(value, t.w);
    const body = { k: 'asg', target: { k: 'sig', sig, t }, value, nb: false, delay: null, loc: conn.loc };
    addProc(E, { name: `${p.name}<=`, kind: 'glue', mode: 'comb', body, triggers: triggersOfReads(body), lang: 'verilog', loc: conn.loc, file: pE.file, inst: E.inst, glueOf: p.name });
  } else if (conn.lnode) {
    const body = { k: 'asg', target: conn.lnode, value: { k: 'sig', sig, t }, nb: false, delay: null, loc: conn.loc };
    addProc(pE, { name: `${p.name}=>`, kind: 'glue', mode: 'comb', body, triggers: [{ sig, edge: 'any' }], lang: 'verilog', loc: conn.loc, file: pE.file, inst: pE.inst, glueOf: `${E.inst.name}.${p.name}` });
  } else if (conn.node) {
    diag(pE, `output port '${p.name}' of '${E.inst.name}' is connected to a non-assignable expression`, conn.loc, 'warning');
  }
}

function addProc(E, proc) {
  proc.inst ||= E.inst;
  proc.id = E.ctx.design.procs.length;
  proc.timeUnit ??= E.timeUnit;
  const rw = collectRW(proc.body);
  proc.reads = rw.reads; proc.writes = rw.writes;
  E.ctx.design.procs.push(proc);
  proc.inst.procs.push(proc);
  return proc;
}

function elabItems(E, items) {
  for (const it of items) {
    safe(E, it.loc, () => {
      switch (it.kind) {
        case 'assign': return elabAssignItem(E, it);
        case 'process': return elabProcess(E, it);
        case 'instance': return elabChild(E, it);
        case 'generate_for': return elabGenFor(E, it);
        case 'generate_if': return elabGenIf(E, it);
        case 'decl': return bindDecl(E, it.decl);
        case 'defparam': return;   // (applied when the instance it names is elaborated)
        default: diag(E, `unsupported item '${it.kind}'`, it.loc, 'warning');
      }
    });
  }
}

function elabAssignItem(E, it) {
  // Verilog: an undeclared target of a continuous assignment is an implicit scalar net
  const target = bindLvalue(E.lang === 'verilog' ? { ...E, implicitNets: true } : E, it.target, it.loc);
  const value = bindExpr(E, it.value, target.t, it.loc);
  if (E.lang === 'verilog') ctxSize(value, target.t.w);
  checkAssignable(E, target, value, it.loc);
  const body = { k: 'asg', target, value, nb: E.lang === 'vhdl', delay: it.delay ? bindExpr(E, it.delay) : null, delayUnit: E.lang === 'vhdl' ? 1 : E.timeUnit, prec: E.timePrec, loc: it.loc };
  if (E.lang === 'vhdl') { Object.assign(body, vhdlMech(E, it)); rangeCheck(body); }
  else if (body.delay) body.inertial = true;   // Verilog: a change before the delay elapses replaces the pending one
  addProc(E, {
    name: `assign_${it.loc?.line ?? ''}`, kind: 'assign', mode: 'comb', body, triggers: triggersOfReads(body),
    lang: E.lang, loc: it.loc, file: E.file, item: it,
  });
}

function elabProcess(E, it) {
  const fb = new FrameBuilder();
  const PE = { ...E, sc: new Scope(E.sc), fb, inProcess: true };
  for (const d of it.decls || []) bindDecl(PE, d);
  const body = bindBlock(PE, it.body, it.loc);
  let mode, triggers = [];
  if (it.sens === null) mode = it.initial ? 'initial' : 'loop';
  else if (it.sens === 'all') { mode = 'comb'; triggers = triggersOfReads(body); }
  else {
    triggers = it.sens.flatMap(s => bindTrigger(PE, s.expr, s.edge, it.loc));
    const edged = triggers.some(t => t.edge !== 'any');
    mode = E.lang === 'vhdl' ? 'sens' : (edged ? 'wait-first' : 'comb');
  }
  const label = it.label || (it.initial ? `initial_${it.loc?.line}` : `${E.lang === 'vhdl' ? 'process' : 'always'}_${it.loc?.line}`);
  addProc(E, {
    name: E.prefix + label, kind: 'process', mode, body, triggers, lang: E.lang, loc: it.loc, file: E.file,
    frameInit: fb.makeInit(), item: it, sens: it.sens,
  });
}

function elabChild(E, it) {
  const mod = findModule(E.ctx.lib, it.module);
  const name = E.prefix + it.name;
  // bind connection expressions in the parent scope
  const conns = [];
  const childPorts = mod ? mod.ports : [];
  const ci = !mod || mod.lang === 'vhdl' || E.lang === 'vhdl';
  it.conns.forEach((c, k) => {
    if (c.port === '*') {
      for (const p of childPorts) {
        if (conns.some(x => x.port === p.name)) continue;
        if (E.sc.lookup(p.name)) conns.push({ port: p.name, expr: { op: 'ref', name: p.name } });
      }
      return;
    }
    let pname = c.port;
    if (pname == null) {
      if (!mod) pname = `p${k}`;
      else if (k >= childPorts.length) { diag(E, `too many port connections for '${it.module}'`, it.loc); return; }
      else pname = childPorts[k].name;
    } else if (mod) {
      const p = childPorts.find(p => p.name === pname) || (ci && childPorts.find(p => p.name.toLowerCase() === pname.toLowerCase()));
      if (!p) { diag(E, `module '${mod.name}' has no port '${pname}'`, it.loc); return; }
      pname = p.name;
    }
    conns.push({ port: pname, expr: c.expr, formal: c.formal || null });
  });
  const portConns = new Map();
  for (const c of conns) {
    if (!c.expr) continue;
    const pdecl = childPorts.find(p => p.name === c.port);
    let node = null, lnode = null;
    try {
      node = bindExpr({ ...E, implicitNets: true }, c.expr, null, it.loc);
      if (pdecl && pdecl.dir !== 'in' && isLvalueExpr(c.expr)) lnode = bindLvalue({ ...E, implicitNets: true }, c.expr, it.loc);
    } catch (e) {
      if (!(e instanceof ElabError)) throw e;
      diag(E, e.message, e.loc || it.loc);
      continue;
    }
    if (c.formal) {
      // VHDL `P(3) => a, P(2) => b` / `P(7 downto 4) => x`: each sub-element formal connects its own bits
      let pc = portConns.get(c.port);
      if (!pc || !pc.parts) { pc = { parts: [], node: null, lnode: null, E, loc: it.loc, text: '' }; portConns.set(c.port, pc); }
      pc.parts.push({ formal: c.formal, node, lnode, text: exprText(c.expr) });
      pc.text = pc.parts.map(x => `${exprText(x.formal)} => ${x.text}`).join(', ');
      continue;
    }
    portConns.set(c.port, { node, lnode, E, loc: it.loc, text: exprText(c.expr) });
  }
  if (!mod) {
    diag(E, `module/entity '${it.module}' not found (instance '${it.name}')`, it.loc);
    const bb = { name, path: `${E.inst.path}.${name}`, module: it.module, lang: null, blackbox: true, ports: [], signals: [], children: [], procs: [], params: [], parent: E.inst, loc: it.loc, file: E.file };
    bb.connInfo = [...portConns].map(([port, c]) => ({ port, dir: 'inout', node: c.node, text: c.text, reads: readsOf(c.node) }));
    E.inst.children.push(bb);
    return;
  }
  // parameter overrides
  const ov = new Map();
  it.params.forEach((p, k) => {
    if (!p.value) return;
    let pname = p.name;
    if (pname == null) {
      const nonLocal = mod.params.filter(x => !x.local);
      if (k >= nonLocal.length) { diag(E, `too many parameter overrides for '${mod.name}'`, it.loc); return; }
      pname = nonLocal[k].name;
    } else {
      const decl = mod.params.find(x => x.name === pname || (ci && x.name.toLowerCase() === pname.toLowerCase()));
      if (!decl) {
        // Silinx's own primitive models (UNISIM / SIMPRIM) ignore attributes they do not model
        const prim = String(mod.file || '').startsWith('<silinx>/');
        diag(E, prim ? `primitive '${mod.name}': generic '${pname}' is not modelled, ignored` : `module '${mod.name}' has no parameter '${pname}'`, it.loc, prim ? 'warning' : undefined);
        return;
      }
      pname = decl.name;
    }
    const n = bindExpr(E, p.value, null, it.loc);
    ov.set(pname, { val: constOf(E, n, it.loc), t: n.t, text: n.strText });
  });
  // defparams naming this instance: its own parameters, and the ones further down (passed on)
  for (const dp of E.defparams || []) {
    if (dp.path[0] !== it.name || dp.path.length < 2) continue;
    if (dp.path.length > 2) { (ov.defparams ||= []).push({ ...dp, path: dp.path.slice(1) }); continue; }
    const decl = mod.params.find(x => x.name === dp.path[1] || (ci && x.name.toLowerCase() === dp.path[1].toLowerCase()));
    if (!decl) { diag(E, `defparam: module '${mod.name}' has no parameter '${dp.path[1]}'`, it.loc); continue; }
    ov.set(decl.name, { val: dp.val, t: dp.t });
  }
  const child = elabInstance(E.ctx, mod, name, `${E.inst.path}.${name}`, ov, portConns, E.inst, (E.depth || 0) + 1);
  child.loc = it.loc; child.instFile = E.file;
  child.connInfo = mod.ports.map(p => {
    const c = portConns.get(p.name);
    const port = child.ports.find(x => x.name === p.name);
    const parts = c?.parts || [];
    return {
      port: p.name, dir: p.dir, t: port?.t, text: c?.text ?? null, node: c?.node ?? null,
      reads: c?.node ? readsOf(c.node) : new Set(parts.flatMap(x => (x.node ? [...readsOf(x.node)] : []))),
      writes: c?.lnode ? writesOfL(c.lnode) : new Set(parts.flatMap(x => (x.lnode ? [...writesOfL(x.lnode)] : []))),
    };
  });
  for (const p of mod.ports) {
    if (p.dir === 'in' && !portConns.has(p.name) && !p.default)
      diag(E, `input port '${p.name}' of '${name}' is not connected`, it.loc, 'warning');
  }
  E.inst.children.push(child);
}

function elabGenFor(E, it) {
  const genScope = new Scope(E.sc);
  const GE0 = { ...E, sc: genScope };
  let i = constOf(GE0, bindExpr(GE0, it.init), it.loc);
  let guard = 0;
  for (;;) {
    const sc = new Scope(E.sc);
    sc.def(it.var, { kind: 'const', val: V.resize(V.withSign(i, true), 32), t: INT });
    const GE = { ...E, sc };
    if (!V.isTrue(constOf(GE, bindExpr(GE, it.cond), it.loc))) break;
    if (++guard > 4096) throw new ElabError('generate loop does not terminate', it.loc);
    const idx = V.toDec(i, true);
    GE.prefix = `${E.prefix}${it.label}[${idx}].`;
    for (const d of it.decls || []) safe(GE, d.loc, () => bindDecl(GE, d));
    elabItems(GE, it.items);
    i = constOf(GE, bindExpr(GE, it.step), it.loc);
  }
}

function elabGenIf(E, it) {
  const c = constOf(E, bindExpr(E, it.cond), it.loc);
  const sc = new Scope(E.sc);
  const GE = { ...E, sc, prefix: it.label ? `${E.prefix}${it.label}.` : E.prefix };
  if (V.isTrue(c)) {
    for (const d of it.decls || []) safe(GE, d.loc, () => bindDecl(GE, d));
    elabItems(GE, it.then);
  } else {
    for (const d of it.elseDecls || []) safe(GE, d.loc, () => bindDecl(GE, d));
    elabItems(GE, it.else || []);
  }
}

// ---------------------------------------------------------------- declarations
function bindDecl(E, d) {
  switch (d.kind) {
    case 'type': {
      if (d.type.kind === 'enum') {
        const n = d.type.values.length;
        const w = Math.max(1, Math.ceil(Math.log2(n)));
        const t = { kind: 'enum', name: d.name, names: d.type.values, w, s: false, left: w - 1, right: 0, desc: true };
        E.sc.def(d.name, { kind: 'type', t });
        d.type.values.forEach((nm, i) => E.sc.def(nm, { kind: 'const', val: V.fromInt(i, w, false), t }));
        return;
      }
      if (d.type.kind === 'array' && !d.type.range) {
        E.sc.def(d.name, { kind: 'type', t: null, unconstrained: d.type, name: d.name });
        return;
      }
      const t = { ...elabType(E, d.type), name: d.name };
      E.sc.def(d.name, { kind: 'type', t });
      return;
    }
    case 'const': {
      const t = d.type ? elabType(E, d.type, true) : null;
      const n = bindExpr(E, d.value, t, d.loc);
      if (E.lang === 'verilog' && t) ctxSize(n, t.w);
      let val = constOf(E, n, d.loc);
      let ft = t;
      if (!t || (t.kind === 'logic' && t.unconstrained)) ft = n.t;
      else val = fitAny(val, t);
      E.sc.def(d.name, { kind: 'const', val, t: ft });
      return;
    }
    case 'signal': {
      const t = elabType(E, d.type);
      let init = defaultValue(t, E.lang, d.net);
      if (d.init) {
        const n = bindExpr(E, d.init, t, d.loc);
        if (E.lang === 'verilog') ctxSize(n, t.w);
        init = fitAny(constOf(E, n, d.loc), t);
      }
      if (E.fb && (d.net === 'variable' || E.inProcess)) {
        const i = E.fb.alloc(t, init);
        E.sc.def(d.name, { kind: 'loc', i, t });
        return;
      }
      if (E.sc.local(d.name) && E.sc.local(d.name).kind === 'sig') { diag(E, `'${d.name}' redeclared`, d.loc, 'warning'); return; }
      // Verilog: a net without drivers is z (tri0 / tri1: pulled to 0 / 1)
      if (E.lang === 'verilog' && d.net === 'wire' && !d.init && t.kind === 'logic') init = d.wired === 'tri0' ? V.zero(t.w) : d.wired === 'tri1' ? V.mk(t.w, V.mask(t.w)) : V.mk(t.w, V.mask(t.w), V.mask(t.w), t.s);
      const sig = newSignal(E, E.prefix + d.name, t, init, d.net === 'variable' ? 'var' : 'signal', d.loc);
      if (d.init) sig.hasInit = true;
      if (d.net === 'reg') sig.net = 'reg';   // (Verilog reg: a variable in VCD files)
      if (d.wired) sig.wired = d.wired;
      if (E.lang === 'verilog' && d.net === 'wire' && !d.init && t.kind === 'logic' && !d.wired) sig.netZ = true;   // (x once it has drivers)
      E.sc.def(d.name, { kind: 'sig', sig, t });
      return;
    }
    case 'function': case 'task': {
      const ent = { kind: 'func', decl: d, E: { ...E, fb: null, inProcess: false }, cache: new Map() };
      // VHDL overloading: subprograms of one name in one region (chosen per call: pickOverload)
      const prev = E.lang === 'vhdl' ? E.sc.local(d.name) : null;
      if (prev && prev.kind === 'func') ent.alts = [...(prev.alts || [prev]), ent];
      E.sc.def(d.name, ent);
      return;
    }
    case 'subalias': defSubAlias(E, d.name, d.target); return;
    case 'alias': {   // VHDL object alias: reads and writes go to the aliased object (or slice)
      // `alias f is g;` without a signature: an alias of subprogram g when g is one
      if (d.target.op === 'ref' && !d.type) {
        const te = E.sc.lookup(d.target.name);
        if (te ? te.kind === 'func' || te.kind === 'subalias' : BUILTIN_SUBPROGRAMS.has(d.target.name)) { defSubAlias(E, d.name, d.target.name); return; }
      }
      const rv = bindExpr(E, d.target, null, d.loc);
      const lv = isLvalueExpr(d.target) && rv.k !== 'c' ? bindLvalue(E, d.target, d.loc) : null;
      if (rv.k === 'c') { E.sc.def(d.name, { kind: 'const', val: rv.val, t: rv.t }); return; }
      E.sc.def(d.name, { kind: 'alias', rv, lv, t: rv.t });
      return;
    }
    default:
      return;
  }
}

function elabType(E, ts, allowUnconstrained = false) {
  switch (ts.kind) {
    case 'logic': {
      // mark: std_logic_vector / bit_vector (not the numeric_std unsigned / signed types)
      const mk = ts.mark ? { mark: ts.mark } : null;
      if (!ts.range) {
        if (ts.unconstrained) return { ...vecT(1, ts.signed), unconstrained: true, ...mk };
        return { ...BIT, s: !!ts.signed };
      }
      const { left, right, desc } = evalRange(E, ts.range);
      const w = Math.abs(left - right) + 1;
      return { kind: 'logic', w, s: !!ts.signed, left, right, desc, ...mk };
    }
    case 'integer': {
      const t = { ...INT };
      if (ts.range) {
        const r = evalRange(E, ts.range);
        t.rlo = Math.min(r.left, r.right); t.rhi = Math.max(r.left, r.right);
        if (r.left > r.right) t.rdown = true;   // `range 10 downto 0`: 'left is the high bound
      }
      return t;
    }
    case 'boolean': return BOOL;
    case 'time': return TIME;
    case 'real': return REAL;
    case 'string': return STR;
    case 'character': return CHAR;
    case 'array': {
      const elem = elabType(E, ts.elem);
      if (!ts.range) return { kind: 'array', unconstrained: true, elem, w: 0 };
      const { left, right, desc } = evalRange(E, ts.range);
      const lo = Math.min(left, right), len = Math.abs(left - right) + 1;
      if (len > 1 << 22) throw new ElabError(`array too large (${len} elements)`);
      return { kind: 'array', left, right, desc, lo, len, elem, w: elem.w };
    }
    case 'named': {
      const e = E.sc.lookup(ts.name);
      if (!e || e.kind !== 'type') {
        const std = stdTypeName(ts.name);
        if (std) return elabType(E, { ...std, range: ts.range || null });
        throw new ElabError(`unknown type '${ts.name}'`);
      }
      if (e.unconstrained) {
        if (!ts.range) {
          if (allowUnconstrained) return { kind: 'array', unconstrained: true, elem: elabType(E, e.unconstrained.elem), w: 0, name: e.name };
          throw new ElabError(`unconstrained type '${ts.name}' needs an index range`);
        }
        return { ...elabType(E, { ...e.unconstrained, range: ts.range }), name: e.name };
      }
      if (ts.range && e.t.kind === 'logic') return elabType(E, { kind: 'logic', range: ts.range, signed: e.t.s, mark: e.t.mark });
      return e.t;
    }
    case 'enum': throw new ElabError('anonymous enum types are not supported');
    case 'record': {
      // a record is an array of its fields (values: JS arrays), with one type per field
      const fields = ts.fields.map(f => ({ name: f.name, t: elabType(E, f.type) }));
      const n = fields.length;
      return { kind: 'array', fields, left: 0, right: n - 1, desc: false, lo: 0, len: n, elem: fields[0]?.t || INT, w: fields.reduce((a, f) => a + (f.t.w || 0), 0) };
    }
  }
  throw new ElabError(`unsupported type '${ts.kind}'`);
}

function stdTypeName(n) {
  switch (n.toLowerCase()) {
    case 'std_logic': case 'std_ulogic': case 'bit': return { kind: 'logic', range: null, signed: false };
    case 'std_logic_vector': case 'std_ulogic_vector': return { kind: 'logic', range: null, signed: false, unconstrained: true, mark: 'std_logic_vector' };
    case 'bit_vector': return { kind: 'logic', range: null, signed: false, unconstrained: true, mark: 'bit_vector' };
    case 'unsigned': return { kind: 'logic', range: null, signed: false, unconstrained: true };
    case 'signed': return { kind: 'logic', range: null, signed: true, unconstrained: true };
    case 'integer': return { kind: 'integer', range: null };
    case 'natural': case 'positive': {
      const lit = v => ({ op: 'int', value: String(v) });
      return { kind: 'integer', range: { left: lit(n.toLowerCase() === 'natural' ? 0 : 1), right: lit(2147483647), dir: 'to' } };
    }
    case 'boolean': return { kind: 'boolean' };
    case 'time': return { kind: 'time' };
    case 'real': return { kind: 'real' };
    case 'string': return { kind: 'string' };
    case 'character': return { kind: 'character' };
  }
  return null;
}

function evalRange(E, r) {
  if (r.of && r.of.op === 'ref' && (E.sc.lookup(r.of.name)?.kind === 'type' || (!E.sc.lookup(r.of.name) && stdTypeName(r.of.name)))) {
    // the range of a (sub)type: integer subtypes, enumerations, constrained vectors
    const te = E.sc.lookup(r.of.name);
    const t = te ? te.t : elabType(E, stdTypeName(r.of.name));
    if (!t) throw new ElabError(`'${r.of.name}' has no range`, r.of.loc);
    let lr;
    if (t.kind === 'int') lr = t.rdown ? [t.rhi ?? 2147483647, t.rlo ?? -2147483648] : [t.rlo ?? -2147483648, t.rhi ?? 2147483647];
    else if (t.kind === 'enum') lr = [0, t.names.length - 1];
    else if (t.kind === 'bool') lr = [0, 1];
    else lr = [t.left, t.right];
    const desc = t.kind === 'int' || t.kind === 'enum' || t.kind === 'bool' ? lr[0] > lr[1] : t.desc;
    if (r.reverse) return { left: lr[1], right: lr[0], desc: !desc };
    return { left: lr[0], right: lr[1], desc };
  }
  if (r.of) {
    const n = bindExpr(E, r.of, null);
    const t = n.t;
    if (t.kind === 'str') throw new ElabError("'range of a string is not supported (use std_logic_vector)", r.of.loc);
    if (r.reverse) return { left: t.right, right: t.left, desc: !t.desc };
    return { left: t.left, right: t.right, desc: t.desc };
  }
  const left = V.toNum(constOf(E, bindExpr(E, r.left), r.left.loc));
  const right = V.toNum(constOf(E, bindExpr(E, r.right), r.right.loc));
  const desc = r.dir ? r.dir === 'downto' : left >= right;
  return { left, right, desc };
}

export function defaultValue(t, lang, net) {
  switch (t.kind) {
    case 'logic': return V.allX(t.w, t.s);
    case 'int': {
      if (lang === 'verilog') return V.allX(32, true);
      return V.fromInt(t.rlo !== undefined ? (t.rdown ? t.rhi : t.rlo) : -2147483648, 32, true);
    }
    case 'bool': return V.ZERO;
    case 'enum': return V.mk(t.w, 0n);
    case 'time': return V.fromInt(0, 64, true);
    case 'real': return V.fromInt(0, 64, true);
    case 'str': return { str: '' };
    case 'array':
      if (t.fields) return t.fields.map(f => defaultValue(f.t, lang, net));
      return t.unconstrained ? [] : Array.from({ length: t.len }, () => defaultValue(t.elem, lang, net));
  }
  return V.allX(t.w || 1);
}

function fitVal(v, t) {
  if (v.str !== undefined || Array.isArray(v)) return v;
  return V.withSign(V.resize(v, t.w), t.s);
}
function fitAny(v, t) {
  if (t.kind === 'str') return v.str !== undefined ? v : { str: String(V.toDec(v)) };
  if (t.kind === 'array') {
    if (!Array.isArray(v)) throw new ElabError('array value expected');
    return v.map((e, k) => fitAny(e, t.fields ? t.fields[k].t : t.elem));
  }
  if (v.str !== undefined) return fitVal(strToVal(v.str), t);
  return fitVal(v, t);
}

// ---------------------------------------------------------------- constant evaluation
function constCtx() { return { frame: [], sim: null, depth: 0 }; }

function constOf(E, n, loc) {
  if (n.k === 'c') return n.val;
  if (!isConstNode(n)) throw new ElabError('expression is not constant', loc);
  try { return evalE(n, constCtx()); }
  catch (e) { throw new ElabError(e.message, loc); }
}

function isConstNode(n) {
  switch (n.k) {
    case 'c': case 'str': return true;
    case 'sig': case 'loc': case 'edge': case 'event': case 'sys': case 'now': case 'sigattr': return false;
    case 'chr': return isConstNode(n.base) && isConstNode(n.index);
    case 'strlen': return isConstNode(n.a);
    case 'call': return !n.fn.impure && n.args.every(isConstNode);
    default:
      for (const key of ['a', 'b', 'c', 'base', 'index', 'left', 'right', 'start', 'count']) if (n[key] && typeof n[key] === 'object' && n[key].k && !isConstNode(n[key])) return false;
      for (const key of ['parts', 'elems', 'args']) if (n[key] && !n[key].every(isConstNode)) return false;
      return true;
  }
}

function fold(n) {
  if (n.k !== 'c' && isConstNode(n) && n.k !== 'str') {
    try {
      const v = evalE(n, constCtx());
      // src: the expression, re-evaluated if Verilog context sizing widens it (ctxSize)
      return { k: 'c', val: v, t: n.t, src: n };
    } catch { return n; }
  }
  return n;
}

// Verilog context-determined sizing: propagate an evaluation width into the expression
// (self-determined operands are sized with their own width).
export function ctxSize(n, w) {
  if (!n || !n.t) return;
  const self = x => { if (x && x.t) ctxSize(x, x.t.w); };
  switch (n.k) {
    case 'bin': {
      const o = n.o;
      if (['==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(o)) {
        const m = Math.max(n.a.t.w, n.b.t.w);
        n.cw = m; ctxSize(n.a, m); ctxSize(n.b, m);
        return;
      }
      if (o === '&&' || o === '||') { self(n.a); self(n.b); return; }
      n.ew = Math.max(n.t.w, w);
      ctxSize(n.a, n.ew);
      if (!['<<', '>>', '<<<', '>>>', '**', 'rol', 'ror'].includes(o)) ctxSize(n.b, n.ew);
      else self(n.b);
      return;
    }
    case 'un':
      if (n.o === '~' || n.o === '-') { n.ew = Math.max(n.t.w, w); ctxSize(n.a, n.ew); }
      else self(n.a);
      return;
    case 'cond':
      n.ew = Math.max(n.t.w, w); self(n.c); ctxSize(n.a, n.ew); ctxSize(n.b, n.ew);
      return;
    case 'cat': for (const p of n.parts) self(p); return;
    case 'repl': self(n.a); return;
    case 'conv': self(n.a); return;
    case 'bit': case 'elem': self(n.index); return;
    case 'c':
      if (n.src) {
        // folded constant: size the original expression and evaluate it again
        ctxSize(n.src, w);
        try { n.val = evalE(n.src, constCtx()); } catch { /* keep the self-determined value */ }
      } else if (n.fillBit && w > n.val.w) {
        n.val = V.fromBits(n.fillBit.repeat(w));
      } else if (n.xext && w > n.val.w) {
        // unsized 'bx / 'bz: the x / z fills the context width
        const ext = V.mask(w) ^ V.mask(n.val.w);
        n.val = V.mk(w, n.val.v | (n.xext === 'z' ? ext : 0n), n.val.x | ext, n.val.s);
      }
      return;
  }
}

// ---------------------------------------------------------------- expressions
const ARITH = new Set(['+', '-', '*', '/', '%', 'mod', 'rem', '**']);
const BITWISE = new Set(['&', '|', '^', '~^', 'nand', 'nor']);
const CMP = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=']);
const SHIFT = new Set(['<<', '>>', '<<<', '>>>', 'rol', 'ror']);

function lookupOrErr(E, name, loc) {
  const e = E.sc.lookup(name);
  if (e) return e;
  return null;
}

// x'event / rising_edge(x) operand: a signal, or one bit of a vector signal (constant index)
function edgeOperand(node) {
  if (node && node.k === 'sig') return { sig: node.sig };
  if (node && node.k === 'bit' && node.base.k === 'sig' && node.index.k === 'c') return { sig: node.base.sig, bit: bitpos(node.base.t, V.toNum(node.index.val)) };
  return null;
}

// VHDL subprogram alias: the alias name stands for the subprogram (a user subprogram: the same
// entry; a built-in one: calls are redirected to its name)
function defSubAlias(E, name, target) {
  const te = E.sc.lookup(target);
  E.sc.def(name, te && (te.kind === 'func' || te.kind === 'subalias') ? te : { kind: 'subalias', target });
}

function refNode(E, entry, name) {
  switch (entry.kind) {
    case 'sig': return { k: 'sig', sig: entry.sig, t: entry.t || entry.sig.t, name };
    case 'const': return { k: 'c', val: entry.val, t: entry.t, name };
    case 'loc': return { k: 'loc', i: entry.i, t: entry.t, name };
    case 'alias': return entry.rv;   // VHDL signal parameter: the actual signal itself
  }
  return null;
}

export function bindExpr(E, e, expect = null, loc) {
  const n = bindExpr0(E, e, expect, loc);
  return n;
}

function bindExpr0(E, e, expect, loc) {
  loc = e.loc || loc;
  switch (e.op) {
    case 'lit': {
      if (E.lang === 'vhdl' && expect && expect.char && e.scalar && e.ch) return charConst(e.ch);
      if (E.lang === 'vhdl' && expect && expect.kind === 'enum' && e.scalar && e.ch) { const c = enumChar(expect, e.ch); if (c) return c; }
      if (E.lang === 'vhdl' && expect && expect.kind === 'str' && e.text !== undefined) return { k: 'str', value: e.text, t: STR };
      if (E.lang === 'vhdl' && expect && expect.kind === 'str' && !e.scalar && /^[01]+$/.test(e.bits)) return { k: 'str', value: e.bits, t: STR };
      const val = V.fromBits(e.bits, !!e.signed);
      const t = e.scalar ? BIT : vecT(val.w, !!e.signed);
      if (E.lang === 'verilog' && e.sized === false && /^[xz]/.test(e.bits)) return { k: 'c', val, t, xext: e.bits[0] };
      if (E.lang === 'vhdl' && e.scalar && expect && expect.kind === 'logic' && expect.w > 1 && !expect.unconstrained) {
        // e.g. assigning '0' where a vector is expected is an error in VHDL; be lenient and extend
        return { k: 'c', val: V.resize(val, expect.w), t: expect };
      }
      if (E.lang === 'vhdl' && !e.scalar && e.sized) return { k: 'c', val, t, strText: e.text ?? e.bits };
      return { k: 'c', val, t };
    }
    case 'int': {
      const b = BigInt(e.value);
      if (E.lang === 'vhdl') return { k: 'c', val: V.mk(32, BigInt.asUintN(32, b), 0n, true), t: INT };
      let w = 32;
      while ((b >= 0n ? b >= 1n << BigInt(w - 1) : -b > 1n << BigInt(w - 1))) w += 32;
      return { k: 'c', val: V.mk(w, BigInt.asUintN(w, b), 0n, true), t: w === 32 ? INT : vecT(w, true) };
    }
    case 'real': return { k: 'c', val: V.real(e.value), t: REAL };
    case 'phys': {
      const ps = Math.round(e.value * (PHYS[e.unit] ?? 1));
      return { k: 'c', val: V.fromInt(ps, 64, true), t: TIME };
    }
    case 'str': {
      if (E.lang === 'verilog' && expect && expect.kind === 'logic') return { k: 'c', val: strToVal(e.value), t: vecT(Math.max(8, e.value.length * 8)) };
      if (E.lang === 'vhdl' && e.char && expect && expect.char) return charConst(e.value);
      if (E.lang === 'vhdl' && e.char && expect && expect.kind === 'enum') { const c = enumChar(expect, e.value); if (c) return c; }
      // a string of std_logic characters where a vector is expected (in a report message, say)
      if (E.lang === 'vhdl' && expect && expect.kind === 'logic' && !e.char) return strAsLogic({ k: 'str', value: e.value, t: STR }, { t: expect });
      return { k: 'str', value: e.value, t: STR };
    }
    case 'fill': {
      const w = expect ? expect.w : 1;
      const bit = e.bit;
      // ('0 '1 'x 'z: in a context-determined expression the fill extends to the context width)
      return { k: 'c', val: V.fromBits(bit.repeat(w)), t: expect || BIT, fillBit: bit };
    }
    case 'ref': {
      const entry = lookupOrErr(E, e.name, loc);
      if (entry?.kind === 'subalias') return bindExpr0(E, { ...e, name: entry.target }, expect, loc);
      if (entry) {
        const n = refNode(E, entry, e.name);
        if (n) return n;
        if (entry.kind === 'func') return bindCall(E, entry, [], e.name, loc);
        if (entry.kind === 'type') throw new ElabError(`type '${e.name}' used as a value`, loc);
      }
      if (E.lang === 'vhdl' && e.name === 'now') return { k: 'now', t: TIME, unit: 1 };
      if (E.implicitNets && E.lang === 'verilog' && E.inst && !e.name.includes('.')) {
        diag(E, `implicit net '${e.name}' (declare it with 'wire')`, loc, 'warning');
        const sig = newSignal(E, E.prefix + e.name, BIT, V.allX(1), 'signal', loc);
        E.sc.def(e.name, { kind: 'sig', sig, t: BIT });
        return { k: 'sig', sig, t: BIT, name: e.name };
      }
      if (e.name.includes('.')) {
        // a signal of a generate block of this instance (blk[2].t)
        const gs = E.inst.signals.find(x => x.name === E.prefix + e.name) || E.inst.signals.find(x => x.name === e.name);
        if (gs) return { k: 'sig', sig: gs, t: gs.t, name: e.name };
        const hs = hierLookup(E, e.name);
        if (hs) return { k: 'sig', sig: hs, t: hs.t, name: e.name };
      }
      throw new ElabError(`'${e.name}' is not declared`, loc);
    }
    case 'index': {
      const base = bindExpr(E, e.base, null, loc);
      return fold(indexNode(E, base, e.index, loc));
    }
    case 'slice': {
      const base = bindExpr(E, e.base, null, loc);
      return fold(sliceNode(E, base, e.left, e.right, loc));
    }
    case 'pslice': {
      const base = bindExpr(E, e.base, null, loc);
      const w = V.toNum(constOf(E, bindExpr(E, e.width), loc));
      const start = bindExpr(E, e.start, null, loc);
      return fold({ k: 'pslice', base, start, dir: e.dir, t: vecT(w) });
    }
    case 'apply': return bindApply(E, e, expect, loc);
    case 'call': return bindVlogCall(E, e, expect, loc);
    case 'concat': {
      let parts = e.parts.map(p => bindExpr(E, p, null, loc));
      if (E.lang === 'vhdl' && parts.some(p => p.t.kind === 'str' || p.t.char)) {
        // "ab" & "-" & 'c': the string literals made of std_logic characters are strings here
        parts = parts.map((p, k) => (p.k === 'c' && p.t.kind === 'logic' && !p.src && (p.strText !== undefined || e.parts[k].ch)
          ? { k: 'str', value: p.strText ?? e.parts[k].ch, t: STR } : p));
        return { k: 'strcat', parts, t: STR };
      }
      if (E.lang === 'verilog') parts = parts.map(p => (p.k === 'str' ? { k: 'c', val: strToVal(p.value), t: vecT(Math.max(8, p.value.length * 8)) } : p));
      if (parts.some(p => p.t.kind === 'str')) return { k: 'strcat', parts, t: STR };
      if (parts.length === 1 && E.lang === 'verilog') return { k: 'conv', a: parts[0], ext: false, t: vecT(parts[0].t.w) };
      const w = parts.reduce((a, p) => a + p.t.w, 0);
      return fold({ k: 'cat', parts, t: vecT(w) });
    }
    case 'repl': {
      const count = bindExpr(E, e.count, null, loc);
      const n = V.toNum(constOf(E, count, loc));
      const a = bindExpr(E, e.value, null, loc);
      return fold({ k: 'repl', count: { k: 'c', val: V.fromInt(n), t: INT }, a, t: vecT(n * a.t.w) });
    }
    case 'unary': {
      const a = bindExpr(E, e.a, expect, loc);
      let t;
      if (e.o === '+' && E.lang === 'vhdl') return a;
      if (a.t.kind === 'real' && (e.o === '-' || e.o === 'abs')) return fold({ k: 'un', o: e.o, a, t: REAL, fp: true });
      if (e.o === '~' || e.o === '-' || e.o === 'abs') t = a.t.kind === 'bool' ? BOOL : (a.t.kind === 'int' || a.t.kind === 'time' ? a.t : vecT(a.t.w, a.t.s));
      else t = E.lang === 'vhdl' && e.o === '!' ? BOOL : BIT;
      if (e.o === '~' && a.t.kind === 'logic' && a.t.scalar) t = BIT;
      return fold({ k: 'un', o: e.o, a, t });
    }
    case 'binary': return fold(bindBinary(E, e, expect, loc));
    case 'cond': {
      const c = bindExpr(E, e.cond, null, loc);
      const a = bindExpr(E, e.then, expect, loc), b = bindExpr(E, e.else, expect, loc);
      const w = Math.max(a.t.w, b.t.w);
      let t = a.t.kind === b.t.kind && a.t.w === b.t.w ? a.t : vecT(w, a.t.s && b.t.s);
      if (a.t.kind === 'array' || a.t.kind === 'str') t = a.t;
      // VHDL `x when c else y`: a condition that is not true selects the else value
      return fold({ k: 'cond', c, a, b, t, vh: E.lang === 'vhdl' });
    }
    case 'attr': return bindAttr(E, e, loc);
    case 'field': return fold(fieldNode(E, bindExpr(E, e.base, null, loc), e.name, loc));
    case 'aggregate': return bindAggregate(E, e, expect, loc);
    case 'qualified': {
      const te = E.sc.lookup(e.type);
      const sn = stdTypeName(e.type);
      let t = te && te.kind === 'type' ? te.t : null;
      // unsigned'(0 => x) / std_logic_vector'(a, b): the aggregate's own length gives the width
      if (!t && sn && e.expr.op === 'aggregate' && e.expr.items.length && e.expr.items.every(i => !i.choices || i.choices.every(c => c && c.op === 'int'))) {
        const n = Math.max(e.expr.items.length, ...e.expr.items.flatMap(i => (i.choices || []).map(c => Number(c.value) + 1)));
        t = vecT(n, !!sn.signed);
      }
      let inner = bindExpr(E, e.expr, t || expect, loc);
      if (sn && sn.kind === 'logic' && inner.k === 'str') inner = strAsLogic(inner, { t: vecT(1) });
      if (sn && inner.t.kind === 'logic') return fold({ k: 'conv', a: inner, ext: inner.t.s, t: { ...inner.t, s: !!sn.signed } });
      return inner;
    }
  }
  throw new ElabError(`unsupported expression '${e.op}'`, loc);
}

// VHDL record element selection r.f: the element of the record (an array of its fields)
function fieldNode(E, base, name, loc) {
  const F = base.t.fields;
  if (!F) throw new ElabError(`'${name}' selected from an expression that is not a record`, loc);
  const k = F.findIndex(f => f.name === name);
  if (k < 0) throw new ElabError(`record has no field '${name}'`, loc);
  return { k: 'elem', base, index: { k: 'c', val: V.fromInt(k), t: INT }, t: F[k].t };
}

function hierLookup(E, name) {
  // Verilog hierarchical reference relative to current instance or from the top.
  const parts = name.split('.');
  let inst = E.inst;
  const findChild = (i, n) => i.children.find(c => c.name === n);
  // walk up to find the first component
  let start = inst;
  while (start && !findChild(start, parts[0]) && start.name !== parts[0]) start = start.parent;
  if (!start) return null;
  let cur = start.name === parts[0] && !findChild(start, parts[0]) ? start : findChild(start, parts[0]);
  for (let k = 1; k < parts.length - 1 && cur; k++) cur = findChild(cur, parts[k]);
  if (!cur) return null;
  const sn = parts[parts.length - 1];
  return cur.signals.find(s => s.name === sn) || cur.ports.find(p => p.name === sn)?.sig || null;
}

function indexNode(E, base, idxExpr, loc) {
  const index = bindExpr(E, idxExpr, null, loc);
  // (chk: VHDL, an index outside the range of the array is a run-time error)
  if (base.t.kind === 'array') return { k: 'elem', base, index, t: base.t.elem, ...(E.lang === 'vhdl' ? { chk: true } : {}) };
  if (base.t.kind === 'str') return { k: 'chr', base, index, t: CHAR };   // s(i): a CHARACTER
  if (index.k === 'c' && !index.val.x) {
    const p = bitpos(base.t, V.toNum(index.val));
    if (p < 0 || p >= base.t.w) diag(E, `index ${V.toDec(index.val, true)} out of range for '${base.name || 'expression'}'`, loc, 'warning');
  }
  return { k: 'bit', base, index, t: BIT, ...(E.lang === 'vhdl' ? { chk: true } : {}) };
}

function sliceNode(E, base, leftE, rightE, loc) {
  if (base.t.kind === 'array') throw new ElabError('array slices are not supported', loc);
  const left = bindExpr(E, leftE, null, loc), right = bindExpr(E, rightE, null, loc);
  if (left.k === 'c' && right.k === 'c') {
    const p1 = bitpos(base.t, V.toNum(left.val)), p2 = bitpos(base.t, V.toNum(right.val));
    const lo = Math.min(p1, p2), w = Math.abs(p1 - p2) + 1;
    if (lo < 0 || lo + w > base.t.w) diag(E, `slice out of range for '${base.name || 'expression'}'`, loc, 'warning');
    // (Verilog: a part-select is unsigned, even of a signed vector; VHDL: a slice keeps the type)
    return { k: 'slice', base, lo, t: { ...vecT(w, base.t.kind === 'logic' && E.lang === 'vhdl' ? base.t.s : false), ...(base.t.mark ? { mark: base.t.mark } : {}) } };
  }
  // dynamic slice: width from a probe evaluation (loop variables at their initial values)
  let w;
  try {
    // (probe: loop variables are not at real values yet, so no run-time checks)
    const ctx = { frame: E.fb ? E.fb.probe() : [], sim: null, depth: 0, probe: true };
    w = Math.abs(V.toNum(evalE(left, ctx)) - V.toNum(evalE(right, ctx))) + 1;
  } catch {
    throw new ElabError('slice bounds must be constant (or depend only on loop variables)', loc);
  }
  return { k: 'dslice', base, left, right, t: vecT(w) };
}

// A VHDL string literal of std_logic characters (kept as a string inside report / assert
// messages) compared with a vector is a vector literal.
function strAsLogic(n, other) {
  if (n.k !== 'str' || other.t.kind !== 'logic' || !/^[01uxzwlh-]+$/i.test(n.value)) return n;
  const val = V.fromBits(mapBits(n.value));
  return { k: 'c', val, t: vecT(val.w) };
}

// std_logic_signed: std_logic_vector operands of arithmetic and comparisons are signed
function slvNum(E, n) {
  if (E.slvArith !== 'signed' || n.t.kind !== 'logic' || n.t.mark !== 'std_logic_vector' || n.t.s) return n;
  return fold({ k: 'conv', a: n, ext: true, t: { ...n.t, s: true } });
}

// std_logic_arith mixes unsigned and signed operands as signed: the unsigned one is extended
// with a 0 sign bit (numeric_std does not allow the mix, so this never changes its results)
function mixedSign(a, b) {
  if (a.t.kind !== 'logic' || b.t.kind !== 'logic' || !!a.t.s === !!b.t.s) return [a, b];
  const widen = n => fold({ k: 'conv', a: n, ext: false, t: vecT(n.t.w + 1, true) });
  return a.t.s ? [a, widen(b)] : [widen(a), b];
}

function harmonizeVhdl(a, b) {
  // numeric_std: vector op integer -> integer converted to the vector's width
  if (a.t.kind === 'logic' && (b.t.kind === 'int')) b = fold({ k: 'conv', a: b, ext: true, t: vecT(a.t.w, a.t.s) });
  else if (b.t.kind === 'logic' && (a.t.kind === 'int')) a = fold({ k: 'conv', a, ext: true, t: vecT(b.t.w, b.t.s) });
  return [a, b];
}

function bindBinary(E, e, expect, loc) {
  const o = e.o;
  let a, b;
  if (e.a.op === 'aggregate' && e.b.op !== 'aggregate') { b = bindExpr(E, e.b, null, loc); a = bindExpr(E, e.a, b.t, loc); }
  else { a = bindExpr(E, e.a, ARITH.has(o) || BITWISE.has(o) ? expect : null, loc); b = bindExpr(E, e.b, a.t.kind === 'logic' || a.t.kind === 'enum' ? a.t : null, loc); }
  if (E.lang === 'vhdl' && (BITWISE.has(o) || ARITH.has(o))) { a = strAsLogic(a, b); b = strAsLogic(b, a); }
  if (E.lang === 'vhdl' && (ARITH.has(o) || CMP.has(o))) { a = slvNum(E, a); b = slvNum(E, b); }
  // REAL operands: floating point (time * real, real / real, comparisons...)
  const fp = a.t.kind === 'real' || b.t.kind === 'real';
  if (fp && CMP.has(o)) return { k: 'bin', o, a, b, t: E.lang === 'vhdl' ? BOOL : BIT, fp };
  if (fp && (ARITH.has(o))) return { k: 'bin', o, a, b, t: a.t.kind === 'time' || b.t.kind === 'time' ? TIME : REAL, fp };
  if (CMP.has(o)) {
    if (E.lang === 'vhdl' && a.t.kind === 'enum' && b.k === 'c') b = { ...b, t: a.t };
    if (E.lang === 'vhdl') { a = strAsLogic(a, b); b = strAsLogic(b, a); [a, b] = mixedSign(a, b); }
    // std_logic_1164 '=' on std_logic_vector (no std_logic_unsigned / _signed): arrays of
    // different lengths are never equal (IEEE 1076 §9.2.3)
    if (E.lang === 'vhdl' && !E.slvArith && (o === '==' || o === '!=') && a.t.kind === 'logic' && b.t.kind === 'logic' &&
        (a.t.mark || b.t.mark) && a.t.w !== b.t.w) return { k: 'c', val: V.fromBool(o === '!='), t: BOOL };
    // VHDL '=' / '/=' compare the enumeration values exactly ('X' = 'X' is true, 'U' /= '1' too);
    // the matching ?= / ?/= treat '-' (constant) bits as don't cares
    if (E.lang === 'vhdl') return { k: 'bin', o, a, b, t: BOOL, vh: o === '==' || o === '!=', ...(e.match && a.t.kind === 'logic' ? { match: true } : {}) };
    return { k: 'bin', o, a, b, t: BIT };
  }
  if (o === '&&' || o === '||') return { k: 'bin', o, a, b, t: BIT };
  if (SHIFT.has(o)) {
    const n = { k: 'bin', o, a, b, t: a.t.kind === 'int' ? a.t : { ...vecT(a.t.w, a.t.s), ...(a.t.mark ? { mark: a.t.mark } : {}) } };
    // VHDL sll/srl/sla/sra/rol/ror: a negative count shifts the other way; bit_vector sla / sra
    // replicate the rightmost / leftmost bit (numeric_std's sla / sra are shift_left / shift_right)
    if (E.lang === 'vhdl') { n.vs = true; if (a.t.mark === 'bit_vector') n.fill = true; }
    return n;
  }
  if (E.lang === 'vhdl' && (ARITH.has(o) && o !== '**')) [a, b] = harmonizeVhdl(a, b);
  if (E.lang === 'vhdl' && ARITH.has(o) && o !== '**') [a, b] = mixedSign(a, b);
  const s = a.t.s && b.t.s;
  if (a.t.kind === 'int' && b.t.kind === 'int') {
    // VHDL INTEGER: division by zero and results outside the 32-bit range are run-time errors
    const chk = E.lang !== 'vhdl' ? {} : o === '/' || o === 'mod' || o === 'rem' ? { dz: true } : o === '+' || o === '-' || o === '*' ? { ov: true } : {};
    return { k: 'bin', o, a, b, t: INT, ...chk };
  }
  if (a.t.kind === 'time' && b.t.kind === 'time' && o === '/') return { k: 'bin', o, a, b: { ...b, t: { ...b.t, s: true } }, t: { ...INT, w: 64 } };   // time / time: universal integer
  if (a.t.kind === 'time' || b.t.kind === 'time') return { k: 'bin', o, a, b, t: TIME };
  if (o === '**') return { k: 'bin', o, a, b, t: a.t.kind === 'int' ? INT : vecT(a.t.w, a.t.s) };
  let w = Math.max(a.t.w, b.t.w);
  if (o === '*' && E.lang === 'vhdl') w = a.t.w + b.t.w;
  // (VHDL boolean and / or / nand / nor are short-circuit operators: sc)
  if (BITWISE.has(o) && a.t.kind === 'bool' && b.t.kind === 'bool') return { k: 'bin', o, a, b, t: BOOL, ...(o !== '^' && o !== '~^' ? { sc: true } : {}) };
  const t = BITWISE.has(o) && w === 1 && (a.t.scalar || b.t.scalar) ? BIT : vecT(w, s);
  return { k: 'bin', o, a, b, t };
}

function bindAttr(E, e, loc) {
  const at = e.attr.toLowerCase();
  if (at === 'image' || at === 'to_string') {
    const a = bindExpr(E, e.args[0], null, loc);
    // T'image(x): formatted as a value of T (boolean / enumeration prefixes)
    const pe = e.prefix.op === 'ref' ? E.sc.lookup(e.prefix.name) : null;
    const it = pe && pe.kind === 'type' && pe.t && (pe.t.kind === 'enum' || pe.t.kind === 'bool') ? pe.t
      : e.prefix.op === 'ref' && /^boolean$/i.test(e.prefix.name) ? BOOL : e.prefix.op === 'ref' && /^character$/i.test(e.prefix.name) ? CHAR : null;
    if (it === CHAR && a.k === 'str' && a.value.length === 1) return { k: 'image', a: charConst(a.value), t: STR, it };
    return { k: 'image', a, t: STR, ...(it ? { it } : {}), ...(at === 'to_string' ? { ts: true } : {}) };
  }
  // prefix could be a type name
  let t, node = null;
  if (e.prefix.op === 'ref') {
    const ent = E.sc.lookup(e.prefix.name);
    if (ent && ent.kind === 'type') t = ent.t;
    else if (!ent && stdTypeName(e.prefix.name)) t = elabType(E, stdTypeName(e.prefix.name));
  }
  if (!t) { node = bindExpr(E, e.prefix, null, loc); t = node.t; }
  const cint = n => ({ k: 'c', val: V.fromInt(n, 32, true), t: INT });
  // A'length(N) ... of a multi-dimensional array (an array of arrays): dimension N
  if (e.args.length && t.kind === 'array' && ['length', 'left', 'right', 'high', 'low', 'ascending'].includes(at)) {
    const dim = V.toNum(constOf(E, bindExpr(E, e.args[0], null, loc), loc));
    for (let k = 1; k < dim; k++) { if (t.elem?.kind !== 'array' && t.elem?.kind !== 'logic') throw new ElabError(`'${at}(${dim}): no dimension ${dim}`, loc); t = t.elem; }
  }
  if (t.kind === 'str' && at === 'length' && node) return { k: 'strlen', a: node, t: INT };
  if (t.kind === 'str' && at !== 'event') throw new ElabError(`'${at} of a string is not supported (use std_logic_vector)`, loc);
  if ((t.kind === 'int' || t.kind === 'enum' || t.kind === 'bool') && ['left', 'right', 'high', 'low'].includes(at)) {
    // scalar types: bounds of the range (integer ranges are ascending here)
    const lo = t.kind === 'int' ? (t.rlo ?? -2147483648) : 0;
    const hi = t.kind === 'int' ? (t.rhi ?? 2147483647) : t.kind === 'bool' ? 1 : t.names.length - 1;
    const v = at === 'low' || (at === 'left') !== !!t.rdown ? lo : hi;
    return t.kind === 'int' ? cint(v) : { k: 'c', val: V.fromInt(v, t.w, false), t };
  }
  switch (at) {
    case 'event':
      if (!edgeOperand(node)) throw new ElabError("'event requires a signal", loc);
      return { k: 'event', ...edgeOperand(node), t: BOOL };
    case 'length': return cint(t.kind === 'array' ? t.len : t.w);
    case 'ascending': return { k: 'c', val: V.fromBool(t.kind === 'int' || t.kind === 'enum' || t.kind === 'bool' ? true : !t.desc), t: BOOL };
    case 'left': return cint(t.left);
    case 'right': return cint(t.right);
    case 'high': return cint(Math.max(t.left, t.right));
    case 'low': return cint(Math.min(t.left, t.right));
    case 'pos': return fold({ k: 'conv', a: bindExpr(E, e.args[0], t, loc), ext: false, t: INT });
    case 'val': return fold({ k: 'conv', a: bindExpr(E, e.args[0], null, loc), ext: true, t });
    case 'succ': case 'pred': case 'leftof': case 'rightof': {
      // (scalar types are ascending here: 'leftof is 'pred, 'rightof is 'succ)
      const a = bindExpr(E, e.args[0], null, loc);
      const up = at === 'succ' || at === 'rightof';
      if (t.kind === 'int') return fold({ k: 'bin', o: up ? '+' : '-', a, b: cint(1), t: INT });
      return fold({ k: 'bin', o: up ? '+' : '-', a, b: { k: 'c', val: V.fromInt(1, a.t.w, false), t: vecT(a.t.w) }, t });
    }
    case 'value': {   // T'value("text") of a constant string
      const a = bindExpr(E, e.args[0], STR, loc);
      const str = a.k === 'str' ? a.value : a.k === 'c' && a.val.str !== undefined ? a.val.str : null;
      if (str === null) throw new ElabError("'value needs a constant string", loc);
      const txt = str.trim().toLowerCase();
      if (t.kind === 'enum') {
        const i = t.names.indexOf(txt);
        if (i < 0) throw new ElabError(`'${str}' is not a value of type '${t.name}'`, loc);
        return { k: 'c', val: V.fromInt(i, t.w, false), t };
      }
      if (t.kind === 'bool' && (txt === 'true' || txt === 'false')) return { k: 'c', val: V.fromBool(txt === 'true'), t: BOOL };
      if (t.kind === 'int' && /^[-+]?\d+$/.test(txt)) return cint(Number(txt));
      throw new ElabError(`'value of '${str}' is not supported`, loc);
    }
    case 'stable':
      if (!edgeOperand(node)) throw new ElabError("'stable requires a signal", loc);
      if (e.args.length) {   // S'stable(T): no event during the last T
        if (node.k !== 'sig') throw new ElabError("'stable(T) requires a whole signal", loc);
        return { k: 'sigattr', a: 'stable', sig: node.sig, T: bindExpr(E, e.args[0], TIME, loc), t: BOOL };
      }
      return { k: 'un', o: '!', a: { k: 'event', ...edgeOperand(node), t: BOOL }, t: BOOL };
    case 'last_value': case 'last_event':
      if (!node || node.k !== 'sig') throw new ElabError(`'${at} requires a whole signal`, loc);
      return { k: 'sigattr', a: at, sig: node.sig, t: at === 'last_event' ? TIME : node.t };
  }
  throw new ElabError(`attribute '${e.attr} is not supported`, loc);
}

function bindAggregate(E, e, expect, loc) {
  if (!expect) {
    // positional aggregate without context: concatenation
    if (e.items.every(i => !i.choices)) {
      const parts = e.items.map(i => bindExpr(E, i.value, BIT, loc));
      return fold({ k: 'cat', parts, t: vecT(parts.reduce((a, p) => a + p.t.w, 0)) });
    }
    throw new ElabError('cannot determine the type of the aggregate', loc);
  }
  if (expect.kind === 'array' && expect.fields) {
    // record aggregate: positional and / or named (field => value, others => value)
    const F = expect.fields, slots = new Array(F.length).fill(null);
    let pos = 0;
    for (const it of e.items) {
      if (!it.choices) { if (pos < F.length) { slots[pos] = bindExpr(E, it.value, F[pos].t, loc); pos++; } continue; }
      for (const ch of it.choices) {
        if (ch === 'others') { F.forEach((f, k) => { if (!slots[k]) slots[k] = bindExpr(E, it.value, f.t, loc); }); continue; }
        const k = ch.op === 'ref' ? F.findIndex(f => f.name === ch.name) : -1;
        if (k < 0) throw new ElabError(`record has no field '${ch.name ?? '?'}'`, loc);
        slots[k] = bindExpr(E, it.value, F[k].t, loc);
      }
    }
    const elems = slots.map((x, k) => x || { k: 'c', val: defaultValue(F[k].t, E.lang), t: F[k].t });
    return fold({ k: 'arr', elems, t: expect });
  }
  if (expect.kind === 'array') {
    if (expect.unconstrained) {
      const elems = e.items.map(i => bindExpr(E, i.value, expect.elem, loc));
      const t = { ...expect, unconstrained: false, left: 0, right: elems.length - 1, desc: false, lo: 0, len: elems.length };
      return fold({ k: 'arr', elems, t });
    }
    const slots = new Array(expect.len).fill(null);
    let pos = 0;
    for (const it of e.items) {
      const val = bindExpr(E, it.value, expect.elem, loc);
      if (!it.choices) {
        const idx = expect.desc ? expect.left - pos : expect.left + pos;
        pos++;
        if (idx - expect.lo >= 0 && idx - expect.lo < expect.len) slots[idx - expect.lo] = val;
        continue;
      }
      for (const ch of it.choices) {
        if (ch === 'others') { for (let k = 0; k < slots.length; k++) if (!slots[k]) slots[k] = val; }
        else if (ch.range) {
          const r = evalRange(E, ch.range);
          for (let i = Math.min(r.left, r.right); i <= Math.max(r.left, r.right); i++) slots[i - expect.lo] = val;
        } else slots[V.toNum(constOf(E, bindExpr(E, ch, null, loc), loc)) - expect.lo] = val;
      }
    }
    const def = { k: 'c', val: defaultValue(expect.elem, E.lang), t: expect.elem };
    return fold({ k: 'arr', elems: slots.map(s => s || def), t: expect });
  }
  // vector aggregate
  const t = expect.unconstrained ? null : expect;
  if (!t) {
    if (e.items.every(i => !i.choices)) {
      const parts = e.items.map(i => bindExpr(E, i.value, BIT, loc));
      return fold({ k: 'cat', parts, t: vecT(parts.length) });
    }
    throw new ElabError('aggregate with others needs a constrained target', loc);
  }
  const w = t.w;
  const bits = new Array(w).fill(null); // indexed by bit position
  let pos = 0;
  for (const it of e.items) {
    const val = bindExpr(E, it.value, BIT, loc);
    if (!it.choices) {
      const idx = t.desc ? t.left - pos : t.left + pos;
      pos++;
      bits[bitpos(t, idx)] = val;
      continue;
    }
    for (const ch of it.choices) {
      if (ch === 'others') { for (let k = 0; k < w; k++) if (!bits[k]) bits[k] = val; }
      else if (ch.range) {
        const r = evalRange(E, ch.range);
        for (let i = Math.min(r.left, r.right); i <= Math.max(r.left, r.right); i++) bits[bitpos(t, i)] = val;
      } else bits[bitpos(t, V.toNum(constOf(E, bindExpr(E, ch, null, loc), loc)))] = val;
    }
  }
  const zero = { k: 'c', val: V.ZERO, t: BIT };
  const parts = [];
  for (let p = w - 1; p >= 0; p--) parts.push(bits[p] || zero);
  if (parts.every(p => p === parts[0])) return fold({ k: 'repl', count: { k: 'c', val: V.fromInt(w), t: INT }, a: parts[0], t: vecT(w, t.s) });
  return fold({ k: 'cat', parts, t: { ...vecT(w, t.s) } });
}

// VHDL name(args): index, call, or conversion
function bindApply(E, e, expect, loc) {
  const name = e.name;
  const args = e.args.slice();
  const entry = E.sc.lookup(name);
  if (entry?.kind === 'subalias') return bindApply(E, { ...e, name: entry.target }, expect, loc);
  if (entry && (entry.kind === 'sig' || entry.kind === 'const' || entry.kind === 'loc' || entry.kind === 'alias')) {
    let base = refNode(E, entry, name);
    // m(i, j) of a multi-dimensional array (an array of arrays): one index per dimension
    while (args.length > 1 && base.t.kind === 'array') {
      const a = args.shift();
      base = fold({ k: 'elem', base, index: bindExpr(E, a.named !== undefined ? a.value : a, null, loc), t: base.t.elem });
    }
    if (args.length !== 1) throw new ElabError(`'${name}' indexed with ${args.length} indices`, loc);
    const a = args[0].named !== undefined ? args[0].value : args[0];
    if (a.op === 'slice' && a.base == null) return fold(sliceNode(E, base, a.left, a.right, loc));
    return fold(indexNode(E, base, a, loc));
  }
  if (entry && entry.kind === 'func') return bindCall(E, entry, args, name, loc);
  if (entry && entry.kind === 'type') {
    const a = bindExpr(E, positional(args)[0], null, loc);
    const t = entry.t;
    return fold({ k: 'conv', a, ext: a.t.s, t: t.unconstrained ? { ...a.t } : t });
  }
  return bindBuiltin(E, name, args, expect, loc);
}

function positional(args) { return args.map(a => (a && a.named !== undefined ? a.value : a)); }

// names of the built-in VHDL subprograms (bindBuiltin; finish / stop: std.env procedures)
const BUILTIN_SUBPROGRAMS = new Set(`rising_edge falling_edge to_unsigned conv_unsigned to_signed conv_signed conv_std_logic_vector
to_integer conv_integer resize ext sxt to_stdlogicvector to_bitvector to_stdulogicvector to_01 to_x01 to_stdulogic to_bit
shift_left shift_right rotate_left rotate_right and_reduce or_reduce xor_reduce nand_reduce nor_reduce xnor_reduce
to_string to_bstring to_hstring minimum maximum now std_match finish stop`.split(/\s+/));

function bindBuiltin(E, name, rawArgs, expect, loc) {
  const args = positional(rawArgs);
  const A = i => bindExpr(E, args[i], null, loc);
  const C = i => V.toNum(constOf(E, A(i), loc));
  const conv = (a, w, s, ext = a.t.s, kind) => fold({ k: 'conv', a, ext, t: kind === 'int' ? INT : vecT(w, s) });
  switch (name) {
    case 'rising_edge': case 'falling_edge': {
      const a = A(0);
      if (!edgeOperand(a)) throw new ElabError(`${name} requires a signal`, loc);
      return { k: 'edge', ...edgeOperand(a), pos: name === 'rising_edge', t: BOOL };
    }
    case 'to_unsigned': case 'conv_unsigned': return conv(A(0), C(1), false, true);
    case 'to_signed': case 'conv_signed': return conv(A(0), C(1), true, true);
    case 'conv_std_logic_vector': return conv(A(0), C(1), false);
    case 'to_integer': case 'conv_integer': case 'integer': case 'natural': case 'positive': { const a = slvNum(E, A(0)); return conv(a, 32, true, a.t.s, 'int'); }
    case 'real': { const a = A(0); return fold({ k: 'conv', a, ext: a.t.s, t: REAL }); }
    case 'resize': {
      const a = A(0), w = C(1);
      if (a.t.s && a.t.kind === 'logic' && w < a.t.w) return fold({ k: 'conv', a, ext: true, sres: true, t: vecT(w, true) });
      return conv(a, w, a.t.s);
    }
    case 'ext': return conv(A(0), C(1), false, false);
    case 'sxt': return conv(A(0), C(1), true, true);
    case 'unsigned': case 'std_logic_vector': case 'std_ulogic_vector': case 'to_stdlogicvector': case 'to_bitvector': case 'to_stdulogicvector': case 'bit_vector': {
      const a = A(0);
      if (a.t.kind === 'int') throw new ElabError(`cannot convert an integer with ${name}(); use to_unsigned(x, n)`, loc);
      return conv(a, a.t.w, false);
    }
    case 'signed': { const a = A(0); return conv(a, a.t.w, true); }
    case 'to_01': case 'to_x01': case 'std_logic': case 'to_stdulogic': case 'to_bit': return A(0);
    case 'shift_left': case 'shift_right': case 'rotate_left': case 'rotate_right': {
      const a = A(0), b = A(1);
      const o = name === 'shift_left' ? '<<' : name === 'shift_right' ? (a.t.s ? '>>>' : '>>') : name === 'rotate_left' ? 'rol' : 'ror';
      return fold({ k: 'bin', o, a, b, t: a.t });
    }
    case 'and_reduce': case 'or_reduce': case 'xor_reduce': case 'nand_reduce': case 'nor_reduce': case 'xnor_reduce': {
      const o = { and_reduce: '&', or_reduce: '|', xor_reduce: '^', nand_reduce: '~&', nor_reduce: '~|', xnor_reduce: '~^' }[name];
      return fold({ k: 'un', o, a: A(0), t: BIT });
    }
    case 'to_string': case 'to_bstring': return { k: 'image', a: A(0), t: STR, ts: true };
    case 'to_hstring': return { k: 'image', a: A(0), t: STR, hex: true };
    case 'minimum': case 'maximum': {
      const a = A(0), b = A(1);
      const c = { k: 'bin', o: name === 'minimum' ? '<' : '>', a, b, t: BOOL };
      return fold({ k: 'cond', c, a, b, t: a.t });
    }
    case 'now': return { k: 'now', t: TIME, unit: 1 };
    // '-' in a constant operand is a don't care ('-' and 'X' share one encoding)
    case 'std_match': { const a = A(0), b = A(1); return fold({ k: 'bin', o: '==', a: strAsLogic(a, b), b: strAsLogic(b, a), t: BOOL, vh: true, match: true }); }
  }
  throw new ElabError(`'${name}' is not declared`, loc);
}

function bindVlogCall(E, e, expect, loc) {
  const name = e.name;
  if (name[0] === '$') {
    const A = i => bindExpr(E, e.args[i], null, loc);
    switch (name) {
      case '$signed': { const a = A(0); return fold({ k: 'conv', a, ext: a.t.s, t: vecT(a.t.w, true) }); }
      case '$unsigned': { const a = A(0); return fold({ k: 'conv', a, ext: a.t.s, t: vecT(a.t.w, false) }); }
      // SystemVerilog size cast W'(expr): the value at W bits, extended by its own sign, signedness kept
      case '$__size_cast': { const w = Number(e.args[0].value), a = A(1); return fold({ k: 'conv', a, ext: a.t.s, t: vecT(w, a.t.s) }); }
      case '$clog2': {
        diag(E, '$clog2 is not supported by XST (ISE 14.7); use a constant function instead', loc, 'warning');
        const v = V.toBig(constOf(E, A(0), loc));
        let r = 0; while ((1n << BigInt(r)) < v) r++;
        return { k: 'c', val: V.fromInt(r), t: INT };
      }
      case '$bits': return { k: 'c', val: V.fromInt(A(0).t.w), t: INT };
      case '$time': case '$stime': return { k: 'sys', name, args: [], t: vecT(64) };
      case '$realtime': return { k: 'sys', name, args: [], t: REAL };
      case '$fopen': return { k: 'sys', name, args: [], t: vecT(32) };   // (file output goes to the log)
      case '$sformatf': return { k: 'sys', name, args: e.args.map((_, i) => { const a = A(i); ctxSize(a, a.t.w); return a; }), t: STR };
      case '$random': return { k: 'sys', name, args: e.args.length ? [bindLvalue(E, e.args[0], loc)] : [], t: INT };
      case '$urandom': return { k: 'sys', name, args: [], t: vecT(32) };
      case '$urandom_range': return { k: 'sys', name, args: e.args.map((_, i) => A(i)), t: vecT(32) };
      case '$countones': {
        const a = A(0);
        let sum = { k: 'c', val: V.fromInt(0), t: INT };
        for (let i = 0; i < a.t.w; i++) sum = { k: 'bin', o: '+', a: sum, b: { k: 'conv', a: { k: 'bit', base: a, index: { k: 'c', val: V.fromInt(a.t.desc ? a.t.right + i : a.t.right - i), t: INT }, t: BIT }, ext: false, t: INT }, t: INT };
        return fold(sum);
      }
      case '$rtoi': { const a = A(0); return fold({ k: 'conv', a, ext: true, rtoi: true, t: INT }); }   // truncates
      case '$itor': { const a = A(0); return fold({ k: 'conv', a, ext: a.t.s, t: REAL }); }
      case '$realtobits': case '$bitstoreal': return A(0);
    }
    throw new ElabError(`system function ${name} is not supported`, loc);
  }
  let entry = E.sc.lookup(name);
  // a recursive call: inside the function its name is the return variable; find the function
  for (let sc = E.sc; entry && entry.kind !== 'func' && sc; sc = sc.parent) { const x = sc.local(name); if (x && x.kind === 'func') entry = x; }
  if (!entry || entry.kind !== 'func') throw new ElabError(`function '${name}' is not declared`, loc);
  return bindCall(E, entry, e.args, name, loc);
}

// VHDL overloaded subprogram: the alternative whose parameter types fit the actuals (first
// exactly - signedness, type marks -, then by kind of type); the last declared one otherwise.
function pickOverload(E, entry, rawArgs, loc) {
  if (!entry.alts) return entry;
  let acts;
  try {
    acts = rawArgs.map(a => (a == null ? null : { named: a.named, n: bindExpr(E, a.named !== undefined ? a.value : a, null, loc) }));
  } catch (e) {
    if (e instanceof ElabError || e instanceof SimError) return entry;
    throw e;
  }
  const fitsType = (n, pt, strict) => {
    const at = n.t;
    if (n.k === 'str' && pt.kind === 'logic') return !pt.scalar && /^[01uxzwlh-]+$/i.test(n.value);
    if (pt.kind !== at.kind) return false;
    switch (pt.kind) {
      case 'logic':
        if (pt.scalar ? !(at.w === 1 && at.scalar) : at.scalar) return false;
        return !strict || pt.scalar || (!!at.s === !!pt.s && (at.mark || '') === (pt.mark || ''));
      case 'enum': return at.name === pt.name;
      case 'array': return !strict || !pt.name || at.name === pt.name;
      default: return true;
    }
  };
  const fits = (alt, strict) => {
    const ps = alt.decl.params, used = new Set();
    if (acts.length > ps.length) return false;
    for (let k = 0; k < acts.length; k++) {
      const a = acts[k];
      if (!a) continue;
      const i = a.named !== undefined ? ps.findIndex(p => p.name === a.named) : k;
      if (i < 0) return false;
      used.add(i);
      let pt;
      try { pt = elabType(alt.E, ps[i].type, true); } catch { return false; }
      if (!fitsType(a.n, pt, strict)) return false;
    }
    return ps.every((p, i) => used.has(i) || p.default);
  };
  return entry.alts.find(a => fits(a, true)) || entry.alts.find(a => fits(a, false)) || entry;
}

function bindCall(E, entry, rawArgs, name, loc) {
  entry = pickOverload(E, entry, rawArgs, loc);
  const decl = entry.decl;
  if (decl.kind === 'task') throw new ElabError(`'${name}' is a procedure/task, not a function`, loc);
  if (rawArgs.filter(a => !(a && a.named !== undefined)).length > decl.params.length) throw new ElabError(`too many arguments in call to '${name}'`, loc);
  // named association
  let argExprs = new Array(decl.params.length).fill(null);
  rawArgs.forEach((a, k) => {
    if (a && a.named !== undefined) {
      const idx = decl.params.findIndex(p => p.name === a.named);
      if (idx < 0) throw new ElabError(`'${name}' has no parameter '${a.named}'`, loc);
      argExprs[idx] = a.value;
    } else argExprs[k] = a;
  });
  argExprs = argExprs.map((a, k) => a || decl.params[k].default || null);   // VHDL default parameter values
  const args = argExprs.map((a, k) => {
    if (!a) throw new ElabError(`missing argument '${decl.params[k].name}' in call to '${name}'`, loc);
    let at = null;   // an aggregate actual takes the type of its parameter
    if (a.op === 'aggregate') { try { at = elabType(entry.E, decl.params[k].type, true); } catch { at = null; } }
    const n = bindExpr(E, a, at && !at.unconstrained ? at : null, loc);
    // a std_logic string literal (kept as a string in report messages) for a vector parameter
    const pt = decl.params[k].type;
    if (E.lang === 'vhdl' && n.k === 'str' && pt && (pt.kind === 'logic' || (pt.kind === 'named' && stdTypeName(pt.name)?.kind === 'logic'))) return strAsLogic(n, { t: { kind: 'logic' } });
    return n;
  });
  const fn = boundFunction(entry, args, loc);
  if (decl.kind === 'task' || !fn.retT) throw new ElabError(`'${name}' is a procedure/task, not a function`, loc);
  args.forEach((a, k) => { if (E.lang === 'verilog') ctxSize(a, fn.params[k].t.w); });
  return fold({ k: 'call', fn, args, t: fn.retT });
}

// Bound function / procedure for these argument types (cached per argument types).
// VHDL: when the generic binding fails (e.g. a width depends on an integer parameter:
// `variable r : std_logic_vector(n-1 downto 0)`, `to_unsigned(i, w)`), the subprogram is bound
// again with its constant integer arguments known as constants (cached per argument value).
function boundFunction(entry, args, loc, sigActuals = null) {
  const decl = entry.decl;
  const key = args.map(a => `${a.t.kind}${a.t.w}${a.t.s ? 's' : ''}`).join(',');
  const consts = new Map();
  if (entry.E.lang === 'vhdl') {
    decl.params.forEach((p, k) => {
      const a = args[k];
      if (!sigActuals?.[k] && a && a.k === 'c' && a.t.kind === 'int' && p.dir !== 'out' && p.dir !== 'inout' && String(p.class || '').toLowerCase() !== 'variable') consts.set(k, a.val);
    });
  }
  if (!sigActuals && entry.cache.has(key)) {
    const fn = entry.cache.get(key);
    if (!fn.needsConsts) return fn;
  } else if (consts.size) {
    // try the generic binding; on errors, fall back to the per-constant one
    const diags = entry.E.ctx.design.diags, n0 = diags.length;
    let fn = null;
    try { fn = bindSubprogram(entry, args, key, sigActuals, null); } catch (e) { if (!(e instanceof ElabError) && !(e instanceof SimError)) throw e; }
    if (fn && !diags.slice(n0).some(d => d.severity === 'error')) return fn;
    diags.length = n0;
    if (!sigActuals) entry.cache.set(key, { needsConsts: true });
  } else {
    return bindSubprogram(entry, args, key, sigActuals, null);
  }
  if (!consts.size) return entry.cache.get(key);
  const ckey = key + '|' + [...consts].map(([k, v]) => `${k}=${V.toDec(v, true)}`).join(',');
  if (!sigActuals && entry.cache.has(ckey)) return entry.cache.get(ckey);
  return bindSubprogram(entry, args, ckey, sigActuals, consts);
}

function bindSubprogram(entry, args, key, sigActuals, consts) {
  const decl = entry.decl;
  const DE = entry.E;
  const fb = new FrameBuilder();
  const sc = new Scope(DE.sc);
  const FE = { ...DE, sc, fb, inProcess: true, inFunction: true };
  const fn = { name: decl.name, params: [], body: null, retSlot: null, retT: null, impure: false };
  if (!sigActuals) entry.cache.set(key, fn);
  try {
    decl.params.forEach((p, k) => {
      if (sigActuals?.[k]) {
        const a = sigActuals[k];
        sc.def(p.name, { kind: 'alias', rv: a.rv, lv: a.lv, t: a.rv.t });
        fn.params.push({ alias: true, dir: p.dir, name: p.name });
        return;
      }
      let t = elabType(FE, p.type, true);
      if ((t.unconstrained || (t.kind === 'logic' && t.w === 1 && p.type.kind === 'logic' && !p.type.range && args[k] && args[k].t.w > 1 && DE.lang === 'vhdl')) && args[k]) {
        t = { ...args[k].t };
        delete t.unconstrained;
      }
      const i = fb.alloc(t, defaultValue(t, DE.lang));
      if (consts?.has(k)) sc.def(p.name, { kind: 'const', val: fitVal(consts.get(k), t), t });
      else sc.def(p.name, { kind: 'loc', i, t });
      fn.params.push({ i, t, dir: p.dir, name: p.name });
    });
    let retOpen = false;
    if (decl.returnType) {
      let rt = elabType(FE, decl.returnType, true);
      if (rt.unconstrained) {
        // provisional (recursive calls): refined from the return statements below
        retOpen = rt.kind === 'logic';
        rt = args[0] ? { ...args[0].t } : vecT(1);
        delete rt.unconstrained;
        if (decl.returnType.signed !== undefined && rt.kind === 'logic') rt.s = !!decl.returnType.signed;
      }
      fn.retT = rt;
      if (!retOpen) FE.retT = rt;   // (aggregates in return statements)
      if (decl.retVar) {
        fn.retSlot = fb.alloc(rt, defaultValue(rt, DE.lang));
        sc.def(decl.retVar, { kind: 'loc', i: fn.retSlot, t: rt });
      }
    }
    for (const d of decl.decls) bindDecl(FE, d);
    fn.body = bindBlock(FE, decl.body, decl.loc);
    if (retOpen) {
      // unconstrained return type (VHDL): the width of the returned values, when they agree
      const ws = new Set();
      walk(fn.body, x => { if (x.k === 'ret' && x.value && x.value.t) ws.add(x.value.t.kind === 'logic' ? x.value.t.w : -1); });
      if (ws.size === 1 && !ws.has(-1)) fn.retT = vecT([...ws][0], !!fn.retT.s);
    }
  } catch (e) {
    if (!sigActuals && entry.cache.get(key) === fn) entry.cache.delete(key);
    throw e;
  }
  fn.frameInit = fb.makeInit();
  const rw = collectRW(fn.body);
  fn.impure = rw.reads.size > 0 || rw.writes.size > 0 || containsKind(fn.body, ['delay', 'event', 'wait', 'sys', 'fork', 'waitfork']);
  return fn;
}

// ---------------------------------------------------------------- lvalues
function isLvalueExpr(e) {
  switch (e.op) {
    case 'ref': return true;
    case 'index': case 'slice': case 'pslice': case 'field': return isLvalueExpr(e.base);
    case 'apply': return e.args.length >= 1;
    case 'concat': return e.parts.every(isLvalueExpr);
  }
  return false;
}

function bindLvalue(E, e, loc) {
  switch (e.op) {
    case 'ref': {
      const entry = E.sc.lookup(e.name);
      if (!entry) {
        if (E.implicitNets) return bindExpr(E, e, null, loc);
        throw new ElabError(`'${e.name}' is not declared`, loc);
      }
      if (entry.kind === 'sig') return { k: 'sig', sig: entry.sig, t: entry.t || entry.sig.t, name: e.name };
      if (entry.kind === 'loc') return { k: 'loc', i: entry.i, t: entry.t, name: e.name };
      if (entry.kind === 'alias' && entry.lv) return entry.lv;
      throw new ElabError(`cannot assign to '${e.name}'`, loc);
    }
    case 'index': {
      const base = bindLvalue(E, e.base, loc);
      const index = bindExpr(E, e.index, null, loc);
      const chk = E.lang === 'vhdl' ? { chk: true } : {};
      if (base.t.kind === 'array') return { k: 'elem', base, index, t: base.t.elem, ...chk };
      if (base.t.kind === 'str') return { k: 'chr', base, index, t: CHAR };
      return { k: 'bit', base, index, t: BIT, ...chk };
    }
    case 'slice': {
      const base = bindLvalue(E, e.base, loc);
      const n = sliceNode(E, base, e.left, e.right, loc);
      return n;
    }
    case 'pslice': {
      const base = bindLvalue(E, e.base, loc);
      const w = V.toNum(constOf(E, bindExpr(E, e.width), loc));
      return { k: 'pslice', base, start: bindExpr(E, e.start, null, loc), dir: e.dir, t: vecT(w) };
    }
    case 'field': return fieldNode(E, bindLvalue(E, e.base, loc), e.name, loc);
    case 'apply': {
      let base = bindLvalue(E, { op: 'ref', name: e.name }, loc);
      const args = positional(e.args);
      // m(i, j) of a multi-dimensional array (an array of arrays): one index per dimension
      for (const a of args.slice(0, -1)) {
        if (base.t.kind !== 'array') throw new ElabError(`'${e.name}' indexed with ${args.length} indices`, loc);
        base = { k: 'elem', base, index: bindExpr(E, a, null, loc), t: base.t.elem };
      }
      const a = args[args.length - 1];
      if (a.op === 'slice' && a.base == null) return sliceNode(E, base, a.left, a.right, loc);
      const index = bindExpr(E, a, null, loc);
      const chk = E.lang === 'vhdl' ? { chk: true } : {};
      if (base.t.kind === 'array') return { k: 'elem', base, index, t: base.t.elem, ...chk };
      if (base.t.kind === 'str') return { k: 'chr', base, index, t: CHAR };
      return { k: 'bit', base, index, t: BIT, ...chk };
    }
    case 'concat': {
      const parts = e.parts.map(p => bindLvalue(E, p, loc));
      return { k: 'cat', parts, t: vecT(parts.reduce((a, p) => a + p.t.w, 0)) };
    }
  }
  throw new ElabError('invalid assignment target', loc);
}

// VHDL: an assignment to an object of an integer subtype checks the value against its range
function rangeCheck(asg) {
  const t = asg.target.t;
  if (t && t.kind === 'int' && t.rlo !== undefined && (t.rlo > -2147483648 || t.rhi < 2147483647)) asg.rng = [t.rlo, t.rhi];
}

function lroot(L) {
  while (L.base) L = L.base;
  return L;
}

function checkAssignable(E, target, value, loc) {
  if (E.lang !== 'vhdl') return;
  const tw = target.t.w, vw = value.t.w;
  if (target.t.kind === 'logic' && value.t.kind === 'logic' && tw !== vw && !value.t.scalar && !target.t.scalar && value.k !== 'c')
    diag(E, `width mismatch: target is ${tw} bits, value is ${vw} bits`, loc, 'warning');
}

// ---------------------------------------------------------------- statements
function bindBlock(E, stmts, loc) {
  return { k: 'blk', stmts: stmts.map(s => bindStmt(E, s, loc)).filter(Boolean), loc };
}

function bindStmt(E, s, ploc) {
  const loc = s.loc || ploc;
  try {
    return bindStmt0(E, s, loc);
  } catch (e) {
    if (!(e instanceof ElabError) && !(e instanceof SimError)) throw e;
    diag(E, e.message, e.loc || loc);
    return { k: 'null', loc };
  }
}

function bindStmt0(E, s, loc) {
  switch (s.kind) {
    case 'block': {
      const sc = new Scope(E.sc);
      const BE = { ...E, sc };
      for (const d of s.decls || []) {
        if (d.kind === 'signal') d.net = 'variable';
        bindDecl(BE, d);
      }
      return { k: 'blk', stmts: s.stmts.map(x => bindStmt(BE, x, loc)).filter(Boolean), loc, ...(s.label ? { label: s.label } : {}) };
    }
    case 'fork': {   // Verilog fork: each statement runs as a child thread of the process
      if (!E.fb) throw new ElabError('fork is only allowed in initial / always blocks and tasks', loc);
      const sc = new Scope(E.sc);
      const BE = { ...E, sc };
      for (const d of s.decls || []) bindDecl(BE, d);
      return { k: 'fork', branches: s.stmts.map(x => bindStmt(BE, x, loc)).filter(Boolean), join: s.join || 'all', loc };
    }
    case 'waitfork': return { k: 'waitfork', loc };
    case 'disablefork': return { k: 'disablefork', loc };
    case 'assign': {
      const target = bindLvalue(E, s.target, loc);
      const value = bindExpr(E, s.value, target.t, loc);
      if (E.lang === 'verilog') ctxSize(value, target.t.w);
      checkAssignable(E, target, value, loc);
      const root = lroot(target.k === 'cat' ? target.parts[0] : target);
      if (E.lang === 'vhdl' && s.nonblocking && root.k === 'loc' && !E.inFunction) diag(E, `'${root.name}' is a variable: use ':='`, loc, 'warning');
      if (E.inFunction && root.k === 'sig' && !s.nonblocking) diag(E, `function assigns signal '${root.name}'`, loc, 'warning');
      const asg = {
        k: 'asg', target, value, nb: !!s.nonblocking && root.k !== 'loc',
        delay: s.delay ? bindExpr(E, s.delay, null, loc) : null, delayUnit: E.lang === 'vhdl' ? 1 : E.timeUnit, prec: E.timePrec, loc,
      };
      if (E.lang === 'vhdl' && asg.nb) Object.assign(asg, vhdlMech(E, s));
      if (E.lang === 'vhdl') rangeCheck(asg);
      // Verilog `a = #d b;`: the process waits d, then assigns the value sampled before the wait
      if (E.lang === 'verilog' && !asg.nb && asg.delay) asg.intra = true;
      return asg;
    }
    case 'if': return { k: 'if', c: vsize(E, bindExpr(E, s.cond, null, loc)), then: bindStmt(E, s.then, loc), else: s.else ? bindStmt(E, s.else, loc) : null, loc };
    case 'case': {
      const sel = bindExpr(E, s.expr, null, loc);
      const items = s.items.map(it => ({
        choices: it.choices.map(ch => {
          if (ch.range) {
            const r = ch.range;
            if (r.of) { const er = evalRange(E, r); return { range: { lo: cI(er.left), hi: cI(er.right) } }; }
            return { range: { lo: bindExpr(E, r.left, null, loc), hi: bindExpr(E, r.right, null, loc) } };
          }
          const c = bindExpr(E, ch, sel.t, loc);
          return c;
        }),
        body: bindStmt(E, it.body, loc),
      }));
      if (E.lang === 'verilog') {
        const m = Math.max(sel.t.w, ...items.flatMap(it => it.choices.filter(c => !c.range).map(c => c.t.w)));
        ctxSize(sel, m);
        for (const it of items) for (const c of it.choices) if (!c.range) ctxSize(c, m);
      }
      return { k: 'case', sel, items, def: s.default ? bindStmt(E, s.default, loc) : null, variant: s.variant || 'case', loc };
    }
    case 'for': return {
      k: 'for', init: bindStmt(E, s.init, loc), cond: vsize(E, bindExpr(E, s.cond, null, loc)), step: bindStmt(E, s.step, loc),
      body: bindStmt(E, s.body, loc), loc,
    };
    case 'forrange': {
      const r = evalRangeDyn(E, s.range, loc);
      const sc = new Scope(E.sc);
      if (!E.fb) throw new ElabError('loop outside of a process', loc);
      const init = r.from.k === 'c' ? fitVal(r.from.val, INT) : V.fromInt(0);
      const i = E.fb.alloc(INT, init);
      sc.def(s.var, { kind: 'loc', i, t: INT });
      const LE = { ...E, sc };
      return { k: 'forrange', var: i, varT: INT, from: r.from, to: r.to, down: r.down, body: bindStmt(LE, s.body, loc), loc, label: s.label };
    }
    case 'while': return { k: 'while', cond: vsize(E, bindExpr(E, s.cond, null, loc)), body: bindStmt(E, s.body, loc), loc, label: s.label };
    case 'repeat': return { k: 'repeat', count: vsize(E, bindExpr(E, s.count, null, loc)), body: bindStmt(E, s.body, loc), loc };
    case 'forever': {
      const body = bindStmt(E, s.body, loc);
      // (a VHDL `loop` may iterate without waiting: it ends with exit; only the iteration count is limited)
      return { k: 'forever', body, hasWait: E.lang === 'vhdl' || containsKind(body, ['delay', 'event', 'wait', 'task', 'fork', 'waitfork']), loc, label: s.label };
    }
    case 'exit': case 'next': return { k: s.kind, c: s.cond ? bindExpr(E, s.cond, null, loc) : null, loc, label: s.label };
    // the return type is the expected type of aggregates and of character / enumeration literals
    case 'return': return { k: 'ret', value: s.value ? bindExpr(E, s.value, E.retT && !E.retT.unconstrained && (s.value.op === 'aggregate' || E.retT.char || E.retT.kind === 'enum') ? E.retT : null, loc) : null, loc };
    case 'null': return { k: 'null', loc };
    case 'delay': return { k: 'delay', amount: bindExpr(E, s.amount, null, loc), unit: E.timeUnit, prec: E.timePrec, stmt: s.stmt ? bindStmt(E, s.stmt, loc) : null, loc };
    case 'disable': return { k: 'disable', label: s.label, loc };
    case 'event': {
      const stmt = s.stmt ? bindStmt(E, s.stmt, loc) : null;
      const triggers = s.events === 'all' ? triggersOfReads(stmt) : s.events.flatMap(ev => bindTrigger(E, ev.expr, ev.edge, loc));
      return { k: 'event', triggers, stmt, loc };
    }
    case 'wait': {
      const until = s.until ? vsize(E, bindExpr(E, s.until, null, loc)) : null;
      let triggers = [];
      if (s.on) triggers = s.on.flatMap(x => bindTrigger(E, x, 'any', loc));
      else if (until) triggers = triggersOfReads(until);
      if (until && !s.on && !triggers.length && !s.for) diag(E, 'wait until condition does not depend on any signal', loc, 'warning');
      return { k: 'wait', until, triggers, forT: s.for ? bindExpr(E, s.for, null, loc) : null, level: !!s.level, loc };
    }
    case 'call': return bindCallStmt(E, s, loc);
    case 'report': return { k: 'report', msg: bindExpr(E, s.message, null, loc), sev: s.severity || 'note', loc };
    case 'assert': return {
      k: 'assert', c: bindExpr(E, s.cond, null, loc), msg: s.message ? bindExpr(E, s.message, null, loc) : null,
      sev: s.severity || 'error', loc,
    };
  }
  throw new ElabError(`unsupported statement '${s.kind}'`, loc);
}

const cI = n => ({ k: 'c', val: V.fromInt(n), t: INT });
// Verilog: a self-determined expression (condition, count) is sized with its own width
const vsize = (E, n) => { if (E.lang === 'verilog') ctxSize(n, n.t.w); return n; };

// VHDL signal assignment: driver semantics (inertial / transport / reject, waveform elements).
function vhdlMech(E, s) {
  const m = { vh: true, mech: s.mech === 'transport' ? 'transport' : 'inertial' };
  if (s.mech && s.mech.reject) m.reject = bindExpr(E, s.mech.reject, null, s.loc);
  if (s.waveCont) m.cont = true;
  return m;
}

function evalRangeDyn(E, r, loc) {
  if (r.of) {
    const er = evalRange(E, r);
    return { from: cI(er.left), to: cI(er.right), down: er.desc };
  }
  const from = bindExpr(E, r.left, null, loc), to = bindExpr(E, r.right, null, loc);
  let down = r.dir === 'downto';
  if (!r.dir && from.k === 'c' && to.k === 'c') down = V.toNum(from.val) > V.toNum(to.val);
  return { from, to, down };
}

function bindCallStmt(E, s, loc) {
  const sub = E.sc.lookup(s.name);
  if (sub?.kind === 'subalias') return bindCallStmt(E, { ...s, name: sub.target }, loc);
  const name = s.name;
  const sysName = name[0] === '$' ? name : (['finish', 'stop'].includes(name.toLowerCase()) ? name.toLowerCase() : null);
  if (sysName && !(name[0] !== '$' && E.sc.lookup(name))) {
    const args = s.args.map(a => (a.op === 'str' ? { k: 'str', value: a.value, t: STR } : bindExpr(E, a, null, loc)));
    if (/^\$(monitor|display[bho]?|write[bho]?|strobe|fdisplay|fwrite|fstrobe|sformat|swrite)$/.test(sysName)) args.forEach(a => { if (a.k !== 'str' && E.lang === 'verilog') ctxSize(a, a.t.w); });
    if ((sysName === '$readmemh' || sysName === '$readmemb') && args[1]) {
      const L = bindLvalue(E, s.args[1], loc);
      return { k: 'sys', name: sysName, args: [args[0], L], loc };
    }
    return { k: 'sys', name: sysName, args, loc };
  }
  let entry = E.sc.lookup(name);
  if (entry && entry.kind === 'func') entry = pickOverload(E, entry, s.args, loc);
  if (!entry || entry.kind !== 'func') {
    if (E.lang === 'vhdl' && ['deallocate', 'write', 'writeline', 'read', 'readline'].includes(name)) {
      diag(E, `procedure '${name}' (textio) is not supported`, loc, 'warning');
      return { k: 'null', loc };
    }
    throw new ElabError(`task/procedure '${name}' is not declared`, loc);
  }
  const decl = entry.decl;
  // one actual per formal, in order: named association (f => a) and default values (VHDL)
  const acts = new Array(Math.max(decl.params.length, s.args.length)).fill(null);
  s.args.forEach((a, k) => {
    if (a && a.named !== undefined) {
      const i = decl.params.findIndex(p => p.name === a.named);
      if (i < 0) throw new ElabError(`'${name}' has no parameter '${a.named}'`, loc);
      acts[i] = a.value;
    } else acts[k] = a;
  });
  decl.params.forEach((p, k) => {
    if (!acts[k] && p.default && p.dir !== 'out') acts[k] = p.default;
    if (!acts[k]) throw new ElabError(`missing argument '${p.name}' in call to '${name}'`, loc);
  });
  s = { ...s, args: acts };
  const args = s.args.map((a, k) => {
    const p = decl.params[k];
    if (!p) throw new ElabError(`too many arguments for '${name}'`, loc);
    if (p.dir === 'out') return null;
    return bindExpr(E, a, null, loc);
  });
  // VHDL `signal` parameters refer to the actual signal (assignments inside the procedure drive
  // it at once, across waits), instead of being copied in and out
  const hasLoc = n => { let found = false; walk(n, x => { if (x.k === 'loc') found = true; }); return found; };
  let sigActuals = null;
  if (E.lang === 'vhdl') {
    s.args.forEach((a, k) => {
      const p = decl.params[k];
      if (!p || String(p.class || '').toLowerCase() !== 'signal') return;
      const actual = a;
      const rv = bindExpr(E, actual, null, loc);
      const lv = p.dir !== 'in' ? bindLvalue(E, actual, loc) : null;
      if (hasLoc(rv) || (lv && hasLoc(lv))) return;     // actual uses process variables: copy semantics
      (sigActuals ||= [])[k] = { rv, lv };
    });
  }
  const fn = boundFunction(entry, s.args.map((a, k) => args[k] || bindLvalue(E, a, loc)), loc, sigActuals);
  const outTargets = s.args.map((a, k) => (decl.params[k] && decl.params[k].dir !== 'in' && !sigActuals?.[k] ? bindLvalue(E, a, loc) : null));
  if (sigActuals) args.forEach((_, k) => { if (sigActuals[k]) args[k] = null; });
  const node = { k: 'task', fn, args, outTargets, loc };
  // signals passed to `signal` parameters of mode in / inout are read by the call
  if (sigActuals) node.sigReads = sigActuals.flatMap((a, k) => (a && decl.params[k].dir !== 'out' ? [a.rv] : []));
  return node;
}

function bindTrigger(E, expr, edge, loc) {
  const n = bindExpr(E, expr, null, loc);
  if (n.k === 'sig') return [{ sig: n.sig, edge, pos: null }];   // pos null: the whole signal
  if (n.k === 'bit' && n.base.k === 'sig' && n.index.k === 'c') return [{ sig: n.base.sig, edge, pos: bitpos(n.base.t, V.toNum(n.index.val)) }];
  const reads = readsOf(n);
  if (edge !== 'any') diag(E, 'edge on a complex expression: treated as any change', loc, 'warning');
  return [...reads].map(sig => ({ sig, edge: 'any', pos: null }));
}

// ---------------------------------------------------------------- read/write analysis
function walk(n, f) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { for (const x of n) walk(x, f); return; }
  if (f(n) === false) return;
  for (const key in n) {
    if (key === 'sig' || key === 't' || key === 'fn' || key === 'val' || key === 'loc' || key === 'triggers') continue;
    const v = n[key];
    if (v && typeof v === 'object') walk(v, f);
  }
}

export function readsOf(n) {
  const reads = new Set();
  walk(n, x => {
    if ((x.k === 'sig' || x.k === 'edge' || x.k === 'event') && x.sig) reads.add(x.sig);
    if (x.k === 'call' && x.fn && !x.fn._visiting) {   // (guard: recursive functions)
      x.fn._visiting = true;
      try { for (const s of x.fn.reads || collectRW(x.fn.body || { k: 'null' }).reads) reads.add(s); } finally { x.fn._visiting = false; }
    }
  });
  return reads;
}

function writesOfL(L) {
  const w = new Set();
  const root = L => {
    if (L.k === 'cat') { L.parts.forEach(root); return; }
    while (L.base) L = L.base;
    if (L.k === 'sig') w.add(L.sig);
  };
  root(L);
  return w;
}

export function collectRW(body) {
  const reads = new Set(), writes = new Set();
  const visitL = L => {
    if (L.k === 'cat') { L.parts.forEach(visitL); return; }
    let x = L;
    while (x.base) {
      for (const key of ['index', 'left', 'right', 'start']) if (x[key]) for (const s of readsOf(x[key])) reads.add(s);
      x = x.base;
    }
    if (x.k === 'sig') writes.add(x.sig);
  };
  walk(body, x => {
    if (x.k === 'asg') {
      visitL(x.target);
      for (const s of readsOf(x.value)) reads.add(s);
      if (x.delay) for (const s of readsOf(x.delay)) reads.add(s);
      return false;
    }
    if (x.k === 'task') {
      x.args.forEach(a => { if (a) for (const s of readsOf(a)) reads.add(s); });
      x.sigReads?.forEach(a => { for (const s of readsOf(a)) reads.add(s); });
      x.outTargets.forEach(L => { if (L) visitL(L); });
      // signals the procedure assigns itself (signal parameters, outer signals)
      if (x.fn && x.fn.body && !x.fn._visiting) {
        x.fn._visiting = true;
        for (const s of collectRW(x.fn.body).writes) writes.add(s);
        x.fn._visiting = false;
      }
      return false;
    }
    if (x.k === 'sys' && (x.name === '$readmemh' || x.name === '$readmemb') && x.args[1]) { visitL(x.args[1]); return false; }
    if ((x.k === 'sig' || x.k === 'edge' || x.k === 'event') && x.sig) reads.add(x.sig);
    if (x.k === 'call' && x.fn && x.fn.body && !x.fn._visiting) {
      x.fn._visiting = true;
      const rw = collectRW(x.fn.body);
      x.fn._visiting = false;
      for (const s of rw.reads) reads.add(s);
    }
  });
  return { reads, writes };
}

function triggersOfReads(n) {
  if (!n) return [];
  return [...collectRW(n).reads].map(sig => ({ sig, edge: 'any', pos: null }));
}

function containsKind(n, kinds) {
  let found = false;
  walk(n, x => { if (kinds.includes(x.k)) found = true; return !found; });
  return found;
}

// ---------------------------------------------------------------- misc
export function exprText(e) {
  if (!e) return '';
  switch (e.op) {
    case 'lit': return e.scalar ? `'${e.bits}'` : (e.bits.length <= 8 ? `"${e.bits}"` : `0x${BigInt('0b' + e.bits.replace(/[xz]/g, '0')).toString(16)}`);
    case 'int': return e.value;
    case 'real': return String(e.value);
    case 'phys': return `${e.value} ${e.unit}`;
    case 'str': return JSON.stringify(e.value);
    case 'ref': return e.name;
    case 'index': return `${exprText(e.base)}[${exprText(e.index)}]`;
    case 'slice': return `${exprText(e.base)}[${exprText(e.left)}:${exprText(e.right)}]`;
    case 'pslice': return `${exprText(e.base)}[${exprText(e.start)}${e.dir}:${exprText(e.width)}]`;
    case 'apply': return `${e.name}(${e.args.map(a => exprText(a.named !== undefined ? a.value : a)).join(', ')})`;
    case 'call': return `${e.name}(${e.args.map(exprText).join(', ')})`;
    case 'concat': return `{${e.parts.map(exprText).join(', ')}}`;
    case 'repl': return `{${exprText(e.count)}{${exprText(e.value)}}}`;
    case 'unary': return `${e.o}${exprText(e.a)}`;
    case 'binary': return `${exprText(e.a)} ${e.o} ${exprText(e.b)}`;
    case 'cond': return `${exprText(e.cond)} ? ${exprText(e.then)} : ${exprText(e.else)}`;
    case 'attr': return `${exprText(e.prefix)}'${e.attr}`;
    case 'aggregate': return `(${e.items.map(i => (i.choices ? i.choices.map(c => (c === 'others' ? 'others' : c.range ? '..' : exprText(c))).join('|') + ' => ' : '') + exprText(i.value)).join(', ')})`;
    case 'qualified': return `${e.type}'(${exprText(e.expr)})`;
    case 'fill': return `'${e.bit}`;
  }
  return '?';
}
