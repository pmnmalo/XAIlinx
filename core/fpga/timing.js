// Silinx - timing of a placed and routed Spartan-3E design (browser + Node): a delay model of the
// wires and the logic of the XC3S250E speed grade -4, and a static timing analysis (STA) over it.
//
// The delay model is our own: fitted to what Xilinx ISE's timing analyzer (trce) and delay report
// (reportgen -delay) say about designs placed and routed by Silinx (research/s3e-route/timing-fit.mjs,
// method and errors in research/s3e-route/README.md, "Timing"). No Xilinx data file is read or copied:
// only the fitted numbers below.
//
// - Wires: every routing node of the device graph (core/fpga/device.js) gets a class from the names
//   of its wires (OMUX, double, hex, long line, input multiplexer, clock, site pin…); the delay of a
//   connection (driver pin -> load pin) is the sum of the delays of the nodes it goes through after
//   the driver's pin, each node's delay growing with the number of branches the net takes off it.
// - Logic: the delay of each path through a slice (an input pin to an output pin: a LUT, the F5 / F6
//   multiplexers, the carry chain), the clock-to-out of the flip-flops and the setup time of each way
//   into them, from the slice's configuration (its cfg string), for SLICEL and SLICEM.
//
//   const sta = analyzeTiming(design, device)       // design: parseXdl() of a routed (or placed) XDL
//   sta.period                                      // the minimum clock period (ns), the worst clock
//   sta.clocks                                      // [{ clock (net name), period, path: [{ inst, pin, kind, delay, arrival }] }]
//   sta.conns                                       // every connection: { net, from, to, delay, slack, crit }
//
// The router (core/fpga/route.js) uses nodeDelays() for its timing-driven cost and timingGraph() to
// recompute the criticalities of the connections as the routing changes.

// ------------------------------------------------------------------ the model (ns, XC3S250E -4)
/** Classes of routing nodes. */
export const WIRE = { PIN: 0, OUT: 1, OMUX: 2, DOUBLE: 3, HEX: 4, LONG: 5, IMUX: 6, GCLK: 7, IO: 8, OTHER: 9 };
export const WIRE_NAMES = ['pin', 'out', 'omux', 'double', 'hex', 'long', 'imux', 'gclk', 'io', 'other'];

/**
 * The fitted model (research/s3e-route/timing-fit.mjs on 10 486 connections of seven placements of
 * blinky and lab11 routed by Silinx, with and without timing, ISE 14.7 reportgen -delay as the
 * reference: rms error 0.099 ns per connection, 95% within 0.19 ns). wire[c]: delay of a node of
 * class c on the path (indexed by WIRE); branch[c]: added per extra branch the net takes off that node (its load); source: the same at the driver's pin; base:
 * the fixed part of every routed connection. dist: the estimate of an unrouted connection from the
 * Manhattan distance d in tiles: base + perTile x min(d, knee) + far x (d - knee) beyond the knee (long
 * lines). slice / pad: the logic, from trce's reports of the same designs (the delay of each kind of
 * path through a slice, SLICEL and SLICEM; the values not seen in a report are marked "est.":
 * derived from those that are).
 */
