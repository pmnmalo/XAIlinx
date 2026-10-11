// core/xdl.js: the implemented design inside the FPGA from XDL (xdl -ncd2xdl) and the device report
// (xdl -report), for View Implemented Design (FPGA). Fixtures: test/fixtures/fpga (hand-made, in the
// format of ISE 14.7's xdl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXdl, parseXdlrc, parseCfg, prettyEquation, fpgaModel, evalLut, lutTable, writeXdl } from '../core/xdl.js';
import * as ise from '../server/ise.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fpga');
const XDL = fs.readFileSync(path.join(FIX, 'top.xdl'), 'utf8');
const XDLRC = fs.readFileSync(path.join(FIX, 'device.xdlrc'), 'utf8');

test('parseXdlrc: part, grid size, tiles with their drawable sites (tie-offs, reserved and global sites left out)', () => {
  const d = parseXdlrc(XDLRC);
  assert.equal(d.part, 'xc3s50etq144-4');
  assert.equal(d.family, 'spartan3e');
  assert.deepEqual([d.rows, d.cols], [4, 5]);
  assert.deepEqual(d.tiles.map(t => t.name), ['TIOIS_X1Y3', 'CLKT_X2Y3', 'CLB_X1Y2', 'CLB_X2Y2', 'BRAMSITE2_X2Y1', 'LIOIS_X0Y0'], 'the empty corner is dropped');
  const clb = d.tiles.find(t => t.name === 'CLB_X1Y2');
  assert.deepEqual([clb.r, clb.c, clb.type], [1, 1, 'CENTER_SMALL']);
  assert.deepEqual(clb.sites.map(s => s.name), ['SLICE_X0Y4', 'SLICE_X0Y5', 'SLICE_X1Y4', 'SLICE_X1Y5'], 'RESERVED_LL is hidden');
  assert.deepEqual(d.tiles.find(t => t.name === 'CLKT_X2Y3').sites.map(s => s.type), ['BUFGMUX'], 'GLOBALSIG is hidden');
  assert.deepEqual(d.tiles[0].sites.map(s => s.bonded), [true, true, false]);
});

test('parseCfg: attribute, logical name and value; escaped colons and spaces; values with colons', () => {
  assert.deepEqual(parseCfg(' F:u1/n5:#LUT:D=(A1*A2) FFX::#OFF  IOATTRBOX::LVCMOS33 '), [
    { attr: 'F', name: 'u1/n5', value: '#LUT:D=(A1*A2)' },
    { attr: 'FFX', name: '', value: '#OFF' },
    { attr: 'IOATTRBOX', name: '', value: 'LVCMOS33' },
  ]);
  assert.deepEqual(parseCfg('F:bus<3\\:0>\\ x:#LUT:D=A1'), [{ attr: 'F', name: 'bus<3:0> x', value: '#LUT:D=A1' }]);
  assert.deepEqual(parseCfg('NOCOLON'), []);
  assert.deepEqual(parseCfg(''), []);
});

test('parseXdl: design header, placed and unplaced instances with their configuration, nets with pins and PIPs', () => {
  const d = parseXdl(XDL);
  assert.deepEqual([d.name, d.part], ['top', 'xc3s50etq144-4']);
  assert.deepEqual(d.insts.map(i => [i.name, i.type, i.placed, i.site]), [
    ['a', 'IOB', true, 'P1'], ['y', 'IOB', true, 'P2'], ['clk', 'IBUF', true, 'P4'], ['clk_BUFGP/BUFG', 'BUFGMUX', true, 'BUFGMUX_X1Y10'],
    ['u1/q', 'SLICEL', true, 'SLICE_X1Y5'], ['u1/r', 'SLICEM', true, 'SLICE_X0Y4'], ['y_and', 'SLICEL', true, 'SLICE_X3Y4'], ['u1/unplaced', 'SLICEL', false, null],
  ]);
  assert.equal(d.insts[4].tile, 'CLB_X1Y2');
  assert.deepEqual(d.insts[4].cfg.find(c => c.attr === 'F'), { attr: 'F', name: 'u1/q_next', value: '#LUT:D=(A1*~A2)' });
  const clk = d.nets.find(n => n.name === 'clk_BUFGP');
  assert.deepEqual(clk.outpins, [{ inst: 'clk_BUFGP/BUFG', pin: 'O' }]);
  assert.deepEqual(clk.inpins.map(p => p.pin), ['CLK', 'CLK']);
  assert.deepEqual(clk.pips[1], { tile: 'CLB_X1Y2', from: 'GCLK0', dir: '->', to: 'CLK_B0' });
  assert.equal(d.nets.find(n => n.name === 'a_IBUF').pips[0].dir, '=>');
  assert.equal(d.nets.find(n => n.name === 'GLOBAL_LOGIC1').type, 'vcc');
  assert.equal(d.nets.find(n => n.name === 'unused_net').inpins.length, 0);
});

