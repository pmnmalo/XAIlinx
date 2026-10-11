// Loads the bit database (db/*.json) for core/fpga/bitgen.js (Node), with the pads of the device
// from the device cache built from this machine's ISE (core/fpga/device-node.js).
import fs from 'node:fs';
import { makeDb, padsFromDevice } from '../../core/fpga/bitgen.js';
import { loadDeviceCache } from '../../core/fpga/device-node.js';

const read = f => { const u = new URL(`./db/${f}`, import.meta.url); return fs.existsSync(u) ? JSON.parse(fs.readFileSync(u, 'utf8')) : null; };
export function loadDb() {
  return makeDb({ layout: read('xc3s250e-layout.json'), lut: read('xc3s250e-lut.json').lutF, tiles: read('xc3s250e-tiles.json') || { types: {} },
    pads: padsFromDevice(loadDeviceCache('xc3s250ecp132-4')), bram: read('xc3s250e-bram.json') });
}
