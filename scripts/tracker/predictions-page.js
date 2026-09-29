/**
 * EditTrades call tracker - "Predictions" page (predictions.html), T-24
 * (docs/PROMPT_T24_PREDICTION_TRACKER.md agent B item 3).
 *
 * Full detail behind the homepage's zone-predictions grid: every cell (symbol x timeframe),
 * rolled up by timeframe and by coin, the during-GOOD row, the last 50 resolved results with
 * their move in bps, a method paragraph and a link to the replay study (agent A writes
 * docs/PREDICTION_STUDY_2026-09-28.md; the link may 404 until the three T-24 worktrees merge).
 * Same bento system as spot.html/strategies.html (./bento.js, ./page-style.js). Renders from
 * an empty aggregate (predictions.js EMPTY_PREDICTIONS_AGGREGATE) with the same
 * `[NO PREDICTIONS YET]` empty state the homepage block uses.
 */

import { PAGE_CSS } from './page-style.js';
import { esc, tile, zone, jumpNav } from './bento.js';
import { STUDIES_REPO } from './how-to-page.js';
import {
  PREDICTION_SYMBOLS, PREDICTION_TIMEFRAMES, predictionCellKey, predCellBeats,
  predictionsZoneBody, NO_PREDICTIONS, EMPTY_PREDICTIONS_AGGREGATE
} from './predictions.js';

const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (v) => (isNum(v) ? `${Math.round(v * 1000) / 10}%` : dash);
const num = (v, d = 1) => (isNum(v) ? v.toFixed(d) : dash);
const time = (iso) => (iso ? String(iso).replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, 'Z') : dash);

const STUDY_LINK = `${STUDIES_REPO}PREDICTION_STUDY_2026-09-28.md`;

