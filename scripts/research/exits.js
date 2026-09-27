#!/usr/bin/env node
/**
 * S1 agent C - exits study (docs/PROMPT_S1_EDGE_SEARCH.md "C - exits study"). Owner
 * question: does trade MANAGEMENT change the sign of the flag entries' expectancy, given
 * the entries themselves show no edge at any timeframe (2026-09-26 finding)? Research
 * only - no product change, no deploy, no engine rule change.
 *
 * Takes the exact same population of signals `scripts/replay-rules.js`'s `L0` variant
 * would score (the live config verbatim: `services/scalpContext.js`'s production
 * pipeline, one signal per first-`ready` `flagTradePlan.candidateId`) and re-walks each
 * one's own 1m candle path under six exit-management variants. Nothing here
 * re-implements detection, geometry, or the flag trade plan's own construction - the
 * entry/stop/tp1/tp2 levels are read verbatim off the production plan, exactly as
 * `scripts/replay-rules.js`'s own `makeConfigCollector` does (this file does not import
 * or modify that collector; it is a small private function, so this is a documented
 * parallel re-implementation of the same read, not a fork of shared logic). The forward
 * walk over 1m candles reuses the tracker's own vendored `walkOutcome`
 * (`scripts/tracker/walk-outcome.js`, imported read-only, never modified) for the
 * `fixed` and `tp2` variants (same conservative stop-before-target, no-same-candle-fill-
 * win convention); the other four variants (`be1r`, `trail1r`, `partial50`, `time`) need
 * a moving stop or an early time-based close, which `walkOutcome` has no hook for, so
 * they are hand-rolled walkers below using the exact same conventions (ascending 1m
 * candles, no lookahead, prefilled entry, same-candle stop always resolves before a
 * same-candle target touch).
 *
 * Six variants (docs/PROMPT_S1_EDGE_SEARCH.md "C"):
 *   - fixed:     stop/TP1 exactly as shipped today.
 *   - be1r:      once a candle CLOSES at or beyond +1R favorable, stop moves to
 *                breakeven (entry) for the rest of the hold. Target unchanged (tp1).
 *   - trail1r:   once a candle CLOSES at or beyond +1R favorable, the stop starts
 *                trailing 1R behind the best CLOSE seen since, monotonically (never
 *                gives back ground). Target unchanged (tp1) - trailing only tightens the
 *                downside once armed, it does not extend the upside past tp1.
 *   - partial50: half the position off at +1R (booked at exactly 1R for that half), the
 *                other half's stop moves to breakeven and it continues toward the
 *                unchanged tp1. Reaching (intrabar) the target level before a candle has
 *                ever CLOSED at +1R still counts as the partial-then-target path - by
 *                construction tp1 is always farther than 1R away under the live gate
 *                (grossRR >= minRR, well above 1), so touching tp1 intrabar always
 *                implies the +1R milestone was passed along the same path.
 *   - time:      the exact `fixed` stop/tp1, but force-closed at market (mark-to-market
 *                against the original risk) if neither has been hit by
 *                `round(2 * medianTimeToTP1Candles)` candles, where the median is taken
 *                over the `fixed` variant's OWN winners on this same population (T-shape
 *                cutoff owned by the study, not a plan field). Falls back to the full
 *                24h hold when there are no `fixed` winners to time from.
 *   - tp2:       target becomes `flagTradePlan.tp2` when the plan carries one (a nearer
 *                opposing zone edge; not every plan has one), else falls back to tp1 -
 *                stop unchanged, no breakeven/trailing/partial management.
 *
 * A trade that resolves neither stop nor target by the 24h hold limit
 * (`scripts/replay-rules.js`'s own `HOLD_24H_CANDLES`) is left `open` (grossR null,
 * excluded from win rate, contributes 0 to the expectancy sum) for `fixed`/`be1r`/
 * `trail1r`/`tp2` - identical convention to `scripts/replay-rules.js`'s own `statsFor`.
 * `partial50` and `time` are exceptions the variant definitions themselves force: a
 * partial already booked is marked-to-market at the hold limit rather than left half-
 * null, and `time`'s whole point is an earlier forced mark-to-market close.
 *
 * Net R (`scripts/tracker/costs.js`'s `netR`, imported read-only, never modified):
 * direction-dependent round-trip cost, 0.34% for a long / 0.14% for a short (the owner's
 * D-cost decision, 2026-09-24 - USDC/USDT-funded positions, a long pays an extra swap in
 * and out a short does not), charged once against the ORIGINAL entry/stop risk
 * regardless of how a variant's exit stop moved - the R unit stays anchored to the
 * plan's own original risk throughout, same as every other cost column in this repo.
 *
 * Usage:
 *   node scripts/research/exits.js [--history <dir>] [--symbols BTC,SOL,ETH]
 *     [--out-dir var/research/exits] [--out-md docs/EXITS_STUDY_2026-09-26.md]
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHistoryDir, replaySymbol } from '../replay.js';
import { SYMBOLS, TIMEFRAMES } from '../../services/scalpContext.js';
import { walkOutcome, isFiniteNumber, round, median, FILL_WINDOW_CANDLES } from '../tracker/walk-outcome.js';
import { netR as costNetR } from '../tracker/costs.js';
import { HOLD_24H_CANDLES } from '../replay-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

export const VARIANT_IDS = ['fixed', 'be1r', 'trail1r', 'partial50', 'time', 'tp2'];

// ---------------------------------------------------------------------------
// L0 signal collection (production pipeline, live config verbatim - the same
// population scripts/replay-rules.js's L0 variant scores)
// ---------------------------------------------------------------------------

/**
 * One production run over `historyByTf`, capturing the first `ready` `flagTradePlan` per
 * `candidateId` - same dedup rule as `scripts/replay-rules.js`'s private
 * `makeConfigCollector`, plus `tp2` (that collector does not carry it forward). No
 * `setConfigOverride` call: L0 IS the config already on disk, so this reads
 * `services/scalpContext.js`'s production pipeline through `replaySymbol` unmodified.
 */
