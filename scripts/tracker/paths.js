#!/usr/bin/env node
/**
 * EditTrades call tracker - flag path labels (T4 P0, docs/PLAN_FLAG_PATHS.md item 4).
 *
 * Reads stored capture rows (data/calls) and stored closed candles (1m, 5m, 15m; 3m is
 * derived from 1m, UTC-aligned full buckets only), finds every distinct engine flag
 * candidate the tracker has seen (by candidateId, across a capture row's candidateSetups
 * and/or its flagRecommendation.candidate), and labels each one's realised path from its
 * tightening point - the closedThrough of the first capture where that candidate's state
 * was 'forming' or 'proto' - using the vendored, pure `labelPath` / `featuresAt`
 * (./flag-paths.js, docs/PLAN_FLAG_PATHS.md P0).
 *
 * Writes data/paths.jsonl, one row per candidate. A row whose window has not elapsed yet
 * and has not otherwise resolved (breakout+target, false_break and fail_first all carry
 * their own resolvedAt) is `status: 'pending'` and recomputed next run; once resolved a
 * row is kept exactly as written (idempotent, like score.js's FINAL_OUTCOMES) - its
 * `labelledAt` never moves again.
 *
 * Read-only with respect to the rest of the store: never touches data/outcomes.jsonl or
 * data/aggregates.json, and changes no existing scored number (docs/PLAN_FLAG_PATHS.md P0
 * item 4: "outcomes.jsonl and every scored number stay untouched"). score.js and
 * aggregate.js are not imported for their scoring behaviour - only score.js's already
 *-exported, side-effect-free `callDims` is reused, purely to read td:/ema200 context off
 * a capture row the same way the scorer already does.
 *
 * Usage: node paths.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJsonl } from './store.js';
import { isFiniteNumber } from './walk-outcome.js';
import { PATHS, DEFAULT_PATH_OPTS, labelPath, featuresAt, baseRates } from './flag-paths.js';
import { callDims } from './score.js';

// Flag candidates only ever live on the engine's default flag timeframes (1m/3m/5m,
// config/engine.js flag.timeframes); 15m is listed here only because it is a stored
// candle timeframe (geometry), never a candidate tf - it degrades to 'unknown' spacing
// (windowElapsed) if a candidate ever names it.
const TF_MS = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000 };
const DAY_MS = 24 * 60 * 60 * 1000;

export function pathsFile(dataDir) {
  return path.join(dataDir, 'paths.jsonl');
}

/**
 * 3m candles derived from stored 1m candles: full, UTC-aligned buckets only (three
 * consecutive 1m candles starting on a 3-minute UTC boundary; a partial trailing bucket -
 * fewer than three consecutive minutes stored - is dropped, matching "closed candles
 * only").
 * @param {Object<string, Array<Object>>} candles1mBySymbol
 * @returns {Object<string, Array<Object>>}
 */
export function derive3mFrom1m(candles1mBySymbol) {
  const out = {};
  for (const [symbol, candles] of Object.entries(candles1mBySymbol || {})) {
    const bySecond = new Map((candles || []).map((c) => [c.timestamp, c]));
    const buckets = [];
    for (const c of candles || []) {
      if (c.timestamp % TF_MS['3m'] !== 0) continue;
      const c2 = bySecond.get(c.timestamp + TF_MS['1m']);
      const c3 = bySecond.get(c.timestamp + 2 * TF_MS['1m']);
      if (!c2 || !c3) continue;
      buckets.push({
        timestamp: c.timestamp,
        open: c.open,
        high: Math.max(c.high, c2.high, c3.high),
        low: Math.min(c.low, c2.low, c3.low),
        close: c3.close
      });
    }
    out[symbol] = buckets.sort((a, b) => a.timestamp - b.timestamp);
  }
  return out;
}

/** Stored candles for every timeframe a flag candidate can live on, keyed by tf then symbol. */
export function readAllTfCandles(dataDir) {
  const c1m = readCandles(dataDir, '1m');
  return { '1m': c1m, '3m': derive3mFrom1m(c1m), '5m': readCandles(dataDir, '5m'), '15m': readCandles(dataDir, '15m') };
}

/**
 * Every candidate named in one capture row, keyed by candidateId: candidateSetups
 * entries (richer - may carry the T4-additive fields, records.js `slimCandidate`) take
 * priority; a flagRecommendation.candidate summary (lib/flagRecommendation.js
 * `candidateSummary` - id/timeframe/direction/state/breakout/invalidation/measuredRR
 * only) fills in an id candidateSetups did not carry this capture. A legacy row stored
 * before the T4-additive fields existed still parses - the extra fields just read null.
 * @param {Object} row - a stored data/calls row
 * @returns {Map<string, Object>}
 */
