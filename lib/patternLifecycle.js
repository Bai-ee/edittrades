/**
 * Pattern lifecycle and visual gate (phase 9).
 *
 * Wraps the phase 4 flag detector's output with the phase 7/8 geometry:
 *   - snapCandidateLevels: breakoutLevel / invalidation snap to a nearby zone edge,
 *     diagonal, or confluence edge, and record where each level came from.
 *   - resolveCoils: a bull and a bear flag over the same range on one timeframe become
 *     one neutral `coil`; once one side triggers, only that side is kept.
 *   - buildVisualGate: per symbol, whether the GPT should look at a chart before acting,
 *     which one, and why.
 *
 * Stateless: everything is derived from the current request's candles and geometry.
 * Direction symmetry: snapping runs in oriented space (a short negates prices), so long
 * and short share one path. Nothing here feeds `strategies.*`, `bestSignal`, or a guard.
 */

import { ENGINE_CONFIG } from '../config/engine.js';

// Timeframes smallest first; a candidate below the geometry timeframes borrows the
// nearest higher one that has geometry.
const TF_ORDER = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];

// Tie-break when two levels are equally near: the stronger evidence wins.
const SOURCE_RANK = Object.freeze({ confluence: 3, diagonal: 2, zone: 1 });

const ACTIVE_STATES = ['triggering', 'confirmed'];

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The geometry timeframe a candidate reads: its own when geometry is configured for it,
 * else the nearest larger configured geometry timeframe. Null when none is larger.
 * @param {string} timeframe
 * @param {Array<string>} [geometryTimeframes=ENGINE_CONFIG.geometry.timeframes]
 * @returns {string|null}
 */
export function geometryTimeframeFor(timeframe, geometryTimeframes = ENGINE_CONFIG.geometry.timeframes) {
  const from = TF_ORDER.indexOf(timeframe);
  if (from < 0) return null;
  for (let i = from; i < TF_ORDER.length; i++) {
    if (geometryTimeframes.includes(TF_ORDER[i])) return TF_ORDER[i];
  }
  return null;
}

/**
 * Every snappable price in one timeframe's geometryContext: both edges of each
 * horizontal zone, each detected diagonal's current level, both edges of each
 * confluence zone.
 * @param {Object|null} geometry - a geometryContext[tf] entry
 * @returns {Array<{price:number, source:'zone'|'diagonal'|'confluence'}>}
 */
export function geometryLevels(geometry) {
  if (!geometry) return [];
  const out = [];
  const add = (price, source) => { if (isFiniteNumber(price)) out.push({ price, source }); };
  for (const z of [...(geometry.horizontalSupportZones || []), ...(geometry.horizontalResistanceZones || [])]) {
    add(z.low, 'zone');
    add(z.high, 'zone');
  }
  for (const d of [geometry.diagonalSupport, geometry.diagonalResistance]) {
    if (d && d.detected) add(d.currentLevel, 'diagonal');
  }
  for (const z of geometry.confluenceZones || []) {
    add(z.low, 'confluence');
    add(z.high, 'confluence');
  }
  return out;
}

/** Nearest oriented level to `target` within `tol` that passes `accept`, or null. */
function nearestLevel(levels, target, tol, accept) {
  let best = null;
  for (const l of levels) {
    if (!accept(l.value)) continue;
    const dist = Math.abs(l.value - target);
    if (dist > tol) continue;
    const better = best === null
      || dist < best.dist
      || (dist === best.dist && SOURCE_RANK[l.source] > SOURCE_RANK[best.source]);
    if (better) best = { ...l, dist };
  }
  return best;
}

