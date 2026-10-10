// Silinx - the implemented design inside the FPGA, from Xilinx XDL (browser + Node).
//
//   xdl -ncd2xdl top.ncd top.xdl         the placed and routed design: every used site (slice, IOB,
//                                        block RAM…) with its configuration, every net with its pins
//                                        and routing switches (PIPs)
//   xdl -report <part> device.xdlrc      the device: its grid of tiles and the sites in each tile
//
// parseXdlrc(text) -> device, parseXdl(text) -> design, fpgaModel(design, device) -> the model
// drawn by web/js/fpgaview.js (Processes ▸ Place & Route ▸ View Implemented Design (FPGA)).

/** The format of fpgaModel(): bumped when it changes (the server's cache of it is rebuilt). */
export const MODEL_VERSION = 2;

// sites that are not drawn: tie-offs, reserved and global-signal pseudo sites
const HIDDEN_SITES = /^(VCC|GND|TIEOFF|GLOBALSIG|RESERVED_\w+|PMV|PCILOGICSE?|BSCAN|CAPTURE|ICAP|STARTUP|JTAGPPC|PMVBRAM|PMVIOB|DNA_PORT|SUSPEND_SYNC|POST_CRC_INTERNAL|SPI_ACCESS|OCT_CALIBRATE|EFUSE_USR|USR_ACCESS\w*|FRAME_ECC|KEY_CLEAR|DCIRESET|CFG_IO_ACCESS|PCIE_\w+|GTP\w*|GTX\w*)$/;

/** The device report (xdl -report, without -pips): { part, family, rows, cols, tiles: [{ r, c, name, type, sites: [{ name, type, bonded }] }] }.
 *  Only the tiles with drawable sites are kept. */
