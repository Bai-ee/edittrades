#!/usr/bin/env node
/**
 * S2 - rule variants on the live flag calls (docs/PROMPT_S2_VARIANTS.md). Research only:
 * no live config change (engine rules frozen until 2026-10-08, docs/AGENT_SESSION_RULES.md),
 * no deploy, no orders. Nothing under lib/, services/, config/, api/, scripts/tracker/ is
 * modified - every rule change below is a replay-time override or a script-only mirror of
 * a private lib/ helper (documented at each site), never an edit to the shipped module.
 *
 * Baseline and scorer (owner instruction): score every variant with the SAME scorer as
 * `docs/CONDITIONS_STUDY_2026-09-26.md` (`scripts/research/conditions.js`, merged into this
 * branch from `conditions-study` per the prompt) - first-ready call per candidateId, fill
 * window (`FILL_WINDOW_CANDLES`) / stop / TP1, `scripts/swing/run.js`'s `scoreSignal`
 * extension (a trade still open at the 24h hold limit is CLOSED at that close and scored
 * mark-to-market, `timeout`, never dropped as an unresolved `open`), net R via
 * `scripts/tracker/costs.js` `netR` at the owner's direction-dependent cost (0.34% long /
 * 0.14% short), with the flat 0.20% cost reported as a sensitivity column.
 *
 * Two tiers of variant:
 *   - "pool" variants re-select the best flag plan from the SAME confirmed candidate pool
 *     `buildScalpContext` already detected (`s.candidateSetups`, type 'flag', state
 *     'confirmed') under a modified stop/target/gate/confidence rule. This mirrors, in this
 *     script only, the private `buildPlanAttempt`/`nearestRoomAhead`/`selectBest` trio in
 *     `lib/flagTradePlan.js` - same precedent `scripts/replay-rules.js`'s V5/V6/L2/L3 gates
 *     already set for an alternative construction over the same detected pool, sharing the
 *     exported gates (`netRiskReward`, `observeRetestHold`, `netFloorStopDistance`), never
 *     touching detection. `L0` (the baseline) instead reads `s.flagTradePlan` directly - the
 *     live selection verbatim, no mirror needed.
 *   - "rescore" variants (`GP-entry`, `exit-trail1r`, `NF-live+exit-trail1r`) take an
 *     already-scored pool variant's own rows (its own `var/research/variants/<id>.<SYM>.jsonl`
 *     output - run that variant first) and re-walk each call's 1m candle path under a
 *     different entry or exit rule, exactly as `scripts/research/exits.js` (S1 Agent C,
 *     uncommitted on `exits-study` - read for its variant definitions only, not imported;
 *     see "exit-trail1r" below) re-walks the L0 population's own levels.
 *
 * RSI substitution (`RSI`, `NF-live+RSI`) - do not edit lib/, "say exactly how": Stoch RSI
 * feeds four places in the live pipeline (`lib/patternDetector.js`'s detector confidence
 * term, `lib/candidateQualifier.js`'s exhaustion reason, `lib/biasMatrix.js`'s basis score,
 * `lib/modelEvidence.js`'s divergence evidence). Tracing all four: the qualifier reason
 * never gates `qual.decision` (only `room:blocked`/`chase`/`rr:` prefixes do,
 * `lib/candidateQualifier.js` line ~127), the bias-matrix basis only feeds `s.topDown`
 * (never read by `lib/flagTradePlan.js`), and the divergence evidence is explicitly
 * "Never a gate, never changes the class or the plan" (`lib/flagRecommendation.js` line
 * ~277) - none of the three can change which candidate reaches `ready` or its entry/stop/
 * tp1. Only the DETECTOR CONFIDENCE term can: it is the #2 tie-break key in `selectBest`
 * (`lib/flagTradePlan.js`) when two-plus confirmed candidates compete for the single
 * published plan. This script recomputes that one term from the payload's own already-
 * published sub-scores (`impulseStrength`, `compressionScore`, `ema21Hold` - all present on
 * every default-payload candidate, confirmed against `services/scalpContext.js`'s
 * `stripUnusedGeometryFields`, which strips `flagSlope`/`breakoutDistancePct`/
 * `invalidationDistancePct`/`levelSource` but keeps these) plus a fresh RSI(14) term
 * (`recomputeConfidenceRsi`, using the `technicalindicators` RSI calculator directly - the
 * same library `services/indicators.js` already uses for its own un-published RSI(14), just
 * not exposed on the payload) at the SAME `flag.confidence.weights.stoch` weight
 * (config/engine.json: 0.15) `lib/patternDetector.js`'s own Stoch term uses. This is a
 * replay-time recompute on the returned payload object (never a monkey-patch of the ES
 * module's own named export, which is read-only) fed into this script's own `selectBest`
 * mirror - the only channel through which the substitution can change which plan the
 * "pool" tier selects. The other three sites are also relabeled/recomputed here
 * (`ema21HoldCategory`/`rsiSlopeScore` reused for the qualifier relabel in the doc's own
 * commentary) but are not wired into gating, because the traced production code never
 * gates on them either - reproducing that inertness faithfully is the honest reading of
 * "implement as replay-time overrides," not a shortcut.
 *
 * Usage (one process per variant, mirrors scripts/replay-rules.js):
 *   node scripts/research/variants.js --variant <id> --history <dir> [--symbols BTC,SOL,ETH]
 *     [--step 5] [--out var/research/variants/<id>.<SYM>.jsonl] [--summary var/research/variants/<id>.summary.json]
 *   node scripts/research/variants.js --doc docs/VARIANTS_STUDY_2026-09-26.md
 *     --summaries var/research/variants/L0.summary.json,var/research/variants/NF-live.summary.json,...
 *     (analyze-only: assembles the one-table doc from already-computed --summary files)
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RSI, MACD } from 'technicalindicators';

import { ENGINE_CONFIG, setConfigOverride } from '../../config/engine.js';
import { buildScalpContext, dropUnclosedCandles, SYMBOLS, TIMEFRAMES, INTERVAL_MS } from '../../services/scalpContext.js';
import { loadHistoryDir, clockCloses, makeReplayFetch } from '../replay.js';
import { scoreSignal } from '../swing/run.js';
import { FILL_WINDOW_CANDLES, round, median, isFiniteNumber } from '../tracker/walk-outcome.js';
import { netR } from '../tracker/costs.js';
import { observeRetestHold, netRiskReward, netFloorStopDistance } from '../../lib/flagTradePlan.js';
import { geometryTimeframeFor } from '../../lib/patternLifecycle.js';
import { swingPivots } from '../../lib/geometry.js';
import { calculateATR } from '../../lib/advancedIndicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const VARIANTS_OUT_DIR = path.join(REPO_ROOT, 'var/research/variants');

/** 24h of 1m candles - same convention as scripts/replay-rules.js HOLD_24H_CANDLES and scripts/research/conditions.js. */
export const HOLD_24H_CANDLES = 1440;
const STRUCTURE_TF = '15m';
const REPLAY_ACCOUNT = Object.freeze({ status: 'unavailable', margin: { usd: null, byAsset: {} } });
const FLAG_TF_RANK = { '1m': 0, '3m': 1, '5m': 2, '15m': 3, '1h': 4 };
const STATUS_RANK = { ready: 0, conditional: 1, rejected: 2 };
/** T-13 net floor (docs/PLAN_TELEGRAM.md "net floor", lib/flagTradePlan.js netFloorStopDistance): stop >= max(0.5x ATR(15m), 3x round-trip cost). */
const NF_ATR_MULT = 0.5;
const NF_COST_MULT = 3;

