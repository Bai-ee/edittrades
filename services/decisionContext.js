/**
 * Decision Context
 * ----------------
 * The single deterministic object the whole desk agrees on, assembled from the
 * five layers in order:
 *
 *   MARKET DATA -> TECHNICAL SETUP -> BTC MACRO -> RISK -> AI INTERPRETATION
 *
 * Its job is provenance and separation. Each layer contributes its own block
 * and nothing else, so a consumer can always answer "where did this number
 * come from, and was the layer that produced it actually working?"
 *
 * Two invariants:
 *
 *  1. Every block carries its own availability. A layer that could not run
 *     produces `{ available: false, reason }`, never a plausible default. The
 *     absence of a risk block means risk was not evaluated — it does not mean
 *     risk is zero.
 *  2. The AI block is OUTPUT ONLY. It is populated after the deterministic
 *     layers are complete and contributes nothing back to them. Nothing in
 *     this module lets a model-produced value enter a numeric field.
 *
 * This is a builder, not a fetcher: it does no I/O. Callers pass in what each
 * layer produced, which keeps it pure and testable and means it cannot become
 * a second, competing source of market data.
 */

import { getProvenance, FRESHNESS } from './dataProvenance.js';
import { buildSystemHealth } from './systemHealth.js';

/** Layer 1 — what is actually happening in the market. */
export function buildMarketBlock({ symbol, ticker = null, candlesByInterval = {} } = {}) {
  if (!ticker || !Number.isFinite(ticker.price)) {
    return {
      available: false,
      reason: 'No live price available from any provider',
      asset: symbol ?? null,
      price: null,
      source: null,
      freshness: FRESHNESS.UNAVAILABLE
    };
  }

  const timeframes = {};
  for (const [interval, candles] of Object.entries(candlesByInterval)) {
    const prov = Array.isArray(candles) ? getProvenance(candles) : null;
    timeframes[interval] = prov
      ? {
          bars: candles.length,
          source: prov.source,
          freshness: prov.freshness,
          ageSeconds: prov.ageSeconds,
          lastBarAgeSeconds: prov.lastBarAgeSeconds,
          derivedFrom: prov.derivedFrom
        }
      : { bars: 0, source: null, freshness: FRESHNESS.UNAVAILABLE };
  }

  return {
    available: true,
    asset: symbol ?? null,
    price: ticker.price,
    priceChangePercent: ticker.priceChangePercent ?? null,
    source: ticker.provenance?.source ?? null,
    freshness: ticker.provenance?.freshness ?? FRESHNESS.UNAVAILABLE,
    fetchedAt: ticker.provenance?.fetchedAt ?? null,
    timeframes
  };
}

/** Layer 2 — does the deterministic strategy see a valid setup? */
export function buildSetupBlock(strategyResult) {
  const signal = strategyResult?.signal;
  if (!signal) {
    return { available: false, reason: 'Strategy engine produced no signal' };
  }

  const targets = Array.isArray(signal.targets) ? signal.targets : [];
  return {
    available: true,
    valid: signal.valid === true,
    direction: signal.direction ?? null,
    strategy: signal.selectedStrategy ?? null,
    score: Number.isFinite(signal.confidence) ? signal.confidence : null,
    entryZone: signal.entryZone ?? null,
    stop: signal.stopLoss ?? null,
    targets: { tp1: targets[0] ?? null, tp2: targets[1] ?? null },
    reason: signal.reason ?? null,
    htfBias: strategyResult.htfBias ?? null
  };
}

/**
 * Layer 3 — the long-duration Bitcoin valuation environment.
 *
 * `bias` is deliberately coarse and is NOT a trade instruction. Economic Value
 * is a valuation context, not a trigger; the brief forbids turning it into one,
 * and nothing downstream may treat this field as a signal.
 */
export function buildMacroBlock({ current = null, meta = null, health = null } = {}) {
  if (!current) {
    return { available: false, reason: 'Bitcoin Economic Value unavailable' };
  }

  const anchorsUsed = current.weightsApplied ? Object.keys(current.weightsApplied).length : null;

  return {
    available: true,
    state: current.state ?? null,
    economicValue: current.economicValue ?? null,
    premium: current.premiumDiscount ?? null,
    percentile: current.percentile ?? null,
    // Context only. Never a buy or sell instruction.
    bias: current.state === 'EUPHORIC' || current.state === 'EXTENDED'
      ? 'CAUTION_EXTENDED'
      : current.state === 'DEEP DISCOUNT' || current.state === 'DISCOUNT'
        ? 'SUPPORTIVE'
        : 'NEUTRAL',
    anchorsUsed,
    // Surfaced so no consumer can mistake a renormalised composite for the
    // full model — the failure mode that otherwise looks identical.
    degraded: health?.status === 'DEGRADED' || (anchorsUsed !== null && anchorsUsed < 3),
    convergence: current.convergence ?? null,
    dataFetchedAt: meta?.dataFetchedAt ?? null,
    stale: meta?.stale === true
  };
}

