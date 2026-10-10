// Silinx - the device routing graph cache, Node side (the only Node-only part of core/fpga).
//
// The graph is built once per user from the device report of their own ISE installation
// (never shipped: see docs/OPEN-TOOLCHAIN.md), then cached as gzipped JSON:
//
//   xdl -report -pips -all_conns xc3s250ecp132-4 dev-full.xdlrc
//   node bin/... or research/s3e-route/build-device.mjs dev-full.xdlrc
//     -> ~/.silinx/devices/xc3s250ecp132-4.json.gz   (SILINX_CONFIG_DIR overrides ~/.silinx)
//
// The browser loads the same file with fetch + DecompressionStream('gzip') + JSON.parse + loadDevice().

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { DeviceBuilder, loadDevice } from './device.js';

/** Folder of the device caches. */
export function devicesDir() {
  return path.join(process.env.SILINX_CONFIG_DIR || path.join(os.homedir(), '.silinx'), 'devices');
}

/** Default cache file of a part (e.g. 'xc3s250ecp132-4'). */
export function deviceCachePath(part) { return path.join(devicesDir(), `${part}.json.gz`); }

/** Stream-parse a device report file into the packed graph (the report is ~200 MB: never read whole). */
export async function packDeviceFile(xdlrcPath) {
  const b = new DeviceBuilder();
  const rl = readline.createInterface({ input: fs.createReadStream(xdlrcPath), crlfDelay: Infinity });
  for await (const l of rl) { b.line(l); if (b.done) { rl.close(); break; } }
  return b.finish();
}

/** Build the cache from a report; returns { path, packed, bytes }. */
export async function buildDeviceCache(xdlrcPath, outPath = null) {
  const packed = await packDeviceFile(xdlrcPath);
  const out = outPath || deviceCachePath(packed.part);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const gz = zlib.gzipSync(JSON.stringify(packed), { level: 9 });
  fs.writeFileSync(out, gz);
  return { path: out, packed, bytes: gz.length };
}

/** Load a cache file (a part name or a path) into a Device. */
export function loadDeviceCache(partOrPath) {
  const f = /[\\/]|\.gz$|\.json$/.test(partOrPath) ? partOrPath : deviceCachePath(partOrPath);
  let buf = fs.readFileSync(f);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return loadDevice(JSON.parse(buf.toString('utf8')));
}
