// Test helper (not a test file): differential testing of the open synthesis. A design is simulated
// twice under the same seeded random stimulus, cycle by cycle:
//
//   RTL      Silinx's front end (core/compile.js, core/elaborate.js) and simulator (core/simulator.js)
//   netlist  the same design written by core/synth-verilog.js and mapped by Yosys (synthesizeOpen,
//            YoWASP), or (from: 'source') the original Verilog read by Yosys's own front end
//            (synthesizeSource: this checks Silinx's parser, elaborator and simulator, which the
//            first path shares between both sides), simulated cell by cell:
//              engine 'cells'   test/fpga-sim.js netlistSim on the JSON netlist (LUTs, MUXF*, carry
//                               chain, FD* / LD*, distributed RAMs, MULT18X18, buffers), an
//                               independent model of the cells
//              engine 'unisim'  Yosys's Verilog netlist compiled by Silinx with its primitive models
//                               (core/unisim.js): block RAMs, DCMs, BUFGMUX, tri-state buffers,
//                               several clocks, a harness around the top
//              engine 'auto'    'cells' when netlistSim models every cell and the stimulus allows it,
//                               else 'unisim'
//
//   const r = await diffSynth({ name, sources, top, sim, seed, engine })
//   r = { name, status: 'pass' | 'mismatch' | 'unsupported' | 'error', stage, reason, engine, cells,
//         cycles, states, mismatch: { cycle, inputs, rtl, netlist, ports }, report, ms }
//
// The stimulus (as in test/netgen-fixtures.test.js): cycle k's clock rises at R = (k + 1/2) * P, the
// inputs of cycle k are applied at R + P/4 (the `late` ones at R + 3P/4) and the outputs are sampled
// before the next rising edge. Clocks are the inputs that reach a clock pin in the netlist, plus the
// ports named clk* / clock*; all clocks run in phase (`sim.clocks` gives others their own period).
// Resets (inputs named rst / reset / clr…, active low when they end in n / _n / _b) are asserted in
// cycles 0 and 1 and then with a probability of 2 %. A design without a clock is combinational: one
// random input vector per "cycle".
//
// Power-up and X rule (what is compared):
//   - the netlist starts with its flip-flops and latches at their INIT values (as after configuring
//     the FPGA); Yosys takes INIT from the HDL's initial values, 0 when there is none;
//   - the RTL starts with the declared initial values; signals without one (all X: VHDL 'U',
//     Verilog x) start at 0 instead, as the FPGA powers up (option powerUp: false keeps the X's);
//   - an output bit that the RTL has at X (or Z) is not compared (don't care: the RTL leaves it
//     undefined, any netlist value implements it); every known RTL bit must equal the netlist's
//     bit (an X there is a difference);
//   - cycles before `sim.skip` (default 0) are not compared;
//   - when the RTL powered up at 0 differs, it is run again with the X's kept (the language's
//     power-up): Yosys may give a register or memory word that is never set any value; the design
//     passes if that run agrees (result powerUp: 'x'). powerUp: true / false forces one rule.
import { compile, elaborate } from '../core/compile.js';
import { Simulator } from '../core/simulator.js';
import * as V from '../core/values.js';
import { primitiveSources, UNISIM_SOURCE } from '../core/unisim.js';
import { synthesizeOpen, cellCounts } from '../core/synth-open.js';
import { SynthError } from '../core/synth-verilog.js';
import { yosysNode } from '../core/synth-open-node.js';
import { readYosysJson } from '../core/fpga/netlist.js';
import { netlistSim, CELLS_SIMULATED } from './fpga-sim.js';

// deterministic pseudo-random numbers (mulberry32)
export function rng(seed) {
  let a = typeof seed === 'string' ? [...seed].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 0x9e3779b9) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RESET = /^(n_?)?(a|s)?(rst|reset|clr|clear)(_?n|_?b|_?l)?$/i;
export const isReset = n => RESET.test(n);
export const activeLow = n => /^n_?(a|s)?(rst|reset|clr|clear)|(rst|reset|clr|clear)(_?n|_?b|_?l)$/i.test(n);
const CLOCK_NAME = /^(clk|clock)/i;
const CLOCK_PINS = new Set(['C', 'WCLK', 'CLK', 'CLKA', 'CLKB', 'CLKIN', 'I0', 'I1']);
const BUFFERS = /^(IBUF|IBUFG|BUFG|BUFGP|BUFGCE|BUF)$/;

