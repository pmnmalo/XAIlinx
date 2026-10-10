// Silinx - placer: the sites of a packed design (core/fpga/pack.js) on a Spartan-3E device
// (browser + Node).
//
// Simulated annealing (in the manner of VPR): every slice, every group of slices that must keep
// its shape (a carry chain up a slice column, the slices of an F6 / F7 / F8 multiplexer) and
// every pad without a LOC constraint is an object; a move takes one object to another position
// nearby (swapping with what is there); the cost is the half-perimeter wirelength of the nets,
// weighted for nets with many pins, in units of a CLB. Clock nets (from a BUFGMUX) run on the global
// clock lines and are left out. Moves that make the cost worse are accepted with a probability
// that falls as the temperature falls; the move window shrinks to keep about 44% of the moves
// accepted. Everything follows one seeded random generator: the same seed gives the same placement.
//
//   const dev = deviceSites(parseXdlrc(text))   the sites with their positions
//   const r = place(packed, dev, { seed, effort })
//     r = { sites: [{ tile, site }] by instance, cost, stats: { moves, temps, seconds, initialCost } }
//   placedXdl(packed, r) -> a design for writeXdl (core/fpga/xdl-write.js)

export class PlaceError extends Error {}

// ------------------------------------------------------------------ the device
/** Sites of the device by kind, with positions: slices by (x, y), pads by name, clock buffers. */
export function deviceSites(dev) {
  const rows = dev.rows;
  const slices = new Map(), pads = new Map(), bufgmux = [];
  for (const t of dev.tiles) {
    for (const s of t.sites) {
      let m;
      // physical position: tile column, tile row counted from the bottom (y grows upward as the
      // slice and CLB numbering does); the two slices of a column of a CLB half a tile apart
      if ((m = /^SLICE_X(\d+)Y(\d+)$/.exec(s.name))) {
        const x = +m[1], y = +m[2];
        slices.set(`${x},${y}`, { name: s.name, tile: t.name, type: s.type, x, y, px: t.c + (x % 2) * 0.5, py: rows - 1 - t.r + (y % 2) * 0.5 });
      } else if (/^(IOB|IBUF|DIFFM|DIFFS|DIFFMI|DIFFSI)$/.test(s.type) && s.bonded) {
        pads.set(s.name, { name: s.name, tile: t.name, type: s.type, px: t.c, py: rows - 1 - t.r, inputOnly: /^(IBUF|DIFFMI|DIFFSI)$/.test(s.type) });
      } else if (s.type === 'BUFGMUX') {
        bufgmux.push({ name: s.name, tile: t.name, px: t.c, py: rows - 1 - t.r });
      }
    }
  }
  return { part: dev.part, rows, cols: dev.cols, slices, pads, bufgmux };
}

// ------------------------------------------------------------------ random numbers
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// the expected wirelength of a net with n pins is more than its bounding box for n > 3 (VPR's
// crossing-count correction)
const CROSS = [1, 1, 1, 1, 1.0828, 1.1536, 1.2206, 1.2823, 1.3385, 1.3991, 1.4493, 1.4974, 1.5455, 1.5937, 1.6418, 1.6899, 1.7304, 1.7709, 1.8114, 1.8519, 1.8924, 1.9288, 1.9652, 2.0015, 2.0379, 2.0743, 2.1061, 2.1379, 2.1698, 2.2016, 2.2334, 2.2646, 2.2958, 2.3271, 2.3583, 2.3895, 2.4187, 2.4479, 2.4772, 2.5064, 2.5356, 2.5610, 2.5864, 2.6117, 2.6371, 2.6625, 2.6887, 2.7148, 2.7410, 2.7671, 2.7933];
const crossing = n => (n < CROSS.length ? CROSS[n] : 2.7933 + 0.02616 * (n - 50));

// Clock buffers next to their pad: a BUFG driven straight from a pad on the top / bottom edge
// takes a global buffer of that edge (as ISE does: B8 -> BUFGMUX_X2Y11); others the first free one.
const BUFG_ORDER = ['BUFGMUX_X2Y11', 'BUFGMUX_X2Y10', 'BUFGMUX_X1Y11', 'BUFGMUX_X1Y10', 'BUFGMUX_X2Y1', 'BUFGMUX_X2Y0', 'BUFGMUX_X1Y1', 'BUFGMUX_X1Y0'];

