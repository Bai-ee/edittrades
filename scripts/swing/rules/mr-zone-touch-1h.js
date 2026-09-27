/**
 * S1 mean-reversion rule: mr-zone-touch-1h (docs/PROMPT_S1_EDGE_SEARCH.md Agent D).
 *
 * Thesis: a 1h close lands inside a horizontal support or resistance zone (own-timeframe
 * 1h zones, or the 15m zone map at the same close time when 1h has none) while the
 * higher-timeframe (4h + 1D) lean opposes the move that produced the touch - i.e. price
 * fell into support with a net-bullish 4h/1D lean (reversion up), or rose into resistance
 * with a net-bearish 4h/1D lean (reversion down). Entry is the touching 1h close; stop
 * sits 0.5x ATR(1h) beyond the far side of the touched zone (a clean break invalidates
 * the zone read); TP1 is the midpoint of the nearest opposing zone ("zone mid-to-mid"),
 * or 2R when no opposing zone exists on that side.
 *
 * Self-contained on purpose, matching every other scripts/swing/rules/*.js module
 * (pb-ema21-pullback-1d, pb-4h-flag-continuation, ctl-4h-range-break, ctl-random-4h):
 * this reads only `ctx.candlesByTf` (+ `ctx.i`), not `ctx.geometry`/`ctx.topDown`/
 * `ctx.indicatorsByTf`. The harness (scripts/swing/run.js) builds those from the real
 * pipeline, but no existing rule module depends on them, and depending on them would make
 * this module's own tests need to hand-build those objects instead of plain candle
 * arrays. Zones come from `lib/geometry.js` (`swingPivots`, `horizontalZones`, `atr`)
 * read-only, the same functions `buildGeometryContext` itself calls, with the same
 * `config/engine.js` zone-tolerance constant (read-only import, per the S1 hard rules) -
 * so a "zone" here is byte-for-byte the production zone definition, just computed
 * directly instead of via buildGeometryContext (which also lacks a Geometry-B confluence
 * field on the harness's ctx.geometry - horizontal S/R is what is actually available).
 *
 * 4h/1D lean is a documented re-derivation of `lib/topDown.js` `buildWeeklyLean`'s own
 * method (price-vs-EMA21 sign + EMA21-slope sign, averaged), applied to 4h/1D candle
 * closes instead of weekly-aggregated closes - topDown.js exports no non-weekly lean;
 * this mirrors `scripts/swing/run.js`'s own harness-local `leanFrom()`, documented there
 * for the identical reason.
 *
 * No lookahead: the 1h array is truncated to `candlesByTf['1h'].slice(0, i + 1)`; the
 * cross-timeframe 15m/4h/1D arrays are defensively re-clipped to candles at or before the
 * current 1h candle's close time.
 */

import { swingPivots, horizontalZones, atr as geometryAtr } from '../../../lib/geometry.js';
import { ENGINE_CONFIG } from '../../../config/engine.js';

const OWN_TF = '1h';
const ZONE_TF_CROSS = '15m';

const STOP_ATR_MULTIPLE = 0.5;
const FALLBACK_TP_R_MULTIPLE = 2;
const MIN_CANDLES_FOR_ZONES = 50;
const EMA_LEAN_PERIOD = 21;
const LEAN_SLOPE_LOOKBACK = 3;