/** Input ports whose net reaches a clock pin (through input and clock buffers). */
export function netlistClocks(nl) {
  const loads = new Map();
  nl.nets.forEach(n => loads.set(n.id, n.loads));
  const reaches = (net, depth) => {
    for (const { cell, pin } of loads.get(net) || []) {
      const c = nl.cells[cell];
      if (BUFFERS.test(c.type) && depth < 4) { if (reaches(c.pins.O, depth + 1)) return true; }
      else if (/^(FD|RAM|SRL|MULT18X18S)/.test(c.type) && CLOCK_PINS.has(pin) && !/^I[01]$/.test(pin)) return true;
      else if (/^BUFGMUX/.test(c.type) && /^I[01]$/.test(pin)) return true;
    }
    return false;
  };
  return nl.ports.filter(p => p.dir === 'in' && p.bits.length === 1 && reaches(p.bits[0].net, 0)).map(p => p.name.toLowerCase());
}

/** Input values per cycle: [{ port: BigInt }] (the `sim` options of test/fixtures/designs/<d>/design.json). */
export function stimulus(r, sim, inputs, cycles) {
  const bits = w => { let v = 0n; for (let i = 0; i < w; i += 16) v |= BigInt(Math.floor(r() * 65536)) << BigInt(i); return v & V.mask(w); };
  const out = [];
  let cur = {};
  const resets = sim.resets ?? inputs.filter(p => p.w === 1 && isReset(p.name)).map(p => p.name);
  const lowRst = new Set(resets.filter(activeLow).map(n => n.toLowerCase()));
  const resetCycles = sim.resetCycles ?? 2;
  for (let k = 0; k < cycles; k++) {
    if (k % (sim.hold || 1) === 0) {
      cur = {};
      for (const { name: p, w } of inputs) {
        if (sim.prob?.[p] !== undefined) cur[p] = r() < sim.prob[p] ? 1n : 0n;
        else if (sim.bitprob?.[p]) cur[p] = sim.bitprob[p].reduce((v, pr, i) => v | (r() < pr ? 1n << BigInt(i) : 0n), 0n);
        else if (sim.ranges?.[p]) { const [lo, hi] = sim.ranges[p]; cur[p] = BigInt(lo + Math.floor(r() * (hi - lo + 1))); }
        else if (resets.includes(p)) { const on = r() < 0.02; cur[p] = on !== lowRst.has(p.toLowerCase()) ? 1n : 0n; }
        else {
          // mostly uniform; sometimes all zeros / all ones / one bit, which random vectors rarely give
          const q = r();
          cur[p] = q < 0.06 ? 0n : q < 0.12 ? V.mask(w) : q < 0.18 ? 1n << BigInt(Math.floor(r() * w)) : bits(w);
        }
      }
      for (const [a, b] of Object.entries(sim.equalBias || {})) if (r() < 0.2) cur[a] = cur[b];
      // ports of a dual-port memory that must not address the same word in the same cycle
      for (const d of sim.distinct || []) {
        const m = BigInt(d.mask), sa = BigInt(d.shiftA || 0), sb = BigInt(d.shiftB || 0);
        if (((cur[d.a] >> sa) & m) === ((cur[d.b] >> sb) & m)) cur[d.b] ^= 1n << sb;
      }
    }
    let c = cur;
    if (k < 3 && sim.start) c = { ...c, ...Object.fromEntries(Object.entries(sim.start).map(([p, v]) => [p, BigInt(v)])) };
    if (k < resetCycles && resets.length && !sim.prob) c = { ...c, ...Object.fromEntries(resets.map(p => [p, lowRst.has(p.toLowerCase()) ? 0n : 1n])) };
    else if (k < resetCycles && resets.length) c = { ...c, ...Object.fromEntries(resets.filter(p => sim.prob[p] === undefined).map(p => [p, lowRst.has(p.toLowerCase()) ? 0n : 1n])) };
    out.push(c);
  }
  return out;
}

/** Signals without an initial value (all X) start at 0, as the FPGA powers up. */
export function powerUp(d) {
  const allX = v => v && !Array.isArray(v) && v.w > 0 && v.x === V.mask(v.w) && !v.real;
  for (const s of d.signals) {
    if (Array.isArray(s.val)) s.val = s.val.map(e => (allX(e) ? V.withSign(V.fromInt(0, e.w, false), e.s) : e));
    else if (allX(s.val)) s.val = V.withSign(V.fromInt(0, s.val.w, false), s.val.s);
  }
}

/**
 * Run an elaborated design under the stimulus with Silinx's simulator.
 * Returns per cycle { port(lower case): { v, x } } for the `outs` ports.
 */
