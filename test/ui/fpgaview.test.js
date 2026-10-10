// UI: View Implemented Design (FPGA) — the chip with the used sites coloured by module, a site's
// logic and connections, nets and the clock network, zoom, and the Design hierarchy and the chip
// selecting each other's modules. The routed design is the XDL fixture (test/fixtures/fpga), put in
// the project's build folder as the 'fpgaview' step of ISE would (no ISE needed).
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupUi, uiTest, makeProject, ROOT } from './harness.js';
import { TEXTS, untranslated } from './i18n-check.js';

let env;
before(async () => { env = await setupUi(); });
after(async () => { await env?.teardown?.(); });
const E = () => env;

const TOP = `library ieee; use ieee.std_logic_1164.all;
entity top is port (clk, a : in std_logic; y : out std_logic); end top;
architecture rtl of top is
  signal q : std_logic;
begin
  u1: entity work.sub port map (clk => clk, a => a, q => q);
  y <= a or q;
end rtl;
`;
const SUB = `library ieee; use ieee.std_logic_1164.all;
entity sub is port (clk, a : in std_logic; q : out std_logic); end sub;
architecture rtl of sub is
  signal r : std_logic := '1';
begin
  process (clk) begin if rising_edge(clk) then r <= a and not r; end if; end process;
  q <= r;
end rtl;
`;

async function routedProject(name) {
  await makeProject(env, { name, files: { 'src/top.vhd': TOP, 'src/sub.vhd': SUB }, top: 'top' });
  const build = path.join(env.server.workspace, name, 'build');
  await fs.mkdir(build, { recursive: true });
  await fs.writeFile(path.join(build, 'top.ncd'), 'NCD');
  const old = new Date(Date.now() - 60000);
  await fs.utimes(path.join(build, 'top.ncd'), old, old);
  for (const f of ['top.xdl', 'device.xdlrc']) await fs.copyFile(path.join(ROOT, 'test', 'fixtures', 'fpga', f), path.join(build, f));
}
const V = '.doc:not([hidden]) .fv';
const idxOf = (page, inst) => page.eval(async (n) => (await (await fetch(`/api/projects/${window.Silinx.project.name}/fpga-view`)).json()).insts.findIndex((i) => i.name === n), inst);

