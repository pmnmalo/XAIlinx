// core/fpga/bitgen.js: XDL -> features -> frame data -> .bit, with a small hand-made database and
// with the measured database (research/s3e-bitstream/db), without ISE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseXdl } from '../core/xdl.js';
import { makeDb, tileOf, tileBase, designFeatures, pipFeatures, frameData, bitgen, siteKind, padsFromDevice, shiftBit, featureBits } from '../core/fpga/bitgen.js';
import { XC3S250E, readBit, getBit, diffFrames } from '../core/fpga/bitstream.js';

const FW = XC3S250E.frameWords;
// a database for two tiles: CLB_X1Y1 (frames 10-28, bits 100-163) and BIOIS_X1Y0
const tiny = () => makeDb({
  layout: { frameWords: 73, frames: 578, brkRows: [9], cols: { 1: 10, 2: 40 }, rows: { 1: 100, 0: 2256 }, defaults: [[3, 37]] },
  lut: { colFrame: { 0: 10, 1: 13 }, rowBit: { 0: 148, 1: 116 } },
  pads: { P11: ['BIOIS_X1Y0', 2] },   // (from the device: padsFromDevice)
  tiles: {
    padFeatures: { P11: { 'I:LVCMOS33': ['500,2300'] } },
    types: {
      CENTER_SMALL: { features: { 'X0->OMUX0': ['6,28'], 'OMUX0->E2BEG0': ['7,1', '!8,2'], 'BX1->BY3': ['10,31'], 'BY3->BX1': [], 'SLICE2:CLKINV:CLK_B': ['5,26'], 'SLICE2:USED': [] } },
      CENTER_SMALL_BRK: { sameAs: 'CENTER_SMALL', features: { 'X0->OMUX0': ['6,29'] } },
      BIOIS: { features: { 'IOB2:IOATTRBOX:LVCMOS33': ['3,69', '5,70@1,0'] } },
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

test('tile types share a switch box at an offset of frames and bits', () => {
  assert.equal(shiftBit('6,28', 2, 0), '8,28');
  assert.equal(shiftBit('!8,2', 0, 16), '!8,18');
  assert.equal(shiftBit('5,70@1,0', 2, 16), '7,86@1,0');
  const db = makeDb({
    layout: { cols: { 0: 3 }, rows: { 5: 100 } },
    lut: {},
    tiles: { types: {
      CENTER_SMALL: { features: { 'X0->OMUX0': ['6,28'], 'OMUX0->E2BEG0': ['7,1', '!8,2'] } },
      LIOIS: { sameAs: 'CENTER_SMALL', shift: [2, 0], rename: [['IOIS_VCC_WIRE', 'VCC_PINWIRE'], ['IOIS_', '']], features: { 'IOIS_Y0->OMUX0': ['1,1'] } },
      TIOIS: { sameAs: 'CENTER_SMALL', shift: [0, 16], features: { 'X0->OMUX0': ['6,99'] } },
    } },
  });
  assert.deepEqual(db.types.LIOIS.feats.get('OMUX0->E2BEG0'), ['9,1', '!10,2']);
  assert.deepEqual(db.types.LIOIS.feats.get('IOIS_Y0->OMUX0'), ['1,1']);
  // the type's own wire names: IOIS_X0 is the CLB's X0 (own measurements first)
  assert.deepEqual(featureBits(db.types.LIOIS, 'IOIS_X0->OMUX0'), ['8,28']);
  assert.deepEqual(featureBits(db.types.LIOIS, 'IOIS_Y0->OMUX0'), ['1,1']);
  assert.equal(featureBits(db.types.LIOIS, 'IOIS_X1->OMUX0'), undefined);
  assert.equal(featureBits(db.types.TIOIS, 'IOIS_X0->OMUX0'), undefined);   // no renaming there
  // the type's own measurement first; the shared type is unchanged
  assert.deepEqual(db.types.TIOIS.feats.get('X0->OMUX0'), ['6,99']);
  assert.deepEqual(db.types.TIOIS.feats.get('OMUX0->E2BEG0'), ['7,17', '!8,18']);
  assert.deepEqual(db.types.CENTER_SMALL.feats.get('OMUX0->E2BEG0'), ['7,1', '!8,2']);
  // in the frame data: LIOIS_X0Y5 starts at frame 3, bit 100
  const d = parseXdl(`design "t" xc3s250ecp132-4 v3.2 , cfg "";
net "n" ,
  outpin "a" X ,
  inpin "b" F1 ,
  pip LIOIS_X0Y5 X0 -> OMUX0 ,
  ;`);
  const { frames, unknown } = frameData(d, db);
  assert.deepEqual(unknown, []);
  assert.equal(getBit(frames, FW, 3 + 8, 128), 1);
});

test('a SLICEM site holding a SLICEM instance has a feature of its own', () => {
  const db = tiny();
  const d = parseXdl(`design "t" xc3s250ecp132-4 v3.2 , cfg "";
inst "m" "SLICEM",placed CLB_X1Y1 SLICE_X0Y0 ,
  cfg " _NO_USER_LOGIC:: _GND_SOURCE::Y "
  ;
inst "l" "SLICEL",placed CLB_X1Y1 SLICE_X0Y1 ,
  cfg " F:l_f:#LUT:D=A1 FXMUX::F XUSED::0 "
  ;`);
  const names = designFeatures(d, db).feats.map(f => f.feature);
  assert.ok(names.includes('SLICE0:SLICEM'));
  assert.ok(names.includes('SLICE0:_GND_SOURCE:Y'));
  assert.ok(names.includes('SLICE1:USED'));
  assert.ok(!names.includes('SLICE1:SLICEM'));
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
  assert.equal(getBit(frames, FW, 45, 2256 + 70), 1);      // and in the column of the tile at x + 1
  // LUT F of SLICE_X1Y0: frame 13 from bit 148, address order, inverted (D=A1: even addresses 1)
  for (let a = 0; a < 16; a++) assert.equal(getBit(frames, FW, 13, 148 + a), a & 1 ? 0 : 1);
  // LUT G (unused): the 16 bits before, all 1
  for (let a = 0; a < 16; a++) assert.equal(getBit(frames, FW, 13, 132 + a), 1);
  assert.deepEqual(unknown.map(u => u.feature).sort(), ['IOB2:PULL:PULLUP', 'IOB2:USED', 'SLICE2:F:#LUT', 'SLICE2:FXMUX:#OFF', 'SLICE2:XORF:'].sort());
  // the pad's own setting (absolute bits)
  assert.equal(getBit(frames, FW, 500, 2300), 1);
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

test('padsFromDevice: the bonded I/O sites of the device, by their index among the I/O sites of the tile', () => {
  // a synthetic device in the form of core/fpga/device.js: an I/O tile with other sites first, an
  // unbonded pad, and an input-only pad; a CLB tile
  const device = {
    tileNames: ['TIOIS_X1Y35', 'CLB_X1Y1'],
    tileTemplate: [0, 1],
    templates: [{ sites: [{ type: 'VCC' }, { type: 'RESERVED_LL' }, { type: 'DIFFM' }, { type: 'DIFFS' }, { type: 'IOB' }, { type: 'IBUF' }] }, { sites: [{ type: 'SLICEM' }] }],
    tileSites: [[['VCC_X2Y37', 0], ['RLL_X1Y35', 0], ['A3', 1], ['B3', 1], ['NOPAD0', 2], ['C4', 1]], [['SLICE_X0Y0', 0]]],
    siteIndex: new Map([['VCC_X2Y37', [0, 0]], ['RLL_X1Y35', [0, 1]], ['A3', [0, 2]], ['B3', [0, 3]], ['NOPAD0', [0, 4]], ['C4', [0, 5]], ['SLICE_X0Y0', [1, 0]]]),
  };
  assert.deepEqual(padsFromDevice(device), { A3: ['TIOIS_X1Y35', 0], B3: ['TIOIS_X1Y35', 1], C4: ['TIOIS_X1Y35', 3] });
  // the committed database has no pad table (it comes from the user's device report)
  const tiles = JSON.parse(fs.readFileSync(new URL('../research/s3e-bitstream/db/xc3s250e-tiles.json', import.meta.url), 'utf8'));
  assert.equal(tiles.pads, undefined);
});
