// core/fpga/timing.js: the delay model (wire classes, routed connection delays, slice arcs), the
// static timing analysis, and the timing-driven router (core/fpga/route.js, opts.timing).
// Device: test/fixtures/fpga/timing-device.xdlrc (hand-made: three CLBs in a row, a slow way by two
// double lines and a fast one by a long line). Designs: small XDL texts below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packDevice, loadDevice } from '../core/fpga/device.js';
import { routeDesign, checkRouting, netEndpoints } from '../core/fpga/route.js';
import { parseXdl, writeXdl } from '../core/xdl.js';
import {
  WIRE, SPEED_4, classOfWires, nodeClasses, nodeDelays, netTree, treePath, pathDelay, distanceDelay,
  instArcs, timingGraph, analyzeTiming, timingReport,
} from '../core/fpga/timing.js';
import { parseDly } from '../research/s3e-route/timing-fit.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fpga');
const device = loadDevice(packDevice(fs.readFileSync(path.join(FIX, 'timing-device.xdlrc'), 'utf8')));
const S = SPEED_4.slice;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);

const inst = (name, type, tile, site, cfg) => `inst "${name}" "${type}",placed ${tile} ${site}  ,\n  cfg "${cfg}"\n  ;\n`;
const net = (name, outpins, inpins, pips = []) =>
  `net "${name}" , \n${outpins.map(([i, p]) => `  outpin "${i}" ${p} ,\n`).join('')}${inpins.map(([i, p]) => `  inpin "${i}" ${p} ,\n`).join('')}${pips.map(p => `  pip ${p} ,\n`).join('')}  ;\n`;
// a: a flip-flop (SLICE_X0Y0, a SLICEM site: the left column); b: a LUT F into a flip-flop and a LUT G (SLICE_X2Y0, also SLICEM)
const INSTS = inst('a', 'SLICEL', 'CLB_X1Y0', 'SLICE_X0Y0', ' FFX:a:#FF DXMUX::1 FXMUX::F ')
  + inst('b', 'SLICEL', 'CLB_X3Y0', 'SLICE_X2Y0', ' F:b_f:#LUT:D=A1 G:b_g:#LUT:D=A1 FXMUX::F GYMUX::G FFX:b:#FF DXMUX::1 ')
  + inst('ck', 'IOB', 'CLB_X1Y0', 'P1', ' ');
const CLK = net('clk', [['ck', 'I']], [['a', 'CLK'], ['b', 'CLK']]);
const design = nets => parseXdl(`design "t" xc3s50etq144-4 v3.2 ,\n  cfg "";\n${INSTS}${CLK}${nets}`);
// d: a.XQ to b.G1 (not timed: G -> Y goes to no flip-flop) and to b.F1 (timed: F -> X -> the flip-flop)
const D_NET = net('d', [['a', 'XQ']], [['b', 'G1'], ['b', 'F1']]);
const pipsOf = (r, name) => r.design.nets.filter(n => n.name === name).flatMap(n => n.pips.map(p => `${p.tile} ${p.from} -> ${p.to}`)).sort();

test('wire classes: from the names of a node\'s wires (long line, hex, double, OMUX, clock, input multiplexer, I/O) and site pins', () => {
  assert.equal(classOfWires(['LH12']), WIRE.LONG);
  assert.equal(classOfWires(['CLKV_LV3', 'LV3']), WIRE.LONG);
  assert.equal(classOfWires(['LH0_TESTWIRE', 'OMUX3']), WIRE.OMUX, 'test wires are not long lines');
  assert.equal(classOfWires(['E6BEG2', 'E6A2', 'E6MID2', 'E6END2']), WIRE.HEX);
  assert.equal(classOfWires(['N2BEG5', 'N2MID5', 'N2END_N5']), WIRE.DOUBLE);
  assert.equal(classOfWires(['OMUX_NW10', 'N2BEG1']), WIRE.DOUBLE, 'the longest class of the node wins');
  assert.equal(classOfWires(['OMUX_N12']), WIRE.OMUX);
  assert.equal(classOfWires(['GCLKH_GCLK_DN4']), WIRE.GCLK);
  assert.equal(classOfWires(['G3_B2']), WIRE.IMUX);
  assert.equal(classOfWires(['BX1']), WIRE.IMUX);
  assert.equal(classOfWires(['IOIS_Y2']), WIRE.IO);
  assert.equal(classOfWires(['SOMETHING']), WIRE.OTHER);
  assert.equal(classOfWires(['F1_B_PINWIRE0'], true), WIRE.PIN);
  assert.equal(classOfWires(['XQ0'], false, true), WIRE.OUT);
  // on the device: every node classified once (cached), site pins by the sites' pin wires
  const cls = nodeClasses(device);
  assert.equal(nodeClasses(device), cls);
  assert.equal(cls[device.node('CLB_X1Y0', 'OMUX0')], WIRE.OMUX);
  assert.equal(cls[device.node('CLB_X2Y0', 'E2END0')], WIRE.DOUBLE);
  assert.equal(cls[device.node('CLB_X3Y0', 'LH0')], WIRE.LONG);
  assert.equal(cls[device.node('CLB_X1Y0', 'XQ0')], WIRE.OUT);
  assert.equal(cls[device.node('CLB_X3Y0', 'F1_B_PINWIRE0')], WIRE.PIN);
  const nd = nodeDelays(device);
  assert.equal(nd[device.node('CLB_X3Y0', 'LH0')], Math.fround(SPEED_4.wire[WIRE.LONG]));
  assert.equal(nodeDelays(device), nd);
});

