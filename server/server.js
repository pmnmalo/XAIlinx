// Silinx HTTP server: static web UI, shared core modules and the REST API.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from './projects.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).then(
  out => { if (out !== undefined && !res.headersSent) res.json(out); },
  err => res.status(err.status || 500).json({ error: err.message }),
);

export async function createApp({ host = '127.0.0.1' } = {}) {
  const app = express();
  // The API changes files and runs the ISE flow: only the Silinx page itself may call it.
  // A request from another web origin (a malicious page in the same browser) is refused, and when
  // bound to localhost the Host header must be local too (DNS rebinding).
  const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  app.use('/api', (req, res, next) => {
    const hostName = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!['0.0.0.0', '::'].includes(host) && hostName && !LOCAL.has(hostName) && hostName !== String(host).toLowerCase()) return res.status(403).json({ error: 'forbidden host' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let oh = '';
      try { oh = new URL(req.headers.origin).host.toLowerCase(); } catch { /* invalid origin */ }
      if (oh !== String(req.headers.host || '').toLowerCase()) return res.status(403).json({ error: 'cross-origin request refused' });
    }
    next();
  });
  app.use(express.json({ limit: '20mb' }));
  app.use(express.text({ type: 'text/*', limit: '20mb' }));

  app.use('/', express.static(path.join(ROOT, 'web')));
  app.use('/core', express.static(path.join(ROOT, 'core')));
  app.use('/vendor/elk', express.static(path.join(ROOT, 'node_modules/elkjs/lib')));
  app.use('/vendor/codemirror', express.static(path.join(ROOT, 'node_modules/codemirror')));
  // Yosys compiled to WebAssembly (YoWASP): the open synthesis runs in the browser (web/js/yosys-worker.js)
  app.use('/vendor/yowasp-yosys', express.static(path.join(ROOT, 'node_modules/@yowasp/yosys')));

  const api = express.Router();
  api.get('/projects', wrap(() => P.listProjects()));
  api.post('/projects', wrap(req => P.createProject(req.body || {})));
  api.get('/projects/:p', wrap(async req => ({ ...await P.readProject(req.params.p), fileTree: await P.fileTree(req.params.p) })));
  api.put('/projects/:p', wrap(req => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw Object.assign(new Error('expected a JSON project object'), { status: 400 });
    return P.writeProject(req.params.p, req.body);
  }));
  api.delete('/projects/:p', wrap(async req => { await P.deleteProject(req.params.p); return { ok: true }; }));
  api.get('/projects/:p/file', wrap(async (req, res) => {
    const text = await P.readFile(req.params.p, req.query.path);   // read first: an error must go out as JSON, not text/plain
    res.type('text/plain').send(text);
  }));
  api.put('/projects/:p/file', wrap(async req => {
    const body = typeof req.body === 'string' ? req.body : (req.body?.text ?? '');
    await P.writeFile(req.params.p, req.query.path, body);
    return { ok: true };
  }));
  api.post('/projects/:p/rename', wrap(async req => {
    const { from, to } = req.body || {};
    if (!from || !to) throw Object.assign(new Error('from and to are required'), { status: 400 });
    return P.renameFile(req.params.p, String(from), String(to));
  }));
  api.delete('/projects/:p/file', wrap(async req => { await P.deleteFile(req.params.p, req.query.path); return { ok: true }; }));
  api.get('/projects/:p/sources', wrap(req => P.readSources(req.params.p)));
  api.get('/templates', wrap(() => fs.readdirSync(P.EXAMPLES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(P.EXAMPLES_DIR, d.name, 'silinx.json')))
    .map(d => d.name)));

  // Implementation (ISE) + programming routes live in impl-routes.js.
  const { registerImplRoutes } = await import('./impl-routes.js');
  registerImplRoutes(api, { wrap, projects: P });

  app.use('/api', api);
  return app;
}

export async function startServer({ port = 8642, host = '127.0.0.1' } = {}) {
  const app = await createApp({ host });
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      console.log(`Silinx running at http://${host}:${port}  (workspace: ${P.workspaceDir()})`);
      resolve(srv);
    });
    srv.on('error', reject);
  });
}

/** Open a URL in the default browser (best effort). */
export async function openBrowser(url) {
  // SILINX_NO_BROWSER=1: only print the URL (tests run the launchers this way; also for a server)
  if (process.env.SILINX_NO_BROWSER) return;
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    // no opener installed (headless Linux without xdg-open): spawn reports ENOENT as an 'error' event,
    // which would crash the process without a listener
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser: the URL is printed */ });
    child.unref();
  } catch { /* no browser: the URL is printed */ }
}
