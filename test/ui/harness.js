// Minimal browser test harness for the Silinx web UI — no npm dependencies for Chrome.
//
// Drives a locally installed Google Chrome / Chromium in headless mode over the Chrome DevTools
// Protocol (the global WebSocket of Node >= 22) — or, with SILINX_UI_BROWSER=firefox|webkit|chromium,
// Playwright's build of that browser (npx playwright install firefox webkit), with the same page
// API (tests that need raw CDP are skipped there: { skip: chromeOnly }) — and runs the Silinx
// server as a child process on a free port with a temporary workspace, configuration directory and
// HOME (never the user's own ~/Silinx-projects or ~/.silinx).
//
//   const env = await setupUi();            // in before(): server + browser (env.skip when none)
//   uiTest('name', env, async (page) => { … });
//
// Every test gets a page in its own browser context (separate localStorage, downloads directory);
// uncaught page exceptions and console.error() calls fail the test; a failing test leaves a
// screenshot in the temp directory (path printed).
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debug = (...a) => { if (process.env.SILINX_UI_DEBUG) console.error(`# [ui ${new Date().toISOString().slice(11, 23)}]`, ...a); };

// ------------------------------------------------------------------------------------- Chrome
export function findChrome() {
  const env = process.env.CHROME_PATH || process.env.CHROME_BIN;
  if (env && fs.existsSync(env)) return env;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    : process.platform === 'win32'
      ? [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`]
      : [];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  if (process.platform !== 'win32') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
      try { const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (p) return p; } catch { /* not found */ }
    }
  }
  return null;
}

/** Chrome DevTools Protocol connection (flat sessions). */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`), { cdp: msg.error }));
        else p.resolve(msg.result);
      } else for (const l of [...this.listeners]) l(msg);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`CDP connection closed (${p.method})`));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const p = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify(msg)); });
    // SILINX_UI_CDP_TIMEOUT=30000: a call Chrome does not answer fails (names the method) instead of hanging
    const ms = +process.env.SILINX_UI_CDP_TIMEOUT;
    if (!ms) return p;
    let to;
    return Promise.race([p, new Promise((_, reject) => { to = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} got no answer in ${ms} ms${method === 'Runtime.evaluate' ? `: ${String(params.expression).slice(0, 160)}` : ''}`)); }, ms); })]).finally(() => clearTimeout(to));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function launchChrome(exe, tmp, extraArgs = []) {
  // a slow machine (2-core CI runner, several suites at once) may need a second try
  try { return await launchChromeOnce(exe, tmp, 'chrome-profile', extraArgs); } catch (e) {
    debug(`Chrome launch failed, retrying: ${e.message.slice(0, 300)}`);
    return launchChromeOnce(exe, tmp, 'chrome-profile-2', extraArgs);
  }
}

async function launchChromeOnce(exe, tmp, profile, extraArgs) {
  const userDir = path.join(tmp, profile);
  await fsp.mkdir(userDir, { recursive: true });
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--metrics-recording-only',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--password-store=basic', '--use-mock-keychain',
    '--window-size=1400,900', '--allow-file-access-from-files',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...(process.env.SILINX_UI_CHROME_ARGS ? process.env.SILINX_UI_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),   // e.g. --disable-gpu
    ...extraArgs,
    'about:blank',
  ];
  // its own writable HOME / cache (fontconfig, crash reports): CI images may have none
  const home = path.join(tmp, `${profile}-home`);
  await fsp.mkdir(path.join(home, '.cache'), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: path.join(home, '.cache'), XDG_CONFIG_HOME: path.join(home, '.config') };
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const portFile = path.join(userDir, 'DevToolsActivePort');
  for (let i = 0; i < 1200; i++) {   // up to 60 s
    if (proc.exitCode != null) throw new Error(`Chrome exited (${proc.exitCode}): ${stderr}`);
    try {
      const [port, wsPath] = (await fsp.readFile(portFile, 'utf8')).split('\n');
      if (port && wsPath) return { proc, cdp: await CDP.connect(`ws://127.0.0.1:${port.trim()}${wsPath.trim()}`) };
    } catch { /* not written yet */ }
    await sleep(50);
  }
  proc.kill('SIGKILL');
  throw new Error(`Chrome did not start (no DevToolsActivePort): ${stderr}`);
}

