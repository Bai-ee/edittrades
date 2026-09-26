/**
 * Wallet-aware risk policy (T-8, docs/PROMPT_T8_AGENT_H.md). Pure, no I/O: every number
 * the caller needs (equity, open positions, daily/weekly PnL, free gas) is passed in.
 *
 * This sits ON TOP of the executor's env caps (lib/execution/gates.js CAP_ENV), which
 * stay hard floors — this module never raises them, only adds a wallet-relative layer
 * (risk per trade, exposure, drawdown, gas) that can refuse a trade the env caps alone
 * would allow.
 *
 * `policy` (readRiskPolicyConfig) is env-driven, all optional, with the defaults below.
 * A caller may also fold in `maxSizeCapUsd` / `maxLeverageCap` (the executor's own env
 * caps) so sizing suggestions never exceed them — see `preflight` in executor.js.
 */

import { maxLeverageForStop } from '../riskEngine.js';
import { ENGINE_CONFIG } from '../../config/engine.js';

export const RISK_ENV = Object.freeze({
  pctPerTrade: 'RISK_PCT_PER_TRADE',
  maxExposurePct: 'RISK_MAX_EXPOSURE_PCT',
  maxPerSymbolPct: 'RISK_MAX_PER_SYMBOL_PCT',
  dailyDrawdownPct: 'RISK_DAILY_DRAWDOWN_PCT',
  weeklyDrawdownPct: 'RISK_WEEKLY_DRAWDOWN_PCT',
  minFreeGasSol: 'RISK_MIN_FREE_GAS_SOL'
});

export const RISK_DEFAULTS = Object.freeze({
  pctPerTrade: 0.5,
  maxExposurePct: 25,
  maxPerSymbolPct: 15,
  dailyDrawdownPct: 3,
  weeklyDrawdownPct: 8,
  minFreeGasSol: 0.05
});

/** Absolute ceiling on a `/risk pct` override, independent of env (H4). */
export const RISK_PCT_PER_TRADE_MAX = 2;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

/**
 * Wallet-management strategy profiles (T-9 v2, docs/PLAN_TELEGRAM_EXECUTION.md
 * "Profiles"). `steady` is the default and must prove itself over `evaluateAfterTrades`
 * trades before anything more aggressive runs live; `aggressive` is defined and tracked
 * in parallel on the same calls (never live-sized unless the owner switches to it via
 * PIN — see lib/execution/executor.js `switchProfile`).
 *
 * `riskPctPerTrade` is the profile's own per-trade default (what `/risk reset` returns
 * to); `riskPctCeiling` is the highest a `/risk pct` override may raise it to for THAT
 * profile (see `riskOverrideBound` below) — the only place a per-trade risk above the
 * historical 2% absolute ceiling is allowed, and only while `aggressive` is the active
 * profile. `minStopPct` is a fee-floor: a stop tighter than this (by direction) refuses
 * with `stop_too_tight` (see `evaluateRiskPolicy`). `tierMultipliers` scale the risk
 * budget by the flag's own tier (lib/tier.js `classifyTier`: A/B/C). `leverageRule`
 * governs `suggestedLeverage` for non-A tiers: `'half'` = 50% of the stop-allowed max,
 * `'stop'` = the full stop-allowed max regardless of tier. `boostMax` caps the one-time
 * Boost multiplier (never above the top tier's own multiplier). `goal` is descriptive
 * only (rendered on the website / `/risk goal` pace check), not enforced here.
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

export function isProfileKey(v) {
  return typeof v === 'string' && PROFILE_KEYS.includes(v);
}

/** Any value -> a valid profile key, defaulting to DEFAULT_PROFILE. Never throws. */
export function normalizeProfileKey(v) {
  return isProfileKey(v) ? v : DEFAULT_PROFILE;
}

/** A profile's own numbers in the RISK_ENV shape (the "un-tiered" base for that profile). */
export function profileRiskConfig(profileKey) {
  const p = PROFILES[normalizeProfileKey(profileKey)];
  return {
    pctPerTrade: p.riskPctPerTrade,
    maxExposurePct: p.maxExposurePct,
    maxPerSymbolPct: p.maxPerSymbolPct,
    dailyDrawdownPct: p.dailyDrawdownPct,
    weeklyDrawdownPct: p.weeklyDrawdownPct,
    minFreeGasSol: RISK_DEFAULTS.minFreeGasSol,
    minStopPct: p.minStopPct
  };
}

/** tierMultipliers['B'] (1) when the tier is missing/unknown -- a flag with no computed tier is never boosted or cut. */
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

/** suggestedLeverage after a profile's leverageRule ('half' halves it for non-A tiers; 'stop' never touches it). */
export function applyLeverageRule(profileKey, tier, suggestedLeverage) {
  if (!isPos(suggestedLeverage)) return suggestedLeverage;
  const p = PROFILES[normalizeProfileKey(profileKey)];
  if (p.leverageRule !== 'half' || tier === 'A') return suggestedLeverage;
  return Math.max(1, Math.floor(suggestedLeverage / 2));
}

