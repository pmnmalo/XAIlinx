// Silinx - graphical ASM chart editor (SVG, no framework).
//
//   import { mountAsmEditor } from './asm-editor.js';
//   const ed = mountAsmEditor(container, { model, onChange(model) {}, onGenerate({ lang, filename, code }) {} });
//   ed.getModel(); ed.setModel(m); ed.destroy();
//
// Styles: web/css/asm-editor.css (scoped under .asm-editor, themed by --bg/--panel/--fg/...).
//
// Besides states, decisions and conditional outputs the chart may hold "every cycle" blocks
// (type 'always': a header box whose tree of decisions/outputs runs on every clock cycle, in
// parallel with the states; unconnected exits end the block), and the machine panel edits the
// data path: generics, internal registers and the 2-flip-flop synchroniser of each input.

import { svgSnapshot, printDiagram } from './print.js';
import {
  normalizeModel, newModel, validate, generate, stateEncoding, ENCODINGS, nextCaseLabel as nextLabel,
} from '/core/asm.js';

const GRID = 20;
const CHW = 7.25;          // approx. width of a 12px monospace character
const SVGNS = 'http://www.w3.org/2000/svg';
let instanceCounter = 0;

// ------------------------------------------------------------------------------- helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const ceilTo = (v, g) => Math.ceil(v / g) * g;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

/** Size of a node box in chart units. */
function nodeSize(n) {
  if (n.type === 'state' || n.type === 'always') {
    const lines = n.actions.length ? n.actions : [''];
    const tw = Math.max(...lines.map((l) => l.length)) * CHW;
    return { w: Math.max(140, ceilTo(tw + 32, 2 * GRID)), h: Math.max(60, ceilTo(lines.length * 17 + 26, GRID)) };
  }
  if (n.type === 'decision') {
    const tw = Math.max(3, (n.cond || '').length) * CHW;
    const w = Math.max(140, ceilTo(tw * 1.25 + 56, 2 * GRID));
    return { w, h: w > 260 ? 100 : 80 };
  }
  if (n.type === 'case') {
    const tw = Math.max(3, (n.expr || '').length) * CHW;
    return { w: Math.max(160, ceilTo(tw + 80, 2 * GRID)), h: 60 };
  }
  const lines = n.actions.length ? n.actions : [''];
  const tw = Math.max(...lines.map((l) => l.length)) * CHW;
  return { w: Math.max(120, ceilTo(tw + 44, 2 * GRID)), h: Math.max(40, ceilTo(lines.length * 17 + 16, GRID)) };
}

function box(n) {
  const { w, h } = nodeSize(n);
  return { x: n.x, y: n.y, w, h, l: n.x - w / 2, r: n.x + w / 2, t: n.y - h / 2, b: n.y + h / 2 };
}

// exits of a case box leave from a horizontal bar CASE_BAR below the box, above each target
const CASE_BAR = 26;

/** Exit point and direction of a port (`dst`: the target, which places the exits of a case box). */
function portGeom(n, port, dst) {
  const b = box(n);
  if (n.type === 'case') {
    if (port === '+') return { x: b.r, y: n.y, dx: 1, dy: 0 };
    return { x: dst ? dst.x : n.x, y: b.b + CASE_BAR, dx: 0, dy: 1 };
  }
  if (n.type === 'decision' && port === 'false') {
    const s = n.flip ? -1 : 1;
    return { x: n.x + s * b.w / 2, y: n.y, dx: s, dy: 0 };
  }
  return { x: n.x, y: b.b, dx: 0, dy: 1 };
}
const portsOf = (n) => (n.type === 'decision' ? ['true', 'false'] : ['next']);

/** Orthogonal route from a port to the top of the target box. */
function routeEdge(src, port, dst, lane) {
  const p = portGeom(src, port, dst);
  const sb = box(src), db = box(dst);
  const t = { x: dst.x, y: db.t };
  const S = 20;
  const below = t.y >= p.y + 20;
  const t0y = clamp(t.y - (dst.type === 'state' ? 34 : S), p.y + 10, t.y - 10);
  const off = lane * 12;
  if (p.dy === 1) {
    if (below) {
      if (Math.abs(p.x - t.x) < 0.5) return [p, t];
      return [p, { x: p.x, y: t0y }, { x: t.x, y: t0y }, t];
    }
    const p1y = p.y + S;
    const ty = t.y - (dst.type === 'state' ? 34 : S);
    const right = dst.x >= src.x - 1;
    const xs = right ? Math.max(sb.r, db.r) + 30 + off : Math.min(sb.l, db.l) - 30 - off;
    return [p, { x: p.x, y: p1y }, { x: xs, y: p1y }, { x: xs, y: ty }, { x: t.x, y: ty }, t];
  }
  // side exit
  const p1x = p.x + p.dx * S;
  if (below && (t.x - p1x) * p.dx >= 0) return [p, { x: t.x, y: p.y }, t];
  if (below) return [p, { x: p1x, y: p.y }, { x: p1x, y: t0y }, { x: t.x, y: t0y }, t];
  const ty = t.y - (dst.type === 'state' ? 34 : S);
  const xs = p.dx > 0 ? Math.max(sb.r, db.r) + 30 + off : Math.min(sb.l, db.l) - 30 - off;
  return [p, { x: xs, y: p.y }, { x: xs, y: ty }, { x: t.x, y: ty }, t];
}