function isFiniteNum(v) { return isFiniteNumber(v); }

/** Swallows the production pipeline's console noise - a replay makes hundreds of builds. */
async function quietly(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
}

/** How many closed candles a timeframe can serve as of cutMs - warm-up gate, same as scripts/research/conditions.js. */
async function servedCount(historyByTf, tf, cutMs) {
  const env = await makeReplayFetch(historyByTf, cutMs)(null, tf, 500);
  return dropUnclosedCandles(env.candles, tf, cutMs).length;
}

/** One production build, no bias/model extras - this study never reads s.topDown, so includeBias is never needed. */
async function buildPlain(symbol, historyByTf, cutMs, timeframes) {
  return quietly(() => buildScalpContext({
    symbols: [symbol], timeframes, now: cutMs,
    fetchCandles: makeReplayFetch(historyByTf, cutMs),
    fetchAccount: async () => REPLAY_ACCOUNT
  }));
}

/**
 * Closed candles for `tf` as of `cutMs`, correct for BOTH native timeframes (1m/5m/15m/
 * 1h/4h/1d, read straight off `historyByTf`) and derived ones (3m - "derived, never
 * stored", scripts/replay.js's own NATIVE_TIMEFRAMES comment). A candidate's own
 * timeframe is 1m/3m/5m per `flag.timeframes`, so 3m candidates are common; reading
 * `historyByTf['3m']` directly (as an earlier version of this file did) silently returns
 * an empty array for every one of them - `makeReplayFetch` is the same production
 * abstraction `buildPlain`/`servedCount` already route every candle read through
 * (`services/marketData.js`'s `getCandlesWithProvenance`, which performs the 3m
 * aggregation), so this is the one correct way to fetch a timeframe's candles here.
 */
async function fetchClosedCandles(historyByTf, cutMs, tf, limit) {
  const env = await makeReplayFetch(historyByTf, cutMs)(null, tf, limit);
  return dropUnclosedCandles(env.candles, tf, cutMs);
}

async function ownTimeframeAtr(historyByTf, cutMs, tf, period) {
  const candles = await fetchClosedCandles(historyByTf, cutMs, tf, period + 50);
  if (candles.length < period + 1) return null;
  const r = calculateATR(candles, period);
  return r && isFiniteNum(r.atr) ? r.atr : null;
}

// ---------------------------------------------------------------------------
// mirror of lib/flagTradePlan.js's private nearestRoomAhead (not exported - same
// precedent scripts/replay-rules.js's evaluateRoom already set for L2/L3). Byte-level
// copy of its logic as of this writing; lib/flagTradePlan.js itself is never touched.
// Used whenever a variant leaves TP1 "unchanged" (room-capped measuredTarget, same as
// the live plan) while only the stop construction differs (NF-live and its combos).
// ---------------------------------------------------------------------------
export function mirrorNearestRoomAhead(direction, entry, measuredTarget, geometryContext, ownGeometry) {
  const sign = direction === 'short' ? -1 : 1;
  const orientedEntry = sign * entry;
  const orientedTarget = sign * measuredTarget;
  let nearestOriented = null;

  for (const g of Object.values(geometryContext || {})) {
    if (!g) continue;
    const zones = direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones;
    if (!Array.isArray(zones)) continue;
    for (const z of zones) {
      if (!isFiniteNum(z.low) || !isFiniteNum(z.high)) continue;
      const near = direction === 'long' ? z.low : z.high;
      const orientedNear = sign * near;
      if (orientedNear > orientedEntry && orientedNear < orientedTarget) {
        if (nearestOriented === null || orientedNear < nearestOriented) nearestOriented = orientedNear;
      }
    }
  }

  let touchesEntry = false;
  if (ownGeometry) {
    const ownZones = direction === 'long' ? ownGeometry.horizontalResistanceZones : ownGeometry.horizontalSupportZones;
    if (Array.isArray(ownZones)) {
      touchesEntry = ownZones.some((z) => isFiniteNum(z.low) && isFiniteNum(z.high) && z.low <= entry && z.high >= entry);
    }
  }

  return { touchesEntry, nearestEdge: nearestOriented === null ? null : sign * nearestOriented };
}

// ---------------------------------------------------------------------------
// RSI substitution helpers (see file header for the "which of Stoch's four roles gate
// anything" trace). EMA21_SCORE_MIRROR mirrors lib/patternDetector.js's private
// EMA21_HOLD_SCORE ({hold:1, wick:0.5, acceptance:0, reclaim:0.5}) keyed by the same
// direction-agnostic categories scripts/research/conditions.js's ema21HoldBucket already
// established for this exact purpose (re-derived here, not imported, to keep this file's
// only lib/ imports read-only exported functions).
// ---------------------------------------------------------------------------
const EMA21_SCORE_MIRROR = { hold: 1, wick: 0.5, acceptance: 0, reclaim: 0.5, none: 0.5 };

export function ema21HoldCategory(ema21Hold) {
  const h = typeof ema21Hold === 'string' ? ema21Hold : '';
  if (h === 'hold' || h === 'hold_below') return 'hold';
  if (h === 'wick' || h === 'wick_above') return 'wick';
  if (h.startsWith('acceptance')) return 'acceptance';
  if (h === 'reclaim') return 'reclaim';
  return 'none';
}

/** RSI(14) slope read, in the SAME 0/0.5/1 oriented shape lib/patternDetector.js's private stochScore uses for %K's slope. Insufficient history (<2 values) scores neutral, mirroring stochScore's null-input behavior. */
export function rsiSlopeScore(rsiValues, sign) {
  if (!Array.isArray(rsiValues) || rsiValues.length < 2) return 0.5;
  const last = rsiValues[rsiValues.length - 1];
  const prev = rsiValues[rsiValues.length - 2];
  if (!isFiniteNum(last) || !isFiniteNum(prev)) return 0.5;
  const slope = (last - prev) * sign;
  if (slope > 0) return 1;
  if (slope < 0) return 0;
  return 0.5;
}