/**
 * The next tier up from `tier` ('C'->'B'->'A'), or null from 'A' (nothing to boost to)
 * or an unrecognized tier.
 */
export function nextTier(tier) {
  if (tier === 'C') return 'B';
  if (tier === 'B') return 'A';
  return null;
}

/**
 * The multiplier a Boost applies for `profileKey` at `tier`: the next tier's own
 * multiplier, never above that profile's `boostMax`. `null` when there is no next tier
 * (already 'A') or the tier is unrecognized.
 */
export function boostMultiplier(profileKey, tier) {
  const up = nextTier(tier);
  if (!up) return null;
  const p = PROFILES[normalizeProfileKey(profileKey)];
  return Math.min(tierMultiplier(p, up), p.boostMax);
}

function envNum(env, name, fallback) {
  const raw = env && env[name];
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const n = Number(raw.trim());
  return isPos(n) ? n : fallback;
}

/** Env-driven policy thresholds, always usable (every field has a default). */
export function readRiskPolicyConfig(env = process.env) {
  const e = env || {};
  const out = {};
  for (const [key, name] of Object.entries(RISK_ENV)) out[key] = envNum(e, name, RISK_DEFAULTS[key]);
  return out;
}

/**
 * Sanitize an arbitrary object into only the known numeric risk-pref keys (positive
 * finite numbers). Unknown keys and invalid values are dropped, never thrown on.
 */
export function normalizeRiskPrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(RISK_ENV)) if (isPos(p[key])) out[key] = p[key];
  return out;
}

/**
 * The highest value a `/risk <key> <value>` override may set: never above the deployed
 * env default for that key (prefs can only tighten a knob, never loosen it), and
 * `pctPerTrade` additionally never above RISK_PCT_PER_TRADE_MAX -- UNLESS `profileKey` is
 * given (T-9 v2), in which case `pctPerTrade`'s bound is that profile's OWN
 * `riskPctCeiling` instead (steady 2%, aggressive 3%: the one place a per-trade override
 * may go above the historical 2% absolute ceiling, and only while that profile is
 * active). Every other key is unaffected by `profileKey` and stays tighten-only against
 * `envConfig[key]` exactly as before.
 */
export function riskOverrideBound(key, envConfig, profileKey = null) {
  const cap = envConfig && isPos(envConfig[key]) ? envConfig[key] : RISK_DEFAULTS[key];
  if (key !== 'pctPerTrade') return cap;
  if (profileKey && isProfileKey(profileKey)) return PROFILES[profileKey].riskPctCeiling;
  return Math.min(cap, RISK_PCT_PER_TRADE_MAX);
}

/**
 * envConfig with any in-bound prefs overrides applied (out-of-bound / invalid ones
 * ignored). `profileKey` (T-9 v2, optional) is passed straight through to
 * `riskOverrideBound` so a `pctPerTrade` override is bound by the active profile's own
 * ceiling rather than the absolute 2% max; omitted, behavior is identical to before
 * profiles existed.
 */
export function applyRiskPrefs(envConfig, prefsRisk, profileKey = null) {
  const prefs = normalizeRiskPrefs(prefsRisk);
  const out = { ...envConfig };
  for (const key of Object.keys(RISK_ENV)) {
    if (isPos(prefs[key]) && prefs[key] <= riskOverrideBound(key, envConfig, profileKey)) out[key] = prefs[key];
  }
  return out;
}

/** Loss so far today/this week as a percent of the equity BEFORE that loss, or 0 (no loss). Null only when equity is invalid. */
function drawdownPct(equityUsd, pnlUsd) {
  if (!isPos(equityUsd)) return null;
  if (!isNum(pnlUsd) || pnlUsd >= 0) return 0;
  const baseEquity = equityUsd - pnlUsd; // pnlUsd is negative, so this adds back the loss
  if (!isPos(baseEquity)) return 0;
  return round2((-pnlUsd / baseEquity) * 100);
}

/**
 * @param {Object} input
 * @param {number|null} input.equityUsd - signing wallet equity (see executor.js "equity source")
 * @param {Array<{symbol:string, sizeUsd:number, collateralUsd?:number, unrealizedPnlUsd?:number}>} [input.openPositions]
 * @param {number|null} [input.dailyPnlUsd]
 * @param {number|null} [input.weekPnlUsd]
 * @param {number|null} [input.freeGasSol] - signing wallet's free (non-position) SOL
 * @param {{symbol:string, sizeUsd:number, leverage?:number, entry:number, stop:number}} [input.intent]
 * @param {Object} [input.policy] - readRiskPolicyConfig() output, optionally merged with
 *   applyRiskPrefs(); may also carry `maxSizeCapUsd` / `maxLeverageCap` (the executor's own
 *   env caps) so sizing suggestions respect them too
 * @returns {{ok:boolean, reasons:string[], suggestedSizeUsd:number|null, suggestedLeverage:number|null,
 *   riskUsd:number|null, riskPct:number|null, exposurePct:number|null, symbolExposurePct:number|null,
 *   drawdown:{dayPct:number|null, weekPct:number|null}, notes:string[]}}
 */
