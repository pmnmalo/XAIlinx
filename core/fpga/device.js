// Silinx - the routing graph of an FPGA, from the device report of Xilinx's xdl (browser + Node).
//
//   xdl -report -pips -all_conns xc3s250ecp132-4 dev-full.xdlrc
//
// The report lists, tile by tile: the sites of the tile and the tile wire each site pin is attached
// to (pinwire), every wire of the tile with the wires of other tiles it is joined to by metal
// (conn), and every programmable switch of the tile (pip: from-wire -> to-wire). For the
// XC3S250E it is about 200 MB of text: 1419 tiles, 569 094 tile wires, 2 139 368 PIPs.
//
// Most tiles of a kind are identical (all 576 CLBs have the same wires and PIPs), so the graph
// is stored as a few dozen tile *templates* (wires, PIPs, site pins, by local index) plus, for
// each tile, its template, position and site names. What differs from tile to tile is how the
// wires join across tiles; that is stored as the list of *nodes* (sets of tile wires joined by
// metal). Packed this way the graph is a few MB, small enough for the browser.
//
// The device description comes from the user's own ISE installation and is never committed to
// the repository (docs/OPEN-TOOLCHAIN.md, open legal question): each user builds the cache once
// (core/fpga/device-node.js, Node only).
//
// Vocabulary used below:
//   tile          index into the tile arrays (row-major order of the report)
//   local wire    index of a wire inside its tile's template
//   wire id       global index of one tile wire: tileWireBase[tile] + local wire
//   node          a set of wire ids joined by metal; the unit the router works on
//   pip index     index of a PIP inside its tile's template

/** Version of the packed format: bumped when it changes (old caches are rebuilt). */
export const DEVICE_FORMAT_VERSION = 1;

/** PIP flags in the packed templates. */
export const PIP_BIDI = 1;          // '=-' in the report: one direction of a bidirectional switch (buffered both ways)
export const PIP_ROUTETHRU = 2;     // a path through a site (a LUT, the carry chain, a BUFGMUX): not a plain switch

// ------------------------------------------------------------------ small helpers (no Node APIs)
// growable Int32 array
class IntVec {
  constructor(n = 1024) { this.a = new Int32Array(n); this.n = 0; }
  push(x) { if (this.n === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = x; }
  view() { return this.a.subarray(0, this.n); }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;

/** bytes -> base64 (both directions written here so core/ needs neither Buffer nor btoa). */
export function toBase64(bytes) {
  let s = '';
  const parts = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (s.length > 65536) { parts.push(s); s = ''; }
  }
  if (i < bytes.length) {
    const v = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8);
    s += B64[v >> 18] + B64[(v >> 12) & 63] + (i + 1 < bytes.length ? B64[(v >> 6) & 63] : '=') + '=';
  }
  parts.push(s);
  return parts.join('');
}

export function fromBase64(str) {
  const s = String(str).replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64I[s.charCodeAt(i)];
    if (v < 0) throw new Error('bad base64');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out;
}

// unsigned varints (LEB128): the node lists are mostly small deltas
function putVarint(vec, x) { while (x >= 128) { vec.push((x & 127) | 128); x = Math.floor(x / 128); } vec.push(x); }
function bytesOf(vec) { const b = new Uint8Array(vec.n); for (let i = 0; i < vec.n; i++) b[i] = vec.a[i]; return b; }
const u16b64 = arr => toBase64(new Uint8Array(Uint16Array.from(arr).buffer));
const b64u16 = s => { const b = fromBase64(s); return new Uint16Array(b.buffer, b.byteOffset, b.length >> 1); };

// ------------------------------------------------------------------ the report, streamed
/**
 * Builds the packed graph from the lines of the report, fed one at a time (the report is too large
 * to hold as one string): `const b = new DeviceBuilder(); for (line of lines) b.line(line); const packed = b.finish();`
 * Lines after `(primitive_defs` (the site definitions) are ignored.
 */
