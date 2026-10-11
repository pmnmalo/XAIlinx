// Silinx schematic editor (ISE 14.x "Schematic Editor" look). SVG, no framework.
//
//   import { mountSchEditor } from './sch-editor.js';
//   const ed = mountSchEditor(container, {
//     doc,                       // a .sch.json document (core/schdoc.js format); a new one if omitted
//     modules,                   // { name: { name, ports: [{ name, dir, width, type? }], generics: [{ name, default }] } }
//     onChange(doc) {},          // debounced, after every edit
//     onGenerate({ lang, filename, code }) {},
//     onOpenModule(moduleName) {},
//   });
//   readOnly: true             // view only: pan/zoom/select/inspect, no edits (RTL schematic viewer)
//   ed.getDoc(); ed.setDoc(doc); ed.setModules(modules); ed.fit(); ed.destroy();
//
// Styles: web/css/sch-editor.css (scoped under .sch-editor, themed by the ISE variables of theme.css).

import {
  SYMBOLS, SYMBOL_CATEGORIES, GRID, defaultParams, normalizeDoc, newDoc, symbolDef, symbolPins, symbolBox,
  xform, rotSize, portBox, netlist, generateHdl, parseNetName,
} from '/core/schdoc.js';
import { svgSnapshot, printDiagram } from './print.js';
import { symbolSummary, presetOf } from '/core/symdocs.js';
import { getLanguage, onLanguageChange } from './i18n.js';
import { popupMenu } from './ui.js';
import { rerouteAfterMove, connectivity, placementClashes, connectionsKept } from '/core/schroute.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const snap = v => Math.round(v / GRID) * GRID;
const r1 = v => Math.round(v * 10) / 10;
const KEYS = { sym: 'symbols', wire: 'wires', port: 'ports', label: 'labels' };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

// ------------------------------------------------------------------ icons (16x16)
const I = (body) => `<svg viewBox="0 0 16 16">${body}</svg>`;
const ICON = {
  select: I('<path d="M3 1.5v12l3.2-3 2.3 5 1.8-.8-2.3-5H12z" fill="#fff" stroke="#24476f" stroke-width="1.1" stroke-linejoin="round"/>'),
  wire: I('<path d="M1.5 12.5h5v-9h8" fill="none" stroke="#0000a0" stroke-width="1.6"/><circle cx="1.5" cy="12.5" r="1.4" fill="#0000a0"/><circle cx="14.5" cy="3.5" r="1.4" fill="#0000a0"/>'),
  net: I('<path d="M1 12.5h14" stroke="#0000a0" stroke-width="1.4"/><text x="1.5" y="9.5" font-size="8" font-family="Arial" font-weight="bold" fill="#800000">abc</text>'),
  io: I('<path d="M1.5 4.5h8l4 3.5-4 3.5h-8z" fill="#fffff0" stroke="#000080" stroke-width="1.2"/>'),
  rotate: I('<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2" fill="none" stroke="#24476f" stroke-width="1.5"/><path d="M13.6 1.8v3.8H9.8z" fill="#24476f"/>'),
  mirror: I('<path d="M8 1v14" stroke="#888" stroke-dasharray="2 1.5"/><path d="M6.5 3.5v9L1.5 12.5z" fill="#9cc3ea" stroke="#24476f"/><path d="M9.5 3.5v9l5 0z" fill="#fff" stroke="#24476f"/>'),
  del: I('<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="#c00000" stroke-width="2.2" stroke-linecap="round"/>'),
  undo: I('<path d="M5 4.5H10a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="#24476f" stroke-width="1.6"/><path d="M1.5 4.5L5.5 1.5v6z" fill="#24476f"/>'),
  redo: I('<path d="M11 4.5H6a3.5 3.5 0 0 0 0 7h4" fill="none" stroke="#24476f" stroke-width="1.6"/><path d="M14.5 4.5L10.5 1.5v6z" fill="#24476f"/>'),
  zin: I('<circle cx="6.5" cy="6.5" r="4.5" fill="#e8f2fc" stroke="#24476f" stroke-width="1.4"/><path d="M10 10l4.5 4.5" stroke="#24476f" stroke-width="2"/><path d="M4 6.5h5M6.5 4v5" stroke="#24476f" stroke-width="1.4"/>'),
  zout: I('<circle cx="6.5" cy="6.5" r="4.5" fill="#e8f2fc" stroke="#24476f" stroke-width="1.4"/><path d="M10 10l4.5 4.5" stroke="#24476f" stroke-width="2"/><path d="M4 6.5h5" stroke="#24476f" stroke-width="1.4"/>'),
  fit: I('<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="#24476f" stroke-width="1.5"/><rect x="5" y="5" width="6" height="6" fill="#9cc3ea" stroke="#24476f"/>'),
  check: I('<rect x="1.5" y="1.5" width="13" height="13" rx="1" fill="#fff" stroke="#24476f"/><path d="M4 8.2l2.6 2.6L12 5" fill="none" stroke="#008000" stroke-width="2"/>'),
  gen: I('<path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#24476f"/><path d="M10 1.5v3h3" fill="none" stroke="#24476f"/><path d="M5 8h6M5 10.5h6M5 13h4" stroke="#316ac5"/><path d="M1 6.5l2.5 2-2.5 2" fill="none" stroke="#c08000" stroke-width="1.4"/>'),
  sim: I('<rect x="1" y="4" width="7" height="8" rx="1.5" fill="#1f6b1f" stroke="#0d3d0d"/><rect x="4.5" y="5.5" width="2.5" height="5" rx=".6" fill="#fff"/><path d="M9 8h2.5" stroke="#00b000" stroke-width="1.6"/><circle cx="13" cy="8" r="2.4" fill="#33e033" stroke="#0d6d0d"/>'),
  info: I('<circle cx="8" cy="8" r="6.5" fill="#e8f2fc" stroke="#24476f" stroke-width="1.2"/><circle cx="8" cy="4.6" r="1.1" fill="#24476f"/><path d="M8 7v5" stroke="#24476f" stroke-width="2"/>'),
  view: I('<path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#24476f"/><path d="M10 1.5v3h3" fill="none" stroke="#24476f"/><text x="4.2" y="12" font-size="6.5" font-family="Consolas,monospace" font-weight="bold" fill="#000080">&lt;/&gt;</text>'),
};

// ------------------------------------------------------------------ symbol drawing (local coordinates)
function lead(x1, y1, x2, y2, bus) { return `<line class="pin${bus ? ' bus' : ''}" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`; }

function bodySvg(sym, def) {
  const pins = def.pins;
  const bus = p => (p.width || 1) > 1;
  let s = '';
  const h = def.h;
  switch (def.shape) {
    case 'gate': {
      const g = def.gate;
      const base = g.replace(/^n(?=and|or)/, '').replace(/^xn/, 'x');
      const isOr = base === 'or' || base === 'xor';
      if (!isOr) s += `<path class="gate" d="M20,0 H40 A20,${h / 2} 0 0 1 40,${h} H20 Z"/>`;
      else {
        s += `<path class="gate" d="M20,0 Q48,0 60,${h / 2} Q48,${h} 20,${h} Q32,${h / 2} 20,0 Z"/>`;
        if (base === 'xor') s += `<path class="gate nofill" d="M14,${h} Q26,${h / 2} 14,0"/>`;
      }
      for (const p of pins) {
        if (p.dir === 'out') {
          const x0 = def.bubble ? 66 : 60;
          s += lead(x0, p.y, p.x, p.y, bus(p));
        } else {
          const t = p.y / h;
          const xe = isOr ? (base === 'xor' ? 14 : 20) + 24 * t * (1 - t) : 20;
          if (p.inv) {
            // inverted input (ANDnBk...): bubble between the pin lead and the body, as ISE draws it
            s += lead(0, p.y, xe - 8, p.y, bus(p)) + `<circle class="gate bubble" cx="${r1(xe - 4)}" cy="${p.y}" r="4"/>`;
          } else s += lead(0, p.y, xe, p.y, bus(p));
        }
      }
      if (def.bubble) s += `<circle class="gate" cx="63" cy="${h / 2}" r="3"/>`;
      break;
    }
    case 'inv': case 'buf': {
      s += `<path class="gate" d="M20,0 L44,10 L20,20 Z"/>`;
      if (def.shape === 'inv') s += `<circle class="gate" cx="47" cy="10" r="3"/>`;
      s += lead(0, 10, 20, 10, bus(pins[0])) + lead(def.shape === 'inv' ? 50 : 44, 10, 60, 10, bus(pins[1]));
      break;
    }
    case 'tbuf': {
      // tri-state buffer: one triangle per row, the enable line from the pin (row 0) down to their top
      // edges (x = 33), a bubble on it for the active-low T of BUFT
      const n = def.rows, ex = 33, edge = k => 20 + 20 * k + (ex - 20) * 10 / 26;
      s += lead(0, 10, ex, 10, false) + `<path class="gate nofill" d="M${ex},10 V${r1(edge(n - 1))}"/>`;
      for (let k = 0; k < n; k++) {
        const y = 30 + 20 * k, ip = pins[1 + k], op = pins[1 + n + k];
        s += `<path class="gate" d="M20,${y - 10} L46,${y} L20,${y + 10} Z"/>` + lead(0, y, 20, y, bus(ip)) + lead(46, y, 60, y, bus(op));
      }
      if (def.activeLow) s += `<circle class="gate" cx="${ex}" cy="${r1(edge(0) - 3.5)}" r="3"/>`;
      break;
    }
    case 'mux': {
      const bh = def.body.h;
      s += `<path class="gate" d="M20,0 L60,10 L60,${bh - 10} L20,${bh} Z"/>`;
      for (const p of pins) {
        if (p.side === 'W') s += lead(0, p.y, 20, p.y, bus(p));
        else if (p.side === 'S') s += lead(p.x, bh - 5, p.x, p.y, bus(p));
        else s += lead(60, p.y, p.x, p.y, bus(p));
      }
      break;
    }
    case 'demux': {
      const b = def.body, bh = b.h, x1 = b.x + b.w;
      s += `<path class="gate" d="M${b.x},20 L${x1},0 L${x1},${bh} L${b.x},${bh - 20} Z"/>`;
      for (const p of pins) {
        if (p.side === 'W') s += lead(0, p.y, b.x, p.y, bus(p));
        else if (p.side === 'S') s += lead(p.x, bh - 20 + 20 * (p.x - b.x) / b.w, p.x, p.y, bus(p));
        else s += lead(x1, p.y, p.x, p.y, bus(p));
      }
      break;
    }
    case 'lib': {
      const b = def.body;
      s += `<rect class="gate" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
      for (const p of pins) s += p.side === 'W' ? lead(0, p.y, b.x, p.y, bus(p)) : lead(b.x + b.w, p.y, p.x, p.y, bus(p));
      break;
    }
    case 'arith': {
      s += `<rect class="gate" x="20" y="0" width="40" height="${h}"/>`;
      for (const p of pins) s += p.side === 'W' ? lead(0, p.y, 20, p.y, bus(p)) : lead(60, p.y, p.x, p.y, bus(p));
      break;
    }
    case 'ff': {
      s += `<rect class="gate" x="20" y="0" width="50" height="${h}"/>`;
      for (const p of pins) {
        if (p.side === 'W') { s += lead(0, p.y, 20, p.y, bus(p)); if (p.clock) s += `<path class="clk" d="M20,${p.y - 5} L28,${p.y} L20,${p.y + 5}"/>`; }
        else s += lead(70, p.y, p.x, p.y, bus(p));
      }
      break;
    }
    case 'slice': {
      s += lead(0, 10, 15, 10, true) + `<path class="ripper" d="M15,13 L25,7 L25,13 Z"/>` + lead(25, 10, 40, 10, (pins[1].width || 1) > 1);
      break;
    }
    case 'join': {
      s += `<rect class="ripper" x="18" y="0" width="4" height="${h}"/>`;
      for (const p of pins) s += p.side === 'W' ? lead(0, p.y, 18, p.y, bus(p)) : lead(22, p.y, p.x, p.y, true);
      break;
    }
    case 'const': {
      s += `<rect class="cbox" x="0" y="2" width="${def.w - 20}" height="16" rx="2"/>` + lead(def.w - 20, 10, def.w, 10, bus(pins[0]));
      break;
    }
    case 'vcc': s += `<path class="gate nofill" d="M2,10 H18 M10,10 V30"/>`; break;
    case 'gnd': s += `<path class="gate nofill" d="M10,0 V20 M1,20 H19 M4,24 H16 M7,28 H13"/>`; break;
    case 'module': case 'hdl': default: {
      const b = def.body;
      s += `<rect class="box${def.shape === 'hdl' ? ' hdl' : ''}${def.missing ? ' missing' : ''}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
      for (const p of pins) {
        s += p.side === 'W' ? lead(0, p.y, b.x, p.y, bus(p)) : lead(b.x + b.w, p.y, p.x, p.y, bus(p));
        if (p.clock) s += `<path class="clk" d="M${b.x},${p.y - 5} L${b.x + 8},${p.y} L${b.x},${p.y + 5}"/>`;
      }
    }
  }
  return s;
}

