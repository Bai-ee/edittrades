/**
 * Deterministic 1m candle fixtures for the phase 4 flag detector.
 *
 * Each builder returns a long-side series: a quiet base, an up impulse, a flag, and
 * whatever ending the case needs. `mirror()` turns any series into its short twin by
 * reflecting every price around a pivot (p -> 2*pivot - p, high/low swapped), so the
 * short fixtures are the long fixtures, not hand-written look-alikes.
 *
 * EMA21 values are taken from the production indicator (`calculateEMA21`) on the
 * closes built so far, so a wick or close placed "relative to EMA21" is relative to
 * exactly what the detector will see.
 *
 * These are the seed of the miss log (plan phase 10). REGRESSION_001 is synthetic: the
 * handoff doc records the shape of the miss (impulse, EMA21 hold, compression, flag-high
 * break, engine NO_TRADE), not the raw candles.
 */

import { calculateEMA21 } from '../../services/indicators.js';

export const FIXTURE_STEP_MS = 60_000;
export const FIXTURE_PIVOT = 100_000;

const BASE_PRICE = 100_000;
const BASE_CANDLES = 60;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Series builder that appends candles by open/close and derives high/low. */
function series(seed) {
  const rand = mulberry32(seed);
  const candles = [];
  const api = {
    candles,
    lastClose: () => (candles.length ? candles[candles.length - 1].close : BASE_PRICE),
    ema: () => {
      const e = calculateEMA21(candles.map((c) => c.close));
      return e[e.length - 1];
    },
    push(open, close, { high, low } = {}) {
      const top = Math.max(open, close);
      const bottom = Math.min(open, close);
      candles.push({
        open: round2(open),
        high: round2(high ?? top + 2 + rand() * 3),
        low: round2(low ?? bottom - 2 - rand() * 3),
        close: round2(close)
      });
      return api;
    },
    /** Quiet chop around a level: ~$20 bars. */
    base(count, level = BASE_PRICE) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        const target = level + (rand() - 0.5) * 20;
        api.push(open, target);
      }
      return api;
    },
    /** Straight-line move of `count` candles by `perCandle` dollars. */
    move(count, perCandle) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        api.push(open, open + perCandle);
      }
      return api;
    },
    /** Tight flag: closes alternate inside [low, high]; bars stay inside the box except where the open sits outside it. */
    flag(count, high, low) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        const close = i % 2 === 0 ? low + (high - low) * 0.35 : low + (high - low) * 0.65;
        api.push(open, close, {
          high: Math.max(open, close, Math.min(high, Math.max(open, close) + 3)),
          low: Math.min(open, close, Math.max(low, Math.min(open, close) - 3))
        });
      }
      return api;
    }
  };
  return api;
}

/** Stamp open/close times ending at `now` (last candle closed at the aligned minute). */
export function withTimes(candles, now) {
  const alignedNow = Math.floor(now / FIXTURE_STEP_MS) * FIXTURE_STEP_MS;
  const firstOpen = alignedNow - candles.length * FIXTURE_STEP_MS;
  return candles.map((c, i) => ({
    timestamp: firstOpen + i * FIXTURE_STEP_MS,
    ...c,
    volume: 100,
    closeTime: firstOpen + (i + 1) * FIXTURE_STEP_MS
  }));
}

/** Reflect a long fixture into its short twin. */
export function mirror(candles, pivot = FIXTURE_PIVOT) {
  return candles.map((c) => ({
    ...c,
    open: round2(2 * pivot - c.open),
    high: round2(2 * pivot - c.low),
    low: round2(2 * pivot - c.high),
    close: round2(2 * pivot - c.close)
  }));
}

/**
 * REGRESSION_001_BTC_1M_FLAG: impulse up → tight flag above EMA21 → flag-high break,
 * followed through by a second close above. Expected: confirmed, hold, no chase.
 */
export function regression001() {
  const s = series(1);
  s.base(BASE_CANDLES).move(5, 80);            // pole ~100000 → ~100400
  s.flag(6, 100385, 100300);                   // flag under the pole top, far above EMA21
  s.push(s.lastClose(), 100395, { high: 100398 });   // break: close > flag high
  s.push(100395, 100402, { high: 100405, low: 100390 }); // follow-through close
  return s.candles;
}

