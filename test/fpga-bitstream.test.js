// core/fpga/bitstream.js: .bit files for the Spartan-3E (packets, CRC, header), without ISE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { XC3S250E, crcUpdate, corValue, writeBit, readBit, setBit, getBit, diffFrames, REG } from '../core/fpga/bitstream.js';

const emptyFrames = () => new Uint32Array(XC3S250E.frames * XC3S250E.frameWords);

test('bits of a frame: the first bit is the most significant bit of the first word', () => {
  const f = emptyFrames(), fw = XC3S250E.frameWords;
  setBit(f, fw, 2, 0);
  setBit(f, fw, 2, 33);
  assert.equal(f[2 * fw], 0x80000000);
  assert.equal(f[2 * fw + 1], 0x40000000);
  assert.equal(getBit(f, fw, 2, 33), 1);
  setBit(f, fw, 2, 33, 0);
  assert.equal(getBit(f, fw, 2, 33), 0);
  assert.deepEqual(diffFrames(emptyFrames(), f), [{ frame: 2, bit: 0, value: 1 }]);
});

test('COR: the values bitgen writes (CRC off / JTAG startup clock)', () => {
  assert.equal(corValue({ crc: false }), 0x200031e5);
  assert.equal(corValue({ crc: true, startupClk: 'JtagClk' }), 0x000131e5);
  assert.equal(corValue({}), 0x000031e5);
});

test('CRC: writing the CRC itself (register 0) brings it back to 0', () => {
  let c = 0;
  for (const [r, w] of [[REG.FLR, 0x48], [REG.COR, 0x31e5], [REG.IDCODE, XC3S250E.idcode], [REG.FDRI, 0xdeadbeef]]) c = crcUpdate(c, r, w);
  assert.notEqual(c, 0);
  assert.equal(crcUpdate(c, REG.CRC, c), 0);
});

test('writeBit / readBit: header, packets, frame data and CRC checks', () => {
  const f = emptyFrames();
  setBit(f, XC3S250E.frameWords, 100, 1234);
  const bytes = writeBit({ frames: f, name: 'top.ncd', date: '2026/10/10', time: '12:34:56', crc: true });
  const r = readBit(bytes);
  assert.deepEqual(r.header, { a: 'top.ncd', b: '3s250ecp132', c: '2026/10/10', d: '12:34:56' });
  assert.equal(r.cor, 0x000031e5);
  assert.deepEqual(diffFrames(f, r.frames), []);
  assert.equal(r.crcChecks.length, 2);
  for (const c of r.crcChecks) assert.equal(c.expected, c.computed);
  // the length in the header (field e) is the number of bytes that follow it
  const e = bytes.indexOf(0x65, 40);
  const len = (bytes[e + 1] << 24) | (bytes[e + 2] << 16) | (bytes[e + 3] << 8) | bytes[e + 4];
  assert.equal(len, bytes.length - e - 5);
  // packets in bitgen's order
  assert.deepEqual(r.packets.map(p => p.reg).slice(0, 10), ['CMD', 'FLR', 'COR', 'IDCODE', 'MASK', 'CMD', 'FAR', 'CMD', 'FDRI', 'FDRI']);
});

test('writeBit with the CRC off writes the fixed check value DEFC', () => {
  const r = readBit(writeBit({ frames: emptyFrames(), crc: false }));
  assert.deepEqual(r.crcChecks.map(c => c.expected), [0xdefc, 0xdefc]);
  assert.equal(r.cor, 0x200031e5);
});

test('writeBit refuses frame data of the wrong size', () => {
  assert.throws(() => writeBit({ frames: new Uint32Array(10) }), /frame data/);
});