async function collectSymbolSignals(symbol, historyByTf, step = 1) {
  const seen = new Set();
  const signals = [];
  await replaySymbol({
    symbol,
    historyByTf,
    timeframes: TIMEFRAMES,
    step,
    onLine: (line) => {
      const plan = line.flagTradePlan;
      if (!plan || plan.status !== 'ready' || !plan.candidateId || seen.has(plan.candidateId)) return;
      seen.add(plan.candidateId);
      signals.push({
        symbol,
        candidateId: plan.candidateId,
        timeframe: plan.timeframe,
        direction: plan.direction,
        firstReadyAt: line.closedThrough,
        entry: plan.entry,
        stop: plan.stop,
        tp1: plan.tp1,
        tp2: isFiniteNumber(plan.tp2) ? plan.tp2 : null,
        stopDistancePct: plan.stopDistancePct
      });
    }
  });
  return signals;
}

/**
 * `step` (default 1, every close): docs/FREQUENCY_STUDY_2026-09-26.md's own precedent for
 * a fixture too large for a `--step 1` full replay to fit a session (~9.5ms/close through
 * the full production pipeline; deep2y's ~1.05M 1m candles/symbol is ~8.5x deep60's,
 * which itself took ~37 minutes at step 1 for 3 symbols) - sampling every `step`-th close
 * can miss a `ready` window shorter than `step` minutes entirely, same caveat that study
 * documented for its own `--step 5`.
 */
export async function collectL0Signals(historyDir, symbols, step = 1) {
  const historyByTf = loadHistoryDir(historyDir, symbols);
  const bySymbol = {};
  let all = [];
  for (const symbol of symbols) {
    const signals = await collectSymbolSignals(symbol, historyByTf[symbol], step);
    bySymbol[symbol] = signals;
    all = all.concat(signals);
  }
  return { historyByTf, signalsBySymbol: bySymbol, signals: all };
}

// ---------------------------------------------------------------------------
// exit walkers - one pure function per variant, all ascending-1m / no-lookahead /
// prefilled (the plan's own retest-hold already filled it at `entry` as of `fromMs`)
// ---------------------------------------------------------------------------

function firstIndexAtOrAfter(candles1m, fromMs) {
  let start = 0;
  while (start < candles1m.length && candles1m[start].timestamp < fromMs) start++;
  return start;
}

/** `fixed`: today's stop/tp1, unmodified `walkOutcome` (imported, never edited). */
export function walkFixed({ candles1m, fromMs, direction, entry, stop, target, maxHoldCandles = HOLD_24H_CANDLES }) {
  return walkOutcome({
    candles1m, fromMs, direction, entryMin: entry, entryMax: entry, stop, target,
    fillWindowCandles: FILL_WINDOW_CANDLES, maxHoldCandles, prefilled: true
  });
}

/** `tp2`: same walk as `fixed`, target swapped to tp2 when the plan carries one. */
export function walkTP2({ candles1m, fromMs, direction, entry, stop, tp1, tp2, maxHoldCandles = HOLD_24H_CANDLES }) {
  const target = isFiniteNumber(tp2) ? tp2 : tp1;
  return walkFixed({ candles1m, fromMs, direction, entry, stop, target, maxHoldCandles });
}