export const SPEED_4 = {
  base: -0.103,
  source: 0.049,
  wire: [0, 0, 0.345, 0.269, 0.350, 0.445, 0.208, 0.414, 0.162, 0.3],
  branch: [0, 0, 0.027, 0.013, 0.018, 0, 0.213, 0.033, 0, 0],
  dist: { base: 0.55, perTile: 0.1, knee: 12, far: 0.03 },
  // logic: [SLICEL, SLICEM]
  slice: {
    Tilo: [0.704, 0.759],      // F1-4 -> X, G1-4 -> Y (LUT)
    Tif5: [0.875, 1.033],      // F1-4 / G1-4 -> F5 (LUT and F5 multiplexer)
    Tif5x: [1.025, 1.152],     // F1-4 / G1-4 -> X through the F5 multiplexer
    Tbxf5: [0.589, 0.687],     // BX (select) -> F5
    Tbxx: [0.739, 0.806],      // BX (select) -> X through F5 (est.)
    Tinafx: [0.463, 0.364],    // FXINA / FXINB -> FX (F6..F8 multiplexer)
    Tif6y: [0.521, 0.409],     // FXINA / FXINB -> Y
    Tbyfx: [0.589, 0.687],     // BY (select) -> FX (est.)
    Tbyy: [0.850, 0.850],      // BY (select) -> Y
    Topcyf: [0.953, 0.953],    // F1-4 -> COUT
    Topcyg: [0.888, 0.888],    // G1-4 -> COUT
    TopcyfDI: [0.953, 0.953],  // F1 / F2 -> COUT when it is also the carry's data input (CY0F)
    TopcygDI: [1.131, 1.131],  // G1 / G2 -> COUT when it is also the carry's data input (CY0G)
    Tbycy: [0.945, 0.945],     // BY (CY0G) -> COUT
    Tbxcy: [1.095, 1.106],     // BX (CYINIT) -> COUT
    Tbyp: [0.118, 0.130],      // CIN -> COUT
    Tcinx: [0.462, 0.497],     // CIN -> X (XOR)
    Tciny: [0.869, 0.883],     // CIN -> Y (through the F stage and the G XOR)
    Topx: [0.85, 0.9],         // F1-4 -> X (XOR) (est.)
    Topy: [1.641, 1.641],      // F1-4 -> Y (carry of the F stage, G XOR)
    Togy: [0.9, 0.95],         // G1-4 -> Y (XOR) (est.)
    Tbxxor: [1.0, 1.0],        // BX (CYINIT) -> X / Y through the XOR (est.)
    TckoX: [0.591, 0.592],     // CLK -> XQ
    TckoY: [0.587, 0.652],     // CLK -> YQ
    Tdxck: [0.133, 0.133],     // setup of the flip-flop from the X / Y path (added to the path to X / Y)
    Tdick: [0.308, 0.308],     // BX -> flip-flop X (DXMUX = 0), BY -> flip-flop Y
    Tceck: [0.555, 0.555],     // CE (est.)
    Tsrck: [0.910, 0.910],     // SR
  },
  pad: { Tiopi: 1.3, Tioop: 3.25 },
};

// ------------------------------------------------------------------ wire classes
const RE_LONG = /(^|_)L[HV]\d+$/, RE_HEX = /(^|_)[NSEW]6(BEG|A|B|MID|C|D|END)(_[NSEW])?\d+$/, RE_DOUBLE = /(^|_)[NSEW]2(BEG|MID|END)(_[NSEW])?\d+$/;
const RE_IMUX = /(^|_)([FG][1-4]_B|B[XY]|CE_B|SR|CLK)\d+$/;

/** The class of a node from the names of its wires and whether it is a site pin (WIRE.*). */
export function classOfWires(names, isPin = false, isOutPin = false) {
  if (isOutPin) return WIRE.OUT;
  if (isPin) return WIRE.PIN;
  let c = WIRE.OTHER;
  for (const n of names) {
    if (/TESTWIRE/.test(n)) continue;
    if (RE_LONG.test(n)) return WIRE.LONG;
    if (RE_HEX.test(n)) c = WIRE.HEX;
    else if (RE_DOUBLE.test(n) && c !== WIRE.HEX) c = WIRE.DOUBLE;
    else if (/OMUX/.test(n) && c === WIRE.OTHER) c = WIRE.OMUX;
    else if (/GCLK/.test(n) && c === WIRE.OTHER) c = WIRE.GCLK;
    else if (RE_IMUX.test(n) && c === WIRE.OTHER) c = WIRE.IMUX;
    else if (/^IOIS_/.test(n) && c === WIRE.OTHER) c = WIRE.IO;
  }
  return c;
}

/** The class of every node of the device (cached on it): Uint8Array. */
export function nodeClasses(device) {
  if (device._wireClass) return device._wireClass;
  const N = device.nodeCount;
  const pin = new Uint8Array(N);    // 1 input pin, 2 output pin
  for (let k = 0; k < device.tileCount; k++) {
    const tp = device.templates[device.tileTemplate[k]];
    for (const s of tp.sites) for (const p of s.pins.values()) {
      const n = device.nodeOf[device.tileWireBase[k] + p.wire];
      pin[n] = p.dir === 'o' ? 2 : pin[n] || 1;
    }
  }
  const cls = new Uint8Array(N);
  for (let n = 0; n < N; n++) {
    const names = [];
    for (let j = device.nodeStart[n]; j < device.nodeStart[n + 1]; j++) {
      const w = device.nodeWires[j], k = device.wireTile[w];
      names.push(device.names[device.templates[device.tileTemplate[k]].wires[w - device.tileWireBase[k]]]);
    }
    cls[n] = classOfWires(names, pin[n] === 1, pin[n] === 2);
  }
  return (device._wireClass = cls);
}