export function parseXdlrc(text) {
  const out = { part: null, family: null, rows: 0, cols: 0, tiles: [] };
  let tile = null;
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    let m;
    if ((m = /^\(xdl_resource_report\s+\S+\s+(\S+)\s+(\S+)/.exec(s))) { out.part = m[1]; out.family = m[2]; continue; }
    if ((m = /^\(tiles\s+(\d+)\s+(\d+)/.exec(s))) { out.rows = +m[1]; out.cols = +m[2]; continue; }
    if ((m = /^\(tile\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(s))) { tile = { r: +m[1], c: +m[2], name: m[3], type: m[4], sites: [] }; out.tiles.push(tile); continue; }
    if ((m = /^\(primitive_site\s+(\S+)\s+(\S+)\s+(\S+)/.exec(s)) && tile) {
      if (!HIDDEN_SITES.test(m[2])) tile.sites.push({ name: m[1], type: m[2], bonded: m[3] === 'bonded' });
      continue;
    }
    if (/^\(primitive_defs\b/.test(s)) break;   // the site definitions are not needed
  }
  out.tiles = out.tiles.filter(t => t.sites.length);
  return out;
}

// ------------------------------------------------------------------ XDL design
// tokens: "quoted strings" (\" escapes), ',' ';' and words
function tokenize(text) {
  const toks = [];
  const src = String(text).split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  const re = /"((?:[^"\\]|\\.)*)"|([,;])|([^\s,;"]+)/g;
  let m;
  while ((m = re.exec(src))) toks.push(m[1] !== undefined ? { s: m[1].replace(/\\(.)/g, '$1'), raw: m[1].replace(/\\"/g, '"') } : m[2] ? { p: m[2] } : { w: m[3] });
  return toks;
}

/** Split a configuration string into { attr, name, value } items ("F:u1/n5:#LUT:D=(A1*A2)").
 *  Colons and spaces inside names are escaped with '\'. */
export function parseCfg(cfg) {
  const items = [];
  for (const raw of String(cfg || '').match(/(?:\\.|\S)+/g) || []) {
    const parts = [];
    let cur = '', esc = false;
    for (const ch of raw) {
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === ':' && parts.length < 2) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    if (parts.length < 3) continue;
    items.push({ attr: parts[0], name: parts[1], value: parts[2] });
  }
  return items;
}

/** The design (xdl -ncd2xdl): { name, part, insts: [{ name, type, placed, tile, site, cfg: [...] }],
 *  nets: [{ name, type, outpins: [{ inst, pin }], inpins: [...], pips: [{ tile, from, dir, to }] }] }. */
export function parseXdl(text) {
  const t = tokenize(text);
  const out = { name: null, part: null, insts: [], nets: [] };
  let i = 0;
  const next = () => t[i++];
  const word = () => { const x = t[i]; if (x && x.w !== undefined) { i++; return x.w; } return null; };
  const str = () => { const x = t[i]; if (x && x.s !== undefined) { i++; return x.s; } return null; };
  // a configuration string keeps its escapes ('\\:' in names) for parseCfg
  const rawStr = () => { const x = t[i]; if (x && x.raw !== undefined) { i++; return x.raw; } return null; };
  const skipTo = () => { while (i < t.length && t[i].p !== ';') i++; i++; };
  while (i < t.length) {
    const tk = next();
    if (tk.w === 'design') {
      out.name = str(); out.part = word();
      while (i < t.length && t[i].p !== ';') { if (t[i].w === 'cfg') { i++; out.cfg = str(); } else i++; }
      i++;
    } else if (tk.w === 'inst') {
      const inst = { name: str(), type: str(), placed: false, tile: null, site: null, cfg: [] };
      if (t[i]?.p === ',') i++;
      const how = word();
      if (how === 'placed') { inst.placed = true; inst.tile = word(); inst.site = word(); }
      while (i < t.length && t[i].p !== ';') {
        if (t[i].w === 'cfg') { i++; inst.cfg = parseCfg(rawStr()); } else if (t[i].w === 'module') { i++; inst.module = str(); } else i++;
      }
      i++;
      out.insts.push(inst);
    } else if (tk.w === 'net') {
      const net = { name: str(), type: 'wire', outpins: [], inpins: [], pips: [] };
      if (t[i]?.w !== undefined && !['outpin', 'inpin', 'pip', 'cfg'].includes(t[i].w)) net.type = word();
      while (i < t.length && t[i].p !== ';') {
        const x = next();
        if (x.w === 'outpin' || x.w === 'inpin') { const inst = str(); const pin = word(); (x.w === 'outpin' ? net.outpins : net.inpins).push({ inst, pin }); }
        else if (x.w === 'pip') { const tile = word(), from = word(), dir = word(), to = word(); net.pips.push({ tile, from, dir, to }); }
        else if (x.w === 'cfg') str();
      }
      i++;
      out.nets.push(net);
    } else if (tk.w === 'module' || tk.w === 'endmodule' || tk.w === 'port') {
      skipTo();   // hard macros: not drawn
    }
  }
  return out;
}

// ------------------------------------------------------------------ the model of the view
const dirOf = name => { const k = String(name).lastIndexOf('/'); return k < 0 ? '' : name.slice(0, k); };
const LUT_ATTR = /^(F|G|[A-D]6?LUT|[A-D]5LUT)$/;   // Spartan-3 F / G; Spartan-6 / Virtex-5+ A6LUT…D5LUT
const FF_ATTR = /^(FFX|FFY|[A-D]FF|[A-D]5FF)$/;

/** A LUT equation with the names of the nets on its inputs: "D=(A1*~A2)" + { A1: 'a', A2: 'b' } -> "a · ¬b". */
export function prettyEquation(eq, inputs = {}) {
  let s = String(eq || '').replace(/^\s*O?\d?=\s*|^D=/, '');
  s = s.replace(/\bA(\d)\b/g, (m, n) => inputs[`A${n}`] || m);
  return s.replace(/~/g, '¬').replace(/\*/g, ' · ').replace(/\+/g, ' + ').replace(/@/g, ' ⊕ ');
}

// ------------------------------------------------------------------ LUT contents
/** Evaluate a LUT equation (XDL syntax: A1..A6, 0 / 1, ~ not, * and, @ xor, + or, parentheses) for
 *  the inputs in `v` ({ A1: 0 | 1, … }). Throws on a malformed equation. */
export function evalLut(eq, v) {
  const s = String(eq).replace(/^\s*\w*=\s*/, '').replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i];
  const atom = () => {
    if (peek() === '~') { i++; return 1 - atom(); }
    if (peek() === '(') { i++; const x = or(); if (s[i++] !== ')') throw new Error(`')' expected in ${eq}`); return x; }
    const m = /^(A[1-6]|[01])/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected '${s.slice(i, i + 4)}' in ${eq}`);
    i += m[0].length;
    return m[0][0] === 'A' ? (v[m[0]] ? 1 : 0) : +m[0];
  };
  const and = () => { let x = atom(); while (peek() === '*') { i++; x &= atom(); } return x; };
  const xor = () => { let x = and(); while (peek() === '@') { i++; x ^= and(); } return x; };
  const or = () => { let x = xor(); while (peek() === '+') { i++; x |= xor(); } return x; };
  const r = or();
  if (i !== s.length) throw new Error(`unexpected '${s.slice(i)}' in ${eq}`);
  return r;
}

/** The contents of a LUT: { inputs: ['A1', 'A3'] (the inputs its equation uses), rows: [{ in: [0, 1], out }],
 *  bits: the 2^size memory bits by address (A1 the least significant), init: their hex value as in
 *  ISE's INIT attribute }. size: 4 for Spartan-3 (16 bits), 6 for Spartan-6 / Virtex-5 and later. */
export function lutTable(eq, size = 4) {
  const used = [...new Set((String(eq).replace(/^\s*\w*=/, '').match(/A[1-6]/g) || []))].sort();
  const bits = [];
  for (let a = 0; a < 1 << size; a++) {
    const v = {};
    for (let k = 1; k <= size; k++) v[`A${k}`] = (a >> (k - 1)) & 1;
    bits.push(evalLut(eq, v));
  }
  const rows = [];
  for (let r = 0; r < 1 << used.length; r++) {
    const v = {};
    used.forEach((a, k) => { v[a] = (r >> (used.length - 1 - k)) & 1; });
    rows.push({ in: used.map(a => v[a]), out: evalLut(eq, v) });
  }
  let init = '';
  for (let a = (1 << size) - 4; a >= 0; a -= 4) init += (bits[a] | (bits[a + 1] << 1) | (bits[a + 2] << 2) | (bits[a + 3] << 3)).toString(16).toUpperCase();
  return { inputs: used, rows, bits, init };
}

/** The site pin of a LUT input (A1..A4 of LUT F -> F1..F4; G -> G1..G4; Spartan-6 A6LUT A1..A6 -> A1..A6). */
const lutPin = (attr, n) => (attr === 'F' || attr === 'G' ? `${attr}${n}` : `${attr[0]}${n}`);

/** Everything the FPGA view draws: the device grid, the used sites with their logic and module, the nets. */
export function fpgaModel(design, device) {
  const insts = [];
  const byName = new Map();
  for (const d of design.insts) {
    const cells = [];
    for (const c of d.cfg) {
      if (!c.name || c.value === '#OFF') continue;
      if (LUT_ATTR.test(c.attr) && /^#(LUT|RAM|ROM)/.test(c.value)) {
        const m = /^#(LUT|RAM|ROM):(.*)$/.exec(c.value);
        cells.push({ bel: c.attr, kind: m[1] === 'LUT' ? 'lut' : m[1].toLowerCase(), name: c.name, eq: m[2] });
      } else if (FF_ATTR.test(c.attr) && /^#(FF|LATCH)/.test(c.value)) {
        cells.push({ bel: c.attr, kind: c.value === '#LATCH' ? 'latch' : 'ff', name: c.name });
      } else if (/^(CYMUX[FG]|XOR[FG]|CARRY4)$/.test(c.attr)) {
        cells.push({ bel: c.attr, kind: 'carry', name: c.name });
      } else if (/^(F5MUX|FXMUX|MUXF[5-8]|F[78]MUX)$/.test(c.attr)) {
        cells.push({ bel: c.attr, kind: 'mux', name: c.name });
      } else if (/^(INBUF|OUTBUF|IFF\d?|OFF\d?|TFF\d?|RAMB\w*|MULT18X18\w*|DSP48\w*|GCLK_BUFFER|BUFG\w*|DCM\w*|PLL\w*)$/.test(c.attr)) {
        cells.push({ bel: c.attr, kind: c.attr.toLowerCase().replace(/\d+$/, '').replace(/^gclk_buffer$/, 'bufg'), name: c.name });
      }
    }
    // FF options of the slice (Spartan-3: FFX_INIT_ATTR:#OFF:INIT0, SYNC_ATTR, *INV)
    // the settings of the site: its internal multiplexers and inverters (DXMUX, FXMUX, CYSELF,
    // CLKINV…), the FF options, the I/O standard…
    const opt = {};
    for (const c of d.cfg) if (!c.name && c.value !== '#OFF' && c.value !== '' && !c.attr.startsWith('_')) opt[c.attr] = c.value;
    // LUTs used only to pass a signal through (route-thru)
    for (const c of d.cfg) if (c.attr === '_BEL_PROP' && /PK_PACKTHRU/.test(c.value)) { const bel = c.name || c.value.split(':')[0]; const lut = cells.find(x => x.kind === 'lut' && x.bel === bel); if (lut) lut.thru = true; }
    // the module of the site: the most common hierarchy path of its logic (the instance name for an IOB)
    // (pads and global buffers belong to the top level; their names are not hierarchy paths)
    const count = new Map();
    for (const c of cells) if (/^(lut|ff|latch|carry|mux|ram|rom|ramb|mult|dsp)/.test(c.kind)) count.set(dirOf(c.name), (count.get(dirOf(c.name)) || 0) + 1);
    let module = /^SLICE/.test(d.type) ? dirOf(d.name) : '';
    if (count.size) module = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const inst = { name: d.name, type: d.type, site: d.site, tile: d.tile, placed: d.placed, module, cells, opt, pins: {} };
    byName.set(d.name, insts.length);
    insts.push(inst);
  }
  const nets = [];
  for (const n of design.nets) {
    if (!n.outpins.length && !n.inpins.length) continue;
    const pin = p => [byName.get(p.inst), p.pin];
    const drv = n.outpins.map(pin).filter(p => p[0] !== undefined);
    const loads = n.inpins.map(pin).filter(p => p[0] !== undefined);
    const power = /^(vcc|gnd|power|ground)$/i.test(n.type);
    const driverType = drv.length ? insts[drv[0][0]].type : '';
    const clock = !power && (/^(BUFGMUX|BUFG|BUFGCTRL|DCM\w*|PLL\w*|BUFIO2)$/.test(driverType) || loads.some(([k, p]) => /^CLK$/.test(p) && insts[k].type !== 'IOB' && /^SLICE|RAMB|MULT|DSP/.test(insts[k].type)) && loads.length > 1);
    const idx = nets.length;
    const tiles = [...new Set(n.pips.map(p => p.tile))];
    nets.push({ name: n.name, kind: power ? 'power' : clock ? 'clock' : 'signal', driver: drv[0] || null, loads, tiles, pips: n.pips.length });
    for (const [k, p] of [...drv, ...loads]) insts[k].pins[p] = idx;
  }
  // the LUT inputs as net names (for the equations), the IOB pads and port directions
  for (const inst of insts) {
    for (const c of inst.cells) if (c.kind === 'lut') {
      const ins = {};
      for (let k = 1; k <= 6; k++) { const ni = inst.pins[lutPin(c.bel, k)]; if (ni !== undefined) ins[`A${k}`] = nets[ni].name; }
      c.inputs = ins;
      c.text = prettyEquation(c.eq, ins);
    }
    if (/^(IOB|IBUF|DIFF[MS]I?|IOBM|IOBS)$/.test(inst.type)) {
      inst.io = {
        pad: inst.site,
        dir: inst.cells.some(c => c.kind === 'outbuf') && inst.cells.some(c => c.kind === 'inbuf') ? 'inout' : inst.cells.some(c => c.kind === 'outbuf') ? 'out' : 'in',
        standard: inst.opt.IOATTRBOX || inst.opt.IOSTANDARD || null,
        drive: inst.opt.DRIVEATTRBOX || null, slew: inst.opt.SLEW || null, pull: inst.opt.PULL || null,
      };
    }
  }
  // utilisation: used sites / sites of the device, per kind
  const kindOf = type => (/^SLICE/.test(type) ? 'Slices' : /^(IOB|IBUF|DIFF[MS]I?|IOBM|IOBS)$/.test(type) ? 'IOBs' : /^RAMB/.test(type) ? 'Block RAMs'
    : /^(MULT18X18\w*|DSP48\w*)$/.test(type) ? 'Multipliers / DSPs' : /^(BUFGMUX|BUFG\w*)$/.test(type) ? 'Global clock buffers' : /^(DCM\w*|PLL\w*)$/.test(type) ? 'DCMs / PLLs' : null);
  const util = {};
  for (const t of device.tiles) for (const s of t.sites) {
    const k = kindOf(s.type);
    if (!k || (k === 'IOBs' && !s.bonded)) continue;
    (util[k] ||= { used: 0, total: 0 }).total++;
  }
  for (const inst of insts) { const k = kindOf(inst.type); if (k && inst.placed && util[k]) util[k].used++; }
  // the modules (hierarchy paths) and how many sites each one uses
  const modules = {};
  for (const inst of insts) if (kindOf(inst.type) && inst.placed) modules[inst.module] = (modules[inst.module] || 0) + 1;
  return {
    design: { name: design.name, part: design.part },
    device: { part: device.part, family: device.family, rows: device.rows, cols: device.cols,
      tiles: device.tiles.map(t => [t.r, t.c, t.name, t.type, t.sites.map(s => [s.name, s.type, s.bonded ? 1 : 0])]) },
    insts, nets, util, modules,
  };
}