/**
 * Recompute a candidate's detector confidence, swapping the Stoch RSI slope term for an
 * RSI(14) slope term at the SAME `cfg.flag.confidence.weights.stoch` weight - the only
 * one of Stoch's four production roles that can change which plan `selectBest` picks (see
 * file header). Every other term is read straight off the candidate's own published
 * sub-scores, unchanged from `lib/patternDetector.js`'s own formula.
 */
export function recomputeConfidenceRsi(candidate, rsiValues, cfg) {
  const w = cfg.flag.confidence.weights;
  const sign = candidate.direction === 'short' ? -1 : 1;
  const impulseFullAtr = cfg.flag.confidence.impulseFullAtr;
  const impulseTerm = isFiniteNum(candidate.impulseStrength) && impulseFullAtr > 0
    ? Math.max(0, Math.min(1, candidate.impulseStrength / impulseFullAtr))
    : 0;
  const compressionTerm = isFiniteNum(candidate.compressionScore) ? candidate.compressionScore : 0;
  const ema21Term = EMA21_SCORE_MIRROR[ema21HoldCategory(candidate.ema21Hold)];
  const rsiTerm = rsiSlopeScore(rsiValues, sign);
  return round(100 * (w.impulse * impulseTerm + w.compression * compressionTerm + w.ema21 * ema21Term + w.stoch * rsiTerm), 4);
}

// ---------------------------------------------------------------------------
// MACD-agree (own timeframe or 15m) and GP-filter/GP-entry (golden pocket, 0.618-0.65
// retracement of the last completed swing leg from lib/geometry.js's exported
// swingPivots - read-only import, no lib/ change).
// ---------------------------------------------------------------------------

/** MACD(12,26,9) histogram sign at the last closed candle, or null with insufficient history. Same `technicalindicators` library services/indicators.js already uses elsewhere in this repo. */
export function macdHistogramSign(candles) {
  if (!Array.isArray(candles) || candles.length < 35) return null;
  const closes = candles.map((c) => c.close);
  const out = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  if (!out.length) return null;
  const last = out[out.length - 1];
  if (!isFiniteNum(last.histogram) || last.histogram === 0) return null;
  return last.histogram > 0 ? 1 : -1;
}

/**
 * Golden-pocket zone (0.618-0.65 retracement) of the last completed swing leg in
 * `direction`: long reads the most recent swing HIGH with an earlier swing LOW before it
 * (the up-leg being retraced); short mirrors it (most recent swing LOW with an earlier
 * swing HIGH before it). Pivots from lib/geometry.js's exported `swingPivots` (read-only),
 * same pivotLeft/pivotRight as the live geometry config. Null when no completed pair
 * exists yet in `candles`.
 * @returns {{low:number, high:number, legLow:number, legHigh:number}|null}
 */
export function goldenPocketZone(direction, candles, cfg) {
  const pivots = swingPivots(candles, cfg.geometry.pivotLeft, cfg.geometry.pivotRight);
  if (direction === 'long') {
    for (let hi = pivots.highs.length - 1; hi >= 0; hi--) {
      const high = pivots.highs[hi];
      const priorLows = pivots.lows.filter((l) => l.index < high.index);
      if (!priorLows.length) continue;
      const low = priorLows[priorLows.length - 1];
      const range = high.price - low.price;
      if (!(range > 0)) continue;
      return { low: round(high.price - 0.65 * range, 6), high: round(high.price - 0.618 * range, 6), legLow: low.price, legHigh: high.price };
    }
    return null;
  }
  for (let li = pivots.lows.length - 1; li >= 0; li--) {
    const low = pivots.lows[li];
    const priorHighs = pivots.highs.filter((h) => h.index < low.index);
    if (!priorHighs.length) continue;
    const high = priorHighs[priorHighs.length - 1];
    const range = high.price - low.price;
    if (!(range > 0)) continue;
    return { low: round(low.price + 0.618 * range, 6), high: round(low.price + 0.65 * range, 6), legLow: low.price, legHigh: high.price };
  }
  return null;
}

// ---------------------------------------------------------------------------
// pool tier: mirrored candidate -> plan construction, sharing lib/flagTradePlan.js's
// exported gates (netRiskReward, observeRetestHold, netFloorStopDistance). Never touches
// detection (candidateSetups is read as production already built it).
// ---------------------------------------------------------------------------

/**
 * One candidate's plan attempt under `ruleOpts`. Returns null on any rejection (construction
 * invalid, a gate fails, or an extra predicate - MACD/GP/direction - fails); the caller
 * records that as a 'rejected' attempt so `selectBestAttempt` can still prefer a different
 * candidate, the same precedent lib/flagTradePlan.js's own buildPlanAttempt/selectBest sets.
 * @param {Object} candidate
 * @param {{geometryContext:Object|null, historyByTf:Object, cutMs:number}} ctx
 * @param {Object} cfg - ENGINE_CONFIG
 * @param {Object} ruleOpts - stopMode:'own'|'nf'|'atr1x', targetMode:'room'|'fixedRR',
 *   minRR, minNetRR (null/undefined falls back to cfg.flagPlan.minNetRR, i.e. off),
 *   requireMacdTf:'own'|'15m'|null, requireGpFilter:bool, directionFilter:'long'|'short'|null
 * @returns {{entry:number, stop:number, tp1:number, grossRR:number, netRR:number|null, stopDistancePct:number}|null}
 */
