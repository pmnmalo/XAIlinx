#!/usr/bin/env node
// Corpus test: Yosys's own test designs (YosysHQ/yosys tests/simple, asicworld, hana, various; ISC
// licence; fetched by scripts/fetch-yosys-tests.mjs at a pinned commit, never committed) through
// Silinx's front end and simulator, compared with Yosys's netlists (test/diff-synth.js).
//
//   node test/corpus/run-corpus.mjs [--update] [--filter text] [--jobs n] [--cycles n] [--json file]
//   (npm run test:corpus)
//
// Every Verilog file is parsed and elaborated by Silinx; each of its top modules (the modules no
// other module of the file instantiates) is then simulated with seeded random stimulus and compared
// cycle by cycle with two netlists:
//   "<dir>/<file>:<top>"          Yosys reads the original file (its own front end): checks Silinx's
//                                 parser, elaborator and simulator against Yosys's reading
//   "<dir>/<file>:<top> (synth)"  Silinx's open synthesis (core/synth-verilog.js, then Yosys)
// A result is 'pass', 'unsupported: <stage>: <reason>' (Silinx cannot read / elaborate / translate
// it, or there is nothing to compare: no outputs, inout ports), 'mismatch: <reason>' or
// 'error: <stage>: <reason>' (Yosys fails on the file, the run times out…).
//
// test/corpus/expected.json holds the expected result of every key. The run fails only on a
// regression: a key expected to 'pass' that does not. Keys that pass now and did not before are
// listed (newly passing); --update rewrites expected.json with the results of this run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = path.join(HERE, 'expected.json');
const TIMEOUT = 900000;   // per file (hana/test_intermout.v: 33 modules, two netlists each)

/** One line of a reason: no newlines, no absolute paths, bounded. */
const clean = s => String(s).replace(/\s+/g, ' ').replace(/(src\d+_)/g, '').slice(0, 160);

/** Results of one file: { key: status }. */
async function runFile(dir, rel, cycles) {
  const { compile, topCandidates } = await import('../../core/compile.js');
  const { diffSynth } = await import('../diff-synth.js');
  const text = fs.readFileSync(path.join(dir, rel), 'utf8');
  const src = { path: path.basename(rel), lang: 'verilog', text };
  const out = {};
  let lib;
  try { lib = compile([src]); }
  catch (e) { out[rel] = `unsupported: parse: ${clean(e.message)}`; return out; }
  const perr = lib.errors.filter(d => d.severity === 'error');
  if (perr.length) { out[rel] = `unsupported: parse: line ${perr[0].line}: ${clean(perr[0].message)}`; return out; }
  const tops = topCandidates(lib);
  if (!tops.length) { out[rel] = 'unsupported: parse: no module'; return out; }
  for (const top of tops) {
    for (const from of ['source', 'silinx']) {
      const key = `${rel}:${top}${from === 'silinx' ? ' (synth)' : ''}`;
      let r;
      try { r = await diffSynth({ name: key, sources: [src], top, from, seed: key, sim: { cycles } }); }
      catch (e) { r = { status: 'error', stage: 'harness', reason: e.message }; }
      out[key] = r.status === 'pass' ? 'pass' : r.status === 'mismatch' ? `mismatch: ${clean(r.reason)}` : `${r.status}: ${r.stage}: ${clean(r.reason)}`;
      if (r.report) out[`${key}#report`] = r.report;
      // nothing more to learn from the second netlist when Silinx cannot elaborate the module
      if (r.stage === 'parse' || r.stage === 'elaborate') break;
    }
  }
  return out;
}

