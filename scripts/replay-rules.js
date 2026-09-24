#!/usr/bin/env node
/**
 * T6 phase 0 replay (docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md "Phase 0"): scores the
 * shippable net gate (`flagPlan.minNetRR`, `lib/flagTradePlan.js`) and the
 * `flag.timeframes` widening against stored history, through the production pipeline -
 * `scripts/replay.js`'s `buildAt`/`replaySymbol` (no lookahead, same fetch truncation as
 * every other replay script) - under `config/engine.js`'s in-process override hook
 * (`setConfigOverride`). Nothing here re-implements a detector: candidate identification,
 * geometry, and the flag trade plan's own retest-hold (`observeRetestHold`) and fee math
 * (`netRiskReward`) are all imported production code. `V5`/`V6`/`V7` substitute an
 * alternative stop/target/entry construction (never touching detection) the same way
 * `scripts/replay-paths.js`'s `tp1Ahead` already mirrors `lib/flagTradePlan.js`'s private
 * `nearestRoomAhead` for read-only research.
 *
 * One process scores exactly one variant. `ENGINE_CONFIG` is a single shared module
 * binding (config/engine.js) - two variants in the same process would corrupt each
 * other's config mid-run, so parallelizing across variants means running this CLI more
 * than once, in separate processes.
 *
 * Variant table (docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md "Phase 0 > Variants"):
 *   - V0: baseline (config unchanged)
 *   - V1a/b/c: `flagPlan.minNetRR` 1.0 / 1.5 / 2.0, 1m/3m/5m flags unchanged
 *   - V2: `flag.timeframes` + 15m/1h (gates unchanged) - already-detected candidates
 *     (`model.flagTimeframes` already includes 15m/1h/4h) simply become eligible for
 *     `flagTradePlan`/qualification; no new detection code runs.
 *   - V3a/b: V2 + net gate 1.5/2.0
 *   - V4 (research only): V3a with gross `minRR` 2.5 - only run if V3 leaves too few calls
 *   - V5 (research): the SAME 1m-5m breakout-retest-hold trigger and entry, but stop/target
 *     read from 15m/1h geometry zones instead of the flag's own invalidation/measured
 *     move - `buildStructurePlan` below, gross >= 3 + net gate 1.5, `horizon: 'swing'`.
 *   - V6: V1b + an ATR floor on the stop (`buildAtrFloorPlan`): stop >= 0.5x ATR(15m),
 *     target fixed at 3x that stop (gross RR exactly 3 by construction).
 *   - V7 (scout research): a FAILED_FLAG_REVERSAL trial from every candidate that failed
 *     via `invalidation_close` (broke out, confirmed, then closed back through its own
 *     invalidation - the closest read of section 1b's "failed reclaim of the broken
 *     level" available from a confirmed candidate's own lifecycle). Entry is the failure
 *     candle's own close (prefilled, same convention as every other trial here); stop
 *     beyond the reclaim extreme of the last `flag.reclaimCandles + 1` candles; target the
 *     next opposing 15m/1h/4h zone ahead (`tp1Ahead`, same helper V5 uses), falling back
 *     to the source flag's own pole height projected from the new entry when no zone is
 *     ahead of the fallback distance.
 *
 * T6 completion plan B1 (docs/PLAN_T6_COMPLETION_V2.md, `buildFrequencyMetrics`):
 * frequency/visibility columns for config-gate variants - ready-plan and gross>=3
 * awaiting_retest conditional-plan closes per hour (raw, not deduped by candidateId -
 * "how often would the owner's chat literally see this status"), plus GOOD/hour, beside
 * the existing deduped GOOD-call scoring. New variants V-B (gross minRR 2.5, owner rule
 * change) and V-D (retest tolerance 0.2 ATR); V-A and V-C reuse V0 and V2 (identical
 * config, no need to duplicate).
 *
 * Scoring (every variant, one convention): a plan/trial's first "ready" close per
 * `(symbol, candidateId)` is walked with `scripts/tracker/walk-outcome.js`'s own
 * `walkOutcome`, `prefilled: true` - the same `ready_prefilled` convention
 * `scripts/tracker/score.js` uses for a real captured GOOD call (the plan's
 * breakout-retest-hold sequence already happened on a closed candle, so scoring starts
 * filled, not searching for a touch), for 24h (`HOLD_24H_CANDLES`, 1m candles). Gross R
 * is the walk's own R (win) or -1 (loss); net R is `scripts/tracker/costs.js`'s `netR` on
 * that outcome (0.20% round-trip cost) - this is the REALISED net R on the trade's own
 * stop distance, not the plan's forward-looking `netRR` field (a different ratio; both
 * are published on each scored row for comparison). A 0.14%-cost sensitivity column
 * (`netR_sens014`) is computed the same way, information only.
 *
 * Usage:
 *   node scripts/replay-rules.js --variant V0 --history test/fixtures/history/deep-2026-09-24
 *     [--symbols BTC,SOL,ETH] [--step 1] [--out var/replay-rules/V0.calls.jsonl]
 *     [--summary var/replay-rules/V0.summary.json]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONFIG, setConfigOverride } from '../config/engine.js';
import { SYMBOLS, INTERVAL_MS } from '../services/scalpContext.js';
import { loadHistoryDir, replaySymbol, closedRows } from './replay.js';
import { walkOutcome, isFiniteNumber, round, median, FILL_WINDOW_CANDLES } from './tracker/walk-outcome.js';
import { netR } from './tracker/costs.js';
import { observeRetestHold, netRiskReward } from '../lib/flagTradePlan.js';
import { tp1Ahead } from './replay-paths.js';
import { calculateATR } from '../lib/advancedIndicators.js';

/** 24h of 1m candles (master plan phase 0: "Score each GOOD... TP1 vs stop, 24 h"). */
export const HOLD_24H_CANDLES = 1440;
const STRUCTURE_TF = '15m';
/**
 * Cost-sensitivity columns (master plan phase 0, decision D3 - Jupiter Perps fee
 * research recorded 2026-09-24): 0.14% is the collateral-matches-position, sub-1h-hold
 * estimate; 0.34% is the USDC-funded-long estimate (an extra swap in and out). Both
 * information only - the shipped cost stays 0.20% (`risk.feeBps`/`slippageBps`).
 *
 * `netR_sensDir` (T6 completion plan B2, D-cost decision 2026-09-24): the owner funds
 * every position from USDC/USDT, so a long pays the extra swap in and out (0.34%) and a
 * short does not (0.14%) - direction-dependent cost, not a flat sensitivity band. Falls
 * back to the shipped 0.20% for a direction that is neither 'long' nor 'short'.
 */
