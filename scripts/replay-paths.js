#!/usr/bin/env node
/**
 * Flag-paths replay (T4 P0 item 2, docs/PLAN_FLAG_PATHS.md).
 *
 * For every distinct flag candidate seen while replaying stored history through the
 * production pipeline, finds its FIRST tightening point (the first closed candle at
 * which it reads `forming` or `proto`), labels the path it actually took from there
 * (`scripts/tracker/flag-paths.js`'s `labelPath`), and buckets the features available at
 * that moment (`featuresAt`). One row per candidate, written as JSONL; `--report` prints
 * base-rate tables over the rows.
 *
 * Why this does not simply read scripts/replay.js's JSONL: `toReplayLine` keeps only a
 * compact `candidateLifecycle` (state/failReason/breakoutLevel/invalidation/
 * measuredTarget) - it drops flagHigh/flagLow/compressionScore/durationCandles/
 * impulseStrength, and the JSONL never carries topDown/bias (scripts/replay.js's `buildAt`
 * calls `buildScalpContext` without `includeBias`). Rather than change scripts/replay.js
 * (owned by another agent this thread), this script runs its own no-lookahead build loop
 * - the same clock/eligibility/fetch primitives scripts/replay.js already exports
 * (`clockCloses`, `makeReplayFetch`, `loadHistoryDir`, `closedRows`) - calling
 * `buildScalpContext` directly with `includeBias: true` so every field the plan asks for
 * (docs/PLAN_FLAG_PATHS.md "Features at the tightening point") is read from the real
 * payload, never re-derived by a parallel implementation.
 *
 * Two candle views per candidate, both real history, never synthetic:
 *   - "as of" the tightening point (`closedRows(fullByTf[tf], tf, fromMs, 500)`, the same
 *     closed-row selection `makeReplayFetch`'s `fetchKraken` uses internally): ATR
 *     (`lib/advancedIndicators.js`'s `calculateATR`, `ENGINE_CONFIG.flag.atrPeriod` - the
 *     same call `lib/patternDetector.js`'s detector makes) and the flag's own candles
 *     (`levelTests`/`structureSteps`). Detection-time only: never a candle closed after
 *     `fromMs`.
 *   - the FULL, unrestricted history for the candidate's own timeframe and 1m: fed to
 *     `labelPath`, which does its own no-lookahead walk forward from `fromMs` (that walk
 *     is the entire point of path labeling - see scripts/tracker/flag-paths.js's own
 *     doc comment for what "no lookahead" means there: never before `fromMs`, capped at
 *     `windowCandles`).
 * 3m is never read from a history file (scripts/replay.js's history files are native
 * timeframes only); it is derived once per symbol from the full 1m history via
 * `aggregateToBuckets` (`services/marketData.js`, the same derivation production and
 * scripts/replay.js use) and then read with `closedRows`/`labelPath` exactly like a
 * native timeframe - aggregating the full series once and slicing is equivalent to
 * deriving fresh at each `fromMs` (a 3m bucket's OHLC depends only on the 1m candles
 * inside that bucket).
 *
 * `roomR` (room to the next opposing geometry level, in R) is NOT `lib/flagTradePlan.js`'s
 * private `nearestRoomAhead` (unexported, and scoped to capping TP1 short of
 * `measuredTarget`). This script's `roomRAhead` is a small, deliberately different
 * function: the nearest opposing zone edge ahead of entry with no upper bound at the
 * measured target, because this is a general "how much room exists" feature
 * (docs/PLAN_FLAG_PATHS.md's `roomR` bucket edges are tight/moderate/roomy in R), not a
 * TP1-selection rule. See its own doc comment.
 *
 * Usage:
 *   node scripts/replay-paths.js --history <dir> [--symbols BTC,SOL,ETH] [--from <iso|ms>]
 *     [--to <iso|ms>] [--step <n>] [--out <rows.jsonl>] [--report] [--json <file>]
 *     [--min-n <n>]
 *
 *   node scripts/replay-paths.js --history <dir> --jsonl <replay.jsonl> --out <rows.jsonl>
 *     (reuses an existing scripts/replay.js JSONL's close schedule per symbol instead of
 *     recomputing the clock/eligibility scan here; still rebuilds every payload itself -
 *     see the "why this does not simply read" note above)
 *
 *   node scripts/replay-paths.js --in <rows.jsonl> --report --json report.json
 *     (report-only: skip the build phase and read rows a prior --out already wrote; this
 *     is also how to combine parallel per-symbol runs - see "Parallel invocation" below)
 *
 * Parallel invocation (symbols as separate processes; each build is the full production
 * pipeline over every timeframe, so it is the dominant cost - see the printed ms/build):
 *   node scripts/replay-paths.js --history <dir> --symbols BTC --out /tmp/btc.jsonl &
 *   node scripts/replay-paths.js --history <dir> --symbols SOL --out /tmp/sol.jsonl &
 *   node scripts/replay-paths.js --history <dir> --symbols ETH --out /tmp/eth.jsonl &
 *   wait
 *   cat /tmp/btc.jsonl /tmp/sol.jsonl /tmp/eth.jsonl > /tmp/all.jsonl
 *   node scripts/replay-paths.js --in /tmp/all.jsonl --report --json /tmp/report.json
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONFIG } from '../config/engine.js';
import { buildScalpContext, dropUnclosedCandles, INTERVAL_MS, SYMBOLS, TIMEFRAMES } from '../services/scalpContext.js';
import { aggregateToBuckets } from '../services/marketData.js';
import { calculateATR } from '../lib/advancedIndicators.js';
import { loadHistoryDir, closedRows, makeReplayFetch, clockCloses } from './replay.js';
import { readJsonl } from './replay-metrics.js';
import { PATHS, DEFAULT_PATH_OPTS, labelPath, featuresAt, baseRates } from './tracker/flag-paths.js';

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundN(v, n = 2) {
  if (!isFiniteNumber(v)) return null;
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// Wallet reads never run in a replay (same rule as scripts/replay.js's REPLAY_ACCOUNT).
const REPLAY_ACCOUNT = Object.freeze({ status: 'unavailable', margin: { usd: null, byAsset: {} } });

/** Swallow the pipeline's per-build console output; hundreds of builds otherwise flood stderr. */
async function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/**
 * One production build of one symbol at `cutMs`, with bias/topDown AND model evidence
 * included (unlike scripts/replay.js's `buildAt`, which requests neither - see this
 * file's header). `includeModel` publishes `s.model` (`lib/modelEvidence.js`'s
 * `buildDivergenceEvidence`), the only source for the T5 `divergence` feature
 * (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md P0 item 1) - the underlying evidence is always
 * computed by `buildScalpContext` regardless of this flag, `includeModel` only controls
 * whether it is attached to the payload, so this costs nothing extra per build.
 * @param {string} symbol
 * @param {Object} historyByTf - tf -> ascending candles, this symbol only
 * @param {number} cutMs
 * @param {Array<string>} [timeframes]
 */