export const meta = {
  id: 'mr-zone-touch-1h',
  label: 'Mean reversion: 1h/15m S-R zone touch, 4h/1D lean opposing',
  source: 'docs/PROMPT_S1_EDGE_SEARCH.md Agent D',
  tf: OWN_TF,
  holdMaxHours: 24,
  stopKind: 'atr',
  notes: [
    'Zone: a 1h close lands inside a horizontal support/resistance zone from lib/geometry.js (own-timeframe 1h zones, or the 15m zone map at the same close time when 1h has none) - zone side (support/resistance) sets the candidate reversion direction; a flipped ("both") zone is skipped, not guessed.',
    "4h/1D lean opposing: a documented re-derivation of lib/topDown.js buildWeeklyLean's own price-vs-EMA21 + EMA21-slope method, applied to 4h and 1D closes; a support touch needs a net-bullish 4h+1D lean (opposing further downside), a resistance touch a net-bearish one.",
    'Stop 0.5x ATR(1h) beyond the far side of the touched zone; TP1 is the midpoint of the nearest opposing zone (zone mid-to-mid) or 2R when none exists; hold 24h.'
  ].join('\n')
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function candleTime(c) {
  if (isFiniteNumber(c.closeTime)) return c.closeTime;
  if (isFiniteNumber(c.timestamp)) return c.timestamp;
  return null;
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

function clipTo(candles, cutoffMs) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => {
    const t = candleTime(c);
    return t === null ? false : t <= cutoffMs;
  });
}

/** SMA-seeded EMA, tail-aligned to `values` (same formula every rule module in this dir uses). */
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
 * Zones for one already-truncated candle array: ATR(default period) + horizontalZones at
 * the production zone tolerance (config/engine.js geometry.zoneToleranceAtr), through
 * lib/geometry.js's own swingPivots/horizontalZones. Null when there is too little
 * history or ATR cannot be computed.
 * @param {Array<Object>} candles - closed candles, oldest first, already truncated to "now"
 * @returns {{atr:number, zones:Array<Object>}|null}
 */
export function computeZones(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES_FOR_ZONES || !candles.every(isValidCandle)) return null;
  const a = geometryAtr(candles);
  if (!a || !isFiniteNumber(a.atr) || a.atr <= 0) return null;
  const pivots = swingPivots(candles);
  const tolerance = a.atr * ENGINE_CONFIG.geometry.zoneToleranceAtr;
  const zones = horizontalZones(pivots, tolerance);
  return { atr: a.atr, zones };
}

/** The zone (if any) whose [low, high] band contains `price`. */
export function findTouchedZone(zones, price) {
  if (!Array.isArray(zones) || !isFiniteNumber(price)) return null;
  return zones.find((z) => price >= z.low && price <= z.high) || null;
}

/** Nearest zone strictly beyond `price` in direction `sign` (1 = above, -1 = below) whose side is not `excludeSide`. */
function nearestOpposingZone(zones, price, sign, excludeSide) {
  let best = null;
  let bestDist = Infinity;
  for (const z of Array.isArray(zones) ? zones : []) {
    if (z.side === excludeSide) continue;
    const mid = (z.low + z.high) / 2;
    if (sign * mid <= sign * price) continue;
    const dist = sign === 1 ? Math.max(0, z.low - price) : Math.max(0, price - z.high);
    if (dist < bestDist) { bestDist = dist; best = z; }
  }
  return best;
}

/**
 * Documented re-derivation of lib/topDown.js buildWeeklyLean's own method (price-vs-EMA21
 * sign + EMA21-slope sign, averaged) at candle granularity instead of weekly, matching
 * scripts/swing/run.js's own harness-local leanFrom() for the same reason (topDown.js
 * exports no non-weekly lean).
 * @returns {'bull'|'bear'|'neutral'|null} null on insufficient history
 */
export function deriveLean(candles, lookback = LEAN_SLOPE_LOOKBACK) {
  if (!Array.isArray(candles) || candles.length < EMA_LEAN_PERIOD + lookback + 1 || !candles.every(isValidCandle)) return null;
  const closes = candles.map((c) => c.close);
  const emaHist = emaSeries(closes, EMA_LEAN_PERIOD);
  const last = emaHist.length - 1;
  const ema21 = emaHist[last];
  const priorIdx = last - lookback;
  const priorEma = priorIdx >= 0 ? emaHist[priorIdx] : null;
  if (!isFiniteNumber(ema21) || !isFiniteNumber(priorEma)) return null;
  const close = closes[last];
  const priceSign = Math.sign(close - ema21);
  const slopeSign = Math.sign(ema21 - priorEma);
  const score = (priceSign + slopeSign) / 2;
  return score > 0 ? 'bull' : score < 0 ? 'bear' : 'neutral';
}

