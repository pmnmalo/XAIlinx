// VlogHammer-style differential tests (test/corpus/vloghammer-gen.mjs, a port of the generator of
// VlogHammer by Claire Xenia Wolf, ISC licence; test/corpus/vloghammer.mjs): random combinational
// Verilog modules evaluated by Silinx's simulator and by Yosys's netlist of the same text (YoWASP).
// A small fixed batch here; a big one on demand: npm run test:vloghammer -- --seed N --count M.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, moduleText, reductions, moduleSize, exprText, exprSize, FAMILIES } from './corpus/vloghammer-gen.mjs';
import { runBatch, reduce } from './corpus/vloghammer.mjs';

test('the generator: seeded like VlogHammer, reproducible, every family', () => {
  for (const f of FAMILIES) assert.equal(moduleText(generate(f, 3)), moduleText(generate(f, 3)), f);
  assert.notEqual(moduleText(generate('expression', 3)), moduleText(generate('expression', 4)));
  const e = moduleText(generate('expression', 1));
  assert.match(e, /^module expression_00001\(a0, a1, a2, a3, a4, a5, b0, b1, b2, b3, b4, b5, y\);\n {2}input \[3:0\] a0;/);
  assert.match(e, /\n {2}output \[89:0\] y;\n {2}assign y = \{y0,y1,y2,y3,y4,y5,y6,y7,y8,y9,y10,y11,y12,y13,y14,y15,y16,y17\};\n/);
  assert.equal(e.match(/^ {2}localparam /gm).length, 18);
  assert.equal(e.match(/^ {2}assign y\d+ = /gm).length, 18);
  assert.match(moduleText(generate('wideexpr', 0)), /input signed \[7:0\] s7;\n {2}output \[127:0\] y;/);
  assert.match(moduleText(generate('partsel', 0)), /input \[3:0\] ctrl;/);
  // the operator families enumerate the operand types and operators
  assert.equal(moduleText(generate('binary', 0)), 'module binary_ops_00000000(a, b, y);\n  input [3:0] a;\n  input [3:0] b;\n  output [3:0] y;\n  assign y = a + b;\nendmodule\n');
  assert.match(moduleText(generate('binary', 5)), /assign y = 4'd2 \*\* b;/);
  assert.match(moduleText(generate('unary', 2)), /assign y = ! a;/);
  assert.match(moduleText(generate('ternary', 0)), /assign y = a \? b : c;/);
  assert.match(moduleText(generate('repeat', 1)), /assign y = \{0\{b\}\};|assign y = \{\d\{b\}\};/);
});

test('reductions: smaller variants, one output kept first, then expression nodes replaced', () => {
  const m = generate('expression', 2);
  const first = reductions(m).next().value;
  assert.equal(first.assigns.filter(a => a.e.s !== "1'b0").length, 1, 'one output kept');
  let n = 0;
  for (const r of reductions(first)) { assert.ok(moduleSize(r) <= moduleSize(first)); if (++n > 200) break; }
  assert.equal(exprText({ k: 'bin', o: '+', a: { k: 'leaf', s: 'a' }, b: { k: 'un', o: '-', a: { k: 'leaf', s: 'b' } } }), '(a+(-b))');
});

test('reduce: keeps the smallest module that still fails', async () => {
  // a stand-in failure: any module whose text still has a subtraction "fails"
  const m = generate('wideexpr', 1);
  const has = x => /\)-\(|[^-]-[^-]/.test(x.assigns.map(a => exprText(a.e)).join(' '));
  const seed = [...Array(40).keys()].map(i => generate('wideexpr', i)).find(has) || m;
  const check = async x => ({ status: has(x) ? 'mismatch' : 'pass' });
  const { module: small } = await reduce(seed, { check });
  assert.ok(has(small));
  assert.ok(moduleSize(small) < moduleSize(seed), `${moduleSize(small)} < ${moduleSize(seed)}`);
  const live = small.assigns.filter(a => exprText(a.e) !== "1'b0");
  assert.equal(live.length, 1, moduleText(small));
  assert.ok(exprSize(live[0].e) <= 3, moduleText(small));
});

test('a fixed batch: Silinx and Yosys agree on every module', { timeout: 300000 }, async () => {
  const { results } = await runBatch({ seed: 0, count: 48, reduceFailing: false });
  const bad = results.filter(r => r.status !== 'pass');
  assert.deepEqual(bad.map(r => `${r.name}: ${r.status}: ${r.reason}\n${r.report || ''}`), []);
  assert.equal(results.length, 48);
});
