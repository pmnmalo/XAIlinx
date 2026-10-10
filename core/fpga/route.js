// Silinx - the router: a placed XDL design in, the same design with every net's PIPs out (browser + Node).
//
// Algorithm: PathFinder (McMurchie and Ebeling, 1995), negotiated congestion. Every net is routed
// as a tree over the device's routing nodes (core/fpga/device.js), each sink found by an A* search
// from the whole tree built so far. At first nets may share nodes; after each pass the cost of a
// node that is used by more than one net goes up (present congestion, growing every pass) and
// stays higher (history), so nets negotiate who gets the contested wires until no node is shared.
//
// Special nets:
// - Global clocks (driven by a BUFGMUX): the clock pins of the slices can also be reached from
//   general routing, but a clock must use the dedicated global network (the GCLK wires of the
//   clock spine, as ISE does), so their search only uses nodes with a GCLK wire, with general
//   routing kept as a fallback for a sink the global network cannot reach (e.g. a LUT input).
// - Carry chains: COUT -> CIN is an ordinary PIP of the CLB (COUT0 -> CIN2, or COUT_N to the
//   tile above), found like any other.
// - VCC / GND nets come from ISE with a source the converter makes up ("XDL_DUMMY_<tile>_<site>",
//   e.g. the VCC site of a tile, pin VCCOUT, or an unused slice); the site is taken from the name.
//   A VCC net without a source is tied to the nearest VCC site (VCC_PINWIRE of the tile).
// - Route-through PIPs (paths through a site: a LUT, the carry chain, a BUFGMUX) are used only out
//   of the net's own source site onto a free output pin: a carry chain whose last COUT does not go
//   to a CIN leaves the slice through YB (COUT -> YB), as ISE routes it. Through any other site they
//   would need that site configured for it, so they are never used.

import { PIP_ROUTETHRU } from './device.js';

// ------------------------------------------------------------------ the nets of a design
/** The site of an instance, or of the made-up source of a power net ("XDL_DUMMY_<tile>_<site>"). */
function siteOfInst(name, instByName, device) {
  const inst = instByName.get(name);
  if (inst) return inst.placed ? inst.site : null;
  const m = /^XDL_DUMMY_(.+)$/.exec(name);
  if (!m) return null;
  // the tile name has underscores too: try each split point
  const s = m[1];
  for (let i = s.indexOf('_'); i > 0; i = s.indexOf('_', i + 1)) {
    const tile = s.slice(0, i), site = s.slice(i + 1);
    if (device.tile(tile) !== undefined && device.site(site)) return site;
  }
  return null;
}

/**
 * The routing problem of a parsed design (core/xdl.js parseXdl): for each net its source nodes and
 * sink nodes. Problems (unplaced instances, pins the device does not have) are listed in `errors`.
 */
export function netEndpoints(design, device) {
  const instByName = new Map(design.insts.map(i => [i.name, i]));
  const nets = [], errors = [];
  const pinNode = (p, what, net) => {
    const site = siteOfInst(p.inst, instByName, device);
    if (!site) { errors.push(`net ${net.name}: ${what} ${p.inst}.${p.pin}: instance not placed or unknown`); return -1; }
    const n = device.sitePinNode(site, p.pin);
    if (n < 0) errors.push(`net ${net.name}: ${what} ${p.inst}.${p.pin}: site ${site} has no pin ${p.pin}`);
    return n;
  };
  for (const net of design.nets) {
    const sources = net.outpins.map(p => pinNode(p, 'outpin', net)).filter(n => n >= 0);
    const sourceSites = net.outpins.map(p => siteOfInst(p.inst, instByName, device)).filter(Boolean);
    const sinks = net.inpins.map(p => ({ pin: p, node: pinNode(p, 'inpin', net) })).filter(s => s.node >= 0);
    const driverTypes = net.outpins.map(p => instByName.get(p.inst)?.type);
    nets.push({
      net, name: net.name, type: net.type || 'wire', sources, sourceSites, sinks,
      clock: driverTypes.some(t => t === 'BUFGMUX' || t === 'BUFG'),
    });
  }
  return { nets, errors };
}

