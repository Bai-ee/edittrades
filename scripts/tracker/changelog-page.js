/**
 * EditTrades call tracker - "System map + changelog" page (changelog.html).
 *
 * Rendered from the engine's docs/ARCHITECTURE_MAP.json and CHANGELOG.md (synced into the
 * tracker at data/engine/ by sync.js), so the picture can only say what the map says, and
 * the engine's test:archmap keeps the map in step with the code. Pure: no fs, no network,
 * no clock (the caller passes nowMs). Same bento system as the other pages (./bento.js,
 * ./page-style.js).
 *
 * Three layers:
 *   primary   - the board (the page's one pattern break): one inline SVG, laid out here at
 *               build time, top to bottom: data sources -> feature lanes (one per stage,
 *               a column of module cards) -> the engine card (delivery modules as rows)
 *               -> outputs with delivery chips -> the GPT and tracker cards, joined by
 *               orthogonal lines from the map's flows (live 100%, context 60%, legacy 30%
 *               dashed, the tracker's scored loop dotted). Two layouts are generated,
 *               wide (>= BOARD_BREAKPOINT px) and narrow (2 columns, lines on a centre
 *               spine), and CSS shows one. A small inline script only highlights a hovered
 *               or tapped card's lines. Below it: every live module as text, and the
 *               off-path modules, both collapsed.
 *   secondary - "What the engine spits out": REST payload, MCP tool, tracker records,
 *               fields grouped by the stage that publishes them, plus current versions.
 *   tertiary  - the changelog timeline, newest first, each entry collapsed to date, title
 *               and schema/config deltas; opens to the entry body (markdown subset).
 * A consistency strip sits at the top: map version, updatedAt, last changelog date and the
 * last test:archmap run.
 */

import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav } from './bento.js';

export const NEW_DAYS = 14;
export const NO_MAP = '[NO ARCHITECTURE MAP SYNCED YET]';
export const NO_ENTRIES = '[NO CHANGELOG ENTRIES]';
export const NO_VERIFY = '[NOT VERIFIED YET]';
export const NO_CAPTURE = '[NO CAPTURE YET]';
export const NO_FIELDS = '[NO FIELDS]';
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;