test('routed connection delays: the path in the net\'s tree, node delays and branch loads; a dedicated connection takes none', () => {
  const src = device.node('CLB_X1Y0', 'XQ0');
  const pips = [{ tile: 'CLB_X1Y0', from: 'XQ0', dir: '->', to: 'OMUX0' }, { tile: 'CLB_X1Y0', from: 'OMUX0', dir: '->', to: 'LH0' },
    { tile: 'CLB_X3Y0', from: 'LH0', dir: '->', to: 'F1_B_PINWIRE0' }, { tile: 'CLB_X1Y0', from: 'OMUX0', dir: '->', to: 'E2BEG0' },
    { tile: 'CLB_X2Y0', from: 'E2END0', dir: '->', to: 'E2BEG1' }, { tile: 'CLB_X3Y0', from: 'E2END1', dir: '->', to: 'G1_B_PINWIRE0' }];
  const tree = netTree(pips, [src], device);
  const f1 = device.node('CLB_X3Y0', 'F1_B_PINWIRE0'), g1 = device.node('CLB_X3Y0', 'G1_B_PINWIRE0');
  assert.deepEqual(treePath(tree, f1), [src, device.node('CLB_X1Y0', 'OMUX0'), device.node('CLB_X1Y0', 'LH0'), f1]);
  assert.equal(treePath(tree, device.node('CLB_X3Y0', 'X0')), null);
  const W = SPEED_4.wire, B = SPEED_4.branch;
  // OMUX0 has two branches (to LH0 and to E2BEG0): one extra branch load
  close(pathDelay(treePath(tree, f1), tree, device), SPEED_4.base + W[WIRE.OMUX] + B[WIRE.OMUX] + W[WIRE.LONG] + W[WIRE.PIN]);
  close(pathDelay(treePath(tree, g1), tree, device), SPEED_4.base + W[WIRE.OMUX] + B[WIRE.OMUX] + 2 * W[WIRE.DOUBLE]);
  // no general routing wire on the path (a carry chain, F5 -> FXINA): no delay
  assert.equal(pathDelay([src, f1], { children: new Map() }, device), 0);
  // a PIP the device does not have: no tree
  assert.equal(netTree([{ tile: 'CLB_X1Y0', from: 'XQ0', dir: '->', to: 'LH0' }], [src], device), null);
  // unrouted: from the distance (tiles), slower per tile up to the knee, then by long lines
  const { base, perTile, knee, far } = SPEED_4.dist;
  close(distanceDelay(src, f1, device), base + 2 * perTile);
  const m = { ...SPEED_4, dist: { base: 1, perTile: 0.5, knee: 1, far: 0.1 } };
  close(distanceDelay(src, f1, device, m), 1 + 0.5 + 0.1);
  assert.ok(knee > 0 && far < perTile);
});

