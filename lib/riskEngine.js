/**
 * Risk engine — pure functions relating stop distance, leverage, and position sizing.
 *
 * No provider dependency: every function takes its inputs explicitly and returns a
 * plain object. Nothing here fetches data or reads account/provider state.
 *
 * A position's `liquidationPrice` is always a caller-supplied input (Phase 3b reads it
 * from the perps provider). This module never re-derives a liquidation price from
 * leverage on its own — no live maintenance-margin tier is wired up in this repo, and
 * guessing one would silently misprice a real, already-open position. Where a *new*
 * position's leverage cap is needed (no live position exists yet), `maxLeverageForStop`
 * uses this module's own conservative model, driven entirely by `config/engine.json`'s
 * `risk.liquidationBufferPct` and `risk.maintenanceMarginPct`. `stopHierarchy` reuses
 * that same conservative model for its `recommendedLeverage` suggestion when an existing
 * position's structural invalidation is incompatible with its (real, given) liquidation
 * price — that suggestion is a planning estimate, not a claim about what the venue would
 * actually do if leverage changed.
 */

import { ENGINE_CONFIG } from '../config/engine.js';

/**
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {*} value
 * @param {number} decimals
 * @returns {number|null}
 */
function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function round2(value) {
  return roundN(value, 2);
}

function round4(value) {
  return roundN(value, 4);
}

/**
 * Maximum leverage for a NEW position such that this module's conservative liquidation
 * model places liquidation beyond the given stop distance plus a safety buffer.
 *
 * Model: liquidation distance (fraction) ≈ 1/leverage - maintenanceMarginPct/100. Solve
 * for the largest integer leverage where that modeled distance still exceeds
 * stopDistancePct + liquidationBufferPct (also in percent). This is a planning estimate,
 * not a venue-accurate liquidation formula — see the module header.
 *
 * @param {number} stopDistancePct - distance from entry to stop, in percent (e.g. 3.0 = 3%)
 * @param {Object} [cfg=ENGINE_CONFIG.risk]
 * @returns {number|null} integer leverage, clamped to [1, cfg.maxLeverage], or null on invalid input
 */
export function maxLeverageForStop(stopDistancePct, cfg = ENGINE_CONFIG.risk) {
  if (!isFiniteNumber(stopDistancePct) || stopDistancePct <= 0) return null;
  if (!cfg || !isFiniteNumber(cfg.liquidationBufferPct) || !isFiniteNumber(cfg.maintenanceMarginPct) || !isFiniteNumber(cfg.maxLeverage)) {
    return null;
  }

  const totalPct = stopDistancePct + cfg.liquidationBufferPct + cfg.maintenanceMarginPct;
  if (totalPct <= 0) return null;

  const raw = 100 / totalPct;
  return Math.max(1, Math.min(Math.floor(raw), Math.floor(cfg.maxLeverage)));
}

/**
 * Size a NEW position from available margin, a stop distance, and a requested leverage.
 * Structural stop first, leverage second: the liquidation-safety cap (`maxLeverageForStop`)
 * and the wallet-risk cap both bind before the requested or exchange-max leverage, and
 * whichever binds tightest is reported in `capReason`.
 *
 * @param {Object} params
 * @param {number} params.marginUsd - collateral this position is sized against (notionalUsd = leverage * marginUsd)
 * @param {number} params.stopDistancePct - distance from entry to stop, in percent
 * @param {number} [params.leverageRequested] - defaults to cfg.maxLeverage (the "up to Nx" preference)
 * @param {number} [params.maxWalletRiskPct] - defaults to cfg.maxWalletRiskPct
 * @param {number} [params.walletMarginUsd] - total account margin the wallet-risk cap is measured against;
 *   defaults to `marginUsd` (this position's own collateral) when the caller trades the whole wallet as one
 *   position. When a position uses only part of the wallet as collateral (the common case - see
 *   attachRisk's collateralUsd), pass the full wallet balance here so a fixed collateral size does not
 *   silently loosen the wallet-risk cap.
 * @param {Object} [cfg=ENGINE_CONFIG.risk]
 * @returns {{leverage:number|null, notionalUsd:number|null, lossAtStopUsd:number|null, lossAtStopPct:number|null, capped:boolean, capReason:string|null}}
 */
