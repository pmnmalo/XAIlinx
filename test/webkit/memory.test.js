// Memory in WebKit, Safari's engine (Playwright's WebKit build). Leaks are found by the Chrome memory
// tests (test/ui/memory.test.js), which force a garbage collection and count what each repetition
// leaves behind. WebKit offers neither, and its allocator does not give memory back to the system, so
// its resident memory cannot tell a leak from reused memory: here the heavy scenarios run many times
// and WebKit's processes must stay within a budget (a page that blows up to gigabytes fails). The
// memory after each round is printed. Needs `npx playwright install webkit` (skipped without it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSilinxServer, makeProject, ROOT } from '../ui/harness.js';

let webkit = null;
try { ({ webkit } = await import('playwright')); } catch { /* not installed */ }
const SKIP = !webkit ? 'playwright not installed (npm install)' : !fs.existsSync(webkit.executablePath()) ? 'WebKit not installed (npx playwright install webkit)' : false;

// all of Playwright's WebKit processes (browser, page, GPU, network); about 600 MB after every scenario
// here on macOS (2026-10)
const BUDGET_MB = 1200;

let tmp, server, browserServer, browser, env;
before(async () => {
  if (SKIP) return;
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'silinx-webkit-'));
  server = await startSilinxServer(tmp);
  env = { server };
  browserServer = await webkit.launchServer();
  browser = await webkit.connect(browserServer.wsEndpoint());
});
after(async () => {
  await browser?.close().catch(() => {});
  await browserServer?.close().catch(() => {});
  server?.stop();
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/**
 * Resident memory (MB) of the processes of Playwright's WebKit: the browser, its page (WebContent),
 * GPU and network processes. On macOS the page process is started by the system (not a child of the
 * browser), so they are found by their location: Playwright's WebKit folder (…/ms-playwright/webkit-N).
 */
function webkitMB() {
  const dir = webkit.executablePath().match(/^.*?[\\/]webkit-\d+/)[0];
  let kb = 0;
  const args = process.platform === 'darwin' ? ['-axo', 'rss=,command='] : ['-eo', 'rss=,args='];
  for (const line of execFileSync('ps', args, { encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].startsWith(dir)) kb += +m[1];
  }
  return Math.round(kb / 1024);
}

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(() => { window.SILINX_NO_UPDATE_CHECK = true; });
  await page.goto(server.url);
  await page.waitForFunction(() => window.SilinxApp && document.querySelector('#menubar .item'));
  return page;
}
async function openProject(page, name) {
  await page.evaluate(async (n) => { await window.SilinxApp.openProject(n); window.SilinxApp.showLeftPage('design'); }, name);
  await page.waitForFunction((n) => window.Silinx.project?.name === n && document.querySelector('#hier .row'), name);
}
const closeActive = (page) => page.evaluate(async () => { const A = window.SilinxApp; if (A.S.active) await A.closeDoc(A.S.active); });

/** `rounds` rounds of `action`; the memory after each must stay under BUDGET_MB. */
async function withinBudget(what, rounds, action) {
  const mb = [];
  for (let r = 0; r < rounds; r++) { await action(r); await new Promise((res) => setTimeout(res, 500)); mb.push(webkitMB()); }
  const msg = `${what}: WebKit memory after each round (MB): ${mb.join(', ')}`;
  console.log(`# ${msg}`);
  // a running WebKit with a page uses well over 50 MB: less means its processes were not found
  assert.ok(Math.min(...mb) >= 50, `${msg}: WebKit's processes not found (measure)`);
  assert.ok(Math.max(...mb) <= BUDGET_MB, `${msg}: over the ${BUDGET_MB} MB budget`);
  return mb;
}

// the routed design of the FPGA view: the XDL fixture, as ISE's 'fpgaview' step writes it
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
  const build = path.join(server.workspace, name, 'build');
  await fsp.mkdir(build, { recursive: true });
  await fsp.writeFile(path.join(build, 'top.ncd'), 'NCD');
  const old = new Date(Date.now() - 60000);
  await fsp.utimes(path.join(build, 'top.ncd'), old, old);
  for (const f of ['top.xdl', 'device.xdlrc']) await fsp.copyFile(path.join(ROOT, 'test', 'fixtures', 'fpga', f), path.join(build, f));
}
async function openFpga(page) {
  await page.evaluate(() => [...document.querySelectorAll('#procs .row')].find((e) => /View Implemented Design \(FPGA\)/.test(e.textContent)).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await page.waitForFunction(() => window.Silinx.active?.id === 'fpgaview' && document.querySelector('.doc:not([hidden]) .fv-site'));
}

test('WebKit memory: the FPGA view, opened and closed, and every site and net selected again and again, stays within the budget', { skip: SKIP, timeout: 300000 }, async () => {
  await routedProject('WkFpga');
  const page = await newPage();
  await openProject(page, 'WkFpga');
  await withinBudget('FPGA view open / close (10 per round)', 6, async () => {
    for (let i = 0; i < 10; i++) { await openFpga(page); await closeActive(page); }
  });
  await openFpga(page);
  await withinBudget('FPGA view: every site, every net and 10 zooms (20 per round)', 6, () => page.evaluate(async () => {
    const v = '.doc:not([hidden]) .fv', svg = document.querySelector(`${v} .fv-canvas svg`);
    for (let k = 0; k < 20; k++) {
      for (const t of svg.querySelectorAll('[data-i]')) {
        const r = t.getBoundingClientRect(), o = { clientX: r.left + 1, clientY: r.top + 1, bubbles: true, pointerId: 1 };
        t.dispatchEvent(new PointerEvent('pointerdown', o)); svg.dispatchEvent(new PointerEvent('pointerup', o));
      }
      for (const a of document.querySelectorAll(`${v} .fv-nets a.fv-net`)) a.click();
      const r = svg.getBoundingClientRect();
      for (let z = 0; z < 10; z++) svg.dispatchEvent(new WheelEvent('wheel', { deltaY: z < 5 ? -100 : 100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 10));
    }
  }));
  await page.close();
});

test('WebKit memory: editors opened and closed, and switching projects, stay within the budget', { skip: SKIP, timeout: 300000 }, async () => {
  await makeProject(env, { name: 'WkA', template: 'blinky' });
  await makeProject(env, { name: 'WkB', template: 'blinky' });
  const page = await newPage();
  await openProject(page, 'WkA');
  await withinBudget('HDL, Verilog and ASM editors open / close (5 each per round)', 6, async () => {
    for (let i = 0; i < 5; i++) for (const f of ['src/top.vhd', 'src/counter.v', 'src/speed_ctrl.asm.json']) {
      await page.evaluate((x) => window.SilinxApp.openFile(x), f);
      await page.waitForFunction((x) => window.Silinx.active?.path === x, f);
      await closeActive(page);
    }
  });
  await withinBudget('switching projects (10 per round)', 6, async () => {
    for (let i = 0; i < 10; i++) await openProject(page, i % 2 ? 'WkA' : 'WkB');
  });
  await page.close();
});
