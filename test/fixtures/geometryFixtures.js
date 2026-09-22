/**
 * Deterministic 4h candle builders for the geometry suites (phase 7/8) and the replay
 * harness (phase 10). Moved out of test-geometry.js unchanged so test-replay.js can
 * build the REGRESSION_002 history from the same series the unit tests use.
 *
 * `mirrorAround()` turns any series into its short twin by reflecting every price around
 * GEOMETRY_PIVOT, so short fixtures are the long fixtures, not hand-written look-alikes.
 */

import { INTERVAL_MS } from '../../services/scalpContext.js';

export const GEOMETRY_PIVOT = 100;
export const GEOMETRY_NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

const STEP_4H = INTERVAL_MS['4h'];

export function r4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/** Reflect a series around `pivot` (p -> 2*pivot - p, high/low swapped). */
export function mirrorAround(candles, pivot = GEOMETRY_PIVOT) {
  return candles.map((c) => ({
    ...c,
    open: r4(2 * pivot - c.open),
    high: r4(2 * pivot - c.low),
    low: r4(2 * pivot - c.high),
    close: r4(2 * pivot - c.close)
  }));
}

/**
 * Candles walking straight between turning points, `steps` candles per leg, with a
 * 0.1 wick either side of the body. The candle that closes on a turning point is the
 * pivot, so its low (or high) is exactly the turning point -/+ 0.1.
 */
export function legs(points, steps, stepMs = STEP_4H, startMs = GEOMETRY_NOW - 400 * STEP_4H) {
  const candles = [];
  let prev = points[0];
  for (let p = 1; p < points.length; p++) {
    const target = points[p];
    for (let s = 1; s <= steps; s++) {
      const close = r4(points[p - 1] + ((target - points[p - 1]) * s) / steps);
      const open = prev;
      const t = startMs + candles.length * stepMs;
      candles.push({
        timestamp: t,
        open,
        high: r4(Math.max(open, close) + 0.1),
        low: r4(Math.min(open, close) - 0.1),
        close,
        volume: 100,
        closeTime: t + stepMs
      });
      prev = close;
    }
  }
  return candles;
}

/**
 * REGRESSION_002 (full): 4h demand zone at ~95 (lows 95, 95.2, then 95 again) with a
 * rising diagonal support through the last three lows (91 → 93 → 95, one per 12
 * candles). The final leg is cut 3 candles after the last low, so the diagonal's current
 * level (~95.4) sits on top of the demand zone [94.9, 95.1]: one confluence zone.
 */
export function regression002Confluence() {
  return legs([80, 100, 95, 104, 95.2, 106, 91, 102, 93, 104, 95, 98], 6).slice(0, -3);
}