export function positionPlan(params = {}, cfg = ENGINE_CONFIG.risk) {
  const { marginUsd, stopDistancePct, leverageRequested, maxWalletRiskPct, walletMarginUsd } = params || {};

  if (!isFiniteNumber(marginUsd) || marginUsd <= 0 || !isFiniteNumber(stopDistancePct) || stopDistancePct <= 0) {
    return { leverage: null, notionalUsd: null, lossAtStopUsd: null, lossAtStopPct: null, capped: false, capReason: null };
  }

  const stopFrac = stopDistancePct / 100;
  const requested = isFiniteNumber(leverageRequested) && leverageRequested > 0 ? leverageRequested : cfg.maxLeverage;
  const walletRiskPct = isFiniteNumber(maxWalletRiskPct) && maxWalletRiskPct > 0 ? maxWalletRiskPct : cfg.maxWalletRiskPct;
  const riskBasisUsd = isFiniteNumber(walletMarginUsd) && walletMarginUsd > 0 ? walletMarginUsd : marginUsd;

  const stopCap = maxLeverageForStop(stopDistancePct, cfg) ?? cfg.maxLeverage;
  // Loss at leverage L is L * marginUsd * stopFrac. Capping that to walletRiskPct% of
  // riskBasisUsd (not necessarily the same as marginUsd - see the walletMarginUsd param)
  // gives L <= (walletRiskPct/100 * riskBasisUsd) / (marginUsd * stopFrac).
  const walletRiskCap = Math.max(1, Math.floor(((walletRiskPct / 100) * riskBasisUsd) / (marginUsd * stopFrac)));
  const exchangeCap = Math.floor(cfg.maxLeverage);

  // Priority order only matters when two caps tie: liquidation safety is the more
  // fundamental constraint (governing rule: structural stop first, leverage second),
  // so it wins the reported reason over a wallet-risk tie.
  const ordered = [
    { value: stopCap, reason: 'stop-distance' },
    { value: walletRiskCap, reason: 'wallet-risk' },
    { value: exchangeCap, reason: 'exchange-max' }
  ];

  const flooredRequested = Math.max(1, Math.floor(requested));
  let leverage = flooredRequested;
  let capReason = null;
  for (const candidate of ordered) {
    if (isFiniteNumber(candidate.value) && candidate.value < leverage) {
      leverage = candidate.value;
      capReason = candidate.reason;
    }
  }
  leverage = Math.max(1, leverage);
  const capped = leverage < flooredRequested;

  const notionalUsd = leverage * marginUsd;
  const lossAtStopUsd = notionalUsd * stopFrac;
  const lossAtStopPct = (lossAtStopUsd / marginUsd) * 100;

  return {
    leverage,
    notionalUsd: round2(notionalUsd),
    lossAtStopUsd: round2(lossAtStopUsd),
    lossAtStopPct: round2(lossAtStopPct),
    capped,
    capReason: capped ? capReason : null
  };
}

/**
 * Risk of an EXISTING position against a proposed stop price. `position.liquidationPrice`
 * is a given input (Phase 3b, from the perps provider) — never derived here.
 *
 * `lossAtStopUsd`/`lossAtStopPctOfCollateral` are the raw price-move loss the stop level
 * itself defines; fee/slippage do not inflate them. Execution cost only affects whether
 * the stop is realistically fillable before liquidation (`executable`).
 *
 * @param {{side:'long'|'short', entry:number, notional:number, collateral:number, leverage:number, liquidationPrice:number}} position
 * @param {number} stopPrice - proposed stop price
 * @param {{feeBps?:number, slippageBps?:number}} [opts]
 * @param {Object} [cfg=ENGINE_CONFIG.risk]
 * @returns {{stopDistancePct:number|null, lossAtStopUsd:number|null, lossAtStopPctOfCollateral:number|null, distanceToLiquidationPct:number|null, stopBeforeLiquidation:boolean|null, executable:string|null}}
 */
