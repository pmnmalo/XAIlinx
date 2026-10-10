// UI: projects — New Project wizard (every board, every device family), open / switch / close,
// Add Copy of Source (overwrite confirmation), files view rename / remove, Silinx and Xilinx zip
// export + import, a failing import keeps the project it would replace.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupUi, uiTest, makeProject, readWs, waitDownload } from './harness.js';

let env;
before(async () => { env = await setupUi(); });
after(async () => { await env?.teardown?.(); });
const E = () => env;

// New Project wizard: page 1 name (+ template), page 2 board / device / language, page 3 summary
async function newProject(page, { name, template = 'empty', board = '', family, part, lang, top }) {
  await page.menu('File', 'New Project…');
  await page.waitDialog('New Project Wizard');
  await page.fill('.dlg-overlay .wiz-main input[type=text]', name);
  if (template !== 'empty') await page.fill('.dlg-overlay .wiz-main select', template, { index: 0 });
  await page.dialogButton('Next >');
  await page.waitFor(() => document.querySelector('.dlg-overlay .wiz-main h3')?.textContent === 'Project Settings');
  if (board) await page.fill('.dlg-overlay .wiz-main select', board, { index: 0 });
  if (family) await page.fill('.dlg-overlay .wiz-main select', family, { index: 2 });
  if (part) await page.fill('.dlg-overlay .wiz-main select', part, { index: 3 });
  if (lang) await page.fill('.dlg-overlay .wiz-main select', lang, { index: 9 });
  if (top) await page.fill('.dlg-overlay .wiz-main select', top, { index: 6 });   // Top-Level Source Type
  const settings = await page.eval(() => {
    const s = [...document.querySelectorAll('.dlg-overlay .wiz-main select')];
    return { board: s[0].value, family: s[2].value, part: s[3].value, pkg: s[4].value, speed: s[5].value, disabled: s[2].disabled, parts: [...s[3].options].map((o) => o.value) };
  });
  await page.dialogButton('Next >');
  await page.waitFor(() => document.querySelector('.dlg-overlay .wiz-main h3')?.textContent === 'Project Summary');
  const summary = await page.eval(() => document.querySelector('.dlg-overlay .wiz-main pre').textContent);
  await page.dialogButton('Finish');
  await page.waitNoDialog();
  await page.waitFor((n) => window.Silinx.project?.name === n, [name], { what: `project ${name} open` });
  return { settings, summary, project: await page.eval(() => window.Silinx.project) };
}

uiTest('New Project wizard: one project per evaluation board (board fixes the device)', E, async (page) => {
  const db = await env.server.api('GET', '/api/devices');
  assert.ok(db.boards.length >= 3);
  for (const b of db.boards) {
    const name = `B_${b.id.replace(/\W/g, '_')}`;
    const r = await newProject(page, { name, board: b.id, lang: b.id === 'nexys2' ? 'verilog' : undefined });
    assert.equal(r.settings.disabled, true, `${b.id}: device fields follow the board`);
    assert.equal(r.settings.part, b.device.part);
    assert.match(r.summary, new RegExp(`Board:\\s+${b.name.replace(/[()+.]/g, '\\$&')}`));
    assert.equal(r.project.board, b.id);
    assert.deepEqual({ part: r.project.device.part, package: r.project.device.package }, { part: b.device.part, package: b.device.package });
    assert.equal(r.project.preferredLanguage, b.id === 'nexys2' ? 'verilog' : 'vhdl');
    // the status bar and the hierarchy follow the new project a moment after it opens
    await page.waitFor((part, id) => { const t = document.getElementById('status-device').textContent; return t.includes(part) && t.includes(id); }, [b.device.part, b.id], { what: `status bar shows ${b.id}` });
    await page.waitFor((n) => document.querySelector('#hier .row .lbl')?.textContent === n, [name], { what: `hierarchy shows ${name}` });
  }
  const list = await env.server.api('GET', '/api/projects');
  assert.equal(list.filter((p) => p.name.startsWith('B_')).length, db.boards.length);
});

