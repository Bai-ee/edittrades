/**
 * T-24 prediction tracker (agent B, docs/PROMPT_T24_PREDICTION_TRACKER.md):
 *
 *   pull       pullPredictions() fetches predictions/manifest.json + day files from the same
 *              public Blob base the served-calls pull uses (collect.js blobBaseFromToken),
 *              same incremental pattern as pullServed/pullTelegramLogs (newest stored day
 *              minus one), into data/predictions/<day>.jsonl (store.js predictionsDir /
 *              readPredictions / appendPredictions, dedupe id+kind, day = UTC day of
 *              closedAt). Rows are written upstream by the engine (agent D,
 *              lib/predictionLive.js) via lib/blobJsonl.js appendJsonlDay, schema
 *              predictions-manifest-1.
 *   join       joinPredictions() pairs each PREDICTION row with its PREDICTION_RESULT (same
 *              id) when one has landed.
 *   aggregate  computePredictionsAggregate() builds aggregates.json.predictions per the
 *              contract: cells "<SYM>:<tf>", current, byTimeframe, bySymbol, overall,
 *              duringGood, last. current[key] (T-24c) is the latest PREDICTION for that cell:
 *              still-pending -> {direction, confidence, closedAt, refClose}; already resolved
 *              -> the same shape plus {resolved:true, hit}; no predictions yet -> null.
 *              n/hits/misses count decided results (hit true/false); noCalls counts resolved
 *              results whose prediction direction was 'no_call' (excluded from n, per spec);
 *              a flat-tie result (hit null, direction not no_call) counts toward none of them.
 *              sameAsLastRate is the "guess same as the last candle" baseline: among decided
 *              results, how often lastCandleDir already matched the actual direction
 *              (moveBps sign). meanMoveBpsHit/Miss are mean |moveBps| for correct/incorrect
 *              decided calls. duringGood restricts to results whose [prediction close, result
 *              close] window overlaps a scored GOOD call for the same symbol
 *              (data/good-call-outcomes.jsonl, score.js scoreGoodCalls: window
 *              [calledAt, endedAt] or [calledAt, calledAt+goodWindowMin] when endedAt is
 *              still open).
 *   homepage   predictionsZone() renders the `id="zone-predictions"` block (bento.js zone/
 *              tile), a 3x4 grid (id="pred-grid", cells id="pred-cell-<sym>-<tf>" lowercase)
 *              coloured only when a cell has n >= 30 and beats both the coin flip and
 *              same-as-last baselines, plus the one-line summary. Empty (`since` null) renders
 *              `[NO PREDICTIONS YET]` instead of the grid - the block itself is never omitted.
 *              Kept exported for predictions.html (predictions-page.js); no longer placed on
 *              the homepage (T-24c below).
 *   panel      (T-24c, docs/PROMPT_T24C_PREDICTION_PANEL.md) predictionsPanelHtml() renders
 *              `id="home-hero-prediction-panel"`, the hero's right-column replacement for the
 *              old zone-predictions grid: predictionsOverallHtml() (id="pred-overall-rate",
 *              the overall hit rate oversized, n/since under it, baselines below - or the
 *              `[NO PREDICTIONS YET]` empty state) plus predictionsCurrentTableHtml()
 *              (id="pred-current-table", 12 rows id="pred-row-<sym>-<tf>", BTC/ETH/SOL x
 *              5m/15m/1h/4h: token, tf, next-candle glyph from `current`, hit rate from
 *              `cells[key]`, and the last resolved result read off the existing `last` list).
 *              home-hero.js places it in the hero grid; build-page.js no longer calls
 *              predictionsZone() for the homepage body.
 *
 * Symbols/timeframes mirror lib/predictionRule.js's PREDICTION_SYMBOLS/PREDICTION_TIMEFRAMES
 * (agent A, merged separately) - duplicated as local constants rather than imported, the same
 * way home-hero.js/live-board.js keep their own SYMBOLS list instead of reaching into the engine.
 *
 * Usage: node predictions.js [--data ./data] [--base <blob base url>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPredictions, appendPredictions, goodCallOutcomesFile, readJsonl, parseArgs } from './store.js';
import { esc, zone, tile } from './bento.js';

export const PREDICTION_SYMBOLS = ['BTC', 'ETH', 'SOL'];
export const PREDICTION_TIMEFRAMES = ['5m', '15m', '1h', '4h'];

const dash = '–';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, n = 4) => (isNum(v) ? Math.round(v * 10 ** n) / 10 ** n : null);
const pct = (v) => (isNum(v) ? `${Math.round(v * 1000) / 10}%` : dash);

export function predictionCellKey(symbol, timeframe) {
  return `${symbol}:${timeframe}`;
}

// ---------------------------------------------------------------- Blob pull

function parseLines(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line skipped */ }
  }
  return rows;
}

