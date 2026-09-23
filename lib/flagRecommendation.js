import { ENGINE_CONFIG } from '../config/engine.js';
import { assessFreshness } from './freshness.js';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function ref(path, timeframe = null, source = 'engine') {
  return { source, timeframe, field: path };
}

function factor(code, state, explanation, refs = [], sign = 'neutral') {
  return { code, state, explanation, refs, sign };
}

function reason(code, text, refs = []) {
  return { code, text, refs };
}

function directionSentiment(direction) {
  return direction === 'short' ? 'bear' : 'bull';
}

function oppositeDirection(direction) {
  return direction === 'short' ? 'bullish' : 'bearish';
}

function qualityBand(points) {
  if (points >= 75) return 'high';
  if (points >= 50) return 'medium';
  return 'low';
}

function scoreContext({ plan, evidence, cfg = ENGINE_CONFIG.model }) {
  const weights = cfg.decisionWeights || {};
  let points = 0;
  const contributions = [];
  const add = (code, value, max) => {
    const pts = Math.max(0, Math.min(max, value));
    points += pts;
    contributions.push({ code, points: pts, max });
  };

  add('readiness', plan && plan.status === 'ready' ? (weights.readiness ?? 35) : 0, weights.readiness ?? 35);
  const flag = (evidence.flags || []).find((f) => f.candidateId === (plan && plan.candidateId));
  add('pattern', flag && isFiniteNumber(flag.confidence) ? ((flag.confidence / 100) * (weights.pattern ?? 20)) : 0, weights.pattern ?? 20);

  const td = evidence.topDown || null;
  const withSentiment = td && plan ? td.sentiment === directionSentiment(plan.direction) : false;
  add('top_down', withSentiment ? (weights.topDown ?? 15) : (td && td.sentiment === 'mixed' ? (weights.topDown ?? 15) * 0.5 : 0), weights.topDown ?? 15);

  const maItem = plan && evidence.ma && evidence.ma.map ? evidence.ma.map[plan.timeframe] : null;
  const maOk = maItem && ((plan.direction === 'long' && maItem.priceVsEma21 !== 'below') || (plan.direction === 'short' && maItem.priceVsEma21 !== 'above'));
  add('ema21_context', maOk ? (weights.maContext ?? 10) : 0, weights.maContext ?? 10);

  const channelRisk = evidence.channels && evidence.channels.nearestLevelAhead ? 0.8 : 0.5;
  add('channel_room', channelRisk * (weights.channel ?? 10), weights.channel ?? 10);

  const div = evidence.divergence && evidence.divergence.confluence ? evidence.divergence.confluence : {};
  const divCount = plan && plan.direction === 'short' ? div.bearish : div.bullish;
  add('divergence', Math.min(1, (divCount || 0) / 2) * (weights.divergence ?? 10), weights.divergence ?? 10);

  return { points: Math.round(points), contributions };
}

function evidenceForRecommendation(rawEvidence, topDown) {
  return { ...(rawEvidence || {}), topDown };
}

