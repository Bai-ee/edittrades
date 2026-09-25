#!/usr/bin/env node
/**
 * EditTrades call tracker - review page (T1, docs/PLAN_CALL_TRACKER.md item 5).
 *
 * Recomputes aggregates from the data dir (writes data/aggregates.json), then renders
 * one static page `<out>/index.html` and `<out>/report.md` with the same numbers.
 *
 * Page design: Nothing design system (Space Grotesk + Space Mono, Doto for the one hero
 * number). Inline CSS, light (warm off-white) and dark (OLED black) via
 * prefers-color-scheme, phone-width first. Three layers:
 *   primary   - 7-day expectancy in gross R per scored call (TP1 or stop), sample size under it
 *   secondary - instruments: win rate at TP1, fill rate, GOOD calls 7d, losing streak, avg win R
 *   tertiary  - capture health in Space Mono caps at the top and bottom edges
 * Then the testing-phase block, the two charts (./charts.js: engine-call equity curve with
 * filters, wallet value over time), "what we track and why", and the tables. The charts
 * are inline SVG drawn server-side and redrawn by the page's one inline script from two
 * inline JSON blocks (no dependencies, no network). Trade journal (T2): the equity chart
 * adds a dashed "your trades" line under the same filters, the wallet chart adds entry /
 * exit ticks, and two sections follow the charts: "Engine vs you" (GOOD calls taken,
 * skipped, not logged; WATCH/BAD taken as overrides, with outcomes) and the journal log.
 * The Performance zone also carries a class check: GOOD / WATCH / BAD calls scored
 * counterfactually from their flag candidate's levels ("did the filter work?"), kept out
 * of the hero and the testing target. The Alerts zone (Telegram sent-alert log and engine
 * transitions, aggregate.js computeAlertAggregates) shows alerts 7d, median latency,
 * alerted -> later GOOD, BE READY -> GET IN NOW within 30 min, transitions per hour by
 * timeframe and a daily table; the Status "Alerts" fact links to it. Every section
 * carries a PROVISIONAL tag; the edge disclaimer appears once, under the hero. Renders
 * from an empty data dir.
 *
 * Usage: node build-page.js [--data ./data] [--out ./docs] [--now <iso>]
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, ensureDir, readJsonl, readJson, readWallet, outcomesFile, readJournal, journalOutcomesFile, telegramStatusFile } from './store.js';
import { aggregateDataDir, computeAlertAggregates, READY_WITHIN_MIN } from './aggregate.js';
import { pathsFile, pathsSummary } from './paths.js';
import { calibrationFile } from './calibration.js';
import { shadowOutcomesFile, shadowSummaryFile } from './shadow.js';
import { v3ShadowOutcomesFile, v3ShadowSummaryFile } from './v3-shadow.js';
import { PATHS } from './flag-paths.js';
import {
  chartKit, chartScript, callVia, equityRows, journalEquityRows, setupEquityRows, walletMarks, filterValues, walletChartRows, jsonForScript,
  FILTER_DIMS, WALLET_RANGES, DEFAULT_WALLET_RANGE, NO_SCORED_CHART, NO_WALLET, NO_JOURNAL, NO_JOURNAL_TRADES, CHART_CSS
} from './charts.js';
import { PAGE_CSS } from './page-style.js';
import { tile, zone, sub, jumpNav } from './bento.js';
import { renderHowTo } from './how-to-page.js';

export const PROVISIONAL = 'provisional; not evidence of an edge';
export const EDGE_NOTE = "Not evidence of an edge. Scores the engine's calls against later closed candles.";
export const NO_SCORED = '[NO SCORED CALLS YET]';

// Active testing phase (docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md Phase 1). Edit here when the phase changes.
// PHASE_START deliberately NOT moved for "D-variant revised" (owner decision
// 2026-09-24, docs/OWNER_DECISIONS_2026-09-24.md) - the window continues, it does not
// restart; the rule-change note lives in the dynamic configBoundary marker instead
// (aggregate.js's configBoundary, rendered by configBoundaryNote below), not a
// manually-maintained restart note.
export const PHASE_NAME = 'Phase 5 forward record (2.5R gross, net gate off)';
export const PHASE_START = '2026-09-24';
export const PHASE_DAYS = 14;
export const PHASE_TARGET_PLANS = 30;
// Owner decision "D-variant revised" (docs/OWNER_DECISIONS_2026-09-24.md): thresholds stay
// frozen through the testing window; the first day tuning may resume.
export const FROZEN_UNTIL = '2026-10-08';
const PHASE_START_MS = Date.parse(`${PHASE_START}T00:00:00Z`);

// Tracker schedule. Must match the cron in repo-template/.github/workflows/track.yml.
export const SCHEDULE_MINUTES = [7, 17, 27, 37, 47, 57];
export const SCHEDULE_TEXT = 'Captures every 10 min, page every 30 min';
// Capture cadence moved from 30 to 10 min here; expected-run counts use the right one per span.
export const CADENCE_10_SINCE = '2026-09-24T06:00:00Z';
const CADENCE_10_SINCE_MS = Date.parse(CADENCE_10_SINCE);

/** Runs the schedule expects in [fromMs, toMs): 30-min cadence before CADENCE_10_SINCE, 10-min after. */
export function expectedRuns(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  const split = Math.min(Math.max(CADENCE_10_SINCE_MS, fromMs), toMs);
  return Math.ceil((split - fromMs) / (30 * 60_000)) + Math.ceil((toMs - split) / (10 * 60_000));
}
// Status bands by minutes since the last capture (GitHub can start a scheduled job a few minutes late).
export const LIVE_MAX_MIN = 45;
export const DELAYED_MAX_MIN = 90;
const HEARTBEAT_SLOTS = 48;
const SLOT_MS = 30 * 60 * 1000;

/** LIVE / DELAYED / STALLED / WAITING from the last capture. Mirrored in statusScript(). */
export function systemStatus(lastCaptureIso, nowMs) {
  if (!lastCaptureIso) return { word: 'WAITING', cls: 'st-warn', mins: null };
  const mins = Math.max(0, Math.round((nowMs - Date.parse(lastCaptureIso)) / 60_000));
  if (mins <= LIVE_MAX_MIN) return { word: 'LIVE', cls: 'st-good', mins };
  if (mins <= DELAYED_MAX_MIN) return { word: 'DELAYED', cls: 'st-warn', mins };
  return { word: 'STALLED', cls: 'st-bad', mins };
}

/**
 * Browser half of the status tile: the page is only rebuilt when the job runs, so a stopped
 * job would otherwise leave "LIVE" frozen on screen. Re-derives status, last-run age and the
 * next-run countdown from the viewer's clock every 30 s. Appended to the page's one script.
 */
export function statusScript() {
  return `(function(){
var el=document.getElementById('system-status-section');if(!el)return;
var last=el.getAttribute('data-last-capture');var mins=${JSON.stringify(SCHEDULE_MINUTES)};
var set=function(id,t){var n=document.getElementById(id);if(n)n.textContent=t;};
var cls=function(id,c,live){var n=document.getElementById(id);if(!n)return;n.classList.remove('st-good','st-warn','st-bad','is-live');n.classList.add(c);if(live)n.classList.add('is-live');};
function tick(){var now=Date.now();
  if(last){var m=Math.max(0,Math.round((now-Date.parse(last))/60000));
    var s=m<=${LIVE_MAX_MIN}?['LIVE','st-good']:m<=${DELAYED_MAX_MIN}?['DELAYED','st-warn']:['STALLED','st-bad'];
    set('system-status-word',s[0]);cls('system-status-word',s[1]);cls('system-status-dot',s[1],s[0]==='LIVE');
    set('system-last-run-age',m+' min ago');set('tile-last-capture','LAST CAPTURE '+(m<90?m+' MIN AGO':Math.round(m/60)+' H AGO'));}
  var d=new Date(now);d.setUTCSeconds(0,0);for(var i=0;i<61;i++){d.setUTCMinutes(d.getUTCMinutes()+1);if(mins.indexOf(d.getUTCMinutes())>=0)break;}
  set('system-next-run','in '+Math.max(1,Math.ceil((d.getTime()-now)/60000))+' min');}
tick();setInterval(tick,30000);
var born=Date.now();function fresh(){if(Date.now()-born>120000)location.reload();}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')fresh();});
window.addEventListener('pageshow',function(e){if(e.persisted)fresh();});
setInterval(function(){if(document.visibilityState==='visible')location.reload();},600000);})();`;
}

/** Next scheduled run strictly after nowMs. */
export function nextRunMs(nowMs) {
  const d = new Date(nowMs);
  d.setUTCSeconds(0, 0);
  for (let i = 0; i < 61; i++) {
    d.setUTCMinutes(d.getUTCMinutes() + 1);
    if (SCHEDULE_MINUTES.includes(d.getUTCMinutes())) return d.getTime();
  }
  return null;
}