/** `be1r`: stop jumps to breakeven the first candle whose CLOSE reaches +1R favorable. */
export function walkBE1R({ candles1m, fromMs, direction, entry, stop, target, maxHoldCandles = HOLD_24H_CANDLES }) {
  const long = direction !== 'short';
  const risk = Math.abs(entry - stop);
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target) || !(risk > 0)) return { status: 'invalid_levels' };
  const start = firstIndexAtOrAfter(candles1m, fromMs);
  if (start >= candles1m.length) return { status: 'not_filled' };
  const rTarget = round(Math.abs(target - entry) / risk, 4);
  const end = Math.min(candles1m.length, start + maxHoldCandles);
  let activeStop = stop;
  let armed = false;

  for (let i = start; i < end; i++) {
    const c = candles1m[i];
    const holdCandles = i - start + 1;
    const stopHit = long ? c.low <= activeStop : c.high >= activeStop;
    const targetHit = long ? c.high >= target : c.low <= target;
    if (stopHit) return { status: armed ? 'breakeven' : 'loss', r: armed ? 0 : -1, holdCandles };
    if (targetHit) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };
    if (!armed) {
      const favorableR = long ? (c.close - entry) / risk : (entry - c.close) / risk;
      if (favorableR >= 1) { armed = true; activeStop = entry; }
    }
  }
  return { status: 'open', holdCandles: end - start };
}

/** `trail1r`: once armed at +1R (candle close), stop trails 1R behind the best close since. */
export function walkTrail1R({ candles1m, fromMs, direction, entry, stop, target, maxHoldCandles = HOLD_24H_CANDLES }) {
  const long = direction !== 'short';
  const risk = Math.abs(entry - stop);
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target) || !(risk > 0)) return { status: 'invalid_levels' };
  const start = firstIndexAtOrAfter(candles1m, fromMs);
  if (start >= candles1m.length) return { status: 'not_filled' };
  const rTarget = round(Math.abs(target - entry) / risk, 4);
  const end = Math.min(candles1m.length, start + maxHoldCandles);
  let activeStop = stop;
  let armed = false;
  let bestClose = entry;

  for (let i = start; i < end; i++) {
    const c = candles1m[i];
    const holdCandles = i - start + 1;
    const stopHit = long ? c.low <= activeStop : c.high >= activeStop;
    const targetHit = long ? c.high >= target : c.low <= target;
    if (stopHit) {
      const r = armed ? round(long ? (activeStop - entry) / risk : (entry - activeStop) / risk, 4) : -1;
      return { status: armed ? 'trail_stop' : 'loss', r, holdCandles };
    }
    if (targetHit) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };
    bestClose = long ? Math.max(bestClose, c.close) : Math.min(bestClose, c.close);
    const favorableR = long ? (bestClose - entry) / risk : (entry - bestClose) / risk;
    if (favorableR >= 1) {
      armed = true;
      const trailed = long ? bestClose - risk : bestClose + risk;
      activeStop = long ? Math.max(activeStop, trailed) : Math.min(activeStop, trailed);
    }
  }
  return { status: 'open', holdCandles: end - start };
}

/**
 * `partial50`: half off at +1R (booked at exactly 1R for that half), remaining half's
 * stop moves to breakeven and continues to the unchanged target. A target touch is
 * always treated as "partial already taken" (see file header) since target is always
 * farther than 1R under the live gate. Unresolved at the hold limit AFTER arming is
 * marked-to-market for the remaining half (see file header); unresolved BEFORE ever
 * arming is left `open`, same convention as every other variant.
 */
export function walkPartial50({ candles1m, fromMs, direction, entry, stop, target, maxHoldCandles = HOLD_24H_CANDLES }) {
  const long = direction !== 'short';
  const risk = Math.abs(entry - stop);
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target) || !(risk > 0)) return { status: 'invalid_levels' };
  const start = firstIndexAtOrAfter(candles1m, fromMs);
  if (start >= candles1m.length) return { status: 'not_filled' };
  const rTarget = round(Math.abs(target - entry) / risk, 4);
  const end = Math.min(candles1m.length, start + maxHoldCandles);
  let armed = false;
  let lastClose = null;

  for (let i = start; i < end; i++) {
    const c = candles1m[i];
    const holdCandles = i - start + 1;
    lastClose = c.close;
    const activeStop = armed ? entry : stop;
    const stopHit = long ? c.low <= activeStop : c.high >= activeStop;
    const targetHit = long ? c.high >= target : c.low <= target;
    if (stopHit) {
      if (!armed) return { status: 'loss', r: -1, holdCandles };
      return { status: 'partial_be', r: 0.5, holdCandles };
    }
    if (targetHit) {
      const r = round(0.5 * 1 + 0.5 * rTarget, 4);
      return { status: 'partial_win', r, holdCandles, timeToTP1Candles: holdCandles };
    }
    if (!armed) {
      const favorableR = long ? (c.close - entry) / risk : (entry - c.close) / risk;
      if (favorableR >= 1) armed = true;
    }
  }
  if (armed) {
    const remR = long ? (lastClose - entry) / risk : (entry - lastClose) / risk;
    const r = round(0.5 * 1 + 0.5 * remR, 4);
    return { status: 'partial_timeout', r, holdCandles: end - start };
  }
  return { status: 'open', holdCandles: end - start };
}

