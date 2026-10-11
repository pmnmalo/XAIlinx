// Differential tests of the open synthesis (test/diff-synth.js): every example project and the
// synthesizable designs of the test fixtures are simulated as RTL by Silinx and as the netlist
// Yosys maps them to (synthesizeOpen, YoWASP), with the same seeded random stimulus, and their
// outputs must be equal at every cycle (X bits of the RTL excepted; see test/diff-synth.js for the
// power-up rule). A difference names the design, the cycle, the inputs and the outputs.
//
// The designs of test/fixtures/designs (block RAMs, DCM, multipliers, latches…) are in
// test/synth-diff-fixtures.test.js (a second file, so that both run in parallel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSynth, stimulus, rng, isReset, activeLow, compareRuns, netlistClocks } from './diff-synth.js';
import { readYosysJson } from '../core/fpga/netlist.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const langOf = f => (/\.(vhd|vhdl)$/i.test(f) ? 'vhdl' : 'verilog');
const src = (...p) => ({ path: p[p.length - 1], lang: langOf(p[p.length - 1]), text: read(...p) });

const expectPass = r => assert.equal(r.status, 'pass', r.report || `${r.name}: ${r.status} at ${r.stage}: ${r.reason}`);

test('stimulus: resets asserted first (active low by name), seeded and reproducible', () => {
  assert.ok(isReset('rst') && isReset('rst_n') && isReset('nrst') && isReset('reset') && isReset('arst') && isReset('clr'));
  assert.ok(!isReset('first') && !isReset('restart') && !isReset('clear_all'));
  assert.ok(activeLow('rst_n') && activeLow('rstn') && activeLow('nreset') && activeLow('rst_b') && !activeLow('rst') && !activeLow('reset'));
  const ins = [{ name: 'rst_n', w: 1 }, { name: 'a', w: 40 }];
  const s1 = stimulus(rng(5), {}, ins, 50), s2 = stimulus(rng(5), {}, ins, 50);
  assert.deepEqual(s1, s2);
  assert.equal(s1[0].rst_n, 0n); assert.equal(s1[1].rst_n, 0n);
  assert.ok(s1.slice(2).filter(v => v.rst_n === 1n).length > 40, 'then mostly released');
  assert.ok(s1.every(v => v.a < 1n << 40n) && new Set(s1.map(v => v.a)).size > 30);
});

test('comparison: X bits of the RTL are not compared, every known bit is', () => {
  const W = [['q', 4]];
  const rtl = [{ q: { v: 0b0101n, x: 0b1000n } }, { q: { v: 0b0001n, x: 0n } }];
  assert.equal(compareRuns(rtl, [{ q: { v: 0b1101n, x: 0n } }, { q: { v: 1n, x: 0n } }], W), null);
  assert.deepEqual(compareRuns(rtl, [{ q: { v: 0b1100n, x: 0n } }, { q: { v: 1n, x: 0n } }], W), { cycle: 0, ports: ['q'] });
  assert.deepEqual(compareRuns(rtl, [{ q: { v: 0b0101n, x: 0n } }, { q: { v: 1n, x: 1n } }], W), { cycle: 1, ports: ['q'] }, 'an X in the netlist where the RTL is known');
  assert.equal(compareRuns(rtl, [{ q: { v: 0n, x: 0n } }, { q: { v: 1n, x: 0n } }], W, 1), null, 'skipped cycles');
});

test('clocks found in the netlist: inputs that reach a clock pin through buffers', () => {
  const json = { modules: { t: { attributes: { top: 1 }, ports: { ck: { direction: 'input', bits: [2] }, d: { direction: 'input', bits: [3] }, q: { direction: 'output', bits: [6] } },
    cells: { i: { type: 'IBUFG', port_directions: { I: 'input', O: 'output' }, connections: { I: [2], O: [4] } },
      b: { type: 'BUFG', port_directions: { I: 'input', O: 'output' }, connections: { I: [4], O: [5] } },
      f: { type: 'FDRE', port_directions: { C: 'input', D: 'input', CE: 'input', R: 'input', Q: 'output' }, connections: { C: [5], D: [3], CE: ['1'], R: ['0'], Q: [6] } } } } } };
  assert.deepEqual(netlistClocks(readYosysJson(json)), ['ck']);
});

test('scripts/fetch-yosys-tests.mjs: the tar reader (ustar names with a prefix, GNU long names, pax paths), a pinned commit', async () => {
  const { untar, YOSYS_TESTS_PIN } = await import('../scripts/fetch-yosys-tests.mjs');
  assert.match(YOSYS_TESTS_PIN.commit, /^[0-9a-f]{40}$/);
  const block = (name, type, data = '', prefix = '') => {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write(type, 156); h.write(prefix, 345);
    const body = Buffer.alloc(Math.ceil(data.length / 512) * 512); body.write(data);
    return Buffer.concat([h, body]);
  };
  const long = `y/${'d'.repeat(120)}.v`;
  const tar = Buffer.concat([block('y/', '5'), block('a.v', '0', 'module a; endmodule', 'y/tests'), block('././@LongLink', 'L', long), block('short', '0', 'x'),
    block('pax', 'x', '20 path=y/tests/p.v\n'), block('ignored', '0', 'p'), Buffer.alloc(1024)]);
  const f = untar(tar);
  assert.deepEqual(f.map(x => [x.name, x.type, x.data.toString()]), [['y/', 'dir', ''], ['y/tests/a.v', 'file', 'module a; endmodule'], [long, 'file', 'x'], ['y/tests/p.v', 'file', 'p']]);
});

