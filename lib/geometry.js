/**
 * Geometry A (phase 7): pivots, horizontal zones, ATR, room to the next zone, extension
 * from EMA21, EMA slopes, Stoch RSI acceleration - per timeframe, on closed candles.
 * Geometry B (phase 8): diagonal support/resistance, channel, confluence zones.
 *
 * Direction symmetry by construction: every feature with a side (pivot highs vs lows,
 * higher lows vs lower highs, support vs resistance, room up vs room down) is computed by
 * one helper parameterised by a sign, never by a long path and a short afterthought. A
 * price series reflected around any pivot yields the mirrored geometry (see test-geometry.js).
 *
 * ATR is the shared `calculateATR` from `lib/advancedIndicators.js` - the one ATR on the
 * scalp path. Importing that one function does not pull the rest of that module onto it.
 *
 * Deliberately separate from `lib/structure.js findSwings` (symbol-level 1h swings that
 * feed `structure`) and `services/indicators.js detectSwingPoints` (feeds the strategy
 * engine). Both stay as they are; nothing here feeds `strategies.*`, `bestSignal`, or a guard.
 */

import { ENGINE_CONFIG } from '../config/engine.js';
import { calculateATR } from './advancedIndicators.js';

const STRUCTURE_LABELS = Object.freeze({ up: 'up', down: 'down', range: 'range' });

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

function candleTime(c) {
  if (isFiniteNumber(c.closeTime)) return c.closeTime;
  if (isFiniteNumber(c.timestamp)) return c.timestamp;
  return null;
}

/**
 * ATR from the shared calculateATR. `atr` is calculateATR's value unchanged; `atrPct` is
 * recomputed from it at 4 decimals because calculateATR's own 2-decimal percent reads 0
 * on quiet 1m candles.
 * @param {Array<Object>} candles - closed candles, oldest first
 * @param {number} [n=ENGINE_CONFIG.geometry.atrPeriod]
 * @returns {{atr:number, atrPct:number|null}|null}
 */
export function atr(candles, n = ENGINE_CONFIG.geometry.atrPeriod) {
  const r = calculateATR(candles, n);
  if (!r || !isFiniteNumber(r.atr)) return null;
  const lastClose = candles[candles.length - 1].close;
  return { atr: r.atr, atrPct: lastClose > 0 ? roundN((r.atr / lastClose) * 100, 4) : null };
}

/**
 * Indices where `values[i]` is a fractal extreme: strictly above every value `left`
 * candles before it and at least equal to every value `right` candles after it, so a
 * flat top of equal values yields one pivot. Callers pass highs for pivot highs and
 * negated lows for pivot lows - one rule for both sides.
 */
