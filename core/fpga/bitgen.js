// Silinx - bitstream generation for the Spartan-3E XC3S250E (browser + Node): a placed and routed
// design (XDL, core/xdl.js parseXdl) -> frame data -> a .bit file.
//
// The configuration is the sum of the design's features. A feature belongs to a tile of the device
// and sets a few bits at fixed positions relative to the tile (its column of frames and its row of
// bits): a routing switch (PIP) of a net, a setting of a site (slice, IOB, global buffer), and the
// contents of a LUT. The positions come from the bit database (research/s3e-bitstream/db/*.json),
// built by observing which bits ISE's bitgen sets for small test designs (docs/OPEN-TOOLCHAIN.md).
//
//   const db = makeDb({ layout, lut, tiles, pads })    the JSON files of the database; pads from
//                                                      padsFromDevice(the user's device cache)
//   const { bytes, unknown } = bitgen(xdlText, db, { name: 'top.ncd', crc: true })
//
// `unknown` lists the features of the design that the database does not know (their bits are not
// set), so a caller can tell whether the bitstream is complete.
import { parseXdl, lutTable } from '../xdl.js';
import { XC3S250E, writeBit, setBit } from './bitstream.js';

/**
 * The I/O sites of the package's pins: pad name -> [tile, index of the pad among the I/O sites of
 * its tile (IOB, IBUF, DIFFM/DIFFS…, bonded or not)], so that an IOB's settings can be stored once
 * per tile type (features IOB<index>:…). It comes from the device (core/fpga/device.js, built on the
 * user's machine from their ISE's device report), never from the committed database.
 */
export function padsFromDevice(device) {
  const pads = {};
  for (const [site, [t, k]] of device.siteIndex) {
    const types = device.templates[device.tileTemplate[t]].sites.map(s => s.type);
    if (!/^(IOB|IBUF|DIFF[MS]I?)$/.test(types[k]) || device.tileSites[t][k][1] !== 1) continue;   // bonded pads
    pads[site] = [device.tileNames[t], types.slice(0, k).filter(x => /^(IOB|IBUF|DIFF[MS]I?)$/.test(x)).length];
  }
  return pads;
}

/** Join the database files (and the pads of the device) into one object with fast lookups. */
export function makeDb({ layout, lut, tiles, pads = {} }) {
  const types = {};
  for (const [type, t] of Object.entries(tiles.types || {})) {
    const feats = new Map();
    for (const [f, bits] of Object.entries(t.features || {})) feats.set(f, bits);
    types[type] = { ...t, feats };
  }
  // a tile type may share the features of another (same switch box), at an offset of its frames and
  // bits (`shift: [df, db]`: the switch box of an I/O tile is the CLB's, 2 frames later in the
  // left column, 16 bits further in the top row); its own features, measured on it, come first
  const own = new Map(Object.entries(types).map(([k, t]) => [k, t.feats]));
  for (const t of Object.values(types)) {
    const src = t.sameAs && own.get(t.sameAs);
    if (!src) continue;
    const [sf, sb] = t.shift || [0, 0];
    const shifted = sf || sb ? [...src].map(([f, bits]) => [f, bits.map(s => shiftBit(s, sf, sb))]) : [...src];
    t.shared = new Map(shifted);
    t.feats = new Map([...shifted, ...t.feats]);
    // the wires of the type's own sites may have other names than the shared type's (the I/O
    // tile's IOIS_X0, IOIS_F1_B0… are the CLB's X0, F1_B0…): `rename: [[regexp, replacement], …]`
    t.rename = (t.rename || []).map(([re, to]) => [new RegExp(re, 'g'), to]);
  }
  return { layout, lut, tiles, types, pads, padFeats: tiles.padFeatures || {} };
}

/** The bits of a feature of a tile type (undefined when the database does not know it). */
export function featureBits(type, feature) {
  if (!type) return undefined;
  const bits = type.feats.get(feature);
  if (bits || !type.rename?.length) return bits;
  let f = feature;
  for (const [re, to] of type.rename) f = f.replace(re, to);
  return f === feature ? undefined : type.shared.get(f);
}

/** The type and the X / Y of a tile from its name (CLB_X3Y5 -> CENTER_SMALL… / 3 / 5). */
export function tileOf(name, db) {
  const m = /^(.*)_X(\d+)Y(\d+)$/.exec(name);
  if (!m) return null;
  let type = m[1];
  const x = +m[2], y = +m[3];
  if (type === 'CLB') type = (db.layout.brkRows || []).includes(y) ? 'CENTER_SMALL_BRK' : 'CENTER_SMALL';
  return { name, type, x, y };
}

/** Frame and bit where a tile starts: { frame, bit } (null when the layout does not know it). */
export function tileBase(tile, db) {
  const L = db.layout;
  const cols = (L.typeCols && L.typeCols[tile.type]) || L.cols;
  const rows = (L.typeRows && L.typeRows[tile.type]) || L.rows;
  const frame = cols[tile.x], bit = rows[tile.y];
  return frame === undefined || bit === undefined ? null : { frame, bit };
}

