// UI: schematic editor (place symbols, wire them, I/O markers, save, Generate HDL), ASM chart
// editor (states, decision, case box, connections, Generate HDL), print preview of a diagram.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupUi, uiTest, makeProject, readWs, waitDownload, chromeOnly } from './harness.js';
import { compile, elaborate } from '../../core/compile.js';

let env;
before(async () => { env = await setupUi(); });
after(async () => { await env?.teardown?.(); });
const E = () => env;

// New Source wizard: a type of the list, a file name, then Next until Finish
async function newSource(page, type, name) {
  await page.menu('Project', 'New Source…');
  await page.waitDialog('New Source Wizard');
  await page.click('.dlg-overlay .src-types .st', { text: type });
  await page.fill('.dlg-overlay .wiz-main input[type=text]', name);
  for (let i = 0; i < 4; i++) {
    const last = await page.eval(() => [...document.querySelectorAll('.dlg-overlay .dlg-buttons .btn')].some((b) => b.textContent === 'Finish'));
    if (last) break;
    await page.dialogButton('Next >');
  }
  await page.dialogButton('Finish');
  await page.waitNoDialog();
}

// screen position of a pin of a schematic symbol (sheet coordinates through the view transform)
const SCH_PIN = `window.__schPin = async (symIndex, dir) => {
  const sd = await import('/core/schdoc.js');
  const doc = window.Silinx.active.schEditor.getDoc();
  const s = doc.symbols[symIndex];
  const p = sd.symbolPins(s, {}).find((q) => q.dir === dir);
  const svg = document.querySelector('.doc:not([hidden]) .se-svg');
  const r = svg.getBoundingClientRect();
  const m = /translate\\(([-\\d.]+),([-\\d.]+)\\) scale\\(([\\d.]+)\\)/.exec(svg.querySelector('.se-vp').getAttribute('transform'));
  return { x: r.left + +m[1] + p.x * +m[3], y: r.top + +m[2] + p.y * +m[3] };
};`;