uiTest('New Project wizard: every device family (no board), the device list follows the family; an example template', E, async (page) => {
  const db = await env.server.api('GET', '/api/devices');
  const families = db.families.filter((f) => (f.parts || []).length);
  assert.ok(families.length >= 5);
  for (const f of families) {
    const parts = db.parts.filter((p) => p.family === f.id);
    const last = parts[parts.length - 1];
    const r = await newProject(page, { name: `F_${f.id}`, family: f.id, part: last.part });
    assert.deepEqual(r.settings.parts, parts.map((p) => p.part), `${f.id}: device list`);
    assert.equal(r.settings.disabled, false);
    assert.equal(r.project.board, null);
    assert.equal(r.project.device.part, last.part);
    assert.ok(Object.keys(last.packages).includes(r.project.device.package));
    assert.ok(last.speeds.includes(r.project.device.speed));
  }
  // from the blinky example: its sources, hierarchy and constraints
  const r = await newProject(page, { name: 'FromExample', template: 'blinky', board: 'basys2' });
  assert.equal(r.project.top, 'top');
  await page.waitFor(() => [...document.querySelectorAll('#hier .lbl')].some((e) => e.textContent === 'u_knight - knight'));
  const files = r.project.files.map((x) => x.path).sort();
  assert.ok(files.includes('src/top.vhd') && files.includes('sim/tb_top.vhd'), files.join(','));
  assert.equal(await readWs(env, 'FromExample', 'src/counter.v').then((t) => /module prescaler/.test(t)), true);
});

uiTest('open, switch and close projects (Open Project dialog, Recent Projects, Start page)', E, async (page) => {
  for (const n of ['Alpha', 'Beta']) {
    await makeProject(env, { name: n, files: { [`src/${n.toLowerCase()}.vhd`]: `library ieee; use ieee.std_logic_1164.all;\nentity ${n.toLowerCase()} is port (a : in std_logic; y : out std_logic); end;\narchitecture r of ${n.toLowerCase()} is begin y <= not a; end r;\n` }, top: n.toLowerCase() });
  }
  // Open Project dialog: select a row, Open
  await page.menu('File', 'Open Project…');
  await page.waitDialog('Open Project');
  await page.click('.dlg-overlay table.grid tr', { text: 'Alpha' });
  await page.dialogButton('Open');
  await page.waitFor(() => window.Silinx.project?.name === 'Alpha' && document.querySelector('#hier .row .lbl')?.textContent === 'Alpha');
  assert.match(await page.eval(() => document.title), /^Alpha — Silinx ISE/);
  await page.waitFor(() => window.SilinxApp.findDoc('summary'));
  await page.eval(() => window.SilinxApp.openFile('src/alpha.vhd'));
  await page.waitFor(() => window.SilinxApp.findDoc('file:src/alpha.vhd')?.editor);
  // switch: double-click the other project; the documents of the first one are closed
  await page.menu('File', 'Open Project…');
  await page.waitDialog('Open Project');
  await page.dblclick('.dlg-overlay table.grid tr', { text: 'Beta' });
  await page.waitFor(() => window.Silinx.project?.name === 'Beta' && document.querySelector('#hier .row .lbl')?.textContent === 'Beta');
  await page.waitNoDialog();
  assert.equal(await page.eval(() => window.Silinx.docs.some((d) => d.project === 'Alpha')), false);
  assert.ok(await page.eval(() => [...document.querySelectorAll('#hier .lbl')].some((e) => e.textContent === 'beta')));
  // Recent Projects lists both, newest first; choosing one switches back
  const items = await page.openMenu('File');
  await page.hover(await page.point('body > .menu-popup > .mi', { index: items.findIndex((i) => i.label === 'Recent Projects') }));
  await page.waitForSelector('.menu-popup.sub .mi');
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll('.menu-popup.sub .mi .lbl')].map((e) => e.textContent)), ['Beta', 'Alpha', 'Clear Recent Projects']);
  await page.click('.menu-popup.sub .mi', { text: 'Alpha' });
  await page.waitFor(() => window.Silinx.project?.name === 'Alpha');
  // Close Project: back to the Start page, project items disabled
  await page.menu('File', 'Close Project');
  await page.waitFor(() => window.Silinx.project === null && !document.querySelector('[data-page=start]').hidden);
  assert.match(await page.eval(() => document.getElementById('hier').innerText), /No project open/);
  assert.equal(await page.eval(() => window.Silinx.docs.length), 0);
  const file = await page.openMenu('File');
  assert.equal(file.find((i) => i.label === 'Close Project').disabled, true);
  assert.equal(file.find((i) => i.label === 'Export Silinx ISE Project (.zip)…').disabled, true);
  await page.closeMenus();
  // the Start page opens a recent project
  await page.waitFor(() => [...document.querySelectorAll('#start-page a')].some((a) => a.textContent === 'Beta'));
  await page.click('#start-page a', { text: 'Beta' });
  await page.waitFor(() => window.Silinx.project?.name === 'Beta' && !document.querySelector('[data-page=design]').hidden);
  // the last project is reopened when the page is loaded again
  await page.goto(env.server.url);
  await page.waitFor(() => window.Silinx?.project?.name === 'Beta');
  // File ▸ Recent Projects ▸ Clear Recent Projects: the list is empty (the projects stay)
  const recentSub = async () => {
    const it = await page.openMenu('File');
    await page.hover(await page.point('body > .menu-popup > .mi', { index: it.findIndex((i) => i.label === 'Recent Projects') }));
    await page.waitForSelector('.menu-popup.sub .mi');
    return page.eval(() => [...document.querySelectorAll('.menu-popup.sub .mi')].map((r) => [r.querySelector('.lbl').textContent, r.classList.contains('disabled')]));
  };
  await recentSub();
  await page.click('.menu-popup.sub .mi', { text: 'Clear Recent Projects' });
  await page.waitFor(() => !localStorage.getItem('silinx.recent'), [], { what: 'recent list cleared' });
  // the menus closed before File is opened again (a click on an open menu closes it)
  await page.waitFor(() => !document.querySelector('.menu-popup') && !document.querySelector('#menubar .item.open'), [], { what: 'menus closed' });
  assert.deepEqual(await recentSub(), [['Clear Recent Projects', true]]);
  await page.closeMenus();
  assert.deepEqual((await env.server.api('GET', '/api/projects')).map((p) => p.name).filter((n) => ['Alpha', 'Beta'].includes(n)).sort(), ['Alpha', 'Beta'], 'the projects are kept');
  // the Start page: no recent projects; opening one lists it again, and its Clear link empties the list
  await page.menu('File', 'Close Project');
  await page.waitFor(() => !document.querySelector('[data-page=start]').hidden && document.querySelector('#start-page .start-box'));
  assert.deepEqual(await page.eval(() => [...document.querySelectorAll('#start-page .start-box')][1].querySelectorAll('a').length), 0);
  await page.openProject('Alpha');
  await page.menu('File', 'Close Project');
  await page.waitFor(() => [...document.querySelectorAll('#start-page a')].some((a) => a.textContent === 'Alpha'));
  await page.click('#start-page a', { text: 'Clear Recent Projects' });
  await page.waitFor(() => ![...document.querySelectorAll('#start-page a')].some((a) => a.textContent === 'Alpha' || a.textContent === 'Clear Recent Projects'), [], { what: 'Start page list cleared' });
});

