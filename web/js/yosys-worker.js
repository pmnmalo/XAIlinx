// Web Worker: runs Yosys compiled to WebAssembly (YoWASP, /vendor/yowasp-yosys) off the page's
// thread, so that the interface keeps working during a synthesis (core/synth-open.js).
//   in:  { id, args, files }                 out: { id, line } … then { id, files } or { id, error, code }
//                                              and { id, progress: 0…1 } while the module is fetched
import { runYosys } from '/vendor/yowasp-yosys/gen/bundle.js';
import { lineStream, asText } from '/core/synth-open.js';

self.onmessage = async ({ data: { id, args, files } }) => {
  const out = lineStream(line => self.postMessage({ id, line }));
  try {
    const res = await runYosys(args, files, {
      stdout: out, stderr: out,
      fetchProgress: e => { if (e.totalLength) self.postMessage({ id, progress: e.doneLength / e.totalLength }); },
    });
    out(null);
    self.postMessage({ id, files: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, asText(v)])) });
  } catch (e) {
    out(null);
    self.postMessage({ id, error: e.code !== undefined ? `Yosys failed (exit code ${e.code})` : `Yosys failed: ${e.message}`, code: e.code });
  }
};
