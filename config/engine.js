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
 *
 * `flag` block (phase 4, `lib/patternDetector.js`), one line each:
 *   - includeFailed (false, phase 5): whether `candidateSetups[]` publishes `state:
 *     failed` entries. `decisionTrace.candidateSetups` always keeps them regardless -
 *     see `filterFailedCandidateSetups` in services/scalpContext.js.
 *   - timeframes (1m, 3m, 5m): where the detector runs; the plan's scalp timeframes.
 *   - atrPeriod (14): Wilder's standard ATR length, the unit for impulse and chase.
 *   - minImpulseAtr (2.0): an impulse must span at least 2 ATR to be a pole, not noise.
 *   - maxImpulseCandles (8): the pole is a burst; 8 bars is ~8 min on 1m, ~40 min on 5m.
 *   - maxContractionRatio (0.5): flag range at most half the pole - a flag, not a range.
 *   - minCandles (3): fewer than 3 bars is a pause, not a consolidation.
 *   - maxFlagCandles (12): longer than 12 bars on a scalp timeframe is a new range.
 *   - wickTolerancePct (0.02): EMA21 band, percent of price; ~a third to half of a BTC
 *     1m ATR, so a touch counts as a hold but a real poke through counts as a wick.
 *   - acceptanceCloses (2): two consecutive closes through EMA21 = acceptance, one = wick.
 *   - confirmCloses (2): a break is confirmed on its second close past the level.
 *   - maxBreakoutAge (5): a break older than 5 bars is history, not a setup.
 *   - chaseAtr (1.5): last close more than 1.5 ATR past the breakout = chasing.
 *   - confidence.impulseFullAtr (4.0): impulse score saturates at 4 ATR.
 *   - confidence.weights: impulse 0.3, compression 0.25, ema21 0.3, stoch 0.15 (sum 1);
 *     structure first, Stoch RSI slope as a tiebreaker.
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
