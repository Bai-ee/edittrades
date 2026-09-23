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
  long: { hold: 'hold', wick: 'wick', acceptance: 'acceptance_below', reclaim: 'reclaim' },
  short: { hold: 'hold_below', wick: 'wick_above', acceptance: 'acceptance_above', reclaim: 'reclaim' }
});

// reclaim (F1 item 3) scores like a wick: recovered, not as strong as never leaving.
const EMA21_HOLD_SCORE = Object.freeze({ hold: 1, wick: 0.5, acceptance: 0, reclaim: 0.5 });

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
 * @returns {{hold:'hold'|'wick'|'acceptance', acceptedAtIndex:number|null}|null} null when
 *   EMA21 or ATR is missing for any candle. `acceptedAtIndex` is the absolute candle index
 *   the acceptance run completed on (F1 item 4, for `failedAtCandlesAgo`); null otherwise.
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
      if (run >= cfg.acceptanceCloses) return { hold: 'acceptance', acceptedAtIndex: i };
    } else {
      run = 0;
      if (candles[i].low < floor) pierced = true;
    }
  }
  return { hold: pierced ? 'wick' : 'hold', acceptedAtIndex: null };
}

/**
 * Whether oriented candle `flagStart` is on-side of EMA21, or reclaims it (a close back
 * on-side) within `cfg.reclaimCandles` candles of `flagStart` (F1 item 3). A flag that
 * never held on-side and never reclaimed in time is not a flag at all - the caller skips
 * this window entirely, same as the old strict "must start on-side" gate.
 * @returns {{ok:boolean, reclaimed:boolean}}
 */
function onSideOrReclaimed(candles, ema, atr, flagStart, atrAtImpulse, lastIdx, cfg) {
  if (ema[flagStart] === null) return { ok: false, reclaimed: false };
  if (candles[flagStart].close >= emaFloor(ema[flagStart], atrAtImpulse, cfg)) return { ok: true, reclaimed: false };
  const end = Math.min(flagStart + cfg.reclaimCandles - 1, lastIdx);
  for (let r = flagStart; r <= end; r++) {
    const atrBefore = atr(r - 1);
    if (ema[r] === null || !isFiniteNumber(atrBefore)) break;
    if (candles[r].close >= emaFloor(ema[r], atrBefore, cfg)) return { ok: true, reclaimed: true };
  }
  return { ok: false, reclaimed: false };
}

/**
 * Impulse ending right before `flagStart`: lowest low → highest high after it, inside
 * the last `maxImpulseCandles` candles. `poleBase` (the trough, oriented) is carried
 * through for the measured-move target (quick pass Q1); it de-orients the same way as
 * breakoutLevel/invalidation, via `sign * poleBase`. `troughIdx` (F1 item 6) is the
 * absolute candle index of the pole's start, for the candidate's stable identity.
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
  return range > 0 ? { peakHigh: candles[peakIdx].high, range, poleBase: candles[troughIdx].low, troughIdx } : null;
}

/**
 * Search oriented candles for the most recent valid up-flag. Flag windows are tried
 * newest end first, then longest first, so the result spans the whole consolidation
 * and a broken flag is found through the candle right before its break.
 *
 * The search window (F1 items 4-5) extends `maxBreakoutAge` + the larger of
 * `failedTtlCandles`/`expiredTtlCandles` candles back, so a flag whose break happened
 * longer ago than `maxBreakoutAge` is still found - either `confirmed` (relabeled
 * `expired`, capped at `expiredTtlCandles` past the window, chaseRisk forced true) or
 * `failed`/`stale` (never capped here; default-payload visibility past `failedTtlCandles`
 * is `flag.includeFailed`'s job in services/scalpContext.js, not detection's).
 *
 * @returns {Object|null} oriented result
 */
