// Test helper (not a test file): two small cycle simulators that check the packer without ISE.
//
//   netlistSim(nl)     the Yosys netlist (core/fpga/netlist.js): LUT1..4, INV, MUXF5..8, MUXCY, XORCY,
//                      FD*/LD* flip-flops and latches, IBUF / OBUF / BUFG
//   packedSim(packed)  the packed design (core/fpga/pack.js) read from its XDL configuration strings
//                      and site-pin nets, with the slice as the Spartan-3E slice works (as the
//                      XDLRC primitive_def SLICEL describes its elements and connections)
//
// Both: sim.step({ port bit name: 0 | 1 }) applies the inputs and settles; sim.out() -> { port bit: v }.
// Flip-flops start at their INIT (as after configuration). Clock edges are found by comparing a
// clock pin with its value at the previous step.
import { evalLut } from '../core/xdl.js';
import { paramBits, paramInt } from '../core/fpga/netlist.js';

const LUT_K = { LUT1: 1, LUT2: 2, LUT3: 3, LUT4: 4 };

export function netlistSim(nl) {
  const v = new Array(nl.nets.length).fill(0);
  v[1] = 1;
  const inPorts = new Map(), outPorts = new Map();
  for (const p of nl.ports) for (const b of p.bits) (p.dir === 'in' ? inPorts : outPorts).set(b.name, b.net);
  const ffs = [];
  for (const c of nl.cells) {
    const m = /^(FD|LD)(\w*?)(_1)?$/.exec(c.type);
    if (!m) continue;
    const init = paramBits(c.params.INIT)?.[0] ?? (/^(FDSE|FDPE|FDS|FDP|LDPE)$/.test(c.type.replace(/_1$/, '')) ? 1 : 0);
    ffs.push({ c, latch: m[1] === 'LD', neg: !!m[3], q: init, prevClk: 0 });
  }
  const setOut = (c, val) => { const n = c.pins.O; if (n !== undefined && n > 1) v[n] = val; };
  const comb = () => {
    for (let it = 0; it < 200; it++) {
      let changed = false;
      const put = (n, val) => { if (n > 1 && v[n] !== val) { v[n] = val; changed = true; } };
      for (const f of ffs) put(f.c.pins.Q, f.q);
      for (const c of nl.cells) {
        const p = k => v[c.pins[k]];
        let o;
        if (LUT_K[c.type]) { const bits = paramBits(c.params.INIT); let i = 0; for (let j = 0; j < LUT_K[c.type]; j++) i |= p(`I${j}`) << j; o = bits[i] || 0; }
        else if (c.type === 'INV') o = 1 - p('I');
        else if (/^MUXF[5-8]$/.test(c.type)) o = p('S') ? p('I1') : p('I0');
        else if (c.type === 'MUXCY') o = p('S') ? p('CI') : p('DI');
        else if (c.type === 'XORCY') o = p('CI') ^ p('LI');
        else if (/^(IBUF|IBUFG|OBUF|BUFG|BUF)$/.test(c.type)) o = p('I');
        else continue;
        put(c.pins.O, o);
      }
      // latches are transparent while their gate is active; they follow the logic once it has
      // settled (both simulators do the same, so a gate and a data input changing together do
      // not race differently in the two)
      if (changed) continue;
      for (const f of ffs) if (f.latch) {
        const c = f.c, g = v[c.pins.G] ^ (f.neg ? 1 : 0) ^ paramInt(c.params.IS_G_INVERTED);
        const ge = c.pins.GE === undefined ? 1 : v[c.pins.GE];
        const clr = c.pins.CLR !== undefined && v[c.pins.CLR], pre = c.pins.PRE !== undefined && v[c.pins.PRE];
        const q = clr ? 0 : pre ? 1 : g && ge ? v[c.pins.D] : f.q;
        if (q !== f.q) { f.q = q; changed = true; }
      }
      if (!changed) return;
    }
    throw new Error('netlistSim: combinational loop');
  };
  void setOut;
  return {
    step(inputs) {
      for (const [k, val] of Object.entries(inputs)) if (inPorts.has(k)) v[inPorts.get(k)] = val;
      comb();
      // flip-flops: asynchronous set / reset, then clock edges
      let again = true;
      for (let round = 0; round < 4 && again; round++) {
        again = false;
        for (const f of ffs) if (!f.latch) {
          const c = f.c, t = c.type.replace(/_1$/, '');
          const clk = v[c.pins.C] ^ (f.neg ? 1 : 0) ^ paramInt(c.params.IS_C_INVERTED);
          const ce = c.pins.CE === undefined ? 1 : v[c.pins.CE];
          let q = f.q;
          if (t === 'FDCE' && v[c.pins.CLR]) q = 0;
          else if (t === 'FDPE' && v[c.pins.PRE]) q = 1;
          else if (clk && !f.prevClk) {
            if (t === 'FDRE' && v[c.pins.R]) q = 0;
            else if (t === 'FDSE' && v[c.pins.S]) q = 1;
            else if (ce) q = v[c.pins.D];
          }
          f.next = q;
          f.nextClk = clk;
        }
        for (const f of ffs) if (!f.latch) { if (f.q !== f.next) again = true; f.q = f.next; f.prevClk = f.nextClk; }
        comb();
      }
    },
    out() { const o = {}; for (const [k, n] of outPorts) o[k] = v[n]; return o; },
  };
}