export function runSilinx(design, { clocks, sim, stim, outs, P = 20000, power = true }) {
  const s = new Simulator(design, { maxWaveEvents: 0, maxDeltas: 20000 });
  if (power) powerUp(design);
  const port = new Map(design.top.ports.map(p => [p.name.toLowerCase(), p]));
  for (const c of clocks) {
    const o = sim.clocks?.[c];
    if (port.has(c)) s.addClock(port.get(c).sig, o ? { period: o.period, offset: o.offset || 0 } : { period: P });
  }
  const late = new Set((sim.late || []).map(x => x.toLowerCase()));
  const apply = (vals, which) => {
    for (const [p, v] of Object.entries(vals)) {
      if (which !== undefined && late.has(p.toLowerCase()) !== which) continue;
      const pt = port.get(p.toLowerCase());
      if (pt) s.force(pt.sig, V.mk(pt.sig.t.w, v));
    }
  };
  const res = [];
  if (!stim.length) return res;
  apply(stim[0]);
  for (let k = 0; k < stim.length; k++) {
    const R = P / 2 + k * P;
    s.run(R + P / 4); apply(stim[k], false);
    s.run(R + (3 * P) / 4); apply(stim[k], true);
    s.run(R + P - 1000);
    if (s.finished) throw new Error(`the simulation stopped (${s.finished})`);
    const o = {};
    for (const n of outs) { const v = port.get(n)?.sig.val; o[n] = v ? { v: v.v, x: v.x } : { v: 0n, x: -1n }; }
    res.push(o);
  }
  return res;
}

/** The same with netlistSim (all clocks in phase). */
export function runCells(nl, { clocks, sim, stim, outs }) {
  const s = netlistSim(nl);
  const ports = new Map(nl.ports.map(p => [p.name.toLowerCase(), p]));
  const late = new Set((sim.late || []).map(x => x.toLowerCase()));
  const vec = (vals, which) => {
    const x = {};
    for (const [p, v] of Object.entries(vals)) {
      if (which !== undefined && late.has(p.toLowerCase()) !== which) continue;
      const pt = ports.get(p.toLowerCase());
      if (pt) pt.bits.forEach((b, i) => { x[b.name] = Number((v >> BigInt(i)) & 1n); });
    }
    return x;
  };
  const clk = val => Object.fromEntries(clocks.filter(c => ports.has(c)).map(c => [ports.get(c).bits[0].name, val]));
  const res = [];
  if (!stim.length) return res;
  s.step({ ...vec(stim[0]), ...clk(0) });
  for (let k = 0; k < stim.length; k++) {
    s.step(clk(1));
    s.step(vec(stim[k], false));
    s.step(clk(0));
    if (late.size) s.step(vec(stim[k], true));
    const o = s.out(), r = {};
    for (const n of outs) {
      const pt = ports.get(n);
      let v = 0n;
      pt.bits.forEach((b, i) => { if (o[b.name]) v |= 1n << BigInt(i); });
      r[n] = { v, x: 0n };
    }
    res.push(r);
  }
  return res;
}

const fmt = (val, w) => {
  if (val.x === -1n) return '(none)';
  // wide values in hexadecimal (a digit with an X or Z bit: x)
  if (w > 64) {
    let h = '';
    for (let i = Math.ceil(w / 4) - 1; i >= 0; i--) h += (val.x >> BigInt(4 * i)) & 15n ? 'x' : ((val.v >> BigInt(4 * i)) & 15n).toString(16);
    return `${w}'h${h}`;
  }
  let s = '';
  for (let i = w - 1; i >= 0; i--) {
    const b = 1n << BigInt(i);
    s += val.x & b ? (val.v & b ? 'z' : 'x') : val.v & b ? '1' : '0';
  }
  return s;
};

/** First cycle where a known RTL output bit differs from the netlist's (from cycle `skip`). */
export function compareRuns(rtl, net, widths, skip = 0) {
  for (let k = skip; k < rtl.length; k++) {
    const bad = [];
    for (const [n, w] of widths) {
      const a = rtl[k][n], b = net[k][n], m = V.mask(w);
      if (!a || !b) continue;
      const known = m & ~a.x;
      if (((a.v ^ b.v) & known) || (b.x & known)) bad.push(n);
    }
    if (bad.length) return { cycle: k, ports: bad };
  }
  return null;
}

const hex = o => Object.entries(o).map(([k, v]) => `${k}=${v.toString(16)}`).join(' ');

