// Open synthesis of a Silinx project (or of plain HDL files) into Yosys's JSON netlist: Silinx's front
// end (core/synth-verilog.js) writes the elaborated design as one flat Verilog module, Yosys maps it
// onto Spartan-3E cells (synth_xilinx -family xc3se -ise -flatten) and writes it as JSON (the input of
// core/fpga/netlist.js) and as Verilog (for simulation against the design).
//
//   node synth.mjs <project folder | file.v/.vhd ...> <top> <out folder>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compile, elaborate } from '../../core/compile.js';
import { primitiveSources } from '../../core/unisim.js';
import { toVerilog } from '../../core/synth-verilog.js';

const args = process.argv.slice(2);
const out = path.resolve(args.pop());
const top = args.pop();
let files = [];
for (const a of args) {
  if (fs.statSync(a).isDirectory()) {
    const proj = JSON.parse(fs.readFileSync(path.join(a, 'silinx.json'), 'utf8'));
    for (const f of proj.files) if (f.role === 'design') files.push(path.join(a, f.path));
  } else files.push(a);
}
const srcs = files.map(f => ({ path: path.basename(f), lang: /\.vhdl?$/i.test(f) ? 'vhdl' : 'verilog', text: fs.readFileSync(f, 'utf8') }));
const lib = compile([...primitiveSources(srcs), ...srcs]);
const d = elaborate(lib, top);
const errs = [...lib.errors, ...d.diags].filter(x => x.severity !== 'warning');
if (errs.length) throw new Error(errs.slice(0, 5).map(e => `${e.file}:${e.line} ${e.message}`).join('\n'));
const { text } = toVerilog(d);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${top}_syn.v`), text);
const t0 = Date.now();
execFileSync('yosys', ['-q', '-p', `read_verilog -sv ${top}_syn.v; synth_xilinx -family xc3se -ise -flatten -top ${d.top.name}; delete t:$scopeinfo; write_json ${top}.json; write_edif -pvector bra ${top}.edf; write_verilog -noattr ${top}_ys.v; stat`], { cwd: out, stdio: ['ignore', 'inherit', 'inherit'] });
console.log(`${top}: ${Date.now() - t0} ms Yosys -> ${out}/${top}.json`);