/** Rows made safe to store: a plain object, a string id, kind PREDICTION|PREDICTION_RESULT, a valid closedAt. */
export function predictionRowsFromLines(rows) {
  return (rows || []).filter((r) => r && typeof r === 'object' && !Array.isArray(r)
    && typeof r.id === 'string' && (r.kind === 'PREDICTION' || r.kind === 'PREDICTION_RESULT')
    && Number.isFinite(Date.parse(r.closedAt)));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pull predictions/manifest.json + day files (from the newest stored day minus one, all of
 * them when nothing is stored yet) into data/predictions/ - same incremental shape as
 * collect.js's pullServed/pullTelegramLogs. A missing manifest (404, engine not writing yet)
 * is not an error.
 * @param {string} dataDir
 * @param {string} base - public Blob base URL
 * @param {Function} [fetchImpl=fetch]
 * @param {number} [nowMs=Date.now()] - cache-buster
 * @returns {Promise<{days:number, added:number, duplicates:number}>}
 */
export async function pullPredictions(dataDir, base, fetchImpl = fetch, nowMs = Date.now()) {
  const get = async (url) => {
    const res = await fetchImpl(`${url}?t=${nowMs}`, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`predictions HTTP ${res.status}`);
    return res.text();
  };
  const manifestText = await get(`${base}/predictions/manifest.json`);
  if (manifestText === null) return { days: 0, added: 0, duplicates: 0 };
  const manifest = JSON.parse(manifestText);
  const listed = Array.isArray(manifest.days) ? manifest.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const newestMs = readPredictions(dataDir).map((r) => Date.parse(r.closedAt)).filter(Number.isFinite).reduce((m, ms) => Math.max(m, ms), -Infinity);
  const from = Number.isFinite(newestMs) ? new Date(newestMs - DAY_MS).toISOString().slice(0, 10) : null;
  const days = from ? listed.filter((d) => d >= from) : listed;
  const fileBase = typeof manifest.baseUrl === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(manifest.baseUrl) ? manifest.baseUrl : base;
  const rows = [];
  for (const day of days) {
    const text = await get(`${fileBase}/predictions/${day}.jsonl`);
    if (text !== null) rows.push(...parseLines(text));
  }
  const result = appendPredictions(dataDir, predictionRowsFromLines(rows));
  return { days: days.length, ...result };
}

// ---------------------------------------------------------------- join + aggregate

/**
 * One row per stored PREDICTION, joined to its PREDICTION_RESULT (same id) when one exists.
 * @param {Array<Object>} rows - data/predictions rows (PREDICTION + PREDICTION_RESULT)
 * @returns {Array<{id:string, symbol:string, timeframe:string, closedAt:string, direction:string, confidence:number, prediction:Object, result:Object|null}>}
 */
/** Rule versions whose rows are dropped from every aggregate: pred-1 wrote BTC candles for ETH/SOL (engine short-symbol fetch bug, fixed 2026-09-29). */
export const IGNORED_RULE_VERSIONS = Object.freeze(['pred-1']);

export function joinPredictions(rows) {
  const predictions = (rows || []).filter((r) => r && r.kind === 'PREDICTION' && !IGNORED_RULE_VERSIONS.includes(r.ruleVersion));
  const results = new Map((rows || []).filter((r) => r && r.kind === 'PREDICTION_RESULT').map((r) => [r.id, r]));
  return predictions.map((p) => ({
    id: p.id, symbol: p.symbol, timeframe: p.timeframe, closedAt: p.closedAt,
    direction: p.direction, confidence: p.confidence, prediction: p, result: results.get(p.id) || null
  }));
}

/** 'over'|'under'|'flat' from a result row's own moveBps sign. */
const actualDirOf = (result) => (result.moveBps > 0 ? 'over' : result.moveBps < 0 ? 'under' : 'flat');

/** Cell/byTimeframe/bySymbol/overall/duringGood shape (see module header) from a list of joined rows. */
function statsForJoined(list) {
  const withResult = (list || []).filter((j) => j.result);
  const decided = withResult.filter((j) => j.result.hit === true || j.result.hit === false);
  const hits = decided.filter((j) => j.result.hit === true).length;
  const misses = decided.filter((j) => j.result.hit === false).length;
  const noCalls = withResult.filter((j) => j.direction === 'no_call').length;
  const n = decided.length;
  const sameAsLastHits = decided.filter((j) => j.result.lastCandleDir === actualDirOf(j.result)).length;
  const absMove = (j) => Math.abs(j.result.moveBps);
  const avg = (arr) => (arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 1) : null);
  return {
    n, hits, misses, noCalls,
    hitRate: n ? round(hits / n) : null,
    coinFlip: 0.5,
    sameAsLastRate: n ? round(sameAsLastHits / n) : null,
    meanMoveBpsHit: avg(decided.filter((j) => j.result.hit === true).map(absMove)),
    meanMoveBpsMiss: avg(decided.filter((j) => j.result.hit === false).map(absMove))
  };
}

