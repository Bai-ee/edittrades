/**
 * Market Structure Detection
 *
 * Pure, side-effect-free helpers for deriving swing points, session levels,
 * and simple support/resistance clusters from OHLCV candle arrays.
 * No network calls. Deliberately independent of lib/levels.js.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {*} value
 * @returns {boolean} true when value is a finite number
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Coerce a value to a finite number, or null.
 * @param {*} value
 * @returns {number|null}
 */
function toFiniteOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Start of the UTC calendar day (midnight) containing the given timestamp.
 * @param {number} ts - epoch ms
 * @returns {number} epoch ms
 */
function utcDayStart(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Compute the high/low range for candles whose timestamp falls within [start, end).
 * @param {Array} candles
 * @param {number} start - inclusive epoch ms
 * @param {number} end - exclusive epoch ms
 * @returns {{high: number|null, low: number|null}}
 */
function computeRangeForDay(candles, start, end) {
  if (!Array.isArray(candles) || candles.length === 0) return { high: null, low: null };

  let high = null;
  let low = null;

  for (const candle of candles) {
    if (!candle || !isFiniteNumber(candle.timestamp) || !isFiniteNumber(candle.high) || !isFiniteNumber(candle.low)) {
      continue;
    }
    if (candle.timestamp < start || candle.timestamp >= end) continue;

    if (high === null || candle.high > high) high = candle.high;
    if (low === null || candle.low < low) low = candle.low;
  }

  return { high, low };
}

/**
 * Find the most recent daily candle whose UTC day is strictly before todayStart.
 * @param {Array} candles - daily candles
 * @param {number} todayStart - epoch ms for start of current UTC day
 * @returns {Object|null}
 */
function findPrevDayCandle(candles, todayStart) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let best = null;
  let bestDayStart = -Infinity;

  for (const candle of candles) {
    if (!candle || !isFiniteNumber(candle.timestamp)) continue;
    const dayStart = utcDayStart(candle.timestamp);
    if (dayStart < todayStart && dayStart > bestDayStart) {
      best = candle;
      bestDayStart = dayStart;
    }
  }

  return best;
}

/**
 * Sort and dedupe a list of candidate levels relative to price.
 * @param {Array<number>} values
 * @param {'support'|'resistance'} kind
 * @returns {Array<number>} up to 3 distinct levels, nearest-to-price first
 */
function dedupeNearest(values, kind) {
  const seen = new Set();
  const unique = [];

  for (const v of values) {
    if (!isFiniteNumber(v)) continue;
    const key = v.toFixed(8);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }

  unique.sort((a, b) => (kind === 'support' ? b - a : a - b));
  return unique.slice(0, 3);
}

/**
 * Detect swing highs/lows using a simple fractal lookback.
 * A swing high is a candle whose high is >= the highs of `lookback` candles either side.
 * A swing low is a candle whose low is <= the lows of `lookback` candles either side.
 * @param {Array<Object>} candles - OHLCV candles, oldest first
 * @param {number} [lookback=3] - candles to check on each side
 * @returns {{swingHighs: Array<{price:number,timestamp:number|null}>, swingLows: Array<{price:number,timestamp:number|null}>}}
 */
export function findSwings(candles, lookback = 3) {
  const empty = { swingHighs: [], swingLows: [] };

  if (!Array.isArray(candles) || candles.length === 0) return empty;

  const lb = isFiniteNumber(lookback) && lookback > 0 ? Math.floor(lookback) : 3;
  const n = candles.length;
  if (n < lb * 2 + 1) return empty;

  const swingHighs = [];
  const swingLows = [];

  for (let i = lb; i < n - lb; i++) {
    const candle = candles[i];
    if (!candle || !isFiniteNumber(candle.high) || !isFiniteNumber(candle.low)) continue;

    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      const other = candles[j];
      if (!other || !isFiniteNumber(other.high) || !isFiniteNumber(other.low)) {
        isSwingHigh = false;
        isSwingLow = false;
        break;
      }
      if (other.high > candle.high) isSwingHigh = false;
      if (other.low < candle.low) isSwingLow = false;
    }

    if (isSwingHigh) {
      swingHighs.push({
        price: candle.high,
        timestamp: isFiniteNumber(candle.timestamp) ? candle.timestamp : null
      });
    }
    if (isSwingLow) {
      swingLows.push({
        price: candle.low,
        timestamp: isFiniteNumber(candle.timestamp) ? candle.timestamp : null
      });
    }
  }

  return {
    swingHighs: swingHighs.slice(-5),
    swingLows: swingLows.slice(-5)
  };
}