export async function buildResearchPlan(candidate, ctx, cfg, ruleOpts) {
  if (candidate.chaseRisk === true) return null;
  const direction = candidate.direction;
  if (ruleOpts.directionFilter && direction !== ruleOpts.directionFilter) return null;
  const sign = direction === 'short' ? -1 : 1;
  const entry = candidate.breakoutLevel;
  const measuredTarget = candidate.measuredTarget;
  if (!isFiniteNum(entry) || !isFiniteNum(measuredTarget)) return null;

  const { geometryContext, historyByTf, cutMs } = ctx;
  const atr15m = geometryContext && geometryContext[STRUCTURE_TF] && isFiniteNum(geometryContext[STRUCTURE_TF].atr)
    ? geometryContext[STRUCTURE_TF].atr : null;

  // --- stop construction ---
  let stop = candidate.invalidation;
  if (ruleOpts.stopMode === 'nf') {
    if (!isFiniteNum(atr15m)) return null; // netFloorStopDistance never guesses a missing ATR
    const nf = netFloorStopDistance({ direction, entry, stop: candidate.invalidation, atr15m, riskCfg: cfg.risk, atrMult: NF_ATR_MULT, costMult: NF_COST_MULT });
    if (!nf) return null;
    stop = entry - sign * nf.distance;
  } else if (ruleOpts.stopMode === 'atr1x') {
    if (!isFiniteNum(atr15m) || atr15m <= 0) return null;
    stop = entry - sign * atr15m;
  }
  if (!isFiniteNum(stop) || sign * (entry - stop) <= 0) return null;

  // --- target construction ---
  let tp1;
  if (ruleOpts.targetMode === 'fixedRR') {
    // ATR-stop: "TP1 recomputed to keep the plan's R:R rule" - grossRR fixed at the
    // variant's own minRR by construction, same precedent scripts/replay-rules.js's V6
    // (buildAtrFloorPlan, fixed 3x) already set for a widened-stop alternative construction.
    const stopDist = Math.abs(entry - stop);
    tp1 = entry + sign * stopDist * (ruleOpts.minRR ?? cfg.flagPlan.minRR);
  } else {
    // 'room' (default): TP1 unchanged from the live rule - room-capped measuredTarget,
    // mirrorNearestRoomAhead above. A stop-only variant (NF-live) never touches this.
    const ownTf = geometryTimeframeFor(candidate.timeframe);
    const ownGeometry = ownTf && geometryContext ? geometryContext[ownTf] : null;
    const { touchesEntry, nearestEdge } = mirrorNearestRoomAhead(direction, entry, measuredTarget, geometryContext, ownGeometry);
    if (touchesEntry) return null;
    tp1 = nearestEdge !== null ? nearestEdge : measuredTarget;
  }
  if (!isFiniteNum(tp1) || sign * (tp1 - entry) <= 0) return null;

  // --- extra predicates (folded into construction, not a post-selection filter, so a
  // failing candidate ranks 'rejected' and a different candidate can win selectBest) ---
  if (ruleOpts.requireMacdTf) {
    const tf = ruleOpts.requireMacdTf === 'own' ? candidate.timeframe : '15m';
    const macdCandles = await fetchClosedCandles(historyByTf, cutMs, tf, 200);
    const macdSign = macdHistogramSign(macdCandles);
    if (macdSign === null || macdSign !== sign) return null;
  }
  if (ruleOpts.requireGpFilter) {
    const ownCandles = await fetchClosedCandles(historyByTf, cutMs, candidate.timeframe, 500);
    const gp = goldenPocketZone(direction, ownCandles, cfg);
    if (!gp || !(entry >= gp.low && entry <= gp.high)) return null;
  }

  // --- gates (mirrors lib/flagTradePlan.js's buildPlanAttempt cascade exactly) ---
  const grossRR = round(Math.abs(tp1 - entry) / Math.abs(entry - stop), 3);
  const minRR = ruleOpts.minRR ?? cfg.flagPlan.minRR;
  if (grossRR === null || grossRR < minRR) return null;
  const netRR = round(netRiskReward(entry, stop, tp1, cfg.risk, direction), 3);
  const minNetRR = ruleOpts.minNetRR !== undefined ? ruleOpts.minNetRR : cfg.flagPlan.minNetRR;
  if (isFiniteNum(minNetRR) && (netRR === null || netRR < minNetRR)) return null;
  const stopDistancePct = round((Math.abs(entry - stop) / entry) * 100, 3);
  if (stopDistancePct === null || stopDistancePct > cfg.scalp.maxStopDistancePct) return null;

  return { entry: round(entry, 2), stop: round(stop, 2), tp1: round(tp1, 2), grossRR, netRR, stopDistancePct };
}

/** Mirrors lib/flagTradePlan.js's private selectBest tie-break exactly (status, then confidence desc, then timeframe rank, then candidateId). */
export function selectBestAttempt(attempts) {
  if (!attempts.length) return null;
  return attempts.slice().sort((a, b) => {
    const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (s !== 0) return s;
    const c = (b.confidence ?? -1) - (a.confidence ?? -1);
    if (c !== 0) return c;
    const t = (FLAG_TF_RANK[b.timeframe] ?? -1) - (FLAG_TF_RANK[a.timeframe] ?? -1);
    if (t !== 0) return t;
    return String(a.candidateId).localeCompare(String(b.candidateId));
  })[0];
}

// ---------------------------------------------------------------------------
// scoring: one selected plan -> one scored row (scripts/research/conditions.js's own
// scorer: scoreSignal's fill window/stop/tp1/24h timeout close-out, net of dir-cost).
// ---------------------------------------------------------------------------

function scoreAndPush({ symbol, candidateId, timeframe, direction, firstReadyAt, entry, stop, tp1, stopDistancePct, plannedGrossRR, plannedNetRR }, candles1m, sink) {
  const fromMs = Date.parse(firstReadyAt);
  const scored = scoreSignal({ candles1m, fromMs, direction, entry, stop, target: tp1, fillWindowCandles: FILL_WINDOW_CANDLES, maxHoldCandles: HOLD_24H_CANDLES });
  const resolved = scored.status === 'win' || scored.status === 'loss' || scored.status === 'timeout';
  const grossR = scored.status === 'loss' ? -1 : (resolved ? scored.r : null);
  const net = resolved ? round(netR(entry, stop, grossR, direction), 4) : null;
  const netSens020 = resolved ? round(grossR - (0.002 * entry) / Math.abs(entry - stop), 4) : null;
  sink.push({
    symbol, candidateId, timeframe, direction, firstReadyAt, entry, stop, tp1,
    stopDistancePct, plannedGrossRR, plannedNetRR,
    status: scored.status, grossR, netR: net, netR_sens020: netSens020,
    holdCandles: isFiniteNum(scored.holdCandles) ? scored.holdCandles : null,
    timeToTP1Candles: isFiniteNum(scored.timeToTP1Candles) ? scored.timeToTP1Candles : null
  });
}

/** L0: read s.flagTradePlan directly - the live selection verbatim, no pool mirror needed. */
function processCloseL0(s, symbol, cutMs, candles1m, seen, sink) {
  const plan = s.flagTradePlan;
  if (!plan || plan.status !== 'ready' || !plan.candidateId || seen.has(plan.candidateId)) return;
  seen.add(plan.candidateId);
  scoreAndPush({
    symbol, candidateId: plan.candidateId, timeframe: plan.timeframe, direction: plan.direction,
    firstReadyAt: new Date(cutMs).toISOString(), entry: plan.entry, stop: plan.stop, tp1: plan.tp1,
    stopDistancePct: plan.stopDistancePct, plannedGrossRR: plan.grossRR, plannedNetRR: plan.netRR
  }, candles1m, sink);
}

