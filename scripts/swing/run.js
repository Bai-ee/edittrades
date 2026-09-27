#!/usr/bin/env node
/**
 * S0 swing-trade research harness (docs/PROMPT_S0_SWING_RESEARCH.md, Agent S0-A -
 * "harness owner"). Owner question: can the system identify daily / 24-72h swing trades
 * with an edge? Research only - no product change, no deploy, no engine change.
 *
 * Loads every `scripts/swing/rules/*.js` module (each exports `meta` + `signalAt(ctx)`,
 * see RULE INTERFACE below), replays it over a stored history fixture at its own
 * `meta.tf` closes with no lookahead, scores every returned signal with the tracker's
 * vendored `walkOutcome` (scripts/tracker/walk-outcome.js) on 1m candles, and writes:
 *   - `docs/swing/<id>.json` - one file per rule: config, per-symbol and combined stats,
 *     every individual scored signal (for the orchestrator's own re-aggregation).
 *   - `docs/SWING_STUDY_2026-09-26.md` - the shared table, one section per rule.
 *
 * RULE INTERFACE (verbatim, shared contract - docs/PROMPT_S0_SWING_RESEARCH.md):
 *   export const meta = { id, label, source, tf: '4h'|'1d', holdMaxHours, stopKind: 'atr'|'structure'|'pct', notes };
 *   /** Called once per closed candle of `meta.tf`, no lookahead. `ctx` = { symbol, tf, i,
 *    * candlesByTf, indicatorsByTf, topDown, geometry } where every array is sliced to
 *    * closes <= this candle. Return null or { direction:'long'|'short', entry, stop, tp1,
 *    * tp2?, reason:string[] }. * /
 *   export function signalAt(ctx) {}
 *
 * ctx, as this harness builds it:
 *   - candlesByTf[tf]: the newest 499 CLOSED candles of `tf` as of this candle's close -
 *     the same window production's own fetch limit hands the pipeline (see
 *     scripts/replay.js's own comment: "the pipeline sees the same 499 closed candles
 *     per timeframe as production"), not the fixture's full depth. Keys: whatever native
 *     timeframes the fixture has for this symbol (1m/5m/15m/1h/4h/1d - 3m is derived
 *     production-side and not reconstructed here; no rule in this study needs it).
 *   - indicatorsByTf[tf]: `services/indicators.js` `calculateAllIndicators(candlesByTf[tf])`
 *     (production's own indicator function - ema21/ema200 + histories, stochRSI,
 *     analysis.trend/pullbackState), or null when a timeframe has under 200 candles
 *     (production's own `replay.minComputeCandles`, config/engine.js).
 *   - topDown: `lib/topDown.js` `buildTopDown({1w,1d,4h,1h})` (production code, unmodified),
 *     fed leans computed from indicatorsByTf: '1w' via the real `buildWeeklyLean` on the
 *     1D candles; '1d'/'4h'/'1h' via a harness-local `leanFrom()` that mirrors
 *     buildWeeklyLean's own method (price-vs-EMA21 sign + EMA21 slope sign, averaged) at
 *     candle instead of week granularity - topDown.js has no non-weekly lean exported, so
 *     this is a documented re-derivation of the same rule, not a redesign.
 *   - geometry[tf]: `lib/geometry.js` `buildGeometryContext(...)` (production code,
 *     unmodified) for tf in {15m, 1h, 4h} (config/engine.js `geometry.timeframes`) -
 *     null when a timeframe is missing or has too little history.
 *
 * Two rules in THIS package (legacy-swing, legacy-trend4h) call through the real
 * evaluator (services/strategy.js `evaluateAllStrategies`) directly instead of reading
 * ctx.topDown/ctx.geometry - see their own file headers for why and what is nulled.
 *
 * Usage:
 *   node scripts/swing/run.js [--history <dir>] [--symbols BTC,SOL,ETH] [--rules <ids>]
 *     [--out-dir docs/swing] [--out-md docs/SWING_STUDY_2026-09-26.md]
 *
 * No network. No lookahead: `candlesByTf` is built the same way scripts/replay.js's own
 * `closedRows` does (binary search on closeTime <= cut), so a rule can only ever see
 * candles closed at or before the candle it is being asked to signal on.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadHistoryDir, NATIVE_TIMEFRAMES } from '../replay.js';
import { SYMBOLS, INTERVAL_MS } from '../../services/scalpContext.js';
import { calculateAllIndicators } from '../../services/indicators.js';
import { buildGeometryContext } from '../../lib/geometry.js';
import { buildWeeklyLean, buildTopDown } from '../../lib/topDown.js';
import { walkOutcome, round, median } from '../tracker/walk-outcome.js';
import { netR } from '../tracker/costs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const MIN_COMPUTE_CANDLES = 200; // mirrors config/engine.js replay.minComputeCandles
const PRODUCTION_FETCH_WINDOW = 499; // mirrors the closed-candle window production's fetch limit gives the pipeline
const GEOMETRY_TIMEFRAMES = ['15m', '1h', '4h']; // mirrors config/engine.js geometry.timeframes
const MS_WEEK = 7 * 86400000;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function closeTimeOf(candle, tf) {
  return isFiniteNumber(candle.closeTime) ? candle.closeTime : candle.timestamp + INTERVAL_MS[tf];
}

/** First index whose close is AFTER cutMs (candles ascending by timestamp). */
export function firstIndexAfter(candles, tf, cutMs) {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (closeTimeOf(candles[mid], tf) <= cutMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The newest `count` candles of `candles` closed at or before `cutMs`. Same rule as scripts/replay.js's closedRows. */
export function closedWindow(candles, tf, cutMs, count) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const lo = firstIndexAfter(candles, tf, cutMs);
  return candles.slice(Math.max(0, lo - count), lo);
}

/** Swallow the production pipeline's console noise during a replay. */
function quietly(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

/**
 * Harness-local lean at candle granularity: mirrors lib/topDown.js buildWeeklyLean's own
 * method (price-vs-EMA21 sign + EMA21 slope sign, averaged) but applied to a plain
 * candle-close series instead of weekly-aggregated closes. topDown.js exports no
 * non-weekly lean, so this is a documented re-derivation of the same rule, not a new one.
 */
function leanFrom(closes, ema21History, lookback = 3) {
  if (!Array.isArray(closes) || closes.length === 0 || !Array.isArray(ema21History)) return 'neutral';
  const close = closes[closes.length - 1];
  const ema21 = ema21History[ema21History.length - 1];
  if (!isFiniteNumber(close) || !isFiniteNumber(ema21)) return 'neutral';
  const priorIdx = ema21History.length - 1 - lookback;
  const priorEma = priorIdx >= 0 ? ema21History[priorIdx] : null;
  const priceSign = Math.sign(close - ema21);
  const slopeSign = isFiniteNumber(priorEma) ? Math.sign(ema21 - priorEma) : 0;
  const score = (priceSign + slopeSign) / 2;
  return score > 0 ? 'bull' : score < 0 ? 'bear' : 'neutral';
}

/** Build the ctx object for one rule at one candle close. */
export function buildCtx({ symbol, tf, i, historyByTf }) {
  const candles = historyByTf[tf];
  const cutMs = closeTimeOf(candles[i], tf);

  const candlesByTf = {};
  const indicatorsByTf = {};
  for (const nativeTf of NATIVE_TIMEFRAMES) {
    if (!historyByTf[nativeTf]) continue;
    const window = closedWindow(historyByTf[nativeTf], nativeTf, cutMs, PRODUCTION_FETCH_WINDOW);
    candlesByTf[nativeTf] = window;
    if (window.length >= MIN_COMPUTE_CANDLES) {
      try {
        indicatorsByTf[nativeTf] = calculateAllIndicators(window);
      } catch {
        indicatorsByTf[nativeTf] = null;
      }
    } else {
      indicatorsByTf[nativeTf] = null;
    }
  }

  // topDown (production buildTopDown, real code; leans as documented above)
  let topDown = null;
  try {
    const weekly = candlesByTf['1d'] ? buildWeeklyLean(candlesByTf['1d']) : null;
    const d1 = indicatorsByTf['1d'];
    const h4 = indicatorsByTf['4h'];
    const h1 = indicatorsByTf['1h'];
    const leans = {
      '1w': weekly ? weekly.bias : 'neutral',
      '1d': d1 ? leanFrom(candlesByTf['1d'].map((c) => c.close), d1.ema.ema21History) : 'neutral',
      '4h': h4 ? leanFrom(candlesByTf['4h'].map((c) => c.close), h4.ema.ema21History) : 'neutral',
      '1h': h1 ? leanFrom(candlesByTf['1h'].map((c) => c.close), h1.ema.ema21History) : 'neutral'
    };
    topDown = buildTopDown(leans);
  } catch {
    topDown = null;
  }

  // geometry (production buildGeometryContext, real code) for 15m/1h/4h
  const geometry = {};
  for (const gtf of GEOMETRY_TIMEFRAMES) {
    const ind = indicatorsByTf[gtf];
    if (!ind || !candlesByTf[gtf]) { geometry[gtf] = null; continue; }
    try {
      geometry[gtf] = buildGeometryContext({
        timeframe: gtf,
        candles: candlesByTf[gtf],
        ema21History: ind.ema.ema21History,
        ema200History: ind.ema.ema200History,
        stochHistory: ind.stochRSI && ind.stochRSI.history
      });
    } catch {
      geometry[gtf] = null;
    }
  }

  return {
    symbol,
    tf,
    i: candlesByTf[tf] ? candlesByTf[tf].length - 1 : null,
    candlesByTf,
    indicatorsByTf,
    topDown,
    geometry,
    cutMs // convenience, additive: the wall-clock close time this ctx was built at
  };
}

/** Binary search: first index of `candles1m` whose timestamp is >= tsMs. */
export function firstAtOrAfter(candles1m, tsMs) {
  let lo = 0;
  let hi = candles1m.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles1m[mid].timestamp < tsMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Score one signal with the tracker's walkOutcome. Slices the 1m array down to a small
 * window around fromMs first (binary search) so walkOutcome's own linear scan-to-start
 * stays cheap regardless of how deep into a multi-month fixture the signal sits.
 *
 * `holdRule` (S3, docs/PROMPT_S3_RETEST_ENTRY.md) is an additional early-exit option, on
 * top of stop/target: when given, `scoreSignalWithHoldRule` below runs an interleaved
 * walk (stop/target exactly as walkOutcome, PLUS the structure exit) instead of calling
 * walkOutcome directly. Omitting it (every pre-S3 rule) takes the original path,
 * byte-for-byte unchanged.
 * @param {{insideLow:number, insideHigh:number, n:number, tfCandleMs:number}} [holdRule] -
 *   exit early once `n` consecutive closes, sampled at `tfCandleMs` boundaries from
 *   `fromMs`, land inside `[insideLow, insideHigh]` (the pre-breakout flag range) -
 *   "closed back inside the flag" per the S3 prompt.
 */
export function scoreSignal({ candles1m, fromMs, direction, entry, stop, target, fillWindowCandles, maxHoldCandles, holdRule }) {
  const startIdx = Math.max(0, firstAtOrAfter(candles1m, fromMs) - 1);
  const endIdx = Math.min(candles1m.length, startIdx + fillWindowCandles + maxHoldCandles + 2);
  const slice = candles1m.slice(startIdx, endIdx);

  if (holdRule) {
    return scoreSignalWithHoldRule({ slice, fromMs, direction, entry, stop, target, fillWindowCandles, maxHoldCandles, holdRule });
  }

  const out = walkOutcome({
    candles1m: slice,
    fromMs,
    direction,
    entryMin: entry,
    entryMax: entry,
    stop,
    target,
    fillWindowCandles,
    maxHoldCandles
  });
  // Swing scoring (orchestrator patch 2026-09-26): a trade still open when the hold limit
  // is reached is CLOSED at that candle's close and scored mark-to-market (`timeout`),
  // instead of being dropped from n/resolved as walkOutcome's `open` would. Fill index is
  // re-derived exactly as walkOutcome does (first candle at/after fromMs whose range
  // touches entry, within fillWindowCandles).
  if (out.status !== 'open') return out;
  let start = 0;
  while (start < slice.length && slice[start].timestamp < fromMs) start++;
  let fillIdx = -1;
  for (let i = start; i < Math.min(slice.length, start + fillWindowCandles); i++) {
    if (slice[i].low <= entry && slice[i].high >= entry) { fillIdx = i; break; }
  }
  if (fillIdx === -1) return out;
  const lastIdx = Math.min(slice.length - 1, fillIdx + maxHoldCandles - 1);
  const dataEnd = lastIdx < fillIdx + maxHoldCandles - 1; // hold window ran past the fixture
  const exit = slice[lastIdx].close;
  const risk = Math.abs(entry - stop);
  const r = risk > 0 ? (direction === 'long' ? (exit - entry) : (entry - exit)) / risk : 0;
  return { status: dataEnd ? 'data_end' : 'timeout', r: Math.round(r * 10000) / 10000, holdCandles: lastIdx - fillIdx + 1, exit };
}

/**
 * S3 structure exit (docs/PROMPT_S3_RETEST_ENTRY.md): `scoreSignal`'s `holdRule` path.
 * Walks the same fill -> stop/target sequence walkOutcome uses (same-candle stop still
 * loses; a target touch only counts on a LATER candle than the fill - never intrabar),
 * but ALSO watches, at every native-timeframe boundary since `fromMs`
 * (`fromMs + k*tfCandleMs`, k=1,2,...), whether that boundary's close (read off the 1m
 * candle whose own close lands on it - exact under continuous 1m coverage, which every
 * timeframe here divides evenly and crypto trades 24/7) sits inside
 * `[holdRule.insideLow, holdRule.insideHigh]`. `holdRule.n` consecutive such closes exit
 * the trade there ("closed back inside the flag for N candles" - the breakout has
 * failed), ahead of either the stop, the target, or the hold cap. A trade that never
 * triggers the structure exit still falls through to the same `timeout`/`data_end`
 * mark-to-market convention the non-holdRule path above uses.
 * @param {Object} p
 * @param {Array} p.slice - the 1m window already sliced around fromMs
 * @param {number} p.fromMs
 * @param {'long'|'short'} p.direction
 * @param {number} p.entry
 * @param {number} p.stop
 * @param {number} p.target
 * @param {number} p.fillWindowCandles
 * @param {number} p.maxHoldCandles
 * @param {{insideLow:number, insideHigh:number, n:number, tfCandleMs:number}} p.holdRule
 */
function scoreSignalWithHoldRule({ slice, fromMs, direction, entry, stop, target, fillWindowCandles, maxHoldCandles, holdRule }) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target)) return { status: 'invalid_levels' };

  let start = 0;
  while (start < slice.length && slice[start].timestamp < fromMs) start++;
  const fillEnd = Math.min(slice.length, start + fillWindowCandles);
  let fillIdx = -1;
  for (let i = start; i < fillEnd; i++) {
    if (slice[i].low <= entry && slice[i].high >= entry) { fillIdx = i; break; }
  }
  if (fillIdx === -1) return { status: 'not_filled' };

  const long = direction !== 'short';
  const risk = Math.abs(entry - stop);
  const rTarget = round(Math.abs(target - entry) / risk, 4);
  const { insideLow, insideHigh, n, tfCandleMs } = holdRule;
  let insideStreak = 0;
  let nextBoundaryMs = fromMs + tfCandleMs; // first native-tf close strictly after the signal candle

  const exitEnd = Math.min(slice.length, fillIdx + maxHoldCandles);
  for (let i = fillIdx; i < exitEnd; i++) {
    const c = slice[i];
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const targetHit = long ? c.high >= target : c.low <= target;
    const holdCandles = i - fillIdx + 1;
    if (stopHit) return { status: 'loss', r: -1, holdCandles, ambiguous: targetHit };
    if (targetHit && i > fillIdx) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };

    while (nextBoundaryMs <= c.timestamp) {
      const inside = c.close >= insideLow && c.close <= insideHigh;
      insideStreak = inside ? insideStreak + 1 : 0;
      if (insideStreak >= n) {
        const r = risk > 0 ? (long ? (c.close - entry) : (entry - c.close)) / risk : 0;
        return { status: 'structure_exit', r: round(r, 4), holdCandles };
      }
      nextBoundaryMs += tfCandleMs;
    }
  }

  // Hold cap reached (or the fixture ran out first) still open - mark-to-market, same
  // timeout/data_end convention the non-holdRule path uses.
  const lastIdx = Math.min(slice.length - 1, fillIdx + maxHoldCandles - 1);
  const dataEnd = lastIdx < fillIdx + maxHoldCandles - 1;
  const exit = slice[lastIdx].close;
  const r = risk > 0 ? (long ? (exit - entry) : (entry - exit)) / risk : 0;
  return { status: dataEnd ? 'data_end' : 'timeout', r: round(r, 4), holdCandles: lastIdx - fillIdx + 1, exit };
}