/**
 * Refine a flag candidate's breakoutLevel and invalidation with geometry. In oriented
 * space (long as-is, short negated), each level only moves outward, away from the flag:
 *   - invalidation snaps to the nearest level at or beyond the flag's own invalidation
 *     (a stop sits past structure, never inside the consolidation);
 *   - breakoutLevel snaps to the nearest level at or beyond the flag's own breakout
 *     (the trigger is the break of the level that caps the flag).
 * Both within `snapTolAtr` ATRs of the flag's value. Nothing in tolerance keeps the
 * flag's value and `levelSource` "flag". Lifecycle state is unchanged: it is read from
 * the flag's own edges, so a triggering flag can carry a snapped breakoutLevel above
 * the last close - price broke the flag but not yet the level capping it.
 *
 * @param {Object} candidate - detectFlagLifecycle(...).candidate (type "flag")
 * @param {Object|null} geometry - geometryContext for geometryTimeframeFor(candidate.timeframe)
 * @param {number|null} atrValue - ATR of the candidate's own timeframe
 * @param {Object} [cfg=ENGINE_CONFIG.lifecycle]
 * @returns {Object} a new candidate with breakoutLevel, invalidation, levelSource
 */
export function snapCandidateLevels(candidate, geometry, atrValue, cfg = ENGINE_CONFIG.lifecycle) {
  const levelSource = { breakout: 'flag', invalidation: 'flag' };
  const out = { ...candidate, levelSource };
  if (!isFiniteNumber(atrValue) || atrValue <= 0) return out;
  const levels = geometryLevels(geometry);
  if (levels.length === 0) return out;

  const sign = candidate.direction === 'short' ? -1 : 1;
  const oriented = levels.map((l) => ({ value: sign * l.price, price: l.price, source: l.source }));
  const tol = cfg.snapTolAtr * atrValue;
  const brk = sign * candidate.breakoutLevel;
  const inv = sign * candidate.invalidation;

  const invHit = nearestLevel(oriented, inv, tol, (v) => v <= inv);
  const brkHit = nearestLevel(oriented, brk, tol, (v) => v >= brk);

  if (invHit) {
    out.invalidation = invHit.price;
    levelSource.invalidation = invHit.source;
  }
  if (brkHit) {
    out.breakoutLevel = brkHit.price;
    levelSource.breakout = brkHit.source;
  }
  return out;
}

/** Overlap of two flags' [flagLow, flagHigh] ranges, as a percent of the narrower range. */
function rangeOverlapPct(a, b) {
  const overlap = Math.min(a.flagHigh, b.flagHigh) - Math.max(a.flagLow, b.flagLow);
  const narrower = Math.min(a.flagHigh - a.flagLow, b.flagHigh - b.flagLow);
  if (!(overlap > 0) || !(narrower > 0)) return 0;
  return (overlap / narrower) * 100;
}

/**
 * Replace contradictory bull + bear flags on one timeframe. When a long and a short flag
 * overlap by at least `coilOverlapPct` of the narrower range:
 *   - both forming → one `coil` (direction neutral, state forming) in the long's slot;
 *   - one forming, one triggering → the triggering side only.
 * Any other pair (confirmed, failed) is left as it is.
 *
 * @param {Array<Object>} candidates - one timeframe's snapped candidates
 * @param {Object} [cfg=ENGINE_CONFIG.lifecycle]
 * @returns {Array<Object>}
 */
export function resolveCoils(candidates, cfg = ENGINE_CONFIG.lifecycle) {
  const long = candidates.find((c) => c.type === 'flag' && c.direction === 'long');
  const short = candidates.find((c) => c.type === 'flag' && c.direction === 'short');
  if (!long || !short || rangeOverlapPct(long, short) < cfg.coilOverlapPct) return candidates;

  const states = [long.state, short.state];
  if (long.state === 'forming' && short.state === 'forming') {
    const coil = {
      timeframe: long.timeframe,
      type: 'coil',
      direction: 'neutral',
      state: 'forming',
      high: Math.max(long.flagHigh, short.flagHigh),
      low: Math.min(long.flagLow, short.flagLow),
      breakoutLevelUp: long.breakoutLevel,
      breakoutLevelDown: short.breakoutLevel,
      levelSource: { breakoutUp: long.levelSource.breakout, breakoutDown: short.levelSource.breakout },
      durationCandles: Math.max(long.durationCandles, short.durationCandles),
      confidence: Math.max(long.confidence, short.confidence)
    };
    return candidates.filter((c) => c !== short).map((c) => (c === long ? coil : c));
  }
  if (states.includes('forming') && states.includes('triggering')) {
    const dropped = long.state === 'forming' ? long : short;
    return candidates.filter((c) => c !== dropped);
  }
  return candidates;
}