uiTest('FPGA view: chip, modules, a site\'s logic and connections, nets, clock network, zoom; hierarchy and chip select each other', E, async (page) => {
  await routedProject('FpgaPj');
  await page.openProject('FpgaPj');
  // Processes ▸ Implement Design ▸ Place & Route ▸ View Implemented Design (FPGA); here from Tools
  assert.ok(await page.eval(() => [...document.querySelectorAll('#procs .lbl')].some((e) => e.textContent === 'View Implemented Design (FPGA)')));
  await page.menu('Tools', 'Implemented Design (FPGA View)');
  await page.waitFor(() => window.Silinx.active?.id === 'fpgaview' && document.querySelector('.doc:not([hidden]) .fv-site'), [], { what: 'FPGA view open' });
  assert.equal(await page.eval(() => window.Silinx.active.title), 'FPGA (top)');
  // the chip: 7 placed sites drawn (the unplaced one is not), the free sites in one path
  const chip = await page.eval((v) => ({
    used: document.querySelectorAll(`${v} .fv-site`).length,
    free: !!document.querySelector(`${v} .fv-site-free`)?.getAttribute('d'),
    legend: [...document.querySelectorAll(`${v} .fv-mod`)].map((r) => [r.querySelector('.fv-mod-name').textContent, r.querySelector('.fv-mod-n').textContent]),
    util: [...document.querySelectorAll(`${v} .fv-util tr`)].map((r) => [r.cells[0].textContent, r.cells[1].textContent]),
    colours: new Set([...document.querySelectorAll(`${v} .fv-site`)].map((r) => r.style.fill)).size,
  }), V);
  assert.equal(chip.used, 7);
  assert.ok(chip.free);
  assert.deepEqual(chip.legend, [['u1 — sub', '2'], ['top (top level)', '5']]);
  assert.deepEqual(chip.util, [['IOBs', '3 / 4'], ['Global clock buffers', '1 / 1'], ['Slices', '3 / 8'], ['Block RAMs', '0 / 1'], ['Multipliers / DSPs', '0 / 1']]);
  assert.equal(chip.colours, 2, 'one colour per module');

  // a site of u1: its LUT (signal names, without the module path), flip-flop, carry, connections; u1 selected in the hierarchy
  const q = await idxOf(page, 'u1/q');
  await page.click(`${V} .fv-site[data-i="${q}"]`);
  await page.waitFor((v) => /SLICE_X1Y5/.test(document.querySelector(`${v} .fv-detail`).textContent), [V], { what: 'site details' });
  const det = await page.eval((v) => document.querySelector(`${v} .fv-detail`).innerText, V);
  assert.match(det, /Module\s+u1 — sub/);
  assert.match(det, /F u1\/q_next\n= \(a_IBUF · ¬q\)/);
  assert.match(det, /FFX u1\/q/);
  assert.match(det, /clock clk_BUFGP/);
  assert.match(det, /initial value 1/);
  assert.match(det, /XORF u1\/Madd_cnt_xor<0> carry chain/);
  assert.match(det, /Connections[\s\S]*CLK\s+clk_BUFGP/);
  await page.waitFor(() => document.querySelector('#hier .row.sel .lbl')?.textContent === 'u1 - sub', [], { what: 'u1 selected in the hierarchy' });
  // inside the slice: LUT F and FFX used (in the module's colour), LUT G and FFY not; the carry chain; pins with signals
  const inside = await page.eval((v) => ({
    on: [...document.querySelectorAll(`${v} .fv-slice .fv-sb.on`)].map((g) => g.dataset.bel),
    off: [...document.querySelectorAll(`${v} .fv-slice .fv-sb:not(.on)`)].map((g) => g.dataset.bel),
    pins: [...document.querySelectorAll(`${v} .fv-slice .fv-sp.on`)].map((t) => t.firstChild.textContent),
    fill: document.querySelector(`${v} .fv-slice .fv-sb.on rect`).style.fill === document.querySelector(`${v} .fv-site.sel`).style.fill,
  }), V);
  assert.deepEqual(inside.on.sort(), ['CYMUXF', 'F', 'FFX', 'XORF']);
  assert.deepEqual(inside.off.sort(), ['CYMUXG', 'FFY', 'G', 'XORG']);
  assert.deepEqual(inside.pins.sort(), ['CLK', 'F1', 'F2', 'XQ']);
  assert.ok(inside.fill, 'the used parts in the colour of the module');
  // how LUT F implements its function: truth table with the signal names, the 16 memory bits, INIT
  const lut = await page.eval((v) => {
    const c = document.querySelector(`${v} .fv-cell[data-cell="F"]`);
    return {
      head: [...c.querySelectorAll('.fv-tt tr:first-child th div')].map((d) => d.textContent),
      rows: [...c.querySelectorAll('.fv-tt tr')].slice(1).map((r) => [...r.cells].map((x) => x.textContent).join('')),
      mem: [...c.querySelectorAll('.fv-mem span')].map((x) => x.textContent).join(''),
      init: c.querySelector('.fv-lut').textContent.match(/INIT = (\w+)/)?.[1],
    };
  }, V);
  assert.deepEqual(lut.head, ['a_IBUF', 'q']);
  assert.deepEqual(lut.rows, ['000', '010', '101', '110']);
  assert.equal(lut.mem, '0010001000100010', 'address 15 … 0');
  assert.equal(lut.init, '2222');
  // a pin of the slice shows its net; Enlarge widens the panel
  await page.eval((v) => [...document.querySelectorAll(`${v} .fv-slice .fv-sp.on`)].find((t) => t.firstChild.textContent === 'F1').dispatchEvent(new MouseEvent('click')), V);
  await page.waitFor((v) => /^Net a_IBUF/.test(document.querySelector(`${v} .fv-info`).textContent), [V], { what: 'pin F1 -> net a_IBUF' });
  await page.click(`${V} .fv-enlarge`);
  assert.ok(await page.eval((v) => document.querySelector(`${v} .fv-side`).classList.contains('wide'), V));
  await page.click(`${V} .fv-enlarge`);
  // the other slices of the CLB: 4 buttons, the used ones enabled; u1/r is in SLICE_X0Y4
  const clb = await page.eval((v) => [...document.querySelectorAll(`${v} .fv-clb-s`)].map((b) => [b.textContent, b.disabled, b.classList.contains('cur')]), V);
  assert.deepEqual(clb, [['X0Y4', false, false], ['X0Y5', true, false], ['X1Y4', true, false], ['X1Y5', false, true]]);
  await page.click(`${V} .fv-clb-s`, { text: 'X0Y4' });
  await page.waitFor((v) => /SLICE_X0Y4/.test(document.querySelector(`${v} .fv-detail`).textContent), [V], { what: 'the other slice' });
  assert.match(await page.eval((v) => document.querySelector(`${v} .fv-cell[data-cell="G"] .fv-eq`).textContent, V), /^= \(q ⊕ GLOBAL_LOGIC1\)$/);
  await page.click(`${V} .fv-site[data-i="${q}"]`);
  await page.waitFor((v) => /SLICE_X1Y5/.test(document.querySelector(`${v} .fv-detail`).textContent), [V]);
  // its connections are drawn
  assert.ok(await page.eval((v) => document.querySelectorAll(`${v} .fv-conn line`).length, V) >= 3);
  // a net from the details: its loads and the tiles of its routing
  await page.click(`${V} .fv-detail a.fv-net`, { text: 'a_IBUF' });
  await page.waitFor((v) => document.querySelectorAll(`${v} .fv-picked line`).length === 2, [V], { what: 'net a_IBUF drawn' });
  assert.equal(await page.eval((v) => document.querySelectorAll(`${v} .fv-picked .fv-route`).length, V), 3);
  assert.match(await page.eval((v) => document.querySelector(`${v} .fv-info`).textContent, V), /^Net a_IBUF: 2 load\(s\), 3 routing switch\(es\) in 3 tile\(s\)$/);
  // the net is marked in the nets list, which is not rebuilt by a selection (the same row elements)
  const rows = await page.eval((v) => { window.__fvRows = [...document.querySelectorAll(`${v} .fv-netrow`)]; return window.__fvRows.filter((r) => r.classList.contains('sel')).map((r) => r.querySelector('a').textContent); }, V);
  assert.deepEqual(rows, ['a_IBUF']);
  await page.click(`${V} .fv-site[data-i="${q}"]`);
  await page.waitFor((v) => !document.querySelector(`${v} .fv-picked`), [V], { what: 'site selected again' });
  assert.deepEqual(await page.eval((v) => {
    const now = [...document.querySelectorAll(`${v} .fv-netrow`)];
    return { same: now.length === window.__fvRows.length && now.every((r, k) => r === window.__fvRows[k]), sel: now.filter((r) => r.classList.contains('sel')).length };
  }, V), { same: true, sel: 0 });
  // the clock network
  await page.click(`${V} .fv-bar .btn`, { text: 'Clock network' });
  await page.waitFor((v) => document.querySelectorAll(`${v} .fv-clock line`).length === 2, [V], { what: 'clock network' });
  assert.ok(await page.eval((v) => [...document.querySelectorAll(`${v} .fv-bar .btn`)].find((b) => b.textContent === 'Clock network').classList.contains('on'), V));
  // nets list: the clock first; search
  assert.equal(await page.eval((v) => document.querySelector(`${v} .fv-netrow a`).textContent, V), 'clk_BUFGP');
  await page.click(`${V} .fv-search`);
  await page.type('obuf');
  await page.waitFor((v) => [...document.querySelectorAll(`${v} .fv-netrow a`)].map((a) => a.textContent).join() === 'y_OBUF', [V], { what: 'search y_OBUF' });

  // hierarchy -> chip: u1 lights up its 2 sites; the top module shows everything again
  await page.treeRow('#hier', 'top', { exact: false });
  await page.waitFor((v) => !document.querySelector(`${v} .fv-svg`).classList.contains('fv-dim'), [V]);
  await page.treeRow('#hier', 'u1 - sub');
  await page.waitFor((v) => document.querySelectorAll(`${v} .fv-site.hl`).length === 2 && document.querySelector(`${v} .fv-svg`).classList.contains('fv-dim'), [V], { what: 'u1 highlighted' });
  assert.match(await page.eval((v) => document.querySelector(`${v} .fv-mod.sel .fv-mod-name`).textContent, V), /^u1 — sub$/);
  // chip -> hierarchy: the legend's top level selects the top module
  await page.click(`${V} .fv-mod`, { index: 1 });
  await page.waitFor((v) => document.querySelectorAll(`${v} .fv-site.hl`).length === 5, [V], { what: 'top-level sites highlighted' });
  await page.waitFor(() => document.querySelector('#hier .row.sel .lbl')?.textContent === 'top', [], { what: 'top selected in the hierarchy' });

  // zoom in / out / fit (the viewBox)
  const vbw = () => page.eval((v) => document.querySelector(`${v} .fv-svg`).viewBox.baseVal.width, V);
  await page.click(`${V} .fv-bar .btn`, { text: 'Fit' });   // (picking a net zoomed to it)
  const w0 = await vbw();
  await page.click(`${V} .fv-bar .btn`, { text: '+' });
  assert.ok(await vbw() < w0 * 0.8, 'zoomed in');
  await page.click(`${V} .fv-bar .btn`, { text: 'Fit' });
  assert.ok(Math.abs(await vbw() - w0) < 1, 'back to the whole chip');
  // an I/O pad
  await page.click(`${V} .fv-site[data-i="${await idxOf(page, 'y')}"]`);
  await page.waitFor((v) => /Package pin\s+P2/.test(document.querySelector(`${v} .fv-detail`).innerText), [V]);
  const io = await page.eval((v) => document.querySelector(`${v} .fv-detail`).innerText, V);
  assert.match(io, /Port\s+y/);
  assert.match(io, /Direction\s+output/);
  assert.match(io, /I\/O standard\s+LVCMOS33/);
  assert.match(io, /Drive\s+12 mA/);
});

