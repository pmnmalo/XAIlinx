// UI: memory use. Each scenario repeats an action (open / close a view, select in it, run a
// simulation…) many times and measures, after a forced garbage collection, the JS heap, the DOM
// nodes (detached ones too) and the event listeners: what one repetition leaves behind must stay
// near zero (no leak), and the whole page must stay within a budget. A failure prints the numbers.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupUi, uiTest, makeProject, ROOT } from './harness.js';

let env;
before(async () => { env = await setupUi(); });
after(async () => { await env?.teardown?.(); });
const E = () => env;

// what one repetition may leave behind (allocator and cache noise stays well below these)
const PER_CYCLE = { heapKB: 40, nodes: 5, listeners: 2 };
// the whole page, after every scenario
const BUDGET = { heapMB: 60, nodes: 20000, listeners: 5000 };

/** JS heap (bytes), DOM nodes and event listeners after a full garbage collection. */
async function measure(page) {
  // let short one-off timers (debounces, delayed redraws) fire first: they hold their closures
  await new Promise((r) => setTimeout(r, 1500));
  await page.send('Performance.enable');
  for (let i = 0; i < 3; i++) await page.send('HeapProfiler.collectGarbage');
  const { metrics } = await page.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  // the console keeps its last 5000 lines (2 nodes each): those are not leaks, so they are not counted
  const consoleLines = await page.eval(() => document.getElementById('console-log').childElementCount);
  return { heap: m.JSHeapUsedSize, nodes: m.Nodes - 2 * consoleLines, listeners: m.JSEventListeners };
}

/**
 * Run `action` a few times (warm-up: lazy modules, language modes, caches fill up), then `n` more
 * times, and check what each of the n repetitions left behind against PER_CYCLE.
 */
async function noLeak(page, what, n, action, { warmUp = 3 } = {}) {
  for (let i = 0; i < warmUp; i++) await action(i);
  const a = await measure(page);
  for (let i = 0; i < n; i++) await action(warmUp + i);
  const b = await measure(page);
  const per = { heapKB: (b.heap - a.heap) / 1024 / n, nodes: (b.nodes - a.nodes) / n, listeners: (b.listeners - a.listeners) / n };
  const msg = `${what}: per repetition ${per.heapKB.toFixed(1)} KB heap, ${per.nodes.toFixed(1)} nodes, ${per.listeners.toFixed(1)} listeners `
    + `(${n} repetitions: heap ${(a.heap / 1e6).toFixed(1)} -> ${(b.heap / 1e6).toFixed(1)} MB, nodes ${a.nodes} -> ${b.nodes}, listeners ${a.listeners} -> ${b.listeners})`;
  assert.ok(per.heapKB <= PER_CYCLE.heapKB, msg);
  assert.ok(per.nodes <= PER_CYCLE.nodes, msg);
  assert.ok(per.listeners <= PER_CYCLE.listeners, msg);
  return b;
}

async function withinBudget(page) {
  const m = await measure(page);
  const msg = `page: heap ${(m.heap / 1e6).toFixed(1)} MB, ${m.nodes} nodes, ${m.listeners} listeners`;
  assert.ok(m.heap / 1e6 <= BUDGET.heapMB, msg);
  assert.ok(m.nodes <= BUDGET.nodes, msg);
  assert.ok(m.listeners <= BUDGET.listeners, msg);
}

const closeActive = (page) => page.eval(async () => { const A = window.SilinxApp; const d = A.S.active; if (d) await A.closeDoc(d); });
const waitActive = (page, id) => page.waitFor((x) => window.Silinx.active?.id === x && window.Silinx.active.view !== undefined, [id], { what: `${id} open` });

// a placed and routed design for the FPGA view (the XDL fixture, as the 'fpgaview' step of ISE writes it)
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
const openFpga = async (page) => {
  await page.menu('Tools', 'Implemented Design (FPGA View)');
  await page.waitFor(() => window.Silinx.active?.id === 'fpgaview' && document.querySelector('.doc:not([hidden]) .fv-site'), [], { what: 'FPGA view open' });
};