// "df,db" (bit set to 1) or "!df,db" (bit cleared) -> [df, db, value, dx, dy]; "df,db@dx,dy": the bit
// is in the column / row of the tile dx, dy away (an I/O tile also configures its pads with bits in
// the neighbouring tile's frames)
export const parseBit = s => {
  const v = s[0] === '!' ? 0 : 1;
  const [pos, nb] = s.replace('!', '').split('@');
  const [df, db] = pos.split(',').map(Number);
  const [dx, dy] = nb ? nb.split(',').map(Number) : [0, 0];
  return [df, db, v, dx, dy];
};

/** A bit of the database ("df,db", "!df,db", "df,db@dx,dy") moved by sf frames and sb bits. */
export const shiftBit = (s, sf, sb) => {
  const [df, db, v, dx, dy] = parseBit(s);
  return `${v ? '' : '!'}${df + sf},${db + sb}${dx || dy ? `@${dx},${dy}` : ''}`;
};

/** The features of a design: [{ tile: name, feature }] plus the LUT contents [{ site, lut: 'F' | 'G', bits }].
 *  A PIP is a feature only on a net with pins (bitgen does not program the routing of a net without
 *  pins). Site settings are `${site kind}${index}:${attr}:${value}` (value '' for a named element). */
export function designFeatures(design, db) {
  const feats = [], luts = [];
  for (const inst of design.insts) {
    if (!inst.placed) continue;
    const kind = siteKind(inst, db);
    if (!kind) continue;
    // the site is used: some settings are set for every used site
    feats.push({ tile: inst.tile, feature: `${kind}:USED` });
    // a SLICEM site holds an instance of type SLICEM or SLICEL: as a SLICEM it sets 2 bits more
    // (feature SLICEk:SLICEM)
    if (inst.type === 'SLICEM') feats.push({ tile: inst.tile, feature: `${kind}:SLICEM` });
    // an I/O: its direction and I/O standard together ('O:LVCMOS33'), a feature of the pad itself
    // (tile '@M5'): the pads do not repeat one pattern per tile type, so their bits are absolute
    if (/^IOB\d/.test(kind)) {
      const has = a => inst.cfg.some(c => c.attr === a && c.value !== '#OFF');
      const mode = has('OUTBUF') ? (has('INBUF') ? 'IO' : 'O') : 'I';
      const std = (inst.cfg.find(c => c.attr === 'IOATTRBOX') || {}).value || 'NONE';
      feats.push({ tile: `@${inst.site}`, feature: `${mode}:${std}` });
    }
    // a LUT not used in a used slice holds the constant 0 (written like any LUT: 16 ones, inverted);
    // a LUT used while the path after it (the X / Y output, or the flip-flop through DXMUX / DYMUX
    // = 1) is not used: bitgen sets the output multiplexer (FXMUX, GYMUX) to all ones (feature
    // SLICEk:FXMUX:#OFF)
    const val = a => (inst.cfg.find(c => c.attr === a) || {}).value;
    const on = a => { const v = val(a); return v !== undefined && v !== '#OFF'; };
    if (/^SLICE/.test(kind)) for (const [l, mux, out, ff, dmux] of [['F', 'FXMUX', 'XUSED', 'FFX', 'DXMUX'], ['G', 'GYMUX', 'YUSED', 'FFY', 'DYMUX']]) {
      if (!inst.cfg.some(c => c.attr === l && /^#(LUT|ROM|RAM):/.test(c.value))) luts.push({ site: inst.site, lut: l, bits: new Array(16).fill(0), kind: 'OFF' });
      else if (!on(out) && !(on(ff) && val(dmux) === '1')) feats.push({ tile: inst.tile, feature: `${kind}:${mux}:#OFF` });
    }
    // flip-flops without a clock enable: the enable is on (feature SLICEk:CEINV:#OFF)
    if (/^SLICE/.test(kind) && (on('FFX') || on('FFY')) && !on('CEINV')) feats.push({ tile: inst.tile, feature: `${kind}:CEINV:#OFF` });
    for (const c of inst.cfg) {
      // underscore settings are notes of the tools, except the constant sources (_GND_SOURCE::Y)
      if (c.value === '#OFF' || (c.attr.startsWith('_') && !/^_(GND|VCC)_SOURCE$/.test(c.attr))) continue;
      if ((c.attr === 'F' || c.attr === 'G') && /^#(LUT|ROM|RAM):/.test(c.value)) {
        const eq = c.value.replace(/^#\w+:/, '');
        luts.push({ site: inst.site, lut: c.attr, bits: lutTable(eq, 4).bits, kind: c.value.slice(1, 4) });
        feats.push({ tile: inst.tile, feature: `${kind}:${c.attr}:${c.value.slice(0, 4)}` });
        continue;
      }
      feats.push({ tile: inst.tile, feature: `${kind}:${c.attr}:${c.name && !c.value ? '' : c.value}` });
    }
  }
  for (const net of design.nets) {
    if (!net.outpins.length && !net.inpins.length) continue;
    const names = pipFeatures(net);
    net.pips.forEach((p, i) => feats.push({ tile: p.tile, feature: names[i] }));
  }
  return { feats, luts };
}

/** The feature names of a net's PIPs: "from->to". A bidirectional PIP (XDL "a =- b") is used in one
 *  direction, the one away from the wire that another PIP of the net drives: "a->b" (or "b->a");
 *  it stays "a=-b" when the net does not tell. */
export function pipFeatures(net) {
  const driven = new Set(net.pips.filter(p => p.dir !== '=-').map(p => `${p.tile}:${p.to}`));
  return net.pips.map(p => {
    if (p.dir !== '=-') return `${p.from}->${p.to}`;
    if (driven.has(`${p.tile}:${p.from}`)) return `${p.from}->${p.to}`;
    if (driven.has(`${p.tile}:${p.to}`)) return `${p.to}->${p.from}`;
    return `${p.from}=-${p.to}`;
  });
}

/** The kind and index of a site inside its tile: SLICE0…3 (by the parity of X and Y), IOB0…2
 *  (the pads of a tile, from the database), or the site type for single-site tiles. */
export function siteKind(inst, db) {
  const m = /^SLICE_X(\d+)Y(\d+)$/.exec(inst.site || '');
  if (m) return `SLICE${(+m[1] & 1) * 2 + (+m[2] & 1)}`;
  if (inst.type === 'IOB' || inst.type === 'IBUF' || /^DIFF/.test(inst.type)) {
    const p = db.pads[inst.site];
    return p ? `IOB${p[1]}` : null;
  }
  if (inst.type === 'VCC' || inst.type === 'GND' || inst.type === 'TIEOFF') return null;
  // global clock buffers: their tiles (CLKB, CLKT, CLKL, CLKR) have one instance each, so the site
  // name says which buffer it is
  if (/^BUFGMUX_/.test(inst.site || '')) return inst.site;
  return inst.type;
}

/** The frame data of a design: { frames, unknown: [{ tile, feature }] }. */
export function frameData(design, db, device = XC3S250E) {
  const fw = device.frameWords;
  const frames = new Uint32Array(device.frames * fw);
  for (const [f, b] of db.layout.defaults || []) setBit(frames, fw, f, b, 1);
  const { feats, luts } = designFeatures(design, db);
  const unknown = [];
  const seen = new Set();
  const clears = [];   // bits a feature clears are cleared after all the bits are set
  for (const { tile, feature } of feats) {
    if (tile[0] === '@') {
      // a pad's own feature: absolute positions
      const bits = db.padFeats[tile.slice(1)]?.[feature];
      if (!bits) { const k = `${tile} ${feature}`; if (!seen.has(k)) { seen.add(k); unknown.push({ tile, feature }); } continue; }
      for (const s of bits) { const [f, b, v] = parseBit(s); if (v) setBit(frames, fw, f, b, 1); else clears.push([f, b]); }
      continue;
    }
    const t = tileOf(tile, db);
    const base = t && tileBase(t, db);
    const type = t && db.types[t.type];
    const bits = featureBits(type, feature);
    if (!base || !bits) {
      const k = `${tile} ${feature}`;
      if (!seen.has(k)) { seen.add(k); unknown.push({ tile, feature }); }
      continue;
    }
    for (const s of bits) {
      const [df, dbit, v, dx, dy] = parseBit(s);
      const b = dx || dy ? tileBase({ ...t, x: t.x + dx, y: t.y + dy }, db) : base;
      if (!b) continue;
      if (v) setBit(frames, fw, b.frame + df, b.bit + dbit, 1); else clears.push([b.frame + df, b.bit + dbit]);
    }
  }
  for (const [f, b] of clears) setBit(frames, fw, f, b, 0);
  // LUT contents: 16 bits from the LUT's first bit, in address order, stored inverted (LUT G: the
  // 16 bits before LUT F)
  for (const { site, lut, bits } of luts) {
    const m = /^SLICE_X(\d+)Y(\d+)$/.exec(site);
    const frame = db.lut.colFrame[m[1]], start = db.lut.rowBit[m[2]] - (lut === 'G' ? 16 : 0);
    for (let a = 0; a < 16; a++) setBit(frames, fw, frame, start + a, bits[a] ? 0 : 1);
  }
  return { frames, unknown };
}

/** A .bit file for a placed and routed design: { bytes (Uint8Array), unknown }. design: XDL text or
 *  a parseXdl() result. opts: name (the design file name in the header, default `${design}.ncd`),
 *  date, time, crc (default true), startupClk. */
export function bitgen(design, db, opts = {}) {
  const d = typeof design === 'string' ? parseXdl(design) : design;
  const { frames, unknown } = frameData(d, db);
  const bytes = writeBit({ frames, name: opts.name || `${d.name || 'design'}.ncd`, ...opts });
  return { bytes, unknown };
}
