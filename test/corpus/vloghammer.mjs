#!/usr/bin/env node
// VlogHammer-style differential test of Silinx's Verilog front end and simulator: random
// combinational modules (test/corpus/vloghammer-gen.mjs, a port of VlogHammer's generator by Claire
// Xenia Wolf, ISC licence) are evaluated by Silinx's simulator and by Yosys's netlist of the same
// text (Yosys's own front end, YoWASP), on the same random input vectors (test/diff-synth.js:
// the X bits of Silinx's result are not compared). A module that differs is reduced (one output
// kept, then expression nodes replaced by their operands or by constants while the difference
// stays) and reported with its smallest text.
//
//   node test/corpus/vloghammer.mjs [--seed N] [--count M] [--families expression,wideexpr,…]
//        [--vectors V] [--flow generic|xilinx] [--synth] [--no-reduce] [--out dir]
//   (npm run test:vloghammer -- --count 1000)
//
// Module k of a run (k = 0 … M-1) is family families[k % F], index N + floor(k / F): a run is
// reproducible from its seed and count. --flow generic (default) maps with Yosys's generic `synth`
// (gates; fast, ~0.1 s a module), xilinx with synth_xilinx as the open synthesis does (~1.5 s).
// --synth also compares Silinx's own synthesis path (core/synth-verilog.js, then Yosys).
// --out writes every failing module (original and reduced) into that directory.
// The exit code is 1 when a module differs or Silinx cannot read one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, moduleText, reductions, moduleSize, FAMILIES } from './vloghammer-gen.mjs';
import { frontEnd, compareNetlist, diffSynth } from '../diff-synth.js';
import { cellCounts } from '../../core/synth-open.js';
import { yosysNode } from '../../core/synth-open-node.js';

const VECTORS = 64;

/** Yosys on several modules in one run: { name: { json, verilog } | { error } }. */
export async function yosysBatch(mods, flow = 'generic') {
  const one = m => {
    const f = `${m.name}.v`;
    const map = flow === 'xilinx' ? `synth_xilinx -family xc3se -ise -flatten -top ${m.name}` : `synth -flatten -top ${m.name}`;
    return { file: f, cmd: `design -reset; read_verilog ${f}; ${map}; delete t:$scopeinfo; write_json ${m.name}.json; write_verilog -noattr ${m.name}_yosys.v` };
  };
  const res = {};
  const runSome = async list => {
    const files = {}, cmds = [];
    for (const m of list) { const o = one(m); files[o.file] = m.text; cmds.push(o.cmd); }
    const lines = [];
    const out = await yosysNode(['-q', '-p', cmds.join('; ')], files, l => lines.push(l));
    for (const m of list) res[m.name] = { json: out[`${m.name}.json`], verilog: out[`${m.name}_yosys.v`] };
    return lines;
  };
  for (let i = 0; i < mods.length; i += 25) {
    const chunk = mods.slice(i, i + 25);
    try { await runSome(chunk); }
    catch {
      // one module stops the run: each on its own
      for (const m of chunk) {
        let lines = [];
        try { lines = await runSome([m]); }
        catch (e) { res[m.name] = { error: (e.lines || lines).find(l => /ERROR/.test(l)) || e.message }; }
      }
    }
  }
  return res;
}

/** Check one module (object from generate()): { status, reason, report }. */
export async function checkModule(m, { flow = 'generic', vectors = VECTORS, yosys, synth = false } = {}) {
  const text = moduleText(m);
  if (synth) {
    // Silinx's own synthesis path (core/synth-verilog.js, then Yosys) against Silinx's simulation
    const s = await diffSynth({ name: `${m.name} (synth)`, sources: [{ path: `${m.name}.v`, lang: 'verilog', text }], top: m.name, sim: { cycles: vectors } });
    return s.status === 'pass' ? { status: 'pass' } : { status: s.status, reason: `synth path: ${s.reason}`, report: s.report };
  }
  const fe = frontEnd([{ path: `${m.name}.v`, lang: 'verilog', text }], m.name);
  if (!fe.design) return { status: 'unsupported', reason: `Silinx: ${fe.stage}: ${fe.reason}` };
  const y = yosys || (await yosysBatch([{ name: m.name, text }], flow))[m.name];
  if (!y || y.error || !y.json) return { status: 'yosys-error', reason: y?.error || 'no netlist' };
  const syn = { top: m.name, files: { [`${m.name}.json`]: y.json, [`${m.name}_yosys.v`]: y.verilog }, cells: cellCounts(y.json, m.name) };
  const r = compareNetlist(fe.design, syn, { name: m.name, seed: m.name, sim: { cycles: vectors } });
  return r.status === 'pass' ? { status: 'pass' } : { status: r.status, reason: r.reason, report: r.report };
}