function leanSign(lean) {
  return lean === 'bull' ? 1 : lean === 'bear' ? -1 : 0;
}

/**
 * @param {Object} ctx - { symbol, tf, i, candlesByTf } per the S0/S1 swing-research contract
 * @returns {null|{direction:'long'|'short', entry:number, stop:number, tp1:number, reason:string[]}}
 */
export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw1h = candlesByTf[OWN_TF];
  if (!Array.isArray(raw1h) || i >= raw1h.length) return null;
  const own1h = raw1h.slice(0, i + 1);
  if (own1h.length < MIN_CANDLES_FOR_ZONES || !own1h.every(isValidCandle)) return null;

  const nowMs = candleTime(own1h[own1h.length - 1]);
  if (nowMs === null) return null;
  const price = own1h[own1h.length - 1].close;

  // ATR(1h) is needed for the stop regardless of which timeframe's zone map fires, so it
  // is computed once, up front, from the own-timeframe array only.
  const zones1hInfo = computeZones(own1h);
  if (!zones1hInfo) return null;
  const atr1h = zones1hInfo.atr;

  let touched = findTouchedZone(zones1hInfo.zones, price);
  let sourceZones = zones1hInfo.zones;
  if (!touched) {
    const cross15m = clipTo(candlesByTf[ZONE_TF_CROSS], nowMs);
    const zones15Info = computeZones(cross15m);
    if (zones15Info) {
      const t15 = findTouchedZone(zones15Info.zones, price);
      if (t15) { touched = t15; sourceZones = zones15Info.zones; }
    }
  }
  if (!touched || touched.side === 'both') return null;

  const lean4h = deriveLean(clipTo(candlesByTf['4h'], nowMs));
  const lean1d = deriveLean(clipTo(candlesByTf['1d'], nowMs));
  if (!lean4h || !lean1d) return null;
  const score = leanSign(lean4h) + leanSign(lean1d);

  let direction = null;
  if (touched.side === 'support' && score > 0) direction = 'long';
  else if (touched.side === 'resistance' && score < 0) direction = 'short';
  if (!direction) return null;

  const entry = price;
  const stop = direction === 'long' ? touched.low - STOP_ATR_MULTIPLE * atr1h : touched.high + STOP_ATR_MULTIPLE * atr1h;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const oppSign = direction === 'long' ? 1 : -1;
  const excludeSide = direction === 'long' ? 'support' : 'resistance';
  const oppZone = nearestOpposingZone(sourceZones, price, oppSign, excludeSide);
  const fallbackTp1 = direction === 'long' ? entry + FALLBACK_TP_R_MULTIPLE * risk : entry - FALLBACK_TP_R_MULTIPLE * risk;
  let tp1 = fallbackTp1;
  let tp1Source = `${FALLBACK_TP_R_MULTIPLE}R fallback`;
  if (oppZone) {
    const mid = (oppZone.low + oppZone.high) / 2;
    const profitable = direction === 'long' ? mid > entry : mid < entry;
    if (profitable) { tp1 = mid; tp1Source = 'opposing zone mid'; }
  }

  const reason = [
    `1h close ${entry} touched a ${touched.side} zone [${touched.low}, ${touched.high}] (${touched.touches} touches)`,
    `4h lean ${lean4h}, 1D lean ${lean1d} (net score ${score}) opposes the move -> ${direction}`,
    `stop ${STOP_ATR_MULTIPLE}x ATR1h (${atr1h}) beyond the zone; TP1 = ${tp1Source} (${tp1})`
  ];

  return { direction, entry, stop, tp1, reason };
}

export default { meta, signalAt };
