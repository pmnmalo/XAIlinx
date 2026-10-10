// Minimal browser test harness for the Silinx web UI — no npm dependencies.
//
// Drives a locally installed Google Chrome / Chromium in headless mode over the Chrome DevTools
// Protocol (the global WebSocket of Node >= 22), and runs the Silinx server as a child process on
// a free port with a temporary workspace, configuration directory and HOME (never the user's own
// ~/Silinx-projects or ~/.silinx).
//
//   const env = await setupUi();            // in before(): server + Chrome (env.skip when no Chrome)
//   uiTest('name', env, async (page) => { … });
//
// Every test gets a page in its own browser context (separate localStorage, downloads directory);
// uncaught page exceptions and console.error() calls fail the test; a failing test leaves a
// screenshot in the temp directory (path printed).
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify(msg)); });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function launchChrome(exe, tmp) {
  // a slow machine (2-core CI runner, several suites at once) may need a second try
  try { return await launchChromeOnce(exe, tmp, 'chrome-profile'); } catch (e) {
    debug(`Chrome launch failed, retrying: ${e.message.slice(0, 300)}`);
    return launchChromeOnce(exe, tmp, 'chrome-profile-2');
  }
}

async function launchChromeOnce(exe, tmp, profile) {
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

export class Page {
  constructor(env, sessionId, targetId, contextId, downloadDir) {
    Object.assign(this, { env, cdp: env.cdp, sessionId, targetId, contextId, downloadDir });
    this.errors = [];             // uncaught exceptions + console.error
    this.console = [];
    this.allowErrors = [];        // regexps of expected errors
    this.dialogs = [];            // window.alert/confirm messages seen
    this.dialogAnswer = true;     // answer to window.confirm()
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

  /** Evaluate `fn(...args)` in the page (fn may be async); the result is returned by value. */
  eval(fn, ...args) { return this.evalAs(null, fn, ...args); }
  /** Like eval; a result that cannot be serialized (DOM node, editor…) comes back as `fallback`. */
  async evalAs(fallback, fn, ...args) {
    const expression = typeof fn === 'function'
      ? `(async () => { const r = await (${fn})(...${JSON.stringify(args)}); try { return r === undefined ? undefined : JSON.parse(JSON.stringify(r)); } catch { return ${JSON.stringify(fallback)}; } })()`
      : fn;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
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
  async mouse(type, x, y, { button = 'left', clickCount = 1, modifiers = 0, buttons } = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && buttons === undefined ? 'none' : button, buttons: buttons ?? (type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0), clickCount, modifiers });
  }
  async click(target, opts = {}) {
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
  async key(key, { modifiers = 0 } = {}) {
    const k = KEYS[key] || { code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: k.text && !modifiers ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && !modifiers ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
  async type(text) { await this.send('Input.insertText', { text }); }
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
  /** Give an <input type=file> local files (CDP DOM.setFileInputFiles). */
  async setFiles(sel, files, { index = 0 } = {}) {
    const r = await this.send('Runtime.evaluate', { expression: `document.querySelectorAll(${JSON.stringify(sel)})[${index}]` });
    if (!r.result.objectId) throw new Error(`setFiles: no element ${sel}`);
    await this.send('DOM.setFileInputFiles', { files, objectId: r.result.objectId });
    await this.eval((s, i) => { document.querySelectorAll(s)[i].dispatchEvent(new Event('change', { bubbles: true })); }, sel, index);
  }

  // ---- Silinx helpers
  /** Open a menu of the menu bar and return its item labels. */
  async openMenu(label) {
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

// ------------------------------------------------------------------------------------- setup
/**
 * Start the server and Chrome. Returns { skip } (a reason string) when Chrome is not installed.
 * `server: false` for tests that do not need the Silinx server (standalone edition).
 */
export async function setupUi({ server = true } = {}) {
  const chrome = findChrome();
  if (!chrome) return { skip: 'Google Chrome / Chromium not found (set CHROME_PATH): UI tests skipped' };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'silinx-ui-'));
  const env = { tmp, chrome, shotDir: path.join(tmp, 'screenshots') };
  await fsp.mkdir(env.shotDir, { recursive: true });
  if (server) env.server = await startSilinxServer(tmp);
  const { proc, cdp } = await launchChrome(chrome, tmp);
  env.chromeProc = proc;
  env.cdp = cdp;
  env.pageSeq = 0;
  env.newPage = async (url = env.server?.url) => {
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const downloadDir = path.join(tmp, `downloads-${++env.pageSeq}`);
    await fsp.mkdir(downloadDir, { recursive: true });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, browserContextId, eventsEnabled: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(env, sessionId, targetId, browserContextId, downloadDir);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    // no update check against GitHub at start-up (a test can turn it on again with its own fetch stub)
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.SILINX_NO_UPDATE_CHECK = true;' });
    // SILINX_UI_INTERFACE=classic: run the tests in the Xilinx ISE interface (the default is the modern one)
    if (process.env.SILINX_UI_INTERFACE) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { if (!localStorage.getItem('silinx.ui')) localStorage.setItem('silinx.ui', ${JSON.stringify(process.env.SILINX_UI_INTERFACE)}); } catch (e) {}` });
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
    if (!env.keep) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    debug('teardown done');
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
