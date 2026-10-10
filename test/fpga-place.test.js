// The placer (core/fpga/place.js) and the XDL writer (core/fpga/xdl-write.js), on a small made-up
// device (test/fixtures/fpga/place-device.xdlrc, from research/s3e-place/gen-test-device.mjs):
// legal placements (one instance per site, LOCs kept, carry chains up one column, wide multiplexers
// in their CLB pattern), wirelength going down, the same seed giving the same placement, and the
// placed XDL reading back through core/xdl.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXdlrc, parseXdl } from '../core/xdl.js';
import { readYosysJson } from '../core/fpga/netlist.js';
import { pack } from '../core/fpga/pack.js';
import { deviceSites, place, placedXdl, PlaceError, rng } from '../core/fpga/place.js';
import { writeXdl } from '../core/fpga/xdl-write.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fpga');
const load = n => readYosysJson(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));
const dev = deviceSites(parseXdlrc(fs.readFileSync(path.join(FIX, 'place-device.xdlrc'), 'utf8')));
const xy = s => { const m = /^SLICE_X(\d+)Y(\d+)$/.exec(s); return m ? [+m[1], +m[2]] : null; };

test('the device: slices with positions, bonded pads, clock buffers', () => {
  assert.equal(dev.slices.size, 140);   // 6 x 6 CLBs, one missing
  assert.ok(dev.slices.has('0,0') && !dev.slices.has('4,6'));
  assert.equal(dev.slices.get('3,5').name, 'SLICE_X3Y5');
  assert.ok(!dev.pads.has('NOPAD20'));
  assert.ok([...dev.pads.values()].some(p => p.inputOnly));
  assert.equal(dev.bufgmux.length, 8);
  // positions: slices of one CLB share the tile; y grows upward
  assert.ok(dev.slices.get('0,1').py > dev.slices.get('0,0').py);
  assert.ok(dev.slices.get('1,0').px > dev.slices.get('0,0').px);
});

function checkLegal(p, r) {
  const used = new Set();
  r.sites.forEach((s, i) => {
    assert.ok(!used.has(s.site), `site ${s.site} used twice`);
    used.add(s.site);
    const inst = p.insts[i];
    if (inst.kind === 'slice') assert.match(s.site, /^SLICE_/);
    if (inst.kind === 'iob') { assert.ok(dev.pads.has(s.site), `${inst.name} on ${s.site}`); if (inst.loc) assert.equal(s.site, inst.loc); if (inst.dir === 'out') assert.ok(!dev.pads.get(s.site).inputOnly); }
    if (inst.kind === 'bufg') assert.match(s.site, /^BUFGMUX_/);
  });
  // every group keeps its shape
  for (const m of p.macros) {
    const [x0, y0] = xy(r.sites[m.members[0].inst].site);
    const ax = x0 - m.members[0].dx, ay = y0 - m.members[0].dy;
    for (const x of m.members) assert.deepEqual(xy(r.sites[x.inst].site), [ax + x.dx, ay + x.dy], `${m.kind} shape`);
    if (m.align) { assert.equal(ax % m.align[0], 0, `${m.kind} column`); assert.equal(ay % m.align[1], 0, `${m.kind} row`); }
  }
}

test('counter: a legal placement, LOCs kept, wirelength reduced, same seed same result', () => {
  const ucf = 'NET "clk" LOC = "P3";\nNET "q<0>" LOC = "P10";\nNET "rst" LOC = "P5";';
  const p = pack(load('counter'), { ucf });
  const r = place(p, dev, { seed: 3 });
  checkLegal(p, r);
  assert.ok(r.cost < r.stats.initialCost, `cost ${r.stats.initialCost} -> ${r.cost}`);
  assert.equal(r.sites[p.insts.findIndex(i => i.name === 'clk')].site, 'P3');
  // the clock buffer: on the edge of the pad that drives it (P3 is on the top edge)
  assert.equal(r.sites[p.insts.findIndex(i => i.kind === 'bufg')].site, 'BUFGMUX_X2Y11');
  const again = place(p, dev, { seed: 3 });
  assert.deepEqual(again.sites, r.sites);
  assert.equal(again.cost, r.cost);
  const other = place(p, dev, { seed: 4 });
  checkLegal(p, other);
});

test('mux64: the two-CLB F8 group and the F7 / F6 groups keep their pattern; chains avoid the hole', () => {
  const p = pack(load('mux64'));
  const r = place(p, dev, { seed: 1, effort: 0.3 });
  checkLegal(p, r);
  const q = pack(load('counter'));
  for (let s = 1; s <= 4; s++) checkLegal(q, place(q, dev, { seed: s, effort: 0.2 }));
});

test('placement errors: unknown LOC, input-only pad for an output, too many slices', () => {
  assert.throws(() => place(pack(load('sw'), { ucf: 'NET "sw" LOC = "Z99";' }), dev), e => e instanceof PlaceError && /Z99/.test(e.message));
  const inOnly = [...dev.pads.values()].find(p => p.inputOnly).name;
  assert.throws(() => place(pack(load('sw'), { ucf: `NET "led" LOC = "${inOnly}";` }), dev), /input-only/);
  const big = pack(load('mux64'));
  const small = deviceSites(parseXdlrc(fs.readFileSync(path.join(FIX, 'place-device.xdlrc'), 'utf8')));
  for (const k of [...small.slices.keys()].slice(0, 100)) small.slices.delete(k);
  assert.throws(() => place(big, small), /slices needed|no room/);
});

test('placed XDL: written, read back by core/xdl.js with the same instances, sites, settings and nets', () => {
  const p = pack(load('counter'), { ucf: 'NET "clk" LOC = "P3";' });
  const r = place(p, dev, { seed: 2, effort: 0.2 });
  const d = placedXdl(p, r);
  const text = writeXdl(d);
  assert.match(text, /^design "counter" xc3s250ecp132-4 v3\.2 ,$/m);
  const back = parseXdl(text);
  assert.equal(back.name, 'counter');
  assert.equal(back.part, 'xc3s250ecp132-4');
  assert.deepEqual(back.insts.map(i => [i.name, i.type, i.placed, i.tile, i.site]), d.insts.map(i => [i.name, i.type, true, i.tile, i.site]));
  assert.deepEqual(back.insts.map(i => i.cfg), d.insts.map(i => i.cfg.map(c => ({ attr: c.attr, name: c.name, value: c.value }))));
  assert.deepEqual(back.nets.map(n => [n.name, n.type, n.outpins, n.inpins]), d.nets.map(n => [n.name, n.type, n.outpins, n.inpins]));
  // the ports' bus information in the design's cfg (raw XDL text: the parser reads it unescaped)
  assert.match(text, /_DESIGN_PROP::PIN_INFO:q<0>:\/counter\/PACKED\/counter\/q<0>\/q<0>\/PAD:OUTPUT:7:q<7\\:0>/);
  assert.equal(back.cfg, d.cfg.replace(/\\:/g, ':'));
  // and written again: the same text
  assert.equal(writeXdl({ ...back, cfg: d.cfg }), text);
});

test('the random generator is deterministic and uniform enough', () => {
  const a = rng(5), b = rng(5);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
  assert.ok(xs.every(x => x >= 0 && x < 1));
});
