/**
 * T4 flag paths (P0, docs/PLAN_FLAG_PATHS.md) - measured scenario weights at the moment
 * a flag candidate tightens (`forming`/`proto`, no post-flag candle yet).
 *
 * Pure: no fs, no network, no env, no imports outside scripts/tracker/. Copied flat into
 * the tracker repo by `sync.js` (which has no `lib/` checkout), so nothing here may
 * `import` from the engine - the retest-hold rule is vendored (copied), not imported; see
 * the `observeRetestHold` comment below.
 *
 * Candle shape everywhere in this file: `{timestamp (open ms), open, high, low, close}`,
 * ascending - the same shape `scripts/tracker/walk-outcome.js` uses.
 *
 * Path table (docs/PLAN_FLAG_PATHS.md "Path outcomes"), labelled from the tightening
 * point `opts.fromMs` (the close time at which the candidate was `forming`/`proto`).
 * `R = |breakoutLevel - invalidation|`. Closes are read on the candidate's own timeframe
 * (`candlesTf`); touches are read on 1m (`candles1m`). No lookahead: only candles whose
 * open time >= `fromMs` (and, for 1m touches, >= the breakout close's own open time) are
 * ever read. Long and short are mirrored throughout via `sign = direction === 'short' ? -1 : 1`.
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export const PATHS = Object.freeze(['retest_go', 'runner', 'false_break', 'fail_first', 'chop']);

// opts.targetR (input, default 1) is the "+1R" boundary the path walk resolves against -
// distinct from the `targetR` FIELD labelPath returns (see labelPath's own doc comment).
// opts.fromMs (the tightening point) has no default: it is per-candidate and required.
export const DEFAULT_PATH_OPTS = Object.freeze({ windowCandles: 24, retestTolR: 0.15, targetR: 1 });

/**
 * Vendored, dependency-free copy of `observeRetestHold` from `lib/flagTradePlan.js`
 * (exported there only so this copy can be parity-tested against it; zero logic change).
 * Kept byte-for-byte in step with the source - see test-flag-paths.js's parity cases.
 *
 * Not called by `labelPath` below. `labelPath` needs the retest-hold EVENT'S timestamp
 * (to report as `retestAt`) and needs to interleave that check with a separate,
 * target-vs-invalidation race across one forward walk; this function only ever reports
 * a status as of the LAST candle in whatever array it is given, which does not compose
 * with that walk. `labelPath` instead applies the identical reached-and-held predicate
 * (see `retestReachedHeld` below) progressively as it scans, using `R * retestTolR` as
 * the tolerance in place of `atrValue * toleranceAtr` - the mapping this module uses in
 * place of the engine's ATR-sized tolerance, since a base-rate table is measured against
 * a fixed R, not a live ATR. This function is kept here, unused by the walk, purely so
 * the parity test can prove the underlying rule (reached-within-tolerance-and-held,
 * sequenced after a breakout close, "ready" while the latest close still holds) has not
 * drifted from the engine's own copy.
 * T6 completion plan A3 (docs/PLAN_T6_COMPLETION_V2.md): a retest candle whose wick
 * reaches through the STOP (`low <= stop` for a long, `high >= stop` for a short) before
 * closing back on the hold side is not a valid hold - in a live position that wick would
 * have triggered the stop loss already. Kept byte-for-byte in step with the engine's own
 * copy (see this file's own parity test).
 * @param {Object} p
 * @param {'long'|'short'} p.direction
 * @param {number} p.entry
 * @param {number} p.stop - the plan's own invalidation; a retest candle that wicks past
 *   it is disqualified regardless of where it closed.
 * @param {Array<{timestamp:number, high:number, low:number, close:number}>|null} p.candles
 * @param {number|null} p.fromMs
 * @param {number|null} p.currentPrice
 * @param {number|null} p.atrValue
 * @param {number} p.toleranceAtr
 * @returns {{status:'ready'|'conditional', reasonCode:string|null}}
 */