function table(id, headers, rows, emptyText) {
  if (!rows.length) return `<p class="empty" id="${id}-empty">${esc(emptyText)}</p>`;
  return `<div class="table-scroll" id="${id}-scroll"><table id="${id}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const CELL_HEADERS = ['Coin', 'TF', 'N', 'Hits', 'Misses', 'No call', 'Hit rate', 'Coin flip', 'Same-as-last', 'Mean move (hit)', 'Mean move (miss)', 'Beats baselines'];
const cellRow = (label1, label2, c) => [label1, label2, c.n, c.hits, c.misses, c.noCalls, pct(c.hitRate), pct(c.coinFlip), pct(c.sameAsLastRate),
  isNum(c.meanMoveBpsHit) ? `${num(c.meanMoveBpsHit)} bps` : dash, isNum(c.meanMoveBpsMiss) ? `${num(c.meanMoveBpsMiss)} bps` : dash,
  predCellBeats(c) ? 'YES' : ''];

function byCellTable(agg) {
  const rows = PREDICTION_SYMBOLS.flatMap((sym) => PREDICTION_TIMEFRAMES.map((tf) => cellRow(sym, tf.toUpperCase(), agg.cells[predictionCellKey(sym, tf)])));
  return table('predictions-by-cell-table', CELL_HEADERS, rows, NO_PREDICTIONS);
}

function byTimeframeTable(agg) {
  const rows = PREDICTION_TIMEFRAMES.map((tf) => cellRow(tf.toUpperCase(), 'ALL COINS', agg.byTimeframe[tf]));
  return table('predictions-by-timeframe-table', CELL_HEADERS, rows, NO_PREDICTIONS);
}

function bySymbolTable(agg) {
  const rows = PREDICTION_SYMBOLS.map((sym) => cellRow(sym, 'ALL TF', agg.bySymbol[sym]));
  return table('predictions-by-coin-table', CELL_HEADERS, rows, NO_PREDICTIONS);
}

function overallAndGoodTable(agg) {
  const rows = [cellRow('ALL', 'ALL', agg.overall), cellRow('ALL', 'DURING GOOD', agg.duringGood)];
  return table('predictions-overall-table', CELL_HEADERS, rows, NO_PREDICTIONS);
}

const LAST_HEADERS = ['Resolved', 'Coin', 'TF', 'Called', 'Confidence', 'Ref close', 'Next close', 'Move (bps)', 'Result', 'vs last candle'];

function lastResultsTable(agg) {
  const rows = (agg.last || []).map((r) => [
    time(r.closedAt), r.symbol, r.timeframe.toUpperCase(), r.direction || dash,
    isNum(r.confidence) ? r.confidence.toFixed(2) : dash, num(r.refClose, 4), num(r.nextClose, 4),
    isNum(r.moveBps) ? `${r.moveBps > 0 ? '+' : ''}${num(r.moveBps)}` : dash,
    r.hit === true ? 'HIT' : r.hit === false ? 'MISS' : (r.direction === 'no_call' ? 'NO CALL' : 'FLAT'),
    r.lastCandleDir || dash
  ]);
  return table('predictions-last-table', LAST_HEADERS, rows, NO_PREDICTIONS);
}

const METHOD_NOTE = 'Info only, never traded: for every closed candle on 5m/15m/1h/4h across BTC/ETH/SOL, lib/predictionRule.js scores five inputs '
  + '(close vs EMA21, EMA21 vs EMA200, close vs the next-higher timeframe\'s EMA21, stochRSI rising and under 80, and the last swing) '
  + 'into a call - over, under, or no_call below +-2 - before the next candle of that timeframe closes. Once that next candle closes, the call is scored '
  + 'against its own close: hit/miss for over/under, no result for no_call or an exact tie. Two baselines sit alongside it: a coin flip (50%) and '
  + '"same direction as the last candle" (sameAsLastRate) - a grid cell is only highlighted once it has at least 30 scored calls and beats both. '
  + 'Not evidence of an edge on its own; see the replay study for the full 2-year read.';

function methodBody() {
  return `<p class="note" id="predictions-method-note">${esc(METHOD_NOTE)}</p>`
    + `<p class="note" id="predictions-study-link-row">Full 2-year replay: <a class="nav-link" id="predictions-study-link" href="${esc(STUDY_LINK)}" target="_blank" rel="noopener">PREDICTION_STUDY_2026-09-28.md on GitHub →</a></p>`;
}

/**
 * @param {Object} [predAgg] - aggregates.json.predictions (predictions.js computePredictionsAggregate output)
 */
export function renderPredictionsPage(predAgg) {
  const agg = predAgg || EMPTY_PREDICTIONS_AGGREGATE;
  const since = agg.since ? String(agg.since).slice(0, 10) : null;

  const topStrip = `<header class="edge-strip" id="predictions-top-edge-strip"><span id="predictions-page-title">EDITTRADES / NEXT-CANDLE PREDICTIONS</span>`
    + `<a class="nav-link" id="predictions-back-link" href="index.html">← Call tracker</a></header>`
    + jumpNav('predictions-jump-nav', [
      ['#predictions-summary-zone', 'Summary'], ['#predictions-by-cell-zone', 'By cell'], ['#predictions-last-zone', 'Last 50'], ['#predictions-method-zone', 'Method'],
      ['index.html', '← Tracker', 'class="nav-link" id="predictions-nav-back-link"']
    ]);
  const bottomStrip = `<footer class="edge-strip" id="predictions-bottom-edge-strip"><span id="predictions-footer-note">INFO ONLY · NEVER TRADED · SCORED AGAINST THE NEXT CLOSED CANDLE${since ? ` · SINCE ${esc(since)}` : ''}</span></footer>`;

  const summaryTile = tile({ id: 'predictions-summary-tile', as: 'div', lg: 12, body: predictionsZoneBody(agg) });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>EditTrades Next-Candle Predictions</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400&display=swap">
<style>
${PAGE_CSS}
.pred-grid{display:grid;grid-template-columns:repeat(4,minmax(84px,1fr));gap:var(--sp-2);min-width:360px}
.pred-cell{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:var(--sp-2);border:1px solid var(--border);border-radius:var(--radius);min-width:0}
.pred-cell-head{display:flex;align-items:baseline;gap:var(--sp-1);font-style:normal}
.pred-cell-sym{font:700 12px/1.2 var(--mono);color:var(--text-display)}
.pred-cell-tf{font:400 10px/1.2 var(--mono);font-style:normal;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary)}
.pred-cell-rate{font:700 var(--fs-md)/1 var(--doto);color:var(--text-primary);font-variant-numeric:tabular-nums}
.pred-cell-n{font:400 10px/1.2 var(--mono);color:var(--text-secondary)}
.pred-cell-good{border-color:var(--success)}
.pred-cell-good .pred-cell-rate{color:var(--success)}
.pred-summary{margin:0;font:400 12px/1.4 var(--mono);color:var(--text-secondary)}
</style>
</head>
<body>
<main id="predictions-page-main">
${topStrip}
${zone({ id: 'predictions-summary-zone', title: 'Next-candle calls · every close, every coin', sub: 'info only · every close, scored', tiles: [summaryTile] })}
${zone({
    id: 'predictions-by-cell-zone', title: 'By cell, timeframe and coin', sub: 'n excludes no_call; a cell is highlighted at n >= 30 beating both baselines',
    tiles: [
      tile({ id: 'predictions-by-cell-section', as: 'div', lg: 12, title: 'By cell (coin x timeframe)', body: byCellTable(agg) }),
      tile({ id: 'predictions-by-timeframe-section', as: 'div', lg: 6, title: 'By timeframe', body: byTimeframeTable(agg) }),
      tile({ id: 'predictions-by-coin-section', as: 'div', lg: 6, title: 'By coin', body: bySymbolTable(agg) }),
      tile({ id: 'predictions-overall-section', as: 'div', lg: 12, title: 'Overall · during a scored GOOD call', body: overallAndGoodTable(agg) })
    ]
  })}
${zone({ id: 'predictions-last-zone', title: 'Last 50 results', sub: 'Most recent resolved candle first', tiles: [tile({ id: 'predictions-last-section', as: 'div', lg: 12, body: lastResultsTable(agg) })] })}
${zone({ id: 'predictions-method-zone', title: 'Method', sub: 'What this measures', tiles: [tile({ id: 'predictions-method-section', as: 'div', lg: 12, body: methodBody() })] })}
${bottomStrip}
</main>
</body>
</html>
`;
}