/** Reduce a failing module while it keeps failing (opts.check(m, opts) -> { status }: checkModule by default). Returns { module, steps }. */
export async function reduce(m, opts = {}, budget = 400) {
  let cur = m, steps = 0;
  for (let progress = true; progress && steps < budget;) {
    progress = false;
    for (const cand of reductions(cur)) {
      if (++steps > budget) break;
      if (moduleSize(cand) > moduleSize(cur)) continue;
      const r = await (opts.check || checkModule)(cand, opts);
      if (r.status === 'mismatch') { cur = cand; progress = true; break; }
    }
  }
  return { module: cur, steps };
}

/** A run: modules k = 0 … count-1. Returns { results: [{ name, family, index, status, reason, report, reduced }], ms }. */
export async function runBatch({ seed = 0, count = 24, families = FAMILIES, flow = 'generic', vectors = VECTORS, synth = false, reduceFailing = true, log = () => {} } = {}) {
  const t0 = Date.now();
  const mods = [];
  for (let k = 0; k < count; k++) {
    const family = families[k % families.length], index = seed + Math.floor(k / families.length);
    const m = generate(family, index);
    mods.push({ m, family, index, text: moduleText(m), name: m.name });
  }
  const ys = await yosysBatch(mods.map(x => ({ name: x.name, text: x.text })), flow);
  const results = [];
  for (const x of mods) {
    const r = await checkModule(x.m, { flow, vectors, yosys: ys[x.name] });
    const res = { name: x.name, family: x.family, index: x.index, ...r };
    if (r.status === 'pass' && synth) {
      const s = await checkModule(x.m, { vectors, synth: true });
      if (s.status !== 'pass') Object.assign(res, s, { path: 'synth' });
    }
    if (res.status === 'mismatch' && reduceFailing) {
      const o = { flow, vectors, synth: res.path === 'synth' };
      const { module: small, steps } = await reduce(x.m, o);
      res.reduced = moduleText(small);
      res.reducedReport = (await checkModule(small, o)).report;
      res.reduceSteps = steps;
    }
    log(res);
    results.push(res);
  }
  return { results, ms: Date.now() - t0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const seed = +opt('--seed', 0), count = +opt('--count', 24), vectors = +opt('--vectors', VECTORS);
  const families = opt('--families', FAMILIES.join(',')).split(',');
  const flow = opt('--flow', 'generic'), out = opt('--out', null);
  const tally = {};
  const { results, ms } = await runBatch({
    seed, count, families, flow, vectors, synth: args.includes('--synth'), reduceFailing: !args.includes('--no-reduce'),
    log: r => {
      tally[r.status] = (tally[r.status] || 0) + 1;
      if (r.status !== 'pass') {
        console.log(`\n${r.name} (${r.family} ${r.index}): ${r.status}: ${r.reason}`);
        if (r.reduced) console.log(`reduced in ${r.reduceSteps} steps:\n${r.reduced}${r.reducedReport || ''}`);
        else if (r.report) console.log(r.report);
      } else process.stderr.write('.');
    },
  });
  console.log(`\nVlogHammer-style run: seed ${seed}, ${count} modules (${families.join(', ')}), ${vectors} vectors, ${flow} flow: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')} (${(ms / 1000).toFixed(1)} s)`);
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    for (const r of results) if (r.status !== 'pass') {
      fs.writeFileSync(path.join(out, `${r.name}.v`), moduleText(generate(r.family, r.index)));
      if (r.reduced) fs.writeFileSync(path.join(out, `${r.name}.reduced.v`), r.reduced);
    }
  }
  if (results.some(r => r.status === 'mismatch' || r.status === 'unsupported')) process.exitCode = 1;
}