export function observeRetestHold({ direction, entry, stop, candles, fromMs, currentPrice, atrValue, toleranceAtr }) {
  const sign = direction === 'short' ? -1 : 1;
  const closedThrough = (c) => isFiniteNumber(c.close) && sign * (c.close - entry) > 0;

  if (!Array.isArray(candles) || candles.length < 2 || !isFiniteNumber(atrValue) || atrValue <= 0) {
    const through = isFiniteNumber(currentPrice) && sign * (currentPrice - entry) > 0;
    return { status: 'conditional', reasonCode: through ? 'awaiting_retest' : 'awaiting_breakout' };
  }

  const windowed = isFiniteNumber(fromMs) ? candles.filter((c) => !isFiniteNumber(c.timestamp) || c.timestamp >= fromMs) : candles;
  const last = windowed.length ? windowed[windowed.length - 1] : null;
  const breakoutIdx = windowed.findIndex(closedThrough);
  if (breakoutIdx === -1) return { status: 'conditional', reasonCode: 'awaiting_breakout' };
  if (!last || breakoutIdx >= windowed.length - 1) return { status: 'conditional', reasonCode: 'awaiting_retest' };

  const tolerance = toleranceAtr * atrValue;
  const stopBreached = (c) => isFiniteNumber(stop) && (direction === 'short' ? c.high >= stop : c.low <= stop);
  const isRetestHold = (c) => {
    const reached = direction === 'short' ? c.high >= entry - tolerance : c.low <= entry + tolerance;
    const held = isFiniteNumber(c.close) && sign * (c.close - entry) >= 0;
    return reached && held && !stopBreached(c);
  };
  const retestIdx = windowed.findIndex((c, i) => i > breakoutIdx && isRetestHold(c));
  const lastHeld = isFiniteNumber(last.close) && sign * (last.close - entry) >= 0;
  if (retestIdx !== -1 && lastHeld) return { status: 'ready', reasonCode: null };
  return { status: 'conditional', reasonCode: 'awaiting_retest' };
}