// ------------------------------------------------------------------ timing
// Which input pins of a site reach each of its outputs without a flip-flop in between, from its
// settings (the slice's output multiplexers and carry logic); flip-flop outputs (XQ, YQ) and pads
// start paths.
const LUT_PINS = s => [1, 2, 3, 4].map(k => `${s}${k}`);
function throughPins(inst) {
  const m = new Map(inst.cfg.map(c => [c.attr, c.value]));
  const deps = {};
  if (inst.kind !== 'slice') return deps;
  const cin = m.get('CYINIT') === 'BX' ? ['BX'] : ['CIN'];
  const cy0 = side => { const v = m.get(`CY0${side}`); return /^(BX|BY|F1|F2|G1|G2)$/.test(v || '') ? [v] : v === 'PROD' ? [`${side}1`, `${side}2`] : []; };
  const cyF = [...LUT_PINS('F'), ...cin, ...cy0('F')];
  const cyG = [...cyF, ...LUT_PINS('G'), ...cy0('G')];
  const f5 = [...LUT_PINS('F'), ...LUT_PINS('G'), 'BX'], fx = ['FXINA', 'FXINB', 'BY'];
  deps.X = { F: LUT_PINS('F'), F5: f5, FXOR: [...LUT_PINS('F'), ...cin] }[m.get('FXMUX')] || [];
  deps.Y = { G: LUT_PINS('G'), FX: fx, GXOR: [...LUT_PINS('G'), ...cyF] }[m.get('GYMUX')] || [];
  deps.F5 = f5; deps.FX = fx; deps.XB = cyF; deps.YB = cyG; deps.COUT = cyG;
  return deps;
}

/** Connections and their timing: every driver pin -> load pin of the nets (clocks and constants
 *  left out), with the input pins each output depends on. */
export function timingGraph(packed) {
  const conns = [];
  packed.nets.forEach((n, k) => {
    if (n.type !== 'wire' || !n.outpins.length) return;
    const src = n.outpins[0];
    if (packed.insts[src.inst].kind === 'bufg') return;
    for (const p of n.inpins) if (p.pin !== 'CLK') conns.push({ net: k, src: src.inst, srcPin: src.pin, dst: p.inst, dstPin: p.pin });
  });
  return { conns, deps: packed.insts.map(throughPins) };
}

/** Static timing on a placement, in rough units (a LUT 1, a connection 0.6 + 0.12 per CLB):
 *  the critical path delay and the criticality (0..1) of every connection. pos[inst] = [x, y]. */
export function analyzeTiming(tg, pos, { lut = 1, wire0 = 0.6, perClb = 0.12 } = {}) {
  const { conns, deps } = tg;
  const delay = c => wire0 + perClb * (Math.abs(pos[c.src][0] - pos[c.dst][0]) + Math.abs(pos[c.src][1] - pos[c.dst][1]));
  // pins as nodes: `${inst}:${pin}`
  const into = new Map();    // input pin -> connections arriving
  const outOf = new Map();   // output pin -> connections leaving
  const key = (i, p) => `${i}:${p}`;
  for (const c of conns) {
    const a = key(c.dst, c.dstPin), b = key(c.src, c.srcPin);
    if (!into.has(a)) into.set(a, []);
    into.get(a).push(c);
    if (!outOf.has(b)) outOf.set(b, []);
    outOf.get(b).push(c);
  }
  // arrival at an output pin: its through inputs + a LUT level (memoised depth-first; a loop
  // through the model counts as a start)
  const arr = new Map();
  const busy = new Set();
  const arrOut = (i, p) => {
    const k = key(i, p);
    if (arr.has(k)) return arr.get(k);
    const d = deps[i][p];
    if (!d || !d.length || busy.has(k)) return 0;
    busy.add(k);
    let t = 0;
    for (const q of d) for (const c of into.get(key(i, q)) || []) t = Math.max(t, arrOut(c.src, c.srcPin) + delay(c));
    busy.delete(k);
    arr.set(k, t + lut);
    return t + lut;
  };
  let dmax = 0;
  for (const c of conns) { c.delay = delay(c); c.arr = arrOut(c.src, c.srcPin) + c.delay; if (c.arr > dmax) dmax = c.arr; }
  // required times: dmax at every load pin, earlier when the pin passes on to an output
  const req = new Map();
  const reqIn = (i, p) => {
    let r = dmax;
    for (const [o, d] of Object.entries(deps[i])) if (d.includes(p) && outOf.has(key(i, o))) r = Math.min(r, reqOut(i, o) - lut);
    return r;
  };
  const reqOut = (i, p) => {
    const k = key(i, p);
    if (req.has(k)) return req.get(k);
    req.set(k, dmax);   // (loops)
    let r = dmax;
    for (const c of outOf.get(k) || []) r = Math.min(r, reqIn(c.dst, c.dstPin) - c.delay);
    req.set(k, r);
    return r;
  };
  for (const c of conns) {
    const slack = reqIn(c.dst, c.dstPin) - c.arr;
    c.crit = dmax > 0 ? Math.max(0, Math.min(1, 1 - slack / dmax)) : 0;
  }
  return { dmax, conns };
}

