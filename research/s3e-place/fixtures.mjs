// The small netlists of the unit tests (test/fixtures/fpga/*.json): the designs in designs/
// synthesized by Yosys (synth_xilinx -family xc3se -ise -flatten), with Yosys's cell library (the
// black-box modules) removed so the files stay small. Needs `yosys` on PATH.
//   node research/s3e-place/fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, '../../test/fixtures/fpga');
for (const f of fs.readdirSync(path.join(here, 'designs')).filter(f => f.endsWith('.v'))) {
  const top = f.replace(/\.v$/, '');
  const tmp = fs.mkdtempSync('/tmp/silinx-fix-');
  // (run in designs/ so the names Yosys derives from the source file hold no local path)
  execFileSync('yosys', ['-q', '-p', `read_verilog ${f}; synth_xilinx -family xc3se -ise -flatten -top ${top}; delete t:$scopeinfo; write_json ${tmp}/n.json`], { cwd: path.join(here, 'designs'), stdio: ['ignore', 'ignore', 'inherit'] });
  const j = JSON.parse(fs.readFileSync(`${tmp}/n.json`, 'utf8'));
  const mod = j.modules[top];
  // only what readYosysJson uses: ports, cells (type, parameters, directions, connections), names
  const keep = { ports: mod.ports, cells: {}, netnames: {} };
  for (const [n, c] of Object.entries(mod.cells)) keep.cells[n] = { type: c.type, parameters: c.parameters, port_directions: c.port_directions, connections: c.connections };
  for (const [n, x] of Object.entries(mod.netnames)) if (!x.hide_name) keep.netnames[n] = { hide_name: 0, bits: x.bits, ...(x.offset !== undefined ? { offset: x.offset } : {}), ...(x.upto ? { upto: x.upto } : {}) };
  const text = JSON.stringify({ creator: j.creator, modules: { [top]: { attributes: { top: '00000000000000000000000000000001' }, ...keep } } });
  fs.writeFileSync(path.join(out, `${top}.json`), text + '\n');
  const types = {};
  for (const c of Object.values(mod.cells)) types[c.type] = (types[c.type] || 0) + 1;
  console.log(top, text.length, 'bytes', JSON.stringify(types));
  fs.rmSync(tmp, { recursive: true });
}