uiTest('Add Copy of Source: new files, association, overwrite confirmation (No keeps, Yes replaces)', E, async (page) => {
  const orig = 'library ieee; use ieee.std_logic_1164.all;\nentity inv is port (a : in std_logic; y : out std_logic); end inv;\narchitecture r of inv is begin y <= not a; end r;\n';
  await makeProject(env, { name: 'Copies', files: { 'src/inv.vhd': orig }, top: 'inv' });
  await page.openProject('Copies');
  const dir = path.join(env.tmp, 'to-add');
  await fs.mkdir(dir, { recursive: true });
  const changed = orig.replace('not a', 'a');
  await fs.writeFile(path.join(dir, 'inv.vhd'), changed);
  await fs.writeFile(path.join(dir, 'buf2.v'), 'module buf2(input a, output y); assign y = a; endmodule\n');
  await fs.writeFile(path.join(dir, 'tb_buf2.v'), 'module tb_buf2; reg a = 0; wire y; buf2 u(.a(a), .y(y)); initial begin #10 a = 1; #10 $finish; end endmodule\n');
  const add = async (files, role, answer) => {
    await page.menu('Project', 'Add Copy of Source…');
    await page.waitDialog('Add Copy of Source');
    await page.setFiles('.dlg-overlay input[type=file]', files.map((f) => path.join(dir, f)));
    await page.fill('.dlg-overlay select', role);
    await page.dialogButton('OK');
    if (answer) {
      await page.waitDialog('Add Copy of Source');
      assert.match(await page.eval(() => [...document.querySelectorAll('.dlg-overlay')].pop().innerText), /src\/inv\.vhd already exists in the project\. Replace it with the copy of inv\.vhd\?/);
      await page.dialogButton(answer);
    }
    await page.waitNoDialog();
  };
  await add(['inv.vhd', 'buf2.v'], 'design', 'No');
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/buf2.v'));
  assert.equal(await readWs(env, 'Copies', 'src/inv.vhd'), orig, 'No: the project file is kept');
  await page.waitConsole(/Added 1 source file\(s\)\./);
  await page.waitFor(() => [...document.querySelectorAll('#hier .lbl')].some((e) => e.textContent === 'buf2'));
  // a simulation-only copy goes to sim/ with the Simulation association
  await add(['tb_buf2.v'], 'sim');
  await page.waitFor(() => window.Silinx.project.files.find((f) => f.path === 'sim/tb_buf2.v')?.role === 'sim');
  assert.equal(await page.eval(() => window.Silinx.project.files.find((f) => f.path === 'src/buf2.v').role), 'design');
  // an implementation-only copy: in the Implementation view, not in the Simulation view; Files and Source Properties show it
  await fs.writeFile(path.join(dir, 'syn_only.v'), 'module syn_only(input a, output y); assign y = ~a; endmodule\n');
  await add(['syn_only.v'], 'impl');
  await page.waitFor(() => window.Silinx.project.files.find((f) => f.path === 'src/syn_only.v')?.role === 'impl', [], { what: 'syn_only.v implementation only' });
  await page.waitFor(() => [...document.querySelectorAll('#hier .lbl')].some((e) => e.textContent === 'syn_only'), [], { what: 'syn_only in the Implementation view' });
  await page.click('#left-tabs .tab[data-page=design]');
  await page.waitFor(() => document.querySelector('input[name=view][value=sim]')?.getClientRects().length > 0, [], { what: 'Design page shown' });
  await page.click('input[name=view][value=sim]');
  await page.waitFor(() => ![...document.querySelectorAll('#hier .lbl')].some((e) => e.textContent === 'syn_only') && [...document.querySelectorAll('#hier .lbl')].some((e) => e.textContent === 'tb_buf2'), [], { what: 'syn_only hidden in the Simulation view' });
  await page.click('input[name=view][value=impl]');
  await page.click('#left-tabs .tab[data-page=files]');
  await page.waitFor(() => [...document.querySelectorAll('#files-page tr')].some((r) => r.cells[0]?.textContent === 'src/syn_only.v' && r.cells[1]?.textContent === 'Implementation'), [], { what: 'Files view: Implementation' });
  await page.click('#left-tabs .tab[data-page=design]');
  // Yes: replaced, and the open editor of that file shows the new text after reopening
  await add(['inv.vhd'], 'design', 'Yes');
  await page.waitFor(async () => true);
  await page.waitConsole(/(Added 1 source file\(s\)\.[\s\S]*){4}/);   // buf2, tb_buf2, syn_only, then inv replaced
  assert.equal(await readWs(env, 'Copies', 'src/inv.vhd'), changed);
  // Files view: every file with its association
  await page.click('#left-tabs .tab[data-page=files]');
  const rows = await page.eval(() => [...document.querySelectorAll('#files-page tr')].slice(1).map((r) => [...r.cells].map((c) => c.textContent).join('|')));
  assert.ok(rows.includes('src/inv.vhd|All|vhdl') && rows.includes('src/buf2.v|All|verilog') && rows.includes('sim/tb_buf2.v|Simulation|verilog'), rows.join('\n'));
});