export const EMPTY_PREDICTIONS_CELL = Object.freeze({ n: 0, hits: 0, misses: 0, noCalls: 0, hitRate: null, coinFlip: 0.5, sameAsLastRate: null, meanMoveBpsHit: null, meanMoveBpsMiss: null });

/** T-24c: the latest PREDICTION for one cell - still pending (no PREDICTION_RESULT yet) ->
 * {direction, confidence, closedAt, refClose}; already resolved -> the same shape plus
 * {resolved:true, hit}; no predictions at all -> null. */
function currentForCell(cellJoined) {
  if (!cellJoined || !cellJoined.length) return null;
  const sorted = [...cellJoined].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  const pending = sorted.find((j) => !j.result);
  const j = pending || sorted[0];
  const base = { direction: j.direction, confidence: j.confidence, closedAt: j.closedAt, refClose: j.prediction.refClose };
  return pending ? base : { ...base, resolved: true, hit: j.result.hit };
}

/** [startMs, endMs] a GOOD call was active: calledAt -> endedAt, or calledAt+goodWindowMin when still open, or a point at calledAt. */
function goodWindow(g) {
  const startMs = Date.parse(g && g.calledAt);
  if (!Number.isFinite(startMs)) return null;
  const endedMs = Date.parse(g.endedAt);
  const endMs = Number.isFinite(endedMs) ? endedMs : (isNum(g.goodWindowMin) ? startMs + g.goodWindowMin * 60_000 : startMs);
  return [startMs, Math.max(startMs, endMs)];
}

/**
 * @param {Array<Object>} rows - data/predictions rows (PREDICTION + PREDICTION_RESULT)
 * @param {Array<Object>} [goodCallOutcomes=[]] - data/good-call-outcomes.jsonl rows (score.js scoreGoodCalls)
 * @returns {Object} aggregates.json.predictions per the T-24 contract
 */
