/**
 * EditTrades call tracker - fee/slippage cost model (T5 S1,
 * docs/PLAN_DIVERGENCE_OPPORTUNITIES.md "S1 - Net R on the tracker").
 *
 * Shared by aggregate.js (net R on scored ready-plan / rec rows), shadow.js (net R on
 * shadow/retest legs), and vb-shadow.js. The tracker repo carries no config/ checkout, so
 * FEE_BPS/SLIPPAGE_BPS/COST_BPS_BY_DIRECTION below are hard-coded copies of THIS repo's
 * config/engine.json risk.feeBps / risk.slippageBps / risk.costBpsByDirection -
 * test-tracker.js asserts they still match; if that file ever changes these values, the
 * test starts failing as the signal to update them here. Same pattern shadow.js's own
 * SHADOW_CFG and scripts/tracker/breakout-entry.js's vendored `netRiskReward` already use
 * to stay in step with lib/flagTradePlan.js.
 *
 * Cost model mirrors lib/flagTradePlan.js's exported `netRiskReward`/`costRFraction`
 * (T6 completion plan C1, D-cost decision, `docs/OWNER_DECISIONS_2026-09-24.md`):
 * direction-dependent when a caller passes `direction` and it is `'long'`/`'short'` -
 * `COST_BPS_BY_DIRECTION[direction] / 10000 * entry` (already round-trip, positions are
 * funded from USDC/USDT so a long pays the extra swap in/out) - else the legacy flat
 * `2 * (FEE_BPS + SLIPPAGE_BPS) / 10000 * entry`. `netRiskReward` charges that cost amount
 * against the gross risk/reward *prices* to get a planned net RR ratio (inflates the risk,
 * deflates the reward, before the trade happens). This module expresses the SAME cost
 * amount in R units instead (`cost / |entry - stop|`), then subtracts it once from a row's
 * already-realised gross R - the tracker scores REALISED outcomes (a resolved -1R stop or
 * a resolved +rR tp1), not a forward-looking ratio, so here cost is charged once in R terms
 * rather than inflating both sides of a ratio. Pure: no fs, no network, no env.
 */

export const FEE_BPS = 5;
export const SLIPPAGE_BPS = 5;
export const COST_BPS_BY_DIRECTION = Object.freeze({ long: 34, short: 14 });

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundTripCostPctFor(direction) {
  const dirBps = (direction === 'long' || direction === 'short') ? COST_BPS_BY_DIRECTION[direction] : null;
  return dirBps !== null ? dirBps / 10000 : (2 * (FEE_BPS + SLIPPAGE_BPS)) / 10000;
}

/**
 * Round-trip cost, in R (a fraction of the row's own gross stop distance):
 * `roundTripCostPctFor(direction) * entry / |entry - stop|` - the same cost amount
 * `netRiskReward` computes in price terms, expressed here as a fraction of gross risk.
 * @param {number} entry
 * @param {number} stop
 * @param {'long'|'short'|null|undefined} [direction] - omit for the legacy flat cost
 * @returns {number|null}
 */
export function costR(entry, stop, direction) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || entry <= 0) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return roundTripCostPctFor(direction) * entry / risk;
}

/**
 * Net R for one already-scored leg: a stop (`grossR = -1`) nets `-1 - cost`; a tp1
 * (`grossR = r`) nets `r - cost`. Same subtraction either way - `grossR - costR(entry, stop, direction)`.
 * @param {number} entry
 * @param {number} stop
 * @param {number} grossR - -1 for a stop leg, the walked R for a tp1 leg
 * @param {'long'|'short'|null|undefined} [direction] - omit for the legacy flat cost
 * @returns {number|null}
 */
export function netR(entry, stop, grossR, direction) {
  if (!isFiniteNumber(grossR)) return null;
  const cost = costR(entry, stop, direction);
  return cost === null ? null : grossR - cost;
}

export default { FEE_BPS, SLIPPAGE_BPS, COST_BPS_BY_DIRECTION, costR, netR };
