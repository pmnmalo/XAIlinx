// Pack a Yosys JSON netlist and print the result: node try-pack.mjs net.json [ucf]
import fs from 'node:fs';
import { readYosysJson } from '../../core/fpga/netlist.js';
import { pack } from '../../core/fpga/pack.js';
const nl = readYosysJson(fs.readFileSync(process.argv[2], 'utf8'));
const p = pack(nl, { ucf: process.argv[3] ? fs.readFileSync(process.argv[3], 'utf8') : null });
console.log(JSON.stringify(p.stats), p.warnings);
console.log(p.macros.map(m => `${m.kind}:${m.members.length}`).join(' '));
if (process.env.V) {
  for (const i of p.insts) console.log(i.name, i.type, i.loc || '', i.cfg.map(c => `${c.attr}:${c.name}:${c.value}`).join(' '));
  for (const n of p.nets) console.log('net', n.name, n.type, n.outpins.map(x => `${p.insts[x.inst].name}.${x.pin}`).join(','), '->', n.inpins.map(x => `${p.insts[x.inst].name}.${x.pin}`).join(','));
}