/** Elaborate `sources` and check: { design } or { status, stage, reason }. */
export function frontEnd(sources, top) {
  let lib;
  try { lib = compile([...primitiveSources(sources), ...sources]); }
  catch (e) { return { status: 'unsupported', stage: 'parse', reason: e.message }; }
  const perr = lib.errors.filter(d => d.severity === 'error');
  if (perr.length) return { status: 'unsupported', stage: 'parse', reason: `${perr[0].file}:${perr[0].line} ${perr[0].message}`, lib };
  let design;
  try { design = elaborate(lib, top); }
  catch (e) { return { status: 'unsupported', stage: 'elaborate', reason: e.message, lib }; }
  const eerr = design.diags.filter(d => d.severity === 'error');
  if (eerr.length || !design.top) return { status: 'unsupported', stage: 'elaborate', reason: eerr.length ? `${eerr[0].file}:${eerr[0].line} ${eerr[0].message}` : 'no top', lib };
  return { design, lib };
}

/**
 * Yosys on the original Verilog sources (its own front end instead of Silinx's): the netlist that
 * Silinx's simulation of the same sources is compared with tests Silinx's parser, elaborator and
 * simulator against Yosys's reading of the language.
 */
export async function synthesizeSource(sources, top, { run = yosysNode, onLine = () => {}, family = 'xc3se' } = {}) {
  const files = {}, reads = [];
  sources.forEach((s, i) => {
    const f = `src${i}_${String(s.path).split(/[\\/]/).pop().replace(/[^\w.]/g, '_')}`;
    files[f] = s.text;
    reads.push(`read_verilog -defer${/\.sv$/i.test(s.path) ? ' -sv' : ''} ${f}`);
  });
  const script = `${reads.join('; ')}; synth_xilinx -family ${family} -ise -flatten -top ${top}; delete t:$scopeinfo; write_json ${top}.json; write_verilog -noattr ${top}_yosys.v`;
  const out = await run(['-q', '-p', script], files, onLine);
  if (!out[`${top}.json`]) throw new Error('Yosys wrote no netlist');
  return { top, files: { [`${top}.json`]: out[`${top}.json`], [`${top}_yosys.v`]: out[`${top}_yosys.v`] || '' }, cells: cellCounts(out[`${top}.json`], top) };
}

/**
 * Differential test of one design. spec: { name, sources, top, sim: { cycles, clock, clocks, prob,
 * ranges, late, hold, start, skip, harness, resets, resetCycles }, seed, engine, run, powerUp, from }.
 * from: 'silinx' (default: synthesizeOpen, Silinx's front end and core/synth-verilog.js) | 'source'
 * (Yosys reads the original Verilog sources: synthesizeSource).
 * sim.harness: extra sources whose top `sim.harnessTop` instantiates the design (inout ports).
 */
export async function diffSynth(spec) {
  const t0 = Date.now();
  const { name, sources, top, seed = name, engine = 'auto', run = yosysNode } = spec;
  const sim = { cycles: 200, ...spec.sim };
  const done = r => ({ name, ms: Date.now() - t0, ...r });
  const fe = frontEnd(sources, top);
  if (!fe.design) return done(fe);
  const design = fe.design;
  // synthesis
  let syn;
  const lines = [];
  try { syn = spec.from === 'source' ? await synthesizeSource(sources, design.top.name, { run, onLine: l => lines.push(l) }) : await synthesizeOpen(design, { run, onLine: l => lines.push(l) }); }
  catch (e) {
    const yosys = lines.find(l => /^ERROR/.test(l));
    return done({ status: e instanceof SynthError ? 'unsupported' : 'error', stage: e instanceof SynthError ? 'synth-verilog' : 'yosys', reason: yosys || e.message });
  }
  return done(compareNetlist(design, syn, { ...spec, sim, seed, engine }));
}

/**
 * The comparison itself, for a design already elaborated and its netlist (syn: { top, files:
 * { '<top>.json', '<top>_yosys.v' }, cells }). Options as diffSynth's.
 */
