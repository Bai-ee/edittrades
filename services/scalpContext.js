/**
 * Scalp Context Builder
 *
 * Assembles a compact, LLM/agent-friendly multi-symbol, multi-timeframe
 * snapshot (candles, indicators, structure, strategies) for BTC/SOL/ETH.
 * Never throws: any missing/failed data is recorded as a warning and the
 * corresponding slice of the payload is emitted with nulls/empties instead.
 */

import * as marketData from './marketData.js';
import * as indicatorService from './indicators.js';
import strategyService from './strategy.js';
import { buildStructure } from '../lib/structure.js';
import { getAccountSnapshot, emptySnapshot as emptyAccountSnapshot } from './walletTracker.js';
import { ENGINE_CONFIG, CONFIG_VERSION } from '../config/engine.js';
import { maxLeverageForStop, positionPlan } from '../lib/riskEngine.js';
import { DIRECTIONS, detectFlagLifecycle, measuredMoveFor } from '../lib/patternDetector.js';
import { buildGeometryContext, buildGeometryB, geometryTraceSummary, nearMissDiagonals, swingPivots } from '../lib/geometry.js';
import { geometryTimeframeFor, snapCandidateLevels, resolveCoils, buildVisualGate, identifyCandidate } from '../lib/patternLifecycle.js';
import { attachQualification } from '../lib/candidateQualifier.js';
import { buildFlagTradePlan } from '../lib/flagTradePlan.js';
import { buildModelEvidence } from '../lib/modelEvidence.js';
import { buildFlagRecommendation, compactRecommendation } from '../lib/flagRecommendation.js';
import { buildPathOutlook } from '../lib/pathOutlook.js';
import { buildBiasMatrix, buildAlignment, buildDecisionInputs, zonesFromGeometry, biasTraceSummary } from '../lib/biasMatrix.js';
import { buildWeeklyLean, buildTopDown, buildAboveBelow200 } from '../lib/topDown.js';
import { fetchPythMarks, buildMark, markTraceToken, compactMark } from '../lib/pythMark.js';

export const SYMBOLS = ['BTC', 'SOL', 'ETH'];
export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

// Published candles per timeframe (payload only; the engine computes on the full closed
// window). 1m/3m/5m went 30 -> 24 on 2026-09-23 to keep the default payload under 80 KB;
// F1 (flag detection coverage) took them 24 -> 20 the same day for the same reason - the
// wider flag.maxImpulseCandles lookback and the new proto/failedTtl/expiredTtl states
// (F1 items 1-5) legitimately surface more candidates, each carrying F1's own new
// identity/geometry/qualification fields (items 6-8), and the two together pushed the
// live default payload past 79 KB. 20 candles is still 20 minutes of 1m history.
// 15m/1h 24 -> 20 in the review fix pass (2026-09-23, config 2026.09.23-4) for the same
// default cap (the engine still computes on the full closed window). Cap raised
// 79,000 -> 80,200 B (2026-09-24, T6 completion plan A1, owner-approved, minimal): a
// synthetic worst case (3 symbols x 6 simultaneous failed-in-TTL candidates + 1 ready
// plan each) measured 80,148 B after removing `breakoutEntry` from the payload and
// dropping flagSlope/breakoutDistancePct/invalidationDistancePct/levelSource (schema
// 1.22.0, confirmed unread by any consumer - see openapi/scalp-context.yaml); the
// remaining gap on that extreme tail case was judged not worth a further field cut.
// Compact cap stays 45,000 B (already passes, no change). See test-scalp-context.js's
// "T6 completion plan A1" test.
export const CANDLE_LIMITS = {
  '1m': 20,
  '3m': 20,
  '5m': 20,
  '15m': 20,
  '1h': 20,
  '4h': 20,
  '1d': 10
};

export const INTERVAL_MS = {
  '1m': 60000,
  '3m': 180000,
  '5m': 300000,
  '15m': 900000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000
};

const SYMBOL_PAIR_MAP = {
  BTC: 'BTCUSDT',
  SOL: 'SOLUSDT',
  ETH: 'ETHUSDT'
};

// Timeframes ordered smallest-first, used for price fallback selection.
const TF_SIZE_ORDER = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

// biasMatrix's long/short/neutral vocabulary mapped to lib/topDown.js's bull/bear/neutral
// (Q3, trading-model quick pass): the two modules describe the same lean, different words.
const BIAS_TO_SENTIMENT = { long: 'bull', short: 'bear', neutral: 'neutral' };

const FETCH_LIMIT = 500;
const MAX_CONCURRENCY = 6;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Round a number to N decimals, or null when not finite.
 * @param {*} value
 * @param {number} decimals
 * @returns {number|null}
 */
function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Round to 2 decimals, or null when not finite.
 * @param {*} value
 * @returns {number|null}
 */
function round2(value) {
  return roundN(value, 2);
}

/**
 * Tiny bounded-concurrency map helper (no new dependencies).
 * @param {Array} items
 * @param {number} limit
 * @param {(item:any, index:number)=>Promise<any>} iteratee
 * @returns {Promise<Array>}
 */