/**
 * Wick through EMA21 then reclaim: the flag sags into a rising EMA21, one bar wicks
 * well below it and closes back above. Expected: ema21Hold "wick", candidate survives.
 */
export function wickReclaim() {
  const s = series(2);
  s.base(BASE_CANDLES).move(5, 80);
  s.flag(8, 100390, 100260);
  const ema = s.ema();
  s.push(s.lastClose(), ema + 15, { low: ema - 40, high: ema + 25 }); // wick below, close above
  s.push(ema + 15, ema + 30, { low: ema + 8 });
  return s.candles;
}

/**
 * Acceptance below EMA21: the flag sags into EMA21 and two consecutive bars close
 * clearly under it. Expected: ema21Hold "acceptance_below", state "failed".
 */
export function acceptanceBelow() {
  const s = series(3);
  s.base(BASE_CANDLES).move(5, 80);
  s.flag(8, 100390, 100260);
  let ema = s.ema();
  s.push(s.lastClose(), ema - 30, { high: ema + 5, low: ema - 35 });
  ema = s.ema();
  s.push(ema - 30, ema - 35, { high: ema - 25, low: ema - 40 });
  return s.candles;
}

/**
 * Extended breakout: clean flag, then a break that runs far past the flag high.
 * Expected: chaseRisk true.
 */
export function extendedBreakout() {
  const s = series(4);
  s.base(BASE_CANDLES).move(5, 80);
  s.flag(6, 100385, 100300);
  s.push(s.lastClose(), 100395, { high: 100398 });
  s.push(100395, 100520, { low: 100390 });
  return s.candles;
}

/**
 * Perfectly flat candles: true range 0 everywhere, so `measureImpulse` (F1) can never
 * find a positive-range impulse no matter how far its lookback reaches. Used both as
 * `noImpulse()` and as neutral padding that cannot itself masquerade as a pole once
 * `flag.maxImpulseCandles` (F1 item 2, 8 -> 20) widens how far back the detector looks.
 */
function flatCandles(count, price = BASE_PRICE) {
  return Array.from({ length: count }, () => ({ open: price, high: price, low: price, close: price }));
}

/** No impulse: flat, zero-range candles. Expected: no candidates in either direction, at any lookback. */
export function noImpulse() {
  return flatCandles(BASE_CANDLES + 20);
}

/** Same flag as REGRESSION_001, one bar before the break. Expected: forming. */
export function formingFlag() {
  const s = series(1);
  s.base(BASE_CANDLES).move(5, 80);
  s.flag(6, 100385, 100300);
  return s.candles;
}

/** REGRESSION_001 truncated at the break candle. Expected: triggering. */
export function triggeringFlag() {
  return regression001().slice(0, -1);
}

/**
 * Phase 9: REGRESSION_001 through the break, then one close back under the flag low.
 * EMA21 sits far below, so this is not acceptance. Expected: failed, invalidation_close.
 */
export function invalidationClose() {
  return [...triggeringFlag(), { open: 100395, high: 100396, low: 100245, close: 100250 }];
}

/**
 * F1 item 1: an impulse that qualifies, then 1 (or 2, `pullbackCandles`) closed candles
 * pulling back without a new extreme beyond the impulse peak - not yet `minCandles`
 * pullback bars, so it is not a real flag yet either. Expected: state `proto`.
 * @param {1|2} pullbackCandles
 */
export function protoFlag(pullbackCandles = 1) {
  const s = series(11);
  s.base(BASE_CANDLES).move(5, 80);
  const peak = s.lastClose();
  s.push(peak, peak - 10, { high: peak + 1, low: peak - 15 });
  if (pullbackCandles === 2) s.push(s.lastClose(), peak - 5, { high: peak, low: peak - 15 });
  return s.candles;
}

/**
 * F1 item 3: the flag's first candle closes off-side of EMA21 (a dip below it right after
 * the pole), then the very next candle reclaims it (closes back on-side) - within
 * `flag.reclaimCandles` (default 2). Expected: `ema21Hold: "reclaim"`, candidate survives
 * (not failed).
 */
