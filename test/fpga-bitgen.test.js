// core/fpga/bitgen.js: XDL -> features -> frame data -> .bit, with a small hand-made database and
// with the measured database (research/s3e-bitstream/db), without ISE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseXdl } from '../core/xdl.js';
import { makeDb, tileOf, tileBase, designFeatures, pipFeatures, frameData, bitgen, siteKind } from '../core/fpga/bitgen.js';
import { XC3S250E, readBit, getBit, diffFrames } from '../core/fpga/bitstream.js';

const FW = XC3S250E.frameWords;
// a database for two tiles: CLB_X1Y1 (frames 10-28, bits 100-163) and BIOIS_X1Y0
const tiny = () => makeDb({
  layout: { frameWords: 73, frames: 578, brkRows: [9], cols: { 1: 10 }, rows: { 1: 100, 0: 2256 }, defaults: [[3, 37]] },
  lut: { colFrame: { 0: 10, 1: 13 }, rowBit: { 0: 148, 1: 116 } },
  tiles: {
    pads: { P11: ['BIOIS_X1Y0', 2] },
    types: {
      CENTER_SMALL: { features: { 'X0->OMUX0': ['6,28'], 'OMUX0->E2BEG0': ['7,1', '!8,2'], 'BX1->BY3': ['10,31'], 'BY3->BX1': [], 'SLICE2:CLKINV:CLK_B': ['5,26'], 'SLICE2:USED': [] } },
      CENTER_SMALL_BRK: { sameAs: 'CENTER_SMALL', features: { 'X0->OMUX0': ['6,29'] } },
      BIOIS: { features: { 'IOB2:IOATTRBOX:LVCMOS33': ['3,69'] } },
    },
  },
});
const design = `design "t" xc3s250ecp132-4 v3.2 , cfg "";
inst "s" "SLICEL",placed CLB_X1Y1 SLICE_X1Y0 ,
  cfg " F:s_f:#LUT:D=A1 CLKINV::CLK_B XORF:a\\:b: FFX::#OFF _NO_USER_LOGIC:: "
  ;
inst "p" "IBUF",placed BIOIS_X1Y0 P11 ,
  cfg " IOATTRBOX::LVCMOS33 PULL::PULLUP "
  ;
net "n" ,
  outpin "s" X ,
  inpin "p" O1 ,
  pip CLB_X1Y1 X0 -> OMUX0 ,
  pip CLB_X1Y1 OMUX0 -> E2BEG0 ,
  ;
net "nopins" ,
  pip CLB_X1Y1 X0 -> OMUX9 ,
  ;
`;

test('tiles: type from the name, start from the layout', () => {
  const db = tiny();
  assert.deepEqual(tileOf('CLB_X1Y1', db), { name: 'CLB_X1Y1', type: 'CENTER_SMALL', x: 1, y: 1 });
  assert.equal(tileOf('CLB_X1Y9', db).type, 'CENTER_SMALL_BRK');
  assert.deepEqual(tileBase(tileOf('CLB_X1Y1', db), db), { frame: 10, bit: 100 });
  assert.equal(tileBase(tileOf('CLB_X5Y1', db), db), null);
  // a tile type that shares another's features keeps its own first
  assert.deepEqual(db.types.CENTER_SMALL_BRK.feats.get('X0->OMUX0'), ['6,29']);
  assert.deepEqual(db.types.CENTER_SMALL_BRK.feats.get('OMUX0->E2BEG0'), ['7,1', '!8,2']);
});

test('XDL configuration strings keep escaped colons in names', () => {
  const d = parseXdl(design);
  assert.deepEqual(d.insts[0].cfg.find(c => c.attr === 'XORF'), { attr: 'XORF', name: 'a:b', value: '' });
});