/** Layer 4 — how much should actually be risked, given the book. */
export function buildRiskBlock(plan) {
  if (!plan) {
    return {
      available: false,
      // The distinction the brief requires: analysis may continue, but the UI
      // and the AI must both say sizing was not evaluated.
      reason: 'Risk Manager did not evaluate this trade; position sizing was not assessed'
    };
  }

  return {
    available: true,
    wallet: plan.walletBalance ?? null,
    riskPct: plan.trade?.riskPct ?? null,
    riskUsd: plan.trade?.riskAmount ?? null,
    positionNotional: plan.trade?.notional ?? null,
    leverage: plan.trade?.leverage ?? null,
    margin: plan.trade?.margin ?? null,
    marginMode: plan.trade?.marginMode ?? null,
    stopDistancePct: plan.trade?.stopDistancePct ?? null,
    plannedLossUsd: plan.trade?.lossAtStop ?? null,
    riskReward: plan.riskReward?.available ? plan.riskReward.ratio ?? plan.riskReward.label ?? null : null,
    totalOpenRiskPct: plan.portfolio?.after?.openRiskPct ?? null,
    exposurePct: plan.exposure?.after?.notionalExposurePct ?? null,
    concentration: plan.concentration?.label ?? null,
    liquidation: plan.liquidation?.available
      ? { price: plan.liquidation.price, isEstimate: true, marginMode: plan.liquidation.assumptions?.marginMode }
      : { price: null, isEstimate: false, reason: plan.liquidation?.reason ?? 'Not available' },
    policyState: plan.status ?? null,
    warnings: (plan.evaluation?.checks || [])
      .filter((c) => c.state === 'fail' || c.state === 'warn')
      .map((c) => `${c.label}: ${c.detail}`)
  };
}

/**
 * Assemble the full decision context.
 *
 * Order matters and is the workflow: market data first because everything
 * above it is worthless without it, AI last because it only reads.
 */
export function buildDecisionContext({
  symbol,
  market,
  setup,
  macro,
  risk,
  health,
  ai = null
} = {}) {
  const context = {
    asset: symbol ?? null,
    generatedAt: new Date().toISOString(),
    market: market || { available: false, reason: 'Not evaluated' },
    setup: setup || { available: false, reason: 'Not evaluated' },
    macro: macro || { available: false, reason: 'Not evaluated' },
    risk: risk || { available: false, reason: 'Not evaluated' },
    ...(health || buildSystemHealth({})),
    // Populated only after everything above. Never read by a deterministic
    // layer; present here so the response carries one object, not two.
    ai: ai || { available: false, reason: 'No AI commentary generated' }
  };

  // A single flag consumers can gate a confident presentation on. If market
  // data is unavailable, no amount of setup or macro detail makes the read
  // trustworthy, and the UI should not render it as though it does.
  context.decisionReady =
    context.market.available === true &&
    context.setup.available === true &&
    context.systemHealth?.marketData !== 'FAILED';

  return context;
}

/**
 * The subset handed to the AI layer, plus the health block the data contract
 * requires it to acknowledge.
 *
 * Built explicitly rather than by spreading the whole context, so a field
 * cannot start reaching the model just because someone added it upstream.
 */
export function toAIPayload(context) {
  return {
    payload: {
      asset: context.asset,
      market: context.market,
      setup: context.setup,
      macro: context.macro,
      risk: context.risk
    },
    dataHealth: context.systemHealth,
    requiredPaths: [
      'market.price',
      'market.freshness',
      'setup.direction',
      'setup.score',
      'setup.stop',
      'macro.state',
      'macro.premium',
      'risk.riskUsd',
      'risk.positionNotional',
      'risk.totalOpenRiskPct'
    ]
  };
}

export default {
  buildMarketBlock,
  buildSetupBlock,
  buildMacroBlock,
  buildRiskBlock,
  buildDecisionContext,
  toAIPayload
};
