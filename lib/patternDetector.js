/**
 * Pattern detector — momentum continuation flags on closed candles (phase 4).
 *
 * Sequence: impulse → contraction → EMA21 hold → local flag high/low break.
 *
 * Direction symmetry by construction: there is exactly one detection path. A short is
 * evaluated by negating every price (candles and EMA21) so a bear flag becomes a bull
 * flag in "oriented" space, running the same logic, and mapping levels back. No branch
 * anywhere below reads `direction` except the orient/un-orient helpers and the label map.
 *
 * Stateless and deterministic: `state` is derived from the last candles on every call.
 * No cross-request memory (serverless).
 *
 * Output never feeds `strategies.*`, `bestSignal`, or any guard. It is a separate
 * candidate channel so a flag stays visible when the strategy engine says NO_TRADE.
 *
 * ATR is the shared `calculateATR` (`lib/advancedIndicators.js`, `flag.atrPeriod`), the
 * one ATR on the scalp path (phase 7). The EMA21 wick band is `flag.wickToleranceAtr`
 * ATRs wide, so it scales with each timeframe's volatility instead of with price.
 */

import { ENGINE_CONFIG } from '../config/engine.js';
import { calculateATR } from './advancedIndicators.js';

export const DIRECTIONS = Object.freeze(['long', 'short']);

const EMA21_HOLD_LABELS = Object.freeze({
  long: { hold: 'hold', wick: 'wick', acceptance: 'acceptance_below' },
  short: { hold: 'hold_below', wick: 'wick_above', acceptance: 'acceptance_above' }
});

const EMA21_HOLD_SCORE = Object.freeze({ hold: 1, wick: 0.5, acceptance: 0 });

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

/**
 * Map candles into oriented space: long is identity, short negates prices so highs and
 * lows swap. Everything downstream only ever reasons about an up-flag.
 */
function orientCandles(candles, sign) {
  if (sign === 1) return candles;
  return candles.map((c) => ({ open: -c.open, high: -c.low, low: -c.high, close: -c.close }));
}

/**
 * Align an EMA history (tail-aligned, shorter than candles) to candle indices.
 * @returns {Array<number|null>} one value per candle, oriented
 */
function alignEma(ema21History, candleCount, sign) {
  const out = new Array(candleCount).fill(null);
  if (!Array.isArray(ema21History)) return out;
  const offset = candleCount - ema21History.length;
  for (let j = 0; j < ema21History.length; j++) {
    const i = j + offset;
    if (i >= 0 && isFiniteNumber(ema21History[j])) out[i] = sign * ema21History[j];
  }
  return out;
}

/**
 * ATR as of each candle index, from the shared calculateATR, computed lazily and cached:
 * the detector only ever reads a couple of dozen indices near the end of the series.
 * True range ignores sign, so the real (un-oriented) candles give the same value.
 * @returns {(i:number) => number|null}
 */
function atrLookup(candles, period) {
  const cache = new Map();
  return (i) => {
    if (i < period) return null;
    if (!cache.has(i)) {
      const r = calculateATR(candles.slice(0, i + 1), period);
      cache.set(i, r && isFiniteNumber(r.atr) ? r.atr : null);
    }
    return cache.get(i);
  };
}

/**
 * Lowest oriented price still counted as on-side of EMA21 (tolerance band). The band is
 * sized from the ATR of the candle before, so a wide candle cannot widen its own band.
 */
function emaFloor(emaValue, atrBefore, cfg) {
  return emaValue - cfg.wickToleranceAtr * atrBefore;
}

/**
 * Classify how price treated EMA21 from flag start through the last candle, in oriented
 * space (long semantics). `acceptance` = `acceptanceCloses` consecutive closes beyond the
 * tolerance band on the wrong side; `wick` = any low (or a lone close) through the band
 * that did not become acceptance; `hold` otherwise.
 * @returns {'hold'|'wick'|'acceptance'|null} null when EMA21 or ATR is missing for any candle
 */
function classifyEma21(candles, ema, atr, from, to, cfg) {
  let run = 0;
  let pierced = false;
  for (let i = from; i <= to; i++) {
    if (ema[i] === null || !isFiniteNumber(atr(i - 1))) return null;
    const floor = emaFloor(ema[i], atr(i - 1), cfg);
    if (candles[i].close < floor) {
      run++;
      pierced = true;
      if (run >= cfg.acceptanceCloses) return 'acceptance';
    } else {
      run = 0;
      if (candles[i].low < floor) pierced = true;
    }
  }
  return pierced ? 'wick' : 'hold';
}

/**
 * Impulse ending right before `flagStart`: lowest low → highest high after it, inside
 * the last `maxImpulseCandles` candles.
 */
