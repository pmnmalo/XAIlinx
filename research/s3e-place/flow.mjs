// Silinx's packer and placer on a Yosys JSON netlist: the placed XDL that ISE routes.
//   node flow.mjs <netlist.json> <ucf | -> <device.xdlrc> <out.xdl> [seed] [effort]
import fs from 'node:fs';
import { parseXdlrc, parseXdl } from '../../core/xdl.js';
import { readYosysJson } from '../../core/fpga/netlist.js';
import { pack } from '../../core/fpga/pack.js';
import { deviceSites, place, placedXdl } from '../../core/fpga/place.js';
import { writeXdl } from '../../core/fpga/xdl-write.js';

const [netFile, ucfFile, devFile, outFile, seed = '1', effort = '1', timing = '1'] = process.argv.slice(2);
let t = Date.now();
const nl = readYosysJson(fs.readFileSync(netFile, 'utf8'));
const packed = pack(nl, { ucf: ucfFile && ucfFile !== '-' ? fs.readFileSync(ucfFile, 'utf8') : null });
console.log(`pack: ${Date.now() - t} ms`, JSON.stringify(packed.stats), packed.warnings.length ? packed.warnings : '');
const kinds = {};
for (const m of packed.macros) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
console.log('groups:', JSON.stringify(kinds), 'longest carry chain:', Math.max(0, ...packed.macros.filter(m => m.kind === 'carry').map(m => m.members.length)), 'slices');
t = Date.now();
const dev = deviceSites(parseXdlrc(fs.readFileSync(devFile, 'utf8')));
const r = place(packed, dev, { seed: +seed, effort: +effort, timing: +timing });
console.log(`place: ${Date.now() - t} ms, wirelength ${r.stats.initialCost.toFixed(0)} -> ${r.cost.toFixed(0)}, estimated critical path ${r.stats.initialDelay.toFixed(1)} -> ${r.delay.toFixed(1)}, ${r.stats.temps} temperatures, ${r.stats.moves} moves`);
const text = writeXdl(placedXdl(packed, r));
fs.writeFileSync(outFile, text);
// the writer's output reads back the same
const back = parseXdl(text);
if (back.insts.length !== packed.insts.length || back.nets.length !== packed.nets.length) throw new Error('XDL does not read back');
console.log(`${outFile}: ${back.insts.length} instances, ${back.nets.length} nets`);