const RESOLVED = new Set(['win', 'loss', 'timeout', 'structure_exit']);
const isResolved = (r) => RESOLVED.has(r.outcome.status);
const grossR = (r) => (r.outcome.status === 'loss' ? -1 : r.outcome.r);

function longestLossStreak(rows) {
  let best = 0;
  let cur = 0;
  for (const r of rows) {
    if (grossR(r) < 0) { cur++; best = Math.max(best, cur); }
    else cur = 0;
  }
  return best;
}

export function statsFor(rows) {
  const resolved = rows.filter(isResolved);
  const wins = resolved.filter((r) => grossR(r) > 0);
  const grossRs = resolved.map(grossR);
  const stopPcts = rows.map((r) => Math.abs(r.entry - r.stop) / r.entry * 100);
  const netDirRs = resolved.map((r) => r.netDir);
  const netSensRs = resolved.map((r) => r.netSens);
  const holds = resolved.map((r) => r.outcome.holdCandles);
  const avg = (arr) => arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 4) : null;
  return {
    n: rows.length,
    resolved: resolved.length,
    winPct: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    grossExpR: avg(grossRs),
    netExpR: avg(netDirRs),
    netExpR_sens020: avg(netSensRs),
    maxLosingStreak: longestLossStreak(resolved),
    medianHoldHours: holds.length ? round(median(holds) / 60, 2) : null,
    medianStopPct: stopPcts.length ? round(median(stopPcts), 3) : null,
    timeouts: resolved.filter((r) => r.outcome.status === 'timeout').length
  };
}