async function mapLimit(items, limit, iteratee) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker() {
    while (cursor < items.length) {
      const current = cursor++;
      results[current] = await iteratee(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * Basic OHLCV shape check.
 * @param {*} c
 * @returns {boolean}
 */
function isValidCandle(c) {
  return !!c &&
    isFiniteNumber(c.timestamp) &&
    isFiniteNumber(c.open) &&
    isFiniteNumber(c.high) &&
    isFiniteNumber(c.low) &&
    isFiniteNumber(c.close);
}

/**
 * Remove any candle that has not fully closed yet (or is garbage).
 * A candle is closed when (closeTime ?? timestamp + INTERVAL_MS[interval]) <= now.
 * Never mutates the input array or its candles.
 * @param {Array<Object>} candles
 * @param {string} interval - one of TIMEFRAMES
 * @param {number} [now=Date.now()]
 * @returns {Array<Object>} new array of closed candles
 */
export function dropUnclosedCandles(candles, interval, now = Date.now()) {
  if (!Array.isArray(candles)) return [];

  const intervalMs = INTERVAL_MS[interval];
  const safeNow = isFiniteNumber(now) ? now : Date.now();
  const out = [];

  for (const candle of candles) {
    if (!isValidCandle(candle)) continue;

    const closeTime = isFiniteNumber(candle.closeTime)
      ? candle.closeTime
      : (isFiniteNumber(intervalMs) ? candle.timestamp + intervalMs : NaN);

    if (!isFiniteNumber(closeTime)) continue;
    if (closeTime <= safeNow) out.push(candle);
  }

  return out;
}

/**
 * Clamp a stoch value to [0, 100] and round to 2 decimals, or null.
 * @param {*} value
 * @returns {number|null}
 */
function clamp0to100(value) {
  if (!isFiniteNumber(value)) return null;
  return round2(Math.min(100, Math.max(0, value)));
}

/**
 * Derive a compact Stochastic RSI read from history.
 * @param {Array<{k:number,d:number}>|null|undefined} history
 * @returns {{k:number|null,d:number|null,state:string|null,cross:string|null,slopeK:number|null,slopeD:number|null}}
 */
export function deriveStochRsi(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { k: null, d: null, state: null, cross: null, slopeK: null, slopeD: null };
  }

  const last = history[history.length - 1];
  const k = clamp0to100(last && last.k);
  const d = clamp0to100(last && last.d);

  let state = null;
  if (k !== null && d !== null) {
    if (k > 80 && d > 80) state = 'OVERBOUGHT';
    else if (k < 20 && d < 20) state = 'OVERSOLD';
    else if (k > d) state = 'BULLISH';
    else if (k < d) state = 'BEARISH';
    else state = 'NEUTRAL';
  }

  let cross = null;
  let slopeK = null;
  let slopeD = null;

  if (history.length >= 2) {
    const prev = history[history.length - 2];
    const pk = clamp0to100(prev && prev.k);
    const pd = clamp0to100(prev && prev.d);

    if (pk !== null && pd !== null && k !== null && d !== null) {
      if (pk <= pd && k > d) cross = 'BULLISH_CROSS';
      else if (pk >= pd && k < d) cross = 'BEARISH_CROSS';
      else cross = 'NONE';
    } else {
      cross = 'NONE';
    }

    if (pk !== null && k !== null) slopeK = round2(k - pk);
    if (pd !== null && d !== null) slopeD = round2(d - pd);
  }

  return { k, d, state, cross, slopeK, slopeD };
}

/**
 * Deep-clone a value for safe JSON output: NaN/Infinity/-Infinity/undefined
 * become null, undefined object properties are dropped, and cycles are
 * broken (converted to null).
 * @param {*} value
 * @param {WeakSet} [seen]
 * @returns {*}
 */
export function normalizeJson(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null;

  const type = typeof value;

  if (type === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (type === 'string' || type === 'boolean') {
    return value;
  }
  if (type !== 'object') {
    // functions, symbols, bigint, etc. have no safe JSON representation
    return null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (seen.has(value)) return null; // cycle guard
  seen.add(value);

  if (Array.isArray(value)) {
    const arr = value.map((item) => normalizeJson(item, seen));
    seen.delete(value);
    return arr;
  }

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue; // drop undefined properties
    out[key] = normalizeJson(v, seen);
  }
  seen.delete(value);
  return out;
}

/**
 * Format a closed candle for the compact payload.
 * @param {Object} candle
 * @returns {{t:string|null,o:number|null,h:number|null,l:number|null,c:number|null,v:number|null}}
 */
function formatCandleOut(candle) {
  return {
    t: isFiniteNumber(candle.timestamp) ? new Date(candle.timestamp).toISOString() : null,
    o: round2(candle.open),
    h: round2(candle.high),
    l: round2(candle.low),
    c: round2(candle.close),
    v: round2(candle.volume)
  };
}

/**
 * The last `n` values of an indicator history that is tail-aligned to the closed
 * candles, i.e. the values for the published candle window. Missing leading values
 * (history shorter than the window) are null.
 * @param {Array<number>} history
 * @param {number} n
 * @returns {Array<number|null>}
 */
function windowSeries(history, n) {
  const h = Array.isArray(history) ? history : [];
  return Array.from({ length: n }, (_, j) => {
    const v = h[h.length - n + j];
    return isFiniteNumber(v) ? v : null;
  });
}

/**
 * @returns {Object} a fully-null timeframe entry (used when data is unusable)
 */
function nullTimeframeEntry() {
  return {
    candles: [],
    ema21: null,
    ema200: null,
    priceVs21Pct: null,
    priceVs200Pct: null,
    trend: null,
    stochRsi: { k: null, d: null, state: null, cross: null, slopeK: null, slopeD: null },
    closedThrough: null,
    candleCount: 0
  };
}

/**
 * @returns {Object} a fully-null structure block
 */
function nullStructure() {
  return {
    sessionHigh: null,
    sessionLow: null,
    prevDayHigh: null,
    prevDayLow: null,
    swingHighs: [],
    swingLows: [],
    support: [],
    resistance: [],
    aboveEma21: null,
    aboveEma200: null
  };
}

/**
 * Coerce a value to a finite number, or null.
 *
 * Nothing is fabricated here: a missing or non-finite engine level becomes null so
 * a consumer can tell "the engine did not produce this level" from a real price.
 *
 * @param {*} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

/**
 * Normalize an engine entry zone to { min, max }, dropping non-finite bounds.
 * @param {*} zone
 * @returns {{min:number|null,max:number|null}}
 */
function normalizeEntryZone(zone) {
  if (!zone || typeof zone !== 'object') return { min: null, max: null };
  return { min: finiteOrNull(zone.min), max: finiteOrNull(zone.max) };
}

/**
 * Normalize engine targets to an array of finite prices, preserving order.
 * Unavailable targets collapse to [] rather than [null, null].
 * @param {*} targets
 * @returns {Array<number>}
 */
function normalizeTargets(targets) {
  if (!Array.isArray(targets)) return [];
  return targets.filter(isFiniteNumber);
}

/**
 * Normalize an engine risk/reward block, dropping non-finite ratios.
 * @param {*} rr
 * @returns {{tp1RR:number|null,tp2RR:number|null}}
 */
function normalizeRiskReward(rr) {
  if (!rr || typeof rr !== 'object') return { tp1RR: null, tp2RR: null };
  return { tp1RR: finiteOrNull(rr.tp1RR), tp2RR: finiteOrNull(rr.tp2RR) };
}

// Canonical strategy names, in the order evaluateAllStrategies always populates them.
const STRATEGY_NAMES = ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP'];

// Ordered classifiers for a strategy's `reason` string into a short rejectedAt code.
// First match wins. Purely a payload-readability aid: it reads the reason text
// evaluateAllStrategies already produces, it never changes what that text says.
const REJECTION_PATTERNS = [
  [/scalp stop distance/i, 'stop-distance'],
  [/4H trend is FLAT/i, 'htf-flat'],
  [/RR\s+[\d.]+R\s*(below|<)\s*minimum/i, 'risk-reward'],
  [/confidence\s+[\d.]+%\s*below minimum/i, 'confidence'],
  [/counter-trend|blocked by strong HTF/i, 'counter-trend'],
  [/too far from (?:EMA21|21 EMA)|EMA distance/i, 'ema-distance'],
  [/no signal returned/i, 'insufficient-data'],
  [/failed validation|wrong side/i, 'invalid-signal'],
  [/strategy evaluation failed|evaluation failed/i, 'evaluation-error'],
  [/insufficient .*data/i, 'insufficient-data'],
  // evaluateAllStrategies' final fallback when nothing else fired (services/strategy.js).
  // Ordered last among the specific patterns, still before the generic catch-all below.
  [/No clean SWING \/ 4H Trend/i, 'no-setup']
];

/**
 * Classify a strategy's rejection reason into a short, stable code.
 * Always reads the full, untruncated reason text, so a long explanation
 * clipped by truncateReason() below still classifies correctly.
 * @param {*} reason
 * @returns {string}
 */
export function classifyRejection(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return 'unspecified';
  for (const [pattern, code] of REJECTION_PATTERNS) {
    if (pattern.test(reason)) return code;
  }
  return 'setup-conditions';
}

// Strategy engine reason strings are free-form prose and not bounded in length.
// decisionTrace trims them so five strategies plus a window block stay inside
// the ~2KB per-symbol budget; classifyRejection above always sees the original.
const REASON_MAX_LEN = 140;

/**
 * Trim a reason string to the decisionTrace budget, or null.
 * @param {*} reason
 * @returns {string|null}
 */
function truncateReason(reason) {
  if (typeof reason !== 'string' || reason.length === 0) return null;
  if (reason.length <= REASON_MAX_LEN) return reason;
  return `${reason.slice(0, REASON_MAX_LEN - 1).trimEnd()}…`;
}

/**
 * Build the per-strategy decision trace entries from evaluateAllStrategies'
 * untrimmed strategies dict. One entry per canonical strategy name, always,
 * so a caller never has to guess whether a name is missing on purpose.
 * @param {Object|null} rawStrategies - result.strategies from evaluateAllStrategies
 * @returns {Array<{name:string, ran:boolean, valid:boolean, rejectedAt:string|null, reason:string|null}>}
 */
export function buildStrategyTrace(rawStrategies) {
  const out = [];
  for (const name of STRATEGY_NAMES) {
    const s = rawStrategies && rawStrategies[name];
    if (!s || typeof s !== 'object') {
      out.push({
        name,
        ran: false,
        valid: false,
        rejectedAt: 'evaluation-error',
        reason: 'strategy did not report a result'
      });
      continue;
    }
    const valid = !!s.valid;
    out.push({
      name,
      ran: true,
      valid,
      rejectedAt: valid ? null : classifyRejection(s.reason),
      reason: truncateReason(s.reason)
    });
  }
  return out;
}

/**
 * Build the compute-window block: last closed-candle time and count, per requested
 * timeframe. Phase 11 dropped `from` (the oldest candle's open time) to recover payload
 * bytes: `to` + `closedCandles` already pin the window precisely enough for the GPT to
 * reason about recency, and the window start was never read by any instruction rule.
 * @param {Object} closedByTf - tf -> full closed candle array (pre-trim)
 * @param {Object} tfEntries - tf -> published timeframe entry (for closedThrough)
 * @param {Array<string>} timeframeList
 * @returns {Object}
 */
export function buildTimeframeWindow(closedByTf, tfEntries, timeframeList) {
  const window = {};
  for (const tf of timeframeList) {
    const closed = (closedByTf && closedByTf[tf]) || [];
    const entry = tfEntries && tfEntries[tf];
    window[tf] = {
      to: (entry && entry.closedThrough) || null,
      closedCandles: closed.length
    };
  }
  return window;
}

/**
 * Build the per-symbol decisionTrace: why each strategy did or didn't fire,
 * why bestSignal is what it is, and the exact candle window compute ran on.
 * Additive only - never changes a strategy decision, only explains it.
 * @param {Object} params
 * @param {Object|null} params.rawStrategies - result.strategies from evaluateAllStrategies
 * @param {string|null} params.bestSignal
 * @param {string} params.evaluatedAt - ISO timestamp
 * @param {Object} params.window - buildTimeframeWindow(...) output
 * @param {Array<Object>} [params.candidateSetups] - the symbol's candidateSetups (phase 4)
 * @param {Object|null} [params.geometryContext] - the symbol's geometryContext by timeframe (phase 7)
 * @param {Object|null} [params.visualGate] - buildVisualGate(...) output (phase 9)
 * @returns {Object}
 */
export function buildDecisionTrace({ rawStrategies, bestSignal, evaluatedAt, window, candidateSetups = [], geometryContext = null, visualGate = null, bias = null }) {
  const bestEntry = bestSignal && rawStrategies ? rawStrategies[bestSignal] : null;
  return {
    configVersion: CONFIG_VERSION,
    evaluatedAt,
    strategies: buildStrategyTrace(rawStrategies),
    bestSignal: bestSignal || null,
    bestSignalReason: bestEntry ? truncateReason(bestEntry.reason) : null,
    window,
    // Compact "timeframe:direction:state" references only: the full candidates live on
    // symbols.<SYM>.candidateSetups, and copying them here breaks the ~2KB trace budget.
    // A failed candidate adds its failReason as a fourth token (phase 9b), so "why did it
    // fail" is answerable while flag.includeFailed keeps the full object out.
    candidateSetups: candidateSetups.map(({ timeframe, direction, state, failReason }) => (
      state === 'failed' && failReason ? `${timeframe}:${direction}:${state}:${failReason}` : `${timeframe}:${direction}:${state}`)),
    // Same idea for geometry (phase 7): one compact string per timeframe, full objects on
    // symbols.<SYM>.geometryContext. Null when no geometry was built for the symbol.
    geometry: geometryContext ? geometryTraceSummary(geometryContext) : null,
    // Visual gate (phase 9): when true, request the chart named in visualTarget (phase
    // 8b) or ask the user for that screenshot. Never true without a candidate.
    needsVisualConfirmation: visualGate ? visualGate.needsVisualConfirmation : false,
    visualTarget: visualGate ? visualGate.visualTarget : null,
    unresolvedGeometry: visualGate ? visualGate.unresolvedGeometry : [],
    // Bias summary (phase 9b): biasTraceSummary(...) string, the only bias field in the
    // default payload. Full objects are opt-in via includeBias / include: bias.
    bias
  };
}

/**
 * Trim a strategy result down to the essentials so the payload stays small.
 *
 * The execution levels the engine already calculated (entry zone, stop, targets,
 * risk/reward, stop source) are carried through verbatim, because a consumer that
 * only sees valid/direction/confidence has no way to act on - or disagree with - a
 * signal. Nothing is invented: a level the engine did not produce stays null (or
 * [] for targets).
 *
 * @param {Object} strategies - strategyService.evaluateAllStrategies(...).strategies
 * @returns {Object}
 */
function trimStrategies(strategies) {
  const out = {};
  if (!strategies || typeof strategies !== 'object') return out;

  for (const [name, s] of Object.entries(strategies)) {
    if (!s || typeof s !== 'object') continue;
    out[name] = {
      valid: !!s.valid,
      direction: s.direction || 'NO_TRADE',
      confidence: isFiniteNumber(s.confidence) ? s.confidence : 0,
      reason: s.reason || null,
      entryZone: normalizeEntryZone(s.entryZone),
      stopLoss: finiteOrNull(s.stopLoss),
      invalidationLevel: finiteOrNull(s.invalidationLevel),
      targets: normalizeTargets(s.targets),
      riskReward: normalizeRiskReward(s.riskReward),
      stopSource: typeof s.stopSource === 'string' ? s.stopSource : null,
      entryType: typeof s.entryType === 'string' ? s.entryType : null
    };
  }
  return out;
}

/**
 * Attach a per-strategy `risk` block to already-trimmed VALID strategies, computed from
 * account.margin.usd. Additive: invalid strategies are left untouched (no `risk` key at
 * all - an invalid signal has nothing to size). Never invents margin: when it is
 * unavailable, every valid strategy gets a risk block of nulls with a reason instead of
 * numbers. Does not touch position-based fields - `account.positions[]` does not exist
 * until Phase 3b.
 *
 * Sizing is against `collateralUsd = min(cfg.defaultMarginUsd, account.margin.usd)`, not
 * the whole wallet: the "~$10, up to 100x" preference trades a slice of the wallet as
 * collateral, not the entire balance. The 2% wallet-risk cap still measures against the
 * full `account.margin.usd`, so a small collateralUsd cannot quietly loosen it (see
 * `positionPlan`'s `walletMarginUsd` param). `collateralUsd` is published so a caller
 * knows what the leverage/loss figures were sized against.
 * @param {Object} strategies - trimStrategies(...) output, mutated in place
 * @param {Object} account - buildScalpContext's fetched account snapshot
 * @returns {Object} the same strategies object
 */
export function attachRisk(strategies, account) {
  const sizing = riskSizing(account);

  for (const s of Object.values(strategies || {})) {
    if (!s || !s.valid) continue;

    const zoneMin = s.entryZone && isFiniteNumber(s.entryZone.min) ? s.entryZone.min : null;
    const zoneMax = s.entryZone && isFiniteNumber(s.entryZone.max) ? s.entryZone.max : null;
    const entryMid = zoneMin !== null && zoneMax !== null
      ? (zoneMin + zoneMax) / 2
      : (zoneMin !== null ? zoneMin : zoneMax);

    s.risk = riskBlock(entryMid, s.stopLoss, sizing);
  }

  return strategies;
}

/**
 * Wallet and collateral figures every risk block is sized against (see attachRisk).
 * @param {Object} account
 * @returns {{walletMarginUsd:number|null, collateralUsd:number|null}}
 */
function riskSizing(account) {
  const cfg = ENGINE_CONFIG.risk;
  const walletMarginUsd = account && account.margin && isFiniteNumber(account.margin.usd) && account.margin.usd > 0
    ? account.margin.usd
    : null;
  const collateralUsd = walletMarginUsd !== null ? Math.min(cfg.defaultMarginUsd, walletMarginUsd) : null;
  return { walletMarginUsd, collateralUsd };
}

/**
 * One risk block for an entry and a stop - the shared body of attachRisk (strategies)
 * and attachCandidateRisk (flag candidates), so both publish the same shape from the
 * same math.
 * @param {number|null} entry
 * @param {number|null} stop
 * @param {{walletMarginUsd:number|null, collateralUsd:number|null}} sizing - riskSizing(...)
 * @returns {Object} Risk
 */
function riskBlock(entry, stop, { walletMarginUsd, collateralUsd }) {
  const cfg = ENGINE_CONFIG.risk;

  if (collateralUsd === null) {
    return { maxLeverage: null, suggestedLeverage: null, lossAtStopUsd: null, lossAtStopPct: null, lossAtStopPctOfWallet: null, collateralUsd: null, reason: 'account unavailable' };
  }

  const stopDistancePct = isFiniteNumber(entry) && entry > 0 && isFiniteNumber(stop)
    ? (Math.abs(entry - stop) / entry) * 100
    : null;

  if (stopDistancePct === null || stopDistancePct <= 0) {
    return { maxLeverage: null, suggestedLeverage: null, lossAtStopUsd: null, lossAtStopPct: null, lossAtStopPctOfWallet: null, collateralUsd: null, reason: 'invalid entry/stop levels' };
  }

  const maxLev = maxLeverageForStop(stopDistancePct, cfg);
  const plan = positionPlan({
    marginUsd: collateralUsd,
    walletMarginUsd,
    stopDistancePct,
    leverageRequested: cfg.maxLeverage,
    maxWalletRiskPct: cfg.maxWalletRiskPct
  }, cfg);

  // lossAtStopPct (above) is percent of collateralUsd - a small sliced-off stake, not
  // the wallet. lossAtStopPctOfWallet (phase 5, item H) is the same loss measured
  // against the whole wallet, since lossAtStopPct alone reads as wallet risk and isn't.
  const lossAtStopPctOfWallet = isFiniteNumber(plan.lossAtStopUsd) && walletMarginUsd > 0
    ? round2((plan.lossAtStopUsd / walletMarginUsd) * 100)
    : null;

  return {
    maxLeverage: maxLev,
    suggestedLeverage: plan.leverage,
    lossAtStopUsd: plan.lossAtStopUsd,
    lossAtStopPct: plan.lossAtStopPct,
    lossAtStopPctOfWallet,
    collateralUsd: round2(collateralUsd),
    reason: null
  };
}

// Candidate states that carry a risk block (phase 7, item F). `forming` has no break to
// enter on and `failed` has nothing to enter; neither gets a `risk` key.
const RISK_CANDIDATE_STATES = ['triggering', 'confirmed'];

/**
 * Attach a `risk` block to flag candidates that are actionable now: state triggering or
 * confirmed, and not a chase. Entry = breakoutLevel, stop = invalidation, sized exactly
 * like a strategy signal (riskBlock). A stop on the wrong side of the entry for the
 * candidate's direction reads as invalid levels rather than being sized. Mutates the
 * candidate objects in place; every other candidate is left with no `risk` key.
 * @param {Array<Object>} setups - a symbol's candidateSetups
 * @param {Object} account
 * @returns {Array<Object>} the same array
 */
export function attachCandidateRisk(setups, account) {
  const sizing = riskSizing(account);
  for (const c of setups || []) {
    if (!c || !RISK_CANDIDATE_STATES.includes(c.state) || c.chaseRisk !== false) continue;
    const sign = c.direction === 'short' ? -1 : 1;
    const stopOnSide = isFiniteNumber(c.breakoutLevel) && isFiniteNumber(c.invalidation)
      && sign * (c.breakoutLevel - c.invalidation) > 0;
    c.risk = riskBlock(c.breakoutLevel, stopOnSide ? c.invalidation : null, sizing);
  }
  return setups;
}

/**
 * Build the top-level `config` snapshot (phase 5, item G): the tunable constants a
 * caller needs to interpret risk/reward figures without a second request. Values
 * only, straight from ENGINE_CONFIG - nothing here is computed or duplicates logic
 * that lives elsewhere.
 * @param {boolean} [includeFailed=ENGINE_CONFIG.flag.includeFailed]
 * @returns {Object}
 */
export function buildConfigSnapshot(includeFailed = ENGINE_CONFIG.flag.includeFailed) {
  return {
    scalp: { maxStopDistancePct: ENGINE_CONFIG.scalp.maxStopDistancePct },
    riskReward: {
      bySetupType: ENGINE_CONFIG.riskReward.bySetupType,
      byStrategy: ENGINE_CONFIG.riskReward.byStrategy
    },
    risk: {
      maxLeverage: ENGINE_CONFIG.risk.maxLeverage,
      maxWalletRiskPct: ENGINE_CONFIG.risk.maxWalletRiskPct,
      defaultMarginUsd: ENGINE_CONFIG.risk.defaultMarginUsd,
      liquidationBufferPct: ENGINE_CONFIG.risk.liquidationBufferPct,
      maintenanceMarginPct: ENGINE_CONFIG.risk.maintenanceMarginPct,
      feeBps: ENGINE_CONFIG.risk.feeBps,
      slippageBps: ENGINE_CONFIG.risk.slippageBps
    },
    flag: { includeFailed }
  };
}

/**
 * Drop `state: failed` entries from a symbol's published candidateSetups[] (phase 5,
 * item J), except a failure still inside `flag.failedTtlCandles` of its own timeframe
 * (F1 item 4) - those stay regardless of `includeFailed`, carrying `failReason` and
 * `failedAt`. Older failures (or one with no `failedAt` to measure from) follow
 * `includeFailed` as before. decisionTrace.candidateSetups is built from the unfiltered
 * array before this runs, so a dropped failure is still visible there as a compact
 * reference string.
 * @param {Array<Object>} setups
 * @param {boolean} includeFailed
 * @param {Object} [opts]
 * @param {Object<string,string>} [opts.closedThroughByTf] - tf -> that timeframe's
 *   closedThrough ISO string this build, the same anchor `failedAt` was computed from
 * @param {number} [opts.failedTtlCandles=ENGINE_CONFIG.flag.failedTtlCandles]
 * @returns {Array<Object>}
 */
export function filterFailedCandidateSetups(setups, includeFailed, opts = {}) {
  if (!Array.isArray(setups)) return [];
  if (includeFailed) return setups;
  const { closedThroughByTf = {}, failedTtlCandles = ENGINE_CONFIG.flag.failedTtlCandles } = opts;
  return setups.filter((s) => {
    if (!s || s.state !== 'failed') return true;
    const intervalMs = INTERVAL_MS[s.timeframe];
    const closedThroughIso = closedThroughByTf[s.timeframe];
    if (typeof s.failedAt !== 'string' || typeof closedThroughIso !== 'string' || !isFiniteNumber(intervalMs)) return false;
    const ageMs = Date.parse(closedThroughIso) - Date.parse(s.failedAt);
    return isFiniteNumber(ageMs) && ageMs / intervalMs <= failedTtlCandles;
  });
}

/**
 * Drop `poleHeight` from published candidateSetups (2026-09-23 follow-up item 1a): it is
 * redundant with the already-published `|measuredTarget - breakoutLevel|` and was the
 * single largest quick-pass contributor to the default payload. Stays on the flag
 * detector's own output (lib/patternDetector.js) and is still read internally, before
 * this runs, to recompute measuredTarget after geometry snapping.
 * @param {Array<Object>} setups
 * @returns {Array<Object>} new array; input is never mutated
 */
// Review fix 6b: a failed candidate is history, not a setup - the default payload keeps
// only what identifies it and why it failed. decisionTrace tokens are built from the
// full objects before this runs, so they are unchanged.
const FAILED_CANDIDATE_KEYS = ['timeframe', 'type', 'direction', 'state', 'failReason', 'failedAt', 'candidateId', 'breakoutLevel', 'invalidation', 'confidence', 'qual'];

/**
 * Slim `state: 'failed'` candidates to FAILED_CANDIDATE_KEYS; every other state passes
 * through unchanged. Pure: returns new objects, never mutates.
 * @param {Array<Object>} setups
 * @returns {Array<Object>}
 */
export function slimFailedCandidates(setups) {
  if (!Array.isArray(setups)) return setups;
  return setups.map((c) => {
    if (!c || c.state !== 'failed') return c;
    const out = {};
    for (const key of FAILED_CANDIDATE_KEYS) if (key in c) out[key] = c[key];
    return out;
  });
}

export function stripPoleHeight(setups) {
  if (!Array.isArray(setups)) return setups;
  return setups.map(({ poleHeight, ...rest }) => rest);
}

/**
 * T6 completion plan A1 (docs/PLAN_T6_COMPLETION_V2.md, payload cap fix): drop
 * `flagSlope`, `breakoutDistancePct`, `invalidationDistancePct` and `levelSource` from
 * every published candidate. Confirmed unread by any consumer in this codebase - not in
 * `docs/GPT_INSTRUCTIONS.md`'s field table (explicitly "not named in the instructions
 * box" there), not in `scripts/tracker/records.js`'s capture whitelist, not read by
 * `lib/pathOutlook.js` or `scripts/tracker/flag-paths.js`'s feature bucketing (unlike
 * `compressionScore`/`durationCandles`/`impulseStrength`/`flagHigh`/`flagLow`, which
 * those DO read and this keeps). Same precedent as the `impulseStart`/`impulseEnd` drop
 * (2026-09-23, `docs/EDITTRADES_MCP_CONNECTOR.md`'s work log): still computed and
 * available internally (`lib/patternDetector.js`) for whatever needs them before this
 * runs; only the published shape is smaller. Runs on every state, not just failed - a
 * failed candidate never carried these fields anyway (`FAILED_CANDIDATE_KEYS`), so this
 * is a no-op there.
 * @param {Array<Object>} setups
 * @returns {Array<Object>}
 */
export function stripUnusedGeometryFields(setups) {
  if (!Array.isArray(setups)) return setups;
  return setups.map(({ flagSlope, breakoutDistancePct, invalidationDistancePct, levelSource, ...rest }) => rest);
}

// Valid `include` tokens for filterPayload (phase 5, item A + G). 'geometry' gates
// symbols.<SYM>.geometryContext (phase 7).
export const INCLUDE_TOKENS = ['timeframes', 'strategies', 'candidates', 'geometry', 'account', 'trace', 'config', 'bias', 'model'];

/** Phase 9b: symbol keys carried only when the build ran with includeBias. */
const BIAS_SECTION_KEYS = ['biasMatrix', 'alignment', 'decisionInputs', 'topDown'];

/**
 * True when an include list asks for the bias section. Callers pass the result to
 * buildScalpContext({ includeBias }) because bias objects are opt-in: a build without it
 * never carries them, so filterPayload(payload, {}) stays the identity.
 * @param {*} include
 * @returns {boolean}
 */
export function wantsBias(include) {
  return Array.isArray(include) && include.some((s) => typeof s === 'string' && s.trim().toLowerCase() === 'bias');
}

export function wantsModel(include) {
  return Array.isArray(include) && include.some((s) => typeof s === 'string' && s.trim().toLowerCase() === 'model');
}

const SYMBOL_SECTION_KEYS = {
  timeframes: 'timeframes',
  strategies: 'strategies',
  candidates: 'candidateSetups',
  geometry: 'geometryContext',
  trace: 'decisionTrace',
  model: 'model'
};

const TOP_LEVEL_SECTION_KEYS = { account: 'account', config: 'config' };

/**
 * Drop the `candles` array from every timeframe entry, leaving the already-computed
 * last-value indicators (ema21, ema200, stochRsi, trend, ...) untouched. Never
 * mutates its input.
 * @param {Object} timeframesObj
 * @returns {Object}
 */
function compactTimeframes(timeframesObj) {
  if (!timeframesObj || typeof timeframesObj !== 'object') return timeframesObj;
  const out = {};
  for (const [tf, entry] of Object.entries(timeframesObj)) {
    out[tf] = entry && typeof entry === 'object' ? { ...entry, candles: [] } : entry;
  }
  return out;
}

/**
 * Narrow one symbol's payload to the requested per-symbol sections, in the field's
 * original key order. `price`, `source`, `structure`, and `bestSignal` are core
 * identity fields, not gated by `include`, and always survive.
 * @param {Object} sym
 * @param {Set<string>|null} tokens - null means "no narrowing, keep every section"
 * @param {boolean} compactMode
 * @returns {Object}
 */
function filterSymbol(sym, tokens, compactMode) {
  if (!sym || typeof sym !== 'object') return sym;
  const out = {};
  for (const [key, value] of Object.entries(sym)) {
    if (key === SYMBOL_SECTION_KEYS.timeframes) {
      if (tokens && !tokens.has('timeframes')) continue;
      out.timeframes = compactMode ? compactTimeframes(value) : value;
    } else if (key === SYMBOL_SECTION_KEYS.strategies) {
      if (tokens && !tokens.has('strategies')) continue;
      out.strategies = value;
    } else if (key === SYMBOL_SECTION_KEYS.candidates) {
      if (tokens && !tokens.has('candidates')) continue;
      out.candidateSetups = value;
    } else if (key === SYMBOL_SECTION_KEYS.geometry) {
      if (tokens && !tokens.has('geometry')) continue;
      out.geometryContext = value;
    } else if (key === SYMBOL_SECTION_KEYS.trace) {
      if (tokens && !tokens.has('trace')) continue;
      out.decisionTrace = value;
    } else if (key === SYMBOL_SECTION_KEYS.model) {
      if (tokens && !tokens.has('model')) continue;
      out.model = value;
    } else if (key === 'mark') {
      // P1: mark is a core identity field beside `price`; compact keeps the three
      // fields a stop check needs.
      out.mark = compactMode ? compactMark(value) : value;
    } else if (BIAS_SECTION_KEYS.includes(key)) {
      if (tokens && !tokens.has('bias')) continue;
      out[key] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Narrow a built scalp-context payload to the requested symbols/sections, and/or drop
 * candle arrays. Pure: never mutates `payload` or anything inside it. `{}` (or any
 * combination of empty/absent options) returns a payload deep-equal to the input, in
 * the same key order, so an unfiltered MCP call or REST request is unaffected.
 *
 * Unknown symbols or include values are never an error - they are dropped and one
 * warning line per kind is appended (to a new warnings array; the input's is untouched).
 * If every requested symbol (or every requested include token) is unknown, that filter
 * is treated as absent rather than collapsing the response to nothing.
 *
 * @param {Object} payload - buildScalpContext() output
 * @param {Object} [opts]
 * @param {Array<string>} [opts.symbols]
 * @param {Array<string>} [opts.include]
 * @param {boolean} [opts.compact]
 * @returns {Object}
 */
export function filterPayload(payload, opts = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const { symbols, include, compact } = opts || {};

  const warnings = Array.isArray(payload.warnings) ? [...payload.warnings] : [];

  const allSymbolKeys = payload.symbols && typeof payload.symbols === 'object' ? Object.keys(payload.symbols) : [];
  let selectedSymbolKeys = allSymbolKeys;
  if (Array.isArray(symbols) && symbols.length > 0) {
    const requested = symbols.filter((s) => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim().toUpperCase());
    const known = [...new Set(requested.filter((s) => allSymbolKeys.includes(s)))];
    const unknown = [...new Set(requested.filter((s) => !allSymbolKeys.includes(s)))];
    if (unknown.length > 0) {
      warnings.push(`payload controls: ignored unknown symbols ${unknown.join(',')}`);
    }
    if (known.length > 0) {
      selectedSymbolKeys = allSymbolKeys.filter((k) => known.includes(k));
    }
  }

  let selectedTokens = null; // null = no narrowing, every section stays
  if (Array.isArray(include) && include.length > 0) {
    const requested = include.filter((s) => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim().toLowerCase());
    const known = [...new Set(requested.filter((s) => INCLUDE_TOKENS.includes(s)))];
    const unknown = [...new Set(requested.filter((s) => !INCLUDE_TOKENS.includes(s)))];
    if (unknown.length > 0) {
      warnings.push(`payload controls: ignored unknown include values ${unknown.join(',')}`);
    }
    if (known.length > 0) {
      selectedTokens = new Set(known);
    }
  }

  const compactMode = compact === true;

  const symbolsOut = {};
  for (const key of selectedSymbolKeys) {
    symbolsOut[key] = filterSymbol(payload.symbols[key], selectedTokens, compactMode);
  }

  const wantAccount = !selectedTokens || selectedTokens.has(TOP_LEVEL_SECTION_KEYS.account);
  const wantConfig = !selectedTokens || selectedTokens.has(TOP_LEVEL_SECTION_KEYS.config);

  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'symbols') out.symbols = symbolsOut;
    else if (key === 'warnings') out.warnings = warnings;
    else if (key === 'account') { if (wantAccount) out.account = value; }
    else if (key === 'config') { if (wantConfig) out.config = value; }
    else out[key] = value;
  }
  return out;
}

/**
 * Determine the ISO close time of the newest closed candle in an array.
 * @param {Array<Object>} closed
 * @param {string} tf
 * @returns {string|null}
 */
function closedThroughOf(closed, tf) {
  if (!Array.isArray(closed) || closed.length === 0) return null;
  const newest = closed[closed.length - 1];
  if (isFiniteNumber(newest.closeTime)) return new Date(newest.closeTime).toISOString();
  if (isFiniteNumber(newest.timestamp) && isFiniteNumber(INTERVAL_MS[tf])) {
    return new Date(newest.timestamp + INTERVAL_MS[tf]).toISOString();
  }
  return null;
}

/**
 * Strict live-data fetch used by the connector.
 *
 * Synthetic candles are never requested: allowSynthetic stays false, so a provider
 * failure surfaces as an error envelope instead of fabricated data. 3m is derived
 * from verified live 1m candles inside marketData, so Kraken is never asked for
 * interval=3.
 *
 * @param {string} pair
 * @param {string} interval
 * @param {number} limit
 * @param {Object} [opts]
 * @returns {Promise<Object>} provenance envelope
 */
function defaultStrictFetch(pair, interval, limit, opts = {}) {
  return marketData.getCandlesWithProvenance(pair, interval, limit, {
    allowSynthetic: false,
    now: opts && isFiniteNumber(opts.now) ? opts.now : Date.now()
  });
}

/**
 * Normalize a fetch result into a provenance envelope.
 *
 * A bare array (legacy/injected fetchers) is accepted and labelled 'injected' - it is
 * never labelled as a live provider, so synthetic data cannot masquerade as Kraken.
 *
 * @param {*} raw
 * @returns {{candles:Array, provider:string|null, synthetic:boolean, error:string|null}}
 */
function toEnvelope(raw) {
  if (Array.isArray(raw)) {
    return { candles: raw, provider: 'injected', synthetic: false, error: null };
  }
  if (!raw || typeof raw !== 'object') {
    return { candles: [], provider: null, synthetic: false, error: 'invalid fetch result' };
  }
  return {
    candles: Array.isArray(raw.candles) ? raw.candles : [],
    provider: raw.provider || null,
    synthetic: raw.synthetic === true,
    error: raw.error || null
  };
}

/**
 * Resolve the symbol-level provider label from the providers actually observed.
 * Never infers 'kraken' from the mere absence of an exception.
 *
 * @param {Array<string>} providers - providers that returned usable live data
 * @param {number} expectedCount - number of timeframes requested
 * @param {boolean} hadWarning
 * @returns {string}
 */
function resolveSymbolProvider(providers, expectedCount, hadWarning) {
  if (!Array.isArray(providers) || providers.length === 0) return 'unavailable';

  const unique = [...new Set(providers)];
  const allKraken = unique.every((p) => p === 'kraken' || p === 'kraken-derived');
  const complete = providers.length === expectedCount && !hadWarning;

  if (allKraken) return complete ? 'kraken' : 'kraken-partial';
  if (unique.length === 1) return complete ? unique[0] : `${unique[0]}-partial`;
  return 'mixed';
}

/**
 * Build the full scalp context payload for a set of symbols/timeframes.
 *
 * @param {Object} [options]
 * @param {Array<string>} [options.symbols=SYMBOLS]
 * @param {Array<string>} [options.timeframes=TIMEFRAMES]
 * @param {number} [options.now=Date.now()]
 * @param {(pair:string, interval:string, limit:number)=>Promise<Array>} [options.fetchCandles] - injectable for tests
 * @param {Function} [options.fetchAccount] - injectable wallet snapshot reader, for tests
 * @param {Function|null} [options.fetchMarks] - P1: `(symbols) => Promise<{SYM: raw}>`, see
 *   lib/pythMark.js. Defaults to the live Pyth read only when candles come from the live
 *   strict fetcher; an injected fetchCandles (tests, replay) gets `mark.status:
 *   "unavailable"` and no request, because a live mark beside historical candles is wrong.
 * @param {boolean} [options.includeBias=false] - phase 9b: attach biasMatrix, alignment and
 *   decisionInputs per symbol. decisionTrace.bias is always present.
 * @param {boolean} [options.includeModel=false] - publish bulky model evidence (and the
 *   full recommendation record as model.recommendation). The compact flagRecommendation
 *   is always present.
 * @param {boolean} [options.slimFailed=true] - slim failed candidates to their identity
 *   and failReason (review fix 6b). Only the replay harness passes false, because its
 *   metrics track a failed candidate by its full lifecycle fields.
 * @param {{symbol:string, timeframe:string, onSeries:Function}|null} [options.chart] - phase 8b:
 *   receives `{ ema21, ema200 }` aligned to that timeframe's published candles. Payload unchanged.
 * @returns {Promise<Object>} normalized JSON-safe payload
 */
export async function buildScalpContext(options = {}) {
  const buildStartMs = Date.now();
  const {
    symbols = SYMBOLS,
    timeframes = TIMEFRAMES,
    now = Date.now(),
    fetchCandles = defaultStrictFetch,
    fetchAccount = getAccountSnapshot,
    includeFailed = ENGINE_CONFIG.flag.includeFailed,
    includeBias = false,
    includeModel = false,
    slimFailed = true,
    chart = null
  } = options || {};
  const fetchMarks = options && options.fetchMarks !== undefined
    ? options.fetchMarks
    : (fetchCandles === defaultStrictFetch ? fetchPythMarks : null);

  const safeNow = isFiniteNumber(now) ? now : Date.now();
  const warnings = [];

  const symbolList = Array.isArray(symbols) && symbols.length > 0 ? symbols : SYMBOLS;
  const timeframeList = Array.isArray(timeframes) && timeframes.length > 0 ? timeframes : TIMEFRAMES;

  console.log(`[ScalpContext] Building context: symbols=${symbolList.join(',')} timeframes=${timeframeList.join(',')}`);

  // Build the flat list of (symbol, timeframe) fetch tasks.
  const tasks = [];
  for (const symbol of symbolList) {
    const pair = SYMBOL_PAIR_MAP[symbol] || `${symbol}USDT`;
    for (const tf of timeframeList) {
      tasks.push({ symbol, tf, pair });
    }
  }

  // P1: one Pyth mark request for every symbol, in flight alongside the candle fetches
  // so it adds no wall time. Never rejects; a failure is `mark.status: "unavailable"`
  // and deliberately stays out of `warnings` (and so out of `dataStatus`).
  const marksPromise = typeof fetchMarks === 'function'
    ? Promise.resolve().then(() => fetchMarks(symbolList)).catch((err) => {
      console.warn(`[ScalpContext] mark read threw - ${err && err.message ? err.message : err}`);
      return {};
    })
    : Promise.resolve({});

  const fetchResults = await mapLimit(tasks, MAX_CONCURRENCY, async (task) => {
    try {
      const raw = await fetchCandles(task.pair, task.tf, FETCH_LIMIT, { now: safeNow });
      const envelope = toEnvelope(raw);

      // Synthetic candles must never reach the connector, and must never be
      // presented as live provider data.
      if (envelope.synthetic || envelope.provider === 'synthetic') {
        return {
          ...task,
          candles: [],
          ok: false,
          provider: 'synthetic',
          error: 'synthetic data rejected by strict connector'
        };
      }

      if (envelope.error || !envelope.provider || envelope.candles.length === 0) {
        return {
          ...task,
          candles: [],
          ok: false,
          provider: envelope.provider || null,
          error: envelope.error || 'no live candles returned'
        };
      }

      return { ...task, candles: envelope.candles, ok: true, provider: envelope.provider, error: null };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`[ScalpContext] fetch failed for ${task.symbol} ${task.tf}: ${message}`);
      return { ...task, candles: [], ok: false, provider: null, error: message };
    }
  });

  const bySymbolTf = {};
  for (const symbol of symbolList) bySymbolTf[symbol] = {};
  for (const r of fetchResults) {
    bySymbolTf[r.symbol][r.tf] = r;
  }

  const rawMarks = (await marksPromise) || {};

  const symbolsOut = {};
  const newest1mCloses = [];
  const symbolDurationsMs = {};

  for (const symbol of symbolList) {
    const symbolStartMs = Date.now();
    const pair = SYMBOL_PAIR_MAP[symbol] || `${symbol}USDT`;
    let symbolHadWarning = false;

    const tfEntries = {};
    const closedByTf = {};
    const mtfForStrategy = {};
    const tfProviders = [];
    let candidateSetups = [];
    let modelCandidateSetups = [];
    const geometryContext = {};
    // Per candidate timeframe { price, atr } (phase 9): snap tolerance and the coil
    // gate measure in the candidate timeframe's ATR. Internal, never published.
    const marketByTf = {};
    // EMA/Stoch series per timeframe, kept for the bias layer's own geometry on
    // timeframes geometryContext does not publish (phase 9b). Internal, never published.
    const seriesByTf = {};
    // Price vs EMA200 per timeframe (Q2/Q3, trading-model quick pass): feeds candidate
    // ema200Side and the top-down above200 count. Internal, never published on its own.
    const ema200SideByTf = {};

    for (const tf of timeframeList) {
      const fetched = bySymbolTf[symbol][tf];

      if (!fetched || !fetched.ok) {
        warnings.push(`${symbol} ${tf}: live data unavailable${fetched && fetched.error ? ' - ' + fetched.error : ''}`);
        symbolHadWarning = true;
      } else if (fetched.provider) {
        tfProviders.push(fetched.provider);
      }

      const rawCandles = (fetched && fetched.candles) || [];
      const closed = dropUnclosedCandles(rawCandles, tf, safeNow);
      closedByTf[tf] = closed;

      if (closed.length < 2) {
        warnings.push(`${symbol} ${tf}: insufficient closed candles (${closed.length})`);
        symbolHadWarning = true;
        tfEntries[tf] = nullTimeframeEntry();
        continue;
      }

      let indicators;
      try {
        indicators = indicatorService.calculateAllIndicators(closed);
      } catch (err) {
        warnings.push(`${symbol} ${tf}: indicator calculation failed - ${err.message}`);
        symbolHadWarning = true;
        tfEntries[tf] = nullTimeframeEntry();
        continue;
      }

      const limitCount = CANDLE_LIMITS[tf] || closed.length;
      const trimmed = closed.slice(-limitCount);
      seriesByTf[tf] = {
        ema21History: indicators.ema && indicators.ema.ema21History,
        ema200History: indicators.ema && indicators.ema.ema200History,
        stochHistory: indicators.stochRSI && indicators.stochRSI.history
      };

      // round2 (2026-09-23 follow-up item 1c): the EMA library's recursive formula leaves
      // float noise (e.g. 85459.07572138119) on every downstream read of this value
      // (published here, priceVs21/200Pct, ema200Side, structure, geometryContext, bias
      // matrix). All of those already work in whole cents or coarser (ATR multiples,
      // percentage points already round2'd), so rounding at the source changes no
      // decision and removes noise from every one of them at once - the single biggest
      // existing-field contributor to the default payload's float noise (42 instances
      // across timeframes x symbols).
      const ema21 = isFiniteNumber(indicators.ema && indicators.ema.ema21) ? round2(indicators.ema.ema21) : null;
      const ema200 = isFiniteNumber(indicators.ema && indicators.ema.ema200) ? round2(indicators.ema.ema200) : null;
      const lastClose = closed[closed.length - 1].close;

      const priceVs21Pct = ema21 !== null && isFiniteNumber(lastClose)
        ? round2(((lastClose - ema21) / ema21) * 100)
        : null;
      const priceVs200Pct = ema200 !== null && isFiniteNumber(lastClose)
        ? round2(((lastClose - ema200) / ema200) * 100)
        : null;
      // Q2 (trading-model quick pass, M-6): EMA200 side on flag candidates. Never filters
      // - a short above the 200 or a long below it is still published (the M-6 case).
      const ema200Side = ema200 !== null && isFiniteNumber(lastClose) ? (lastClose >= ema200 ? 'above' : 'below') : null;
      ema200SideByTf[tf] = ema200Side;

      tfEntries[tf] = {
        candles: trimmed.map(formatCandleOut),
        ema21,
        ema200,
        priceVs21Pct,
        priceVs200Pct,
        trend: (indicators.analysis && indicators.analysis.trend) || null,
        stochRsi: deriveStochRsi(indicators.stochRSI && indicators.stochRSI.history),
        closedThrough: closedThroughOf(closed, tf),
        candleCount: closed.length
      };

      // Confirmation chart (phase 8b): opt-in only. Hands the renderer the EMA series for
      // the published window; the payload is not touched, so a build without `chart` is
      // byte-identical. round2 (2026-09-23 follow-up item 1c) so the series's last point
      // still matches the now-rounded timeframes.<tf>.ema21/ema200.
      if (chart && chart.symbol === symbol && chart.timeframe === tf && typeof chart.onSeries === 'function') {
        chart.onSeries({
          ema21: windowSeries(indicators.ema && indicators.ema.ema21History, trimmed.length).map(round2),
          ema200: windowSeries(indicators.ema && indicators.ema.ema200History, trimmed.length).map(round2)
        });
      }

      // Flag candidates: a separate channel from strategies, never an input to them.
      // A detector fault is logged, not warned, so it cannot move dataStatus.
      if (ENGINE_CONFIG.model.flagTimeframes.includes(tf)) {
        try {
          const flagInput = {
            candles: closed,
            ema21History: indicators.ema && indicators.ema.ema21History,
            stochRsi: tfEntries[tf].stochRsi
          };
          for (const direction of DIRECTIONS) {
            const found = detectFlagLifecycle(flagInput, direction);
            if (!found) continue;
            // F1 item 6: stable identity, derived from this request's own candle window
            // (candidateId, firstDetectedAt, impulseStart, impulseEnd, failedAt); drops
            // the raw candle-count offsets detectFlagLifecycle carried them in as.
            const identified = identifyCandidate({ timeframe: tf, ...found.candidate, ema200Side }, {
              symbol,
              closedThroughIso: tfEntries[tf].closedThrough,
              intervalMs: INTERVAL_MS[tf]
            });
            modelCandidateSetups.push(identified);
            if (ENGINE_CONFIG.flag.timeframes.includes(tf)) candidateSetups.push(identified);
            marketByTf[tf] = { price: lastClose, atr: found.atr };
          }
        } catch (err) {
          console.warn(`[ScalpContext] ${symbol} ${tf}: pattern detector failed - ${err.message}`);
        }
      }

      // Geometry (phase 7): same separate-channel rule as candidates - logged, never
      // warned, so a geometry fault cannot move dataStatus.
      if (ENGINE_CONFIG.geometry.timeframes.includes(tf)) {
        try {
          geometryContext[tf] = buildGeometryContext({
            timeframe: tf,
            candles: closed,
            ema21History: indicators.ema && indicators.ema.ema21History,
            ema200History: indicators.ema && indicators.ema.ema200History,
            stochHistory: indicators.stochRSI && indicators.stochRSI.history
          });
        } catch (err) {
          geometryContext[tf] = null;
          console.warn(`[ScalpContext] ${symbol} ${tf}: geometry failed - ${err.message}`);
        }
      }

      mtfForStrategy[tf] = {
        indicators,
        structure: indicatorService.detectSwingPoints(closed, 20),
        candleCount: closed.length,
        lastCandle: closed[closed.length - 1]
      };
    }

    // price = close of newest closed 1m candle, fall back to smallest available timeframe
    let price = null;
    for (const tf of TF_SIZE_ORDER) {
      const entry = tfEntries[tf];
      if (entry && entry.candles && entry.candles.length > 0) {
        const lastCandle = entry.candles[entry.candles.length - 1];
        if (isFiniteNumber(lastCandle.c)) {
          price = lastCandle.c;
          break;
        }
      }
    }

    if (tfEntries['1m'] && tfEntries['1m'].closedThrough) {
      newest1mCloses.push(tfEntries['1m'].closedThrough);
    }

    let structure;
    try {
      structure = buildStructure({
        candles1d: closedByTf['1d'] || [],
        candles1h: closedByTf['1h'] || [],
        candles15m: closedByTf['15m'] || [],
        price,
        ema21: tfEntries['1h'] ? tfEntries['1h'].ema21 : null,
        ema200: tfEntries['1h'] ? tfEntries['1h'].ema200 : null,
        now: safeNow
      });
    } catch (err) {
      warnings.push(`${symbol}: structure build failed - ${err.message}`);
      symbolHadWarning = true;
      structure = nullStructure();
    }

    // Geometry B (phase 8): diagonals, channel, confluence per geometry timeframe. Runs
    // after structure because confluence reads the session and prev-day levels. Same
    // separate-channel rule as phase 7: a fault is logged, never warned.
    for (const [tf, g] of Object.entries(geometryContext)) {
      if (!g) continue;
      try {
        const b = buildGeometryB({
          candles: closedByTf[tf],
          geometry: g,
          ema21: tfEntries[tf].ema21,
          ema200: tfEntries[tf].ema200,
          levels: {
            sessionHigh: structure.sessionHigh,
            sessionLow: structure.sessionLow,
            prevDayHigh: structure.prevDayHigh,
            prevDayLow: structure.prevDayLow
          }
        });
        if (b) geometryContext[tf] = { ...g, ...b };
      } catch (err) {
        console.warn(`[ScalpContext] ${symbol} ${tf}: geometry B failed - ${err.message}`);
      }
    }

    // Pattern lifecycle (phase 9): snap candidate levels to geometry, collapse bull/bear
    // pairs into coils, then decide whether a chart is needed. Same separate-channel
    // rule: a fault is logged and the unrefined candidates stand.
    let visualGate = null;
    try {
      const nearMissByTf = {};
      for (const [tf, g] of Object.entries(geometryContext)) {
        if (!g) continue;
        nearMissByTf[tf] = nearMissDiagonals(
          swingPivots(closedByTf[tf], ENGINE_CONFIG.geometry.pivotLeft, ENGINE_CONFIG.geometry.pivotRight),
          ENGINE_CONFIG.geometry,
          { candles: closedByTf[tf], atr: g.atr }
        );
      }
      // Q1 (trading-model quick pass): snapping can move breakoutLevel/invalidation
      // outward to a geometry edge. snapCandidateLevels itself is unchanged; the measured
      // target is just recomputed from whatever breakoutLevel/invalidation it settled on,
      // so a snapped candidate's measuredTarget always matches its published levels.
      const snapped = candidateSetups.map((c) => {
        const s = snapCandidateLevels(
          c,
          geometryContext[geometryTimeframeFor(c.timeframe)] || null,
          marketByTf[c.timeframe] ? marketByTf[c.timeframe].atr : null
        );
        if (s.type !== 'flag' || !isFiniteNumber(s.poleHeight)) return s;
        const sign = s.direction === 'short' ? -1 : 1;
        const { measuredTarget, measuredRR } = measuredMoveFor({ breakoutLevel: s.breakoutLevel, invalidation: s.invalidation, poleHeight: s.poleHeight, sign });
        return { ...s, measuredTarget, measuredRR };
      });
      candidateSetups = [...new Set(snapped.map((c) => c.timeframe))]
        .flatMap((tf) => resolveCoils(snapped.filter((c) => c.timeframe === tf)));
      modelCandidateSetups = modelCandidateSetups.map((c) => {
        const s = snapCandidateLevels(
          c,
          geometryContext[geometryTimeframeFor(c.timeframe)] || null,
          marketByTf[c.timeframe] ? marketByTf[c.timeframe].atr : null
        );
        if (s.type !== 'flag' || !isFiniteNumber(s.poleHeight)) return s;
        const sign = s.direction === 'short' ? -1 : 1;
        const { measuredTarget, measuredRR } = measuredMoveFor({ breakoutLevel: s.breakoutLevel, invalidation: s.invalidation, poleHeight: s.poleHeight, sign });
        return { ...s, measuredTarget, measuredRR };
      });
      visualGate = buildVisualGate({ symbol, candidates: candidateSetups, geometryByTf: geometryContext, nearMissByTf, marketByTf });
    } catch (err) {
      console.warn(`[ScalpContext] ${symbol}: pattern lifecycle failed - ${err.message}`);
    }

    let strategies = {};
    let bestSignal = null;
    let rawStrategies = null;
    try {
      const result = strategyService.evaluateAllStrategies(pair, mtfForStrategy, 'STANDARD');
      rawStrategies = (result && result.strategies) || null;
      strategies = trimStrategies(rawStrategies);
      bestSignal = (result && result.bestSignal) || null;
    } catch (err) {
      warnings.push(`${symbol}: strategy evaluation failed - ${err.message}`);
      symbolHadWarning = true;
      strategies = {};
      bestSignal = null;
      rawStrategies = null;
    }

    // Bias matrix (phase 9b): a layer above strategies and candidates, never an input to
    // them. Timeframes without published geometry get the same geometry functions run
    // here for the bias read only. Same separate-channel rule: a fault is logged, the
    // trace string is null and the opt-in objects are omitted.
    let bias = null;
    let topDownModel = null;
    try {
      const biasGeometry = {};
      for (const tf of timeframeList) {
        if (geometryContext[tf]) { biasGeometry[tf] = geometryContext[tf]; continue; }
        if (!seriesByTf[tf] || !closedByTf[tf]) continue;
        const g = buildGeometryContext({ timeframe: tf, candles: closedByTf[tf], ...seriesByTf[tf] });
        if (!g) continue;
        const b = buildGeometryB({ candles: closedByTf[tf], geometry: g, ema21: tfEntries[tf].ema21, ema200: tfEntries[tf].ema200 });
        biasGeometry[tf] = b ? { ...g, ...b } : g;
      }
      const matrix = buildBiasMatrix(tfEntries, biasGeometry);
      const alignment = buildAlignment({ price, candidates: candidateSetups, strategies, matrix, zonesByTf: zonesFromGeometry(biasGeometry) });
      const decisionInputs = buildDecisionInputs(matrix);

      // Top-down sentiment (Q3, trading-model quick pass): 1W derived from the already-
      // fetched 1D candles; 1D/4H/1H reuse this same bias matrix's leans. Same
      // separate-channel rule as the rest of this block - a fault here still leaves the
      // rest of `bias` (matrix/alignment/decisionInputs/summary) intact.
      let topDown = null;
      let above200 = null;
      try {
        const weekly = buildWeeklyLean(closedByTf['1d'] || []);
        const leans = {
          '1w': weekly.bias,
          '1d': matrix['1d'] ? BIAS_TO_SENTIMENT[matrix['1d'].bias] : 'neutral',
          '4h': matrix['4h'] ? BIAS_TO_SENTIMENT[matrix['4h'].bias] : 'neutral',
          '1h': matrix['1h'] ? BIAS_TO_SENTIMENT[matrix['1h'].bias] : 'neutral'
        };
        const td = buildTopDown(leans);
        const ab = buildAboveBelow200(ema200SideByTf);
        above200 = ab.above200;
        topDown = { sentiment: td.sentiment, aligned: td.aligned, score: td.score, leans, weekly, above200 };
        topDownModel = topDown;
      } catch (err) {
        console.warn(`[ScalpContext] ${symbol}: top-down sentiment failed - ${err.message}`);
      }

      bias = {
        matrix,
        alignment,
        decisionInputs,
        topDown,
        summary: biasTraceSummary(matrix, decisionInputs, alignment, topDown, above200)
      };
    } catch (err) {
      console.warn(`[ScalpContext] ${symbol}: bias matrix failed - ${err.message}`);
    }

    // Trade qualification (F1 item 8): a compact read layered on the finalized
    // candidates, never a detection input. Runs after coil resolution/snapping and bias
    // so it can read the symbol's own geometryContext, per-timeframe Stoch RSI, and the
    // 4h lean; a fault is logged, never warned, matching every other candidate-adjacent
    // layer here.
    try {
      const stochRsiByTf = {};
      for (const tf of ENGINE_CONFIG.flag.timeframes) {
        if (tfEntries[tf]) stochRsiByTf[tf] = tfEntries[tf].stochRsi;
      }
      attachQualification(candidateSetups, {
        geometryContext,
        stochRsiByTf,
        fourHourBias: bias && bias.matrix && bias.matrix['4h'] ? bias.matrix['4h'].bias : null
      });
    } catch (err) {
      console.warn(`[ScalpContext] ${symbol}: candidate qualification failed - ${err.message}`);
    }

    // Flag trade plan (signal-reliability minimum plan, work package 2): the one
    // engine-owned trade call built from the symbol's confirmed directional flag
    // candidates, if any. Same separate-channel rule as qualification/risk above - a
    // fault is logged, never warned, and never touches strategies/bestSignal.
    let flagTradePlan = null;
    try {
      flagTradePlan = buildFlagTradePlan({
        candidateSetups,
        geometryContext,
        tfEntries,
        marketByTf,
        candlesByTf: closedByTf,
        intervalMsByTf: INTERVAL_MS,
        geometryTimeframes: ENGINE_CONFIG.geometry.timeframes,
        now: safeNow,
        symbol,
        configVersion: CONFIG_VERSION
      });
    } catch (err) {
      console.warn(`[ScalpContext] ${symbol}: flag trade plan failed - ${err.message}`);
    }

    let modelEvidence = null;
    let recommendationFull = null;
    // Review fix 5: a symbol with no price is unavailable, never "partial"; and the
    // null-plan branch checks the flag timeframes' own freshness before calling WATCH.
    const recommendationDataStatus = price === null ? 'unavailable' : (symbolHadWarning ? 'partial' : 'complete');
    const flagFreshness = ENGINE_CONFIG.flag.timeframes.map((tf) => ({
      tf,
      closedThroughIso: tfEntries[tf] ? tfEntries[tf].closedThrough : null,
      intervalMs: INTERVAL_MS[tf],
      graceMs: ENGINE_CONFIG.freshness.graceMs
    }));
    const recommendationAsOf = (tfEntries['1m'] && tfEntries['1m'].closedThrough) || new Date(safeNow).toISOString();
    try {
      modelEvidence = buildModelEvidence({
        tfEntries,
        seriesByTf,
        closedByTf,
        candidateSetups: modelCandidateSetups,
        flagTradePlan,
        geometryContext,
        topDown: topDownModel,
        price,
        now: safeNow
      });
      recommendationFull = buildFlagRecommendation({
        symbol,
        asOf: recommendationAsOf,
        dataStatus: recommendationDataStatus,
        flagTradePlan,
        evidence: modelEvidence,
        topDown: topDownModel,
        flagFreshness,
        now: safeNow,
        // Phase 2: default 1m/3m/5m candidates (with qual) and geometry, read-only, so
        // every record names its candidate, first level ahead and change condition.
        candidates: candidateSetups,
        geometryContext
      });
    } catch (err) {
      console.warn(`[ScalpContext] ${symbol}: flag recommendation failed - ${err.message}`);
      recommendationFull = buildFlagRecommendation({
        symbol,
        asOf: recommendationAsOf,
        dataStatus: 'unavailable',
        flagTradePlan: null,
        evidence: null,
        topDown: null
      });
    }

    // P1: Pyth mark beside the closed-candle price. `price` itself is untouched.
    const mark = buildMark(rawMarks[symbol], price, safeNow, ENGINE_CONFIG.mark.pyth.maxAgeSec);

    // Flag paths outlook (T4 P1, docs/PLAN_FLAG_PATHS.md): a measured-history read on the
    // symbol's live flag candidate, info only - never an input to flagTradePlan,
    // flagRecommendation, strategies, bestSignal, or any gate/threshold. Same
    // separate-channel rule as qualification/risk/trade-plan above: a fault is logged,
    // never warned, and the field is simply null.
    let pathOutlook = null;
    try {
      pathOutlook = buildPathOutlook({
        candidateSetups,
        flagRecommendation: recommendationFull,
        flagTradePlan,
        geometryContext,
        tfEntries,
        closedByTf,
        marketByTf,
        topDown: topDownModel
      });
    } catch (err) {
      console.warn(`[ScalpContext] ${symbol}: path outlook failed - ${err.message}`);
    }

    const decisionTrace = buildDecisionTrace({
      rawStrategies,
      bestSignal,
      evaluatedAt: new Date(safeNow).toISOString(),
      window: buildTimeframeWindow(closedByTf, tfEntries, timeframeList),
      candidateSetups,
      geometryContext,
      visualGate,
      bias: bias ? `${bias.summary}|${markTraceToken(mark)}` : null
    });

    const closedThroughByTf = {};
    for (const tf of timeframeList) {
      if (tfEntries[tf]) closedThroughByTf[tf] = tfEntries[tf].closedThrough;
    }

    symbolsOut[symbol] = {
      price,
      mark,
      source: {
        provider: resolveSymbolProvider(tfProviders, timeframeList.length, symbolHadWarning),
        pair,
        fetchedAt: new Date(safeNow).toISOString()
      },
      structure,
      timeframes: tfEntries,
      strategies,
      bestSignal,
      candidateSetups: (slimFailed ? slimFailedCandidates : (x) => x)(stripUnusedGeometryFields(stripPoleHeight(filterFailedCandidateSetups(candidateSetups, includeFailed, { closedThroughByTf })))),
      geometryContext,
      decisionTrace,
      flagTradePlan,
      // Review fix 6a: codes + one-line text by default; the full record (refs,
      // factorStates, per-reason text) only under model.recommendation.
      flagRecommendation: compactRecommendation(recommendationFull),
      // T4 P1: measured-history scenario weights for the live flag candidate. null when
      // none exists. Never gates anything above.
      pathOutlook
    };
    if (includeModel && modelEvidence) symbolsOut[symbol].model = { ...modelEvidence, recommendation: recommendationFull };
    if (includeBias && bias) {
      symbolsOut[symbol].biasMatrix = bias.matrix;
      symbolsOut[symbol].alignment = bias.alignment;
      symbolsOut[symbol].decisionInputs = bias.decisionInputs;
      if (bias.topDown) symbolsOut[symbol].topDown = bias.topDown;
    }

    symbolDurationsMs[symbol] = Date.now() - symbolStartMs;
  }

  const usableSymbolCount = Object.values(symbolsOut).filter((s) => s.price !== null).length;
  let dataStatus = 'complete';
  if (usableSymbolCount === 0) {
    dataStatus = 'unavailable';
  } else if (warnings.length > 0) {
    dataStatus = 'partial';
  }

  // Oldest of the per-symbol newest 1m closes = the time through which ALL data is closed.
  const closedThrough = newest1mCloses.length > 0
    ? newest1mCloses.slice().sort()[0]
    : null;

  console.log(`[ScalpContext] Done: dataStatus=${dataStatus} warnings=${warnings.length}`);

  // Tracked-wallet equity, priced with the SOL price this build already resolved so no
  // extra price source is introduced. Read-only: walletTracker holds no signing key.
  //
  // A failed wallet read is reported on account.status and is deliberately NOT pushed
  // into `warnings`, because `warnings` drives `dataStatus` - an RPC hiccup on the wallet
  // must not mark otherwise-complete market data as 'partial'.
  let account;
  try {
    account = await fetchAccount({
      prices: {
        SOL: symbolsOut.SOL ? symbolsOut.SOL.price : null,
        BTC: symbolsOut.BTC ? symbolsOut.BTC.price : null,
        ETH: symbolsOut.ETH ? symbolsOut.ETH.price : null
      },
      now: safeNow
    });
  } catch (err) {
    account = emptyAccountSnapshot('unavailable', `wallet read threw - ${err.message}`);
  }

  for (const symbolEntry of Object.values(symbolsOut)) {
    attachRisk(symbolEntry.strategies, account);
    attachCandidateRisk(symbolEntry.candidateSetups, account);
  }

  const payload = {
    schemaVersion: '1.22.0',
    configVersion: CONFIG_VERSION,
    config: buildConfigSnapshot(includeFailed),
    generatedAt: new Date(safeNow).toISOString(),
    closedThrough,
    sessionTimezone: 'UTC',
    dataStatus,
    account,
    symbols: symbolsOut,
    warnings
  };

  const normalized = normalizeJson(payload);

  // Payload size guard (phase 5, item D): logged on every build so growth is visible
  // before geometry (phase 7/8) adds bulk. 80 KB is a soft warning, not a rejection -
  // filterPayload's compact/include options are how a caller brings it back down.
  const payloadBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  console.log(`[ScalpContext] payload bytes=${payloadBytes}`);
  if (payloadBytes > 80 * 1024) {
    console.warn(`[ScalpContext] payload size ${payloadBytes} bytes exceeds the 80KB guard`);
  }

  // Build duration (phase 6): total wall time and per-symbol compute time, logged once
  // per build so a regression in fetch/compute cost is visible before geometry (phase
  // 7/8) adds work to this same loop.
  const totalDurationMs = Date.now() - buildStartMs;
  console.log(`[ScalpContext] build duration totalMs=${totalDurationMs} perSymbolMs=${JSON.stringify(symbolDurationsMs)}`);

  return normalized;
}

export default {
  buildScalpContext,
  filterPayload,
  buildConfigSnapshot,
  filterFailedCandidateSetups,
  stripPoleHeight,
  stripUnusedGeometryFields,
  slimFailedCandidates,
  attachCandidateRisk,
  wantsBias,
  wantsModel,
  SYMBOLS,
  TIMEFRAMES,
  CANDLE_LIMITS
};
