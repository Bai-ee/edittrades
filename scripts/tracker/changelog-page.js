/**
 * EditTrades call tracker - "System map + changelog" page (changelog.html).
 *
 * Rendered from the engine's docs/ARCHITECTURE_MAP.json and CHANGELOG.md (synced into the
 * tracker at data/engine/ by sync.js), so the picture can only say what the map says, and
 * the engine's test:archmap keeps the map in step with the code. Pure: no fs, no network,
 * no clock (the caller passes nowMs). Same bento system as the other pages (./bento.js,
 * ./page-style.js); no scripts at all.
 *
 * Three layers:
 *   primary   - the pipeline: stage cards left to right with thin SVG arrows (the page's
 *               one pattern break); vertical ticks on phones. Each card is a
 *               details/summary that opens to its modules (role, publishes/consumes
 *               chips, tests, since, NEW within NEW_DAYS).
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
export const NO_MODULES = '[NO MODULES]';
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

// ---- page ----

const CHANGELOG_CSS = `
/* system map page */
.consistency-strip{display:flex;flex-wrap:wrap;gap:var(--sp-1) var(--sp-4);padding:var(--sp-3) 0;border-bottom:1px solid var(--border);font:400 var(--fs-sm)/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.consistency-strip b{font-weight:400;color:var(--text-display)}
#map-intro-title{margin:0;font:500 clamp(32px,8vw,56px)/1.05 var(--grotesk);letter-spacing:-.02em;color:var(--text-display)}
.pipeline-wrap{grid-column:1 / -1;min-width:0}
.pipeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;align-items:stretch}
.pipe-arrow{display:flex;justify-content:center;align-items:center;height:32px;color:var(--text-secondary)}
.pipe-arrow svg{display:block;width:32px;height:12px;transform:rotate(90deg)}
@media (min-width:1024px){
  .pipeline-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 calc(-1 * var(--sp-4));padding:0 var(--sp-4) var(--sp-3)}
  .pipeline{flex-direction:row;align-items:flex-start;width:max-content}
  .pipe-stage{width:272px;flex:0 0 272px}
  .pipe-arrow{height:auto;width:32px;align-self:flex-start;margin-top:44px}
  .pipe-arrow svg{transform:none}
}
.pipe-stage details{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.pipe-stage details[open]{border-color:var(--border-visible)}
.pipe-stage summary{display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-4);cursor:pointer;list-style:none}
.pipe-stage summary::-webkit-details-marker{display:none}
.stage-label{display:flex;justify-content:space-between;gap:var(--sp-3);font:400 var(--fs-sm)/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-display)}
.stage-label::after{content:"+";color:var(--text-secondary)}
.pipe-stage details[open] .stage-label::after{content:"\\2212"}
.stage-purpose{margin:0;color:var(--text-primary)}
.stage-count{font:400 var(--fs-sm)/1.3 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.stage-branch{display:flex;flex-direction:column;gap:var(--sp-1);padding-top:var(--sp-2);border-top:1px solid var(--border)}
.stage-branch svg{display:block;width:100%;height:28px;color:var(--text-secondary)}
.branch-labels{display:grid;grid-template-columns:repeat(3,1fr);text-align:center;font:400 10px/1.3 var(--mono);letter-spacing:.1em;color:var(--text-display)}
.module-list{list-style:none;margin:0;padding:0 var(--sp-4) var(--sp-4);display:flex;flex-direction:column}
.module{display:flex;flex-direction:column;gap:var(--sp-2);padding:var(--sp-3) 0;border-top:1px solid var(--border);min-width:0}
.module-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--sp-1) var(--sp-2)}
.module-name{font:400 var(--fs-body)/1.3 var(--mono);color:var(--text-display);overflow-wrap:anywhere}
.module-role{margin:0;color:var(--text-primary)}
.module-meta{font:400 10px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--text-secondary);overflow-wrap:anywhere}
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