/** Place a packed design. Options: seed (1), effort (1: moves per temperature scale with it),
 *  timing (1: how much more the nets on the slowest paths weigh; 0: wirelength only),
 *  log (function for progress lines). */
export function place(packed, dev, { seed = 1, effort = 1, timing = 1, log = null } = {}) {
  const t0 = Date.now();
  if (!dev.slices) throw new PlaceError('place: pass deviceSites(parseXdlrc(…))');
  const random = rng(seed);
  const ri = n => Math.floor(random() * n);
  const N = packed.insts.length;
  const sites = new Array(N).fill(null);     // inst -> site object
  const pos = new Array(N);                  // inst -> [px, py]
  let moves = 0, temps = 0;

  // ---------------------------------------------------------------- objects
  const objOf = new Array(N).fill(-1);
  const objs = [];
  const addObj = o => { o.id = objs.length; objs.push(o); return o; };
  for (const m of packed.macros) {
    const o = { kind: 'macro', members: m.members.map(x => ({ inst: x.inst, dx: x.dx, dy: x.dy })), align: m.align || [1, 1], anchor: null, macro: m.kind };
    for (const x of o.members) objOf[x.inst] = objs.length;
    addObj(o);
  }
  packed.insts.forEach((inst, i) => {
    if (objOf[i] >= 0) return;
    objOf[i] = objs.length;
    if (inst.kind === 'slice') addObj({ kind: 'macro', members: [{ inst: i, dx: 0, dy: 0 }], align: [1, 1], anchor: null });
    else if (inst.kind === 'iob') addObj({ kind: 'iob', inst: i, fixed: !!inst.loc, dir: inst.dir });
    else if (inst.kind === 'bufg') addObj({ kind: 'bufg', inst: i });
    else throw new PlaceError(`place: unknown instance kind ${inst.kind}`);
  });

  // ---------------------------------------------------------------- pads and clock buffers
  const padUsed = new Map();   // pad name -> obj
  for (const o of objs) if (o.kind === 'iob' && o.fixed) {
    const inst = packed.insts[o.inst];
    const p = dev.pads.get(inst.loc);
    if (!p) throw new PlaceError(`place: ${inst.name}: LOC ${inst.loc} is not a bonded pad of ${dev.part}`);
    if (p.inputOnly && o.dir !== 'in') throw new PlaceError(`place: ${inst.name}: pad ${inst.loc} is input-only`);
    if (padUsed.has(p.name)) throw new PlaceError(`place: two ports on pad ${p.name}`);
    padUsed.set(p.name, o);
    sites[o.inst] = p;
  }
  const freePads = dir => [...dev.pads.values()].filter(p => !padUsed.has(p.name) && (dir === 'in' || !p.inputOnly));
  for (const o of objs) if (o.kind === 'iob' && !o.fixed) {
    const fp = freePads(o.dir);
    if (!fp.length) throw new PlaceError('place: not enough pads');
    const p = fp[ri(fp.length)];
    padUsed.set(p.name, o);
    sites[o.inst] = p;
  }
  // clock buffers: by the pad that drives them
  const bufUsed = new Set();
  const byName = new Map(dev.bufgmux.map(b => [b.name, b]));
  const driverOfPin = new Map();
  for (const n of packed.nets) for (const ip of n.inpins) driverOfPin.set(`${ip.inst}:${ip.pin}`, n.outpins[0]);
  for (const o of objs) if (o.kind === 'bufg') {
    const d = driverOfPin.get(`${o.inst}:I0`);
    const pad = d && sites[d.inst];
    const top = pad && pad.py > dev.rows / 2;
    const order = [...BUFG_ORDER.slice(top ? 0 : 4, top ? 4 : 8), ...BUFG_ORDER.slice(top ? 4 : 0, top ? 8 : 4), ...dev.bufgmux.map(b => b.name)];
    const b = order.map(n => byName.get(n)).find(b => b && !bufUsed.has(b.name));
    if (!b) throw new PlaceError('place: no free global clock buffer');
    bufUsed.add(b.name);
    sites[o.inst] = b;
  }

  // ---------------------------------------------------------------- slices: legal anchors, occupancy
  const occ = new Map();   // `${x},${y}` -> inst
  const fitsAt = (o, x, y) => {
    if (x % o.align[0] || y % o.align[1]) return false;
    for (const m of o.members) if (!dev.slices.has(`${x + m.dx},${y + m.dy}`)) return false;
    return true;
  };
  const sliceList = [...dev.slices.values()];
  const maxX = Math.max(...sliceList.map(s => s.x)), maxY = Math.max(...sliceList.map(s => s.y));
  const setAt = (o, x, y) => {
    o.anchor = [x, y];
    for (const m of o.members) {
      const k = `${x + m.dx},${y + m.dy}`;
      occ.set(k, m.inst);
      sites[m.inst] = dev.slices.get(k);
    }
  };
  // initial placement: the largest groups first, each at a random free legal position near the
  // middle of the chip (then the annealing spreads and orders them)
  const slicesObjs = objs.filter(o => o.kind === 'macro').sort((a, b) => b.members.length - a.members.length);
  const total = slicesObjs.reduce((a, o) => a + o.members.length, 0);
  if (total > dev.slices.size) throw new PlaceError(`place: ${total} slices needed, the device has ${dev.slices.size}`);
  for (const o of slicesObjs) {
    let done = false;
    for (let tries = 0; tries < 20000 && !done; tries++) {
      // a window around the centre that grows with the attempts
      const r = Math.min(1, 0.25 + tries / 4000);
      const x = Math.floor(maxX / 2 + (random() - 0.5) * (maxX + 1) * r), y = Math.floor(maxY / 2 + (random() - 0.5) * (maxY + 1) * r);
      if (x < 0 || y < 0 || !fitsAt(o, x, y)) continue;
      if (o.members.some(m => occ.has(`${x + m.dx},${y + m.dy}`))) continue;
      setAt(o, x, y);
      done = true;
    }
    if (!done) {
      // exhaustive search
      outer: for (let x = 0; x <= maxX; x++) for (let y = 0; y <= maxY; y++) {
        if (!fitsAt(o, x, y) || o.members.some(m => occ.has(`${x + m.dx},${y + m.dy}`))) continue;
        setAt(o, x, y);
        done = true;
        break outer;
      }
    }
    if (!done) throw new PlaceError(`place: no room for a group of ${o.members.length} slices (${o.macro || 'slice'})`);
  }
  for (let i = 0; i < N; i++) { if (!sites[i]) throw new PlaceError(`place: ${packed.insts[i].name} not placed`); pos[i] = [sites[i].px, sites[i].py]; }

  // ---------------------------------------------------------------- nets and cost
  // nets for the cost: not the clocks (global lines), not the constants, not the carry links
  const nets = [];
  const netsOf = Array.from({ length: N }, () => []);
  for (const n of packed.nets) {
    if (n.type !== 'wire' || !n.outpins.length) continue;
    const d = packed.insts[n.outpins[0].inst];
    if (d.kind === 'bufg') continue;
    const pins = [...new Set([...n.outpins, ...n.inpins].map(p => p.inst))];
    if (pins.length < 2) continue;
    const k = nets.length;
    nets.push({ pins, base: crossing(pins.length), w: crossing(pins.length), cost: 0, src: n });
    for (const i of pins) netsOf[i].push(k);
  }
  const netCost = n => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of n.pins) { const [x, y] = pos[i]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return n.w * ((x1 - x0) + (y1 - y0));
  };
  let cost = 0;
  for (const n of nets) { n.cost = netCost(n); cost += n.cost; }
  const initialCost = cost;
  // timing: a net weighs more the more critical its most critical connection is; the weights
  // follow the placement (recomputed at every temperature, as VPR's timing-driven placer does)
  const tg = timing > 0 ? timingGraph(packed) : null;
  const netIndex = new Map(nets.map((n, k) => [n.src, k]));
  let dmax = 0;
  const reweight = () => {
    if (!tg) return;
    const t = analyzeTiming(tg, pos);
    dmax = t.dmax;
    const crit = new Array(nets.length).fill(0);
    for (const c of t.conns) { const k = netIndex.get(packed.nets[c.net]); if (k !== undefined && c.crit > crit[k]) crit[k] = c.crit; }
    cost = 0;
    nets.forEach((n, k) => { n.w = n.base * (1 + timing * crit[k] ** 4); n.cost = netCost(n); cost += n.cost; });
  };
  reweight();
  const initialDelay = dmax;

  // ---------------------------------------------------------------- moves
  const movable = objs.filter(o => (o.kind === 'macro') || (o.kind === 'iob' && !o.fixed));
  if (!movable.length) return finish();
  // propose: returns the list of [inst, newSite] changes, or null
  let rlim = Math.max(maxX, maxY);
  const padsFor = { in: [...dev.pads.values()], out: [...dev.pads.values()].filter(p => !p.inputOnly) };
  function propose() {
    const o = movable[ri(movable.length)];
    if (o.kind === 'iob') {
      const cands = padsFor[o.dir === 'in' ? 'in' : 'out'];
      const p = cands[ri(cands.length)];
      const other = padUsed.get(p.name);
      if (other === o) return null;
      if (other && (other.fixed || (other.dir !== 'in' && sites[o.inst].inputOnly))) return null;
      const ch = [[o.inst, p]];
      if (other) ch.push([other.inst, sites[o.inst]]);
      return { ch, kind: 'iob', o, other, p };
    }
    const [ax, ay] = o.anchor;
    const r = Math.max(1, Math.round(rlim));
    const x = ax + ri(2 * r + 1) - r, y = ay + ri(2 * r + 1) - r;
    if ((x === ax && y === ay) || x < 0 || y < 0 || !fitsAt(o, x, y)) return null;
    const newKeys = o.members.map(m => `${x + m.dx},${y + m.dy}`);
    const oldKeys = new Set(o.members.map(m => `${ax + m.dx},${ay + m.dy}`));
    const displaced = [];
    for (const k of newKeys) {
      const i = occ.get(k);
      if (i === undefined || objOf[i] === o.id) continue;
      const oo = objs[objOf[i]];
      if (oo.members.length > 1) return null;   // only single slices step aside
      displaced.push(i);
    }
    const freed = [...oldKeys].filter(k => !newKeys.includes(k));
    const ch = o.members.map((m, j) => [m.inst, dev.slices.get(newKeys[j])]);
    displaced.forEach((i, j) => ch.push([i, dev.slices.get(freed[j])]));
    return { ch, kind: 'slice', o, x, y, displaced, freed };
  }
  function delta(ch) {
    const touched = new Set();
    for (const [i] of ch) for (const k of netsOf[i]) touched.add(k);
    const save = ch.map(([i]) => pos[i]);
    for (const [i, s] of ch) pos[i] = [s.px, s.py];
    let d = 0;
    const newCosts = [];
    for (const k of touched) { const c = netCost(nets[k]); newCosts.push([k, c]); d += c - nets[k].cost; }
    ch.forEach(([i], j) => { pos[i] = save[j]; });
    return { d, newCosts };
  }
  function commit(mv, newCosts) {
    if (mv.kind === 'iob') {
      const { o, other, p } = mv;
      const old = sites[o.inst];
      padUsed.delete(old.name);
      if (other) { padUsed.set(old.name, other); sites[other.inst] = old; pos[other.inst] = [old.px, old.py]; }
      padUsed.set(p.name, o); sites[o.inst] = p; pos[o.inst] = [p.px, p.py];
    } else {
      const { o, x, y, displaced, freed } = mv;
      const [ax, ay] = o.anchor;
      for (const m of o.members) occ.delete(`${ax + m.dx},${ay + m.dy}`);
      displaced.forEach((i, j) => {
        const s = dev.slices.get(freed[j]);
        occ.set(freed[j], i); sites[i] = s; pos[i] = [s.px, s.py];
        objs[objOf[i]].anchor = [s.x, s.y];
      });
      setAt(o, x, y);
      for (const m of o.members) pos[m.inst] = [sites[m.inst].px, sites[m.inst].py];
    }
    for (const [k, c] of newCosts) { cost += c - nets[k].cost; nets[k].cost = c; }
  }

  // ---------------------------------------------------------------- annealing
  // initial temperature: 20 x the standard deviation of the cost changes of random moves
  const sample = [];
  for (let k = 0; k < Math.max(50, movable.length); k++) { const mv = propose(); if (mv) sample.push(delta(mv.ch).d); }
  const mean = sample.reduce((a, b) => a + b, 0) / Math.max(1, sample.length);
  const sd = Math.sqrt(sample.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sample.length));
  let T = 20 * sd || 1;
  const perT = Math.max(100, Math.round(effort * 10 * Math.pow(movable.length, 4 / 3)));
  for (;;) {
    let acc = 0, tried = 0;
    for (let k = 0; k < perT; k++) {
      const mv = propose();
      if (!mv) continue;
      tried++;
      const { d, newCosts } = delta(mv.ch);
      if (d <= 0 || random() < Math.exp(-d / T)) { commit(mv, newCosts); acc++; }
    }
    moves += perT; temps++;
    reweight();
    const a = tried ? acc / tried : 0;
    // VPR's schedule: cool slowly while many moves are accepted
    T *= a > 0.96 ? 0.5 : a > 0.8 ? 0.9 : a > 0.15 ? 0.95 : 0.8;
    rlim = Math.min(Math.max(maxX, maxY), Math.max(1, rlim * (1 - 0.44 + a)));
    if (log && temps % 10 === 0) log(`T=${T.toFixed(3)} cost=${cost.toFixed(1)} accept=${a.toFixed(2)} rlim=${rlim.toFixed(1)}`);
    if (T < 0.005 * cost / Math.max(1, nets.length) || temps > 400) break;
  }
  // a last greedy pass (temperature 0)
  for (let k = 0; k < perT; k++) { const mv = propose(); if (!mv) continue; const { d, newCosts } = delta(mv.ch); if (d < 0) commit(mv, newCosts); }
  // the result: the wirelength alone (no drift), and the estimated critical path
  reweight();
  if (!tg) dmax = analyzeTiming(timingGraph(packed), pos).dmax;
  cost = 0;
  for (const n of nets) { n.w = n.base; n.cost = netCost(n); cost += n.cost; }
  return finish();

  function finish() {
    return {
      sites: sites.map(s => ({ tile: s.tile, site: s.name })),
      cost, delay: dmax, stats: { initialCost, initialDelay, moves, temps, seconds: (Date.now() - t0) / 1000, objects: objs.length },
    };
  }
}

/** The placed design, ready for writeXdl: instances with their sites, nets by instance name. */
export function placedXdl(packed, placement) {
  const insts = packed.insts.map((i, k) => ({ name: i.name, type: i.type, placed: true, tile: placement.sites[k].tile, site: placement.sites[k].site, cfg: i.cfg }));
  const nets = packed.nets.map(n => ({
    name: n.name, type: n.type,
    outpins: n.outpins.map(p => ({ inst: insts[p.inst].name, pin: p.pin })),
    inpins: n.inpins.map(p => ({ inst: insts[p.inst].name, pin: p.pin })),
    pips: [],
  }));
  return { name: packed.name, part: packed.part, cfg: packed.cfg || '', insts, nets };
}