/** True when `since` (YYYY-MM-DD) is within `days` days before nowMs (and not in the future). */
export function isNew(since, nowMs, days = NEW_DAYS) {
  const t = Date.parse(`${since}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - t;
  return age >= -DAY_MS && age < days * DAY_MS;
}

// ---- markdown subset: headings, lists, bold, code, links, fenced code, paragraphs ----

const SAFE_URL = /^(https?:\/\/|\.{0,2}\/|#|[\w.-]+(\/|\.html|\.md|$))/i;

export function renderInline(text) {
  const codes = [];
  let s = String(text ?? '').replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const raw = url.replace(/&amp;/g, '&');
    return SAFE_URL.test(raw) && !/^javascript:/i.test(raw) ? `<a class="nav-link" href="${esc(raw)}">${label}</a>` : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // {tag, items: [string]}
  const flushPara = () => { if (para.length) out.push(`<p>${renderInline(para.join(' '))}</p>`); para = []; };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre class="md-pre">${esc(body.join('\n'))}</pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h4 class="md-h">${renderInline(h[2])}</h4>`); continue; }
    const li = line.match(/^\s{0,3}([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flushPara();
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(li[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('');
}

// ---- changelog parsing ----

const VER = '`?\\*{0,2}`?';
const SCHEMA_DELTA = new RegExp(`schema\\s+${VER}(\\d+\\.\\d+\\.\\d+)${VER}\\s*(?:→|->)\\s*${VER}(\\d+\\.\\d+\\.\\d+)`, 'i');
const CONFIG_DELTA = new RegExp(`config(?:Version)?\\s+${VER}(\\d{4}\\.\\d{2}\\.\\d{2}-\\d+)${VER}\\s*(?:→|->)\\s*${VER}(\\d{4}\\.\\d{2}\\.\\d{2}-\\d+)`, 'i');

/**
 * Split CHANGELOG.md into entries at `## ` headings, newest date first (file order kept
 * within a date; undated entries last).
 * @returns {Array<{date: string|null, title: string, body: string, schema: {from,to}|null, config: {from,to}|null}>}
 */
export function parseChangelog(md) {
  const text = String(md ?? '').replace(/\r\n?/g, '\n');
  const parts = text.split(/^## /m).slice(1);
  const entries = parts.map((part, idx) => {
    const nl = part.indexOf('\n');
    const head = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? '' : part.slice(nl + 1).trim();
    const dm = head.match(DATE_RE);
    const date = dm ? dm[0] : null;
    const title = (date ? head.replace(date, '') : head).replace(/^[\s\-—–:[\]]+|[\s\-—–:]+$/g, '').replace(/^\[?Previous\]?\s*[-—–]?\s*$/i, 'Previous') || 'Changes';
    const sm = body.match(SCHEMA_DELTA);
    const cm = body.match(CONFIG_DELTA);
    return { idx, date, title, body, schema: sm ? { from: sm[1], to: sm[2] } : null, config: cm ? { from: cm[1], to: cm[2] } : null };
  });
  entries.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (!a.date !== !b.date) return a.date ? -1 : 1;
    return a.idx - b.idx;
  });
  return entries.map(({ idx, ...e }) => e);
}


// ---- board: model ----

export const NO_BOARD = '[NO MAP YET]';
export const BOARD_BREAKPOINT = 900;
const TIERS = ['live', 'context', 'legacy', 'loop'];
const tierOf = (t) => (TIERS.includes(t) ? t : 'context');
const stageKind = (s) => s.kind || { delivery: 'engine', tracker: 'consumer', gpt: 'consumer' }[s.id] || 'feature';
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The board's content, read from the map: data sources, one lane per feature stage, the
 * engine card (its stage's other modules become rows), outputs, consumers (their stage's
 * modules become rows) and every connecting flow. Off-path stages never appear. Optional
 * layout hints live in map.board and on stages (`kind`) and flows (`tier`); without them the
 * board is derived from the stages alone.
 * @returns {null | {sources, lanes, engine, outputs, consumers, flows}}
 */
export function boardModel(map, nowMs) {
  if (!isMap(map)) return null;
  const cfg = map.board && typeof map.board === 'object' ? map.board : {};
  const live = map.stages.filter((s) => !s.offPath && (s.modules || []).length);
  const byStage = new Map(live.map((s) => [s.id, s]));
  const legacy = new Set(cfg.legacy || []);
  const mod = (m, extra) => ({
    key: m.name, title: m.name, path: m.path, role: m.role, tests: (m.tests || []).length,
    fresh: isNew(m.since, nowMs), legacy: legacy.has(m.name), ...extra
  });

  const laneCfg = (Array.isArray(cfg.lanes) ? cfg.lanes : []).filter((l) => byStage.has(l.stage));
  for (const s of live) if (stageKind(s) === 'feature' && !laneCfg.some((l) => l.stage === s.id)) laneCfg.push({ stage: s.id });
  const lanes = laneCfg.map((l) => {
    const s = byStage.get(l.stage);
    return {
      id: s.id, title: s.title, short: String(l.short || s.title.split(/[\s&]+/)[0]).toUpperCase(),
      label: l.label || s.title, tier: tierOf(l.tier), cards: s.modules.map((m) => mod(m, { type: 'feature', lane: s.id }))
    };
  });

  const engStage = live.find((s) => stageKind(s) === 'engine');
  const engMods = engStage ? engStage.modules : [];
  const engMod = engMods.find((m) => m.name === cfg.engine) || engMods[0] || null;
  const engine = engMod
    ? { ...mod(engMod, { type: 'engine' }), title: cfg.engineTitle || engMod.name, rows: engMods.filter((m) => m !== engMod).map((m) => mod(m, { type: 'row', group: engMod.name })) }
    : null;

  const sources = (Array.isArray(cfg.sources) ? cfg.sources : []).map((s) => ({
    key: `source:${s.id}`, id: s.id, type: 'source', title: s.title, note: s.note || '', feeds: s.feeds || [], label: s.label || '', tier: tierOf(s.tier)
  }));
  const outCfg = Array.isArray(cfg.outputs) && cfg.outputs.length
    ? cfg.outputs
    : (map.outputs || []).map((o) => ({ id: slug(o.name), title: o.name, note: `${(o.fields || []).length} fields`, delivery: [o.where], label: o.where }));
  const outputs = outCfg.map((o) => ({
    key: `output:${o.id}`, id: o.id, type: 'output', title: o.title, note: o.note || '', delivery: o.delivery || [], label: o.label || '', tier: tierOf(o.tier)
  }));
  const consCfg = (Array.isArray(cfg.consumers) ? cfg.consumers : []).filter((c) => byStage.has(c.stage));
  for (const s of live) {
    if (stageKind(s) === 'consumer' && !consCfg.some((c) => c.stage === s.id)) consCfg.push({ id: s.id, stage: s.id, title: s.title, note: s.purpose, chip: s.title });
  }
  const consumers = consCfg.map((c) => {
    const key = `consumer:${c.id}`;
    return { key, id: c.id, type: 'consumer', title: c.title, note: c.note || '', chip: c.chip || c.title, rows: byStage.get(c.stage).modules.map((m) => mod(m, { type: 'row', group: key })) };
  });

  const onBoard = new Set([
    ...lanes.flatMap((l) => l.cards.map((c) => c.key)),
    ...(engine ? [engine.key, ...engine.rows.map((r) => r.key)] : []),
    ...consumers.flatMap((c) => c.rows.map((r) => r.key))
  ]);
  const flows = [];
  const add = (from, to, label, tier, extra = {}) => flows.push({ from, to, label, tier, fromKeys: [from], ...extra });
  for (const s of sources) for (const f of s.feeds) if (onBoard.has(f)) add(s.key, f, s.label, s.tier);
  const mapFlows = (Array.isArray(map.flows) ? map.flows : []).filter((f) => onBoard.has(f.from) && onBoard.has(f.to));
  for (const f of mapFlows) add(f.from, f.to, f.label, tierOf(f.tier));
  if (engine) {
    for (const l of lanes) {
      const keys = l.cards.map((c) => c.key);
      if (!mapFlows.some((f) => keys.includes(f.from) && f.to === engine.key)) add(`lane:${l.id}`, engine.key, l.label, l.tier, { fromKeys: keys });
    }
    for (const o of outputs) add(engine.key, o.key, o.label, o.tier);
  }
  for (const o of outputs) for (const c of consumers) if (o.delivery.includes(c.chip)) add(o.key, c.key, '', o.tier);
  for (const lp of Array.isArray(cfg.loops) ? cfg.loops : []) {
    const a = consumers.find((c) => c.id === lp.from);
    const b = outputs.find((o) => o.id === lp.to);
    if (a && b) add(a.key, b.key, lp.label || '', 'loop');
  }
  const seen = new Map();
  for (const f of flows) {
    const base = `flow-${slug(f.from)}-${slug(f.to)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    f.id = n > 1 ? `${base}-${n}` : base;
  }
  return { sources, lanes, engine, outputs, consumers, flows };
}

// ---- board: layout ----

const LAYOUTS = {
  wide: { W: 1088, M: 20, G: 20, gutter: 4, roleLines: 4, name: 14, cwName: 7.8, cwRole: 6.5, cwLabel: 6.9, cwRow: 6.2, lineH: 15, prefix: 'board-' },
  narrow: { W: 360, M: 14, S: 44, G: 12, gutter: 4, roleLines: 3, name: 13, cwName: 7.3, cwRole: 6, cwLabel: 6.9, cwRow: 6.2, lineH: 14, prefix: 'board-narrow-' }
};
const P = 10; // card padding
const ROW_H = 20;
const STRIP = 14; // bracket strip left of each row column

function fit(text, maxW, cw) {
  const s = String(text ?? '');
  const max = Math.max(1, Math.floor(maxW / cw));
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function wrap(text, maxW, cw, maxLines) {
  const max = Math.max(4, Math.floor(maxW / cw));
  const lines = [];
  let cur = '';
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w.length > max ? `${w.slice(0, max - 1)}…` : w;
    if (lines.length === maxLines) { cur = ''; break; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines || (lines.length === maxLines && words.join(' ').length > lines.join(' ').length)) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, max - 1).replace(/[\s,.;:]+$/, '')}…`;
  }
  return lines;
}

const off = (k) => (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2));
function channel(center, spacing, max) { return { center, spacing, max, used: [], n: 0 }; }
function take(ch, a, b) {
  const lo = Math.min(a, b) - 4;
  const hi = Math.max(a, b) + 4;
  for (let k = 0; k < ch.max; k++) {
    const t = ch.used[k] || (ch.used[k] = []);
    if (t.every(([p, q]) => hi < p || lo > q)) { t.push([lo, hi]); return ch.center + off(k) * ch.spacing; }
  }
  return ch.center + off(ch.n++ % ch.max) * ch.spacing;
}

/** Order rows so every internal chain stays in one column, then split into columns. */
function packColumns(rows, flows, nCols) {
  const keys = new Set(rows.map((r) => r.key));
  const edges = flows.filter((f) => keys.has(f.from) && keys.has(f.to));
  const hasIn = new Set(edges.map((e) => e.to));
  const seen = new Set();
  const comps = [];
  const visit = (r, comp) => {
    if (seen.has(r.key)) return;
    seen.add(r.key);
    comp.push(r);
    for (const e of edges) if (e.from === r.key) visit(rows.find((x) => x.key === e.to), comp);
  };
  for (const r of rows) if (!hasIn.has(r.key) && !seen.has(r.key)) { const c = []; visit(r, c); comps.push(c); }
  for (const r of rows) if (!seen.has(r.key)) { const c = []; visit(r, c); comps.push(c); }
  const per = Math.ceil(rows.length / nCols);
  const cols = [[]];
  for (const comp of comps) {
    const cur = cols[cols.length - 1];
    if (cur.length && cur.length + comp.length > per && cols.length < nCols) cols.push([...comp]);
    else cur.push(...comp);
  }
  return cols;
}

/** Delivery chips laid out left to right, wrapping to a new line when the card is full. */
function chipRows(delivery, x0, inner, cw) {
  const out = [];
  let x = x0;
  let line = 0;
  for (const d of delivery) {
    const text = String(d).toUpperCase();
    const w = text.length * cw + 10;
    if (x > x0 && x + w > x0 + inner) { x = x0; line++; }
    out.push({ text, x, w, line });
    x += w + 4;
  }
  return out;
}

/** Card text blocks and height; `w` is the card width. */
function sizeCard(n, w, L, kind) {
  const inner = w - 2 * P;
  const text = n.type === 'feature' || n.type === 'engine' ? n.role : n.note;
  const maxLines = n.type === 'feature' ? L.roleLines : n.type === 'engine' ? L.roleLines + 1 : 2;
  const lines = text ? wrap(text, inner, L.cwRole, maxLines) : [];
  let h = 58 + Math.max(0, lines.length - 1) * L.lineH + 8;
  if (n.type === 'feature' || n.type === 'engine') h += 16; // tests meta
  if (kind === 'output') h += 26 + 20 * Math.max(0, ...chipRows(n.delivery, 0, inner, L.cwLabel).map((c) => c.line)); // delivery chips
  return { lines, h: Math.max(h, 66) };
}

/**
 * Place every card and route every flow for one layout ('wide' or 'narrow').
 * @returns {{W, H, L, nodes: Map, cards: Array, groups: Array, heads: Array, lanesHead: Array, lines: Array, labels: Array}}
 */
export function layoutBoard(model, mode = 'wide') {
  const L = LAYOUTS[mode];
  const wide = mode === 'wide';
  const { W, M } = L;
  const nodes = new Map();
  const cards = [];
  const groups = [];
  const heads = [];
  const laneHeads = [];
  const boxes = []; // obstacles for labels: [x, y, w, h]
  const put = (n, x, y, w, h, extra = {}) => {
    const rec = { ...n, x, y, w, h, cx: x + w / 2, slots: { left: 0, right: 0, top: 0 }, ...extra };
    nodes.set(n.key, rec);
    boxes.push([x, y, w, h]);
    return rec;
  };
  const rowHead = (y, num, title, meta) => { heads.push({ y, text: `${num} · ${title}`.toUpperCase(), meta: String(meta).toUpperCase() }); const mw = String(meta).length * L.cwLabel + 8; boxes.push([M, y - 12, 150, 16], [W - M - mw, y - 12, mw, 16]); };
  let y = 18;

  // 01 data in
  rowHead(y, '01', 'Data in', `${model.sources.length} sources`);
  y += 12;
  const colW = wide ? 0 : (W - 2 * M - L.S) / 2;
  const colX = (c) => (c === 0 ? M : W - M - colW);
  const gridRow = (items, kind, top) => {
    if (!items.length) return top;
    if (wide) {
      const w = (W - 2 * M - (items.length - 1) * L.G) / items.length;
      const sized = items.map((n) => sizeCard(n, w, L, kind));
      const h = Math.max(...sized.map((s) => s.h));
      items.forEach((n, i) => cards.push(put(n, M + i * (w + L.G), top, w, h, { lines: sized[i].lines, idx: i, count: items.length })));
      return top + h;
    }
    let yy = top;
    for (let i = 0; i < items.length; i += 2) {
      const pair = items.slice(i, i + 2);
      const sized = pair.map((n) => sizeCard(n, colW, L, kind));
      const h = Math.max(...sized.map((s) => s.h));
      pair.forEach((n, j) => cards.push(put(n, colX(j), yy, colW, h, { lines: sized[j].lines, col: j, idx: i + j, count: items.length })));
      yy += h + (i + 2 < items.length ? L.G : 0);
    }
    return yy;
  };
  y = gridRow(model.sources, 'source', y);
  const srcBottom = y;
  const bandTop = { y: y + 8, h: wide ? 64 : 0 };
  y += wide ? bandTop.h + 16 : 36;

  // 02 features
  const nMods = model.lanes.reduce((k, l) => k + l.cards.length, 0);
  rowHead(y, '02', 'Features', `${model.lanes.length} lanes · ${nMods} modules`);
  y += 22;
  const laneRec = [];
  const placeLane = (lane, li, x, w, top) => {
    laneHeads.push({ x, y: top, w, text: fit(lane.title.toUpperCase(), w - 24, L.cwLabel), count: lane.cards.length, id: lane.id });
    let yy = top + 14;
    lane.cards.forEach((c, k) => {
      const s = sizeCard(c, w, L, 'feature');
      cards.push(put(c, x, yy, w, s.h, { lines: s.lines, li, k, short: lane.short, col: wide ? undefined : li % 2 }));
      yy += s.h + 16;
    });
    laneRec[li] = { x, w, cx: x + w / 2, bottom: yy - 16, last: lane.cards[lane.cards.length - 1].key };
    return yy - 16;
  };
  let featBottom = y;
  if (wide) {
    const n = model.lanes.length || 1;
    const lw = (W - 2 * M - (n - 1) * L.G) / n;
    model.lanes.forEach((lane, li) => { featBottom = Math.max(featBottom, placeLane(lane, li, M + li * (lw + L.G), lw, y)); });
  } else {
    for (let i = 0; i < model.lanes.length; i += 2) {
      let pairBottom = y;
      model.lanes.slice(i, i + 2).forEach((lane, j) => { pairBottom = Math.max(pairBottom, placeLane(lane, i + j, colX(j), colW, y)); });
      featBottom = pairBottom;
      y = pairBottom + 28;
    }
  }
  y = featBottom + (wide ? 56 : 40);

  // 03 engine
  const groupCard = (n, x, top, w, nCols, headW, rowFlows, subLabel) => {
    const lines = wrap(n.type === 'engine' ? n.role : n.note, headW - 2 * P, L.cwRole, n.type === 'engine' ? L.roleLines : 2);
    const headH = 58 + Math.max(0, lines.length - 1) * L.lineH + 8 + (n.type === 'engine' ? 16 : 0);
    const split = headW < w; // rows to the right of the head (wide engine)
    const rowsX = split ? x + headW : x;
    const rowsW = split ? w - headW : w;
    const rowsTop = split ? top + 30 : top + headH + 26;
    const cols = packColumns(n.rows, model.flows, nCols);
    const cw = (rowsW - P) / nCols;
    let maxRows = 0;
    const rowRecs = [];
    cols.forEach((col, ci) => {
      maxRows = Math.max(maxRows, col.length);
      col.forEach((r, ri) => {
        const rx = rowsX + P + ci * cw + STRIP;
        rowRecs.push({ ...r, x: rx, y: rowsTop + ri * ROW_H, w: cw - STRIP - 6, h: ROW_H, cx: rx + (cw - STRIP) / 2, mid: rowsTop + ri * ROW_H + ROW_H / 2, ci, group: n.key });
      });
    });
    const h = Math.max(split ? headH : 0, (split ? 30 : headH + 26) + maxRows * ROW_H + 14);
    const rec = put(n, x, top, w, h, { lines, headW, split, rowsX, rowsTop, rowsBottom: rowsTop + maxRows * ROW_H, subLabel, full: true });
    rec.strips = cols.map((_, ci) => channel(rowsX + P + ci * cw + STRIP / 2, 3, 3));
    for (const r of rowRecs) { r.card = rec; nodes.set(r.key, r); }
    rec.rows = rowRecs;
    groups.push(rec);
    return top + h;
  };
  if (model.engine) {
    rowHead(y, '03', 'Engine', `1 build · ${model.engine.rows.length} delivery modules`);
    y += 12;
    const w = W - 2 * M;
    y = groupCard(model.engine, M, y, w, 2, wide ? Math.round(w * 0.36) : w, model.flows, `Served by · ${model.engine.rows.length}`);
  }
  const engine = model.engine ? nodes.get(model.engine.key) : null;
  const bandO = { y: y + 8 };
  y += wide ? 60 : 40;

  // 04 out
  rowHead(y, '04', 'Out', `${model.outputs.length} outputs`);
  y += 12;
  y = gridRow(model.outputs, 'output', y);
  const outBottom = y;
  const bandC = { y: y + 8, h: wide ? 56 : 0 };
  y += wide ? bandC.h + 20 : 40;

  // 05 consumers
  if (model.consumers.length) {
    rowHead(y, '05', 'Consumers', model.consumers.map((c) => c.title).join(' · '));
    y += 12;
    if (wide) {
      const colsOf = model.consumers.map((c) => Math.min(3, Math.max(1, Math.ceil(c.rows.length / 7))));
      const total = colsOf.reduce((a, b) => a + b, 0);
      const avail = W - 2 * M - (model.consumers.length - 1) * L.G;
      let x = M;
      let bottom = y;
      model.consumers.forEach((c, i) => {
        const w = (avail * colsOf[i]) / total;
        bottom = Math.max(bottom, groupCard(c, x, y, w, colsOf[i], w, model.flows, `${c.rows.length} modules`));
        x += w + L.G;
      });
      y = bottom;
    } else {
      model.consumers.forEach((c, i) => { y = groupCard(c, M, y, W - 2 * M, 2, W - 2 * M, model.flows, `${c.rows.length} modules`) + (i < model.consumers.length - 1 ? 16 : 0); });
    }
  }
  const consBottom = y;
  y += 36;
  const H = Math.ceil(y);

  // ---- routing ----
  const lines = [];
  const labels = [];
  const n = model.lanes.length;
  const lanesXs = laneRec.map((r) => r.x);
  const gutters = wide
    ? Array.from({ length: n + 1 }, (_, g) => channel(g === 0 ? M / 2 : g === n ? W - M / 2 : lanesXs[g] - L.G / 2, L.gutter, g === 0 || g === n ? 4 : 5))
    : [];
  const railL = channel(wide ? M / 2 : M / 2, wide ? 4 : 3, wide ? 4 : 3);
  const railR = channel(wide ? W - M / 2 : W - M / 2, wide ? 4 : 3, wide ? 4 : 3);
  if (wide) { gutters[0] = railL; gutters[n] = railR; }
  const spine = channel(W / 2, 4, 9);
  const top = channel(bandTop.y + bandTop.h / 2, 5, 11);
  const busC = channel(bandC.y + (bandC.h || 20) / 2, 5, 9);
  const busBottom = channel(consBottom + 18, 4, 3);
  const slot = (c, side) => {
    const i = c.slots[side]++;
    return Math.min(c.y + c.h - 10, c.y + 24 + i * 8);
  };
  const isRow = (x) => x && x.type === 'row';
  const groupOf = (x) => (isRow(x) ? x.card : x);
  const yOf = (x) => (isRow(x) ? x.mid : x.y + 22);

  const bracket = (a, b) => {
    const card = groupOf(b);
    const aRow = isRow(a);
    const y1 = aRow ? a.mid : card.rowsTop - 6;
    if (aRow && a.ci !== b.ci) {
      const yb = card.rowsBottom + 6;
      const s1 = take(card.strips[a.ci], y1, yb);
      const s2 = take(card.strips[b.ci], yb, b.mid);
      return [[a.x - 2, y1], [s1, y1], [s1, yb], [s2, yb], [s2, b.mid], [b.x - 2, b.mid]];
    }
    const sx = take(card.strips[b.ci], y1, b.mid);
    return aRow ? [[a.x - 2, y1], [sx, y1], [sx, b.mid], [b.x - 2, b.mid]] : [[sx, y1], [sx, b.mid], [b.x - 2, b.mid]];
  };
  const elbow = (a, b) => {
    const y1 = a.y + a.h;
    const my = (y1 + b.y) / 2;
    return [[a.cx, y1], [a.cx, my], [b.cx, my], [b.cx, b.y]];
  };

  const routeWide = (f, a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga && gb && ga === gb && gb.full) return bracket(a, b);
    if (f.from.startsWith('lane:')) return [[a.cx, a.bottom], [a.cx, engine.y]];
    if (a.type === 'source' && b.type === 'feature') {
      const sx = a.cx + (a.fed = (a.fed ?? -1) + 1) * 6;
      const ty = slot(b, 'left');
      const gx0 = gutters[b.li].center;
      const by = take(top, sx, gx0);
      const gx = take(gutters[b.li], by, ty);
      return [[sx, a.y + a.h], [sx, by], [gx, by], [gx, ty], [b.x, ty]];
    }
    if (a.type === 'source') {
      const right = gb === engine ? a.cx > W / 2 : gb.x + gb.w > W - M - 1;
      const rail = right ? railR : railL;
      const sx = a.cx + (a.fed = (a.fed ?? -1) + 1) * 6;
      const by = take(top, sx, rail.center);
      const ty = yOf(b);
      const rx = take(rail, by, ty);
      return [[sx, a.y + a.h], [sx, by], [rx, by], [rx, ty], [right ? gb.x + gb.w : gb.x, ty]];
    }
    if (a.type === 'feature' && b.type === 'feature') {
      const li = a.li;
      const tl = b.li;
      if (li === tl && b.k === a.k + 1) return [[a.cx, a.y + a.h], [b.cx, b.y]];
      if (li === tl) {
        const y1 = slot(a, 'right');
        const y2 = slot(b, 'right');
        const gx = take(gutters[li + 1], y1, y2);
        return [[a.x + a.w, y1], [gx, y1], [gx, y2], [b.x + b.w, y2]];
      }
      const fwd = tl > li;
      const y1 = slot(a, fwd ? 'right' : 'left');
      const y2 = slot(b, fwd ? 'left' : 'right');
      const x1 = fwd ? a.x + a.w : a.x;
      const x2 = fwd ? b.x : b.x + b.w;
      const g1 = fwd ? li + 1 : li;
      const g2 = fwd ? tl : tl + 1;
      if (g1 === g2) {
        const gx = take(gutters[g1], y1, y2);
        return [[x1, y1], [gx, y1], [gx, y2], [x2, y2]];
      }
      const by = take(top, gutters[g1].center, gutters[g2].center);
      const gx1 = take(gutters[g1], by, y1);
      const gx2 = take(gutters[g2], by, y2);
      return [[x1, y1], [gx1, y1], [gx1, by], [gx2, by], [gx2, y2], [x2, y2]];
    }
    if (a.type === 'feature' && gb === engine) {
      const right = a.li < n - 1;
      const y1 = slot(a, right ? 'right' : 'left');
      const gx = take(gutters[right ? a.li + 1 : a.li], y1, engine.y);
      return [[right ? a.x + a.w : a.x, y1], [gx, y1], [gx, engine.y]];
    }
    if (a === engine && b.type === 'output') return [[b.cx, engine.y + engine.h], [b.cx, b.y]];
    if (a.type === 'output' && b.type === 'consumer') {
      const k = (a.fed = (a.fed ?? -1) + 1);
      const sx = a.cx - 6 + k * 12;
      if (sx >= b.x + 14 && sx <= b.x + b.w - 14) return [[sx, a.y + a.h], [sx, b.y]];
      const fromLeft = sx < b.x;
      const i = b.slots.top++;
      const tx = fromLeft ? b.x + 16 + i * 10 : b.x + b.w - 16 - i * 10;
      const by = take(busC, sx, tx);
      return [[sx, a.y + a.h], [sx, by], [tx, by], [tx, b.y]];
    }
    if (ga === engine && gb && gb.type === 'consumer') {
      const right = gb.x + gb.w > W - M - 1;
      const y1 = yOf(a);
      const y2 = yOf(b);
      const rx = take(right ? railR : railL, y1, y2);
      return [[right ? engine.x + engine.w : engine.x, y1], [rx, y1], [rx, y2], [right ? gb.x + gb.w : gb.x, y2]];
    }
    if (a.type === 'consumer' && b.type === 'output' && (b.idx === 0 || b.idx === b.count - 1)) {
      const left = b.idx === 0;
      const by = take(busBottom, a.cx, left ? M : W - M);
      const ty = slot(b, left ? 'left' : 'right');
      const rx = take(left ? railL : railR, by, ty);
      return [[a.cx, a.y + a.h], [a.cx, by], [rx, by], [rx, ty], [left ? b.x : b.x + b.w, ty]];
    }
    return elbow(ga || a, gb || b);
  };

  const fullCards = [...groups];
  const routeNarrow = (f, a, b) => {
    const ga = groupOf(a);
    const gb = groupOf(b);
    if (ga && gb && ga === gb && gb.full) return bracket(a, b);
    let src = a;
    if (f.from.startsWith('lane:')) src = nodes.get(a.last);
    if (src.type === 'feature' && b.type === 'feature' && src.li === b.li && b.k === src.k + 1) return [[src.cx, src.y + src.h], [b.cx, b.y]];
    const gs = groupOf(src);
    const full = (x) => !!(groupOf(x) && groupOf(x).full);
    const down = (gb.y + (full(b) ? 0 : b.h / 2)) > (gs.y + (full(src) ? 0 : gs.h / 2));
    const y1 = full(src) ? (down ? gs.y + gs.h : gs.y) : f.from.startsWith('lane:') ? src.y + src.h - 12 : slot(src, src.col === 0 ? 'right' : 'left');
    const y2 = full(b) ? (down ? gb.y : gb.y + gb.h) : slot(b, b.col === 0 ? 'right' : 'left');
    const lo = Math.min(y1, y2);
    const hi = Math.max(y1, y2);
    const blocked = fullCards.some((c) => c !== gs && c !== gb && c.y < hi && c.y + c.h > lo);
    if (!blocked) {
      const x = take(spine, y1, y2);
      const pts = [];
      if (!full(src)) pts.push([src.col === 0 ? src.x + src.w : src.x, y1]);
      pts.push([x, y1], [x, y2]);
      if (!full(b)) pts.push([b.col === 0 ? b.x + b.w : b.x, y2]);
      return pts;
    }
    const col = !full(src) ? src.col : !full(b) ? b.col : 0;
    const right = col === 1;
    const ay = full(src) ? yOf(src) : y1;
    const by = full(b) ? yOf(b) : y2;
    const rx = take(right ? railR : railL, ay, by);
    const edge = (x) => (right ? groupOf(x).x + groupOf(x).w : groupOf(x).x);
    return [[edge(src), ay], [rx, ay], [rx, by], [edge(b), by]];
  };

  for (const f of model.flows) {
    const a = f.from.startsWith('lane:') ? laneRec[model.lanes.findIndex((l) => `lane:${l.id}` === f.from)] : nodes.get(f.from);
    const b = nodes.get(f.to);
    if (!a || !b) continue;
    const pts = (wide ? routeWide : routeNarrow)(f, a, b);
    const g1 = groupOf(a);
    lines.push({ ...f, pts, internal: !!(g1 && g1 === groupOf(b) && g1.full) });
    if (!wide || !f.label) continue;
    // labels on the buses (wide only): near the source, above the engine, above each output, on the loop
    const lab = f.label.toUpperCase();
    const [x0, y0] = pts[0];
    const [xe, ye] = pts[pts.length - 1];
    if (a.type === 'source') {
      if (!labels.some((l) => l.key === a.key)) labels.push({ key: a.key, text: lab, cands: [[x0 + 5, y0 + 13], [x0 + 5, y0 + 24], [x0 - 5, y0 + 13, 'end']] });
    } else if (b === engine) labels.push({ key: f.id, text: lab, cands: [[xe + 5, ye - 8], [xe + 5, ye - 20], [xe + 5, ye - 32], [xe - 5, ye - 8, 'end'], [xe - 5, ye - 20, 'end'], [xe + 5, ye - 44]] });
    else if (b.type === 'output') labels.push({ key: f.id, text: lab, cands: [[xe + 5, ye - 8], [xe + 5, ye - 20], [xe + 5, ye - 32]] });
    else if (f.tier === 'loop') { const [xa, ya] = pts[2] || pts[1]; labels.push({ key: f.id, text: lab, cands: [[(x0 + xa) / 2, ya - 5, 'middle'], [(x0 + xa) / 2, ya + 12, 'middle']] }); }
  }
  const placed = [];
  const hit = ([x, y, w, h], [X, Y, Wd, Hd]) => x < X + Wd && x + w > X && y < Y + Hd && y + h > Y;
  for (const l of labels) {
    const w = l.text.length * L.cwLabel + 6;
    for (const [cx, cy, anchor = 'start'] of l.cands) {
      const bx = anchor === 'end' ? cx - w + 3 : anchor === 'middle' ? cx - w / 2 : cx - 3;
      const box = [bx, cy - 10, w, 13];
      if (bx < 0 || bx + w > W || boxes.some((o) => hit(box, o)) || placed.some((p) => hit(box, p.box))) continue;
      placed.push({ ...l, x: cx, y: cy, anchor, box });
      break;
    }
  }
  return { W, H, L, mode, nodes, cards, groups, heads, laneHeads, lines, labels: placed, srcBottom, outBottom };
}

// ---- board: SVG ----

const r1 = (v) => Math.round(v * 2) / 2;
const pathD = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join('');
function arrowHead(pts) {
  const [x2, y2] = pts[pts.length - 1];
  const [x1, y1] = pts[pts.length - 2];
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const s = 5;
  const bx = x2 - ux * s;
  const by = y2 - uy * s;
  return `M${r1(x2)} ${r1(y2)}L${r1(bx - uy * 3)} ${r1(by + ux * 3)}L${r1(bx + uy * 3)} ${r1(by - ux * 3)}Z`;
}

const newPill = (x, y) => `<g class="new-pill"><rect x="${r1(x)}" y="${r1(y - 9)}" width="28" height="12" rx="2"/><text class="t-pill" x="${r1(x + 14)}" y="${r1(y)}" text-anchor="middle">NEW</text></g>`;

function cardSvg(c, L) {
  const id = `${L.prefix}card-${slug(c.key)}`;
  const x = c.x + P;
  let label;
  let meta = '';
  if (c.type === 'feature') { label = c.short; meta = c.tests ? `${c.tests} TEST${c.tests === 1 ? '' : 'S'}` : 'NO TESTS'; }
  else if (c.type === 'source') label = 'SOURCE';
  else if (c.type === 'output') label = `OUT · ${c.tier === 'live' ? 'LIVE' : c.tier === 'legacy' ? 'LEGACY' : 'CONTEXT'}`;
  else if (c.type === 'engine') { label = `ENGINE · ${c.path}`.toUpperCase(); meta = c.tests ? `${c.tests} TEST${c.tests === 1 ? '' : 'S'}` : 'NO TESTS'; }
  else label = 'CONSUMER';
  const headW = c.full ? c.headW : c.w;
  const labelW = (c.fresh ? headW - 2 * P - 34 : headW - 2 * P);
  const labelText = fit(label, labelW, L.cwLabel);
  const nameW = headW - 2 * P;
  const est = String(c.title).length * L.cwName;
  const squeeze = est > nameW ? ` textLength="${r1(nameW)}" lengthAdjust="spacingAndGlyphs"` : '';
  const tip = [c.title, c.path, c.role || c.note].filter(Boolean).join(' — ');
  let s = `<g class="board-card kind-${c.type}${c.legacy || c.tier === 'legacy' ? ' is-legacy' : ''}" id="${id}" data-card="${esc(c.key)}" data-new="${!!c.fresh}" tabindex="0">`
    + `<title>${esc(tip)}</title>`
    + `<rect class="card-box" x="${r1(c.x)}" y="${r1(c.y)}" width="${r1(c.w)}" height="${r1(c.h)}" rx="6"/>`
    + `<text class="t-label" x="${r1(x)}" y="${r1(c.y + 20)}">${esc(labelText)}</text>`
    + (c.fresh ? newPill(x + labelText.length * L.cwLabel + 6, c.y + 20) : '')
    + `<text class="t-name" x="${r1(x)}" y="${r1(c.y + 40)}"${squeeze}>${esc(c.title)}</text>`;
  c.lines.forEach((ln, i) => { s += `<text class="t-role" x="${r1(x)}" y="${r1(c.y + 58 + i * L.lineH)}">${esc(ln)}</text>`; });
  const afterText = c.y + 58 + Math.max(0, c.lines.length - 1) * L.lineH;
  if (meta) s += `<text class="t-meta" x="${r1(x)}" y="${r1(afterText + 20)}">${meta}</text>`;
  if (c.type === 'output') {
    const chips = chipRows(c.delivery, x, c.w - 2 * P, L.cwLabel);
    const last = Math.max(0, ...chips.map((ch) => ch.line));
    for (const ch of chips) {
      const cy = c.y + c.h - 26 - (last - ch.line) * 20;
      s += `<g class="chip-d"><rect x="${r1(ch.x)}" y="${r1(cy)}" width="${r1(ch.w)}" height="16" rx="8"/><text class="t-label t-chip" x="${r1(ch.x + ch.w / 2)}" y="${r1(cy + 11.5)}" text-anchor="middle">${esc(ch.text)}</text></g>`;
    }
  }
  if (c.full) {
    if (c.split) s += `<path class="card-rule" d="M${r1(c.x + c.headW)} ${r1(c.y + P)}V${r1(c.y + c.h - P)}"/>`;
    const subX = c.split ? c.rowsX + P : x;
    s += `<text class="t-label" x="${r1(subX)}" y="${r1(c.rowsTop - 10)}">${esc(String(c.subLabel).toUpperCase())}</text>`;
  }
  return `${s}</g>`;
}

function rowSvg(r, L) {
  const id = `${L.prefix}card-${slug(r.key)}`;
  const maxW = r.w - (r.fresh ? 34 : 0);
  const name = fit(r.title, maxW, L.cwRow);
  return `<g class="board-row${r.legacy ? ' is-legacy' : ''}" id="${id}" data-card="${esc(r.key)}" data-new="${!!r.fresh}" tabindex="0">`
    + `<title>${esc([r.title, r.path, r.role].join(' — '))}</title>`
    + `<rect class="row-hit" x="${r1(r.x - 4)}" y="${r1(r.y + 1)}" width="${r1(r.w + 4)}" height="${ROW_H - 2}" rx="3"/>`
    + `<text class="t-row" x="${r1(r.x)}" y="${r1(r.y + 14)}">${esc(name)}</text>`
    + (r.fresh ? newPill(r.x + name.length * L.cwRow + 6, r.y + 14) : '')
    + '</g>';
}

/** One board SVG ('wide' or 'narrow'). */
export function renderBoardSvg(model, mode) {
  const lay = layoutBoard(model, mode);
  const { W, H, L } = lay;
  const flowSvg = (f) => `<g class="flow tier-${f.tier}" id="${L.prefix}${f.id}" data-from="${esc(f.fromKeys.join('|'))}" data-to="${esc(f.to)}">`
    + `<title>${esc(`${f.from.replace(/^\w+:/, '')} → ${f.to.replace(/^\w+:/, '')}${f.label ? `: ${f.label}` : ''}`)}</title>`
    + `<path class="flow-line" d="${pathD(f.pts)}"/><path class="flow-head" d="${arrowHead(f.pts)}"/></g>`;
  const flows = lay.lines.filter((f) => !f.internal).map(flowSvg).join('');
  const inner = lay.lines.filter((f) => f.internal).map(flowSvg).join('');
  const knock = (x, y, w) => `<rect class="knock" x="${r1(x)}" y="${r1(y - 10)}" width="${r1(w)}" height="13"/>`;
  const heads = lay.heads.map((h, i) => {
    const w = h.text.length * L.cwLabel + 8;
    const mw = h.meta.length * L.cwLabel + 8;
    return `<g class="board-rowhead" id="${L.prefix}row-${i + 1}">${knock(L.M - 4, h.y, w)}<text class="t-label t-strong" x="${L.M}" y="${h.y}">${esc(h.text)}</text>`
      + `${knock(W - L.M - mw + 4, h.y, mw)}<text class="t-label" x="${W - L.M}" y="${h.y}" text-anchor="end">${esc(h.meta)}</text></g>`;
  }).join('');
  const laneHeads = lay.laneHeads.map((h) => `<g class="board-lanehead" id="${L.prefix}lane-${slug(h.id)}"><text class="t-label t-strong" x="${r1(h.x)}" y="${r1(h.y + 2)}">${esc(h.text)}</text>`
    + `<text class="t-label" x="${r1(h.x + h.w)}" y="${r1(h.y + 2)}" text-anchor="end">${h.count}</text></g>`).join('');
  const labels = lay.labels.map((l) => `<g class="flow-label">${knock(l.box[0], l.y, l.box[2])}<text class="t-label t-bus" x="${r1(l.x)}" y="${r1(l.y)}"${l.anchor === 'start' ? '' : ` text-anchor="${l.anchor}"`}>${esc(l.text)}</text></g>`).join('');
  const cards = [...lay.cards, ...lay.groups].map((c) => cardSvg(c, L)).join('')
    + lay.groups.flatMap((g) => g.rows).map((r) => rowSvg(r, L)).join('');
  return `<svg class="board board-${mode}" id="map-board-${mode}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="System board, ${mode} layout" data-layout="${mode}">`
    + `<g class="board-flows">${flows}</g><g class="board-heads">${heads}${laneHeads}</g><g class="board-labels">${labels}</g><g class="board-cards">${cards}</g><g class="board-flows-inner">${inner}</g></svg>`;
}

const LEGEND = '<div class="board-legend" id="map-board-legend">'
  + '<span class="legend-item"><svg viewBox="0 0 28 8" aria-hidden="true"><path d="M0 4H28" class="lg-live"/></svg>Live call path</span>'
  + '<span class="legend-item"><svg viewBox="0 0 28 8" aria-hidden="true"><path d="M0 4H28" class="lg-context"/></svg>Context</span>'
  + '<span class="legend-item"><svg viewBox="0 0 28 8" aria-hidden="true"><path d="M0 4H28" class="lg-legacy"/></svg>Legacy / shadow</span>'
  + '<span class="legend-item"><svg viewBox="0 0 28 8" aria-hidden="true"><path d="M0 4H28" class="lg-loop"/></svg>Scored loop</span>'
  + '<span class="legend-item legend-hint">Hover or tap a card to trace its lines</span></div>';

// Hover / tap: a card's lines go to 100%, the rest dim. The drawing itself needs no script.
const BOARD_SCRIPT = `(() => {
  for (const svg of document.querySelectorAll('svg.board')) {
    const flows = [...svg.querySelectorAll('.flow')];
    const cards = [...svg.querySelectorAll('[data-card]')];
    let pinned = null;
    const clear = () => {
      svg.classList.remove('is-focus');
      for (const el of svg.querySelectorAll('.is-on')) el.classList.remove('is-on');
    };
    const light = (key) => {
      clear();
      svg.classList.add('is-focus');
      const linked = new Set([key]);
      for (const f of flows) {
        const ends = [...f.dataset.from.split('|'), f.dataset.to];
        if (!ends.includes(key)) continue;
        f.classList.add('is-on');
        for (const e of ends) linked.add(e);
      }
      for (const c of cards) if (linked.has(c.dataset.card)) c.classList.add('is-on');
    };
    for (const c of cards) {
      const key = c.dataset.card;
      c.addEventListener('pointerenter', () => { if (!pinned) light(key); });
      c.addEventListener('pointerleave', () => { if (!pinned) clear(); });
      c.addEventListener('focus', () => light(key));
      c.addEventListener('blur', () => { if (!pinned) clear(); });
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        pinned = pinned === key ? null : key;
        if (pinned) light(key); else clear();
      });
    }
    svg.addEventListener('click', () => { pinned = null; clear(); });
  }
})();`;

// ---- page ----

const CHANGELOG_CSS = `
/* system map page */
.consistency-strip{display:flex;flex-wrap:wrap;gap:var(--sp-1) var(--sp-4);padding:var(--sp-3) 0;border-bottom:1px solid var(--border);font:400 var(--fs-sm)/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.consistency-strip b{font-weight:400;color:var(--text-display)}
#map-intro-title{margin:0;font:500 clamp(32px,8vw,56px)/1.05 var(--grotesk);letter-spacing:-.02em;color:var(--text-display)}

/* board: the page's one pattern break */
.board-wrap{grid-column:1 / -1;min-width:0;display:flex;flex-direction:column;gap:var(--sp-4)}
.board-legend{display:flex;flex-wrap:wrap;gap:var(--sp-2) var(--sp-4);font:400 var(--fs-sm)/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.legend-item{display:inline-flex;align-items:center;gap:var(--sp-2)}
.legend-item svg{width:28px;height:8px;overflow:visible}
.legend-item path{fill:none;stroke:var(--text-display)}
.legend-hint{color:var(--text-disabled)}
.lg-live{stroke-width:1.5}.lg-context{opacity:.6}.lg-legacy{opacity:.3;stroke-dasharray:4 3}.lg-loop{opacity:.6;stroke-dasharray:1 3;stroke-linecap:round}
.board{display:block;width:100%;height:auto;overflow:visible;-webkit-tap-highlight-color:transparent}
.board-wide{display:none}
@media (min-width:${BOARD_BREAKPOINT}px){.board-wide{display:block}.board-narrow{display:none}}
.board text{font-family:var(--grotesk)}
.board .t-label{font:400 10px var(--mono);letter-spacing:.08em;fill:var(--text-secondary)}
.board .t-strong{fill:var(--text-display)}
.board .t-bus{fill:var(--text-primary)}
.board .t-name{font:500 14px var(--grotesk);fill:var(--text-display)}
.board .t-role{font:400 12px var(--grotesk);fill:var(--text-secondary)}
.board .t-meta{font:400 10px var(--mono);letter-spacing:.08em;fill:var(--text-disabled)}
.board .t-row{font:400 10px var(--mono);fill:var(--text-primary)}
.board .t-pill{font:400 9px var(--mono);letter-spacing:.08em;fill:var(--black)}
.board-narrow .t-name{font-size:13px}
.board-narrow .t-role{font-size:11px}
.board .knock{fill:var(--black)}
.board .card-box{fill:var(--surface);stroke:var(--border-visible);stroke-width:1;vector-effect:non-scaling-stroke}
.board .is-legacy>.card-box{stroke-dasharray:4 3;fill:transparent}
.board .kind-engine>.card-box{stroke:var(--text-display)}
.board .card-rule{stroke:var(--border);stroke-width:1;fill:none;vector-effect:non-scaling-stroke}
.board .new-pill rect{fill:var(--text-display)}
.board .chip-d rect{fill:none;stroke:var(--border-visible);vector-effect:non-scaling-stroke}
.board .t-chip{fill:var(--text-primary)}
.board .row-hit{fill:transparent}
.board [data-card]{cursor:pointer;outline:none;transition:opacity .15s ease-out}
.board [data-card]:focus-visible>.card-box,.board [data-card]:focus-visible>.row-hit{stroke:var(--text-display);stroke-width:1}
.board .flow{transition:opacity .15s ease-out;pointer-events:none}
.board .flow-line{fill:none;stroke:var(--text-display);stroke-width:1;vector-effect:non-scaling-stroke}
.board .flow-head{fill:var(--text-display)}
.board .tier-live .flow-line{stroke-width:1.5}
.board .tier-context{opacity:.6}
.board .tier-legacy{opacity:.3}
.board .tier-legacy .flow-line{stroke-dasharray:4 3}
.board .tier-loop{opacity:.6}
.board .tier-loop .flow-line{stroke-dasharray:1 3;stroke-linecap:round}
.board.is-focus .flow{opacity:.3}
.board.is-focus .flow.is-on{opacity:1}
.board.is-focus .flow.is-on .flow-line{stroke-width:1.5}
.board.is-focus [data-card]:not(.is-on){opacity:.45}
@media (prefers-reduced-motion: reduce){.board .flow,.board [data-card]{transition:none}}

.module-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.module{display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-3) 0;border-top:1px solid var(--border);min-width:0}
.module-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--sp-1) var(--sp-2)}
.module-name{font:400 var(--fs-body)/1.3 var(--mono);color:var(--text-display);overflow-wrap:anywhere}
.module-role{margin:0;color:var(--text-primary)}
.module-meta{font:400 10px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--text-secondary);overflow-wrap:anywhere}
.module-stage{padding-top:var(--sp-4)}
.new-tag{flex:0 0 auto;padding:1px var(--sp-2);border-radius:999px;background:var(--text-display);color:var(--black);font:400 10px/1.4 var(--mono);letter-spacing:.1em}
.chips{display:flex;flex-wrap:wrap;gap:var(--sp-1);margin:0;padding:0;list-style:none}
.chip{padding:1px var(--sp-2);border:1px solid var(--border-visible);border-radius:999px;font:400 11px/1.5 var(--mono);color:var(--text-primary);overflow-wrap:anywhere}
.chip.in{border-style:dashed;color:var(--text-secondary)}
.chip-key{font:400 10px/1.8 var(--mono);letter-spacing:.1em;color:var(--text-secondary);margin-right:var(--sp-1)}
.field-group{display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-3) 0;border-top:1px solid var(--border)}
.field-group:first-child{border-top:0;padding-top:0}
.cl-list{display:flex;flex-direction:column}
.cl-entry summary{flex-wrap:wrap;justify-content:flex-start;gap:var(--sp-1) var(--sp-3);padding:var(--sp-2) 0}
.cl-entry summary::after{margin-left:auto}
.cl-date{font:400 var(--fs-sm)/1.3 var(--mono);letter-spacing:.08em;color:var(--text-secondary);min-width:10ch}
.cl-title{flex:1 1 16em;min-width:0;color:var(--text-display)}
.cl-body{color:var(--text-primary);max-width:48em;overflow-wrap:anywhere}
.cl-body p,.cl-body ul,.cl-body ol{margin:0 0 var(--sp-3)}
.cl-body ul,.cl-body ol{padding-left:var(--sp-5)}
.cl-body li{margin-bottom:var(--sp-1)}
.cl-body .md-h{margin:var(--sp-4) 0 var(--sp-2);font:400 var(--fs-sm)/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.cl-body code{font:400 .92em/1 var(--mono);color:var(--text-display);overflow-wrap:anywhere}
.cl-body strong{font-weight:500;color:var(--text-display)}
.md-pre{margin:0 0 var(--sp-3);padding:var(--sp-3);background:var(--black);border:1px solid var(--border);border-radius:var(--radius-sm);font:400 var(--fs-sm)/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
.offpath-list{columns:1}
@media (min-width:760px){.offpath-list{columns:2;column-gap:var(--sp-6)}.offpath-list .module{break-inside:avoid}}
`;

const chipList = (id, key, items, cls = '') => (items.length
  ? `<ul class="chips" id="${id}"><li class="chip-key">${esc(key)}</li>${items.map((f) => `<li class="chip${cls}">${esc(f)}</li>`).join('')}</ul>`
  : '');

function renderModule(m, nowMs, idPrefix) {
  const id = `${idPrefix}-${slug(m.name)}`;
  const fresh = isNew(m.since, nowMs);
  const meta = [m.path, `since ${m.since}`, m.schemaSince ? `schema ${m.schemaSince}` : null, m.tests.length ? `tests ${m.tests.join(' ')}` : 'tests none']
    .filter(Boolean).map(esc).join(' · ');
  return `<li class="module" id="${id}" data-new="${fresh}">`
    + `<div class="module-head"><span class="module-name">${esc(m.name)}</span>${fresh ? '<span class="new-tag">NEW</span>' : ''}</div>`
    + `<p class="module-role">${esc(m.role)}</p>`
    + chipList(`${id}-publishes`, 'OUT', m.publishes)
    + chipList(`${id}-consumes`, 'IN', m.consumes, ' in')
    + `<div class="module-meta">${meta}</div></li>`;
}

/** Group an output's fields under the stage whose module publishes each; unmatched -> "Other". */
export function groupFields(fields, stages) {
  const owner = new Map();
  for (const s of stages) for (const m of s.modules || []) for (const f of m.publishes || []) if (!owner.has(f)) owner.set(f, s.title);
  const groups = new Map(stages.map((s) => [s.title, []]));
  groups.set('Other', []);
  for (const f of fields || []) groups.get(owner.get(f) || 'Other').push(f);
  return [...groups].filter(([, fs]) => fs.length);
}

function isMap(map) {
  return map && typeof map === 'object' && Array.isArray(map.stages) && map.stages.length > 0;
}

/**
 * @param {Object} o
 * @param {Object|null} o.map - parsed ARCHITECTURE_MAP.json
 * @param {string} o.changelog - CHANGELOG.md text
 * @param {{checkedAt: string, files: number, ok: boolean}|null} [o.verify]
 * @param {{schemaVersion: string|null, configVersion: string|null, capturedAt: string|null}} [o.versions]
 * @param {number} o.nowMs
 */
export function renderChangelogPage({ map, changelog, verify = null, versions = {}, nowMs }) {
  const ok = isMap(map);
  const stages = ok ? map.stages : [];
  const liveStages = stages.filter((s) => !s.offPath);
  const offStages = stages.filter((s) => s.offPath);
  const entries = parseChangelog(changelog);
  const lastDate = entries.find((e) => e.date)?.date || null;
  const model = boardModel(map, nowMs);

  const topStrip = `<header class="edge-strip" id="map-top-edge-strip"><span id="map-page-title">EDITTRADES / SYSTEM MAP</span>`
    + `<a class="nav-link" id="map-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('map-jump-nav', [
      ['#map-board-zone', 'Board'], ['#map-outputs-zone', 'Outputs'], ['#map-changelog-zone', 'Changelog'],
      ['index.html', '← Tracker', 'class="nav-link" id="map-nav-tracker-link"'], ['how-to.html', 'How to', 'class="nav-link" id="map-nav-how-to-link"']
    ]);

  const verifyText = verify && verify.checkedAt
    ? `<b class="${verify.ok ? '' : 'st-bad'}">${esc(String(verify.checkedAt).slice(0, 10))} ${verify.ok ? 'OK' : 'FAILED'}</b> · ${esc(verify.files ?? '?')} files`
    : `<b>${NO_VERIFY}</b>`;
  const consistency = `<div class="consistency-strip" id="map-consistency-strip">`
    + `<span id="map-consistency-version">Map <b>${ok ? esc(map.version) : '[NONE]'}</b></span>`
    + `<span id="map-consistency-updated">Updated <b>${ok ? esc(map.updatedAt) : '[NONE]'}</b></span>`
    + `<span id="map-consistency-changelog">Last changelog <b>${lastDate ? esc(lastDate) : '[NONE]'}</b></span>`
    + `<span id="map-consistency-verify">Verified by test:archmap ${verifyText}</span></div>`;

  // Primary: the board.
  const boardBody = model
    ? `${LEGEND}${renderBoardSvg(model, 'wide')}${renderBoardSvg(model, 'narrow')}`
    : `<p class="empty" id="map-board-empty">${NO_BOARD}</p>`;
  const nLive = liveStages.reduce((k, s) => k + (s.modules || []).length, 0);
  const moduleTile = liveStages.length
    ? [tile({
      id: 'map-modules-tile', title: 'Every module on the board', tag: `${nLive} modules`,
      body: `<p class="note">The same modules as text: what each hands on (OUT), what it reads (IN), its tests and when it landed.</p>`
        + `<details class="sub" id="map-modules-sub"><summary class="sub-title">Show modules</summary>`
        + liveStages.map((s) => `<div class="module-stage" id="map-modules-${slug(s.id)}"><span class="label">${esc(s.title)}</span>`
          + `<ul class="module-list" id="map-modules-${slug(s.id)}-list">${(s.modules || []).map((m) => renderModule(m, nowMs, `map-module-${slug(s.id)}`)).join('')}</ul></div>`).join('')
        + '</details>'
    })]
    : [];
  const offPath = offStages.map((s) => tile({
    id: `map-offpath-${slug(s.id)}-tile`, title: s.title, tag: `${(s.modules || []).length} modules`,
    body: `<p class="note">${esc(s.purpose)}</p>`
      + `<details class="sub" id="map-offpath-${slug(s.id)}-sub"><summary class="sub-title">Show modules</summary><ul class="module-list offpath-list" id="map-offpath-${slug(s.id)}-modules">${(s.modules || []).map((m) => renderModule(m, nowMs, `map-offpath-${slug(s.id)}`)).join('')}</ul></details>`
  }));
  const board = zone({
    id: 'map-board-zone', title: 'How a call is made',
    sub: model ? `${model.sources.length} sources · ${model.lanes.length} lanes · ${nLive} modules` : '',
    tiles: [
      tile({ id: 'map-intro-section', body: `<h1 id="map-intro-title">From candles to your chat.</h1><p class="note" id="map-intro-note">Top to bottom is the order data moves: sources feed the feature lanes, every lane feeds the engine, the engine hands out calls, plans and data, and the GPT and the tracker read them. NEW marks modules added in the last ${NEW_DAYS} days.</p>` }),
      `<div class="board-wrap" id="map-board-section" data-section="map-board-section">${boardBody}</div>`,
      ...moduleTile,
      ...offPath
    ]
  });

  // Secondary: outputs + versions.
  const v = versions || {};
  const versionTile = tile({
    id: 'map-versions-tile', title: 'Current versions', tag: 'Latest capture',
    body: v.schemaVersion || v.configVersion
      ? `<dl class="status-facts" id="map-versions-facts"><div class="status-fact"><dt>Schema</dt><dd id="map-version-schema">${esc(v.schemaVersion || '—')}</dd></div>`
        + `<div class="status-fact"><dt>Config</dt><dd id="map-version-config">${esc(v.configVersion || '—')}</dd></div>`
        + `<div class="status-fact"><dt>Captured</dt><dd class="fact-sub" id="map-version-captured">${esc(v.capturedAt || '—')}</dd></div></dl>`
      : `<p class="empty" id="map-versions-empty">${NO_CAPTURE}</p>`
  });
  const outputTiles = (ok ? map.outputs || [] : []).map((o) => {
    const id = `map-output-${slug(o.name)}-tile`;
    const groups = groupFields(o.fields, stages);
    return tile({
      id, title: o.name, tag: o.where, lg: 4,
      body: groups.length
        ? groups.map(([title, fs]) => `<div class="field-group" id="${id}-${slug(title)}"><span class="label">${esc(title)}</span><ul class="chips">${fs.map((f) => `<li class="chip">${esc(f)}</li>`).join('')}</ul></div>`).join('')
        : `<p class="empty">${NO_FIELDS}</p>`
    });
  });
  const outputs = zone({
    id: 'map-outputs-zone', title: 'What the engine spits out', sub: 'Fields by the stage that makes them',
    tiles: [versionTile, ...(outputTiles.length ? outputTiles : [tile({ id: 'map-outputs-empty-tile', body: `<p class="empty">${NO_MAP}</p>` })])]
  });

  // Tertiary: changelog timeline.
  const delta = (k, d) => (d ? `<span class="prov-tag">${k} ${esc(d.from)} → ${esc(d.to)}</span>` : '');
  const clBody = entries.length
    ? `<div class="cl-list" id="map-changelog-list">${entries.map((e, i) => `<details class="sub cl-entry" id="map-changelog-entry-${i + 1}">`
      + `<summary><span class="cl-date">${esc(e.date || 'undated')}</span><span class="cl-title">${renderInline(e.title)}</span>${delta('Schema', e.schema)}${delta('Config', e.config)}</summary>`
      + `<div class="cl-body">${renderMarkdown(e.body)}</div></details>`).join('')}</div>`
    : `<p class="empty" id="map-changelog-empty">${NO_ENTRIES}</p>`;
  const timeline = zone({
    id: 'map-changelog-zone', title: 'Changelog', sub: `${entries.length} entries · newest first`,
    tiles: [tile({ id: 'map-changelog-section', body: clBody })]
  });

  const bottomStrip = `<footer class="edge-strip" id="map-bottom-edge-strip"><span id="map-footer-note">GENERATED FROM DOCS/ARCHITECTURE_MAP.JSON + CHANGELOG.MD · NEVER EDITED BY HAND</span></footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades System Map</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}${CHANGELOG_CSS}
</style>
</head>
<body>
<main id="map-page-main">
${topStrip}
${consistency}
${[board, outputs, timeline].join('\n')}
${bottomStrip}
</main>
${model ? `<script>${BOARD_SCRIPT}</script>` : ''}
</body>
</html>
`;
}