/** The delay of each node of the device for a model (ns): Float32Array (cached per model). */
export function nodeDelays(device, model = SPEED_4) {
  device._nodeDelay ||= new Map();
  if (device._nodeDelay.has(model)) return device._nodeDelay.get(model);
  const cls = nodeClasses(device);
  const d = new Float32Array(cls.length);
  for (let n = 0; n < cls.length; n++) d[n] = model.wire[cls[n]];
  device._nodeDelay.set(model, d);
  return d;
}

// ------------------------------------------------------------------ routed nets
/**
 * The routing tree of a routed net: from its source nodes through its PIPs. Returns
 * { parent: Map node -> parent node (-1 for a source), children: Map node -> count } or null when a
 * PIP is not in the device.
 */
export function netTree(pips, sources, device) {
  const adj = new Map();
  const edge = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
  for (const p of pips) {
    const k = device.tile(p.tile);
    const i = k === undefined ? -1 : device.findPip(k, p.from, p.to);
    if (i < 0) return null;
    const [a, b] = device.pipNodes(k, i);
    edge(a, b);
    if (device.pipIsBidi(k, i)) edge(b, a);
  }
  const parent = new Map(), children = new Map();
  const q = [];
  for (const s of sources) if (!parent.has(s)) { parent.set(s, -1); q.push(s); }
  while (q.length) {
    const a = q.shift();
    for (const b of adj.get(a) || []) if (!parent.has(b)) { parent.set(b, a); children.set(a, (children.get(a) || 0) + 1); q.push(b); }
  }
  return { parent, children };
}

/** The nodes from the source to `sink` in a tree (source first), or null when not reached. */
export function treePath(tree, sink) {
  if (!tree.parent.has(sink)) return null;
  const path = [];
  for (let n = sink; n !== -1; n = tree.parent.get(n)) path.push(n);
  return path.reverse();
}

/** The delay of a routed connection: the nodes of its path (source first) in a tree. A dedicated
 *  connection (no general routing wire on it: carry chain, F5 / FX -> FXIN) takes no time. */
export function pathDelay(path, tree, device, model = SPEED_4) {
  const cls = nodeClasses(device);
  let d = model.base + model.source * Math.max(0, (tree.children.get(path[0]) || 0) - 1), routed = false;
  for (let j = 1; j < path.length; j++) {
    const n = path[j], c = cls[n];
    if (c > WIRE.OUT) routed = true;
    d += model.wire[c] + model.branch[c] * Math.max(0, (tree.children.get(n) || 0) - 1);
  }
  return routed ? d : 0;
}

/** The estimated delay of an unrouted connection between two nodes (Manhattan distance in tiles). */
export function distanceDelay(a, b, device, model = SPEED_4) {
  const d = Math.abs(device.nodeR0[a] - device.nodeR0[b]) + Math.abs(device.nodeC0[a] - device.nodeC0[b]);
  const { base, perTile, knee, far } = model.dist;
  return base + perTile * Math.min(d, knee) + far * Math.max(0, d - knee);
}

// ------------------------------------------------------------------ logic
const F_PINS = ['F1', 'F2', 'F3', 'F4'], G_PINS = ['G1', 'G2', 'G3', 'G4'];

/**
 * The timing arcs of a placed instance (parseXdl's inst) from its type and configuration:
 * { comb: [[input pin, output pin, ns]], setup: [[input pin, ns]] (into a flip-flop or latch, before
 * the clock edge), clkToOut: [[output pin, ns]], clock: true if it has a flip-flop }. Pads: an input
 * pad's I pin starts paths (`input`), an output pad's O pin ends them (`output`).
 */
