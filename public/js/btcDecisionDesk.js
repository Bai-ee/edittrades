/**
 * BTC Decision Desk — should we show a trade recommendation right now?
 *
 * One question, one answer, and a reason code either way.
 *
 * WHY THIS LIVES IN THE BROWSER: the Vercel Hobby plan caps a deployment at 12
 * Serverless Functions and `vercel.json` already declares exactly 12. There is
 * no room for a new endpoint. This module runs client-side on the payload the
 * existing `/api/analyze-full` already returns, plus the account state the Risk
 * Manager already computes, so it adds no function and no network call.
 *
 * NON-NEGOTIABLES, in the same spirit as adaptiveRisk.js:
 *
 *   - PURE. No network, no clock, no randomness. `now` is always a parameter.
 *     Same inputs -> same output, forever.
 *   - DECISION SUPPORT. Nothing here places, modifies or closes a trade.
 *   - FAIL CLOSED. Anything unknown, missing or stale means NO POPUP. A trade
 *     card is a recommendation to risk money; absence of evidence is never
 *     permission.
 *   - EXPLAINS ITSELF. Every no-popup answer carries a machine-readable reason,
 *     so "why did nothing appear?" is answerable without a debugger.
 */

import { recommendTrade } from './adaptiveRisk.js';

/**
 * Why no card was shown. Surfaced in diagnostics, not to the user by default.
 */
export const NO_POPUP_REASON = Object.freeze({
  NO_CANDIDATE: 'NO_CANDIDATE',
  STALE_MARKET_DATA: 'STALE_MARKET_DATA',
  INCOMPLETE_MARKET_DATA: 'INCOMPLETE_MARKET_DATA',
  BELOW_QUALITY_FLOOR: 'BELOW_QUALITY_FLOOR',
  BELOW_DYNAMIC_THRESHOLD: 'BELOW_DYNAMIC_THRESHOLD',
  ADAPTIVE_RISK_NO_TRADE: 'ADAPTIVE_RISK_NO_TRADE',
  ACTIVE_BTC_TRADE: 'ACTIVE_BTC_TRADE',
  DUPLICATE_RECOMMENDATION: 'DUPLICATE_RECOMMENDATION',
  DISMISSED: 'DISMISSED'
});

/**
 * The absolute minimum confidence for a card. Frozen, and deliberately NOT a
 * parameter and NOT mode-dependent.
 *
 * Adaptive behaviour may make the bar HIGHER (see calculateDynamicThreshold).
 * Nothing may make it lower. That asymmetry is the whole point: a system that
 * can relax its own standards will eventually relax them at the worst moment.
 *
 * 60 matches the admission gate the strategy engine already applies in
 * STANDARD mode, so this floor does not invent a new standard — it stops the
 * existing one being negotiated away.
 */
export const ABSOLUTE_MIN_CONFIDENCE = 60;

/**
 * How stale a timeframe's newest bar may be before we refuse to trade on it,
 * as a multiple of that timeframe's own bar length.
 *
 * 1.25 bars allows for ordinary publication latency while still noticing a
 * missing bar. Two bars — the repo's existing staleness label — is too loose
 * here: it means the PREVIOUS bar can be absent entirely and still read fresh,
 * which on 4h is an eight-hour blind spot.
 */
export const MAX_BAR_AGE_MULTIPLE = 1.25;

/** Bar length in milliseconds, for the timeframes this desk requires. */
const BAR_MS = Object.freeze({
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000
});

/**
 * Timeframes the engine hard-requires to produce a BTC signal at all.
 * If any is missing or stale there is nothing to show.
 */
export const REQUIRED_TIMEFRAMES = Object.freeze(['4h', '1h']);

/**
 * Deterministic tie-break order when two setups score the same.
 *
 * Longer timeframes first: they are slower to invalidate and cheaper to be
 * wrong about. This is a stable ordering, not a claim that SWING is better
 * than MICRO_SCALP — no backtest in this repo has yet compared them.
 */