function measureImpulse(candles, flagStart, cfg) {
  const start = Math.max(0, flagStart - cfg.maxImpulseCandles);
  const end = flagStart - 1;
  if (end < start) return null;
  let peakIdx = start;
  for (let i = start; i <= end; i++) {
    if (candles[i].high >= candles[peakIdx].high) peakIdx = i;
  }
  let troughIdx = start;
  for (let i = start; i <= peakIdx; i++) {
    if (candles[i].low <= candles[troughIdx].low) troughIdx = i;
  }
  const range = candles[peakIdx].high - candles[troughIdx].low;
  return range > 0 ? { peakHigh: candles[peakIdx].high, range } : null;
}

/**
 * Search oriented candles for the most recent valid up-flag. Flag windows are tried
 * newest end first, then longest first, so the result spans the whole consolidation
 * and a broken flag is found through the candle right before its break.
 * @returns {Object|null} oriented result
 */
function findOrientedFlag(candles, ema, atr, cfg) {
  const n = candles.length;
  const lastIdx = n - 1;
  const earliestEnd = Math.max(0, lastIdx - cfg.maxBreakoutAge);

  for (let flagEnd = lastIdx; flagEnd >= earliestEnd; flagEnd--) {
    const post = flagEnd < lastIdx ? candles.slice(flagEnd + 1) : [];

    for (let len = cfg.maxFlagCandles; len >= cfg.minCandles; len--) {
      const flagStart = flagEnd - len + 1;
      if (flagStart < 1) continue;

      const atrAtImpulse = atr(flagStart - 1);
      if (!isFiniteNumber(atrAtImpulse) || atrAtImpulse <= 0) continue;

      const impulse = measureImpulse(candles, flagStart, cfg);
      if (!impulse) continue;
      const impulseStrength = impulse.range / atrAtImpulse;
      if (impulseStrength < cfg.minImpulseAtr) continue;

      let flagHigh = -Infinity;
      let flagLow = Infinity;
      for (let i = flagStart; i <= flagEnd; i++) {
        if (candles[i].high > flagHigh) flagHigh = candles[i].high;
        if (candles[i].low < flagLow) flagLow = candles[i].low;
      }
      // A flag consolidates under the pole top; a new high is a continuation, not a flag.
      if (flagHigh > impulse.peakHigh) continue;
      const contractionRatio = (flagHigh - flagLow) / impulse.range;
      if (contractionRatio > cfg.maxContractionRatio) continue;
      // A flag window ends exactly before its break candle.
      if (post.length > 0 && !(post[0].close > flagHigh)) continue;

      // A flag starts on its own side of EMA21; one that never held there cannot fail.
      if (ema[flagStart] === null || candles[flagStart].close < emaFloor(ema[flagStart], atrAtImpulse, cfg)) continue;

      const hold = classifyEma21(candles, ema, atr, flagStart, lastIdx, cfg);
      if (hold === null) continue;

      const breakoutLevel = flagHigh;
      const invalidation = flagLow;
      let state;
      if (hold === 'acceptance' || post.some((c) => c.close < invalidation)) {
        state = 'failed';
      } else if (post.length === 0) {
        state = 'forming';
      } else if (post.filter((c) => c.close > breakoutLevel).length >= cfg.confirmCloses) {
        state = 'confirmed';
      } else {
        state = 'triggering';
      }

      const lastAtr = atr(lastIdx);
      const extension = candles[lastIdx].close - breakoutLevel;
      const chaseRisk = post.length > 0 && isFiniteNumber(lastAtr) && extension > cfg.chaseAtr * lastAtr;

      // Lifecycle facts (phase 9), read by detectFlagLifecycle only; detectFlag's output
      // does not carry them. Acceptance is checked first, matching the state rule above.
      let failCause = null;
      if (state === 'failed') failCause = hold === 'acceptance' ? 'acceptance' : 'invalidation_close';

      return {
        state,
        failCause,
        durationCandles: lastIdx - flagStart,
        breakCount: post.length,
        lastAtr,
        impulseStrength,
        compressionScore: clamp01(1 - contractionRatio),
        flagHigh,
        flagLow,
        breakoutLevel,
        invalidation,
        hold,
        chaseRisk
      };
    }
  }
  return null;
}

/**
 * Stoch RSI alignment in oriented space: rising K supports a long continuation,
 * falling K a short one. Null input scores neutral.
 */
function stochScore(stochRsi, sign) {
  const slope = stochRsi && isFiniteNumber(stochRsi.slopeK) ? stochRsi.slopeK * sign : null;
  if (slope === null) return 0.5;
  return slope > 0 ? 1 : 0;
}

/**
 * Detect a continuation flag for one timeframe and one direction.
 *
 * @param {Object} input
 * @param {Array<{open:number,high:number,low:number,close:number}>} input.candles - closed candles, oldest first
 * @param {Array<number>} input.ema21History - EMA21 series, tail-aligned to candles
 * @param {Object|null} [input.stochRsi] - deriveStochRsi(...) output for the same timeframe
 * @param {'long'|'short'} direction
 * @param {Object} [cfg=ENGINE_CONFIG.flag]
 * @returns {Object|null} `{ type, direction, state, impulseStrength, compressionScore, flagHigh,
 *   flagLow, breakoutLevel, invalidation, ema21Hold, confidence, chaseRisk }`, or null when
 *   no flag exists
 */
