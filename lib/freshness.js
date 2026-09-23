/**
 * Data freshness gate (signal-reliability minimum plan, work package 1).
 *
 * A pure check of one timeframe's `closedThrough` against a pinned `now`: does not
 * change `dataStatus` (that stays a fetch-availability signal, unrelated to candle
 * age) and is not itself published on the payload - it only feeds
 * lib/flagTradePlan.js's fail-closed gate, so a successful-but-old provider response
 * cannot produce a `ready` flag trade plan.
 *
 * Allowed age is one full interval (the candle can be up to one interval old before
 * the next one is expected to have closed) plus a small fixed provider grace period
 * (`freshness.graceMs`, config/engine.json) for normal fetch/processing lag. Missing
 * or unparseable timestamps fail closed - never treated as fresh.
 */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {Object} p
 * @param {string|null} p.closedThroughIso - the timeframe's published `closedThrough`
 * @param {number} p.now - pinned clock, ms epoch
 * @param {number} p.intervalMs - INTERVAL_MS[tf]
 * @param {number} [p.graceMs=0] - provider grace period, ms
 * @returns {{fresh:boolean, reason:string|null, ageMs:number|null, maxAgeMs:number|null}}
 */
export function assessFreshness({ closedThroughIso, now, intervalMs, graceMs = 0 }) {
  if (typeof closedThroughIso !== 'string' || closedThroughIso.length === 0) {
    return { fresh: false, reason: 'missing_closed_through', ageMs: null, maxAgeMs: null };
  }
  const closedThroughMs = Date.parse(closedThroughIso);
  if (!isFiniteNumber(closedThroughMs)) {
    return { fresh: false, reason: 'invalid_closed_through', ageMs: null, maxAgeMs: null };
  }
  if (!isFiniteNumber(intervalMs) || intervalMs <= 0) {
    return { fresh: false, reason: 'unknown_interval', ageMs: null, maxAgeMs: null };
  }
  if (!isFiniteNumber(now)) {
    return { fresh: false, reason: 'invalid_now', ageMs: null, maxAgeMs: null };
  }

  const ageMs = now - closedThroughMs;
  const maxAgeMs = intervalMs + (isFiniteNumber(graceMs) ? graceMs : 0);

  // A closedThrough in the future (clock skew, bad data) is exactly as untrustworthy
  // as one too old - fail closed rather than guess which side is wrong.
  if (ageMs < 0) return { fresh: false, reason: 'closed_through_in_future', ageMs, maxAgeMs };
  if (ageMs > maxAgeMs) return { fresh: false, reason: 'stale', ageMs, maxAgeMs };
  return { fresh: true, reason: null, ageMs, maxAgeMs };
}

/**
 * Assess several `{ tf, closedThroughIso, intervalMs }` requirements at once; fresh
 * only when every one of them is. Stops at the first failure (order given) so the
 * caller gets one stable, deterministic reason rather than a set.
 * @param {Array<{tf:string, closedThroughIso:string|null, intervalMs:number}>} requirements
 * @param {number} now
 * @param {number} [graceMs=0]
 * @returns {{fresh:boolean, tf:string|null, reason:string|null, ageMs:number|null, maxAgeMs:number|null}}
 */
export function assessFreshnessAll(requirements, now, graceMs = 0) {
  for (const req of requirements || []) {
    const result = assessFreshness({ closedThroughIso: req.closedThroughIso, now, intervalMs: req.intervalMs, graceMs });
    if (!result.fresh) return { fresh: false, tf: req.tf, ...result };
  }
  return { fresh: true, tf: null, reason: null, ageMs: null, maxAgeMs: null };
}

export default { assessFreshness, assessFreshnessAll };