export function instArcs(inst, model = SPEED_4) {
  const comb = [], setup = [], clkToOut = [];
  const out = { comb, setup, clkToOut, input: [], output: [], clock: false };
  if (/^(IOB|IBUF|DIFF[MS]I?)$/.test(inst.type)) {
    out.input.push(['I', model.pad.Tiopi]);
    out.output.push(['O', model.pad.Tioop]);
    return out;
  }
  if (!/^SLICE[LM]$/.test(inst.type)) return out;
  const m = new Map(inst.cfg.map(c => [c.attr, c.value]));
  // SLICEM or SLICEL by the site (a slice may be written SLICEL on a SLICEM site): the left column of a CLB
  const sx = /^SLICE_X(\d+)Y/.exec(inst.site || '');
  const k = sx ? (+sx[1] % 2 === 0 ? 1 : 0) : inst.type === 'SLICEM' ? 1 : 0;
  const T = name => model.slice[name][k];
  const arc = (ins, o, d) => { for (const i of ins) comb.push([i, o, d]); };
  const cin = m.get('CYINIT') === 'BX' ? 'BX' : 'CIN';
  // into X / Y (kept to add the flip-flop's setup)
  const toX = [], toY = [];
  const fx = m.get('FXMUX'), gy = m.get('GYMUX');
  if (fx === 'F' || fx === undefined) for (const p of F_PINS) toX.push([p, T('Tilo')]);
  if (fx === 'F5') { for (const p of [...F_PINS, ...G_PINS]) toX.push([p, T('Tif5x')]); toX.push(['BX', T('Tbxx')]); }
  if (fx === 'FXOR') { for (const p of F_PINS) toX.push([p, T('Topx')]); toX.push([cin, cin === 'BX' ? T('Tbxxor') : T('Tcinx')]); }
  if (gy === 'G' || gy === undefined) for (const p of G_PINS) toY.push([p, T('Tilo')]);
  if (gy === 'FX') toY.push(['FXINA', T('Tif6y')], ['FXINB', T('Tif6y')], ['BY', T('Tbyy')]);
  if (gy === 'GXOR') {
    for (const p of G_PINS) toY.push([p, T('Togy')]);
    for (const p of F_PINS) toY.push([p, T('Topy')]);
    toY.push([cin, cin === 'BX' ? T('Tbxxor') : T('Tciny')]);
  }
  for (const [p, d] of toX) comb.push([p, 'X', d]);
  for (const [p, d] of toY) comb.push([p, 'Y', d]);
  arc([...F_PINS, ...G_PINS], 'F5', T('Tif5')); comb.push(['BX', 'F5', T('Tbxf5')]);
  arc(['FXINA', 'FXINB'], 'FX', T('Tinafx')); comb.push(['BY', 'FX', T('Tbyfx')]);
  // the carry chain: the LUT selects (S), CY0F / CY0G the data input (DI: a LUT pin, BX / BY or a constant)
  const cy = cin === 'BX' ? T('Tbxcy') : T('Tbyp');
  const cyF = F_PINS.map(p => [p, m.get('CY0F') === p ? T('TopcyfDI') : T('Topcyf')]);
  if (m.get('CY0F') === 'BX') cyF.push(['BX', T('Tbxcy')]);
  const cyG = G_PINS.map(p => [p, m.get('CY0G') === p ? T('TopcygDI') : T('Topcyg')]);
  if (m.get('CY0G') === 'BY') cyG.push(['BY', T('Tbycy')]);
  for (const [p, d] of [...cyF, ...cyG]) comb.push([p, 'COUT', d], [p, 'YB', d]);
  for (const [p, d] of cyF) comb.push([p, 'XB', d]);
  comb.push([cin, 'COUT', cy], [cin, 'XB', cy], [cin, 'YB', cy]);
  // the flip-flops (or latches): D from X / Y (DXMUX / DYMUX = 1) or from BX / BY
  const ff = (name, D, toD, byp, q, tco) => {
    if (!m.has(name)) return;
    out.clock = true;
    if (m.get(D) === '0') setup.push([byp, T('Tdick')]);
    else for (const [p, d] of toD) setup.push([p, d + T('Tdxck')]);
    clkToOut.push([q, T(tco)]);
  };
  ff('FFX', 'DXMUX', toX, 'BX', 'XQ', 'TckoX');
  ff('FFY', 'DYMUX', toY, 'BY', 'YQ', 'TckoY');
  if (out.clock) setup.push(['CE', T('Tceck')], ['SR', T('Tsrck')]);
  return out;
}

