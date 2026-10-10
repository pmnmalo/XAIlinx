// Silinx - packer: the cells of a Spartan-3E netlist (core/fpga/netlist.js) grouped into the sites
// of the chip (browser + Node).
//
// A Spartan-3E slice has two 4-input LUTs (F, G), two flip-flops (FFX fed from the F side, FFY from
// the G side), the F5MUX (F or G, selected by BX), one wide multiplexer FiMUX (F6, F7 or F8 depending
// on the slice, inputs FXINA / FXINB from neighbouring slices, selected by BY) and two stages of the
// carry chain (CYMUXF / XORF on the F side, CYMUXG / XORG on the G side; COUT of slice Y feeds CIN of
// slice Y+1 in the same column). Both flip-flops share the clock, the clock enable, the set/reset and
// its synchronous / asynchronous mode. Every site output goes through a multiplexer with a few
// fixed choices: X = F, F5 or the XORF sum (FXMUX), Y = G, the FiMUX or the XORG sum (GYMUX); the
// flip-flops take their D from that multiplexer or from BX / BY (DXMUX / DYMUX).
//
// pack(netlist, { ucf, part }) -> {
//   name, part, cfg (the design's cfg string: the ports' bus information, raw XDL text),
//   insts:  [{ name, type: 'SLICEL' | 'IBUF' | 'IOB' | 'BUFGMUX', cfg: [{ attr, name, value }], loc: pad | null }],
//   nets:   [{ name, type: 'wire' | 'gnd' | 'vcc', outpins: [{ inst, pin }], inpins: [{ inst, pin }] }]   (inst = index)
//   macros: [{ kind: 'carry' | 'F6' | 'F7' | 'F8', members: [{ inst, dx, dy }] }]   slices that must keep these
//           relative positions (slice coordinates: SLICE_X(x+dx)Y(y+dy))
//   stats:  { slices, luts, ffs, carry, muxes, iobs, bufgs, copies, passthru }, warnings: [] }
// The cfg strings are those ISE writes for the same settings (xdl -ncd2xdl), without the settings
// that are off, which is what xdl -xdl2ncd expects of a design.
import { paramBits, paramInt } from './netlist.js';
import { initToEquation } from './lut.js';
import { parseUcf } from '../ucf.js';

export class PackError extends Error {}

// ------------------------------------------------------------------ cells
const LUT_K = { LUT1: 1, LUT2: 2, LUT3: 3, LUT4: 4 };
// flip-flops and latches: the pin of the set / reset, whether it sets, whether it is synchronous
const FF_KIND = {
  FDRE: { sr: 'R', high: false, sync: true }, FDSE: { sr: 'S', high: true, sync: true },
  FDCE: { sr: 'CLR', high: false, sync: false }, FDPE: { sr: 'PRE', high: true, sync: false },
  FD: { sr: null }, FDE: { sr: null }, FDR: { sr: 'R', high: false, sync: true }, FDS: { sr: 'S', high: true, sync: true },
  FDC: { sr: 'CLR', high: false, sync: false }, FDP: { sr: 'PRE', high: true, sync: false },
  LDCE: { sr: 'CLR', high: false, sync: false, latch: true }, LDPE: { sr: 'PRE', high: true, sync: false, latch: true },
  LD: { sr: null, latch: true }, LDE: { sr: null, latch: true },
};
const ffKind = type => {
  const m = /^(\w+?)(_1)?$/.exec(type);
  const k = m && FF_KIND[m[1]];
  return k ? { ...k, neg: !!m[2] } : null;
};
const MUXF = { MUXF5: 5, MUXF6: 6, MUXF7: 7, MUXF8: 8 };

// Wide multiplexers in a CLB (slices S0 = (0,0), S1 = (0,1), S2 = (1,0), S3 = (1,1) from the CLB's
// bottom-left slice): which FiMUX each slice has, and where its inputs come from (I1 on FXINA,
// I0 on FXINB). F6 combines the F5 of its own slice and the slice above; F7 the F6 of the two
// slices at the bottom; F8 the F7 of its own CLB and of the CLB above. (As ISE places lab11's
// MUXF6 / F7 / F8: research/s3e-place/wide-mux.mjs. MUXF5: LUT F is I1, selected by BX = 1.)
export const WIDE_MUX = {
  6: [{ at: [0, 0], a: [0, 0], b: [0, 1] }, { at: [1, 0], a: [1, 0], b: [1, 1] }],
  7: [{ at: [0, 1], a: [0, 0], b: [1, 0] }],
  8: [{ at: [1, 1], a: [0, 1], b: [0, 3] }],
};