export function buildFull(symbol, historyByTf, cutMs, timeframes = TIMEFRAMES) {
  return quietly(() => buildScalpContext({
    symbols: [symbol],
    timeframes,
    now: cutMs,
    includeFailed: true,
    includeBias: true,
    includeModel: true,
    slimFailed: false,
    fetchCandles: makeReplayFetch(historyByTf, cutMs),
    fetchAccount: async () => REPLAY_ACCOUNT
  }));
}

/** Closed candles the pipeline would receive for `tf` at `cutMs` (mirrors scripts/replay.js's own private servedCount). */
async function servedCount(historyByTf, tf, cutMs) {
  const env = await makeReplayFetch(historyByTf, cutMs)(null, tf, 500);
  return dropUnclosedCandles(env.candles, tf, cutMs).length;
}

function parseTime(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  const ms = isFiniteNumber(n) ? n : Date.parse(v);
  if (!isFiniteNumber(ms)) throw new Error(`bad time: ${v}`);
  return ms;
}

/**
 * The close schedule to build at for one symbol: every replayed timeframe's own clock
 * (scripts/replay.js's `clockCloses`), starting at the first close where every timeframe
 * has `ENGINE_CONFIG.replay.minComputeCandles` closed candles (the same eligibility rule
 * scripts/replay.js's `replaySymbol` applies - duplicated here, not imported, because it
 * is a small loop over already-exported primitives and importing `replaySymbol` itself
 * would mean going through `buildAt`, which cannot request `includeBias`).
 * `explicitCloses` (an existing replay JSONL's own close times) bypasses the eligibility
 * scan entirely and is used as-is, then still filtered by from/to/step below.
 * @param {Object} historyByTf
 * @param {{from:*, to:*, step:number, explicitCloses:Array<number>|null}} opts
 * @returns {Promise<Array<number>>}
 */