uiTest('schematic editor: place two inverters, wire them, add I/O markers, save, Generate HDL', E, async (page) => {
  await makeProject(env, { name: 'SchPj' });
  await page.openProject('SchPj');
  await newSource(page, 'Schematic (Diagram)', 'chain');
  await page.waitFor(() => window.Silinx.active?.id === 'sch:src/chain.sch.json' && document.querySelector('.doc:not([hidden]) .se-symrow'));
  await page.eval(SCH_PIN);
  // the palette: search, then click the symbol and click twice on the sheet
  await page.fill('.doc:not([hidden]) .se-search', 'inv');
  await page.click('.doc:not([hidden]) .se-symrow', { text: 'INV' });
  const c = await page.eval(() => { const r = document.querySelector('.doc:not([hidden]) .se-svg').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.click({ x: c.x - 120, y: c.y });
  await page.click({ x: c.x + 120, y: c.y });
  await page.key('Escape');
  await page.waitFor(() => window.Silinx.active.schEditor.getDoc().symbols.length === 2);
  assert.deepEqual(await page.eval(() => window.Silinx.active.schEditor.getDoc().symbols.map((s) => s.type)), ['inv', 'inv']);
  // wire: output of the first to the input of the second
  await page.click('.doc:not([hidden]) .se-btn[data-act=wire]');
  await page.click(await page.eval(() => window.__schPin(0, 'out')));
  await page.click(await page.eval(() => window.__schPin(1, 'in')));
  await page.waitFor(() => window.Silinx.active.schEditor.getDoc().wires.length === 1);
  // I/O markers on the free pins (name asked in place)
  await page.click('.doc:not([hidden]) .se-btn[data-act=io]');
  for (const [i, dir, name] of [[0, 'in', 'din'], [1, 'out', 'dout']]) {
    await page.click(await page.eval((k, d) => window.__schPin(k, d), i, dir));
    await page.waitFor(() => document.activeElement?.matches('.se-prompt input'), [], { what: 'port name prompt focused' });
    await page.type(name);
    await page.key('Enter');
    await page.waitFor((n) => window.Silinx.active.schEditor.getDoc().ports.some((p) => p.name === n), [name]);
  }
  await page.key('Escape');
  const doc = await page.eval(() => window.Silinx.active.schEditor.getDoc());
  assert.deepEqual(doc.ports.map((p) => `${p.name}:${p.dir}`).sort(), ['din:in', 'dout:out']);
  // the editor's Check has no errors
  await page.click('.doc:not([hidden]) .se-btn[data-act=check]');
  // saved automatically (the .sch.json on disk)
  await page.waitFor(async () => { const d = JSON.parse(await (await fetch('/api/projects/SchPj/file?path=src/chain.sch.json')).text()); return d.symbols.length === 2 && d.ports.length === 2; }, [], { what: 'schematic saved' });
  const saved = JSON.parse(await readWs(env, 'SchPj', 'src/chain.sch.json'));
  assert.equal(saved.symbols.length, 2);
  assert.equal(saved.wires.length, 1);
  assert.equal(saved.ports.length, 2);
  // Generate HDL: src/chain.vhd, linked to the schematic, compiles to two inverters in series
  await page.click('.doc:not([hidden]) .se-btn[data-act=generate]');
  await page.waitConsole(/Schematic 'src\/chain\.sch\.json' -> generated VHDL file src\/chain\.vhd/);
  assert.deepEqual(page.dialogs, [], 'no "generate anyway?" question: the schematic has no errors');
  const vhd = await readWs(env, 'SchPj', 'src/chain.vhd');
  assert.match(vhd, /entity chain is/i);
  const lib = compile([{ path: 'src/chain.vhd', lang: 'vhdl', text: vhd }]);
  const d = elaborate(lib, 'chain');
  assert.deepEqual([...lib.errors, ...d.diags].filter((x) => x.severity === 'error').map((x) => x.message), []);
  assert.deepEqual(d.top.ports.map((p) => `${p.name}:${p.dir}`).sort(), ['din:in', 'dout:out']);
  // in the hierarchy the schematic is the module, with its synchronized HDL under it
  await page.waitFor(() => [...document.querySelectorAll('#hier .row')].some((r) => r.querySelector('.lbl').textContent === 'chain' && /chain\.sch\.json/.test(r.querySelector('.meta')?.textContent)));
  assert.ok(await page.eval(() => [...document.querySelectorAll('#hier .row .meta')].some((e) => e.textContent === '(synchronized HDL)')));
  // View HDL shows the code; Close
  await page.click('.doc:not([hidden]) .se-btn[data-act=view]');
  await page.waitFor(() => /entity chain is/i.test(document.querySelector('.doc:not([hidden]) .se-code')?.textContent || ''));
  await page.click('.doc:not([hidden]) .se-dialog .btn', { text: 'Close' });
});

uiTest('ASM chart editor: add a state, a decision and a case box, connect them, Generate VHDL', E, async (page) => {
  await makeProject(env, { name: 'AsmPj' });
  await page.openProject('AsmPj');
  // Tools ▸ ASM State Machine Editor… opens the New Source wizard on the ASM type
  await page.menu('Tools', 'ASM State Machine Editor…');
  await page.waitDialog('New Source Wizard');
  assert.equal(await page.eval(() => document.querySelector('.dlg-overlay .src-types .st.sel').textContent), 'State Machine (ASM)');
  await page.fill('.dlg-overlay .wiz-main input[type=text]', 'ctrl');
  await page.dialogButton('Next >');
  await page.dialogButton('Finish');
  await page.waitNoDialog();
  await page.waitFor(() => window.Silinx.active?.id === 'asm:src/ctrl.asm.json' && document.querySelector('.doc:not([hidden]) [data-node]'));
  const model = () => page.eval(() => window.Silinx.active.asmEditor.getModel());
  const ids0 = new Set((await model()).nodes.map((n) => n.id));
  const tool = (label) => page.click('.doc:not([hidden]) .asm-toolbar .asm-btn', { text: label });
  // a point inside a node / port that is really on top (boxes may touch)
  const at = (sel) => page.eval((s) => {
    const e = document.querySelector(`.doc:not([hidden]) ${s}`);
    const r = e.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.3, 0.5], [0.7, 0.5], [0.5, 0.7]]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === e || e.contains(hit) || hit.closest(s) === e)) return { x, y };
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  const arrange = async () => { await tool('Arrange'); await tool('Fit'); };
  // wait until the node stops moving (Arrange / Fit lay out over several frames on a slow machine)
  const settled = async (sel) => {
    let last = '';
    for (let i = 0; i < 40; i++) {
      const p = JSON.stringify(await at(sel));
      if (p === last) return JSON.parse(p);
      last = p;
      await new Promise((r) => setTimeout(r, 100));
    }
    return JSON.parse(last);
  };
  const isSel = (id) => page.eval((i) => !!document.querySelector(`.doc:not([hidden]) [data-node="${i}"]`)?.classList.contains('sel'), id);
  const select = async (id) => {
    await arrange();
    for (let k = 0; k < 3 && !await isSel(id); k++) {
      await page.click(await settled(`[data-node="${id}"]`));
      await page.waitFor((i) => document.querySelector(`.doc:not([hidden]) [data-node="${i}"]`)?.classList.contains('sel'), [id], { timeout: 3000 }).catch(() => {});
    }
    assert.ok(await isSel(id), `node ${id} selected`);
  };
  const newest = async (type) => (await model()).nodes.filter((n) => n.type === type && !ids0.has(n.id)).map((n) => n.id);
  // nothing selected: a free state
  await page.click('.doc:not([hidden]) .asm-canvas', {});
  await page.key('Escape');
  await tool('State');
  const [s0] = await newest('state');
  // with the new state selected: a decision on its exit, then a case box on the decision's 1 exit
  await tool('Decision');
  const [d0] = await newest('decision');
  await tool('Case');
  const [c0] = await newest('case');
  let m = await model();
  assert.ok(m.edges.some((e) => e.from === s0 && e.to === d0 && e.port === 'next'));
  assert.ok(m.edges.some((e) => e.from === d0 && e.to === c0 && e.port === 'true'));
  // two states on the case exits (one per value of the 1-bit input), one on the decision's 0 exit
  await select(c0); await tool('State');
  await select(c0); await tool('State');
  await select(d0); await tool('State');
  const added = await newest('state');
  assert.equal(added.length, 4);
  m = await model();
  assert.deepEqual(m.edges.filter((e) => e.from === c0).map((e) => e.port).sort(), ['0', '1']);
  assert.ok(m.edges.some((e) => e.from === d0 && e.port === 'false'));
  // the new end states go back to the initial state: drag from their free exit to IDLE
  const idle = m.nodes.find((n) => n.name === 'IDLE').id;
  for (const s of added.filter((x) => x !== s0)) {
    await arrange();
    await page.drag(await settled(`[data-node="${s}"] [data-port="next"]`), await settled(`[data-node="${idle}"]`));
    await page.waitFor((a, b) => window.Silinx.active.asmEditor.getModel().edges.some((e) => e.from === a && e.to === b), [s, idle], { what: `${s} -> IDLE` });
  }
  // the free state S0 is unreachable: a warning, not an error
  await page.click('.doc:not([hidden]) .asm-btn', { text: '✓ Validate' });
  await page.waitFor(() => /· 7 states · 0 errors/.test(document.querySelector('.doc:not([hidden]) .asm-status')?.textContent || ''), [], { what: 'chart valid' });
  const final = await model();
  // Generate HDL: src/ctrl.vhd written, opened, linked to the chart
  await page.click('.doc:not([hidden]) .asm-btn.asm-primary');
  await page.waitConsole(/ASM chart 'src\/ctrl\.asm\.json' -> VHDL file src\/ctrl\.vhd/);
  await page.waitFor(() => window.Silinx.active?.id === 'file:src/ctrl.vhd');
  const vhd = await readWs(env, 'AsmPj', 'src/ctrl.vhd');
  assert.match(vhd, /entity ctrl is/i);
  for (const st of ['IDLE', 'RUN', 'FINISH', ...final.nodes.filter((n) => added.includes(n.id)).map((n) => n.name)]) assert.match(vhd, new RegExp(`\\b${st}\\b`), `state ${st} in the VHDL`);
  assert.match(vhd, /case/i);
  const lib = compile([{ path: 'src/ctrl.vhd', lang: 'vhdl', text: vhd }]);
  assert.deepEqual([...lib.errors, ...elaborate(lib, 'ctrl').diags].filter((x) => x.severity === 'error').map((x) => x.message), []);
  const saved = JSON.parse(await readWs(env, 'AsmPj', 'src/ctrl.asm.json'));
  assert.equal(saved.generatedFile, 'src/ctrl.vhd');
  assert.equal(saved.nodes.length, final.nodes.length);
  // the hierarchy shows the chart as the module
  await page.waitFor(() => [...document.querySelectorAll('#hier .row .meta')].some((e) => e.textContent === '(ctrl.asm.json)'));
});

