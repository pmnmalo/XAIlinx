// Print the cells of a Yosys JSON netlist with their connections: node show-net.mjs net.json [type regex]
import fs from 'node:fs';
import { readYosysJson } from '../../core/fpga/netlist.js';
const nl = readYosysJson(fs.readFileSync(process.argv[2], 'utf8'));
const re = new RegExp(process.argv[3] || '.');
const nn = k => nl.nets[k].name;
for (const c of nl.cells) if (re.test(c.type)) {
  const drv = Object.entries(c.pins).map(([p, k]) => `${p}=${nn(k)}${c.dirs[p.replace(/<\d+>$/, '')] !== 'output' && nl.nets[k].driver ? `(${nl.cells[nl.nets[k].driver.cell].type})` : ''}`);
  console.log(c.type, c.name.slice(-30), JSON.stringify(c.params), drv.join(' '));
}