/**
 * `time`: identical stop/target walk to `fixed`, but force-closed at market (mark-to-
 * market against the original risk) at `min(maxHoldCandles, timeStopCandles)` candles if
 * neither stop nor target has resolved by then.
 */
export function walkTimeStop({ candles1m, fromMs, direction, entry, stop, target, maxHoldCandles = HOLD_24H_CANDLES, timeStopCandles }) {
  const long = direction !== 'short';
  const risk = Math.abs(entry - stop);
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target) || !(risk > 0)) return { status: 'invalid_levels' };
  const start = firstIndexAtOrAfter(candles1m, fromMs);
  if (start >= candles1m.length) return { status: 'not_filled' };
  const rTarget = round(Math.abs(target - entry) / risk, 4);
  const cutoff = isFiniteNumber(timeStopCandles) && timeStopCandles > 0
    ? Math.max(1, Math.min(maxHoldCandles, Math.round(timeStopCandles)))
    : maxHoldCandles;
  const end = Math.min(candles1m.length, start + cutoff);
  let lastClose = null;

  for (let i = start; i < end; i++) {
    const c = candles1m[i];
    const holdCandles = i - start + 1;
    lastClose = c.close;
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const targetHit = long ? c.high >= target : c.low <= target;
    if (stopHit) return { status: 'loss', r: -1, holdCandles };
    if (targetHit) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };
  }
  const r = round(long ? (lastClose - entry) / risk : (entry - lastClose) / risk, 4);
  return { status: 'time_stop', r, holdCandles: end - start };
}

// ---------------------------------------------------------------------------
// per-variant scoring across the shared L0 signal population
// ---------------------------------------------------------------------------

function scoreOne(signal, historyByTf, variantId, timeStopCandles) {
  const candles1m = historyByTf[signal.symbol] && historyByTf[signal.symbol]['1m'];
  const fromMs = Date.parse(signal.firstReadyAt);
  const common = { candles1m, fromMs, direction: signal.direction, entry: signal.entry, stop: signal.stop };
  let outcome;
  if (variantId === 'fixed') outcome = walkFixed({ ...common, target: signal.tp1 });
  else if (variantId === 'be1r') outcome = walkBE1R({ ...common, target: signal.tp1 });
  else if (variantId === 'trail1r') outcome = walkTrail1R({ ...common, target: signal.tp1 });
  else if (variantId === 'partial50') outcome = walkPartial50({ ...common, target: signal.tp1 });
  else if (variantId === 'time') outcome = walkTimeStop({ ...common, target: signal.tp1, timeStopCandles });
  else if (variantId === 'tp2') outcome = walkTP2({ ...common, tp1: signal.tp1, tp2: signal.tp2 });
  else throw new Error(`unknown exit variant ${variantId}`);

  const grossR = isFiniteNumber(outcome.r) ? outcome.r : null;
  const net = grossR === null ? null : round(costNetR(signal.entry, signal.stop, grossR, signal.direction), 4);
  return {
    symbol: signal.symbol,
    candidateId: signal.candidateId,
    timeframe: signal.timeframe,
    direction: signal.direction,
    firstReadyAt: signal.firstReadyAt,
    entry: signal.entry,
    stop: signal.stop,
    tp1: signal.tp1,
    tp2: signal.tp2,
    stopDistancePct: signal.stopDistancePct,
    variant: variantId,
    outcomeStatus: outcome.status,
    grossR,
    netR: net,
    holdCandles: isFiniteNumber(outcome.holdCandles) ? outcome.holdCandles : null,
    timeToTP1Candles: isFiniteNumber(outcome.timeToTP1Candles) ? outcome.timeToTP1Candles : null
  };
}