// ------------------------------------------------------------------ static timing analysis
const isConstNet = n => /^(vcc|gnd|power|ground|vdd)$/i.test(n.type || '');

/**
 * The timing graph of a design (parseXdl's structure, placed; routed or not): the pins of the
 * instances, the connections of the nets (driver pin -> load pin; not the clocks, not the
 * constants) and the arcs through the instances. Returns { conns: [{ net, fromPin: { inst, pin },
 * toPin }], connIndex: Map 'net\0inst\0pin' -> index, pins, analyze(connDelay) }.
 * analyze(connDelay: delay of each connection, ns) -> { period, clocks: [{ clock, period, path }],
 * slack: Float64Array, crit: Float64Array } covers the paths from a flip-flop to a flip-flop on the
 * same clock net (what trce's "minimum period" of each clock covers); the criticality of a
 * connection is 1 - slack / period, the slack taken against the worst clock's period.
 */
export function timingGraph(design, model = SPEED_4) {
  const pinId = new Map(), pinName = [];
  const pid = (inst, pin) => { const k = `${inst}\u0000${pin}`; let i = pinId.get(k); if (i === undefined) { i = pinName.length; pinId.set(k, i); pinName.push({ inst, pin }); } return i; };
  const instByName = new Map(design.insts.map(i => [i.name, i]));
  // the clock of each instance: the net on its CLK pin
  const clockOf = new Map();
  for (const n of design.nets) for (const p of n.inpins) if (p.pin === 'CLK') clockOf.set(p.inst, n.name);
  // edges: from pin, to pin, delay, connection (-1: an arc through an instance)
  const eFrom = [], eTo = [], eDelay = [], eConn = [];
  const conns = [], connIndex = new Map();
  for (const n of design.nets) {
    if (!n.outpins.length || isConstNet(n)) continue;
    const src = n.outpins[0];
    if (/^BUFG/.test(instByName.get(src.inst)?.type || '')) continue;
    for (const p of n.inpins) {
      if (p.pin === 'CLK') continue;
      const c = conns.length;
      conns.push({ net: n.name, fromPin: src, toPin: p });
      connIndex.set(`${n.name}\u0000${p.inst}\u0000${p.pin}`, c);
      eFrom.push(pid(src.inst, src.pin)); eTo.push(pid(p.inst, p.pin)); eDelay.push(0); eConn.push(c);
    }
  }
  const starts = [], ends = [];   // [pin, ns, clock]
  for (const inst of design.insts) {
    const a = instArcs(inst, model);
    const clk = clockOf.get(inst.name) || null;
    for (const [i, o, d] of a.comb) { eFrom.push(pid(inst.name, i)); eTo.push(pid(inst.name, o)); eDelay.push(d); eConn.push(-1); }
    if (!clk) continue;
    for (const [o, d] of a.clkToOut) starts.push([pid(inst.name, o), d, clk]);
    for (const [i, d] of a.setup) ends.push([pid(inst.name, i), d, clk]);
  }
  const P = pinName.length, E = eFrom.length;
  // edges by from-pin, and a topological order (Kahn; pins on a combinational loop are left out)
  const outStart = new Int32Array(P + 1), indeg = new Int32Array(P);
  for (let e = 0; e < E; e++) { outStart[eFrom[e] + 1]++; indeg[eTo[e]]++; }
  for (let p = 0; p < P; p++) outStart[p + 1] += outStart[p];
  const fill = outStart.slice(0, P), outEdge = new Int32Array(E);
  for (let e = 0; e < E; e++) outEdge[fill[eFrom[e]]++] = e;
  const order = [];
  for (let p = 0; p < P; p++) if (!indeg[p]) order.push(p);
  for (let j = 0; j < order.length; j++) for (let x = outStart[order[j]]; x < outStart[order[j] + 1]; x++) { const q = eTo[outEdge[x]]; if (--indeg[q] === 0) order.push(q); }
  const clocks = [...new Set(starts.map(s => s[2]))].sort();

  function analyze(connDelay) {
    const delay = Float64Array.from(eDelay);
    for (let e = 0; e < E; e++) if (eConn[e] >= 0) delay[e] = connDelay[eConn[e]];
    const req = new Float64Array(P), prevE = new Int32Array(P);
    const crit = new Float64Array(conns.length), slack = new Float64Array(conns.length).fill(Infinity);
    const perClock = [];
    for (const clk of clocks) {
      const arr = new Float64Array(P).fill(-Infinity);
      prevE.fill(-1);
      for (const [p, d, c] of starts) if (c === clk && d > arr[p]) arr[p] = d;
      for (const p of order) {
        if (arr[p] === -Infinity) continue;
        for (let x = outStart[p]; x < outStart[p + 1]; x++) { const e = outEdge[x], q = eTo[e], t = arr[p] + delay[e]; if (t > arr[q]) { arr[q] = t; prevE[q] = e; } }
      }
      let worst = -Infinity, wEnd = null;
      for (const end of ends) if (end[2] === clk && arr[end[0]] > -Infinity && arr[end[0]] + end[1] > worst) { worst = arr[end[0]] + end[1]; wEnd = end; }
      if (!wEnd) continue;
      // the critical path, back from its end
      const path = [{ ...pinName[wEnd[0]], kind: 'setup', delay: wEnd[1], arrival: worst }];
      for (let p = wEnd[0]; ;) {
        const e = prevE[p];
        path.unshift({ ...pinName[p], kind: e < 0 ? 'clock-to-out' : eConn[e] >= 0 ? 'net' : 'logic', delay: e < 0 ? arr[p] : delay[e], arrival: arr[p] });
        if (e < 0) break;
        p = eFrom[e];
      }
      perClock.push({ clock: clk, period: worst, path, arr });
    }
    const period = perClock.reduce((a, c) => Math.max(a, c.period), 0);
    // required times against the worst period
    for (const c of perClock) {
      req.fill(Infinity);
      for (const [p, d, k] of ends) if (k === c.clock && period - d < req[p]) req[p] = period - d;
      for (let j = order.length - 1; j >= 0; j--) {
        const p = order[j];
        for (let x = outStart[p]; x < outStart[p + 1]; x++) { const e = outEdge[x], t = req[eTo[e]] - delay[e]; if (t < req[p]) req[p] = t; }
      }
      for (let e = 0; e < E; e++) {
        const ci = eConn[e];
        if (ci < 0 || c.arr[eFrom[e]] === -Infinity || req[eTo[e]] === Infinity) continue;
        const s = req[eTo[e]] - c.arr[eFrom[e]] - delay[e];
        if (s < slack[ci]) slack[ci] = s;
      }
    }
    for (let ci = 0; ci < conns.length; ci++) crit[ci] = period > 0 && slack[ci] < Infinity ? Math.max(0, Math.min(1, 1 - slack[ci] / period)) : 0;
    return { period, clocks: perClock.map(c => ({ clock: c.clock, period: c.period, path: c.path })), crit, slack };
  }
  return { conns, connIndex, pins: pinName, analyze };
}