// ------------------------------------------------------------------ binary heap of (cost, node)
class Heap {
  constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.n = 0; }
  clear() { this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) { const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k; const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v; }
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

// ------------------------------------------------------------------ the router
/** Nodes of the dedicated global clock network: nodes with a GCLK wire (CLKT_GCLK_MAIN, GCLKVC, GCLKH, the CLBs' GCLK0-7…). */
function globalClockMask(device) {
  if (device._gclkMask) return device._gclkMask;
  const mask = new Uint8Array(device.nodeCount);
  const gclkName = device.names.map(n => /GCLK/.test(n));
  for (let w = 0; w < device.wireCount; w++) {
    const k = device.wireTile[w], tp = device.templates[device.tileTemplate[k]];
    if (gclkName[tp.wires[w - device.tileWireBase[k]]]) mask[device.nodeOf[w]] = 1;
  }
  return (device._gclkMask = mask);
}

/**
 * Route a placed design. `design` is parseXdl()'s structure (its existing PIPs are ignored and
 * replaced); `device` a Device (loadDevice). Options: maxIterations (50), log (fn).
 * Returns { design (a copy with the PIPs of every routed net), routed, failed: [names], iterations,
 * overused (nodes still shared at the end: 0 when successful), errors, pips, timeMs }.
 */