const DAY = 24 * 60 * 60 * 1000;
const MINUS = '−';
const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => (isNum(v) ? String(Math.round(v * 10 ** d) / 10 ** d) : dash);
const pct = (v) => (isNum(v) ? `${Math.round(v * 1000) / 10}%` : dash);
const signed = (v) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(2)}` : dash);
const rVal = (v) => (isNum(v) ? `${signed(v)}R` : dash);
const time = (iso) => (iso ? String(iso).replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, 'Z') : dash);
const levels = (r) => (r.entry === null || r.entry === undefined ? dash : `${num(r.entry, 4)} / ${num(r.stop, 4)} / ${num(r.tp1, 4)}`);
const callLabel = (r) => (r.kind === 'rec' ? (r.class || 'rec') : `plan:${r.planStatus}`);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Status class for an R value: green >= 0, amber between -0.5R and 0, red below. */
export const rStatus = (v) => (!isNum(v) ? '' : v >= 0 ? 'st-good' : v >= -0.5 ? 'st-warn' : 'st-bad');
const outcomeStatus = (o) => (o === 'tp1' ? 'st-good' : o === 'stop' ? 'st-bad' : '');

/** Testing-phase progress from the aggregate (phase stats are optional for older callers). */
export function phaseProgress(agg) {
  const nowMs = Date.parse(agg.generatedAt);
  const elapsed = nowMs < PHASE_START_MS ? 0 : clamp(Math.floor((nowMs - PHASE_START_MS) / DAY) + 1, 0, PHASE_DAYS);
  const t = agg.phase && agg.phase.tradable;
  const scored = t ? t.wins + t.losses : null;
  const done = elapsed >= PHASE_DAYS && isNum(scored) && scored >= PHASE_TARGET_PLANS;
  const status = nowMs < PHASE_START_MS ? 'SCHEDULED' : done ? 'READY FOR REVIEW' : 'RUNNING';
  return { elapsed, scored, status, endDate: new Date(PHASE_START_MS + PHASE_DAYS * DAY).toISOString().slice(0, 10) };
}

function ageText(fromIso, nowIso) {
  if (!fromIso) return '[NO CAPTURES YET]';
  const mins = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(fromIso)) / 60_000));
  return mins < 90 ? `${mins} MIN AGO` : `${Math.round(mins / 60)} H AGO`;
}

// ---------- markup helpers ----------

/** A cell is a plain value or {v, cls}. Zero and dash values are dimmed (opacity before color). */
function cell(c, right) {
  const v = c && typeof c === 'object' ? c.v : c;
  let cls = c && typeof c === 'object' && c.cls ? c.cls : '';
  if (v === 0 || v === '0' || v === dash || v === '' || v === null || v === undefined) cls = `${cls} dim`.trim();
  if (right) cls = `${cls} num`.trim();
  return `<td${cls ? ` class="${cls}"` : ''}>${esc(v ?? dash)}</td>`;
}

function table(id, headers, rows, emptyText = '[NO ROWS YET]', rightFrom = Infinity) {
  if (!rows.length) return `<p class="empty" id="${id}-empty">${esc(emptyText)}</p>`;
  return `<div class="table-scroll" id="${id}-scroll"><table id="${id}"><thead><tr>${headers.map((h, i) => `<th${i >= rightFrom ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => cell(c, i >= rightFrom)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const STAT_COLUMNS = [
  ['Calls', (s) => s.calls],
  ['Fills', (s) => s.fills],
  ['TP1', (s) => s.wins],
  ['Stop', (s) => s.losses],
  ['Open', (s) => s.open + s.pending],
  ['Win rate', (s) => pct(s.winRate)],
  ['Exp. (gross R)', (s) => ({ v: rVal(s.expectancy), cls: rStatus(s.expectancy) })],
  ['Net exp. (net of fees)', (s) => ({ v: rVal(s.netExpectancy), cls: rStatus(s.netExpectancy) })],
  ['Avg net R:R (plan)', (s) => num(s.avgNetRR)],
  ['Max loss streak', (s) => ({ v: s.maxLosingStreak, cls: s.maxLosingStreak >= 5 ? 'st-bad' : '' })],
  ['Median min to TP1', (s) => num(s.medianMinutesToTP1, 0)]
];

function statTable(id, groups, keyLabel) {
  return table(id, [keyLabel, ...STAT_COLUMNS.map((c) => c[0])], groups.map((g) => [g.key, ...STAT_COLUMNS.map((c) => c[1](g))]), '[NO ROWS YET]', 1);
}

/** A bento tile that carries the PROVISIONAL tag (every <section> on this page does). */
function section(id, title, body, span = {}) {
  return tile({ id, title, tag: 'PROVISIONAL', body, ...span });
}

/** Segmented progress bar: discrete square blocks, 2px gaps. */
function segBar(id, filled, total, size = 'std', tone = '') {
  const on = clamp(Math.round(filled), 0, total);
  const segs = Array.from({ length: total }, (_, i) => `<i${i < on ? ` class="on${tone ? ` ${tone}` : ''}"` : ''}></i>`).join('');
  return `<div class="seg seg-${size}" id="${id}" style="grid-template-columns:repeat(${total},1fr)" role="img" aria-label="${on} of ${total}">${segs}</div>`;
}

function inlineBar(id, ratio) {
  const w = isNum(ratio) ? clamp(ratio, 0, 1) * 100 : 0;
  return `<div class="ibar" id="${id}" role="img" aria-label="${Math.round(w)}%"><i style="width:${w.toFixed(1)}%"></i></div>`;
}

/**
 * Config-boundary marker (T6 completion plan C3): the most recent configVersion
 * change, gross + net expectancy before/after it, side by side. Empty string (no
 * markup at all) when `cb` is null - single configVersion throughout, nothing to mark.
 */
function configBoundaryNote(cb) {
  if (!cb) return '';
  const seg = (s) => `n=${s.n} exp=${rVal(s.expectancy)} net=${rVal(s.netExpectancy)}`;
  return `<p class="mono-note" id="testing-phase-config-boundary-note">CONFIG ${esc(cb.fromVersion)} &rarr; ${esc(cb.toVersion)} AT ${esc(time(cb.at))} - BEFORE (${esc(seg(cb.before))}) / AFTER (${esc(seg(cb.after))})</p>`;
}

/** One instrument = one small bento tile (a div, so no PROVISIONAL chip of its own). */
function instrument(id, label, valueHtml, visual = '', subText = '', span = { sm: 1, lg: 3 }) {
  return tile({
    id: `${id}-tile`, as: 'div', cls: 'tile-instrument', ...span,
    body: `<div class="instrument" id="${id}"><div class="label">${esc(label)}</div><div class="inst-value">${valueHtml}</div>${visual}${subText ? `<div class="inst-sub">${esc(subText)}</div>` : ''}</div>`
  });
}

const emptyInline = (text = NO_SCORED) => `<span class="empty-inline">${esc(text)}</span>`;

// ---------- charts ----------

const kit = chartKit();
const SSR_WIDTH = 640;

function segButtons(dim, values, activeVal) {
  return values.map(([v, label]) => `<button type="button" class="seg-btn${v === activeVal ? ' is-on' : ''}" data-dim="${esc(dim)}" data-val="${esc(v)}" aria-pressed="${v === activeVal}">${esc(label)}</button>`).join('');
}

function equityBody(rows, nowMs, you = [], setup = []) {
  const values = filterValues([...rows, ...you, ...setup]);
  const stats = kit.equityStats(rows);
  const legend = `<div class="chart-legend" id="equity-chart-legend">`
    + `<span><svg class="swatch" viewBox="0 0 24 8" aria-hidden="true"><line class="line-main" x1="0" x2="24" y1="4" y2="4"/></svg>ENGINE CALLS</span>`
    + `<span><svg class="swatch" viewBox="0 0 24 8" aria-hidden="true"><line class="line-you" x1="0" x2="24" y1="4" y2="4"/></svg>YOUR TRADES</span></div>`;
  const filters = rows.length || you.length
    ? `<details class="filters" id="equity-filters"><summary id="equity-filters-summary"><span class="label">Filters · OR within a row, AND across rows</span><span class="label" id="equity-filters-count">NONE ACTIVE</span></summary>`
      + FILTER_DIMS.map(([k, label]) => `<div class="filter-row" id="equity-filter-${k}-row"><span class="label">${esc(label)}</span>`
        + `<div class="seg-ctl" role="group" aria-label="${esc(label)}">${segButtons(k, [['*', 'ALL'], ...values[k].map((v) => [v, v])], '*')}</div></div>`).join('')
      + '</details>'
    : '<p class="empty" id="equity-filters-empty">[FILTERS APPEAR WITH THE FIRST SCORED CALL]</p>';
  return `<div class="chart-readout" id="equity-readout">${kit.readoutHtml(stats)}</div>`
    + `<div class="chart-readout" id="equity-you-readout">${kit.youReadoutHtml(kit.equityStats(you), NO_JOURNAL_TRADES)}</div>`
    + `<div class="chart-frame-box" id="equity-chart-frame">${kit.equitySvg('equity-chart-svg', rows, SSR_WIDTH, nowMs, NO_SCORED_CHART, you)}</div>`
    + legend
    + sub('equity-chart-caption-sub', 'How to read this chart', `<p class="note" id="equity-chart-caption">Cumulative gross R of scored ready flag plans, 1R risked per call: TP1 = +R to TP1 as walked by the scorer, stop = ${MINUS}1R. Not filled and expired calls are excluded; open calls are the hollow last point. Before fees and slippage. The dashed line is your journal trades: scored the same way from your entry, stop and TP1, or your reported R when you logged a close; filters apply through the engine call each trade links to. SETUPs (T6 completion plan C2) are what-if only, shown in the filter table below, not the line above - never entered, walked forward only if the trigger actually occurred.</p>`)
    + filters
    + sub('equity-filter-table-sub', 'By filter', `<div class="table-scroll" id="equity-filter-table-scroll">${kit.filterTableHtml(rows, {}, FILTER_DIMS, you, setup)}</div>`);
}

function walletBody(rows, goods, nowMs, marks = []) {
  const latest = [...rows].reverse().find((r) => isNum(r.totalUsd)) || null;
  const last = rows[rows.length - 1] || null;
  const pnlCls = latest && isNum(latest.pnlUsd) ? (latest.pnlUsd > 0 ? 'st-good' : latest.pnlUsd < 0 ? 'st-bad' : '') : '';
  const value = latest
    ? `<div class="wallet-value ${pnlCls}" id="wallet-current-value">${esc(kit.usd(latest.totalUsd))}</div>`
    : `<div class="wallet-value dim" id="wallet-current-value">${esc(rows.length ? '[WALLET UNAVAILABLE]' : NO_WALLET)}</div>`;
  const pnl = latest && isNum(latest.pnlUsd)
    ? `PNL ${latest.pnlUsd > 0 ? '+' : ''}${kit.usd(latest.pnlUsd)}${isNum(latest.pnlPct) ? ` · ${latest.pnlPct > 0 ? '+' : latest.pnlPct < 0 ? MINUS : ''}${Math.abs(latest.pnlPct).toFixed(2)}%` : ''} VS BASELINE ${kit.usd(latest.baselineUsd)} (MARGIN)`
    : 'PNL ' + dash + ' (NO BASELINE)';
  const subLine = `${pnl} · LAST SAMPLE ${time(last ? last.t : null)}${last && last.status !== 'available' ? ` · ${String(last.status).toUpperCase()}` : ''}`;
  const legend = `<div class="chart-legend" id="wallet-chart-legend">`
    + `<span><svg class="swatch" viewBox="0 0 24 8" aria-hidden="true"><line class="line-main" x1="0" x2="24" y1="4" y2="4"/></svg>TOTAL</span>`
    + `<span><svg class="swatch" viewBox="0 0 24 8" aria-hidden="true"><line class="line-margin" x1="0" x2="24" y1="4" y2="4"/></svg>MARGIN</span>`
    + `<span><svg class="swatch" viewBox="0 0 24 8" aria-hidden="true"><line class="line-holdings" x1="1" x2="23" y1="4" y2="4"/></svg>HOLDINGS</span>`
    + `<span><svg class="swatch" viewBox="0 0 24 8" aria-hidden="true"><line class="baseline" x1="0" x2="24" y1="4" y2="4"/></svg>BASELINE</span>`
    + `<span><svg class="swatch" viewBox="0 0 24 12" aria-hidden="true"><line class="good-tick" x1="12" x2="12" y1="0" y2="12"/></svg>GOOD CALL</span>`
    + `<span><svg class="swatch" viewBox="0 0 24 12" aria-hidden="true"><line class="j-tick" x1="12" x2="12" y1="12" y2="0"/></svg>YOUR ENTRY ↑ / EXIT ↓</span></div>`;
  return `<div class="wallet-head" id="wallet-value-row">${value}<div class="label" id="wallet-pnl">${esc(subLine)}</div></div>`
    + `<div class="seg-ctl seg-joined" id="wallet-range-control" role="group" aria-label="Range">${segButtons('range', WALLET_RANGES, DEFAULT_WALLET_RANGE)}</div>`
    + `<div class="chart-frame-box" id="wallet-chart-frame">${kit.walletSvg('wallet-chart-svg', rows, goods, SSR_WIDTH, DEFAULT_WALLET_RANGE, nowMs, NO_WALLET, marks)}</div>`
    + legend
    + sub('wallet-chart-caption-sub', 'How to read this chart', `<p class="note" id="wallet-chart-caption">Total = margin + holdings from the engine's account block, one sample per capture; gaps are samples where the wallet read was unavailable. PnL is measured on margin against the configured baseline. Ticks mark GOOD calls: coincidence only. Short ticks up and down are your journal entries and exits (green or red by that trade's R, grey while unknown): what you told the GPT, not a wallet read.</p>`);
}

// ---------- journal (T2) ----------

const recOf = (r) => (r.engineRef && typeof r.engineRef === 'object' ? r.engineRef : {});
const tradeTime = (r) => r.saidAt || r.receivedAt;

/**
 * Engine vs you: GOOD calls (distinct candidateId) taken / skipped / not logged, with your
 * result on the taken ones and the engine's own result on the skipped ones; WATCH/BAD
 * calls taken (overrides) with their outcomes; trades with no engine link.
 */
export function engineVsYou(outcomes, journal, journalOutcomes) {
  const goods = new Map();
  for (const o of outcomes) if (o.kind === 'rec' && o.class === 'GOOD' && o.candidateId && !goods.has(o.candidateId)) goods.set(o.candidateId, o);
  const opens = journal.filter((r) => r.kind === 'open');
  const taken = new Set(opens.map((r) => recOf(r).candidateId).filter(Boolean));
  const skipped = new Set(journal.filter((r) => r.kind === 'skip').map((r) => recOf(r).candidateId).filter(Boolean));
  const goodIds = [...goods.keys()];
  const goodTaken = goodIds.filter((id) => taken.has(id));
  const goodSkipped = goodIds.filter((id) => !taken.has(id) && skipped.has(id));
  const toRows = (list) => list.map((o) => ({ o: o.outcome, r: o.outcome === 'stop' ? -1 : isNum(o.r) ? o.r : null, t: o.calledAt, at: o.resolvedAt }));
  const yourGood = journalOutcomes.filter((o) => o.recClass === 'GOOD' || (o.dims && o.dims.recClass === 'GOOD'));
  const overrides = journalOutcomes.filter((o) => ['WATCH', 'BAD'].includes(o.recClass || (o.dims && o.dims.recClass)));
  return {
    records: journal.length,
    goodCalls: goodIds.length,
    goodTaken: goodTaken.length,
    goodSkipped: goodSkipped.length,
    goodNotLogged: goodIds.length - goodTaken.length - goodSkipped.length,
    yourGoodStats: kit.equityStats(toRows(yourGood)),
    skippedEngineStats: kit.equityStats(toRows(goodSkipped.map((id) => goods.get(id)))),
    overrides,
    overrideStats: kit.equityStats(toRows(overrides)),
    unlinked: opens.filter((r) => !recOf(r).candidateId).length
  };
}

const statsText = (s) => (s.n ? `N=${s.n} · WIN ${pct(s.winRate)} · CUM ${rVal(s.cum)}` : `N=0${s.open ? ` · ${s.open} OPEN` : ''}`);

function engineVsYouBody(ev) {
  if (!ev.records) return `<p class="empty" id="engine-vs-you-empty">${esc(NO_JOURNAL)}</p><p class="note" id="engine-vs-you-note">Tell the GPT "log took BTC long 84600 stop 84390 tp 85100", "log closed BTC +1.2R" or "log skipped SOL"; the next tracker run pulls it here.</p>`;
  const row = (id, label, value, cls = '') => `<div class="stat-row" id="${id}"><dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(value)}</dd></div>`;
  const overrideRows = ev.overrides.map((o) => {
    const rv = o.outcome === 'stop' ? -1 : o.r;
    return [time(o.calledAt), o.symbol || dash, o.recClass || (o.dims && o.dims.recClass) || dash, o.direction || dash, levels(o),
      { v: o.outcome, cls: outcomeStatus(o.outcome) }, { v: rVal(rv), cls: rStatus(rv) }];
  });
  return `<dl class="stat-rows" id="engine-vs-you-rows">`
    + row('engine-vs-you-good-row', 'GOOD calls (engine)', String(ev.goodCalls))
    + row('engine-vs-you-good-taken-row', 'GOOD taken · your result', `${ev.goodTaken} · ${statsText(ev.yourGoodStats)}`, rStatus(ev.yourGoodStats.n ? ev.yourGoodStats.cum : null))
    + row('engine-vs-you-good-skipped-row', 'GOOD skipped · engine result', `${ev.goodSkipped} · ${statsText(ev.skippedEngineStats)}`, rStatus(ev.skippedEngineStats.n ? ev.skippedEngineStats.cum : null))
    + row('engine-vs-you-good-unlogged-row', 'GOOD not logged', String(ev.goodNotLogged))
    + row('engine-vs-you-override-row', 'WATCH / BAD taken (overrides)', `${ev.overrides.length} · ${statsText(ev.overrideStats)}`, rStatus(ev.overrideStats.n ? ev.overrideStats.cum : null))
    + row('engine-vs-you-unlinked-row', 'Trades with no engine link', String(ev.unlinked))
    + `</dl>`
    + sub('engine-vs-you-overrides-sub', `Overrides · ${ev.overrides.length}`, table('engine-vs-you-overrides-table', ['Taken', 'Symbol', 'Class', 'Dir', 'Entry / stop / TP1', 'Outcome', 'R'], overrideRows, '[NO OVERRIDES YET]'))
    + `<p class="note" id="engine-vs-you-caption">Taken = a journal open whose engine link names that call's candidate; skipped = a journal skip naming it. Your R is scored from your own levels or your reported close; the engine's R is its own walk.</p>`;
}

function journalLogRows(journal, journalOutcomes) {
  const byId = new Map(journalOutcomes.map((o) => [o.journalId, o]));
  return [...journal].sort((a, b) => Date.parse(tradeTime(b)) - Date.parse(tradeTime(a))).slice(0, 50).map((r) => {
    const o = byId.get(r.id);
    const rv = r.kind === 'close' && isNum(r.resultR) ? r.resultR : o ? (o.outcome === 'stop' ? -1 : o.r) : null;
    const text = String(r.text || '');
    return [time(tradeTime(r)), r.kind || dash, r.symbol || dash, r.direction || dash, r.entry === null || r.entry === undefined ? dash : levels(r),
      o ? { v: o.outcome, cls: outcomeStatus(o.outcome) } : dash, { v: rVal(rv), cls: rStatus(rv) }, recOf(r).recClass || dash,
      text.length > 80 ? `${text.slice(0, 79)}…` : text];
  });
}

// ---------- class check (counterfactual WATCH / BAD scoring) ----------

export const NO_CLASS_CALLS = '[NO CLASSIFIED CALLS YET]';
export const CLASS_CHECK_NOTE = 'WATCH and BAD are scored as if taken: entry at the flag breakout, stop at invalidation, TP1 at the measured move. Counterfactual only: never counted in the 30-plan target or the expectancy above.';
const CLASS_CHECK_MIN_SCORED = 5;

/** Class-check rows to show: GOOD, WATCH, BAD always; DATA_UNAVAILABLE only when it has calls. Null → empty state. */
function classCheckRows(agg) {
  const rows = agg.classCheck && Array.isArray(agg.classCheck.rows) ? agg.classCheck.rows : [];
  const shown = rows.filter((r) => r && (r.key !== 'DATA_UNAVAILABLE' || r.calls > 0));
  return shown.some((r) => r.calls > 0) ? shown : null;
}

/** Plain-language verdict for one class row: {text, cls}. */
export function classVerdict(r) {
  const scored = r.scored || 0;
  if (scored < CLASS_CHECK_MIN_SCORED) return { text: `[${scored} SCORED · TOO FEW TO JUDGE]`, cls: 'dim' };
  if (!isNum(r.expectancy)) return { text: dash, cls: '' };
  if (r.key === 'GOOD') return r.expectancy > 0 ? { text: 'WORKING', cls: 'st-good' } : { text: 'NOT WORKING YET', cls: 'st-warn' };
  if (r.key === 'WATCH' || r.key === 'BAD') return r.expectancy <= 0 ? { text: 'FILTER CONFIRMED', cls: 'st-good' } : { text: 'FILTER MAY BE BLOCKING WINNERS', cls: 'st-warn' };
  return { text: dash, cls: '' };
}

const CLASS_CHECK_HEADERS = ['Class', 'Calls', 'Scored', 'Win rate', 'Exp. (gross R)', 'TP1 / Stop', 'Open', 'Not filled', 'No levels', 'Levels from (plan / candidate)'];
const classCheckCells = (r) => [r.key, r.calls, r.scored, pct(r.winRate), { v: rVal(r.expectancy), cls: rStatus(r.expectancy) },
  `${r.wins ?? 0} / ${r.losses ?? 0}`, r.open, r.notFilled, r.noLevels, `${r.fromPlan ?? 0} / ${r.fromCandidate ?? 0}`];

function classCheckBody(agg) {
  const rows = classCheckRows(agg);
  if (!rows) return `<p class="empty" id="class-check-empty">${esc(NO_CLASS_CALLS)}</p>`;
  const since = agg.classCheck.since ? `<p class="mono-note" id="class-check-since">SINCE ${esc(time(agg.classCheck.since))}</p>` : '';
  const verdicts = `<dl class="stat-rows" id="class-check-verdicts">${rows.map((r) => {
    const v = classVerdict(r);
    const id = `class-check-verdict-${String(r.key).toLowerCase().replace(/_/g, '-')}`;
    return `<div class="stat-row" id="${id}"><dt>${esc(r.key)}</dt><dd${v.cls ? ` class="${v.cls}"` : ''}>${esc(v.text)}</dd></div>`;
  }).join('')}</dl>`;
  return since + verdicts + table('class-check-table', CLASS_CHECK_HEADERS, rows.map(classCheckCells), NO_CLASS_CALLS, 1);
}

// ---------- flag paths (T4 P0, docs/PLAN_FLAG_PATHS.md; measure only, no production change) ----------

export const NO_FLAG_PATHS = '[NO RESOLVED FLAG PATHS YET]';
export const FLAG_PATHS_NOTE = "Measure only: labelled at the tightening point (first forming/proto capture), never fed back into a rule, threshold or trigger. n < 100 per bucket is uncalibrated.";
const PATH_HEADERS = PATHS.map((p) => p.replace(/_/g, ' ').toUpperCase());
const fmtShare = (v) => (isNum(v) ? `${v}%` : dash);

function flagPathsWindowBody(block, idPrefix) {
  if (!block.n) return `<p class="empty" id="${idPrefix}-empty">${esc(NO_FLAG_PATHS)}</p>`;
  const row = (label, g) => [label, g.n, ...PATHS.map((p) => fmtShare(g.shares[p])), g.calibrated ? '' : { v: 'UNCALIBRATED', cls: 'dim' }];
  const rows = [row('ALL', block.overall), ...block.byTf.map((g) => row(g.key, g))];
  return table(`${idPrefix}-table`, ['Bucket', 'N', ...PATH_HEADERS, 'Status'], rows, NO_FLAG_PATHS, 1);
}

function flagPathsBody(summary) {
  if (!summary.d7.n && !summary.d30.n) return `<p class="empty" id="flag-paths-empty">${esc(NO_FLAG_PATHS)}</p>`;
  return sub('flag-paths-7d-sub', 'Last 7 days', flagPathsWindowBody(summary.d7, 'flag-paths-7d'), true)
    + sub('flag-paths-30d-sub', 'Last 30 days', flagPathsWindowBody(summary.d30, 'flag-paths-30d'));
}

// ---------- path calibration (T4 P3, docs/PLAN_FLAG_PATHS.md; measure only) ----------

export const NO_CALIBRATION = '[NO CALIBRATION DATA YET]';
export const CALIBRATION_MIN_N = 30;
export const CALIBRATION_TOO_FEW = 'TOO FEW CALLS';
export const CALIBRATION_NOTE = "Measure only: pathOutlook's own predicted weights vs the realised path, never fed back into a rule, threshold or weight table. n < 30 per stat reads too few calls.";

export const EMPTY_CALIBRATION = {
  n: 0,
  phases: {
    tightening: { n: 0, brier: null, baselineBrier: null, baseline: {} },
    broken: { n: 0, brier: null, baselineBrier: null, baseline: {} }
  },
  reliability: { runner: [], fail_first: [] },
  likely: { n: 0, hitRate: null },
  chase: { highElevated: { n: 0, runnerRate: null }, low: { n: 0, runnerRate: null } }
};

function calibrationPhaseRow(label, stats) {
  if (!stats || !stats.n) return [label, 0, dash, dash];
  if (stats.n < CALIBRATION_MIN_N) return [label, stats.n, { v: CALIBRATION_TOO_FEW, cls: 'dim' }, dash];
  return [label, stats.n, num(stats.brier, 4), num(stats.baselineBrier, 4)];
}

function calibrationReliabilityBody(idPrefix, rows) {
  const tableRows = (rows || []).map((r) => [r.bucket, r.n, r.meanPredicted === null ? dash : `${r.meanPredicted}%`, r.realisedRate === null ? dash : `${r.realisedRate}%`]);
  return table(`${idPrefix}-table`, ['Predicted %', 'N', 'Mean predicted', 'Realised rate'], tableRows, NO_CALIBRATION, 1);
}

/** `${value} · n=N` once n reaches CALIBRATION_MIN_N, else TOO FEW CALLS (still with n), else a dash. */
function calibrationStatText(n, valuePct) {
  if (!n) return dash;
  if (n < CALIBRATION_MIN_N) return `${CALIBRATION_TOO_FEW} · n=${n}`;
  return `${pct(valuePct / 100)} · n=${n}`;
}

function calibrationBody(cal) {
  if (!cal || !cal.n) return `<p class="empty" id="path-calibration-empty">${esc(NO_CALIBRATION)}</p>`;
  const row = (id, label, value) => `<div class="stat-row" id="${id}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  const likelyText = calibrationStatText(cal.likely.n, cal.likely.hitRate);
  const chaseHiText = calibrationStatText(cal.chase.highElevated.n, cal.chase.highElevated.runnerRate);
  const chaseLoText = calibrationStatText(cal.chase.low.n, cal.chase.low.runnerRate);
  return `<dl class="stat-rows" id="path-calibration-summary-rows">`
    + row('path-calibration-likely-row', 'Likely hit rate', likelyText)
    + row('path-calibration-chase-hi-row', 'Chase high/elevated → runner', chaseHiText)
    + row('path-calibration-chase-lo-row', 'Chase low → runner', chaseLoText)
    + `</dl>`
    + table('path-calibration-phases-table', ['Phase', 'N', 'Brier', 'Baseline Brier'],
      [calibrationPhaseRow('TIGHTENING', cal.phases.tightening), calibrationPhaseRow('BROKEN', cal.phases.broken)], NO_CALIBRATION, 1)
    + sub('path-calibration-runner-reliability-sub', 'Reliability · runner', calibrationReliabilityBody('path-calibration-runner-reliability', cal.reliability.runner))
    + sub('path-calibration-fail-first-reliability-sub', 'Reliability · fail first', calibrationReliabilityBody('path-calibration-fail-first-reliability', cal.reliability.fail_first));
}