function findOrientedFlag(candles, ema, atr, cfg) {
  const n = candles.length;
  const lastIdx = n - 1;
  const lookback = cfg.maxBreakoutAge + Math.max(cfg.failedTtlCandles, cfg.expiredTtlCandles);
  const earliestEnd = Math.max(0, lastIdx - lookback);

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

      // A flag starts on its own side of EMA21, or reclaims it within reclaimCandles
      // (F1 item 3); one that never held or reclaimed there cannot fail.
      const side = onSideOrReclaimed(candles, ema, atr, flagStart, atrAtImpulse, lastIdx, cfg);
      if (!side.ok) continue;

      const holdResult = classifyEma21(candles, ema, atr, flagStart, lastIdx, cfg);
      if (holdResult === null) continue;
      const hold = holdResult.hold;

      const breakoutLevel = flagHigh;
      const invalidation = flagLow;
      const invalidIdx = post.findIndex((c) => c.close < invalidation);
      let state;
      if (hold === 'acceptance' || invalidIdx !== -1) {
        state = 'failed';
      } else if (post.length === 0) {
        state = 'forming';
      } else if (post.filter((c) => c.close > breakoutLevel).length >= cfg.confirmCloses) {
        state = 'confirmed';
      } else {
        state = 'triggering';
      }

      // A confirmed flag stays confirmed as post grows (more closes past breakoutLevel
      // only), so past maxBreakoutAge it ages into expired instead of vanishing (F1 item
      // 5) - bounded at expiredTtlCandles, past which this window is not a match at all.
      const ageBeyondWindow = Math.max(0, post.length - cfg.maxBreakoutAge);
      let expired = false;
      if (state === 'confirmed' && ageBeyondWindow > 0) {
        if (ageBeyondWindow > cfg.expiredTtlCandles) continue;
        state = 'expired';
        expired = true;
      }

      const lastAtr = atr(lastIdx);
      const extension = candles[lastIdx].close - breakoutLevel;
      const chaseRisk = expired || (post.length > 0 && isFiniteNumber(lastAtr) && extension > cfg.chaseAtr * lastAtr);

      // Lifecycle facts (phase 9 / F1 item 4), read by detectFlagLifecycle only;
      // detectFlag's output does not carry them. Acceptance is checked first, matching
      // the state rule above.
      let failCause = null;
      let failedAtCandlesAgo = null;
      if (state === 'failed') {
        if (hold === 'acceptance') {
          failCause = 'acceptance';
          failedAtCandlesAgo = lastIdx - holdResult.acceptedAtIndex;
        } else {
          failCause = 'invalidation_close';
          failedAtCandlesAgo = lastIdx - (flagEnd + 1 + invalidIdx);
        }
      }

      // F1 item 3: a reclaim only labels the hold when the flag did not go on to fail by
      // acceptance - an acceptance failure keeps its own acceptance_below/above label.
      const holdOut = side.reclaimed && hold !== 'acceptance' ? 'reclaim' : hold;

      return {
        state,
        failCause,
        failedAtCandlesAgo,
        durationCandles: lastIdx - flagStart,
        breakCount: post.length,
        lastAtr,
        impulseStrength,
        compressionScore: clamp01(1 - contractionRatio),
        flagHigh,
        flagLow,
        breakoutLevel,
        invalidation,
        hold: holdOut,
        chaseRisk,
        poleBase: impulse.poleBase,
        poleHeight: impulse.range,
        impulseStartCandlesAgo: lastIdx - impulse.troughIdx
      };
    }
  }

  return findOrientedProto(candles, ema, atr, cfg, lastIdx);
}

/**
 * F1 item 1: a `proto` candidate - an impulse qualifies and 1 to `minCandles - 1` closed
 * candles have pulled back without a new extreme beyond the impulse peak. Only tried at
 * the current tip (`lastIdx`): a proto is inherently "developing right now" - by the time
 * it is `minCandles` old it either becomes a real flag (found above) or was overwritten
 * by whatever price did next. No entry call; `qual.decision` (services/scalpContext.js)
 * reads it as `watch`.
 * @returns {Object|null} oriented result, same shape as the real-flag branch above minus
 *   the post-breakout fields (breakCount 0, chaseRisk false)
 */