/** Every other "pool" variant: full confirmed-candidate-pool reselection under ruleOpts. */
async function processClosePool(s, symbol, cutMs, candles1m, historyByTf, cfg, ruleOpts, seen, sink) {
  const geometryContext = s.geometryContext || {};
  const pool = (s.candidateSetups || []).filter((c) => c && c.type === 'flag' && c.state === 'confirmed' && c.candidateId);
  if (!pool.length) return;

  const ctx = { geometryContext, historyByTf, cutMs };
  const attempts = [];
  for (const candidate of pool) {
    const plan = await buildResearchPlan(candidate, ctx, cfg, ruleOpts);
    let confidence = candidate.confidence;
    if (ruleOpts.rsiConfidence) {
      const closes = (await fetchClosedCandles(historyByTf, cutMs, candidate.timeframe, 200)).map((c) => c.close);
      const rsiSeries = closes.length > 15 ? RSI.calculate({ period: 14, values: closes }) : [];
      confidence = recomputeConfidenceRsi(candidate, rsiSeries, cfg);
    }
    if (!plan) { attempts.push({ candidateId: candidate.candidateId, timeframe: candidate.timeframe, confidence, status: 'rejected', plan: null }); continue; }

    const tf = candidate.timeframe;
    const candles = await fetchClosedCandles(historyByTf, cutMs, tf, 500);
    const firstDetectedMs = typeof candidate.firstDetectedAt === 'string' ? Date.parse(candidate.firstDetectedAt) : NaN;
    const fromMs = isFiniteNum(firstDetectedMs) ? firstDetectedMs - INTERVAL_MS[tf] : null;
    const atrValue = await ownTimeframeAtr(historyByTf, cutMs, tf, cfg.flag.atrPeriod);
    const currentPrice = candles.length ? candles[candles.length - 1].close : null;
    const { status } = observeRetestHold({ direction: candidate.direction, entry: plan.entry, stop: plan.stop, candles, fromMs, currentPrice, atrValue, toleranceAtr: cfg.flagPlan.entryToleranceAtr });
    attempts.push({ candidateId: candidate.candidateId, timeframe: tf, direction: candidate.direction, confidence, status, plan });
  }

  const best = selectBestAttempt(attempts);
  if (!best || best.status !== 'ready' || seen.has(best.candidateId)) return;
  seen.add(best.candidateId);
  scoreAndPush({
    symbol, candidateId: best.candidateId, timeframe: best.timeframe, direction: best.direction,
    firstReadyAt: new Date(cutMs).toISOString(), entry: best.plan.entry, stop: best.plan.stop, tp1: best.plan.tp1,
    stopDistancePct: best.plan.stopDistancePct, plannedGrossRR: best.plan.grossRR, plannedNetRR: best.plan.netRR
  }, candles1m, sink);
}

// ---------------------------------------------------------------------------
// rescore tier: GP-entry (different entry rule), exit-trail1r / NF-live+exit-trail1r
// (different exit rule), both re-walking a BASE pool variant's own already-scored rows.
// ---------------------------------------------------------------------------

/**
 * GP-entry: instead of the base row's own breakout-level fill, search up to 24h of 1m
 * candles from the ready close for the first touch of the golden-pocket zone's near edge
 * (the shallower 0.618 level, reached first on a retracement) computed from the flag's own
 * timeframe as of that same ready close. Stop/TP1 stay the base row's own numbers. Returns
 * null (excluded, not a 0/loss row) when no completed swing exists yet or the zone is never
 * touched within 24h - "not filled if untouched."
 */
export async function rescoreGpEntryRow(row, historyByTf, cfg) {
  const tf = row.timeframe;
  const fromMs = Date.parse(row.firstReadyAt);
  const ownCandles = await fetchClosedCandles(historyByTf, fromMs, tf, 500);
  const gp = goldenPocketZone(row.direction, ownCandles, cfg);
  if (!gp) return null;
  const nearEdge = row.direction === 'long' ? gp.high : gp.low;

  const candles1m = historyByTf['1m'];
  let start = 0;
  while (start < candles1m.length && candles1m[start].timestamp < fromMs) start++;
  const searchEnd = Math.min(candles1m.length, start + HOLD_24H_CANDLES);
  let touchIdx = -1;
  for (let i = start; i < searchEnd; i++) {
    const c = candles1m[i];
    const touched = row.direction === 'long' ? c.low <= nearEdge : c.high >= nearEdge;
    if (touched) { touchIdx = i; break; }
  }
  if (touchIdx === -1) return null;

  const newEntry = round(nearEdge, 2);
  const scored = scoreSignal({ candles1m, fromMs: candles1m[touchIdx].timestamp, direction: row.direction, entry: newEntry, stop: row.stop, target: row.tp1, fillWindowCandles: 1, maxHoldCandles: HOLD_24H_CANDLES });
  const resolved = scored.status === 'win' || scored.status === 'loss' || scored.status === 'timeout';
  const grossR = scored.status === 'loss' ? -1 : (resolved ? scored.r : null);
  const net = resolved ? round(netR(newEntry, row.stop, grossR, row.direction), 4) : null;
  return {
    ...row, entry: newEntry, gpZone: gp,
    status: scored.status, grossR, netR: net,
    holdCandles: isFiniteNum(scored.holdCandles) ? scored.holdCandles : null,
    timeToTP1Candles: isFiniteNum(scored.timeToTP1Candles) ? scored.timeToTP1Candles : null
  };
}

/**
 * `exit-trail1r` (docs/PROMPT_S2_VARIANTS.md item 13): `docs/EXITS_STUDY_2026-09-26.md`
 * does not exist on `origin/upgrade-signal-engine`, and `git log exits-study -1` shows only
 * the S1-prompt-docs commit (d8fbb87) - the exits study has not landed on that branch (its
 * `scripts/research/exits.js`/`test-exits-study.js` exist only as uncommitted work in a
 * sibling worktree). Per the prompt's own fallback, trail1R is implemented here from its
 * spec: once a candle CLOSES at or beyond +1R favorable, the stop starts trailing 1R behind
 * the best CLOSE seen since, monotonically (never gives back ground); target stays the
 * base row's own TP1 - trailing only tightens the downside once armed. Same-candle
 * convention as `scripts/tracker/walk-outcome.js`'s `walkOutcome` (stop always resolves
 * before a same-candle target touch; a target touch on the very fill candle never counts).
 * R is measured against the ORIGINAL entry/stop risk throughout (never re-based off a
 * moved stop) and `netR` is charged against that same original stop - same convention
 * every other cost column in this repo uses.
 */