// ---------- breakout entry shadow (T4 P4, docs/PLAN_FLAG_PATHS.md; shadow mode, never traded) ----------

export const NO_SHADOW = '[NO SHADOW ENTRIES YET]';
export const SHADOW_MIN_N = 30;
export const SHADOW_TOO_FEW = 'TOO FEW CALLS';
export const SHADOW_NOTE = "Shadow mode: a breakout-close entry, scored but never traded (docs/PLAN_FLAG_PATHS.md P4). Never feeds flagTradePlan, class logic or any gate. Retest is the same stop/target from a retest-hold entry, for comparison. n < 30 per row reads too few calls.";

const EMPTY_SHADOW_LEG_STATS = { n: 0, wins: 0, losses: 0, open: 0, winRate: null, expectancy: null, netExpectancy: null, maxLosingStreak: 0 };
export const EMPTY_SHADOW_SUMMARY = {
  n: 0,
  shadow: { overall: EMPTY_SHADOW_LEG_STATS, byChase: { highElevated: EMPTY_SHADOW_LEG_STATS, lowUnknown: EMPTY_SHADOW_LEG_STATS } },
  retest: { overall: EMPTY_SHADOW_LEG_STATS, byChase: { highElevated: EMPTY_SHADOW_LEG_STATS, lowUnknown: EMPTY_SHADOW_LEG_STATS } }
};

