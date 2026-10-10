// The packer (core/fpga/pack.js) on small Yosys netlists (test/fixtures/fpga/*.json): the slices
// and their XDL settings, the shapes the placer must keep, and - the main check - the packed
// design simulated from its own XDL settings behaves like the netlist (test/fpga-sim.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readYosysJson } from '../core/fpga/netlist.js';
import { pack, PackError, WIDE_MUX } from '../core/fpga/pack.js';
import { compareSims } from './fpga-sim.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fpga');
const load = n => readYosysJson(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));
const cfgOf = inst => Object.fromEntries(inst.cfg.map(c => [c.attr, c]));
const val = (inst, a) => cfgOf(inst)[a]?.value;

for (const [name, cycles] of [['sw', 50], ['counter', 600], ['ffs', 400], ['widemux', 300], ['mux64', 150], ['latches', 600]]) {
  test(`packed ${name} behaves like its netlist (random stimulus, ${cycles} cycles)`, () => {
    const nl = load(name);
    const p = pack(nl);
    const d = compareSims(nl, p, { cycles, seed: 7 });
    assert.equal(d, null, d && `first difference at cycle ${d.cycle} (clk ${d.clk}): netlist ${JSON.stringify(d.netlist)} packed ${JSON.stringify(d.packed)}`);
  });
}

test('pads: IBUF / IOB instances named after the ports, settings from the UCF', () => {
  const ucf = 'NET "sw" LOC = "P11" | IOSTANDARD = LVCMOS33 | PULLDOWN;\nNET "led" LOC = "M5" | IOSTANDARD = LVCMOS33 | DRIVE = 8 | SLEW = FAST;';
  const p = pack(load('sw'), { ucf });
  const sw = p.insts.find(i => i.name === 'sw'), led = p.insts.find(i => i.name === 'led'), one = p.insts.find(i => i.name === 'one');
  assert.equal(sw.type, 'IBUF');
  assert.equal(sw.loc, 'P11');
  assert.deepEqual([val(sw, 'IOATTRBOX'), val(sw, 'IMUX'), val(sw, 'PULL')], ['LVCMOS33', '1', 'PULLDOWN']);
  assert.equal(cfgOf(sw).PAD.name, 'sw');
  assert.equal(led.type, 'IOB');
  assert.deepEqual([val(led, 'IOATTRBOX'), val(led, 'DRIVEATTRBOX'), val(led, 'SLEW'), val(led, 'OMUX')], ['LVCMOS33', '8', 'FAST', 'O1']);
  // without constraints: ISE's defaults
  assert.deepEqual([one.loc, val(one, 'IOATTRBOX'), val(one, 'DRIVEATTRBOX'), val(one, 'SLEW')], [null, 'LVCMOS25', '12', 'SLOW']);
  // the switch drives the LED straight from pad to pad; the constant output comes from a vcc net
  const k = i => p.insts.indexOf(i);
  const n = p.nets.find(x => x.outpins[0]?.inst === k(sw));
  assert.deepEqual(n.inpins, [{ inst: k(led), pin: 'O1' }]);
  const vcc = p.nets.find(x => x.type === 'vcc');
  assert.deepEqual(vcc.inpins, [{ inst: k(one), pin: 'O1' }]);
  assert.equal(vcc.outpins.length, 0);
});

