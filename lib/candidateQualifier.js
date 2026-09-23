/**
 * Trade qualification (F1 item 8) - a compact read layered on top of a flag/coil
 * candidate, built only from data already elsewhere in the payload: the symbol's other
 * candidates (conflict), its geometryContext (room), its per-timeframe Stoch RSI
 * (exhaustion), the candidate's own ema200Side/chaseRisk/measuredRR, and the 4h bias
 * lean. It never adds a new detection signal and never changes the candidate it reads -
 * `qual` is attached beside the existing fields, the same separate-channel rule as
 * `risk` (attachCandidateRisk, services/scalpContext.js).
 *
 * `decision` is a compact next-step label (watch/wait/dont/actionable), not a
 * probability of profit - the plan is explicit that this layer never estimates win
 * odds. `quality` bands the detector's own 0-100 `confidence` (impulse/compression/
 * EMA21/Stoch evidence) rather than computing a second, competing score.
 */

import { ENGINE_CONFIG } from '../config/engine.js';
import { geometryTimeframeFor } from './patternLifecycle.js';

const ACTIVE_CONFLICT_STATES = ['forming', 'triggering', 'confirmed'];
const OPPOSITE = { long: 'short', short: 'long' };

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function qualityBand(confidence, cfg) {
  if (!isFiniteNumber(confidence)) return 'low';
  if (confidence >= cfg.highConfidence) return 'high';
  if (confidence >= cfg.medConfidence) return 'med';
  return 'low';
}

/**
 * `conflict:<tf>-<dir>`: an opposite-direction candidate forming or later (forming through
 * confirmed - not proto, failed or expired; a proto is 1-2 candles and would only add
 * noise) on another 1m/3m/5m timeframe. A neutral coil neither
 * raises nor is targeted by this check (it already reflects both directions).
 */