const SENSITIVITY_ROUND_TRIP_PCT_LOW = 0.0014;
const SENSITIVITY_ROUND_TRIP_PCT_HIGH = 0.0034;
const DIR_COST_PCT_LONG = 0.0034;
const DIR_COST_PCT_SHORT = 0.0014;
const DIR_COST_PCT_FALLBACK = 0.0020;

const WIDE_FLAG_TFS = ['1m', '3m', '5m', '15m', '1h'];

export const VARIANTS = {
  V0: { label: 'baseline (gross-only gate, 1m/3m/5m)', gate: 'config', override: null },
  V1a: { label: 'net gate 1.0', gate: 'config', override: { flagPlan: { minNetRR: 1.0 } } },
  V1b: { label: 'net gate 1.5', gate: 'config', override: { flagPlan: { minNetRR: 1.5 } } },
  V1c: { label: 'net gate 2.0', gate: 'config', override: { flagPlan: { minNetRR: 2.0 } } },
  V2: { label: '+15m/1h flag timeframes, gates unchanged', gate: 'config', override: { flag: { timeframes: WIDE_FLAG_TFS } } },
  V3a: { label: 'V2 + net gate 1.5', gate: 'config', override: { flag: { timeframes: WIDE_FLAG_TFS }, flagPlan: { minNetRR: 1.5 } } },
  V3b: { label: 'V2 + net gate 2.0', gate: 'config', override: { flag: { timeframes: WIDE_FLAG_TFS }, flagPlan: { minNetRR: 2.0 } } },
  V4: { label: 'research only: V3a + gross minRR 2.5 (owner decision needed to ship)', gate: 'config', override: { flag: { timeframes: WIDE_FLAG_TFS }, flagPlan: { minRR: 2.5, minNetRR: 1.5 } } },
  V5: { label: 'research: 1m-5m trigger, stop/target from 15m/1h structure, gross>=3 + net gate 1.5, horizon swing', gate: 'structure', override: { flagPlan: { minNetRR: 1.5 } }, horizon: 'swing' },
  V6: { label: 'V1b + ATR floor: stop >= 0.5x ATR(15m), target fixed 3x stop', gate: 'atrFloor', override: { flagPlan: { minNetRR: 1.5 } } },
  V7: { label: 'research: FAILED_FLAG_REVERSAL scout from invalidation_close failures, net gate 1.5', gate: 'scout', override: { flagPlan: { minNetRR: 1.5 } } },
  // T6 completion plan Step B (docs/PLAN_T6_COMPLETION_V2.md "B1"): frequency-focused
  // variants. V-A is V0 and V-C is V2 by config (both already exist above) - reuse
  // those ids directly rather than duplicating an identical override under a new name.
  'V-B': { label: 'research, owner rule change: gross minRR 2.5 (lowers the shipped 3R floor - needs an explicit owner decision to ship)', gate: 'config', override: { flagPlan: { minRR: 2.5 } } },
  'V-D': { label: 'retest tolerance 0.2 ATR (entryToleranceAtr, default 0.1)', gate: 'config', override: { flagPlan: { entryToleranceAtr: 0.2 } } }
};

