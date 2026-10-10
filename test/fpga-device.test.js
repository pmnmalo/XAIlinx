// core/fpga/device.js: the routing graph from the device report (xdl -report -pips -all_conns).
// Fixture: test/fixtures/fpga/route-device.xdlrc (hand-made, in the format of ISE 14.7's xdl; the
// real report is ~200 MB and comes from the user's own ISE installation, so it is never used here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packDevice, loadDevice, DeviceBuilder, toBase64, fromBase64, PIP_ROUTETHRU, PIP_BIDI, DEVICE_FORMAT_VERSION } from '../core/fpga/device.js';
import { buildDeviceCache, loadDeviceCache, packDeviceFile } from '../core/fpga/device-node.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fpga');
const RC = path.join(FIX, 'route-device.xdlrc');
const TEXT = fs.readFileSync(RC, 'utf8');

test('packDevice: part, grid, counts; identical tiles share one template', () => {
  const p = packDevice(TEXT);
  assert.equal(p.format, 'silinx-device');
  assert.equal(p.version, DEVICE_FORMAT_VERSION);
  assert.deepEqual([p.part, p.family, p.rows, p.cols], ['xc3s50etq144-4', 'spartan3e', 2, 3]);
  assert.equal(p.counts.tiles, 6);
  assert.equal(p.counts.pips, 4 + 2 + 27 + 27);
  assert.equal(p.counts.wires, 7 + 4 + 30 + 30);
  // EMPTY_CNR, CLKT, TTERM, LIOIS, and one CENTER_SMALL template for both CLBs
  assert.equal(p.counts.templates, 5);
  assert.equal(p.tiles[4][3], p.tiles[5][3], 'CLB_X1Y0 and CLB_X2Y0 use the same template');
  assert.deepEqual(p.routethrus, ['_ROUTETHROUGH-I0-O BUFGMUX', '_ROUTETHROUGH-COUT-X SLICEL', '_ROUTETHROUGH-F1-X SLICEL']);
});

test('nodes: wires joined by metal across tiles are one node; the others are nodes of their own', () => {
  const d = loadDevice(packDevice(TEXT));
  assert.equal(d.node('CLB_X1Y0', 'E2BEG0'), d.node('CLB_X2Y0', 'E2END0'));
  assert.equal(d.node('CLB_X1Y0', 'E2END0'), d.node('LIOIS_X0Y0', 'IOIS_E0'));
  assert.notEqual(d.node('CLB_X1Y0', 'E2BEG0'), d.node('CLB_X1Y0', 'E2BEG1'));
  const g = d.node('CLKT_X1Y1', 'CLKT_GCLK_SPINE0');
  assert.deepEqual(d.nodeNames(g).map(x => `${x.tile}/${x.name}`).sort(), ['CLB_X1Y0/GCLK0', 'CLB_X2Y0/GCLK0', 'CLKT_X1Y1/CLKT_GCLK_SPINE0']);
  assert.equal(d.node('CLB_X1Y0', 'NOWIRE'), -1);
  assert.equal(d.node('NOTILE', 'X0'), -1);
  // 71 wires; joined: E2BEG0/E2END0, E2BEG1/E2END1, IOIS_E0/E2END0, IOIS_W2END0/W2BEG0, W2END0/W2BEG0, GCLK x3 (2), CLKT_OUT0/S2END0
  assert.equal(d.nodeCount, 71 - 8);
  // the bounding box of a node spans its tiles
  assert.deepEqual([d.nodeR0[g], d.nodeR1[g], d.nodeC0[g], d.nodeC1[g]], [0, 1, 1, 2]);
});

test('sites and pins: the tile wire of each site pin, its node, bonded pads, sites by type', () => {
  const d = loadDevice(packDevice(TEXT));
  assert.deepEqual(d.sitePin('SLICE_X1Y1', 'F1'), { tile: 5, tileName: 'CLB_X2Y0', wire: 'F1_B_PINWIRE1', wireId: d.wireId(5, 'F1_B_PINWIRE1'), dir: 'i' });
  assert.equal(d.sitePin('SLICE_X0Y0', 'X').dir, 'o');
  assert.equal(d.sitePinNode('BUFGMUX_X1Y1', 'O'), d.node('CLKT_X1Y1', 'CLKT_GCLK_PINWIRE0'));
  assert.equal(d.sitePin('SLICE_X0Y0', 'NOPIN'), null);
  assert.equal(d.site('NOSITE'), null);
  assert.equal(d.site('P1').bonded, 1);
  assert.equal(d.site('SLICE_X0Y0').type, 'SLICEL');
  assert.deepEqual(d.sites('SLICEL').map(s => s.name), ['SLICE_X0Y0', 'SLICE_X0Y1', 'SLICE_X1Y0', 'SLICE_X1Y1']);
  assert.deepEqual(d.sites('VCC').map(s => s.tileName), ['CLB_X1Y0', 'CLB_X2Y0']);
});