uiTest('FPGA view: not placed and routed yet asks to run Implement Design (No: nothing opens); Portuguese', E, async (page) => {
  await makeProject(env, { name: 'NoRoute', files: { 'src/top.vhd': TOP, 'src/sub.vhd': SUB }, top: 'top' });
  await page.openProject('NoRoute');
  await page.menu('Tools', 'Implemented Design (FPGA View)');
  await page.waitDialog('View Implemented Design (FPGA)');
  assert.match(await page.eval(() => document.querySelector('.dlg-overlay .msg-text').textContent), /after Place & Route\. Run Implement Design/);
  await page.dialogButton('No');
  await page.waitNoDialog();
  assert.equal(await page.eval(() => !!window.SilinxApp.findDoc('fpgaview')), false);
  // the view in Portuguese: no untranslated text
  await routedProject('PtPj');
  await page.openProject('PtPj');
  await page.menu('Tools', 'Implemented Design (FPGA View)');
  await page.waitFor(() => window.Silinx.active?.id === 'fpgaview' && document.querySelector('.doc:not([hidden]) .fv-site'));
  await page.click(`${V} .fv-site[data-i="${await idxOf(page, 'u1/q')}"]`);
  await page.waitFor((v) => /SLICE_X1Y5/.test(document.querySelector(`${v} .fv-detail`).textContent), [V]);
  await page.eval(TEXTS);
  const en = await page.eval((v) => window.__uiTexts(document.querySelector(v)), V);
  await page.eval(() => window.SilinxApp.S && import('/js/i18n.js').then((m) => m.setLanguage('pt')));
  await page.waitFor(() => document.documentElement.lang === 'pt');
  const pt = await page.eval((v) => window.__uiTexts(document.querySelector(v)), V);
  assert.deepEqual(untranslated(en, pt, [/^@?(Fit|DCMs \/ PLLs|Flip-flops|IOBs)$/]), []);
  assert.match(await page.eval((v) => document.querySelector(`${v} .fv-detail`).innerText, V), /Tabelas de consulta \(LUTs\)[\s\S]*valor inicial 1/);
});