export function splitHalves(resolvedRows) {
  const mid = Math.floor(resolvedRows.length / 2);
  const first = resolvedRows.slice(0, mid);
  const second = resolvedRows.slice(mid);
  const netAvg = (rows) => {
    const vals = rows.map((r) => r.netDir);
    return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 4) : null;
  };
  return { firstHalf: netAvg(first), secondHalf: netAvg(second) };
}

/** One rule, one symbol: replay signalAt over every meta.tf close, score every signal. */
export function runRuleOnSymbol(rule, symbol, historyByTf) {
  const tf = rule.meta.tf;
  const candles = historyByTf[tf];
  if (!Array.isArray(candles) || candles.length === 0) {
    return { symbol, rows: [], firstEligibleIdx: null, lastIdx: null };
  }
  const fillWindowCandles = INTERVAL_MS[tf] / 60000; // 1m candles in one meta.tf candle
  const maxHoldCandles = rule.meta.holdMaxHours * 60;
  const candles1m = historyByTf['1m'];

  let firstEligibleIdx = null;
  const rows = [];
  for (let i = 0; i < candles.length; i++) {
    // Need enough history on every native tf the harness builds before asking a rule to
    // signal (mirrors production's own minComputeCandles gate) - approximate with the
    // rule's own tf here; ctx-building already nulls indicators/geometry per-tf below
    // MIN_COMPUTE_CANDLES, so a rule reading them sees nulls until then regardless.
    if (i + 1 < MIN_COMPUTE_CANDLES) continue;
    if (firstEligibleIdx === null) firstEligibleIdx = i;

    const ctx = buildCtx({ symbol, tf, i, historyByTf });
    let signal;
    try {
      signal = rule.signalAt(ctx);
    } catch (err) {
      throw new Error(`${rule.meta.id} ${symbol} @${new Date(ctx.cutMs).toISOString()}: signalAt threw - ${err.message}`);
    }
    if (!signal) continue;
    const { direction, entry, stop, tp1, tp2, reason, holdRule } = signal;
    if (direction !== 'long' && direction !== 'short') continue;
    if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(tp1)) continue;
    // Reject a stop on the wrong side of entry (mirrors validateStrategySignal's own check).
    if (direction === 'long' && !(stop < entry)) continue;
    if (direction === 'short' && !(stop > entry)) continue;

    if (!Array.isArray(candles1m) || candles1m.length === 0) continue;
    // Only closes the 1m fixture can score: skip signals before 1m coverage begins, and
    // signals whose fill+hold window would run past its end (they would read as `open`).
    const oneMinStart = candles1m[0].timestamp;
    const oneMinEnd = candles1m[candles1m.length - 1].timestamp;
    if (ctx.cutMs < oneMinStart) continue;
    if (ctx.cutMs + (fillWindowCandles + maxHoldCandles) * 60000 > oneMinEnd) continue;
    // S3 (docs/PROMPT_S3_RETEST_ENTRY.md): a rule may return `holdRule` alongside the
    // standard fields to opt into scoreSignal's structure-exit path - additive, every
    // pre-S3 rule leaves it undefined and takes the original walkOutcome-only path.
    const outcome = scoreSignal({
      candles1m, fromMs: ctx.cutMs, direction, entry, stop, target: tp1,
      fillWindowCandles, maxHoldCandles, holdRule
    });
    if (outcome.status === 'invalid_levels') continue;

    const scored = RESOLVED.has(outcome.status);
    const gr = outcome.status === 'loss' ? -1 : outcome.r;
    const netDir = scored ? netR(entry, stop, gr, direction) : null;
    const netSens = scored ? netR(entry, stop, gr, null) : null;

    rows.push({
      closedThrough: new Date(ctx.cutMs).toISOString(),
      symbol,
      direction,
      entry: round(entry, 6),
      stop: round(stop, 6),
      tp1: round(tp1, 6),
      tp2: isFiniteNumber(tp2) ? round(tp2, 6) : null,
      reason: Array.isArray(reason) ? reason : (reason ? [String(reason)] : []),
      outcome,
      netDir,
      netSens
    });
  }
  return { symbol, rows, firstEligibleIdx, lastIdx: candles.length - 1 };
}

