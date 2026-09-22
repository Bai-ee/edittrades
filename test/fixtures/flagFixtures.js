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

/** No impulse: quiet chop only. Expected: no candidates in either direction. */
export function noImpulse() {
  return series(5).base(BASE_CANDLES + 20).candles;
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
 * Phase 9: REGRESSION_001 through the break, then four bars back inside the flag without
 * a second close above it or a close below it. The break has sat `flag.maxBreakoutAge`
 * candles unconfirmed. Expected: failed, stale.
 */
export function staleBreak() {
  return [
    ...triggeringFlag(),
    { open: 100395, high: 100397, low: 100360, close: 100370 },
    { open: 100370, high: 100380, low: 100340, close: 100350 },
    { open: 100350, high: 100370, low: 100340, close: 100360 },
    { open: 100360, high: 100370, low: 100345, close: 100355 }
  ];
}
