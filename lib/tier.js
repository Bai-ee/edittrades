/**
 * Flag/plan tier classification (T-9 v2 P4): a plain A/B/C read off a flagRecommendation
 * record's OWN fields (lib/flagRecommendation.js), never recomputed or re-scored here.
 * Pure, no I/O. Deliberately outside lib/execution/ so lib/telegram.js (which imports
 * nothing from lib/execution on purpose) can classify a tier at Open-tap time without
 * crossing that boundary.
 *
 * A = readiness 'ready' AND qualityBand 'high' AND clarity.gate.passable AND, when the
 *     record carries a SETUP (`setup.stopFloor`, T-15 additive rename of the T-13
 *     `setup.shadowNF`), that SETUP clears the net floor. Since T-15 the net floor is
 *     live and baked into every plan attempt before it can reach 'conditional'/'ready'
 *     (lib/flagTradePlan.js buildPlanAttempt) - so any `setup` that exists has already
 *     cleared it by construction, and this criterion is now effectively always true
 *     when a setup is present. Kept (rather than removed) so a future stricter
 *     tier-specific floor has the same field to read without touching A/B/C's shape
 *     again; still skipped entirely when the field is absent.
 * B = readiness 'ready' but missing one of the A criteria above.
 * C = everything else: 'conditional', 'rejected', 'no_plan', or no record at all (manual
 *     `/order`).
 */

const TIERS = Object.freeze(['A', 'B', 'C']);
export const DEFAULT_TIER = 'B';

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {Object|null} rec - a flagRecommendation record (full or compact), or null for a manual order. */
export function classifyTier(rec) {
  if (!isObj(rec)) return 'C';
  if (rec.readiness !== 'ready') return 'C';
  const gatePassable = isObj(rec.clarity) && isObj(rec.clarity.gate) && rec.clarity.gate.passable === true;
  const topBand = rec.qualityBand === 'high';
  const nf = isObj(rec.setup) && isObj(rec.setup.stopFloor) ? typeof rec.setup.stopFloor.netRR === 'number' : true; // absent -> ignored
  return topBand && gatePassable && nf ? 'A' : 'B';
}

export function isTier(v) {
  return typeof v === 'string' && TIERS.includes(v);
}

/** Any value -> a valid tier, defaulting to DEFAULT_TIER ('B', never boosted or cut). */
export function normalizeTier(v) {
  return isTier(v) ? v : DEFAULT_TIER;
}

export default { DEFAULT_TIER, classifyTier, isTier, normalizeTier };
