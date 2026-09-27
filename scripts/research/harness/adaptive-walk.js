// WP11-B (docs/research/harness/WP11_VALIDATE.md) - adaptive same-bar stop/TP ordering.
// Research only. Does NOT edit scripts/tracker/walk-outcome.js (vendored, read-only import
// below) - this file wraps/reimplements a variant of its `walkOutcome`, plus a matching
// variant of scripts/swing/run.js's `scoreSignalWithHoldRule` (reimplemented, not imported -
// scripts/swing/ is outside this work package's edit/import scope; kept byte-identical to
// its published logic except for the one line the adaptive rule changes).
//
// Reference (docs/research/external-refs/OTHER_REPOS_VERIFY.md, section 1,
// "Adaptive bar ordering (VERIFIED)"): nautechsystems/nautilus_trader
// `crates/execution/src/matching_engine/mod.rs:2281-2283`:
//   fn bar_high_first(&self, bar: &Bar) -> bool {
//       !self.config.bar_adaptive_high_low_ordering || bar.high - bar.open < bar.open - bar.low
//   }
// i.e. with the flag on, whichever of a bar's two extremes is numerically CLOSER to the
// bar's open is assumed touched first. This module applies the same "closer to open wins"
// rule to a signal's STOP and TARGET prices (instead of a bar's high/low) whenever a single
// 1m candle's [low,high] range contains both - the concrete "ambiguous" case the vendored
// walkOutcome already detects (see below) but always resolves conservatively (stop first).
//
// Why this can only matter on ONE specific candle per signal, not many:
// walkOutcome's loop checks `stopHit` before `targetHit` and returns immediately on any
// stopHit=true candle. So every candle BEFORE the final one is, by construction, a
// stopHit=false candle (else the walk would already have ended there as a loss) - ambiguity
// (both stop and target within range) can therefore only ever arise on the walk's LAST
// candle, and only when that candle resolves as a loss. The vendored function already
// records this exact fact via the `ambiguous` field: `{ status:'loss', r:-1, holdCandles,
// ambiguous: targetHit }`. Consequently `ambiguous === true` on a recorded 'loss' outcome is
// both necessary AND sufficient to identify every signal adaptive ordering could possibly
// flip - no other outcome (win/open/not_filled/timeout/structure_exit) can hide a
// stop+target co-touch. `summarizeAmbiguity()` below uses exactly this fact to rescore an
// entire docs/swing/<rule>.json corpus without needing to re-walk 1m candles at all.

import { walkOutcome, isFiniteNumber, round } from '../../tracker/walk-outcome.js';

export { walkOutcome };

/**
 * Adaptive-ordering variant of the vendored `walkOutcome`. Identical in every branch except
 * one: when a candle's range touches BOTH stop and target (and a win would otherwise be
 * creditable there - i.e. it isn't the fill candle unless `prefilled`), the level whose
 * price is numerically closer to that candle's OPEN is assumed hit first, instead of always
 * assuming the stop. A tie (equidistant) keeps the conservative default (stop first), same
 * as Nautilus's strict `<` comparison only swapping the default when the other side is
 * clearly closer.
 * @param {Object} p - same shape as walkOutcome's params.
 * @returns {{status:'invalid_levels'|'not_filled'|'open'|'win'|'loss', r?:number,
 *   holdCandles?:number, timeToTP1Candles?:number, ambiguous?:boolean,
 *   adaptiveResolved?:'stop'|'target'}}
 */
