// Open synthesis (core/synth-open.js): Silinx's front end + Yosys compiled to WebAssembly (YoWASP),
// here in Node (in the browser the same module runs in a Web Worker: test/ui/synth-open.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, elaborate } from '../core/compile.js';
import { synthesizeOpen, yosysScript, cellCounts, utilization, lineStream, YOSYS_FAMILY } from '../core/synth-open.js';
import { yosysNode } from '../core/synth-open-node.js';
import { readYosysJson } from '../core/fpga/netlist.js';
import { netlistSim } from './fpga-sim.js';

const COUNTER = `library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
entity counter is port (clk, rst, en : in std_logic; q : out std_logic_vector(3 downto 0)); end counter;
architecture rtl of counter is
  signal c : unsigned(3 downto 0) := (others => '0');
begin
  process (clk, rst) begin
    if rst = '1' then c <= (others => '0');
    elsif rising_edge(clk) then if en = '1' then c <= c + 1; end if; end if;
  end process;
  q <= std_logic_vector(c);
end rtl;
`;
const design = (text, top) => elaborate(compile([{ path: 'd.vhd', lang: 'vhdl', text }]), top);

test('the Yosys script and the device families', () => {
  assert.equal(yosysScript('top', 'spartan3e'),
    'read_verilog -sv top_syn.v; synth_xilinx -family xc3se -ise -flatten -top top; delete t:$scopeinfo; write_json top.json; write_verilog -noattr top_yosys.v; tee -q -o top_stat.txt stat');
  assert.match(yosysScript('m', 'spartan6'), /-family xc6s /);
  assert.throws(() => yosysScript('m', 'cyclone'), /no Yosys mapping for the device family 'cyclone'/);
  for (const f of ['spartan3', 'spartan3e', 'spartan3a', 'spartan3adsp', 'spartan6', 'virtex4', 'virtex5', 'virtex6', 'artix7', 'kintex7', 'zynq']) assert.ok(YOSYS_FAMILY[f], f);
});

test('cell counts and utilization of a netlist', () => {
  const json = { modules: { top: { attributes: { top: 1 }, cells: { a: { type: 'LUT4' }, b: { type: 'LUT2' }, c: { type: 'FDCE' }, d: { type: 'MUXF5' }, e: { type: 'IBUF' }, f: { type: 'OBUF' }, g: { type: 'BUFG' }, h: { type: 'XORCY' }, i: { type: 'RAMB16_S9' }, j: { type: 'LDCE' } } } } };
  const c = cellCounts(JSON.stringify(json), 'top');
  assert.deepEqual(c, { LUT4: 1, LUT2: 1, FDCE: 1, MUXF5: 1, IBUF: 1, OBUF: 1, BUFG: 1, XORCY: 1, RAMB16_S9: 1, LDCE: 1 });
  const u = utilization(c);
  assert.deepEqual([u.luts, u.flipFlops, u.latches, u.muxes, u.carry, u.blockRam, u.clockBuffers, u.ios, u.cells], [2, 1, 1, 1, 1, 1, 1, 2, 10]);
});

test('Yosys output split into lines, across chunks', () => {
  const lines = [];
  const feed = lineStream(l => lines.push(l));
  const enc = s => new TextEncoder().encode(s);
  feed(enc('Warning: a\nWar')); feed(enc('ning: b\r\nend')); feed(null);
  assert.deepEqual(lines, ['Warning: a', 'Warning: b', 'end']);
});

test('a counter synthesized by Yosys (WebAssembly) counts like the design', { timeout: 120000 }, async () => {
  const lines = [];
  const r = await synthesizeOpen(design(COUNTER, 'counter'), { family: 'spartan3e', run: yosysNode, onLine: l => lines.push(l) });
  assert.equal(r.top, 'counter');
  assert.deepEqual(Object.keys(r.files), ['counter_syn.v', 'counter.json', 'counter_yosys.v', 'counter_stat.txt']);
  assert.match(r.files['counter_yosys.v'], /module counter/);
  assert.match(r.files['counter_stat.txt'], /cells/);
  assert.equal(r.util.flipFlops, 4);
  assert.equal(r.util.clockBuffers, 1);
  assert.equal(r.util.ios, 3 + 4);   // rst, en, q (the clock goes through its BUFG)
  // the netlist, simulated cell by cell: reset, then count only when enabled
  const sim = netlistSim(readYosysJson(r.files['counter.json']));
  const q = () => { const o = sim.out(); return [0, 1, 2, 3].reduce((n, i) => n | (o[`q<${i}>`] << i), 0); };
  const cycle = (v) => { sim.step({ ...v, clk: 0 }); sim.step({ ...v, clk: 1 }); };
  cycle({ rst: 1, en: 0 });
  assert.equal(q(), 0);
  for (let k = 1; k <= 18; k++) { cycle({ rst: 0, en: 1 }); assert.equal(q(), k % 16, `count ${k}`); }
  cycle({ rst: 0, en: 0 }); cycle({ rst: 0, en: 0 });
  assert.equal(q(), 2);
});

test('a design Yosys cannot map is reported with its messages', { timeout: 120000 }, async () => {
  // a run() that fails like Yosys does on an error
  const run = async (args, files, onLine) => { onLine('ERROR: Module `foo\' referenced in module `top\' is not part of the design.'); throw Object.assign(new Error('Yosys failed (exit code 1)'), { code: 1 }); };
  const lines = [];
  await assert.rejects(synthesizeOpen(design(COUNTER, 'counter'), { run, onLine: l => lines.push(l) }), /Yosys failed \(exit code 1\)/);
  assert.match(lines[0], /^ERROR: Module/);
  // and the real one, on a script error
  await assert.rejects(yosysNode(['-q', '-p', 'read_verilog nofile.v'], {}), /Yosys failed \(exit code 1\)/);
});
