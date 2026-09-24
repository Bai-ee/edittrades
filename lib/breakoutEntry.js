/**
 * T4 P4 (docs/PLAN_FLAG_PATHS.md "P4 - More opportunities"), SHADOW MODE: publishes a
 * breakout-close entry for runner-prone flags, for the tracker to score - never an
 * input to `flagTradePlan`, `flagRecommendation` class, GO IN logic, strategies, gates,
 * thresholds, the 3% scalp stop guard, or `minRR`. Those stay exactly as
 * `lib/flagTradePlan.js` computes them; this module only describes a second,
 * shadow-only entry the tracker independently walks and scores. See CLAUDE.md's hard
 * rules and docs/PLAN_FLAG_PATHS.md.
 *
 * Pure: no fs, no network, no `Date.now()`. Imports only `config/engine.js` and
 * `scripts/tracker/breakout-entry.js`'s `shadowEntryFromBreakout` - the same precedent
 * `lib/pathOutlook.js` sets importing `scripts/tracker/flag-paths.js`'s `featuresAt`.
 *
 * RULE (docs/PLAN_FLAG_PATHS.md P4 plan, as approved for shadow mode): for the symbol's
 * `pathOutlook` candidate (same `candidateId`), when `pathOutlook.at === 'broken'` AND
 * the candidate's own timeframe's most recent closed candle is the FIRST close beyond
 * `breakoutLevel` (the breakout candle itself; nothing after it - `candidate.ageCandles
 * === 0`, `lib/patternDetector.js`'s "candles since the break candle, 0 = the break is
 * the last closed candle") AND `pathOutlook.chase` is `'elevated'` or `'high'`: entry =
 * that candle's own close, stop = invalidation, tp1 = measuredTarget, gated on the same
 * `minRR` and scalp max-stop-distance config `flagTradePlan` uses (never lowered) -
 * `scripts/tracker/breakout-entry.js`'s `shadowEntryFromBreakout` computes and gates all
 * of that. Otherwise null. `ageCandles` is only ever set (and only ever `0`) on a
 * `triggering` candidate the very build its own breakout candle closes - a `confirmed`
 * candidate always has `ageCandles >= 1` (confirmCloses >= 2 closes past breakoutLevel
 * by definition), so this rule can only ever fire once per candidate, on its first
 * broken build.
 */

import { ENGINE_CONFIG } from '../config/engine.js';
import { shadowEntryFromBreakout } from '../scripts/tracker/breakout-entry.js';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Build the symbol's `breakoutEntry` shadow-mode payload field, or null.
 *
 * @param {Object} pieces
 * @param {Array<Object>|null} pieces.candidateSetups - the symbol's full (un-slimmed)
 *   candidateSetups, same array `flagTradePlan`/`pathOutlook` were built from.
 * @param {Object|null} pieces.pathOutlook - this build's `lib/pathOutlook.js` result for
 *   the same symbol (already built; read-only here, never re-derived).
 * @param {Object|null} pieces.tfEntries - the symbol's per-timeframe entries (`.closedThrough` read)
 * @param {Object|null} pieces.closedByTf - tf -> full closed candles for this build
 * @param {Object} [cfg=ENGINE_CONFIG]
 * @returns {{id:string, tf:string, dir:'long'|'short', at:string, entry:number, stop:number,
 *   tp1:number, grossRR:number, netRR:number|null, status:'shadow'}|null}
 */
export function buildBreakoutEntry({ candidateSetups, pathOutlook, tfEntries, closedByTf } = {}, cfg = ENGINE_CONFIG) {
  if (!pathOutlook || pathOutlook.at !== 'broken') return null;
  if (pathOutlook.chase !== 'elevated' && pathOutlook.chase !== 'high') return null;

  const candidate = (candidateSetups || []).find((c) => c && c.type === 'flag'
    && c.candidateId === pathOutlook.id
    && (c.state === 'triggering' || c.state === 'confirmed'));
  if (!candidate) return null;

  // The most recent closed candle on the candidate's own timeframe is the FIRST close
  // beyond breakoutLevel, nothing after it - see this file's header.
  if (candidate.ageCandles !== 0) return null;

  const tf = candidate.timeframe;
  const tfCandles = closedByTf && Array.isArray(closedByTf[tf]) ? closedByTf[tf] : null;
  const breakoutClose = tfCandles && tfCandles.length ? tfCandles[tfCandles.length - 1].close : null;
  const at = tfEntries && tfEntries[tf] && typeof tfEntries[tf].closedThrough === 'string' ? tfEntries[tf].closedThrough : null;
  if (!isFiniteNumber(breakoutClose) || !at) return null;

  const shadow = shadowEntryFromBreakout({
    dir: candidate.direction,
    breakoutLevel: candidate.breakoutLevel,
    invalidation: candidate.invalidation,
    measuredTarget: candidate.measuredTarget,
    breakoutClose
  }, {
    minRR: cfg.flagPlan.minRR,
    maxStopPct: cfg.scalp.maxStopDistancePct,
    feeBps: cfg.risk.feeBps,
    slippageBps: cfg.risk.slippageBps
  });
  if (!shadow) return null;

  return {
    id: candidate.candidateId,
    tf,
    dir: candidate.direction,
    at,
    entry: shadow.entry,
    stop: shadow.stop,
    tp1: shadow.tp1,
    grossRR: shadow.grossRR,
    netRR: shadow.netRR,
    status: 'shadow'
  };
}

export default { buildBreakoutEntry };
