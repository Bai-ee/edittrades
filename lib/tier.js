/**
 * Flag/plan tier classification (T-9 v2 P4): a plain A/B/C read off a flagRecommendation
 * record's OWN fields (lib/flagRecommendation.js), never recomputed or re-scored here.
 * Pure, no I/O. Deliberately outside lib/execution/ so lib/telegram.js (which imports
 * nothing from lib/execution on purpose) can classify a tier at Open-tap time without
 * crossing that boundary.
 *
 * A = readiness 'ready' AND qualityBand 'high' AND clarity.gate.passable AND, when the
 *     record carries a net-floor shadow (T-13 `setup.shadowNF`, not yet merged on this
 *     branch), that shadow is also ready. The NF check is skipped entirely when the field
 *     is absent -- "NF ready when present" -- so this degrades cleanly before T-13 lands.
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
  const nf = isObj(rec.setup) && isObj(rec.setup.shadowNF) ? rec.setup.shadowNF.ready === true : true; // absent -> ignored
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
