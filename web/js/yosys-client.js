// The page's side of web/js/yosys-worker.js: run(args, files, onLine) for core/synth-open.js, with
// Yosys in a Web Worker (one worker, kept: the WebAssembly module is fetched and compiled once).
let worker = null, seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('/js/yosys-worker.js', { type: 'module' });
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    if (data.line !== undefined) p.onLine(data.line);
    else if (data.progress !== undefined) p.onProgress?.(data.progress);
    else { pending.delete(data.id); if (data.error) p.reject(Object.assign(new Error(data.error), { code: data.code })); else p.resolve(data.files); }
  };
  worker.onerror = e => {
    // the worker could not start (e.g. the module was not found): fail every run, start afresh next time
    for (const p of pending.values()) p.reject(new Error(`the Yosys worker failed: ${e.message || 'could not be loaded'}`));
    pending.clear(); worker = null;
  };
  return worker;
}

/** run() for core/synth-open.js. onProgress(0…1) while the WebAssembly module is being fetched. */
export function yosysBrowser(args, files, onLine = () => {}, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onLine, onProgress });
    getWorker().postMessage({ id, args, files });
  });
}