export class DeviceBuilder {
  constructor() {
    this.part = null; this.family = null; this.rows = 0; this.cols = 0;
    this.names = []; this.nameId = new Map();              // wire names, shared by all templates
    this.rtNames = []; this.rtId = new Map();              // route-through descriptions
    this.templates = []; this.templateKey = new Map();
    this.tileId = new Map();                               // tile name -> tile index (also forward references from conns)
    this.tiles = [];                                       // { name, r, c, type, t, sites: [[name, bonded]] } (null until parsed)
    this.conns = new IntVec(1 << 20);                      // (tile, local, other tile, other wire name id) quads
    this.cur = null; this.done = false;
  }

  nid(name) { let k = this.nameId.get(name); if (k === undefined) { k = this.names.length; this.names.push(name); this.nameId.set(name, k); } return k; }
  tid(name) { let k = this.tileId.get(name); if (k === undefined) { k = this.tiles.length; this.tiles.push(null); this.tileId.set(name, k); } return k; }

  line(raw) {
    if (this.done) return;
    const s = raw.trim();
    if (!s || s[0] === '#') return;
    const c = this.cur;
    // the most frequent lines first: conns, pips, wires
    if (s.startsWith('(conn ')) {
      const m = /^\(conn (\S+) (\S+)\)/.exec(s);
      c.connsTmp.push([c.wireLocal(this, c.lastWire), m[1], m[2]]);
      return;
    }
    if (s.startsWith('(pip ')) {
      const m = /^\(pip \S+ (\S+) (\S+) ([^\s)]+)\)?(?: \((\S+) (\S+)\)\))?/.exec(s);
      let flags = m[2] === '=-' ? PIP_BIDI : m[2] === '->' ? 0 : (() => { throw new Error(`unknown PIP direction ${m[2]}`); })();
      let rt = -1;
      if (m[4]) { flags |= PIP_ROUTETHRU; const d = `${m[4]} ${m[5]}`; rt = this.rtId.get(d); if (rt === undefined) { rt = this.rtNames.length; this.rtNames.push(d); this.rtId.set(d, rt); } }
      c.pips.push(c.wireLocal(this, m[1]), c.wireLocal(this, m[3]), flags, rt);
      return;
    }
    if (s.startsWith('(wire ')) {
      const m = /^\(wire (\S+) (\d+)/.exec(s);
      c.lastWire = m[1];
      c.wireLocal(this, m[1]);
      return;
    }
    if (s.startsWith('(pinwire ')) {
      const m = /^\(pinwire (\S+) (\S+) (\S+)\)/.exec(s);
      c.sites[c.sites.length - 1].pins.push([m[1], m[2] === 'output' ? 'o' : m[2] === 'input' ? 'i' : m[2], c.wireLocal(this, m[3])]);
      return;
    }
    let m;
    if ((m = /^\(tile (\d+) (\d+) (\S+) (\S+)/.exec(s))) {
      const k = this.tid(m[3]);
      this.cur = new TileTmp(k, +m[1], +m[2], m[3], m[4]);
      return;
    }
    if ((m = /^\(primitive_site (\S+) (\S+) (\S+)/.exec(s))) {
      c.sites.push({ name: m[1], type: m[2], bonded: m[3] === 'bonded' ? 1 : m[3] === 'unbonded' ? 2 : 0, pins: [] });
      return;
    }
    if (s.startsWith('(tile_summary')) { this.endTile(); return; }
    if ((m = /^\(xdl_resource_report\s+\S+\s+(\S+)\s+(\S+)/.exec(s))) { this.part = m[1]; this.family = m[2]; return; }
    if ((m = /^\(tiles\s+(\d+)\s+(\d+)/.exec(s))) { this.rows = +m[1]; this.cols = +m[2]; return; }
    if (s.startsWith('(primitive_defs')) { if (this.cur) this.endTile(); this.done = true; }
    // a tile without tile_summary (hand-made fixtures) ends at the next tile or at primitive_defs
  }

  endTile() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    // the template: wires in the order of the report, PIPs, sites with their pins (site names are per tile)
    const wires = c.wires.map(w => this.nid(w));
    const sites = c.sites.map(x => ({ type: x.type, pins: x.pins }));
    const key = `${c.type}|${wires.join(',')}|${c.pips.join(',')}|${JSON.stringify(sites)}`;
    let t = this.templateKey.get(key);
    if (t === undefined) {
      t = this.templates.length;
      this.templates.push({ type: c.type, wires, pips: c.pips, sites });
      this.templateKey.set(key, t);
    }
    this.tiles[c.k] = { name: c.name, r: c.r, c: c.c, type: c.type, t, sites: c.sites.map(x => [x.name, x.bonded]) };
    for (const [local, otherTile, otherWire] of c.connsTmp) {
      this.conns.push(c.k); this.conns.push(local); this.conns.push(this.tid(otherTile)); this.conns.push(this.nid(otherWire));
    }
  }

  /** The packed graph (a plain object, JSON-serializable): see loadDevice() for its use. */
  finish() {
    if (this.cur) this.endTile();
    const T0 = this.tiles.length;
    for (let k = 0; k < T0; k++) if (!this.tiles[k]) throw new Error(`tile ${[...this.tileId].find(e => e[1] === k)[0]} is referenced but not described`);
    // tiles were numbered when first named (a conn can name a tile before it is described):
    // renumber them in the order of the report (row by row)
    const order = this.tiles.map((t, k) => k).sort((a, b) => this.tiles[a].r - this.tiles[b].r || this.tiles[a].c - this.tiles[b].c);
    const renum = new Int32Array(T0);
    order.forEach((k, i) => { renum[k] = i; });
    this.tiles = order.map(k => this.tiles[k]);
    { const q = this.conns.view(); for (let i = 0; i < q.length; i += 4) { q[i] = renum[q[i]]; q[i + 2] = renum[q[i + 2]]; } }
    const T = this.tiles.length;
    // local index of each wire name in each template
    const localOf = this.templates.map(tp => { const m = new Map(); tp.wires.forEach((n, i) => m.set(n, i)); return m; });
    const base = new Int32Array(T + 1);
    for (let k = 0; k < T; k++) base[k + 1] = base[k] + this.templates[this.tiles[k].t].wires.length;
    const W = base[T];
    // nodes: union-find over the conns
    const parent = new Int32Array(W);
    for (let i = 0; i < W; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const q = this.conns.view();
    for (let i = 0; i < q.length; i += 4) {
      const a = base[q[i]] + q[i + 1];
      const lo = localOf[this.tiles[q[i + 2]].t].get(q[i + 3]);
      if (lo === undefined) throw new Error(`conn to unknown wire ${this.names[q[i + 3]]} of tile ${this.tiles[q[i + 2]].name}`);
      const b = base[q[i + 2]] + lo;
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    // multi-wire nodes, each listed from its lowest wire id: varint(first - previous first), varint(count - 2), then deltas
    const members = new Map();
    for (let i = 0; i < W; i++) { const r = find(i); if (r !== i) { let l = members.get(r); if (!l) members.set(r, l = [r]); l.push(i); } }
    const roots = [...members.keys()].sort((a, b) => a - b);
    const vec = new IntVec(1 << 20);
    let prev = 0;
    for (const r of roots) {
      const l = members.get(r);
      putVarint(vec, r - prev); prev = r;
      putVarint(vec, l.length - 2);
      for (let j = 1; j < l.length; j++) putVarint(vec, l[j] - l[j - 1]);
    }
    const pipCount = this.tiles.reduce((n, t) => n + this.templates[t.t].pips.length / 4, 0);
    return {
      format: 'silinx-device', version: DEVICE_FORMAT_VERSION,
      part: this.part, family: this.family, rows: this.rows, cols: this.cols,
      counts: { tiles: T, wires: W, pips: pipCount, nodes: W - [...members.values()].reduce((n, l) => n + l.length - 1, 0), templates: this.templates.length },
      names: this.names,
      routethrus: this.rtNames,
      templates: this.templates.map(tp => ({
        type: tp.type,
        wires: u16b64(tp.wires),
        // from, to, flags, route-through index + 1 (0: none), four uint16 per PIP
        pips: u16b64(tp.pips.map((v, i) => (i % 4 === 3 ? v + 1 : v))),
        sites: tp.sites.map(x => ({ type: x.type, pins: x.pins })),
      })),
      tiles: this.tiles.map(t => [t.name, t.r, t.c, t.t, t.sites]),
      nodes: toBase64(bytesOf(vec)),
    };
  }
}

class TileTmp {
  constructor(k, r, c, name, type) {
    Object.assign(this, { k, r, c, name, type });
    this.wires = []; this.local = new Map(); this.pips = []; this.sites = []; this.connsTmp = []; this.lastWire = null;
  }
  wireLocal(b, name) { let i = this.local.get(name); if (i === undefined) { i = this.wires.length; this.wires.push(name); this.local.set(name, i); } return i; }
}

/** Build the packed graph from report text (for small reports and tests; large ones are streamed line by line). */
export function packDevice(text) {
  const b = new DeviceBuilder();
  for (const l of String(text).split('\n')) b.line(l);
  return b.finish();
}

// ------------------------------------------------------------------ the graph in memory
/**
 * The routing graph from its packed form (the object of packDevice() / DeviceBuilder.finish(), e.g.
 * after JSON.parse of the cache). Returns a Device: see the class below.
 */
export function loadDevice(packed) {
  if (!packed || packed.format !== 'silinx-device') throw new Error('not a Silinx device graph');
  if (packed.version !== DEVICE_FORMAT_VERSION) throw new Error(`device graph format ${packed.version}, expected ${DEVICE_FORMAT_VERSION}: rebuild the cache`);
  return new Device(packed);
}

export class Device {
  constructor(p) {
    this.part = p.part; this.family = p.family; this.rows = p.rows; this.cols = p.cols;
    this.names = p.names;
    this.routethrus = p.routethrus;
    // templates
    this.templates = p.templates.map(tp => {
      const wires = b64u16(tp.wires);
      const raw = b64u16(tp.pips);
      const n = raw.length / 4;
      const from = new Uint16Array(n), to = new Uint16Array(n), flags = new Uint8Array(n), rt = new Int16Array(n);
      for (let i = 0; i < n; i++) { from[i] = raw[4 * i]; to[i] = raw[4 * i + 1]; flags[i] = raw[4 * i + 2]; rt[i] = raw[4 * i + 3] - 1; }
      // PIPs by their text (from, to as written in XDL), before the bidirectional ones are turned round
      const pipIndex = new Map();
      for (let i = 0; i < n; i++) pipIndex.set(from[i] * 65536 + to[i], i);
      // A bidirectional PIP is listed in both orientations ("BX2 =- BY0" and "BY0 =- BX2"), one edge
      // each in the graph. A routed design names it in one orientation only, whatever the direction
      // of the signal (lab11 has "BY0 =- BX2" carrying BX2 to BY0 in one CLB and BY0 to BX2 in
      // another): the wire with the lower number first (BX0 =- BY1, BY0 =- BX2, BX1 =- BY3,
      // BY2 =- BX3, as ISE writes them). textSwap[i]: pip i is written to-first.
      const textSwap = new Uint8Array(n);
      const num = nm => { const m = /(\d+)$/.exec(nm); return m ? +m[1] : -1; };
      for (let i = 0; i < n; i++) if (flags[i] & PIP_BIDI) {
        const a = this.names[wires[from[i]]], b = this.names[wires[to[i]]];
        textSwap[i] = num(b) < num(a) || (num(b) === num(a) && b < a) ? 1 : 0;
      }
      // PIPs by from-wire (CSR), for the downhill search
      const outStart = new Int32Array(wires.length + 1);
      for (let i = 0; i < n; i++) outStart[from[i] + 1]++;
      for (let w = 0; w < wires.length; w++) outStart[w + 1] += outStart[w];
      const fill = outStart.slice(0, wires.length), outPips = new Int32Array(n);
      for (let i = 0; i < n; i++) outPips[fill[from[i]]++] = i;
      const local = new Map();
      wires.forEach((nm, i) => local.set(this.names[nm], i));
      const sites = tp.sites.map(s => ({ type: s.type, pins: new Map(s.pins.map(([pin, dir, w]) => [pin, { dir, wire: w }])) }));
      return { type: tp.type, wires, local, from, to, flags, rt, textSwap, outStart, outPips, pipIndex, sites };
    });
    // tiles
    const T = p.tiles.length;
    this.tileCount = T;
    this.tileNames = new Array(T); this.tileRow = new Int16Array(T); this.tileCol = new Int16Array(T); this.tileTemplate = new Uint16Array(T);
    this.tileSites = new Array(T);
    this.tileIndex = new Map();
    this.siteIndex = new Map();       // site name -> [tile, site index in the tile]
    this.tileWireBase = new Int32Array(T + 1);
    for (let k = 0; k < T; k++) {
      const [name, r, c, t, sites] = p.tiles[k];
      this.tileNames[k] = name; this.tileRow[k] = r; this.tileCol[k] = c; this.tileTemplate[k] = t;
      this.tileSites[k] = sites;
      this.tileIndex.set(name, k);
      sites.forEach(([sn], i) => this.siteIndex.set(sn, [k, i]));
      this.tileWireBase[k + 1] = this.tileWireBase[k] + this.templates[t].wires.length;
    }
    const W = this.wireCount = this.tileWireBase[T];
    // the tile of each wire id
    this.wireTile = new Int32Array(W);
    for (let k = 0; k < T; k++) this.wireTile.fill(k, this.tileWireBase[k], this.tileWireBase[k + 1]);
    // nodes: the packed multi-wire nodes, then one node per remaining wire
    const bytes = fromBase64(p.nodes);
    const nodeOf = new Int32Array(W).fill(-1);
    const starts = new IntVec(1 << 16), mem = new IntVec(W);
    let i = 0, first = 0;
    const rd = () => { let x = 0, mul = 1, b; do { b = bytes[i++]; x += (b & 127) * mul; mul *= 128; } while (b & 128); return x; };
    while (i < bytes.length) {
      first += rd();
      const cnt = rd() + 2;
      const id = starts.n;
      starts.push(mem.n);
      let w = first;
      nodeOf[w] = id; mem.push(w);
      for (let j = 1; j < cnt; j++) { w += rd(); nodeOf[w] = id; mem.push(w); }
    }
    for (let w = 0; w < W; w++) if (nodeOf[w] < 0) { nodeOf[w] = starts.n; starts.push(mem.n); mem.push(w); }
    starts.push(mem.n);
    this.nodeOf = nodeOf;
    this.nodeStart = starts.view().slice();
    this.nodeWires = mem.view().slice();
    this.nodeCount = this.nodeStart.length - 1;
    // bounding box of each node (tile rows / columns), for the router's distance estimate
    const N = this.nodeCount;
    this.nodeR0 = new Int16Array(N); this.nodeR1 = new Int16Array(N); this.nodeC0 = new Int16Array(N); this.nodeC1 = new Int16Array(N);
    for (let n = 0; n < N; n++) {
      let r0 = 1e4, r1 = -1, c0 = 1e4, c1 = -1;
      for (let j = this.nodeStart[n]; j < this.nodeStart[n + 1]; j++) {
        const k = this.wireTile[this.nodeWires[j]], r = this.tileRow[k], c = this.tileCol[k];
        if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c;
      }
      this.nodeR0[n] = r0; this.nodeR1[n] = r1; this.nodeC0[n] = c0; this.nodeC1[n] = c1;
    }
    this.pipCount = 0;
    for (let k = 0; k < T; k++) this.pipCount += this.templates[this.tileTemplate[k]].from.length;
    this.edges = null;
  }

  // ---- tiles and wires
  /** Tile index of a tile name (undefined if unknown). */
  tile(name) { return this.tileIndex.get(name); }
  tileName(k) { return this.tileNames[k]; }
  tileType(k) { return this.templates[this.tileTemplate[k]].type; }
  /** Local index of a wire in a tile (undefined if the tile has no such wire). */
  localWire(k, wireName) { return this.templates[this.tileTemplate[k]].local.get(wireName); }
  /** Wire id of (tile, wire name), or -1. */
  wireId(k, wireName) { const l = this.localWire(k, wireName); return l === undefined ? -1 : this.tileWireBase[k] + l; }
  /** { tile, name } of a wire id. */
  wireInfo(w) { const k = this.wireTile[w]; return { tile: this.tileNames[k], name: this.names[this.templates[this.tileTemplate[k]].wires[w - this.tileWireBase[k]]] }; }

  // ---- nodes
  /** Node of (tile name or index, wire name), or -1. */
  node(tile, wireName) { const k = typeof tile === 'number' ? tile : this.tileIndex.get(tile); if (k === undefined) return -1; const w = this.wireId(k, wireName); return w < 0 ? -1 : this.nodeOf[w]; }
  /** The wire ids of a node. */
  nodeWireIds(n) { return this.nodeWires.subarray(this.nodeStart[n], this.nodeStart[n + 1]); }
  /** The (tile, wire) names of a node: [{ tile, name }]. */
  nodeNames(n) { return Array.from(this.nodeWireIds(n), w => this.wireInfo(w)); }
  /** A readable name: the first wire of the node, "TILE/WIRE". */
  nodeName(n) { const x = this.wireInfo(this.nodeWires[this.nodeStart[n]]); return `${x.tile}/${x.name}`; }

  // ---- sites
  /** { tile (index), tileName, index, type, bonded (0 internal, 1 bonded, 2 unbonded), pins: Map pin -> { dir, wire (local) } } of a site name. */
  site(name) {
    const e = this.siteIndex.get(name);
    if (!e) return null;
    const [k, i] = e;
    const s = this.templates[this.tileTemplate[k]].sites[i];
    return { tile: k, tileName: this.tileNames[k], index: i, name, type: s.type, bonded: this.tileSites[k][i][1], pins: s.pins };
  }
  /** The tile wire a site pin is attached to: { tile (index), tileName, wire (name), wireId, dir ('i' / 'o') }, or null. */
  sitePin(siteName, pin) {
    const s = this.site(siteName);
    const p = s && s.pins.get(pin);
    if (!p) return null;
    const tp = this.templates[this.tileTemplate[s.tile]];
    return { tile: s.tile, tileName: s.tileName, wire: this.names[tp.wires[p.wire]], wireId: this.tileWireBase[s.tile] + p.wire, dir: p.dir };
  }
  /** The routing node of a site pin, or -1. */
  sitePinNode(siteName, pin) { const p = this.sitePin(siteName, pin); return p ? this.nodeOf[p.wireId] : -1; }
  /** All sites: [{ name, tile, type, bonded }] (filter by type for the placer). */
  sites(type = null) {
    const out = [];
    for (let k = 0; k < this.tileCount; k++) {
      const tp = this.templates[this.tileTemplate[k]];
      this.tileSites[k].forEach(([name, bonded], i) => { if (!type || tp.sites[i].type === type) out.push({ name, tile: k, tileName: this.tileNames[k], type: tp.sites[i].type, bonded }); });
    }
    return out;
  }

  // ---- PIPs
  /**
   * PIP `i` of tile `k` as written in XDL: { tile, from, to, dir ('->' or '=-'), routethru (string or null) }.
   * A bidirectional PIP is written in its one usual orientation, whichever way the signal goes.
   */
  pip(k, i) {
    const tp = this.templates[this.tileTemplate[k]];
    const a = this.names[tp.wires[tp.from[i]]], b = this.names[tp.wires[tp.to[i]]];
    const bidi = tp.flags[i] & PIP_BIDI, sw = tp.textSwap[i];
    return { tile: this.tileNames[k], from: sw ? b : a, to: sw ? a : b, dir: bidi ? '=-' : '->', routethru: tp.rt[i] >= 0 ? this.routethrus[tp.rt[i]] : null };
  }
  /** The nodes of PIP i of tile k, in the direction of the signal: [from node, to node]. */
  pipNodes(k, i) {
    const tp = this.templates[this.tileTemplate[k]], b = this.tileWireBase[k];
    return [this.nodeOf[b + tp.from[i]], this.nodeOf[b + tp.to[i]]];
  }
  /** Is PIP i of tile k bidirectional? */
  pipIsBidi(k, i) { return !!(this.templates[this.tileTemplate[k]].flags[i] & PIP_BIDI); }
  /** Index of the PIP written "from <dir> to" in tile k (wire names, XDL text order), or -1. */
  findPip(k, from, to) {
    const tp = this.templates[this.tileTemplate[k]];
    const a = tp.local.get(from), b = tp.local.get(to);
    if (a === undefined || b === undefined) return -1;
    const i = tp.pipIndex.get(a * 65536 + b);
    return i === undefined ? -1 : i;
  }
  /** Calls fn(toNode, tile, pipIndex, flags) for every PIP leaving node n (route-through PIPs included: check the flags). */
  forEachPip(n, fn) {
    for (let j = this.nodeStart[n]; j < this.nodeStart[n + 1]; j++) {
      const w = this.nodeWires[j], k = this.wireTile[w], tp = this.templates[this.tileTemplate[k]], l = w - this.tileWireBase[k];
      for (let q = tp.outStart[l]; q < tp.outStart[l + 1]; q++) {
        const i = tp.outPips[q];
        fn(this.nodeOf[this.tileWireBase[k] + tp.to[i]], k, i, tp.flags[i]);
      }
    }
  }
  /**
   * The node-level graph as flat arrays, built once (about 26 MB for the XC3S250E): the edges leaving
   * node n are edgeStart[n] .. edgeStart[n+1]-1; for each, edgeTo (node), edgeTile, edgePip, edgeFlags.
   */
  routingEdges() {
    if (this.edges) return this.edges;
    const N = this.nodeCount;
    const edgeStart = new Int32Array(N + 1);
    for (let n = 0; n < N; n++) {
      let c = 0;
      for (let j = this.nodeStart[n]; j < this.nodeStart[n + 1]; j++) {
        const w = this.nodeWires[j], k = this.wireTile[w], tp = this.templates[this.tileTemplate[k]], l = w - this.tileWireBase[k];
        c += tp.outStart[l + 1] - tp.outStart[l];
      }
      edgeStart[n + 1] = edgeStart[n] + c;
    }
    const E = edgeStart[N];
    const edgeTo = new Int32Array(E), edgeTile = new Int32Array(E), edgePip = new Int32Array(E), edgeFlags = new Uint8Array(E);
    let e = 0;
    for (let n = 0; n < N; n++) this.forEachPip(n, (to, k, i, f) => { edgeTo[e] = to; edgeTile[e] = k; edgePip[e] = i; edgeFlags[e] = f; e++; });
    return (this.edges = { edgeStart, edgeTo, edgeTile, edgePip, edgeFlags });
  }
}
