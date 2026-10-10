// Silinx - XDL writer (browser + Node): a design in the shape parseXdl (core/xdl.js) returns,
// written back as XDL text that ISE's `xdl -xdl2ncd` reads and parseXdl reads back unchanged.
//
//   writeXdl({ name, part, cfg?, insts: [{ name, type, placed, tile, site, cfg: [{ attr, name, value }] }],
//              nets: [{ name, type, outpins: [{ inst, pin }], inpins: [...], pips: [{ tile, from, dir, to }] }] })
//
// inst / net names are quoted ("…", with \" and \\ escaped); inside a cfg string the names of
// the elements have ':' and '\' escaped with '\' (as ISE writes them), spaces are not allowed.

const q = s => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

/** One cfg item as text: attr:name:value (name already escaped as the cfg syntax needs). */
export function cfgItem({ attr, name = '', value = '' }) {
  return `${attr}:${name}:${value}`;
}

/** Escape a name for use inside a cfg string (':' and '\' escaped, blanks replaced). */
export function cfgName(s) {
  return String(s).replace(/\s/g, '_').replace(/([:\\"])/g, '\\$1');
}

export function writeXdl(d) {
  const out = [];
  out.push(`# Written by Silinx (core/fpga/xdl-write.js)`);
  out.push(`design ${q(d.name || 'top')} ${d.part}${d.ncdVersion ? ` ${d.ncdVersion}` : ' v3.2'} ,`);
  // the design's cfg is raw XDL text (its fields keep their '\' escapes): only quotes are escaped
  out.push(`  cfg "${String(d.cfg || '').replace(/"/g, '\\"')}";`);
  out.push('');
  for (const i of d.insts) {
    const place = i.placed ? `placed ${i.tile} ${i.site}` : 'unplaced';
    const items = (i.cfg || []).map(cfgItem);
    // a few items per line, as ISE does (the parser does not care)
    const lines = [];
    for (let k = 0; k < items.length; k += 4) lines.push(items.slice(k, k + 4).join(' '));
    out.push(`inst ${q(i.name)} ${q(i.type)},${place}  ,`);
    out.push(`  cfg " ${lines.join('\n       ').replace(/"/g, '\\"')} "`);
    out.push('  ;');
  }
  out.push('');
  for (const n of d.nets) {
    const type = n.type && n.type !== 'wire' ? ` ${n.type}` : '';
    out.push(`net ${q(n.name)}${type}, `);
    for (const p of n.outpins || []) out.push(`  outpin ${q(p.inst)} ${p.pin} ,`);
    for (const p of n.inpins || []) out.push(`  inpin ${q(p.inst)} ${p.pin} ,`);
    for (const p of n.pips || []) out.push(`  pip ${p.tile} ${p.from} ${p.dir || '->'} ${p.to} , `);
    out.push('  ;');
  }
  out.push('');
  return out.join('\n');
}