function pathD(pts, r = 7) {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) { d += ` L${b.x},${b.y}`; continue; }
    const p1 = { x: b.x - ((b.x - a.x) / l1) * rr, y: b.y - ((b.y - a.y) / l1) * rr };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * rr, y: b.y + ((c.y - b.y) / l2) * rr };
    d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`;
  }
  const z = pts[pts.length - 1];
  return d + ` L${z.x},${z.y}`;
}

// Tiny syntax highlighter for the code preview.
const KW = new Set(('library use entity is port in out inout end architecture of signal constant type subtype ' +
  'attribute begin process if then elsif else case when others null downto to and or not xor ' +
  'module input output wire reg localparam always posedge negedge assign endcase endmodule default ' +
  'std_logic std_logic_vector unsigned rising_edge resize all generic integer parameter ' +
  'shift_left shift_right to_integer to_unsigned').split(' '));
function highlight(code) {
  const re = /(--[^\n]*|\/\/[^\n]*)|("[^"\n]*")|('[01]')|(\b\d+'[bdhoBDHO][0-9a-fA-F_]+\b)|(\(\*[^\n]*?\*\))|\b([A-Za-z_]\w*)\b/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out += `<span class="tk-com">${esc(m[1])}</span>`;
    else if (m[2] || m[3] || m[4]) out += `<span class="tk-lit">${esc(m[0])}</span>`;
    else if (m[5]) out += `<span class="tk-attr">${esc(m[5])}</span>`;
    else if (KW.has(m[6].toLowerCase()) && !/^[A-Z]/.test(m[6])) out += `<span class="tk-kw">${esc(m[6])}</span>`;
    else if (/^S_/.test(m[6])) out += `<span class="tk-st">${esc(m[6])}</span>`;
    else out += esc(m[6]);
  }
  return out + esc(code.slice(last));
}

// ================================================================================ editor

export function mountAsmEditor(container, { model, onChange, onGenerate } = {}) {
  const uid = `asm${++instanceCounter}`;
  let M = normalizeModel(model || newModel('fsm', 'vhdl'));
  let sel = { nodes: new Set(), edge: null };
  let view = { tx: 40, ty: 40, k: 1 };
  let snap = true;
  let showCode = false;
  let diags = [];
  let hist = [JSON.stringify(M)], hi = 0, lastKey = null, lastT = 0;
  let spaceDown = false;
  let drag = null;
  let destroyed = false;
  const timers = {};

  // ---------------------------------------------------------------------------- DOM
  container.innerHTML = '';
  const root = h('div', { class: 'asm-editor', tabindex: '0' });
  container.append(root);

  const btn = (label, title, onclick, cls = '') => h('button', { type: 'button', class: `asm-btn ${cls}`, title, onclick }, label);
  const sep = () => h('span', { class: 'asm-sep' });

  const langSel = h('select', { class: 'asm-select', title: 'HDL language', onchange: () => { M.lang = langSel.value; commit('lang'); } },
    h('option', { value: 'vhdl' }, 'VHDL'), h('option', { value: 'verilog' }, 'Verilog'));
  const encSel = h('select', { class: 'asm-select', title: 'State encoding', onchange: () => { M.encoding = encSel.value; commit('enc'); } },
    ...ENCODINGS.map((e) => h('option', { value: e }, { binary: 'Binary', gray: 'Gray', onehot: 'One-hot', enum: 'Enum / auto' }[e])));
  const undoBtn = btn('↶', 'Undo (Ctrl+Z)', () => undo());
  const redoBtn = btn('↷', 'Redo (Ctrl+Shift+Z)', () => redo());
  const snapBtn = btn('# Snap', 'Toggle snapping to the grid', () => { snap = !snap; snapBtn.classList.toggle('on', snap); });
  snapBtn.classList.add('on');
  const zoomLbl = h('span', { class: 'asm-zoom', title: 'Zoom level' }, '100%');
  const codeBtn = btn('</> Code', 'Show / hide the generated HDL preview', () => toggleCode());
  const delBtn = btn('✕', 'Delete selection (Del)', () => deleteSelection(), 'asm-danger');

  const toolbar = h('div', { class: 'asm-toolbar' },
    h('div', { class: 'asm-group' },
      btn([h('span', { class: 'asm-ico ico-state' }), 'State'], 'Add state box (rectangle)', () => addNode('state'), 'asm-add'),
      btn([h('span', { class: 'asm-ico ico-decision' }), 'Decision'], 'Add decision box (diamond)', () => addNode('decision'), 'asm-add'),
      btn([h('span', { class: 'asm-ico ico-case' }), 'Case'], 'Add case box (multi-way decision on the value of a signal, e.g. opcode)', () => addNode('case'), 'asm-add'),
      btn([h('span', { class: 'asm-ico ico-output' }), 'Cond. output'], 'Add conditional output box (oval)', () => addNode('output'), 'asm-add'),
      btn([h('span', { class: 'asm-ico ico-always' }), 'Every cycle'], 'Add an every-cycle block (logic evaluated on every clock cycle, in parallel with the states)', () => addNode('always'), 'asm-add'),
      delBtn),
    sep(),
    h('div', { class: 'asm-group' }, undoBtn, redoBtn),
    sep(),
    h('div', { class: 'asm-group' },
      btn('Arrange', 'Automatic layout (states top-down, every-cycle blocks on the right)', () => autoArrange()),
      snapBtn,
      btn('−', 'Zoom out', () => zoomBy(1 / 1.2)), zoomLbl, btn('+', 'Zoom in', () => zoomBy(1.2)),
      btn('Fit', 'Fit the chart in the window', () => fit()),
      btn('🖨', 'Print the chart / save it as PDF or SVG (Ctrl+P)', () => print())),
    sep(),
    h('div', { class: 'asm-group' }, langSel, encSel),
    h('div', { class: 'asm-spacer' }),
    h('div', { class: 'asm-group' },
      btn('✓ Validate', 'Check the chart for errors', () => { runValidate(); showProblems(true); }),
      codeBtn,
      btn('Generate HDL', 'Generate the VHDL/Verilog file', () => doGenerate(), 'asm-primary')));

  // canvas
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'asm-canvas');
  svg.innerHTML = `
    <defs>
      <pattern id="${uid}-grid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse">
        <circle cx="0.5" cy="0.5" r="0.9" class="asm-griddot"/>
      </pattern>
      <marker id="${uid}-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M0,1 L10,5 L0,9 z" class="asm-arrowhead"/>
      </marker>
      <marker id="${uid}-arr-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M0,1 L10,5 L0,9 z" class="asm-arrowhead sel"/>
      </marker>
    </defs>
    <rect class="asm-bg" x="0" y="0" width="100%" height="100%" fill="url(#${uid}-grid)"/>
    <g class="asm-vp">
      <g class="asm-blocks"></g><g class="asm-edges"></g><g class="asm-nodes"></g><g class="asm-overlay"></g>
    </g>
    <rect class="asm-rubber" visibility="hidden"/>`;
  const vp = svg.querySelector('.asm-vp');
  const gBlocks = svg.querySelector('.asm-blocks');
  const gEdges = svg.querySelector('.asm-edges');
  const gNodes = svg.querySelector('.asm-nodes');
  const gOverlay = svg.querySelector('.asm-overlay');
  const rubber = svg.querySelector('.asm-rubber');
  const pattern = svg.querySelector('pattern');

  const hint = h('div', { class: 'asm-hint' },
    'Drag from a port ● to a box to connect · drag background to pan · wheel to zoom · Shift+drag to select · double-click to add a state');
  const canvasWrap = h('div', { class: 'asm-canvas-wrap' }, svg, hint);

  const codePre = h('pre', { class: 'asm-code' });
  const codeTitle = h('span', { class: 'asm-code-title' }, '');
  const codePanel = h('div', { class: 'asm-codepanel', hidden: true },
    h('div', { class: 'asm-codebar' }, codeTitle, h('div', { class: 'asm-spacer' }),
      btn('Copy', 'Copy the code to the clipboard', () => {
        navigator.clipboard?.writeText(codePre.textContent).then(() => flash('Code copied to clipboard'), () => {});
      }),
      btn('✕', 'Hide code preview', () => toggleCode(false))),
    codePre);
  const mainCol = h('div', { class: 'asm-main' }, canvasWrap, codePanel);

  // side panel
  const selSection = h('section', { class: 'asm-section asm-selection' });
  const machineBody = h('div', { class: 'asm-section-body' });
  const machineSection = h('details', { class: 'asm-section', open: true }, h('summary', {}, 'Machine'), machineBody);
  const probList = h('ul', { class: 'asm-problems' });
  const probSummary = h('span', { class: 'asm-prob-count' });
  const probSection = h('details', { class: 'asm-section', open: true }, h('summary', {}, 'Problems ', probSummary), probList);
  const side = h('aside', { class: 'asm-side' }, selSection, machineSection, probSection);

  const status = h('div', { class: 'asm-status' });
  const statusMsg = h('span', { class: 'asm-status-msg' });
  const statusInfo = h('span', { class: 'asm-status-info' });
  status.append(statusInfo, statusMsg);

  root.append(toolbar, h('div', { class: 'asm-body' }, mainCol, side), status);

  // ---------------------------------------------------------------------------- model ops
  const nodeById = (id) => M.nodes.find((n) => n.id === id);
  const exitsOf = (id) => {
    const o = {};
    for (const e of M.edges) if (e.from === id && !o[e.port]) o[e.port] = e;
    return o;
  };
  function newId(prefix) {
    const used = new Set([...M.nodes.map((n) => n.id), ...M.edges.map((e) => e.id)]);
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }
  function uniqueStateName() {
    const used = new Set(M.nodes.filter((n) => n.type === 'state').map((n) => n.name.toLowerCase()));
    let i = 0;
    while (used.has(`s${i}`)) i++;
    return `S${i}`;
  }
  const snapV = (v) => (snap ? Math.round(v / GRID) * GRID : Math.round(v));

  function connect(from, port, to) {
    M.edges = M.edges.filter((e) => !(e.from === from && e.port === port));
    const e = { id: newId('e'), from, to, port };
    M.edges.push(e);
    return e;
  }

  /** Width (bits) of the expression of a case box, or 1 if unknown. */
  function caseWidth(n) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[[(]\s*(\d+)\s*(?:(?::|downto)\s*(\d+))?\s*[\])])?\s*$/i.exec(n.expr || '');
    if (!m) return 1;
    if (m[2] != null) return m[3] != null ? Math.abs(+m[2] - +m[3]) + 1 : 1;
    const p = [...M.inputs, ...M.outputs, ...(M.registers || [])].find((x) => x.name === m[1]);
    return p ? p.width : 1;
  }
  const caseExits = (id) => M.edges.filter((e) => e.from === id);
  /** Target of an exit as drawn: exits of a case box that share a target are spread apart. */
  function drawTarget(e) {
    const a = nodeById(e.from), b = nodeById(e.to);
    if (!a || !b || a.type !== 'case') return b;
    const sib = M.edges.filter((x) => x.from === e.from && x.to === e.to);
    if (sib.length < 2) return b;
    return { ...b, x: b.x + (sib.indexOf(e) - (sib.length - 1) / 2) * 22 };
  }
  /** Label for a new exit of a case box (see nextCaseLabel in core/asm.js), null when all values have one. */
  const nextCaseLabel = (n) => nextLabel(caseExits(n.id).map((e) => e.port), caseWidth(n));

  function uniqueBlockName() {
    const used = new Set(M.nodes.filter((n) => n.type === 'always').map((n) => (n.name || '').toLowerCase()));
    let i = 1;
    while (used.has(i === 1 ? 'every_cycle' : `every_cycle${i}`)) i++;
    return i === 1 ? 'every_cycle' : `every_cycle${i}`;
  }

  function addNode(type, at) {
    const n = { id: newId({ state: 's', decision: 'd', case: 'c', always: 'a' }[type] || 'o'), type, x: 0, y: 0 };
    if (type === 'state') { n.name = uniqueStateName(); n.actions = []; }
    if (type === 'always') { n.name = uniqueBlockName(); n.actions = []; }
    if (type === 'decision') n.cond = M.inputs[0]?.name || 'cond';
    if (type === 'case') n.expr = (M.inputs.find((i) => i.width > 1) || M.inputs[0])?.name || 'sel';
    if (type === 'output') n.actions = M.outputs[0] ? [`${M.outputs[0].name} = 1`] : [];
    const s = nodeSize(n);
    let parent = null, port = null;
    if (!at && sel.nodes.size === 1 && type !== 'always') {
      parent = nodeById([...sel.nodes][0]);
      const ex = exitsOf(parent.id);
      port = parent.type === 'case' ? nextCaseLabel(parent) : (portsOf(parent).find((p) => !ex[p]) || null);
      if (!port) parent = null;
    }
    if (at) { n.x = snapV(at.x); n.y = snapV(at.y); }
    else if (parent) {
      const pb = box(parent);
      if (port === 'false') {
        const dir = parent.flip ? -1 : 1;
        n.x = snapV(parent.x + dir * (pb.w / 2 + s.w / 2 + 60));
        n.y = snapV(parent.y + pb.h / 2 + 40 + s.h / 2);
      } else {
        n.x = parent.x;
        n.y = snapV(pb.b + 50 + s.h / 2 + (type === 'state' ? 20 : 0));
      }
    } else {
      const r = svg.getBoundingClientRect();
      const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      n.x = snapV(c.x); n.y = snapV(c.y);
      // find a free spot to the right of the chart if the centre is occupied
      const overlaps = () => {
        const a = box(n);
        return M.nodes.some((o) => { const b = box(o); return a.l < b.r + 30 && a.r > b.l - 30 && a.t < b.b + 40 && a.b > b.t - 40; });
      };
      if (type === 'always') { // to the right of the chart
        const bb = chartBounds();
        if (bb) { n.x = snapV(bb.r + s.w / 2 + 40); n.y = snapV(bb.t + 50 + s.h / 2); }
      }
      for (let i = 0; i < 200 && overlaps(); i++) n.x += GRID;
    }
    M.nodes.push(n);
    if (parent) connect(parent.id, port, n.id);
    if (type === 'state' && (!M.initial || !nodeById(M.initial))) M.initial = n.id;
    sel = { nodes: new Set([n.id]), edge: null };
    commit('add');
    renderInspector();
    return n;
  }

  function deleteSelection() {
    if (sel.edge) {
      M.edges = M.edges.filter((e) => e.id !== sel.edge);
      sel.edge = null;
    } else if (sel.nodes.size) {
      M.nodes = M.nodes.filter((n) => !sel.nodes.has(n.id));
      M.edges = M.edges.filter((e) => !sel.nodes.has(e.from) && !sel.nodes.has(e.to));
      if (sel.nodes.has(M.initial)) M.initial = M.nodes.find((n) => n.type === 'state')?.id || '';
      sel.nodes.clear();
    } else return;
    commit('delete');
    renderInspector();
  }

  // ---------------------------------------------------------------------------- history
  function commit(key) {
    const snapStr = JSON.stringify(M);
    if (snapStr !== hist[hi]) {
      const now = Date.now();
      if (key && key === lastKey && now - lastT < 1500 && hi > 0) hist[hi] = snapStr;
      else {
        hist = hist.slice(0, hi + 1);
        hist.push(snapStr);
        hi++;
        if (hist.length > 300) { hist.shift(); hi--; }
      }
      lastKey = key; lastT = now;
      scheduleChange();
    }
    render();
    scheduleValidate();
    updateToolbar();
  }
  function restore(i) {
    hi = i;
    M = JSON.parse(hist[hi]);
    lastKey = null;
    sel.nodes = new Set([...sel.nodes].filter((id) => nodeById(id)));
    if (sel.edge && !M.edges.some((e) => e.id === sel.edge)) sel.edge = null;
    render(); renderInspector(); renderMachine(); scheduleValidate(); updateToolbar(); scheduleChange();
  }
  const undo = () => { if (hi > 0) restore(hi - 1); };
  const redo = () => { if (hi < hist.length - 1) restore(hi + 1); };

  function scheduleChange() {
    clearTimeout(timers.change);
    timers.change = setTimeout(() => { if (!destroyed) onChange?.(clone(M)); }, 300);
  }
  function scheduleValidate() {
    clearTimeout(timers.val);
    timers.val = setTimeout(runValidate, 150);
  }

  // ---------------------------------------------------------------------------- view
  function applyView() {
    vp.setAttribute('transform', `translate(${view.tx},${view.ty}) scale(${view.k})`);
    pattern.setAttribute('patternTransform', `translate(${view.tx},${view.ty}) scale(${view.k})`);
    zoomLbl.textContent = `${Math.round(view.k * 100)}%`;
  }
  function toWorld(cx, cy) {
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.k, y: (cy - r.top - view.ty) / view.k };
  }
  function zoomAt(f, cx, cy) {
    const r = svg.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const k = clamp(view.k * f, 0.2, 4);
    view.tx = px - ((px - view.tx) * k) / view.k;
    view.ty = py - ((py - view.ty) * k) / view.k;
    view.k = k;
    applyView();
  }
  function zoomBy(f) {
    const r = svg.getBoundingClientRect();
    zoomAt(f, r.left + r.width / 2, r.top + r.height / 2);
  }
  function chartBounds() {
    if (!M.nodes.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const n of M.nodes) {
      const bx = box(n);
      l = Math.min(l, bx.l - 50); r = Math.max(r, bx.r + 50); t = Math.min(t, bx.t - (n.type === 'state' || n.type === 'always' ? 50 : 20)); b = Math.max(b, bx.b + 40);
    }
    return { l, t, r, b };
  }
  /** Print dialog for the whole chart (selection and editing handles left out). */
  function print() {
    const bb = chartBounds();
    if (!bb) return;
    const saved = sel;
    sel = { nodes: new Set(), edge: null };
    render();
    let snap;
    try { snap = svgSnapshot(svg, vp, bb, ['.asm-bg', '.asm-rubber', '.asm-port', '.asm-overlay > *', 'defs pattern']); } finally { sel = saved; render(); }
    printDiagram({ title: `ASM chart ${M.name}`, snapshot: snap, filename: `${M.name}_asm` });
  }
  function fit() {
    const bb = chartBounds();
    const r = svg.getBoundingClientRect();
    if (!bb || r.width < 10 || r.height < 10) { view = { tx: 40, ty: 40, k: 1 }; applyView(); return; }
    const pad = 30;
    const k = clamp(Math.min((r.width - 2 * pad) / (bb.r - bb.l), (r.height - 2 * pad) / (bb.b - bb.t)), 0.2, 1.25);
    view.k = k;
    view.tx = (r.width - (bb.r - bb.l) * k) / 2 - bb.l * k;
    view.ty = (r.height - (bb.b - bb.t) * k) / 2 - bb.t * k;
    applyView();
  }
  function centerOn(n) {
    const r = svg.getBoundingClientRect();
    view.tx = r.width / 2 - n.x * view.k;
    view.ty = r.height / 2 - n.y * view.k;
    applyView();
  }

  // ---------------------------------------------------------------------------- rendering
  function blockMembers(stateId) {
    const out = new Set([stateId]);
    const stack = [];
    const push = (id) => { const n = nodeById(id); if (n && n.type !== 'state' && n.type !== 'always' && !out.has(id)) { out.add(id); stack.push(id); } };
    for (const e of M.edges) if (e.from === stateId && e.port === 'next') push(e.to);
    while (stack.length) {
      const id = stack.pop();
      for (const e of M.edges) if (e.from === id) push(e.to);
    }
    return out;
  }

  function render() {
    const diagBy = new Map();
    for (const d of diags) {
      if (!d.nodeId) continue;
      const cur = diagBy.get(d.nodeId);
      if (!cur || (cur === 'warning' && d.severity === 'error') || cur === 'info') diagBy.set(d.nodeId, d.severity);
    }
    let enc = new Map();
    try { enc = new Map(stateEncoding(M).map((s) => [s.id, s])); } catch { /* ignore */ }

    // ASM block outlines
    let bh = '';
    for (const s of M.nodes) {
      if (s.type !== 'state' && s.type !== 'always') continue;
      const mem = blockMembers(s.id);
      if (mem.size < 2) continue;
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const id of mem) {
        const bx = box(nodeById(id));
        l = Math.min(l, bx.l); r = Math.max(r, bx.r); t = Math.min(t, bx.t); b = Math.max(b, bx.b);
      }
      bh += `<rect class="asm-block${s.type === 'always' ? ' asm-block-always' : ''}" x="${l - 14}" y="${t - 32}" width="${r - l + 28}" height="${b - t + 46}" rx="10"/>`;
    }
    gBlocks.innerHTML = bh;

    // edges
    const lanes = { l: 0, r: 0 };
    let eh = '';
    for (const e of M.edges) {
      const a = nodeById(e.from), b = drawTarget(e);
      if (!a || !b) continue;
      let pts;
      if (e.points?.length) {
        const p = portGeom(a, e.port, b);
        pts = [p, ...e.points, { x: b.x, y: box(b).t }];
      } else {
        const p = portGeom(a, e.port, b);
        const goingUp = box(b).t < p.y + 20;
        let lane = 0;
        if (goingUp) {
          const right = p.dy ? b.x >= a.x - 1 : p.dx > 0;
          lane = right ? lanes.r++ : lanes.l++;
        }
        pts = routeEdge(a, e.port, b, lane);
      }
      const d = pathD(pts);
      const selc = sel.edge === e.id ? ' sel' : '';
      let label = '';
      if (a.type === 'decision') {
        const p = pts[0];
        const lx = e.port === 'false' ? p.x + (a.flip ? -10 : 10) : p.x + 9;
        const ly = e.port === 'false' ? p.y - 7 : p.y + 14;
        label = `<text class="asm-edge-label" x="${lx}" y="${ly}" text-anchor="${e.port === 'false' && a.flip ? 'end' : 'start'}">${e.port === 'true' ? '1' : '0'}</text>`;
      } else if (a.type === 'case') {
        const p = pts[0];
        label = `<text class="asm-edge-label asm-case-label" x="${p.x + 5}" y="${p.y + 13}">${esc(e.port)}</text>`;
      }
      eh += `<g class="asm-edge${selc}" data-edge="${esc(e.id)}"><path class="asm-edge-hit" d="${d}"/>` +
        `<path class="asm-edge-line" d="${d}" marker-end="url(#${uid}-arr${selc ? '-sel' : ''})"/>${label}</g>`;
    }
    // case boxes: stem and bar from which the exits leave
    let ch = '';
    for (const n of M.nodes) {
      if (n.type !== 'case') continue;
      const bx = box(n), by = bx.b + CASE_BAR;
      const xs = [n.x];
      for (const e of M.edges) { const t = e.from === n.id && drawTarget(e); if (t) xs.push(t.x); }
      ch += `<path class="asm-case-bar" d="M${n.x},${bx.b} L${n.x},${by} M${Math.min(...xs)},${by} L${Math.max(...xs)},${by}"/>`;
    }
    gEdges.innerHTML = ch + eh;

    // nodes
    const inAlways = new Set();
    for (const a of M.nodes) if (a.type === 'always') for (const id of blockMembers(a.id)) inAlways.add(id);
    let nh = '';
    for (const n of M.nodes) {
      const { w, h: hh } = nodeSize(n);
      const cls = ['asm-node', `asm-${n.type}`];
      if (sel.nodes.has(n.id)) cls.push('sel');
      const sev = diagBy.get(n.id);
      if (sev === 'error') cls.push('err'); else if (sev === 'warning') cls.push('warn');
      if (n.id === M.initial) cls.push('initial');
      let inner = '';
      const lines = (arr) => {
        const lh = 17, y0 = -((arr.length - 1) * lh) / 2;
        return arr.map((l, i) => `<text class="asm-text" x="0" y="${y0 + i * lh}" dominant-baseline="central" text-anchor="middle">${esc(l)}</text>`).join('');
      };
      if (n.type === 'state') {
        inner += `<rect class="asm-shape" x="${-w / 2}" y="${-hh / 2}" width="${w}" height="${hh}" rx="3"/>`;
        inner += n.actions.length ? lines(n.actions) : `<text class="asm-text asm-empty" x="0" y="0" dominant-baseline="central" text-anchor="middle">no outputs</text>`;
        const name = n.name || '?';
        const tw = Math.max(36, name.length * 7.6 + 16 + (n.id === M.initial ? 14 : 0));
        inner += `<g class="asm-tag" transform="translate(${-w / 2},${-hh / 2 - 22})">` +
          `<rect width="${tw}" height="20" rx="4"/>` +
          (n.id === M.initial ? `<path class="asm-init-mark" d="M7,5 L13,10 L7,15 z"/>` : '') +
          `<text x="${n.id === M.initial ? 17 : 8}" y="10.5" dominant-baseline="central">${esc(name)}</text></g>`;
        const code = enc.get(n.id);
        if (code && M.encoding !== 'enum') inner += `<text class="asm-statecode" x="${w / 2}" y="${-hh / 2 - 7}" text-anchor="end">${code.bits}</text>`;
      } else if (n.type === 'always') {
        inner += `<rect class="asm-shape" x="${-w / 2}" y="${-hh / 2}" width="${w}" height="${hh}" rx="3"/>`;
        inner += `<rect class="asm-always-band" x="${-w / 2}" y="${-hh / 2}" width="${w}" height="6" rx="2"/>`;
        inner += n.actions.length ? lines(n.actions) : `<text class="asm-text asm-empty" x="0" y="0" dominant-baseline="central" text-anchor="middle">every clock cycle</text>`;
        const label = `↻ ${n.name || '?'}`;
        const tw = Math.max(36, label.length * 7.6 + 16);
        inner += `<g class="asm-tag asm-tag-always" transform="translate(${-w / 2},${-hh / 2 - 22})">` +
          `<rect width="${tw}" height="20" rx="4"/><text x="8" y="10.5" dominant-baseline="central">${esc(label)}</text></g>`;
      } else if (n.type === 'decision') {
        inner += `<polygon class="asm-shape" points="0,${-hh / 2} ${w / 2},0 0,${hh / 2} ${-w / 2},0"/>`;
        inner += `<text class="asm-text" x="0" y="0" dominant-baseline="central" text-anchor="middle">${esc(n.cond || '?')}</text>`;
      } else if (n.type === 'case') {
        const k = hh / 2;
        inner += `<polygon class="asm-shape" points="${-w / 2},0 ${-w / 2 + k},${-hh / 2} ${w / 2 - k},${-hh / 2} ${w / 2},0 ${w / 2 - k},${hh / 2} ${-w / 2 + k},${hh / 2}"/>`;
        inner += `<text class="asm-text" x="0" y="0" dominant-baseline="central" text-anchor="middle">${esc(n.expr || '?')}</text>`;
      } else {
        inner += `<rect class="asm-shape" x="${-w / 2}" y="${-hh / 2}" width="${w}" height="${hh}" rx="${Math.min(hh / 2, 22)}"/>`;
        inner += n.actions.length ? lines(n.actions) : `<text class="asm-text asm-empty" x="0" y="0" dominant-baseline="central" text-anchor="middle">no outputs</text>`;
      }
      // ports
      const ex = exitsOf(n.id);
      if (n.type === 'case') {
        for (const e of caseExits(n.id)) {
          const g = portGeom(n, e.port, drawTarget(e));
          inner += `<circle class="asm-port" data-port="${esc(e.port)}" cx="${g.x - n.x}" cy="${g.y - n.y}" r="5.5"><title>exit ${esc(e.port)} - drag to another box to reconnect</title></circle>`;
        }
        const g = portGeom(n, '+');
        inner += `<circle class="asm-port free" data-port="+" cx="${g.x - n.x}" cy="${g.y - n.y}" r="5.5"><title>new exit (next free value) - drag to a box to connect</title></circle>`;
      }
      for (const p of n.type === 'case' ? [] : portsOf(n)) {
        const g = portGeom(n, p);
        const lx = g.x - n.x, ly = g.y - n.y;
        // an unconnected exit of an every-cycle block is the end of the block: drawn as a terminator
        const end = !ex[p] && inAlways.has(n.id);
        if (end) {
          const ex2 = lx + g.dx * 16, ey2 = ly + g.dy * 16;
          inner += `<path class="asm-end" d="M${lx},${ly} L${ex2},${ey2} M${ex2 - (g.dy ? 7 : 0)},${ey2 - (g.dx ? 7 : 0)} L${ex2 + (g.dy ? 7 : 0)},${ey2 + (g.dx ? 7 : 0)}"/>`;
        }
        const free = ex[p] ? '' : end ? ' end' : ' free';
        const what = n.type === 'decision' ? (p === 'true' ? 'true (1) exit' : 'false (0) exit') : 'exit';
        inner += `<circle class="asm-port${free}" data-port="${p}" cx="${lx}" cy="${ly}" r="5.5"><title>${what}${end ? ' (unconnected: end of the every-cycle block)' : ''} - drag to a box to connect</title></circle>`;
      }
      nh += `<g class="${cls.join(' ')}" data-node="${esc(n.id)}" transform="translate(${n.x},${n.y})">${inner}</g>`;
    }
    gNodes.innerHTML = nh;

    const ns = M.nodes.filter((n) => n.type === 'state').length;
    const na = M.nodes.filter((n) => n.type === 'always').length;
    const ne = diags.filter((d) => d.severity === 'error').length, nw = diags.filter((d) => d.severity === 'warning').length;
    statusInfo.innerHTML = `${esc(M.name)} · ${ns} state${ns === 1 ? '' : 's'} · ` +
      (na ? `${na} every-cycle block${na === 1 ? '' : 's'} · ` : '') +
      `<span class="${ne ? 'c-err' : 'c-ok'}">${ne} error${ne === 1 ? '' : 's'}</span> · ` +
      `<span class="${nw ? 'c-warn' : ''}">${nw} warning${nw === 1 ? '' : 's'}</span>`;
  }

  function updateToolbar() {
    undoBtn.disabled = hi <= 0;
    redoBtn.disabled = hi >= hist.length - 1;
    delBtn.disabled = !sel.edge && !sel.nodes.size;
    langSel.value = M.lang;
    encSel.value = M.encoding;
  }

  let flashTimer = null;
  function flash(msg, kind = '') {
    statusMsg.textContent = msg;
    statusMsg.className = `asm-status-msg ${kind}`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { statusMsg.textContent = ''; }, 5000);
  }

  // ---------------------------------------------------------------------------- validation & code
  function runValidate() {
    if (destroyed) return;
    try { diags = validate(M); } catch (e) { diags = [{ severity: 'error', message: `Internal error: ${e.message}` }]; }
    probList.innerHTML = '';
    const ne = diags.filter((d) => d.severity === 'error').length;
    const nw = diags.filter((d) => d.severity === 'warning').length;
    probSummary.textContent = ne || nw ? `(${ne} error${ne === 1 ? '' : 's'}, ${nw} warning${nw === 1 ? '' : 's'})` : '';
    probSummary.className = `asm-prob-count ${ne ? 'c-err' : nw ? 'c-warn' : ''}`;
    if (!diags.length) probList.append(h('li', { class: 'asm-prob ok' }, h('span', { class: 'asm-sev' }, '✓'), 'No problems: the chart is ready to generate.'));
    for (const d of diags) {
      const li = h('li', { class: `asm-prob ${d.severity}${d.nodeId ? ' link' : ''}`, title: d.nodeId ? 'Click to show the box' : '' },
        h('span', { class: 'asm-sev' }, d.severity === 'error' ? '✖' : d.severity === 'warning' ? '▲' : 'i'), d.message);
      if (d.nodeId) li.addEventListener('click', () => focusNode(d.nodeId));
      probList.append(li);
    }
    render();
    if (showCode) renderCode();
  }
  function showProblems(announce) {
    probSection.open = true;
    const ne = diags.filter((d) => d.severity === 'error').length;
    if (announce) flash(ne ? `${ne} error(s) found - see Problems` : diags.length ? 'No errors (see warnings in Problems)' : 'No problems found', ne ? 'err' : 'ok');
  }
  function focusNode(id) {
    const n = nodeById(id);
    if (!n) return;
    sel = { nodes: new Set([id]), edge: null };
    centerOn(n);
    render(); renderInspector(); updateToolbar();
  }
  function renderCode() {
    const fname = `${M.name}.${M.lang === 'verilog' ? 'v' : 'vhd'}`;
    codeTitle.textContent = fname;
    try {
      const g = generate(M);
      codePre.innerHTML = highlight(g.code);
      codePre.classList.remove('has-err');
    } catch (e) {
      codePre.textContent = `-- Cannot generate ${fname}:\n\n${e.message}`;
      codePre.classList.add('has-err');
    }
  }
  function toggleCode(force) {
    showCode = force ?? !showCode;
    codePanel.hidden = !showCode;
    codeBtn.classList.toggle('on', showCode);
    if (showCode) renderCode();
  }
  function doGenerate() {
    runValidate();
    let g;
    try { g = generate(M); } catch (e) {
      showProblems(false);
      flash('Cannot generate HDL: fix the errors listed in Problems', 'err');
      return;
    }
    flash(`Generated ${g.filename}`, 'ok');
    onGenerate?.(g);
  }

  // ---------------------------------------------------------------------------- inspector
  function field(label, input, hintText) {
    return h('label', { class: 'asm-field' }, h('span', { class: 'asm-label' }, label), input, hintText ? h('small', { class: 'asm-fhint' }, hintText) : null);
  }
  const put = (...kids) => selSection.append(...kids.filter((k) => k != null));
  function renderInspector() {
    selSection.innerHTML = '';
    if (sel.edge) {
      const e = M.edges.find((x) => x.id === sel.edge);
      if (!e) return;
      const a = nodeById(e.from), b = nodeById(e.to);
      const nm = (n) => (n.type === 'state' ? `state ${n.name}` : n.type === 'always' ? `every-cycle block ${n.name}`
        : n.type === 'decision' ? `decision "${n.cond}"` : n.type === 'case' ? `case "${n.expr}"` : 'conditional output');
      put(h('h3', {}, 'Connection'),
        h('p', { class: 'asm-muted' }, `From ${nm(a)}${a.type === 'decision' ? ` (${e.port === 'true' ? '1' : '0'} branch)` : ''} to ${nm(b)}.`),
        a.type === 'case' ? field('Value(s) of this exit', h('input', { class: 'asm-input mono', value: e.port, spellcheck: 'false', 'data-focus': '1',
          oninput: (ev) => { e.port = ev.target.value.trim() || 'others'; commit(`lbl:${e.id}`); } }),
        `e.g. ${'0'.repeat(Math.max(0, caseWidth(a) - 1))}1, 4, 0|1 (several values) or others`) : null,
        e.points ? btn('Reset route', 'Use automatic routing', () => { delete e.points; commit('route'); }) : null,
        btn('Delete connection', 'Delete (Del)', () => deleteSelection(), 'asm-danger'));
      return;
    }
    if (sel.nodes.size > 1) {
      put(h('h3', {}, `${sel.nodes.size} boxes selected`),
        h('p', { class: 'asm-muted' }, 'Drag to move them together, or delete them.'),
        btn('Delete selection', 'Delete (Del)', () => deleteSelection(), 'asm-danger'));
      return;
    }
    if (sel.nodes.size === 0) {
      put(h('h3', {}, 'Selection'),
        h('p', { class: 'asm-muted' }, 'Select a box to edit it. Add boxes with the toolbar (a new box is connected below the selected one) or double-click the canvas.'),
        h('div', { class: 'asm-legend' },
          h('div', {}, h('span', { class: 'asm-ico ico-state' }), ' State: name + Moore outputs'),
          h('div', {}, h('span', { class: 'asm-ico ico-decision' }), ' Decision: condition, exits 1 / 0'),
          h('div', {}, h('span', { class: 'asm-ico ico-case' }), ' Case: one exit per value of a signal'),
          h('div', {}, h('span', { class: 'asm-ico ico-output' }), ' Conditional (Mealy) outputs'),
          h('div', {}, h('span', { class: 'asm-ico ico-always' }), ' Every cycle: logic in parallel with the states')));
      return;
    }
    const n = nodeById([...sel.nodes][0]);
    if (!n) return;
    const syntax = 'Syntax: out = 1, out = 4\'b1010, cnt = cnt + 1 (registered), or just "out" for out = 1';
    if (n.type === 'state') {
      put(h('h3', {}, 'State'));
      put(field('Name', h('input', { class: 'asm-input', value: n.name, spellcheck: 'false', 'data-focus': '1',
        oninput: (ev) => { n.name = ev.target.value.trim(); commit(`name:${n.id}`); }, onchange: () => renderMachine() })));
      const isInit = n.id === M.initial;
      put(h('label', { class: 'asm-check' },
        h('input', { type: 'checkbox', checked: isInit, disabled: isInit, onchange: () => { M.initial = n.id; commit('initial'); renderInspector(); renderMachine(); } }),
        isInit ? ' Initial (reset) state' : ' Make this the initial (reset) state'));
      put(field('Moore outputs (one per line)', actionsArea(n), syntax));
    } else if (n.type === 'always') {
      put(h('h3', {}, 'Every-cycle block'));
      put(field('Name', h('input', { class: 'asm-input', value: n.name, spellcheck: 'false', 'data-focus': '1',
        oninput: (ev) => { n.name = ev.target.value.trim(); commit(`name:${n.id}`); } }), 'Used in the generated code comments.'));
      put(field('Actions on every cycle (one per line)', actionsArea(n),
        'e.g. tc = 0, cnt = cnt + 1. Assign registers, registered outputs (next value) or combinational outputs.'));
      put(h('p', { class: 'asm-muted' }, 'Connect the exit to decision and conditional output boxes: they are evaluated on every clock cycle, ' +
        'in parallel with the states. Leave the last exits unconnected (end of the block); paths may join again but must not loop or reach a state. ' +
        'An assignment of the current state to the same target takes priority.'));
    } else if (n.type === 'decision') {
      put(h('h3', {}, 'Decision'));
      put(field('Condition', h('input', { class: 'asm-input mono', value: n.cond, spellcheck: 'false', 'data-focus': '1',
        oninput: (ev) => { n.cond = ev.target.value; commit(`cond:${n.id}`); } }),
      'e.g. go, !done, cnt == 9, x && (mode == 2\'b01), (1 << n) > cnt. Exit 1 = true, 0 = false.'));
      put(h('label', { class: 'asm-check' },
        h('input', { type: 'checkbox', checked: !!n.flip, onchange: (ev) => { if (ev.target.checked) n.flip = true; else delete n.flip; commit('flip'); } }),
        ' 0-exit on the left side'));
      put(btn('Swap 1 / 0 exits', 'Exchange the true and false branches', () => {
        for (const e of M.edges) if (e.from === n.id) e.port = e.port === 'true' ? 'false' : 'true';
        commit('swap');
      }));
    } else if (n.type === 'case') {
      put(h('h3', {}, 'Case'));
      put(field('Value tested', h('input', { class: 'asm-input mono', value: n.expr, spellcheck: 'false', 'data-focus': '1',
        oninput: (ev) => { n.expr = ev.target.value; commit(`expr:${n.id}`); } }),
      'An input, register or registered output, or a bit slice (e.g. opcode, opcode[4:3]). Generated as a case statement.'));
      const list = h('div', { class: 'asm-case-list' });
      for (const e of caseExits(n.id)) {
        const t = nodeById(e.to);
        list.append(h('div', { class: 'asm-row' },
          h('input', { class: 'asm-input mono', value: e.port, spellcheck: 'false', title: 'Value(s) of this exit: binary digits, a literal, a|b, or others',
            oninput: (ev) => { e.port = ev.target.value.trim() || 'others'; commit(`lbl:${e.id}`); } }),
          h('span', { class: 'asm-muted' }, `→ ${t ? (t.type === 'state' ? t.name : t.type === 'decision' ? t.cond : t.type === 'case' ? t.expr : 'output') : '?'}`),
          btn('✕', 'Delete this exit', () => { M.edges = M.edges.filter((x) => x.id !== e.id); commit('del-exit'); renderInspector(); }, 'asm-small asm-danger')));
      }
      put(field('Exits (value → box)', list, 'Drag from the ○ port on the right of the box to a box to add an exit (it gets the next free value). ' +
        "Without an 'others' exit the values must cover every case."));
    } else {
      put(h('h3', {}, 'Conditional output'));
      put(field('Mealy outputs (one per line)', actionsArea(n), syntax));
    }
    put(h('div', { class: 'asm-row' }, btn('Delete box', 'Delete (Del)', () => deleteSelection(), 'asm-danger')));
  }
  function actionsArea(n) {
    const ta = h('textarea', { class: 'asm-input mono', rows: String(Math.max(3, n.actions.length + 1)), spellcheck: 'false', 'data-focus': '1',
      oninput: () => { n.actions = ta.value.split('\n').map((s) => s.trim()).filter(Boolean); commit(`act:${n.id}`); } });
    ta.value = n.actions.join('\n');
    return ta;
  }

  function renderMachine() {
    machineBody.innerHTML = '';
    const txt = (label, get, set, key, hintText) => field(label, h('input', { class: 'asm-input', value: get(), spellcheck: 'false',
      oninput: (ev) => { set(ev.target.value.trim()); commit(key); } }), hintText);
    machineBody.append(txt('Module / entity name', () => M.name, (v) => { M.name = v; }, 'm-name'));
    const row = h('div', { class: 'asm-grid2' },
      txt('Clock', () => M.clock, (v) => { M.clock = v; }, 'm-clk'),
      txt('Reset', () => M.reset.name, (v) => { M.reset.name = v; }, 'm-rst'));
    machineBody.append(row);
    machineBody.append(h('div', { class: 'asm-grid2' },
      field('Reset level', h('select', { class: 'asm-input', onchange: (ev) => { M.reset.active = ev.target.value; commit('m-act'); } },
        h('option', { value: 'high', selected: M.reset.active === 'high' }, 'active high'),
        h('option', { value: 'low', selected: M.reset.active === 'low' }, 'active low'))),
      field('Reset type', h('select', { class: 'asm-input', onchange: (ev) => { M.reset.sync = ev.target.value === 'sync'; commit('m-sync'); } },
        h('option', { value: 'async', selected: !M.reset.sync }, 'asynchronous'),
        h('option', { value: 'sync', selected: M.reset.sync }, 'synchronous')))));
    const states = M.nodes.filter((n) => n.type === 'state');
    machineBody.append(field('Initial state', h('select', { class: 'asm-input', onchange: (ev) => { M.initial = ev.target.value; commit('m-init'); renderInspector(); } },
      !states.some((s) => s.id === M.initial) ? h('option', { value: '', selected: true }, '(none)') : null,
      ...states.map((s) => h('option', { value: s.id, selected: s.id === M.initial }, s.name || s.id)))));

    // ports, generics and registers tables
    const usedNames = () => new Set([...M.inputs, ...M.outputs, ...(M.generics || []), ...(M.registers || [])].map((x) => x.name));
    const freshName = (base, start) => { let k = start; const used = usedNames(); while (used.has(`${base}${k}`)) k++; return `${base}${k}`; };
    const nameCell = (p, key) => h('td', {}, h('input', { class: 'asm-input mono', value: p.name, spellcheck: 'false', placeholder: 'name',
      oninput: (ev) => { p.name = ev.target.value.trim(); commit(key); } }));
    const widthCell = (p, key) => h('td', {}, h('input', { class: 'asm-input mono w', type: 'number', min: '1', max: '256', value: String(p.width),
      oninput: (ev) => { p.width = parseInt(ev.target.value, 10) || 0; commit(key); } }));
    const removeCell = (list, i, key) => h('td', { class: 'c' }, h('button', { type: 'button', class: 'asm-x', title: 'Remove',
      onclick: () => {
        list.splice(i, 1);
        // optional lists disappear when empty (old charts stay unchanged)
        for (const k of ['registers', 'generics']) if (M[k] && !M[k].length) delete M[k];
        commit(key); renderMachine();
      } }, '✕'));
    const table = (title, cls, heads, list, row, addLabel, addTitle, make, attach = () => {}) => {
      const tb = h('tbody');
      list.forEach((p, i) => tb.append(h('tr', {}, ...row(p, i))));
      const add = btn(addLabel, addTitle, () => {
        attach(list);
        list.push(make(list));
        commit(`${cls}-add`); renderMachine();
        const inputs = machineBody.querySelectorAll(`table.${cls} tbody tr:last-child input`);
        inputs[0]?.focus(); inputs[0]?.select();
      }, 'asm-small');
      return h('div', { class: 'asm-ports' },
        h('div', { class: 'asm-ports-head' }, h('span', { class: 'asm-label' }, title), add),
        h('table', { class: `asm-table ${cls}` }, h('thead', {}, h('tr', {}, ...heads.map(([t, tt]) => h('th', tt ? { title: tt } : {}, t)), h('th', {}))), tb));
    };
    machineBody.append(table('Inputs', 'ins', [['Name'], ['Width'], ['Sync', 'Synchronise with 2 flip-flops (conditions see the synchronised value)']], M.inputs,
      (p, i) => [nameCell(p, `p-n:in:${i}`), widthCell(p, `p-w:in:${i}`),
        h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: !!p.sync, title: 'Synchronise with 2 flip-flops (asynchronous input, e.g. a button)',
          onchange: (ev) => { if (ev.target.checked) p.sync = true; else delete p.sync; commit('p-s'); } })),
        removeCell(M.inputs, i, 'p-del')],
      '+ input', 'Add an input port', () => ({ name: freshName('in', M.inputs.length), width: 1 })));
    machineBody.append(table('Outputs', 'outs', [['Name'], ['Width'], ['Default'], ['Reg', 'Registered']], M.outputs,
      (p, i) => [nameCell(p, `p-n:out:${i}`), widthCell(p, `p-w:out:${i}`),
        h('td', {}, h('input', { class: 'asm-input mono d', value: p.default, spellcheck: 'false', title: 'Default (combinational) or reset value (registered)',
          oninput: (ev) => { p.default = ev.target.value.trim() || '0'; commit(`p-d:${i}`); } })),
        h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: p.registered, title: 'Registered output (holds its value, readable in conditions)',
          onchange: (ev) => { p.registered = ev.target.checked; commit('p-r'); } })),
        removeCell(M.outputs, i, 'p-del')],
      '+ output', 'Add an output port', () => ({ name: freshName('out', M.outputs.length), width: 1, default: '0', registered: false })));
    machineBody.append(h('small', { class: 'asm-fhint' }, 'Combinational outputs take their default unless assigned. Registered outputs (Reg) hold their value, reset to the default and can be read in conditions, e.g. cnt = cnt + 1.'));
    const regs = M.registers || [];
    machineBody.append(table('Registers', 'regs', [['Name'], ['Width'], ['Reset', 'Reset (initial) value']], regs,
      (r, i) => [nameCell(r, `r-n:${i}`), widthCell(r, `r-w:${i}`),
        h('td', {}, h('input', { class: 'asm-input mono d', value: r.init, spellcheck: 'false', title: 'Reset value',
          oninput: (ev) => { r.init = ev.target.value.trim() || '0'; commit(`r-i:${i}`); } })),
        removeCell(regs, i, 'r-del')],
      '+ register', 'Add an internal register (data path)', () => ({ name: freshName('r', regs.length), width: 8, init: '0' }),
      (l) => { M.registers = l; }));
    const gens = M.generics || [];
    machineBody.append(table('Generics', 'gens', [['Name'], ['Default', 'Default value (integer)']], gens,
      (g, i) => [nameCell(g, `g-n:${i}`),
        h('td', {}, h('input', { class: 'asm-input mono d', value: String(g.default), spellcheck: 'false', title: 'Default value (non-negative integer)',
          oninput: (ev) => { const t = ev.target.value.trim().replace(/_/g, ''); g.default = /^\d+$/.test(t) ? Number(t) : ev.target.value.trim(); commit(`g-d:${i}`); } })),
        removeCell(gens, i, 'g-del')],
      '+ generic', 'Add an integer generic / parameter', () => ({ name: freshName('N', gens.length + 1), default: 1 }),
      (l) => { M.generics = l; }));
    machineBody.append(h('small', { class: 'asm-fhint' }, 'Registers are internal: assign them like registered outputs (next value at the clock edge, they hold otherwise) ' +
      'and read them anywhere. Generics are integer VHDL generics / Verilog parameters, usable in expressions (e.g. cnt == N - 1).'));
  }

  // ---------------------------------------------------------------------------- layout
  // Arrange: the layout used for charts extracted from HDL (state blocks top-down in BFS order,
  // every-cycle blocks in a column on the right); the layered layout below is the fallback
  async function autoArrange() {
    if (!M.nodes.length) return;
    let asmLayout = null;
    try { ({ asmLayout } = await import('/core/asm-from-hdl.js')); } catch { /* not available: fallback */ }
    if (destroyed) return;
    if (asmLayout) {
      try {
        const pos = new Map(asmLayout(M).nodes.map((n) => [n.id, n]));
        for (const n of M.nodes) { const p = pos.get(n.id); if (p) { n.x = p.x; n.y = p.y; } }
        for (const e of M.edges) delete e.points;
        commit('arrange');
        fit();
        return;
      } catch { /* fallback */ }
    }
    layeredArrange();
  }
  function layeredArrange() {
    const layer = new Map(), parentOf = new Map();
    const order = [];
    const bfs = (start) => {
      if (layer.has(start)) return;
      let base = 0;
      for (const v of layer.values()) base = Math.max(base, v + 1);
      layer.set(start, base); order.push(start);
      const q = [start];
      while (q.length) {
        const id = q.shift();
        const ex = exitsOf(id);
        const ports = nodeById(id)?.type === 'case' ? caseExits(id).map((e) => e.port) : ['next', 'true', 'false'];
        for (const p of ports) {
          const e = ex[p];
          if (!e || layer.has(e.to) || !nodeById(e.to)) continue;
          layer.set(e.to, layer.get(id) + 1); parentOf.set(e.to, { id, port: p }); order.push(e.to); q.push(e.to);
        }
      }
    };
    if (nodeById(M.initial)) bfs(M.initial);
    for (const n of M.nodes) if (n.type === 'state') bfs(n.id);
    for (const n of M.nodes) bfs(n.id);
    const layers = [];
    for (const id of order) (layers[layer.get(id)] ||= []).push(nodeById(id));
    let y = 0;
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      if (!L) continue;
      const maxH = Math.max(...L.map((n) => nodeSize(n).h));
      const hasState = L.some((n) => n.type === 'state');
      y += maxH / 2 + (hasState && li ? 24 : 0);
      const want = L.map((n) => {
        const p = parentOf.get(n.id);
        if (!p) return 0;
        const par = nodeById(p.id);
        if (p.port === 'false') {
          const dir = par.flip ? -1 : 1;
          return par.x + dir * (nodeSize(par).w / 2 + nodeSize(n).w / 2 + 50);
        }
        return par.x;
      });
      const idxs = L.map((_, i) => i).sort((a, b) => want[a] - want[b] || a - b);
      const xs = [];
      idxs.forEach((i, k) => {
        let x = want[i];
        if (k) {
          const pi = idxs[k - 1];
          const min = xs[pi] + nodeSize(L[pi]).w / 2 + nodeSize(L[i]).w / 2 + 50;
          x = Math.max(x, min);
        }
        xs[i] = x;
      });
      const shift = xs.reduce((s, x, i) => s + (x - want[i]), 0) / xs.length;
      L.forEach((n, i) => { n.x = Math.round((xs[i] - shift) / GRID) * GRID; n.y = Math.round(y / GRID) * GRID; });
      y += maxH / 2 + 60;
    }
    for (const e of M.edges) delete e.points;
    commit('arrange');
    fit();
  }

  // ---------------------------------------------------------------------------- pointer interaction
  function onPointerDown(ev) {
    if (ev.button !== 0 && ev.button !== 1) return;
    root.focus({ preventScroll: true });
    const t = ev.target;
    const nodeEl = t.closest?.('[data-node]');
    const portEl = t.closest?.('[data-port]');
    const edgeEl = t.closest?.('[data-edge]');
    // a block or arrow is drawn again below (render): without this, Safari (WebKit) sends the
    // mousedown to the removed element and moves the keyboard focus to the page (Delete did nothing)
    if (nodeEl || edgeEl) ev.preventDefault();
    const start ={ cx: ev.clientX, cy: ev.clientY, w: toWorld(ev.clientX, ev.clientY) };
    svg.setPointerCapture(ev.pointerId);
    if (ev.button === 1 || spaceDown) {
      drag = { mode: 'pan', start, tx: view.tx, ty: view.ty };
    } else if (portEl && nodeEl) {
      drag = { mode: 'connect', start, from: nodeEl.dataset.node, port: portEl.dataset.port };
      svg.classList.add('connecting');
    } else if (nodeEl) {
      const id = nodeEl.dataset.node;
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
        if (sel.nodes.has(id)) sel.nodes.delete(id); else sel.nodes.add(id);
        sel.edge = null;
        render(); renderInspector(); updateToolbar();
        drag = null;
        return;
      }
      if (!sel.nodes.has(id)) { sel = { nodes: new Set([id]), edge: null }; render(); renderInspector(); updateToolbar(); }
      drag = { mode: 'move', start, orig: new Map([...sel.nodes].map((nid) => { const n = nodeById(nid); return [nid, { x: n.x, y: n.y }]; })), moved: false };
    } else if (edgeEl) {
      sel = { nodes: new Set(), edge: edgeEl.dataset.edge };
      render(); renderInspector(); updateToolbar();
      drag = null;
    } else if (ev.shiftKey) {
      drag = { mode: 'rubber', start };
    } else {
      drag = { mode: 'pan', start, tx: view.tx, ty: view.ty, click: true };
    }
    if (drag?.mode === 'pan') svg.classList.add('panning');
  }

  function onPointerMove(ev) {
    if (!drag) return;
    const dxs = ev.clientX - drag.start.cx, dys = ev.clientY - drag.start.cy;
    const far = Math.hypot(dxs, dys) > 3;
    if (drag.mode === 'pan') {
      view.tx = drag.tx + dxs; view.ty = drag.ty + dys; applyView();
      if (far) drag.click = false;
    } else if (drag.mode === 'move') {
      if (!far && !drag.moved) return;
      drag.moved = true;
      const w = toWorld(ev.clientX, ev.clientY);
      for (const [id, o] of drag.orig) {
        const n = nodeById(id);
        n.x = snapV(o.x + w.x - drag.start.w.x);
        n.y = snapV(o.y + w.y - drag.start.w.y);
      }
      render();
    } else if (drag.mode === 'connect') {
      const a = nodeById(drag.from);
      const cur = a.type === 'case' ? M.edges.find((e) => e.from === a.id && e.port === drag.port) : null;
      const p = portGeom(a, drag.port, cur ? drawTarget(cur) : null);
      const w = toWorld(ev.clientX, ev.clientY);
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-node]');
      svg.querySelectorAll('.drop').forEach((el) => el.classList.remove('drop'));
      let target = null;
      if (over && validTarget(drag.from, over.dataset.node)) { over.classList.add('drop'); target = nodeById(over.dataset.node); }
      const pts = target ? routeEdge(a, drag.port, target, 0) : [p, { x: p.x + p.dx * 12, y: p.y + p.dy * 12 }, w];
      gOverlay.innerHTML = `<path class="asm-edge-temp" d="${pathD(pts)}" marker-end="url(#${uid}-arr-sel)"/>`;
    } else if (drag.mode === 'rubber') {
      const r = svg.getBoundingClientRect();
      const x = Math.min(ev.clientX, drag.start.cx) - r.left, y = Math.min(ev.clientY, drag.start.cy) - r.top;
      rubber.setAttribute('x', x); rubber.setAttribute('y', y);
      rubber.setAttribute('width', Math.abs(dxs)); rubber.setAttribute('height', Math.abs(dys));
      rubber.setAttribute('visibility', 'visible');
    }
  }

  function validTarget(from, to) {
    const a = nodeById(from), b = nodeById(to);
    if (!a || !b) return false;
    if (b.type === 'always') return false; // an every-cycle block has no entry
    if (from === to) return a.type === 'state';
    return true;
  }

  function onPointerUp(ev) {
    if (!drag) return;
    const d = drag;
    drag = null;
    svg.classList.remove('panning', 'connecting');
    try { svg.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    if (d.mode === 'move' && d.moved) commit('move');
    else if (d.mode === 'connect') {
      gOverlay.innerHTML = '';
      svg.querySelectorAll('.drop').forEach((el) => el.classList.remove('drop'));
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-node]');
      if (over && validTarget(d.from, over.dataset.node)) {
        const a = nodeById(d.from);
        const same = a.type === 'case' && d.port === '+' ? M.edges.find((x) => x.from === a.id && x.to === over.dataset.node && x.port !== 'others') : null;
        const label = a.type === 'case' && d.port === '+' ? nextCaseLabel(a) : d.port;
        if (label == null) flash('Every value of the case box already has an exit (edit the labels to change them)');
        else {
          let e;
          if (same && label !== 'others') { same.port = `${same.port}|${label}`; e = same; }   // one more value for the same exit
          else e = connect(d.from, label, over.dataset.node);
          sel = { nodes: new Set(), edge: e.id };
          commit('connect'); renderInspector();
        }
      } else if (!over && Math.hypot(ev.clientX - d.start.cx, ev.clientY - d.start.cy) > 30) {
        flash('Drop the connection on a box (a state, decision or conditional output)');
      }
    } else if (d.mode === 'rubber') {
      rubber.setAttribute('visibility', 'hidden');
      const a = d.start.w, b = toWorld(ev.clientX, ev.clientY);
      const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x), t = Math.min(a.y, b.y), bt = Math.max(a.y, b.y);
      for (const n of M.nodes) if (n.x >= l && n.x <= r && n.y >= t && n.y <= bt) sel.nodes.add(n.id);
      sel.edge = null;
      render(); renderInspector(); updateToolbar();
    } else if (d.mode === 'pan' && d.click) {
      if (sel.nodes.size || sel.edge) { sel = { nodes: new Set(), edge: null }; render(); renderInspector(); updateToolbar(); }
    }
  }

  function onDblClick(ev) {
    const nodeEl = ev.target.closest?.('[data-node]');
    if (nodeEl) {
      const f = selSection.querySelector('[data-focus]');
      f?.focus(); f?.select?.();
      return;
    }
    if (ev.target.closest?.('[data-edge]')) return;
    sel = { nodes: new Set(), edge: null };
    const n = addNode('state', toWorld(ev.clientX, ev.clientY));
    focusInspectorSoon(n);
  }
  function focusInspectorSoon() {
    setTimeout(() => { const f = selSection.querySelector('[data-focus]'); f?.focus(); f?.select?.(); }, 0);
  }

  function onWheel(ev) {
    ev.preventDefault();
    const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015));
    zoomAt(f, ev.clientX, ev.clientY);
  }

  const isEditable = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  function onKeyDown(ev) {
    if (isEditable(ev.target)) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key;
    if (k === ' ') { spaceDown = true; svg.classList.add('space'); ev.preventDefault(); return; }
    if (k === 'Delete' || k === 'Backspace') { deleteSelection(); ev.preventDefault(); return; }
    if (mod && (k === 'z' || k === 'Z')) { if (ev.shiftKey) redo(); else undo(); ev.preventDefault(); return; }
    if (mod && (k === 'y' || k === 'Y')) { redo(); ev.preventDefault(); return; }
    if (mod && (k === 'p' || k === 'P')) { print(); ev.preventDefault(); return; }
    if (mod && (k === 'a' || k === 'A')) { sel = { nodes: new Set(M.nodes.map((n) => n.id)), edge: null }; render(); renderInspector(); updateToolbar(); ev.preventDefault(); return; }
    if (k === 'Escape') {
      if (drag?.mode === 'connect') { drag = null; gOverlay.innerHTML = ''; svg.classList.remove('connecting'); }
      sel = { nodes: new Set(), edge: null }; render(); renderInspector(); updateToolbar(); return;
    }
    if (!mod && (k === '+' || k === '=')) { zoomBy(1.2); return; }
    if (!mod && k === '-') { zoomBy(1 / 1.2); return; }
    if (!mod && k === '0') { fit(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[k] && sel.nodes.size) {
      const step = ev.shiftKey ? 1 : GRID;
      for (const id of sel.nodes) { const n = nodeById(id); n.x += arrows[k][0] * step; n.y += arrows[k][1] * step; }
      commit('nudge'); ev.preventDefault();
    }
  }
  function onKeyUp(ev) {
    if (ev.key === ' ') { spaceDown = false; svg.classList.remove('space'); }
  }

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointercancel', onPointerUp);
  svg.addEventListener('dblclick', onDblClick);
  svg.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('keyup', onKeyUp);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (!fitted) { fitted = tryInitialFit(); } }) : null;
  let fitted = false;
  function tryInitialFit() {
    const r = svg.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return false;
    fit();
    return true;
  }
  ro?.observe(svg);

  // ---------------------------------------------------------------------------- init
  applyView();
  render();
  renderInspector();
  renderMachine();
  updateToolbar();
  runValidate();
  requestAnimationFrame(() => { if (!fitted) fitted = tryInitialFit(); });

  return {
    getModel: () => clone(M),
    setModel(m) {
      M = normalizeModel(m || newModel('fsm', 'vhdl'));
      hist = [JSON.stringify(M)]; hi = 0; lastKey = null;
      sel = { nodes: new Set(), edge: null };
      render(); renderInspector(); renderMachine(); updateToolbar(); runValidate();
      fitted = tryInitialFit();
    },
    validate: () => { runValidate(); return diags.slice(); },
    fit,
    print,
    destroy() {
      destroyed = true;
      Object.values(timers).forEach(clearTimeout);
      clearTimeout(flashTimer);
      ro?.disconnect();
      root.remove();
    },
  };
}

export default mountAsmEditor;