// readable texts, positioned in sheet coordinates
function textsSvg(sym, def) {
  let s = '';
  const box = symbolBox(sym, null, def);
  const cx = (lx, ly) => xform(sym, def, lx, ly);
  const center = cx(def.body.x + def.body.w / 2, def.body.y + def.body.h / 2);
  const showName = !['constant', 'vcc', 'gnd', 'slice', 'busjoin'].includes(sym.type);
  const pinLabels = ['module', 'hdl', 'ff', 'arith', 'mux', 'demux', 'lib'].includes(def.shape);
  if (showName) {
    // above the symbol; when pins stick out of the top (turned symbols), beside the top right corner instead
    const topPins = (def.shape === 'lib' || def.shape === 'demux' || def.shape === 'mux' || def.shape === 'ff') && symbolPins(sym, null, def).some(p => p.side === 'N');
    s += topPins ? `<text class="iname" x="${box.x + box.w + 3}" y="${box.y - 2}" text-anchor="start">${esc(sym.name)}</text>`
      : `<text class="iname" x="${box.x + box.w / 2}" y="${box.y - 4}" text-anchor="middle">${esc(sym.name)}</text>`;
  }
  if (def.shape === 'module' || def.shape === 'hdl') {
    const tt = def.shape === 'hdl' ? (sym.params.title || 'HDL') : def.title;
    const top = cx(def.body.x + def.body.w / 2, def.body.y + 11);
    const rot = sym.rot === 90 || sym.rot === 270;
    s += `<text class="stitle${def.shape === 'hdl' ? ' hdl' : ''}" x="${rot ? center.x : top.x}" y="${rot ? center.y : top.y + 3}" text-anchor="middle">${esc(tt)}</text>`;
  } else if (def.shape === 'ff') {
    // type name in the bottom corner away from the inputs (turned 90/270: the centre of the body)
    const turned = sym.rot === 90 || sym.rot === 270;
    const t = turned ? center : cx(def.body.x + def.body.w - 3, def.body.h - 4);
    const dx = xform(sym, def, 1, 0).x - xform(sym, def, 0, 0).x;
    const nm = SYMBOLS[sym.type]?.title || '';
    s += `<text class="stype" x="${t.x}" y="${t.y + (turned ? 3 : sym.rot === 180 ? 7 : 0)}" text-anchor="${turned ? 'middle' : dx > 0 ? 'end' : 'start'}">${esc(sym.type === 'register' || sym.type === 'counter' ? `${nm}${sym.params.width}` : nm)}</text>`;
  } else if (def.shape === 'lib') {
    // decoders / encoders: symbol name in the free top row, like the title of module symbols (centre when turned)
    const top = cx(def.body.x + def.body.w / 2, def.body.y + 15);
    const rot = sym.rot === 90 || sym.rot === 270;
    s += `<text class="stitle" x="${rot ? center.x : top.x}" y="${rot ? center.y + 4 : top.y + 4}" text-anchor="middle">${esc(def.title)}</text>`;
  } else if (def.shape === 'arith') {
    s += `<text class="sop" x="${center.x}" y="${center.y + 5}" text-anchor="middle">${esc(def.op)}</text>`;
  } else if (def.shape === 'slice') {
    const t = cx(20, 0);
    s += `<text class="stext" x="${t.x}" y="${t.y - 3}" text-anchor="middle">${esc(def.text)}</text>`;
  } else if (def.shape === 'const') {
    const t = cx((def.w - 20) / 2, 10);
    s += `<text class="cval" x="${t.x}" y="${t.y + 4}" text-anchor="middle">${esc(def.text)}</text>`;
  } else if (def.shape === 'vcc' || def.shape === 'gnd') {
    const t = cx(10, def.shape === 'vcc' ? 6 : 34);
    s += `<text class="stype" x="${t.x}" y="${t.y + (def.shape === 'vcc' ? -2 : 6)}" text-anchor="middle">${def.shape.toUpperCase()}</text>`;
  } else if (def.shape === 'gate' || def.shape === 'inv' || def.shape === 'buf') {
    const w = sym.params?.width > 1 ? `${sym.params.width}` : '';
    if (w) { const t = cx(def.body.x + 8, def.h / 2); s += `<text class="pname" x="${t.x}" y="${t.y + 3}" text-anchor="middle">${w}</text>`; }
  } else if (def.shape === 'tbuf') {
    // bus width inside the triangle (bus pins), as for the gates
    const w = def.rows === 1 && sym.params?.width > 1 ? `${sym.params.width}` : '';
    if (w) { const t = cx(def.body.x + 7, 30); s += `<text class="pname" x="${t.x}" y="${t.y + 3}" text-anchor="middle">${w}</text>`; }
  }
  if (def.shape === 'lib' || def.shape === 'demux' || def.shape === 'ff') {
    // pin names inside the body, clear of the 20 px leads, upright in every orientation; bus widths beside the pin end
    for (const p of symbolPins(sym, null, def)) {
      const v = { W: [1, 0], E: [-1, 0], N: [0, 1], S: [0, -1] }[p.side];
      // demux select: the lead ends on the sloped edge; clock pins: room for the clock triangle
      const L = 20 + (def.shape === 'demux' && p.ly === def.h ? 6 : 0) + (p.clock ? 8 : 0);
      let x = p.x, y = p.y, anchor = 'middle';
      if (v[0]) { x += v[0] * (L + 3); y += 3; anchor = v[0] > 0 ? 'start' : 'end'; } else y += v[1] > 0 ? L + 10 : -(L + 4);
      s += `<text class="pname" x="${x}" y="${y}" text-anchor="${anchor}">${esc(p.name)}</text>`;
      if ((p.width || 1) > 1) {
        const o = { W: [-10, -3], E: [10, -3], N: [6, -4], S: [6, 10] }[p.side];
        s += `<text class="pwidth" x="${p.x + o[0]}" y="${p.y + o[1]}" text-anchor="${p.side === 'N' || p.side === 'S' ? 'start' : 'middle'}">${p.width}</text>`;
      }
    }
  } else if (pinLabels) {
    for (const p of symbolPins(sym, null, def)) {
      if (def.shape === 'mux' && p.side === 'E') continue;
      if (def.shape === 'arith' && sym.type !== 'add' && p.side === 'E') continue;
      const v = { W: [1, 0], E: [-1, 0], N: [0, 1], S: [0, -1] }[p.side];
      const inset = def.shape === 'mux' ? 23 : (def.shape === 'hdl' || def.shape === 'module') ? 23 + (p.clock && p.side === 'W' ? 8 : 0) : 22 + (p.clock ? 8 : 0);
      const x = p.x + v[0] * inset, y = p.y + v[1] * (p.side === 'S' ? 16 : 14);
      const anchor = v[0] > 0 ? 'start' : v[0] < 0 ? 'end' : 'middle';
      const label = def.shape === 'mux' ? (p.name.startsWith('D') ? p.name.slice(1) : p.name) : p.name;
      s += `<text class="pname" x="${x}" y="${y + (v[1] ? 0 : 3)}" text-anchor="${anchor}">${esc(label)}</text>`;
      if ((p.width || 1) > 1 && (def.shape === 'module' || def.shape === 'hdl')) {
        const o = { W: [-10, -3], E: [10, -3], N: [4, -8], S: [4, 8] }[p.side];
        s += `<text class="pwidth" x="${p.x + o[0]}" y="${p.y + o[1]}" text-anchor="middle">${p.width}</text>`;
      }
    }
  }
  return s;
}

function matrixOf(sym, def) {
  const o = xform(sym, def, 0, 0), a = xform(sym, def, 1, 0), b = xform(sym, def, 0, 1);
  return `matrix(${a.x - o.x},${a.y - o.y},${b.x - o.x},${b.y - o.y},${o.x},${o.y})`;
}

function symbolSvg(sym, def, cls = '') {
  const box = symbolBox(sym, null, def);
  return `<g class="sym${cls}" data-kind="sym" data-id="${esc(sym.id)}">`
    + `<rect class="hitbox" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"/>`
    + `<g transform="${matrixOf(sym, def)}">${bodySvg(sym, def)}</g>${textsSvg(sym, def)}</g>`;
}

/**
 * Standalone SVG drawing of a symbol at its parameters (Symbol Info datasheets): the editor drawing
 * plus the pin names of the symbols that do not show them (gates, inverters, arithmetic outputs).
 */
export function symbolDrawingSvg(symIn, def, { scale = 1.6 } = {}) {
  const sym = { ...symIn, x: 0, y: 0, rot: 0, mirror: false, name: '' };
  const labelled = ['lib', 'demux', 'ff', 'module', 'hdl', 'mux'].includes(def.shape);
  let extra = '';
  for (const p of def.pins) {
    if (labelled && !(def.shape === 'mux' && p.side === 'E')) continue;
    if (def.shape === 'arith' && p.side === 'W') continue;
    const v = { W: [-1, 0], E: [1, 0], N: [0, -1], S: [0, 1] }[p.side];
    const x = p.x + v[0] * 3, y = p.y + (v[1] ? v[1] * 12 : -3);
    extra += `<text class="pname" x="${x}" y="${y}" text-anchor="${v[0] < 0 ? 'end' : v[0] > 0 ? 'start' : 'middle'}">${esc(p.name)}</text>`;
  }
  const m = 34, w = def.w + 2 * m, hh = def.h + 2 * 22;
  return `<svg class="se-svg sd-svg" xmlns="${SVGNS}" viewBox="${-m} -22 ${w} ${hh}" width="${Math.round(w * scale)}" height="${Math.round(hh * scale)}">`
    + `<g class="sym">${bodySvg(sym, def)}${textsSvg(sym, def)}${extra}</g></svg>`;
}

function portSvg(p, cls = '') {
  const b = portBox(p);
  const name = p.width > 1 ? `${p.name}(${p.width - 1}:0)` : p.name;
  const y = p.y, M = 7;
  let shape;
  if (p.dir === 'in') { const x0 = p.x - 30; shape = `M${x0},${y - M} H${p.x - 10} L${p.x - 3},${y} L${p.x - 10},${y + M} H${x0} Z`; }
  else if (p.dir === 'out') { const x0 = p.x + 3; shape = `M${x0},${y - M} H${p.x + 23} L${p.x + 30},${y} L${p.x + 23},${y + M} H${x0} Z`; }
  else { const x0 = p.x + 3; shape = `M${x0},${y} L${x0 + 7},${y - M} H${p.x + 23} L${p.x + 30},${y} L${p.x + 23},${y + M} H${x0 + 7} Z`; }
  const tx = p.dir === 'in' ? p.x - 34 : p.x + 34;
  return `<g class="port${cls}" data-kind="port" data-id="${esc(p.id)}"><rect class="hitbox" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`
    + `<path class="iomark${p.width > 1 ? ' bus' : ''}" d="${shape}"/>`
    + `<line class="pin${p.width > 1 ? ' bus' : ''}" x1="${p.x}" y1="${y}" x2="${p.dir === 'in' ? p.x - 3 : p.x + 3}" y2="${y}"/>`
    + `<text class="ioname" x="${tx}" y="${y + 4}" text-anchor="${p.dir === 'in' ? 'end' : 'start'}">${esc(name)}</text></g>`;
}

// ------------------------------------------------------------------ geometry helpers
function onSeg(p, a, b, tol = 0) {
  if (a.x === b.x) return Math.abs(p.x - a.x) <= tol && p.y >= Math.min(a.y, b.y) - tol && p.y <= Math.max(a.y, b.y) + tol;
  if (a.y === b.y) return Math.abs(p.y - a.y) <= tol && p.x >= Math.min(a.x, b.x) - tol && p.x <= Math.max(a.x, b.x) + tol;
  return false;
}
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function cleanPts(pts) {
  const out = [];
  for (const p of pts) { const l = out[out.length - 1]; if (!l || l.x !== p.x || l.y !== p.y) out.push({ x: p.x, y: p.y }); }
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1], b = out[i + 1];
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}
const rectsTouch = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

let editorCount = 0;
let clipboard = null;

