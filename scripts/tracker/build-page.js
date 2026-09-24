#!/usr/bin/env node
/**
 * EditTrades call tracker - review page (T1, docs/PLAN_CALL_TRACKER.md item 5).
 *
 * Recomputes aggregates from the data dir (writes data/aggregates.json), then renders
 * one static page `<out>/index.html` and `<out>/report.md` with the same numbers.
 *
 * Page design: Nothing design system (Space Grotesk + Space Mono, Doto for the one hero
 * number). No scripts, inline CSS, light (warm off-white) and dark (OLED black) via
 * prefers-color-scheme, phone-width first. Three layers:
 *   primary   - 7-day expectancy in gross R per scored call (TP1 or stop), sample size under it
 *   secondary - instruments: win rate at TP1, fill rate, GOOD calls 7d, losing streak, avg win R
 *   tertiary  - capture health in Space Mono caps at the top and bottom edges
 * Then the testing-phase block, "what we track and why", and the tables. Every section
 * carries a PROVISIONAL tag; the edge disclaimer appears once, under the hero. Renders
 * from an empty data dir.
 *
 * Usage: node build-page.js [--data ./data] [--out ./docs] [--now <iso>]
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, ensureDir } from './store.js';
import { aggregateDataDir } from './aggregate.js';

export const PROVISIONAL = 'provisional; not evidence of an edge';
export const EDGE_NOTE = "Not evidence of an edge. Scores the engine's calls against later closed candles.";
export const NO_SCORED = '[NO SCORED CALLS YET]';

// Active testing phase (docs/MASTER_PLAN_NEXT_STEPS.md Phase 4). Edit here when the phase changes.
export const PHASE_NAME = 'Phase 4 forward paper record';
export const PHASE_START = '2026-09-23';
export const PHASE_DAYS = 14;
export const PHASE_TARGET_PLANS = 30;
const PHASE_START_MS = Date.parse(`${PHASE_START}T00:00:00Z`);

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
  ['Avg net R:R (plan)', (s) => num(s.avgNetRR)],
  ['Max loss streak', (s) => ({ v: s.maxLosingStreak, cls: s.maxLosingStreak >= 5 ? 'st-bad' : '' })],
  ['Median min to TP1', (s) => num(s.medianMinutesToTP1, 0)]
];

function statTable(id, groups, keyLabel) {
  return table(id, [keyLabel, ...STAT_COLUMNS.map((c) => c[0])], groups.map((g) => [g.key, ...STAT_COLUMNS.map((c) => c[1](g))]), '[NO ROWS YET]', 1);
}

function section(id, title, body, extraClass = '') {
  return `<section id="${id}" data-section="${id}"${extraClass ? ` class="${extraClass}"` : ''}>`
    + `<div class="section-head" id="${id}-head"><h2>${esc(title)}</h2><span class="prov-tag">PROVISIONAL</span></div>${body}</section>`;
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

function instrument(id, label, valueHtml, visual = '', sub = '') {
  return `<div class="instrument" id="${id}"><div class="label">${esc(label)}</div><div class="inst-value">${valueHtml}</div>${visual}${sub ? `<div class="inst-sub">${esc(sub)}</div>` : ''}</div>`;
}

const emptyInline = (text = NO_SCORED) => `<span class="empty-inline">${esc(text)}</span>`;

// ---------- page ----------

export function renderHtml(agg) {
  const t = agg.tiles;
  const w7 = agg.windows['7d'];
  const t7 = w7.tradable;
  const scored7 = t7.wins + t7.losses;
  const c = agg.captures;
  const phase = phaseProgress(agg);

  // Tertiary: top edge.
  const topStrip = `<header class="edge-strip" id="tracker-top-edge-strip"><span id="tracker-page-title">EDITTRADES / CALL TRACKER</span>`
    + `<span id="tile-last-capture">LAST CAPTURE ${esc(ageText(t.lastCapture, agg.generatedAt))}</span></header>`;

  // Primary: hero.
  const heroValue = isNum(t.expectancy7d) && scored7 > 0
    ? `<div class="hero-value ${rStatus(t.expectancy7d)}" id="tile-expectancy-7d">${esc(signed(t.expectancy7d))}<span class="hero-unit">R</span></div>`
    : `<div class="hero-value hero-empty" id="tile-expectancy-7d">0.00<span class="hero-unit">R</span></div><div class="hero-empty-note" id="hero-empty-note">${emptyInline()}</div>`;
  const hero = `<section id="performance-hero-section" data-section="performance-hero-section" class="hero">`
    + `<div class="section-head" id="performance-hero-head"><span class="label">Expectancy · 7d · gross R per scored call</span><span class="prov-tag">PROVISIONAL</span></div>`
    + heroValue
    + `<div class="hero-n" id="hero-sample-size">n=${scored7} scored call${scored7 === 1 ? '' : 's'} · 7d</div>`
    + `<p class="edge-note" id="hero-edge-note">${esc(EDGE_NOTE)}</p></section>`;

  // Secondary: instruments.
  const good7 = (w7.byClass.find((g) => g.key === 'GOOD') || { calls: 0 }).calls;
  const fillRate = t7.calls ? t7.fills / t7.calls : null;
  const instruments = `<section id="instrument-row-section" data-section="instrument-row-section">`
    + `<div class="section-head" id="instrument-row-head"><h2>Last 7 days</h2><span class="prov-tag">PROVISIONAL</span></div>`
    + `<div class="instruments" id="instrument-row">`
    + instrument('tile-win-rate-7d', 'Win rate at TP1',
      scored7 ? esc(pct(t7.winRate)) : emptyInline(),
      segBar('win-rate-7d-bar', (t7.winRate || 0) * 20, 20), scored7 ? `${t7.wins} TP1 / ${t7.losses} STOP` : '')
    + instrument('tile-fills-7d', 'Fill rate',
      t7.calls ? esc(pct(fillRate)) : emptyInline('[NO READY PLANS YET]'),
      inlineBar('fill-rate-7d-bar', fillRate), `${t7.fills} / ${t7.calls} READY PLANS`)
    + instrument('tile-good-7d', 'GOOD calls', `<span class="${good7 ? '' : 'dim'}">${good7}</span>`, '', `${w7.byClass.reduce((a, g) => a + g.calls, 0)} REC CALLS`)
    + instrument('tile-losing-streak-7d', 'Losing streak',
      `<span class="${t.losingStreak7d >= 5 ? 'st-bad' : t.losingStreak7d ? '' : 'dim'}">${t.losingStreak7d}</span>`, '', 'MAX CONSECUTIVE STOPS')
    + instrument('tile-avg-r-7d', 'Avg win R',
      isNum(t7.avgWinR) ? `<span class="${rStatus(t7.avgWinR)}">${esc(rVal(t7.avgWinR))}</span>` : emptyInline(), '', 'GROSS R AT TP1')
    + `</div><p class="note" id="instrument-row-note">Scored = a ready flag plan that reached TP1 or stop. R is gross, before fees and slippage.</p></section>`;

  // Testing phase.
  const scoredText = isNum(phase.scored) ? phase.scored : dash;
  const phaseBody = `<dl class="stat-rows" id="testing-phase-rows">`
    + `<div class="stat-row" id="testing-phase-status-row"><dt>Status</dt><dd><span class="status-word" id="testing-phase-status">[${esc(phase.status)}]</span></dd></div>`
    + `<div class="stat-row"><dt>Phase</dt><dd>${esc(PHASE_NAME.toUpperCase())}</dd></div>`
    + `<div class="stat-row"><dt>Start</dt><dd>${esc(PHASE_START)} → ${esc(phase.endDate)}</dd></div>`
    + `<div class="stat-row"><dt>Target</dt><dd>${PHASE_DAYS} DAYS / ≥ ${PHASE_TARGET_PLANS} SCORED PLANS</dd></div>`
    + `</dl>`
    + `<div class="progress" id="testing-phase-days-progress"><div class="progress-head"><span class="label">Days elapsed</span><span class="progress-val">${phase.elapsed} / ${PHASE_DAYS}</span></div>${segBar('testing-phase-days-bar', phase.elapsed, PHASE_DAYS, 'hero')}</div>`
    + `<div class="progress" id="testing-phase-plans-progress"><div class="progress-head"><span class="label">Plans scored (TP1 or stop)</span><span class="progress-val">${scoredText} / ${PHASE_TARGET_PLANS}</span></div>${segBar('testing-phase-plans-bar', phase.scored || 0, PHASE_TARGET_PLANS, 'hero')}</div>`
    + `<p class="mono-note" id="testing-phase-frozen">FROZEN DURING THE WINDOW: NO THRESHOLD TUNING. ONE CALIBRATION PASS WITH THE OWNER AFTER THE WINDOW CLOSES. ALL LABELS PROVISIONAL.</p>`;

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
  const windowBody = (k) => `<h3>By class (recommendation calls)</h3>${statTable(`window-${k}-by-class-table`, w(k).byClass, 'Class')}`
    + `<h3>By reason code</h3>${statTable(`window-${k}-by-reason-table`, w(k).byReason, 'Reason')}`
    + `<h3>Ready plans by symbol</h3>${statTable(`window-${k}-by-symbol-table`, w(k).bySymbol, 'Symbol')}`
    + `<h3>Ready plans by timeframe</h3>${statTable(`window-${k}-by-timeframe-table`, w(k).byTimeframe, 'Timeframe')}`
    + `<h3>Plans by status</h3>${statTable(`window-${k}-by-plan-status-table`, w(k).byPlanStatus, 'Plan status')}`
    + `<p class="mono-note">CHASE ${w(k).reasonCounts.chase} · RR_BELOW_MIN ${w(k).reasonCounts.rr_below_min} · ROOM ${w(k).reasonCounts.room}</p>`;

  const dayRows = agg.byDay.map((d) => [d.day, d.recCalls, d.good, d.watch, d.bad, d.dataUnavailable, d.ready, d.fills, d.wins, d.losses, { v: rVal(d.expectancy), cls: rStatus(d.expectancy) }]);
  const logRows = agg.dailyLog.map((r) => {
    const rv = r.outcome === 'stop' ? -1 : r.r;
    return [time(r.calledAt), r.symbol, callLabel(r), r.reasonCode || dash, r.timeframe || dash, r.direction || dash, levels(r),
      { v: r.outcome, cls: outcomeStatus(r.outcome) }, { v: rVal(rv), cls: rStatus(rv) }, num(r.minutesToResolution, 0)];
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
    hero,
    instruments,
    section('testing-phase-section', 'Testing phase', phaseBody),
    section('what-we-track-section', 'What we track and why', trackBody),
    section('open-calls-section', 'Open calls now', table('open-calls-table', ['Called', 'Symbol', 'Call', 'TF', 'Dir', 'Entry / stop / TP1', 'Status', 'Filled', 'Net R:R'], openRows, '[NO OPEN CALLS]')),
    section('window-7d-section', 'Last 7 days by class and reason', windowBody('7d')),
    section('window-30d-section', 'Last 30 days by class and reason', windowBody('30d')),
    section('daily-summary-section', 'By day', table('daily-summary-table', ['Day', 'Calls', 'GOOD', 'WATCH', 'BAD', 'DATA_UNAV', 'Ready plans', 'Fills', 'TP1', 'Stop', 'Exp.'], dayRows, '[NO ROWS YET]', 1)),
    section('daily-log-section', 'Call log (last 7 days)', table('daily-log-table', ['Called', 'Symbol', 'Call', 'Reason', 'TF', 'Dir', 'Entry / stop / TP1', 'Outcome', 'R', 'Min'], logRows, '[NO CALLS YET]')),
    section('data-health-section', 'Data health', table('data-health-table', ['Metric', 'Value'], healthRows, '[NO ROWS YET]', 1))
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
:root{
  --black:#F5F5F5;--surface:#FFFFFF;--border:#E8E8E8;--border-visible:#CCCCCC;--seg-empty:#E0E0E0;
  --text-disabled:#999999;--text-secondary:#666666;--text-primary:#1A1A1A;--text-display:#000000;
  --success:#4A9E5C;--warning:#D4A843;--accent:#D71921;
  --fs-sm:12px;--fs-md:24px;--fs-hero:clamp(88px,26vw,160px);
  --grotesk:"Space Grotesk","DM Sans",system-ui,sans-serif;--mono:"Space Mono","SF Mono",ui-monospace,monospace;--doto:"Doto","Space Mono",monospace;
  color-scheme:light}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--black:#F5F5F5;--surface:#FFFFFF;--border:#E8E8E8;--border-visible:#CCCCCC;--seg-empty:#E0E0E0;--text-disabled:#999999;--text-secondary:#666666;--text-primary:#1A1A1A;--text-display:#000000;color-scheme:light}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--black:#000000;--surface:#111111;--border:#222222;--border-visible:#333333;--seg-empty:#222222;--text-disabled:#666666;--text-secondary:#999999;--text-primary:#E8E8E8;--text-display:#FFFFFF;color-scheme:dark}}
:root[data-theme="dark"]{--black:#000000;--surface:#111111;--border:#222222;--border-visible:#333333;--seg-empty:#222222;--text-disabled:#666666;--text-secondary:#999999;--text-primary:#E8E8E8;--text-display:#FFFFFF;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--black);color:var(--text-primary);font:400 var(--fs-sm)/1.5 var(--grotesk)}
main{max-width:1100px;margin:0 auto;padding:0 16px}
.label,.prov-tag,.edge-strip,th,dt,.inst-sub,.mono-note,.empty,.empty-inline,.progress-val,.status-word,.track-val,.hero-n{font-family:var(--mono);font-size:var(--fs-sm);text-transform:uppercase;letter-spacing:.08em}
.label,dt,th,.inst-sub{color:var(--text-secondary)}
.prov-tag{color:var(--text-disabled)}
.edge-strip{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 16px;padding:16px 0;color:var(--text-disabled)}
#tracker-top-edge-strip{border-bottom:1px solid var(--border)}
#tracker-bottom-edge-strip{border-top:1px solid var(--border);margin-top:64px;padding-bottom:32px}
section{margin-top:48px}
.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding-bottom:8px;border-bottom:1px solid var(--border-visible);margin-bottom:16px}
h2{margin:0;font:500 var(--fs-md)/1.2 var(--grotesk);letter-spacing:-.01em;color:var(--text-display)}
h3{margin:24px 0 8px;font:400 var(--fs-sm)/1.2 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.hero{margin-top:48px}
.hero .section-head{border-bottom:0;padding-bottom:0;margin-bottom:0}
.hero-empty{color:var(--text-disabled)}.hero-empty-note{margin:0 0 8px}
.hero-value{font-family:var(--doto);font-weight:700;font-size:var(--fs-hero);line-height:1;letter-spacing:-.03em;color:var(--text-display);margin:16px 0 8px;font-variant-numeric:tabular-nums}
.hero-unit{font-family:var(--mono);font-weight:400;font-size:var(--fs-md);letter-spacing:0;vertical-align:top;margin-left:8px;color:var(--text-secondary)}
.hero-empty{font-size:var(--fs-md);font-family:var(--mono);font-weight:400;letter-spacing:.04em;margin:32px 0 16px}
.hero-n{color:var(--text-primary)}
.edge-note{margin:8px 0 0;max-width:36em;color:var(--text-secondary)}
.instruments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px 16px}
@media (min-width:760px){.instruments{grid-template-columns:repeat(5,minmax(0,1fr))}}
.instrument{display:flex;flex-direction:column;gap:8px;min-width:0}
.inst-value{font:400 var(--fs-md)/1.1 var(--mono);color:var(--text-display);font-variant-numeric:tabular-nums}
.inst-value .empty-inline{display:block;font-size:var(--fs-sm);line-height:1.5;color:var(--text-secondary)}
.seg{display:grid;gap:2px}
.seg i{display:block;background:var(--seg-empty)}
.seg i.on{background:var(--text-display)}
.seg-std i{height:8px}
.seg-hero i{height:16px}
.ibar{height:4px;background:var(--seg-empty)}
.ibar i{display:block;height:100%;background:var(--text-display)}
.st-good{color:var(--success)!important}
.st-warn{color:var(--warning)!important}
.st-bad{color:var(--accent)!important}
.dim{color:var(--text-disabled)!important}
.note{margin:16px 0 0;color:var(--text-secondary)}
.mono-note{margin:16px 0 0;color:var(--text-secondary)}
.empty{margin:8px 0;color:var(--text-secondary)}
.empty-inline{color:var(--text-secondary)}
dl{margin:0}
dd{margin:0}
.stat-row{display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--border)}
.stat-row dd{font-family:var(--mono);text-align:right;color:var(--text-primary);letter-spacing:.04em}
.status-word{color:var(--text-display)}
.progress{margin-top:24px}
.progress-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px}
.progress-val{color:var(--text-display)}
.track-row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:12px 0;border-bottom:1px solid var(--border)}
.track-row dt{grid-column:1}
.track-val{grid-column:2;grid-row:1;text-align:right;color:var(--text-primary);white-space:nowrap}
.track-why{grid-column:1 / -1;color:var(--text-primary)}
@media (min-width:760px){.track-row{grid-template-columns:200px 1fr auto}.track-why{grid-column:2;grid-row:1}.track-val{grid-column:3}}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font:400 var(--fs-sm)/1.4 var(--mono);font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 16px 8px 0;white-space:nowrap}
th{font-weight:400;border-bottom:1px solid var(--border-visible)}
td{border-bottom:1px solid var(--border);color:var(--text-primary)}
th.num,td.num{text-align:right;padding:8px 0 8px 16px}
</style>
</head>
<body>
<main id="tracker-page-main">
${topStrip}
${body}
${bottomStrip}
</main>
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
  out.push(`- Status: ${phase.status}\n- Phase: ${PHASE_NAME}, start ${PHASE_START}, ends ${phase.endDate}\n- Target: ${PHASE_DAYS} days / >= ${PHASE_TARGET_PLANS} scored plans\n- Progress: day ${phase.elapsed} / ${PHASE_DAYS}, plans scored ${isNum(phase.scored) ? phase.scored : dash} / ${PHASE_TARGET_PLANS}\n- Frozen during the window: no threshold tuning\n`);
  out.push(`## Summary\n\n_${PROVISIONAL}_\n`);
  out.push(mdTable(['Expectancy 7d', 'Scored 7d', 'Win rate 7d', 'Fills 7d', 'Losing streak 7d', 'Avg win R 7d', 'Last capture'],
    [[isNum(t.expectancy7d) ? rVal(t.expectancy7d) : NO_SCORED, t7.wins + t7.losses, pct(t.winRate7d), `${t7.fills} / ${t7.calls}`, t.losingStreak7d, rVal(t7.avgWinR), time(t.lastCapture)]]));
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
  writeFileSync(htmlFile, renderHtml(agg));
  writeFileSync(mdFile, renderReport(agg));
  return { agg, htmlFile, mdFile };
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