export function detectFlag(input, direction, cfg = ENGINE_CONFIG.flag) {
  const detail = detectFlagDetail(input, direction, cfg);
  return detail ? detail.flag : null;
}

/**
 * detectFlag plus the oriented search result it was built from. Internal: shared by
 * detectFlag (phase 4 output, unchanged) and detectFlagLifecycle (phase 9).
 * @returns {{flag:Object, found:Object}|null}
 */
function detectFlagDetail({ candles, ema21History, stochRsi = null }, direction, cfg) {
  if (!DIRECTIONS.includes(direction)) throw new Error(`detectFlag: unknown direction ${direction}`);
  if (!Array.isArray(candles) || candles.length <= cfg.atrPeriod) return null;
  if (!candles.every(isValidCandle)) return null;

  const sign = direction === 'long' ? 1 : -1;
  const oriented = orientCandles(candles, sign);
  const ema = alignEma(ema21History, candles.length, sign);
  const atr = atrLookup(candles, cfg.atrPeriod);

  const found = findOrientedFlag(oriented, ema, atr, cfg);
  if (!found) return null;

  const w = cfg.confidence.weights;
  const confidence = 100 * (
    w.impulse * clamp01(found.impulseStrength / cfg.confidence.impulseFullAtr)
    + w.compression * found.compressionScore
    + w.ema21 * EMA21_HOLD_SCORE[found.hold]
    + w.stoch * stochScore(stochRsi, sign)
  );

  // Un-orient: for a short, oriented high is the real low and vice versa.
  const realHigh = sign === 1 ? found.flagHigh : -found.flagLow;
  const realLow = sign === 1 ? found.flagLow : -found.flagHigh;

  const flag = {
    type: 'flag',
    direction,
    state: found.state,
    impulseStrength: roundN(found.impulseStrength, 2),
    compressionScore: roundN(found.compressionScore, 2),
    flagHigh: realHigh,
    flagLow: realLow,
    breakoutLevel: sign * found.breakoutLevel,
    invalidation: sign * found.invalidation,
    ema21Hold: EMA21_HOLD_LABELS[direction][found.hold],
    confidence: Math.round(confidence),
    chaseRisk: found.chaseRisk
  };
  return { flag, found };
}

/**
 * Phase 9 lifecycle read of one flag: detectFlag's output plus, derived from the same
 * candle window (no store):
 *   - durationCandles: candles since the flag's first candle (0 = it started on the last one)
 *   - ageCandles (triggering/confirmed only): candles since the break candle (0 = the
 *     break is the last closed candle)
 *   - failReason (failed only): `acceptance_below`/`acceptance_above` (EMA21 acceptance,
 *     the direction's own label), `invalidation_close` (a close through invalidation
 *     after the break), or `stale` (the break sat `maxBreakoutAge` candles without
 *     confirming; before phase 9 this read `triggering` until it aged out of the window).
 *
 * @param {Object} input - see detectFlag
 * @param {'long'|'short'} direction
 * @param {Object} [cfg=ENGINE_CONFIG.flag]
 * @returns {{candidate:Object, atr:number|null}|null} atr is the flag timeframe's ATR at
 *   the last candle, for callers that measure distances in ATRs; it is not published.
 */
export function detectFlagLifecycle(input, direction, cfg = ENGINE_CONFIG.flag) {
  const detail = detectFlagDetail(input, direction, cfg);
  if (!detail) return null;
  const { flag, found } = detail;
  const candidate = { ...flag, durationCandles: found.durationCandles };
  if (found.state === 'triggering' && found.breakCount >= cfg.maxBreakoutAge) {
    candidate.state = 'failed';
    candidate.failReason = 'stale';
  } else if (found.state === 'failed') {
    candidate.failReason = found.failCause === 'acceptance' ? EMA21_HOLD_LABELS[direction].acceptance : found.failCause;
  } else if (found.state === 'triggering' || found.state === 'confirmed') {
    candidate.ageCandles = found.breakCount - 1;
  }
  return { candidate, atr: isFiniteNumber(found.lastAtr) ? found.lastAtr : null };
}

/**
 * Run the detector in both directions for one timeframe.
 * @param {Object} input - see detectFlag
 * @param {Object} [cfg=ENGINE_CONFIG.flag]
 * @returns {Array<Object>} zero, one, or two flags (long first)
 */
export function detectCandidateSetups(input, cfg = ENGINE_CONFIG.flag) {
  return DIRECTIONS.map((d) => detectFlag(input, d, cfg)).filter(Boolean);
}

export default { detectFlag, detectFlagLifecycle, detectCandidateSetups, DIRECTIONS };