/** Smallest positive gap between consecutive candles - one candle's own duration. */
function inferIntervalMs(candlesTf) {
  if (!Array.isArray(candlesTf) || candlesTf.length < 2) return null;
  let best = null;
  for (let i = 1; i < candlesTf.length; i++) {
    const d = candlesTf[i].timestamp - candlesTf[i - 1].timestamp;
    if (isFiniteNumber(d) && d > 0 && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * Max favourable excursion in R, from `breakoutLevel`, over `candles` (their favourable
 * extreme: high for long, low for short). Not clamped at 0 - a sequence that never
 * approaches `breakoutLevel` legitimately has a negative max.
 */
function maxFavorableR(candles, direction, breakoutLevel, r) {
  if (!Array.isArray(candles) || candles.length === 0 || !(r > 0)) return null;
  const sign = direction === 'short' ? -1 : 1;
  let best = null;
  for (const c of candles) {
    const extreme = direction === 'long' ? c.high : c.low;
    if (!isFiniteNumber(extreme)) continue;
    const rVal = (sign * (extreme - breakoutLevel)) / r;
    if (best === null || rVal > best) best = rVal;
  }
  return best === null ? null : roundN(best, 2);
}

function minutesBetween(fromMs, toMs) {
  return isFiniteNumber(fromMs) && isFiniteNumber(toMs) ? roundN((toMs - fromMs) / 60000, 1) : null;
}

/**
 * Label one candidate's realised path from its tightening point (docs/PLAN_FLAG_PATHS.md
 * "Path outcomes"). Mutually exclusive: exactly one of `PATHS` is returned.
 *
 * @param {Object} candidate - a candidateSetups-shaped object; reads `direction`,
 *   `breakoutLevel`, `invalidation`, and (for `targetR` only) `measuredTarget`.
 * @param {Array<{timestamp:number, open:number, high:number, low:number, close:number}>} candlesTf -
 *   the candidate's own timeframe, ascending closed candles (breakout/invalidation closes,
 *   and the false_break "close back inside the flag" step, which any post-breakout
 *   invalidation close already implies since `invalidation` sits beyond `breakoutLevel`).
 * @param {Array<{timestamp:number, open:number, high:number, low:number, close:number}>} candles1m -
 *   1m ascending closed candles (retest touches and the +`opts.targetR`R touch).
 * @param {Object} opts - merged over DEFAULT_PATH_OPTS; `opts.fromMs` (ms) is required -
 *   the tightening point. No candle with `timestamp < fromMs` is ever read.
 * @returns {{path:string, breakoutAt:number|null, retestAt:number|null, resolvedAt:number|null,
 *   mfeR:number|null, targetR:number|null, minutes:number|null}} `targetR` here is the R
 *   multiple `candidate.measuredTarget` sits at (from `breakoutLevel`/`invalidation`), not
 *   the walk's own +`opts.targetR`R resolution boundary - a static geometry fact about the
 *   candidate, independent of how price actually moved; null when `measuredTarget` is not
 *   a finite number.
 */
export function labelPath(candidate, candlesTf, candles1m, opts = {}) {
  const o = { ...DEFAULT_PATH_OPTS, ...opts };
  const empty = { path: 'chop', breakoutAt: null, retestAt: null, resolvedAt: null, mfeR: null, targetR: null, minutes: null };

  const direction = candidate && (candidate.direction === 'long' || candidate.direction === 'short') ? candidate.direction : null;
  const breakoutLevel = candidate && isFiniteNumber(candidate.breakoutLevel) ? candidate.breakoutLevel : null;
  const invalidation = candidate && isFiniteNumber(candidate.invalidation) ? candidate.invalidation : null;
  const fromMs = isFiniteNumber(o.fromMs) ? o.fromMs : null;

  const targetR = direction && breakoutLevel !== null && invalidation !== null && candidate && isFiniteNumber(candidate.measuredTarget)
    ? (() => {
      const sign = direction === 'short' ? -1 : 1;
      const r = Math.abs(breakoutLevel - invalidation);
      return r > 0 ? roundN((sign * (candidate.measuredTarget - breakoutLevel)) / r, 2) : null;
    })()
    : null;

  if (!direction || breakoutLevel === null || invalidation === null || fromMs === null || !Array.isArray(candlesTf)) {
    return { ...empty, targetR };
  }
  const sign = direction === 'short' ? -1 : 1;
  const r = Math.abs(breakoutLevel - invalidation);
  if (!(r > 0)) return { ...empty, targetR };

  // No lookahead: only candles at/after the tightening point, capped at windowCandles.
  const winTf = candlesTf.filter((c) => isFiniteNumber(c.timestamp) && c.timestamp >= fromMs).slice(0, o.windowCandles);
  if (winTf.length === 0) return { ...empty, targetR };

  const closedBeyondBreakout = (c) => isFiniteNumber(c.close) && sign * (c.close - breakoutLevel) > 0;
  const closedBeyondInvalidation = (c) => isFiniteNumber(c.close) && sign * (c.close - invalidation) < 0;

  const breakoutIdx = winTf.findIndex(closedBeyondBreakout);

  // fail_first: an invalidation close before any breakout close (or with no breakout
  // close at all in the window).
  const preBreakoutInvalidIdx = winTf.findIndex((c, i) => (breakoutIdx === -1 || i < breakoutIdx) && closedBeyondInvalidation(c));
  if (preBreakoutInvalidIdx !== -1) {
    const resolvedAt = winTf[preBreakoutInvalidIdx].timestamp;
    return {
      path: 'fail_first',
      breakoutAt: null,
      retestAt: null,
      resolvedAt,
      mfeR: maxFavorableR(winTf.slice(0, preBreakoutInvalidIdx + 1), direction, breakoutLevel, r),
      targetR,
      minutes: minutesBetween(fromMs, resolvedAt)
    };
  }

  if (breakoutIdx === -1) {
    // Never broke out and never invalidated within the window.
    return {
      path: 'chop',
      breakoutAt: null,
      retestAt: null,
      resolvedAt: null,
      mfeR: maxFavorableR(winTf, direction, breakoutLevel, r),
      targetR,
      minutes: null
    };
  }

  const breakoutAt = winTf[breakoutIdx].timestamp;
  const postTf = winTf.slice(breakoutIdx + 1);
  const invalidationAfterIdx = postTf.findIndex(closedBeyondInvalidation);
  const invalidationAfterAt = invalidationAfterIdx !== -1 ? postTf[invalidationAfterIdx].timestamp : null;

  // Window end boundary (exclusive) for 1m touches: the windowed TF candles' own span,
  // one inferred interval past the last one. Falls back to the last 1m candle available,
  // then to the breakout candle's own close, if spacing can't be inferred (too few
  // candlesTf rows) - never reads past what was actually given.
  const intervalMs = inferIntervalMs(candlesTf);
  const lastWinTfMs = winTf[winTf.length - 1].timestamp;
  const windowEndMs = intervalMs !== null
    ? lastWinTfMs + intervalMs
    : (Array.isArray(candles1m) && candles1m.length ? candles1m[candles1m.length - 1].timestamp + 1 : lastWinTfMs);

  const win1m = Array.isArray(candles1m)
    ? candles1m.filter((c) => isFiniteNumber(c.timestamp) && c.timestamp >= breakoutAt && c.timestamp < windowEndMs)
    : [];

  const targetLevel = breakoutLevel + sign * o.targetR * r;
  const targetIdx1m = win1m.findIndex((c) => (direction === 'long' ? c.high >= targetLevel : c.low <= targetLevel));
  const targetAt = targetIdx1m !== -1 ? win1m[targetIdx1m].timestamp : null;

  // Retest-hold predicate: mirrors observeRetestHold's isRetestHold above, mapped to an
  // R-sized tolerance (R * retestTolR) in place of an ATR-sized one (see the comment on
  // observeRetestHold for why this walk applies the predicate itself instead of calling
  // that function).
  // A retest is a return to the level AFTER the breakout candle has closed: the 1m
  // candles inside the breakout candle itself (the one that crossed from inside the flag)
  // always "touch and hold" the level and must not count.
  // T6 completion plan A3: a 1m touch candle that also wicked through invalidation
  // (stop) before closing back on the hold side is not a valid hold, same rule as
  // observeRetestHold's stopBreached check - in a live position that wick would have
  // stopped the trade out.
  const breakoutCloseMs = breakoutAt + (intervalMs !== null ? intervalMs : 60_000);
  const tolerance = o.retestTolR * r;
  const stopBreached1m = (c) => (direction === 'short' ? c.high >= invalidation : c.low <= invalidation);
  const retestReachedHeld = (c) => {
    if (c.timestamp < breakoutCloseMs) return false;
    const reached = direction === 'short' ? c.high >= breakoutLevel - tolerance : c.low <= breakoutLevel + tolerance;
    const held = isFiniteNumber(c.close) && sign * (c.close - breakoutLevel) >= 0;
    return reached && held && !stopBreached1m(c);
  };

  let path;
  let resolvedAt;
  if (targetAt !== null && (invalidationAfterAt === null || targetAt <= invalidationAfterAt)) {
    // Target reached before (or without) an invalidation close: retest_go if a
    // retest-hold occurred at or before the resolving candle, runner otherwise.
    resolvedAt = targetAt;
    path = win1m.slice(0, targetIdx1m + 1).some(retestReachedHeld) ? 'retest_go' : 'runner';
  } else if (invalidationAfterAt !== null) {
    path = 'false_break';
    resolvedAt = invalidationAfterAt;
  } else {
    path = 'chop';
    resolvedAt = null;
  }

  const retestIdx1m = win1m.findIndex((c) => (resolvedAt === null || c.timestamp <= resolvedAt) && retestReachedHeld(c));
  const retestAt = retestIdx1m !== -1 ? win1m[retestIdx1m].timestamp : null;

  const mfeBoundMs = invalidationAfterAt !== null ? invalidationAfterAt : windowEndMs;
  const mfeR = maxFavorableR(win1m.filter((c) => c.timestamp <= mfeBoundMs), direction, breakoutLevel, r);

  return {
    path,
    breakoutAt,
    retestAt,
    resolvedAt,
    mfeR,
    targetR,
    minutes: minutesBetween(fromMs, resolvedAt)
  };
}

// ---- featuresAt bucket edges (exported; docs/PLAN_FLAG_PATHS.md "Features at the
// tightening point") ----
export const COMPRESSION_BUCKET_EDGES = Object.freeze([0.5, 0.75]);
export const COMPRESSION_BUCKET_LABELS = Object.freeze(['loose', 'moderate', 'tight']);
export const DURATION_BUCKET_EDGES = Object.freeze([4, 9]);
export const DURATION_BUCKET_LABELS = Object.freeze(['short', 'medium', 'long']);
export const IMPULSE_BUCKET_EDGES = Object.freeze([2, 4]);
export const IMPULSE_BUCKET_LABELS = Object.freeze(['weak', 'moderate', 'strong']);
export const LEVEL_TESTS_BUCKET_EDGES = Object.freeze([1, 2]);
export const LEVEL_TESTS_BUCKET_LABELS = Object.freeze(['none', 'one', 'multiple']);
export const STRUCTURE_STEPS_BUCKET_EDGES = Object.freeze([1, 3]);
export const STRUCTURE_STEPS_BUCKET_LABELS = Object.freeze(['none', 'some', 'many']);
export const ROOM_R_BUCKET_EDGES = Object.freeze([1, 3]);
export const ROOM_R_BUCKET_LABELS = Object.freeze(['tight', 'moderate', 'roomy']);
export const HOUR_UTC_BUCKET_EDGES = Object.freeze([6, 12, 18]);
export const HOUR_UTC_BUCKET_LABELS = Object.freeze(['00-06', '06-12', '12-18', '18-24']);

/** `value < edges[0]` -> `labels[0]`, ... , `value >= edges[last]` -> `labels[last]`; 'unknown' when `value` is not a finite number. */
function bucketByEdges(value, edges, labels) {
  if (!isFiniteNumber(value)) return 'unknown';
  for (let i = 0; i < edges.length; i++) {
    if (value < edges[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

/**
 * Count of flag candles whose favourable extreme (high for long, low for short) is
 * within 0.1 ATR of `breakoutLevel` (docs/PLAN_FLAG_PATHS.md "level tests"). null when
 * `flagCandles` or `atrValue` is missing - callers bucket a null count as 'unknown'.
 */
function countLevelTests(flagCandles, direction, breakoutLevel, atrValue) {
  if (!Array.isArray(flagCandles) || !isFiniteNumber(breakoutLevel) || !isFiniteNumber(atrValue) || atrValue <= 0) return null;
  const tol = 0.1 * atrValue;
  let count = 0;
  for (const c of flagCandles) {
    const extreme = direction === 'long' ? c.high : c.low;
    if (isFiniteNumber(extreme) && Math.abs(extreme - breakoutLevel) <= tol) count++;
  }
  return count;
}

/**
 * Simplified higher-lows (long) / lower-highs (short) step count inside the flag: how
 * many candles, in order, set a new best (higher low / lower high) than every candle
 * before it. A cheap proxy, not true swing-pivot detection (plan: "no model library").
 * null when `flagCandles` has fewer than 2 candles.
 */
function countStructureSteps(flagCandles, direction) {
  if (!Array.isArray(flagCandles) || flagCandles.length < 2) return null;
  const first = direction === 'long' ? flagCandles[0].low : flagCandles[0].high;
  if (!isFiniteNumber(first)) return null;
  let best = first;
  let count = 0;
  for (let i = 1; i < flagCandles.length; i++) {
    const extreme = direction === 'long' ? flagCandles[i].low : flagCandles[i].high;
    if (!isFiniteNumber(extreme)) continue;
    const better = direction === 'long' ? extreme > best : extreme < best;
    if (better) { count++; best = extreme; }
  }
  return count;
}

// ---- T5 P0 additions (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md "P0 item 1") ----
// Additive only: every existing featuresAt field/bucket above is unchanged, so the T4
// pathOutlook table (config/engine.json's pathOutlook.broken, keyed on the OLD feature
// set) still resolves the same buckets it always did.

/**
 * Nearest distance from `price` to any zone in `zones` (0 when `price` sits inside one),
 * or null when there is no valid zone to measure against (empty/missing `zones`, or
 * every entry lacks finite low/high).
 * @param {number} price
 * @param {Array<{low:number, high:number}>|null|undefined} zones
 * @returns {number|null}
 */
function nearestZoneDistance(price, zones) {
  if (!isFiniteNumber(price) || !Array.isArray(zones) || zones.length === 0) return null;
  let best = null;
  for (const z of zones) {
    if (!z || !isFiniteNumber(z.low) || !isFiniteNumber(z.high)) continue;
    const d = price >= z.low && price <= z.high ? 0 : (price < z.low ? z.low - price : price - z.high);
    if (best === null || d < best) best = d;
  }
  return best;
}

/**
 * `atLevel` bucket (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md P0 item 1): does the flag's
 * invalidation sit within 0.5 ATR of a support zone (long) / resistance zone (short).
 * 'unknown' only when a required input (direction, invalidation, atr) is missing -
 * an empty/no-zone read with valid inputs is a genuine 'no', not 'unknown'.
 * @param {'long'|'short'|null} direction
 * @param {number|null} invalidation
 * @param {number|null} atrValue
 * @param {Array<Object>|null|undefined} supportZones
 * @param {Array<Object>|null|undefined} resistanceZones
 * @returns {'yes'|'no'|'unknown'}
 */
function atLevelBucket(direction, invalidation, atrValue, supportZones, resistanceZones) {
  if (!direction || !isFiniteNumber(invalidation) || !isFiniteNumber(atrValue) || atrValue <= 0) return 'unknown';
  const zones = direction === 'long' ? supportZones : resistanceZones;
  const distance = nearestZoneDistance(invalidation, zones);
  if (distance === null) return 'no';
  return distance <= 0.5 * atrValue ? 'yes' : 'no';
}

/**
 * `sweepReclaim` bucket: within `candles` (already limited by the caller to the last N
 * candidate-tf candles as of the tightening point), a wick beyond `level` (the flag's
 * invalidation) on the invalidation side, with that same candle's close back on the flag
 * side of it. 'unknown' when there is no candle data or `level`/`direction` is missing;
 * otherwise a scan that finds nothing is a genuine 'no'.
 * @param {Array<{high:number, low:number, close:number}>|null|undefined} candles
 * @param {'long'|'short'|null} direction
 * @param {number|null} level - the flag's invalidation price
 * @returns {'yes'|'no'|'unknown'}
 */
function sweepReclaimBucket(candles, direction, level) {
  if (!direction || !isFiniteNumber(level) || !Array.isArray(candles) || candles.length === 0) return 'unknown';
  const sign = direction === 'short' ? -1 : 1;
  for (const c of candles) {
    if (!c || !isFiniteNumber(c.high) || !isFiniteNumber(c.low) || !isFiniteNumber(c.close)) continue;
    const wickBeyond = direction === 'long' ? c.low < level : c.high > level;
    const closeBack = sign * (c.close - level) >= 0;
    if (wickBeyond && closeBack) return 'yes';
  }
  return 'no';
}

/**
 * `divergence` bucket: Stoch RSI divergence on the candidate timeframe
 * (`lib/modelEvidence.js`'s `buildDivergenceEvidence`), fresh only (its own `strength`
 * field is 0 when stale beyond `divergenceMaxAgeCandles` - a stale divergence reads the
 * same as no divergence here, mirroring how that module excludes stale hits from its own
 * confluence count). 'unknown' when direction or the divergence type itself could not be
 * read (missing price/Stoch history upstream).
 * @param {'long'|'short'|null} direction
 * @param {'bullish'|'bearish'|'none'|'unknown'|null} divergenceType
 * @param {number|null} divergenceStrength
 * @returns {'agrees'|'conflicts'|'none'|'unknown'}
 */
function divergenceBucket(direction, divergenceType, divergenceStrength) {
  if (!direction) return 'unknown';
  if (divergenceType !== 'bullish' && divergenceType !== 'bearish' && divergenceType !== 'none') return 'unknown';
  if (divergenceType === 'none') return 'none';
  if (!(isFiniteNumber(divergenceStrength) && divergenceStrength > 0)) return 'none'; // stale -> fresh-only means "no divergence"
  const agreeType = direction === 'long' ? 'bullish' : 'bearish';
  return divergenceType === agreeType ? 'agrees' : 'conflicts';
}

/**
 * `counterTrend` bucket: the 4h bias (`lib/biasMatrix.js` timeframeBias, `long`/`short`/
 * `neutral`) leaning against the flag's own direction. A measured `neutral` 4h is a known
 * "no lean" - a real 'no', not 'unknown'. 'unknown' only when the 4h bias could not be
 * measured at all (null - insufficient 4h data upstream) or direction is missing.
 * @param {'long'|'short'|null} direction
 * @param {'long'|'short'|'neutral'|null} fourHourBias
 * @returns {'yes'|'no'|'unknown'}
 */
function counterTrendBucket(direction, fourHourBias) {
  if (!direction) return 'unknown';
  if (fourHourBias !== 'long' && fourHourBias !== 'short' && fourHourBias !== 'neutral') return 'unknown';
  if (fourHourBias === 'neutral') return 'no';
  return fourHourBias !== direction ? 'yes' : 'no';
}

/**
 * Bucketed features at the candidate's tightening point (docs/PLAN_FLAG_PATHS.md
 * "Features at the tightening point"). Every value is a bucket label or 'unknown' - never
 * a raw number - so `baseRates` can group on them directly.
 *
 * @param {Object} candidate - reads `direction`, `timeframe`, `breakoutLevel`,
 *   `compressionScore`, `durationCandles`, `impulseStrength`.
 * @param {Object} [ctx] - everything the candidate itself does not carry. Missing/invalid
 *   fields bucket as 'unknown', never thrown.
 * @param {Array<Object>} [ctx.flagCandles] - the flag's own candles (candlesTf slice),
 *   for `levelTests`/`structureSteps`.
 * @param {number} [ctx.atrValue] - candidate timeframe ATR at the tightening point, for `levelTests`.
 * @param {string} [ctx.stochSide] - e.g. 'bull'/'bear'/'neutral' (lib/modelEvidence.js Stoch RSI), passed through as-is.
 * @param {number|string} [ctx.stochSlope] - a signed slope number (bucketed to rising/falling/flat) or an already-labelled string.
 * @param {boolean} [ctx.sameDirOtherTf] - another timeframe has a same-direction live candidate.
 * @param {string} [ctx.tdSide] - top-down sentiment token (lib/biasMatrix.js `td:` side).
 * @param {string} [ctx.ema200Side] - 'above'/'below' (candidate.ema200Side upstream).
 * @param {number} [ctx.roomR] - room to the next opposing geometry level, in R.
 * @param {number} [ctx.fromMs] - the tightening point, for `hourUtc`.
 * @param {Array<{low:number,high:number}>} [ctx.supportZones] - horizontal support zones
 *   (geometryContext, merged across timeframes) for `atLevel` (long).
 * @param {Array<{low:number,high:number}>} [ctx.resistanceZones] - horizontal resistance
 *   zones for `atLevel` (short).
 * @param {Array<Object>} [ctx.recentCandles] - the last N candidate-tf candles as of the
 *   tightening point (no lookahead), for `sweepReclaim`.
 * @param {string} [ctx.divergenceType] - 'bullish'/'bearish'/'none' (lib/modelEvidence.js
 *   `buildDivergenceEvidence`'s `byTimeframe[tf].type`), for `divergence`.
 * @param {number} [ctx.divergenceStrength] - the same object's `strength` (0 = stale).
 * @param {string} [ctx.fourHourBias] - 'long'/'short'/'neutral' (lib/biasMatrix.js
 *   `matrix['4h'].bias`), for `counterTrend`.
 * @returns {Object} bucketed feature map (see field list in the source)
 */
export function featuresAt(candidate, ctx = {}) {
  const direction = candidate && (candidate.direction === 'long' || candidate.direction === 'short') ? candidate.direction : null;
  const breakoutLevel = candidate && isFiniteNumber(candidate.breakoutLevel) ? candidate.breakoutLevel : null;
  const invalidation = candidate && isFiniteNumber(candidate.invalidation) ? candidate.invalidation : null;
  const atrValue = isFiniteNumber(ctx.atrValue) ? ctx.atrValue : null;
  const flagCandles = Array.isArray(ctx.flagCandles) ? ctx.flagCandles : null;

  const levelTestsCount = direction && breakoutLevel !== null ? countLevelTests(flagCandles, direction, breakoutLevel, atrValue) : null;
  const structureCount = direction ? countStructureSteps(flagCandles, direction) : null;

  const hour = isFiniteNumber(ctx.fromMs) ? new Date(ctx.fromMs).getUTCHours() : null;

  const stochSlopeRaw = ctx.stochSlope;
  const stochSlope = isFiniteNumber(stochSlopeRaw)
    ? (stochSlopeRaw > 0 ? 'rising' : stochSlopeRaw < 0 ? 'falling' : 'flat')
    : (typeof stochSlopeRaw === 'string' && stochSlopeRaw ? stochSlopeRaw : null);

  return {
    compression: candidate && isFiniteNumber(candidate.compressionScore)
      ? bucketByEdges(candidate.compressionScore, COMPRESSION_BUCKET_EDGES, COMPRESSION_BUCKET_LABELS) : 'unknown',
    duration: candidate && isFiniteNumber(candidate.durationCandles)
      ? bucketByEdges(candidate.durationCandles, DURATION_BUCKET_EDGES, DURATION_BUCKET_LABELS) : 'unknown',
    impulseStrength: candidate && isFiniteNumber(candidate.impulseStrength)
      ? bucketByEdges(candidate.impulseStrength, IMPULSE_BUCKET_EDGES, IMPULSE_BUCKET_LABELS) : 'unknown',
    tf: candidate && candidate.timeframe ? candidate.timeframe : 'unknown',
    direction: direction || 'unknown',
    levelTests: levelTestsCount !== null ? bucketByEdges(levelTestsCount, LEVEL_TESTS_BUCKET_EDGES, LEVEL_TESTS_BUCKET_LABELS) : 'unknown',
    structureSteps: structureCount !== null ? bucketByEdges(structureCount, STRUCTURE_STEPS_BUCKET_EDGES, STRUCTURE_STEPS_BUCKET_LABELS) : 'unknown',
    stochSide: typeof ctx.stochSide === 'string' && ctx.stochSide ? ctx.stochSide : 'unknown',
    stochSlope: stochSlope || 'unknown',
    tfAgreement: ctx.sameDirOtherTf === true ? 'agree' : ctx.sameDirOtherTf === false ? 'disagree' : 'unknown',
    tdSide: typeof ctx.tdSide === 'string' && ctx.tdSide ? ctx.tdSide : 'unknown',
    ema200Side: typeof ctx.ema200Side === 'string' && ctx.ema200Side ? ctx.ema200Side : 'unknown',
    roomR: isFiniteNumber(ctx.roomR) ? bucketByEdges(ctx.roomR, ROOM_R_BUCKET_EDGES, ROOM_R_BUCKET_LABELS) : 'unknown',
    hourUtc: hour !== null ? bucketByEdges(hour, HOUR_UTC_BUCKET_EDGES, HOUR_UTC_BUCKET_LABELS) : 'unknown',
    // T5 P0 (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md): additive fields, computed by the
    // helpers just above.
    divergence: divergenceBucket(direction, typeof ctx.divergenceType === 'string' ? ctx.divergenceType : null, ctx.divergenceStrength),
    atLevel: atLevelBucket(direction, invalidation, atrValue, ctx.supportZones, ctx.resistanceZones),
    sweepReclaim: sweepReclaimBucket(Array.isArray(ctx.recentCandles) ? ctx.recentCandles : null, direction, invalidation),
    counterTrend: counterTrendBucket(direction, typeof ctx.fourHourBias === 'string' ? ctx.fourHourBias : null)
  };
}

/**
 * Base-rate table: groups `rows` by `keyFn(row)`, and for each key reports the count and
 * each path's share of that group. A row is expected to carry a `path` field (one of
 * `PATHS`, e.g. a `labelPath` result merged with its `featuresAt` bucket); rows with no
 * usable key (`keyFn` returns null/undefined) are skipped.
 * @param {Array<Object>} rows
 * @param {(row:Object) => (string|number|null|undefined)} keyFn
 * @param {number} [minN=100]
 * @returns {Array<{key:(string|number), n:number, shares:Object<string,number|null>, calibrated:boolean}>}
 */
export function baseRates(rows, keyFn, minN = 100) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = keyFn(row);
    if (key === undefined || key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = [];
  for (const [key, groupRows] of groups) {
    const n = groupRows.length;
    const shares = {};
    for (const p of PATHS) {
      const count = groupRows.filter((row) => row.path === p).length;
      shares[p] = n > 0 ? roundN((count / n) * 100, 2) : null;
    }
    out.push({ key, n, shares, calibrated: n >= minN });
  }
  return out;
}

export default { PATHS, DEFAULT_PATH_OPTS, observeRetestHold, labelPath, featuresAt, baseRates };