export function computePredictionsAggregate(rows, goodCallOutcomes = []) {
  const joined = joinPredictions(rows);

  const firstMs = joined.reduce((m, j) => {
    const ms = Date.parse(j.closedAt);
    return Number.isFinite(ms) && (m === null || ms < m) ? ms : m;
  }, null);

  const cells = {};
  const current = {};
  for (const symbol of PREDICTION_SYMBOLS) {
    for (const timeframe of PREDICTION_TIMEFRAMES) {
      const key = predictionCellKey(symbol, timeframe);
      const cellJoined = joined.filter((j) => j.symbol === symbol && j.timeframe === timeframe);
      cells[key] = statsForJoined(cellJoined);
      current[key] = currentForCell(cellJoined);
    }
  }
  const byTimeframe = {};
  for (const timeframe of PREDICTION_TIMEFRAMES) byTimeframe[timeframe] = statsForJoined(joined.filter((j) => j.timeframe === timeframe));
  const bySymbol = {};
  for (const symbol of PREDICTION_SYMBOLS) bySymbol[symbol] = statsForJoined(joined.filter((j) => j.symbol === symbol));
  const overall = statsForJoined(joined);

  const goodWindows = (goodCallOutcomes || [])
    .map((g) => ({ symbol: g && g.symbol, w: goodWindow(g) }))
    .filter((g) => g.symbol && g.w);
  const duringGoodJoined = joined.filter((j) => {
    if (!j.result) return false;
    const startMs = Date.parse(j.closedAt);
    const endMs = Date.parse(j.result.closedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
    return goodWindows.some((g) => g.symbol === j.symbol && startMs <= g.w[1] && endMs >= g.w[0]);
  });
  const duringGood = statsForJoined(duringGoodJoined);

  const last = joined
    .filter((j) => j.result)
    .sort((a, b) => Date.parse(b.result.closedAt) - Date.parse(a.result.closedAt))
    .slice(0, 50)
    .map((j) => ({
      id: j.id, symbol: j.symbol, timeframe: j.timeframe, closedAt: j.result.closedAt,
      refClose: j.result.refClose, nextClose: j.result.nextClose, moveBps: j.result.moveBps,
      hit: j.result.hit, direction: j.direction, confidence: j.confidence, lastCandleDir: j.result.lastCandleDir
    }));

  return { since: firstMs !== null ? new Date(firstMs).toISOString() : null, cells, current, byTimeframe, bySymbol, overall, duringGood, last };
}

export const EMPTY_PREDICTIONS_AGGREGATE = Object.freeze({
  since: null,
  cells: Object.fromEntries(PREDICTION_SYMBOLS.flatMap((s) => PREDICTION_TIMEFRAMES.map((tf) => [predictionCellKey(s, tf), EMPTY_PREDICTIONS_CELL]))),
  current: Object.fromEntries(PREDICTION_SYMBOLS.flatMap((s) => PREDICTION_TIMEFRAMES.map((tf) => [predictionCellKey(s, tf), null]))),
  byTimeframe: Object.fromEntries(PREDICTION_TIMEFRAMES.map((tf) => [tf, EMPTY_PREDICTIONS_CELL])),
  bySymbol: Object.fromEntries(PREDICTION_SYMBOLS.map((s) => [s, EMPTY_PREDICTIONS_CELL])),
  overall: EMPTY_PREDICTIONS_CELL,
  duringGood: EMPTY_PREDICTIONS_CELL,
  last: []
});

/** aggregates.json.predictions, read straight from a data dir (aggregate.js aggregateDataDir wires this in). */
export function predictionsAggregateFor(dataDir) {
  return computePredictionsAggregate(readPredictions(dataDir), readJsonl(goodCallOutcomesFile(dataDir)));
}

// ---------------------------------------------------------------- homepage block

export const NO_PREDICTIONS = '[NO PREDICTIONS YET]';
const TF_LABEL = { '5m': '5M', '15m': '15M', '1h': '1H', '4h': '4H' };

/** A cell is coloured only when it has a real sample (n >= 30) and beats both baselines. */
export function predCellBeats(cell) {
  return !!cell && isNum(cell.n) && cell.n >= 30 && isNum(cell.hitRate)
    && cell.hitRate > cell.coinFlip && (cell.sameAsLastRate === null || cell.hitRate > cell.sameAsLastRate);
}

function predCellHtml(symbol, timeframe, cell) {
  const id = `pred-cell-${symbol.toLowerCase()}-${timeframe}`;
  const good = predCellBeats(cell);
  const rateText = cell && isNum(cell.hitRate) ? pct(cell.hitRate) : dash;
  const nText = `n=${(cell && cell.n) || 0}`;
  return `<div class="pred-cell${good ? ' pred-cell-good' : ''}" id="${id}">`
    + `<span class="pred-cell-head"><b class="pred-cell-sym">${esc(symbol)}</b><i class="pred-cell-tf">${esc(TF_LABEL[timeframe] || timeframe.toUpperCase())}</i></span>`
    + `<span class="pred-cell-rate">${esc(rateText)}</span>`
    + `<span class="pred-cell-n">${esc(nText)}</span></div>`;
}

/** `id="pred-grid"`, one cell per symbol x timeframe (3x4), scrollable on phone via .table-scroll. */
export function predictionsGridHtml(agg) {
  const cellsHtml = PREDICTION_SYMBOLS.flatMap((sym) => PREDICTION_TIMEFRAMES.map((tf) => predCellHtml(sym, tf, agg.cells[predictionCellKey(sym, tf)])))
    .join('');
  return `<div class="table-scroll" id="pred-grid-scroll"><div class="pred-grid" id="pred-grid" role="img" aria-label="Hit rate by coin and timeframe">${cellsHtml}</div></div>`;
}

/** "Overall x% of n · coin flip 50% · same-as-last y% · since <date>". */
export function predictionsSummaryLine(agg) {
  const o = agg.overall || EMPTY_PREDICTIONS_CELL;
  const since = agg.since ? String(agg.since).slice(0, 10) : dash;
  return `<p class="pred-summary" id="pred-summary-line">Overall ${esc(pct(o.hitRate))} of n=${o.n || 0} · coin flip 50% · same-as-last ${esc(pct(o.sameAsLastRate))} · since ${esc(since)}</p>`;
}

/** Grid + summary, or the never-hidden empty state when nothing has been predicted yet. */
export function predictionsZoneBody(agg) {
  const a = agg || EMPTY_PREDICTIONS_AGGREGATE;
  if (!a.since) return `<p class="empty" id="zone-predictions-empty">${esc(NO_PREDICTIONS)}</p>`;
  return predictionsGridHtml(a) + predictionsSummaryLine(a);
}

/** Homepage block `id="zone-predictions"`: directly under home-hero-right-now, above the strategy scoreboard. */
export function predictionsZone(agg) {
  const predAgg = (agg && agg.predictions) || EMPTY_PREDICTIONS_AGGREGATE;
  return zone({
    id: 'zone-predictions', title: 'Next-candle calls · every close, every coin', sub: 'info only · every close, scored',
    tiles: [tile({ id: 'pred-grid-tile', as: 'div', lg: 12, body: predictionsZoneBody(predAgg) })]
  });
}

// ---------------------------------------------------------------- home-hero panel (T-24c)

const NEXT_GLYPH = { over: '▲', under: '▼' };

/** '▲' over / '▼' under / '·' no call or no current prediction yet. */
export function predictionNextGlyph(current) {
  return (current && NEXT_GLYPH[current.direction]) || '·';
}

/** The most recently resolved result for one cell, read off the existing last-50 list
 * (already sorted newest first) - no new aggregate field needed. */
function latestResultForCell(agg, symbol, timeframe) {
  const list = Array.isArray(agg && agg.last) ? agg.last : [];
  return list.find((r) => r.symbol === symbol && r.timeframe === timeframe) || null;
}

function predCurrentRowHtml(symbol, timeframe, agg) {
  const key = predictionCellKey(symbol, timeframe);
  const cell = (agg.cells && agg.cells[key]) || EMPTY_PREDICTIONS_CELL;
  const current = agg.current && agg.current[key];
  const last = latestResultForCell(agg, symbol, timeframe);
  const lastGlyph = !last ? dash : (last.hit === true ? '✓' : last.hit === false ? '✗' : dash);
  const rateText = isNum(cell.hitRate) ? pct(cell.hitRate) : dash;
  const id = `pred-row-${symbol.toLowerCase()}-${timeframe}`;
  return `<tr class="pred-current-row${predCellBeats(cell) ? ' pred-row-good' : ''}" id="${id}">`
    + `<td class="pred-current-sym">${esc(symbol)}</td>`
    + `<td class="pred-current-tf">${esc(TF_LABEL[timeframe] || timeframe.toUpperCase())}</td>`
    + `<td class="pred-current-next">${esc(predictionNextGlyph(current))}</td>`
    + `<td class="pred-current-rate">${esc(rateText)}<span class="pred-current-hit-n">n=${cell.n || 0}</span></td>`
    + `<td class="pred-current-last">${esc(lastGlyph)}</td>`
    + `</tr>`;
}

/** `id="pred-current-table"`: 12 rows, BTC/ETH/SOL x 5m/15m/1h/4h, row id="pred-row-<sym>-<tf>".
 * Columns: token, tf, next-candle glyph (from `current`), hit rate (from `cells`, n small),
 * last resolved result. Never hidden - empty cells render their own dashes. */
export function predictionsCurrentTableHtml(agg) {
  const rows = PREDICTION_SYMBOLS.flatMap((sym) => PREDICTION_TIMEFRAMES.map((tf) => predCurrentRowHtml(sym, tf, agg))).join('');
  return `<div class="table-scroll pred-current-table-wrap" id="pred-current-table-scroll">`
    + `<table class="pred-current-table" id="pred-current-table">`
    + `<thead><tr><th>Coin</th><th>TF</th><th>Next</th><th>Hit rate</th><th>Last</th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div>`;
}

/** `id="pred-overall-rate"`: oversized overall hit rate with n/since under it and the two
 * baselines on their own line. Empty (`since` null) shows '–' and [NO PREDICTIONS YET]
 * instead - the block itself is never hidden. */
export function predictionsOverallHtml(agg) {
  const a = agg || EMPTY_PREDICTIONS_AGGREGATE;
  const o = a.overall || EMPTY_PREDICTIONS_CELL;
  const since = a.since ? String(a.since).slice(0, 10) : null;
  if (!since) {
    return `<div class="pred-overall-block" id="pred-overall-block">`
      + `<div class="pred-overall-rate is-empty" id="pred-overall-rate">${dash}</div>`
      + `<p class="pred-overall-meta" id="pred-overall-meta">${esc(NO_PREDICTIONS)}</p>`
      + `</div>`;
  }
  return `<div class="pred-overall-block" id="pred-overall-block">`
    + `<div class="pred-overall-rate" id="pred-overall-rate">${esc(pct(o.hitRate))}</div>`
    + `<p class="pred-overall-meta" id="pred-overall-meta">n=${o.n || 0} · since ${esc(since)}</p>`
    + `<p class="pred-overall-baseline" id="pred-overall-baseline">coin flip 50% · same-as-last ${esc(pct(o.sameAsLastRate))}</p>`
    + `</div>`;
}

/**
 * `id="home-hero-prediction-panel"`: the hero's right-column panel (T-24c) - overall hit-rate
 * figure, the 12-row current-call table, a footer link to predictions.html. Replaces the old
 * zone-predictions grid on the homepage; never hidden (renders its own empty states).
 * @param {Object} [pageAgg] - computeAggregates() output; `pageAgg.predictions` is read
 */
export function predictionsPanelHtml(pageAgg) {
  const agg = (pageAgg && pageAgg.predictions) || EMPTY_PREDICTIONS_AGGREGATE;
  return `<div class="home-hero-prediction-panel" id="home-hero-prediction-panel" data-section="home-hero-prediction-panel">`
    + predictionsOverallHtml(agg)
    + predictionsCurrentTableHtml(agg)
    + `<p class="pred-panel-foot" id="pred-panel-foot"><a id="pred-panel-foot-link" href="predictions.html">every call, every close →</a></p>`
    + `</div>`;
}

export const PREDICTIONS_CSS = `
/* zone-predictions (predictions.html only, see predictionsZone header note): 3x4 next-candle
   hit-rate grid, scrolls inside its tile on phone. */
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
/* home-hero-prediction-panel (T-24c): hero right column, hard-capped at 40vh like live-board -
   the current-call table scrolls inside it, the panel itself never grows past the cap. */
.home-hero-prediction-panel{grid-area:board;container-type:inline-size;display:flex;flex-direction:column;gap:var(--sp-2);min-width:0;max-height:40vh;overflow:hidden;padding:var(--sp-3) var(--sp-4);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.pred-overall-block{flex:0 0 auto;display:flex;flex-direction:column;gap:2px;padding-bottom:var(--sp-2);border-bottom:1px solid var(--border)}
.pred-overall-rate{font:700 clamp(40px,11cqi,64px)/.95 var(--doto);letter-spacing:-.03em;color:var(--text-display);font-variant-numeric:tabular-nums}
.pred-overall-rate.is-empty{color:var(--text-disabled)}
.pred-overall-meta{margin:0;font:400 11px/1.4 var(--mono);color:var(--text-secondary)}
.pred-overall-baseline{margin:0;font:400 11px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--text-secondary)}
.pred-current-table-wrap{flex:1 1 auto;min-height:0;overflow-y:auto}
.pred-current-table{width:100%}
.pred-current-table th{font:400 10px/1.2 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);white-space:nowrap}
.pred-current-table td{font:400 12px/1.4 var(--mono);color:var(--text-primary);white-space:nowrap}
.pred-current-next{font-size:14px}
.pred-current-hit-n{margin-left:4px;font-size:10px;color:var(--text-secondary)}
.pred-row-good td{color:var(--success)}
.pred-panel-foot{margin:0;flex:0 0 auto;font:400 11px/1.4 var(--mono);color:var(--text-secondary)}
.pred-panel-foot a{color:inherit}
`;

// ---------------------------------------------------------------- CLI

async function main() {
  const opts = parseArgs();
  const base = typeof opts.base === 'string' ? opts.base : process.env.PREDICTIONS_BLOB_BASE;
  if (!base) {
    console.log('[tracker:predictions] no --base / PREDICTIONS_BLOB_BASE set, skipping pull');
    return;
  }
  const result = await pullPredictions(opts.data, base);
  console.log(`[tracker:predictions] +${result.added} (dup ${result.duplicates}, ${result.days} day file(s))`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[tracker:predictions] ${err.message}`);
    process.exit(1);
  });
}
