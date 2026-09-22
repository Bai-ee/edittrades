/**
 * Direction and multi-timeframe bias matrix (engine refinement plan, phase 9b).
 *
 * A layer above the strategies and candidates: it never changes a strategy decision or
 * a candidate. It reads each timeframe's published fields plus its geometry and says
 * which way that timeframe leans, then classifies every live candidate and valid
 * strategy as with or against the higher-timeframe lean, and how much room it has to
 * the nearest higher-timeframe zone in its own direction.
 *
 * One code path for both directions: every signal is scored as +1 (long) / -1 (short) /
 * 0, and labels come from a table indexed by that sign. A mirrored market yields the
 * mirrored matrix with identical strengths.
 *
 * Pure functions, no I/O. Constants come from `ENGINE_CONFIG.bias`.
 */

import { ENGINE_CONFIG } from '../config/engine.js';

export const BIAS_TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
const LABEL = { 1: 'long', '-1': 'short', 0: 'neutral' };
const LETTER = { long: 'L', short: 'S', neutral: 'N' };

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sign(v) {
  return v > 0 ? 1 : (v < 0 ? -1 : 0);
}

function round(v, n = 2) {
  return isFiniteNumber(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

/** Basis token per signal, indexed by the signal's sign. */
const TOKENS = {
  trend: { 1: 'trend:up', '-1': 'trend:down' },
  emaStack: { 1: 'ema21>ema200', '-1': 'ema21<ema200' },
  price21: { 1: 'price>ema21', '-1': 'price<ema21' },
  emaSlope: { 1: 'ema:rising', '-1': 'ema:falling' },
  structure: { 1: 'higherLows', '-1': 'lowerHighs' },
  channel: { 1: 'channel:bottom', '-1': 'channel:top' },
  stoch: { 1: 'stoch:bullish', '-1': 'stoch:bearish' }
};

/**
 * Signed signals for one timeframe. A signal is present (counts in the denominator)
 * only when its input was measurable; present-but-zero means "measured, no lean".
 * @returns {Array<{name:string, s:number}>}
 */
function signals(tf, geometry, cfg) {
  const out = [];
  const g = geometry || {};
  if (tf.trend) out.push({ name: 'trend', s: tf.trend === 'UPTREND' ? 1 : (tf.trend === 'DOWNTREND' ? -1 : 0) });
  if (isFiniteNumber(tf.ema21) && isFiniteNumber(tf.ema200)) out.push({ name: 'emaStack', s: sign(tf.ema21 - tf.ema200) });
  if (isFiniteNumber(tf.priceVs21Pct)) out.push({ name: 'price21', s: sign(tf.priceVs21Pct) });
  if (isFiniteNumber(g.ema21Slope) || isFiniteNumber(g.ema200Slope)) {
    // Both slopes agreeing is a lean; disagreeing (or flat) is measured, no lean.
    const s21 = sign(g.ema21Slope || 0);
    const s200 = sign(g.ema200Slope || 0);
    out.push({ name: 'emaSlope', s: isFiniteNumber(g.ema200Slope) ? (s21 === s200 ? s21 : 0) : s21 });
  }
  if (g.higherLows || g.lowerHighs) {
    out.push({ name: 'structure', s: (g.higherLows && g.higherLows.active ? 1 : 0) - (g.lowerHighs && g.lowerHighs.active ? 1 : 0) });
  }
  if (g.channel && g.channel.detected && isFiniteNumber(g.channel.positionPct)) {
    const p = g.channel.positionPct;
    out.push({ name: 'channel', s: p <= cfg.channelEdgePct ? 1 : (p >= 100 - cfg.channelEdgePct ? -1 : 0) });
  }
  if (tf.stochRsi && tf.stochRsi.state) {
    out.push({ name: 'stoch', s: tf.stochRsi.state === 'BULLISH' ? 1 : (tf.stochRsi.state === 'BEARISH' ? -1 : 0) });
  }
  return out;
}

/**
 * Bias for one timeframe.
 * @param {Object} tfData - symbols.<SYM>.timeframes[tf] (trend, ema21, ema200, priceVs21Pct, stochRsi)
 * @param {Object|null} geometry - geometry for the same timeframe (ema21Slope, ema200Slope,
 *   higherLows, lowerHighs, channel); null when unavailable
 * @param {Object} [cfg=ENGINE_CONFIG.bias]
 * @returns {{bias:'long'|'short'|'neutral', strength:number, basis:Array<string>}|null} null
 *   when the timeframe has no usable data
 */
export function timeframeBias(tfData, geometry, cfg = ENGINE_CONFIG.bias) {
  if (!tfData || typeof tfData !== 'object') return null;
  const list = signals(tfData, geometry, cfg);
  const weightSum = list.reduce((a, x) => a + cfg.basisWeights[x.name], 0);
  if (weightSum === 0) return null;
  const score = list.reduce((a, x) => a + cfg.basisWeights[x.name] * x.s, 0) / weightSum;
  const strength = Math.round(Math.abs(score) * 100);
  const dir = strength >= cfg.neutralBelow ? sign(score) : 0;
  return {
    bias: LABEL[dir],
    strength,
    basis: list.filter((x) => x.s !== 0).map((x) => TOKENS[x.name][x.s])
  };
}

/**
 * @param {Object} timeframes - symbols.<SYM>.timeframes
 * @param {Object} geometryByTf - per-timeframe geometry (published or bias-only)
 * @returns {Object} tf -> timeframeBias(...) | null, over BIAS_TIMEFRAMES
 */
export function buildBiasMatrix(timeframes, geometryByTf = {}, cfg = ENGINE_CONFIG.bias) {
  const out = {};
  for (const tf of BIAS_TIMEFRAMES) {
    const entry = timeframes && timeframes[tf];
    // A timeframe with no computed indicators (fetch failed) carries no lean.
    out[tf] = entry && (entry.trend || isFiniteNumber(entry.ema21)) ? timeframeBias(entry, geometryByTf[tf] || null, cfg) : null;
  }
  return out;
}

/** Signed, weighted lean over `tfs`: { dir, strength } with strength 0–100. */
function combinedBias(matrix, tfs, weights) {
  let num = 0;
  let den = 0;
  for (const tf of tfs) {
    const e = matrix[tf];
    const w = weights[tf] || 0;
    if (!e || w === 0) continue;
    const s = e.bias === 'long' ? 1 : (e.bias === 'short' ? -1 : 0);
    num += w * s * e.strength;
    den += w;
  }
  if (den === 0) return { dir: 0, strength: 0 };
  const v = num / den;
  return { dir: sign(v), strength: Math.round(Math.abs(v)) };
}

/**
 * Nearest context-timeframe zone in the trade's direction (the obstacle): resistance for
 * a long, support for a short; a confluence zone counts when its midpoint is ahead. A
 * zone containing price is at distance 0.
 * @returns {{distancePct:number, room:number|null, tf:string}|null}
 */
function nearestZone(price, s, tfs, zonesByTf) {
  const ahead = s === 1 ? 'resistance' : 'support';
  let best = null;
  for (const tf of tfs) {
    const z = zonesByTf[tf];
    if (!z) continue;
    for (const zone of z.zones) {
      // Oriented: for a short, flip so "ahead" is always "above".
      const lo = s === 1 ? zone.low : -zone.high;
      const hi = s === 1 ? zone.high : -zone.low;
      const p = s * price;
      if (zone.side === 'either' ? (lo + hi) / 2 < p : zone.side !== ahead) continue; // behind the trade
      const dist = Math.max(0, lo - p);
      if (best === null || dist < best.dist) best = { dist, tf, atr: z.atr };
    }
  }
  if (!best) return null;
  return {
    distancePct: round((best.dist / price) * 100, 3),
    room: isFiniteNumber(best.atr) && best.atr > 0 ? round(best.dist / best.atr, 2) : null,
    tf: best.tf
  };
}

/**
 * Zones per timeframe for the room read: horizontal support and resistance zones (side
 * as geometry published it) plus confluence zones (side "either", decided by midpoint
 * against price), with the timeframe's ATR.
 * @param {Object} geometryByTf
 * @returns {Object} tf -> { atr, zones:[{low, high, side}] }
 */
export function zonesFromGeometry(geometryByTf) {
  const out = {};
  const valid = (z) => z && isFiniteNumber(z.low) && isFiniteNumber(z.high);
  for (const [tf, g] of Object.entries(geometryByTf || {})) {
    if (!g) continue;
    const tag = (list, side) => (list || []).filter(valid).map((z) => ({ low: z.low, high: z.high, side }));
    out[tf] = {
      atr: g.atr,
      zones: [...tag(g.horizontalSupportZones, 'support'), ...tag(g.horizontalResistanceZones, 'resistance'), ...tag(g.confluenceZones, 'either')]
    };
  }
  return out;
}

/**
 * Alignment entry for one directional idea (a candidate or a valid strategy).
 * @param {Object} p
 * @param {'candidate'|'strategy'} p.source
 * @param {string} p.ref - trace ref ("1m:short:forming") or strategy name
 * @param {'long'|'short'|'neutral'} p.direction
 * @param {string} p.executionTf
 */
export function alignmentEntry({ source, ref, direction, executionTf, price, matrix, zonesByTf }, cfg = ENGINE_CONFIG.bias) {
  const contextTfs = cfg.contextTimeframes[executionTf] || [];
  const htf = combinedBias(matrix, contextTfs, cfg.contextWeights);
  const s = direction === 'long' ? 1 : (direction === 'short' ? -1 : 0);
  const zone = s !== 0 && isFiniteNumber(price) && price > 0 ? nearestZone(price, s, contextTfs, zonesByTf) : null;
  const room = zone ? zone.room : null;
  return {
    source,
    ref,
    direction,
    executionTf,
    contextTfs,
    withTrend: s !== 0 && htf.dir === s,
    counterTrend: s !== 0 && htf.dir === -s,
    htfBias: LABEL[htf.dir],
    htfBiasStrength: htf.strength,
    nearestHtfZoneDistancePct: zone ? zone.distancePct : null,
    room,
    roomTooSmall: room !== null && room < cfg.minRoomAtr
  };
}

/**
 * alignment[] for a symbol: every non-failed candidate, then every valid strategy.
 * @param {Object} p
 * @param {number} p.price
 * @param {Array<Object>} p.candidates - resolved candidateSetups (failed ones are skipped)
 * @param {Object} p.strategies - trimmed strategies (valid ones are used)
 * @param {Object} p.matrix - buildBiasMatrix(...)
 * @param {Object} p.zonesByTf - zonesFromGeometry(...)
 */
export function buildAlignment({ price, candidates = [], strategies = {}, matrix, zonesByTf }, cfg = ENGINE_CONFIG.bias) {
  const out = [];
  for (const c of candidates) {
    if (!c || c.state === 'failed') continue;
    out.push(alignmentEntry({
      source: 'candidate', ref: `${c.timeframe}:${c.direction}:${c.state}`, direction: c.direction, executionTf: c.timeframe, price, matrix, zonesByTf
    }, cfg));
  }
  for (const [name, st] of Object.entries(strategies || {})) {
    if (!st || !st.valid || !cfg.strategyTimeframes[name]) continue;
    const direction = st.direction === 'LONG' ? 'long' : (st.direction === 'SHORT' ? 'short' : null);
    if (!direction) continue;
    out.push(alignmentEntry({ source: 'strategy', ref: name, direction, executionTf: cfg.strategyTimeframes[name], price, matrix, zonesByTf }, cfg));
  }
  return out;
}

/**
 * Integer percentages summing to exactly 100 (largest remainder). Shares are rounded to
 * 1e-6 first so float noise cannot split a tie. Ties go to the larger share, then to
 * neutral; a rounding point that would go to long or short while the other side holds
 * the identical share goes to neutral instead. So long and short never gain a point by
 * key order, and a mirrored market rounds to mirrored numbers.
 */
function toPercent(masses) {
  const keys = Object.keys(masses);
  const total = keys.reduce((a, k) => a + masses[k], 0);
  if (total <= 0) return { long: 0, short: 0, neutral: 100 };
  const v = Object.fromEntries(keys.map((k) => [k, round((masses[k] / total) * 100, 6)]));
  const out = Object.fromEntries(keys.map((k) => [k, Math.floor(v[k])]));
  let left = 100 - keys.reduce((a, k) => a + out[k], 0);
  const rem = (k) => v[k] - Math.floor(v[k]);
  const order = [...keys].sort((a, b) => rem(b) - rem(a) || v[b] - v[a] || (b === 'neutral') - (a === 'neutral'));
  const opposite = { long: 'short', short: 'long' };
  for (const k of order) {
    if (left <= 0) break;
    out[k !== 'neutral' && v[opposite[k]] === v[k] ? 'neutral' : k]++;
    left--;
  }
  return out;
}

/**
 * Directional bias per horizon, { long, short, neutral } summing to 100. Each weighted
 * timeframe contributes its strength to its side and the rest to neutral. On the scalp
 * horizon, a timeframe leaning against the swing horizon keeps only
 * (1 - counterTrendPenalty) of its strength; the removed part goes to neutral.
 * The API does not turn these into GO IN / HOLD / DON'T; that allocation is GPT-owned.
 * @param {Object} matrix - buildBiasMatrix(...)
 * @returns {{directionalBias:{scalp:Object, swing:Object}}}
 */
export function buildDecisionInputs(matrix, cfg = ENGINE_CONFIG.bias) {
  const swingDir = combinedBias(matrix, Object.keys(cfg.horizons.swing), cfg.horizons.swing).dir;
  const horizon = (weights, penalise) => {
    const m = { long: 0, short: 0, neutral: 0 };
    for (const [tf, w] of Object.entries(weights)) {
      const e = matrix[tf];
      if (!e) continue;
      let s = e.strength / 100;
      const dir = e.bias === 'long' ? 1 : (e.bias === 'short' ? -1 : 0);
      if (penalise && dir !== 0 && dir === -swingDir) s *= 1 - cfg.counterTrendPenalty;
      if (dir === 0) m.neutral += w;
      else {
        m[LABEL[dir]] += w * s;
        m.neutral += w * (1 - s);
      }
    }
    return toPercent(m);
  };
  return {
    directionalBias: {
      scalp: horizon(cfg.horizons.scalp, true),
      swing: horizon(cfg.horizons.swing, false)
    }
  };
}

/**
 * One compact string for decisionTrace (always published, ≤ 120 bytes):
 * `scalp:L42,S31,N27|swing:L70,S5,N25|tf:1m=S,3m=S,5m=N,15m=L,1h=L,4h=L,1d=L|ct:1`
 * (ct = counter-trend alignments; a timeframe without data reads `-`).
 */
export function biasTraceSummary(matrix, decisionInputs, alignment) {
  const h = (x) => `L${x.long},S${x.short},N${x.neutral}`;
  const tfs = BIAS_TIMEFRAMES.map((tf) => `${tf}=${matrix[tf] ? LETTER[matrix[tf].bias] : '-'}`).join(',');
  const ct = alignment.filter((a) => a.counterTrend).length;
  return `scalp:${h(decisionInputs.directionalBias.scalp)}|swing:${h(decisionInputs.directionalBias.swing)}|tf:${tfs}|ct:${ct}`;
}

export default { timeframeBias, buildBiasMatrix, buildAlignment, alignmentEntry, zonesFromGeometry, buildDecisionInputs, biasTraceSummary, BIAS_TIMEFRAMES };