test('prettyEquation: LUT inputs replaced by signal names, logic operators readable', () => {
  assert.equal(prettyEquation('D=(A1*~A2)', { A1: 'a', A2: 'q' }), '(a · ¬q)');
  assert.equal(prettyEquation('D=((A1+A3)@A4)', { A1: 'x' }), '((x + A3) ⊕ A4)');
  assert.equal(prettyEquation('O6=(A1*A2)', {}), '(A1 · A2)', 'Spartan-6 / Virtex-5 output name');
});

test('fpgaModel: sites with their logic, module of each site, nets (clock / power / signal), LUT inputs as signal names, I/O pads, utilisation', () => {
  const m = fpgaModel(parseXdl(XDL), parseXdlrc(XDLRC));
  assert.equal(m.device.part, 'xc3s50etq144-4');
  assert.deepEqual(m.device.tiles.find(t => t[2] === 'CLB_X1Y2').slice(0, 4), [1, 1, 'CLB_X1Y2', 'CENTER_SMALL']);
  const q = m.insts.find(i => i.name === 'u1/q');
  assert.equal(q.module, 'u1');
  assert.deepEqual(q.cells.map(c => [c.bel, c.kind, c.name]), [['F', 'lut', 'u1/q_next'], ['FFX', 'ff', 'u1/q'], ['XORF', 'carry', 'u1/Madd_cnt_xor<0>'], ['CYMUXF', 'carry', 'u1/Madd_cnt_cy<0>']]);
  const lut = q.cells[0];
  assert.deepEqual(lut.inputs, { A1: 'a_IBUF', A2: 'u1/q' }, 'F1 / F2 of the slice');
  assert.equal(lut.text, '(a_IBUF · ¬u1/q)');
  assert.deepEqual(q.opt, { FFX_INIT_ATTR: 'INIT1', FFX_SR_ATTR: 'SRLOW', SYNC_ATTR: 'ASYNC', CLKINV: 'CLK' });
  assert.equal(m.nets[q.pins.CLK].name, 'clk_BUFGP');
  // G LUT -> G1..G4; the XOR operator
  const r = m.insts.find(i => i.name === 'u1/r');
  assert.deepEqual(r.cells[0].inputs, { A1: 'u1/q', A2: 'GLOBAL_LOGIC1' });
  assert.equal(r.cells[0].text, '(u1/q ⊕ GLOBAL_LOGIC1)');
  // a site of the top level; muxes
  const y = m.insts.find(i => i.name === 'y_and');
  assert.equal(y.module, '');
  assert.deepEqual(y.cells.map(c => c.kind), ['lut', 'mux']);
  // pads, buffers: top level, with their I/O settings
  const a = m.insts.find(i => i.name === 'a');
  assert.equal(a.module, '');
  assert.deepEqual(a.io, { pad: 'P1', dir: 'in', standard: 'LVCMOS33', drive: null, slew: null, pull: 'PULLUP' });
  assert.deepEqual(m.insts.find(i => i.name === 'y').io, { pad: 'P2', dir: 'out', standard: 'LVCMOS33', drive: '12', slew: 'SLOW', pull: null });
  assert.equal(m.insts.find(i => i.name === 'clk_BUFGP/BUFG').module, '');
  assert.deepEqual(m.insts.find(i => i.name === 'clk_BUFGP/BUFG').cells.map(c => c.kind), ['bufg']);
  // nets: kinds, driver / loads, routing tiles; empty nets dropped
  const byName = Object.fromEntries(m.nets.map(n => [n.name, n]));
  assert.equal(byName.clk_BUFGP.kind, 'clock');
  assert.deepEqual(byName.clk_BUFGP.tiles, ['CLKT_X2Y3', 'CLB_X1Y2']);
  assert.equal(byName.clk_BUFGP.pips, 2);
  assert.equal(byName.GLOBAL_LOGIC1.kind, 'power');
  assert.equal(byName.GLOBAL_LOGIC1.driver, null, 'the XDL dummy driver is not a site');
  assert.equal(byName.a_IBUF.kind, 'signal');
  assert.deepEqual(byName.a_IBUF.loads.map(([k, p]) => [m.insts[k].name, p]), [['u1/q', 'F1'], ['y_and', 'F1']]);
  assert.equal(m.insts[byName.y_OBUF.driver[0]].name, 'y_and');
  assert.equal(byName.unused_net, undefined);
  // utilisation (bonded IOBs only) and modules
  assert.deepEqual(m.util, {
    IOBs: { used: 3, total: 4 }, 'Global clock buffers': { used: 1, total: 1 }, Slices: { used: 3, total: 8 },
    'Block RAMs': { used: 0, total: 1 }, 'Multipliers / DSPs': { used: 0, total: 1 },
  });
  assert.deepEqual(m.modules, { '': 5, u1: 2 }, 'placed sites only');
  assert.equal(m.insts.find(i => i.name === 'u1/unplaced').placed, false);
});