export async function computeTicks(historyByTf, { from = null, to = null, step = 1, explicitCloses = null } = {}) {
  let closes;
  if (Array.isArray(explicitCloses)) {
    closes = explicitCloses;
  } else {
    const timeframes = TIMEFRAMES;
    const clock = clockCloses(historyByTf, timeframes).closes;
    const min = ENGINE_CONFIG.replay.minComputeCandles;
    let first = -1;
    for (let i = 0; i < clock.length; i++) {
      let ok = true;
      for (const tf of timeframes) {
        // eslint-disable-next-line no-await-in-loop
        if ((await servedCount(historyByTf, tf, clock[i])) < min) { ok = false; break; }
      }
      if (ok) { first = i; break; }
    }
    closes = first === -1 ? [] : clock.slice(first);
  }
  const fromMs = parseTime(from);
  const toMs = parseTime(to);
  const selected = closes.filter((t) => (fromMs === null || t >= fromMs) && (toMs === null || t <= toMs));
  const out = [];
  for (let i = 0; i < selected.length; i += Math.max(1, step || 1)) out.push(selected[i]);
  return out;
}

/**
 * The nearest opposing horizontal-zone edge strictly ahead of `entry` in the candidate's
 * direction, in R (`r = |breakoutLevel - invalidation|`). Deliberately NOT
 * `lib/flagTradePlan.js`'s private `nearestRoomAhead` - see this file's header. Reads
 * only `horizontalResistanceZones`/`horizontalSupportZones` (the same zones
 * `nearestRoomAhead` reads; diagonals/confluence are a separate, richer read in
 * `lib/modelEvidence.js`'s `levelsAhead`, out of scope for this "no model library"
 * measurement).
 * @param {'long'|'short'} direction
 * @param {number} entry
 * @param {number} r
 * @param {Object|null} geometryContext
 * @returns {number|null}
 */
export function roomRAhead(direction, entry, r, geometryContext) {
  if (!isFiniteNumber(entry) || !(r > 0)) return null;
  const sign = direction === 'short' ? -1 : 1;
  let nearest = null;
  for (const g of Object.values(geometryContext || {})) {
    if (!g) continue;
    const zones = direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones;
    for (const z of zones || []) {
      const edge = direction === 'long' ? z.low : z.high;
      if (!isFiniteNumber(edge)) continue;
      if (sign * (edge - entry) <= 0) continue; // must sit strictly ahead of entry
      if (nearest === null || sign * (edge - nearest) < 0) nearest = edge;
    }
  }
  return nearest === null ? null : roundN((sign * (nearest - entry)) / r, 3);
}

/**
 * The TP1 `lib/flagTradePlan.js`'s (private, unexported) `nearestRoomAhead` would select
 * for a `breakoutLevel` entry: the nearest opposing zone edge strictly ahead of `entry`
 * AND short of `measuredTarget`, else `measuredTarget` itself. A price-returning
 * equivalent of that rule (same zone read and near-edge selection as `roomRAhead` above,
 * but bounded at `measuredTarget` and returning a price, not an R-multiple) - written
 * here, not exported from `lib/flagTradePlan.js`, because this thread does not touch
 * `lib/` (CLAUDE.md). Used by `scripts/replay-early-entry.js` (T5 P0,
 * docs/PLAN_DIVERGENCE_OPPORTUNITIES.md) as the shared TP1 for both its early and
 * retest-hold entries - both are always capped relative to `breakoutLevel`, the only
 * "entry" `flagTradePlan` itself ever caps against.
 * @param {'long'|'short'} direction
 * @param {number} entry - breakoutLevel
 * @param {number} measuredTarget
 * @param {Object|null} geometryContext
 * @returns {number|null} null when `entry`/`measuredTarget` are not finite numbers
 */
