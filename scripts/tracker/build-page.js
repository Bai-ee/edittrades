#!/usr/bin/env node
/**
 * EditTrades call tracker - review page (T1, docs/PLAN_CALL_TRACKER.md item 5).
 *
 * Recomputes aggregates from the data dir (writes data/aggregates.json), then renders
 * one static page `<out>/index.html` (no scripts, inline CSS, light/dark via
 * prefers-color-scheme, phone-width) and `<out>/report.md` with the same numbers.
 * Every section says "provisional; not evidence of an edge" once. Renders from an
 * empty data dir.
 *
 * Usage: node build-page.js [--data ./data] [--out ./docs] [--now <iso>]
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, ensureDir } from './store.js';
import { aggregateDataDir } from './aggregate.js';

export const PROVISIONAL = 'provisional; not evidence of an edge';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = '–';
const num = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 10 ** d) / 10 ** d) : dash);
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 1000) / 10}%` : dash);
const rVal = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${num(v)}R` : dash);
const time = (iso) => (iso ? String(iso).replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, 'Z') : dash);
const levels = (r) => (r.entry === null || r.entry === undefined ? dash : `${num(r.entry, 4)} / ${num(r.stop, 4)} / ${num(r.tp1, 4)}`);
const callLabel = (r) => (r.kind === 'rec' ? (r.class || 'rec') : `plan:${r.planStatus}`);

const STAT_COLUMNS = [
  ['calls', 'Calls', (s) => s.calls],
  ['fills', 'Fills', (s) => s.fills],
  ['wins', 'TP1', (s) => s.wins],
  ['losses', 'Stop', (s) => s.losses],
  ['open', 'Open', (s) => s.open + s.pending],
  ['winRate', 'Win rate', (s) => pct(s.winRate)],
  ['expectancy', 'Exp. (gross R)', (s) => rVal(s.expectancy)],
  ['avgNetRR', 'Avg net R:R (plan)', (s) => num(s.avgNetRR)],
  ['streak', 'Max loss streak', (s) => s.maxLosingStreak],
  ['ttp1', 'Median min to TP1', (s) => num(s.medianMinutesToTP1, 0)]
];

function table(id, headers, rows, emptyText = 'No rows yet.') {
  if (!rows.length) return `<p class="empty" id="${id}-empty">${esc(emptyText)}</p>`;
  return `<div class="table-scroll" id="${id}-scroll"><table id="${id}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function statTable(id, groups, keyLabel) {
  return table(id, [keyLabel, ...STAT_COLUMNS.map((c) => c[1])], groups.map((g) => [g.key, ...STAT_COLUMNS.map((c) => c[2](g))]));
}

function section(id, title, body) {
  return `<section id="${id}" data-section="${id}"><h2>${esc(title)}</h2><p class="provisional">${PROVISIONAL}</p>${body}</section>`;
}

export function renderHtml(agg) {
  const t = agg.tiles;
  const tiles = [
    ['tile-last-capture', 'Last capture', time(t.lastCapture)],
    ['tile-calls-today', 'Calls today', t.callsToday],
    ['tile-good-today', 'GOOD today', t.goodToday],
    ['tile-fills-7d', 'Fills 7d', t.fills7d],
    ['tile-win-rate-7d', 'Win rate 7d', pct(t.winRate7d)],
    ['tile-expectancy-7d', 'Expectancy 7d', rVal(t.expectancy7d)],
    ['tile-losing-streak-7d', 'Losing streak 7d', t.losingStreak7d]
  ];
  const tileHtml = `<div class="tiles" id="summary-tiles-row">${tiles.map(([id, label, value]) => `<div class="tile" id="${id}"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div></div>`).join('')}</div>`
    + `<p class="note">Calls = recommendation class changes (GOOD/WATCH/BAD/DATA_UNAVAILABLE). Fills, win rate and expectancy use ready flag plans only. R is gross, before fees and slippage.</p>`;

  const openRows = agg.openCalls.map((r) => [time(r.calledAt), r.symbol, callLabel(r), r.timeframe || dash, r.direction || dash, levels(r), r.outcome, time(r.filledAt), num(r.netRR)]);
  const w = (k) => agg.windows[k];
  const windowBody = (k) => `<h3>By class (recommendation calls)</h3>${statTable(`window-${k}-by-class-table`, w(k).byClass, 'Class')}`
    + `<h3>By reason code</h3>${statTable(`window-${k}-by-reason-table`, w(k).byReason, 'Reason')}`
    + `<h3>Ready plans by symbol</h3>${statTable(`window-${k}-by-symbol-table`, w(k).bySymbol, 'Symbol')}`
    + `<h3>Ready plans by timeframe</h3>${statTable(`window-${k}-by-timeframe-table`, w(k).byTimeframe, 'Timeframe')}`
    + `<h3>Plans by status</h3>${statTable(`window-${k}-by-plan-status-table`, w(k).byPlanStatus, 'Plan status')}`
    + `<p class="note">chase ${w(k).reasonCounts.chase} · rr_below_min ${w(k).reasonCounts.rr_below_min} · room ${w(k).reasonCounts.room}</p>`;

  const dayRows = agg.byDay.map((d) => [d.day, d.recCalls, d.good, d.watch, d.bad, d.dataUnavailable, d.ready, d.fills, d.wins, d.losses, rVal(d.expectancy)]);
  const logRows = agg.dailyLog.map((r) => [time(r.calledAt), r.symbol, callLabel(r), r.reasonCode || dash, r.timeframe || dash, r.direction || dash, levels(r), r.outcome, rVal(r.outcome === 'stop' ? -1 : r.r), num(r.minutesToResolution, 0)]);
  const c = agg.captures;
  const healthRows = [
    ['Capture rows', c.captures], ['Symbols', c.symbols.join(', ') || dash],
    [`Capture gaps (> 20 min)`, c.gaps], ['Longest gap (min)', num(c.longestGapMinutes, 0)],
    ['DATA_UNAVAILABLE captures', c.dataUnavailable],
    ['Mark drift |bps| median / p95 / max', `${num(c.markDriftBps.medianAbs)} / ${num(c.markDriftBps.p95Abs)} / ${num(c.markDriftBps.maxAbs)}`],
    ['Mark status not ok', c.markDriftBps.notOk],
    ['1m candles stored', Object.entries(c.candles1m).map(([s, n]) => `${s} ${n}`).join(', ') || dash],
    ['Missing 1m candles inside stored span', c.missing1mCandles]
  ];

  const body = [
    section('summary-section', 'Summary', tileHtml),
    section('open-calls-section', 'Open calls right now', table('open-calls-table', ['Called', 'Symbol', 'Call', 'TF', 'Dir', 'Entry / stop / TP1', 'Status', 'Filled', 'Net R:R'], openRows, 'No open calls.')),
    section('window-7d-section', 'Last 7 days', windowBody('7d')),
    section('window-30d-section', 'Last 30 days', windowBody('30d')),
    section('daily-summary-section', 'By day', table('daily-summary-table', ['Day', 'Calls', 'GOOD', 'WATCH', 'BAD', 'DATA_UNAV', 'Ready plans', 'Fills', 'TP1', 'Stop', 'Exp.'], dayRows)),
    section('daily-log-section', `Call log (last 7 days)`, table('daily-log-table', ['Called', 'Symbol', 'Call', 'Reason', 'TF', 'Dir', 'Entry / stop / TP1', 'Outcome', 'R', 'Min'], logRows)),
    section('data-health-section', 'Data health', table('data-health-table', ['Metric', 'Value'], healthRows))
  ].join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades Call Tracker</title>
<style>
:root{--bg:#f7f7f5;--panel:#ffffff;--text:#1b1c1e;--muted:#6b6f76;--border:#e3e3df;--accent:#2f6fde;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111214;--panel:#1a1b1e;--text:#e8e8e6;--muted:#9a9ea6;--border:#2c2e33;--accent:#7aa7ff;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#111214;--panel:#1a1b1e;--text:#e8e8e6;--muted:#9a9ea6;--border:#2c2e33;--accent:#7aa7ff;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 48px}
header h1{font-size:20px;margin:0 0 4px}
header p{margin:0;color:var(--muted);font-size:13px}
section{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 14px 10px;margin-top:16px}
h2{font-size:16px;margin:0 0 2px}
h3{font-size:13px;margin:14px 0 6px;color:var(--muted);font-weight:600}
.provisional{margin:0 0 10px;font-size:12px;color:var(--muted);font-style:italic}
.note{font-size:12px;color:var(--muted);margin:8px 0 4px}
.empty{color:var(--muted);font-size:13px;margin:6px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.tile{border:1px solid var(--border);border-radius:8px;padding:10px}
.tile-label{font-size:12px;color:var(--muted)}
.tile-value{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px;word-break:break-word}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--muted);font-weight:600}
</style>
</head>
<body>
<main id="tracker-page-main">
<header id="tracker-page-header"><h1>EditTrades call tracker</h1><p>Generated ${esc(time(agg.generatedAt))} · last closed candle ${esc(time(agg.tiles.lastClosedThrough))} · ${agg.totals.outcomes} scored rows</p></header>
${body}
</main>
</body>
</html>
`;
}

function mdTable(headers, rows) {
  if (!rows.length) return '_none yet_\n';
  return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map((c) => String(c ?? '').replace(/\|/g, '/')).join(' | ')} |`).join('\n')}\n`;
}

function mdStats(groups, keyLabel) {
  return mdTable([keyLabel, ...STAT_COLUMNS.map((c) => c[1])], groups.map((g) => [g.key, ...STAT_COLUMNS.map((c) => c[2](g))]));
}

export function renderReport(agg) {
  const t = agg.tiles;
  const w = agg.windows;
  const out = [];
  out.push(`# EditTrades call tracker report\n\nGenerated ${time(agg.generatedAt)}. R is gross, before fees and slippage.\n`);
  out.push(`## Summary\n\n_${PROVISIONAL}_\n`);
  out.push(mdTable(['Last capture', 'Calls today', 'GOOD today', 'Fills 7d', 'Win rate 7d', 'Expectancy 7d', 'Losing streak 7d'],
    [[time(t.lastCapture), t.callsToday, t.goodToday, t.fills7d, pct(t.winRate7d), rVal(t.expectancy7d), t.losingStreak7d]]));
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
  const agg = aggregateDataDir(dataDir, nowMs);
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