/** The packed design simulated from its cfg strings. */
export function packedSim(packed) {
  const insts = packed.insts;
  const cfgOf = i => {
    const m = new Map();
    for (const c of i.cfg) m.set(c.attr, c);
    return m;
  };
  const C = insts.map(cfgOf);
  // pin values: inputs by inst:pin, outputs by inst:pin
  const pinNet = new Map();   // `${inst}:${pin}` (input) -> net index
  const netVal = packed.nets.map(n => (n.type === 'vcc' ? 1 : 0));
  const drv = new Map();      // `${inst}:${pin}` (output) -> nets driven
  packed.nets.forEach((n, k) => {
    for (const p of n.inpins) pinNet.set(`${p.inst}:${p.pin}`, k);
    for (const p of n.outpins) { const key = `${p.inst}:${p.pin}`; if (!drv.has(key)) drv.set(key, []); drv.get(key).push(k); }
  });
  const pin = (i, p) => { const k = pinNet.get(`${i}:${p}`); return k === undefined ? 0 : netVal[k]; };
  const st = insts.map((inst, i) => {
    const c = C[i];
    const init = X => (c.get(`FF${X}_INIT_ATTR`)?.value === 'INIT1' ? 1 : 0);
    return { q: { X: init('X'), Y: init('Y') }, prevClk: 0 };
  });
  const pads = new Map();
  insts.forEach((inst, i) => { if (inst.kind === 'iob') pads.set(C[i].get('PAD').name, i); });
  const padIn = new Map();
  // the outputs of one instance from its inputs and state
  function evalInst(i) {
    const inst = insts[i], c = C[i], o = {};
    if (inst.kind === 'iob') { if (inst.dir === 'in') o.I = padIn.get(c.get('PAD').name) || 0; return o; }
    if (inst.kind === 'bufg') { o.O = pin(i, 'I0'); return o; }
    const val = a => c.get(a)?.value;
    const lut = side => {
      const e = c.get(side);
      if (!e) return 0;
      const eq = e.value.replace(/^#LUT:/, '');
      return evalLut(eq, { A1: pin(i, `${side}1`), A2: pin(i, `${side}2`), A3: pin(i, `${side}3`), A4: pin(i, `${side}4`) });
    };
    const F = lut('F'), G = lut('G');
    const inv = (name, p) => (val(name) === `${p}_B` ? 1 - pin(i, p) : pin(i, p));
    const BX = inv('BXINV', 'BX'), BY = inv('BYINV', 'BY');
    const F5 = BX ? F : G;
    const FX = BY ? pin(i, 'FXINA') : pin(i, 'FXINB');
    const cin = val('CYINIT') === 'BX' ? BX : pin(i, 'CIN');
    const cy0 = (v, side) => ({ 0: 0, 1: 1, BX, BY, F1: pin(i, 'F1'), F2: pin(i, 'F2'), G1: pin(i, 'G1'), G2: pin(i, 'G2'), PROD: side === 'F' ? pin(i, 'F1') & pin(i, 'F2') : pin(i, 'G1') & pin(i, 'G2') }[v]);
    const selF = val('CYSELF') === '1' ? 1 : F, selG = val('CYSELG') === '1' ? 1 : G;
    const cyF = selF ? cin : cy0(val('CY0F'), 'F');
    const cyG = selG ? cyF : cy0(val('CY0G'), 'G');
    const xorF = F ^ cin, xorG = G ^ cyF;
    const fxmux = { F, F5, FXOR: xorF }[val('FXMUX')] ?? 0;
    const gymux = { G, FX, GXOR: xorG }[val('GYMUX')] ?? 0;
    Object.assign(o, { X: fxmux, Y: gymux, XB: cyF, YB: cyG, COUT: cyG, F5, FX, XQ: st[i].q.X, YQ: st[i].q.Y });
    o._d = { X: val('DXMUX') === '1' ? fxmux : BX, Y: val('DYMUX') === '1' ? gymux : BY };
    return o;
  }
  const outs = new Array(insts.length);
  const comb = () => {
    for (let it = 0; it < 400; it++) {
      let changed = false;
      for (let i = 0; i < insts.length; i++) {
        const o = evalInst(i);
        outs[i] = o;
        for (const [p, x] of Object.entries(o)) {
          if (p === '_d') continue;
          for (const k of drv.get(`${i}:${p}`) || []) if (netVal[k] !== x) { netVal[k] = x; changed = true; }
        }
      }
      if (changed) continue;
      // latches: transparent while the clock (gate) is LOW after the inverter, once the logic has settled
      for (let i = 0; i < insts.length; i++) {
        const c = C[i];
        for (const X of ['X', 'Y']) if (c.get(`FF${X}`)?.value === '#LATCH') {
          const q = ffNext(i, X, true);
          if (q !== st[i].q[X]) { st[i].q[X] = q; changed = true; }
        }
      }
      if (!changed) return;
    }
    throw new Error('packedSim: combinational loop');
  };
  // the next value of a flip-flop / latch: edge = a rising clock edge happened (or, for a latch, the gate is open)
  function ffNext(i, X, latch) {
    const c = C[i], val = a => c.get(a)?.value;
    const clk = val('CLKINV') === 'CLK_B' ? 1 - pin(i, 'CLK') : pin(i, 'CLK');
    const ce = c.has('CEINV') ? (val('CEINV') === 'CE_B' ? 1 - pin(i, 'CE') : pin(i, 'CE')) : 1;
    const sr = c.has('SRINV') ? (val('SRINV') === 'SR_B' ? 1 - pin(i, 'SR') : pin(i, 'SR')) : 0;
    const srv = val(`FF${X}_SR_ATTR`) === 'SRHIGH' ? 1 : 0;
    const sync = val('SYNC_ATTR') === 'SYNC';
    const q = st[i].q[X];
    if (sr && !sync) return srv;
    if (latch) return !clk && ce ? (sr ? srv : outs[i]._d[X]) : q;   // open while CLKINV's output is low
    const edge = clk && !st[i].prevClk;
    if (!edge) return q;
    if (sr) return srv;
    return ce ? outs[i]._d[X] : q;
  }
  return {
    step(inputs) {
      for (const [k, v] of Object.entries(inputs)) padIn.set(k, v);
      comb();
      for (let round = 0; round < 4; round++) {
        let again = false;
        const next = insts.map((inst, i) => {
          if (inst.kind !== 'slice' || !C[i].has('CLKINV')) return null;
          const c = C[i], val = a => c.get(a)?.value;
          const clk = val('CLKINV') === 'CLK_B' ? 1 - pin(i, 'CLK') : pin(i, 'CLK');
          const r = { clk };
          for (const X of ['X', 'Y']) if (c.get(`FF${X}`)?.value === '#FF') r[X] = ffNext(i, X, false);
          return r;
        });
        next.forEach((r, i) => {
          if (!r) return;
          for (const X of ['X', 'Y']) if (r[X] !== undefined && r[X] !== st[i].q[X]) { st[i].q[X] = r[X]; again = true; }
          st[i].prevClk = r.clk;
        });
        comb();
        if (!again) break;
      }
    },
    out() {
      const o = {};
      insts.forEach((inst, i) => { if (inst.kind === 'iob' && inst.dir === 'out') o[C[i].get('PAD').name] = pin(i, 'O1'); });
      return o;
    },
  };
}

/** Random stimulus on both simulators; returns the first cycle where the outputs differ (-1: none). */
export function compareSims(nl, packed, { cycles = 300, seed = 1, clock = 'clk' } = {}) {
  let a = seed >>> 0 || 1;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const A = netlistSim(nl), B = packedSim(packed);
  const ins = nl.ports.filter(p => p.dir === 'in').flatMap(p => p.bits.map(b => b.name)).filter(n => n !== clock);
  const hasClock = nl.ports.some(p => p.name === clock);
  for (let k = 0; k < cycles; k++) {
    const v = {};
    for (const n of ins) v[n] = rnd() < 0.5 ? 1 : 0;
    // inputs change with the clock low, then the clock rises
    for (const clk of hasClock ? [0, 1] : [0]) {
      const x = { ...v };
      if (hasClock) x[clock] = clk;
      A.step(x); B.step(x);
      const key = o => JSON.stringify(Object.entries(o).sort((x, y) => (x[0] < y[0] ? -1 : 1)));
      const oa = key(A.out()), ob = key(B.out());
      if (oa !== ob) return { cycle: k, clk, netlist: A.out(), packed: B.out(), inputs: x };
    }
  }
  return null;
}