function fractalExtremes(values, left, right) {
  const out = [];
  for (let i = left; i < values.length - right; i++) {
    let ok = true;
    for (let j = i - left; j < i && ok; j++) if (!(values[i] > values[j])) ok = false;
    for (let j = i + 1; j <= i + right && ok; j++) if (!(values[i] >= values[j])) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Confirmed swing pivots on closed candles. A pivot needs `right` closed candles after
 * it, so the newest `right` candles can never be one.
 * @param {Array<Object>} candles
 * @param {number} [left=ENGINE_CONFIG.geometry.pivotLeft]
 * @param {number} [right=ENGINE_CONFIG.geometry.pivotRight]
 * @returns {{highs:Array<{index:number,price:number,time:number|null}>, lows:Array<{index:number,price:number,time:number|null}>}}
 */
export function swingPivots(candles, left = ENGINE_CONFIG.geometry.pivotLeft, right = ENGINE_CONFIG.geometry.pivotRight) {
  if (!Array.isArray(candles) || !candles.every(isValidCandle)) return { highs: [], lows: [] };
  const toPivot = (price) => (i) => ({ index: i, price: price(candles[i]), time: candleTime(candles[i]) });
  return {
    highs: fractalExtremes(candles.map((c) => c.high), left, right).map(toPivot((c) => c.high)),
    lows: fractalExtremes(candles.map((c) => -c.low), left, right).map(toPivot((c) => c.low))
  };
}

/** Consecutive strict rises at the tail of a series (sign -1 counts falls). */
function tailRun(prices, sign) {
  let count = 0;
  for (let i = prices.length - 1; i > 0; i--) {
    if (sign * prices[i] > sign * prices[i - 1]) count++;
    else break;
  }
  return count;
}

function runFlag(count) {
  return { active: count > 0, count };
}

/** Higher lows: consecutive rising pivot lows, newest first. */
export function higherLows(pivots) {
  return runFlag(tailRun(pivots.lows.map((p) => p.price), 1));
}

/** Lower highs: consecutive falling pivot highs, newest first. Mirror of higherLows. */
export function lowerHighs(pivots) {
  return runFlag(tailRun(pivots.highs.map((p) => p.price), -1));
}

/** Higher highs: consecutive rising pivot highs. */
export function higherHighs(pivots) {
  return runFlag(tailRun(pivots.highs.map((p) => p.price), 1));
}

/** Lower lows: consecutive falling pivot lows. Mirror of higherHighs. */
export function lowerLows(pivots) {
  return runFlag(tailRun(pivots.lows.map((p) => p.price), -1));
}

/**
 * Structure label from the latest pivots: `up` = higher high and higher low, `down` =
 * lower high and lower low, `range` otherwise, null with fewer than two pivots a side.
 * @returns {'up'|'down'|'range'|null}
 */
export function swingStructure(pivots) {
  if (pivots.highs.length < 2 || pivots.lows.length < 2) return null;
  if (higherHighs(pivots).active && higherLows(pivots).active) return STRUCTURE_LABELS.up;
  if (lowerHighs(pivots).active && lowerLows(pivots).active) return STRUCTURE_LABELS.down;
  return STRUCTURE_LABELS.range;
}

/**
 * Cluster pivot prices into horizontal zones. Densest-first so the result does not
 * depend on scanning bottom-up or top-down (a mirrored series gives mirrored zones):
 * repeatedly take the unassigned pivot with the most unassigned neighbours within
 * `atrTolerance` (ties: most recent, then highest index), and make a zone of it and those
 * neighbours. Every zone is therefore at most 2 x atrTolerance wide.
 *
 * `side` records which pivots formed the zone - `support` (swing lows), `resistance`
 * (swing highs), or `both` (a flipped level). Where the zone sits relative to price now
 * is roomTo's job, not this field's.
 *
 * @param {{highs:Array, lows:Array}} pivots - swingPivots(...) output
 * @param {number} atrTolerance - absolute price distance (ATR x zoneToleranceAtr)
 * @param {number} [minTouches=ENGINE_CONFIG.geometry.minTouches]
 * @returns {Array<{low:number,high:number,touches:number,lastTouchAt:number|null,side:string}>} low-to-high
 */
export function horizontalZones(pivots, atrTolerance, minTouches = ENGINE_CONFIG.geometry.minTouches) {
  if (!isFiniteNumber(atrTolerance) || atrTolerance <= 0) return [];
  const points = [
    ...pivots.highs.map((p) => ({ ...p, kind: 'resistance' })),
    ...pivots.lows.map((p) => ({ ...p, kind: 'support' }))
  ];
  const unassigned = new Set(points.map((_, i) => i));
  const neighbours = (i) => [...unassigned].filter((j) => Math.abs(points[j].price - points[i].price) <= atrTolerance);
  const zones = [];

  while (unassigned.size > 0) {
    let best = null;
    let bestMembers = null;
    for (const i of unassigned) {
      const members = neighbours(i);
      const p = points[i];
      const b = best === null ? null : points[best];
      const better = best === null
        || members.length > bestMembers.length
        || (members.length === bestMembers.length && (p.time ?? -Infinity) > (b.time ?? -Infinity))
        || (members.length === bestMembers.length && (p.time ?? -Infinity) === (b.time ?? -Infinity) && p.index > b.index);
      if (better) { best = i; bestMembers = members; }
    }
    for (const j of bestMembers) unassigned.delete(j);
    if (bestMembers.length < minTouches) continue;

    const members = bestMembers.map((j) => points[j]);
    const kinds = new Set(members.map((m) => m.kind));
    const times = members.map((m) => m.time).filter(isFiniteNumber);
    zones.push({
      low: Math.min(...members.map((m) => m.price)),
      high: Math.max(...members.map((m) => m.price)),
      touches: members.length,
      lastTouchAt: times.length > 0 ? Math.max(...times) : null,
      side: kinds.size > 1 ? 'both' : [...kinds][0]
    });
  }
  return zones.sort((a, b) => a.low - b.low);
}

/**
 * Zones beyond `price` in one direction (sign 1 = above, -1 = below), nearest first, with
 * the distance from price to the zone's near edge in percent (0 when price is inside it).
 * A zone belongs to the side its midpoint is on.
 */
function zonesBeyond(price, zones, sign) {
  return zones
    .filter((z) => sign * ((z.low + z.high) / 2) > sign * price)
    .map((z) => ({ zone: z, distance: Math.max(0, Math.min(sign * z.low, sign * z.high) - sign * price) }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Room from price to the nearest zone on each side.
 * @param {number} price
 * @param {Array<Object>} zones - horizontalZones(...) output
 * @returns {{nextSupport:Object|null, nextResistance:Object|null, roomUpPct:number|null, roomDownPct:number|null}}
 */
export function roomTo(price, zones) {
  if (!isFiniteNumber(price) || price <= 0 || !Array.isArray(zones)) {
    return { nextSupport: null, nextResistance: null, roomUpPct: null, roomDownPct: null };
  }
  const up = zonesBeyond(price, zones, 1)[0] || null;
  const down = zonesBeyond(price, zones, -1)[0] || null;
  return {
    nextSupport: down ? down.zone : null,
    nextResistance: up ? up.zone : null,
    roomUpPct: up ? roundN((up.distance / price) * 100, 3) : null,
    roomDownPct: down ? roundN((down.distance / price) * 100, 3) : null
  };
}

/**
 * How stretched price is from EMA21, in ATRs. Signed (+ above, - below); the level
 * reads the magnitude only, so a long and a short stretched by the same amount match.
 * @returns {{atrFromEma21:number, level:'low'|'elevated'|'high'}|null}
 */
export function extensionRisk(price, ema21, atrValue, cfg = ENGINE_CONFIG.geometry.extensionAtr) {
  if (!isFiniteNumber(price) || !isFiniteNumber(ema21) || !isFiniteNumber(atrValue) || atrValue <= 0) return null;
  const units = (price - ema21) / atrValue;
  const mag = Math.abs(units);
  const level = mag >= cfg.high ? 'high' : (mag >= cfg.elevated ? 'elevated' : 'low');
  return { atrFromEma21: roundN(units, 2), level };
}

/**
 * EMA slope over the last `n` values, in percent per candle.
 * @param {Array<number>} history - EMA series, oldest first
 * @param {number} [n=ENGINE_CONFIG.geometry.slopeCandles]
 * @returns {number|null}
 */
export function emaSlope(history, n = ENGINE_CONFIG.geometry.slopeCandles) {
  if (!Array.isArray(history) || history.length <= n || n <= 0) return null;
  const last = history[history.length - 1];
  const past = history[history.length - 1 - n];
  if (!isFiniteNumber(last) || !isFiniteNumber(past) || past === 0) return null;
  return roundN((((last - past) / past) * 100) / n, 4);
}

/**
 * Stoch RSI %K acceleration: the change in slopeK between the last two closes
 * ((k0 - k1) - (k1 - k2)). Positive = K turning up or rising faster ("reset then
 * reaccelerate" for a long); negative is the short mirror.
 * @param {Array<{k:number}>} history - Stoch RSI history, oldest first
 * @returns {number|null}
 */
export function stochAcceleration(history) {
  if (!Array.isArray(history) || history.length < 3) return null;
  const k = history.slice(-3).map((h) => (h && isFiniteNumber(h.k) ? Math.min(100, Math.max(0, h.k)) : null));
  if (k.some((v) => v === null)) return null;
  return roundN((k[2] - k[1]) - (k[1] - k[0]), 2);
}

function zoneOut(z) {
  return {
    low: z.low,
    high: z.high,
    touches: z.touches,
    lastTouchAt: isFiniteNumber(z.lastTouchAt) ? new Date(z.lastTouchAt).toISOString() : null,
    side: z.side
  };
}

/**
 * Assemble one timeframe's geometryContext from closed candles and the indicator
 * histories the scalp path already computes.
 *
 * `confidence` is evidence completeness, 0-100 in steps of 20: ATR, a pivot structure
 * (two pivots a side), a support zone, a resistance zone, both EMA slopes. It says how
 * much geometry could be measured, not whether a trade is good.
 *
 * @param {Object} input
 * @param {string} input.timeframe
 * @param {Array<Object>} input.candles - closed candles, oldest first
 * @param {Array<number>} [input.ema21History]
 * @param {Array<number>} [input.ema200History]
 * @param {Array<{k:number,d:number}>} [input.stochHistory]
 * @param {Object} [cfg=ENGINE_CONFIG.geometry]
 * @returns {Object|null} null when there are too few candles for ATR
 */
export function buildGeometryContext({ timeframe, candles, ema21History, ema200History, stochHistory }, cfg = ENGINE_CONFIG.geometry) {
  if (!Array.isArray(candles) || candles.length <= cfg.atrPeriod || !candles.every(isValidCandle)) return null;
  const a = atr(candles, cfg.atrPeriod);
  if (!a) return null;

  const price = candles[candles.length - 1].close;
  const pivots = swingPivots(candles, cfg.pivotLeft, cfg.pivotRight);
  const zones = horizontalZones(pivots, a.atr * cfg.zoneToleranceAtr, cfg.minTouches);
  const room = roomTo(price, zones);
  const ema21 = Array.isArray(ema21History) && ema21History.length > 0 ? ema21History[ema21History.length - 1] : null;
  const structure = swingStructure(pivots);
  const ema21Slope = emaSlope(ema21History, cfg.slopeCandles);
  const ema200Slope = emaSlope(ema200History, cfg.slopeCandles);

  const supports = zonesBeyond(price, zones, -1).slice(0, cfg.maxZonesPerSide).map((x) => zoneOut(x.zone));
  const resistances = zonesBeyond(price, zones, 1).slice(0, cfg.maxZonesPerSide).map((x) => zoneOut(x.zone));

  const evidence = [
    true,
    structure !== null,
    supports.length > 0,
    resistances.length > 0,
    ema21Slope !== null && ema200Slope !== null
  ];

  return {
    timeframe,
    atr: a.atr,
    atrPct: a.atrPct,
    structure,
    higherLows: higherLows(pivots),
    lowerHighs: lowerHighs(pivots),
    horizontalSupportZones: supports,
    horizontalResistanceZones: resistances,
    roomToNextSupport: room.roomDownPct,
    roomToNextResistance: room.roomUpPct,
    extensionRisk: extensionRisk(price, ema21, a.atr, cfg.extensionAtr),
    ema21Slope,
    ema200Slope,
    stochAccelK: stochAcceleration(stochHistory),
    confidence: 20 * evidence.filter(Boolean).length
  };
}

/**
 * Compact per-symbol geometry summary for decisionTrace: one
 * "timeframe:structure:roomUpPct:roomDownPct:extension" string per timeframe
 * (e.g. "1h:up:0.42:0.18:low", "na" where a value is missing). Full geometry lives on
 * symbols.<SYM>.geometryContext; this stays well under 300 bytes per symbol.
 * @param {Object} geometryByTf - { [tf]: buildGeometryContext(...) | null }
 * @returns {Array<string>}
 */
export function geometryTraceSummary(geometryByTf) {
  const na = (v) => (v === null || v === undefined ? 'na' : v);
  return Object.entries(geometryByTf || {}).map(([tf, g]) => (g
    ? `${tf}:${na(g.structure)}:${na(g.roomToNextResistance)}:${na(g.roomToNextSupport)}:${na(g.extensionRisk && g.extensionRisk.level)}`
    : `${tf}:na:na:na:na`));
}

// ---------------------------------------------------------------------------
// Geometry B (phase 8): diagonals, channel, confluence
// ---------------------------------------------------------------------------

const NOT_DETECTED = Object.freeze({ detected: false });

/** Price-scale rounding for computed levels: 7 significant digits (65432.12, 150.1234). */
function roundPrice(value) {
  return isFiniteNumber(value) ? Number(value.toPrecision(7)) : null;
}

function isoOrNull(ms) {
  return isFiniteNumber(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Best support-side line in "value space", where support means price should stay at or
 * above the line. Resistance runs through the same code on negated prices (see
 * fitDiagonal), so there is one fitting rule for both sides.
 *
 * Candidates are lines through every pair of the newest `maxDiagonalCandidates` pivots.
 * A candidate survives only if, from its first touch to the newest candle:
 *   - no close sits more than `tol` beyond the line, and no pivot either (a broken line
 *     is not a line), and
 *   - it has at least `diagonalMinTouches` pivots within `tol`, spanning at least
 *     `diagonalMinSpanCandles` candles, and
 *   - price closed at least `minBounce` away from the line between every two touches.
 * Survivors rank by touches, then fit residual, then most recent last touch.
 */
function bestLine(points, closes, tol, minBounce, cfg) {
  const last = closes.length - 1;
  const cands = points.slice(-cfg.maxDiagonalCandidates);
  let best = null;
  for (let a = 0; a < cands.length; a++) {
    for (let b = a + 1; b < cands.length; b++) {
      const p = cands[a];
      const q = cands[b];
      const slope = (q.value - p.value) / (q.index - p.index);
      const at = (i) => p.value + slope * (i - p.index);

      const touching = cands.filter((k) => Math.abs(k.value - at(k.index)) <= tol);
      if (touching.length < cfg.diagonalMinTouches) continue;
      const first = touching[0].index;
      const lastTouch = touching[touching.length - 1];
      if (lastTouch.index - first < cfg.diagonalMinSpanCandles) continue;

      let broken = cands.some((k) => k.index >= first && k.value < at(k.index) - tol);
      for (let i = first; i <= last && !broken; i++) if (closes[i] < at(i) - tol) broken = true;
      if (broken) continue;

      // Each touch must be a real test of the line: between consecutive touches price
      // closed at least diagonalMinBounceAtr ATRs away from it. Noise that merely hugs a
      // line within tolerance never qualifies.
      let weak = false;
      for (let t = 1; t < touching.length && !weak; t++) {
        let away = 0;
        for (let i = touching[t - 1].index; i <= touching[t].index; i++) away = Math.max(away, closes[i] - at(i));
        if (away < minBounce) weak = true;
      }
      if (weak) continue;

      const residual = Math.sqrt(touching.reduce((s, k) => s + (k.value - at(k.index)) ** 2, 0) / touching.length);
      const better = best === null
        || touching.length > best.touches.length
        || (touching.length === best.touches.length && residual < best.residual - 1e-12)
        || (touching.length === best.touches.length && Math.abs(residual - best.residual) <= 1e-12 && lastTouch.index > best.lastTouch.index);
      if (better) best = { slope, level: at(last), touches: touching, lastTouch, residual };
    }
  }
  return best;
}

/**
 * Diagonal support or resistance through swing pivots. Precision over recall: a line
 * with fewer than `diagonalMinTouches` touches, a short span, a weak bounce between
 * touches, or a close beyond it is never exposed - `{ detected: false }` instead.
 *
 * @param {{highs:Array, lows:Array}} pivots - swingPivots(...) output
 * @param {'support'|'resistance'} side - support fits pivot lows, resistance pivot highs
 * @param {Object} [cfg=ENGINE_CONFIG.geometry]
 * @param {{candles:Array<Object>, atr:number}} ctx - the candles the pivots came from, and their ATR
 * @returns {{detected:true, slope:number, touches:number, currentLevel:number,
 *   currentDistancePct:number, lastTouchAt:string|null, fitError:number, confidence:number}|{detected:false}}
 *   slope: percent of the current level per candle (+ rising). currentDistancePct: percent
 *   of price from price to the line, positive while price is on the line's side.
 *   fitError: RMS distance of the touches from the line, in ATRs.
 */
export function fitDiagonal(pivots, side, cfg = ENGINE_CONFIG.geometry, ctx = {}) {
  const { candles, atr: atrValue } = ctx;
  if (!pivots || !Array.isArray(candles) || candles.length === 0 || !candles.every(isValidCandle)) return NOT_DETECTED;
  if (!isFiniteNumber(atrValue) || atrValue <= 0) return NOT_DETECTED;
  const sign = side === 'support' ? 1 : (side === 'resistance' ? -1 : 0);
  if (sign === 0) return NOT_DETECTED;

  const source = sign === 1 ? pivots.lows : pivots.highs;
  const points = (source || []).map((pt) => ({ index: pt.index, value: sign * pt.price, time: pt.time }));
  const closes = candles.map((c) => sign * c.close);
  const tol = atrValue * cfg.zoneToleranceAtr;
  const line = bestLine(points, closes, tol, atrValue * cfg.diagonalMinBounceAtr, cfg);
  if (!line) return NOT_DETECTED;

  const level = sign * line.level;
  const price = candles[candles.length - 1].close;
  if (!(level > 0) || !(price > 0)) return NOT_DETECTED;
  const fitErrorAtr = line.residual / atrValue;
  const touchScore = Math.min(1, line.touches.length / cfg.diagonalFullTouches);
  // A fit at the tolerance edge halves confidence; a perfect fit keeps the touch score.
  const fitScore = 1 - fitErrorAtr / (2 * cfg.zoneToleranceAtr);
  return {
    detected: true,
    slope: roundN(((sign * line.slope) / level) * 100, 4),
    touches: line.touches.length,
    currentLevel: roundPrice(level),
    currentDistancePct: roundN((sign * (price - level) / price) * 100, 3),
    lastTouchAt: isoOrNull(line.lastTouch.time),
    fitError: roundN(fitErrorAtr, 3),
    confidence: Math.round(100 * touchScore * fitScore)
  };
}

/**
 * Channel from a detected diagonal support and resistance with compatible slopes.
 * Scale-free: slopes are compared as a fraction of the channel's own width, so the
 * same config reads the same on 15m and 4h.
 *   - compatible: |slopeResistance - slopeSupport| <= maxSlopeDivergence x widthPct
 *     (the lines converge or diverge by at most that fraction of the width per candle;
 *     a triangle or wedge fails this and is not a channel)
 *   - slope: flat when the mean slope moves less than channelFlatSlope x widthPct per candle
 * @param {Object} diagonalSupport - fitDiagonal(..., 'support', ...)
 * @param {Object} diagonalResistance - fitDiagonal(..., 'resistance', ...)
 * @param {number} price
 * @param {Object} [cfg=ENGINE_CONFIG.geometry]
 * @returns {{detected:true, upper:number, lower:number, widthPct:number, positionPct:number,
 *   slope:'rising'|'falling'|'flat'}|{detected:false}} positionPct: 0 = at lower, 100 = at upper
 */
export function channel(diagonalSupport, diagonalResistance, price, cfg = ENGINE_CONFIG.geometry) {
  if (!diagonalSupport || !diagonalSupport.detected || !diagonalResistance || !diagonalResistance.detected) return NOT_DETECTED;
  if (!isFiniteNumber(price) || price <= 0) return NOT_DETECTED;
  const lower = diagonalSupport.currentLevel;
  const upper = diagonalResistance.currentLevel;
  if (!(upper > lower)) return NOT_DETECTED;

  const widthPct = ((upper - lower) / price) * 100;
  const sS = (diagonalSupport.slope * lower) / price;
  const sR = (diagonalResistance.slope * upper) / price;
  if (Math.abs(sR - sS) > cfg.maxSlopeDivergence * widthPct) return NOT_DETECTED;

  const mean = (sS + sR) / 2;
  const flatBand = cfg.channelFlatSlope * widthPct;
  return {
    detected: true,
    upper,
    lower,
    widthPct: roundN(widthPct, 3),
    positionPct: roundN(((price - lower) / (upper - lower)) * 100, 1),
    slope: mean > flatBand ? 'rising' : (mean < -flatBand ? 'falling' : 'flat')
  };
}

// Fixed order for a zone's components[], so the list is stable and comparable.
const CONFLUENCE_KINDS = ['diagonalSupport', 'diagonalResistance', 'horizontalZone', 'ema21', 'ema200',
  'sessionHigh', 'sessionLow', 'prevDayHigh', 'prevDayLow'];

/**
 * Confluence: where independent levels overlap. Each input level is an interval (a
 * point level is [p, p]); two intervals overlap when they are within
 * `confluenceTolAtr` ATRs. Clustered densest-first like horizontalZones, so the result
 * does not depend on scanning order and a mirrored input gives mirrored zones. A zone
 * needs two or more distinct component kinds - one level alone is not confluence.
 *
 * `score` is the number of distinct components (more agreeing levels = higher).
 * Zones sort by score, then nearest to price; at most `maxConfluenceZones`.
 *
 * @param {Object} input
 * @param {number} input.price
 * @param {number} input.atr
 * @param {Object} [input.diagonalSupport] - fitDiagonal output
 * @param {Object} [input.diagonalResistance] - fitDiagonal output
 * @param {Array<{low:number,high:number}>} [input.horizontalZones]
 * @param {number|null} [input.ema21]
 * @param {number|null} [input.ema200]
 * @param {Object} [input.levels] - { sessionHigh, sessionLow, prevDayHigh, prevDayLow }
 * @param {Object} [cfg=ENGINE_CONFIG.geometry]
 * @returns {Array<{low:number, high:number, components:Array<string>, score:number, distancePct:number}>}
 *   distancePct: percent from price to the zone's near edge, 0 when price is inside it.
 */
export function confluenceZones({ price, atr: atrValue, diagonalSupport, diagonalResistance, horizontalZones: hz = [], ema21, ema200, levels = {} } = {}, cfg = ENGINE_CONFIG.geometry) {
  if (!isFiniteNumber(price) || price <= 0 || !isFiniteNumber(atrValue) || atrValue <= 0) return [];
  const items = [];
  const add = (kind, low, high) => {
    if (isFiniteNumber(low) && isFiniteNumber(high)) items.push({ kind, low: Math.min(low, high), high: Math.max(low, high) });
  };
  if (diagonalSupport && diagonalSupport.detected) add('diagonalSupport', diagonalSupport.currentLevel, diagonalSupport.currentLevel);
  if (diagonalResistance && diagonalResistance.detected) add('diagonalResistance', diagonalResistance.currentLevel, diagonalResistance.currentLevel);
  for (const z of Array.isArray(hz) ? hz : []) if (z) add('horizontalZone', z.low, z.high);
  add('ema21', ema21, ema21);
  add('ema200', ema200, ema200);
  for (const k of ['sessionHigh', 'sessionLow', 'prevDayHigh', 'prevDayLow']) add(k, levels[k], levels[k]);

  const tol = atrValue * cfg.confluenceTolAtr;
  const gap = (x, y) => Math.max(0, Math.max(x.low, y.low) - Math.min(x.high, y.high));
  const mid = (x) => (x.low + x.high) / 2;
  const unassigned = new Set(items.map((_, i) => i));
  const zones = [];

  while (unassigned.size > 0) {
    let best = null;
    let bestMembers = null;
    for (const i of unassigned) {
      const members = [...unassigned].filter((j) => gap(items[i], items[j]) <= tol);
      const kinds = new Set(members.map((j) => items[j].kind)).size;
      const bestKinds = best === null ? -1 : new Set(bestMembers.map((j) => items[j].kind)).size;
      const better = kinds > bestKinds
        || (kinds === bestKinds && Math.abs(mid(items[i]) - price) < Math.abs(mid(items[best]) - price));
      if (better) { best = i; bestMembers = members; }
    }
    for (const j of bestMembers) unassigned.delete(j);
    const members = bestMembers.map((j) => items[j]);
    const kinds = new Set(members.map((m) => m.kind));
    if (kinds.size < 2) continue;

    const low = Math.min(...members.map((m) => m.low));
    const high = Math.max(...members.map((m) => m.high));
    const distance = price < low ? low - price : (price > high ? price - high : 0);
    zones.push({
      low: roundPrice(low),
      high: roundPrice(high),
      components: CONFLUENCE_KINDS.filter((k) => kinds.has(k)),
      score: kinds.size,
      distancePct: roundN((distance / price) * 100, 3)
    });
  }
  return zones
    .sort((a, b) => b.score - a.score || a.distancePct - b.distancePct)
    .slice(0, cfg.maxConfluenceZones);
}

/**
 * Geometry B fields for one timeframe, merged onto a buildGeometryContext result by the
 * caller. Recomputes pivots and ATR from the same candles rather than changing
 * buildGeometryContext, so phase 7 output stays byte-identical.
 * @param {Object} input
 * @param {Array<Object>} input.candles - closed candles, oldest first
 * @param {Object} input.geometry - buildGeometryContext(...) for the same candles
 * @param {number|null} [input.ema21]
 * @param {number|null} [input.ema200]
 * @param {Object} [input.levels] - { sessionHigh, sessionLow, prevDayHigh, prevDayLow }
 * @param {Object} [cfg=ENGINE_CONFIG.geometry]
 * @returns {{diagonalSupport:Object, diagonalResistance:Object, channel:Object, confluenceZones:Array}|null}
 */
export function buildGeometryB({ candles, geometry, ema21 = null, ema200 = null, levels = {} }, cfg = ENGINE_CONFIG.geometry) {
  if (!geometry || !Array.isArray(candles) || candles.length === 0 || !candles.every(isValidCandle)) return null;
  const pivots = swingPivots(candles, cfg.pivotLeft, cfg.pivotRight);
  const ctx = { candles, atr: geometry.atr };
  const diagonalSupport = fitDiagonal(pivots, 'support', cfg, ctx);
  const diagonalResistance = fitDiagonal(pivots, 'resistance', cfg, ctx);
  const price = candles[candles.length - 1].close;
  return {
    diagonalSupport,
    diagonalResistance,
    channel: channel(diagonalSupport, diagonalResistance, price, cfg),
    confluenceZones: confluenceZones({
      price,
      atr: geometry.atr,
      diagonalSupport,
      diagonalResistance,
      horizontalZones: [...geometry.horizontalSupportZones, ...geometry.horizontalResistanceZones],
      ema21,
      ema200,
      levels
    }, cfg)
  };
}

export default {
  atr,
  swingPivots,
  higherLows,
  lowerHighs,
  higherHighs,
  lowerLows,
  swingStructure,
  horizontalZones,
  roomTo,
  extensionRisk,
  emaSlope,
  stochAcceleration,
  buildGeometryContext,
  geometryTraceSummary,
  fitDiagonal,
  channel,
  confluenceZones,
  buildGeometryB
};