uiTest('Files view: rename a file into another folder, remove a file (right-click)', E, async (page) => {
  await makeProject(env, {
    name: 'FilesPj', top: 'a',
    files: {
      'src/a.vhd': 'library ieee; use ieee.std_logic_1164.all;\nentity a is port (x : in std_logic; y : out std_logic); end a;\narchitecture r of a is begin y <= x; end r;\n',
      'src/b.v': 'module b(input x, output y); assign y = ~x; endmodule\n',
    },
  });
  await page.openProject('FilesPj');
  await page.click('#left-tabs .tab[data-page=files]');
  const row = (text) => page.waitFor((t) => { const r = [...document.querySelectorAll('#files-page tr')].findIndex((tr) => tr.cells[0]?.textContent === t); return r >= 0 ? r + 1 : 0; }, [text]).then((i) => i - 1);
  // rename src/a.vhd -> rtl/core/a.vhd
  await page.rightClick('#files-page tr', { index: await row('src/a.vhd') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Rename…' });
  await page.waitDialog('Rename');
  await page.fill('.dlg-overlay input[type=text]', 'rtl/core/a.vhd', { index: 1 });
  await page.dialogButton('Rename');
  await page.waitNoDialog();
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'rtl/core/a.vhd'));
  assert.equal(await page.eval(() => window.Silinx.project.files.some((f) => f.path === 'src/a.vhd')), false);
  assert.match(await readWs(env, 'FilesPj', 'rtl/core/a.vhd'), /entity a is/);
  await assert.rejects(fs.access(path.join(env.server.workspace, 'FilesPj', 'src/a.vhd')));
  await page.waitConsole(/Rename: src\/a\.vhd → rtl\/core\/a\.vhd\./);
  // remove src/b.v (confirmation): out of the project, but the file stays in the folder ("Not in project")
  await page.rightClick('#files-page tr', { index: await row('src/b.v') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Remove from Project' });
  await page.waitDialog('Remove Source');
  assert.match(await page.eval(() => [...document.querySelectorAll('.dlg-overlay')].pop().innerText), /The file stays in the project folder/);
  await page.dialogButton('Yes');
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'src/b.v'));
  await fs.access(path.join(env.server.workspace, 'FilesPj', 'src/b.v'));   // still on disk
  await page.waitFor(() => [...document.querySelectorAll('#files-page tr')].some((r) => r.cells[0]?.textContent === 'src/b.v' && r.cells[1]?.textContent === 'Not in project'), [], { what: 'Not in project row' });
  assert.ok(!(await page.eval(() => [...document.querySelectorAll('#hier .lbl')].map((e) => e.textContent))).includes('b'));
  // Undo (the toast button): back in the project
  await page.click('.toast .toast-action', { text: 'Undo' });
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v' && f.role === 'design'), [], { what: 'undo: b.v back' });
  await page.waitFor(() => [...document.querySelectorAll('#files-page tr')].some((r) => r.cells[0]?.textContent === 'src/b.v' && r.cells[1]?.textContent === 'All'), [], { what: 'b.v row in the project again' });
  // remove again, then Edit ▸ Undo Remove from Project
  await page.rightClick('#files-page tr', { index: await row('src/b.v') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Remove from Project' });
  await page.waitDialog('Remove Source');
  await page.dialogButton('Yes');
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'src/b.v'));
  await page.menu('Edit', 'Undo Remove from Project');
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'Edit undo: b.v back' });
  await page.waitFor(() => [...document.querySelectorAll('#files-page tr')].some((r) => r.cells[0]?.textContent === 'src/b.v' && r.cells[1]?.textContent === 'All'), [], { what: 'b.v row in the project again' });
  // remove again, then the toolbar's Undo button
  await page.rightClick('#files-page tr', { index: await row('src/b.v') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Remove from Project' });
  await page.waitDialog('Remove Source');
  await page.dialogButton('Yes');
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'src/b.v'));
  await page.click('#toolbar .tb-btn[title=Undo]');
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'toolbar undo: b.v back' });
  // Redo: the toolbar button removes it again (no question), Ctrl+Z / Ctrl+Shift+Z and Ctrl+Y alternate
  const inPj = () => page.eval(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v'));
  await page.click('#toolbar .tb-btn[title=Redo]');
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'toolbar redo: b.v out' });
  assert.equal(await page.dialogCount(), 0);
  await page.eval(() => document.activeElement?.blur?.());
  await page.key('z', { modifiers: 2 });
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'Ctrl+Z: back' });
  await page.key('z', { modifiers: 2 | 8 });
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'Ctrl+Shift+Z: out' });
  await page.key('z', { modifiers: 2 });
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'Ctrl+Z: back again' });
  const edit = await page.openMenu('Edit');
  assert.ok(edit.some((i) => i.label === 'Redo Remove from Project' && !i.disabled), edit.map((i) => i.label).join(' | '));
  await page.closeMenus();
  await page.key('y', { modifiers: 2 });
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'Ctrl+Y: out' });
  await page.menu('Edit', 'Undo Remove from Project');
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'Edit undo: back' });
  assert.ok(await inPj());
  await page.waitFor(() => [...document.querySelectorAll('#files-page tr')].some((r) => r.cells[0]?.textContent === 'src/b.v' && r.cells[1]?.textContent === 'All'), [], { what: 'b.v row in the project again' });
  // remove once more, then right-click the "Not in project" row ▸ Add to Project
  await page.rightClick('#files-page tr', { index: await row('src/b.v') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Remove from Project' });
  await page.waitDialog('Remove Source');
  await page.dialogButton('Yes');
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'src/b.v'));
  await page.waitFor(() => [...document.querySelectorAll('#files-page tr')].some((r) => r.cells[1]?.textContent === 'Not in project'));
  await page.rightClick('#files-page tr', { index: await row('src/b.v') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Add to Project' });
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'src/b.v'), [], { what: 'Add to Project' });
});