export function walkOutcomeAdaptive({ candles1m, fromMs, direction, entryMin, entryMax, stop, target, fillWindowCandles, maxHoldCandles, prefilled = false }) {
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
  const entry = long ? zoneHigh : zoneLow;
  const rTarget = round(Math.abs(target - entry) / Math.abs(entry - stop), 4);

  const exitEnd = Math.min(candles1m.length, fillIdx + maxHoldCandles);
  for (let i = fillIdx; i < exitEnd; i++) {
    const c = candles1m[i];
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const targetHit = long ? c.high >= target : c.low <= target;
    const holdCandles = i - fillIdx + 1;
    const canWinHere = targetHit && (prefilled || i > fillIdx);

    if (stopHit && canWinHere) {
      // The ambiguous case: this candle's range contains both levels AND a win would
      // otherwise be creditable here. Adaptive ordering: whichever price is closer to
      // this candle's open is assumed touched first.
      const distStop = Math.abs(c.open - stop);
      const distTarget = Math.abs(c.open - target);
      if (distTarget < distStop) {
        return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles, adaptiveResolved: 'target' };
      }
      return { status: 'loss', r: -1, holdCandles, ambiguous: true, adaptiveResolved: 'stop' };
    }
    if (stopHit) return { status: 'loss', r: -1, holdCandles, ambiguous: targetHit };
    if (canWinHere) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };
  }
  return { status: 'open', holdCandles: exitEnd - fillIdx };
}

/**
 * Adaptive-ordering variant of scripts/swing/run.js's `scoreSignalWithHoldRule` (the S3
 * structure-exit path re-flag-retest-1h/4h and re-flag-breakout-4h/re-random-4h opt into).
 * Reimplemented here (not imported - scripts/swing/ is outside this WP's scope); identical
 * to the published function except the same stop/target precedence swap as
 * `walkOutcomeAdaptive` above. The structure-exit ("closed back inside the flag for N
 * candles") check is untouched - adaptive ordering only concerns stop vs target ambiguity.
 * @param {Object} p - same shape as scripts/swing/run.js's scoreSignalWithHoldRule.
 */
export function scoreSignalWithHoldRuleAdaptive({ slice, fromMs, direction, entry, stop, target, fillWindowCandles, maxHoldCandles, holdRule }) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target)) return { status: 'invalid_levels' };

  let start = 0;
  while (start < slice.length && slice[start].timestamp < fromMs) start++;
  const fillEnd = Math.min(slice.length, start + fillWindowCandles);
  let fillIdx = -1;
  for (let i = start; i < fillEnd; i++) {
    if (slice[i].low <= entry && slice[i].high >= entry) { fillIdx = i; break; }
  }
  if (fillIdx === -1) return { status: 'not_filled' };

  const long = direction !== 'short';
  const risk = Math.abs(entry - stop);
  const rTarget = round(Math.abs(target - entry) / risk, 4);
  const { insideLow, insideHigh, n, tfCandleMs } = holdRule;
  let insideStreak = 0;
  let nextBoundaryMs = fromMs + tfCandleMs;

  const exitEnd = Math.min(slice.length, fillIdx + maxHoldCandles);
  for (let i = fillIdx; i < exitEnd; i++) {
    const c = slice[i];
    const stopHit = long ? c.low <= stop : c.high >= stop;
    const targetHit = long ? c.high >= target : c.low <= target;
    const holdCandles = i - fillIdx + 1;
    const canWinHere = targetHit && i > fillIdx;

    if (stopHit && canWinHere) {
      const distStop = Math.abs(c.open - stop);
      const distTarget = Math.abs(c.open - target);
      if (distTarget < distStop) {
        return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles, adaptiveResolved: 'target' };
      }
      return { status: 'loss', r: -1, holdCandles, ambiguous: true, adaptiveResolved: 'stop' };
    }
    if (stopHit) return { status: 'loss', r: -1, holdCandles, ambiguous: targetHit };
    if (canWinHere) return { status: 'win', r: rTarget, holdCandles, timeToTP1Candles: holdCandles };

    while (nextBoundaryMs <= c.timestamp) {
      const inside = c.close >= insideLow && c.close <= insideHigh;
      insideStreak = inside ? insideStreak + 1 : 0;
      if (insideStreak >= n) {
        const r = risk > 0 ? (long ? (c.close - entry) : (entry - c.close)) / risk : 0;
        return { status: 'structure_exit', r: round(r, 4), holdCandles };
      }
      nextBoundaryMs += tfCandleMs;
    }
  }

  const lastIdx = Math.min(slice.length - 1, fillIdx + maxHoldCandles - 1);
  const dataEnd = lastIdx < fillIdx + maxHoldCandles - 1;
  const exit = slice[lastIdx].close;
  const r = risk > 0 ? (long ? (exit - entry) : (entry - exit)) / risk : 0;
  return { status: dataEnd ? 'data_end' : 'timeout', r: round(r, 4), holdCandles: lastIdx - fillIdx + 1, exit };
}

