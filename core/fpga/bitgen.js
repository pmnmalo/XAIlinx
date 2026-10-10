// Silinx - bitstream generation for the Spartan-3E XC3S250E (browser + Node): a placed and routed
// design (XDL, core/xdl.js parseXdl) -> frame data -> a .bit file.
//
// The configuration is the sum of the design's features. A feature belongs to a tile of the device
// and sets a few bits at fixed positions relative to the tile (its column of frames and its row of
// bits): a routing switch (PIP) of a net, a setting of a site (slice, IOB, global buffer), and the
// contents of a LUT. The positions come from the bit database (research/s3e-bitstream/db/*.json),
// built by observing which bits ISE's bitgen sets for small test designs (docs/OPEN-TOOLCHAIN.md).
//
//   const db = makeDb({ layout, lut, tiles })          the JSON files of the database
//   const { bytes, unknown } = bitgen(xdlText, db, { name: 'top.ncd', crc: true })
//
// `unknown` lists the features of the design that the database does not know (their bits are not
// set), so a caller can tell whether the bitstream is complete.
import { parseXdl, lutTable } from '../xdl.js';
import { XC3S250E, writeBit, setBit } from './bitstream.js';

/** Join the database files into one object with fast lookups. */
export function makeDb({ layout, lut, tiles }) {
  const types = {};
  for (const [type, t] of Object.entries(tiles.types || {})) {
    const feats = new Map();
    for (const [f, bits] of Object.entries(t.features || {})) feats.set(f, bits);
    types[type] = { ...t, feats };
  }
  // a tile type may share the features of another (same switch box)
  for (const t of Object.values(types)) if (t.sameAs && types[t.sameAs]) t.feats = types[t.sameAs].feats;
  return { layout, lut, tiles, types, pads: tiles.pads || {} };
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

// "df,db" (bit set to 1) or "!df,db" (bit cleared) -> [df, db, value]
const parseBit = s => { const v = s[0] === '!' ? 0 : 1; const [df, db] = s.replace('!', '').split(',').map(Number); return [df, db, v]; };

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
    // a LUT not used in a used slice holds the constant 0 (written like any LUT: 16 ones, inverted)
    if (/^SLICE/.test(kind)) for (const l of ['F', 'G']) {
      if (!inst.cfg.some(c => c.attr === l && /^#(LUT|ROM|RAM):/.test(c.value))) luts.push({ site: inst.site, lut: l, bits: new Array(16).fill(0), kind: 'OFF' });
    }
    for (const c of inst.cfg) {
      if (c.value === '#OFF' || c.attr.startsWith('_')) continue;
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
    for (const p of net.pips) feats.push({ tile: p.tile, feature: `${p.from}${p.dir === '->' ? '->' : p.dir}${p.to}` });
  }
  return { feats, luts };
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
  const s = /(\d+)$/.exec(inst.site || '');
  return `${inst.type}${s && /^BUFGMUX/.test(inst.site) ? s[1] : ''}`;
}

/** The frame data of a design: { frames, unknown: [{ tile, feature }] }. */
export function frameData(design, db, device = XC3S250E) {
  const fw = device.frameWords;
  const frames = new Uint32Array(device.frames * fw);
  for (const [f, b] of db.layout.defaults || []) setBit(frames, fw, f, b, 1);
  const { feats, luts } = designFeatures(design, db);
  const unknown = [];
  const seen = new Set();
  for (const { tile, feature } of feats) {
    const t = tileOf(tile, db);
    const base = t && tileBase(t, db);
    const type = t && db.types[t.type];
    const bits = type && type.feats.get(feature);
    if (!base || !bits) {
      const k = `${tile} ${feature}`;
      if (!seen.has(k)) { seen.add(k); unknown.push({ tile, feature }); }
      continue;
    }
    for (const s of bits) { const [df, dbit, v] = parseBit(s); setBit(frames, fw, base.frame + df, base.bit + dbit, v); }
  }
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