function weeksSpanned(candles, tf, fromIdx, toIdx) {
  if (fromIdx === null || toIdx === null || toIdx <= fromIdx) return null;
  const fromMs = closeTimeOf(candles[fromIdx], tf);
  const toMs = closeTimeOf(candles[toIdx], tf);
  return (toMs - fromMs) / MS_WEEK;
}

function tableRow(label, statsRow, oos, signalsPerWeek) {
  const passFail = (isFiniteNumber(oos.firstHalf) && isFiniteNumber(oos.secondHalf) && oos.firstHalf > 0 && oos.secondHalf > 0)
    ? 'pass' : 'fail';
  return [
    label,
    statsRow.n,
    statsRow.resolved,
    statsRow.winPct === null ? '-' : `${statsRow.winPct}%`,
    statsRow.grossExpR === null ? '-' : statsRow.grossExpR,
    statsRow.netExpR === null ? '-' : statsRow.netExpR,
    statsRow.netExpR_sens020 === null ? '-' : statsRow.netExpR_sens020,
    statsRow.maxLosingStreak,
    statsRow.medianHoldHours === null ? '-' : statsRow.medianHoldHours,
    statsRow.medianStopPct === null ? '-' : `${statsRow.medianStopPct}%`,
    statsRow.timeouts,
    signalsPerWeek === null ? '-' : round(signalsPerWeek, 2),
    oos.firstHalf === null ? '-' : oos.firstHalf,
    oos.secondHalf === null ? '-' : oos.secondHalf,
    passFail
  ];
}