export function walkTrail1R({ candles1m, fromMs, direction, entry, stop, target, fillWindowCandles, maxHoldCandles }) {
  const sign = direction === 'short' ? -1 : 1;
  const long = direction !== 'short';
  let start = 0;
  while (start < candles1m.length && candles1m[start].timestamp < fromMs) start++;
  const fillEnd = Math.min(candles1m.length, start + fillWindowCandles);
  let fillIdx = -1;
  for (let i = start; i < fillEnd; i++) {
    const c = candles1m[i];
    if (c.low <= entry && c.high >= entry) { fillIdx = i; break; }
  }
  if (fillIdx === -1) return { status: 'not_filled' };
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { status: 'invalid_levels' };

  let currentStop = stop;
  let armed = false;
  let bestClose = entry;
  const exitEnd = Math.min(candles1m.length, fillIdx + maxHoldCandles);
  for (let i = fillIdx; i < exitEnd; i++) {
    const c = candles1m[i];
    const holdCandles = i - fillIdx + 1;
    const stopHit = long ? c.low <= currentStop : c.high >= currentStop;
    const targetHit = long ? c.high >= target : c.low <= target;

    if (stopHit) {
      const r = round((sign * (currentStop - entry)) / risk, 4);
      return { status: r >= 0 ? 'win' : 'loss', r, holdCandles };
    }
    if (targetHit && i > fillIdx) {
      const r = round(Math.abs(target - entry) / risk, 4);
      return { status: 'win', r, holdCandles, timeToTP1Candles: holdCandles };
    }

    if (isFiniteNum(c.close)) {
      const closeR = (sign * (c.close - entry)) / risk;
      if (!armed && closeR >= 1) { armed = true; bestClose = c.close; }
      else if (armed) bestClose = long ? Math.max(bestClose, c.close) : Math.min(bestClose, c.close);
      if (armed) {
        const trailStop = bestClose - sign * risk;
        currentStop = long ? Math.max(currentStop, trailStop) : Math.min(currentStop, trailStop);
      }
    }
    if (i === exitEnd - 1) {
      const r = round((sign * (c.close - entry)) / risk, 4);
      return { status: 'timeout', r, holdCandles };
    }
  }
  return { status: 'open', holdCandles: exitEnd - fillIdx };
}

function rescoreTrail1RRow(row) {
  return (historyByTf) => {
    const candles1m = historyByTf['1m'];
    const fromMs = Date.parse(row.firstReadyAt);
    const walked = walkTrail1R({ candles1m, fromMs, direction: row.direction, entry: row.entry, stop: row.stop, target: row.tp1, fillWindowCandles: FILL_WINDOW_CANDLES, maxHoldCandles: HOLD_24H_CANDLES });
    const resolved = walked.status === 'win' || walked.status === 'loss' || walked.status === 'timeout';
    const grossR = resolved ? walked.r : null;
    const net = resolved ? round(netR(row.entry, row.stop, grossR, row.direction), 4) : null;
    return {
      ...row, status: walked.status, grossR, netR: net,
      holdCandles: isFiniteNum(walked.holdCandles) ? walked.holdCandles : null,
      timeToTP1Candles: isFiniteNum(walked.timeToTP1Candles) ? walked.timeToTP1Candles : null
    };
  };
}

// ---------------------------------------------------------------------------
// variant table
// ---------------------------------------------------------------------------

export const VARIANTS = {
  L0: {
    label: 'baseline: live config verbatim (s.flagTradePlan.status===ready, first-ready per candidateId, same L0 scripts/replay-rules.js scores)',
    tier: 'pool', ruleOpts: null, configOverride: null
  },
  'NF-live': {
    label: 'owner rule: T-13 net floor applied for real - stop >= max(0.5x ATR15m, 3x direction cost), TP1 unchanged, gross>=2.5, net R:R>=1.0',
    tier: 'pool', ruleOpts: { stopMode: 'nf', targetMode: 'room', minRR: 2.5, minNetRR: 1.0 }, configOverride: null
  },
  'NF-live+minRR2': {
    label: 'NF-live with the gross floor lowered to 2.0',
    tier: 'pool', ruleOpts: { stopMode: 'nf', targetMode: 'room', minRR: 2.0, minNetRR: 1.0 }, configOverride: null
  },
  RSI: {
    label: 'RSI(14) replaces Stoch RSI in the detector confidence weight (same weight, replay-time recompute; qualifier/bias/divergence roles traced non-gating, see file header)',
    tier: 'pool', ruleOpts: { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, rsiConfidence: true }, configOverride: null
  },
  'NF-live+RSI': {
    label: 'NF-live stop/gate rule + RSI confidence substitution',
    tier: 'pool', ruleOpts: { stopMode: 'nf', targetMode: 'room', minRR: 2.5, minNetRR: 1.0, rsiConfidence: true }, configOverride: null
  },
  'NF-live+5m': {
    label: 'NF-live, flag timeframes restricted to 5m only (config override: flag.timeframes)',
    tier: 'pool', ruleOpts: { stopMode: 'nf', targetMode: 'room', minRR: 2.5, minNetRR: 1.0 }, configOverride: { flag: { timeframes: ['5m'] } }
  },
  'NF-live+shorts': {
    label: 'NF-live, short-direction candidates only',
    tier: 'pool', ruleOpts: { stopMode: 'nf', targetMode: 'room', minRR: 2.5, minNetRR: 1.0, directionFilter: 'short' }, configOverride: null
  },
  'ATR-stop': {
    label: 'stop = 1x ATR(15m) from entry (not the flag invalidation); TP1 recomputed to hold gross R:R at the live floor (2.5)',
    tier: 'pool', ruleOpts: { stopMode: 'atr1x', targetMode: 'fixedRR', minRR: 2.5, minNetRR: null }, configOverride: null
  },
  'MACD-agree': {
    label: "MACD(12,26,9) histogram on the flag's own timeframe must share the trade's sign at the ready close",
    tier: 'pool', ruleOpts: { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, requireMacdTf: 'own' }, configOverride: null
  },
  'MACD-agree-15m': {
    label: 'same MACD-agree test, computed on 15m instead of the flag\'s own timeframe',
    tier: 'pool', ruleOpts: { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, requireMacdTf: '15m' }, configOverride: null
  },
  'GP-filter': {
    label: "breakout level must lie inside the 0.618-0.65 retracement (golden pocket) of the last completed swing on the flag's own timeframe, in the trend direction",
    tier: 'pool', ruleOpts: { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, requireGpFilter: true }, configOverride: null
  },
  'GP-entry': {
    label: 'L0 calls, entry moved to the first touch of the golden-pocket zone after the ready close (stop/TP1 unchanged; excluded, not scored, if untouched within 24h)',
    tier: 'gpEntryRescore', baseVariant: 'L0', configOverride: null
  },
  'NF-live+MACD-agree+GP-filter': {
    label: 'the stack: NF-live stop/gate + MACD-agree (own timeframe) + GP-filter',
    tier: 'pool', ruleOpts: { stopMode: 'nf', targetMode: 'room', minRR: 2.5, minNetRR: 1.0, requireMacdTf: 'own', requireGpFilter: true }, configOverride: null
  },
  'exit-trail1r': {
    label: 'L0 entries; exit management: once a candle closes >= +1R, stop trails 1R behind the best close since (docs/EXITS_STUDY_2026-09-26.md not landed on origin/upgrade-signal-engine or branch exits-study - implemented per the prompt\'s own fallback spec)',
    tier: 'trail1rRescore', baseVariant: 'L0', configOverride: null
  },
  'NF-live+exit-trail1r': {
    label: 'NF-live entries, trail-1R exit management',
    tier: 'trail1rRescore', baseVariant: 'NF-live', configOverride: null
  }
};

