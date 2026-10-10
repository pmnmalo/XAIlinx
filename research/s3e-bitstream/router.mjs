// A small router over the device graph (xdlrc-graph.mjs) for test designs: breadth-first search
// through PIPs (no route-throughs) on free nodes, near a given tile.
export function makeRouter(g, { radius = 3, maxDepth = 7 } = {}) {
  const fromNode = new Float64Array(g.pipCount), toNode = new Float64Array(g.pipCount);
  const outE = new Map(), inE = new Map();
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
  for (let i = 0; i < g.pipCount; i++) {
    if (g.rt[i]) continue;
    const a = g.node(g.pipT[i], g.pipA[i]), b = g.node(g.pipT[i], g.pipB[i]);
    fromNode[i] = a; toNode[i] = b;
    push(outE, a, i); push(inE, b, i);
    if (g.pipBi[i]) { push(outE, b, -i - 1); push(inE, a, -i - 1); }
  }
  // a PIP used backwards (bidirectional) is encoded as -i-1
  const ends = e => (e >= 0 ? [fromNode[e], toNode[e]] : [toNode[-e - 1], fromNode[-e - 1]]);
  const text = e => { const i = e >= 0 ? e : -e - 1; const p = g.pip(i); return e >= 0 ? `pip ${g.tiles[p.t].name} ${p.from} -> ${p.to}` : `pip ${g.tiles[p.t].name} ${p.to} -> ${p.from}`; };
  const used = new Set();
  const tileOfNode = n => Math.floor(n / g.W);
  const near = (t0, n, r) => { const a = g.tiles[t0], b = g.tiles[tileOfNode(n)]; return Math.abs(a.r - b.r) <= r + 1 && Math.abs(a.c - b.c) <= r + 1; };
  /** PIPs from n0 forward to a node in goal (a Map / Set), or backward from n0 to one; null if none. */
  function search(n0, goal, forward, t0, r = radius) {
    if (goal.has(n0)) return [];
    const prev = new Map([[n0, null]]);
    let frontier = [n0];
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const n of frontier) for (const e of (forward ? outE : inE).get(n) || []) {
        const [a, b] = ends(e);
        const m = forward ? b : a;
        if (prev.has(m) || used.has(m) || !near(t0, m, r)) continue;
        prev.set(m, { n, e });
        if (goal.has(m)) {
          const path = [];
          for (let x = m; prev.get(x); x = prev.get(x).n) path.push(prev.get(x).e);
          return forward ? path.reverse() : path;
        }
        next.push(m);
      }
      frontier = next;
    }
    return null;
  }
  const take = path => { for (const e of path) for (const n of ends(e)) used.add(n); };
  const nodesOf = path => { const s = new Set(); for (const e of path) for (const n of ends(e)) s.add(n); return s; };
  // slice pins: sources (X, Y) and sinks (F1-4, G1-4)
  const srcPin = new Map(), sinkPin = new Map();
  for (const [t, tile] of g.tiles.entries()) for (const s of tile.sites) {
    if (s.type !== 'SLICEL' && s.type !== 'SLICEM') continue;
    for (const [pin, { wire }] of Object.entries(s.pins)) {
      const n = g.node(t, wire);
      const info = { site: s.name, type: s.type, tile: tile.name, t, pin };
      if (pin === 'X' || pin === 'Y') srcPin.set(n, info);
      if (/^[FG][1-4]$/.test(pin)) sinkPin.set(n, info);
    }
  }
  return { fromNode, toNode, outE, inE, ends, text, used, search, take, nodesOf, srcPin, sinkPin };
}