export function evaluateRiskPolicy(input = {}) {
  const equityUsd = isPos(input.equityUsd) ? input.equityUsd : null;
  const policy = { ...RISK_DEFAULTS, ...(input.policy || {}) };
  const notes = [];

  if (equityUsd === null) {
    return {
      ok: false, reasons: ['equity_unavailable'], suggestedSizeUsd: null, suggestedLeverage: null,
      riskUsd: null, riskPct: null, exposurePctBefore: null, exposurePct: null, symbolExposurePct: null,
      drawdown: { dayPct: null, weekPct: null }, notes
    };
  }

  const reasons = [];
  const openPositions = Array.isArray(input.openPositions) ? input.openPositions.filter((p) => p && typeof p === 'object') : [];
  const intent = input.intent && typeof input.intent === 'object' ? input.intent : null;
  const newSizeUsd = intent && isPos(intent.sizeUsd) ? intent.sizeUsd : 0;

  if (isNum(input.freeGasSol) && input.freeGasSol < policy.minFreeGasSol) reasons.push('gas_low');

  const dayPct = drawdownPct(equityUsd, input.dailyPnlUsd);
  const weekPct = drawdownPct(equityUsd, input.weekPnlUsd);
  if (dayPct !== null && dayPct > policy.dailyDrawdownPct) reasons.push('daily_drawdown');
  if (weekPct !== null && weekPct > policy.weeklyDrawdownPct) reasons.push('weekly_drawdown');

  const existingExposureUsd = openPositions.reduce((s, p) => s + (isPos(p.sizeUsd) ? p.sizeUsd : 0), 0);
  const exposurePctBefore = round2((existingExposureUsd / equityUsd) * 100);
  const exposurePct = round2(((existingExposureUsd + newSizeUsd) / equityUsd) * 100);
  if (exposurePct > policy.maxExposurePct) reasons.push('exposure_over');

  let symbolExposurePct = null;
  if (intent && typeof intent.symbol === 'string' && intent.symbol) {
    const symbolExistingUsd = openPositions.reduce((s, p) => s + (p.symbol === intent.symbol && isPos(p.sizeUsd) ? p.sizeUsd : 0), 0);
    symbolExposurePct = round2(((symbolExistingUsd + newSizeUsd) / equityUsd) * 100);
    if (symbolExposurePct > policy.maxPerSymbolPct) reasons.push('symbol_exposure_over');
  }

  let riskUsd = null;
  let riskPct = null;
  let suggestedSizeUsd = null;
  let suggestedLeverage = null;
  if (intent && isPos(intent.entry) && isPos(intent.stop)) {
    const stopDistancePct = (Math.abs(intent.entry - intent.stop) / intent.entry) * 100;
    if (stopDistancePct > 0) {
      // Fee-floor (T-9 v2 profile `minStopPct`): only checked when a profile supplies it.
      // Direction is inferred from entry vs. stop -- the same convention checkIntent (T-3)
      // uses -- so this needs no separate `intent.direction` field.
      if (policy.minStopPct && typeof policy.minStopPct === 'object') {
        const direction = intent.stop < intent.entry ? 'long' : intent.stop > intent.entry ? 'short' : null;
        const floor = direction ? policy.minStopPct[direction] : null;
        if (isPos(floor) && stopDistancePct < floor) reasons.push('stop_too_tight');
      }
      riskUsd = round2(newSizeUsd * (stopDistancePct / 100));
      riskPct = round2((riskUsd / equityUsd) * 100);
      if (newSizeUsd > 0 && riskPct > policy.pctPerTrade) reasons.push('risk_pct_over');

      const riskBudgetUsd = (equityUsd * policy.pctPerTrade) / 100;
      const rawSuggestedSize = riskBudgetUsd / (stopDistancePct / 100);
      suggestedSizeUsd = round2(isPos(policy.maxSizeCapUsd) ? Math.min(rawSuggestedSize, policy.maxSizeCapUsd) : rawSuggestedSize);

      const liqCap = maxLeverageForStop(stopDistancePct, ENGINE_CONFIG.risk);
      if (liqCap !== null) {
        const envCap = isPos(policy.maxLeverageCap) ? Math.floor(policy.maxLeverageCap) : Infinity;
        suggestedLeverage = Math.max(1, Math.min(Math.floor(liqCap), envCap));
      }
    } else {
      notes.push('stop_equals_entry');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons: [...new Set(reasons)],
    suggestedSizeUsd, suggestedLeverage, riskUsd, riskPct, exposurePctBefore, exposurePct, symbolExposurePct,
    drawdown: { dayPct, weekPct },
    notes
  };
}

/**
 * One intent evaluated against EVERY profile at once (T-9 v2 P3, parallel tracking): each
 * profile's own config (tiered by `tier`, capped by the caller's own `maxSizeCapUsd` /
 * maxLeverageCap so a comparison never suggests a size the executor would refuse anyway),
 * keyed by profile name. Informational only -- it never gates the real order; only the
 * ACTIVE profile's own `evaluateRiskPolicy` call (via `tieredPolicyConfig`) does that. Used
 * to stamp `order.profiles` / the audit `ticket`/`fill` lines / the journal open record's
 * `execRef.profiles`, and by the website's virtual equity curves.
 * @param {Object} input - the same shape evaluateRiskPolicy takes, minus `policy`
 * @param {{maxSizeCapUsd?:number, maxLeverageCap?:number, tier?:'A'|'B'|'C'}} [opts]
 */
export function evaluateAllProfiles(input = {}, opts = {}) {
  const tier = ['A', 'B', 'C'].includes(opts.tier) ? opts.tier : 'B';
  const out = {};
  for (const key of PROFILE_KEYS) {
    const policy = { ...tieredPolicyConfig(key, tier), maxSizeCapUsd: opts.maxSizeCapUsd, maxLeverageCap: opts.maxLeverageCap };
    const r = evaluateRiskPolicy({ ...input, policy });
    out[key] = {
      tier,
      riskUsd: r.riskUsd,
      riskPct: r.riskPct,
      sizeUsd: r.suggestedSizeUsd,
      leverage: applyLeverageRule(key, tier, r.suggestedLeverage),
      ok: r.ok,
      reasons: r.reasons
    };
  }
  return out;
}

/**
 * Straight-line pace check for a `/risk goal EQUITY by DATE` (T-9 v2 P4): how far current
 * equity is toward the target, minus how far along the goal's own timeline `nowMs` is.
 * Positive = ahead of pace, negative = behind. `null` (never a refusal, descriptive only)
 * when the goal has no baseline yet (`startEquityUsd` / `startAt`, stamped by the caller
 * -- lib/telegram.js `normalizeRiskGoal` -- the moment the goal was set) or the window has
 * zero/negative length.
 */
export function goalAheadFraction(goal, currentEquityUsd, nowMs = Date.now()) {
  if (!goal || typeof goal !== 'object') return null;
  if (!isPos(goal.equityUsd) || !isPos(goal.startEquityUsd) || !isPos(currentEquityUsd)) return null;
  if (typeof goal.startAt !== 'string' || typeof goal.byDate !== 'string') return null;
  const startMs = Date.parse(goal.startAt);
  const endMs = Date.parse(goal.byDate);
  if (!isNum(startMs) || !isNum(endMs) || endMs <= startMs) return null;
  const timeFrac = Math.min(1, Math.max(0, (nowMs - startMs) / (endMs - startMs)));
  const range = goal.equityUsd - goal.startEquityUsd;
  const equityFrac = range !== 0 ? (currentEquityUsd - goal.startEquityUsd) / range : (currentEquityUsd >= goal.equityUsd ? 1 : 0);
  return round2(equityFrac - timeFrac);
}

/**
 * Drawdown caps tightened -- never loosened -- once a goal is >=25% ahead of its own
 * straight-line pace (T-9 v2 P4): both dailyDrawdownPct and weeklyDrawdownPct scaled by
 * (1 - aheadFraction). A null / <0.25 aheadFraction returns `policyConfig` unchanged.
 */
export function applyGoalPaceTightening(policyConfig, aheadFraction) {
  if (!isPos(aheadFraction) || aheadFraction < 0.25) return policyConfig;
  const factor = Math.max(0, 1 - aheadFraction);
  return {
    ...policyConfig,
    dailyDrawdownPct: round2(policyConfig.dailyDrawdownPct * factor),
    weeklyDrawdownPct: round2(policyConfig.weeklyDrawdownPct * factor)
  };
}

export default {
  RISK_ENV, RISK_DEFAULTS, RISK_PCT_PER_TRADE_MAX,
  PROFILE_KEYS, DEFAULT_PROFILE, PROFILES,
  isProfileKey, normalizeProfileKey, profileRiskConfig, tieredPolicyConfig, applyLeverageRule, nextTier, boostMultiplier,
  readRiskPolicyConfig, normalizeRiskPrefs, riskOverrideBound, applyRiskPrefs, evaluateRiskPolicy, evaluateAllProfiles,
  goalAheadFraction, applyGoalPaceTightening
};