function shadowStatRow(label, s) {
  if (!s || !s.n) return [label, 0, dash, dash, dash];
  if (s.n < SHADOW_MIN_N) return [label, s.n, { v: SHADOW_TOO_FEW, cls: 'dim' }, dash, dash];
  return [label, s.n, pct(s.winRate), { v: rVal(s.expectancy), cls: rStatus(s.expectancy) }, { v: rVal(s.netExpectancy), cls: rStatus(s.netExpectancy) }];
}

function shadowSummaryBody(summary) {
  const rows = [
    shadowStatRow('SHADOW · ALL', summary.shadow.overall),
    shadowStatRow('SHADOW · CHASE HIGH/ELEVATED', summary.shadow.byChase.highElevated),
    shadowStatRow('SHADOW · CHASE LOW/UNKNOWN', summary.shadow.byChase.lowUnknown),
    shadowStatRow('RETEST · ALL', summary.retest.overall),
    shadowStatRow('RETEST · CHASE HIGH/ELEVATED', summary.retest.byChase.highElevated),
    shadowStatRow('RETEST · CHASE LOW/UNKNOWN', summary.retest.byChase.lowUnknown)
  ];
  return table('breakout-shadow-summary-table', ['Entry', 'N', 'Win rate', 'Exp. (gross R)', 'Net exp. (net of fees)'], rows, NO_SHADOW, 1);
}

const legR = (leg) => (leg.outcome === 'stop' ? -1 : leg.outcome === 'tp1' ? leg.r : null);

function shadowListRows(rows) {
  return [...rows]
    .filter((r) => r && r.shadow)
    .sort((a, b) => (b.breakoutAt || 0) - (a.breakoutAt || 0))
    .slice(0, 20)
    .map((r) => [time(new Date(r.breakoutAt).toISOString()), r.symbol, r.tf, r.direction, levels(r.shadow),
      { v: r.shadow.outcome, cls: outcomeStatus(r.shadow.outcome) }, { v: rVal(legR(r.shadow)), cls: rStatus(legR(r.shadow)) }]);
}

function shadowBody(summary, rows) {
  const total = (summary.shadow.overall.n || 0) + (summary.retest.overall.n || 0);
  if (!total) return `<p class="empty" id="breakout-shadow-empty">${esc(NO_SHADOW)}</p>`;
  return shadowSummaryBody(summary)
    + sub('breakout-shadow-list-sub', 'Last 20 shadow entries',
      table('breakout-shadow-list-table', ['Time', 'Symbol', 'TF', 'Dir', 'Entry / stop / TP1', 'Outcome', 'R'], shadowListRows(rows), NO_SHADOW));
}

// ---------- 3R shadow, former live rule (T6 completion plan "D-variant revised", owner decision 2026-09-24; shadow mode, never traded) ----------

export const NO_V3_SHADOW = '[NO 3R SHADOW ENTRIES YET]';
export const V3_SHADOW_MIN_N = 20;
export const V3_SHADOW_TOO_FEW = 'TOO FEW CALLS';
// Cannot backfill: flagTradePlan.shadow.v3 only exists on rows captured after this
// deploy goes live. Edit this line again if the deploy timeline changes - same
// pattern as PHASE_START above.
export const V3_SHADOW_ACCRUAL_NOTE = 'Accruing since this deploy (D-variant revised, 2026-09-24) - nothing captured before that carries a v3 shadow field.';
export const V3_SHADOW_NOTE = `Shadow mode: the former live rule (gross minRR 3.0) kept as a comparator now that the live rule is gross minRR 2.5; the net gate is off in both, so only the gross floor differs (owner decision "D-variant revised", docs/OWNER_DECISIONS_2026-09-24.md - lean toward producing GOOD calls so the strategy can be tracked and tweaked) - computed by the engine itself with real ATR and retest-hold, not an approximation, never traded, never feeds flagTradePlan/flagRecommendation/class logic or any gate. ${V3_SHADOW_ACCRUAL_NOTE}`;

