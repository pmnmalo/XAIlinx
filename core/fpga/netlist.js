// Silinx - the netlist of open synthesis, as the packer and placer read it (browser + Node).
//
// Yosys's JSON netlist (write_json after synth_xilinx -family xc3se) names every wire bit with a
// number; a cell's connection is a list of those numbers (or the constants "0" / "1" / "x" / "z").
// readYosysJson turns the top module into plain objects that the packer can walk both ways
// (cell -> nets on its pins, net -> its driver and its loads):
//
//   const nl = readYosysJson(json, { top })
//   nl = { name,
//          ports: [{ name, dir: 'in' | 'out' | 'inout', bits: [{ net, name }] }]   bit names as in UCF: led<3>
//          cells: [{ name, type, params: { INIT: '0110…' (msb first) … }, attrs, pins: { I0: net … }, dirs: { I0: 'input' … } }]
//          nets:  [{ id, name, const: 0 | 1 | undefined, driver: { cell, pin } | null, port: 'name<3>' | null,
//                    loads: [{ cell, pin }] }] }
//   (cells and nets refer to each other by index; nets[0] is the constant 0, nets[1] the constant 1)
//
// Parameters are kept as Yosys writes them: binary strings, most significant bit first (a
// string parameter that looks binary gets a trailing space in Yosys's JSON; it is trimmed).
// paramBits / paramInt read them.

/** The bits of a parameter value, least significant first (x / z read as 0). */
export function paramBits(v) {
  const s = String(v ?? '').trim();
  if (!/^[01xz]+$/i.test(s)) return null;
  return [...s].reverse().map(c => (c === '1' ? 1 : 0));
}

/** A parameter as a number (binary string or number); `dflt` when it is missing. */
export function paramInt(v, dflt = 0) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'number') return v;
  const b = paramBits(v);
  if (!b) return Number.isNaN(+v) ? dflt : +v;
  let n = 0;
  for (let i = b.length - 1; i >= 0; i--) n = n * 2 + b[i];
  return n;
}

/** Pick the top module: the one Yosys marked top, else the only module that is not a black box. */
function topModule(json, top) {
  const mods = json.modules || {};
  if (top) {
    if (!mods[top]) throw new Error(`netlist: no module '${top}'`);
    return [top, mods[top]];
  }
  const real = Object.entries(mods).filter(([, m]) => !paramInt(m.attributes?.blackbox));
  const marked = real.find(([, m]) => paramInt(m.attributes?.top));
  if (marked) return marked;
  if (real.length === 1) return real[0];
  throw new Error(`netlist: which top module? (${real.map(([n]) => n).join(', ') || 'none'})`);
}

/** Read Yosys's JSON netlist (object or text). */
export function readYosysJson(json, { top } = {}) {
  if (typeof json === 'string') json = JSON.parse(json);
  const [name, mod] = topModule(json, top);
  const nets = [
    { id: 0, name: '<const0>', const: 0, driver: null, port: null, loads: [] },
    { id: 1, name: '<const1>', const: 1, driver: null, port: null, loads: [] },
  ];
  const byBit = new Map();
  const netOf = b => {
    // undriven ('x', 'z') inputs are tied to 0, as the FPGA's unused inputs read
    if (typeof b === 'string') return b === '1' ? 1 : 0;
    let k = byBit.get(b);
    if (k === undefined) { k = nets.length; byBit.set(b, k); nets.push({ id: k, name: null, driver: null, port: null, loads: [] }); }
    return k;
  };

  // ports: bit names as UCF writes them (bus bits name<i>, i counted as the HDL declares them)
  const ports = [];
  for (const [pname, p] of Object.entries(mod.ports || {})) {
    const dir = p.direction === 'input' ? 'in' : p.direction === 'output' ? 'out' : 'inout';
    const w = p.bits.length, off = p.offset ?? 0, bus = w > 1 || p.offset !== undefined || p.upto !== undefined;
    const bits = p.bits.map((b, i) => {
      const idx = p.upto ? off + (w - 1 - i) : off + i;
      return { net: netOf(b), name: bus ? `${pname}<${idx}>` : pname };
    });
    ports.push({ name: pname, dir, bits });
    for (const b of bits) if (nets[b.net].const === undefined) nets[b.net].port = b.name;
  }

  // net names: a port bit's name first, then the shortest visible name Yosys kept for that bit
  const named = new Map();
  for (const [nname, n] of Object.entries(mod.netnames || {})) {
    const hidden = n.hide_name ? 1 : 0;
    n.bits.forEach((b, i) => {
      if (typeof b === 'string') return;
      const full = n.bits.length > 1 ? `${nname}<${(n.offset ?? 0) + (n.upto ? n.bits.length - 1 - i : i)}>` : nname;
      const prev = named.get(b);
      if (!prev || hidden < prev.hidden || (hidden === prev.hidden && full.length < prev.name.length)) named.set(b, { name: full, hidden });
    });
  }

  const cells = [];
  for (const [cname, c] of Object.entries(mod.cells || {})) {
    const cell = { name: cname.replace(/^\\/, ''), type: c.type, params: {}, attrs: c.attributes || {}, pins: {}, dirs: c.port_directions || {} };
    for (const [k, v] of Object.entries(c.parameters || {})) cell.params[k] = typeof v === 'string' ? v.replace(/ $/, '') : v;
    const ci = cells.length;
    for (const [pin, bits] of Object.entries(c.connections || {})) {
      // multi-bit pins (block RAMs, multipliers) are named PIN<i>, like the UNISIM ports' bits
      bits.forEach((b, i) => {
        const pn = bits.length > 1 ? `${pin}<${i}>` : pin;
        const k = netOf(b);
        cell.pins[pn] = k;
        if (cell.dirs[pin] === 'output') {
          if (k > 1) {
            if (nets[k].driver) throw new Error(`netlist: net ${nets[k].name} has two drivers (${cells[nets[k].driver.cell].name}, ${cell.name})`);
            nets[k].driver = { cell: ci, pin: pn };
          }
        } else nets[k].loads.push({ cell: ci, pin: pn });
      });
    }
    cells.push(cell);
  }
  // names last: the cells add nets too
  for (const [b, k] of byBit) nets[k].name = nets[k].port || named.get(b)?.name || `n${b}`;
  // nets that only exist as names (not connected to anything) are not needed; their ids stay
  return { name, ports, cells, nets };
}