export function routeDesign(design, device, opts = {}) {
  const t0 = Date.now();
  const log = opts.log || (() => {});
  const maxIter = opts.maxIterations ?? 50;
  const { nets: all, errors } = netEndpoints(design, device);
  const E = device.routingEdges();
  const N = device.nodeCount;
  const gclk = globalClockMask(device);

  // power nets without a source (as a placer writes them): tied to made-up sources, as ISE does
  const work = [];
  const sourceless = { vcc: [], gnd: [] };
  const tied = new Set();     // the sourceless nets replaced by one net per made-up source
  for (const n of all) {
    if (!n.sinks.length) continue;
    if (!n.sources.length) {
      const kind = /^(vcc|power|vdd)$/i.test(n.type) ? 'vcc' : /^(gnd|ground)$/i.test(n.type) ? 'gnd' : null;
      if (kind) sourceless[kind].push(n); else errors.push(`net ${n.name}: no source`);
      continue;
    }
    work.push(n);
  }
  if (sourceless.vcc.length || sourceless.gnd.length) {
    const usedSites = new Set(design.insts.filter(i => i.placed).map(i => i.site));
    for (const n of all) for (const site of n.sourceSites) usedSites.add(site);   // ISE's made-up sources too
    for (const n of [...sourceless.vcc, ...sourceless.gnd]) tied.add(n.net);
    work.push(...tieConstants(sourceless.vcc, 'vcc', device, usedSites, errors), ...tieConstants(sourceless.gnd, 'gnd', device, usedSites, errors));
  }
  // pins belong to their net: no other net may route through them
  const owner = new Int32Array(N).fill(-1);
  const isSource = new Int32Array(N);     // net index + 1 of the source pins
  work.forEach((n, i) => { for (const s of n.sources) { owner[s] = i; isSource[s] = i + 1; } for (const s of n.sinks) owner[s.node] = i; });

  const occ = new Int32Array(N);
  const hist = new Float32Array(N);
  const trees = work.map(() => null);      // Map node -> entering edge (-1 for a source)
  const g = new Float64Array(N), stamp = new Int32Array(N), prev = new Int32Array(N), done = new Int32Array(N);
  let curStamp = 0;
  // the from-node of each edge (the CSR keeps only edgeTo), to walk a path back
  const edgeFrom = new Int32Array(E.edgeTo.length);
  for (let n = 0; n < N; n++) edgeFrom.fill(n, E.edgeStart[n], E.edgeStart[n + 1]);
  const heap = new Heap();
  const failed = new Set();

  // A* from the tree to one sink; returns the list of edges of the new branch (sink first) or null
  const search = (tree, sink, netIdx, pf, restrict) => {
    curStamp++;
    heap.clear();
    const tr = device.nodeR0[sink], tc = device.nodeC0[sink];
    const h = m => {
      const dr = tr < device.nodeR0[m] ? device.nodeR0[m] - tr : tr > device.nodeR1[m] ? tr - device.nodeR1[m] : 0;
      const dc = tc < device.nodeC0[m] ? device.nodeC0[m] - tc : tc > device.nodeC1[m] ? tc - device.nodeC1[m] : 0;
      return 0.3 * (dr + dc);
    };
    for (const n of tree.keys()) { stamp[n] = curStamp; g[n] = 0; prev[n] = -1; done[n] = 0; heap.push(h(n), n); }
    let expanded = 0;
    while (heap.n) {
      const n = heap.pop();
      if (done[n] === curStamp) continue;
      done[n] = curStamp;
      if (n === sink) {
        const path = [];
        for (let m = n; !tree.has(m); m = edgeFrom[prev[m]]) path.push(prev[m]);
        return path;
      }
      if (++expanded > 400000) return null;
      for (let e = E.edgeStart[n]; e < E.edgeStart[n + 1]; e++) {
        const m = E.edgeTo[e];
        // a route-through (a path through a site) only out of the net's own source site, onto an
        // output pin no other net uses: the carry chain's last COUT out through YB, as ISE does;
        // never through a LUT or another site, which would need that site configured for it
        if (E.edgeFlags[e] & PIP_ROUTETHRU && !(prev[n] === -1 && isSource[n] === netIdx + 1 && owner[m] < 0)) continue;
        if (done[m] === curStamp) continue;
        if (owner[m] >= 0 && owner[m] !== netIdx) continue;
        if (restrict && !restrict[m] && m !== sink) continue;
        const over = occ[m];      // other nets on this node (this net is ripped up)
        const c = (1 + hist[m]) * (1 + pf * over);
        const gm = g[n] + c;
        if (stamp[m] !== curStamp || gm < g[m]) {
          stamp[m] = curStamp; g[m] = gm; prev[m] = e; done[m] = 0;
          heap.push(gm + h(m), m);
        }
      }
    }
    return null;
  };
  const ripUp = i => { if (trees[i]) for (const n of trees[i].keys()) occ[n]--; trees[i] = null; };
  const routeNet = (i, pf) => {
    const net = work[i];
    const tree = new Map();
    for (const s of net.sources) tree.set(s, -1);
    // nearest sinks first, so later sinks branch off a tree that already spans the region
    const src = net.sources[0];
    const dist = s => Math.abs(device.nodeR0[s.node] - device.nodeR0[src]) + Math.abs(device.nodeC0[s.node] - device.nodeC0[src]);
    const sinks = [...net.sinks].sort((a, b) => dist(a) - dist(b));
    let ok = true;
    for (const s of sinks) {
      if (tree.has(s.node)) continue;
      let path = net.clock ? search(tree, s.node, i, pf, gclk) : null;
      if (!path) path = search(tree, s.node, i, pf, null);
      if (!path) { ok = false; continue; }
      for (const e of path) tree.set(E.edgeTo[e], e);
    }
    for (const n of tree.keys()) occ[n]++;
    trees[i] = tree;
    return ok;
  };

  let iter = 0, overused = 0, pf = 0.5;
  let toRoute = work.map((_, i) => i);
  for (iter = 1; iter <= maxIter; iter++) {
    for (const i of toRoute) { ripUp(i); if (routeNet(i, pf)) failed.delete(i); else failed.add(i); }
    // congestion: nodes used by more than one net
    overused = 0;
    const hot = new Uint8Array(N);
    for (let n = 0; n < N; n++) if (occ[n] > 1) { overused++; hot[n] = 1; hist[n] += 0.5 * (occ[n] - 1); }
    log(`iteration ${iter}: ${toRoute.length} nets routed, ${overused} nodes overused, ${failed.size} unroutable`);
    if (!overused) break;
    toRoute = [];
    work.forEach((_, i) => { if (trees[i] && [...trees[i].keys()].some(n => hot[n])) toRoute.push(i); });
    pf *= 1.6;
  }

  // the routed design: each net's PIPs (ISE's own power nets keep their names; made-up ones are added)
  // the made-up sources are declared as instances, as ISE writes them (xdl -xdl2ncd rejects an
  // outpin on an undeclared "XDL_DUMMY_…" instance)
  const dummies = work.filter(w => w.synthetic && !design.insts.some(i => i.name === w.outpins[0].inst)).map(w => w.dummy);
  const out = { ...design, insts: [...design.insts, ...dummies], nets: [] };
  const routedBy = new Map();
  work.forEach((n, i) => routedBy.set(n.net, [...(routedBy.get(n.net) || []), i]));
  let pipCount = 0;
  const pipsOf = i => {
    const pips = [];
    for (const e of trees[i]?.values() || []) {
      if (e < 0) continue;
      const p = device.pip(E.edgeTile[e], E.edgePip[e]);
      pips.push({ tile: p.tile, from: p.from, dir: p.dir, to: p.to });
    }
    pipCount += pips.length;
    return pips;
  };
  for (const net of design.nets) {
    const idx = routedBy.get(net);
    if (!idx) { if (!tied.has(net)) out.nets.push({ ...net, pips: [] }); continue; }
    for (const i of idx) {
      const w = work[i];
      if (w.synthetic) out.nets.push({ ...net, name: w.name, outpins: w.outpins, inpins: w.sinks.map(s => s.pin), pips: pipsOf(i) });
      else out.nets.push({ ...net, pips: pipsOf(i) });
    }
  }
  return {
    design: out, routed: work.length - failed.size, failed: [...failed].map(i => work[i].name),
    iterations: Math.min(iter, maxIter), overused, errors, pips: pipCount, timeMs: Date.now() - t0,
  };
}

