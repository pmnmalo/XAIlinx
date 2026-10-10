// core/fpga/route.js: the router (PathFinder) and the routing check; core/xdl.js writeXdl.
// Device: test/fixtures/fpga/route-device.xdlrc (hand-made). Designs: small XDL texts below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packDevice, loadDevice } from '../core/fpga/device.js';
import { routeDesign, checkRouting, netEndpoints } from '../core/fpga/route.js';
import { parseXdl, writeXdl } from '../core/xdl.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fpga');
const device = loadDevice(packDevice(fs.readFileSync(path.join(FIX, 'route-device.xdlrc'), 'utf8')));

// a placed design: instances on sites (their configuration does not matter to the router)
const inst = (name, type, tile, site) => `inst "${name}" "${type}",placed ${tile} ${site}  ,\n  cfg " A::B "\n  ;\n`;
const net = (name, type, outpins, inpins, pips = []) =>
  `net "${name}" ${type || ''}, \n${outpins.map(([i, p]) => `  outpin "${i}" ${p} ,\n`).join('')}${inpins.map(([i, p]) => `  inpin "${i}" ${p} ,\n`).join('')}${pips.map(p => `  pip ${p} ,\n`).join('')}  ;\n`;
const INSTS = inst('pad', 'IOB', 'LIOIS_X0Y0', 'P1') + inst('a0', 'SLICEL', 'CLB_X1Y0', 'SLICE_X0Y0') + inst('a1', 'SLICEL', 'CLB_X1Y0', 'SLICE_X0Y1')
  + inst('b0', 'SLICEL', 'CLB_X2Y0', 'SLICE_X1Y0') + inst('b1', 'SLICEL', 'CLB_X2Y0', 'SLICE_X1Y1') + inst('ck', 'BUFGMUX', 'CLKT_X1Y1', 'BUFGMUX_X1Y1');
const design = nets => parseXdl(`design "t" xc3s50etq144-4 v3.2 ,\n  cfg "";\n${INSTS}${nets}`);
const pipsOf = (r, name) => r.design.nets.filter(n => n.name === name).flatMap(n => n.pips.map(p => `${p.tile} ${p.from} ${p.dir} ${p.to}`)).sort();

test('netEndpoints: source and sink nodes of each net from the placed sites; unknown pins reported', () => {
  const d = design(net('n', '', [['a0', 'X']], [['b0', 'F1'], ['b1', 'NOPIN'], ['ghost', 'F1']]));
  const { nets, errors } = netEndpoints(d, device);
  assert.deepEqual(nets[0].sources, [device.sitePinNode('SLICE_X0Y0', 'X')]);
  assert.deepEqual(nets[0].sinks.map(s => s.node), [device.sitePinNode('SLICE_X1Y0', 'F1')]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /site SLICE_X1Y1 has no pin NOPIN/);
  assert.match(errors[1], /ghost\.F1: instance not placed or unknown/);
  // the made-up source of ISE's power nets: the site is in the name
  const v = netEndpoints(design(net('v', 'vcc', [['XDL_DUMMY_CLB_X2Y0_VCC_X2Y0', 'VCCOUT']], [['b0', 'F2']])), device);
  assert.deepEqual(v.nets[0].sources, [device.sitePinNode('VCC_X2Y0', 'VCCOUT')]);
  assert.deepEqual(v.errors, []);
});