test('slice arcs: LUT, F5 / FX multiplexers, carry chain (its data input), flip-flops by DXMUX / DYMUX; SLICEM or SLICEL by the site', () => {
  const sl = (site, cfg) => instArcs({ type: 'SLICEL', site, cfg: cfg.map(([attr, value]) => ({ attr, name: '', value })) });
  const find = (a, i, o) => a.comb.filter(x => x[0] === i && x[1] === o).map(x => x[2]);
  // FXMUX = F, FFX from X: F1 -> X is a LUT; the setup through it adds Tdxck; XQ is Tcko
  const l = sl('SLICE_X1Y0', [['FXMUX', 'F'], ['GYMUX', 'G'], ['FFX', '#FF'], ['DXMUX', '1']]);
  assert.deepEqual(find(l, 'F3', 'X'), [S.Tilo[0]]);
  assert.deepEqual(l.setup.find(x => x[0] === 'F3'), ['F3', S.Tilo[0] + S.Tdxck[0]]);
  assert.deepEqual(l.clkToOut, [['XQ', S.TckoX[0]]]);
  assert.ok(l.clock);
  assert.ok(l.setup.some(x => x[0] === 'CE') && l.setup.some(x => x[0] === 'SR'));
  // the same on a SLICEM site (even X): SLICEM delays, whatever the type written
  const m = sl('SLICE_X2Y5', [['FXMUX', 'F'], ['FFX', '#FF'], ['DXMUX', '1']]);
  assert.deepEqual(find(m, 'F1', 'X'), [S.Tilo[1]]);
  // DXMUX = 0: the flip-flop from BX (Tdick), the LUT not on its way
  const b = sl('SLICE_X1Y0', [['FXMUX', 'F'], ['FFX', '#FF'], ['DXMUX', '0']]);
  assert.deepEqual(b.setup.filter(x => /^F/.test(x[0])), []);
  assert.deepEqual(b.setup.find(x => x[0] === 'BX'), ['BX', S.Tdick[0]]);
  // F5 into X, FX into Y; F5 / FX outputs
  const w = sl('SLICE_X1Y0', [['FXMUX', 'F5'], ['GYMUX', 'FX']]);
  assert.deepEqual(find(w, 'G2', 'X'), [S.Tif5x[0]]);
  assert.deepEqual(find(w, 'BX', 'X'), [S.Tbxx[0]]);
  assert.deepEqual(find(w, 'FXINB', 'Y'), [S.Tif6y[0]]);
  assert.deepEqual(find(w, 'BY', 'Y'), [S.Tbyy[0]]);
  assert.deepEqual(find(w, 'F1', 'F5'), [S.Tif5[0]]);
  assert.deepEqual(find(w, 'FXINA', 'FX'), [S.Tinafx[0]]);
  assert.ok(!w.clock && !w.clkToOut.length && !w.setup.length);
  // carry: CYINIT = CIN; the G LUT pin that is also CY0G's data input is slower; BX as CY0F
  const c = sl('SLICE_X1Y0', [['FXMUX', 'FXOR'], ['GYMUX', 'GXOR'], ['CYINIT', 'CIN'], ['CY0F', 'BX'], ['CY0G', 'G1']]);
  assert.deepEqual(find(c, 'CIN', 'COUT'), [S.Tbyp[0]]);
  assert.deepEqual(find(c, 'CIN', 'Y'), [S.Tciny[0]]);
  assert.deepEqual(find(c, 'CIN', 'X'), [S.Tcinx[0]]);
  assert.deepEqual(find(c, 'G1', 'COUT'), [S.TopcygDI[0]]);
  assert.deepEqual(find(c, 'G2', 'COUT'), [S.Topcyg[0]]);
  assert.deepEqual(find(c, 'BX', 'COUT'), [S.Tbxcy[0]]);
  assert.deepEqual(find(c, 'F2', 'Y'), [S.Topy[0]]);
  // CYINIT = BX: the chain starts from BX
  const c0 = sl('SLICE_X1Y0', [['GYMUX', 'GXOR'], ['CYINIT', 'BX']]);
  assert.deepEqual(find(c0, 'BX', 'COUT'), [S.Tbxcy[0]]);
  assert.deepEqual(find(c0, 'CIN', 'COUT'), []);
  // pads start and end paths; other sites have no arcs
  const p = instArcs({ type: 'IOB', site: 'P1', cfg: [] });
  assert.deepEqual([p.input, p.output], [[['I', SPEED_4.pad.Tiopi]], [['O', SPEED_4.pad.Tioop]]]);
  assert.deepEqual(instArcs({ type: 'BUFGMUX', site: 'B', cfg: [] }).comb, []);
});

