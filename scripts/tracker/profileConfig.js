/**
 * Vendored, dependency-free copy of the wallet-strategy profile config (PROFILE_KEYS,
 * PROFILES, tieredPolicyConfig) from the engine repo's lib/execution/riskPolicy.js
 * (T-9 v2, schema 1.27.0). Copied, not imported, so the tracker repo runs its own
 * scripts (profiles.js, strategies-page.js) with no engine checkout - the same reason
 * walk-outcome.js and nf-shadow.js's NF_RULE are vendored rather than imported. Keep the
 * PROFILES numbers and tieredPolicyConfig body byte-for-byte in step with the source;
 * the engine repo's test-tracker.js runs a parity check against the original.
 */

export const PROFILE_KEYS = Object.freeze(['steady', 'aggressive']);
export const DEFAULT_PROFILE = 'steady';

export const PROFILES = Object.freeze({
  steady: Object.freeze({
    key: 'steady',
    label: 'Steady',
    blurb: 'Recommended default — proves itself over 30 trades before anything more aggressive runs live.',
    riskPctPerTrade: 1,
    riskPctCeiling: 2,
    maxExposurePct: 25,
    maxPerSymbolPct: 15,
    dailyDrawdownPct: 3,
    weeklyDrawdownPct: 8,
    minStopPct: Object.freeze({ long: 1.5, short: 1.0 }),
    tierMultipliers: Object.freeze({ A: 1.5, B: 1, C: 0.5 }),
    boostMax: 1.5,
    leverageRule: 'half',
    goal: Object.freeze({ pctPer10Trades: 2, pctPerMonth: [5, 10] }),
    evaluateAfterTrades: 30
  }),
  aggressive: Object.freeze({
    key: 'aggressive',
    label: 'Aggressive',
    blurb: 'Owner target +25% per 10 trades — expected to fail on a 30%/3R edge; tracked in parallel to test it.',
    riskPctPerTrade: 2.5,
    riskPctCeiling: 3,
    maxExposurePct: 50,
    maxPerSymbolPct: 30,
    dailyDrawdownPct: 6,
    weeklyDrawdownPct: 15,
    minStopPct: Object.freeze({ long: 1.0, short: 0.7 }),
    tierMultipliers: Object.freeze({ A: 2, B: 1, C: 0.5 }),
    boostMax: 2,
    leverageRule: 'stop',
    goal: Object.freeze({ pctPer10Trades: 25, pctPerMonth: null }),
    evaluateAfterTrades: 30
  })
});

const MIN_FREE_GAS_SOL = 0.05;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

function normalizeProfileKey(v) {
  return typeof v === 'string' && PROFILE_KEYS.includes(v) ? v : DEFAULT_PROFILE;
}

function profileRiskConfig(profileKey) {
  const p = PROFILES[normalizeProfileKey(profileKey)];
  return {
    pctPerTrade: p.riskPctPerTrade,
    maxExposurePct: p.maxExposurePct,
    maxPerSymbolPct: p.maxPerSymbolPct,
    dailyDrawdownPct: p.dailyDrawdownPct,
    weeklyDrawdownPct: p.weeklyDrawdownPct,
    minFreeGasSol: MIN_FREE_GAS_SOL,
    minStopPct: p.minStopPct
  };
}

function tierMultiplier(profile, tier) {
  const m = profile.tierMultipliers[tier];
  return isPos(m) ? m : 1;
}

/** profileRiskConfig(profileKey) with pctPerTrade scaled by that tier's multiplier. */
export function tieredPolicyConfig(profileKey, tier = 'B') {
  const p = PROFILES[normalizeProfileKey(profileKey)];
  const base = profileRiskConfig(profileKey);
  return { ...base, pctPerTrade: round2(base.pctPerTrade * tierMultiplier(p, tier)) };
}