function findOrientedProto(candles, ema, atr, cfg, lastIdx) {
  for (let len = cfg.minCandles - 1; len >= 1; len--) {
    const flagStart = lastIdx - len + 1;
    if (flagStart < 1) continue;

    const atrAtImpulse = atr(flagStart - 1);
    if (!isFiniteNumber(atrAtImpulse) || atrAtImpulse <= 0) continue;

    const impulse = measureImpulse(candles, flagStart, cfg);
    if (!impulse) continue;
    const impulseStrength = impulse.range / atrAtImpulse;
    if (impulseStrength < cfg.minImpulseAtr) continue;

    let flagHigh = -Infinity;
    let flagLow = Infinity;
    for (let i = flagStart; i <= lastIdx; i++) {
      if (candles[i].high > flagHigh) flagHigh = candles[i].high;
      if (candles[i].low < flagLow) flagLow = candles[i].low;
    }
    if (flagHigh > impulse.peakHigh) continue;
    const contractionRatio = (flagHigh - flagLow) / impulse.range;
    if (contractionRatio > cfg.maxContractionRatio) continue;

    const side = onSideOrReclaimed(candles, ema, atr, flagStart, atrAtImpulse, lastIdx, cfg);
    if (!side.ok) continue;

    const holdResult = classifyEma21(candles, ema, atr, flagStart, lastIdx, cfg);
    if (holdResult === null) continue;
    // Already failed before it accumulated minCandles - it never was a flag; nothing to
    // report as forming.
    if (holdResult.hold === 'acceptance') continue;

    return {
      state: 'proto',
      failCause: null,
      failedAtCandlesAgo: null,
      durationCandles: lastIdx - flagStart,
      breakCount: 0,
      lastAtr: atr(lastIdx),
      impulseStrength,
      compressionScore: clamp01(1 - contractionRatio),
      flagHigh,
      flagLow,
      breakoutLevel: flagHigh,
      invalidation: flagLow,
      hold: side.reclaimed ? 'reclaim' : holdResult.hold,
      chaseRisk: false,
      poleBase: impulse.poleBase,
      poleHeight: impulse.range,
      impulseStartCandlesAgo: lastIdx - impulse.troughIdx
    };
  }
  return null;
}

/**
 * Measured-move target from the pole length (M-5b, quick pass Q1): the pole that flagged
 * out projects its length from the flag's breakout. `poleHeight` is the pole's absolute
 * price range (real, not oriented - a distance is unchanged by orientation). Called both
 * at detection and again after geometry snapping moves breakoutLevel (services/
 * scalpContext.js), so a snapped candidate's measured target always matches its final
 * breakoutLevel.
 * @param {{breakoutLevel:number, invalidation:number, poleHeight:number, sign:1|-1}} p -
 *   sign is 1 for long, -1 for short (callers outside this module derive it once from
 *   direction, the same "one comparison" rule the rest of this file follows). poleHeight
 *   is expected already rounded (see the flag object's own `poleHeight`); measuredTarget
 *   is rounded here too so float accumulation (pole subtraction, geometry snap) never
 *   reaches the payload (2026-09-23 follow-up, item 1b/2).
 * @returns {{measuredTarget:number, measuredRR:number|null}}
 */