export function reclaimFlag() {
  const s = series(21);
  s.base(BASE_CANDLES).move(5, 80);
  const emaAfterPole = s.ema();
  s.push(s.lastClose(), emaAfterPole - 30, { high: emaAfterPole + 5, low: emaAfterPole - 35 }); // dip: off-side close
  s.push(s.lastClose(), s.ema() + 15, { high: s.ema() + 20, low: s.lastClose() - 5 }); // reclaim: back on-side
  const flagTop = s.lastClose() + 5;
  const flagBottom = s.lastClose() - 10;
  s.flag(4, flagTop, flagBottom);
  return s.candles;
}

/**
 * F1 items 4-5: REGRESSION_001 confirmed, then `extraCandles` more closes drifting up
 * (still above breakoutLevel, so it stays "confirmed" by the phase-4 rule on its own).
 * Past `flag.maxBreakoutAge` candles since the break this reads `expired` instead
 * (chaseRisk forced true); past `flag.maxBreakoutAge + flag.expiredTtlCandles` it is not
 * found at all.
 */
export function expiredConfirmed(extraCandles) {
  const base = regression001();
  const out = [...base];
  let last = out[out.length - 1].close;
  for (let i = 0; i < extraCandles; i++) {
    last += 1;
    out.push({ open: last - 1, high: last + 1, low: last - 2, close: last });
  }
  return out;
}

/**
 * A dedicated, modest pole/flag/break (F1 item 2 follow-up), shared by every fixture
 * below that needs to extend well past the break: with `maxImpulseCandles` widened
 * 8 -> 20, a handful of quiet bars after REGRESSION_001's much larger pole can
 * themselves look like a *fresh* forming flag from a tip-anchored window, masking
 * whatever the extension means to test - the pole and the extension would both be
 * within the wider lookback's reach. A small, purpose-built pole keeps that from
 * happening once the caller adds wide-wick padding (see `wideWickTail`).
 * @param {number} seed
 * @returns {{s:Object, flagHigh:number, flagLow:number}} `s` has already pushed the pole,
 *   flag, and break candle; `s.candles` is REGRESSION_001-shaped but ~60-point, not ~400.
 */
function smallPoleBreak(seed) {
  const s = series(seed);
  s.base(BASE_CANDLES).move(5, 12); // a modest pole - contractionRatio math needs it small
  const poleTop = s.lastClose();
  const flagHigh = poleTop - 2;
  const flagLow = poleTop - 17; // range 15, well under 0.5x the pole's ~60
  s.flag(6, flagHigh, flagLow);
  s.push(s.lastClose(), flagHigh + 3, { high: flagHigh + 4 }); // the break
  return { s, flagHigh, flagLow };
}

/**
 * `count` candles wicking `amplitude`+ points off `level` with `close` fixed there -
 * enough range that any window spanning one of them blows `maxContractionRatio` against
 * `smallPoleBreak`'s small pole, so a tip-anchored window can never mistake this padding
 * for a fresh consolidation. Close never moving means it never confirms or invalidates
 * anything past `level` either.
 */
function wideWickTail(s, level, count, amplitude = 60) {
  for (let i = 0; i < count; i++) {
    const wide = amplitude + (i % 2) * 20;
    s.push(level, level, { high: level + wide, low: level - wide });
  }
  return s;
}

/**
 * Phase 9: a break that sits `flag.maxBreakoutAge` candles unconfirmed, without a second
 * close above the flag high or a close below the flag low. Expected: failed, stale.
 */
export function staleBreak() {
  const { s, flagHigh, flagLow } = smallPoleBreak(6);
  wideWickTail(s, (flagHigh + flagLow) / 2, 5);
  return s.candles;
}

/**
 * F1 item 4: a break that closes back under the flag low once, then stays down for
 * `extraCandles` more (wide-wick, per `smallPoleBreak`/`wideWickTail`) - stays `failed`/
 * `invalidation_close` throughout; only default-payload visibility (services/
 * scalpContext.js's `failedTtlCandles` check) changes as `extraCandles` grows.
 */
export function invalidationCloseAged(extraCandles) {
  const { s, flagLow } = smallPoleBreak(7);
  const invalidatedLevel = flagLow - 10;
  s.push(s.lastClose(), invalidatedLevel, { high: s.lastClose() + 1, low: invalidatedLevel - 5 });
  wideWickTail(s, invalidatedLevel, extraCandles);
  return s.candles;
}