uiTest('memory: the FPGA view — opening and closing it, selecting sites and nets, zooming leave nothing behind', E, async (page) => {
  await routedProject('MemFpga');
  await page.openProject('MemFpga');
  await noLeak(page, 'FPGA view open / close', 15, async () => { await openFpga(page); await closeActive(page); });
  await openFpga(page);
  // a click on each used site, then on each net of the list, then zoom in and out
  const V = '.doc:not([hidden]) .fv';
  await noLeak(page, 'FPGA view: select every site and net', 10, async () => {
    await page.eval((v) => {
      const svg = document.querySelector(`${v} .fv-canvas svg`);
      for (const t of svg.querySelectorAll('[data-i]')) {
        const r = t.getBoundingClientRect(), o = { clientX: r.left + 1, clientY: r.top + 1, bubbles: true, pointerId: 1 };
        t.dispatchEvent(new PointerEvent('pointerdown', o)); svg.dispatchEvent(new PointerEvent('pointerup', o));
      }
      for (const a of document.querySelectorAll(`${v} .fv-nets a.fv-net`)) a.click();
      const r = svg.getBoundingClientRect();
      for (let k = 0; k < 10; k++) svg.dispatchEvent(new WheelEvent('wheel', { deltaY: k < 5 ? -100 : 100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    }, V);
  });
  // replaced by a new view (as after a new implementation run) while open
  await noLeak(page, 'FPGA view reopened while open', 10, () => openFpga(page));
  await closeActive(page);
  await withinBudget(page);
});

uiTest('memory: editors (HDL, ASM chart, Design Summary) opened and closed leave nothing behind', E, async (page) => {
  await makeProject(env, { name: 'MemEd', template: 'blinky' });
  await page.openProject('MemEd');
  for (const file of ['src/top.vhd', 'src/counter.v', 'src/speed_ctrl.asm.json']) {
    await noLeak(page, `open / close ${file}`, 10, async () => {
      await page.eval((f) => window.SilinxApp.openFile(f), file);
      await page.waitFor((f) => window.Silinx.active?.path === f, [file], { what: `${file} open` });
      await closeActive(page);
    }, { warmUp: 20 });   // the editor's code is compiled and optimised over its first ~20 openings
  }
  await noLeak(page, 'open / close Design Summary', 10, async () => {
    await page.eval(() => window.SilinxApp.openSummary());
    await page.waitFor(() => window.Silinx.active?.id === 'summary');
    await closeActive(page);
  });
  await withinBudget(page);
});

uiTest('memory: ISim and the board emulator, run and closed, leave nothing behind', E, async (page) => {
  await makeProject(env, { name: 'MemSim', template: 'blinky' });
  await page.openProject('MemSim');
  await page.click('input[name=view][value=sim]');
  await page.treeRow('#hier', 'tb_top');
  await noLeak(page, 'ISim: simulate (1 us) and close', 5, async () => {
    await page.treeRow('#procs', 'Simulate Behavioral Model', { dbl: true, exact: true });
    await waitActive(page, 'isim');
    await page.waitFor(() => /Sim Time: 1,000,000 ps/.test(document.querySelector('.isim-st-time')?.textContent || '') && !window.Silinx.active.view.state.running, [], { what: 'initial 1 us run', timeout: 20000 });
    await closeActive(page);
  });
  await page.click('input[name=view][value=impl]');
  await noLeak(page, 'board emulator: run and close', 5, async () => {
    await page.menu('Tools', 'Board Emulator');
    await page.waitFor(() => window.Silinx.active?.id === 'emulator' && window.Silinx.active.view?.outputs, [], { what: 'emulator running' });
    await page.waitFor(() => window.Silinx.active.view.sim.now > 0, [], { what: 'emulator time advancing' });
    await closeActive(page);
  });
  await withinBudget(page);
});

uiTest('memory: switching projects and a long console stay bounded', E, async (page) => {
  await makeProject(env, { name: 'MemA', template: 'blinky' });
  await makeProject(env, { name: 'MemB', template: 'blinky' });
  await noLeak(page, 'switch between two projects', 10, async (i) => { await page.openProject(i % 2 ? 'MemA' : 'MemB'); });
  // the console keeps its last 5000 lines
  await page.eval(() => { for (let i = 0; i < 20000; i++) window.SilinxApp.log(`line ${i}`); });
  assert.equal(await page.eval(() => document.getElementById('console-log').childElementCount), 5000);
  await withinBudget(page);
});
