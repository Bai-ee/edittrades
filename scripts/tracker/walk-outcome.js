/**
 * Vendored, dependency-free copy of `walkOutcome` (and the tiny helpers it needs) from
 * the engine repo's scripts/replay-outcomes.js (snapshot_tradingview, schema 1.18.0,
 * commit b3b5cbe). Copied, not imported, so the tracker repo runs its own scripts with
 * no engine checkout. Keep the walk body byte-for-byte in step with the source; the
 * engine repo's test-tracker.js runs a parity check against the original.
 *
 * FILL_WINDOW_CANDLES mirrors ENGINE_CONFIG.replay.outcomes.fillWindowCandles (15).
 */

export const FILL_WINDOW_CANDLES = 15;

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function round(v, n = 4) {
  return isFiniteNumber(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round((sorted[mid - 1] + sorted[mid]) / 2, 2);
}

/**
 * Walk 1m candles forward from `fromMs` looking for the entry zone, then for stop or
 * target. No lookahead: only candles at or after `fromMs` are ever read.
 * @param {Object} p
 * @param {Array<{timestamp:number, high:number, low:number}>} p.candles1m - ascending
 * @param {number} p.fromMs - the signal's closedThrough, in ms
 * @param {'long'|'short'} p.direction
 * @param {number} p.entryMin
 * @param {number} p.entryMax
 * @param {number} p.stop
 * @param {number} p.target
 * @param {number} p.fillWindowCandles
 * @param {number} p.maxHoldCandles
 * @param {boolean} [p.prefilled=false] - review fix 8: the position is already filled at
 *   `fromMs` (a `ready` flag plan: its retest candle traded the entry level and closed
 *   holding it). No touch search; the walk starts at the first candle at/after `fromMs`,
 *   and a target touch on that first candle counts (the fill precedes it).
 * @returns {{status:'invalid_levels'|'not_filled'|'open'|'win'|'loss', r?:number, holdCandles?:number, timeToTP1Candles?:number}}
 */
export function walkOutcome({ candles1m, fromMs, direction, entryMin, entryMax, stop, target, fillWindowCandles, maxHoldCandles, prefilled = false }) {
  if (!Array.isArray(candles1m) || !isFiniteNumber(entryMin) || !isFiniteNumber(entryMax)
    || !isFiniteNumber(stop) || !isFiniteNumber(target)) {
    return { status: 'invalid_levels' };
  }

  let start = 0;
  while (start < candles1m.length && candles1m[start].timestamp < fromMs) start++;

  const zoneLow = Math.min(entryMin, entryMax);
  const zoneHigh = Math.max(entryMin, entryMax);
  const fillEnd = Math.min(candles1m.length, start + fillWindowCandles);
  let fillIdx = -1;
  if (prefilled) fillIdx = start < candles1m.length ? start : -1;
  else for (let i = start; i < fillEnd; i++) {
    const c = candles1m[i];
    if (c.low <= zoneHigh && c.high >= zoneLow) { fillIdx = i; break; }
  }
  if (fillIdx === -1) return { status: 'not_filled' };

  const long = direction !== 'short';
  // Unfavorable fill (signal-reliability minimum plan, work package 3): a resting
  // limit fills at its own price when touched, never better - the worst price still
  // inside the zone (entryMax for a long, entryMin for a short), not the midpoint.
  const entry = long ? zoneHigh : zoneLow;
  const rTarget = round(Math.abs(target - entry) / Math.abs(entry - stop), 4);

  const exitEnd = Math.min(candles1m.length, fillIdx + maxHoldCandles);
  for (let i = fillIdx; i < exitEnd; i++) {
    const c = candles1m[i];
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const targetHit = long ? c.high >= target : c.low <= target;
    const holdCandles = i - fillIdx + 1;
    // Same-candle stop still loses (conservative either way). A target touch on the
    // fill candle itself is never credited as a win: entry and target order within
    // that one candle is unknowable from OHLC alone, so only a LATER candle's target
    // touch - after the fill is already unambiguous history - counts (no false
    // intrabar wins; work package 3, item 1).
    if (stopHit) return { status: 'loss', r: -1, holdCandles, ambiguous: targetHit };
    if (targetHit && (prefilled || i > fillIdx)) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };
  }
  return { status: 'open', holdCandles: exitEnd - fillIdx };
}