test('counter: carry chains as vertical groups, flip-flops in the slices of their sums', () => {
  const p = pack(load('counter'), { ucf: null });
  assert.equal(p.stats.slices, 9);
  const chains = p.macros.filter(m => m.kind === 'carry');
  assert.equal(chains.length, 2);
  for (const m of chains) m.members.forEach((x, k) => assert.deepEqual([x.dx, x.dy], [0, k]));
  // the 8-bit counter: 4 slices, 2 sum bits and their 2 flip-flops in each
  const cnt = chains.find(m => m.members.length === 4);
  const sl = cnt.members.map(x => p.insts[x.inst]);
  for (const s of sl) {
    assert.equal(val(s, 'FFX'), '#FF');
    assert.equal(val(s, 'FFY'), '#FF');
    assert.deepEqual([val(s, 'FXMUX'), val(s, 'GYMUX'), val(s, 'DXMUX'), val(s, 'DYMUX')], ['FXOR', 'GXOR', '1', '1']);
    // synchronous reset and clock enable shared by the two flip-flops
    assert.deepEqual([val(s, 'SYNC_ATTR'), val(s, 'SRINV'), val(s, 'CEINV'), val(s, 'CLKINV')], ['SYNC', 'SR', 'CE', 'CLK']);
  }
  // the chain starts from the constant 0 through BX; the next slices from CIN
  assert.equal(val(sl[0], 'CYINIT'), 'BX');
  for (const s of sl.slice(1)) assert.equal(val(s, 'CYINIT'), 'CIN');
  const k = sl.map(s => p.insts.indexOf(s));
  const gnd = p.nets.find(n => n.type === 'gnd');
  assert.ok(gnd.inpins.some(x => x.inst === k[0] && x.pin === 'BX'));
  for (let j = 1; j < 4; j++) {
    const link = p.nets.find(n => n.outpins[0]?.inst === k[j - 1] && n.outpins[0].pin === 'COUT');
    assert.deepEqual(link.inpins, [{ inst: k[j], pin: 'CIN' }]);
    assert.equal(val(p.insts[k[j - 1]], 'COUTUSED'), '0');
  }
  // the constant carry inputs: CY0F 1 at bit 0 with its VCC element, 0 elsewhere with a GND one
  assert.equal(val(sl[0], 'CY0F'), '1');
  assert.ok(cfgOf(sl[0]).C1VDD);
  assert.equal(val(sl[1], 'CY0F'), '0');
  assert.ok(cfgOf(sl[1]).GNDF);
  // the comparator: its DI is not an input of the stage's LUT and the LUT is full, so a first
  // stage of its own brings the carry in (LUT F = 0, CY0F = the constant), DI comes through BY
  const cmp = chains.find(m => m.members.length === 3).members.map(x => p.insts[x.inst]);
  assert.match(val(cmp[0], 'F'), /^#LUT:D=0$/);
  assert.equal(val(cmp[0], 'CY0G'), 'BY');
  // its result leaves the chain through XB
  assert.equal(val(cmp[2], 'XBUSED'), '0');
});

test('carryOut xor: a carry out read by logic leaves through an XOR stage (LUT 0) and X / Y, never XB / YB', () => {
  const nl = load('counter');
  const p = pack(nl, { carryOut: 'xor' });
  assert.ok(!p.insts.some(i => val(i, 'XBUSED') || val(i, 'YBUSED')));
  assert.ok(!p.nets.some(n => n.outpins.some(o => o.pin === 'XB' || o.pin === 'YB')));
  // the comparator ended on the F side of its third slice: the G side of that slice is the extra stage
  const cmp = p.macros.filter(m => m.kind === 'carry').find(m => m.members.length === 3).members.map(x => p.insts[x.inst]);
  assert.match(val(cmp[2], 'G'), /^#LUT:D=0$/);
  assert.ok(cfgOf(cmp[2]).XORG);
  assert.equal(val(cmp[2], 'GYMUX'), 'GXOR');
  assert.equal(val(cmp[2], 'YUSED'), '0');
  assert.ok(p.nets.some(n => n.outpins.some(o => o.inst === p.insts.indexOf(cmp[2]) && o.pin === 'Y')));
  const d = compareSims(nl, p, { cycles: 600, seed: 7 });
  assert.equal(d, null, d && `first difference at cycle ${d.cycle}`);
});

test('carryOut xor: a chain ending on the G side gets its XOR stage on the F side of a slice above (CIN)', () => {
  // y = {a, c} >= {b, d}-like: two MUXCY stages (F, G of one slice) whose carry out drives a pad
  const io = (t, i, o) => ({ type: t, parameters: {}, port_directions: { I: 'input', O: 'output' }, connections: { I: [i], O: [o] } });
  const lut2 = (i0, i1, o) => ({ type: 'LUT2', parameters: { INIT: '1001' }, port_directions: { I0: 'input', I1: 'input', O: 'output' }, connections: { I0: [i0], I1: [i1], O: [o] } });
  const muxcy = (ci, di, sel, o) => ({ type: 'MUXCY', parameters: {}, port_directions: { CI: 'input', DI: 'input', S: 'input', O: 'output' }, connections: { CI: [ci], DI: [di], S: [sel], O: [o] } });
  const nl = readYosysJson(JSON.stringify({ modules: { cmp: {
    attributes: { top: '00000000000000000000000000000001' },
    ports: { a: { direction: 'input', bits: [2] }, b: { direction: 'input', bits: [3] }, c: { direction: 'input', bits: [4] }, d: { direction: 'input', bits: [5] }, y: { direction: 'output', bits: [10] } },
    cells: {
      ia: io('IBUF', 2, 12), ib: io('IBUF', 3, 13), ic: io('IBUF', 4, 14), id: io('IBUF', 5, 15), oy: io('OBUF', 9, 10),
      s0: lut2(12, 13, 6), s1: lut2(14, 15, 7), m0: muxcy('0', 12, 6, 8), m1: muxcy(8, 14, 7, 9),
    },
    netnames: {},
  } } }));
  const p = pack(nl, { carryOut: 'xor' });
  const chain = p.macros.find(m => m.kind === 'carry').members.map(x => p.insts[x.inst]);
  assert.equal(chain.length, 2);
  assert.ok(cfgOf(chain[0]).CYMUXG && cfgOf(chain[0]).CYMUXF);
  assert.equal(val(chain[0], 'COUTUSED'), '0');
  assert.deepEqual([val(chain[1], 'CYINIT'), val(chain[1], 'FXMUX'), val(chain[1], 'XUSED')], ['CIN', 'FXOR', '0']);
  assert.match(val(chain[1], 'F'), /^#LUT:D=0$/);
  assert.ok(cfgOf(chain[1]).XORF);
  const k = chain.map(s => p.insts.indexOf(s));
  assert.deepEqual(p.nets.find(n => n.outpins[0]?.inst === k[0] && n.outpins[0].pin === 'COUT').inpins, [{ inst: k[1], pin: 'CIN' }]);
  assert.ok(p.nets.some(n => n.outpins[0]?.inst === k[1] && n.outpins[0].pin === 'X'));
  const d = compareSims(nl, p, { cycles: 64, seed: 3 });
  assert.equal(d, null, d && `first difference at cycle ${d.cycle}`);
  // the default: through YB, as ISE does
  assert.ok(pack(nl).nets.some(n => n.outpins.some(o => o.pin === 'YB')));
});

test('wide multiplexers: F5 in every slice, F6 / F7 / F8 in their fixed slices', () => {
  const p = pack(load('mux64'));
  const f8 = p.macros.filter(m => m.kind === 'F8');
  assert.equal(f8.length, 1);
  const m = f8[0];
  assert.equal(m.members.length, 8);
  assert.deepEqual(m.align, [2, 2]);
  const at = new Map(m.members.map(x => [`${x.dx},${x.dy}`, p.insts[x.inst]]));
  // two CLBs, one above the other
  assert.deepEqual([...at.keys()].sort(), ['0,0', '0,1', '0,2', '0,3', '1,0', '1,1', '1,2', '1,3']);
  for (const s of at.values()) assert.ok(cfgOf(s).F5MUX, 'every slice has its F5');
  // which FiMUX each slice uses: F6 at S0 / S2 of each CLB, F7 at S1, F8 at S3 of the lower CLB
  const fi = (x, y) => !!cfgOf(at.get(`${x},${y}`)).F6MUX;
  assert.deepEqual([fi(0, 0), fi(1, 0), fi(0, 1), fi(1, 1), fi(0, 2), fi(1, 2), fi(0, 3), fi(1, 3)], [true, true, true, true, true, true, true, false]);
  // the F8 input from the CLB above: FX of S1 of the upper CLB -> FXINB of S3 of the lower one
  const k = s => p.insts.indexOf(s);
  const n = p.nets.find(x => x.outpins[0]?.inst === k(at.get('0,3')) && x.outpins[0].pin === 'FX');
  assert.deepEqual(n.inpins, [{ inst: k(at.get('1,1')), pin: 'FXINB' }]);
  assert.deepEqual(WIDE_MUX[8][0], { at: [1, 1], a: [0, 1], b: [0, 3] });
  // F6: F5 of the slice above -> FXINB
  const n6 = p.nets.find(x => x.outpins[0]?.inst === k(at.get('0,1')) && x.outpins[0].pin === 'F5');
  assert.deepEqual(n6.inpins, [{ inst: k(at.get('0,0')), pin: 'FXINB' }]);
  // the registered output: the flip-flop sits in the F8's slice, fed through GYMUX = FX
  const top = at.get('1,1');
  assert.deepEqual([val(top, 'GYMUX'), val(top, 'DYMUX'), val(top, 'FFY')], ['FX', '1', '#FF']);
});

test('flip-flop kinds: set / reset, synchronous / asynchronous, falling edge, never two control sets in a slice', () => {
  const p = pack(load('ffs'));
  const ffs = p.insts.filter(i => i.kind === 'slice').flatMap(s => ['X', 'Y'].filter(X => cfgOf(s)[`FF${X}`]).map(X => ({ s, X })));
  assert.equal(ffs.length, 5);
  const kinds = ffs.map(({ s, X }) => `${val(s, 'SYNC_ATTR')}/${val(s, `FF${X}_SR_ATTR`)}/${val(s, `FF${X}_INIT_ATTR`)}/${val(s, 'CLKINV')}/${val(s, 'SRINV') || '-'}`).sort();
  // (no initial values in ffs.v: Yosys's INIT is x, read as 0 as the simulator starts registers)
  assert.deepEqual(kinds, ['ASYNC/SRHIGH/INIT0/CLK/SR', 'ASYNC/SRLOW/INIT0/CLK/SR', 'ASYNC/SRLOW/INIT0/CLK_B/-', 'SYNC/SRHIGH/INIT0/CLK/SR', 'SYNC/SRLOW/INIT0/CLK/SR']);
});

test('names are plain words; unsupported cells are reported', () => {
  const p = pack(load('counter'));
  for (const i of p.insts) { assert.doesNotMatch(i.name, /[\s:"\\]/); for (const c of i.cfg) assert.doesNotMatch(c.name, /[\s:"\\]/); }
  for (const n of p.nets) assert.doesNotMatch(n.name, /[\s:"\\]/);
  const nl = load('sw');
  nl.cells.push({ name: 'ram', type: 'RAMB16_S9', params: {}, attrs: {}, pins: {}, dirs: {} });
  assert.throws(() => pack(nl), e => e instanceof PackError && /RAMB16_S9/.test(e.message));
});

test('latches: #LATCH, transparent while CLKINV gives 0 (an active-high gate takes CLK_B, as ISE writes it)', () => {
  const p = pack(load('latches'));
  const lat = p.insts.filter(i => i.kind === 'slice' && ['X', 'Y'].some(X => val(i, `FF${X}`) === '#LATCH'));
  assert.ok(lat.length >= 2);
  // LDCE (gate g & ge) and LDPE (its gate !g2 through an inverter): both active high on the cell
  for (const s of lat) { assert.equal(val(s, 'CLKINV'), 'CLK_B'); assert.equal(val(s, 'SYNC_ATTR'), 'ASYNC'); }
});