/** `time`'s own cutoff: 2x the median timeToTP1Candles among `fixed`'s winners on this population. */
export function timeStopCutoffFromFixed(fixedRows) {
  const winners = fixedRows.filter((r) => r.outcomeStatus === 'win' && isFiniteNumber(r.timeToTP1Candles));
  const med = median(winners.map((r) => r.timeToTP1Candles));
  return isFiniteNumber(med) ? Math.round(2 * med) : null;
}

/** Score every L0 signal under every variant. Returns { rowsByVariant, timeStopCandles }. */
export function scoreAllVariants(signals, historyByTf) {
  const fixedRows = signals.map((s) => scoreOne(s, historyByTf, 'fixed', null));
  const timeStopCandles = timeStopCutoffFromFixed(fixedRows);
  const rowsByVariant = { fixed: fixedRows };
  for (const variantId of VARIANT_IDS) {
    if (variantId === 'fixed') continue;
    rowsByVariant[variantId] = signals.map((s) => scoreOne(s, historyByTf, variantId, timeStopCandles));
  }
  return { rowsByVariant, timeStopCandles };
}

// ---------------------------------------------------------------------------
// stats - n / win% / gross R / net R / max streak / median hold, OOS halves + pass
// (same 2/3-1st, 1/3-2nd calendar split and n>=20-both-halves-positive pass rule as
// scripts/replay-rules.js's own splitHalves/passesOOSRule - reimplemented here rather
// than imported since that module's statsFor hardcodes outcome==='win'/'loss', which
// does not cover this file's fractional partial/breakeven/trail/time-stop outcomes)
// ---------------------------------------------------------------------------

function maxLosingStreak(rows) {
  let max = 0;
  let cur = 0;
  for (const r of rows.slice().sort((a, b) => Date.parse(a.firstReadyAt) - Date.parse(b.firstReadyAt))) {
    if (r.grossR !== null && r.grossR < 0) { cur++; if (cur > max) max = cur; }
    else if (r.grossR !== null) cur = 0;
  }
  return max;
}

export function statsFor(rows) {
  const n = rows.length;
  const resolved = rows.filter((r) => r.grossR !== null);
  const wins = resolved.filter((r) => r.grossR > 0);
  const grossSum = rows.reduce((s, r) => s + (r.grossR ?? 0), 0);
  const netSum = rows.reduce((s, r) => s + (r.netR ?? 0), 0);
  const holds = resolved.map((r) => r.holdCandles).filter(isFiniteNumber);
  const medHold = median(holds);
  return {
    n,
    resolvedN: resolved.length,
    unresolvedN: n - resolved.length,
    winRate: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    grossExpectancyR: n ? round(grossSum / n, 4) : null,
    netExpectancyR: n ? round(netSum / n, 4) : null,
    // Median net R, alongside the mean: the 2026-09-26 frequency study
    // (docs/FREQUENCY_STUDY_2026-09-26.md, "Data-quality flag") found this fixture's mean
    // net R is dominated by a handful of near-zero-stopDistance outliers (a penny-level
    // invalidation gap rounding to stopDistancePct 0.000 explodes costR, since cost is a
    // % of entry divided by risk) - the median is far more robust to that same artifact.
    medianNetR: median(resolved.map((r) => r.netR).filter(isFiniteNumber)),
    maxLosingStreak: maxLosingStreak(rows),
    medianHoldHours: medHold !== null ? round(medHold / 60, 2) : null
  };
}

/** First 2/3 of the replayed span vs the last 1/3 - same convention as scripts/replay-rules.js's splitHalves. */
export function splitHalves(rows, spanFromMs, spanToMs) {
  const boundary = spanFromMs + Math.round((spanToMs - spanFromMs) * (2 / 3));
  const first = rows.filter((r) => Date.parse(r.firstReadyAt) < boundary);
  const second = rows.filter((r) => Date.parse(r.firstReadyAt) >= boundary);
  return { boundaryIso: new Date(boundary).toISOString(), first: statsFor(first), second: statsFor(second) };
}

/** Same rule as scripts/replay-rules.js's passesOOSRule: n >= 20 and net > 0 in both halves. */
export function passesOOSRule(rows, halves) {
  return rows.length >= 20
    && isFiniteNumber(halves.first.netExpectancyR) && halves.first.netExpectancyR > 0
    && isFiniteNumber(halves.second.netExpectancyR) && halves.second.netExpectancyR > 0;
}

function readSpan(historyDir, symbols) {
  const manifestFile = path.join(historyDir, 'manifest.json');
  if (!existsSync(manifestFile)) return null;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  let fromMs = null;
  let toMs = null;
  for (const symbol of symbols) {
    const entry = manifest.files && manifest.files[`${symbol}_1m.json`];
    if (!entry) continue;
    const f = Date.parse(entry.from);
    const t = Date.parse(entry.closedThrough);
    if (fromMs === null || f < fromMs) fromMs = f;
    if (toMs === null || t > toMs) toMs = t;
  }
  return fromMs !== null && toMs !== null ? { fromMs, toMs } : null;
}