export function positionRisk(position, stopPrice, opts = {}, cfg = ENGINE_CONFIG.risk) {
  const nullResult = {
    stopDistancePct: null,
    lossAtStopUsd: null,
    lossAtStopPctOfCollateral: null,
    distanceToLiquidationPct: null,
    stopBeforeLiquidation: null,
    executable: null
  };

  const { side, entry, notional, collateral, liquidationPrice } = position || {};
  const isLong = side === 'long';
  const isShort = side === 'short';

  if (!isLong && !isShort) return nullResult;
  if (!isFiniteNumber(entry) || entry <= 0) return nullResult;
  if (!isFiniteNumber(stopPrice) || stopPrice <= 0) return nullResult;
  if (!isFiniteNumber(notional) || notional <= 0) return nullResult;
  if (!isFiniteNumber(collateral) || collateral <= 0) return nullResult;
  if (!isFiniteNumber(liquidationPrice) || liquidationPrice <= 0) return nullResult;

  const feeBps = isFiniteNumber(opts.feeBps) ? opts.feeBps : cfg.feeBps;
  const slippageBps = isFiniteNumber(opts.slippageBps) ? opts.slippageBps : cfg.slippageBps;
  const executionBufferPct = ((isFiniteNumber(feeBps) ? feeBps : 0) + (isFiniteNumber(slippageBps) ? slippageBps : 0)) / 100;

  const stopDistancePct = round4((Math.abs(entry - stopPrice) / entry) * 100);

  const liqOnRightSide = isLong ? liquidationPrice < entry : liquidationPrice > entry;
  const distanceToLiquidationPct = liqOnRightSide
    ? round4((Math.abs(entry - liquidationPrice) / entry) * 100)
    : null;

  const stopBeforeLiquidation = isLong ? stopPrice > liquidationPrice : stopPrice < liquidationPrice;

  const lossAtStopUsd = round2(notional * (stopDistancePct / 100));
  const lossAtStopPctOfCollateral = round2((lossAtStopUsd / collateral) * 100);

  let executable = null;
  if (distanceToLiquidationPct !== null) {
    const room = distanceToLiquidationPct - stopDistancePct;
    executable = stopBeforeLiquidation && room > executionBufferPct ? 'intrabar' : 'gap_risk';
  }

  return {
    stopDistancePct,
    lossAtStopUsd,
    lossAtStopPctOfCollateral,
    distanceToLiquidationPct,
    stopBeforeLiquidation,
    executable
  };
}

/**
 * The absolute price distance (quote currency, e.g. USD) a loss budget allows for an
 * existing position, net of estimated execution cost. Returns null when the budget is
 * fully consumed by fee/slippage or inputs are invalid.
 *
 * @param {{notional:number}} position
 * @param {number} lossBudgetUsd
 * @param {{feeBps?:number, slippageBps?:number}} [opts]
 * @param {Object} [cfg=ENGINE_CONFIG.risk]
 * @returns {number|null}
 */
export function maxStopDistanceForBudget(position, lossBudgetUsd, opts = {}, cfg = ENGINE_CONFIG.risk) {
  const { entry, notional } = position || {};
  if (!isFiniteNumber(entry) || entry <= 0) return null;
  if (!isFiniteNumber(notional) || notional <= 0) return null;
  if (!isFiniteNumber(lossBudgetUsd) || lossBudgetUsd <= 0) return null;

  const feeBps = isFiniteNumber(opts.feeBps) ? opts.feeBps : cfg.feeBps;
  const slippageBps = isFiniteNumber(opts.slippageBps) ? opts.slippageBps : cfg.slippageBps;
  const executionCostUsd = notional * (((isFiniteNumber(feeBps) ? feeBps : 0) + (isFiniteNumber(slippageBps) ? slippageBps : 0)) / 10000);

  const netBudget = lossBudgetUsd - executionCostUsd;
  if (netBudget <= 0) return null;

  return round2(entry * (netBudget / notional));
}

/**
 * Reconcile an existing position's structural (thesis) invalidation against its real,
 * given liquidation price and a loss budget. `thesisInvalidation` is echoed back
 * unchanged — the plan's rule is that the thesis level is never tightened to fit;
 * incompatibility is resolved by recommending a smaller position instead.
 *
 * Compatibility is a liquidation-reachability question first (can the market ever reach
 * the thesis level before this position is forced closed?) and a budget question second.
 * `protectiveStop` is always an executable price before liquidation with fee/slippage
 * allowance — it equals the thesis level only when compatible.
 *
 * @param {{side:'long'|'short', entry:number, notional:number, collateral:number, leverage:number, liquidationPrice:number}} position
 * @param {number} structuralInvalidation - thesis-level price
 * @param {number} [lossBudgetUsd] - defaults to cfg.defaultLossBudgetPctOfCollateral% of position.collateral
 * @param {Object} [cfg=ENGINE_CONFIG.risk]
 * @returns {{protectiveStop:number|null, thesisInvalidation:number|null, compatible:boolean, reason:string|null, recommendedLeverage:number|null, recommendedNotional:number|null}}
 */