// ================================================================== the editor
export function mountSchEditor(container, opts = {}) {
  const uidE = ++editorCount;
  let modules = normMods(opts.modules);
  let doc = normalizeDoc(opts.doc || newDoc('schematic', 'vhdl'));
  let nl = null;                      // cached netlist of the current doc
  let view = { s: 1, tx: 40, ty: 40 };
  let tool = 'select';                // select | wire | net | io | place
  let placing = null;                 // { type, params, rot, mirror }
  let sel = new Set();                // 'sym:S1' ...
  let drag = null;                    // current mouse interaction
  let wireDraw = null;                // { pts: [], first: 'h'|'v' }
  let cursor = { x: 0, y: 0 };
  let hoverPin = null;
  const undoStack = [], redoStack = [];
  let changeTimer = null;
  let destroyed = false;
  let lastDiags = null;
  let genLang = doc.lang;
  const readOnly = !!opts.readOnly;
  let live = null;                    // live simulation controller (web/js/sch-live.js) while simulating
  let liveStarting = false;

  container.classList.add('sch-editor');
  container.classList.toggle('read-only', readOnly);
  if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
  container.innerHTML = '';

  // ---------------- DOM skeleton
  const tb = h('div', { class: 'se-toolbar' });
  const left = h('div', { class: 'se-left' });
  const canvas = h('div', { class: 'se-canvas' });
  const right = h('div', { class: 'se-right' });
  const status = h('div', { class: 'se-status' });
  const diagPanel = h('div', { class: 'se-diags', hidden: true });
  const simBar = h('div', { class: 'se-simbar', hidden: true });
  const main = h('div', { class: 'se-main' }, left, h('div', { class: 'se-center' }, simBar, canvas, diagPanel), right);
  container.append(tb, main, status);

  canvas.innerHTML = `<svg class="se-svg" xmlns="${SVGNS}">
    <defs>
      <pattern id="se-grid-${uidE}" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="0.7" class="griddot"/></pattern>
      <pattern id="se-grid2-${uidE}" width="${GRID * 5}" height="${GRID * 5}" patternUnits="userSpaceOnUse"><circle cx="0" cy="0" r="1.1" class="griddot"/></pattern>
    </defs>
    <g class="se-vp"><g class="se-sheet"></g><g class="se-content"></g><g class="se-simlayer"></g><g class="se-overlay"></g></g></svg>
    <div class="se-hint" hidden></div>`;
  const svg = canvas.querySelector('svg');
  const vp = svg.querySelector('.se-vp');
  const sheetG = svg.querySelector('.se-sheet');
  const contentG = svg.querySelector('.se-content');
  const overlayG = svg.querySelector('.se-overlay');
  const simG = svg.querySelector('.se-simlayer');
  const hint = canvas.querySelector('.se-hint');

  // ---------------- toolbar
  // moving components keeps their wires connected (re-routed), or detaches them
  let keepConn = true;
  try { keepConn = localStorage.getItem('xl.sch.keepConn') !== '0'; } catch { /* default */ }
  const keepBox = h('input', { type: 'checkbox', checked: keepConn });
  keepBox.addEventListener('change', () => { keepConn = keepBox.checked; try { localStorage.setItem('xl.sch.keepConn', keepConn ? '1' : '0'); } catch { /* ignore */ } });
  const btn = (act, icon, title) => h('button', { type: 'button', class: 'se-btn', 'data-act': act, title, html: ICON[icon] });
  const sep = () => h('span', { class: 'se-sep' });
  const langSel = h('select', { class: 'se-lang', title: 'HDL language for Generate / View HDL' },
    h('option', { value: 'vhdl', text: 'VHDL' }), h('option', { value: 'verilog', text: 'Verilog' }));
  const optBox = h('span', { class: 'se-opts' });
  tb.append(
    btn('select', 'select', 'Select (Esc)'), btn('wire', 'wire', 'Add Wire (W)'), btn('net', 'net', 'Add Net Name (N)'), btn('io', 'io', 'Add I/O Marker (O)'),
    sep(), btn('rotate', 'rotate', 'Rotate (Ctrl+R)'), btn('mirror', 'mirror', 'Mirror (Ctrl+M)'), btn('delete', 'del', 'Delete (Del)'),
    sep(), h('label', { class: 'se-keep', title: 'Moving components: keep the wires connected (re-routed around other parts) or detach them' },
      keepBox, h('span', { text: 'Keep connections' })),
    sep(), btn('undo', 'undo', 'Undo (Ctrl+Z)'), btn('redo', 'redo', 'Redo (Ctrl+Y)'),
    sep(), btn('zin', 'zin', 'Zoom In (+)'), btn('zout', 'zout', 'Zoom Out (−)'), btn('fit', 'fit', 'Zoom to Full View (F)'),
    sep(), btn('info', 'info', 'Symbol Info (F1)'),
    sep(), h('button', { type: 'button', class: 'se-btn wide', 'data-act': 'check', title: 'Check Schematic', html: `${ICON.check}<span>Check</span>` }),
    sep(), langSel,
    h('button', { type: 'button', class: 'se-btn wide', 'data-act': 'view', title: 'View generated HDL', html: `${ICON.view}<span>View HDL</span>` }),
    h('button', { type: 'button', class: 'se-btn wide', 'data-act': 'generate', title: 'Generate HDL source from the schematic', html: `${ICON.gen}<span>Generate HDL</span>` }),
    sep(), h('button', { type: 'button', class: 'se-btn wide', 'data-act': 'sim', title: 'Simulate: click the inputs and watch the circuit work (Esc to stop)', html: `${ICON.sim}<span>Simulate</span>` }),
    sep(), optBox,
  );
  langSel.value = genLang;
  // read-only (RTL view): the editing tools are hidden, so drop the separators they leave doubled
  if (readOnly) {
    let prevSep = true;                                   // a separator at the start is not needed
    let lastSep = null;
    for (const el of tb.children) {
      if (el.classList.contains('se-keep') || el.classList.contains('se-opts') || ['wire', 'net', 'io', 'rotate', 'mirror', 'delete', 'undo', 'redo', 'generate', 'sim'].includes(el.dataset.act)) continue;   // hidden by .read-only CSS
      if (el.classList.contains('se-sep')) { if (prevSep) el.style.display = 'none'; else { prevSep = true; lastSep = el; } }
      else { prevSep = false; lastSep = null; }
    }
    if (lastSep) lastSep.style.display = 'none';          // nor at the end
  }
  langSel.addEventListener('change', () => { genLang = langSel.value; });
  tb.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const a = b.dataset.act;
    if (a === 'sim') { if (live) leaveSim(); else enterSim(); container.focus({ preventScroll: true }); return; }
    if (a === 'info') { const t0 = infoTarget(); if (t0) openInfo(t0); return; }
    if (live && !['zin', 'zout', 'fit', 'view', 'check'].includes(a)) return;
    if (a === 'select' || a === 'wire' || a === 'net' || a === 'io') setTool(a);
    else if (a === 'rotate') rotateSel(); else if (a === 'mirror') mirrorSel(); else if (a === 'delete') deleteSel();
    else if (a === 'undo') undo(); else if (a === 'redo') redo();
    else if (a === 'zin') zoomAt(1.25); else if (a === 'zout') zoomAt(0.8); else if (a === 'fit') fit();
    else if (a === 'check') runCheck(true);
    else if (a === 'view') viewHdl();
    else if (a === 'generate') doGenerate();
    container.focus({ preventScroll: true });
  });

  // ---------------- left: symbols palette
  const search = h('input', { type: 'search', class: 'se-search', placeholder: 'Search symbols…' });
  const catSel = h('select', { class: 'se-cat' });
  const symList = h('div', { class: 'se-symlist' });
  const symInfo = h('div', { class: 'se-syminfo' });
  left.append(h('div', { class: 'se-cap', text: 'Symbols' }), h('div', { class: 'se-lefttools' }, h('label', { text: 'Categories' }), catSel, search), symList, symInfo);
  const collapsed = new Set();
  function paletteItems() {
    const items = [];
    for (const [type, S] of Object.entries(SYMBOLS)) {
      if (type === 'module') continue;
      // parameterised symbols listed under their Xilinx-style names (D2_4E, DEMUX1_4...), then the generic one
      for (const pr of S.presets || []) items.push({ type, cat: S.category, title: pr.title, desc: pr.description || S.description, params: { ...pr.params }, preset: pr.title });
      items.push({ type, cat: S.category, title: S.title, desc: S.description, params: {} });
    }
    for (const m of Object.values(modules).sort((a, b) => a.name.localeCompare(b.name))) {
      if (m.name === doc.name) continue;
      items.push({ type: 'module', cat: 'Project modules', title: m.name, desc: `${m.ports?.length || 0} ports${m.lang ? ` · ${m.lang.toUpperCase()}` : ''}${m.file ? ` · ${m.file}` : ''}`, params: { module: m.name, generics: {} } });
    }
    return items;
  }
  function previewSvg(it) {
    const sym = { id: 'pv', type: it.type, x: 0, y: 0, rot: 0, mirror: false, name: '', params: { ...defaultParams(it.type), ...it.params } };
    const def = symbolDef(sym, modules);
    const pad = 4, W = 54, H = 34;
    const sc = Math.min(1, (W - 2 * pad) / def.w, (H - 2 * pad) / def.h);
    const ox = (W - def.w * sc) / 2, oy = (H - def.h * sc) / 2;
    return `<svg class="se-pv" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><g transform="translate(${r1(ox)},${r1(oy)}) scale(${r1(sc * 100) / 100})">${bodySvg(sym, def)}</g></svg>`;
  }
  function renderPalette() {
    const q = search.value.trim().toLowerCase();
    const cat = catSel.value;
    const items = paletteItems().filter(it => (cat === '<all>' || it.cat === cat) && (!q || `${it.title} ${it.type} ${it.desc}`.toLowerCase().includes(q)));
    symList.innerHTML = '';
    const cats = [...SYMBOL_CATEGORIES];
    for (const c of cats) {
      const its = items.filter(i => i.cat === c);
      if (!its.length && !(c === 'Project modules' && cat === c)) continue;
      const open = !collapsed.has(c) || q;
      const head = h('div', { class: `se-cathead${open ? ' open' : ''}`, text: `${c} (${its.length})`, onclick: () => { if (collapsed.has(c)) collapsed.delete(c); else collapsed.add(c); renderPalette(); } });
      symList.append(head);
      if (!open) continue;
      if (!its.length) symList.append(h('div', { class: 'se-empty', text: 'No other modules in the project' }));
      for (const it of its) {
        const row = h('div', {
          class: `se-symrow${placing && placing.type === it.type && (placing.preset || null) === (it.preset || null) && (it.type !== 'module' || placing.params.module === it.params.module) ? ' active' : ''}`,
          draggable: 'true', title: it.desc,
          html: `${previewSvg(it)}<span class="nm">${esc(it.title)}</span>`,
        });
        row.addEventListener('click', () => { infoItem = it; startPlace(it); showSymInfo(it); });
        row.addEventListener('contextmenu', e => {
          e.preventDefault();
          infoItem = it; showSymInfo(it);
          popupMenu([{ label: 'Symbol Info…', shortcut: 'F1', action: () => openInfo(itemTarget(it)) }, ...(readOnly ? [] : [{ label: 'Place Symbol', action: () => startPlace(it) }])], e.clientX, e.clientY);
        });
        row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-silinx-symbol', JSON.stringify(it)); e.dataTransfer.effectAllowed = 'copy'; });
        symList.append(row);
      }
    }
  }
  // the small info box under the palette: first sentence of the datasheet + More… (Symbol Info)
  let infoItem = null;
  function itemTarget(it) { return { type: it.type, params: { ...defaultParams(it.type), ...clone(it.params || {}) }, preset: it.preset || null }; }
  function showSymInfo(it) {
    symInfo.innerHTML = '';
    if (!it) return;
    const lang = getLanguage();
    const sum = it.type === 'module' ? it.desc : symbolSummary(it.type, { ...defaultParams(it.type), ...it.params }, lang, it.preset || undefined);
    const more = h('a', { href: '#', class: 'se-more', text: 'More…', title: 'Datasheet of the symbol: pins, parameters, truth table, equivalent HDL' });
    more.addEventListener('click', e => { e.preventDefault(); openInfo(itemTarget(it)); });
    symInfo.append(h('b', { 'data-no-i18n': '', text: it.title }), ': ', h('span', { class: 'se-sum', 'data-no-i18n': '', text: sum }), ' ', more);
  }
  function renderCats() {
    const cur = catSel.value || '<all>';
    catSel.innerHTML = '';
    catSel.append(h('option', { value: '<all>', text: '<--All Symbols-->' }));
    for (const c of SYMBOL_CATEGORIES) catSel.append(h('option', { value: c, text: c }));
    catSel.value = cur;
  }
  catSel.addEventListener('change', renderPalette);
  search.addEventListener('input', renderPalette);
  renderCats();

  // ---------------- right: properties
  const propBody = h('div', { class: 'se-props' });
  right.append(h('div', { class: 'se-cap', text: 'Properties' }), propBody);

  // ---------------- view transform
  function applyView() {
    vp.setAttribute('transform', `translate(${r1(view.tx)},${r1(view.ty)}) scale(${view.s})`);
    canvas.classList.toggle('se-lod', view.s < 0.45);
    updateStatus();
  }
  const toSheet = (cx, cy) => { const r = svg.getBoundingClientRect(); return { x: (cx - r.left - view.tx) / view.s, y: (cy - r.top - view.ty) / view.s }; };
  function zoomAt(f, cx, cy) {
    const r = svg.getBoundingClientRect();
    if (cx == null) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    const ns = Math.max(0.08, Math.min(6, view.s * f));
    const k = ns / view.s;
    const px = cx - r.left, py = cy - r.top;
    view.tx = px - (px - view.tx) * k; view.ty = py - (py - view.ty) * k; view.s = ns;
    applyView();
  }
  function contentBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = b => { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + (b.w || 0)); y1 = Math.max(y1, b.y + (b.h || 0)); };
    for (const s of doc.symbols) { const b = symbolBox(s, modules); add({ ...b, y: b.y - 14, h: b.h + 14 }); }
    for (const p of doc.ports) add(portBox(p));
    for (const w of doc.wires) for (const p of w.points) add(p);
    for (const l of doc.labels) add({ x: l.x, y: l.y - 12, w: 8 * l.net.length, h: 12 });
    if (!Number.isFinite(x0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** Print dialog for the whole schematic (selection and editing overlays left out). */
  function print(title = 'Schematic') {
    const b = contentBounds();
    if (!b) return;
    const saved = sel;
    sel = new Set();
    render();
    let snap;
    try { snap = svgSnapshot(svg, vp, { l: b.x - 30, t: b.y - 30, r: b.x + b.w + 30, b: b.y + b.h + 30 }, ['.se-sheet', '.se-overlay > *', 'defs pattern']); } finally { sel = saved; render(); }
    printDiagram({ title, snapshot: snap, filename: title.replace(/[^\w.-]+/g, '_') });
  }
  function fit() {
    const r = svg.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const b = contentBounds() || { x: 0, y: 0, w: doc.sheet.w, h: doc.sheet.h };
    const pad = 40;
    const s = Math.max(0.08, Math.min(2, (r.width - 2 * pad) / Math.max(1, b.w), (r.height - 2 * pad) / Math.max(1, b.h)));
    view.s = s;
    view.tx = (r.width - b.w * s) / 2 - b.x * s;
    view.ty = (r.height - b.h * s) / 2 - b.y * s;
    applyView();
  }
  function centerOn(x, y) {
    const r = svg.getBoundingClientRect();
    if (view.s < 0.8) view.s = 1;
    view.tx = r.width / 2 - x * view.s; view.ty = r.height / 2 - y * view.s;
    applyView();
  }

  // ---------------- rendering
  function refreshNetlist() { try { nl = netlist(doc, { modules }); } catch (e) { console.error(e); nl = null; } }
  function renderSheet() {
    const W = doc.sheet.w, H = doc.sheet.h;
    const tbw = 300, tbh = 60;
    sheetG.innerHTML = `<rect class="sheet" x="0" y="0" width="${W}" height="${H}"/>`
      + `<rect class="gridfill" x="0" y="0" width="${W}" height="${H}" fill="url(#se-grid-${uidE})"/>`
      + `<rect class="gridfill2" x="0" y="0" width="${W}" height="${H}" fill="url(#se-grid2-${uidE})"/>`
      + `<rect class="frame" x="10" y="10" width="${W - 20}" height="${H - 20}"/>`
      + `<g class="titleblock"><rect x="${W - 10 - tbw}" y="${H - 10 - tbh}" width="${tbw}" height="${tbh}"/>`
      + `<line x1="${W - 10 - tbw}" y1="${H - 10 - tbh / 2}" x2="${W - 10}" y2="${H - 10 - tbh / 2}"/>`
      + `<text x="${W - tbw}" y="${H - 10 - tbh / 2 - 9}" class="tb-l">SHEET</text><text x="${W - tbw + 50}" y="${H - 10 - tbh / 2 - 9}" class="tb-v">${esc(doc.name)}</text>`
      + `<text x="${W - tbw}" y="${H - 19}" class="tb-l">LANGUAGE</text><text x="${W - tbw + 70}" y="${H - 19}" class="tb-v">${doc.lang.toUpperCase()}</text>`
      + `<text x="${W - 20}" y="${H - 19}" class="tb-l" text-anchor="end">Silinx</text></g>`
      // the sheet description (Schematic Wizard / sheet properties), top left
      + (String(doc.description || '').trim() ? `<text class="se-desc" x="30" y="40">${String(doc.description).trim().split(/\r?\n/).map((l, i) => `<tspan x="30" dy="${i ? 16 : 0}">${esc(l)}</tspan>`).join('')}</text>` : '');
  }
  function render() {
    if (destroyed) return;
    refreshNetlist();
    renderSheet();
    const parts = [];
    const busW = new Map();
    if (nl) for (const [wid, n] of nl.wireNet) busW.set(wid, n.width);
    // wires
    for (const w of doc.wires) {
      const pts = w.points.map(p => `${p.x},${p.y}`).join(' ');
      const bus = w.bus || (busW.get(w.id) || 1) > 1;
      const cls = `wire${bus ? ' bus' : ''}${sel.has(`wire:${w.id}`) ? ' sel' : ''}`;
      parts.push(`<g class="${cls}" data-kind="wire" data-id="${esc(w.id)}"><polyline class="whit" points="${pts}"/><polyline class="wline" points="${pts}"/></g>`);
    }
    if (nl) for (const j of nl.junctions) parts.push(`<circle class="junction" cx="${j.x}" cy="${j.y}" r="3.2"/>`);
    // symbols
    for (const s of doc.symbols) {
      let def;
      try { def = symbolDef(s, modules); } catch { continue; }
      parts.push(symbolSvg(s, def, sel.has(`sym:${s.id}`) ? ' sel' : ''));
    }
    for (const p of doc.ports) parts.push(portSvg(p, sel.has(`port:${p.id}`) ? ' sel' : ''));
    for (const l of doc.labels) {
      const n = nl?.labelNet.get(l.id);
      const bus = n && n.width > 1 && !parseNetName(l.net).width ? `(${n.width - 1}:0)` : '';
      parts.push(`<g class="label${sel.has(`label:${l.id}`) ? ' sel' : ''}" data-kind="label" data-id="${esc(l.id)}"><text x="${l.x + 2}" y="${l.y - 4}">${esc(l.net)}${bus}</text><rect class="hitbox" x="${l.x}" y="${l.y - 14}" width="${Math.max(16, (l.net.length + bus.length) * 6.5 + 4)}" height="14"/><circle class="lpt" cx="${l.x}" cy="${l.y}" r="1.6"/></g>`);
    }
    // unconnected pin markers
    if (nl) {
      for (const s of doc.symbols) {
        for (const p of symbolPins(s, modules)) {
          const n = nl.pinNet.get(`${s.id}/${p.name}`);
          if (!n || (n.endpoints.length + n.wires.length + n.labels.length) <= 1) parts.push(`<rect class="nc" x="${p.x - 2.5}" y="${p.y - 2.5}" width="5" height="5"/>`);
        }
      }
    }
    contentG.innerHTML = parts.join('');
    renderOverlay();
    updateToolbar();
    updateStatus();
    if (live) live.update(true);
  }
  function renderOverlay() {
    let s = '';
    if (tool === 'place' && placing) {
      const g = { id: 'ghost', type: placing.type, x: 0, y: 0, rot: placing.rot, mirror: placing.mirror, name: '', params: placing.params };
      const def = symbolDef(g, modules);
      const sz = rotSize(g, def);
      g.x = snap(cursor.x - sz.w / 2); g.y = snap(cursor.y - sz.h / 2);
      s += `<g class="ghost">${symbolSvg(g, def)}</g>`;
    }
    if (tool === 'wire' && wireDraw) {
      const pts = [...wireDraw.pts, ...routeTo(wireDraw.pts[wireDraw.pts.length - 1], snapPoint(cursor), wireDraw)];
      s += `<polyline class="wire-preview" points="${pts.map(p => `${p.x},${p.y}`).join(' ')}"/>`;
    }
    if ((tool === 'wire' || tool === 'io' || tool === 'net') && hoverPin) s += `<rect class="pinhover" x="${hoverPin.x - 4}" y="${hoverPin.y - 4}" width="8" height="8"/>`;
    if (tool === 'wire' || tool === 'io') { const c = snapPoint(cursor); s += `<path class="xhair" d="M${c.x - 6},${c.y} H${c.x + 6} M${c.x},${c.y - 6} V${c.y + 6}"/>`; }
    if (drag && drag.kind === 'band') {
      const r = bandRect();
      s += `<rect class="band" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`;
    }
    overlayG.innerHTML = s;
  }
  function updateToolbar() {
    tb.querySelectorAll('[data-act]').forEach(b => b.classList.toggle('on', live ? b.dataset.act === 'sim' : b.dataset.act === tool));
    tb.querySelector('[data-act="undo"]').disabled = !undoStack.length;
    tb.querySelector('[data-act="redo"]').disabled = !redoStack.length;
    const any = sel.size > 0;
    tb.querySelector('[data-act="delete"]').disabled = !any;
    const symSel = [...sel].some(k => k.startsWith('sym:')) || (tool === 'place');
    tb.querySelector('[data-act="rotate"]').disabled = !symSel;
    tb.querySelector('[data-act="mirror"]').disabled = !symSel;
    tb.querySelector('[data-act="info"]').disabled = !infoTarget();
  }
  const TOOL_HINT = {
    select: 'Click to select, drag to move (connected wires follow), drag on empty space to select a region. Double-click a module to open it.',
    wire: 'Add Wire: click to start, click to add a bend, click on a pin/wire or double-click to finish. Esc ends the wire.',
    net: 'Add Net Name: type a name, then click a wire to attach it.',
    io: 'Add I/O Marker: click a wire end or a pin to add a port marker.',
    place: 'Click to place the symbol (Ctrl+R rotate, Ctrl+M mirror). Esc to stop placing.',
  };
  function updateStatus() {
    const n = doc.symbols.length;
    const tip = live ? 'Live simulation: click the inputs (switches, bus values, clocks), hover a wire or pin to see its value, drag to pan. Esc stops the simulation.' : readOnly ? 'Read-only view. Drag on empty space to select, double-click a module to open it, wheel to zoom.' : (TOOL_HINT[tool] || '');
    const d = lastDiags ? ` · ${lastDiags.filter(x => x.severity === 'error').length} error(s), ${lastDiags.filter(x => x.severity === 'warning').length} warning(s)` : '';
    status.innerHTML = `<span class="hint">${esc(tip)}</span><span class="sp"></span><span>${n} symbol${n === 1 ? '' : 's'}, ${nl ? nl.nets.length : 0} nets${d}</span><span class="xy">X ${snap(cursor.x)} Y ${snap(cursor.y)}</span><span class="zoom">${Math.round(view.s * 100)}%</span>`;
  }

  // ---------------- properties panel
  function field(label, input, note) { return h('div', { class: 'se-field' }, h('label', { text: label }), input, note ? h('div', { class: 'se-note', text: note }) : null); }
  // the single selected module instance (RTL view: "push into"), or null
  function selectedModuleSym() {
    const ids = [...sel].filter(k => k.startsWith('sym:'));
    if (ids.length !== 1 || sel.size !== 1) return null;
    const s = doc.symbols.find(x => x.id === ids[0].slice(4));
    return s && s.type === 'module' ? s : null;
  }
  function openSelected() {
    const s = selectedModuleSym();
    if (s && opts.onOpenModule) opts.onOpenModule(s.params.module, { instance: s.name, symbol: clone(s) });
    return !!s;
  }
  function renderProps() {
    if (live) { live.renderProps(propBody); return; }
    renderPropsInner();
    opts.onSelect?.(selectedModuleSym());
    if (readOnly) propBody.querySelectorAll('input, textarea, select, button').forEach(el => { if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) el.readOnly = true; else if (!el.classList.contains('ro-ok')) el.disabled = true; });
  }
  function renderPropsInner() {
    propBody.innerHTML = '';
    const items = [...sel];
    if (items.length === 0) return sheetProps();
    if (items.length > 1) {
      propBody.append(h('div', { class: 'se-ptitle', text: `${items.length} objects selected` }),
        h('div', { class: 'se-pbtns' }, h('button', { class: 'btn', type: 'button', text: 'Rotate', onclick: rotateSel }), h('button', { class: 'btn', type: 'button', text: 'Mirror', onclick: mirrorSel }), h('button', { class: 'btn', type: 'button', text: 'Delete', onclick: deleteSel })));
      return;
    }
    const [kind, id] = items[0].split(/:(.*)/s);
    const obj = doc[KEYS[kind]].find(o => o.id === id);
    if (!obj) return;
    if (kind === 'sym') symProps(obj);
    else if (kind === 'port') portProps(obj);
    else if (kind === 'label') labelProps(obj);
    else if (kind === 'wire') wireProps(obj);
  }
  // text input bound to a setter (commits on change)
  // a property applied with Enter keeps the keyboard in the (redrawn) field
  function keepFocus(el, apply) {
    const fields = () => [...propBody.querySelectorAll('input, textarea, select')];
    const kept = document.activeElement === el, idx = fields().indexOf(el);
    apply();
    if (kept && idx >= 0) setTimeout(() => { const f = fields()[idx]; if (f) { f.focus(); f.select?.(); } }, 0);
  }
  function inp(value, set, attrs = {}) {
    const el = h('input', { type: 'text', value: value ?? '', ...attrs });
    el.addEventListener('change', () => keepFocus(el, () => edit(() => set(el.type === 'number' ? Number(el.value) : el.value))));
    return el;
  }
  function chk(value, set) { const el = h('input', { type: 'checkbox', checked: !!value }); el.addEventListener('change', () => edit(() => set(el.checked))); return el; }
  function selBox(value, options, set) {
    const el = h('select', {}, ...options.map(o => h('option', { value: Array.isArray(o) ? o[0] : o, text: Array.isArray(o) ? o[1] : o })));
    el.value = value; el.addEventListener('change', () => edit(() => set(el.value))); return el;
  }
  function sheetProps() {
    propBody.append(h('div', { class: 'se-ptitle', text: 'Schematic sheet' }));
    propBody.append(field('Module name', inp(doc.name, v => { doc.name = String(v).trim() || 'schematic'; })));
    propBody.append(field('Language', selBox(doc.lang, [['vhdl', 'VHDL'], ['verilog', 'Verilog']], v => { doc.lang = v; genLang = v; langSel.value = v; })));
    propBody.append(field('Description', ta(doc.description || '', v => { if (String(v).trim()) doc.description = v; else delete doc.description; }, 2), 'shown on the sheet and as a comment in the HDL'));
    propBody.append(field('Sheet size', h('div', { class: 'se-row' },
      inp(doc.sheet.w, v => { doc.sheet.w = Math.max(400, +v || 1700); }, { type: 'number', step: 100 }),
      h('span', { text: '×' }), inp(doc.sheet.h, v => { doc.sheet.h = Math.max(300, +v || 1100); }, { type: 'number', step: 100 }))));
    const hd = doc.hdl || {};
    const sec = h('details', { class: 'se-sec', open: !!(hd.decls || hd.generics?.length) });
    sec.append(h('summary', { text: `HDL kept with the schematic${hd.lang ? ` (${hd.lang.toUpperCase()})` : ''}` }));
    const ensure = () => { doc.hdl ||= { lang: doc.lang, context: '', generics: [], decls: '', arch: '' }; return doc.hdl; };
    sec.append(field(hd.lang === 'verilog' ? 'Compiler directives' : 'Context clause', ta(hd.context || '', v => { ensure().context = v; }, 3)));
    sec.append(field(hd.lang === 'verilog' ? 'Parameters' : 'Generics', ta((hd.generics || []).map(g => `${g.name}${g.type ? ` : ${g.type}` : ''}${g.default ? ` := ${g.default}` : ''}`).join('\n'), v => {
      ensure().generics = v.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = /^([A-Za-z_]\w*)\s*(?::\s*([^:=]+?))?\s*(?::?=\s*(.+))?$/.exec(l); return m ? { name: m[1], type: (m[2] || '').trim(), default: (m[3] || '').trim() } : null; }).filter(Boolean);
    }, 2), 'one per line: NAME : type := default'));
    sec.append(field('Declarations', ta(hd.decls || '', v => { ensure().decls = v; }, 6), 'signals, types, constants, functions emitted verbatim'));
    if (doc.lang === 'vhdl') sec.append(field('Architecture name', inp(hd.arch || '', v => { ensure().arch = String(v).trim(); }, { placeholder: 'schematic' })));
    propBody.append(sec);
    propBody.append(h('div', { class: 'se-note', text: 'Tip: drag symbols from the Symbols panel; double-click a module symbol to open its source.' }));
  }
  function ta(value, set, rows = 4) {
    const el = h('textarea', { rows, spellcheck: 'false' });
    el.value = value;
    el.addEventListener('change', () => keepFocus(el, () => edit(() => set(el.value))));
    return el;
  }
  function symProps(s) {
    const S = SYMBOLS[s.type];
    const sd = symbolDef(s, modules);
    const title = s.type === 'module' ? `Module ${s.params.module}` : (sd.shape === 'lib' || sd.shape === 'demux' || sd.shape === 'tbuf') ? `${sd.title} (${S.title})` : `${S?.title || s.type}`;
    const sum = s.type === 'module' ? (S?.description || '') : symbolSummary(s.type, s.params, getLanguage());
    propBody.append(h('div', { class: 'se-ptitle', text: title }), h('div', { class: 'se-note se-sum', 'data-no-i18n': '', text: sum }),
      h('div', { class: 'se-pbtns' }, h('button', { class: 'btn ro-ok se-infobtn', type: 'button', text: 'Symbol Info…', title: 'Symbol Info (F1)', onclick: () => openInfo(infoTarget()) })));
    propBody.append(field('Instance name', inp(s.name, v => { s.name = String(v).trim() || s.name; })));
    for (const p of S?.params || []) {
      const v = s.params[p.name];
      let el;
      if (p.kind === 'bool') el = chk(v, x => { s.params[p.name] = x; });
      else if (p.kind === 'select') el = selBox(String(v), p.options, x => { s.params[p.name] = x; });
      else if (p.kind === 'int') el = inp(v, x => { s.params[p.name] = Math.max(p.min ?? 0, Math.min(p.max ?? 1e6, Math.round(+x || p.default))); }, { type: 'number', min: p.min, max: p.max });
      else el = inp(v, x => { s.params[p.name] = String(x).trim(); });
      propBody.append(field(p.label, el));
    }
    if (s.type === 'module') {
      const names = Object.keys(modules).sort();
      const modOpts = names.includes(s.params.module) ? names : [s.params.module, ...names];
      propBody.append(field('Module', selBox(s.params.module, modOpts, x => { s.params.module = x; s.params.generics = {}; delete s.params.ports; })));
      const m = modules[s.params.module];
      const gens = m?.generics || Object.keys(s.params.generics || {}).map(k => ({ name: k, default: '' }));
      if (gens.length) {
        const box = h('div', { class: 'se-gens' });
        for (const g of gens) box.append(h('div', { class: 'se-row' }, h('span', { class: 'gn', text: g.name }), inp(s.params.generics?.[g.name] ?? '', x => { s.params.generics ||= {}; if (String(x).trim()) s.params.generics[g.name] = String(x).trim(); else delete s.params.generics[g.name]; }, { placeholder: g.default || '' })));
        propBody.append(field(m?.lang === 'verilog' || doc.lang === 'verilog' ? 'Parameters' : 'Generics', box, 'empty = module default'));
      }
      if (opts.onOpenModule) propBody.append(h('div', { class: 'se-pbtns' }, h('button', { class: 'btn ro-ok', type: 'button', text: readOnly ? 'Open this instance' : 'Open module source', onclick: () => opts.onOpenModule(s.params.module, { instance: s.name, symbol: clone(s) }) })));
    }
    if (s.type === 'hdlblock') {
      propBody.append(field('Title', inp(s.params.title || '', x => { s.params.title = String(x); })));
      const pinsTa = (list, out) => ta((list || []).map(q => `${q.name}${q.width > 1 ? `[${q.width}]` : ''}${q.clock ? ' clock' : ''}${q.reg ? ' reg' : ''}`).join('\n'), v => {
        s.params[out ? 'outputs' : 'inputs'] = v.split(/[\n,]/).map(l => l.trim()).filter(Boolean).map(l => {
          const m = /^([A-Za-z_][\w$]*)\s*(?:\[\s*(\d+)\s*\])?\s*(.*)$/.exec(l);
          if (!m) return null;
          const q = { name: m[1], width: Math.max(1, +(m[2] || 1)) };
          if (/\bclock\b/.test(m[3])) q.clock = true;
          if (/\breg\b/.test(m[3])) q.reg = true;
          return q;
        }).filter(Boolean);
      }, 3);
      propBody.append(field('Input pins', pinsTa(s.params.inputs, false), 'one per line: name[width] (add "clock" for a clock pin)'));
      propBody.append(field('Output pins', pinsTa(s.params.outputs, true), doc.lang === 'verilog' ? 'name[width], add "reg" if assigned in always/initial' : 'name[width]'));
      const code = ta(s.hdl || '', v => { s.hdl = v; }, 12);
      code.classList.add('code');
      propBody.append(field(`${(doc.hdl?.lang || doc.lang).toUpperCase()} statements (emitted verbatim)`, code));
      code.addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); const p = code.selectionStart; code.setRangeText('  ', p, code.selectionEnd, 'end'); } });
    }
    const nets = symbolPins(s, modules).map(p => `${p.name} → ${nl?.pinNet.get(`${s.id}/${p.name}`)?.name ?? '(unconnected)'}`);
    if (nets.length) propBody.append(h('details', { class: 'se-sec' }, h('summary', { text: `Pins (${nets.length})` }), h('pre', { class: 'se-pins', text: nets.join('\n') })));
  }
  function portProps(p) {
    propBody.append(h('div', { class: 'se-ptitle', text: 'I/O Marker' }));
    propBody.append(field('Name', inp(p.name, v => { p.name = String(v).trim() || p.name; })));
    propBody.append(field('Direction', selBox(p.dir, [['in', 'Input'], ['out', 'Output'], ['inout', 'Bidirectional']], v => { p.dir = v; })));
    propBody.append(field('Width', inp(p.width, v => { p.width = Math.max(1, Math.round(+v || 1)); if (p.type && !/\(|\[/.test(p.type) && p.width > 1) delete p.type; }, { type: 'number', min: 1 })));
    propBody.append(field('HDL type', inp(p.type || '', v => { if (String(v).trim()) p.type = String(v).trim(); else delete p.type; }, { placeholder: doc.lang === 'vhdl' ? (p.width > 1 ? `std_logic_vector(${p.width - 1} downto 0)` : 'std_logic') : (p.width > 1 ? `[${p.width - 1}:0]` : '') }), 'optional, overrides the type derived from the width'));
  }
  function labelProps(l) {
    propBody.append(h('div', { class: 'se-ptitle', text: 'Net Name' }));
    propBody.append(field('Name', inp(l.net, v => { if (String(v).trim()) l.net = String(v).trim(); }), 'ISE style bus names are accepted: data(7:0)'));
    netInfo(nl?.labelNet.get(l.id));
  }
  function wireProps(w) {
    const n = nl?.wireNet.get(w.id);
    propBody.append(h('div', { class: 'se-ptitle', text: `Wire${n ? ` · net ${n.name}` : ''}` }));
    propBody.append(field('Draw as bus', chk(w.bus, v => { if (v) w.bus = true; else delete w.bus; })));
    if (n) propBody.append(field('Rename net', inp(n.auto ? '' : n.name, v => {
      const name = String(v).trim(); if (!name) return;
      const p0 = w.points[0], p1 = w.points[1];
      const mid = { x: snap((p0.x + p1.x) / 2), y: snap((p0.y + p1.y) / 2) };
      const ex = doc.labels.find(l => nl.labelNet.get(l.id) === n);
      if (ex) ex.net = name; else doc.labels.push({ id: nextId('L', doc.labels), x: p0.x === p1.x ? p0.x : mid.x, y: p0.y === p1.y ? p0.y : mid.y, net: name });
    }, { placeholder: n.name })));
    netInfo(n);
  }
  function netInfo(n) {
    if (!n) return;
    const eps = n.endpoints.map(e => (e.kind === 'pin' ? `${doc.symbols.find(s => s.id === e.sym)?.name}.${e.pin} (${e.dir})` : `I/O ${doc.ports.find(p => p.id === e.port)?.name}`));
    propBody.append(h('div', { class: 'se-note', text: `Net '${n.name}', ${n.width} bit${n.width > 1 ? 's' : ''}` }), h('pre', { class: 'se-pins', text: eps.join('\n') || '(no connections)' }));
  }

  // ---------------- edits, undo, change notification
  const snapshot = () => JSON.stringify(doc);
  function edit(fn, { keepProps = false } = {}) {
    if (readOnly || live) return;
    const before = snapshot();
    fn();
    doc = normalizeDoc(doc);
    if (snapshot() !== before) { pushUndo(before); changed(); }
    render();
    if (!keepProps) renderProps();
  }
  function pushUndo(before) { undoStack.push(before); if (undoStack.length > 300) undoStack.shift(); redoStack.length = 0; }
  function changed() {
    lastDiags = null;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { if (!destroyed) opts.onChange?.(clone(doc)); }, 300);
  }
  function undo() {
    if (!undoStack.length || live) return;
    redoStack.push(snapshot());
    doc = normalizeDoc(JSON.parse(undoStack.pop()));
    pruneSel(); changed(); render(); renderProps();
  }
  function redo() {
    if (!redoStack.length || live) return;
    undoStack.push(snapshot());
    doc = normalizeDoc(JSON.parse(redoStack.pop()));
    pruneSel(); changed(); render(); renderProps();
  }
  function pruneSel() { for (const k of [...sel]) { const [kind, id] = k.split(/:(.*)/s); if (!doc[KEYS[kind]]?.some(o => o.id === id)) sel.delete(k); } }
  function nextId(prefix, arr) { let n = 0; for (const o of arr) { const m = new RegExp(`^${prefix}(\\d+)$`).exec(o.id); if (m) n = Math.max(n, +m[1]); } return `${prefix}${n + 1}`; }
  function nextInstName() {
    const used = new Set(doc.symbols.map(s => s.name));
    let n = 0; for (const s of doc.symbols) { const m = /^XLXI_(\d+)$/.exec(s.name); if (m) n = Math.max(n, +m[1]); }
    let nm; do nm = `XLXI_${++n}`; while (used.has(nm)); return nm;
  }

  // ---------------- tools
  function setTool(t) {
    if (readOnly && t !== 'select') return;
    if (wireDraw) finishWire();
    tool = t;
    if (t !== 'place') placing = null;
    canvas.dataset.tool = t;
    renderOpts();
    renderOverlay(); updateToolbar(); updateStatus();
    if (t !== 'place') renderPalette();
  }
  const netNameInput = h('input', { type: 'text', class: 'se-optin', placeholder: 'net name' });
  const ioNameInput = h('input', { type: 'text', class: 'se-optin', placeholder: 'auto' });
  const ioDirSel = h('select', { class: 'se-optin' }, h('option', { value: 'auto', text: 'Auto direction' }), h('option', { value: 'in', text: 'Input' }), h('option', { value: 'out', text: 'Output' }), h('option', { value: 'inout', text: 'Bidirectional' }));
  function renderOpts() {
    optBox.innerHTML = '';
    if (tool === 'net') optBox.append(h('label', { text: 'Name:' }), netNameInput);
    else if (tool === 'io') optBox.append(h('label', { text: 'Name:' }), ioNameInput, ioDirSel);
    else if (tool === 'place' && placing) optBox.append(h('span', { class: 'se-placing', text: `Placing ${placing.type === 'module' ? placing.params.module : (placing.preset || SYMBOLS[placing.type]?.title || placing.type)}` }));
  }
  function startPlace(it) {
    if (wireDraw) finishWire();
    placing = { type: it.type, params: { ...defaultParams(it.type), ...clone(it.params || {}) }, rot: 0, mirror: false, preset: it.preset || null };
    if (it.type === 'module') {
      const m = modules[it.params.module];
      if (m) placing.params.ports = m.ports.map(p => ({ name: p.name, dir: p.dir, width: p.width }));
    }
    tool = 'place';
    canvas.dataset.tool = 'place';
    sel.clear();
    renderOpts(); renderPalette(); render(); renderProps();
    container.focus({ preventScroll: true });
  }
  function placeAt(pt, src = placing) {
    if (!src) return;
    edit(() => {
      const s = { id: nextId('S', doc.symbols), type: src.type, x: 0, y: 0, rot: src.rot || 0, mirror: !!src.mirror, name: nextInstName(), params: clone(src.params) };
      const def = symbolDef(s, modules);
      const sz = rotSize(s, def);
      s.x = snap(pt.x - sz.w / 2); s.y = snap(pt.y - sz.h / 2);
      doc.symbols.push(s);
      if (tool !== 'place') { sel.clear(); sel.add(`sym:${s.id}`); }
    });
    // keep the keyboard on the editor (Esc, Ctrl+R / Ctrl+M while placing)
    setTimeout(() => { if (!destroyed && container.isConnected) container.focus({ preventScroll: true }); }, 0);
  }

  // all connectable points (pins, I/O markers, wire vertices)
  function connPoints() {
    const pts = [];
    for (const s of doc.symbols) for (const p of symbolPins(s, modules)) pts.push({ x: p.x, y: p.y, pin: p, sym: s });
    for (const p of doc.ports) pts.push({ x: p.x, y: p.y, port: p });
    return pts;
  }
  function pinNear(pt, tol = 7 / Math.max(0.3, view.s)) {
    let best = null, bd = tol;
    for (const c of connPoints()) { const d = Math.hypot(c.x - pt.x, c.y - pt.y); if (d <= bd) { bd = d; best = c; } }
    return best;
  }
  function wireNear(pt, tol = 5 / Math.max(0.3, view.s)) {
    for (const w of doc.wires) for (let i = 0; i + 1 < w.points.length; i++) if (segDist(pt, w.points[i], w.points[i + 1]) <= tol) return { w, i };
    return null;
  }
  function snapPoint(pt) { const p = hoverPin || null; return p ? { x: p.x, y: p.y } : { x: snap(pt.x), y: snap(pt.y) }; }
  // orthogonal route from a to b
  function routeTo(a, b, wd) {
    if (a.x === b.x || a.y === b.y) return [b];
    let first = 'h';
    const pts = wd.pts;
    if (pts.length >= 2) { const p = pts[pts.length - 2]; first = p.y === a.y ? 'v' : 'h'; }
    else if (wd.startSide) first = wd.startSide === 'N' || wd.startSide === 'S' ? 'v' : 'h';
    else first = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'h' : 'v';
    return first === 'h' ? [{ x: b.x, y: a.y }, b] : [{ x: a.x, y: b.y }, b];
  }
  function finishWire() {
    if (!wireDraw) return;
    const pts = cleanPts(wireDraw.pts);
    wireDraw = null;
    if (pts.length >= 2) edit(() => { doc.wires.push({ id: nextId('W', doc.wires), points: pts }); }, { keepProps: true });
    else renderOverlay();
  }
  function wireClick(pt, dbl) {
    const p = snapPoint(pt);
    if (!wireDraw) {
      const near = pinNear(pt);
      wireDraw = { pts: [p], startSide: near?.pin?.side || (near?.port ? (near.port.dir === 'in' ? 'E' : 'W') : null) };
      renderOverlay();
      return;
    }
    const last = wireDraw.pts[wireDraw.pts.length - 1];
    if (dbl) { finishWire(); return; }
    if (last.x === p.x && last.y === p.y) return;
    wireDraw.pts.push(...routeTo(last, p, wireDraw));
    // end on a pin / marker / another wire
    const onPin = pinNear(pt);
    const onWire = doc.wires.some(w => w.points.some((q, i) => i + 1 < w.points.length && onSeg(p, q, w.points[i + 1])));
    if (onPin || onWire) finishWire(); else renderOverlay();
  }
  async function netClick(pt) {
    const hit = wireNear(pt);
    if (!hit) { flash('Click on a wire to attach the net name'); return; }
    const a = hit.w.points[hit.i], b = hit.w.points[hit.i + 1];
    const at = a.x === b.x ? { x: a.x, y: Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), snap(pt.y))) } : { x: Math.max(Math.min(a.x, b.x), Math.min(Math.max(a.x, b.x), snap(pt.x))), y: a.y };
    let name = netNameInput.value.trim();
    if (!name) name = await promptBox(pt, 'Net name', nl?.wireNet.get(hit.w.id)?.auto ? '' : (nl?.wireNet.get(hit.w.id)?.name || ''));
    if (!name) return;
    const pn = parseNetName(name);
    if (pn.bad) { flash(`Invalid net name '${name}'`); return; }
    edit(() => {
      const n = nl?.wireNet.get(hit.w.id);
      const ex = n && doc.labels.find(l => nl.labelNet.get(l.id) === n && Math.hypot(l.x - at.x, l.y - at.y) < 1);
      if (ex) ex.net = name; else doc.labels.push({ id: nextId('L', doc.labels), x: at.x, y: at.y, net: name });
    }, { keepProps: true });
    // auto increment trailing numbers (d0 -> d1)
    if (netNameInput.value.trim()) { const m = /^(.*?)(\d+)(\)?)$/.exec(name); if (m) netNameInput.value = `${m[1]}${+m[2] + 1}${m[3]}`; }
  }
  async function ioClick(pt) {
    const near = pinNear(pt);
    const p = near ? { x: near.x, y: near.y } : { x: snap(pt.x), y: snap(pt.y) };
    if (near?.port) { flash('There is already an I/O marker here'); return; }
    let dir = ioDirSel.value, width = 1, suggest = '';
    const net = near?.pin ? nl?.pinNet.get(`${near.sym.id}/${near.pin.name}`) : nl?.wireNet.get(wireNear(p, 0.5)?.w.id);
    if (near?.pin) { width = near.pin.width || net?.width || 1; if (dir === 'auto') dir = near.pin.dir === 'out' ? 'out' : near.pin.dir === 'inout' ? 'inout' : 'in'; }
    else if (net) { width = net.width; if (dir === 'auto') dir = net.drivers.length ? 'out' : 'in'; }
    else if (!wireNear(p, 0.5)) { flash('Click on a wire end or a pin'); return; }
    if (dir === 'auto') dir = 'in';
    const taken = new Set(doc.ports.map(q => q.name.toLowerCase()));
    if (net && !net.auto && !net.ports.length && !taken.has(net.name.toLowerCase())) suggest = net.name;
    let name = ioNameInput.value.trim();
    if (!name || taken.has(name.toLowerCase())) name = await promptBox(pt, `${dir === 'in' ? 'Input' : dir === 'out' ? 'Output' : 'Bidirectional'} port name`, name || suggest);
    if (!name) return;
    if (taken.has(name.toLowerCase())) { flash(`An I/O marker named '${name}' already exists`); return; }
    edit(() => { doc.ports.push({ id: nextId('P', doc.ports), name, dir, width, x: p.x, y: p.y }); }, { keepProps: true });
    if (ioNameInput.value.trim()) { const m = /^(.*?)(\d+)$/.exec(name); ioNameInput.value = m ? `${m[1]}${+m[2] + 1}` : ''; }
  }

  // ---------------- selection operations
  function selected(kind) { return [...sel].filter(k => k.startsWith(kind + ':')).map(k => k.slice(kind.length + 1)); }
  function rotateSel() {
    if (tool === 'place' && placing) { placing.rot = (placing.rot + 90) % 360; renderOverlay(); return; }
    const ids = selected('sym');
    if (!ids.length) return;
    edit(() => {
      for (const id of ids) {
        const s = doc.symbols.find(x => x.id === id);
        const def = symbolDef(s, modules);
        const a = rotSize(s, def);
        const cx = s.x + a.w / 2, cy = s.y + a.h / 2;
        s.rot = (s.rot + 90) % 360;
        const b = rotSize(s, def);
        s.x = snap(cx - b.w / 2); s.y = snap(cy - b.h / 2);
      }
    });
  }
  function mirrorSel() {
    if (tool === 'place' && placing) { placing.mirror = !placing.mirror; renderOverlay(); return; }
    const ids = selected('sym');
    if (!ids.length) return;
    edit(() => { for (const id of ids) { const s = doc.symbols.find(x => x.id === id); s.mirror = !s.mirror; } });
  }
  function deleteSel() {
    if (!sel.size) return;
    edit(() => {
      for (const [kind, arr] of Object.entries(KEYS)) { const ids = new Set(selected(kind)); doc[arr] = doc[arr].filter(o => !ids.has(o.id)); }
      sel.clear();
    });
  }
  function copySel(cut = false) {
    if (!sel.size) return;
    clipboard = { symbols: [], wires: [], ports: [], labels: [] };
    for (const [kind, arr] of Object.entries(KEYS)) { const ids = new Set(selected(kind)); clipboard[arr] = clone(doc[arr].filter(o => ids.has(o.id))); }
    clipboard.n = 0;
    if (cut) deleteSel();
  }
  function paste() {
    if (!clipboard) return;
    clipboard.n++;
    const d = 40 * clipboard.n;
    edit(() => {
      sel.clear();
      const usedNames = new Set(doc.symbols.map(s => s.name));
      for (const s0 of clipboard.symbols) {
        const s = clone(s0); s.id = nextId('S', doc.symbols); s.x += d; s.y += d;
        if (usedNames.has(s.name)) s.name = nextInstName();
        usedNames.add(s.name); doc.symbols.push(s); sel.add(`sym:${s.id}`);
      }
      for (const w0 of clipboard.wires) { const w = clone(w0); w.id = nextId('W', doc.wires); w.points.forEach(p => { p.x += d; p.y += d; }); doc.wires.push(w); sel.add(`wire:${w.id}`); }
      const pn = new Set(doc.ports.map(p => p.name));
      for (const p0 of clipboard.ports) { const p = clone(p0); p.id = nextId('P', doc.ports); p.x += d; p.y += d; let k = 1; const base = p.name; while (pn.has(p.name)) p.name = `${base}_${k++}`; pn.add(p.name); doc.ports.push(p); sel.add(`port:${p.id}`); }
      for (const l0 of clipboard.labels) { const l = clone(l0); l.id = nextId('L', doc.labels); l.x += d; l.y += d; doc.labels.push(l); sel.add(`label:${l.id}`); }
    });
  }
  function selectAll() { sel = new Set([...doc.symbols.map(s => `sym:${s.id}`), ...doc.wires.map(w => `wire:${w.id}`), ...doc.ports.map(p => `port:${p.id}`), ...doc.labels.map(l => `label:${l.id}`)]); render(); renderProps(); }

  // ---------------- moving with rubber-banding wires
  function beginMove(start) {
    const before = snapshot();
    const orig = clone({ symbols: doc.symbols, wires: doc.wires, ports: doc.ports, labels: doc.labels });
    const symIds = new Set(selected('sym')), portIds = new Set(selected('port')), wireIds = new Set(selected('wire')), labelIds = new Set(selected('label'));
    const moved = new Set();
    for (const s of doc.symbols) if (symIds.has(s.id)) for (const p of symbolPins(s, modules)) moved.add(`${p.x},${p.y}`);
    for (const p of doc.ports) if (portIds.has(p.id)) moved.add(`${p.x},${p.y}`);
    for (const w of doc.wires) if (wireIds.has(w.id)) for (const p of w.points) moved.add(`${p.x},${p.y}`);
    const attach = [];   // { wire id, ends: [bool start, bool end] }
    for (const w of doc.wires) {
      if (wireIds.has(w.id)) continue;
      const a = moved.has(`${w.points[0].x},${w.points[0].y}`), b = moved.has(`${w.points[w.points.length - 1].x},${w.points[w.points.length - 1].y}`);
      if (a || b) attach.push({ id: w.id, a, b });
    }
    // labels sitting on moved wires move too
    for (const l of doc.labels) {
      if (labelIds.has(l.id)) continue;
      if (doc.wires.some(w => wireIds.has(w.id) && w.points.some((p, i) => i + 1 < w.points.length && onSeg(l, p, w.points[i + 1])))) labelIds.add(l.id);
    }
    // points that must stay on the wires being stretched (T-junctions, net names)
    const anchors = [];
    for (const w of doc.wires) anchors.push(w.points[0], w.points[w.points.length - 1]);
    for (const l of doc.labels) if (!labelIds.has(l.id)) anchors.push({ x: l.x, y: l.y });
    if (!keepConn) attach.length = 0;      // detach: the wires stay where they are
    // moved pins / markers and what they touch now
    const movedPts = [];
    for (const s of doc.symbols) if (symIds.has(s.id)) for (const p of symbolPins(s, modules)) movedPts.push({ key: `${s.id}/${p.name}`, x: p.x, y: p.y });
    for (const p of doc.ports) if (portIds.has(p.id)) movedPts.push({ key: `port:${p.id}`, x: p.x, y: p.y });
    const fixedPts = [];
    for (const s of doc.symbols) if (!symIds.has(s.id)) for (const p of symbolPins(s, modules)) fixedPts.push(p);
    for (const p of doc.ports) if (!portIds.has(p.id)) fixedPts.push(p);
    const wirePt = new Set();
    for (const w of doc.wires) for (const p of w.points) wirePt.add(`${p.x},${p.y}`);
    // pins/markers connected before the move: guarded against landing on other nets
    const guard = new Set(movedPts.filter(q => wirePt.has(`${q.x},${q.y}`) || fixedPts.some(f => f.x === q.x && f.y === q.y)).map(q => q.key));
    // touching a pin/marker directly (no wire): add a wire so the connection is kept
    const synth = [];
    if (keepConn) {
      const done = new Set();
      for (const q of movedPts) {
        const k = `${q.x},${q.y}`;
        if (done.has(k) || wirePt.has(k) || !fixedPts.some(f => f.x === q.x && f.y === q.y)) continue;
        done.add(k);
        const w = { id: nextId('W', doc.wires), points: [{ x: q.x, y: q.y }, { x: q.x, y: q.y }] };
        doc.wires.push(w); orig.wires.push(clone(w));
        attach.push({ id: w.id, a: false, b: true });
        synth.push(w.id);
      }
    }
    let conn0 = null;
    try { conn0 = connectivity(doc, modules); } catch { /* checked only when available */ }
    return { kind: 'move', start, before, orig, symIds, portIds, wireIds, labelIds, attach, anchors, conn0, guard, synth, dx: 0, dy: 0 };
  }
  function applyMove(m, dx, dy) {
    if (dx === m.dx && dy === m.dy) return;
    m.dx = dx; m.dy = dy;
    const o = m.orig;
    for (const s of doc.symbols) if (m.symIds.has(s.id)) { const s0 = o.symbols.find(x => x.id === s.id); s.x = s0.x + dx; s.y = s0.y + dy; }
    for (const p of doc.ports) if (m.portIds.has(p.id)) { const p0 = o.ports.find(x => x.id === p.id); p.x = p0.x + dx; p.y = p0.y + dy; }
    for (const l of doc.labels) if (m.labelIds.has(l.id)) { const l0 = o.labels.find(x => x.id === l.id); l.x = l0.x + dx; l.y = l0.y + dy; }
    for (const w of doc.wires) if (m.wireIds.has(w.id)) { const w0 = o.wires.find(x => x.id === w.id); w.points = w0.points.map(p => ({ x: p.x + dx, y: p.y + dy })); }
    for (const at of m.attach) {
      const w = doc.wires.find(x => x.id === at.id), w0 = o.wires.find(x => x.id === at.id);
      if (!w || !w0) continue;
      w.points = rubber(w0.points, at.a, at.b, dx, dy, m.anchors);
    }
    if (!moveFrame) moveFrame = requestAnimationFrame(() => { moveFrame = 0; render(); });
  }
  let moveFrame = 0;
  function rubber(pts0, a, b, dx, dy, anchors = []) {
    let pts = pts0.map(p => ({ ...p }));
    if (a && b) return pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    if (b) pts = pts.reverse();
    const n = pts.length;
    const P0 = pts[0], P1 = pts[1];
    const horiz = P0.y === P1.y;
    const np = { x: P0.x + dx, y: P0.y + dy };
    // something else is attached to the first segment: keep it in place and add a jog near the end
    const pinned = anchors.some(q => onSeg(q, P0, P1) && !(q.x === P0.x && q.y === P0.y) && !(q.x === P1.x && q.y === P1.y));
    const along = horiz ? dy === 0 : dx === 0;
    if (along && (n === 2 || !pinned)) pts[0] = np;
    else if (pinned || n === 2) {
      const sx = Math.sign(P1.x - P0.x) || 1, sy = Math.sign(P1.y - P0.y) || 1;
      if (n === 2 && !pinned) {
        if (horiz) { const mx = snap((np.x + P1.x) / 2); pts = [np, { x: mx, y: np.y }, { x: mx, y: P1.y }, P1]; }
        else { const my = snap((np.y + P1.y) / 2); pts = [np, { x: np.x, y: my }, { x: P1.x, y: my }, P1]; }
      } else if (horiz) {
        const jx = np.x + sx * GRID;
        pts = [np, { x: jx, y: np.y }, { x: jx, y: P0.y }, ...pts.slice(1)];
      } else {
        const jy = np.y + sy * GRID;
        pts = [np, { x: np.x, y: jy }, { x: P0.x, y: jy }, ...pts.slice(1)];
      }
    } else {
      pts[0] = np;
      if (horiz) pts[1] = { x: P1.x, y: P1.y + dy }; else pts[1] = { x: P1.x + dx, y: P1.y };
    }
    pts = cleanPts(pts);
    if (b) pts.reverse();
    return pts.length >= 2 ? pts : pts0;
  }
  function bandRect(d = drag) { const a = d.start, b = d.cur || a; return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }; }
  function bandSelect(add, d = drag) {
    const r = bandRect(d);
    if (!add) sel.clear();
    for (const s of doc.symbols) { const b = symbolBox(s, modules); if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) sel.add(`sym:${s.id}`); }
    for (const p of doc.ports) { const b = portBox(p); if (rectsTouch(b, r) && inside(p, r)) sel.add(`port:${p.id}`); }
    for (const w of doc.wires) if (w.points.every(p => inside(p, r))) sel.add(`wire:${w.id}`);
    for (const l of doc.labels) if (inside(l, r)) sel.add(`label:${l.id}`);
  }

  // ---------------- mouse
  const itemAt = target => { const g = target.closest?.('[data-kind]'); return g ? { kind: g.dataset.kind, id: g.dataset.id } : null; };
  let spaceDown = false;
  function onDown(e) {
    if (e.button === 2) { e.preventDefault(); if (wireDraw) finishWire(); else if (tool !== 'select') setTool('select'); return; }
    container.focus({ preventScroll: true });
    const pt = toSheet(e.clientX, e.clientY);
    cursor = pt;
    if (e.button === 1 || spaceDown) { e.preventDefault(); drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, tx: view.tx, ty: view.ty }; canvas.classList.add('panning'); return; }
    if (e.button !== 0) return;
    // live simulation: the inputs are controls, the rest of the sheet pans
    if (live) { if (!live.pointerDown(e, itemAt(e.target))) drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, tx: view.tx, ty: view.ty }; return; }
    if (tool === 'place') { placeAt(pt); return; }
    if (tool === 'wire') { wireClick(pt, e.detail >= 2); return; }
    if (tool === 'net') { netClick(pt); return; }
    if (tool === 'io') { ioClick(pt); return; }
    const it = itemAt(e.target);
    if (it) {
      // the item is drawn again below (render): without this, Safari (WebKit) sends the mousedown to
      // the removed element and moves the keyboard focus to the page, so F1, Delete, Ctrl+C… did
      // nothing after a click on a symbol (the focus stays on the editor, given above)
      e.preventDefault();
      const k = `${it.kind}:${it.id}`;
      if (e.shiftKey || e.ctrlKey || e.metaKey) { if (sel.has(k)) sel.delete(k); else sel.add(k); render(); renderProps(); return; }
      if (!sel.has(k)) { sel = new Set([k]); render(); renderProps(); }
      if (e.detail >= 2) return;            // handled by the dblclick listener
      if (!readOnly) drag = beginMove({ x: snap(pt.x), y: snap(pt.y) });
      return;
    }
    drag = { kind: 'band', start: pt, cur: pt, add: e.shiftKey || e.ctrlKey || e.metaKey };
  }
  function onMove(e) {
    if (destroyed) return;
    const pt = toSheet(e.clientX, e.clientY);
    cursor = pt;
    if (drag?.kind === 'pan') { view.tx = drag.tx + e.clientX - drag.cx; view.ty = drag.ty + e.clientY - drag.cy; applyView(); return; }
    if (drag?.kind === 'move') { applyMove(drag, snap(pt.x) - drag.start.x, snap(pt.y) - drag.start.y); return; }
    if (drag?.kind === 'band') { drag.cur = pt; renderOverlay(); return; }
    if (!svg.contains(e.target) && e.target !== svg) { live?.hideTip(); return; }
    if (live) { live.hover(e, pt, view.s); updateStatus(); return; }
    if (tool === 'wire' || tool === 'io' || tool === 'net') hoverPin = pinNear(pt); else hoverPin = null;
    if (tool !== 'select') renderOverlay();
    updateStatus();
  }
  // after a move: re-route the stretched wires so every connection is kept and none is added
  function finishMove(m) {
    // dropped with a pin on another net: nudge to the nearest clear position (up to 5 grid steps)
    if (keepConn && (m.symIds.size || m.portIds.size)) {
      const attachedIds = new Set(m.attach.map(a => a.id));
      const clash = () => placementClashes(doc, { moved: { symIds: m.symIds, portIds: m.portIds }, attachedIds, modules, guard: m.guard });
      if (clash()) {
        const bx = m.dx, by = m.dy;
        let found = false;
        for (let r = 1; r <= 5 && !found; r++) {
          for (let i = -r; i <= r && !found; i++) for (const [ox, oy] of [[i, -r], [i, r], [-r, i], [r, i]]) {
            applyMove(m, bx + ox * GRID, by + oy * GRID);
            if (!clash()) { found = true; break; }
          }
        }
        if (!found) applyMove(m, bx, by);
      }
    }
    if (keepConn && m.attach.length) {
      try { rerouteAfterMove(doc, { orig: m.orig, attached: m.attach, dx: m.dx, dy: m.dy, modules }); } catch (e) { console.error(e); }
    }
    doc = normalizeDoc(doc);
    if (keepConn && m.conn0) {
      let now = null;
      try { now = connectivity(doc, modules); } catch { /* ignore */ }
      if (now && !connectionsKept(m.conn0, now)) flash('Connections changed by this move (a pin now touches another net, or a wire could not be routed). Undo with Ctrl+Z if not intended.');
    }
    pushUndo(m.before); changed(); render(); renderProps();
  }
  function onUp(e) {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'pan') { canvas.classList.remove('panning'); return; }
    if (d.kind === 'move') {
      if (d.dx || d.dy) finishMove(d);
      else if (d.synth?.length) { doc.wires = doc.wires.filter(w => !d.synth.includes(w.id)); render(); }   // just a click
      return;
    }
    if (d.kind === 'band') {
      const r = bandRect(d);
      if (r.w < 3 && r.h < 3) { if (!d.add) sel.clear(); }
      else bandSelect(d.add, d);
      render(); renderProps();
    }
  }
  function onDouble(it) {
    if (it.kind === 'sym') {
      const s = doc.symbols.find(x => x.id === it.id);
      if (s?.type === 'module' && opts.onOpenModule) opts.onOpenModule(s.params.module, { instance: s.name, symbol: clone(s) });
      else if (s?.type === 'hdlblock') setTimeout(() => propBody.querySelector('textarea.code')?.focus(), 0);
      else setTimeout(() => propBody.querySelector('input')?.focus(), 0);
    } else setTimeout(() => propBody.querySelector('input')?.focus(), 0);
  }
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 1 && e.deltaMode !== 0) || (!e.shiftKey && Math.abs(e.deltaX) < 1 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50)) {
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
    } else {
      view.tx -= e.shiftKey ? e.deltaY : e.deltaX; view.ty -= e.shiftKey ? 0 : e.deltaY; applyView();
    }
  }
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('contextmenu', e => e.preventDefault());
  svg.addEventListener('dblclick', e => {
    if (live) { e.preventDefault(); return; }
    if (tool === 'wire') { e.preventDefault(); finishWire(); return; }
    if (tool === 'select') { const it = itemAt(e.target); if (it) { e.preventDefault(); onDouble(it); } }
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('pointerleave', () => { live?.hideTip(); hoverPin = null; if (tool !== 'select') renderOverlay(); });
  // drag & drop from the palette
  canvas.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('text/x-silinx-symbol')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  canvas.addEventListener('drop', e => {
    const raw = e.dataTransfer.getData('text/x-silinx-symbol');
    if (!raw || readOnly || live) return;
    e.preventDefault();
    const it = JSON.parse(raw);
    const src = { type: it.type, params: { ...defaultParams(it.type), ...(it.params || {}) }, rot: 0, mirror: false };
    if (it.type === 'module' && modules[it.params.module]) src.params.ports = modules[it.params.module].ports.map(p => ({ name: p.name, dir: p.dir, width: p.width }));
    const prevTool = tool;
    if (tool === 'place') setTool('select');
    placeAt(toSheet(e.clientX, e.clientY), src);
    if (prevTool !== 'place') renderProps();
  });

  // ---------------- keyboard
  function onKey(e) {
    if (destroyed) return;
    if (live) {
      if (!container.contains(document.activeElement) && document.activeElement !== container && !(e.key === 'Escape' && document.activeElement === document.body && container.offsetParent)) return;
      const t0 = e.target;
      if (t0 && (t0.tagName === 'INPUT' || t0.tagName === 'TEXTAREA' || t0.tagName === 'SELECT')) return;
      const k0 = e.key.toLowerCase();
      if (k0 === 'escape') { e.preventDefault(); if (live.editing) live.closeEditor(); else leaveSim(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k0 === ' ' && !spaceDown) { spaceDown = true; canvas.classList.add('pan-ready'); e.preventDefault(); }
      else if (k0 === 'f') fit();
      else if (k0 === '+' || k0 === '=') zoomAt(1.25);
      else if (k0 === '-' || k0 === '_') zoomAt(0.8);
      return;
    }
    // Esc stops placing a symbol / drawing a wire wherever the keyboard focus is (palette, search
    // box, page), as long as this editor is on screen
    if (e.key === 'Escape' && (tool !== 'select' || wireDraw) && container.isConnected && container.offsetParent) {
      e.preventDefault();
      if (wireDraw) { if (wireDraw.pts.length > 1) finishWire(); else { wireDraw = null; renderOverlay(); } }
      else setTool('select');
      container.focus({ preventScroll: true });
      return;
    }
    if (!container.contains(document.activeElement) && document.activeElement !== container) return;
    if (e.key === 'F1') { e.preventDefault(); const t1 = infoTarget(); if (t1) openInfo(t1); return; }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (k === ' ' && !spaceDown) { spaceDown = true; canvas.classList.add('pan-ready'); e.preventDefault(); return; }
    // read-only (RTL view): Backspace = up to the parent module, Enter = push into the selected instance
    if (readOnly && k === 'backspace' && !mod) { e.preventDefault(); opts.onUp?.(); return; }
    if (readOnly && k === 'enter' && !mod) { if (openSelected()) e.preventDefault(); return; }
    if (readOnly && !(['escape', 'f', '+', '=', '-', '_'].includes(k) || (mod && (k === 'a' || k === 'c')))) return;
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((mod && k === 'y') || (mod && k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    if (mod && k === 'r') { e.preventDefault(); rotateSel(); return; }
    if (mod && k === 'm') { e.preventDefault(); mirrorSel(); return; }
    if (mod && k === 'c') { e.preventDefault(); if (!readOnly) copySel(); return; }
    if (mod && k === 'x') { e.preventDefault(); copySel(true); return; }
    if (mod && k === 'v') { e.preventDefault(); paste(); return; }
    if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
    if (mod) return;
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); return; }
    if (k === 'escape') {
      if (wireDraw) { if (wireDraw.pts.length > 1) finishWire(); else { wireDraw = null; renderOverlay(); } return; }
      if (tool !== 'select') { setTool('select'); return; }
      sel.clear(); render(); renderProps(); return;
    }
    if (k === 'w') setTool('wire');
    else if (k === 'n') setTool('net');
    else if (k === 'o') setTool('io');
    else if (k === 's' && tool !== 'select') setTool('select');
    else if (k === 'f') fit();
    else if (k === '+' || k === '=') zoomAt(1.25);
    else if (k === '-' || k === '_') zoomAt(0.8);
    else if (k.startsWith('arrow') && sel.size) {
      e.preventDefault();
      const d = (e.shiftKey ? 5 : 1) * GRID;
      const dx = k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, dy = k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0;
      const m = beginMove({ x: 0, y: 0 });
      applyMove(m, dx, dy);
      finishMove(m);
    }
  }
  function onKeyUp(e) { if (e.key === ' ') { spaceDown = false; canvas.classList.remove('pan-ready'); } }
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);

  // ---------------- check / generate / view
  function runCheck(show) {
    refreshNetlist();
    const extra = [];
    try {
      const g = generateHdl(doc, { lang: genLang, modules });
      for (const d of g.diagnostics) if (!nl.diagnostics.some(x => x.message === d.message)) extra.push(d);
    } catch (err) { extra.push({ severity: 'error', message: `HDL generation failed: ${err.message}` }); }
    lastDiags = [...nl.diagnostics, ...extra];
    if (show) showDiags();
    updateStatus();
    return lastDiags;
  }

  // ---------------- live simulation (Logisim style): web/js/sch-live.js on core/schlive.js
  const toCanvas = pt => ({ x: pt.x * view.s + view.tx, y: pt.y * view.s + view.ty });
  async function enterSim() {
    if (live || liveStarting || readOnly || destroyed) return;
    if (wireDraw) finishWire();
    if (tool !== 'select') setTool('select');
    liveStarting = true;
    flash('Building the simulation model…');
    try {
      const [{ startLiveSim }, sources] = await Promise.all([import('./sch-live.js'), Promise.resolve(opts.simSources ? opts.simSources() : [])]);
      if (destroyed || live) return;
      const res = startLiveSim({
        doc: clone(doc), modules, sources: sources || [], lang: opts.simLang || genLang, h,
        layer: simG, content: contentG, bar: simBar, canvas, toCanvas, onExit: leaveSim,
      });
      if (!res.ok) {
        lastDiags = res.diagnostics?.length ? res.diagnostics : res.errors.map(message => ({ severity: 'error', message }));
        showDiags('Simulation refused');
        flash(`Cannot simulate: ${res.errors[0]}`);
        updateStatus();
        return;
      }
      live = res.ctl;
      sel.clear();
      diagPanel.hidden = true;
      hint.hidden = true;
      container.classList.add('sim-mode');
      render(); renderProps();
      opts.onSimulate?.(true);
    } catch (err) {
      console.error(err);
      flash(`Cannot simulate: ${err.message}`);
    } finally { liveStarting = false; }
  }
  function leaveSim() {
    if (!live) return;
    live.destroy();
    live = null;
    container.classList.remove('sim-mode');
    render(); renderProps();
    opts.onSimulate?.(false);
    container.focus({ preventScroll: true });
  }
  function showDiags(what = 'Check Schematic') {
    diagPanel.hidden = false;
    diagPanel.innerHTML = '';
    const errs = lastDiags.filter(d => d.severity === 'error').length, warns = lastDiags.filter(d => d.severity === 'warning').length;
    const head = h('div', { class: 'se-cap' }, h('span', { text: `${what}: ${errs} error(s), ${warns} warning(s)` }), h('span', { class: 'sp' }), h('button', { type: 'button', class: 'se-x', title: 'Close', text: '×', onclick: () => { diagPanel.hidden = true; } }));
    const list = h('div', { class: 'se-dlist' });
    if (!lastDiags.length) list.append(h('div', { class: 'se-drow ok', text: 'No errors or warnings found.' }));
    for (const d of lastDiags) {
      const row = h('div', { class: `se-drow ${d.severity}` }, h('span', { class: 'sev', text: d.severity === 'error' ? 'ERROR' : d.severity === 'warning' ? 'WARNING' : 'INFO' }), h('span', { text: d.message }));
      row.addEventListener('click', () => focusDiag(d));
      list.append(row);
    }
    diagPanel.append(head, list);
  }
  function focusDiag(d) {
    const r = d.ref || {};
    const k = r.kind === 'symbol' ? 'sym' : r.kind;
    if (k && KEYS[k] && r.id && doc[KEYS[k]].some(o => o.id === r.id)) sel = new Set([`${k}:${r.id}`]);
    let x = d.x, y = d.y;
    if (x == null && r.kind === 'symbol') { const s = doc.symbols.find(o => o.id === r.id); if (s) { const b = symbolBox(s, modules); x = b.x + b.w / 2; y = b.y + b.h / 2; } }
    if (x == null && r.kind === 'port') { const p = doc.ports.find(o => o.id === r.id); if (p) { x = p.x; y = p.y; } }
    if (x == null && d.net && nl) { const n = nl.nets.find(q => q.name === d.net); const w = n && doc.wires.find(q => q.id === n.wires[0]); if (w) { x = w.points[0].x; y = w.points[0].y; } }
    if (x != null) centerOn(x, y);
    render(); renderProps();
  }
  function doGenerate() {
    const diags = runCheck(false);
    const g = generateHdl(doc, { lang: genLang, modules });
    const errs = diags.filter(d => d.severity === 'error');
    if (errs.length) {
      showDiags();
      if (!window.confirm(`The schematic has ${errs.length} error(s). Generate the HDL anyway?`)) return;
    }
    // keep writing the HDL file the schematic owns (e.g. the source it was converted from) when its
    // extension matches the language; otherwise src/<name>.<ext>
    const ownExt = genLang === 'vhdl' ? /\.vhdl?$/i : /\.v$/i;
    const target = doc.generatedFile && ownExt.test(doc.generatedFile) ? doc.generatedFile : `src/${g.filename}`;
    if (doc.generatedFile !== target) edit(() => { doc.generatedFile = target; }, { keepProps: true });
    opts.onGenerate?.({ lang: genLang, filename: g.filename, code: g.code, target });
    flash(`Generated ${g.filename}`);
  }
  // ---------------- Symbol Info (datasheet of the selected / palette symbol): web/js/symbol-info.js
  let infoDlg = null;
  // the symbol the Symbol Info action is about: the selected symbol, else the one being placed / last picked in the palette
  function infoTarget() {
    const ids = selected('sym');
    if (ids.length === 1 && sel.size === 1) {
      const s = doc.symbols.find(x => x.id === ids[0]);
      if (s) return { type: s.type, params: clone(s.params), hdl: s.hdl, preset: presetOf(s.type, s.params) };
    }
    if (tool === 'place' && placing) return { type: placing.type, params: clone(placing.params), preset: placing.preset };
    return infoItem ? itemTarget(infoItem) : null;
  }
  async function openInfo(target) {
    if (!target || destroyed) return null;
    const { openSymbolInfo } = await import('./symbol-info.js');
    if (destroyed) return null;
    infoDlg?.close();
    infoDlg = openSymbolInfo({
      container, ...target, modules, lang: genLang, highlight,
      draw: (sym, def) => symbolDrawingSvg(sym, def),
      onClose: () => { infoDlg = null; if (container.isConnected) container.focus({ preventScroll: true }); },
    });
    return infoDlg;
  }
  const offLang = onLanguageChange(() => { if (infoItem) showSymInfo(infoItem); if (!live) renderProps(); });

  function viewHdl() {
    const dlg = h('div', { class: 'se-modal' });
    const box = h('div', { class: 'se-dialog' });
    const pre = h('pre', { class: 'se-code' });
    const dsel = h('select', {}, h('option', { value: 'vhdl', text: 'VHDL' }), h('option', { value: 'verilog', text: 'Verilog' }));
    dsel.value = genLang;
    const info = h('span', { class: 'se-dinfo' });
    let cur = null;
    const upd = () => {
      cur = generateHdl(doc, { lang: dsel.value, modules });
      pre.innerHTML = highlight(cur.code, dsel.value);
      const e = cur.diagnostics.filter(d => d.severity === 'error').length, w = cur.diagnostics.filter(d => d.severity === 'warning').length;
      info.textContent = `${cur.filename} · ${e} error(s), ${w} warning(s)`;
    };
    dsel.addEventListener('change', () => { genLang = dsel.value; langSel.value = genLang; upd(); });
    const close = () => dlg.remove();
    box.append(
      h('div', { class: 'se-dhead' }, h('b', { text: 'View HDL' }), dsel, info, h('span', { class: 'sp' }),
        h('button', { class: 'btn', type: 'button', text: 'Copy', onclick: () => { navigator.clipboard?.writeText(cur.code).then(() => flash('Copied'), () => {}); } }),
        h('button', { class: 'btn primary', type: 'button', text: 'Generate HDL', onclick: () => { close(); doGenerate(); } }),
        h('button', { class: 'btn', type: 'button', text: 'Close', onclick: close })),
      pre);
    dlg.append(box);
    dlg.addEventListener('pointerdown', e => { if (e.target === dlg) close(); });
    dlg.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    container.append(dlg);
    upd();
    box.tabIndex = -1; box.focus();
  }
  function highlight(code, lang) {
    const kw = lang === 'vhdl'
      ? /\b(library|use|entity|is|port|generic|map|in|out|inout|end|architecture|of|signal|begin|process|if|then|elsif|else|when|others|case|for|generate|loop|downto|to|and|or|not|xor|nand|nor|xnor|std_logic|std_logic_vector|unsigned|signed|integer|type|constant|component|select|with|rising_edge|wait|variable|function|return|all)\b/gi
      : /\b(module|endmodule|input|output|inout|wire|reg|assign|always|posedge|negedge|or|if|else|begin|end|case|endcase|default|parameter|localparam|generate|endgenerate|for|genvar|initial|integer|signed)\b/g;
    return esc(code).split('\n').map(line => {
      const ci = line.indexOf(lang === 'vhdl' ? '--' : '//');
      const a = ci >= 0 ? line.slice(0, ci) : line, c = ci >= 0 ? line.slice(ci) : '';
      return a.replace(kw, m => `<span class="kw">${m}</span>`) + (c ? `<span class="cm">${c}</span>` : '');
    }).join('\n');
  }

  // ---------------- small UI helpers
  let flashTimer = null;
  function flash(msg) {
    hint.textContent = msg; hint.hidden = false;
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { hint.hidden = true; }, 1800);
  }
  function promptBox(pt, label, value) {
    return new Promise(resolve => {
      const r = svg.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      const x = Math.min(cr.width - 220, Math.max(4, pt.x * view.s + view.tx + (r.left - cr.left) + 8));
      const y = Math.min(cr.height - 60, Math.max(4, pt.y * view.s + view.ty + (r.top - cr.top) + 8));
      const input = h('input', { type: 'text', value: value || '' });
      const box = h('div', { class: 'se-prompt', style: `left:${x}px;top:${y}px` }, h('label', { text: label }), input);
      let done = false;
      const end = v => { if (done) return; done = true; box.remove(); container.focus({ preventScroll: true }); resolve(v); };
      input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') end(input.value.trim() || null); else if (e.key === 'Escape') end(null); });
      input.addEventListener('blur', () => setTimeout(() => end(input.value.trim() || null), 0));
      canvas.append(box);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  // ---------------- resize
  let ro = null;
  let fitted = false;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (!fitted) { const r = svg.getBoundingClientRect(); if (r.width > 20 && r.height > 20) { fitted = true; fit(); } } });
    ro.observe(canvas);
  }

  // ---------------- init
  renderSheet();
  renderPalette();
  renderOpts();
  render();
  renderProps();
  setTimeout(() => { if (!fitted) { fitted = true; fit(); } }, 0);

  function normMods(m) {
    const out = {};
    if (!m) return out;
    for (const x of Array.isArray(m) ? m : Object.values(m)) if (x && x.name) out[x.name] = x;
    return out;
  }

  return {
    getDoc: () => clone(normalizeDoc(doc)),
    setDoc(d) { leaveSim(); infoDlg?.close(); doc = normalizeDoc(d || newDoc()); undoStack.length = 0; redoStack.length = 0; sel.clear(); lastDiags = null; genLang = doc.lang; langSel.value = genLang; diagPanel.hidden = true; renderSheet(); renderPalette(); render(); renderProps(); fit(); },
    setModules(m) { leaveSim(); modules = normMods(m); renderPalette(); render(); renderProps(); },
    check: () => runCheck(true),
    openSelected,
    fit,
    print,
    simulate: enterSim,
    stopSimulation: leaveSim,
    get simulating() { return !!live; },
    get liveSim() { return live?.live || null; },
    /** Open the Symbol Info datasheet ({ type, params, preset } or the current target); resolves to the dialog. */
    symbolInfo: target => openInfo(target || infoTarget()),
    get symbolInfoDialog() { return infoDlg; },
    destroy() {
      infoDlg?.close(); offLang();
      live?.destroy(); live = null;
      destroyed = true;
      clearTimeout(changeTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      ro?.disconnect();
      container.innerHTML = '';
      container.classList.remove('sch-editor');
    },
  };
}