export function candidatesInRow(row) {
  const map = new Map();
  for (const c of Array.isArray(row && row.candidateSetups) ? row.candidateSetups : []) {
    if (!c || typeof c.id !== 'string' || !c.id) continue;
    map.set(c.id, {
      candidateId: c.id,
      tf: c.tf ?? null,
      direction: c.dir ?? null,
      state: c.state ?? null,
      breakoutLevel: isFiniteNumber(c.breakout) ? c.breakout : null,
      invalidation: isFiniteNumber(c.invalidation) ? c.invalidation : null,
      measuredRR: isFiniteNumber(c.measuredRR) ? c.measuredRR : null,
      measuredTarget: isFiniteNumber(c.measuredTarget) ? c.measuredTarget : null,
      compressionScore: isFiniteNumber(c.compressionScore) ? c.compressionScore : null,
      durationCandles: isFiniteNumber(c.durationCandles) ? c.durationCandles : null,
      impulseStrength: isFiniteNumber(c.impulseStrength) ? c.impulseStrength : null,
      flagHigh: isFiniteNumber(c.flagHigh) ? c.flagHigh : null,
      flagLow: isFiniteNumber(c.flagLow) ? c.flagLow : null
    });
  }
  const rc = row && row.flagRecommendation && row.flagRecommendation.candidate && typeof row.flagRecommendation.candidate === 'object'
    ? row.flagRecommendation.candidate : null;
  if (rc && typeof rc.candidateId === 'string' && rc.candidateId && !map.has(rc.candidateId)) {
    map.set(rc.candidateId, {
      candidateId: rc.candidateId,
      tf: rc.timeframe ?? null,
      direction: rc.direction ?? null,
      state: rc.state ?? null,
      breakoutLevel: isFiniteNumber(rc.breakout) ? rc.breakout : null,
      invalidation: isFiniteNumber(rc.invalidation) ? rc.invalidation : null,
      measuredRR: isFiniteNumber(rc.measuredRR) ? rc.measuredRR : null,
      measuredTarget: null, compressionScore: null, durationCandles: null, impulseStrength: null, flagHigh: null, flagLow: null
    });
  }
  return map;
}

/**
 * The tightening snapshot for every distinct candidateId across `rows`: the first
 * capture (chronological, any input order) where that id's state was 'forming' or
 * 'proto', with the candidate's own geometry as of that exact capture - the tightening
 * point is a fixed fact, never overwritten by a later, different-looking capture of the
 * same id. Internal `_row` carries the originating capture row for `contextFor` (feature
 * context); it is never written to paths.jsonl.
 * @param {Array<Object>} rows - data/calls rows, any order in
 * @returns {Array<Object>}
 */
export function extractTighteningPoints(rows) {
  const sorted = [...(rows || [])].sort((a, b) => Date.parse(a && a.closedThrough) - Date.parse(b && b.closedThrough));
  const tightened = new Map();
  for (const row of sorted) {
    if (!row || !row.symbol || !row.closedThrough) continue;
    for (const c of candidatesInRow(row).values()) {
      if (tightened.has(c.candidateId)) continue;
      if (c.state !== 'forming' && c.state !== 'proto') continue;
      const rec = row.flagRecommendation;
      const recMatches = !!rec && (rec.candidateId === c.candidateId || (rec.candidate && rec.candidate.candidateId === c.candidateId));
      tightened.set(c.candidateId, {
        ...c,
        symbol: row.symbol,
        tighteningAt: row.closedThrough,
        source: row.source === 'served' ? 'served' : 'cron',
        recClass: recMatches ? (rec.class ?? null) : null,
        _row: row
      });
    }
  }
  return [...tightened.values()];
}

/** The trailing `candidate.durationCandles` candles of `candlesTf` ending at the tightening close, or null. */
function flagCandlesFor(candidate, candlesTf) {
  const n = candidate.durationCandles;
  const intervalMs = TF_MS[candidate.tf];
  if (!isFiniteNumber(n) || n <= 0 || !isFiniteNumber(intervalMs) || !Array.isArray(candlesTf) || !candlesTf.length) return null;
  const lastOpenMs = Date.parse(candidate.tighteningAt) - intervalMs;
  const idx = candlesTf.findIndex((c) => c.timestamp === lastOpenMs);
  if (idx === -1) return null;
  return candlesTf.slice(Math.max(0, idx - n + 1), idx + 1);
}

/**
 * `featuresAt`'s ctx, built from whatever the tightening capture row itself carries.
 * Everything this tracker does not store yet (ATR, Stoch RSI, room to the next opposing
 * level) is left undefined - `featuresAt` buckets that as 'unknown', never a thrown error.
 * @param {Object} candidate - an `extractTighteningPoints` entry (carries `_row`)
 * @param {Array<Object>} candlesTf - the candidate's own timeframe, ascending
 */
export function contextFor(candidate, candlesTf) {
  const row = candidate._row;
  const dims = row ? callDims(row) : null;
  const others = row ? [...candidatesInRow(row).values()].filter((c) => c.candidateId !== candidate.candidateId) : [];
  let sameDirOtherTf;
  if (others.some((c) => c.direction && c.direction === candidate.direction && c.state !== 'failed')) sameDirOtherTf = true;
  else if (others.some((c) => c.direction && c.direction !== candidate.direction)) sameDirOtherTf = false;
  return {
    flagCandles: flagCandlesFor(candidate, candlesTf) || undefined,
    sameDirOtherTf,
    tdSide: dims && dims.topDownToken ? dims.topDownToken : undefined,
    ema200Side: dims && dims.ema200Side ? dims.ema200Side : undefined,
    fromMs: Date.parse(candidate.tighteningAt)
  };
}