export function stopHierarchy(position, structuralInvalidation, lossBudgetUsd, cfg = ENGINE_CONFIG.risk) {
  const { side, entry, notional, collateral, leverage, liquidationPrice } = position || {};
  const isLong = side === 'long';
  const isShort = side === 'short';

  const echoedThesis = isFiniteNumber(structuralInvalidation) ? structuralInvalidation : null;

  if ((!isLong && !isShort) || !isFiniteNumber(entry) || entry <= 0 || !isFiniteNumber(notional) || notional <= 0 ||
      !isFiniteNumber(collateral) || collateral <= 0 || !isFiniteNumber(liquidationPrice) || liquidationPrice <= 0 ||
      echoedThesis === null) {
    return {
      protectiveStop: null,
      thesisInvalidation: echoedThesis,
      compatible: false,
      reason: 'invalid position or invalidation input',
      recommendedLeverage: null,
      recommendedNotional: null
    };
  }

  const liqOnRightSide = isLong ? liquidationPrice < entry : liquidationPrice > entry;
  if (!liqOnRightSide) {
    return {
      protectiveStop: null,
      thesisInvalidation: echoedThesis,
      compatible: false,
      reason: 'liquidation price is not on the expected side of entry',
      recommendedLeverage: null,
      recommendedNotional: null
    };
  }

  const distanceToLiquidationPct = (Math.abs(entry - liquidationPrice) / entry) * 100;
  const maxSafeStopDistancePct = Math.max(0, distanceToLiquidationPct - cfg.liquidationBufferPct);

  const thesisOnRightSide = isLong ? structuralInvalidation < entry : structuralInvalidation > entry;
  const thesisDistancePct = (Math.abs(entry - structuralInvalidation) / entry) * 100;

  const budget = isFiniteNumber(lossBudgetUsd) && lossBudgetUsd > 0
    ? lossBudgetUsd
    : (cfg.defaultLossBudgetPctOfCollateral / 100) * collateral;
  const budgetDistancePct = (budget / notional) * 100;

  const EPS = 1e-9;
  const liquidityOk = thesisOnRightSide && thesisDistancePct <= maxSafeStopDistancePct + EPS;
  const budgetOk = thesisOnRightSide && thesisDistancePct <= budgetDistancePct + EPS;
  const compatible = liquidityOk && budgetOk;

  let protectiveStopDistancePct;
  let reason = null;
  let recommendedLeverage = leverage ?? null;
  let recommendedNotional = notional;

  if (!thesisOnRightSide) {
    reason = 'structural invalidation is on the wrong side of entry';
    protectiveStopDistancePct = Math.min(maxSafeStopDistancePct, budgetDistancePct);
  } else if (compatible) {
    protectiveStopDistancePct = thesisDistancePct;
  } else if (!liquidityOk) {
    reason = `structural invalidation ${round4(thesisDistancePct)}% away exceeds the ${round4(maxSafeStopDistancePct)}% safe distance to liquidation`;
    protectiveStopDistancePct = maxSafeStopDistancePct;
    recommendedLeverage = maxLeverageForStop(thesisDistancePct, cfg);
    recommendedNotional = isFiniteNumber(recommendedLeverage) ? round2(recommendedLeverage * collateral) : null;
  } else {
    reason = `structural invalidation ${round4(thesisDistancePct)}% away exceeds the loss budget (max ${round4(budgetDistancePct)}%)`;
    protectiveStopDistancePct = budgetDistancePct;
    recommendedNotional = round2(budget / (thesisDistancePct / 100));
    recommendedLeverage = isFiniteNumber(recommendedNotional) ? round2(recommendedNotional / collateral) : null;
  }

  const protectiveStop = isLong
    ? round2(entry * (1 - protectiveStopDistancePct / 100))
    : round2(entry * (1 + protectiveStopDistancePct / 100));

  return {
    protectiveStop,
    thesisInvalidation: echoedThesis,
    compatible,
    reason,
    recommendedLeverage: isFiniteNumber(recommendedLeverage) ? recommendedLeverage : null,
    recommendedNotional: isFiniteNumber(recommendedNotional) ? recommendedNotional : null
  };
}

export default {
  maxLeverageForStop,
  positionPlan,
  positionRisk,
  maxStopDistanceForBudget,
  stopHierarchy
};
