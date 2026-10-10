// The decisive check: does the routed design (Silinx's packing and placement, routed by ISE's
// par -p) behave like the design? The routed NCD written by `netgen -sim -ofmt vhdl` (SIMPRIM
// primitives, simulated with Silinx's models: core/unisim.js) and the design's RTL are simulated
// with Silinx under the same pseudo-random stimulus; the outputs are compared at every clock cycle.
//
//   node compare.mjs <spec.json> <netgen.vhd> [cycles]
//
// spec.json: { "dir": sources folder (relative to the spec), "files": [...], "top": "top",
//              "sim": { clock, period (ps), cycles, hold, start, prob, bitprob, ranges, late } }
// (the `sim` section as in test/fixtures/designs/*/design.json). The netlist's ports are found by
// name: the port itself, or (when the XDL had no port information) the pad instance's name as
// netgen writes it (<bit>_PAD_PAD / <bit>_OUTBUF_OUT with < > as _).
import fs from 'node:fs';
import path from 'node:path';
import { compile, elaborate } from '../../core/compile.js';
import { Simulator } from '../../core/simulator.js';
import * as V from '../../core/values.js';
import { primitiveSources } from '../../core/unisim.js';

const [specFile, netFile, cyclesArg] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const dir = path.resolve(path.dirname(specFile), (spec.dir || '.').replace(/^~(?=\/)/, process.env.HOME));
const sim = spec.sim;
const CYCLES = +(cyclesArg || sim.cycles);
const langOf = f => (/\.vhdl?$/i.test(f) ? 'vhdl' : 'verilog');

function build(sources, top, what) {
  const lib = compile([...primitiveSources(sources), ...sources]);
  const d = elaborate(lib, top);
  const bad = [...lib.errors, ...d.diags].filter(x => x.severity !== 'warning' || /not modelled|no model/i.test(x.message));
  if (bad.length || !d.top) throw new Error(`${what}: ${bad.slice(0, 6).map(x => `${x.file}:${x.line} ${x.message}`).join('\n') || 'no top'}`);
  return d;
}
function rng(seedText) {
  let a = [...seedText].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 0x9e3779b9);
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function stimulus(name, inputs, cycles) {
  const r = rng(name);
  const bits = w => { let v = 0n; for (let i = 0; i < w; i += 16) v |= BigInt(Math.floor(r() * 65536)) << BigInt(i); return v & ((1n << BigInt(w)) - 1n); };
  const out = [];
  let cur = {};
  for (let k = 0; k < cycles; k++) {
    if (k % (sim.hold || 1) === 0) {
      cur = {};
      for (const { name: p, w } of inputs) {
        if (sim.prob?.[p] !== undefined) cur[p] = r() < sim.prob[p] ? 1n : 0n;
        else if (sim.bitprob?.[p]) cur[p] = sim.bitprob[p].reduce((v, pr, i) => v | (r() < pr ? 1n << BigInt(i) : 0n), 0n);
        else if (sim.ranges?.[p]) { const [lo, hi] = sim.ranges[p]; cur[p] = BigInt(lo + Math.floor(r() * (hi - lo + 1))); }
        else cur[p] = bits(w);
      }
    }
    out.push(k < 3 && sim.start ? { ...cur, ...Object.fromEntries(Object.entries(sim.start).map(([p, v]) => [p, BigInt(v)])) } : cur);
  }
  return out;
}
// as the FPGA after configuration: RTL registers without an initial value start at 0
function powerUp(d) {
  const allX = v => v && !Array.isArray(v) && v.w > 0 && v.x === (1n << BigInt(v.w)) - 1n;
  const zero = v => V.withSign(V.fromInt(0, v.w, false), v.s);
  for (const s of d.signals) { if (Array.isArray(s.val)) s.val = s.val.map(e => (allX(e) ? zero(e) : e)); else if (allX(s.val)) s.val = zero(s.val); }
}