/**
 * Per-symbol visual gate. Evaluated over the symbol's non-failed candidates only; with
 * none, the gate is never set. A candidate raises one or more short codes:
 *   - `<tf>:low_confidence`       triggering/confirmed with confidence < visualConfidenceFloor
 *   - `<gtf>:near_miss_<side>`    its geometry timeframe has a diagonal one touch short
 *   - `<tf>:coil_near_break`      a coil with price within coilBreakAtr ATRs of either breakout
 *   - `<gtf>:low_geometry`        its geometry timeframe's confidence < geometryConfidenceFloor
 *                                 (missing geometry counts as 0)
 * With `nearMissGate` false (phase 9b default), a near-miss code alone does not flag a
 * candidate; near-miss codes are still listed when another code raised the gate.
 * `visualTarget` is the flagged candidate in the most advanced state (triggering or
 * confirmed before forming), then the highest confidence (first on a tie).
 *
 * @param {Object} input
 * @param {string} input.symbol
 * @param {Array<Object>} input.candidates - the symbol's resolved candidates
 * @param {Object} input.geometryByTf - symbols.<SYM>.geometryContext
 * @param {Object} [input.nearMissByTf] - { [gtf]: nearMissDiagonals(...) }
 * @param {Object} [input.marketByTf] - { [tf]: { price, atr } } for the candidate timeframes
 * @param {Object} [cfg=ENGINE_CONFIG.lifecycle]
 * @returns {{needsVisualConfirmation:boolean, visualTarget:{symbol:string,timeframe:string}|null, unresolvedGeometry:Array<string>}}
 */
export function buildVisualGate({ symbol, candidates, geometryByTf = {}, nearMissByTf = {}, marketByTf = {} }, cfg = ENGINE_CONFIG.lifecycle) {
  const codes = [];
  let target = null;
  const rank = (c) => (ACTIVE_STATES.includes(c.state) ? 1 : 0);
  for (const c of candidates || []) {
    if (!c || c.state === 'failed') continue;
    const reasons = [];
    const gtf = geometryTimeframeFor(c.timeframe);

    if (ACTIVE_STATES.includes(c.state) && c.confidence < cfg.visualConfidenceFloor) {
      reasons.push(`${c.timeframe}:low_confidence`);
    }
    const nearMiss = gtf ? nearMissByTf[gtf] : null;
    for (const side of (nearMiss && nearMiss.sides) || []) reasons.push(`${gtf}:near_miss_${side}`);
    if (c.type === 'coil') {
      const m = marketByTf[c.timeframe];
      if (m && isFiniteNumber(m.price) && isFiniteNumber(m.atr) && m.atr > 0) {
        const reach = cfg.coilBreakAtr * m.atr;
        if (Math.abs(c.breakoutLevelUp - m.price) <= reach || Math.abs(m.price - c.breakoutLevelDown) <= reach) {
          reasons.push(`${c.timeframe}:coil_near_break`);
        }
      }
    }
    if (gtf) {
      const g = geometryByTf[gtf];
      const confidence = g && isFiniteNumber(g.confidence) ? g.confidence : 0;
      if (confidence < cfg.geometryConfidenceFloor) reasons.push(`${gtf}:low_geometry`);
    }

    if (reasons.length === 0) continue;
    for (const r of reasons) if (!codes.includes(r)) codes.push(r);
    const raises = cfg.nearMissGate ? reasons : reasons.filter((r) => !r.includes(':near_miss_'));
    if (raises.length === 0) continue;
    if (target === null || rank(c) > rank(target) || (rank(c) === rank(target) && c.confidence > target.confidence)) target = c;
  }
  return {
    needsVisualConfirmation: target !== null,
    visualTarget: target ? { symbol, timeframe: target.timeframe } : null,
    // Near-miss codes collected from candidates that did not raise the gate are dropped
    // with everything else when nothing raised it.
    unresolvedGeometry: target ? codes : []
  };
}

export default { geometryTimeframeFor, geometryLevels, snapCandidateLevels, resolveCoils, buildVisualGate };