test('PIPs: lookup, the PIPs leaving a node, route-throughs flagged, bidirectional PIPs written one way', () => {
  const d = loadDevice(packDevice(TEXT));
  const k = d.tile('CLB_X1Y0');
  const i = d.findPip(k, 'OMUX1', 'E2BEG1');
  assert.ok(i >= 0);
  assert.deepEqual(d.pip(k, i), { tile: 'CLB_X1Y0', from: 'OMUX1', dir: '->', to: 'E2BEG1', routethru: null });
  assert.deepEqual(d.pipNodes(k, i), [d.node(k, 'OMUX1'), d.node('CLB_X2Y0', 'E2END1')]);
  assert.equal(d.findPip(k, 'E2BEG1', 'OMUX1'), -1);
  const out = [];
  d.forEachPip(d.node(k, 'OMUX1'), (to, tile, pip, flags) => out.push([d.nodeName(to), d.tileName(tile), flags]));
  assert.deepEqual(out.map(x => x[0]).sort(), ['CLB_X1Y0/E2BEG0', 'CLB_X1Y0/E2BEG1']);
  // route-through: through the LUT of the slice
  const rt = d.findPip(k, 'F1_B_PINWIRE0', 'X0');
  assert.equal(d.pip(k, rt).routethru, '_ROUTETHROUGH-F1-X SLICEL');
  assert.ok(d.templates[d.tileTemplate[k]].flags[rt] & PIP_ROUTETHRU);
  // a bidirectional PIP is listed both ways; both are written "BX0 =- BX1" (the lower number first)
  const b1 = d.findPip(k, 'BX1', 'BX0'), b0 = d.findPip(k, 'BX0', 'BX1');
  assert.ok(d.pipIsBidi(k, b1) && d.templates[d.tileTemplate[k]].flags[b0] & PIP_BIDI);
  assert.deepEqual([d.pip(k, b1).from, d.pip(k, b1).dir, d.pip(k, b1).to], ['BX0', '=-', 'BX1']);
  assert.deepEqual([d.pip(k, b0).from, d.pip(k, b0).to], ['BX0', 'BX1']);
  assert.deepEqual(d.pipNodes(k, b1), [d.node(k, 'BX1'), d.node(k, 'BX0')]);
  // the node-level edge arrays: one edge per PIP
  const e = d.routingEdges();
  assert.equal(e.edgeTo.length, d.pipCount);
  assert.equal(e.edgeStart.length, d.nodeCount + 1);
  assert.strictEqual(d.routingEdges(), e, 'built once');
});

test('the packed graph survives JSON (the cache format) and is rejected when it is not one', () => {
  const p = packDevice(TEXT);
  const d1 = loadDevice(p), d2 = loadDevice(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(Array.from(d2.nodeOf), Array.from(d1.nodeOf));
  assert.deepEqual(d2.nodeNames(d2.node('CLB_X1Y0', 'GCLK0')), d1.nodeNames(d1.node('CLB_X1Y0', 'GCLK0')));
  assert.throws(() => loadDevice({ format: 'other' }), /not a Silinx device graph/);
  assert.throws(() => loadDevice({ ...p, version: 999 }), /rebuild the cache/);
});

test('the builder stops at the site definitions and fails on a conn to a tile that is not described', () => {
  const b = new DeviceBuilder();
  for (const l of TEXT.split('\n')) b.line(l);
  assert.equal(b.done, true);
  const bad = TEXT.replace('(conn CLB_X1Y0 S2END0)', '(conn CLB_X9Y9 S2END0)');
  assert.throws(() => packDevice(bad), /CLB_X9Y9/);
  const bad2 = TEXT.replace('(conn CLB_X1Y0 S2END0)', '(conn CLB_X1Y0 NOWIRE)');
  assert.throws(() => packDevice(bad2), /NOWIRE/);
});

test('base64: round trip of bytes of every length (no Buffer or btoa needed in the browser)', () => {
  for (let n = 0; n < 20; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) & 255);
    assert.deepEqual(Array.from(fromBase64(toBase64(b))), Array.from(b));
  }
  assert.equal(toBase64(new Uint8Array([77, 97, 110])), 'TWFu');
  assert.throws(() => fromBase64('a*b'), /bad base64/);
});

test('device-node: the cache is built from the report file, gzipped, and loads back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silinx-dev-'));
  try {
    const p = await packDeviceFile(RC);
    assert.equal(p.counts.pips, 60);
    const out = path.join(dir, 'x.json.gz');
    const r = await buildDeviceCache(RC, out);
    assert.equal(r.path, out);
    assert.ok(r.bytes > 100);
    const d = loadDeviceCache(out);
    assert.equal(d.part, 'xc3s50etq144-4');
    assert.equal(d.node('CLB_X1Y0', 'E2BEG0'), d.node('CLB_X2Y0', 'E2END0'));
    // by part name, from SILINX_CONFIG_DIR/devices
    const old = process.env.SILINX_CONFIG_DIR;
    process.env.SILINX_CONFIG_DIR = dir;
    try {
      const r2 = await buildDeviceCache(RC);
      assert.equal(r2.path, path.join(dir, 'devices', 'xc3s50etq144-4.json.gz'));
      assert.equal(loadDeviceCache('xc3s50etq144-4').tileCount, 6);
    } finally { if (old === undefined) delete process.env.SILINX_CONFIG_DIR; else process.env.SILINX_CONFIG_DIR = old; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