// ------------------------------------------------------------------------------------- server
export async function startSilinxServer(tmp) {
  const env = {
    ...process.env,
    SILINX_WORKSPACE: path.join(tmp, 'workspace'),
    SILINX_CONFIG_DIR: path.join(tmp, 'config'),
    HOME: path.join(tmp, 'home'),
    USERPROFILE: path.join(tmp, 'home'),
  };
  for (const d of [env.SILINX_WORKSPACE, env.SILINX_CONFIG_DIR, env.HOME]) await fsp.mkdir(d, { recursive: true });
  const proc = spawn(process.execPath, [path.join(ROOT, 'test/ui/serve.js')], { env, stdio: ['pipe', 'pipe', 'pipe'], cwd: tmp });
  let out = '', err = '';
  proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  const port = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`Silinx server did not start: ${err}`)), 20000);
    proc.stdout.on('data', (d) => {
      out += d;
      const m = /SILINX_PORT (\d+)/.exec(out);
      if (m) { clearTimeout(to); resolve(+m[1]); }
    });
    proc.on('exit', (c) => { clearTimeout(to); reject(new Error(`Silinx server exited (${c}): ${err}`)); });
  });
  proc.removeAllListeners('exit');
  const url = `http://127.0.0.1:${port}`;
  return {
    proc, url, workspace: env.SILINX_WORKSPACE, configDir: env.SILINX_CONFIG_DIR,
    /** REST call to the server (JSON in / out; strings are sent as text/plain). */
    async api(method, p, body) {
      const init = { method, headers: {} };
      if (body !== undefined) {
        if (typeof body === 'string') { init.body = body; init.headers['content-type'] = 'text/plain'; }
        else if (body instanceof Uint8Array) { init.body = body; init.headers['content-type'] = 'application/zip'; }
        else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
      }
      const r = await fetch(url + p, init);
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('json') ? await r.json() : await r.text();
      if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(data)}`);
      return data;
    },
    stop() {
      try { proc.stdin.end(); } catch { /* ignore */ }
      proc.kill('SIGTERM');
      proc.stdout.destroy(); proc.stderr.destroy(); proc.unref();
    },
  };
}

// ------------------------------------------------------------------------------------- page
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 }, ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, F1: { code: 'F1', keyCode: 112 },
};

/** What every backend's page offers: the helpers built on eval / mouse / key. */
class PageBase {
  constructor(env, downloadDir) {
    Object.assign(this, { env, downloadDir });
    this.errors = [];             // uncaught exceptions + console.error
    this.console = [];
    this.allowErrors = [];        // regexps of expected errors
    this.dialogs = [];            // window.alert/confirm messages seen
    this.dialogAnswer = true;     // answer to window.confirm()
  }

  /** Evaluate `fn(...args)` in the page (fn may be async); the result is returned by value. */
  eval(fn, ...args) { return this.evalAs(null, fn, ...args); }
  /** Wait until `fn(...args)` returns a truthy value in the page; returns it. */
  async waitFor(fn, args = [], { timeout = 10000, interval = 50, what } = {}) {
    const t0 = Date.now();
    let last;
    for (;;) {
      try { last = await this.evalAs(true, fn, ...args); if (last) return last; } catch (e) { last = e.message; }
      if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${what || String(fn).slice(0, 200)}${typeof last === 'string' ? ` (last: ${last})` : ''}`);
      await sleep(interval);
    }
  }
  waitForSelector(sel, opts = {}) {
    return this.waitFor((s) => { const e = document.querySelector(s); return !!e && !!(e.offsetParent || e.getClientRects().length); }, [sel], { what: `selector ${sel}`, ...opts });
  }

  // ---- mouse / keyboard
  /** Centre of the first element matching `sel` (or `{x, y}` / a function returning a rect). */
  async point(target, { index = 0, text } = {}) {
    if (typeof target === 'object' && target && 'x' in target) return target;
    const r = await this.eval((sel, idx, txt) => {
      let els = [...document.querySelectorAll(sel)];
      if (txt != null) els = els.filter((e) => e.getClientRects().length && ((e.textContent || '').trim() === txt || (e.textContent || '').trim().startsWith(txt)));
      const e = els[idx];
      if (!e || !e.getClientRects().length) return null;
      e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const b = e.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, target, index, text ?? null);
    if (!r) throw new Error(`no visible element ${target}${text != null ? ` with text '${text}'` : ''}${index ? ` #${index}` : ''}`);
    return r;
  }
  async click(target, opts = {}) {
    debug(`click ${typeof target === 'string' ? target : JSON.stringify(target)}${opts.index ? ` #${opts.index}` : ''}${opts.text != null ? ` '${opts.text}'` : ''}`);
    const { x, y } = await this.point(target, opts);
    const button = opts.button || 'left';
    await this.mouse('mouseMoved', x, y);
    for (let i = 1; i <= (opts.count || 1); i++) {
      await this.mouse('mousePressed', x, y, { button, clickCount: i, modifiers: opts.modifiers || 0 });
      await this.mouse('mouseReleased', x, y, { button, clickCount: i, modifiers: opts.modifiers || 0 });
    }
    return { x, y };
  }
  dblclick(target, opts = {}) { return this.click(target, { ...opts, count: 2 }); }
  rightClick(target, opts = {}) { return this.click(target, { ...opts, button: 'right' }); }
  async drag(from, to, { steps = 8 } = {}) {
    const a = await this.point(from), b = await this.point(to);
    await this.mouse('mouseMoved', a.x, a.y);
    await this.mouse('mousePressed', a.x, a.y);
    for (let i = 1; i <= steps; i++) await this.mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, { buttons: 1, button: 'left' });
    await this.mouse('mouseReleased', b.x, b.y);
  }
  async hover(target) { const { x, y } = await this.point(target); await this.mouse('mouseMoved', x, y); }
  /** Set the value of an <input>/<select> and fire input + change. */
  async fill(sel, value, { index = 0 } = {}) {
    const ok = await this.eval((s, v, i) => {
      const e = document.querySelectorAll(s)[i];
      if (!e) return false;
      e.focus();
      if (e.type === 'checkbox') e.checked = !!v; else e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, sel, value, index);
    if (!ok) throw new Error(`fill: no element ${sel}`);
  }

  // ---- Silinx helpers
  /** Open a menu of the menu bar and return its item labels. */
  async openMenu(label) {
    debug(`menu ${label}`);
    await this.closeMenus();
    const items = await this.eval(() => [...document.querySelectorAll('#menubar .item')].map((e) => e.textContent.trim()));
    const idx = typeof label === 'number' ? label : items.indexOf(label);
    if (idx < 0) throw new Error(`no menu '${label}' (menus: ${items.join(', ')})`);
    const { x, y } = await this.point('#menubar .item', { index: idx });
    await this.mouse('mouseMoved', x, y);
    // (moving onto a menu title while another menu is open opens it already)
    if (!await this.eval((i) => document.querySelectorAll('#menubar .item')[i].classList.contains('open'), idx)) {
      await this.mouse('mousePressed', x, y);
      await this.mouse('mouseReleased', x, y);
    }
    // this menu's popup: its title is the open one and only one top-level popup is left (a popup of
    // the menu open before can still be there for a moment, and would be read instead: a CI-only race)
    await this.waitFor((i) => document.querySelectorAll('#menubar .item')[i].classList.contains('open')
      && document.querySelectorAll('body > .menu-popup:not(.sub)').length === 1, [idx], { what: `menu '${label}' open` });
    return this.eval(() => [...document.querySelectorAll('body > .menu-popup > .mi')].map((r) => ({ label: r.querySelector('.lbl').textContent, disabled: r.classList.contains('disabled'), submenu: r.querySelector('.sc').textContent === '▸' })));
  }
  /** Close the open menus the way the app does (a mouse press outside them). */
  async closeMenus() {
    await this.eval(() => { if (document.querySelector('.menu-popup')) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  }
  /** File ▸ Open Project… style: open the menu and click the item. */
  async menu(menuLabel, itemLabel) {
    const items = await this.openMenu(menuLabel);
    const idx = items.findIndex((i) => i.label === itemLabel);
    if (idx < 0) throw new Error(`no item '${itemLabel}' in menu '${menuLabel}' (${items.map((i) => i.label).join(' | ')})`);
    if (items[idx].disabled) throw new Error(`menu item '${menuLabel} ▸ ${itemLabel}' is disabled`);
    await this.click('body > .menu-popup > .mi', { index: idx });
  }
  /** Click a button of the topmost dialog by its label. */
  async dialogButton(label) {
    debug(`dialog button ${label}`);
    await this.waitFor((l) => { const d = [...document.querySelectorAll('.dlg-overlay')].pop(); return d && [...d.querySelectorAll('.dlg-buttons .btn')].some((b) => b.textContent.trim() === l && !b.disabled); }, [label], { what: `dialog button '${label}'` });
    const idx = await this.eval((l) => {
      const all = [...document.querySelectorAll('.dlg-overlay .dlg-buttons .btn')];
      const d = [...document.querySelectorAll('.dlg-overlay')].pop();
      return all.indexOf([...d.querySelectorAll('.dlg-buttons .btn')].find((b) => b.textContent.trim() === l));
    }, label);
    await this.click('.dlg-overlay .dlg-buttons .btn', { index: idx });
  }
  dialogCount() { return this.eval(() => document.querySelectorAll('.dlg-overlay').length); }
  topDialogTitle() { return this.eval(() => [...document.querySelectorAll('.dlg-overlay')].pop()?.querySelector('.dlg-title span')?.textContent ?? null); }
  async waitDialog(title, opts) {
    return this.waitFor((t) => { const d = [...document.querySelectorAll('.dlg-overlay')].pop(); const s = d?.querySelector('.dlg-title span')?.textContent; return s && (t == null || s === t || s.startsWith(t)) ? s : null; }, [title ?? null], { what: `dialog '${title}'`, ...opts });
  }
  async waitNoDialog(opts) { return this.waitFor(() => !document.querySelector('.dlg-overlay'), [], { what: 'all dialogs closed', ...opts }); }
  /** Lines of the Console panel. */
  consoleText() { return this.eval(() => document.getElementById('console-log').innerText); }
  async waitConsole(re, opts) {
    const src = re.source, flags = re.flags;
    return this.waitFor((s, f) => new RegExp(s, f).test(document.getElementById('console-log').innerText), [src, flags], { what: `console ${re}`, ...opts });
  }
  /** Open a project through the app (fast path for tests that are not about opening projects). */
  async openProject(name) {
    await this.eval(async (n) => { await window.SilinxApp.openProject(n); window.SilinxApp.showLeftPage('design'); }, name);
    await this.waitFor((n) => window.Silinx.project?.name === n && document.querySelector('#hier .row'), [name], { what: `project ${name} open` });
  }
  /** Click a row of the Design hierarchy / processes by its label. */
  async treeRow(container, label, { dbl = false, exact = false, right = false } = {}) {
    const idx = await this.waitFor((c, l, ex) => {
      const rows = [...document.querySelectorAll(`${c} .row`)].filter((r) => r.getClientRects().length);
      const i = rows.findIndex((r) => { const t = r.querySelector('.lbl')?.textContent?.trim() || ''; return ex ? t === l : t === l || t.startsWith(l); });
      return i >= 0 ? i + 1 : 0;
    }, [container, label, exact], { what: `tree row '${label}' in ${container}` });
    const sel = `${container} .row`;
    // index among visible rows
    const absolute = await this.eval((s, k) => { const all = [...document.querySelectorAll(s)]; const vis = all.filter((r) => r.getClientRects().length); return all.indexOf(vis[k - 1]); }, sel, idx);
    if (dbl) return this.dblclick(sel, { index: absolute });
    if (right) return this.rightClick(sel, { index: absolute });
    return this.click(sel, { index: absolute });
  }
}

/** A page of Chrome, driven over the Chrome DevTools Protocol (the default backend). */
export class Page extends PageBase {
  constructor(env, sessionId, targetId, contextId, downloadDir) {
    super(env, downloadDir);
    Object.assign(this, { cdp: env.cdp, sessionId, targetId, contextId });
    this.off = this.cdp.on((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(`uncaught: ${d.exception?.description || d.text}${d.url ? ` (${d.url}:${d.lineNumber})` : ''}`);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' ');
        this.console.push({ type: msg.params.type, text });
        if (msg.params.type === 'error' || msg.params.type === 'assert') this.errors.push(`console.error: ${text}`);
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(msg.params.message);
        this.cdp.send('Page.handleJavaScriptDialog', { accept: !!this.dialogAnswer }, this.sessionId).catch(() => {});
      }
    });
  }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }
  /** Like eval; a result that cannot be serialized (DOM node, editor…) comes back as `fallback`. */
  async evalAs(fallback, fn, ...args) {
    const expression = typeof fn === 'function'
      ? `(async () => { const r = await (${fn})(...${JSON.stringify(args)}); try { return r === undefined ? undefined : JSON.parse(JSON.stringify(r)); } catch { return ${JSON.stringify(fallback)}; } })()`
      : fn;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  /** Reload the page and wait for the new one to load and the app to start (not the old page). */
  async reload() {
    const loaded = this.waitEvent('Page.loadEventFired', 30000);
    await this.send('Page.reload', {});
    await loaded;
    await this.waitFor(() => window.SilinxApp && document.querySelector('#menubar .item'), [], { what: 'app boot after reload' });
  }
  async goto(url) {
    const loaded = this.waitEvent('Page.loadEventFired', 30000);
    await this.send('Page.navigate', { url });
    await loaded;
  }
  waitEvent(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)); }, timeout);
      const off = this.cdp.on((msg) => { if (msg.sessionId === this.sessionId && msg.method === method) { clearTimeout(to); off(); resolve(msg.params); } });
    });
  }
  async mouse(type, x, y, { button = 'left', clickCount = 1, modifiers = 0, buttons } = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && buttons === undefined ? 'none' : button, buttons: buttons ?? (type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0), clickCount, modifiers });
  }
  async key(key, { modifiers = 0 } = {}) {
    const k = KEYS[key] || { code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && !modifiers ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async type(text) { await this.send('Input.insertText', { text }); }
  /** Give an <input type=file> local files (CDP DOM.setFileInputFiles). */
  async setFiles(sel, files, { index = 0 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression: `document.querySelectorAll(${JSON.stringify(sel)})[${index}]` });
    if (!r.result.objectId) throw new Error(`setFiles: no element ${sel}`);
    await this.send('DOM.setFileInputFiles', { files, objectId: r.result.objectId });
    await this.eval((s, i) => { document.querySelectorAll(s)[i].dispatchEvent(new Event('change', { bubbles: true })); }, sel, index);
  }
  /**
   * Record in `list` the requests of the page and of its workers to other hosts than this computer
   * ("GET https://…"), from the Network events of the page and of every worker it starts.
   */
  async recordExternal(list) {
    const sessions = new Set([this.sessionId]);
    const local = (h) => /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(h);
    const off = this.cdp.on((msg) => {
      if (!sessions.has(msg.sessionId)) return;
      if (msg.method === 'Network.requestWillBeSent') {
        const { url, method } = msg.params.request;
        try { if (/^(https?|wss?):/.test(url) && !local(new URL(url).hostname)) list.push(`${method} ${url}`); } catch { /* not a URL */ }
      } else if (msg.method === 'Target.attachedToTarget') {
        // a worker, paused until its requests are seen too
        const s = msg.params.sessionId;
        sessions.add(s);
        this.cdp.send('Network.enable', {}, s).catch(() => {})
          .then(() => this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s).catch(() => {}))
          .then(() => this.cdp.send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {}));
      }
    });
    const prevOff = this.off;
    this.off = () => { off(); prevOff(); };
    await this.send('Network.enable');
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    await fsp.writeFile(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async close() {
    const t0 = Date.now();
    this.off();
    try { await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }); } catch { /* already gone */ }
    debug(`page closed in ${Date.now() - t0} ms`);
  }
}