const STRATEGY_PRIORITY = Object.freeze([
  'SWING',
  'TREND_4H',
  'TREND_RIDER',
  'SCALP_1H',
  'MICRO_SCALP'
]);

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function toTime(value) {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Every reason the market data is not good enough to trade on.
 * Returns an array so a caller can show all of them, not just the first.
 */
export function checkMarketData({ analysis, now }) {
  const problems = [];
  const timeframes = (analysis && analysis.timeframes) || {};

  for (const tf of REQUIRED_TIMEFRAMES) {
    const block = timeframes[tf];
    if (!block || !block.indicators) {
      problems.push({ code: NO_POPUP_REASON.INCOMPLETE_MARKET_DATA, timeframe: tf, detail: 'no data' });
      continue;
    }

    // A provider can answer instantly with a series that stopped updating
    // hours ago, so the age that matters is the newest BAR's, not the call's.
    const lastBarOpen = toTime(block.indicators.metadata && block.indicators.metadata.lastBarOpenTime);
    if (lastBarOpen === null) {
      problems.push({ code: NO_POPUP_REASON.INCOMPLETE_MARKET_DATA, timeframe: tf, detail: 'no bar timestamp' });
      continue;
    }

    const budget = BAR_MS[tf] * MAX_BAR_AGE_MULTIPLE;
    const age = now - lastBarOpen;
    if (age > budget) {
      problems.push({
        code: NO_POPUP_REASON.STALE_MARKET_DATA,
        timeframe: tf,
        detail: `newest bar is ${Math.round(age / 60000)}m old, budget ${Math.round(budget / 60000)}m`
      });
    }
  }

  return problems;
}

/**
 * The confidence a setup must clear right now.
 *
 * Starts at the absolute floor and only ever RISES. Each condition below is a
 * reason to be more demanding than usual; there is no branch that subtracts.
 */
export function calculateDynamicThreshold({ volatilityState = null, drawdownPct = 0, missingLayers = [] } = {}) {
  let threshold = ABSOLUTE_MIN_CONFIDENCE;
  const raisedBy = [];

  // A violent tape widens stops and thins liquidity; the same nominal setup is
  // worth less than it is in a calm one.
  if (volatilityState === 'HIGH') {
    threshold += 5;
    raisedBy.push('high volatility (+5)');
  } else if (volatilityState === 'EXTREME') {
    threshold += 10;
    raisedBy.push('extreme volatility (+10)');
  }

  // Drawdown is a fact about capital, not an opinion about the market. Deeper
  // drawdown means fewer, better trades.
  if (drawdownPct >= 15) {
    threshold += 10;
    raisedBy.push('drawdown over 15% (+10)');
  } else if (drawdownPct >= 8) {
    threshold += 5;
    raisedBy.push('drawdown over 8% (+5)');
  }

  // Any missing evidence layer already costs the setup points inside the
  // confidence model. Raising the bar as well is deliberate: a degraded
  // reading should have to be clearly good, not marginally good.
  if (missingLayers.length > 0) {
    threshold += 5;
    raisedBy.push(`degraded inputs: ${missingLayers.join(', ')} (+5)`);
  }

  return { threshold, raisedBy, floor: ABSOLUTE_MIN_CONFIDENCE };
}

/**
 * Pick the single setup to show, from whatever the engine returned.
 *
 * Deterministic by construction: confidence first, then the fixed priority
 * order, then the name. Never random, never "whichever came back first".
 */
export function rankCandidates(strategies = {}) {
  return Object.entries(strategies)
    .filter(([, s]) => s && s.valid === true && isFiniteNumber(s.confidence))
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const ai = STRATEGY_PRIORITY.indexOf(a.name);
      const bi = STRATEGY_PRIORITY.indexOf(b.name);
      if (ai !== bi) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return a.name.localeCompare(b.name);
    });
}

/**
 * A stable identity for one recommendation.
 *
 * Two evaluations describing the same trade must produce the same id, or a
 * dismissed card reappears on every refresh. Prices are bucketed to whole
 * dollars for the same reason — a one-cent drift in the entry zone is not a
 * new recommendation.
 */
export function recommendationId(candidate, strategyVersion) {
  const entry = candidate.entryZone ? Math.round((candidate.entryZone.min + candidate.entryZone.max) / 2) : 0;
  const stop = Math.round(candidate.stopLoss || 0);
  return `BTC-${candidate.name}-${candidate.direction}-${entry}-${stop}-${strategyVersion || 'v0'}`;
}

/**
 * Should a card be shown, and if so which trade?
 *
 * @param {Object}   input
 * @param {Object}   input.analysis     `/api/analyze-full` payload for BTC
 * @param {Object}   input.account      account shape adaptiveRisk.recommendTrade expects
 * @param {number}   input.now          epoch ms — always supplied, never read from the clock
 * @param {string[]} [input.dismissedIds]     recommendation ids the user dismissed
 * @param {boolean}  [input.hasActiveBtcTrade] true when a BTC position is already open
 * @param {Object}   [input.marketVolatility]  { atrPercentile, volatilityState, timeframe }
 * @param {boolean}  [input.aggressiveAllowed] user preference; false forbids AGGRESSIVE outright
 *
 * @returns {{show: boolean, reason: string|null, recommendation: Object|null, diagnostics: Object}}
 */
