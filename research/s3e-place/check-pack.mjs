// The packed design against its netlist, in the small simulators of test/fpga-sim.js (no ISE):
//   node check-pack.mjs net.json [cycles]
import fs from 'node:fs';
import { readYosysJson } from '../../core/fpga/netlist.js';
import { pack } from '../../core/fpga/pack.js';
import { compareSims } from '../../test/fpga-sim.js';
const nl = readYosysJson(fs.readFileSync(process.argv[2], 'utf8'));
const p = pack(nl);
const t = Date.now();
const d = compareSims(nl, p, { cycles: +(process.argv[3] || 300) });
console.log(d ? `DIFFERENT: ${JSON.stringify(d)}` : `same outputs (${Date.now() - t} ms)`, JSON.stringify(p.stats));
