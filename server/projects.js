// Project storage: one directory per project with a silinx.json descriptor.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EXAMPLES_DIR = path.join(HERE, '..', 'examples');

export const PROJECT_FILE = 'silinx.json';

export function workspaceDir() {
  return process.env.SILINX_WORKSPACE || path.join(os.homedir(), 'Silinx-projects');
}

const projectFile = async dir => path.join(dir, PROJECT_FILE);

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function projectDir(name) {
  if (!NAME_RE.test(name || '')) throw new HttpError(400, `invalid project name '${name}'`);
  return path.join(workspaceDir(), name);
}

// Resolve a project-relative path, refusing anything that escapes the project folder.
export function safeJoin(dir, rel) {
  if (!rel || typeof rel !== 'string') throw new HttpError(400, 'missing path');
  const full = path.resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + path.sep)) throw new HttpError(400, 'path escapes project');
  return full;
}

export function langOf(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.v' || ext === '.vh' || ext === '.sv') return 'verilog';
  if (ext === '.vhd' || ext === '.vhdl') return 'vhdl';
  if (ext === '.ucf') return 'ucf';
  return 'text';
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

export async function listProjects() {
  const ws = workspaceDir();
  await fs.mkdir(ws, { recursive: true });
  const out = [];
  for (const ent of await fs.readdir(ws, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    try {
      const pj = JSON.parse(await fs.readFile(await projectFile(path.join(ws, ent.name)), 'utf8'));
      out.push({ name: ent.name, device: pj.device, top: pj.top, board: pj.board });
    } catch { /* not a project */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readProject(name) {
  const dir = projectDir(name);
  let pj;
  try { pj = JSON.parse(await fs.readFile(await projectFile(dir), 'utf8')); }
  catch { throw new HttpError(404, `project '${name}' not found`); }
  pj.name = name;
  pj.files ||= [];
  return pj;
}

// Per-project mutex: every read-modify-write of silinx.json runs under it, so concurrent requests
// (API, CLI, several browser tabs) cannot lose each other's updates.
const locks = new Map();
export function withProjectLock(name, fn) {
  name = String(name).toLowerCase();   // case-insensitive file systems: Foo and foo are one folder
  const prev = locks.get(name) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  locks.set(name, tail);
  tail.then(() => { if (locks.get(name) === tail) locks.delete(name); });
  return run;
}

// Atomic write (temp file + rename): a concurrent reader never sees a half-written silinx.json.
async function writeProjectUnlocked(name, pj) {
  const dir = projectDir(name);
  const clean = { ...pj, name };
  delete clean.fileTree;
  const file = path.join(dir, PROJECT_FILE);
  const tmp = path.join(dir, `.${PROJECT_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(clean, null, 2) + '\n');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return clean;
}

export function writeProject(name, pj) {
  projectDir(name);
  return withProjectLock(name, () => writeProjectUnlocked(name, pj));
}

/** Read silinx.json, let `fn(pj)` change it (or return a new object), write it back, all under the project lock. */
export function updateProject(name, fn) {
  projectDir(name);
  return withProjectLock(name, async () => {
    const pj = await readProject(name);
    const next = (await fn(pj)) ?? pj;
    return writeProjectUnlocked(name, next);
  });
}

async function walk(dir, base = '') {
  const out = [];
  for (const ent of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    if (ent.name.startsWith('.') || (base === '' && ent.name === 'build')) continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...await walk(dir, rel));
    else out.push(rel);
  }
  return out;
}

export async function fileTree(name) {
  return (await walk(projectDir(name))).filter(f => f !== PROJECT_FILE).sort();
}

const DEFAULT_DEVICE = { family: 'spartan3e', part: 'xc3s250e', package: 'cp132', speed: '-4' };

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d); else await fs.copyFile(s, d);
  }
}

export async function createProject({ name, template = 'empty', device, board }) {
  const dir = projectDir(name);
  if (await exists(dir)) throw new HttpError(409, `project '${name}' already exists`);
  if (template && template !== 'empty') {
    const src = path.join(EXAMPLES_DIR, template);
    if (!/^[a-z0-9_-]+$/i.test(template) || !await exists(path.join(src, PROJECT_FILE)))
      throw new HttpError(400, `unknown template '${template}'`);
    await copyDir(src, dir);
    const pj = await readProject(name);
    if (device) pj.device = device;
    if (board !== undefined) pj.board = board;
    return writeProject(name, pj);
  }
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sim'), { recursive: true });
  await fs.mkdir(path.join(dir, 'constraints'), { recursive: true });
  return writeProject(name, {
    name, version: 1, device: device || DEFAULT_DEVICE, board: board ?? null,
    top: '', simTop: '', files: [], constraints: 'constraints/top.ucf',
    stimuli: {}, impl: { optMode: 'Speed', optLevel: 1, startupClk: 'JtagClk' },
  });
}

export async function deleteProject(name) {
  const dir = projectDir(name);
  if (!await exists(dir)) throw new HttpError(404, 'not found');
  const trash = path.join(workspaceDir(), '.trash');
  await fs.mkdir(trash, { recursive: true });
  await fs.rename(dir, path.join(trash, `${name}-${Date.now()}`));
}

export async function readFile(name, rel) {
  const full = safeJoin(projectDir(name), rel);
  try { return await fs.readFile(full, 'utf8'); }
  catch { throw new HttpError(404, `file '${rel}' not found`); }
}

export async function writeFile(name, rel, text) {
  const dir = projectDir(name);
  const full = safeJoin(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  // atomic: a reader (or a crash) never sees a half-written / empty file
  const tmp = path.join(path.dirname(full), `.${path.basename(full)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);   // hidden: not listed
  try {
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, full);
  } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
  // Register HDL files automatically (not the generated ones in build/, e.g. the netlists of the open
  // synthesis); a file written again is back in the project (not excluded).
  const lang = langOf(rel);
  {
    const pj0 = await readProject(name);
    if ((pj0.excluded || []).includes(rel)) await updateProject(name, pj => { pj.excluded = (pj.excluded || []).filter(f => f !== rel); });
  }
  if ((lang === 'verilog' || lang === 'vhdl') && !/^build\//.test(rel)) {
    await withProjectLock(name, async () => {
      const pj = await readProject(name);
      if (!pj.files.some(f => f.path === rel)) {
        const role = /^(sim|tb|test)\//.test(rel) || /(^|\/)tb_|_tb\.|_tb$/.test(rel) ? 'sim' : 'design';
        pj.files.push({ path: rel, lang, role });
        await writeProjectUnlocked(name, pj);
      }
    });
  }
}

// project-relative path normalised to forward slashes, without './' or a trailing '/'
const relKey = (dir, full) => path.relative(dir, full).split(path.sep).join('/');

/** Move/rename a project file (or folder), keeping the project's file list and constraints path. */
export async function renameFile(name, from, to) {
  const dir = projectDir(name);
  const src = safeJoin(dir, from), dst = safeJoin(dir, to);
  if (src === dir || dst === dir) throw new HttpError(400, 'cannot rename the project folder itself');
  const fromKey = relKey(dir, src), toKey = relKey(dir, dst);
  if (fromKey === PROJECT_FILE || toKey === PROJECT_FILE) throw new HttpError(400, `${PROJECT_FILE} cannot be renamed`);
  return withProjectLock(name, async () => {
    let st;
    try { st = await fs.stat(src); } catch { throw new HttpError(404, `file '${from}' not found`); }
    const isDir = st.isDirectory();
    if (isDir && src !== dst && (dst + path.sep).startsWith(src + path.sep)) throw new HttpError(400, `cannot move '${from}' into itself`);
    if (src !== dst && await exists(dst) && src.toLowerCase() !== dst.toLowerCase()) throw new HttpError(409, `'${to}' already exists`);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    const pj = await readProject(name);
    // a file maps exactly; a folder maps every path below it
    const remap = p => {
      if (p === fromKey) return toKey;
      if (isDir && p.startsWith(fromKey + '/')) return toKey + p.slice(fromKey.length);
      return null;
    };
    pj.files = pj.files.map(f => {
      const np = remap(f.path);
      if (np === null) return f;
      const lang = langOf(np);
      return { ...f, path: np, lang: lang === 'vhdl' || lang === 'verilog' ? lang : f.lang };
    });
    if (pj.constraints) pj.constraints = remap(pj.constraints) ?? pj.constraints;
    return writeProjectUnlocked(name, pj);
  });
}

/** Delete a project file or folder (recursively) and unregister the files it contained. */
export async function deleteFile(name, rel) {
  const dir = projectDir(name);
  const full = safeJoin(dir, rel);
  if (full === dir) throw new HttpError(400, 'cannot delete the project folder itself (delete the project instead)');
  const key = relKey(dir, full);
  if (key === PROJECT_FILE) throw new HttpError(400, `${PROJECT_FILE} cannot be deleted`);
  await withProjectLock(name, async () => {
    await fs.rm(full, { recursive: true, force: true });
    const pj = await readProject(name);
    const n = pj.files.length;
    pj.files = pj.files.filter(f => f.path !== key && !f.path.startsWith(key + '/'));
    if (pj.files.length !== n) await writeProjectUnlocked(name, pj);
  });
}

export async function readSources(name) {
  const pj = await readProject(name);
  const out = [];
  for (const f of pj.files) {
    try { out.push({ ...f, text: await readFile(name, f.path) }); }
    catch { out.push({ ...f, text: '', missing: true }); }
  }
  return out;
}