export const EMPTY_V3_SHADOW_SUMMARY = {
  generatedAt: null, n: 0, resolvedN: 0, open: 0, expired: 0, winRate: null, grossExpectancyR: null, netExpectancyR: null, netExpectancyR_dirCost: null
};

function v3ShadowSummaryBody(summary) {
  const row = summary.n < V3_SHADOW_MIN_N
    ? ['3R (minRR 3.0, former live)', summary.n, { v: V3_SHADOW_TOO_FEW, cls: 'dim' }, dash, dash, dash]
    : ['3R (minRR 3.0, former live)', summary.n, pct(summary.winRate),
      { v: rVal(summary.grossExpectancyR), cls: rStatus(summary.grossExpectancyR) },
      { v: rVal(summary.netExpectancyR), cls: rStatus(summary.netExpectancyR) },
      { v: rVal(summary.netExpectancyR_dirCost), cls: rStatus(summary.netExpectancyR_dirCost) }];
  return table('v3-shadow-summary-table', ['Variant', 'N', 'Win rate', 'Exp. (gross R)', 'Net exp. (flat 0.20%)', 'Net exp. (dir-cost)'], [row], NO_V3_SHADOW, 1);
}

function v3ShadowListRows(rows) {
  return [...rows]
    .filter((r) => r && r.outcome)
    .sort((a, b) => Date.parse(b.readyAt || 0) - Date.parse(a.readyAt || 0))
    .slice(0, 20)
    .map((r) => [time(r.readyAt), r.symbol, r.timeframe, r.direction, levels(r),
      { v: r.outcome, cls: outcomeStatus(r.outcome) }, { v: rVal(r.r), cls: rStatus(r.r) }]);
}

function v3ShadowBody(summary, rows) {
  if (!summary.n) return `<p class="empty" id="v3-shadow-empty">${esc(NO_V3_SHADOW)}</p>`;
  return v3ShadowSummaryBody(summary)
    + sub('v3-shadow-list-sub', 'Last 20 3R shadow entries',
      table('v3-shadow-list-table', ['Ready at', 'Symbol', 'TF', 'Dir', 'Entry / stop / TP1', 'Outcome', 'R'], v3ShadowListRows(rows), NO_V3_SHADOW));
}

// ---------- page ----------

/**
 * @param {Object} agg - computeAggregates output
 * @param {{outcomes?: Array<Object>, wallet?: Array<Object>}} [data] - raw outcome rows and
 *   wallet.jsonl rows for the charts (both optional; empty charts render their empty state)
 */
/**
 * Status "Alerts" fact (T-1 Telegram, docs/PLAN_TELEGRAM.md): last alert, alerts today and
 * the Telegram cron's heartbeat age, from data/telegram-status.json (collect.js). The cron
 * saves its heartbeat at most every 10 minutes, so the age reads up to ~10 min high.
 * @param {Object|null} tg - telegramStatusFromState output, or null before the first pull
 * @param {number} nowMs
 * @returns {string} one status-fact <div>
 */
