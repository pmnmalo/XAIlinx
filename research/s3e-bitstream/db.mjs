// Loads the bit database (db/*.json) for core/fpga/bitgen.js (Node).
import fs from 'node:fs';
import { makeDb } from '../../core/fpga/bitgen.js';

const read = f => { const u = new URL(`./db/${f}`, import.meta.url); return fs.existsSync(u) ? JSON.parse(fs.readFileSync(u, 'utf8')) : null; };
export function loadDb() {
  return makeDb({ layout: read('xc3s250e-layout.json'), lut: read('xc3s250e-lut.json').lutF, tiles: read('xc3s250e-tiles.json') || { types: {} } });
}