/**
 * Build a market-structure snapshot: session range, previous-day range,
 * recent swings, and nearby support/resistance clusters.
 *
 * @param {Object} params
 * @param {Array<Object>} [params.candles1d] - daily candles
 * @param {Array<Object>} [params.candles1h] - hourly candles
 * @param {Array<Object>} [params.candles15m] - 15m candles
 * @param {number} [params.price] - current price
 * @param {number} [params.ema21] - current 21 EMA
 * @param {number} [params.ema200] - current 200 EMA
 * @param {number} [params.now] - epoch ms "now" (defaults to Date.now())
 * @returns {{
 *   sessionHigh: number|null, sessionLow: number|null,
 *   prevDayHigh: number|null, prevDayLow: number|null,
 *   swingHighs: Array<{price:number,timestamp:number|null}>,
 *   swingLows: Array<{price:number,timestamp:number|null}>,
 *   support: Array<number>, resistance: Array<number>,
 *   aboveEma21: boolean|null, aboveEma200: boolean|null
 * }}
 */
export function buildStructure(params = {}) {
  const {
    candles1d = [],
    candles1h = [],
    candles15m = [],
    price = null,
    ema21 = null,
    ema200 = null,
    now = Date.now()
  } = params || {};

  const safePrice = toFiniteOrNull(price);
  const safeEma21 = toFiniteOrNull(ema21);
  const safeEma200 = toFiniteOrNull(ema200);
  const safeNow = isFiniteNumber(now) ? now : Date.now();

  const todayStart = utcDayStart(safeNow);
  const todayEnd = todayStart + DAY_MS;

  const safeCandles1h = Array.isArray(candles1h) ? candles1h : [];
  const safeCandles15m = Array.isArray(candles15m) ? candles15m : [];
  const safeCandles1d = Array.isArray(candles1d) ? candles1d : [];

  // Session high/low: current UTC day from 1h candles, fall back to 15m.
  let session = computeRangeForDay(safeCandles1h, todayStart, todayEnd);
  if (session.high === null || session.low === null) {
    const fallback = computeRangeForDay(safeCandles15m, todayStart, todayEnd);
    session = {
      high: session.high !== null ? session.high : fallback.high,
      low: session.low !== null ? session.low : fallback.low
    };
  }

  // Previous completed UTC day from daily candles.
  const prevDayCandle = findPrevDayCandle(safeCandles1d, todayStart);
  const prevDayHigh = prevDayCandle ? toFiniteOrNull(prevDayCandle.high) : null;
  const prevDayLow = prevDayCandle ? toFiniteOrNull(prevDayCandle.low) : null;

  // Swing points from 1h candles.
  const { swingHighs, swingLows } = findSwings(safeCandles1h);

  const sessionHigh = toFiniteOrNull(session.high);
  const sessionLow = toFiniteOrNull(session.low);

  const resistanceCandidates = [];
  const supportCandidates = [];

  for (const swing of swingHighs) {
    if (isFiniteNumber(swing.price)) resistanceCandidates.push(swing.price);
  }
  for (const swing of swingLows) {
    if (isFiniteNumber(swing.price)) supportCandidates.push(swing.price);
  }
  if (isFiniteNumber(sessionHigh)) resistanceCandidates.push(sessionHigh);
  if (isFiniteNumber(sessionLow)) supportCandidates.push(sessionLow);
  if (isFiniteNumber(prevDayHigh)) resistanceCandidates.push(prevDayHigh);
  if (isFiniteNumber(prevDayLow)) supportCandidates.push(prevDayLow);

  const support = safePrice !== null
    ? dedupeNearest(supportCandidates.filter((v) => v < safePrice), 'support')
    : [];
  const resistance = safePrice !== null
    ? dedupeNearest(resistanceCandidates.filter((v) => v > safePrice), 'resistance')
    : [];

  const aboveEma21 = safePrice !== null && safeEma21 !== null ? safePrice > safeEma21 : null;
  const aboveEma200 = safePrice !== null && safeEma200 !== null ? safePrice > safeEma200 : null;

  return {
    sessionHigh,
    sessionLow,
    prevDayHigh,
    prevDayLow,
    swingHighs,
    swingLows,
    support,
    resistance,
    aboveEma21,
    aboveEma200
  };
}

export default {
  findSwings,
  buildStructure
};