export const NO_ALERT_LOG = '[NO SENT ALERTS LOGGED YET]';
export const NO_TRANSITIONS = '[NO TRANSITIONS LOGGED YET]';
const countsText = (m) => Object.entries(m || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(' · ') || dash;

/**
 * Alerts zone (Telegram sent-alert log + transitions): four instruments and two sections,
 * each section PROVISIONAL. Renders from an empty aggregate.
 * @param {Object} a - computeAlertAggregates output
 * @returns {string[]} tiles
 */
export function alertsZoneTiles(a) {
  const t = a.tiles;
  const rateHtml = (v, n) => (n ? esc(pct(v)) : emptyInline('[NONE YET]'));
  const tpH = Object.entries(t.transitionsPerHour || {});
  const tiles = [
    instrument('tile-alerts-7d', 'Alerts sent · 7d', `<span class="${t.alerts7d ? '' : 'dim'}">${t.alerts7d}</span>`, '', `${t.alertsToday} TODAY`),
    instrument('tile-alert-latency', 'Median latency',
      isNum(t.medianLatencyMin) ? `${esc(num(t.medianLatencyMin, 1))}<span class="hero-unit"> min</span>` : emptyInline('[NONE YET]'), '', `CANDLE CLOSE → SENT · n=${t.latencyN}`),
    instrument('tile-alert-later-good', 'Alerted → later GOOD', rateHtml(t.laterGoodRate, t.laterGoodN),
      inlineBar('alert-later-good-bar', t.laterGoodRate), `n=${t.laterGoodN} ALERTS BEFORE GET IN NOW`),
    instrument('tile-be-ready-to-go', `BE READY → GET IN NOW ≤ ${READY_WITHIN_MIN} min`, rateHtml(t.beReadyToGoRate, t.beReadyN),
      inlineBar('be-ready-to-go-bar', t.beReadyToGoRate), `n=${t.beReadyN} BE READY ALERTS`)
  ];
  const tpBody = tpH.length
    ? `<dl class="stat-rows" id="alerts-transitions-rows">${tpH.map(([tf, v]) => `<div class="stat-row" id="alerts-transitions-${esc(tf)}-row"><dt>${esc(tf)}</dt><dd>${esc(num(v, 2))} / h</dd></div>`).join('')}</dl>`
      + `<p class="mono-note" id="alerts-transitions-total">${t.transitions24h} TRANSITIONS · LAST 24 H</p>`
    : `<p class="empty" id="alerts-transitions-empty">${esc(NO_TRANSITIONS)}</p>`;
  const kindsBody = `<dl class="stat-rows" id="alerts-mix-rows">`
    + `<div class="stat-row" id="alerts-mix-kind-row"><dt>By kind · 7d</dt><dd>${esc(countsText(a.byKind7d))}</dd></div>`
    + `<div class="stat-row" id="alerts-mix-verdict-row"><dt>By verdict · 7d</dt><dd>${esc(countsText(a.byVerdict7d))}</dd></div>`
    + `<div class="stat-row" id="alerts-mix-outcome-row"><dt>Outcome · 7d</dt><dd>${esc(countsText(a.byOutcome7d))}</dd></div></dl>`
    + `<p class="note" id="alerts-mix-note">Latency = sent time minus the close of the alert timeframe's candle that produced it. Outcome = the furthest the candidate got after the alert (tp1 / stop, GET IN NOW, SETUP, confirmed, void, expired). Counts only; nothing here tunes a rule.</p>`;
  const dayRows = a.byDay.map((d) => [d.day, d.alerts, countsText(d.byKind), countsText(d.byVerdict), num(d.medianLatencyMin, 1),
    d.laterGoodOf ? `${d.laterGood} / ${d.laterGoodOf}` : dash, d.transitions]);
  tiles.push(
    section('alerts-mix-section', 'Alert mix and outcomes', kindsBody, { sm: 2, lg: 7 }),
    section('alerts-transitions-section', 'Engine transitions / hour · 24 h', tpBody, { sm: 2, lg: 5 }),
    section('alerts-daily-section', 'Alerts by day', table('alerts-daily-table', ['Day', 'Alerts', 'By kind', 'By verdict', 'Median latency (min)', 'Later GOOD', 'Transitions'], dayRows, NO_ALERT_LOG))
  );
  return tiles;
}

export function alertsFact(tg, nowMs) {
  const none = !tg || (!tg.lastAlert && !tg.cronLastRunAt);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const count = tg && tg.alertsDay === today ? tg.alertsToday : 0;
  const cronMs = tg && tg.cronLastRunAt ? Date.parse(tg.cronLastRunAt) : NaN;
  const cronText = Number.isFinite(cronMs) ? `TELEGRAM CRON ${Math.max(0, Math.round((nowMs - cronMs) / 60_000))} MIN AGO` : 'TELEGRAM CRON NOT SEEN';
  const main = none ? '[NO ALERTS YET]'
    : tg.lastAlert ? `${tg.lastAlert.kind || 'ALERT'}${tg.lastAlert.symbol ? ` ${tg.lastAlert.symbol}` : ''} · ${count} today` : `[NO ALERTS YET] · ${count} today`;
  return `<div class="status-fact" id="system-alerts-fact"><dt><a class="nav-link" id="system-alerts-fact-link" href="#zone-alerts">Alerts →</a></dt><dd id="system-alerts-last">${esc(main)}</dd>`
    + `<dd class="fact-sub" id="system-alerts-sub">${esc(tg && tg.lastAlert ? `${time(tg.lastAlert.at)} · ${cronText}` : cronText)}</dd></div>`;
}

export function renderHtml(agg, data = {}) {
  const t = agg.tiles;
  const nowMs = Date.parse(agg.generatedAt);
  const outcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
  const eqRows = equityRows(outcomes);
  const walletRows = walletChartRows(data.wallet);
  const journal = Array.isArray(data.journal) ? data.journal : [];
  const journalOutcomes = Array.isArray(data.journalOutcomes) ? data.journalOutcomes : [];
  const youRows = journalEquityRows(journalOutcomes);
  const setupRows = setupEquityRows(outcomes);
  const marks = walletMarks(journal, journalOutcomes);
  const ev = engineVsYou(outcomes, journal, journalOutcomes);
  const goods = outcomes.filter((r) => r.kind === 'rec' && r.class === 'GOOD' && r.calledAt).map((r) => r.calledAt);
  const flagPaths = pathsSummary(Array.isArray(data.paths) ? data.paths : [], nowMs);
  const calibration = data.calibration && typeof data.calibration === 'object' ? data.calibration : EMPTY_CALIBRATION;
  const shadowRows = Array.isArray(data.shadowOutcomes) ? data.shadowOutcomes : [];
  const shadowSum = data.shadowSummary && typeof data.shadowSummary === 'object' ? data.shadowSummary : EMPTY_SHADOW_SUMMARY;
  const v3ShadowRows = Array.isArray(data.v3ShadowOutcomes) ? data.v3ShadowOutcomes : [];
  const v3ShadowSum = data.v3ShadowSummary && typeof data.v3ShadowSummary === 'object' ? data.v3ShadowSummary : EMPTY_V3_SHADOW_SUMMARY;
  const w7 = agg.windows['7d'];
  const t7 = w7.tradable;
  const scored7 = t7.wins + t7.losses;
  const c = agg.captures;
  const phase = phaseProgress(agg);

  // Tertiary: top edge + jump nav.
  const topStrip = `<header class="edge-strip" id="tracker-top-edge-strip"><span id="tracker-page-title">EDITTRADES / CALL TRACKER</span>`
    + `<span id="tile-last-capture">LAST CAPTURE ${esc(ageText(t.lastCapture, agg.generatedAt))}</span></header>`
    + jumpNav('tracker-jump-nav', [
      ['#zone-system', 'Status'], ['#zone-performance', 'Performance'], ['#zone-charts', 'Charts'], ['#zone-you', 'Engine vs you'],
      ['#zone-calls', 'Calls'], ['#zone-alerts', 'Alerts'], ['#zone-breakdown', 'Breakdown'], ['#zone-reference', 'Data'],
      ['how-to.html', 'How to use →', 'class="nav-link" id="tracker-how-to-link"'], ['changelog.html', 'System map →', 'class="nav-link" id="tracker-system-map-link"']
    ]);

  // Primary: hero. Net (fees + slippage, costs.js) shown beside gross (T5 S1).
  const heroValue = isNum(t.expectancy7d) && scored7 > 0
    ? `<div class="hero-value ${rStatus(t.expectancy7d)}" id="tile-expectancy-7d">${esc(signed(t.expectancy7d))}<span class="hero-unit">R</span></div>`
    : `<div class="hero-value hero-empty" id="tile-expectancy-7d">0.00<span class="hero-unit">R</span></div><div class="hero-empty-note" id="hero-empty-note">${emptyInline()}</div>`;
  const heroNetLine = isNum(t.expectancy7d) && scored7 > 0
    ? `<div class="hero-n" id="hero-net-expectancy-7d">${esc(signed(t.netExpectancy7d))}R net of fees</div>`
    : '';
  const hero = section('performance-hero-section', 'Expectancy · gross R per scored call',
    `<div class="hero-stack" id="performance-hero-stack">${heroValue}${heroNetLine}`
    + `<div class="hero-n" id="hero-sample-size">n=${scored7} scored call${scored7 === 1 ? '' : 's'} · 7d</div></div>`
    + `<p class="edge-note" id="hero-edge-note">${esc(EDGE_NOTE)}</p>`
    + `<p class="note" id="instrument-row-note">Scored = a ready flag plan that reached TP1 or stop. R is gross, before fees and slippage.</p>`,
    { sm: 2, lg: 6 });

  // Class check: did the filter work? Counterfactual WATCH / BAD scoring, separate from the hero.
  const classCheck = section('class-check-section', 'Class check · did the filter work?', classCheckBody(agg), { sm: 2, lg: 12, foot: CLASS_CHECK_NOTE });

  // Flag paths (T4 P0): measured scenario mix at the tightening point. Measure only.
  const flagPathsSection = section('flag-paths-section', 'Flag paths · scenario mix at tightening', flagPathsBody(flagPaths), { sm: 2, lg: 12, foot: FLAG_PATHS_NOTE });

  // Path calibration (T4 P3): pathOutlook's predicted weights vs the realised path. Measure only.
  const pathCalibrationSection = section('path-calibration-section', 'Path calibration · predicted vs realised', calibrationBody(calibration), { sm: 2, lg: 12, foot: CALIBRATION_NOTE });

  // Breakout entry shadow (T4 P4): breakout-close entry scored but never traded, vs retest. Shadow mode only.
  const breakoutShadowSection = section('breakout-shadow-section', 'Breakout entry (shadow, not traded)', shadowBody(shadowSum, shadowRows), { sm: 2, lg: 12, foot: SHADOW_NOTE });

  // 3R shadow, former live rule (T6 completion plan "D-variant revised"): gross minRR 3.0, computed by the engine itself. Shadow mode only.
  const v3ShadowSection = section('v3-shadow-section', '3R shadow (former live rule) · gross minRR 3.0 (not traded)', v3ShadowBody(v3ShadowSum, v3ShadowRows), { sm: 2, lg: 12, foot: V3_SHADOW_NOTE });

  // Secondary: instruments, one small tile each.
  const good7 = (w7.byClass.find((g) => g.key === 'GOOD') || { calls: 0 }).calls;
  const fillRate = t7.calls ? t7.fills / t7.calls : null;
  const instruments = [
    instrument('tile-win-rate-7d', 'Win rate at TP1',
      scored7 ? esc(pct(t7.winRate)) : emptyInline(),
      segBar('win-rate-7d-bar', (t7.winRate || 0) * 20, 20), scored7 ? `${t7.wins} TP1 / ${t7.losses} STOP` : '', { sm: 2, lg: 6 }),
    instrument('tile-fills-7d', 'Fill rate',
      t7.calls ? esc(pct(fillRate)) : emptyInline('[NO READY PLANS YET]'),
      inlineBar('fill-rate-7d-bar', fillRate), `${t7.fills} / ${t7.calls} READY PLANS`, { sm: 1, lg: 3 }),
    instrument('tile-good-7d', 'GOOD calls', `<span class="${good7 ? '' : 'dim'}">${good7}</span>`, '', `${w7.byClass.reduce((a, g) => a + g.calls, 0)} REC CALLS`),
    instrument('tile-losing-streak-7d', 'Losing streak',
      `<span class="${t.losingStreak7d >= 5 ? 'st-bad' : t.losingStreak7d ? '' : 'dim'}">${t.losingStreak7d}</span>`, '', 'MAX CONSECUTIVE STOPS'),
    instrument('tile-avg-r-7d', 'Avg win R',
      isNum(t7.avgWinR) ? `<span class="${rStatus(t7.avgWinR)}">${esc(rVal(t7.avgWinR))}</span>` : emptyInline(), '', 'GROSS R AT TP1', { sm: 1, lg: 3 }),
    // T6 completion plan C3: visibility tiles - how often does the owner's chat see a
    // GOOD call or a SETUP line, not just the 7-day expectancy above.
    instrument('tile-good-per-hour-7d', 'GOOD / hour',
      isNum(t.goodPerHour7d) ? `<span class="${t.goodPerHour7d ? '' : 'dim'}">${esc(num(t.goodPerHour7d, 3))}</span>` : emptyInline(), '', `${good7} GOOD / 7d`, { sm: 1, lg: 3 }),
    instrument('tile-setups-per-day-7d', 'SETUPs / day',
      isNum(t.setupsPerDay7d) ? `<span class="${t.setupsPerDay7d ? '' : 'dim'}">${esc(num(t.setupsPerDay7d, 2))}</span>` : emptyInline(), '', 'DISTINCT SETUP CANDIDATES / 7d', { sm: 1, lg: 3 })
  ];

  // System status: is the automated job running? Re-evaluated in the browser by statusScript().
  const act = { served24h: 0, servedGood24h: 0, ...(agg.activity || { firstRun: null, runs: 0, runTimes48h: [], recCalls24h: 0, good24h: 0, ready24h: 0, lastGoodAt: null }) };
  const status = systemStatus(t.lastCapture, nowMs);
  const next = nextRunMs(nowMs);
  const firstRunMs = act.firstRun ? Date.parse(act.firstRun) : null;
  const runMs = act.runTimes48h.map((iso) => Date.parse(iso));
  // Heartbeat marks slots with at least one run; the counter counts runs (manual runs can share a slot).
  const runs24h = runMs.filter((ms) => ms >= nowMs - HEARTBEAT_SLOTS * SLOT_MS).length;
  let slotsHit = 0;
  const beats = Array.from({ length: HEARTBEAT_SLOTS }, (_, i) => {
    const from = nowMs - (HEARTBEAT_SLOTS - i) * SLOT_MS;
    const to = from + SLOT_MS;
    if (firstRunMs === null || to <= firstRunMs) return '<i class="pre"></i>';
    const hit = runMs.some((ms) => ms >= from && ms < to);
    if (hit) slotsHit++;
    return hit ? '<i class="on"></i>' : '<i class="miss"></i>';
  }).join('');
  const expectedSlots = firstRunMs === null ? 0 : Math.min(HEARTBEAT_SLOTS, Math.ceil((nowMs - Math.max(firstRunMs, nowMs - HEARTBEAT_SLOTS * SLOT_MS)) / SLOT_MS));
  const expected24h = firstRunMs === null ? 0 : expectedRuns(Math.max(firstRunMs, nowMs - HEARTBEAT_SLOTS * SLOT_MS), nowMs);
  const statusBody = `<div class="status-hero" id="system-status-hero">`
    + `<span class="status-dot ${status.cls}${status.word === 'LIVE' ? ' is-live' : ''}" id="system-status-dot" aria-hidden="true"></span>`
    + `<span class="status-big ${status.cls}" id="system-status-word">${esc(status.word)}</span>`
    + `<span class="status-desc" id="system-status-desc">Automated · no manual step. ${esc(SCHEDULE_TEXT)} on GitHub Actions: pull the engine, score calls, email new GOOD calls, rebuild this page.</span></div>`
    + `<dl class="status-facts" id="system-status-facts">`
    + `<div class="status-fact" id="system-last-run-fact"><dt>Last run</dt><dd id="system-last-run-age">${esc(status.mins === null ? 'none yet' : `${status.mins} min ago`)}</dd><dd class="fact-sub" id="system-last-run-time">${esc(time(t.lastCapture))}</dd></div>`
    + `<div class="status-fact" id="system-next-run-fact"><dt>Next run</dt><dd id="system-next-run">${esc(next ? `in ${Math.max(1, Math.ceil((next - nowMs) / 60_000))} min` : dash)}</dd><dd class="fact-sub">EVERY 10 MIN · :07 :17 … :57 UTC</dd></div>`
    + `<div class="status-fact" id="system-runs-fact"><dt>Runs · 24 h</dt><dd id="system-runs-24h">${runs24h} / ${expected24h || dash}</dd><dd class="fact-sub">${act.runs} since ${esc(act.firstRun ? act.firstRun.slice(0, 10) : dash)}</dd></div>`
    + alertsFact(data.telegram || null, nowMs)
    + `</dl>`
    + `<p class="note status-channel-note" id="system-alerts-channel-note">Alerts: Telegram @EditTrades_Bot · <a class="nav-link" id="system-alerts-channel-link" href="how-to.html#howto-telegram-section">how alerts work →</a></p>`
    + `<div class="heartbeat-wrap" id="system-heartbeat-wrap"><div class="heartbeat" id="system-heartbeat" style="grid-template-columns:repeat(${HEARTBEAT_SLOTS},1fr)" role="img" aria-label="${slotsHit} of ${expectedSlots} half-hour slots in the last 24 hours had a run">${beats}</div>`
    + `<div class="heartbeat-axis" id="system-heartbeat-axis"><span>24 H AGO</span><span class="heartbeat-key"><i class="on"></i>RUN <i class="miss"></i>MISSED</span><span>BUILT ${esc(time(agg.generatedAt).slice(11))}</span></div></div>`;
  const statusTile = tile({
    id: 'system-status-section', as: 'div', cls: 'tile-status', sm: 2, lg: 12,
    body: statusBody, data: { lastCapture: t.lastCapture || '' }
  });

  // Testing phase timeline.
  const scoredText = isNum(phase.scored) ? phase.scored : dash;
  const dayRate = phase.elapsed ? (phase.scored || 0) / phase.elapsed : 0;
  const remaining = Math.max(0, PHASE_TARGET_PLANS - (phase.scored || 0));
  const etaText = remaining === 0 ? 'TARGET REACHED'
    : dayRate > 0 ? `AT ${num(dayRate, 1)}/DAY ≈ ${new Date(nowMs + (remaining / dayRate) * DAY).toISOString().slice(0, 10)}`
      : 'ETA UNKNOWN · NO SCORED PLANS YET';
  const dayCells = Array.from({ length: PHASE_DAYS }, (_, i) => `<i class="${i < phase.elapsed - 1 ? 'on' : i === phase.elapsed - 1 ? 'on now' : ''}"></i>`).join('');
  const phaseBody = `<div class="phase-head" id="testing-phase-head-row"><span class="status-word" id="testing-phase-status">[${esc(phase.status)}]</span>`
    + `<span class="phase-day" id="testing-phase-day">Day ${phase.elapsed} <span class="phase-of">of ${PHASE_DAYS}</span></span></div>`
    + `<div class="progress" id="testing-phase-days-progress"><div class="seg seg-hero seg-days" id="testing-phase-days-bar" style="grid-template-columns:repeat(${PHASE_DAYS},1fr)" role="img" aria-label="Day ${phase.elapsed} of ${PHASE_DAYS}">${dayCells}</div>`
    + `<div class="timeline-axis" id="testing-phase-axis"><span>START ${esc(PHASE_START.slice(5))}</span><span>PULSING = TODAY</span><span>END ${esc(phase.endDate.slice(5))}</span></div></div>`
    + `<div class="progress" id="testing-phase-plans-progress"><div class="progress-head"><span class="label">Plans scored (TP1 or stop)</span><span class="progress-val">${scoredText} / ${PHASE_TARGET_PLANS}</span></div>${segBar('testing-phase-plans-bar', phase.scored || 0, PHASE_TARGET_PLANS, 'hero')}`
    + `<div class="timeline-axis" id="testing-phase-plans-eta"><span>${esc(etaText)}</span></div></div>`
    + `<dl class="stat-rows" id="testing-phase-rows">`
    + `<div class="stat-row"><dt>Phase</dt><dd>${esc(PHASE_NAME.toUpperCase())}</dd></div>`
    + `<div class="stat-row"><dt>Done when</dt><dd>DAY ${PHASE_DAYS} AND ≥ ${PHASE_TARGET_PLANS} SCORED PLANS</dd></div>`
    + `<div class="stat-row"><dt>Then</dt><dd>ONE CALIBRATION PASS WITH YOU</dd></div>`
    + `<div class="stat-row" id="testing-phase-frozen-row"><dt>Thresholds</dt><dd>FROZEN UNTIL ${esc(FROZEN_UNTIL)}</dd></div>`
    + `</dl>`
    + `<p class="mono-note" id="testing-phase-frozen">LIVE RULES: GROSS MINRR 2.5, NET GATE OFF (NET R SHOWN), 3R AS SHADOW. NO TUNING UNTIL ${esc(FROZEN_UNTIL)}. CONFIG BOUNDARY MARKED AT EACH CONFIGVERSION CHANGE; STATS SPLIT BEFORE / AFTER. ALL LABELS PROVISIONAL.</p>`
    + configBoundaryNote(agg.configBoundary);

  // Activity, last 24 h.
  const activityBody = `<dl class="stat-rows" id="activity-24h-rows">`
    + `<div class="stat-row" id="activity-rec-calls-row"><dt>Recommendation calls</dt><dd>${act.recCalls24h}</dd></div>`
    + `<div class="stat-row" id="activity-good-row"><dt>GOOD calls</dt><dd class="${act.good24h ? 'st-good' : 'dim'}">${act.good24h}</dd></div>`
    + `<div class="stat-row" id="activity-ready-row"><dt>Ready plans</dt><dd class="${act.ready24h ? '' : 'dim'}">${act.ready24h}</dd></div>`
    + `<div class="stat-row" id="activity-open-row"><dt>Open calls now</dt><dd class="${agg.openCalls.length ? '' : 'dim'}">${agg.openCalls.length}</dd></div>`
    + `<div class="stat-row" id="activity-last-good-row"><dt>Last GOOD call</dt><dd>${esc(act.lastGoodAt ? time(act.lastGoodAt) : 'NONE YET')}</dd></div>`
    + `<div class="stat-row" id="activity-served-row"><dt>Seen in chat · 24 h</dt><dd class="${act.served24h ? '' : 'dim'}">${act.served24h}${act.servedGood24h ? ` <span class="st-good">(${act.servedGood24h} GOOD)</span>` : ''}</dd></div>`
    + `</dl>`
    + `<p class="note" id="activity-24h-note">Only GOOD calls with a ready plan get scored. Mostly WATCH and BAD is normal while the market sets up.</p>`;

  // What we track and why.
  const planCount = w7.byPlanStatus.reduce((a, g) => a + g.calls, 0);
  const recCount = w7.byClass.reduce((a, g) => a + g.calls, 0);
  const topReason = w7.byReason[0] ? w7.byReason[0].key : dash;
  const drift = c.markDriftBps;
  const track = [
    ['track-flag-plans-row', 'Flag trade plans', 'Ready, conditional and rejected plans; the engine owns entry, stop and TP1.', `${planCount} · 7D`],
    ['track-rec-class-row', 'Recommendation class', 'GOOD, WATCH, BAD, DATA_UNAVAILABLE; checks fidelity to the 21/200 rules.', `${recCount} · 7D`],
    ['track-reason-codes-row', 'Reason codes', 'chase, rr_below_min, room_at_entry and the rest; shows which rule blocks most.', `TOP ${topReason}`],
    ['track-outcomes-row', 'Outcome per call', 'tp1, stop, not_filled or expired with gross R and the plan netRR; does a ready plan reach TP1 before stop.', `${scored7} SCORED · 7D`],
    ['track-mark-drift-row', 'Mark drift', 'Pyth mark against the Kraken close; stops are hit on mark.', isNum(drift.medianAbs) ? `MED ${num(drift.medianAbs)} BPS` : dash],
    ['track-candle-coverage-row', 'Candle coverage', 'Stored closed 1m candles and gaps; sets scoring precision.', `${c.missing1mCandles} MISSING 1M`]
  ];
  const trackBody = `<dl class="track-list" id="track-list">${track.map(([id, label, why, val]) => `<div class="track-row" id="${id}"><dt>${esc(label)}</dt><dd class="track-why">${esc(why)}</dd><dd class="track-val">${esc(val)}</dd></div>`).join('')}</dl>`;

  // Tables.
  const openRows = agg.openCalls.map((r) => [time(r.calledAt), r.symbol, callLabel(r), r.timeframe || dash, r.direction || dash, levels(r), r.outcome, time(r.filledAt), num(r.netRR)]);
  const w = (k) => agg.windows[k];
  const windowBody = (k) => `<p class="mono-note" id="window-${k}-reason-counts">CHASE ${w(k).reasonCounts.chase} · RR_BELOW_MIN ${w(k).reasonCounts.rr_below_min} · ROOM ${w(k).reasonCounts.room}</p>`
    + `<div id="window-${k}-subs">`
    + sub(`window-${k}-by-class-sub`, 'By class (recommendation calls)', statTable(`window-${k}-by-class-table`, w(k).byClass, 'Class'), true)
    + sub(`window-${k}-by-reason-sub`, 'By reason code', statTable(`window-${k}-by-reason-table`, w(k).byReason, 'Reason'))
    + sub(`window-${k}-by-symbol-sub`, 'Ready plans by symbol', statTable(`window-${k}-by-symbol-table`, w(k).bySymbol, 'Symbol'))
    + sub(`window-${k}-by-timeframe-sub`, 'Ready plans by timeframe', statTable(`window-${k}-by-timeframe-table`, w(k).byTimeframe, 'Timeframe'))
    + sub(`window-${k}-by-plan-status-sub`, 'Plans by status', statTable(`window-${k}-by-plan-status-table`, w(k).byPlanStatus, 'Plan status'))
    + `</div>`;

  const dayRows = agg.byDay.map((d) => [d.day, d.recCalls, d.good, d.watch, d.bad, d.dataUnavailable, d.ready, d.fills, d.wins, d.losses, { v: rVal(d.expectancy), cls: rStatus(d.expectancy) }]);
  const logRows = agg.dailyLog.map((r) => {
    const rv = r.outcome === 'stop' ? -1 : r.r;
    return [time(r.calledAt), r.symbol, callLabel(r), r.reasonCode || dash, r.timeframe || dash, r.direction || dash, levels(r),
      r.levelSource === 'plan' || r.levelSource === 'candidate' ? r.levelSource : dash,
      { v: r.outcome, cls: outcomeStatus(r.outcome) }, { v: rVal(rv), cls: rStatus(rv) }, num(r.minutesToResolution, 0), callVia(r)];
  });
  const healthRows = [
    ['Capture rows', c.captures], ['Symbols', c.symbols.join(', ') || dash],
    ['Capture gaps (> 20 min)', { v: c.gaps, cls: c.gaps ? 'st-warn' : '' }], ['Longest gap (min)', num(c.longestGapMinutes, 0)],
    ['DATA_UNAVAILABLE captures', { v: c.dataUnavailable, cls: c.dataUnavailable ? 'st-warn' : '' }],
    ['Mark drift |bps| median / p95 / max', `${num(drift.medianAbs)} / ${num(drift.p95Abs)} / ${num(drift.maxAbs)}`],
    ['Mark status not ok', { v: drift.notOk, cls: drift.notOk ? 'st-warn' : '' }],
    ['1m candles stored', Object.entries(c.candles1m).map(([s, n]) => `${s} ${n}`).join(', ') || dash],
    ['Missing 1m candles inside stored span', c.missing1mCandles]
  ];

  // Tertiary: bottom edge.
  const bottomStrip = `<footer class="edge-strip" id="tracker-bottom-edge-strip">`
    + `<span id="capture-health-summary">GAPS ${c.gaps} · LONGEST ${num(c.longestGapMinutes, 0)} MIN · DRIFT MED ${num(drift.medianAbs)} / MAX ${num(drift.maxAbs)} BPS · MARK NOT OK ${drift.notOk} · MISSING 1M ${c.missing1mCandles}</span>`
    + `<span id="page-generated-at">GENERATED ${esc(time(agg.generatedAt))} · LAST CLOSE ${esc(time(t.lastClosedThrough))} · ${agg.totals.outcomes} ROWS</span></footer>`;

  const body = [
    zone({
      id: 'zone-system', title: 'System', sub: 'Automated tracker · testing window',
      tiles: [
        statusTile,
        section('testing-phase-section', 'Testing timeline', phaseBody, { sm: 2, lg: 7 }),
        tile({ id: 'activity-24h-section', title: 'Activity · last 24 h', as: 'div', sm: 2, lg: 5, body: activityBody })
      ]
    }),
    zone({
      id: 'zone-performance', title: 'Performance', sub: 'Last 7 days · gross R, before fees',
      tiles: [hero, classCheck, flagPathsSection, pathCalibrationSection, breakoutShadowSection, v3ShadowSection, ...instruments]
    }),
    zone({
      id: 'zone-charts', title: 'Charts', sub: 'Engine calls, your trades, wallet',
      tiles: [
        section('equity-chart-section', 'Engine-call equity curve', equityBody(eqRows, nowMs, youRows, setupRows)),
        section('wallet-chart-section', 'Wallet value', walletBody(walletRows, goods, nowMs, marks))
      ]
    }),
    zone({
      id: 'zone-you', title: 'Engine vs you', sub: 'From your journal',
      tiles: [
        section('engine-vs-you-section', 'GOOD calls taken, skipped, overridden', engineVsYouBody(ev), { sm: 2, lg: 5 }),
        section('journal-log-section', 'Journal log (last 50)', table('journal-log-table', ['Time', 'Kind', 'Symbol', 'Dir', 'Entry / stop / TP1', 'Outcome', 'R', 'Engine', 'You said'], journalLogRows(journal, journalOutcomes), NO_JOURNAL), { sm: 2, lg: 7 })
      ]
    }),
    zone({
      id: 'zone-calls', title: 'Calls', sub: 'Open now, recent, by day',
      tiles: [
        section('open-calls-section', 'Open calls now', table('open-calls-table', ['Called', 'Symbol', 'Call', 'TF', 'Dir', 'Entry / stop / TP1', 'Status', 'Filled', 'Net R:R'], openRows, '[NO OPEN CALLS]')),
        section('daily-log-section', 'Call log (last 7 days)', table('daily-log-table', ['Called', 'Symbol', 'Call', 'Reason', 'TF', 'Dir', 'Entry / stop / TP1', 'Levels', 'Outcome', 'R', 'Min', 'Via'], logRows, '[NO CALLS YET]')),
        section('daily-summary-section', 'By day', table('daily-summary-table', ['Day', 'Calls', 'GOOD', 'WATCH', 'BAD', 'DATA_UNAV', 'Ready plans', 'Fills', 'TP1', 'Stop', 'Exp.'], dayRows, '[NO ROWS YET]', 1))
      ]
    }),
    zone({
      id: 'zone-alerts', title: 'Alerts', sub: 'Telegram · sent alerts and engine transitions',
      tiles: alertsZoneTiles(agg.alerts || computeAlertAggregates([], [], nowMs))
    }),
    zone({
      id: 'zone-breakdown', title: 'Breakdown', sub: 'By class, reason, symbol, timeframe',
      tiles: [
        section('window-7d-section', 'Last 7 days', windowBody('7d')),
        section('window-30d-section', 'Last 30 days', windowBody('30d'))
      ]
    }),
    zone({
      id: 'zone-reference', title: 'Data', sub: 'What is tracked, capture health',
      tiles: [
        section('what-we-track-section', 'What we track and why', trackBody, { sm: 2, lg: 7 }),
        section('data-health-section', 'Data health', table('data-health-table', ['Metric', 'Value'], healthRows, '[NO ROWS YET]', 1), { sm: 2, lg: 5 })
      ]
    })
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades Call Tracker</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}${CHART_CSS}
</style>
</head>
<body>
<main id="tracker-page-main">
${topStrip}
${body}
${bottomStrip}
</main>
<script type="application/json" id="tracker-calls-data">${jsonForScript({ now: agg.generatedAt, dims: FILTER_DIMS, rows: eqRows, you: youRows, setup: setupRows })}</script>
<script type="application/json" id="tracker-wallet-data">${jsonForScript({ now: agg.generatedAt, range: DEFAULT_WALLET_RANGE, rows: walletRows, good: goods, marks })}</script>
<script>${chartScript()}${statusScript()}</script>
</body>
</html>
`;
}

// ---------- report.md ----------

function mdTable(headers, rows) {
  if (!rows.length) return '_none yet_\n';
  const txt = (c) => String(c && typeof c === 'object' ? c.v : (c ?? '')).replace(/\|/g, '/');
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map(txt).join(' | ')} |`).join('\n')}\n`;
}

function mdStats(groups, keyLabel) {
  return mdTable([keyLabel, ...STAT_COLUMNS.map((c) => c[0])], groups.map((g) => [g.key, ...STAT_COLUMNS.map((c) => c[1](g))]));
}

export function renderReport(agg) {
  const t = agg.tiles;
  const w = agg.windows;
  const t7 = w['7d'].tradable;
  const phase = phaseProgress(agg);
  const out = [];
  out.push(`# EditTrades call tracker report\n\nGenerated ${time(agg.generatedAt)}. R is gross, before fees and slippage. ${EDGE_NOTE}\n`);
  out.push(`## Testing phase\n\n_${PROVISIONAL}_\n`);
  out.push(`- Status: ${phase.status}\n- Phase: ${PHASE_NAME}, start ${PHASE_START}, ends ${phase.endDate}\n- Thresholds frozen until ${FROZEN_UNTIL}\n- Target: ${PHASE_DAYS} days / >= ${PHASE_TARGET_PLANS} scored plans\n- Progress: day ${phase.elapsed} / ${PHASE_DAYS}, plans scored ${isNum(phase.scored) ? phase.scored : dash} / ${PHASE_TARGET_PLANS}\n- Frozen during the window: no threshold tuning\n`);
  out.push(`## Summary\n\n_${PROVISIONAL}_\n`);
  out.push(mdTable(['Expectancy 7d', 'Scored 7d', 'Win rate 7d', 'Fills 7d', 'Losing streak 7d', 'Avg win R 7d', 'Last capture'],
    [[isNum(t.expectancy7d) ? rVal(t.expectancy7d) : NO_SCORED, t7.wins + t7.losses, pct(t.winRate7d), `${t7.fills} / ${t7.calls}`, t.losingStreak7d, rVal(t7.avgWinR), time(t.lastCapture)]]));
  out.push(`\n## Class check\n\n_${PROVISIONAL}_\n`);
  const ccRows = classCheckRows(agg);
  out.push(ccRows
    ? mdTable([...CLASS_CHECK_HEADERS, 'Verdict'], ccRows.map((r) => [...classCheckCells(r), classVerdict(r).text]))
    : `${NO_CLASS_CALLS}\n`);
  out.push(`\n${CLASS_CHECK_NOTE}\n`);
  out.push(`\n## Open calls\n\n_${PROVISIONAL}_\n`);
  out.push(mdTable(['Called', 'Symbol', 'Call', 'TF', 'Dir', 'Entry / stop / TP1', 'Status'],
    agg.openCalls.map((r) => [time(r.calledAt), r.symbol, callLabel(r), r.timeframe || dash, r.direction || dash, levels(r), r.outcome])));
  for (const k of ['7d', '30d']) {
    out.push(`\n## Last ${k}\n\n_${PROVISIONAL}_\n\nBy class:\n\n${mdStats(w[k].byClass, 'Class')}\nBy reason:\n\n${mdStats(w[k].byReason, 'Reason')}\nReady plans by symbol:\n\n${mdStats(w[k].bySymbol, 'Symbol')}`);
  }
  out.push(`\n## By day\n\n_${PROVISIONAL}_\n`);
  out.push(mdTable(['Day', 'Calls', 'GOOD', 'WATCH', 'BAD', 'Ready', 'Fills', 'TP1', 'Stop', 'Exp.'],
    agg.byDay.map((d) => [d.day, d.recCalls, d.good, d.watch, d.bad, d.ready, d.fills, d.wins, d.losses, rVal(d.expectancy)])));
  const c = agg.captures;
  out.push(`\n## Data health\n\n_${PROVISIONAL}_\n\nCaptures ${c.captures}, gaps ${c.gaps}, DATA_UNAVAILABLE ${c.dataUnavailable}, mark drift |bps| median ${num(c.markDriftBps.medianAbs)} / max ${num(c.markDriftBps.maxAbs)}, missing 1m candles ${c.missing1mCandles}.\n`);
  return out.join('\n');
}