function conflictReasons(candidate, allCandidates) {
  const opposite = OPPOSITE[candidate.direction];
  if (!opposite) return [];
  const codes = [];
  for (const other of allCandidates || []) {
    if (other === candidate || other.timeframe === candidate.timeframe) continue;
    if (other.direction !== opposite || !ACTIVE_CONFLICT_STATES.includes(other.state)) continue;
    const code = `conflict:${other.timeframe}-${other.direction}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * `stoch:ob-cross` / `stoch:os-cross`: the candidate's own timeframe Stoch RSI showing
 * overbought-with-bearish-cross against a long, mirrored oversold-with-bullish-cross
 * against a short - exhaustion/reversal risk, not a detection input.
 */
function stochReason(candidate, stochRsiByTf) {
  const stoch = stochRsiByTf && stochRsiByTf[candidate.timeframe];
  if (!stoch || !stoch.state || !stoch.cross) return null;
  if (candidate.direction === 'long' && stoch.state === 'OVERBOUGHT' && stoch.cross === 'BEARISH_CROSS') return 'stoch:ob-cross';
  if (candidate.direction === 'short' && stoch.state === 'OVERSOLD' && stoch.cross === 'BULLISH_CROSS') return 'stoch:os-cross';
  return null;
}

/**
 * `room:blocked-<tf>`: a geometry resistance zone (long) or support zone (short) on the
 * candidate's own mapped geometry timeframe (geometryTimeframeFor(candidate.timeframe))
 * sits between breakoutLevel and measuredTarget - the measured-move target has a level
 * in the way before it gets there. Owner decision 2026-09-23 item 4a: zones on any
 * farther geometry timeframe never block here.
 */
function roomBlockedReasons(candidate, geometryContext) {
  if (!isFiniteNumber(candidate.breakoutLevel) || !isFiniteNumber(candidate.measuredTarget)) return [];
  const lo = Math.min(candidate.breakoutLevel, candidate.measuredTarget);
  const hi = Math.max(candidate.breakoutLevel, candidate.measuredTarget);
  const tf = geometryTimeframeFor(candidate.timeframe);
  const g = tf && geometryContext ? geometryContext[tf] : null;
  if (!g) return [];
  const zones = candidate.direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones;
  if (!Array.isArray(zones)) return [];
  const blocked = zones.some((z) => isFiniteNumber(z.low) && isFiniteNumber(z.high) && z.low <= hi && z.high >= lo);
  return blocked ? [`room:blocked-${tf}`] : [];
}

/**
 * Build one candidate's qualification. Reads only fields already in the payload; never
 * mutates `candidate` or `allCandidates`.
 * @param {Object} candidate - one of the symbol's finalized candidateSetups entries
 * @param {Array<Object>} allCandidates - the symbol's full candidateSetups (all
 *   timeframes, pre-filter), for the conflict check
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.geometryContext] - the symbol's geometryContext
 * @param {Object|null} [ctx.stochRsiByTf] - `{ [tf]: stochRsi }` for the flag timeframes
 * @param {'long'|'short'|'neutral'|null} [ctx.fourHourBias] - bias.matrix['4h'].bias
 * @param {Object} [cfg=ENGINE_CONFIG.flag]
 * @returns {{quality:'low'|'med'|'high', decision:'watch'|'wait'|'dont'|'actionable', reasons:Array<string>}}
 */
export function buildQualification(candidate, allCandidates, ctx = {}, cfg = ENGINE_CONFIG.flag) {
  const { geometryContext = null, stochRsiByTf = null, fourHourBias = null } = ctx;
  const dir = candidate.direction;
  const reasons = [];

  for (const code of conflictReasons(candidate, allCandidates)) reasons.push(code);

  const stoch = stochReason(candidate, stochRsiByTf);
  if (stoch) reasons.push(stoch);

  for (const code of roomBlockedReasons(candidate, geometryContext)) reasons.push(code);

  if (candidate.ema200Side && ((dir === 'long' && candidate.ema200Side === 'below') || (dir === 'short' && candidate.ema200Side === 'above'))) {
    reasons.push('ema200:counter');
  }
  if ((dir === 'long' || dir === 'short') && (fourHourBias === 'long' || fourHourBias === 'short') && fourHourBias !== dir) {
    reasons.push('ct:4h');
  }
  if (candidate.chaseRisk === true) reasons.push('chase');
  if (isFiniteNumber(candidate.measuredRR) && candidate.measuredRR < 3) reasons.push(`rr:${candidate.measuredRR}`);

  let decision;
  if (candidate.state === 'proto' || candidate.state === 'forming') {
    decision = 'watch';
  } else if (candidate.state === 'triggering') {
    decision = 'wait';
  } else if (candidate.state === 'failed' || candidate.state === 'expired') {
    decision = 'dont';
  } else if (candidate.state === 'confirmed') {
    const blocking = reasons.some((r) => r.startsWith('room:blocked') || r === 'chase' || r.startsWith('rr:'));
    decision = blocking ? 'wait' : 'actionable';
  } else {
    decision = 'wait';
  }

  return { quality: qualityBand(candidate.confidence, cfg.quality), decision, reasons };
}

/**
 * Attach `.qual` to every candidate in a symbol's finalized candidateSetups, in place -
 * the same mutate-in-place shape as attachCandidateRisk (services/scalpContext.js).
 * Additive only: no other field is read from or written to.
 * @param {Array<Object>} candidateSetups
 * @param {Object} [ctx] - see buildQualification
 * @param {Object} [cfg=ENGINE_CONFIG.flag]
 * @returns {Array<Object>} the same array
 */
export function attachQualification(candidateSetups, ctx = {}, cfg = ENGINE_CONFIG.flag) {
  for (const candidate of candidateSetups || []) {
    candidate.qual = buildQualification(candidate, candidateSetups, ctx, cfg);
  }
  return candidateSetups;
}

export default { buildQualification, attachQualification };