if (!isMainThread) {
  const { dir, cycles } = workerData;
  parentPort.on('message', async rel => {
    let res;
    try { res = await runFile(dir, rel, cycles); }
    catch (e) { res = { [rel]: `error: harness: ${clean(e.message)}` }; }
    parentPort.postMessage({ rel, res });
  });
} else {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const update = args.includes('--update');
  const filter = opt('--filter', '');
  const jobs = Math.max(1, +opt('--jobs', Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length) - 1)));
  const cycles = +opt('--cycles', 100);
  const { fetchYosysTests, YOSYS_TEST_DIRS, YOSYS_TESTS_PIN } = await import(pathToFileURL(path.join(HERE, '..', '..', 'scripts', 'fetch-yosys-tests.mjs')).href);
  const dir = await fetchYosysTests();
  const files = [];
  for (const d of YOSYS_TEST_DIRS) {
    const abs = path.join(dir, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) if (/\.s?v$/.test(f)) files.push(`${d.replace(/^tests\//, '')}/${f}`);
  }
  const todo = files.filter(f => f.includes(filter)).map(f => f);
  const testsDir = path.join(dir, 'tests');
  const results = {}, reports = {};
  const t0 = Date.now();
  let next = 0, doneN = 0;
  await new Promise(resolve => {
    let live = 0;
    const spawn = () => {
      if (next >= todo.length) { if (!live) resolve(); return; }
      live++;
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { dir: testsDir, cycles } });
      let cur = null, timer = null;
      const give = () => {
        if (next >= todo.length) { w.terminate(); return; }
        cur = todo[next++];
        timer = setTimeout(() => { results[cur] = 'error: timeout'; doneN++; cur = null; w.terminate(); }, TIMEOUT);
        w.postMessage(cur);
      };
      w.on('message', ({ rel, res }) => {
        clearTimeout(timer);
        for (const [k, v] of Object.entries(res)) (k.endsWith('#report') ? reports : results)[k.replace(/#report$/, '')] = v;
        doneN++;
        process.stderr.write(`\r${doneN}/${todo.length} ${rel.padEnd(60).slice(0, 60)}`);
        cur = null;
        give();
      });
      w.on('error', e => { clearTimeout(timer); if (cur) { results[cur] = `error: harness: ${clean(e.message)}`; doneN++; } });
      w.on('exit', () => { clearTimeout(timer); live--; if (cur) { results[cur] = results[cur] || 'error: worker exited'; doneN++; } spawn(); });
      give();
    };
    for (let i = 0; i < Math.min(jobs, todo.length); i++) spawn();
    if (!todo.length) resolve();
  });
  process.stderr.write('\n');

  // summary
  const keys = Object.keys(results).sort();
  const kind = v => v.split(':')[0];
  const count = (pred) => keys.filter(pred).length;
  const src = keys.filter(k => !k.endsWith(' (synth)')), syn = keys.filter(k => k.endsWith(' (synth)'));
  const fileOf = k => k.split(':')[0];
  const fileSet = new Set(keys.map(fileOf));
  const parsed = [...fileSet].filter(f => !(results[f] || '').startsWith('unsupported: parse'));
  const elaborated = src.filter(k => k.includes(':') && !/^unsupported: (parse|elaborate)/.test(results[k]));
  const tally = list => ['pass', 'mismatch', 'unsupported', 'error'].map(s => `${s} ${list.filter(k => kind(results[k]) === s).length}`).join(', ');
  console.log(`Yosys ${YOSYS_TESTS_PIN.tag} tests: ${fileSet.size} files, ${parsed.length} parsed by Silinx; ${src.filter(k => k.includes(':')).length} top modules, ${elaborated.length} elaborated`);
  console.log(`  vs Yosys reading the source:  ${tally(src.filter(k => k.includes(':')))}`);
  console.log(`  vs Silinx's open synthesis:   ${tally(syn)}`);
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s, ${jobs} jobs, ${cycles} cycles)`);
  for (const k of keys) if (kind(results[k]) === 'mismatch' && reports[k]) console.log(`\n${reports[k]}`);

  // against the expectations
  const expected = fs.existsSync(EXPECTED) ? JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) : {};
  const regress = [], fixed = [], fresh = [];
  for (const k of keys) {
    const e = expected[k];
    if (e === undefined) fresh.push(k);
    else if (e === 'pass' && results[k] !== 'pass') regress.push(k);
    else if (e !== 'pass' && results[k] === 'pass') fixed.push(k);
  }
  // a module that passed and has no result now (its file failed as a whole: a timeout, a crash)
  const ran = new Set(todo);
  for (const [k, e] of Object.entries(expected)) {
    const f = k.split(':')[0];
    if (e === 'pass' && ran.has(f) && !(k in results)) { regress.push(k); results[k] = `missing (${results[f] || 'no result'})`; }
  }
  if (fixed.length) console.log(`\nnewly passing (${fixed.length}; npm run test:corpus -- --update records them):\n${fixed.map(k => `  ${k}  (was: ${expected[k]})`).join('\n')}`);
  const freshBad = fresh.filter(k => results[k] !== 'pass');
  if (fresh.length && !update) console.log(`\nnot in expected.json: ${fresh.length} (${fresh.length - freshBad.length} pass)${freshBad.slice(0, 60).map(k => `\n  ${k}: ${results[k]}`).join('')}`);
  if (update) {
    const merged = filter ? { ...expected, ...Object.fromEntries(keys.map(k => [k, results[k]])) } : Object.fromEntries(keys.map(k => [k, results[k]]));
    const sorted = Object.fromEntries(Object.keys(merged).sort().map(k => [k, merged[k]]));
    fs.writeFileSync(EXPECTED, JSON.stringify(sorted, null, 1) + '\n');
    console.log(`\nwrote ${path.relative(process.cwd(), EXPECTED)} (${Object.keys(sorted).length} entries)`);
  }
  if (regress.length) {
    console.log(`\nREGRESSIONS (${regress.length}): expected to pass\n${regress.map(k => `  ${k}: ${results[k]}`).join('\n')}`);
    if (!update) process.exitCode = 1;
  }
}