test('features: site settings, LUTs, PIPs only on nets with pins', () => {
  const db = tiny();
  const d = parseXdl(design);
  assert.equal(siteKind(d.insts[0], db), 'SLICE2');
  assert.equal(siteKind(d.insts[1], db), 'IOB2');
  const { feats, luts } = designFeatures(d, db);
  const names = feats.map(f => f.feature);
  assert.ok(names.includes('SLICE2:CLKINV:CLK_B'));
  assert.ok(names.includes('SLICE2:XORF:'));
  assert.ok(names.includes('SLICE2:USED'));
  assert.ok(!names.some(n => /FFX|_NO_USER/.test(n)));
  assert.ok(names.includes('X0->OMUX0'));
  assert.ok(!names.includes('X0->OMUX9'));
  // LUT F with its 16 bits, LUT G unused: the constant 0
  assert.deepEqual(luts.map(l => l.lut), ['G', 'F']);
  assert.deepEqual(luts[1].bits, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
});

test('bidirectional PIPs take the direction away from the driven wire', () => {
  const net = { pips: [{ tile: 'T', from: 'W2MID4', dir: '->', to: 'BY3' }, { tile: 'T', from: 'BX1', dir: '=-', to: 'BY3' }, { tile: 'T', from: 'BX0', dir: '=-', to: 'BY1' }] };
  assert.deepEqual(pipFeatures(net), ['W2MID4->BY3', 'BY3->BX1', 'BX0=-BY1']);
});

test('frame data: defaults, features at tile offsets, LUTs stored inverted, unknown features listed', () => {
  const db = tiny();
  const { frames, unknown } = frameData(parseXdl(design), db);
  assert.equal(getBit(frames, FW, 3, 37), 1);              // default bit
  assert.equal(getBit(frames, FW, 16, 128), 1);            // X0->OMUX0 at 6,28
  assert.equal(getBit(frames, FW, 17, 101), 1);            // OMUX0->E2BEG0 7,1 (and 8,2 cleared)
  assert.equal(getBit(frames, FW, 15, 126), 1);            // CLKINV:CLK_B 5,26
  assert.equal(getBit(frames, FW, 13, 2256 + 69), 1);      // IOB2 LVCMOS33 at the I/O tile
  // LUT F of SLICE_X1Y0: frame 13 from bit 148, address order, inverted (D=A1: even addresses 1)
  for (let a = 0; a < 16; a++) assert.equal(getBit(frames, FW, 13, 148 + a), a & 1 ? 0 : 1);
  // LUT G (unused): the 16 bits before, all 1
  for (let a = 0; a < 16; a++) assert.equal(getBit(frames, FW, 13, 132 + a), 1);
  assert.deepEqual(unknown.map(u => u.feature).sort(), ['IOB2:PULL:PULLUP', 'IOB2:USED', 'SLICE2:F:#LUT', 'SLICE2:XORF:'].sort());
});

test('bitgen: a complete .bit file whose frame data is the design', () => {
  const db = tiny();
  const { bytes } = bitgen(design, db, { name: 't.ncd', date: '2026/10/10', time: '10:00:00', crc: false });
  const r = readBit(bytes);
  assert.equal(r.header.a, 't.ncd');
  assert.deepEqual(diffFrames(frameData(parseXdl(design), db).frames, r.frames), []);
});

// the measured database
const dbDir = new URL('../research/s3e-bitstream/db/', import.meta.url);
const measured = () => {
  const read = f => JSON.parse(fs.readFileSync(new URL(f, dbDir), 'utf8'));
  return makeDb({ layout: read('xc3s250e-layout.json'), lut: read('xc3s250e-lut.json').lutF, tiles: read('xc3s250e-tiles.json') });
};

test('measured database: a LUT and a slice setting where stage A and B found them', () => {
  const db = measured();
  const d = parseXdl(`design "t" xc3s250ecp132-4 v3.2 , cfg "";
inst "s" "SLICEL",placed CLB_X16Y24 SLICE_X31Y47 ,
  cfg " F:s_f:#LUT:D=(A1*A2*A3*A4) CLKINV::CLK_B "
  ;`);
  const { frames } = frameData(d, db);
  // LUT F of SLICE_X31Y47: frame 236, bits 736-751, inverted: only address 15 is 1 (stored 0)
  for (let a = 0; a < 16; a++) assert.equal(getBit(frames, FW, 236, 736 + a), a === 15 ? 0 : 1);
  // the clock inverter of an upper SLICEL: 2 frames after its LUT frame, at the LUT's first bit
  assert.equal(getBit(frames, FW, 238, 736), 1);
});

test('measured database: the routing switches of a route are known', () => {
  const db = measured();
  const d = parseXdl(`design "t" xc3s250ecp132-4 v3.2 , cfg "";
net "n" ,
  outpin "a" X ,
  inpin "b" F2 ,
  pip CLB_X8Y24 X0 -> OMUX6 ,
  pip CLB_X8Y24 OMUX6 -> S2BEG2 ,
  pip CLB_X8Y24 F2_B0 -> F2_B_PINWIRE0 ,
  ;`);
  const { unknown } = frameData(d, db);
  assert.deepEqual(unknown, []);
});