test('static timing: the clock period of flip-flop to flip-flop paths, the critical path, slack and criticality of each connection', () => {
  const d = design(D_NET);
  const tg = timingGraph(d);
  // the connections: the data net only (not the clock)
  assert.deepEqual(tg.conns.map(c => `${c.net} ${c.fromPin.inst}.${c.fromPin.pin} -> ${c.toPin.inst}.${c.toPin.pin}`), ['d a.XQ -> b.G1', 'd a.XQ -> b.F1']);
  const r = tg.analyze(Float64Array.from([2, 1]));
  // a.XQ (Tcko, SLICEM) -> 1 ns -> b.F1 -> X (LUT) -> flip-flop setup
  close(r.period, S.TckoX[1] + 1 + S.Tilo[1] + S.Tdxck[1]);
  assert.deepEqual(r.clocks.map(c => c.clock), ['clk']);
  assert.deepEqual(r.clocks[0].path.map(s => `${s.kind} ${s.inst}.${s.pin}`), ['clock-to-out a.XQ', 'net b.F1', 'setup b.F1']);
  close(r.slack[1], 0);
  assert.equal(r.crit[1], 1);
  assert.equal(r.slack[0], Infinity, 'b.G1 leads to no flip-flop');
  assert.equal(r.crit[0], 0);
  // slower connection, longer period; criticality follows
  const r2 = tg.analyze(Float64Array.from([0, 3]));
  close(r2.period - r.period, 2);
  assert.match(timingReport(r2)[0], /^clock clk: minimum period \d+\.\d{3} ns \(\d+\.\d MHz\)$/);
  // flip-flops on different clocks: not a period path
  const d2 = parseXdl(`design "t" xc3s50etq144-4 v3.2 ,\n  cfg "";\n${INSTS}${net('c1', [['ck', 'I']], [['a', 'CLK']])}${net('c2', [['ck', 'I']], [['b', 'CLK']])}${D_NET}`);
  const r3 = timingGraph(d2).analyze(Float64Array.from([1, 1]));
  assert.equal(r3.period, 0);
  assert.deepEqual(r3.clocks, []);
});

test('static timing: a combinational loop does not hang the analysis; constants and clocks are not connections', () => {
  const loop = inst('l', 'SLICEL', 'CLB_X3Y0', 'SLICE_X2Y0', ' FXMUX::F GYMUX::G ');
  const d = parseXdl(`design "t" xc3s50etq144-4 v3.2 ,\n  cfg "";\n${loop}${net('x', [['l', 'X']], [['l', 'G1']])}${net('y', [['l', 'Y']], [['l', 'F1']])}`
    + 'net "g" gnd , \n  inpin "l" F2 ,\n  ;\n');
  const tg = timingGraph(d);
  assert.deepEqual(tg.conns.map(c => c.net), ['x', 'y']);
  const r = tg.analyze(Float64Array.from([1, 1]));
  assert.equal(r.period, 0);
});

test('analyzeTiming: connection delays from the design\'s routing, or from the distance when a net has no PIPs', () => {
  const unrouted = analyzeTiming(design(D_NET), device);
  const est = distanceDelay(device.node('CLB_X1Y0', 'XQ0'), device.node('CLB_X3Y0', 'F1_B_PINWIRE0'), device);
  close(unrouted.conns[1].delay, est);
  const fast = design(net('d', [['a', 'XQ']], [['b', 'F1']], ['CLB_X1Y0 XQ0 -> OMUX0', 'CLB_X1Y0 OMUX0 -> LH0', 'CLB_X3Y0 LH0 -> F1_B_PINWIRE0']));
  const slow = design(net('d', [['a', 'XQ']], [['b', 'F1']], ['CLB_X1Y0 XQ0 -> OMUX0', 'CLB_X1Y0 OMUX0 -> E2BEG0', 'CLB_X2Y0 E2END0 -> E2BEG1', 'CLB_X3Y0 E2END1 -> F1_B_PINWIRE0']));
  const W = SPEED_4.wire;
  const rf = analyzeTiming(fast, device), rs = analyzeTiming(slow, device);
  close(rf.conns[0].delay, SPEED_4.base + W[WIRE.OMUX] + W[WIRE.LONG]);
  close(rs.conns[0].delay, SPEED_4.base + W[WIRE.OMUX] + 2 * W[WIRE.DOUBLE]);
  close(rs.period - rf.period, 2 * W[WIRE.DOUBLE] - W[WIRE.LONG]);
  assert.deepEqual(rf.conns.map(c => [c.net, c.from, c.to, c.crit]), [['d', 'a.XQ', 'b.F1', 1]]);
});