const MODIFIER_KEYS = [[1, 'Alt'], [2, 'Control'], [4, 'Meta'], [8, 'Shift']];   // CDP modifier bits
/**
 * A page of Firefox, WebKit or Chromium, driven by Playwright (SILINX_UI_BROWSER=firefox|webkit|
 * chromium). The same API as Page: mouse / key take the CDP event names and modifier bits; send()
 * knows the few CDP methods the tests use that have an equivalent.
 */
export class PwPage extends PageBase {
  constructor(env, context, page, downloadDir) {
    super(env, downloadDir);
    Object.assign(this, { context, page, held: [] });
    page.on('pageerror', (e) => this.errors.push(`uncaught: ${e.name}: ${e.message}`));
    page.on('console', (m) => {
      const text = m.text();
      // WebKit and Firefox log failed requests (e.g. a 404 the app expects) as console errors;
      // Chrome's console API events (the CDP backend) do not have them: not page errors here either
      if (/^Failed to load resource\b/.test(text)) { this.console.push({ type: 'network', text: `${text} ${m.location()?.url || ''}` }); return; }
      this.console.push({ type: m.type(), text });
      if (m.type() === 'error' || m.type() === 'assert') this.errors.push(`console.error: ${text}`);
    });
    page.on('dialog', (d) => { this.dialogs.push(d.message()); (this.dialogAnswer ? d.accept() : d.dismiss()).catch(() => {}); });
    // into the download directory, under the name the page gave (complete files only)
    page.on('download', async (d) => {
      const f = path.join(downloadDir, d.suggestedFilename());
      try { await d.saveAs(`${f}.part`); await fsp.rename(`${f}.part`, f); } catch (e) { debug(`download failed: ${e.message}`); }
    });
  }
  async send(method, params = {}) {
    if (method === 'Emulation.setEmulatedMedia') {
      const scheme = params.features?.find((f) => f.name === 'prefers-color-scheme')?.value;
      return this.page.emulateMedia({ colorScheme: scheme || null });
    }
    throw new Error(`${method}: the Chrome DevTools Protocol is not available in ${BROWSER} (mark the test chromeOnly)`);
  }
  async evalAs(fallback, fn, ...args) {
    const expression = typeof fn === 'function'
      ? `(async () => { const r = await (${fn})(...${JSON.stringify(args)}); try { return r === undefined ? undefined : JSON.parse(JSON.stringify(r)); } catch { return ${JSON.stringify(fallback)}; } })()`
      : fn;
    try { return await this.page.evaluate(expression); } catch (e) { throw new Error(`page eval failed: ${e.message.replace(/^page\.evaluate: /, '')}`); }
  }
  async reload() {
    await this.page.reload({ timeout: 30000 });
    await this.waitFor(() => window.SilinxApp && document.querySelector('#menubar .item'), [], { what: 'app boot after reload' });
  }
  async goto(url) { await this.page.goto(url, { timeout: 30000 }); }
  async mouse(type, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    const m = this.page.mouse;
    if (type === 'mouseMoved') return m.move(x, y);
    if (type === 'mousePressed') {
      for (const [bit, k] of MODIFIER_KEYS) if (modifiers & bit) { await this.page.keyboard.down(k); this.held.push(k); }
      await m.move(x, y);
      return m.down({ button, clickCount });
    }
    await m.move(x, y);
    await m.up({ button, clickCount });
    while (this.held.length) await this.page.keyboard.up(this.held.pop());
  }
  async key(key, { modifiers = 0 } = {}) {
    await this.page.keyboard.press([...MODIFIER_KEYS.filter(([bit]) => modifiers & bit).map(([, k]) => k), key].join('+'));
  }
  async type(text) { await this.page.keyboard.insertText(text); }
  /** Give an <input type=file> local files (Playwright fires input + change). */
  async setFiles(sel, files, { index = 0 } = {}) { await this.page.locator(sel).nth(index).setInputFiles(files); }
  async screenshot(file) { await this.page.screenshot({ path: file }); return file; }
  async close() { await this.context.close().catch(() => {}); }
}

