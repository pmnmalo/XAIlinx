// research/s3e-bitstream: helpers of the bit database's experiments (no ISE, no device report), and
// the stage D rules as they are in the committed database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolvePatterns } from '../research/s3e-bitstream/lib.mjs';
import { SHIFTS } from '../research/s3e-bitstream/share-sb.mjs';
import { makeDb, featureBits } from '../core/fpga/bitgen.js';

test('resolvePatterns: a PIP measured with different bits keeps the pattern without artefacts', () => {
  const p = (pat, n) => [pat, new Array(n).fill('T')];
  // a cleared bit: the pin's input multiplexer fell back to another setting when the PIP was removed
  assert.deepEqual(resolvePatterns([p('11,31 12,27 12,28 12,29', 1), p('!11,30 11,31 12,28 12,29', 1)]).map(x => x[0]), ['11,31 12,27 12,28 12,29']);
  // a LUT turned into the constant 0 (16 bits of one LUT block) when its only route was removed
  const lut = Array.from({ length: 16 }, (_, i) => `3,${32 + i}`).join(' ');
  assert.deepEqual(resolvePatterns([p(`${lut} 7,24`, 2), p('7,24', 2)]).map(x => x[0]), ['7,24']);
  // no bits while another tile has them (bits given to a neighbouring tile)
  assert.deepEqual(resolvePatterns([p('', 1), p('14,4 14,5', 1)]).map(x => x[0]), ['14,4 14,5']);
  // nothing to tell apart: both stay
  assert.equal(resolvePatterns([p('1,1', 1), p('2,2', 1)]).length, 2);
});

test('share-sb: every tile type shares the switch box at one offset', () => {
  const all = Object.values(SHIFTS).flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(SHIFTS['2,0'].includes('LIOIS') && SHIFTS['0,16'].includes('TIOIS') && SHIFTS['0,0'].includes('BRAM1_SMALL'));
});

// the committed database
const dbDir = new URL('../research/s3e-bitstream/db/', import.meta.url);
const read = f => JSON.parse(fs.readFileSync(new URL(f, dbDir), 'utf8'));

test('measured database: the I/O, block-RAM and DCM tiles use the CLB switch box', () => {
  const tiles = read('xc3s250e-tiles.json');
  for (const [sh, types] of Object.entries(SHIFTS)) for (const t of types) {
    assert.equal(tiles.types[t]?.sameAs, 'CENTER_SMALL', t);
    assert.deepEqual(tiles.types[t].shift || [0, 0], sh.split(',').map(Number), t);
  }
  const db = makeDb({ layout: read('xc3s250e-layout.json'), lut: read('xc3s250e-lut.json').lutF, tiles });
  const clb = db.types.CENTER_SMALL.feats.get('S2MID4->E2BEG4');
  assert.ok(clb.length);
  assert.deepEqual(db.types.BRAM1_SMALL.feats.get('S2MID4->E2BEG4'), clb);
  assert.deepEqual(db.types.LIOIS.feats.get('S2MID4->E2BEG4'), clb.map(s => s.replace(/^(\d+)/, f => +f + 2)));
  // the I/O tile's own pin wires: IOIS_F1_B0 is the CLB's F1_B0
  assert.ok(db.types.CENTER_SMALL.feats.get('E2END6->F1_B0').length);
  assert.deepEqual(featureBits(db.types.BIOIS, 'E2END6->IOIS_F1_B0'), db.types.CENTER_SMALL.feats.get('E2END6->F1_B0'));
});

test('measured database: the terminal tiles\' PIPs set no bits', () => {
  const tiles = read('xc3s250e-tiles.json');
  const term = Object.entries(tiles.types).filter(([t]) => /TERM/.test(t));
  assert.ok(term.length > 20);
  for (const [t, ty] of term) {
    assert.equal(ty.pipsWithoutBits, true, t);
    assert.ok(!Object.keys(ty.features).some(f => /->/.test(f)), t);
  }
});

test('measured database: SLICEM instances, the constant sources and the carry outputs', () => {
  const f = read('xc3s250e-tiles.json').types.CENTER_SMALL.features;
  assert.deepEqual(f['SLICE0:SLICEM'], ['1,55', '1,57']);
  assert.deepEqual(f['SLICE1:SLICEM'], ['1,23', '1,25']);
  assert.deepEqual(f['SLICE1:_GND_SOURCE:Y'], []);
  assert.deepEqual(f['SLICE3:XBUSED:0'], []);
});
