/**
 * S0 swing research (docs/PROMPT_S0_SWING_RESEARCH.md, Agent S0-C - standard controls):
 * the null baseline every real rule must beat. Seeded, deterministic long/short pick at
 * every 4h close, using the SAME stop/TP mechanics as `ctl-4h-range-break.js` (shared
 * via that module's exported `rangeAt`, not reimplemented) - only the direction choice
 * and the removal of the 1D-bias/breakout gate differ.
 *
 * No lookahead: the 4h array is defensively re-sliced to `ctx.i`.
 *
 * Seed: `RANDOM_SEED` (fixed at 42) combined with `symbol` and the current candle's
 *   `timestamp` through a small FNV-1a hash feeding a mulberry32 PRNG - deterministic
 *   per (symbol, candle), independent of call order, so re-running the harness (or
 *   calling `signalAt` twice with the same ctx) reproduces the exact same signal.
 * Direction: PRNG draw < 0.5 -> long, else short. No trend/breakout condition.
 * Stop: prior-24h (6x4h) range midpoint, same as `ctl-4h-range-break`.
 * Target: TP1 = entry +/- one range-height, same as `ctl-4h-range-break`. When the
 *   random direction's stop/target geometry is invalid relative to the current close
 *   (e.g. long chosen but close sits below the range midpoint, so "stop below entry"
 *   fails), the signal is skipped (null) - the same risk>0 validity check the real rule
 *   applies, not an extra frequency filter.
 * Hold: 24h, mirroring `ctl-4h-range-break`.
 */

import { rangeAt } from './ctl-4h-range-break.js';

export const meta = {
  id: 'ctl-random-4h',
  label: 'Control: seeded random long/short (4h) - null baseline',
  source: 'docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C',
  tf: '4h',
  holdMaxHours: 24,
  stopKind: 'structure',
  notes: 'Null baseline: seeded (RANDOM_SEED=42) deterministic random direction at every 4h close, no trend/breakout condition; same range-midpoint stop / range-height TP1 mechanics as ctl-4h-range-break. Every real S0 rule must beat this on net expectancy.'
};

export const RANDOM_SEED = 42;

/** FNV-1a, 32-bit unsigned. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let k = 0; k < str.length; k++) {
    h ^= str.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: deterministic PRNG from a 32-bit seed, returns a fn producing floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exported for tests: the deterministic [0,1) draw for a given (seed, symbol, timestamp). */
export function seededDraw(seed, symbol, timestamp) {
  const hash = fnv1a(`${seed}:${symbol}:${timestamp}`);
  return mulberry32(hash)();
}

export function signalAt(ctx) {
  const { candlesByTf, i, symbol } = ctx || {};
  const raw4h = candlesByTf && candlesByTf['4h'];
  if (!Array.isArray(raw4h) || !Number.isInteger(i) || i < 0 || !symbol) return null;

  const candles4h = raw4h.slice(0, i + 1); // defensive: never trust anything past i
  const range = rangeAt(candles4h);
  if (!range || !(range.height > 0)) return null;

  const current = candles4h[candles4h.length - 1];
  const draw = seededDraw(RANDOM_SEED, symbol, current.timestamp);
  const direction = draw < 0.5 ? 'long' : 'short';

  const entry = current.close;
  const stop = range.mid;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null; // random direction's geometry invalid at this close - skip, don't force a trade

  const tp1 = direction === 'long' ? entry + range.height : entry - range.height;

  return {
    direction,
    entry,
    stop,
    tp1,
    reason: [
      `seeded random draw ${draw.toFixed(4)} (seed ${RANDOM_SEED}, symbol ${symbol}, ts ${current.timestamp}) -> ${direction}`,
      `stop at the 24h range midpoint (${stop}), same mechanics as ctl-4h-range-break`,
      `TP1 = entry +/- one range-height (${range.height}) -> ${tp1}`
    ]
  };
}