// names: Yosys's names may hold ':', '\\', blanks or quotes, which XDL would need escaped inside cfg
// strings; they are replaced, so every name is a plain word
const clean = s => String(s).replace(/^\\/, '').replace(/[\s"\\:]/g, '_');
const escCfg = clean;

/** Pack a netlist. ucf: UCF text or parseUcf() result (LOC, IOSTANDARD, DRIVE, SLEW, PULL). */
export function pack(nl, { ucf = null, part = 'xc3s250ecp132-4' } = {}) {
  const warnings = [];
  const cons = typeof ucf === 'string' ? parseUcf(ucf).assignments : ucf?.assignments || ucf || {};
  // own copies: the packer renames pins (INV -> LUT1, MUXF -> LUT3) and must not change its input
  const nets = nl.nets.map(n => ({ ...n, loads: n.loads.map(l => ({ ...l })) }));
  const cells = nl.cells.map((c, idx) => ({ ...c, pins: { ...c.pins }, idx }));
  const loadsOf = n => nets[n].loads;

  // INV / BUF are 1-input LUTs
  for (const c of cells) {
    if (c.type === 'INV') { c.type = 'LUT1'; c.params = { INIT: '01' }; c.pins = { I0: c.pins.I, O: c.pins.O }; relabel(c, { I: 'I0' }); }
    else if (c.type === 'BUF') { c.type = 'LUT1'; c.params = { INIT: '10' }; c.pins = { I0: c.pins.I, O: c.pins.O }; relabel(c, { I: 'I0' }); }
  }
  function relabel(c, map) {
    for (const n of Object.values(c.pins)) for (const l of nets[n].loads) if (l.cell === c.idx && map[l.pin]) l.pin = map[l.pin];
  }
  const ci = c => c.idx;
  const isLut = c => LUT_K[c.type] !== undefined;
  const driverCell = n => (nets[n].driver ? cells[nets[n].driver.cell] : null);
  const unsupported = cells.filter(c => !isLut(c) && !ffKind(c.type) && !MUXF[c.type] && !/^(MUXCY|XORCY|IBUF|IBUFG|OBUF|BUFG)$/.test(c.type));
  if (unsupported.length) throw new PackError(`pack: cells not supported yet: ${[...new Set(unsupported.map(c => c.type))].join(', ')}`);

  // ---------------------------------------------------------------- the placed elements
  // Every netlist cell lands in one place. Its input pins are either internal to the site
  // (sink[cell][pin] = 'int') or a site pin { inst, pin, kind }; its output gets site pins when
  // something outside needs it (src[cell] = { gen: { inst, pin }, f5: …, fx: …, cy: … }).
  const insts = [];
  const sink = new Map();          // `${cell}:${pin}` -> 'int' | { inst, pin, kind }
  const extra = [];                // inputs of LUTs added by the packer (copies, route-throughs): { net, inst, pin }
  const where = new Map();         // cell -> { inst, bel }
  const setSink = (c, pin, v) => sink.set(`${c}:${pin}`, v);
  const stats = { copies: 0, passthru: 0 };
  let ucount = 0;
  const unique = names => base => { let n = clean(base); if (names.has(n)) { let k = 1; while (names.has(`${n}_${k}`)) k++; n = `${n}_${k}`; } names.add(n); return n; };
  const uniqueName = unique(new Set());       // instances
  const uniqueNet = unique(new Set());        // nets

  // A slice under construction.
  const newSlice = () => {
    const s = { kind: 'slice', type: 'SLICEL', lut: { F: null, G: null }, ff: { X: null, Y: null }, f5: null, fi: null,
      carry: null, out: { X: null, Y: null }, b: { X: null, Y: null }, ctrl: null, idx: insts.length };
    insts.push(s);
    return s;
  };
  // a LUT for a slot: { name, k, init (msb first), inputs: [net], pins: [site pin of each input], cell (index or -1), out: net }
  const lutOf = c => ({ name: c.name, k: LUT_K[c.type], init: lutInit(c), inputs: Array.from({ length: LUT_K[c.type] }, (_, j) => c.pins[`I${j}`]), pins: [1, 2, 3, 4].slice(0, LUT_K[c.type]), cell: ci(c), out: c.pins.O });
  function lutInit(c) {
    const k = LUT_K[c.type], bits = paramBits(c.params.INIT) || [];
    let s = '';
    for (let i = (1 << k) - 1; i >= 0; i--) s += bits[i] ? '1' : '0';
    return s;
  }
  // a LUT that passes its input through (route-through), or a constant
  const passLut = (net, name) => {
    stats.passthru++;
    if (nets[net].const !== undefined) return { name, k: 0, init: String(nets[net].const), inputs: [], pins: [], cell: -1, out: null };
    return { name, k: 1, init: '10', inputs: [net], pins: [1], cell: -1, out: null };
  };
  // the netlist loads of a net that are not the given (cell, pin) pairs
  const otherLoads = (net, except) => loadsOf(net).filter(l => !except.some(([c, p]) => l.cell === c && l.pin === p));

  // Put a LUT for `net` into slot side of slice s, for internal use by (cell, pin) pairs `users`.
  // The driving LUT cell moves in when nothing else needs it (or `outFree`: its output can leave
  // through X / Y); otherwise a copy goes in; a net not driven by a LUT gets a route-through.
  function lutFor(s, side, net, users, outFree) {
    const d = driverCell(net);
    let lut;
    if (d && isLut(d) && !where.has(ci(d)) && (outFree || !otherLoads(net, users).length)) {
      lut = lutOf(d);
      placeLut(s, side, lut, ci(d));
    } else if (d && isLut(d)) {
      lut = { ...lutOf(d), name: `${d.name}_copy${++ucount}`, cell: -1 };
      stats.copies++;
      placeLut(s, side, lut, -1);
    } else {
      lut = passLut(net, `${nets[net].name}_thru${++ucount}`);
      placeLut(s, side, lut, -1);
    }
    for (const [c, p] of users) setSink(c, p, 'int');
    return lut;
  }
  function placeLut(s, side, lut, cell) {
    if (s.lut[side]) throw new PackError(`pack: LUT ${side} of a slice used twice`);
    s.lut[side] = lut;
    if (cell >= 0) where.set(cell, { inst: s.idx, bel: side });
  }

  // ---------------------------------------------------------------- control sets of flip-flops
  function ffInfo(c) {
    const k = ffKind(c.type);
    const p = c.params || {};
    const inv = n => paramInt(p[n]) === 1;
    const clkPin = k.latch ? 'G' : 'C', cePin = k.latch ? 'GE' : 'CE';
    const ce = c.pins[cePin], sr = k.sr ? c.pins[k.sr] : undefined;
    const ceNet = ce === undefined || (nets[ce].const === 1 && !inv(`IS_${cePin}_INVERTED`)) ? null : ce;
    const srNet = sr === undefined || (nets[sr].const === 0 && !inv(`IS_${k.sr}_INVERTED`)) ? null : sr;
    const initBits = paramBits(p.INIT);
    const init = initBits ? initBits[0] : (k.high ? 1 : 0);
    // a latch's gate is its clock pin. A flip-flop captures on the rising edge after CLKINV; the
    // slice latch is transparent while CLKINV's output is LOW (netgen models CLKINV::CLK on a
    // #LATCH with an inverter: measured with designs/latches.v), so a latch with an active-high
    // gate takes CLKINV::CLK_B, as ISE writes it
    const clkInv = (k.neg ? 1 : 0) ^ (inv(`IS_${clkPin}_INVERTED`) ? 1 : 0) ^ (k.latch ? 1 : 0);
    return {
      cell: ci(c), name: c.name, kind: k, d: c.pins.D, q: c.pins.Q, init, clkPin, cePin, srPin: k.sr,
      ctrl: { clk: c.pins[clkPin], clkInv, ce: ceNet, ceInv: ceNet !== null && inv(`IS_${cePin}_INVERTED`) ? 1 : 0, sr: srNet,
        srInv: srNet !== null && inv(`IS_${k.sr}_INVERTED`) ? 1 : 0, sync: srNet !== null ? !!k.sync : null, latch: !!k.latch },
    };
  }
  const ctrlKey = t => `${t.clk}|${t.clkInv}|${t.ce}|${t.ceInv}|${t.sr}|${t.srInv}|${t.sync}|${t.latch}`;
  const ctrlOk = (s, f) => !s.ctrl || ctrlKey(s.ctrl) === ctrlKey(f.ctrl);
  // Put flip-flop f on side X / Y of slice s; its D comes from the side's output multiplexer
  // (dsrc: 'mux', D is internal) or from BX / BY ('bypass').
  function placeFf(s, side, f, dsrc) {
    if (s.ff[side]) throw new PackError('pack: flip-flop slot used twice');
    s.ff[side] = { ...f, dsrc };
    s.ctrl = f.ctrl;
    where.set(f.cell, { inst: s.idx, bel: `FF${side}` });
    const t = f.ctrl;
    setSink(f.cell, f.clkPin, { inst: s.idx, pin: 'CLK', kind: 'gen' });
    if (t.ce !== null) setSink(f.cell, f.cePin, { inst: s.idx, pin: 'CE', kind: 'gen' }); else if (f.cePin in cells[f.cell].pins) setSink(f.cell, f.cePin, 'int');
    if (f.srPin) setSink(f.cell, f.srPin, t.sr !== null ? { inst: s.idx, pin: 'SR', kind: 'gen' } : 'int');
    if (dsrc === 'mux') setSink(f.cell, 'D', 'int');
    else { setBypass(s, side, f.d); setSink(f.cell, 'D', { inst: s.idx, pin: side === 'X' ? 'BX' : 'BY', kind: 'gen' }); }
  }
  function setBypass(s, side, net) {
    if (s.b[side] !== null && s.b[side] !== net) throw new PackError(`pack: B${side} of a slice used twice`);
    s.b[side] = net;
  }
  const ffs = new Map();   // cell index -> ffInfo, for the flip-flops not placed yet
  for (const c of cells) if (ffKind(c.type)) ffs.set(ci(c), ffInfo(c));
  // the flip-flops whose D is net n
  const ffsOn = n => loadsOf(n).filter(l => l.pin === 'D' && ffs.has(l.cell) && !where.has(l.cell)).map(l => ffs.get(l.cell));
  // try to put a flip-flop fed by the output multiplexer of side `side` into that side's slot
  function absorbFf(s, side, net) {
    if (s.ff[side]) return;
    const f = ffsOn(net).find(x => ctrlOk(s, x));
    if (f) placeFf(s, side, f, 'mux');
  }

  // ---------------------------------------------------------------- carry chains
  const macros = [];
  const muxcy = cells.filter(c => c.type === 'MUXCY');
  const xorcy = cells.filter(c => c.type === 'XORCY');
  const muxcyOn = new Map();   // CI net -> MUXCY cells reading it
  for (const m of muxcy) { const n = m.pins.CI; if (!muxcyOn.has(n)) muxcyOn.set(n, []); muxcyOn.get(n).push(m); }
  const xorOn = new Map();     // CI net -> XORCY
  for (const x of xorcy) { const n = x.pins.CI; if (!xorOn.has(n)) xorOn.set(n, []); xorOn.get(n).push(x); }
  const nextOf = new Map();    // MUXCY -> the MUXCY that continues its chain
  for (const m of muxcy) {
    const d = driverCell(m.pins.CI);
    if (d && d.type === 'MUXCY' && !nextOf.has(d)) nextOf.set(d, m);
  }
  const isNext = new Set(nextOf.values());
  const usedXor = new Set();
  const takeXor = (ciNet, sNet) => {
    const x = (xorOn.get(ciNet) || []).find(c => !usedXor.has(c) && (sNet === undefined || c.pins.LI === sNet));
    if (x) usedXor.add(x);
    return x || null;
  };
  const chains = [];
  for (const m of muxcy) {
    if (isNext.has(m)) continue;
    const stages = [];
    for (let c = m; c; c = nextOf.get(c)) stages.push({ mux: c, ci: c.pins.CI, s: c.pins.S, di: c.pins.DI, xor: takeXor(c.pins.CI, c.pins.S) });
    const last = stages.at(-1).mux;
    const x = takeXor(last.pins.O);
    if (x) stages.push({ mux: null, ci: last.pins.O, s: x.pins.LI, di: null, xor: x });
    chains.push(stages);
  }
  for (const x of xorcy) if (!usedXor.has(x)) { usedXor.add(x); chains.push([{ mux: null, ci: x.pins.CI, s: x.pins.LI, di: null, xor: x }]); }
  stats.carry = chains.length;

  // Does the first stage need BX for its DI (then BX cannot also bring the carry in)? DI can come
  // from pin 1 of the stage's LUT when the LUT reads it already or has a free input.
  const lutInputs = n => {
    const d = driverCell(n);
    if (d && isLut(d)) return Array.from({ length: LUT_K[d.type] }, (_, j) => d.pins[`I${j}`]);
    return nets[n].const !== undefined ? [] : [n];
  };
  const diNeedsB = st => st.mux && nets[st.di].const === undefined && !lutInputs(st.s).includes(st.di) && lutInputs(st.s).length >= 4;
  for (const stages of chains) if (diNeedsB(stages[0]) && stages[0].ci !== stages[0].di) {
    // a first stage of its own on the F side brings the carry in: LUT F = 0 so CYMUXF passes CY0F,
    // the constant or the carry-in net on F1 (the real first stage then takes the G side)
    stages.unshift({ dummy: true, ci: stages[0].ci });
  }

  for (const stages of chains) {
    const members = [];
    let s = null;
    stages.forEach((st, i) => {
      const side = i % 2 ? 'G' : 'F', X = side === 'F' ? 'X' : 'Y';
      if (side === 'F') { s = newSlice(); s.carry = { F: null, G: null, init: null, cout: false }; members.push({ inst: s.idx, dx: 0, dy: members.length }); }
      if (st.dummy) {
        const k = nets[st.ci].const;
        const name = `${stages[1].mux.name}_cin`;
        placeLut(s, 'F', k !== undefined ? { name, k: 0, init: '0', inputs: [], pins: [], cell: -1, out: null } : { name, k: 1, init: '00', inputs: [st.ci], pins: [1], cell: -1, out: null }, -1);
        stats.passthru++;
        s.carry.F = { mux: { name: `${name}_cy` }, xor: null, cy0: k !== undefined ? String(k) : 'F1' };
        return;
      }
      const users = [];
      if (st.mux) users.push([ci(st.mux), 'S']);
      if (st.xor) users.push([ci(st.xor), 'LI']);
      const sumUsed = st.xor && loadsOf(st.xor.pins.O).length > 0;
      const lut = lutFor(s, side, st.s, users, !sumUsed);
      const c = { mux: st.mux, xor: st.xor, cy0: null };
      s.carry[side] = c;
      if (st.mux) where.set(ci(st.mux), { inst: s.idx, bel: `CYMUX${side}` });
      if (st.xor) where.set(ci(st.xor), { inst: s.idx, bel: `XOR${side}` });
      // carry in: from the chain (internal / CIN), or at the start of the chain through BX
      const ciUsers = [st.mux && [ci(st.mux), 'CI'], st.xor && [ci(st.xor), 'CI']].filter(Boolean);
      if (i === 0) {
        s.carry.init = 'BX';
        setBypass(s, 'X', st.ci);
        for (const [cc, p] of ciUsers) setSink(cc, p, { inst: s.idx, pin: 'BX', kind: 'gen' });
      } else {
        if (side === 'F') { s.carry.init = 'CIN'; insts[s.idx - 1].carry.cout = true; }
        for (const [cc, p] of ciUsers) setSink(cc, p, 'int');
      }
      // DI: a constant, a LUT input on pin 1 / 2, or BX / BY
      if (st.mux) {
        const di = st.di, pin1 = side === 'F' ? 'F1' : 'G1';
        if (nets[di].const !== undefined) c.cy0 = String(nets[di].const);
        else {
          let j = lut.inputs.indexOf(di);
          if (j < 0 && lut.k < 4) {
            // add DI as an input the LUT's function does not depend on
            lut.init = lut.init + lut.init; lut.inputs.push(di); lut.pins.push(lut.k + 1); lut.k++; j = lut.k - 1;
          }
          if (j >= 0) {
            // move that input to pin 1 (swap pins with whatever input is there)
            const o = lut.pins.indexOf(1);
            if (o >= 0) [lut.pins[o], lut.pins[j]] = [lut.pins[j], lut.pins[o]]; else lut.pins[j] = 1;
            c.cy0 = pin1;
            setSink(ci(st.mux), 'DI', 'int');
          } else {
            c.cy0 = side === 'F' ? 'BX' : 'BY';
            setBypass(s, X, di);
            setSink(ci(st.mux), 'DI', { inst: s.idx, pin: `B${X}`, kind: 'gen' });
          }
        }
        if (c.cy0 === '0' || c.cy0 === '1') setSink(ci(st.mux), 'DI', 'int');
      }
      // the sum leaves through X / Y (FXMUX = FXOR) and may feed the flip-flop of its side
      if (sumUsed) { s.out[X] = side === 'F' ? 'FXOR' : 'GXOR'; absorbFf(s, X, st.xor.pins.O); }
      else if (lut.cell >= 0 && otherLoads(lut.out, users).length) s.out[X] = side;   // the LUT's own output
    });
    macros.push({ kind: 'carry', members });
  }

  // ---------------------------------------------------------------- wide multiplexers
  // A multiplexer tree uses the dedicated F5 / FX connections only when each input of an F6 / F7 / F8
  // is the output of the level below and nothing else claims it; any other multiplexer becomes a
  // 3-input LUT (O = S ? I1 : I0).
  const muxes = cells.filter(c => MUXF[c.type]);
  stats.muxes = muxes.length;
  const claimed = new Set();
  const childOk = (m, pin) => {
    const d = driverCell(m.pins[pin]);
    return d && MUXF[d.type] === MUXF[m.type] - 1 && !claimed.has(d) && !d.lut3;
  };
  const tree = m => {   // claim the whole tree under m (or fail without claiming)
    const lvl = MUXF[m.type];
    if (lvl === 5) return [m];
    if (!childOk(m, 'I0') || !childOk(m, 'I1')) return null;
    const a = tree(driverCell(m.pins.I1)), b = a && tree(driverCell(m.pins.I0));
    return a && b ? [m, ...a, ...b] : null;
  };
  const roots = [];
  for (const lvl of [8, 7, 6, 5]) for (const m of muxes.filter(x => MUXF[x.type] === lvl && !claimed.has(x))) {
    const t = tree(m);
    if (!t) { m.lut3 = true; continue; }
    // a level-5 tree whose parent became a LUT is a root of its own
    for (const x of t) claimed.add(x);
    roots.push(m);
  }
  // multiplexers that became LUT3: inputs (I0, I1, S) -> LUT3 INIT for O = S ? I1 : I0 (I0 = bit 0)
  for (const m of muxes) if (m.lut3) {
    stats.muxLuts = (stats.muxLuts || 0) + 1;
    m.type = 'LUT3'; m.params = { INIT: '11001010' };
    m.pins = { I0: m.pins.I0, I1: m.pins.I1, I2: m.pins.S, O: m.pins.O };
    relabel(m, { S: 'I2' });
  }

  // place a tree: the F5 of `leaf` slices, the FiMUX at their fixed spots inside the CLB(s)
  for (const root of roots) {
    const lvl = MUXF[root.type];
    // slices of the macro by position: lvl 5 -> 1 slice, 6 -> 2, 7 -> 4 (a CLB), 8 -> 8 (two CLBs)
    const members = [];
    const at = new Map();
    const sliceAt = (dx, dy) => {
      const k = `${dx},${dy}`;
      if (!at.has(k)) { const s = newSlice(); at.set(k, s); members.push({ inst: s.idx, dx, dy }); }
      return at.get(k);
    };
    // where each multiplexer of the tree goes: (mux, dx, dy)
    const put = (m, dx, dy) => {
      const l = MUXF[m.type];
      const s = sliceAt(dx, dy);
      if (l === 5) { placeF5(s, m); return; }
      s.fi = m;
      where.set(ci(m), { inst: s.idx, bel: 'F6MUX' });
      setBypass(s, 'Y', m.pins.S);
      setSink(ci(m), 'S', { inst: s.idx, pin: 'BY', kind: 'gen' });
      const spec = WIDE_MUX[l].find(w => w.at[0] === ((dx % 2) + 2) % 2 && w.at[1] === ((dy % 2) + 2) % 2);
      const base = [dx - spec.at[0], dy - spec.at[1]];
      const ca = driverCell(m.pins.I1), cb = driverCell(m.pins.I0);
      const pa = [base[0] + spec.a[0], base[1] + spec.a[1]], pb = [base[0] + spec.b[0], base[1] + spec.b[1]];
      const kind = l === 6 ? 'f5' : 'fx';
      setSink(ci(m), 'I1', { inst: s.idx, pin: 'FXINA', kind });
      setSink(ci(m), 'I0', { inst: s.idx, pin: 'FXINB', kind });
      put(ca, pa[0], pa[1]);
      put(cb, pb[0], pb[1]);
    };
    // the root's own position: F6 at S0, F7 at S1, F8 at S3 (of the upper CLB: its F7 below)
    const r0 = lvl === 5 ? [0, 0] : WIDE_MUX[lvl][0].at;
    put(root, r0[0], r0[1]);
    // normalise the offsets (the lowest slice at dy = 0) and record the macro
    const minDy = Math.min(...members.map(x => x.dy));
    for (const x of members) x.dy -= minDy;
    // F6 pairs start on an even slice row, F7 / F8 on a CLB (even column and row)
    macros.push({ kind: lvl === 5 ? 'F5' : `F${lvl}`, members, align: lvl === 5 ? [1, 1] : lvl === 6 ? [1, 2] : [2, 2] });
    // the FiMUX output feeds GYMUX (Y) / the flip-flop on the Y side
    for (const [, s] of at) if (s.fi) {
      const o = s.fi.pins.O;
      const parent = loadsOf(o).filter(l => MUXF[cells[l.cell].type] && claimed.has(cells[l.cell]) && where.get(l.cell)?.bel === 'F6MUX');
      if (otherLoads(o, parent.map(l => [l.cell, l.pin])).length) s.out.Y = 'FX';
      if (!s.out.Y || s.out.Y === 'FX') { absorbFf(s, 'Y', o); if (s.ff.Y) s.out.Y = s.out.Y || 'FX'; }
    }
  }
  // a single-slice multiplexer of two LUTs: F = I1, G = I0, BX selects (BX = 1 -> F)
  function placeF5(s, m) {
    s.f5 = m;
    where.set(ci(m), { inst: s.idx, bel: 'F5MUX' });
    setBypass(s, 'X', m.pins.S);
    setSink(ci(m), 'S', { inst: s.idx, pin: 'BX', kind: 'gen' });
    lutFor(s, 'F', m.pins.I1, [[ci(m), 'I1']], false);
    lutFor(s, 'G', m.pins.I0, [[ci(m), 'I0']], !s.fi);
    if (s.lut.G.cell >= 0 && otherLoads(s.lut.G.out, [[ci(m), 'I0']]).length) s.out.Y = 'G';
    const o = m.pins.O;
    const parent = loadsOf(o).filter(l => MUXF[cells[l.cell].type] && claimed.has(cells[l.cell]));
    if (otherLoads(o, parent.map(l => [l.cell, l.pin])).length) s.out.X = 'F5';
    if (!s.out.X || s.out.X === 'F5') { absorbFf(s, 'X', o); if (s.ff.X) s.out.X = 'F5'; }
  }
  // ---------------------------------------------------------------- the rest: LUTs and flip-flops
  // Units: a LUT with the flip-flop it feeds (the flip-flop's D from the LUT inside the slice), a LUT
  // alone, a flip-flop alone (D through BX / BY). Slices are filled greedily: a seed unit, then
  // the compatible units that share the most nets with what is already in the slice.
  const units = [];
  const unitOf = new Map();
  for (const c of cells) {
    if (!isLut(c) || where.has(ci(c))) continue;
    const f = ffsOn(c.pins.O)[0];
    const u = { lut: ci(c), ff: f ? f.cell : -1 };
    if (f) unitOf.set(f.cell, u);
    unitOf.set(ci(c), u);
    units.push(u);
  }
  for (const [c] of ffs) if (!where.has(c) && !unitOf.has(c)) { const u = { lut: -1, ff: c }; unitOf.set(c, u); units.push(u); }
  // nets of a unit (for the affinity): inputs and outputs, without clocks and constants
  const unitNets = u => {
    const ns = new Set();
    for (const k of [u.lut, u.ff]) if (k >= 0) for (const [p, n] of Object.entries(cells[k].pins)) if (n > 1 && !/^(C|G)$/.test(p) && loadsOf(n).length < 64) ns.add(n);
    return ns;
  };
  const netUnits = new Map();
  units.forEach((u, k) => { u.k = k; u.nets = unitNets(u); for (const n of u.nets) { if (!netUnits.has(n)) netUnits.set(n, []); netUnits.get(n).push(k); } });
  const done = new Set();
  // can unit u go into slice s? returns the side(s) it would take, or null
  const fits = (s, u) => {
    const f = u.ff >= 0 ? ffs.get(u.ff) : null;
    if (f && !ctrlOk(s, f)) return null;
    if (u.lut >= 0 && f) { for (const side of ['F', 'G']) { const X = side === 'F' ? 'X' : 'Y'; if (!s.lut[side] && !s.ff[X]) return { lutSide: side, ffSide: X }; } return null; }
    if (u.lut >= 0) { for (const side of ['F', 'G']) if (!s.lut[side]) return { lutSide: side }; return null; }
    for (const X of ['X', 'Y']) if (!s.ff[X] && (s.b[X] === null || s.b[X] === f.d)) return { ffSide: X };
    return null;
  };
  const putUnit = (s, u, how) => {
    done.add(u.k);
    if (u.lut >= 0) {
      const lut = lutOf(cells[u.lut]);
      placeLut(s, how.lutSide, lut, u.lut);
      const X = how.lutSide === 'F' ? 'X' : 'Y';
      const fCell = u.ff >= 0 && how.ffSide ? u.ff : -1;
      if (otherLoads(lut.out, fCell >= 0 ? [[fCell, 'D']] : []).length) s.out[X] = how.lutSide;
      if (fCell >= 0) { s.out[X] = how.lutSide; placeFf(s, how.ffSide, ffs.get(fCell), 'mux'); }
    } else placeFf(s, how.ffSide, ffs.get(u.ff), 'bypass');
  };
  // seeds in netlist order (keeps related logic together, deterministic); units with a flip-flop first
  const order = [...units].sort((a, b) => (b.ff >= 0) - (a.ff >= 0) || a.k - b.k);
  for (const seed of order) {
    if (done.has(seed.k)) continue;
    const s = newSlice();
    putUnit(s, seed, fits(s, seed));
    for (;;) {
      // candidates: units sharing a net with the slice
      const score = new Map();
      const sliceNets = new Set();
      for (const k of [s.lut.F, s.lut.G]) if (k?.cell >= 0) for (const n of unitOf.get(k.cell).nets) sliceNets.add(n);
      for (const X of ['X', 'Y']) if (s.ff[X]) for (const n of unitOf.get(s.ff[X].cell)?.nets || []) sliceNets.add(n);
      for (const n of sliceNets) for (const k of netUnits.get(n) || []) if (!done.has(k)) score.set(k, (score.get(k) || 0) + 1);
      let best = null, bestScore = 0;
      for (const [k, sc] of score) if (sc > bestScore || (sc === bestScore && best !== null && k < best.k)) { const u = units[k]; if (fits(s, u)) { best = u; bestScore = sc; } }
      if (!best) {
        // nothing related: fill with the next unit in order that fits
        best = order.find(u => !done.has(u.k) && fits(s, u)) || null;
        if (!best || (s.lut.F && s.lut.G && s.ff.X && s.ff.Y)) break;
      }
      putUnit(s, best, fits(s, best));
      if (s.lut.F && s.lut.G && s.ff.X && s.ff.Y) break;
    }
  }

  // ---------------------------------------------------------------- pads and clock buffers
  const portOfNet = new Map();
  for (const p of nl.ports) for (const b of p.bits) if (nets[b.net].const === undefined) portOfNet.set(b.net, { ...b, dir: p.dir });
  for (const c of cells) {
    if (/^(IBUF|IBUFG)$/.test(c.type)) {
      const port = portOfNet.get(c.pins.I);
      if (!port) throw new PackError(`pack: ${c.name}: input buffer not on a port`);
      const a = cons[port.name] || {};
      const cfg = [['IDELMUX', '', '1'], ['IMUX', '', '1'], ['IOATTRBOX', '', a.iostandard || 'LVCMOS25'], ['INBUF', `${port.name}_IBUF`, ''], ['PAD', port.name, '']];
      if (a.pull) cfg.push(['PULL', '', { up: 'PULLUP', down: 'PULLDOWN', keeper: 'KEEPER' }[a.pull]]);
      const s = { kind: 'iob', type: 'IBUF', name: port.name, loc: a.loc || null, dir: 'in', fixedCfg: cfg, idx: insts.length };
      insts.push(s);
      where.set(ci(c), { inst: s.idx, bel: 'INBUF' });
      setSink(ci(c), 'I', 'int');
    } else if (c.type === 'OBUF') {
      const port = portOfNet.get(c.pins.O);
      if (!port) throw new PackError(`pack: ${c.name}: output buffer not on a port`);
      const a = cons[port.name] || {};
      const cfg = [['DRIVEATTRBOX', '', String(a.drive || 12)], ['IOATTRBOX', '', a.iostandard || 'LVCMOS25'], ['O1INV', '', 'O1'], ['OMUX', '', 'O1'],
        ['SLEW', '', (a.slew || 'slow').toUpperCase()], ['OUTBUF', `${port.name}_OBUF`, ''], ['PAD', port.name, '']];
      if (a.pull) cfg.push(['PULL', '', { up: 'PULLUP', down: 'PULLDOWN', keeper: 'KEEPER' }[a.pull]]);
      const s = { kind: 'iob', type: 'IOB', name: port.name, loc: a.loc || null, dir: 'out', fixedCfg: cfg, idx: insts.length };
      insts.push(s);
      where.set(ci(c), { inst: s.idx, bel: 'OUTBUF' });
      setSink(ci(c), 'I', { inst: s.idx, pin: 'O1', kind: 'gen' });
    } else if (c.type === 'BUFG') {
      const s = { kind: 'bufg', type: 'BUFGMUX', name: c.name, loc: null, fixedCfg: null, idx: insts.length, cell: ci(c) };
      insts.push(s);
      where.set(ci(c), { inst: s.idx, bel: 'BUFG' });
      setSink(ci(c), 'I', { inst: s.idx, pin: 'I0', kind: 'gen' });
      // the select input is tied high (SINV inverts it: I0 selected), as ISE's map does
      extra.push({ net: 1, inst: s.idx, pin: 'S', kind: 'gen' });
    }
  }
  for (const c of cells) if (!where.has(ci(c))) throw new PackError(`pack: ${c.type} ${c.name} was not packed`);

  // ---------------------------------------------------------------- site pins of every connection
  // the inputs of the LUTs in slices, by pin
  for (const s of insts) if (s.kind === 'slice') for (const side of ['F', 'G']) {
    const lut = s.lut[side];
    if (!lut) continue;
    lut.inputs.forEach((n, j) => {
      const pin = `${side}${lut.pins[j]}`;
      if (lut.cell >= 0 && j < LUT_K[cells[lut.cell].type]) setSink(lut.cell, `I${j}`, { inst: s.idx, pin, kind: 'gen' });
      else extra.push({ net: n, inst: s.idx, pin, kind: 'gen' });
    });
  }
  // the source pin of a cell's output for a connection of this kind
  const srcPin = (cell, kind) => {
    const w = where.get(cell);
    const s = insts[w.inst];
    if (kind === 'f5') { s.f5out = true; return { inst: w.inst, pin: 'F5' }; }
    if (kind === 'fx') { s.fxout = true; return { inst: w.inst, pin: 'FX' }; }
    const sel = (X, v) => {
      if (s.out[X] && s.out[X] !== v) throw new PackError(`pack: output ${X} of a slice needed for two signals (${s.out[X]}, ${v})`);
      s.out[X] = v;
      s.used = s.used || {};
      s.used[X] = true;
      return { inst: w.inst, pin: X };
    };
    switch (w.bel) {
      case 'F': return sel('X', 'F');
      case 'G': return sel('Y', 'G');
      case 'FFX': return { inst: w.inst, pin: 'XQ' };
      case 'FFY': return { inst: w.inst, pin: 'YQ' };
      case 'F5MUX': return sel('X', 'F5');
      case 'F6MUX': return sel('Y', 'FX');
      case 'XORF': return sel('X', 'FXOR');
      case 'XORG': return sel('Y', 'GXOR');
      case 'CYMUXF': s.xb = true; return { inst: w.inst, pin: 'XB' };
      case 'CYMUXG': s.yb = true; return { inst: w.inst, pin: 'YB' };
      case 'INBUF': return { inst: w.inst, pin: 'I' };
      case 'BUFG': return { inst: w.inst, pin: 'O' };
      default: throw new PackError(`pack: no output pin for ${w.bel}`);
    }
  };
  const outNets = [];
  const netByKey = new Map();
  const constNet = v => {
    const k = `const${v}`;
    if (!netByKey.has(k)) { const n = { name: v ? 'GLOBAL_LOGIC1' : 'GLOBAL_LOGIC0', type: v ? 'vcc' : 'gnd', outpins: [], inpins: [] }; netByKey.set(k, n); outNets.push(n); }
    return netByKey.get(k);
  };
  const xdlNet = (n, from, kind) => {
    const k = `${n}|${kind}|${from.inst}`;
    if (!netByKey.has(k)) {
      const base = nets[n].name;
      const nn = { name: uniqueNet(kind === 'gen' ? base : `${base}_${kind.toUpperCase()}`), type: 'wire', outpins: [from], inpins: [] };
      netByKey.set(k, nn); outNets.push(nn);
    }
    return netByKey.get(k);
  };
  const connect = (n, to) => {
    if (nets[n].const !== undefined) { constNet(nets[n].const).inpins.push({ inst: to.inst, pin: to.pin }); return; }
    const d = nets[n].driver;
    if (!d) { warnings.push(`net ${nets[n].name} has no driver: ${insts[to.inst].name || to.inst}.${to.pin} tied to 0`); constNet(0).inpins.push({ inst: to.inst, pin: to.pin }); return; }
    if (to.kind === 'cy') { xdlNet(n, { inst: to.from, pin: 'COUT' }, 'cy').inpins.push({ inst: to.inst, pin: 'CIN' }); return; }
    xdlNet(n, srcPin(d.cell, to.kind), to.kind).inpins.push({ inst: to.inst, pin: to.pin });
  };
  const seenPin = new Set();
  for (const [n, net] of nets.entries()) {
    for (const l of net.loads) {
      const v = sink.get(`${l.cell}:${l.pin}`);
      if (v === undefined) throw new PackError(`pack: ${cells[l.cell].type} ${cells[l.cell].name} pin ${l.pin}: not connected by the packer`);
      if (v === 'int') continue;
      const key = `${v.inst}:${v.pin}`;
      if (seenPin.has(key)) continue;   // several cell pins on one site pin (a shared BX, CLK…)
      seenPin.add(key);
      connect(n, v);
    }
  }
  for (const e of extra) { const key = `${e.inst}:${e.pin}`; if (!seenPin.has(key)) { seenPin.add(key); connect(e.net, e); } }
  // carry chains between slices: COUT of one slice -> CIN of the next
  for (const mac of macros) if (mac.kind === 'carry') for (let k = 1; k < mac.members.length; k++) {
    const a = insts[mac.members[k - 1].inst], b = insts[mac.members[k].inst];
    if (b.carry.init !== 'CIN') continue;
    const name = uniqueNet(`${a.carry.G?.mux?.name || a.carry.F?.mux?.name || 'carry'}_COUT`);
    outNets.push({ name, type: 'wire', outpins: [{ inst: a.idx, pin: 'COUT' }], inpins: [{ inst: b.idx, pin: 'CIN' }] });
  }
  // ---------------------------------------------------------------- configuration strings
  for (const s of insts) if (s.kind === 'iob') s.name = uniqueName(s.name);   // pads keep their port's name
  // names of the slices: the first flip-flop or LUT inside
  for (const s of insts) if (s.kind === 'slice') {
    const base = s.ff.X?.name || s.ff.Y?.name || s.lut.F?.name || s.lut.G?.name || `slice${s.idx}`;
    s.name = uniqueName(base);
  }
  for (const s of insts) {
    if (s.kind === 'iob') { s.cfg = s.fixedCfg.map(([attr, name, value]) => ({ attr, name: name ? escCfg(name) : '', value })); continue; }
    if (s.kind === 'bufg') {
      s.name = uniqueName(s.name);
      const n = escCfg(s.name);
      s.cfg = [['DISABLE_ATTR', '', 'LOW'], ['I0_USED', '', '0'], ['SINV', '', 'S_B'], ['GCLKMUX', `${n}.GCLKMUX`, ''], ['GCLK_BUFFER', n, '']].map(([attr, name, value]) => ({ attr, name, value }));
      continue;
    }
    sliceCfg(s);
  }
  function sliceCfg(s) {
    const cfg = [];
    const add = (attr, name, value) => cfg.push({ attr, name, value });
    const nm = x => escCfg(x);
    for (const side of ['F', 'G']) {
      const lut = s.lut[side];
      if (lut) add(side, nm(lut.name), `#LUT:${initToEquation(lut.init, lut.k, lut.pins)}`);
    }
    for (const X of ['X', 'Y']) {
      const f = s.ff[X];
      if (!f) continue;
      add(`FF${X}`, nm(f.name), f.ctrl.latch ? '#LATCH' : '#FF');
      add(`FF${X}_INIT_ATTR`, '', f.init ? 'INIT1' : 'INIT0');
      add(`FF${X}_SR_ATTR`, '', f.kind.sr && f.kind.high ? 'SRHIGH' : f.kind.sr ? 'SRLOW' : (f.init ? 'SRHIGH' : 'SRLOW'));
      add(`D${X}MUX`, '', f.dsrc === 'mux' ? '1' : '0');
    }
    if (s.ctrl) {
      add('CLKINV', '', s.ctrl.clkInv ? 'CLK_B' : 'CLK');
      if (s.ctrl.ce !== null) add('CEINV', '', s.ctrl.ceInv ? 'CE_B' : 'CE');
      if (s.ctrl.sr !== null) add('SRINV', '', s.ctrl.srInv ? 'SR_B' : 'SR');
      add('SYNC_ATTR', '', s.ctrl.sync ? 'SYNC' : 'ASYNC');
    }
    if (s.b.X !== null) add('BXINV', '', 'BX');
    if (s.b.Y !== null) add('BYINV', '', 'BY');
    // output multiplexers: needed by the X / Y pins or by the flip-flops
    if (s.out.X && (s.used?.X || s.ff.X?.dsrc === 'mux')) add('FXMUX', '', s.out.X);
    if (s.out.Y && (s.used?.Y || s.ff.Y?.dsrc === 'mux')) add('GYMUX', '', s.out.Y);
    if (s.used?.X) add('XUSED', '', '0');
    if (s.used?.Y) add('YUSED', '', '0');
    if (s.f5) { add('F5MUX', nm(s.f5.name), ''); if (s.f5out) add('F5USED', '', '0'); }
    if (s.fi) { add('F6MUX', nm(s.fi.name), ''); if (s.fxout) add('FXUSED', '', '0'); }
    if (s.carry) {
      const c = s.carry;
      if (c.init) add('CYINIT', '', c.init);
      for (const side of ['F', 'G']) {
        const st = c[side];
        if (!st) continue;
        if (st.mux) {
          add(`CYMUX${side}`, nm(st.mux.name), '');
          add(`CYSEL${side}`, '', side);
          add(`CY0${side}`, '', st.cy0);
          if (st.cy0 === '0') add(`GND${side}`, nm(`${s.name}.GND${side}`), '');
          if (st.cy0 === '1') add(side === 'F' ? 'C1VDD' : 'C2VDD', nm(`${s.name}.C${side === 'F' ? 1 : 2}VDD`), '');
        }
        if (st.xor) add(`XOR${side}`, nm(st.xor.name), '');
      }
      if (s.xb) add('XBUSED', '', '0');
      if (s.yb) add('YBUSED', '', '0');
      if (c.cout) add('COUTUSED', '', '0');
    }
    s.cfg = cfg;
  }
  const slices = insts.filter(s => s.kind === 'slice');
  // the ports of the design, as ISE's map records them in the design's cfg (netgen names the ports
  // of its simulation model from them): one BUS_INFO per bus, one PIN_INFO per bus bit (the
  // index counted from the first bit declared; ':' inside a field escaped)
  const designCfg = [];
  for (const p of nl.ports) {
    if (p.bits.length < 2 && !/<\d+>$/.test(p.bits[0]?.name || '')) continue;
    const idx = p.bits.map(b => +/<(-?\d+)>$/.exec(b.name)[1]);
    const msb = idx.at(-1), lsb = idx[0];
    const dir = p.dir === 'in' ? 'INPUT' : p.dir === 'out' ? 'OUTPUT' : 'BIDIR';
    const bus = `${clean(p.name)}<${msb}:${lsb}>`;
    designCfg.push(`_DESIGN_PROP::BUS_INFO:${p.bits.length}:${dir}:${bus}`);
    p.bits.forEach((b, i) => {
      const n = clean(b.name);
      designCfg.push(`_DESIGN_PROP::PIN_INFO:${n}:/${clean(nl.name)}/PACKED/${clean(nl.name)}/${n}/${n}/PAD:${dir}:${p.bits.length - 1 - i}:${bus.replace(':', '\\:')}`);
    });
  }
  const out = {
    name: nl.name, part, cfg: designCfg.join('\n       '),
    insts: insts.map(s => ({ name: s.name, type: s.type, cfg: s.cfg, loc: s.loc || null, kind: s.kind, dir: s.dir })),
    nets: outNets.filter(n => n.inpins.length),
    macros,
    stats: {
      slices: slices.length, luts: slices.reduce((a, s) => a + !!s.lut.F + !!s.lut.G, 0), ffs: slices.reduce((a, s) => a + !!s.ff.X + !!s.ff.Y, 0),
      carry: stats.carry, muxes: stats.muxes, iobs: insts.filter(s => s.kind === 'iob').length, bufgs: insts.filter(s => s.kind === 'bufg').length,
      copies: stats.copies, passthru: stats.passthru, muxLuts: stats.muxLuts || 0,
    },
    warnings,
  };
  return out;
}