export function tp1Ahead(direction, entry, measuredTarget, geometryContext) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(measuredTarget)) return null;
  const sign = direction === 'short' ? -1 : 1;
  const orientedEntry = sign * entry;
  const orientedTarget = sign * measuredTarget;
  let nearestOriented = null;
  for (const g of Object.values(geometryContext || {})) {
    if (!g) continue;
    const zones = direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones;
    for (const z of zones || []) {
      const near = direction === 'long' ? z.low : z.high;
      if (!isFiniteNumber(near)) continue;
      const orientedNear = sign * near;
      if (orientedNear > orientedEntry && orientedNear < orientedTarget) {
        if (nearestOriented === null || orientedNear < nearestOriented) nearestOriented = orientedNear;
      }
    }
  }
  return nearestOriented === null ? measuredTarget : sign * nearestOriented;
}

/**
 * All zones of one kind (`horizontalSupportZones`/`horizontalResistanceZones`) across
 * every geometryContext timeframe, flattened - the same "read every timeframe's zones,
 * not just one borrowed timeframe" approach `roomRAhead` above and `flagTradePlan.js`'s
 * `nearestRoomAhead` both take, feeding `featuresAt`'s `atLevel` (T5 P0,
 * docs/PLAN_DIVERGENCE_OPPORTUNITIES.md).
 * @param {Object|null} geometryContext
 * @param {'horizontalSupportZones'|'horizontalResistanceZones'} key
 * @returns {Array<{low:number, high:number}>}
 */
export function mergeZones(geometryContext, key) {
  const out = [];
  for (const g of Object.values(geometryContext || {})) {
    if (!g || !Array.isArray(g[key])) continue;
    for (const z of g[key]) out.push(z);
  }
  return out;
}

/**
 * Build one output row for a candidate at its first tightening point.
 * @param {string} symbol
 * @param {Object} candidate - a candidateSetups entry, state forming/proto
 * @param {Object} s - payload.symbols[symbol] for the build this candidate was first seen in
 * @param {Array<Object>} flagCandidates - every type:'flag' candidate in that same build (for tfAgreement)
 * @param {Object} fullByTf - tf -> FULL ascending candles (native + derived 3m), unrestricted by cutMs
 * @param {Object} pathOpts - merged over DEFAULT_PATH_OPTS (minus fromMs, set here)
 * @returns {Object|null} null when the candidate's own timeframe has no usable closedThrough
 */