uiTest('Files view: rename a folder (its files and subfolders follow, still registered), delete a folder', E, async (page) => {
  await makeProject(env, {
    name: 'FoldPj', top: 'a',
    files: {
      'src/a.vhd': 'library ieee; use ieee.std_logic_1164.all;\nentity a is port (x : in std_logic; y : out std_logic); end a;\narchitecture r of a is begin y <= x; end r;\n',
      'src/sub/b.v': 'module b(input x, output y); assign y = ~x; endmodule\n',
      'old/c.v': 'module c(input x, output y); assign y = x; endmodule\n',
    },
  });
  await page.openProject('FoldPj');
  await page.click('#left-tabs .tab[data-page=files]');
  const folderRow = (dir) => page.waitFor((d) => { const i = [...document.querySelectorAll('#files-page tr')].findIndex((tr) => tr.dataset.folder === d); return i >= 0 ? i + 1 : 0; }, [dir]).then((i) => i - 1);
  // rename src -> rtl: both files (also the one in src/sub) move and stay registered
  await page.rightClick('#files-page tr', { index: await folderRow('src') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Rename Folder…' });
  await page.waitDialog('Rename Folder');
  await page.fill('.dlg-overlay input[type=text]', 'rtl');
  await page.dialogButton('OK');
  await page.waitFor(() => window.Silinx.project.files.some((f) => f.path === 'rtl/sub/b.v') && window.Silinx.project.files.some((f) => f.path === 'rtl/a.vhd'));
  assert.equal(await page.eval(() => window.Silinx.project.files.some((f) => f.path.startsWith('src/'))), false);
  assert.match(await readWs(env, 'FoldPj', 'rtl/sub/b.v'), /module b/);
  await assert.rejects(fs.access(path.join(env.server.workspace, 'FoldPj', 'src')));
  // delete the folder old (confirmation): its file is gone and unregistered
  await page.rightClick('#files-page tr', { index: await folderRow('old') });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Delete Folder…' });
  await page.waitDialog('Delete Folder');
  await page.dialogButton('Yes');
  await page.waitFor(() => !window.Silinx.project.files.some((f) => f.path === 'old/c.v'));
  await assert.rejects(fs.access(path.join(env.server.workspace, 'FoldPj', 'old')));
});

uiTest('Silinx and Xilinx zip: export, import as a new project, and a failing import keeps the existing project', E, async (page) => {
  await makeProject(env, { name: 'ZipSrc', template: 'blinky', board: 'basys2' });
  await page.openProject('ZipSrc');
  await page.menu('File', 'Export Silinx ISE Project (.zip)…');
  const silinxZip = await waitDownload(page, 'ZipSrc-silinx.zip');
  await page.menu('File', 'Export Xilinx ISE Project (.zip)…');
  const xilinxZip = await waitDownload(page, 'ZipSrc.zip');
  const srcTree = (await env.server.api('GET', '/api/projects/ZipSrc')).fileTree;

  // import the Silinx zip under a new name: every file and the settings come back
  await page.menu('File', 'Import Silinx ISE Project (.zip)…');
  await page.waitDialog('Import Silinx ISE Project');
  await page.setFiles('.dlg-overlay input[type=file]', [silinxZip]);
  assert.equal(await page.eval(() => document.querySelector('.dlg-overlay input[type=text]').value), 'ZipSrc', 'name suggested from the zip');
  await page.fill('.dlg-overlay input[type=text]', 'ZipCopy');
  await page.dialogButton('Import');
  await page.waitFor(() => window.Silinx.project?.name === 'ZipCopy');
  await page.waitConsole(/Imported Silinx project 'ZipCopy'/);
  const copy = await env.server.api('GET', '/api/projects/ZipCopy');
  assert.deepEqual(copy.fileTree, srcTree);
  assert.equal(copy.board, 'basys2');
  assert.equal(copy.top, 'top');
  assert.equal(await readWs(env, 'ZipCopy', 'src/speed_ctrl.asm.json'), await readWs(env, 'ZipSrc', 'src/speed_ctrl.asm.json'));

  // the Xilinx zip (a .xise and its sources) imports as an ISE project
  await page.menu('File', 'Import Xilinx ISE Project (.zip)…');
  await page.waitDialog('Import Xilinx ISE Project');
  await page.setFiles('.dlg-overlay input[type=file]', [xilinxZip], { index: 1 });
  await page.fill('.dlg-overlay input[type=text]', 'FromIse');
  await page.dialogButton('Import');
  await page.waitFor(() => window.Silinx.project?.name === 'FromIse');
  await page.waitConsole(/Imported Xilinx ISE project 'FromIse'/);
  const ise = await env.server.api('GET', '/api/projects/FromIse');
  assert.equal(ise.top, 'top');
  for (const f of ['src/top.vhd', 'src/knight.vhd', 'src/counter.v', 'constraints/top.ucf']) assert.ok(ise.fileTree.includes(f), `${f} imported: ${ise.fileTree}`);
  assert.ok(await page.eval(() => [...document.querySelectorAll('#hier .lbl')].some((e) => e.textContent === 'u_knight - knight')));

  // a broken zip imported over an existing (open) project: error, and the existing project is still there
  await page.openProject('ZipCopy');
  const bad = path.join(env.tmp, 'broken.zip');
  await fs.writeFile(bad, 'this is not a zip file');
  await page.menu('File', 'Import Silinx ISE Project (.zip)…');
  await page.waitDialog('Import Silinx ISE Project');
  await page.setFiles('.dlg-overlay input[type=file]', [bad]);
  await page.fill('.dlg-overlay input[type=text]', 'ZipCopy');
  await page.dialogButton('Import');
  await page.waitDialog('Replace Project');
  await page.dialogButton('Yes');
  await page.waitFor(() => [...document.querySelectorAll('.dlg-overlay .msg-error')].length);
  assert.match(await page.eval(() => document.querySelector('.dlg-overlay').innerText), /cannot read zip/);
  await page.dialogButton('OK');
  await page.waitNoDialog();
  const kept = await env.server.api('GET', '/api/projects/ZipCopy');
  assert.deepEqual(kept.fileTree, srcTree, 'the project that the import would have replaced is kept');
  assert.equal(kept.board, 'basys2');
  assert.equal(await readWs(env, 'ZipCopy', 'src/top.vhd'), await readWs(env, 'ZipSrc', 'src/top.vhd'));
  // …and it is open again, as it was before the import
  await page.waitFor(() => window.Silinx.project?.name === 'ZipCopy');
});

uiTest('New Project wizard: Top-Level Source Type Schematic / FSM / ASM / Truth Table starts the project with that top and its synchronized HDL', E, async (page) => {
  const cases = [['sch', 'top.sch.json', 'vhdl'], ['fsm', 'top.fsm.json', 'verilog'], ['asm', 'top.asm.json', 'vhdl'], ['tt', 'top.tt.json', 'verilog']];
  for (const [type, file, lang] of cases) {
    const name = `Top_${type}`;
    const r = await newProject(page, { name, lang, top: type });
    assert.match(r.summary, /Top-Level Source Type: (Schematic|State Machine \((FSM|ASM)\)|Truth Table)/);
    await page.waitFor((n) => window.Silinx.project?.name === n && window.Silinx.project.top === 'top', [name], { what: `${name}: top = top` });
    const hdl = `src/top.${lang === 'vhdl' ? 'vhd' : 'v'}`;
    const pj = JSON.parse(await readWs(env, name, 'silinx.json'));
    assert.equal(pj.topSourceType, type);
    assert.ok(pj.files.some((f) => f.path === hdl && f.role === 'design'), JSON.stringify(pj.files));
    const doc = JSON.parse(await readWs(env, name, `src/${file}`));
    assert.equal(doc.generatedFile, hdl);
    assert.match(await readWs(env, name, hdl), lang === 'vhdl' ? /entity top is/ : /module top/);
    // the hierarchy shows the top as that document, and its editor is open
    await page.waitFor((f) => [...document.querySelectorAll('#hier .row')].some((r) => r.textContent.includes(`(${f})`)), [file], { what: `hierarchy shows ${file}` });
    await page.waitFor((f) => String(window.Silinx.active?.id || '').endsWith(`src/${f}`), [file], { what: `${file} editor open` });
  }
  // an example: the type stays HDL (the example has its own sources)
  await page.menu('File', 'New Project…');
  await page.waitDialog('New Project Wizard');
  await page.fill('.dlg-overlay .wiz-main select', 'blinky', { index: 0 });
  await page.fill('.dlg-overlay .wiz-main input[type=text]', 'Top_ex');
  await page.dialogButton('Next >');
  await page.waitFor(() => document.querySelector('.dlg-overlay .wiz-main h3')?.textContent === 'Project Settings');
  assert.deepEqual(await page.eval(() => { const s = document.querySelectorAll('.dlg-overlay .wiz-main select')[6]; return [s.value, s.disabled]; }), ['hdl', true]);
  await page.dialogButton('Cancel');
  await page.waitNoDialog();
});

uiTest('Remove from Project of a diagram (ASM chart): it leaves the hierarchy, the file stays; Undo brings it back', E, async (page) => {
  const { newModel } = await import('../../core/asm.js');
  await makeProject(env, { name: 'ExclPj', files: { 'src/ctl.asm.json': JSON.stringify(newModel('ctl', 'vhdl'), null, 2) } });
  await page.openProject('ExclPj');
  const inHier = () => page.eval(() => [...document.querySelectorAll('#hier .row')].some((r) => r.textContent.includes('ctl.asm.json')));
  await page.waitFor(() => [...document.querySelectorAll('#hier .row')].some((r) => r.textContent.includes('ctl.asm.json')), [], { what: 'chart in the hierarchy' });
  await page.click('#left-tabs .tab[data-page=files]');
  const idx = await page.waitFor(() => { const i = [...document.querySelectorAll('#files-page tr')].findIndex((tr) => tr.cells[0]?.textContent === 'src/ctl.asm.json'); return i >= 0 ? i + 1 : 0; }) - 1;
  await page.rightClick('#files-page tr', { index: idx });
  await page.waitForSelector('body > .menu-popup');
  await page.click('body > .menu-popup .mi', { text: 'Remove from Project' });
  await page.waitDialog('Remove Source');
  await page.dialogButton('Yes');
  await page.waitFor(() => (window.Silinx.project.excluded || []).includes('src/ctl.asm.json'), [], { what: 'chart excluded' });
  await fs.access(path.join(env.server.workspace, 'ExclPj', 'src/ctl.asm.json'));
  await page.click('#left-tabs .tab[data-page=design]');
  await page.waitFor(() => ![...document.querySelectorAll('#hier .row')].some((r) => r.textContent.includes('ctl.asm.json')), [], { what: 'chart left the hierarchy' });
  // the Edit menu has one Undo, which now undoes the removal; Ctrl+Z (outside an editor) does it
  const items = await page.openMenu('Edit');
  assert.ok(items.some((i) => i.label === 'Undo Remove from Project' && !i.disabled), items.map((i) => i.label).join(' | '));
  assert.ok(!items.some((i) => i.label === 'Undo'), 'a single Undo entry');
  await page.closeMenus();
  await page.eval(() => document.activeElement?.blur?.());
  await page.key('z', { modifiers: 2 });
  await page.waitFor(() => !(window.Silinx.project.excluded || []).includes('src/ctl.asm.json'), [], { what: 'undo' });
  await page.waitFor(() => [...document.querySelectorAll('#hier .row')].some((r) => r.textContent.includes('ctl.asm.json')), [], { what: 'chart back in the hierarchy' });
  assert.ok(await inHier());
});