export function compareNetlist(design, syn, spec) {
  const { name, seed = name, engine = 'auto' } = spec;
  const sim = { cycles: 200, ...spec.sim };
  const done = r => r;
  let nl;
  try { nl = readYosysJson(syn.files[`${syn.top}.json`], { top: syn.top }); }
  catch (e) { return { status: 'error', stage: 'netlist', reason: e.message, cells: syn.cells }; }
  const harness = sim.harness || [];
  const ports = design.top.ports;
  if (!harness.length && ports.some(p => p.dir === 'inout')) return done({ status: 'unsupported', stage: 'stimulus', reason: 'inout ports (needs a harness)', cells: syn.cells });
  const outs = ports.filter(p => p.dir === 'out').map(p => p.name.toLowerCase()).sort();
  const nlPorts = new Map(nl.ports.map(p => [p.name.toLowerCase(), p]));
  const missing = outs.filter(n => !nlPorts.has(n));
  if (missing.length) return done({ status: 'error', stage: 'netlist', reason: `outputs missing from the netlist: ${missing.join(', ')}`, cells: syn.cells });
  if (!outs.length) return done({ status: 'unsupported', stage: 'stimulus', reason: 'no outputs', cells: syn.cells });
  // the widths compared: the netlist's (integers have the width of their range there)
  const widths = outs.map(n => [n, nlPorts.get(n).bits.length]);
  const clockSet = new Set([...(sim.clock ? [sim.clock.toLowerCase()] : []), ...Object.keys(sim.clocks || {}).map(c => c.toLowerCase()), ...netlistClocks(nl)]);
  for (const p of ports) if (p.dir === 'in' && p.sig.t.w === 1 && CLOCK_NAME.test(p.name)) clockSet.add(p.name.toLowerCase());
  const clocks = [...clockSet];
  const inputs = ports.filter(p => p.dir === 'in' && !clockSet.has(p.name.toLowerCase())).map(p => ({ name: p.name, w: p.sig.t.w }));
  const stim = stimulus(rng(seed), sim, inputs, sim.cycles);
  // which engine
  const unmodelled = [...new Set(nl.cells.map(c => c.type))].filter(t => !CELLS_SIMULATED.test(t));
  const eng = engine !== 'auto' ? engine : unmodelled.length || harness.length || sim.clocks ? 'unisim' : 'cells';
  const power = spec.powerUp !== false;
  let rtl, net;
  try { rtl = runSilinx(design, { clocks, sim, stim, outs, power }); }
  catch (e) { return done({ status: 'error', stage: 'rtl-sim', reason: e.message, cells: syn.cells, engine: eng }); }
  try {
    if (eng === 'cells') net = runCells(nl, { clocks, sim, stim, outs });
    else {
      // a flip-flop whose register had no initial value gets INIT x from Yosys: 0 in the bitstream
      const text = syn.files[`${syn.top}_yosys.v`].replace(/\.INIT\((\d+)'([bh])([0-9a-fx]+)\)/g, (_, w, b, d) => `.INIT(${w}'${b}${d.replace(/x/g, '0')})`);
      const src = { path: `${syn.top}_yosys.v`, lang: 'verilog', text };
      const fn = frontEnd([UNISIM_SOURCE, src, ...harness], harness.length ? sim.harnessTop : syn.top);
      if (!fn.design) return done({ status: 'error', stage: 'netlist-sim', reason: `the Yosys netlist does not elaborate: ${fn.reason}`, cells: syn.cells, engine: eng });
      net = runSilinx(fn.design, { clocks, sim, stim, outs, power: false });
    }
  } catch (e) { return done({ status: 'error', stage: 'netlist-sim', reason: e.message, cells: syn.cells, engine: eng }); }
  const states = new Set(rtl.map(o => outs.map(n => `${o[n].v}/${o[n].x}`).join())).size;
  const mm = compareRuns(rtl, net, widths, sim.skip || 0);
  if (spec.keep) Object.assign(spec.keep, { rtl, net, stim, outs, syn });
  if (!mm) return done({ status: 'pass', engine: eng, cells: syn.cells, cycles: stim.length, states });
  // the registers without an initial value at X (as the language says) instead of 0: Yosys may
  // implement an X power-up value as anything (a memory word never written, a register never set)
  if (spec.powerUp === undefined) {
    try {
      const rtlX = runSilinx(design, { clocks, sim, stim, outs, power: false });
      if (!compareRuns(rtlX, net, widths, sim.skip || 0)) return done({ status: 'pass', engine: eng, cells: syn.cells, cycles: stim.length, states, powerUp: 'x' });
    } catch { /* the first difference is reported */ }
  }
  const k = mm.cycle, W = new Map(widths);
  const line = (o, which) => mm.ports.map(n => `${n}=${fmt(o[n], W.get(n))}`).join(' ') + (which ? '' : '');
  const report = `${name}: the netlist differs from the RTL at cycle ${k} (engine ${eng}, seed ${JSON.stringify(seed)})\n`
    + `  inputs  ${hex(stim[k])}${clocks.length ? ` (clocks ${clocks.join(', ')})` : ''}\n`
    + `  RTL     ${line(rtl[k])}\n  netlist ${line(net[k])}`
    + (k > 0 ? `\n  (cycle ${k - 1}: inputs ${hex(stim[k - 1])})` : '');
  return done({ status: 'mismatch', engine: eng, cells: syn.cells, cycles: stim.length, states, mismatch: { ...mm, inputs: stim[k], rtl: rtl[k], netlist: net[k] }, report, reason: `cycle ${k}: ${mm.ports.join(', ')}` });
}
