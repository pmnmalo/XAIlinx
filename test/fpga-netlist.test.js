// Yosys's JSON netlist as the packer reads it (core/fpga/netlist.js). The fixtures in
// test/fixtures/fpga/*.json are small designs (research/s3e-place/designs) synthesized by Yosys
// (synth_xilinx -family xc3se), regenerated with research/s3e-place/fixtures.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readYosysJson, paramBits, paramInt } from '../core/fpga/netlist.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fpga');
const load = n => readYosysJson(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));

test('parameters: binary strings, most significant bit first', () => {
  assert.deepEqual(paramBits('0110'), [0, 1, 1, 0].reverse());
  assert.deepEqual(paramBits('1x'), [0, 1]);
  assert.equal(paramBits('LVCMOS33'), null);
  assert.equal(paramInt('00000000000000000000000000000101'), 5);
  assert.equal(paramInt(undefined, 7), 7);
  assert.equal(paramInt(3), 3);
});

test('ports: one entry per bit, named as UCF names them', () => {
  const nl = load('counter');
  assert.equal(nl.name, 'counter');
  const q = nl.ports.find(p => p.name === 'q');
  assert.equal(q.dir, 'out');
  assert.deepEqual(q.bits.map(b => b.name), ['q<0>', 'q<1>', 'q<2>', 'q<3>', 'q<4>', 'q<5>', 'q<6>', 'q<7>']);
  const clk = nl.ports.find(p => p.name === 'clk');
  assert.deepEqual(clk.bits.map(b => b.name), ['clk']);
  assert.equal(nl.nets[clk.bits[0].net].port, 'clk');
});

test('cells, nets, drivers and loads refer to each other', () => {
  const nl = load('counter');
  const types = {};
  for (const c of nl.cells) types[c.type] = (types[c.type] || 0) + 1;
  assert.deepEqual(types, { LUT4: 8, INV: 1, MUXCY: 11, XORCY: 8, BUFG: 1, FDRE: 8, IBUF: 11, OBUF: 9 });
  // the two constants
  assert.equal(nl.nets[0].const, 0);
  assert.equal(nl.nets[1].const, 1);
  for (const [ci, c] of nl.cells.entries()) {
    for (const [pin, n] of Object.entries(c.pins)) {
      const net = nl.nets[n];
      if (c.dirs[pin] === 'output') assert.deepEqual(net.driver, { cell: ci, pin });
      else assert.ok(net.loads.some(l => l.cell === ci && l.pin === pin), `${c.name}.${pin} not a load of ${net.name}`);
    }
  }
  // every flip-flop has its INIT, every LUT its INIT of 2^k bits
  for (const c of nl.cells) {
    if (/^LUT(\d)$/.test(c.type)) assert.equal(paramBits(c.params.INIT).length, 1 << +c.type[3], c.name);
    if (c.type === 'FDRE') assert.equal(paramInt(c.params.INIT), 0);
  }
  // the carry chain starts with the constant 0
  const first = nl.cells.find(c => c.type === 'MUXCY' && c.pins.CI === 0 && c.pins.DI === 1);
  assert.ok(first, 'the counter chain: CI = 0, DI = 1');
});

test('a module is chosen: the one marked top, or the only one that is not a black box', () => {
  const j = JSON.parse(fs.readFileSync(path.join(FIX, 'sw.json'), 'utf8'));
  j.modules.LUT1 = { attributes: { blackbox: '00000000000000000000000000000001' }, ports: {}, cells: {}, netnames: {} };
  delete j.modules.sw.attributes;
  assert.equal(readYosysJson(j).name, 'sw');
  j.modules.other = { ports: {}, cells: {}, netnames: {} };
  assert.throws(() => readYosysJson(j), /which top module/);
  assert.equal(readYosysJson(j, { top: 'sw' }).name, 'sw');
  assert.throws(() => readYosysJson(j, { top: 'nope' }), /no module 'nope'/);
});

test('constant outputs and undriven bits', () => {
  const nl = load('sw');
  const one = nl.ports.find(p => p.name === 'one');
  // 'one' is driven through an OBUF whose input is the constant 1
  const obuf = nl.cells.find(c => c.type === 'OBUF' && c.pins.O === one.bits[0].net);
  assert.equal(obuf.pins.I, 1);
  // a bit 'x' reads as the constant 0
  const j = { modules: { m: { attributes: { top: '1' }, ports: { y: { direction: 'output', bits: [2] } },
    cells: { b: { type: 'OBUF', port_directions: { I: 'input', O: 'output' }, connections: { I: ['x'], O: [2] } } }, netnames: {} } } };
  assert.equal(readYosysJson(j).cells[0].pins.I, 0);
});