/** The delay of every connection of a timing graph from the routing of the design (Float64Array);
 *  a connection not routed (no PIPs, or not reached by them) is estimated from the distance. */
export function routedDelays(design, device, tg, model = SPEED_4) {
  const instByName = new Map(design.insts.map(i => [i.name, i]));
  const pinNode = p => { const i = instByName.get(p.inst); return i && i.placed ? device.sitePinNode(i.site, p.pin) : -1; };
  const netByName = new Map(design.nets.map(n => [n.name, n]));
  const byNet = new Map();
  tg.conns.forEach((c, i) => { if (!byNet.has(c.net)) byNet.set(c.net, []); byNet.get(c.net).push(i); });
  const connDelay = new Float64Array(tg.conns.length);
  for (const [name, idx] of byNet) {
    const net = netByName.get(name);
    const src = pinNode(net.outpins[0]);
    const tree = net.pips.length && src >= 0 ? netTree(net.pips, [src], device) : null;
    for (const i of idx) {
      const sink = pinNode(tg.conns[i].toPin);
      const path = tree && sink >= 0 ? treePath(tree, sink) : null;
      connDelay[i] = path ? pathDelay(path, tree, device, model) : src >= 0 && sink >= 0 ? distanceDelay(src, sink, device, model) : 0;
    }
  }
  return connDelay;
}