// ---------------------------------------------------------------------------
// per-symbol replay (pool tier) - mirrors scripts/research/conditions.js's own
// replayConditions loop (warm-up gate, manual close-by-close buildPlain), generalized
// to dispatch to processCloseL0 or processClosePool per ruleOpts.
// ---------------------------------------------------------------------------

export async function replayVariantSymbol({ symbol, historyByTf, ruleOpts, cfg = ENGINE_CONFIG, step = 1, timeframes = TIMEFRAMES }) {
  const { closes } = clockCloses(historyByTf, timeframes);
  const min = cfg.replay.minComputeCandles;
  let first = -1;
  for (let i = 0; i < closes.length; i++) {
    let ok = true;
    for (const tf of timeframes) { if ((await servedCount(historyByTf, tf, closes[i])) < min) { ok = false; break; } }
    if (ok) { first = i; break; }
  }
  const rows = [];
  if (first === -1) return { rows, firstEligible: null };

  const selected = closes.slice(first);
  const seen = new Set();
  const candles1m = historyByTf['1m'];

  for (let i = 0; i < selected.length; i += Math.max(1, step)) {
    const cutMs = selected[i];
    const payload = await buildPlain(symbol, historyByTf, cutMs, timeframes);
    const s = payload.symbols[symbol];
    if (!s) continue;
    if (ruleOpts === null) processCloseL0(s, symbol, cutMs, candles1m, seen, rows);
    else await processClosePool(s, symbol, cutMs, candles1m, historyByTf, cfg, ruleOpts, seen, rows);
  }
  return { rows, firstEligible: new Date(closes[first]).toISOString() };
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

async function runRescoreVariant({ variantId, variant, historyDir, symbols }) {
  const historyByTfAll = loadHistoryDir(historyDir, symbols);
  const cfg = ENGINE_CONFIG;
  const rows = [];
  for (const symbol of symbols) {
    const baseFile = path.join(VARIANTS_OUT_DIR, `${variant.baseVariant}.${symbol}.jsonl`);
    if (!existsSync(baseFile)) throw new Error(`missing base rows for ${variant.baseVariant} (${symbol}): ${baseFile} - run --variant ${variant.baseVariant} first`);
    const baseRows = readFileSync(baseFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const row of baseRows) {
      const rescored = variant.tier === 'gpEntryRescore'
        ? await rescoreGpEntryRow(row, historyByTfAll[symbol], cfg)
        : rescoreTrail1RRow(row)(historyByTfAll[symbol]);
      if (rescored) rows.push(rescored);
    }
  }
  const span = readSpan(historyDir, symbols);
  return { variantId, label: variant.label, symbols, historyDir, span, firstEligibleBySymbol: {}, rows };
}

export async function runVariant({ variantId, historyDir, symbols, step = 1 }) {
  const variant = VARIANTS[variantId];
  if (!variant) throw new Error(`unknown --variant ${variantId}; known: ${Object.keys(VARIANTS).join(', ')}`);
  if (variant.tier === 'gpEntryRescore' || variant.tier === 'trail1rRescore') {
    return runRescoreVariant({ variantId, variant, historyDir, symbols });
  }

  setConfigOverride(variant.configOverride || null);
  try {
    const historyByTfAll = loadHistoryDir(historyDir, symbols);
    const rows = [];
    const firstEligibleBySymbol = {};
    for (const symbol of symbols) {
      const t0 = Date.now();
      const { rows: symbolRows, firstEligible } = await replayVariantSymbol({ symbol, historyByTf: historyByTfAll[symbol], ruleOpts: variant.ruleOpts, cfg: ENGINE_CONFIG, step });
      rows.push(...symbolRows);
      firstEligibleBySymbol[symbol] = firstEligible;
      console.log(`[variants] ${variantId} ${symbol}: ${symbolRows.length} GOOD calls in ${Date.now() - t0}ms (first eligible ${firstEligible})`);
    }
    const span = readSpan(historyDir, symbols);
    return { variantId, label: variant.label, symbols, historyDir, span, firstEligibleBySymbol, rows };
  } finally {
    setConfigOverride(null);
  }
}

// ---------------------------------------------------------------------------
// stats (docs/PROMPT_S2_VARIANTS.md's required columns): mean AND median net R, n,
// win %, gross R, calls/day, days with >=1, max losing streak, median stop %, OOS
// first/second half BY MEDIAN net R, pass = median net R > 0 in both halves.
// ---------------------------------------------------------------------------

const RESOLVED = new Set(['win', 'loss', 'timeout']);

export function statsFor(rows) {
  const resolved = rows.filter((r) => RESOLVED.has(r.status));
  const wins = resolved.filter((r) => r.grossR > 0);
  const avg = (arr) => (arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 4) : null);
  return {
    n: rows.length,
    resolved: resolved.length,
    winPct: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    grossExpR: avg(resolved.map((r) => r.grossR)),
    meanNetR: avg(resolved.map((r) => r.netR)),
    medianNetR: resolved.length ? median(resolved.map((r) => r.netR).filter(isFiniteNumber)) : null,
    medianStopPct: median(rows.map((r) => r.stopDistancePct).filter(isFiniteNumber))
  };
}

function maxLosingStreak(rows) {
  let max = 0;
  let cur = 0;
  for (const r of rows.slice().sort((a, b) => Date.parse(a.firstReadyAt) - Date.parse(b.firstReadyAt))) {
    if (r.status === 'loss' || (isFiniteNumber(r.grossR) && r.grossR < 0)) { cur++; if (cur > max) max = cur; }
    else if (r.status === 'win' || (isFiniteNumber(r.grossR) && r.grossR > 0)) cur = 0;
  }
  return max;
}