export function buildRow(symbol, candidate, s, flagCandidates, fullByTf, pathOpts = {}) {
  const tf = candidate.timeframe;
  const closedThroughIso = s.timeframes && s.timeframes[tf] && s.timeframes[tf].closedThrough;
  const fromMs = typeof closedThroughIso === 'string' ? Date.parse(closedThroughIso) : NaN;
  if (!isFiniteNumber(fromMs)) return null;

  const direction = candidate.direction;
  const r = isFiniteNumber(candidate.breakoutLevel) && isFiniteNumber(candidate.invalidation)
    ? Math.abs(candidate.breakoutLevel - candidate.invalidation) : null;

  // "As of" fromMs only - never a candle closed after it (see this file's header).
  const candlesTfFull = fullByTf[tf] || [];
  const candlesTfAsOf = closedRows(candlesTfFull, tf, fromMs, 500);
  const atrResult = candlesTfAsOf.length > ENGINE_CONFIG.flag.atrPeriod ? calculateATR(candlesTfAsOf, ENGINE_CONFIG.flag.atrPeriod) : null;
  const atrValue = atrResult && isFiniteNumber(atrResult.atr) ? atrResult.atr : null;

  const flagLen = Math.max(1, (isFiniteNumber(candidate.durationCandles) ? candidate.durationCandles : 0) + 1);
  const flagCandles = candlesTfAsOf.slice(Math.max(0, candlesTfAsOf.length - flagLen));
  // The tightening candle's OWN close: closedRows' cutoff is a close-time boundary
  // (scripts/replay.js's closeTimeOf), so the tightening candle - the newest one closed
  // as of fromMs by construction - is always candlesTfAsOf's LAST row. T5 P0
  // (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md): the early-entry price, before confirmation.
  const tighteningClose = candlesTfAsOf.length ? candlesTfAsOf[candlesTfAsOf.length - 1].close : null;

  const stochRsi = (s.timeframes && s.timeframes[tf] && s.timeframes[tf].stochRsi) || {};
  const sameDirOtherTf = flagCandidates.some((c) => c.timeframe !== tf && c.direction === direction && c.state !== 'failed');
  const tdSide = s.topDown && typeof s.topDown.sentiment === 'string' ? s.topDown.sentiment : undefined;
  const roomR = r !== null && r > 0 ? roomRAhead(direction, candidate.breakoutLevel, r, s.geometryContext) : null;
  const tp1Cap = (direction === 'long' || direction === 'short') && isFiniteNumber(candidate.breakoutLevel) && isFiniteNumber(candidate.measuredTarget)
    ? tp1Ahead(direction, candidate.breakoutLevel, candidate.measuredTarget, s.geometryContext) : null;

  // T5 P0 (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md item 1): divergence, atLevel,
  // sweepReclaim, counterTrend - all read from the SAME "as of fromMs" build `s` already
  // is (buildFull requests includeModel/includeBias), never re-derived.
  const divergenceTf = s.model && s.model.divergence && s.model.divergence.byTimeframe ? s.model.divergence.byTimeframe[tf] : null;
  const supportZones = mergeZones(s.geometryContext, 'horizontalSupportZones');
  const resistanceZones = mergeZones(s.geometryContext, 'horizontalResistanceZones');
  // "As of" fromMs only, same as flagCandles/atrValue above - never a candle closed after it.
  const recentCandles = candlesTfAsOf.slice(Math.max(0, candlesTfAsOf.length - 5));
  const fourHourBias = s.biasMatrix && s.biasMatrix['4h'] ? s.biasMatrix['4h'].bias : undefined;

  const ctx = {
    flagCandles,
    atrValue,
    stochSide: typeof stochRsi.state === 'string' ? stochRsi.state.toLowerCase() : undefined,
    stochSlope: isFiniteNumber(stochRsi.slopeK) ? stochRsi.slopeK : undefined,
    sameDirOtherTf,
    tdSide,
    ema200Side: candidate.ema200Side || undefined,
    roomR: roomR !== null ? roomR : undefined,
    fromMs,
    divergenceType: divergenceTf && typeof divergenceTf.type === 'string' ? divergenceTf.type : undefined,
    divergenceStrength: divergenceTf && isFiniteNumber(divergenceTf.strength) ? divergenceTf.strength : undefined,
    supportZones,
    resistanceZones,
    recentCandles,
    fourHourBias: typeof fourHourBias === 'string' ? fourHourBias : undefined
  };
  const features = featuresAt(candidate, ctx);

  // labelPath does its own forward no-lookahead walk from fromMs (see this file's
  // header) - candlesTfFull/fullByTf['1m'] are intentionally the FULL, unrestricted
  // history, not candlesTfAsOf.
  const label = labelPath(candidate, candlesTfFull, fullByTf['1m'] || [], { ...pathOpts, fromMs });

  return {
    symbol,
    candidateId: candidate.candidateId,
    timeframe: tf,
    direction,
    detectedAt: new Date(fromMs).toISOString(),
    state: candidate.state,
    confidence: isFiniteNumber(candidate.confidence) ? candidate.confidence : null,
    compressionScore: isFiniteNumber(candidate.compressionScore) ? candidate.compressionScore : null,
    durationCandles: isFiniteNumber(candidate.durationCandles) ? candidate.durationCandles : null,
    impulseStrength: isFiniteNumber(candidate.impulseStrength) ? candidate.impulseStrength : null,
    breakoutLevel: isFiniteNumber(candidate.breakoutLevel) ? candidate.breakoutLevel : null,
    invalidation: isFiniteNumber(candidate.invalidation) ? candidate.invalidation : null,
    measuredTarget: isFiniteNumber(candidate.measuredTarget) ? candidate.measuredTarget : null,
    ema200Side: candidate.ema200Side || null,
    roomR,
    atrValue,
    // T5 P0 (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md item 2): consumed by
    // scripts/replay-early-entry.js, not by the T4 path-label/base-rate report above.
    tighteningClose,
    tp1Cap,
    path: label.path,
    breakoutAt: label.breakoutAt,
    retestAt: label.retestAt,
    resolvedAt: label.resolvedAt,
    mfeR: label.mfeR,
    targetR: label.targetR,
    minutes: label.minutes,
    features
  };
}