test('run.sh: the fpgaview step converts the routed design to XDL and reports the device once', () => {
  assert.ok(ise.ALL_STEPS.includes('fpgaview'));
  assert.deepEqual(ise.normalizeSteps(['xdl']), ['fpgaview']);
  assert.ok(!ise.STEPS.includes('fpgaview'), 'not part of the default flow');
  const sh = ise.generateRunSh({ top: 'top', device: { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' }, hasUcf: true });
  assert.match(sh, /if has fpgaview; then/);
  assert.match(sh, /\[ -s top\.ncd \] \|\| \{ echo "=== SILINX STEP fpgaview ==="; echo "ERROR: top\.ncd not found: run Place & Route first"/);
  assert.match(sh, /run_step fpgaview xdl -ncd2xdl top\.ncd top\.xdl/);
  assert.match(sh, /grep -q ' xc3s250ecp132-4 '/, 'the report of another device is replaced');
  assert.match(sh, /run_step fpgadevice xdl -report xc3s250ecp132-4 device\.xdlrc/);
});

test('evalLut: XDL LUT equations (not, and, xor, or with their precedence, constants, parentheses)', () => {
  const v = (a1, a2, a3 = 0, a4 = 0) => ({ A1: a1, A2: a2, A3: a3, A4: a4 });
  assert.equal(evalLut('D=(A1*~A2)', v(1, 0)), 1);
  assert.equal(evalLut('D=(A1*~A2)', v(1, 1)), 0);
  assert.equal(evalLut('D=A1+A2*A3', v(0, 1, 0)), 0, '* before +');
  assert.equal(evalLut('D=A1+A2*A3', v(1, 0, 0)), 1);
  assert.equal(evalLut('D=A1@A2*A3', v(1, 1, 0)), 1, '* before @');
  assert.equal(evalLut('D=A1@A2+A3', v(1, 1, 1)), 1, '@ before +');
  assert.equal(evalLut('D=~(A1+A2)', v(0, 0)), 1);
  assert.equal(evalLut('D=1', v(0, 0)), 1);
  assert.equal(evalLut('O6=(A6*A1)', { A1: 1, A6: 1 }), 1, 'Spartan-6 output name and inputs');
  assert.throws(() => evalLut('D=(A1*A2', v(1, 1)), /'\)' expected/);
  assert.throws(() => evalLut('D=A1#A2', v(1, 1)), /unexpected/);
});

test('lutTable: the inputs used, the truth table rows, the memory bits and the INIT value of the LUT', () => {
  const t = lutTable('D=(A1*~A2)');
  assert.deepEqual(t.inputs, ['A1', 'A2']);
  assert.deepEqual(t.rows, [{ in: [0, 0], out: 0 }, { in: [0, 1], out: 0 }, { in: [1, 0], out: 1 }, { in: [1, 1], out: 0 }]);
  assert.equal(t.bits.length, 16);
  assert.deepEqual(t.bits.slice(0, 4), [0, 1, 0, 0], 'address = A4 A3 A2 A1 in binary');
  assert.equal(t.init, '2222');
  // values ISE writes for well-known functions
  assert.equal(lutTable('D=A3').init, 'F0F0');
  assert.equal(lutTable('D=~A1').init, '5555');
  assert.equal(lutTable('D=(A1*A2*A3*A4)').init, '8000');
  assert.equal(lutTable('D=(A1@A2)').init, '6666');
  assert.equal(lutTable('D=1').init, 'FFFF');
  assert.deepEqual(lutTable('D=1').inputs, []);
  // a 6-input LUT: 64 bits
  const t6 = lutTable('O6=(A1*A6)', 6);
  assert.equal(t6.bits.length, 64);
  assert.equal(t6.init, 'AAAAAAAA00000000');
});

test('fpgaModel keeps the settings of a site (internal multiplexers, inverters) and marks route-thru LUTs', () => {
  const m = fpgaModel(parseXdl(`inst "s" "SLICEL",placed CLB_X1Y2 SLICE_X1Y4 ,
  cfg " F:s/f:#LUT:D=A2 G::#OFF DXMUX::1 FXMUX::F CYINIT::BX _BEL_PROP::F:PK_PACKTHRU: BXINV::BX "
  ;`), parseXdlrc(XDLRC));
  const s = m.insts[0];
  assert.deepEqual(s.opt, { DXMUX: '1', FXMUX: 'F', CYINIT: 'BX', BXINV: 'BX' });
  assert.equal(s.cells[0].thru, true);
});

test('writeXdl: the one XDL writer, for designs built by the packer / placer (no raw text) too', () => {
  const d = {
    name: 'top', part: 'xc3s250ecp132-4', ncdVersion: 'v3.2', comment: 'Written by Silinx\nsecond line',
    cfg: '_DESIGN_PROP::PIN_INFO:a:/top/PACKED/top/a/a/PAD:IN:0:a\\:0',   // raw XDL: its '\:' kept
    insts: [{ name: 'p "1"', type: 'IBUF', placed: true, tile: 'BIOIS_X1Y0', site: 'P11', cfg: [{ attr: 'IOATTRBOX', name: '', value: 'LVCMOS33' }, { attr: 'F', name: 'a:b', value: '#LUT:D=A1' }] }],
    nets: [{ name: 'n', type: 'wire', outpins: [{ inst: 'p "1"', pin: 'I' }], pips: [{ tile: 'CLB_X1Y1', from: 'X0', to: 'OMUX0' }] }, { name: 'gnd', type: 'gnd' }],
  };
  const text = writeXdl(d);
  assert.match(text, /^# Written by Silinx\n# second line\ndesign "top" xc3s250ecp132-4 v3.2 ,\n {2}cfg "_DESIGN_PROP::PIN_INFO:a:\/top\/PACKED\/top\/a\/a\/PAD:IN:0:a\\:0";/);
  assert.match(text, /inst "p \\"1\\"" "IBUF",placed BIOIS_X1Y0 P11 {2},\n {2}cfg " IOATTRBOX::LVCMOS33 F:a\\:b:#LUT:D=A1 "/);
  assert.match(text, /pip CLB_X1Y1 X0 -> OMUX0 ,/);   // the default direction
  // read back unchanged
  const back = parseXdl(text);
  assert.equal(back.insts[0].name, 'p "1"');
  assert.deepEqual(back.insts[0].cfg.map(c => [c.attr, c.name, c.value]), [['IOATTRBOX', '', 'LVCMOS33'], ['F', 'a:b', '#LUT:D=A1']]);
  assert.equal(back.cfgRaw, d.cfg);
  assert.deepEqual(back.nets.map(n => [n.name, n.type, n.pips.length]), [['n', 'wire', 1], ['gnd', 'gnd', 0]]);
});
