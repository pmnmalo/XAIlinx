// UI: FSM state diagram editor. A new diagram from New Source (listed just before State Machine (ASM)),
// a state added by double-click and named in place, a transition drawn from the rim of a state,
// conditions edited in place and in the properties panel; the tables (transition, state, encoded)
// and the truth tables of the next-state logic; Generate HDL (linked: an edit of a transition
// rewrites the HDL, which simulates like the diagram; a saved edit of the HDL updates the diagram;
// an HDL edit the diagram cannot show gives the out-of-sync banner with the reason); step-by-step
// simulation; HDL module -> diagram and diagram -> ASM chart; Portuguese texts.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupUi, uiTest, makeProject, readWs } from './harness.js';
import { TEXTS, untranslated } from './i18n-check.js';
import { normalizeFsm, simulateFsm, encodedTable, generateFsm } from '../../core/fsm.js';
import { simulate } from '../../core/compile.js';

let env;
before(async () => { env = await setupUi(); });
after(async () => { await env?.teardown?.(); });
const E = () => env;
const ED = '.doc:not([hidden]) .fsm-editor';
const fsmFile = async (pj, p) => JSON.parse(await readWs(env, pj, p));

/** Outputs of the HDL per cycle and of the diagram (reference model) for the same inputs. */
function hdlVsModel(code, model) {
  const m = normalizeFsm(model);
  const vec = [];
  let s = 7;
  for (let i = 0; i < 60; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; vec.push(Object.fromEntries(m.inputs.map((x) => [x.name, (s >> 8) % (1 << x.width)]))); }
  const tb = ['module tb;', '  reg clk = 0; reg rst = 1;', ...m.inputs.map((i) => `  reg [${i.width - 1}:0] i_${i.name} = 0;`), ...m.outputs.map((o) => `  wire [${o.width - 1}:0] o_${o.name};`),
    `  ${m.name.toLowerCase()} dut(.clk(clk), .rst(rst)${m.inputs.map((i) => `, .${i.name}(i_${i.name})`).join('')}${m.outputs.map((o) => `, .${o.name}(o_${o.name})`).join('')});`,
    '  always #5 clk = ~clk;', '  initial begin', '    #12 rst = 0;',
    ...vec.map((v) => `    ${m.inputs.map((i) => `i_${i.name} = ${v[i.name]};`).join(' ')} #2 $display("${m.outputs.map(() => '%b').join('_')}", ${m.outputs.map((o) => `o_${o.name}`).join(', ')}); @(posedge clk); #1;`),
    '    $finish;', '  end', 'endmodule'].join('\n');
  const r = simulate([{ path: 'dut.vhd', text: code }, { path: 'tb.v', text: tb }], 'tb', { until: 1e8 });
  assert.deepEqual(r.errors, []);
  const got = r.sim.log.map((e) => String(e.text).trim()).filter((x) => /^[01xz_]+$/.test(x));
  const want = simulateFsm(m, vec).map((row) => m.outputs.map((o) => row.outputs[o.name].toString(2).padStart(o.width, '0')).join('_'));
  return { got, want };
}

/** Select a transition by clicking its label (again if the view was still moving: fit on activation). */
async function selectTrans(page, id) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { await page.click(`${ED} [data-trans=${id}] .fsm-label`); } catch { continue; }
    if (await page.eval((ed, t) => !!document.querySelector(`${ed} .fsm-cond`) && window.Silinx.active.fsmEditor && document.querySelector(`${ed} [data-trans=${t}]`)?.classList.contains('sel'), ED, id)) return;
  }
  throw new Error(`transition ${id} not selected`);
}

/** Screen position of a state circle (centre) and its radius. */
const statePos = (page, id) => page.eval((ed, sid) => {
  const c = document.querySelector(`${ed} [data-state="${sid}"] .fsm-circle`);
  const b = c.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, r: b.width / 2 };
}, ED, id);