test('a mismatch is reported with the design, the cycle, the inputs and the outputs', { timeout: 120000 }, async () => {
  // a run() standing in for Yosys: it returns a netlist whose output is inverted
  const json = JSON.stringify({ modules: { inv: { attributes: { top: 1 }, ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [3] } },
    cells: { b: { type: 'BUF', port_directions: { I: 'input', O: 'output' }, connections: { I: [2], O: [3] } } } } } });
  const run = async () => ({ 'inv.json': json, 'inv_yosys.v': '', 'inv_stat.txt': '' });
  const r = await diffSynth({ name: 'inv', sources: [{ path: 'inv.v', lang: 'verilog', text: 'module inv(input a, output y); assign y = ~a; endmodule' }], top: 'inv', run, sim: { cycles: 20 } });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.mismatch.cycle, 0);
  assert.match(r.report, /^inv: the netlist differs from the RTL at cycle 0 \(engine cells, seed "inv"\)\n {2}inputs {2}a=[01]\n {2}RTL {5}y=[01]\n {2}netlist y=[01]$/);
});

test('a netlist with one wrong LUT is caught (the comparison sees the cells)', { timeout: 120000 }, async () => {
  const { yosysNode } = await import('../core/synth-open-node.js');
  // Yosys, then the INIT of the first 2-input LUT that feeds an output inverted
  const run = async (args, files, onLine) => {
    const out = await yosysNode(args, files, onLine);
    const k = Object.keys(out).find(f => f.endsWith('.json'));
    const json = JSON.parse(out[k]);
    const mod = Object.values(json.modules).find(m => m.attributes?.top);
    const lut = Object.values(mod.cells).find(c => c.type === 'LUT2');
    lut.parameters.INIT = [...lut.parameters.INIT].map(b => (b === '1' ? '0' : '1')).join('');
    out[k] = JSON.stringify(json);
    return out;
  };
  const sources = [{ path: 'm.v', lang: 'verilog', text: 'module m(input [3:0] a, b, output [3:0] y, output z); assign y = a ^ b; assign z = &a; endmodule' }];
  assert.equal((await diffSynth({ name: 'm', sources, top: 'm', sim: { cycles: 40 } })).status, 'pass');
  const r = await diffSynth({ name: 'm', sources, top: 'm', run, sim: { cycles: 40 } });
  assert.equal(r.status, 'mismatch', r.reason);
});

// Regressions of core/synth-verilog.js found on Yosys's test designs (asicworld gray_counter,
// simple/signedexpr.v, simple/partsel.v, simple/defvalue.sv): Yosys 0.68 sized an xor of size
// casts inside a concatenation at the casts' operand width; {a + b} of signed operands is
// unsigned; a part-select starting below bit 0 keeps its bits in range; an unconnected input with a
// default value and an output variable with an initializer.
test('synthesis front end: concatenations of casts, {signed}, negative part-select bases, port defaults', { timeout: 120000 }, async () => {
  const text = `module sub(input clk, input [3:0] d = 10, output logic [3:0] q = 2); always @(posedge clk) q <= q + d; endmodule
module top(input clk, input rst, input en, input signed [1:0] a, input signed [2:0] b, input [31:0] din, input signed [4:0] n,
    output [7:0] gray, output [3:0] ys, output reg [31:0] dout, output [3:0] q);
  reg [7:0] count;
  always @(posedge clk) if (rst) count <= 0; else if (en) count <= count + 1;
  assign gray = {count[7], count[7] ^ count[6], count[6] ^ count[5], count[5] ^ count[4], count[4] ^ count[3], count[3] ^ count[2], count[2] ^ count[1], count[1] ^ count[0]};
  assign ys = {a + b} + 3'sd0;
  always @* begin dout = 0; dout[n + 1 +: 2] = din[n +: 2]; end
  sub s(.clk(clk), .q(q));
endmodule`;
  const r = await diffSynth({ name: 'syn', sources: [{ path: 'syn.v', lang: 'verilog', text }], top: 'top', sim: { cycles: 120 }, powerUp: true });
  expectPass(r);
});

test('example projects: RTL and Yosys netlist agree', { timeout: 600000 }, async (t) => {
  for (const name of fs.readdirSync(path.join(ROOT, 'examples')).sort()) {
    const pj = path.join('examples', name, 'silinx.json');
    if (!fs.existsSync(path.join(ROOT, pj))) continue;
    const proj = JSON.parse(read(pj));
    await t.test(name, async () => {
      const sources = proj.files.filter(f => f.role !== 'sim').map(f => ({ path: f.path, lang: f.lang, text: read('examples', name, f.path) }));
      expectPass(await diffSynth({ name, sources, top: proj.top, sim: { cycles: 300 } }));
    });
  }
});

test('test fixtures: VHDL and Verilog designs agree with their netlists', { timeout: 600000 }, async (t) => {
  const vhd = ['util_pkg.vhd', 'counter.vhd', 'reg_n.vhd', 'fsm.vhd', 'seg7.vhd', 'top.vhd'].map(f => src('test', 'fixtures', 'vhdl', f));
  const cases = [
    ['vhdl/top (generate, package, hierarchy)', vhd, 'top'],
    ['vhdl/seq_detect', vhd, 'seq_detect'],
    ['vhdl/seg7', vhd, 'seg7'],
    ['vhdl/counter', vhd, 'counter'],
    ['verilog/counter_top', [src('test', 'fixtures', 'verilog', 'counter_top.v')], 'top'],
  ];
  for (const [name, sources, top] of cases) {
    await t.test(name, async () => {
      const r = await diffSynth({ name, sources, top, sim: { cycles: 300 } });
      expectPass(r);
      assert.ok(r.states > 1, `${name}: the outputs change (${r.states} states)`);
    });
  }
});