export function decideBtcTrade({
  analysis,
  account,
  now,
  dismissedIds = [],
  hasActiveBtcTrade = false,
  marketVolatility = null,
  aggressiveAllowed = false
} = {}) {
  const diagnostics = { checkedAt: now, dataProblems: [], candidates: [], threshold: null };

  const stop = (reason) => ({ show: false, reason, recommendation: null, diagnostics });

  // A null account must fail closed, not throw. recommendTrade only defaults
  // its argument when it is `undefined`, so `null` would reach the wallet read
  // and crash — and a crash in the caller's render path is indistinguishable
  // from "no trade today", which is exactly the ambiguity this module exists
  // to remove. An empty object reaches the engine's own INCOMPLETE branch.
  const safeAccount = account || {};

  // 1. Never compete with a position the user already has on.
  if (hasActiveBtcTrade) return stop(NO_POPUP_REASON.ACTIVE_BTC_TRADE);

  // 2. Data integrity, before anything is scored.
  const dataProblems = checkMarketData({ analysis, now });
  diagnostics.dataProblems = dataProblems;
  if (dataProblems.length > 0) return stop(dataProblems[0].code);

  // 3. Candidates.
  const ranked = rankCandidates(analysis && analysis.strategies);
  diagnostics.candidates = ranked.map((c) => ({ name: c.name, direction: c.direction, confidence: c.confidence }));
  if (ranked.length === 0) return stop(NO_POPUP_REASON.NO_CANDIDATE);

  const best = ranked[0];

  // 4. Quality bar. The floor is checked separately from the dynamic threshold
  //    so diagnostics can distinguish "nowhere near" from "close but not today".
  if (best.confidence < ABSOLUTE_MIN_CONFIDENCE) return stop(NO_POPUP_REASON.BELOW_QUALITY_FLOOR);

  const missingLayers = (best.confidenceFactors || [])
    .filter((f) => f.points === 0 && /contributes nothing/.test(f.detail || ''))
    .map((f) => f.code);

  const dynamic = calculateDynamicThreshold({
    volatilityState: marketVolatility && marketVolatility.volatilityState,
    drawdownPct: safeAccount.currentDrawdownPct || 0,
    missingLayers
  });
  diagnostics.threshold = dynamic;

  if (best.confidence < dynamic.threshold) return stop(NO_POPUP_REASON.BELOW_DYNAMIC_THRESHOLD);

  // 5. Deduplicate before sizing — no point asking the risk engine about a card
  //    the user has already dismissed.
  const id = recommendationId(best, analysis && analysis.meta && analysis.meta.strategyVersion);
  diagnostics.recommendationId = id;
  if (dismissedIds.includes(id)) return stop(NO_POPUP_REASON.DISMISSED);

  // 6. How much has this account earned the right to risk?
  //
  //    The engine chooses the strategy preset; the user is never asked
  //    "STANDARD or AGGRESSIVE?" per card. AGGRESSIVE is only ever AVAILABLE,
  //    never automatic — it additionally requires the setup to be well clear of
  //    the bar rather than scraping past it.
  const preset = aggressiveAllowed && best.confidence >= dynamic.threshold + 15 ? 'AGGRESSIVE' : 'STANDARD';

  const entryMid = best.entryZone ? (best.entryZone.min + best.entryZone.max) / 2 : null;

  const sizing = recommendTrade({
    account: safeAccount,
    request: {
      asset: 'BTC',
      strategy: preset,
      confidence: best.confidence,
      entry: entryMid,
      stop: best.stopLoss,
      direction: best.direction,
      marketVolatility,
      now
    }
  });
  diagnostics.sizing = { decision: sizing.decision, blockers: sizing.blockers };

  if (sizing.decision !== 'TRADE') return stop(NO_POPUP_REASON.ADAPTIVE_RISK_NO_TRADE);

  // 7. Show the card.
  return {
    show: true,
    reason: null,
    diagnostics,
    recommendation: {
      recommendationId: id,
      recommendedAt: now,
      asset: 'BTC',
      symbol: 'BTCUSDT',
      strategy: best.name,
      strategyPreset: preset,
      direction: best.direction,

      confidence: best.confidence,
      confidenceFactors: best.confidenceFactors || [],
      threshold: dynamic,

      entryZone: best.entryZone,
      entry: entryMid,
      stopLoss: best.stopLoss,
      targets: best.targets || [],
      invalidationLevel: best.invalidationLevel,

      // Straight from the risk engine — this module never sizes anything itself.
      position: sizing.position,
      maxLoss: sizing.maxLoss,
      level: sizing.level,
      sizingFactors: sizing.factors || [],
      warnings: sizing.warnings || [],

      marketVolatility,
      strategyVersion: (analysis && analysis.meta && analysis.meta.strategyVersion) || null,
      riskStrategyVersion: sizing.strategyVersion,
      inputsHash: sizing.inputsHash
    }
  };
}

export default {
  NO_POPUP_REASON,
  ABSOLUTE_MIN_CONFIDENCE,
  MAX_BAR_AGE_MULTIPLE,
  REQUIRED_TIMEFRAMES,
  checkMarketData,
  calculateDynamicThreshold,
  rankCandidates,
  recommendationId,
  decideBtcTrade
};