uiTest('State diagram (FSM): New Source, states and transitions drawn and edited, tables, truth tables, linked HDL kept in sync both ways', E, async (page) => {
  await makeProject(env, { name: 'FsmPj', files: {} });
  await page.openProject('FsmPj');
  await page.menu('Project', 'New Source…');
  await page.waitDialog('New Source Wizard');
  const types = await page.eval(() => [...document.querySelectorAll('.dlg-overlay .src-types .st')].map((e) => e.textContent.trim()));
  assert.equal(types.indexOf('State Machine (FSM)') + 1, types.indexOf('State Machine (ASM)'), types.join(' | '));   // FSM listed just before ASM
  await page.eval(() => { const r = [...document.querySelectorAll('.dlg-overlay .src-types .st')].find((e) => e.textContent.trim() === 'State Machine (FSM)'); r.scrollIntoView(); r.click(); });
  await page.fill('.dlg-overlay .wiz-main input[type=text]', 'det');
  await page.dialogButton('Next >');
  await page.dialogButton('Finish');
  await page.waitNoDialog();
  await page.waitFor((ed) => window.Silinx.active?.id === 'fsm:src/det.fsm.json' && document.querySelector(ed), [ED], { what: 'state diagram editor' });
  // the example machine: S0 -> S1 -> S2 (z = 1), the initial state with a double circle
  assert.equal(await page.eval((ed) => document.querySelectorAll(`${ed} .fsm-state`).length, ED), 3);
  assert.ok(await page.eval((ed) => !!document.querySelector(`${ed} [data-state=s1].initial .fsm-circle-in`), ED));
  assert.equal(await page.eval((ed) => document.querySelector(`${ed} [data-state=s3] .fsm-outs`).textContent, ED), 'z=1');
  assert.match(await page.eval((ed) => document.querySelector(`${ed} .fsm-problems`).textContent, ED), /No problems/);
  // the hierarchy lists the diagram
  await page.waitFor(() => [...document.querySelectorAll('#hier .row')].some((r) => /det\.fsm\.json/.test(r.textContent)), [], { what: 'det.fsm.json in the hierarchy' });

  // ---- a new state: double-click the drawing, name and Moore output typed in place
  await page.waitFor((ed) => document.querySelector(`${ed} [data-state=s3] .fsm-circle`)?.getBoundingClientRect().width > 10, [ED]);
  const s3 = await statePos(page, 's3');
  await page.dblclick({ x: s3.x, y: s3.y + 130 });
  await page.waitForSelector(`${ED} .fsm-inline`);
  await page.fill(`${ED} .fsm-inline`, 'S3 / z=1');
  await page.key('Enter');
  await page.waitFor((ed) => [...document.querySelectorAll(`${ed} .fsm-name`)].some((t) => t.textContent === 'S3'), [ED], { what: 'state S3' });
  const sid = await page.eval((ed) => [...document.querySelectorAll(`${ed} .fsm-state`)].find((g) => g.querySelector('.fsm-name').textContent === 'S3').dataset.state, ED);
  // a warning: S3 cannot be reached and has no exit
  await page.waitFor((ed) => /State S3 cannot be reached/.test(document.querySelector(`${ed} .fsm-problems`).textContent), [ED]);

  // ---- a transition S3 -> S0: dragged from the rim of S3, condition typed in place (empty = always)
  const a = await statePos(page, sid), b = await statePos(page, 's1');
  await page.drag({ x: a.x - a.r + 3, y: a.y }, { x: b.x, y: b.y });
  await page.waitForSelector(`${ED} .fsm-inline`);
  await page.key('Enter');
  // ---- S2 --!x--> S3 instead of S0: the transition chosen by its label, its target changed in the panel
  await selectTrans(page, 't6');
  await page.fill(`${ED} .fsm-to`, sid);
  await page.waitFor((ed) => /No problems/.test(document.querySelector(`${ed} .fsm-problems`).textContent), [ED], { what: 'no problems' });
  await page.waitFor(() => !window.Silinx.active.dirty, [], { what: 'saved' });
  // the save reaches the disk a moment after the tab is marked clean: wait for the new state in the file
  let m;
  for (let i = 0; i < 100; i++) {
    m = await fsmFile('FsmPj', 'src/det.fsm.json');
    if (m.states.some((s) => s.id === sid) && m.transitions.find((t) => t.id === 't6')?.to === sid) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(m.states.find((s) => s.id === sid), { id: sid, name: 'S3', x: m.states.find((s) => s.id === sid).x, y: m.states.find((s) => s.id === sid).y, outputs: { z: '1' } });
  assert.deepEqual(m.transitions.filter((t) => t.from === sid).map((t) => [t.to, t.cond]), [['s1', '']]);
  assert.equal(m.transitions.find((t) => t.id === 't6').to, sid);

  // ---- tables
  await page.click(`${ED} .fsm-tab-btn`, { text: 'Tables' });
  await page.waitForSelector(`${ED} .fsm-ttable`);
  const rows = await page.eval((ed) => [...document.querySelectorAll(`${ed} .fsm-ttable tr`)].slice(1).map((r) => [...r.children].map((c) => c.textContent).join('|')), ED);
  assert.deepEqual(rows, ['S0|00|x|S1|01|', 'S0|00|!x|S0|00|', 'S1|01|x|S2|10|', 'S1|01|!x|S0|00|', 'S2|10|x|S2|10|z=1', 'S2|10|!x|S3|11|z=1', 'S3|11|1|S0|00|z=1']);
  // state table: columns x = 0 / 1
  const st = await page.eval((ed) => [...document.querySelectorAll(`${ed} .fsm-stable tr`)].slice(2).map((r) => [...r.children].map((c) => c.textContent).join('|')), ED);
  assert.deepEqual(st, ['S0|00|S0|S1|0', 'S1|01|S0|S2|0', 'S2|10|S3|S2|1', 'S3|11|S0|S0|1']);
  // encoded table: 4 codes x 2 values of x
  assert.equal(await page.eval((ed) => document.querySelectorAll(`${ed} .fsm-etable tr`).length - 2, ED), 8);
  // truth tables of the next-state bits and of the output
  await page.click(`${ED} .fsm-mktt`);
  await page.waitFor(() => window.Silinx.fileTree?.includes('src/det_next.tt.json') && window.Silinx.fileTree.includes('src/det_out.tt.json'), [], { what: 'truth tables', timeout: 15000 });
  await page.waitFor(() => window.Silinx.active?.id === 'tt:src/det_next.tt.json' && window.Silinx.docs.some((d) => d.id === 'tt:src/det_out.tt.json'), [], { what: 'truth tables opened', timeout: 15000 });
  const ttn = await fsmFile('FsmPj', 'src/det_next.tt.json');
  const et = encodedTable(m);
  assert.deepEqual(ttn.inputs, ['q1', 'q0', 'x']);
  assert.equal(ttn.table.d1, et.rows.map((r) => r.d[0]).join(''));
  assert.equal(ttn.table.d0, et.rows.map((r) => r.d[1]).join(''));
  assert.equal((await fsmFile('FsmPj', 'src/det_out.tt.json')).table.z, '00001111'.replace(/./g, (c, i) => et.rows[i].out));

  // ---- Generate HDL: linked to the diagram, simulates like it
  await page.eval(() => window.SilinxApp.openFsm('src/det.fsm.json'));
  await page.waitFor(() => window.Silinx.active?.id === 'fsm:src/det.fsm.json');
  await page.waitFor((ed) => document.querySelector(`${ed} .fsm-gen`)?.getClientRects().length, [ED], { what: 'Generate HDL button' });
  await page.click(`${ED} .fsm-gen`);
  await page.waitFor(() => window.Silinx.hdlToSch?.['src/det.vhd'] === 'src/det.fsm.json', [], { what: 'linked HDL', timeout: 15000 });
  assert.equal((await fsmFile('FsmPj', 'src/det.fsm.json')).generatedFile, 'src/det.vhd');
  let vhd = await readWs(env, 'FsmPj', 'src/det.vhd');
  let r = hdlVsModel(vhd, await fsmFile('FsmPj', 'src/det.fsm.json'));
  assert.deepEqual(r.got, r.want);
  await page.waitFor(() => window.Silinx.active?.id === 'file:src/det.vhd' && /Synchronized with det\.fsm\.json/.test(document.querySelector('.doc:not([hidden]) [data-sync-banner]')?.textContent || ''), [], { what: 'HDL editor banner' });
  // the hierarchy shows the module with its diagram, the HDL under it
  await page.waitFor(() => [...document.querySelectorAll('#hier .row')].some((x) => /det\s*\(det\.fsm\.json\)/.test(x.textContent)), [], { what: 'det (det.fsm.json)' });

  // ---- diagram -> HDL: an edited condition rewrites the module
  await page.eval(() => window.SilinxApp.openFsm('src/det.fsm.json'));
  await page.waitFor((ed) => window.Silinx.active?.id === 'fsm:src/det.fsm.json' && /Synchronized with det\.vhd/.test(document.querySelector(`${ed} .fsm-link`).textContent), [ED]);
  await selectTrans(page, 't1');
  await page.fill(`${ED} .fsm-cond`, 'x and x');
  await page.waitFor(async () => /S0 +: x and x -> S1/.test(await (await fetch('/api/projects/FsmPj/file?path=src%2Fdet.vhd')).text()), [], { what: 'HDL regenerated', timeout: 15000 });
  vhd = await readWs(env, 'FsmPj', 'src/det.vhd');
  r = hdlVsModel(vhd, await fsmFile('FsmPj', 'src/det.fsm.json'));
  assert.deepEqual(r.got, r.want);

  // ---- HDL -> diagram: a saved edit of the module updates the diagram (S1 --x--> S3 instead of S2)
  await page.eval(() => window.SilinxApp.openFile('src/det.vhd'));
  await page.waitFor(() => window.Silinx.active?.id === 'file:src/det.vhd' && window.Silinx.active.editor);
  await page.eval(() => { const ed = window.Silinx.active.editor; ed.setValue(ed.getValue().replace(/(when S_S1 =>\n\s+if [^\n]+\n\s+state_next <= )S_S2;/, '$1S_S3;')); });
  await page.waitFor(async (s) => (await (await fetch('/api/projects/FsmPj/file?path=src%2Fdet.fsm.json')).json()).transitions.some((t) => t.from === 's2' && t.to === s && t.cond === 'x'), [sid], { what: 'diagram updated from the HDL', timeout: 15000 });
  m = await fsmFile('FsmPj', 'src/det.fsm.json');
  assert.ok(!m.transitions.some((t) => t.from === 's2' && t.to === 's3'));
  assert.deepEqual(m.states.map((s) => s.name), ['S0', 'S1', 'S2', 'S3']);
  // the open diagram shows it
  await page.eval(() => window.SilinxApp.openFsm('src/det.fsm.json'));
  await page.waitFor((ed, s) => [...document.querySelectorAll(`${ed} [data-trans]`)].length === 7 && window.Silinx.active.fsmEditor.getModel().transitions.some((t) => t.from === 's2' && t.to === s), [ED, sid], { what: 'editor updated' });
  // an edit the diagram cannot show (a counter process): out-of-sync banner with the reason
  await page.eval(() => window.SilinxApp.openFile('src/det.vhd'));
  await page.waitFor(() => window.Silinx.active?.id === 'file:src/det.vhd');
  await page.eval(() => {
    const ed = window.Silinx.active.editor;
    ed.setValue(ed.getValue().replace('    signal state_next : state_t;', '    signal state_next : state_t;\n    signal cnt : std_logic := \'0\';')
      .replace('end architecture rtl;', '    counter : process (clk)\n    begin\n        if rising_edge(clk) then\n            cnt <= not cnt;\n        end if;\n    end process counter;\n\nend architecture rtl;'));
  });
  await page.waitFor(() => /Not in sync with det\.fsm\.json — the diagram cannot show it: process at line \d+ is not part of the state machine \(it drives 'cnt'\)/.test(document.querySelector('.doc:not([hidden]) [data-sync-banner]')?.textContent || ''), [], { what: 'out-of-sync banner', timeout: 15000 });
  await page.eval(() => window.SilinxApp.openFsm('src/det.fsm.json'));
  await page.waitFor((ed) => /Not in sync with det\.vhd/.test(document.querySelector(`${ed} .fsm-link`).textContent), [ED]);
  // editing the diagram again rewrites the HDL: back in sync, and said so only once the file is
  // written (the save is slowed down here: a slow disk / server, as on CI)
  await page.eval(() => {
    const f = window.fetch;
    window.fetch = (url, init) => (init?.method === 'PUT' && /path=src%2Fdet\.vhd/.test(String(url)) ? new Promise((r) => setTimeout(r, 1500)).then(() => f(url, init)) : f(url, init));
    window.__restoreFetch = () => { window.fetch = f; };
  });
  await selectTrans(page, 't1');
  await page.fill(`${ED} .fsm-cond`, 'x');
  await page.waitFor((ed) => /Synchronized with det\.vhd/.test(document.querySelector(`${ed} .fsm-link`).textContent), [ED], { what: 'back in sync', timeout: 15000 });
  vhd = await readWs(env, 'FsmPj', 'src/det.vhd');
  await page.eval(() => window.__restoreFetch());
  assert.doesNotMatch(vhd, /cnt/);
  r = hdlVsModel(vhd, await fsmFile('FsmPj', 'src/det.fsm.json'));
  assert.deepEqual(r.got, r.want);

  // ---- rename the module: the diagram follows (file, name, link) and the HDL is regenerated
  await page.treeRow('#hier', 'det', { right: true, exact: true });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Rename…' });
  await page.waitDialog('Rename');
  await page.fill('.dlg-overlay input[type=text]', 'det2', { index: 0 });
  await page.dialogButton('Rename');
  await page.waitNoDialog();
  await page.waitFor(() => window.Silinx.hdlToSch?.['src/det2.vhd'] === 'src/det2.fsm.json', [], { what: 'link after the rename', timeout: 15000 });
  const d2 = await fsmFile('FsmPj', 'src/det2.fsm.json');
  assert.deepEqual([d2.name, d2.generatedFile], ['det2', 'src/det2.vhd']);
  assert.match(await readWs(env, 'FsmPj', 'src/det2.vhd'), /entity det2 is/);
});

uiTest('State diagram (FSM): step-by-step simulation, Mealy labels, module -> diagram, diagram -> ASM chart, undo', E, async (page) => {
  const mealy = normalizeFsm({
    name: 'seq', type: 'mealy', inputs: [{ name: 'x', width: 1 }], outputs: [{ name: 'z', width: 1 }],
    states: [{ id: 'a', name: 'A', x: 100, y: 100 }, { id: 'b', name: 'B', x: 300, y: 100 }],
    transitions: [{ id: 't1', from: 'a', to: 'b', cond: 'x' }, { id: 't2', from: 'b', to: 'a', cond: '!x', outputs: { z: '1' } }], initial: 'a',
  });
  await makeProject(env, { name: 'FsmSim', files: { 'src/seq.vhd': generateFsm(mealy, 'vhdl').code, 'src/m.fsm.json': JSON.stringify(mealy, null, 2) } });
  await page.openProject('FsmSim');
  await page.eval(() => window.SilinxApp.openFsm('src/m.fsm.json'));
  await page.waitFor((ed) => window.Silinx.active?.id === 'fsm:src/m.fsm.json' && document.querySelector(ed), [ED]);
  // Mealy label "condition / outputs"
  assert.equal(await page.eval((ed) => document.querySelector(`${ed} [data-trans=t2] .fsm-label`).textContent, ED), '!x / z=1');
  // ---- simulation: x = 1, clock -> B; x = 0: z = 1 (Mealy) and the transition back to A is shown
  await page.click(`${ED} .fsm-tab-btn`, { text: '▶ Simulate' });
  await page.waitForSelector(`${ED} .fsm-sim`);
  assert.ok(await page.eval((ed) => document.querySelector(`${ed} [data-state=a]`).classList.contains('current'), ED));
  await page.click(`${ED} .fsm-bit[data-input=x]`);
  assert.ok(await page.eval((ed) => document.querySelector(`${ed} [data-trans=t1]`).classList.contains('hot'), ED));
  await page.click(`${ED} .fsm-sim-step`);
  await page.waitFor((ed) => document.querySelector(`${ed} [data-state=b]`).classList.contains('current'), [ED]);
  assert.equal(await page.eval((ed) => document.querySelector(`${ed} .fsm-led[data-output=z]`).textContent, ED), 'z = 0');
  await page.click(`${ED} .fsm-bit[data-input=x]`);
  await page.waitFor((ed) => document.querySelector(`${ed} .fsm-led[data-output=z]`)?.textContent === 'z = 1', [ED]);
  await page.click(`${ED} .fsm-sim-step`);
  await page.waitFor((ed) => document.querySelector(`${ed} [data-state=a]`).classList.contains('current'), [ED]);
  assert.equal(await page.eval((ed) => document.querySelectorAll(`${ed} .fsm-trace tr`).length, ED), 3);
  await page.click(`${ED} .fsm-sim-reset`);
  // ---- undo / redo of a deleted transition (Del key)
  await selectTrans(page, 't1');
  await page.eval((ed) => document.querySelector(ed).focus(), ED);
  await page.key('Delete');
  await page.waitFor((ed) => !document.querySelector(`${ed} [data-trans=t1]`), [ED]);
  await page.key('z', { modifiers: 2 });
  await page.waitFor((ed) => !!document.querySelector(`${ed} [data-trans=t1]`), [ED], { what: 'undo' });
  // ---- diagram -> ASM chart
  await page.click(`${ED} .asm-btn`, { text: 'Convert to ASM chart' });
  await page.waitFor(() => window.Silinx.active?.id === 'asm:src/seq_asm.asm.json', [], { what: 'ASM chart opened', timeout: 15000 });
  const asm = JSON.parse(await readWs(env, 'FsmSim', 'src/seq_asm.asm.json'));
  assert.deepEqual(asm.nodes.filter((n) => n.type === 'state').map((n) => n.name), ['A', 'B']);
  // ---- HDL module -> state diagram (module context menu), linked to the module
  await page.treeRow('#hier', 'seq', { right: true, exact: true });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Convert to State Diagram (FSM)…' });
  await page.waitFor(() => window.Silinx.active?.id === 'fsm:src/seq.fsm.json', [], { what: 'diagram of seq', timeout: 15000 });
  const d = JSON.parse(await readWs(env, 'FsmSim', 'src/seq.fsm.json'));
  assert.equal(d.generatedFile, 'src/seq.vhd');
  assert.equal(d.type, 'mealy');
  assert.deepEqual(d.transitions.map((t) => [t.cond, t.outputs]), [['x', {}], ['!x', { z: '1' }]]);
  await page.waitFor(() => window.Silinx.hdlToSch?.['src/seq.vhd'] === 'src/seq.fsm.json', [], { what: 'linked' });
});

uiTest('State diagram (FSM) in Portuguese: every label of the editor, the panels and the problems is translated', E, async (page) => {
  const m = normalizeFsm({
    name: 'pt', type: 'mealy', inputs: [{ name: 'x', width: 1 }, { name: 'y', width: 2 }], outputs: [{ name: 'z', width: 1 }],
    states: [{ id: 'a', name: 'A', x: 100, y: 100 }, { id: 'b', name: 'B', x: 300, y: 100 }, { id: 'c', name: 'C', x: 300, y: 300 }],
    transitions: [{ id: 't1', from: 'a', to: 'b', cond: 'x' }, { id: 't2', from: 'a', to: 'c', cond: 'y == 1' }, { id: 't3', from: 'b', to: 'a', cond: '', outputs: { z: '1' } }], initial: 'a',
  });
  await makeProject(env, { name: 'FsmPt', files: { 'src/pt.fsm.json': JSON.stringify(m, null, 2) } });
  await page.openProject('FsmPt');
  await page.eval(() => window.SilinxApp.openFsm('src/pt.fsm.json'));
  await page.waitFor((ed) => window.Silinx.active?.id === 'fsm:src/pt.fsm.json' && document.querySelector(ed), [ED]);
  await page.eval(TEXTS);
  const setLang = (l) => page.eval(async (x) => { (await import('/js/i18n.js')).setLanguage(x); }, l);
  const missing = [];
  const SAME = [/^(Moore|Mealy|Gray|One-hot|<\/> HDL|VHDL|Verilog|[A-C]|x|y|z|[xyz] = \d+|\d+)$/, /^@?e\.g\./];
  const check = async (where) => {
    await setLang('en'); const en = await page.eval((ed) => window.__uiTexts(document.querySelector(ed)), ED);
    await setLang('pt'); const pt = await page.eval((ed) => window.__uiTexts(document.querySelector(ed)), ED);
    for (const s of untranslated(en, pt, SAME)) missing.push(`${where}: ${s}`);
  };
  await check('editor');
  // problems (an overlap warning, an info), a state, a transition
  assert.match(await page.eval((ed) => document.querySelector(`${ed} .fsm-problems`).textContent, ED), /Estado A: as transições para B \('x'\) e para C \('y == 1'\) são ambas verdadeiras quando x=1, y=01/);
  assert.match(await page.eval((ed) => document.querySelector(`${ed} .fsm-problems`).textContent, ED), /nenhuma transição é verdadeira quando/);
  await page.click(`${ED} [data-state=a] .fsm-circle`);
  await check('state');
  await page.click(`${ED} [data-trans=t3] .fsm-label`);
  await check('transition');
  for (const tab of ['Tables', '</> HDL', '▶ Simulate']) {
    await setLang('en');
    await page.click(`${ED} .fsm-tab-btn`, { text: tab });
    await check(tab);
  }
  assert.deepEqual(missing, [], `untranslated:\n${missing.join('\n')}`);
  await setLang('pt');
  assert.equal(await page.eval((ed) => document.querySelector(`${ed} .fsm-gen`).textContent, ED), 'Gerar HDL');
  await setLang('en');
});