/**
 * Static timing analysis of a placed (and routed) design: connection delays from the routing (the
 * nets' PIPs) or, for a net without them, from the distance. Returns timingGraph's analysis plus
 * conns: [{ net, from: 'inst.pin', to, delay, slack, crit }].
 */
export function analyzeTiming(design, device, opts = {}) {
  const model = opts.model || SPEED_4;
  const tg = timingGraph(design, model);
  const connDelay = routedDelays(design, device, tg, model);
  const r = tg.analyze(connDelay);
  r.conns = tg.conns.map((c, i) => ({ net: c.net, from: `${c.fromPin.inst}.${c.fromPin.pin}`, to: `${c.toPin.inst}.${c.toPin.pin}`, delay: connDelay[i], slack: r.slack[i], crit: r.crit[i] }));
  return r;
}

/**
 * The port a clock net comes from: its driver is followed back through the clock buffers (BUFGMUX,
 * BUFG, the input buffer) to the I/O site, which the packer names after the port. null when the net
 * does not come from a pad (a clock made by logic).
 */
export function clockPort(design, netName) {
  const driverOf = new Map();
  for (const n of design.nets) for (const p of n.outpins || []) driverOf.set(n.name, p.inst);
  const inst = new Map(design.insts.map(i => [i.name, i]));
  const inNet = new Map();   // buffer instance -> the net on its data input (I0 / I, not the select S)
  for (const n of design.nets) for (const p of n.inpins || []) if (/^I0?$/.test(p.pin)) inNet.set(p.inst, n.name);
  let net = netName;
  for (let k = 0; k < 6 && net; k++) {
    const i = inst.get(driverOf.get(net));
    if (!i) return null;
    if (/^(IOB|IBUF|IBUFG|IOBS|IOBM|DIFFM|DIFFS)$/.test(i.type)) return i.name;
    if (!/^BUFG/.test(i.type)) return null;
    net = inNet.get(i.name);
  }
  return null;
}

/**
 * The clocks' periods against the PERIOD constraints of the UCF (core/ucf.js parseUcf().clocks:
 * [{ net, period }], the net being the clock's port): [{ clock, port, required, period, slack, met }]
 * for each constrained clock found, and { port, required, missing: true } for a constraint on a port
 * that clocks nothing analyzed.
 */
export function checkPeriods(r, design, constraints = []) {
  const out = [];
  const byPort = new Map(r.clocks.map(c => [String(clockPort(design, c.clock) || c.clock).toLowerCase(), c]));
  for (const k of constraints) {
    const c = byPort.get(String(k.net).toLowerCase());
    if (!c) { out.push({ port: k.net, required: k.period, missing: true }); continue; }
    out.push({ clock: c.clock, port: k.net, required: k.period, period: c.period, slack: k.period - c.period, met: c.period <= k.period });
  }
  return out;
}

/** A readable report of the critical path of each clock (lines of text), with the PERIOD checks
 *  (checkPeriods) when given. */
export function timingReport(r, checks = []) {
  const lines = [];
  for (const k of checks) {
    lines.push(k.missing ? `constraint PERIOD ${k.required} ns on ${k.port}: no clock of the design comes from this port`
      : `constraint PERIOD ${k.required} ns on ${k.port}: ${k.met ? 'met' : 'NOT MET'} (period ${k.period.toFixed(3)} ns, slack ${k.slack.toFixed(3)} ns)`);
  }
  for (const c of r.clocks) {
    lines.push(`clock ${c.clock}: minimum period ${c.period.toFixed(3)} ns (${(1000 / c.period).toFixed(1)} MHz)`);
    for (const s of c.path) lines.push(`  ${s.kind.padEnd(12)} ${s.delay.toFixed(3).padStart(7)} ${s.arrival.toFixed(3).padStart(8)}  ${s.inst}.${s.pin}`);
  }
  return lines;
}