// ---------------------------------------------------------------------------
// shared scoring: one trial -> one walked, scored row
// ---------------------------------------------------------------------------

function costRAtPct(entry, stop, roundTripPct) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || entry <= 0) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return (roundTripPct * entry) / risk;
}

/** One trial's outcome: production fill rules (prefilled ready), gross/net R, 24h hold. */
export function walkPlan({ candles1m, closedThroughIso, direction, entry, stop, target }) {
  const fromMs = Date.parse(closedThroughIso);
  const walked = walkOutcome({
    candles1m, fromMs, direction, entryMin: entry, entryMax: entry, stop, target,
    fillWindowCandles: FILL_WINDOW_CANDLES, maxHoldCandles: HOLD_24H_CANDLES, prefilled: true
  });
  const grossR = walked.status === 'win' ? walked.r : walked.status === 'loss' ? -1 : null;
  return {
    outcome: walked.status,
    grossR,
    netR: grossR === null ? null : round(netR(entry, stop, grossR), 4),
    netR_sens014: grossR === null ? null : round(grossR - costRAtPct(entry, stop, SENSITIVITY_ROUND_TRIP_PCT_LOW), 4),
    netR_sens034: grossR === null ? null : round(grossR - costRAtPct(entry, stop, SENSITIVITY_ROUND_TRIP_PCT_HIGH), 4),
    netR_sensDir: grossR === null ? null : round(grossR - costRAtPct(entry, stop, direction === 'long' ? DIR_COST_PCT_LONG : direction === 'short' ? DIR_COST_PCT_SHORT : DIR_COST_PCT_FALLBACK), 4),
    holdCandles: isFiniteNumber(walked.holdCandles) ? walked.holdCandles : null,
    timeToTP1Candles: isFiniteNumber(walked.timeToTP1Candles) ? walked.timeToTP1Candles : null
  };
}

// ---------------------------------------------------------------------------
// gate: config - score the production-selected flagTradePlan as-is
// ---------------------------------------------------------------------------

/**
 * T6 completion plan B1 (docs/PLAN_T6_COMPLETION_V2.md): raw per-close visibility
 * counts, not deduped by candidateId - "how often would a GPT chat literally see this
 * status if it checked at a random moment", complementary to the deduped
 * first-ready GOOD-call count `sink` already tracks. `readyCloses` mirrors GOOD
 * exactly (every close a plan reads `ready`, including a plan that stays ready across
 * many consecutive closes); `conditionalAwaitingRetestCloses` is the near-miss signal
 * the owner asked to see - a plan that already cleared the gross floor and is only
 * waiting on the retest-hold candle.
 */
function makeConfigCollector({ symbol, candles1m, sink, freq = null }) {
  const seen = new Set();
  return {
    onPayload: null,
    onLine(line) {
      const plan = line.flagTradePlan;
      if (freq && plan) {
        if (plan.status === 'ready') freq.readyCloses++;
        else if (plan.status === 'conditional' && plan.reasonCode === 'awaiting_retest' && isFiniteNumber(plan.grossRR) && plan.grossRR >= 3) freq.conditionalCloses++;
      }
      if (!plan || plan.status !== 'ready' || !plan.candidateId || seen.has(plan.candidateId)) return;
      seen.add(plan.candidateId);
      const walked = walkPlan({ candles1m, closedThroughIso: line.closedThrough, direction: plan.direction, entry: plan.entry, stop: plan.stop, target: plan.tp1 });
      sink.push({
        symbol, candidateId: plan.candidateId, timeframe: plan.timeframe, direction: plan.direction,
        firstReadyAt: line.closedThrough, entry: plan.entry, stop: plan.stop, tp1: plan.tp1,
        stopDistancePct: plan.stopDistancePct, plannedGrossRR: plan.grossRR, plannedNetRR: plan.netRR,
        ...walked
      });
    }
  };
}

// ---------------------------------------------------------------------------
// gate: structure / atrFloor - same 1m-5m trigger, an alternative stop/target
// ---------------------------------------------------------------------------