/** True once `DEFAULT_PATH_OPTS.windowCandles` candidate-tf candles' worth of real time has passed since the tightening point. */
function windowElapsed(candidate, nowMs) {
  const intervalMs = TF_MS[candidate.tf];
  if (!isFiniteNumber(intervalMs)) return false;
  return nowMs >= Date.parse(candidate.tighteningAt) + DEFAULT_PATH_OPTS.windowCandles * intervalMs;
}

/**
 * Label every tightened candidate. A candidateId already `status: 'resolved'` in
 * `previous` is kept exactly as written (idempotent); only a new or still-`pending`
 * candidate is (re)computed.
 * @param {Array<Object>} rows - data/calls rows
 * @param {Object<string, Object<string, Array<Object>>>} candlesByTf - readAllTfCandles output
 * @param {Array<Object>} [previous=[]] - existing paths.jsonl rows
 * @param {number} [nowMs=Date.now()]
 * @returns {Array<Object>}
 */
export function computePathsRows(rows, candlesByTf, previous = [], nowMs = Date.now()) {
  const prevById = new Map((previous || []).map((r) => [r.candidateId, r]));
  const nowIso = new Date(nowMs).toISOString();
  const out = [];
  for (const candidate of extractTighteningPoints(rows)) {
    const prev = prevById.get(candidate.candidateId);
    if (prev && prev.status === 'resolved') { out.push(prev); continue; }

    const candlesTf = ((candlesByTf || {})[candidate.tf] && candlesByTf[candidate.tf][candidate.symbol]) || [];
    const candles1m = ((candlesByTf || {})['1m'] && candlesByTf['1m'][candidate.symbol]) || [];
    const result = labelPath(candidate, candlesTf, candles1m, { fromMs: Date.parse(candidate.tighteningAt) });
    const features = featuresAt({ ...candidate, timeframe: candidate.tf }, contextFor(candidate, candlesTf));
    const pending = result.path === 'chop' && !windowElapsed(candidate, nowMs);
    const status = pending ? 'pending' : 'resolved';

    out.push({
      candidateId: candidate.candidateId,
      symbol: candidate.symbol,
      tf: candidate.tf,
      direction: candidate.direction,
      tighteningAt: candidate.tighteningAt,
      source: candidate.source,
      recClass: candidate.recClass,
      status,
      path: result.path,
      breakoutAt: result.breakoutAt,
      retestAt: result.retestAt,
      resolvedAt: result.resolvedAt,
      mfeR: result.mfeR,
      targetR: result.targetR,
      minutes: result.minutes,
      features,
      labelledAt: status === 'resolved' ? (prev && prev.labelledAt ? prev.labelledAt : nowIso) : null
    });
  }
  return out.sort((a, b) => Date.parse(a.tighteningAt) - Date.parse(b.tighteningAt) || a.candidateId.localeCompare(b.candidateId));
}

/** Read data/calls + data/candles + existing paths.jsonl from `dataDir`, write paths.jsonl. */
export function pathsDataDir(dataDir, nowMs = Date.now()) {
  const rows = computePathsRows(readAllCalls(dataDir), readAllTfCandles(dataDir), readJsonl(pathsFile(dataDir)), nowMs);
  writeJsonl(pathsFile(dataDir), rows);
  return rows;
}

/**
 * Path-mix base rates over resolved rows (docs/PLAN_FLAG_PATHS.md "Path outcomes"),
 * windowed by `tighteningAt`: overall and by candidate timeframe, for 7d and 30d. Read by
 * build-page.js for the `#flag-paths-section` tile; never written into
 * data/aggregates.json - kept additive-only and entirely out of aggregate.js.
 * @param {Array<Object>} rows - paths.jsonl rows
 * @param {number} [nowMs=Date.now()]
 * @param {number} [minN=100]
 * @returns {{d7:Object, d30:Object}}
 */
export function pathsSummary(rows, nowMs = Date.now(), minN = 100) {
  const resolved = (Array.isArray(rows) ? rows : []).filter((r) => r && r.status === 'resolved' && PATHS.includes(r.path));
  const emptyGroup = { key: 'all', n: 0, shares: Object.fromEntries(PATHS.map((p) => [p, null])), calibrated: false };
  const block = (days) => {
    const sinceMs = nowMs - days * DAY_MS;
    const g = resolved.filter((r) => Date.parse(r.tighteningAt) >= sinceMs);
    return { n: g.length, overall: baseRates(g, () => 'all', minN)[0] || emptyGroup, byTf: baseRates(g, (r) => r.tf, minN) };
  };
  return { d7: block(7), d30: block(30) };
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const rows = pathsDataDir(opts.data, nowMs);
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`[tracker:paths] ${rows.length} candidate(s) -> ${pathsFile(opts.data)} ${JSON.stringify(counts)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:paths] ${err.message}`);
    process.exit(1);
  }
}