export function buildFlagRecommendation({
  symbol,
  asOf,
  dataStatus,
  flagTradePlan,
  evidence,
  topDown,
  flagFreshness = null,
  now = null,
  cfg = ENGINE_CONFIG.model,
  planCfg = ENGINE_CONFIG.flagPlan
}) {
  // One R:R floor, owned by the flag plan config (review fix 9) - never a second copy.
  // Owner decision 2026-09-23 (1a): the floor is gross price R; netRR is information.
  const minRR = planCfg.minRR;
  const ev = evidenceForRecommendation(evidence, topDown);
  const supports = [];
  const opposes = [];
  const unknowns = [];
  const changeConditions = [];
  const factorStates = [];

  if (dataStatus === 'unavailable') {
    unknowns.push(reason('market_data_unavailable', `${symbol} market data is unavailable`, [ref('dataStatus')]));
    return finish('DATA_UNAVAILABLE', 'market_data_unavailable');
  }

  if (!flagTradePlan) {
    // No plan: before calling it WATCH, the flag timeframes themselves must be fresh -
    // a missing or stale 1m/3m/5m series cannot be read as "no flag" (review fix 5).
    const gaps = [];
    for (const req of flagFreshness || []) {
      const f = assessFreshness({ closedThroughIso: req.closedThroughIso, now, intervalMs: req.intervalMs, graceMs: req.graceMs });
      if (f.fresh) continue;
      const kind = f.reason === 'stale' || f.reason === 'closed_through_in_future' ? 'stale_data' : 'missing_data';
      gaps.push({ tf: req.tf, kind });
    }
    if (gaps.length > 0) {
      for (const g of gaps) {
        unknowns.push(reason(`${g.kind}:${g.tf}`, `${symbol} ${g.tf} closed candles are ${g.kind === 'stale_data' ? 'stale' : 'missing'}; no flag call is made on them.`, [ref(`timeframes.${g.tf}.closedThrough`, g.tf)]));
      }
      changeConditions.push(reason('fresh_closed_candles', `Refresh ${gaps.map((g) => g.tf).join('/')} closed candles and rebuild.`, [ref('timeframes')]));
      return finish('DATA_UNAVAILABLE', unknowns[0].code);
    }
    const anyFlag = ev.flags && ev.flags.length > 0;
    changeConditions.push(reason('need_confirmed_flag_plan', anyFlag
      ? 'A detected flag must become an engine-owned ready plan.'
      : 'A flag must form, confirm, and produce an engine-owned trade plan.', [ref('flagTradePlan')]));
    factorStates.push(factor('flag_plan', 'missing', 'No engine-owned flagTradePlan is present; legacy bestSignal is not the 21/200 recommendation.', [ref('flagTradePlan')], 'against'));
    return finish('WATCH', 'need_confirmed_flag_plan');
  }

  factorStates.push(factor('trade_readiness', flagTradePlan.status, `Plan status is ${flagTradePlan.status}${flagTradePlan.reasonCode ? ` (${flagTradePlan.reasonCode})` : ''}.`, [ref('flagTradePlan.status'), ref('flagTradePlan.reasonCode')], flagTradePlan.status === 'ready' ? 'support' : 'against'));

  if (flagTradePlan.reasonCode === 'missing_data' || flagTradePlan.reasonCode === 'stale_data') {
    unknowns.push(reason(flagTradePlan.reasonCode, `The selected flag plan is ${flagTradePlan.reasonCode}; the engine will not infer missing or stale candle data.`, [ref('flagTradePlan.reasonCode')]));
    changeConditions.push(reason('fresh_closed_candles', 'Refresh the required closed candles and rebuild the plan.', [ref('flagTradePlan')]));
    return finish('DATA_UNAVAILABLE', flagTradePlan.reasonCode);
  }

  if (flagTradePlan.status === 'rejected') {
    const hardBad = ['invalid_levels', 'chase', 'room_at_entry', 'stop_distance_exceeds_cap', 'rr_below_min'];
    if (hardBad.includes(flagTradePlan.reasonCode)) {
      const rrText = flagTradePlan.reasonCode === 'rr_below_min'
        ? `The engine rejected the flag plan: gross R:R to TP1 is ${flagTradePlan.grossRR ?? 'unavailable'}, below the ${minRR}R floor.`
        : `The engine rejected the flag plan: ${flagTradePlan.reasonCode}.`;
      const rrRefs = flagTradePlan.reasonCode === 'rr_below_min' ? [ref('flagTradePlan.reasonCode'), ref('flagTradePlan.grossRR')] : [ref('flagTradePlan.reasonCode')];
      opposes.push(reason(flagTradePlan.reasonCode, rrText, rrRefs));
      changeConditions.push(reason('new_valid_plan', 'A fresh flag plan must pass levels, stop distance, and gross R:R checks.', [ref('flagTradePlan')]));
      return finish('BAD', flagTradePlan.reasonCode);
    }
    unknowns.push(reason('unclassified_rejection', `The engine rejected the plan with ${flagTradePlan.reasonCode || 'no reason code'}.`, [ref('flagTradePlan.reasonCode')]));
    return finish('DATA_UNAVAILABLE', 'unclassified_rejection');
  }

  // Ready or conditional from here: gross R:R already met the floor in the engine. Net
  // R:R after fees is information - a non-blocking oppose so the GPT can warn, never BAD.
  if (isFiniteNumber(flagTradePlan.grossRR)) {
    supports.push(reason('rr_ok', `Gross R:R to TP1 is ${flagTradePlan.grossRR}, meeting the ${minRR}R floor.`, [ref('flagTradePlan.grossRR')]));
  }
  if (!isFiniteNumber(flagTradePlan.netRR) || flagTradePlan.netRR < minRR) {
    opposes.push(reason('net_rr_low', `Net R:R after fees is ${flagTradePlan.netRR ?? 'unavailable'}; fees eat the edge.`, [ref('flagTradePlan.netRR')]));
  }

  if (flagTradePlan.status === 'conditional') {
    supports.push(reason('valid_conditional_plan', `The engine has a valid conditional ${flagTradePlan.direction} flag plan with TP1 ${flagTradePlan.tp1}, gross R:R ${flagTradePlan.grossRR} and net R:R ${flagTradePlan.netRR}.`, [ref('flagTradePlan')]));
    changeConditions.push(reason('entry_condition', flagTradePlan.entryCondition || 'The published entry condition must be observed on a closed candle.', [ref('flagTradePlan.entryCondition')]));
    return finish('WATCH', 'entry_condition');
  }

  supports.push(reason('ready_flag_plan', `The engine-owned ${flagTradePlan.direction} flag plan is ready at ${flagTradePlan.entry}.`, [ref('flagTradePlan.entry')]));

  const maItem = ev.ma && ev.ma.map ? ev.ma.map[flagTradePlan.timeframe] : null;
  if (maItem) {
    const good21 = (flagTradePlan.direction === 'long' && maItem.priceVsEma21 !== 'below') || (flagTradePlan.direction === 'short' && maItem.priceVsEma21 !== 'above');
    (good21 ? supports : opposes).push(reason('ema21_flag_context', `${flagTradePlan.timeframe} price is ${maItem.priceVsEma21} EMA21 (${maItem.ema21}).`, [ref(`model.ma.map.${flagTradePlan.timeframe}.ema21`, flagTradePlan.timeframe)]));
    factorStates.push(factor('ema200_side', maItem.priceVsEma200, `${flagTradePlan.timeframe} price is ${maItem.priceVsEma200} EMA200 (${maItem.ema200}); EMA200 is context, not a veto.`, [ref(`model.ma.map.${flagTradePlan.timeframe}.ema200`, flagTradePlan.timeframe)], 'context'));
  } else {
    unknowns.push(reason('ma_context_missing', `EMA21/EMA200 context is missing for ${flagTradePlan.timeframe}.`, [ref(`timeframes.${flagTradePlan.timeframe}`)]));
  }

  if (topDown) {
    const withTd = topDown.sentiment === directionSentiment(flagTradePlan.direction);
    (withTd ? supports : opposes).push(reason('top_down_context', `Top-down sentiment is ${topDown.sentiment} with ${topDown.aligned}/4 aligned. Alignment changes quality, not validity.`, [ref('model.topDown')]));
  } else {
    unknowns.push(reason('top_down_missing', 'Top-down sentiment is unavailable.', [ref('model.topDown')]));
  }

  const nearest = ev.channels && ev.channels.nearestLevelAhead;
  if (nearest) {
    supports.push(reason('first_level_ahead', `First level ahead is ${nearest.kind} on ${nearest.timeframe} at ${nearest.price}; TP1 is engine-owned and already capped when applicable.`, [ref('model.channels.levelsAhead')]));
  } else {
    unknowns.push(reason('level_context_missing', 'No channel or major level ahead was detected.', [ref('model.channels')]));
  }

  const div = ev.divergence && ev.divergence.confluence ? ev.divergence.confluence : null;
  if (div) {
    const agree = flagTradePlan.direction === 'short' ? div.bearish : div.bullish;
    const conflict = flagTradePlan.direction === 'short' ? div.bullish : div.bearish;
    if (agree > 0) supports.push(reason('divergence_agrees', `${agree} timeframe(s) show ${flagTradePlan.direction === 'short' ? 'bearish' : 'bullish'} Stoch RSI divergence.`, [ref('model.divergence')]));
    if (conflict > 0) opposes.push(reason('divergence_conflicts', `${conflict} timeframe(s) show ${oppositeDirection(flagTradePlan.direction)} divergence against the setup.`, [ref('model.divergence')]));
    if (agree === 0 && conflict === 0) unknowns.push(reason('divergence_absent', 'No confirming or opposing Stoch RSI divergence was detected.', [ref('model.divergence')]));
  } else {
    unknowns.push(reason('divergence_missing', 'Stoch RSI divergence could not be evaluated.', [ref('model.divergence')]));
  }

  changeConditions.push(reason('call_changes_on_invalidation', `Call changes if price invalidates the plan at ${flagTradePlan.stop}, TP1 becomes blocked below ${minRR}R gross, or required data goes stale.`, [ref('flagTradePlan.stop'), ref('flagTradePlan.grossRR')]));

  const scored = scoreContext({ plan: flagTradePlan, evidence: ev, cfg });
  factorStates.push(factor('quality_score', scored.points, `Quality score is ${scored.points}/100 from deterministic context weights, not win odds.`, [ref('model.decisionWeights', null, 'config')], 'context'));
  for (const item of scored.contributions) factorStates.push(factor(`score_${item.code}`, item.points, `${item.code} contributes ${item.points}/${item.max}.`, [ref('model.decisionWeights', null, 'config')], 'context'));

  return finish('GOOD', 'ready_flag_plan', scored);

  function finish(klass, primaryCode, scored = null) {
    const primaryReason = [...supports, ...opposes, ...unknowns, ...changeConditions].find((r) => r.code === primaryCode)
      || reason(primaryCode, primaryCode, []);
    return {
      class: klass,
      setupId: flagTradePlan ? flagTradePlan.planId : null,
      candidateId: flagTradePlan ? flagTradePlan.candidateId : null,
      asOf,
      primaryReason,
      supports,
      opposes,
      unknowns,
      changeConditions,
      factorStates,
      qualityBand: scored ? qualityBand(scored.points) : null,
      readiness: flagTradePlan ? flagTradePlan.status : 'no_plan',
      policyVersion: cfg.policyVersion || 'flag-21-decision-v1',
      trace: {
        symbol,
        class: klass,
        code: primaryCode,
        score: scored ? scored.points : null,
        planStatus: flagTradePlan ? flagTradePlan.status : null,
        planReasonCode: flagTradePlan ? flagTradePlan.reasonCode : null
      }
    };
  }
}

/**
 * Default-payload form of a recommendation record (review fix 6a): codes plus one-line
 * primary/change-condition text, no refs, no factorStates. The full record is published
 * only under `model.recommendation` (include=model).
 * @param {Object|null} full - buildFlagRecommendation output
 * @returns {Object|null}
 */
export function compactRecommendation(full) {
  if (!full) return full;
  const codes = (list) => (list || []).map((r) => r.code);
  return {
    class: full.class,
    setupId: full.setupId,
    candidateId: full.candidateId,
    asOf: full.asOf,
    primaryReason: full.primaryReason ? { code: full.primaryReason.code, text: full.primaryReason.text } : null,
    readiness: full.readiness,
    qualityBand: full.qualityBand,
    policyVersion: full.policyVersion,
    supports: codes(full.supports),
    opposes: codes(full.opposes),
    unknowns: codes(full.unknowns),
    changeConditions: (full.changeConditions || []).map((r) => ({ code: r.code, text: r.text })),
    trace: full.trace
  };
}

export default { buildFlagRecommendation, compactRecommendation };