export function buildPage(dataDir, outDir, nowMs = Date.now()) {
  const agg = aggregateDataDir(dataDir, nowMs, { phaseStartMs: PHASE_START_MS });
  ensureDir(outDir);
  const htmlFile = path.join(outDir, 'index.html');
  const mdFile = path.join(outDir, 'report.md');
  const howToFile = path.join(outDir, 'how-to.html');
  writeFileSync(htmlFile, renderHtml(agg, {
    outcomes: readJsonl(outcomesFile(dataDir)), wallet: readWallet(dataDir),
    journal: readJournal(dataDir), journalOutcomes: readJsonl(journalOutcomesFile(dataDir)),
    telegram: readJson(telegramStatusFile(dataDir), null),
    paths: readJsonl(pathsFile(dataDir)), calibration: readJson(calibrationFile(dataDir), null),
    shadowOutcomes: readJsonl(shadowOutcomesFile(dataDir)), shadowSummary: readJson(shadowSummaryFile(dataDir), null),
    v3ShadowOutcomes: readJsonl(v3ShadowOutcomesFile(dataDir)), v3ShadowSummary: readJson(v3ShadowSummaryFile(dataDir), null)
  }));
  writeFileSync(mdFile, renderReport(agg));
  writeFileSync(howToFile, renderHowTo());
  return { agg, htmlFile, mdFile, howToFile };
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const { htmlFile, mdFile, agg } = buildPage(opts.data, opts.out, nowMs);
  console.log(`[tracker:page] ${agg.totals.outcomes} row(s) -> ${htmlFile}, ${mdFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:page] ${err.message}`);
    process.exit(1);
  }
}