function byKeyGroups(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, rs]) => ({ key, ...statsFor(rs) }));
}

// ---------------------------------------------------------------------------
// data-quality outlier exclusion (2026-09-26 frequency study precedent,
// docs/FREQUENCY_STUDY_2026-09-26.md "Data-quality flag: mean net expectancy is
// outlier-dominated"): a small share of deep60 signals (mostly BTC near $85-90k) carry a
// `stopDistancePct` that rounds to (near) zero - a penny-level invalidation gap on a
// five-figure price. `netR`'s cost term is `roundTripPct * entry / risk`: as risk ->
// 0 that ratio explodes, so a single such row can move a population-wide mean net R by
// double digits while every other row is +/- a few R. Reported here on the SAME
// threshold the frequency study used so the two reads are directly comparable.
// ---------------------------------------------------------------------------

export const OUTLIER_STOP_DISTANCE_PCT = 0.02;

export function excludeStopOutliers(rows) {
  return rows.filter((r) => !(isFiniteNumber(r.stopDistancePct) && r.stopDistancePct < OUTLIER_STOP_DISTANCE_PCT));
}

function buildVariantTables(rowsByVariant, span) {
  return VARIANT_IDS.map((variantId) => {
    const rows = rowsByVariant[variantId];
    const overall = statsFor(rows);
    const halves = span ? splitHalves(rows, span.fromMs, span.toMs) : { first: statsFor([]), second: statsFor([]) };
    const pass = span ? passesOOSRule(rows, halves) : false;
    const bySymbol = byKeyGroups(rows, (r) => r.symbol);
    return { variantId, rows, overall, halves, pass, bySymbol };
  });
}

// ---------------------------------------------------------------------------
// report / markdown
// ---------------------------------------------------------------------------

/** Cheap re-aggregation from already-scored rows (no pipeline replay) - shared by a fresh run and `--from-json`. */
export function buildReportFromRowsByVariant({ historyDir, symbols, rowsByVariant, timeStopCandles }) {
  const span = readSpan(historyDir, symbols);
  const signalCount = (rowsByVariant.fixed || []).length;
  const outlierCandidateIds = new Set(
    (rowsByVariant.fixed || [])
      .filter((r) => isFiniteNumber(r.stopDistancePct) && r.stopDistancePct < OUTLIER_STOP_DISTANCE_PCT)
      .map((r) => r.candidateId)
  );
  const cleanRowsByVariant = {};
  for (const variantId of VARIANT_IDS) {
    cleanRowsByVariant[variantId] = (rowsByVariant[variantId] || []).filter((r) => !outlierCandidateIds.has(r.candidateId));
  }

  return {
    historyDir, symbols, signalCount, timeStopCandles, span,
    outlierThresholdPct: OUTLIER_STOP_DISTANCE_PCT,
    outlierCount: outlierCandidateIds.size,
    variantsFull: buildVariantTables(rowsByVariant, span),
    variantsClean: buildVariantTables(cleanRowsByVariant, span)
  };
}

export async function buildExitsReport({ historyDir, symbols, step = 1 }) {
  const { historyByTf, signals } = await collectL0Signals(historyDir, symbols, step);
  const { rowsByVariant, timeStopCandles } = scoreAllVariants(signals, historyByTf);
  return buildReportFromRowsByVariant({ historyDir, symbols, rowsByVariant, timeStopCandles });
}

function fmtR(v) { return v === null || v === undefined ? '-' : v.toFixed(3); }
function fmtPct(v) { return v === null || v === undefined ? '-' : `${v}%`; }

function mainTable(variants) {
  const header = '| variant | n | win % | gross R | net R | median net R | max losing streak | median hold (h) | OOS 1st half net R | OOS 2nd half net R | pass |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const rows = variants.map((v) => {
    const o = v.overall;
    return `| ${v.variantId} | ${o.n} | ${fmtPct(o.winRate)} | ${fmtR(o.grossExpectancyR)} | ${fmtR(o.netExpectancyR)} | ${fmtR(o.medianNetR)} | ${o.maxLosingStreak} | ${o.medianHoldHours ?? '-'} | ${fmtR(v.halves.first.netExpectancyR)} | ${fmtR(v.halves.second.netExpectancyR)} | ${v.pass ? 'pass' : 'fail'} |`;
  });
  return [header, sep, ...rows].join('\n');
}