/** Nearest 15m (or given timeframes') zone edge behind `entry` (the stop side), + buffer beyond it. Null if none. */
export function nearestStructureStop(direction, entry, geometryContext, timeframes, bufferPct) {
  const sign = direction === 'short' ? -1 : 1;
  const orientedEntry = sign * entry;
  let nearestOriented = null;
  for (const tf of timeframes) {
    const g = geometryContext && geometryContext[tf];
    if (!g) continue;
    const zones = direction === 'long' ? g.horizontalSupportZones : g.horizontalResistanceZones;
    for (const z of zones || []) {
      const far = direction === 'long' ? z.low : z.high;
      if (!isFiniteNumber(far)) continue;
      const orientedFar = sign * far;
      if (orientedFar < orientedEntry && (nearestOriented === null || orientedFar > nearestOriented)) nearestOriented = orientedFar;
    }
  }
  if (nearestOriented === null) return null;
  const raw = sign * nearestOriented;
  return raw * (1 - sign * bufferPct);
}

function ownTimeframeAtr(historyByTf, tf, cutMs, period) {
  const candles = closedRows(historyByTf[tf], tf, cutMs, period + 50);
  if (candles.length < period + 1) return null;
  const r = calculateATR(candles, period);
  return r && isFiniteNumber(r.atr) ? r.atr : null;
}

/** V5: stop beyond nearest 15m structure (+ structureBuffer), target next 15m/1h/4h level or the flag's own measured move. */
export function buildStructurePlan(candidate, geometryContext, cfg) {
  if (candidate.chaseRisk === true) return null;
  const direction = candidate.direction;
  const sign = direction === 'short' ? -1 : 1;
  const entry = candidate.breakoutLevel;
  if (!isFiniteNumber(entry)) return null;
  let stop = nearestStructureStop(direction, entry, geometryContext, [STRUCTURE_TF], cfg.stops.structureBuffer);
  if (stop === null) stop = candidate.invalidation;
  if (!isFiniteNumber(stop) || sign * (entry - stop) <= 0) return null;
  const target = tp1Ahead(direction, entry, candidate.measuredTarget, geometryContext);
  if (!isFiniteNumber(target) || sign * (target - entry) <= 0) return null;
  return finalizePlan(entry, stop, target, cfg);
}

/** V6: V1b's net gate + a stop floored at 0.5x ATR(15m); target fixed at 3x that stop. */
export function buildAtrFloorPlan(candidate, geometryContext, cfg) {
  if (candidate.chaseRisk === true) return null;
  const direction = candidate.direction;
  const sign = direction === 'short' ? -1 : 1;
  const entry = candidate.breakoutLevel;
  const baseStop = candidate.invalidation;
  if (!isFiniteNumber(entry) || !isFiniteNumber(baseStop)) return null;
  const atr15m = geometryContext && geometryContext[STRUCTURE_TF] ? geometryContext[STRUCTURE_TF].atr : null;
  if (!isFiniteNumber(atr15m)) return null;
  const stopDist = Math.max(Math.abs(entry - baseStop), 0.5 * atr15m);
  const stop = entry - sign * stopDist;
  const target = entry + sign * stopDist * 3;
  return finalizePlan(entry, stop, target, cfg);
}

/** Gross/net gates + the 3% stop cap, shared by every alternate-construction variant. */
function finalizePlan(entry, stop, target, cfg) {
  const grossRR = round(Math.abs(target - entry) / Math.abs(entry - stop), 3);
  if (grossRR === null || grossRR < cfg.flagPlan.minRR) return null;
  const netRR = round(netRiskReward(entry, stop, target, cfg.risk), 3);
  if (isFiniteNumber(cfg.flagPlan.minNetRR) && (netRR === null || netRR < cfg.flagPlan.minNetRR)) return null;
  const stopDistancePct = round((Math.abs(entry - stop) / entry) * 100, 3);
  if (stopDistancePct === null || stopDistancePct > cfg.scalp.maxStopDistancePct) return null;
  return { entry: round(entry, 2), stop: round(stop, 2), tp1: round(target, 2), grossRR, netRR, stopDistancePct };
}

