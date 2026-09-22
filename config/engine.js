/**
 * Engine configuration loader.
 *
 * `config/engine.json` is the single source of truth for tunable engine constants.
 * This module is the only thing that reads it: everything else imports the frozen
 * object from here, so a constant can never be edited in two places.
 *
 * Why a loader instead of `import engine from './engine.json' with { type: 'json' }`:
 * import attributes are a parse-level feature, so a runtime that does not support
 * them fails the whole module rather than one call. Reading the file through
 * `new URL(..., import.meta.url)` works on every Node version this project can be
 * deployed on, and Vercel's file tracer follows that pattern when bundling, so the
 * JSON ships with the function.
 *
 * The exported object is deep-frozen: config is read-only at runtime. Nothing in
 * the request path may mutate a threshold.
 *
 * `risk` block (phase 3, `lib/riskEngine.js`), one line each:
 *   - liquidationBufferPct (0.05): safety cushion, in percentage points, subtracted from
 *     a position's real distance-to-liquidation before a structural invalidation is
 *     accepted as reachable (stopHierarchy). Small on purpose - it is not the venue's
 *     maintenance margin, just a guard against rounding/latency at the boundary.
 *   - maintenanceMarginPct (0.3): conservative flat estimate used only by this module's
 *     own leverage-cap model for a NEW position (maxLeverageForStop). No live per-asset
 *     maintenance-margin tier exists in this repo; an existing position's real
 *     liquidation price is always a given input (Phase 3b), never derived from this.
 *   - maxWalletRiskPct (2): most of margin, in percent, positionPlan will size a new
 *     position to lose at its own stop - a standard 1-2% per-trade risk-of-ruin cap.
 *   - defaultMarginUsd (10): the "~$10, up to 100x" preference. `attachRisk`
 *     (services/scalpContext.js) sizes every position against
 *     min(defaultMarginUsd, account.margin.usd) - a slice of the wallet, never the
 *     whole balance - and publishes that as `risk.collateralUsd`.
 *   - maxLeverage (100): exchange/UI leverage ceiling; the hard cap every plan respects.
 *   - feeBps (5): one-sided taker-fee estimate in basis points; no live fee schedule is
 *     wired up, so this is a round conservative default.
 *   - slippageBps (5): execution-slippage estimate in basis points for a stop-market
 *     fill; same reasoning as feeBps.
 *   - defaultLossBudgetPctOfCollateral (5): fallback risk budget, percent of a position's
 *     own collateral, used by stopHierarchy when the caller supplies no lossBudgetUsd.
 */

import { readFileSync } from 'node:fs';

/**
 * Recursively freeze an object and everything it holds.
 * @param {*} value
 * @returns {*} the same value, frozen
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const raw = JSON.parse(readFileSync(new URL('./engine.json', import.meta.url), 'utf8'));

/** @type {Object} frozen engine configuration */
export const ENGINE_CONFIG = deepFreeze(raw);

/** @type {string} version stamped into every payload for reproducibility */
export const CONFIG_VERSION = ENGINE_CONFIG.configVersion;

/**
 * R:R multiples for a setup type, as used by calculateSLTP's callers.
 * @param {string} setupType - 'Swing', 'Scalp', or anything else (TREND_4H/4h)
 * @returns {Array<number>}
 */
export function rrForSetupType(setupType) {
  const table = ENGINE_CONFIG.riskReward.bySetupType;
  return table[setupType] || table.default;
}

/**
 * R:R multiples for a named strategy.
 * @param {string} strategyName - SCALP_1H, TREND_RIDER, MICRO_SCALP
 * @returns {Array<number>}
 */
export function rrForStrategy(strategyName) {
  return ENGINE_CONFIG.riskReward.byStrategy[strategyName] || ENGINE_CONFIG.riskReward.default;
}

export default ENGINE_CONFIG;