/**
 * Rescore ONE already-scored signal (a docs/swing/<rule>.json row: `{entry, stop, tp1,
 * direction, closedThrough, outcome}`) against its own 1m candle window, under adaptive
 * ordering, by re-locating the exact resolving candle (same fill search + index arithmetic
 * the vendored function itself uses) and comparing distances to that candle's open. Returns
 * null when the signal's recorded outcome is not `{status:'loss', ambiguous:true}` (per the
 * header comment, that is the only outcome adaptive ordering could ever change) - i.e. this
 * function is a no-op fast-path for the ~100% of signals that are provably unaffected,
 * and only actually re-touches 1m data for the (here: zero) signals that need it.
 * @param {{entry:number, stop:number, tp1:number, direction:'long'|'short', closedThrough:string, outcome:Object}} signal
 * @param {Array<{timestamp:number, open:number, high:number, low:number}>} candles1m - ascending, covering the signal's fill+hold window
 * @param {number} fillWindowCandles
 */
export function rescoreAmbiguousSignal(signal, candles1m, fillWindowCandles) {
  if (!signal || signal.outcome.status !== 'loss' || signal.outcome.ambiguous !== true) return null;
  const fromMs = Date.parse(signal.closedThrough);
  const out = walkOutcomeAdaptive({
    candles1m,
    fromMs,
    direction: signal.direction,
    entryMin: signal.entry,
    entryMax: signal.entry,
    stop: signal.stop,
    target: signal.tp1,
    fillWindowCandles,
    maxHoldCandles: signal.outcome.holdCandles + 1 // resolving candle is within the original hold
  });
  return { conservative: signal.outcome, adaptive: out, flipped: out.status !== signal.outcome.status };
}

/**
 * Corpus-level ambiguity summary for one docs/swing/<rule>.json file's already-computed
 * `perSymbol[SYM].signals[]`. Per the header comment, `outcome.ambiguous === true` on a
 * `'loss'` row is the complete, exact set of signals adaptive ordering could flip (no 1m
 * replay needed to enumerate them - only to resolve each one, via `rescoreAmbiguousSignal`).
 * @param {Object} ruleJson - a parsed docs/swing/<id>.json document.
 * @returns {{id:string, n:number, lossCount:number, ambiguousCount:number,
 *   ambiguityRatePctOfN:number, ambiguityRatePctOfLosses:number, existingNetExpR:number|null,
 *   existingNetExpR_sens020:number|null}}
 */
export function summarizeAmbiguity(ruleJson) {
  let n = 0, lossCount = 0, ambiguousCount = 0;
  for (const sym of Object.keys(ruleJson.perSymbol || {})) {
    for (const s of ruleJson.perSymbol[sym].signals) {
      n += 1;
      if (s.outcome.status === 'loss') {
        lossCount += 1;
        if (s.outcome.ambiguous === true) ambiguousCount += 1;
      }
    }
  }
  const stats = ruleJson.combined && ruleJson.combined.stats ? ruleJson.combined.stats : {};
  return {
    id: ruleJson.meta.id,
    n,
    lossCount,
    ambiguousCount,
    ambiguityRatePctOfN: n ? round((ambiguousCount / n) * 100, 3) : 0,
    ambiguityRatePctOfLosses: lossCount ? round((ambiguousCount / lossCount) * 100, 3) : 0,
    existingNetExpR: stats.netExpR ?? null,
    existingNetExpR_sens020: stats.netExpR_sens020 ?? null
  };
}

export default { walkOutcome, walkOutcomeAdaptive, scoreSignalWithHoldRuleAdaptive, rescoreAmbiguousSignal, summarizeAmbiguity };