// ------------------------------------------------------------------------------------- offline
/**
 * An HTTP proxy that the browser sends all its traffic to: requests to this computer (the Silinx
 * server) go through, every other one is refused and recorded in `requests` (method + URL or
 * host:port). Tells that the app works without the Internet and asks nothing of other hosts.
 */
export async function startRecordingProxy() {
  const requests = [];
  const local = (host) => /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i.test(host);
  // the browser may reset any connection (Chrome on macOS does, to the hosts it is refused): a socket
  // error is never left unhandled (it would end the test process: ECONNRESET as an uncaught exception)
  const srv = http.createServer((req, res) => {
    req.on('error', () => {}); res.on('error', () => {});
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (!local(u.hostname)) { requests.push(`${req.method} ${req.url}`); res.writeHead(502, { 'content-type': 'text/plain' }).end('offline (test proxy)'); return; }
    const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { r.on('error', () => res.destroy()); res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { try { res.writeHead(502).end(); } catch { /* sent */ } });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });   // the browser went away
    req.pipe(up);
  });
  srv.on('connect', (req, sock, head) => {
    sock.on('error', () => {});
    const [host, port] = req.url.replace(/^\[|\](?=:)/g, '').split(/:(?=\d+$)/);
    if (!local(host)) { requests.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const up = net.connect(+port, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
    sock.on('close', () => up.destroy());
  });
  srv.on('clientError', (e, sock) => sock.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, requests, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}

// ------------------------------------------------------------------------------------- setup
/** The browser of the UI tests: chrome (default, CDP), or firefox / webkit / chromium (Playwright). */
export const BROWSER = (process.env.SILINX_UI_BROWSER || 'chrome').toLowerCase();
/** `skip` reason for a test that needs the Chrome DevTools Protocol (undefined in Chrome). */
export const chromeOnly = BROWSER === 'chrome' ? undefined : `needs the Chrome DevTools Protocol (not in ${BROWSER})`;

// the scripts every page starts with
function initScripts({ updateCheck }) {
  return [
    // no update check against GitHub at start-up (a test can turn it on again with its own fetch stub)
    ...(updateCheck ? [] : ['window.SILINX_NO_UPDATE_CHECK = true;']),
    // SILINX_UI_INTERFACE=classic: run the tests in the Xilinx ISE interface (the default is the modern one)
    ...(process.env.SILINX_UI_INTERFACE ? [`try { if (!localStorage.getItem('silinx.ui')) localStorage.setItem('silinx.ui', ${JSON.stringify(process.env.SILINX_UI_INTERFACE)}); } catch (e) {}`] : []),
  ];
}

/**
 * Start the server and the browser (Chrome unless SILINX_UI_BROWSER says otherwise). Returns
 * { skip } (a reason string) when the browser is not installed.
 * `server: false` for tests that do not need the Silinx server (standalone edition, or one started
 * by the test). `offline: true`: the browser's requests to other hosts are refused and recorded in
 * env.external (see startRecordingProxy). env.newPage(url, { updateCheck }) opens a page (the
 * update check against GitHub only with updateCheck: true).
 */
export async function setupUi({ server = true, offline = false } = {}) {
  if (BROWSER !== 'chrome') return setupPlaywright({ server, offline });
  const chrome = findChrome();
  if (!chrome) return { skip: 'Google Chrome / Chromium not found (set CHROME_PATH): UI tests skipped' };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'silinx-ui-'));
  const env = { tmp, chrome, browser: BROWSER, shotDir: path.join(tmp, 'screenshots') };
  await fsp.mkdir(env.shotDir, { recursive: true });
  if (server) env.server = await startSilinxServer(tmp);
  // Chrome does not send the requests to this computer through a proxy (its implicit bypass rule)
  const proxy = offline ? await startRecordingProxy() : null;
  // (the proxy also sees Chrome's own requests to Google: the pages' requests are recorded by CDP)
  env.external = proxy ? [] : undefined;
  const { proc, cdp } = await launchChrome(chrome, tmp, proxy ? [`--proxy-server=${proxy.url}`] : []);
  env.chromeProc = proc;
  env.cdp = cdp;
  env.pageSeq = 0;
  env.newPage = async (url = env.server?.url, { updateCheck = false } = {}) => {
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const downloadDir = path.join(tmp, `downloads-${++env.pageSeq}`);
    await fsp.mkdir(downloadDir, { recursive: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, browserContextId, eventsEnabled: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(env, sessionId, targetId, browserContextId, downloadDir);
    if (proxy) await page.recordExternal(env.external);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    for (const source of initScripts({ updateCheck })) await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
    await page.send('DOM.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    // SILINX_UI_THROTTLE=6: a slow CPU (e.g. to reproduce CI-only timing problems)
    if (process.env.SILINX_UI_THROTTLE) await page.send('Emulation.setCPUThrottlingRate', { rate: +process.env.SILINX_UI_THROTTLE }).catch(() => {});
    if (url) await page.goto(url);
    return page;
  };
  env.teardown = async () => {
    debug('teardown');
    try { await cdp.send('Browser.close'); } catch { /* ignore */ }
    cdp.close();
    await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
    if (proc.exitCode == null) proc.kill('SIGKILL');
    // Chrome's helper processes may keep the stderr pipe open for a while: do not wait for them
    proc.stderr?.destroy();
    proc.unref();
    env.server?.stop();
    proxy?.close();
    if (!env.keep) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    debug('teardown done');
  };
  return env;
}

async function setupPlaywright({ server, offline }) {
  let pw;
  try { pw = await import('playwright'); } catch { return { skip: 'playwright not installed (npm install): UI tests skipped' }; }
  const type = { firefox: pw.firefox, webkit: pw.webkit, chromium: pw.chromium }[BROWSER];
  if (!type) throw new Error(`SILINX_UI_BROWSER=${BROWSER}: use chrome, chromium, firefox or webkit`);
  // chromium: Playwright's build, else the installed Chrome
  const executablePath = !fs.existsSync(type.executablePath()) && BROWSER === 'chromium' ? findChrome() : undefined;
  if (!executablePath && !fs.existsSync(type.executablePath())) return { skip: `Playwright's ${BROWSER} not installed (npx playwright install ${BROWSER}): UI tests skipped` };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `silinx-ui-${BROWSER}-`));
  const env = { tmp, browser: BROWSER, shotDir: path.join(tmp, 'screenshots') };
  await fsp.mkdir(env.shotDir, { recursive: true });
  if (server) env.server = await startSilinxServer(tmp);
  const proxy = offline ? await startRecordingProxy() : null;
  env.external = proxy?.requests;
  const browser = await type.launch({ executablePath, ...(proxy ? { proxy: { server: proxy.url } } : {}) });
  env.pw = browser;
  env.pageSeq = 0;
  env.newPage = async (url = env.server?.url, { updateCheck = false } = {}) => {
    const downloadDir = path.join(tmp, `downloads-${++env.pageSeq}`);
    await fsp.mkdir(downloadDir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    for (const content of initScripts({ updateCheck })) await context.addInitScript({ content });
    const page = new PwPage(env, context, await context.newPage(), downloadDir);
    if (url) await page.goto(url);
    return page;
  };
  env.teardown = async () => {
    await browser.close().catch(() => {});
    env.server?.stop();
    proxy?.close();
    if (!env.keep) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  };
  return env;
}


/**
 * A UI test: a fresh page (own browser context) loaded with the app. Uncaught page errors and
 * console.error() fail the test (page.allowErrors: regexps of expected ones); on failure a
 * screenshot is written and its path printed.
 */
// skip: a reason to skip the test (e.g. it needs the default interface)
export function uiTest(name, envRef, fn, { timeout = 90000, url, skip } = {}) {
  test(name, { timeout }, async (t) => {
    const env = typeof envRef === 'function' ? envRef() : envRef;
    if (env.skip || skip) { t.skip(env.skip || skip); return; }
    const page = await env.newPage(url ? url(env) : undefined);
    try {
      if (!url) await page.waitFor(() => window.SilinxApp && document.querySelector('#menubar .item'), [], { what: 'app boot' });
      await fn(page, env, t);
      const errs = page.errors.filter((e) => !page.allowErrors.some((re) => re.test(e)));
      if (errs.length) throw new Error(`page errors:\n  ${errs.join('\n  ')}`);
    } catch (e) {
      try {
        const file = path.join(env.shotDir, `${name.replace(/[^\w.-]+/g, '_').slice(0, 80)}.png`);
        await page.screenshot(file);
        env.keep = true;
        console.error(`# screenshot of the failed test '${name}': ${file}`);
      } catch { /* page gone */ }
      if (page.errors.length) console.error(`# page errors: ${page.errors.join(' | ')}`);
      throw e;
    } finally {
      await page.close();
    }
  });
}

export const tick = sleep;

/** Wait for a file downloaded by the page (its browser context's download directory). */
export async function waitDownload(page, name, timeout = 15000) {
  const f = path.join(page.downloadDir, name);
  const t0 = Date.now();
  for (;;) {
    try {
      const files = await fsp.readdir(page.downloadDir);
      if (files.includes(name) && !files.some((x) => x.endsWith('.crdownload'))) {
        const size = (await fsp.stat(f)).size;
        await sleep(100);
        if (size > 0 && (await fsp.stat(f)).size === size) return f;
      }
    } catch { /* not yet */ }
    if (Date.now() - t0 > timeout) throw new Error(`download ${name} not found in ${page.downloadDir}`);
    await sleep(100);
  }
}

/** Read a project file from the temp workspace on disk. */
export function readWs(env, project, rel) { return fsp.readFile(path.join(env.server.workspace, project, rel), 'utf8'); }
export async function writeWs(env, project, rel, text) {
  const f = path.join(env.server.workspace, project, rel);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, text);
}

/** Create a project on the server with the given files (REST), ready to open. */
export async function makeProject(env, { name, template = 'empty', board, device, files = {}, top, simTop, constraints, roles = {} }) {
  const api = env.server.api;
  await api('POST', '/api/projects', { name, template, ...(board !== undefined ? { board } : {}), ...(device ? { device } : {}) });
  for (const [p, text] of Object.entries(files)) await api('PUT', `/api/projects/${encodeURIComponent(name)}/file?path=${encodeURIComponent(p)}`, text);
  const pj = await api('GET', `/api/projects/${encodeURIComponent(name)}`);
  delete pj.fileTree;
  if (top !== undefined) pj.top = top;
  if (simTop !== undefined) pj.simTop = simTop;
  if (constraints !== undefined) pj.constraints = constraints;
  for (const f of pj.files) if (roles[f.path]) f.role = roles[f.path];
  if (board && !device) {
    const db = await api('GET', '/api/devices');
    const b = db.boards.find((x) => x.id === board);
    if (b) pj.device = { ...b.device };
  }
  return api('PUT', `/api/projects/${encodeURIComponent(name)}`, pj);
}
