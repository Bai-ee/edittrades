/**
 * T4 P4 (docs/PLAN_FLAG_PATHS.md "P4 - More opportunities"), SHADOW MODE: a second,
 * shadow-only entry type for runner-prone flags - a breakout-close entry, published so
 * the tracker can score it against the retest-hold entry `lib/flagTradePlan.js` already
 * publishes. This module never changes a real trade: `flagTradePlan`, `flagRecommendation`
 * class, GO IN logic, strategies, gates, thresholds, the 3% scalp stop guard, and minRR
 * are all untouched by it (see docs/PLAN_FLAG_PATHS.md and CLAUDE.md's hard rules).
 *
 * Pure: no fs, no network, no env, no `Date.now()`, no imports outside scripts/tracker/
 * (sync.js copies every scripts/tracker/*.js file flat into the tracker repo, so an
 * import of `./walk-outcome.js` resolves there the same way it does here; an import of
 * anything under lib/ or config/ would not). `netRiskReward` below is a vendored,
 * dependency-free copy of `lib/flagTradePlan.js`'s exported helper of the same name -
 * kept byte-for-byte in step with the source (test-breakout-entry.js runs a parity
 * check), the same precedent `scripts/tracker/flag-paths.js` sets for its own vendored
 * copy of `observeRetestHold`.
 *
 * RULE this module implements (`shadowEntryFromBreakout`, documented again on the
 * function itself): entry = the breakout candle's own close; stop = invalidation;
 * tp1 = measuredTarget; grossRR = |tp1-entry|/|entry-stop|; netRR = the same fee/
 * slippage formula `flagTradePlan` uses. Published only when grossRR >= cfg.minRR (the
 * same config value `flagTradePlan` gates on, never lowered) AND the stop distance from
 * entry is within cfg.maxStopPct (the same scalp stop cap the engine uses everywhere
 * else). The caller (`lib/breakoutEntry.js`) is the one place that decides WHEN this
 * rule applies (first close beyond breakoutLevel, chase elevated/high) - this module
 * only computes the entry itself, given the caller already decided to try.
 */

// walkShadow reuses ./walk-outcome.js's walkOutcome (prefilled - entry already filled at
// the breakout close, same convention as a `ready` flag plan's retest candle; see that
// file's own header). Both files are copied flat into the tracker repo by sync.js, so
// this import resolves there exactly as it does here.
import { walkOutcome } from './walk-outcome.js';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Vendored, dependency-free copy of `netRiskReward` from `lib/flagTradePlan.js`
 * (exported there only so this copy can be parity-tested against it; zero logic
 * change). Kept byte-for-byte in step with the source - see test-breakout-entry.js's
 * parity case.
 * @param {number} entry
 * @param {number} stop
 * @param {number} target
 * @param {{feeBps:number, slippageBps:number}} riskCfg
 * @returns {number|null}
 */
export function netRiskReward(entry, stop, target, riskCfg) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target) || entry <= 0) return null;
  const grossRisk = Math.abs(entry - stop);
  const grossReward = Math.abs(target - entry);
  if (grossRisk <= 0 || grossReward <= 0) return null;

  const roundTripCostPct = 2 * ((riskCfg.feeBps || 0) + (riskCfg.slippageBps || 0)) / 10000;
  const costAmount = entry * roundTripCostPct;

  const netRisk = grossRisk + costAmount;
  const netReward = grossReward - costAmount;
  if (netRisk <= 0 || netReward <= 0) return null;
  return netReward / netRisk;
}

/**
 * Build the shadow breakout-close entry for one candidate, or null when the rule's own
 * conditions are not met. This function only checks the entry-quality conditions it can
 * see from its own inputs (direction validity, RR floor, stop-distance cap); the
 * "is this actually the breakout candle, nothing after it, with chase elevated/high"
 * conditions live in the caller (`lib/breakoutEntry.js` reads `candidate.ageCandles` and
 * `pathOutlook.chase` for those - see its own header).
 *
 * @param {Object} p
 * @param {'long'|'short'} p.dir
 * @param {number} p.breakoutLevel - the candidate's own (already geometry-snapped)
 *   breakout level; used only to confirm `breakoutClose` actually closed beyond it (a
 *   defensive invariant of this function, independent of the caller's own "first close"
 *   check).
 * @param {number} p.invalidation
 * @param {number} p.measuredTarget
 * @param {number} p.breakoutClose - the breakout candle's own close price; the entry.
 * @param {Object} cfg
 * @param {number} cfg.minRR - grossRR floor (same value `flagTradePlan`'s `minRR` uses)
 * @param {number} cfg.maxStopPct - stop distance from entry, as a percent of entry, cap
 *   (same value the engine's scalp stop guard uses)
 * @param {number} [cfg.feeBps]
 * @param {number} [cfg.slippageBps]
 * @returns {{entry:number, stop:number, tp1:number, grossRR:number, netRR:number|null}|null}
 */