function daysWithAtLeast(rows, threshold) {
  const perDay = new Map();
  for (const r of rows) {
    const day = r.firstReadyAt.slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  let count = 0;
  for (const n of perDay.values()) if (n >= threshold) count++;
  return count;
}

/** First 2/3 of the span vs the last 1/3 (same convention as scripts/replay-rules.js splitHalves), BY MEDIAN net R per this study's own pass rule. */
export function splitHalvesByMedian(rows, spanFromMs, spanToMs) {
  if (!isFiniteNumber(spanFromMs) || !isFiniteNumber(spanToMs)) return { first: statsFor([]), second: statsFor([]) };
  const boundary = spanFromMs + Math.round((spanToMs - spanFromMs) * (2 / 3));
  const first = rows.filter((r) => Date.parse(r.firstReadyAt) < boundary);
  const second = rows.filter((r) => Date.parse(r.firstReadyAt) >= boundary);
  return { first: statsFor(first), second: statsFor(second) };
}

export function passesOOSByMedian(halves) {
  return isFiniteNumber(halves.first.medianNetR) && halves.first.medianNetR > 0
    && isFiniteNumber(halves.second.medianNetR) && halves.second.medianNetR > 0;
}

export function buildVariantSummary(result) {
  const { rows, span } = result;
  const stats = statsFor(rows);
  const spanFromMs = span ? span.fromMs : null;
  const spanToMs = span ? span.toMs : null;
  const totalDays = span ? round((spanToMs - spanFromMs) / 86400000, 2) : null;
  const halves = splitHalvesByMedian(rows, spanFromMs, spanToMs);
  return {
    variantId: result.variantId,
    label: result.label,
    stats,
    callsPerDay: totalDays ? round(rows.length / totalDays, 3) : null,
    daysWithAtLeast1: daysWithAtLeast(rows, 1),
    totalDays,
    maxLosingStreak: maxLosingStreak(rows),
    oos: halves,
    pass: passesOOSByMedian(halves)
  };
}

// ---------------------------------------------------------------------------
// doc rendering (single table + one-line readings)
// ---------------------------------------------------------------------------

function fmt(v, suffix = '') { return v === null || v === undefined ? '-' : `${v}${suffix}`; }

function tableRow(summary) {
  const s = summary.stats;
  return `| ${summary.variantId} | ${fmt(s.meanNetR)} | ${fmt(s.medianNetR)} | ${s.n} | ${fmt(s.winPct, '%')} | ${fmt(s.grossExpR)} | ${fmt(summary.callsPerDay)} | ${summary.daysWithAtLeast1}${summary.totalDays ? `/${Math.round(summary.totalDays)}` : ''} | ${summary.maxLosingStreak} | ${fmt(s.medianStopPct, '%')} | ${fmt(summary.oos.first.medianNetR)} / ${fmt(summary.oos.second.medianNetR)} | ${summary.pass ? 'PASS' : 'fail'} |`;
}

export function buildDoc(summaries, readings) {
  const header = [
    '# S2 - rule variants on the live flag calls',
    '',
    'Owner question (2026-09-26): after `docs/CONDITIONS_STUDY_2026-09-26.md` (95% of GOOD',
    'calls carry a stop < 0.5%, median net -3.2R; nothing but stop distance moves the',
    'number), test concrete rule changes side by side on the same 85 days. Research only -',
    'no live config change (engine rules frozen until 2026-10-08), no deploy, no orders.',
    '`scripts/research/variants.js`, `npm run study:variants`. Every variant is scored with',
    'the SAME scorer `scripts/research/conditions.js` (S1 Agent B) uses: first-ready call',
    'per candidateId, fill window/stop/TP1, `scripts/swing/run.js`\'s `scoreSignal` (24h',
    'timeout close-out, mark-to-market), net of direction-dependent round-trip cost (0.34%',
    'long / 0.14% short, `scripts/tracker/costs.js` `netR`).',
    '',
    `${Object.keys(VARIANTS).length} hypotheses tested (1 baseline + ${Object.keys(VARIANTS).length - 1} rule variants).`,
    '',
    '## Results (deep60-2026-09-24, BTC+SOL+ETH)',
    '',
    'OOS pass rule for this study (owner instruction): median net R > 0 in BOTH halves',
    '(first 2/3 vs last 1/3 of the fixture span by calendar time) - median, not mean, per',
    'the conditions study\'s own finding that a single near-zero-stop loss can dominate a',
    'bucket\'s mean net R.',
    '',
    '| variant | mean net R | median net R | n | win % | gross R | calls/day | days>=1 | max losing streak | median stop % | OOS 1st/2nd (median) | pass |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  const rows = summaries.map(tableRow);
  const readingLines = ['', '## Readings', ''].concat(summaries.map((s) => `- **${s.variantId}**: ${readings[s.variantId] || s.label}`));
  return header.concat(rows).concat(readingLines).join('\n') + '\n';
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
    out: typeof opts.out === 'string' ? opts.out : null,
    summary: typeof opts.summary === 'string' ? opts.summary : null,
    doc: typeof opts.doc === 'string' ? opts.doc : null,
    summaries: list(opts.summaries)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.doc) {
    if (!args.summaries || !args.summaries.length) throw new Error('need --summaries <file1,file2,...> with --doc');
    const summaries = args.summaries.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    const readings = {}; // filled in by hand in the committed doc; CLI output is the table skeleton
    mkdirSync(path.dirname(args.doc), { recursive: true });
    writeFileSync(args.doc, buildDoc(summaries, readings));
    console.log(`[variants] wrote ${args.doc}`);
    return;
  }

  if (!args.variant || !args.history) throw new Error(`need --variant <id> --history <dir> (variants: ${Object.keys(VARIANTS).join(', ')})`);
  const symbols = args.symbols || SYMBOLS;
  const result = await runVariant({ variantId: args.variant, historyDir: args.history, symbols, step: args.step });
  const summary = buildVariantSummary(result);
  console.log(`\n[variants] ${result.variantId} - ${result.label}`);
  console.log(`  n=${summary.stats.n} resolved=${summary.stats.resolved} winRate=${fmt(summary.stats.winPct, '%')} meanNetR=${fmt(summary.stats.meanNetR)} medianNetR=${fmt(summary.stats.medianNetR)} medianStop=${fmt(summary.stats.medianStopPct, '%')}`);
  console.log(`  callsPerDay=${fmt(summary.callsPerDay)} daysWithAtLeast1=${summary.daysWithAtLeast1}/${summary.totalDays ? Math.round(summary.totalDays) : '-'} maxLosingStreak=${summary.maxLosingStreak}`);
  console.log(`  OOS median: first=${fmt(summary.oos.first.medianNetR)} second=${fmt(summary.oos.second.medianNetR)} -> ${summary.pass ? 'PASSES' : 'does not pass'}`);

  if (args.out) {
    mkdirSync(path.dirname(args.out), { recursive: true });
    // one file per symbol, mirroring scripts/research/conditions.js's --out convention,
    // so rescore-tier variants (GP-entry, exit-trail1r) can load a base variant's rows
    // per symbol without re-parsing a combined file.
    for (const symbol of symbols) {
      const symbolRows = result.rows.filter((r) => r.symbol === symbol);
      const perSymbolOut = symbols.length > 1 ? args.out.replace(/(\.jsonl)?$/, (m) => `.${symbol}${m || '.jsonl'}`) : args.out;
      writeFileSync(perSymbolOut, symbolRows.map((r) => JSON.stringify(r)).join('\n') + (symbolRows.length ? '\n' : ''));
    }
  }
  if (args.summary) {
    mkdirSync(path.dirname(args.summary), { recursive: true });
    writeFileSync(args.summary, `${JSON.stringify(summary, null, 2)}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[variants] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

export default {
  VARIANTS, runVariant, parseArgs, statsFor, buildVariantSummary, splitHalvesByMedian, passesOOSByMedian, buildDoc,
  buildResearchPlan, selectBestAttempt, mirrorNearestRoomAhead, recomputeConfidenceRsi, rsiSlopeScore, ema21HoldCategory,
  macdHistogramSign, goldenPocketZone, walkTrail1R, rescoreGpEntryRow
};
