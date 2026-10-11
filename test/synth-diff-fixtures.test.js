// Differential tests of the open synthesis on test/fixtures/designs/<design> (the designs the netgen
// fixtures were made from): RTL simulated by Silinx and the Yosys netlist (synthesizeOpen), with the
// stimulus of the design's design.json, cycle by cycle (see test/diff-synth.js).
//
// The netlist runs on netlistSim (test/fpga-sim.js) when it models every cell, else (block RAMs,
// DCM, BUFGMUX, tri-state buffers, a second clock) it is Yosys's Verilog netlist simulated by Silinx
// with its primitive models. Note: the latch design is compared on netlistSim; with the primitive
// models its gate (g AND ge, a LUT) closes one delta cycle after a data input that changes at the
// same instant, a zero-delay race of the gate-level simulation (a hold violation in hardware), not
// a difference of the synthesis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSynth } from './diff-synth.js';

const DESIGNS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'designs');
const langOf = f => (/\.(vhd|vhdl)$/i.test(f) ? 'vhdl' : 'verilog');

for (const name of fs.readdirSync(DESIGNS).sort()) {
  const dir = path.join(DESIGNS, name);
  if (!fs.existsSync(path.join(dir, 'design.json'))) continue;
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
  const rd = f => ({ path: f, lang: langOf(f), text: fs.readFileSync(path.join(dir, f), 'utf8') });
  test(`open synthesis vs RTL: ${name}`, { timeout: 120000 }, async () => {
    const sim = { ...spec.sim };
    if (sim.harness) { sim.harness = [rd(sim.harness)]; sim.harnessTop = 'harness'; }
    const r = await diffSynth({ name, sources: spec.files.map(rd), top: spec.top, sim });
    assert.equal(r.status, 'pass', r.report || `${name}: ${r.status} at ${r.stage}: ${r.reason}`);
    assert.ok(r.states > 3, `${name}: the outputs change (${r.states} states)`);
  });
}

// Verilog designs also through Yosys's own front end (the original text, not Silinx's translation)
for (const name of ['adder', 'fsm']) {
  const dir = path.join(DESIGNS, name);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
  test(`Yosys reading the source vs Silinx's simulation: ${name}`, { timeout: 120000 }, async () => {
    const r = await diffSynth({ name, from: 'source', sources: spec.files.map(f => ({ path: f, lang: langOf(f), text: fs.readFileSync(path.join(dir, f), 'utf8') })), top: spec.top, sim: spec.sim });
    assert.equal(r.status, 'pass', r.report || `${name}: ${r.status} at ${r.stage}: ${r.reason}`);
  });
}