export function shadowEntryFromBreakout({ dir, breakoutLevel, invalidation, measuredTarget, breakoutClose } = {}, cfg = {}) {
  const direction = dir === 'long' || dir === 'short' ? dir : null;
  if (!direction || !isFiniteNumber(breakoutLevel) || !isFiniteNumber(invalidation)
    || !isFiniteNumber(measuredTarget) || !isFiniteNumber(breakoutClose)) return null;

  const sign = direction === 'short' ? -1 : 1;

  // The entry must actually be a breakout close: strictly beyond breakoutLevel in the
  // candidate's own direction. Independent of the caller's "first close" check above.
  if (sign * (breakoutClose - breakoutLevel) <= 0) return null;

  const entry = breakoutClose;
  const stop = invalidation;
  const tp1 = measuredTarget;

  const stopOnRightSide = sign * (entry - stop) > 0;
  const targetAhead = sign * (tp1 - entry) > 0;
  if (!stopOnRightSide || !targetAhead) return null;

  const grossRisk = Math.abs(entry - stop);
  if (!(grossRisk > 0)) return null;

  const grossRR = roundN(Math.abs(tp1 - entry) / grossRisk, 3);
  const minRR = isFiniteNumber(cfg.minRR) ? cfg.minRR : Infinity;
  if (grossRR === null || grossRR < minRR) return null;

  const stopDistancePct = (grossRisk / entry) * 100;
  const maxStopPct = isFiniteNumber(cfg.maxStopPct) ? cfg.maxStopPct : 0;
  if (!(stopDistancePct <= maxStopPct)) return null;

  const netRR = roundN(netRiskReward(entry, stop, tp1, cfg), 3);

  return {
    entry: roundN(entry, 2),
    stop: roundN(stop, 2),
    tp1: roundN(tp1, 2),
    grossRR,
    netRR
  };
}

function minutesBetween(fromMs, toMs) {
  return isFiniteNumber(fromMs) && isFiniteNumber(toMs) ? roundN((toMs - fromMs) / 60000, 1) : null;
}

/**
 * Walk 1m candles forward from `fromMs` (the shadow entry's own `at`, the breakout
 * candle's close time) for up to `windowMs`, prefilled at `entryObj.entry` (no fill-
 * window search - the position is already filled at `fromMs`, same convention as
 * `walkOutcome`'s `prefilled`/`ready_prefilled` path: a target touch on the very first
 * candle counts, a same-candle stop still loses). No lookahead: only candles at/after
 * `fromMs` are ever read.
 *
 * @param {{dir:'long'|'short', entry:number, stop:number, tp1:number}} entryObj - the
 *   published (or candidate) shadow entry; extra fields (id/tf/at/...) are ignored.
 * @param {Array<{timestamp:number, high:number, low:number}>} candles1m - ascending
 * @param {number} fromMs
 * @param {number} [windowMs=86400000] - 24h default; converted to a 1m candle count.
 * @returns {{outcome:'tp1'|'stop'|'open'|'expired', r:number|null, resolvedAt:number|null, minutes:number|null}}
 *   `r` is gross R (stop = -1, tp1 = the same grossRR formula as `shadowEntryFromBreakout`,
 *   open/expired = null - unresolved). `open` = ran out of candle data before `windowMs`
 *   elapsed (check again once more 1m candles land, or there was no data at all yet at
 *   `fromMs`); `expired` = the full `windowMs` window was walked and neither stop nor tp1
 *   was ever touched.
 */
export function walkShadow(entryObj, candles1m, fromMs, windowMs = 24 * 60 * 60 * 1000) {
  const empty = (outcome) => ({ outcome, r: null, resolvedAt: null, minutes: null });

  const dir = entryObj && (entryObj.dir === 'long' || entryObj.dir === 'short') ? entryObj.dir : null;
  const entry = entryObj && isFiniteNumber(entryObj.entry) ? entryObj.entry : null;
  const stop = entryObj && isFiniteNumber(entryObj.stop) ? entryObj.stop : null;
  const tp1 = entryObj && isFiniteNumber(entryObj.tp1) ? entryObj.tp1 : null;
  if (!dir || entry === null || stop === null || tp1 === null || !Array.isArray(candles1m) || !isFiniteNumber(fromMs)) {
    return empty('open');
  }

  let start = 0;
  while (start < candles1m.length && candles1m[start].timestamp < fromMs) start++;

  const maxHoldCandles = Math.max(1, Math.round(windowMs / 60000));
  const result = walkOutcome({
    candles1m,
    fromMs,
    direction: dir,
    entryMin: entry,
    entryMax: entry,
    stop,
    target: tp1,
    fillWindowCandles: 1, // unused when prefilled
    maxHoldCandles,
    prefilled: true
  });

  // 'not_filled' only happens (prefilled) when there is no candle at/after fromMs at
  // all; 'invalid_levels' is a malformed-input guard. Both mean "nothing observed yet",
  // not "resolved" - treated as open, same as running out of data below.
  if (result.status === 'not_filled' || result.status === 'invalid_levels') return empty('open');

  if (result.status === 'win' || result.status === 'loss') {
    const idx = start + result.holdCandles - 1;
    const c = candles1m[idx];
    const resolvedAt = c ? c.timestamp : null;
    const minutes = minutesBetween(fromMs, resolvedAt);
    return result.status === 'win'
      ? { outcome: 'tp1', r: roundN(result.r, 4), resolvedAt, minutes }
      : { outcome: 'stop', r: -1, resolvedAt, minutes };
  }

  // status === 'open': the walk finished its loop without a stop/tp1 touch. Distinguish
  // an exhausted tracking window (expired - fully observed, never resolved) from data
  // simply not reaching the window yet (open - check again later).
  return empty(result.holdCandles >= maxHoldCandles ? 'expired' : 'open');
}

export default { netRiskReward, shadowEntryFromBreakout, walkShadow };