// ports as bits: get(name) -> [{ sig, bit }] (bit index inside the signal, null for a scalar)
function portBits(d, rtlPorts) {
  const own = new Map(d.top.ports.map(p => [p.name.toLowerCase(), p]));
  const map = new Map();
  for (const rp of rtlPorts) {
    const p = own.get(rp.name.toLowerCase());
    if (p && p.sig.t.w === rp.w) { map.set(rp.name, Array.from({ length: rp.w }, (_, i) => ({ sig: p.sig, bit: rp.w === 1 && !p.sig.t.elem ? null : i, whole: true }))); continue; }
    const bits = [];
    for (let i = 0; i < rp.w; i++) {
      const bn = (rp.w === 1 && !rp.bus ? rp.name : `${rp.name}_${i}_`).toLowerCase();
      const cands = [bn, `${bn}_pad_pad`, `${bn}_outbuf_out`, `${bn}pad_pad`, `${bn}outbuf_out`, `${bn.replace(/_$/, '')}_pad_pad`, `${bn.replace(/_$/, '')}_outbuf_out`];
      const q = cands.map(c => own.get(c)).find(Boolean);
      if (!q) throw new Error(`netlist: no port for ${rp.name} bit ${i} (ports: ${[...own.keys()].join(' ')})`);
      bits.push({ sig: q.sig, bit: null });
    }
    map.set(rp.name, bits);
  }
  return map;
}

function run(d, rtlPorts, stim, isNet) {
  const P = sim.period;
  const s = new Simulator(d, { maxWaveEvents: 0 });
  if (!isNet) powerUp(d);
  const pb = portBits(d, rtlPorts);
  const one = (b, v) => {
    if (b.bit === null) s.force(b.sig, V.mk(1, v));
    else throw new Error('vector ports of the netlist: not needed yet');
  };
  const setPort = (name, v) => {
    const bits = pb.get(name);
    if (bits[0].whole) { s.force(bits[0].sig, V.mk(bits[0].sig.t.w, v)); return; }
    bits.forEach((b, i) => one(b, (v >> BigInt(i)) & 1n));
  };
  const read = name => {
    const bits = pb.get(name);
    if (bits[0].whole) return V.toBin(bits[0].sig.val);
    return bits.map(b => V.toBin(b.sig.val)).reverse().join('');
  };
  // the clock: driven by hand (a forced port), low first, rising at (k + 1/2) * P
  const clk = sim.clock;
  const late = new Set(sim.late || []);
  const outs = rtlPorts.filter(p => p.dir !== 'in').map(p => p.name).sort();
  const apply = (vals, which) => { for (const [p, v] of Object.entries(vals)) if (which === undefined || late.has(p) === which) setPort(p, v); };
  if (clk) setPort(clk, 0n);
  apply(stim[0]);
  const res = [];
  for (let k = 0; k < stim.length; k++) {
    const R = P / 2 + k * P;
    s.run(R - 1); if (clk) setPort(clk, 1n);
    s.run(R + P / 4); apply(stim[k], false);
    s.run(R + P / 2); if (clk) setPort(clk, 0n);
    s.run(R + (3 * P) / 4); apply(stim[k], true);
    s.run(R + P - 1000);
    res.push(outs.map(o => `${o}=${read(o)}`).join(' '));
  }
  return res;
}

const rtlSrcs = spec.files.map(f => ({ path: f, lang: langOf(f), text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const rtl = build(rtlSrcs, spec.top, 'RTL');
const rtlPorts = rtl.top.ports.map(p => ({ name: p.name, dir: p.dir, w: p.sig.t.w, bus: !!p.sig.t.elem || p.sig.t.w > 1 }));
const inputs = rtlPorts.filter(p => p.dir === 'in' && p.name !== sim.clock).map(p => ({ name: p.name, w: p.w }));
const stim = stimulus(spec.top, inputs, CYCLES);
let t = Date.now();
const a = run(rtl, rtlPorts, stim, false);
console.log(`RTL: ${CYCLES} cycles in ${Date.now() - t} ms, ${new Set(a).size} distinct output states`);
const net = { path: path.basename(netFile), lang: 'vhdl', text: fs.readFileSync(netFile, 'utf8') };
const nd = build([net], spec.netTop || spec.top, 'netlist');
t = Date.now();
const b = run(nd, rtlPorts, stim, true);
console.log(`routed netlist: ${CYCLES} cycles in ${Date.now() - t} ms`);
const k = a.findIndex((x, i) => x !== b[i]);
if (k < 0) console.log(`IDENTICAL: the outputs of the routed design equal the RTL's at every one of ${CYCLES} cycles`);
else { console.log(`DIFFERENT at cycle ${k}:\n  inputs ${JSON.stringify(stim[k], (_, v) => (typeof v === 'bigint' ? v.toString(16) : v))}\n  RTL     ${a[k]}\n  netlist ${b[k]}`); process.exitCode = 1; }