// Sources for the constant nets a placer leaves without one, the way ISE writes them in XDL:
// - VCC: a VCC site (pin VCCOUT, wire VCC_PINWIRE / IOIS_VCC_WIRE…; every CLB and I/O tile has one,
//   wired by a PIP to the pins of its tile that may need a 1): the one of the sink's own tile when it
//   reaches the sink directly, else the nearest. Source "XDL_DUMMY_<tile>_<VCC site>" VCCOUT.
// - GND: the Y output of an unused slice nearby, "XDL_DUMMY_<tile>_<slice>" Y; xdl -xdl2ncd turns
//   it into a slice whose G LUT gives 0 (ISE's own designs read back this way give the same
//   bitstream as ISE's: research/s3e-route/README.md).
// Each source is declared as an instance with ISE's configuration for it:
//   inst "XDL_DUMMY_CLB_X9Y1_SLICE_X17Y1" "SLICEL", placed CLB_X9Y1 SLICE_X17Y1, cfg "_NO_USER_LOGIC:: _GND_SOURCE::Y ";
//   inst "XDL_DUMMY_CLKB_X13Y0_VCC_X15Y0" "VCC", placed CLKB_X13Y0 VCC_X15Y0, cfg "_NO_USER_LOGIC:: _VCC_SOURCE::VCCOUT ";
// All the sourceless nets of one kind are the same signal, so they are merged and split again
// into one net per source.
function tieConstants(nets, kind, device, usedSites, errors) {
  if (!nets.length) return [];
  const pin = kind === 'vcc' ? 'VCCOUT' : 'Y';
  const cands = (kind === 'vcc' ? device.sites('VCC') : [...device.sites('SLICEL'), ...device.sites('SLICEM')])
    .filter(s => !usedSites.has(s.name))
    .map(s => ({ ...s, node: device.sitePinNode(s.name, pin) }))
    .filter(s => s.node >= 0);
  const reachesDirectly = (src, sink) => { let ok = false; device.forEachPip(src, (to, k, i, f) => { if (to === sink && !(f & PIP_ROUTETHRU)) ok = true; }); return ok; };
  const groups = new Map();
  for (const n of nets) for (const s of n.sinks) {
    const r = device.nodeR0[s.node], c = device.nodeC0[s.node];
    let best = null, bd = Infinity;
    for (const v of cands) {
      let d = Math.abs(device.tileRow[v.tile] - r) + Math.abs(device.tileCol[v.tile] - c);
      if (kind === 'vcc') d = reachesDirectly(v.node, s.node) ? d : d + 1000;
      if (d < bd) { bd = d; best = v; }
    }
    if (!best) { errors.push(`net ${n.name}: no free site for a ${kind} source`); continue; }
    if (!groups.has(best.name)) groups.set(best.name, { site: best, net: n, sinks: [] });
    groups.get(best.name).sinks.push(s);
  }
  let k = 0;
  return [...groups.values()].map(({ site, net, sinks }) => ({
    net: net.net, name: `${nets[0].name}_${k++}`, type: kind, sources: [site.node], sinks, clock: false, synthetic: true,
    outpins: [{ inst: `XDL_DUMMY_${site.tileName}_${site.name}`, pin }],
    dummy: {
      name: `XDL_DUMMY_${site.tileName}_${site.name}`, type: site.type, placed: true, tile: site.tileName, site: site.name,
      cfg: [{ attr: '_NO_USER_LOGIC', name: '', value: '' }, { attr: kind === 'vcc' ? '_VCC_SOURCE' : '_GND_SOURCE', name: '', value: pin }],
      cfgRaw: `_NO_USER_LOGIC:: ${kind === 'vcc' ? '_VCC_SOURCE' : '_GND_SOURCE'}::${pin} `,
    },
  }));
}