function appendixTable(variant) {
  const header = '| symbol | n | win % | gross R | net R | median net R |';
  const sep = '| --- | --- | --- | --- | --- | --- |';
  const rows = variant.bySymbol.map((s) => `| ${s.key} | ${s.n} | ${fmtPct(s.winRate)} | ${fmtR(s.grossExpectancyR)} | ${fmtR(s.netExpectancyR)} | ${fmtR(s.medianNetR)} |`);
  return [header, sep, ...rows].join('\n');
}

export function buildMarkdown(report, { generatedAt = new Date().toISOString() } = {}) {
  const parts = [];
  parts.push('# S1 agent C - exits study');
  parts.push('');
  parts.push(`Generated ${generatedAt} by \`scripts/research/exits.js\`, fixture \`${path.relative(REPO_ROOT, report.historyDir)}\`, symbols ${report.symbols.join('/')}.`);
  parts.push('');
  parts.push(`Population: ${report.signalCount} L0 signals (the live config verbatim - production's own \`flagTradePlan\`, first \`ready\` close per \`candidateId\`, same population \`scripts/replay-rules.js --variant L0\` scores at \`--step 1\`). Every variant re-walks the SAME signals' own 1m path under a different exit rule; \`n\` is identical across variants by construction - only management changes. Net R is direction-dependent (0.34% long / 0.14% short round-trip, \`scripts/tracker/costs.js\`), charged against each signal's ORIGINAL entry/stop risk regardless of how a variant's stop moved. Unresolved-at-24h trades score grossR=null (excluded from win %, contribute 0 to the expectancy sum) for fixed/be1r/trail1r/tp2; partial50 marks-to-market an already-armed remainder at the hold limit, and time force-closes at market by its own cutoff - see the file header of scripts/research/exits.js for the full per-variant convention.`);
  if (isFiniteNumber(report.timeStopCandles)) {
    parts.push('');
    parts.push(`\`time\` variant cutoff: ${report.timeStopCandles} candles (${round(report.timeStopCandles / 60, 2)}h) = 2x the median timeToTP1 among \`fixed\`'s own winners on this population.`);
  }
  parts.push('');
  parts.push('## Data-quality flag: near-zero stop distance outliers');
  parts.push('');
  parts.push(`${report.outlierCount} of ${report.signalCount} signals (${round((report.outlierCount / report.signalCount) * 100, 1)}%) carry a \`stopDistancePct\` under ${report.outlierThresholdPct}% - a penny-level invalidation gap on a five-figure price (mostly BTC) that rounds to a near-zero risk denominator. Net R's cost term (\`roundTripPct * entry / risk\`) explodes as risk -> 0, so these ~${round((report.outlierCount / report.signalCount) * 100, 0)}% of signals can move the population MEAN net R by double digits while every other row sits at +/- a few R - the exact artifact \`docs/FREQUENCY_STUDY_2026-09-26.md\` ("Data-quality flag: mean net expectancy is outlier-dominated") already found and flagged for the owner on this same fixture. **The tables below report both reads**: "full population" (every L0 signal, mean net R outlier-dominated) and "outlier-excluded" (\`stopDistancePct >= ${report.outlierThresholdPct}%\`, the honest read of whether management changes the sign) - the median net R column is included in both as a robustness cross-check regardless of which table is read. Same \`candidateId\` set is excluded across all six variants (the outlier flag is a property of the original signal, not of a variant's own management).`);
  parts.push('');
  parts.push('## Variants - outlier-excluded (headline)');
  parts.push('');
  parts.push(mainTable(report.variantsClean));
  parts.push('');
  parts.push('## Variants - full population (reference, mean net R outlier-dominated)');
  parts.push('');
  parts.push(mainTable(report.variantsFull));
  parts.push('');
  parts.push('Columns: n (signals scored, identical across variants within a table) · win % (share of resolved trades with grossR > 0) · gross R / net R (per-trade expectancy, unresolved counted as 0) · median net R (resolved trades only, robust to the outlier artifact above) · max losing streak (consecutive grossR < 0, chronological) · median hold hours (resolved trades) · OOS halves (first 2/3 vs last 1/3 of the fixture span, net R) · pass (net R > 0 in both halves AND n >= 20 - same rule as scripts/replay-rules.js\'s phase-0 OOS gate).');
  parts.push('');
  parts.push('## Per-symbol appendix (outlier-excluded)');
  parts.push('');
  for (const v of report.variantsClean) {
    parts.push(`### ${v.variantId}`);
    parts.push('');
    parts.push(appendixTable(v));
    parts.push('');
  }
  return parts.join('\n');
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
  return {
    history: typeof opts.history === 'string' ? opts.history : 'test/fixtures/history/deep60-2026-09-24',
    symbols: typeof opts.symbols === 'string' ? opts.symbols.split(',').map((s) => s.trim()).filter(Boolean) : SYMBOLS,
    outDir: typeof opts['out-dir'] === 'string' ? opts['out-dir'] : 'var/research/exits',
    outMd: typeof opts['out-md'] === 'string' ? opts['out-md'] : 'docs/EXITS_STUDY_2026-09-26.md',
    step: opts.step ? Number(opts.step) : 1,
    // Re-aggregate from a previous run's per-variant JSON (same shape `--out-dir` writes)
    // instead of re-running the production pipeline - a full run replays every 1m close
    // of the fixture through buildScalpContext (~35-40 min over deep60's 85.5 days x 3
    // symbols), so a stats-only change (e.g. this file's own outlier-exclusion table)
    // should not have to pay that twice.
    fromJson: typeof opts['from-json'] === 'string' ? opts['from-json'] : null
  };
}

