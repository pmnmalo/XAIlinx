// Silinx - open synthesis in Node: run() for core/synth-open.js with Yosys from @yowasp/yosys in
// this process (the browser runs it in a Web Worker instead: web/js/yosys-worker.js). Kept apart
// from core/synth-open.js so that the page never imports the Node-only loader.
import { lineStream, asText } from './synth-open.js';

/** run() for Node: Yosys from @yowasp/yosys in this process. */
export async function yosysNode(args, files, onLine = () => {}) {
  const { runYosys } = await import('@yowasp/yosys');
  const out = lineStream(onLine);
  try {
    const res = await runYosys(args, files, { stdout: out, stderr: out, fetchProgress: () => {} });
    out(null);
    return Object.fromEntries(Object.entries(res).map(([k, v]) => [k, asText(v)]));
  } catch (e) {
    out(null);
    throw Object.assign(new Error(`Yosys failed${e.code !== undefined ? ` (exit code ${e.code})` : `: ${e.message}`}`), { code: e.code });
  }
}