/**
 * Replay one symbol: build at every tick in `ticks`, and for every distinct
 * `candidateId` first seen `forming`/`proto`, label its path from that first sighting.
 * A later re-sighting of the same `candidateId` (e.g. a 5m candidate still `forming` on
 * the next 1m-clock tick, before its own timeframe's next close) is skipped - only the
 * FIRST tightening point is ever labelled (docs/PLAN_FLAG_PATHS.md).
 * @param {string} symbol
 * @param {Object} historyByTf - tf -> ascending candles, this symbol only (native timeframes)
 * @param {Array<number>} ticks
 * @param {Object} [pathOpts]
 * @param {Function} [buildFn] - injectable, for tests (default `buildFull`)
 * @returns {Promise<{rows:Array<Object>, buildMs:number}>}
 */
export async function runSymbol(symbol, historyByTf, ticks, pathOpts = {}, buildFn = buildFull) {
  const full3m = aggregateToBuckets(historyByTf['1m'] || [], INTERVAL_MS['1m'], INTERVAL_MS['3m']);
  const fullByTf = { ...historyByTf, '3m': full3m };
  const seen = new Map();
  let buildMs = 0;
  for (const cutMs of ticks) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const payload = await buildFn(symbol, historyByTf, cutMs);
    buildMs += Date.now() - t0;
    const s = payload && payload.symbols && payload.symbols[symbol];
    if (!s) continue;
    const flagCandidates = (s.candidateSetups || []).filter((c) => c && c.type === 'flag');
    for (const c of flagCandidates) {
      if (c.state !== 'forming' && c.state !== 'proto') continue;
      if (!c.candidateId || seen.has(c.candidateId)) continue;
      const row = buildRow(symbol, c, s, flagCandidates, fullByTf, pathOpts);
      if (row) seen.set(c.candidateId, row);
    }
  }
  return { rows: [...seen.values()], buildMs };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Base-rate tables over labelled rows: overall, per timeframe x direction, per single
 * feature bucket, and the top-n 2-feature combo buckets by sample size (docs/
 * PLAN_FLAG_PATHS.md "P0" item 2). `calibrated`/`uncalibrated` per bucket comes straight
 * from `baseRates` (`n >= minN`) - never filtered out here, so an honest "most buckets
 * read uncalibrated" is exactly what a small dataset reports.
 * @param {Array<Object>} rows
 * @param {number} [minN=100]
 * @param {number} [topComboCount=25]
 */
export function buildReport(rows, minN = 100, topComboCount = 25) {
  const overall = baseRates(rows, () => 'all', minN);
  const byTfDir = baseRates(rows, (r) => `${r.timeframe}:${r.direction}`, minN);
  const featureNames = rows.length ? Object.keys(rows[0].features) : [];
  const byFeature = {};
  for (const f of featureNames) byFeature[f] = baseRates(rows, (r) => r.features[f], minN);

  const combos = [];
  for (let i = 0; i < featureNames.length; i++) {
    for (let j = i + 1; j < featureNames.length; j++) {
      const [fa, fb] = [featureNames[i], featureNames[j]];
      const table = baseRates(rows, (r) => `${fa}=${r.features[fa]}|${fb}=${r.features[fb]}`, minN);
      for (const t of table) combos.push({ ...t, features: [fa, fb] });
    }
  }
  combos.sort((a, b) => b.n - a.n);

  return { rowCount: rows.length, minN, overall, byTfDir, byFeature, topCombos: combos.slice(0, topComboCount) };
}