uiTest('print preview of a diagram: File ▸ Print… dialog, Save SVG, Print… opens the print page', E, async (page) => {
  await makeProject(env, { name: 'PrintPj', template: 'blinky' });
  await page.openProject('PrintPj');
  await page.eval(() => window.SilinxApp.openAsm('src/speed_ctrl.asm.json'));
  await page.waitFor(() => window.Silinx.active?.asmEditor && document.querySelector('.doc:not([hidden]) [data-node]'));
  await page.menu('File', 'Print…');
  await page.waitDialog('Print — ASM chart speed_ctrl');
  assert.match(await page.eval(() => document.querySelector('.dlg-overlay').innerText), /\d+ pages? \(\d+ across × \d+ down\), A4 (landscape|portrait)/);
  // two pages across: the page count follows
  await page.eval(() => { const i = document.querySelector('.dlg-overlay input[type=number]'); i.value = '2'; i.dispatchEvent(new Event('input')); });
  await page.waitFor(() => /\(2 across/.test(document.querySelector('.dlg-overlay').innerText));
  await page.dialogButton('Save SVG');
  const svgFile = await waitDownload(page, 'speed_ctrl_asm.svg');
  const fs = await import('node:fs/promises');
  assert.match(await fs.readFile(svgFile, 'utf8'), /^<svg[\s\S]*IDLE[\s\S]*<\/svg>\s*$/);
  // Print…: a new page with the drawing (Ctrl+P does the same)
  await page.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  const pages = async () => (await env.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && t.browserContextId === page.contextId);
  const before = (await pages()).length;
  await page.key('p', { modifiers: 2 });
  await page.waitDialog('Print — ASM chart speed_ctrl');
  await page.dialogButton('Print…');
  await page.waitNoDialog();
  const t0 = Date.now();
  let opened = false;
  while (Date.now() - t0 < 5000 && !opened) {
    opened = (await pages()).length > before || await page.eval(() => !!document.querySelector('iframe'));
    if (!opened) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(opened, 'the print page was opened');
}, { skip: chromeOnly });   // (the new page is found with Target.getTargets)