test('routeDesign: a two-sink net is routed as one tree of PIPs and passes the check', () => {
  const r = routeDesign(design(net('n', '', [['a0', 'X']], [['b0', 'F1'], ['b1', 'F1']])), device);
  assert.equal(r.routed, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(r.overused, 0);
  assert.deepEqual(pipsOf(r, 'n'), [
    'CLB_X1Y0 OMUX0 -> E2BEG0', 'CLB_X1Y0 X0 -> OMUX0', 'CLB_X2Y0 E2END0 -> F1_B_PINWIRE0', 'CLB_X2Y0 E2END0 -> F1_B_PINWIRE1',
  ]);
  assert.ok(checkRouting(r.design, device).ok);
});

test('routeDesign: two nets wanting the same wire negotiate (PathFinder): one takes the longer way', () => {
  // a0.X -> b0.F1 can only use E2BEG0; a1.X -> b1.F1 prefers E2BEG0 too (3 nodes) but can go by E2BEG1 + HOP1 (4)
  const r = routeDesign(design(net('na', '', [['a0', 'X']], [['b0', 'F1']]) + net('nb', '', [['a1', 'X']], [['b1', 'F1']])), device);
  assert.equal(r.overused, 0);
  assert.ok(r.iterations >= 2, 'the conflict of the first pass is resolved in a later one');
  assert.ok(pipsOf(r, 'na').includes('CLB_X1Y0 OMUX0 -> E2BEG0'));
  assert.deepEqual(pipsOf(r, 'nb'), ['CLB_X1Y0 OMUX1 -> E2BEG1', 'CLB_X1Y0 X1 -> OMUX1', 'CLB_X2Y0 E2END1 -> HOP1', 'CLB_X2Y0 HOP1 -> F1_B_PINWIRE1']);
  assert.ok(checkRouting(r.design, device).ok);
});

test('routeDesign: a global clock takes the GCLK network even when general routing is shorter', () => {
  const r = routeDesign(design(net('clk', '', [['ck', 'O']], [['a0', 'CLK'], ['b1', 'CLK']])), device);
  assert.deepEqual(pipsOf(r, 'clk'), [
    'CLB_X1Y0 GCLK0 -> CLK0', 'CLB_X2Y0 GCLK0 -> CLK1', 'CLKT_X1Y1 CLKT_GCLK_MAIN0 -> CLKT_GCLK_SPINE0', 'CLKT_X1Y1 CLKT_GCLK_PINWIRE0 -> CLKT_GCLK_MAIN0',
  ]);
  // the same source driving a non-clock design pin falls back to general routing (here: none exists)
  assert.ok(checkRouting(r.design, device).ok);
});

test('routeDesign: carry chain, bidirectional PIPs, route-throughs never used, unreachable sinks reported', () => {
  const r = routeDesign(design(
    net('carry', '', [['a0', 'COUT']], [['a1', 'CIN']])
    + net('bx', '', [['pad', 'I']], [['a1', 'BX']])
    + net('lost', '', [['a0', 'X']], [['b0', 'CIN']])), device);
  assert.deepEqual(pipsOf(r, 'carry'), ['CLB_X1Y0 COUT0 -> CIN1']);
  // pad -> E2END0 -> BX0 -> (bidirectional, written BX0 =- BX1) -> BX1 -> BX pin of the upper slice
  assert.deepEqual(pipsOf(r, 'bx'), ['CLB_X1Y0 BX0 =- BX1', 'CLB_X1Y0 BX1 -> BX_PINWIRE1', 'CLB_X1Y0 E2END0 -> BX0', 'LIOIS_X0Y0 IOIS_I0 -> IOIS_E0']);
  assert.ok(!r.design.nets.some(n => n.pips.some(p => p.from === 'F1_B_PINWIRE0' && p.to === 'X0')));
  assert.deepEqual(r.failed, ['lost']);
  const c = checkRouting(r.design, device);
  assert.deepEqual(c.problems, ['net lost: sink b0.CIN not reached']);
});

test('routeDesign: a route-through only out of the net\'s own source site onto a free pin (COUT -> X, like ISE\'s COUT -> YB)', () => {
  // a1 is the top of a carry chain: its COUT leaves the slice through X1 when X1 is free
  const r = routeDesign(design(net('cy', '', [['a1', 'COUT']], [['b1', 'F1']])), device);
  assert.deepEqual(r.failed, []);
  assert.ok(pipsOf(r, 'cy').includes('CLB_X1Y0 COUT1 -> X1'));
  assert.ok(checkRouting(r.design, device).ok);
  // X1 used by another net: no way out
  const r2 = routeDesign(design(net('cy', '', [['a1', 'COUT']], [['b1', 'F1']]) + net('x', '', [['a1', 'X']], [['b0', 'F1']])), device);
  assert.deepEqual(r2.failed, ['cy']);
  assert.equal(r2.routed, 1);
});

test('routeDesign: a net that fails in the first pass stays reported when later passes reroute only congested nets', () => {
  const r = routeDesign(design(net('na', '', [['a0', 'X']], [['b0', 'F1']]) + net('nb', '', [['a1', 'X']], [['b1', 'F1']]) + net('lost', '', [['pad', 'I']], [['b0', 'CIN']])), device);
  assert.ok(r.iterations >= 2);
  assert.deepEqual(r.failed, ['lost']);
  assert.equal(r.routed, 2);
});

test('routeDesign: VCC without a source is tied to the VCC site of each sink tile (ISE-style dummy source); with one, from it', () => {
  const r = routeDesign(design(net('pwr', 'vcc', [], [['a0', 'F2'], ['b1', 'F2']])), device);
  const out = r.design.nets.filter(n => n.type === 'vcc');
  assert.deepEqual(out.map(n => [n.name, n.outpins[0].inst, n.outpins[0].pin]), [
    ['pwr_0', 'XDL_DUMMY_CLB_X1Y0_VCC_X1Y0', 'VCCOUT'], ['pwr_1', 'XDL_DUMMY_CLB_X2Y0_VCC_X2Y0', 'VCCOUT'],
  ]);
  assert.deepEqual(out.map(n => n.pips.map(p => `${p.tile} ${p.from} -> ${p.to}`)), [['CLB_X1Y0 VCC_PINWIRE -> F2_B_PINWIRE0'], ['CLB_X2Y0 VCC_PINWIRE -> F2_B_PINWIRE1']]);
  // the made-up sources are declared as instances, as ISE does (xdl -xdl2ncd needs them)
  const dum = r.design.insts.filter(i => /^XDL_DUMMY/.test(i.name));
  assert.deepEqual(dum.map(i => [i.name, i.type, i.tile, i.site, i.cfgRaw]), [
    ['XDL_DUMMY_CLB_X1Y0_VCC_X1Y0', 'VCC', 'CLB_X1Y0', 'VCC_X1Y0', '_NO_USER_LOGIC:: _VCC_SOURCE::VCCOUT '],
    ['XDL_DUMMY_CLB_X2Y0_VCC_X2Y0', 'VCC', 'CLB_X2Y0', 'VCC_X2Y0', '_NO_USER_LOGIC:: _VCC_SOURCE::VCCOUT '],
  ]);
  assert.match(writeXdl(r.design), /inst "XDL_DUMMY_CLB_X1Y0_VCC_X1Y0" "VCC",placed CLB_X1Y0 VCC_X1Y0 {2},\n {2}cfg "_NO_USER_LOGIC:: _VCC_SOURCE::VCCOUT "/);
  assert.ok(checkRouting(r.design, device).ok);
  const r2 = routeDesign(design(net('v', 'vcc', [['XDL_DUMMY_CLB_X2Y0_VCC_X2Y0', 'VCCOUT']], [['b0', 'F2']])), device);
  assert.deepEqual(pipsOf(r2, 'v'), ['CLB_X2Y0 VCC_PINWIRE -> F2_B_PINWIRE0']);
  // an ordinary net without a source is reported
  const r3 = routeDesign(design(net('w', '', [], [['b0', 'F2']])), device);
  assert.match(r3.errors[0], /net w: no source/);
});

test('routeDesign: GND without a source comes from the Y output of the nearest unused slice (ISE-style dummy); merged nets split per source', () => {
  // slice SLICE_X0Y1 (a1) is left free: its Y reaches b0.F1 by OMUX1 -> E2BEG0
  const insts = INSTS.replace(/inst "a1"[^;]*;\n/, '');
  const d = parseXdl(`design "t" xc3s50etq144-4 v3.2 ,\n  cfg "";\n${insts}${net('g1', 'gnd', [], [['b0', 'F1']])}${net('g2', 'gnd', [], [['b1', 'F1']])}`);
  const r = routeDesign(d, device);
  assert.deepEqual(r.errors, []);
  const g = r.design.nets.filter(n => n.type === 'gnd');
  assert.deepEqual(g.map(n => [n.name, n.outpins[0].inst, n.outpins[0].pin, n.inpins.map(p => p.inst)]), [['g1_0', 'XDL_DUMMY_CLB_X1Y0_SLICE_X0Y1', 'Y', ['b0', 'b1']]]);
  assert.deepEqual(r.design.insts.filter(i => /^XDL_DUMMY/.test(i.name)).map(i => [i.type, i.site, i.cfgRaw]), [['SLICEL', 'SLICE_X0Y1', '_NO_USER_LOGIC:: _GND_SOURCE::Y ']]);
  assert.equal(r.design.nets.filter(n => n.name === 'g2').length, 0, 'the merged net is not written twice');
  assert.ok(checkRouting(r.design, device).ok);
  // no free slice at all: reported
  const r2 = routeDesign(design(net('g', 'gnd', [], [['b0', 'F2']])), device);
  assert.match(r2.errors[0], /net g: no free site for a gnd source/);
});

test('routeDesign: existing PIPs are replaced; nets without sinks get none; the input design is not changed', () => {
  const d = design(net('n', '', [['a0', 'X']], [['b0', 'F1']], ['CLB_X1Y0 X1 -> OMUX1']) + net('empty', '', [['a1', 'X']], []));
  const r = routeDesign(d, device);
  assert.equal(pipsOf(r, 'n').length, 3);
  assert.deepEqual(pipsOf(r, 'empty'), []);
  assert.deepEqual(d.nets[0].pips, [{ tile: 'CLB_X1Y0', from: 'X1', dir: '->', to: 'OMUX1' }]);
});

test('checkRouting: unknown PIPs, unreached sinks, antennas and nodes shared by two nets', () => {
  const bad = design(
    net('n1', '', [['a0', 'X']], [['b0', 'F1']], ['CLB_X1Y0 X0 -> OMUX0', 'CLB_X1Y0 OMUX0 -> E2BEG0', 'CLB_X2Y0 E2END0 -> F1_B_PINWIRE0', 'CLB_X1Y0 OMUX0 -> W2BEG0', 'CLB_X1Y0 X0 -> NOWIRE'])
    + net('n2', '', [['a1', 'X']], [['b1', 'F1']], ['CLB_X1Y0 X1 -> OMUX1', 'CLB_X1Y0 OMUX1 -> E2BEG0']));
  const c = checkRouting(bad, device);
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems.sort(), [
    'net n1: LIOIS_X0Y0/IOIS_W2END0 leads nowhere (antenna)',
    'net n1: no PIP CLB_X1Y0 X0 -> NOWIRE',
    'net n2: CLB_X1Y0/E2BEG0 leads nowhere (antenna)',
    'net n2: sink b1.F1 not reached',
    'node CLB_X1Y0/E2BEG0 used by n1 and n2',
  ]);
});