function printBaseRateTable(title, table) {
  console.log(`\n${title}`);
  if (!table.length) { console.log('  (no data)'); return; }
  const header = ['key', 'n', 'calibrated', ...PATHS];
  const body = table.map((t) => [String(t.key), t.n, t.calibrated ? 'yes' : 'uncalibrated', ...PATHS.map((p) => (t.shares[p] === null ? '-' : t.shares[p]))]);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)));
  for (const row of all) console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join('  '));
}

function printReport(report) {
  console.log(`\nrows: ${report.rowCount} (minN ${report.minN})`);
  printBaseRateTable('overall', report.overall);
  printBaseRateTable('by timeframe x direction', report.byTfDir);
  for (const [f, t] of Object.entries(report.byFeature)) printBaseRateTable(`feature: ${f}`, t);
  // combo keys are already "featureA=valueA|featureB=valueB" (see buildReport) - readable as-is.
  printBaseRateTable(`top 2-feature combos (${report.topCombos.length} shown, by n)`, report.topCombos);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
  const num = (v) => (v === undefined || v === true ? undefined : Number(v));
  return {
    history: typeof opts.history === 'string' ? opts.history : null,
    jsonl: typeof opts.jsonl === 'string' ? opts.jsonl : null,
    in: typeof opts.in === 'string' ? opts.in : null,
    symbols: list(opts.symbols),
    from: opts.from === true ? null : opts.from ?? null,
    to: opts.to === true ? null : opts.to ?? null,
    step: opts.step ? Number(opts.step) : 1,
    out: typeof opts.out === 'string' ? opts.out : null,
    report: Boolean(opts.report),
    json: typeof opts.json === 'string' ? opts.json : null,
    minN: opts['min-n'] ? Number(opts['min-n']) : 100,
    windowCandles: num(opts['window-candles']),
    retestTolR: num(opts['retest-tol-r']),
    targetR: num(opts['target-r'])
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pathOpts = {};
  if (args.windowCandles !== undefined) pathOpts.windowCandles = args.windowCandles;
  if (args.retestTolR !== undefined) pathOpts.retestTolR = args.retestTolR;
  if (args.targetR !== undefined) pathOpts.targetR = args.targetR;

  let rows;
  if (args.in) {
    rows = readJsonl(args.in);
  } else {
    if (!args.history) throw new Error('need --history <dir> (or --in <rows.jsonl>)');
    const symbols = args.symbols || SYMBOLS;
    const history = loadHistoryDir(args.history, symbols);

    let jsonlBySymbol = null;
    if (args.jsonl) {
      jsonlBySymbol = new Map();
      for (const line of readJsonl(args.jsonl)) {
        if (!symbols.includes(line.symbol)) continue;
        const ms = Date.parse(line.closedThrough);
        if (!Number.isFinite(ms)) continue;
        if (!jsonlBySymbol.has(line.symbol)) jsonlBySymbol.set(line.symbol, new Set());
        jsonlBySymbol.get(line.symbol).add(ms);
      }
    }

    rows = [];
    for (const symbol of symbols) {
      const explicitCloses = jsonlBySymbol && jsonlBySymbol.has(symbol)
        ? [...jsonlBySymbol.get(symbol)].sort((a, b) => a - b) : null;
      const ticks = await computeTicks(history[symbol], { from: args.from, to: args.to, step: args.step, explicitCloses });
      const started = Date.now();
      const { rows: symRows, buildMs } = await runSymbol(symbol, history[symbol], ticks, pathOpts);
      const ms = Date.now() - started;
      rows.push(...symRows);
      console.error(`[replay-paths] ${symbol}: ${ticks.length} builds, ${symRows.length} candidates, ${ms} ms total${ticks.length ? ` (${(buildMs / ticks.length).toFixed(1)} ms/build)` : ''}`);
    }
    if (args.out) writeFileSync(args.out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  }

  if (args.report || args.json) {
    const report = buildReport(rows, args.minN);
    if (args.report) printReport(report);
    if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[replay-paths] ${err.stack || err.message}`);
    process.exit(1);
  });
}

export default { buildFull, computeTicks, roomRAhead, tp1Ahead, mergeZones, buildRow, runSymbol, buildReport, parseArgs };
