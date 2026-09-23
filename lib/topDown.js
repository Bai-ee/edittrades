/**
 * Top-down sentiment (trading-model quick pass Q3; master plan M-1, M-2, M-6, M-6b).
 *
 * Pure, no I/O. Three pieces:
 *   - weeklyFromDaily / buildWeeklyLean: 1D candles already fetched aggregate into ISO
 *     weeks (Monday 00:00 UTC), giving a weekly lean from the last close vs weekly EMA21
 *     and its 3-week slope. Weekly EMA200 needs ~200 weeks of history this engine does
 *     not have, so it is always null with a reason.
 *   - buildTopDown: a weighted vote over the 1W/1D/4H/1H leans (config
 *     model.topDownWeights; higher timeframes dominate per M-6b) gives one sentiment,
 *     how many of the four agree with it, and a 0-1 conviction score.
 *   - buildAboveBelow200: how many of the timeframes that have an EMA200 (1m-1D) sit on
 *     each side, weighted the same way (config model.above200Weights).
 *
 * Never gates or changes a strategy, candidate or confidence (M-2, M-6): this module only
 * describes the market, it does not decide anything. One code path for both directions:
 * every lean is a sign (+1 bull, -1 bear, 0 neutral); a mirrored market yields the
 * mirrored sentiment with an identical score.
 */

import { ENGINE_CONFIG } from '../config/engine.js';