export function measuredMoveFor({ breakoutLevel, invalidation, poleHeight, sign }) {
  const measuredTarget = roundN(breakoutLevel + sign * poleHeight, 2);
  const denom = Math.abs(breakoutLevel - invalidation);
  const measuredRR = denom > 0 ? roundN(Math.abs(measuredTarget - breakoutLevel) / denom, 2) : null;
  return { measuredTarget, measuredRR };
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
 * Least-squares slope of real (un-oriented) closes over `[fromIdx, toIdx]`, as a percent
 * of the window's average close per candle (F1 item 7). Computed on real prices only, so
 * the sign is already "real price space" - no orient/un-orient step needed, unlike
 * breakoutLevel/invalidation. Positive = rising closes.
 * @returns {number|null} null when the window has fewer than 2 candles or a zero average
 */
function flagClosesSlopePct(candles, fromIdx, toIdx) {
  const n = toIdx - fromIdx + 1;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    const y = candles[fromIdx + i].close;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const avg = sumY / n;
  if (denom === 0 || avg === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return (slope / avg) * 100;
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
 *   flagLow, breakoutLevel, invalidation, ema21Hold, confidence, chaseRisk, poleHeight,
 *   measuredTarget, measuredRR, flagSlope, breakoutDistancePct, invalidationDistancePct }`,
 *   or null when no flag exists. poleHeight/measuredTarget/measuredRR are computed from
 *   this call's breakoutLevel/invalidation (quick pass Q1); a caller that snaps those
 *   levels to geometry afterward must call measuredMoveFor(...) again with the snapped
 *   levels to keep them in step (services/scalpContext.js does).
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

  const breakoutLevel = sign * found.breakoutLevel;
  const invalidation = sign * found.invalidation;
  // Rounded once here so the published poleHeight and the measuredTarget computed from it
  // agree exactly (2026-09-23 follow-up item 1b/2: no float noise like 388.6999999999971).
  const poleHeight = roundN(found.poleHeight, 2);
  const { measuredTarget, measuredRR } = measuredMoveFor({ breakoutLevel, invalidation, poleHeight, sign });

  // F1 item 7: cheap geometry, computed on the real (un-oriented) candles - flagStart/
  // flagEnd are recovered from durationCandles/breakCount rather than threaded through
  // `found`, and a distance/slope of real prices needs no sign flip the way levels do.
  const lastIdx = candles.length - 1;
  const flagStartIdx = lastIdx - found.durationCandles;
  const flagEndIdx = lastIdx - found.breakCount;
  const flagSlope = roundN(flagClosesSlopePct(candles, flagStartIdx, flagEndIdx), 4);
  const lastClose = candles[lastIdx].close;
  const breakoutDistancePct = lastClose !== 0 ? roundN(((breakoutLevel - lastClose) / lastClose) * 100, 2) : null;
  const invalidationDistancePct = lastClose !== 0 ? roundN(((invalidation - lastClose) / lastClose) * 100, 2) : null;

  const flag = {
    type: 'flag',
    direction,
    state: found.state,
    impulseStrength: roundN(found.impulseStrength, 2),
    compressionScore: roundN(found.compressionScore, 2),
    flagHigh: realHigh,
    flagLow: realLow,
    breakoutLevel,
    invalidation,
    ema21Hold: EMA21_HOLD_LABELS[direction][found.hold],
    confidence: Math.round(confidence),
    chaseRisk: found.chaseRisk,
    poleHeight,
    measuredTarget,
    measuredRR,
    flagSlope,
    breakoutDistancePct,
    invalidationDistancePct
  };
  return { flag, found };
}

/**
 * Phase 9 lifecycle read of one flag: detectFlag's output plus, derived from the same
 * candle window (no store):
 *   - durationCandles: candles since the flag's first candle (0 = it started on the last one)
 *   - impulseStartCandlesAgo (F1 item 6, internal): candles since the pole's trough;
 *     services/scalpContext.js turns this and durationCandles into the published
 *     `impulseStart`/`impulseEnd`/`firstDetectedAt` ISO fields and `candidateId`, then
 *     drops the raw count - a stateless request has no other way to name "this flag" run
 *     to run.
 *   - ageCandles (triggering/confirmed/expired only): candles since the break candle (0 =
 *     the break is the last closed candle)
 *   - failReason (failed only): `acceptance_below`/`acceptance_above` (EMA21 acceptance,
 *     the direction's own label), `invalidation_close` (a close through invalidation
 *     after the break), or `stale` (the break sat `maxBreakoutAge` candles without
 *     confirming; before phase 9 this read `triggering` until it aged out of the window).
 *   - failedAtCandlesAgo (failed only, internal, F1 item 4): candles since the failure
 *     candle itself (acceptance close, invalidation close, or the candle the break first
 *     went stale on). services/scalpContext.js turns it into `failedAt` (ISO) and the
 *     failedTtlCandles visibility check, then drops the raw count.
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
  const candidate = {
    ...flag,
    durationCandles: found.durationCandles,
    impulseStartCandlesAgo: found.impulseStartCandlesAgo
  };
  if (found.state === 'triggering' && found.breakCount >= cfg.maxBreakoutAge) {
    candidate.state = 'failed';
    candidate.failReason = 'stale';
    candidate.failedAtCandlesAgo = found.breakCount - cfg.maxBreakoutAge;
  } else if (found.state === 'failed') {
    candidate.failReason = found.failCause === 'acceptance' ? EMA21_HOLD_LABELS[direction].acceptance : found.failCause;
    candidate.failedAtCandlesAgo = found.failedAtCandlesAgo;
  } else if (found.state === 'triggering' || found.state === 'confirmed' || found.state === 'expired') {
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

export default { detectFlag, detectFlagLifecycle, detectCandidateSetups, measuredMoveFor, DIRECTIONS };