const TABLE_HEADER = ['scope', 'n', 'resolved', 'win %', 'gross exp R', 'net exp R (dir-cost)', '0.20% sens', 'max losing streak', 'median hold h', 'median stop %', 'timeouts', 'signals/week', 'OOS 1st half net R', 'OOS 2nd half net R', 'pass/fail'];

function mdTable(rows) {
  const header = `| ${TABLE_HEADER.join(' | ')} |`;
  const sep = `| ${TABLE_HEADER.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return [header, sep, body].join('\n');
}

/** Run one rule across all symbols; returns { perSymbol, combined, tableRows, runtimeMs }. */
function runRule(rule, symbols, historyByTf) {
  const t0 = Date.now();
  const perSymbol = {};
  const tableRows = [];
  const allResolvedForOOS = [];
  let combinedRows = [];

  for (const symbol of symbols) {
    const { rows, firstEligibleIdx, lastIdx } = quietly(() => runRuleOnSymbol(rule, symbol, historyByTf[symbol]));
    perSymbol[symbol] = rows;
    combinedRows = combinedRows.concat(rows);
    const s = statsFor(rows);
    const resolved = rows.filter(isResolved);
    const oos = splitHalves(resolved);
    const c1 = historyByTf[symbol]['1m'];
    const weeks = c1 && c1.length ? (c1[c1.length - 1].timestamp - c1[0].timestamp) / MS_WEEK : null;
    const perWeek = weeks && weeks > 0 ? s.n / weeks : null;
    tableRows.push(tableRow(symbol, s, oos, perWeek));
    allResolvedForOOS.push(...resolved);
  }

  const combinedStats = statsFor(combinedRows);
  const combinedOos = splitHalves(allResolvedForOOS);
  // Every symbol's tf array spans the same fixture calendar, so "combined" signals/week
  // reuses the first symbol's span with n summed across symbols.
  const anySymbol = symbols[0];
  const c1 = historyByTf[anySymbol]['1m'];
  const combinedSpanWeeks = c1 && c1.length ? (c1[c1.length - 1].timestamp - c1[0].timestamp) / MS_WEEK : null;
  const combinedPerWeek = combinedSpanWeeks && combinedSpanWeeks > 0 ? combinedStats.n / combinedSpanWeeks : null;
  tableRows.push(tableRow('combined', combinedStats, combinedOos, combinedPerWeek));

  return {
    perSymbol,
    combinedStats,
    combinedOos,
    tableRows,
    runtimeMs: Date.now() - t0
  };
}

export function loadRules(rulesDir, filterIds) {
  if (!existsSync(rulesDir)) return [];
  const files = readdirSync(rulesDir).filter((f) => f.endsWith('.js')).sort();
  const rules = [];
  for (const f of files) {
    const id = f.replace(/\.js$/, '');
    if (filterIds && !filterIds.includes(id)) continue;
    rules.push({ file: f, path: path.join(rulesDir, f) });
  }
  return rules;
}

export function parseArgs(argv) {
  const args = { history: 'test/fixtures/history/deep60-2026-09-24', symbols: SYMBOLS, rules: null, outDir: 'docs/swing', outMd: 'docs/SWING_STUDY_2026-09-26.md' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--history') args.history = argv[++i];
    else if (a === '--symbols') args.symbols = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--rules') args.rules = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--out-md') args.outMd = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyDir = path.isAbsolute(args.history) ? args.history : path.join(REPO_ROOT, args.history);
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(REPO_ROOT, args.outDir);
  const outMd = path.isAbsolute(args.outMd) ? args.outMd : path.join(REPO_ROOT, args.outMd);
  const rulesDir = path.join(__dirname, 'rules');

  mkdirSync(outDir, { recursive: true });

  console.log(`[swing:study] history=${historyDir}`);
  const historyByTf = loadHistoryDir(historyDir, args.symbols);

  const ruleFiles = loadRules(rulesDir, args.rules);
  if (ruleFiles.length === 0) {
    console.log('[swing:study] no rule files found under scripts/swing/rules/ - nothing to do.');
    return;
  }

  const sections = [];
  for (const { file, path: rulePath } of ruleFiles) {
    const mod = await import(pathToFileURL(rulePath).href);
    if (!mod.meta || typeof mod.signalAt !== 'function') {
      throw new Error(`${file}: must export meta and signalAt(ctx) per the rule interface`);
    }
    const rule = { meta: mod.meta, signalAt: mod.signalAt };
    console.log(`[swing:study] running ${rule.meta.id} (tf=${rule.meta.tf}, holdMaxHours=${rule.meta.holdMaxHours}) ...`);
    const result = runRule(rule, args.symbols, historyByTf);
    console.log(`[swing:study] ${rule.meta.id} done in ${result.runtimeMs}ms`);

    const jsonOut = {
      meta: rule.meta,
      generatedAt: new Date().toISOString(),
      runtimeMs: result.runtimeMs,
      combined: { stats: result.combinedStats, oos: result.combinedOos },
      perSymbol: Object.fromEntries(Object.entries(result.perSymbol).map(([sym, rows]) => [sym, {
        stats: statsFor(rows),
        signals: rows
      }]))
    };
    writeFileSync(path.join(outDir, `${rule.meta.id}.json`), JSON.stringify(jsonOut, null, 2) + '\n');

    sections.push({ rule, tableRows: result.tableRows, runtimeMs: result.runtimeMs });
  }

  const mdParts = [
    '# S0 swing-trade research - study results',
    '',
    `Generated ${new Date().toISOString()} by \`scripts/swing/run.js\` (Agent S0-A harness), fixture \`${path.relative(REPO_ROOT, historyDir)}\`.`,
    '',
    'Columns: n (signals inside 1m coverage) · resolved (win/loss, or timeout = closed at the hold limit, mark-to-market) · win % · gross exp R · net exp R (0.34% long / 0.14% short direction cost) · 0.20% sensitivity net R · max losing streak (resolved trades) · median hold (hours) · signals/week · OOS first/second half net R (dir-cost) · pass/fail (net > 0 in both halves).',
    ''
  ];
  for (const { rule, tableRows, runtimeMs } of sections) {
    mdParts.push(`## ${rule.meta.id} - ${rule.meta.label}`, '');
    mdParts.push(`Source: ${rule.meta.source}. tf=${rule.meta.tf}, holdMaxHours=${rule.meta.holdMaxHours}, stopKind=${rule.meta.stopKind}. Runtime: ${runtimeMs}ms.`, '');
    if (Array.isArray(rule.meta.notes) && rule.meta.notes.length) {
      for (const note of rule.meta.notes) mdParts.push(`- ${note}`);
      mdParts.push('');
    }
    mdParts.push(mdTable(tableRows), '');
  }

  writeFileSync(outMd, mdParts.join('\n'));
  console.log(`[swing:study] wrote ${path.relative(REPO_ROOT, outMd)}`);
}

// Only run the CLI when this file is executed directly (`node scripts/swing/run.js`),
// not when its helpers are imported for tests (test-swing-rules.js).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