function makeStructureCollector({ symbol, candles1m, historyByTf, cfg, mode, sink }) {
  const seen = new Set();
  let latestPayload = null;
  return {
    onPayload(payload) { latestPayload = payload; },
    onLine(line) {
      const s = latestPayload && latestPayload.symbols && latestPayload.symbols[symbol];
      if (!s) return;
      const geometryContext = s.geometryContext || {};
      const pool = (s.candidateSetups || []).filter((c) => c && c.type === 'flag' && c.state === 'confirmed'
        && ['1m', '3m', '5m'].includes(c.timeframe) && c.candidateId && !seen.has(c.candidateId));
      for (const candidate of pool) {
        const built = mode === 'atrFloor' ? buildAtrFloorPlan(candidate, geometryContext, cfg) : buildStructurePlan(candidate, geometryContext, cfg);
        if (!built) continue;
        const tf = candidate.timeframe;
        const cutMs = Date.parse(line.closedThrough);
        const atrValue = ownTimeframeAtr(historyByTf, tf, cutMs, cfg.flag.atrPeriod);
        const firstDetectedMs = typeof candidate.firstDetectedAt === 'string' ? Date.parse(candidate.firstDetectedAt) : NaN;
        const fromMs = isFiniteNumber(firstDetectedMs) ? firstDetectedMs - INTERVAL_MS[tf] : null;
        const candles = closedRows(historyByTf[tf], tf, cutMs, 500);
        const currentPrice = candles.length ? candles[candles.length - 1].close : null;
        const { status } = observeRetestHold({ direction: candidate.direction, entry: built.entry, stop: built.stop, candles, fromMs, currentPrice, atrValue, toleranceAtr: cfg.flagPlan.entryToleranceAtr });
        if (status !== 'ready') continue;
        seen.add(candidate.candidateId);
        const walked = walkPlan({ candles1m, closedThroughIso: line.closedThrough, direction: candidate.direction, entry: built.entry, stop: built.stop, target: built.tp1 });
        sink.push({
          symbol, candidateId: candidate.candidateId, timeframe: tf, direction: candidate.direction,
          firstReadyAt: line.closedThrough, entry: built.entry, stop: built.stop, tp1: built.tp1,
          stopDistancePct: built.stopDistancePct, plannedGrossRR: built.grossRR, plannedNetRR: built.netRR,
          ...walked
        });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// gate: scout (V7) - a reversal trial from an invalidation_close failure
// ---------------------------------------------------------------------------

function makeScoutCollector({ symbol, candles1m, historyByTf, cfg, sink }) {
  const seen = new Set();
  let latestPayload = null;
  return {
    onPayload(payload) { latestPayload = payload; },
    onLine(line) {
      const s = latestPayload && latestPayload.symbols && latestPayload.symbols[symbol];
      const geometryContext = (s && s.geometryContext) || {};
      for (const c of line.candidateLifecycle) {
        if (c.state !== 'failed' || c.failReason !== 'invalidation_close') continue;
        const trackId = `${c.ref}|${c.startedAt}`;
        if (seen.has(trackId)) continue;
        seen.add(trackId);
        const [tf, origDirection] = c.ref.split(':');
        if (origDirection !== 'long' && origDirection !== 'short') continue;
        const newDirection = origDirection === 'long' ? 'short' : 'long';
        const sign = newDirection === 'short' ? -1 : 1;
        const cutMs = Date.parse(line.closedThrough);
        const candles = closedRows(historyByTf[tf], tf, cutMs, cfg.flag.reclaimCandles + 5);
        if (!candles.length) continue;
        const entry = candles[candles.length - 1].close;
        const lookback = candles.slice(-(cfg.flag.reclaimCandles + 1));
        const extreme = newDirection === 'short' ? Math.max(...lookback.map((x) => x.high)) : Math.min(...lookback.map((x) => x.low));
        const stop = extreme * (1 - sign * cfg.stops.structureBuffer);
        if (!isFiniteNumber(c.breakoutLevel) || !isFiniteNumber(c.invalidation)) continue;
        const poleHeight = Math.abs(c.breakoutLevel - c.invalidation);
        const fallbackTarget = entry + sign * poleHeight;
        const target = tp1Ahead(newDirection, entry, fallbackTarget, geometryContext);
        const built = finalizePlan(entry, stop, target, cfg);
        if (!built) continue;
        const walked = walkPlan({ candles1m, closedThroughIso: line.closedThrough, direction: newDirection, entry: built.entry, stop: built.stop, target: built.tp1 });
        sink.push({
          symbol, candidateId: `scout:${symbol}:${trackId}`, timeframe: tf, direction: newDirection,
          firstReadyAt: line.closedThrough, entry: built.entry, stop: built.stop, tp1: built.tp1,
          stopDistancePct: built.stopDistancePct, plannedGrossRR: built.grossRR, plannedNetRR: built.netRR,
          sourceRef: c.ref, ...walked
        });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

function maxLosingStreak(calls) {
  let max = 0;
  let cur = 0;
  for (const c of calls.slice().sort((a, b) => Date.parse(a.firstReadyAt) - Date.parse(b.firstReadyAt))) {
    if (c.outcome === 'loss') { cur++; if (cur > max) max = cur; }
    else if (c.outcome === 'win') cur = 0;
  }
  return max;
}

export function statsFor(calls) {
  const n = calls.length;
  const resolved = calls.filter((c) => c.outcome === 'win' || c.outcome === 'loss');
  const wins = resolved.filter((c) => c.outcome === 'win');
  const grossSum = calls.reduce((s, c) => s + (c.grossR ?? 0), 0);
  const netSum = calls.reduce((s, c) => s + (c.netR ?? 0), 0);
  const sens014Sum = calls.reduce((s, c) => s + (c.netR_sens014 ?? 0), 0);
  const sens034Sum = calls.reduce((s, c) => s + (c.netR_sens034 ?? 0), 0);
  const sensDirSum = calls.reduce((s, c) => s + (c.netR_sensDir ?? 0), 0);
  return {
    n,
    resolvedN: resolved.length,
    unresolvedN: n - resolved.length,
    winRate: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    grossExpectancyR: n ? round(grossSum / n, 4) : null,
    netExpectancyR: n ? round(netSum / n, 4) : null,
    netExpectancyR_sens014pct: n ? round(sens014Sum / n, 4) : null,
    netExpectancyR_sens034pct: n ? round(sens034Sum / n, 4) : null,
    netExpectancyR_sensDirPct: n ? round(sensDirSum / n, 4) : null,
    maxLosingStreak: maxLosingStreak(calls),
    medianStopPct: median(calls.map((c) => c.stopDistancePct).filter(isFiniteNumber)),
    medianMinutesToTP1: median(wins.map((c) => c.timeToTP1Candles).filter(isFiniteNumber)),
    medianHoldMinutes: median(resolved.map((c) => c.holdCandles).filter(isFiniteNumber))
  };
}

function byKeyGroups(calls, keyFn) {
  const groups = new Map();
  for (const c of calls) {
    const key = keyFn(c);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()].map(([key, cs]) => ({ key, ...statsFor(cs) })).sort((a, b) => b.n - a.n);
}

/** First 2/3 of the replayed span vs the last 1/3 (master plan: 15d -> 10/5, 60d -> 40/20). */
export function splitHalves(calls, spanFromMs, spanToMs) {
  const boundary = spanFromMs + Math.round((spanToMs - spanFromMs) * (2 / 3));
  const first = calls.filter((c) => Date.parse(c.firstReadyAt) < boundary);
  const second = calls.filter((c) => Date.parse(c.firstReadyAt) >= boundary);
  return { boundaryIso: new Date(boundary).toISOString(), first: statsFor(first), second: statsFor(second) };
}

/** Master plan phase 0: "passes only if net expectancy > 0 in BOTH halves and n >= 20 scored GOOD calls" (read as overall n). */
export function passesOOSRule(calls, halves) {
  return calls.length >= 20
    && isFiniteNumber(halves.first.netExpectancyR) && halves.first.netExpectancyR > 0
    && isFiniteNumber(halves.second.netExpectancyR) && halves.second.netExpectancyR > 0;
}

function coverageStats(calls, spanFromMs, spanToMs) {
  const totalDays = (spanToMs - spanFromMs) / 86400000;
  const daysWithGood = new Set(calls.map((c) => c.firstReadyAt.slice(0, 10))).size;
  return {
    totalDays: round(totalDays, 2),
    goodPerDay: totalDays > 0 ? round(calls.length / totalDays, 3) : null,
    daysWithGoodCount: daysWithGood,
    daysWithGoodSharePct: totalDays > 0 ? round((daysWithGood / Math.round(totalDays)) * 100, 1) : null
  };
}

/**
 * T6 completion plan B1: ready/conditional/GOOD "visibility" rates per hour - how often
 * the owner's chat would literally see each status, not deduped by candidateId (that's
 * `coverageStats`'s `goodPerDay`, a distinct-opportunities count). config-gate variants
 * only (`freqBySymbol` empty for structure/atrFloor/scout - those don't share a
 * flagTradePlan status to sample).
 */
export function buildFrequencyMetrics(freqBySymbol, goodCalls, { spanFromMs, spanToMs }) {
  const totalHours = (spanToMs - spanFromMs) / 3600000;
  const perHour = (n) => (totalHours > 0 ? round(n / totalHours, 4) : null);
  const bySymbol = {};
  let readyTotal = 0;
  let conditionalTotal = 0;
  for (const [symbol, f] of Object.entries(freqBySymbol)) {
    readyTotal += f.readyCloses;
    conditionalTotal += f.conditionalCloses;
    bySymbol[symbol] = {
      readyPlansPerHour: perHour(f.readyCloses),
      conditionalPlansPerHour: perHour(f.conditionalCloses),
      readyCloses: f.readyCloses,
      conditionalCloses: f.conditionalCloses
    };
  }
  const goodByHourKey = new Map();
  for (const c of goodCalls) {
    const h = c.firstReadyAt.slice(0, 13); // YYYY-MM-DDTHH
    goodByHourKey.set(h, (goodByHourKey.get(h) || 0) + 1);
  }
  return {
    totalHours: round(totalHours, 2),
    combined: {
      readyPlansPerHour: perHour(readyTotal),
      conditionalPlansPerHour: perHour(conditionalTotal),
      goodPerHour: perHour(goodCalls.length),
      hoursWithAtLeastOneGood: goodByHourKey.size,
      hoursWithAtLeastOneGoodSharePct: totalHours > 0 ? round((goodByHourKey.size / Math.round(totalHours)) * 100, 2) : null
    },
    bySymbol
  };
}

export function buildVariantMetrics(goodCalls, { spanFromMs, spanToMs }) {
  const halves = splitHalves(goodCalls, spanFromMs, spanToMs);
  return {
    overall: statsFor(goodCalls),
    coverage: coverageStats(goodCalls, spanFromMs, spanToMs),
    bySymbol: byKeyGroups(goodCalls, (c) => c.symbol),
    byTimeframe: byKeyGroups(goodCalls, (c) => c.timeframe),
    byDirection: byKeyGroups(goodCalls, (c) => c.direction),
    oos: halves,
    oosPasses: passesOOSRule(goodCalls, halves)
  };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

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

export async function runVariant({ variantId, historyDir, symbols, step = 1, from = null, to = null }) {
  const variant = VARIANTS[variantId];
  if (!variant) throw new Error(`unknown --variant ${variantId}; known: ${Object.keys(VARIANTS).join(', ')}`);

  setConfigOverride(variant.override || null);
  try {
    const history = loadHistoryDir(historyDir, symbols);
    const goodCalls = [];
    let payloadBytesSum = 0;
    let payloadBytesCount = 0;
    let totalMs = 0;
    let totalCloses = 0;
    const firstEligibleBySymbol = {};
    const freqBySymbol = {}; // T6 completion plan B1: raw ready/conditional close counts, config-gate variants only
    const cfg = ENGINE_CONFIG; // read once, post-override (live binding; stable for this whole run)

    for (const symbol of symbols) {
      const candles1m = history[symbol]['1m'];
      const freq = variant.gate === 'config' ? { readyCloses: 0, conditionalCloses: 0 } : null;
      if (freq) freqBySymbol[symbol] = freq;
      const collector = variant.gate === 'config'
        ? makeConfigCollector({ symbol, candles1m, sink: goodCalls, freq })
        : variant.gate === 'scout'
          ? makeScoutCollector({ symbol, candles1m, historyByTf: history[symbol], cfg, sink: goodCalls })
          : makeStructureCollector({ symbol, candles1m, historyByTf: history[symbol], cfg, mode: variant.gate, sink: goodCalls });

      let sampleCounter = 0;
      const onPayload = (payload) => {
        sampleCounter++;
        if (sampleCounter % 30 === 0) { payloadBytesSum += JSON.stringify(payload).length; payloadBytesCount++; }
        if (collector.onPayload) collector.onPayload(payload);
      };

      const t0 = Date.now();
      const r = await replaySymbol({
        symbol, historyByTf: history[symbol], from, to, step,
        onPayload,
        onLine: (line) => collector.onLine(line)
      });
      totalMs += Date.now() - t0;
      totalCloses += r.lines.length;
      firstEligibleBySymbol[symbol] = r.firstEligible;
    }

    const span = readSpan(historyDir, symbols);
    const metrics = span ? buildVariantMetrics(goodCalls, { spanFromMs: span.fromMs, spanToMs: span.toMs }) : null;
    const frequency = span ? buildFrequencyMetrics(freqBySymbol, goodCalls, { spanFromMs: span.fromMs, spanToMs: span.toMs }) : null;

    return {
      variantId, label: variant.label, gate: variant.gate, horizon: variant.horizon || 'scalp',
      override: variant.override, symbols, historyDir, step,
      span: span ? { fromIso: new Date(span.fromMs).toISOString(), toIso: new Date(span.toMs).toISOString() } : null,
      buildMs: { totalMs, totalCloses, msPerClose: totalCloses ? round(totalMs / totalCloses, 3) : null },
      payloadBytesSample: { avg: payloadBytesCount ? Math.round(payloadBytesSum / payloadBytesCount) : null, n: payloadBytesCount },
      firstEligibleBySymbol,
      metrics,
      frequency,
      goodCalls
    };
  } finally {
    setConfigOverride(null);
  }
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
  return {
    variant: typeof opts.variant === 'string' ? opts.variant : null,
    history: typeof opts.history === 'string' ? opts.history : null,
    symbols: list(opts.symbols),
    step: opts.step ? Number(opts.step) : 1,
    from: opts.from ?? null,
    to: opts.to ?? null,
    out: typeof opts.out === 'string' ? opts.out : null,
    summary: typeof opts.summary === 'string' ? opts.summary : null
  };
}

function printReport(result) {
  const m = result.metrics;
  console.log(`\n[replay-rules] ${result.variantId} - ${result.label}`);
  console.log(`  gate=${result.gate} horizon=${result.horizon} step=${result.step} symbols=${result.symbols.join(',')}`);
  console.log(`  build: ${result.buildMs.totalCloses} closes in ${result.buildMs.totalMs} ms (${result.buildMs.msPerClose} ms/close)`);
  if (result.payloadBytesSample.n) console.log(`  payload bytes (sampled n=${result.payloadBytesSample.n}): avg ${result.payloadBytesSample.avg} B`);
  if (!m) { console.log('  no manifest.json span found - metrics skipped'); return; }
  if (result.frequency) {
    const f = result.frequency.combined;
    console.log(`  frequency (B1, ${result.frequency.totalHours}h span): ready=${f.readyPlansPerHour ?? '-'}/hr conditional(gross>=3,awaiting_retest)=${f.conditionalPlansPerHour ?? '-'}/hr GOOD=${f.goodPerHour ?? '-'}/hr, ${f.hoursWithAtLeastOneGoodSharePct ?? '-'}% of hours had >=1 GOOD`);
    for (const [symbol, s] of Object.entries(result.frequency.bySymbol)) {
      console.log(`    ${symbol}: ready=${s.readyPlansPerHour ?? '-'}/hr (n=${s.readyCloses}) conditional=${s.conditionalPlansPerHour ?? '-'}/hr (n=${s.conditionalCloses})`);
    }
  }
  const o = m.overall;
  console.log(`  GOOD calls: n=${o.n} resolved=${o.resolvedN} winRate=${o.winRate === null ? '-' : `${o.winRate}%`} grossExp=${o.grossExpectancyR ?? '-'}R netExp=${o.netExpectancyR ?? '-'}R (0.14% sens ${o.netExpectancyR_sens014pct ?? '-'}R, 0.34% sens ${o.netExpectancyR_sens034pct ?? '-'}R, dir-cost[long 0.34%/short 0.14%] ${o.netExpectancyR_sensDirPct ?? '-'}R) maxLosingStreak=${o.maxLosingStreak} medianStop=${o.medianStopPct ?? '-'}%`);
  console.log(`  coverage: ${m.coverage.goodPerDay ?? '-'}/day, ${m.coverage.daysWithGoodSharePct ?? '-'}% of ${m.coverage.totalDays} days had >=1 GOOD`);
  console.log(`  OOS halves (boundary ${m.oos.boundaryIso}): first n=${m.oos.first.n} netExp=${m.oos.first.netExpectancyR ?? '-'}R | second n=${m.oos.second.n} netExp=${m.oos.second.netExpectancyR ?? '-'}R -> ${m.oosPasses ? 'PASSES' : 'does not pass'} the phase 0 OOS rule`);
  for (const [name, table] of [['symbol', m.bySymbol], ['timeframe', m.byTimeframe], ['direction', m.byDirection]]) {
    console.log(`  -- by ${name} --`);
    for (const t of table) console.log(`    ${t.key}: n=${t.n} winRate=${t.winRate === null ? '-' : `${t.winRate}%`} netExp=${t.netExpectancyR ?? '-'}R`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.variant || !args.history) throw new Error('need --variant <id> --history <dir> (variants: ' + Object.keys(VARIANTS).join(', ') + ')');
  const symbols = args.symbols || SYMBOLS;

  const result = await runVariant({ variantId: args.variant, historyDir: args.history, symbols, step: args.step, from: args.from, to: args.to });
  printReport(result);

  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    writeFileSync(args.out, result.goodCalls.map((c) => JSON.stringify(c)).join('\n') + (result.goodCalls.length ? '\n' : ''));
  }
  if (args.summary) {
    mkdirSync(path.dirname(args.summary), { recursive: true });
    const { goodCalls, ...summary } = result;
    writeFileSync(args.summary, `${JSON.stringify({ ...summary, goodCallCount: goodCalls.length }, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[replay-rules] ${err.stack || err.message}`);
    process.exit(1);
  });
}

export default { VARIANTS, runVariant, parseArgs, statsFor, buildVariantMetrics, buildFrequencyMetrics, splitHalves, passesOOSRule };
