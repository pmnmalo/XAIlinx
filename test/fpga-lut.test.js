// LUT contents both ways (core/fpga/lut.js): a cell's INIT <-> the XDL equation of a LUT site, with
// the cell's inputs on any of the site pins A1..A4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initToEquation, equationToInit, initToTable, equationTable } from '../core/fpga/lut.js';
import { evalLut, lutTable } from '../core/xdl.js';

// every function of k inputs (k <= 3) and a sample of the 4-input ones, on every pin assignment
const perms = a => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p])));
const bin = (v, w) => v.toString(2).padStart(w, '0');

test('INIT -> equation -> INIT is the identity, for every pin assignment', () => {
  for (let k = 1; k <= 4; k++) {
    const n = 1 << k;
    const inits = k <= 3 ? Array.from({ length: 1 << n }, (_, v) => v) : [0, 0xffff, 0x8000, 0x6996, 0xcafe, 0x1234, 0xe8e8, 0x00ff, 0xf0f0, 0x5555];
    // the cell's inputs on k of the four pins, in every order
    const pinSets = perms([1, 2, 3, 4]).map(p => p.slice(0, k));
    for (const v of inits) for (const pins of pinSets) {
      const init = bin(v, n);
      const eq = initToEquation(init, k, pins);
      assert.match(eq, /^D=/);
      assert.equal(equationToInit(eq, k, pins), init, `k=${k} INIT=${init} pins=${pins} eq=${eq}`);
    }
  }
});

test('the equation only uses the pins the function depends on, in XDL syntax', () => {
  assert.equal(initToEquation('10', 1), 'D=A1');                 // buffer
  assert.equal(initToEquation('01', 1), 'D=~A1');                // inverter (Yosys INV)
  assert.equal(initToEquation('1000', 2), 'D=(A2*A1)');          // AND
  assert.equal(initToEquation('0110', 2), 'D=(A2@A1)');          // XOR
  assert.equal(initToEquation('1110', 2), 'D=(A2+A1)');          // OR
  assert.equal(initToEquation('0000', 2), 'D=0');                // constant
  assert.equal(initToEquation('1111', 2), 'D=1');
  assert.equal(initToEquation('10', 1, [3]), 'D=A3');            // input I0 on pin A3
  // a 3-input LUT that ignores I1: A2 does not appear
  const eq = initToEquation('11110000', 3);
  assert.equal(eq, 'D=A3');
  // the multiplexer that replaces a MUXF (O = I2 ? I1 : I0)
  const mux = initToEquation('11001010', 3);
  for (let a = 0; a < 8; a++) assert.equal(evalLut(mux, { A1: a & 1, A2: (a >> 1) & 1, A3: (a >> 2) & 1 }), (a & 4) ? (a >> 1) & 1 : a & 1);
});

test('the equation agrees with core/xdl.js lutTable (INIT as ISE writes it)', () => {
  for (const v of [0x0001, 0x8000, 0x6996, 0xfe01, 0x7350]) {
    const init = bin(v, 16);
    const eq = initToEquation(init, 4);
    assert.equal(lutTable(eq).init, v.toString(16).toUpperCase().padStart(4, '0'));
    assert.deepEqual(equationTable(eq), initToTable(init, 4));
  }
});

test('equations ISE wrote parse back to the same INIT', () => {
  // from xdl -ncd2xdl of designs implemented by ISE
  const eq = 'D=((~A3*~A1)+(A3*(~A2+~A4)))';
  const init = equationToInit(eq, 4);
  assert.equal(equationToInit(initToEquation(init, 4), 4), init);
  assert.equal(equationToInit('D=A2', 2, [2, 1]), '1010');   // I0 on A2: O = I0
});