test('writeXdl: parse -> write -> parse keeps instances, configurations (as written), nets, pins and PIPs', () => {
  const text = fs.readFileSync(path.join(FIX, 'top.xdl'), 'utf8');
  const a = parseXdl(text);
  const out = writeXdl(a);
  const b = parseXdl(out);
  const strip = d => ({ ...d, cfgRaw: undefined, insts: d.insts.map(i => ({ ...i, cfgRaw: undefined })), nets: d.nets.map(n => ({ ...n, cfgRaw: undefined })) });
  assert.deepEqual(strip(b), strip(a));
  assert.match(out, /name\\:with\\:colons:x/, 'escapes inside configurations are kept as written');
  assert.match(out, /^net "GLOBAL_LOGIC1" vcc, $/m);
  assert.match(out, /^ {2}pip TIOIS_X1Y3 IOIS_IQ1 => OMUX0 ,$/m);
  // a design built in memory (no raw configuration text): the items are written with escapes
  const c = parseXdl(writeXdl({ name: 'x', part: 'p', insts: [{ name: 'i', type: 'SLICEL', placed: true, tile: 'T', site: 'S', cfg: [{ attr: 'F', name: 'a:b c', value: '#LUT:D=A1' }] }], nets: [] }));
  assert.equal(c.insts[0].cfgRaw, ' F:a\\:b\\ c:#LUT:D=A1 ');
});
