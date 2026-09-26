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
 * `pctPerTrade` additionally never above RISK_PCT_PER_TRADE_MAX.
 */
export function riskOverrideBound(key, envConfig) {
  const cap = envConfig && isPos(envConfig[key]) ? envConfig[key] : RISK_DEFAULTS[key];
  return key === 'pctPerTrade' ? Math.min(cap, RISK_PCT_PER_TRADE_MAX) : cap;
}

/** envConfig with any in-bound prefs overrides applied (out-of-bound / invalid ones ignored). */
export function applyRiskPrefs(envConfig, prefsRisk) {
  const prefs = normalizeRiskPrefs(prefsRisk);
  const out = { ...envConfig };
  for (const key of Object.keys(RISK_ENV)) {
    if (isPos(prefs[key]) && prefs[key] <= riskOverrideBound(key, envConfig)) out[key] = prefs[key];
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

export default {
  RISK_ENV, RISK_DEFAULTS, RISK_PCT_PER_TRADE_MAX,
  readRiskPolicyConfig, normalizeRiskPrefs, riskOverrideBound, applyRiskPrefs, evaluateRiskPolicy
};