const ARROW_SVG = '<svg viewBox="0 0 32 12" aria-hidden="true"><path d="M0 6H30M25 1l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const BRANCH_SVG = '<svg viewBox="0 0 240 28" preserveAspectRatio="none" aria-hidden="true"><path d="M120 0V10M40 10H200M40 10V28M120 10V28M200 10V28" fill="none" stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

function renderStage(stage, i, nowMs) {
  const id = `pipeline-stage-${slug(stage.id)}`;
  const mods = stage.modules || [];
  const newCount = mods.filter((m) => isNew(m.since, nowMs)).length;
  const branch = stage.id === 'delivery'
    ? `<div class="stage-branch" id="${id}-branch">${BRANCH_SVG}<div class="branch-labels"><span>REST</span><span>MCP</span><span>JOURNAL</span></div></div>`
    : '';
  return `<li class="pipe-stage" id="${id}" data-section="${id}"><details id="${id}-details">`
    + `<summary id="${id}-summary"><span class="stage-label">${String(i + 1).padStart(2, '0')} · ${esc(stage.title)}</span>`
    + `<p class="stage-purpose">${esc(stage.purpose)}</p>`
    + `<span class="stage-count">${mods.length} module${mods.length === 1 ? '' : 's'}${newCount ? ` · ${newCount} new` : ''}</span>${branch}</summary>`
    + (mods.length ? `<ul class="module-list" id="${id}-modules">${mods.map((m) => renderModule(m, nowMs, id)).join('')}</ul>` : `<p class="empty" id="${id}-empty">${NO_MODULES}</p>`)
    + '</details></li>';
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
  const pipeStages = stages.filter((s) => !s.offPath);
  const offStages = stages.filter((s) => s.offPath);
  const entries = parseChangelog(changelog);
  const lastDate = entries.find((e) => e.date)?.date || null;

  const topStrip = `<header class="edge-strip" id="map-top-edge-strip"><span id="map-page-title">EDITTRADES / SYSTEM MAP</span>`
    + `<a class="nav-link" id="map-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('map-jump-nav', [
      ['#map-pipeline-zone', 'Pipeline'], ['#map-outputs-zone', 'Outputs'], ['#map-changelog-zone', 'Changelog'],
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

  // Primary: the pipeline.
  const pipelineBody = ok
    ? `<div class="pipeline-scroll" id="map-pipeline-scroll"><ol class="pipeline" id="map-pipeline">`
      + pipeStages.map((s, i) => (i ? `<li class="pipe-arrow" aria-hidden="true">${ARROW_SVG}</li>` : '') + renderStage(s, i, nowMs)).join('')
      + '</ol></div>'
    : `<p class="empty" id="map-pipeline-empty">${NO_MAP}</p>`;
  const offPath = offStages.map((s) => tile({
    id: `map-offpath-${slug(s.id)}-tile`, title: s.title, tag: `${(s.modules || []).length} modules`,
    body: `<p class="note">${esc(s.purpose)}</p>`
      + `<details class="sub" id="map-offpath-${slug(s.id)}-sub"><summary class="sub-title">Show modules</summary><ul class="module-list offpath-list" id="map-offpath-${slug(s.id)}-modules">${(s.modules || []).map((m) => renderModule(m, nowMs, `map-offpath-${slug(s.id)}`)).join('')}</ul></details>`
  }));
  const pipeline = zone({
    id: 'map-pipeline-zone', title: 'How a call is made', sub: ok ? `${pipeStages.length} stages · ${pipeStages.reduce((n, s) => n + (s.modules || []).length, 0)} modules` : '',
    tiles: [
      tile({ id: 'map-intro-section', body: `<h1 id="map-intro-title">From candles to your chat.</h1><p class="note" id="map-intro-note">Left to right is the order data moves. Open a stage to see each module, what it hands on (OUT) and what it reads (IN). NEW marks modules added in the last ${NEW_DAYS} days.</p>` }),
      `<div class="pipeline-wrap" id="map-pipeline-section" data-section="map-pipeline-section">${pipelineBody}</div>`,
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
${[pipeline, outputs, timeline].join('\n')}
${bottomStrip}
</main>
</body>
</html>
`;
}