// ------------------------------------------------------------------ checking a routed design
/**
 * Check the routing of a design against the device: every PIP exists, every sink is reached from
 * a source through the net's PIPs, no PIP hangs off the tree (antenna), no node is used by two nets.
 * Returns { ok, nets: count, problems: [strings] }.
 */
export function checkRouting(design, device) {
  const { nets, errors } = netEndpoints(design, device);
  const problems = [...errors];
  const usedBy = new Map();
  for (const n of nets) {
    const pips = n.net.pips;
    if (!n.sinks.length && !pips.length) continue;
    // the net's graph: from-node -> to-nodes (a bidirectional PIP either way: its text does not say)
    const adj = new Map(), nodes = new Set();
    const edge = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); nodes.add(a); nodes.add(b); };
    for (const p of pips) {
      const k = device.tile(p.tile);
      const i = k === undefined ? -1 : device.findPip(k, p.from, p.to);
      if (i < 0) { problems.push(`net ${n.name}: no PIP ${p.tile} ${p.from} ${p.dir} ${p.to}`); continue; }
      const [a, b] = device.pipNodes(k, i);
      edge(a, b);
      if (device.pipIsBidi(k, i)) edge(b, a);
    }
    // walk from the sources; a node of the net reached by the walk but leading to nothing new is an antenna
    const reached = new Set(n.sources), q = [...n.sources], children = new Map();
    while (q.length) {
      const a = q.pop();
      for (const b of adj.get(a) || []) if (!reached.has(b)) { reached.add(b); q.push(b); children.set(a, (children.get(a) || 0) + 1); }
    }
    for (const s of n.sinks) if (!reached.has(s.node)) problems.push(`net ${n.name}: sink ${s.pin.inst}.${s.pin.pin} not reached`);
    const sinkSet = new Set(n.sinks.map(s => s.node));
    for (const a of nodes) {
      if (!reached.has(a)) problems.push(`net ${n.name}: ${device.nodeName(a)} not connected to the source`);
      else if (!children.get(a) && !sinkSet.has(a)) problems.push(`net ${n.name}: ${device.nodeName(a)} leads nowhere (antenna)`);
    }
    for (const a of nodes) {
      const o = usedBy.get(a);
      if (o !== undefined && o !== n.name) problems.push(`node ${device.nodeName(a)} used by ${o} and ${n.name}`);
      else usedBy.set(a, n.name);
    }
  }
  return { ok: problems.length === 0, nets: nets.length, problems };
}