function printReport(label, variants) {
  for (const v of variants) {
    const o = v.overall;
    console.log(`  [${label}] ${v.variantId}: n=${o.n} winRate=${o.winRate ?? '-'}% grossExp=${fmtR(o.grossExpectancyR)}R netExp=${fmtR(o.netExpectancyR)}R medianNet=${fmtR(o.medianNetR)}R maxStreak=${o.maxLosingStreak} -> ${v.pass ? 'PASSES' : 'fails'} OOS`);
  }
}

/** Loads a previous run's per-variant JSON (`{ variantId, rows, ... }` per file) back into `rowsByVariant`. */
function loadRowsByVariantFromJson(dir) {
  const rowsByVariant = {};
  for (const variantId of VARIANT_IDS) {
    const file = path.join(dir, `${variantId}.json`);
    if (!existsSync(file)) throw new Error(`--from-json: missing ${file}`);
    rowsByVariant[variantId] = JSON.parse(readFileSync(file, 'utf8')).rows;
  }
  return rowsByVariant;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyDir = path.isAbsolute(args.history) ? args.history : path.join(REPO_ROOT, args.history);
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(REPO_ROOT, args.outDir);
  const outMd = path.isAbsolute(args.outMd) ? args.outMd : path.join(REPO_ROOT, args.outMd);

  let report;
  if (args.fromJson) {
    const fromJsonDir = path.isAbsolute(args.fromJson) ? args.fromJson : path.join(REPO_ROOT, args.fromJson);
    const rowsByVariant = loadRowsByVariantFromJson(fromJsonDir);
    const timeStopCandles = timeStopCutoffFromFixed(rowsByVariant.fixed);
    report = buildReportFromRowsByVariant({ historyDir, symbols: args.symbols, rowsByVariant, timeStopCandles });
    console.log(`\n[exits] re-aggregated from ${path.relative(REPO_ROOT, fromJsonDir)} (no pipeline replay)`);
  } else {
    report = await buildExitsReport({ historyDir, symbols: args.symbols, step: args.step });
    mkdirSync(outDir, { recursive: true });
    for (const v of report.variantsFull) {
      writeFileSync(path.join(outDir, `${v.variantId}.json`), JSON.stringify({ variantId: v.variantId, overall: v.overall, halves: v.halves, pass: v.pass, bySymbol: v.bySymbol, rows: v.rows }, null, 2) + '\n');
    }
  }

  console.log(`\n[exits] ${report.signalCount} L0 signals (${report.outlierCount} outlier-excluded), fixture ${report.historyDir}, symbols ${report.symbols.join(',')}`);
  if (isFiniteNumber(report.timeStopCandles)) console.log(`  time-stop cutoff: ${report.timeStopCandles} candles`);
  printReport('outlier-excluded', report.variantsClean);
  printReport('full population', report.variantsFull);

  mkdirSync(path.dirname(outMd), { recursive: true });
  writeFileSync(outMd, `${buildMarkdown(report)}\n`);
  console.log(`\n[exits] wrote ${path.relative(REPO_ROOT, outMd)}${args.fromJson ? '' : ` and per-variant JSON under ${path.relative(REPO_ROOT, outDir)}`}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[exits] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

export default {
  VARIANT_IDS, collectL0Signals, scoreAllVariants, statsFor, splitHalves, passesOOSRule,
  timeStopCutoffFromFixed, buildExitsReport, buildReportFromRowsByVariant, buildMarkdown,
  parseArgs, OUTLIER_STOP_DISTANCE_PCT, excludeStopOutliers,
  walkFixed, walkBE1R, walkTrail1R, walkPartial50, walkTimeStop, walkTP2
};