const DAY_MS = 86400000;
const SIGN = { bull: 1, bear: -1, neutral: 0 };

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round(v, n = 4) {
  return isFiniteNumber(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

function isValidDaily(c) {
  return c && isFiniteNumber(c.timestamp) && isFiniteNumber(c.open) && isFiniteNumber(c.high)
    && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

/** Monday 00:00 UTC of the week containing `tsMs`. */
function isoWeekStartUtc(tsMs) {
  const d = new Date(tsMs);
  const utcDay = d.getUTCDay(); // 0 Sun .. 6 Sat
  const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - daysSinceMonday * DAY_MS;
}

/**
 * Aggregate closed 1D candles into 1W candles, bucketed to ISO weeks (Monday 00:00 UTC).
 * The last bucket is dropped when it holds fewer than 7 daily candles - the current week,
 * still forming.
 * @param {Array<Object>} dailyCandles - closed 1D candles, any order
 * @returns {Array<{timestamp:number, open:number, high:number, low:number, close:number, days:number}>}
 *   ascending by timestamp
 */
export function weeklyFromDaily(dailyCandles) {
  if (!Array.isArray(dailyCandles)) return [];
  const sorted = dailyCandles.filter(isValidDaily).sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) return [];

  const byWeek = new Map();
  for (const c of sorted) {
    const key = isoWeekStartUtc(c.timestamp);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(c);
  }

  const weeks = [...byWeek.keys()].sort((a, b) => a - b).map((key) => {
    const chunk = byWeek.get(key);
    return {
      timestamp: key,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      days: chunk.length
    };
  });

  if (weeks.length > 0 && weeks[weeks.length - 1].days < 7) weeks.pop();
  return weeks;
}

/**
 * EMA of `values` (SMA-seeded), aligned 1:1 to `values`; entries before `period - 1` are
 * null. Deliberately local (not services/indicators.js): this module stays pure and
 * dependency-free, and weekly series are short enough that a hand-rolled EMA is plenty.
 * @param {Array<number>} values
 * @param {number} period
 * @returns {Array<number|null>}
 */
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Weekly lean (M-2, M-6): last weekly close vs weekly EMA21, plus the EMA21 slope over
 * the last `weeklySlopeLookbackWeeks` weeks. Weekly EMA200 is always null - not enough
 * weekly history exists (~71 weeks at 500 daily candles, 200 needed) - with a reason.
 * Too few weeks for even the EMA21 (config model.weeklyMinWeeksForEma21) reads neutral
 * with its own reason instead of computing on thin data.
 * @param {Array<Object>} dailyCandles - closed 1D candles
 * @param {Object} [cfg=ENGINE_CONFIG.model]
 * @returns {{bias:'bull'|'bear'|'neutral', strength:number, close:number|null, ema21:number|null, ema21Slope:number|null, ema200:null, reason:string|null}}
 */
export function buildWeeklyLean(dailyCandles, cfg = ENGINE_CONFIG.model) {
  const weeks = weeklyFromDaily(dailyCandles);
  const closeRaw = weeks.length > 0 ? weeks[weeks.length - 1].close : null;
  const minWeeks = cfg.weeklyMinWeeksForEma21;
  const lookback = cfg.weeklySlopeLookbackWeeks;

  // Published prices round2 like every other price field in the payload (2026-09-23
  // follow-up item 1b): the sign/score math below still uses the unrounded values, so
  // rounding here only cleans the output, it never moves the bull/bear/neutral call.
  const close = round(closeRaw, 2);

  if (weeks.length < minWeeks) {
    return { bias: 'neutral', strength: 0, close, ema21: null, ema21Slope: null, ema200: null, reason: 'insufficient history for weekly EMA21' };
  }

  const closes = weeks.map((w) => w.close);
  const ema21History = emaSeries(closes, 21);
  const ema21 = ema21History[ema21History.length - 1];
  const priorIdx = ema21History.length - 1 - lookback;
  const ema21Slope = priorIdx >= 0 && isFiniteNumber(ema21History[priorIdx]) ? ema21 - ema21History[priorIdx] : null;

  const priceSign = isFiniteNumber(closeRaw) && isFiniteNumber(ema21) ? Math.sign(closeRaw - ema21) : 0;
  const slopeSign = isFiniteNumber(ema21Slope) ? Math.sign(ema21Slope) : 0;
  const score = (priceSign + slopeSign) / 2;
  const bias = score > 0 ? 'bull' : score < 0 ? 'bear' : 'neutral';

  return {
    bias,
    strength: Math.round(Math.abs(score) * 100),
    close,
    ema21: round(ema21, 2),
    ema21Slope: round(ema21Slope, 2),
    ema200: null,
    reason: 'insufficient history for weekly EMA200'
  };
}

/**
 * Weighted vote over the four top-down leans (M-1, M-2, M-6b): higher timeframes
 * dominate. `aligned` counts how many of the four agree with the result:
 *   - bull/bear sentiment: how many of the four leans share that sign.
 *   - mixed sentiment (net weighted vote exactly 0, 2026-09-23 follow-up item 4): the
 *     weighted vote cancelled out, but the four leans still split some way, e.g. 2 bull
 *     + 2 bear at equal-and-opposite weight, or 1 bull + 1 bear + 2 neutral. `aligned` is
 *     the larger of the bull count and the bear count (a neutral lean is not "aligned
 *     with mixed" - it isn't part of either side), ties going to the bull count. This
 *     reads as "how many timeframes back the stronger of the two sides", not as
 *     agreement with a direction that does not exist.
 * @param {{'1w':'bull'|'bear'|'neutral', '1d':string, '4h':string, '1h':string}} leans
 * @param {Object} [weights=ENGINE_CONFIG.model.topDownWeights]
 * @returns {{sentiment:'bull'|'bear'|'mixed', aligned:number, score:number}}
 */
export function buildTopDown(leans, weights = ENGINE_CONFIG.model.topDownWeights) {
  const tfs = ['1w', '1d', '4h', '1h'];
  let num = 0;
  let den = 0;
  let bullCount = 0;
  let bearCount = 0;
  for (const tf of tfs) {
    const w = weights[tf] || 0;
    const s = SIGN[leans[tf]] ?? 0;
    num += w * s;
    den += w;
    if (s > 0) bullCount++;
    else if (s < 0) bearCount++;
  }
  const sentiment = num > 0 ? 'bull' : num < 0 ? 'bear' : 'mixed';
  let aligned;
  if (sentiment === 'mixed') {
    aligned = bearCount > bullCount ? bearCount : bullCount;
  } else {
    const targetSign = sentiment === 'bull' ? 1 : -1;
    aligned = tfs.filter((tf) => (SIGN[leans[tf]] ?? 0) === targetSign).length;
  }
  const score = den > 0 ? round(Math.abs(num) / den) : 0;
  return { sentiment, aligned, score };
}

/**
 * How many of the timeframes with an EMA200 (1m-1D) sit above/below it, weighted so
 * higher timeframes count for more (config model.above200Weights, M-6: "the more
 * timeframes above the 200, the stronger the bull case"). Never filters anything.
 * @param {Object} emaSides - tf -> 'above'|'below'|null (null = EMA200 unavailable, excluded)
 * @param {Object} [weights=ENGINE_CONFIG.model.above200Weights]
 * @returns {{above200:{count:number,of:number,weighted:number|null}, below200:{count:number,of:number,weighted:number|null}}}
 */
export function buildAboveBelow200(emaSides, weights = ENGINE_CONFIG.model.above200Weights) {
  let count = 0;
  let of = 0;
  let wAbove = 0;
  let wTotal = 0;
  for (const [tf, side] of Object.entries(emaSides || {})) {
    if (side !== 'above' && side !== 'below') continue;
    of++;
    const w = weights[tf] || 0;
    wTotal += w;
    if (side === 'above') { count++; wAbove += w; }
  }
  const weighted = wTotal > 0 ? round(wAbove / wTotal) : null;
  const belowWeighted = wTotal > 0 ? round((wTotal - wAbove) / wTotal) : null;
  return {
    above200: { count, of, weighted },
    below200: { count: of - count, of, weighted: belowWeighted }
  };
}

export default { weeklyFromDaily, buildWeeklyLean, buildTopDown, buildAboveBelow200 };