test('timing-driven routing: the critical load gets the fast long line, routed first; without timing it branches off the doubles', () => {
  // b.G1 can only be reached by the doubles; b.F1 by the doubles (branching off G1's path: one new
  // node) or by the long line from the source (two new nodes, but faster)
  const plain = routeDesign(design(D_NET), device);
  assert.deepEqual(plain.failed, []);
  assert.ok(!pipsOf(plain, 'd').includes('CLB_X3Y0 LH0 -> F1_B_PINWIRE0'));
  assert.ok(pipsOf(plain, 'd').includes('CLB_X3Y0 E2END1 -> F1_B_PINWIRE0'));
  assert.equal(plain.period, null);
  const timed = routeDesign(design(D_NET), device, { timing: true });
  assert.deepEqual(timed.failed, []);
  assert.deepEqual(pipsOf(timed, 'd'), ['CLB_X1Y0 OMUX0 -> E2BEG0', 'CLB_X1Y0 OMUX0 -> LH0', 'CLB_X1Y0 XQ0 -> OMUX0', 'CLB_X2Y0 E2END0 -> E2BEG1', 'CLB_X3Y0 E2END1 -> G1_B_PINWIRE0', 'CLB_X3Y0 LH0 -> F1_B_PINWIRE0']);
  assert.ok(checkRouting(timed.design, device).ok);
  // the router's period is the analysis of the routing it returns, and shorter than without timing
  const sta = analyzeTiming(parseXdl(writeXdl(timed.design)), device);
  close(timed.period, sta.period);
  assert.ok(sta.period < analyzeTiming(parseXdl(writeXdl(plain.design)), device).period);
  // a net with no timed load is routed as before
  const g = routeDesign(design(net('d', [['a', 'XQ']], [['b', 'G1']])), device, { timing: true });
  assert.deepEqual(pipsOf(g, 'd'), ['CLB_X1Y0 OMUX0 -> E2BEG0', 'CLB_X1Y0 XQ0 -> OMUX0', 'CLB_X2Y0 E2END0 -> E2BEG1', 'CLB_X3Y0 E2END1 -> G1_B_PINWIRE0']);
  // the long line not allowed: the doubles, still legal
  const noLong = routeDesign(design(D_NET), device, { timing: true, allowPip: (t, f, to) => to !== 'LH0' });
  assert.deepEqual(noLong.failed, []);
  assert.ok(pipsOf(noLong, 'd').includes('CLB_X3Y0 E2END1 -> F1_B_PINWIRE0'));
  assert.ok(netEndpoints(noLong.design, device).errors.length === 0);
});

test('timing-fit: reportgen -delay\'s report read back (names wrapped at 80 columns, a short load on its delay\'s line)', () => {
  const long = '$abc$1$long.name' + '.genblk1'.repeat(12);
  const wrap = t => t.match(/.{1,80}/g).join('\n');
  const text = ['Release 14.7 - reportgen', '', ' The 20 worst nets by delay are:', '', '-'.repeat(79), '                               Net Delays', '-'.repeat(79), '',
    'u_knight.pattern<1>', '   $ff$2073.YQ', '         0.891  $ff$2073.F1', '         0.597  $ff$2075.F2', '',
    wrap(`${long}.net_FX`), '  ', wrap(`${long}.lut1.FX`), '         0.000 ', wrap(`${long}.lut0.FXINB`), ''].join('\n');
  const d = parseDly(text);
  assert.deepEqual([...d.keys()], ['u_knight.pattern<1>', `${long}.net_FX`]);
  assert.deepEqual(d.get('u_knight.pattern<1>'), { driver: '$ff$2073.YQ', loads: new Map([['$ff$2073.F1', 0.891], ['$ff$2075.F2', 0.597]]) });
  assert.deepEqual(d.get(`${long}.net_FX`), { driver: `${long}.lut1.FX`, loads: new Map([[`${long}.lut0.FXINB`, 0]]) });
});
