// Silinx - open synthesis (browser + Node): Silinx's front end writes the elaborated design as one
// flat SystemVerilog module (core/synth-verilog.js), and Yosys compiled to WebAssembly (YoWASP,
// package @yowasp/yosys, ISC licence) maps it onto the cells of the device family (synth_xilinx)
// and writes the netlist: JSON (as core/fpga/netlist.js reads it) and Verilog, with its statistics.
// No Xilinx tool is involved. The caller says how Yosys runs: in a Web Worker in the browser
// (web/js/yosys-worker.js), directly in Node (core/synth-open-node.js).
//
//   const r = await synthesizeOpen(design, { family: 'spartan3e', run, onLine })
//   r: { top, files: { '<top>_syn.v', '<top>.json', '<top>_yosys.v', '<top>_stat.txt' }, cells, util,
//        warnings, log }
import { toVerilog } from './synth-verilog.js';

// Silinx's device families -> synth_xilinx -family
export const YOSYS_FAMILY = {
  spartan3: 'xc3s', spartan3e: 'xc3se', spartan3a: 'xc3sa', spartan3adsp: 'xc3sda', spartan6: 'xc6s',
  virtex4: 'xc4v', virtex5: 'xc5v', virtex6: 'xc6v', artix7: 'xc7', kintex7: 'xc7', zynq: 'xc7',
};

/** The Yosys script: read the flat module, map it, write the netlist and its statistics. */
export function yosysScript(top, family) {
  const fam = YOSYS_FAMILY[family];
  if (!fam) throw new Error(`open synthesis: no Yosys mapping for the device family '${family}'`);
  // $scopeinfo cells (kept hierarchy names) are not cells of the device: deleted before writing
  return `read_verilog -sv ${top}_syn.v; synth_xilinx -family ${fam} -ise -flatten -top ${top}; delete t:$scopeinfo; `
    + `write_json ${top}.json; write_verilog -noattr ${top}_yosys.v; tee -q -o ${top}_stat.txt stat`;
}

/** Cells of a Yosys JSON netlist by type: { LUT4: 286, FDRE: 48, … } (the top module's). */
export function cellCounts(json, top) {
  const nl = typeof json === 'string' ? JSON.parse(json) : json;
  const mod = nl.modules[top] || Object.values(nl.modules).find(m => m.attributes?.top) || Object.values(nl.modules)[0];
  const counts = {};
  for (const c of Object.values(mod?.cells || {})) counts[c.type] = (counts[c.type] || 0) + 1;
  return counts;
}

/** The resources of the cell counts, as the Design Summary lists them. */
export function utilization(counts) {
  const sum = re => Object.entries(counts).reduce((n, [t, k]) => n + (re.test(t) ? k : 0), 0);
  return {
    luts: sum(/^LUT[1-6]$/),
    flipFlops: sum(/^FD/),
    latches: sum(/^LD/),
    muxes: sum(/^MUXF[5-8]$/),
    carry: sum(/^(MUXCY|XORCY|CARRY4)$/),
    shiftRegisters: sum(/^SRL/),
    distributedRam: sum(/^RAM\d+X/),
    blockRam: sum(/^RAMB/),
    multipliers: sum(/^(MULT18X18|DSP48)/),
    clockBuffers: sum(/^BUFG/),
    dcms: sum(/^(DCM|PLL|MMCM)/),
    ios: sum(/^(IBUF|OBUF|IOBUF|OBUFT|IBUFG)/),
    cells: sum(/./),
  };
}

/**
 * Synthesize an elaborated design (core/elaborate.js). run(args, files, onLine) runs Yosys and
 * resolves with its output files ({ name: text }), or rejects with an error whose `lines` holds
 * Yosys's messages. onLine receives Yosys's output line by line.
 */
export async function synthesizeOpen(design, { family = 'spartan3e', run, onLine = () => {} } = {}) {
  const { text, top, warnings } = toVerilog(design);
  const script = yosysScript(top, family);
  const log = [];
  const line = l => { log.push(l); onLine(l); };
  const out = await run(['-q', '-p', script], { [`${top}_syn.v`]: text }, line);
  const json = out[`${top}.json`];
  if (!json) throw Object.assign(new Error('Yosys wrote no netlist'), { lines: log });
  const files = { [`${top}_syn.v`]: text, [`${top}.json`]: json, [`${top}_yosys.v`]: out[`${top}_yosys.v`] || '', [`${top}_stat.txt`]: out[`${top}_stat.txt`] || '' };
  const cells = cellCounts(json, top);
  return { top, files, cells, util: utilization(cells), warnings: [...warnings, ...log.filter(l => /^Warning:/.test(l))], log };
}

/** Text of a Yosys output file (YoWASP gives strings, or bytes for binary files). */
export const asText = v => (typeof v === 'string' ? v : v instanceof Uint8Array ? new TextDecoder().decode(v) : '');

/**
 * Line splitter for Yosys's stdout / stderr byte streams: feed(bytes | null) calls onLine for each
 * complete line; null (end of stream) flushes the rest.
 */
export function lineStream(onLine) {
  const dec = new TextDecoder();
  let buf = '';
  return bytes => {
    buf += bytes ? dec.decode(bytes, { stream: true }) : dec.decode();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    if (!bytes && buf) { onLine(buf); buf = ''; }
  };
}
