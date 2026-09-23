import { ENGINE_CONFIG } from '../config/engine.js';
import { swingPivots } from './geometry.js';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function roundN(value, decimals = 4) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function side(price, level) {
  if (!isFiniteNumber(price) || !isFiniteNumber(level)) return 'unknown';
  if (price > level) return 'above';
  if (price < level) return 'below';
  return 'at';
}

function slopeFrom(history, decimals = 4) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  return isFiniteNumber(last) && isFiniteNumber(prev) ? roundN(last - prev, decimals) : null;
}

function pctDistance(price, level) {
  if (!isFiniteNumber(price) || !isFiniteNumber(level) || level === 0) return null;
  return roundN(((price - level) / level) * 100, 4);
}

function candleAge(now, closedThroughIso) {
  const closedMs = Date.parse(closedThroughIso);
  return isFiniteNumber(now) && Number.isFinite(closedMs) ? now - closedMs : null;
}

export function buildMaEvidence({ tfEntries, seriesByTf, topDown, now, cfg = ENGINE_CONFIG.model }) {
  const map = {};
  for (const [timeframe, entry] of Object.entries(tfEntries || {})) {
    if (!entry) continue;
    const price = Array.isArray(entry.candles) && entry.candles.length
      ? entry.candles[entry.candles.length - 1].c
      : null;
    const series = seriesByTf && seriesByTf[timeframe] ? seriesByTf[timeframe] : {};
    const ema21DistancePct = pctDistance(price, entry.ema21);
    const ema200DistancePct = pctDistance(price, entry.ema200);
    map[timeframe] = {
      timeframe,
      source: 'closed_candle_indicators',
      closedThrough: entry.closedThrough || null,
      ageMs: candleAge(now, entry.closedThrough),
      price: isFiniteNumber(price) ? roundN(price, 2) : null,
      ema21: isFiniteNumber(entry.ema21) ? entry.ema21 : null,
      ema200: isFiniteNumber(entry.ema200) ? entry.ema200 : null,
      priceVsEma21: side(price, entry.ema21),
      priceVsEma200: side(price, entry.ema200),
      ema21DistancePct,
      ema200DistancePct,
      ema21Slope: slopeFrom(series.ema21History, 4),
      ema200Slope: slopeFrom(series.ema200History, 4),
      unavailable: {
        ema21: isFiniteNumber(entry.ema21) ? null : 'not_enough_closed_candles',
        ema200: isFiniteNumber(entry.ema200) ? null : 'not_enough_closed_candles'
      }
    };
  }

  const weekly = topDown && topDown.weekly ? topDown.weekly : null;
  if (weekly) {
    map['1w'] = {
      timeframe: '1w',
      source: 'derived_from_1d_closed_candles',
      closedThrough: null,
      ageMs: null,
      price: weekly.close,
      ema21: weekly.ema21,
      ema200: null,
      priceVsEma21: side(weekly.close, weekly.ema21),
      priceVsEma200: 'unknown',
      ema21DistancePct: pctDistance(weekly.close, weekly.ema21),
      ema200DistancePct: null,
      ema21Slope: weekly.ema21Slope,
      ema200Slope: null,
      unavailable: {
        ema21: isFiniteNumber(weekly.ema21) ? null : (weekly.reason || 'insufficient_history'),
        // weekly.reason names the EMA21 gap when EMA21 itself is missing; never file it
        // under ema200 (review nit 15).
        ema200: isFiniteNumber(weekly.ema21) && weekly.reason ? weekly.reason : 'insufficient_weekly_history'
      }
    };
  }

  const pull = summarizePull(map, cfg);
  return { map, pull };
}

export function summarizePull(maMap, cfg = ENGINE_CONFIG.model) {
  const weights = cfg.above200Weights || {};
  let best = null;
  for (const [timeframe, item] of Object.entries(maMap || {})) {
    const dist = Math.abs(item.ema21DistancePct || 0);
    if (!isFiniteNumber(dist) || dist < (cfg.maPullDistancePct || 0.75)) continue;
    const sign = item.ema21DistancePct > 0 ? -1 : 1;
    const score = dist * (weights[timeframe] ?? (timeframe === '1w' ? 4 : 0.1));
    if (!best || score > best.score) {
      best = {
        direction: sign > 0 ? 'up' : 'down',
        timeframe,
        basis: `price ${roundN(dist, 2)}% from EMA21`,
        score: roundN(score, 4),
        overridden: false,
        overrideReason: null
      };
    }
  }
  return best || { direction: 'none', timeframe: null, basis: 'no stretched EMA21 distance', score: 0, overridden: false, overrideReason: null };
}

function addLevel(out, { timeframe, kind, price, zone }) {
  if (!isFiniteNumber(price)) return;
  out.push({
    timeframe,
    kind,
    price: roundN(price, 2),
    zone: zone ? { low: roundN(zone.low, 2), high: roundN(zone.high, 2) } : null
  });
}

export function levelsAhead({ direction, price, geometryContext }) {
  if (direction !== 'long' && direction !== 'short') return [];
  const sign = direction === 'short' ? -1 : 1;
  const levels = [];
  for (const [timeframe, g] of Object.entries(geometryContext || {})) {
    if (!g) continue;
    if (g.channel) {
      addLevel(levels, { timeframe, kind: direction === 'short' ? 'channel_bottom' : 'channel_top', price: direction === 'short' ? g.channel.bottom : g.channel.top });
    }
    const zones = direction === 'short' ? g.horizontalSupportZones : g.horizontalResistanceZones;
    for (const zone of zones || []) {
      addLevel(levels, { timeframe, kind: direction === 'short' ? 'support_zone' : 'resistance_zone', price: direction === 'short' ? zone.high : zone.low, zone });
    }
    for (const zone of g.confluenceZones || []) {
      addLevel(levels, { timeframe, kind: 'confluence_zone', price: direction === 'short' ? zone.high : zone.low, zone });
    }
  }
  return levels
    .filter((level) => isFiniteNumber(price) && sign * (level.price - price) > 0)
    .sort((a, b) => sign * (a.price - b.price));
}

export function buildChannelEvidence({ direction, price, geometryContext, topDown, cfg = ENGINE_CONFIG.model }) {
  const channels = {};
  for (const [timeframe, g] of Object.entries(geometryContext || {})) {
    if (!g) continue;
    const positionPct = g.channel && isFiniteNumber(g.channel.positionPct) ? roundN(g.channel.positionPct, 2) : null;
    let edge = 'middle';
    if (positionPct !== null && positionPct <= (cfg.channelEdgePct || 20)) edge = 'bottom';
    else if (positionPct !== null && positionPct >= 100 - (cfg.channelEdgePct || 20)) edge = 'top';
    const sentiment = topDown && topDown.sentiment ? topDown.sentiment : 'mixed';
    const withBreak = (direction === 'long' && sentiment === 'bull') || (direction === 'short' && sentiment === 'bear');
    const againstSentiment = (direction === 'long' && sentiment === 'bear') || (direction === 'short' && sentiment === 'bull');
    const atBreakEdge = (direction === 'long' && edge === 'top') || (direction === 'short' && edge === 'bottom');
    // A fade into the edge sentiment is pushing through (short at the top in bull, long at
    // the bottom in bear) is the channel break most likely to run over the trade.
    const atFadeEdge = (direction === 'short' && edge === 'top') || (direction === 'long' && edge === 'bottom');
    let breakoutRisk = 'low';
    if (direction !== 'long' && direction !== 'short') breakoutRisk = 'unknown';
    else if (atBreakEdge) breakoutRisk = withBreak ? 'high' : 'medium';
    else if (atFadeEdge && againstSentiment) breakoutRisk = 'high';
    channels[timeframe] = {
      timeframe,
      kind: g.channel ? 'channel' : 'unknown',
      top: g.channel ? roundN(g.channel.top, 2) : null,
      bottom: g.channel ? roundN(g.channel.bottom, 2) : null,
      positionPct,
      edge,
      breakoutRisk,
      basis: g.channel ? [`position:${edge}`, `sentiment:${sentiment}`] : ['no detected channel']
    };
  }
  const ahead = levelsAhead({ direction, price, geometryContext });
  return { channels, levelsAhead: ahead.slice(0, 8), nearestLevelAhead: ahead[0] || null };
}

/**
 * Stoch RSI %K at a candle index. The Stoch history is shorter than the candle series
 * (indicator warm-up) and aligned to its END, so candle index i maps to history index
 * i - offset (offset = candles.length - history.length). A pivot before the history's
 * first value gets null - no value, never a neighbour's value.
 */
function stochAt(history, candleIndex, offset = 0) {
  const index = candleIndex - offset;
  if (!Array.isArray(history) || index < 0 || index >= history.length) return null;
  const item = history[index];
  const v = item && isFiniteNumber(item.k) ? item.k : null;
  return v;
}

function comparePair(a, b, mode) {
  if (!a || !b || !isFiniteNumber(a.price) || !isFiniteNumber(b.price) || !isFiniteNumber(a.stoch) || !isFiniteNumber(b.stoch)) return null;
  if (mode === 'bull_standard' && b.price < a.price && b.stoch > a.stoch) return 'bullish';
  if (mode === 'bear_standard' && b.price > a.price && b.stoch < a.stoch) return 'bearish';
  if (mode === 'bull_hidden' && b.price > a.price && b.stoch < a.stoch) return 'bullish';
  if (mode === 'bear_hidden' && b.price < a.price && b.stoch > a.stoch) return 'bearish';
  return null;
}

function divergenceOnPivots(pivots, stochHistory, latestIndex, cfg, offset = 0) {
  const lows = pivots.lows.slice(-(cfg.divergenceLookbackPivots || 5)).map((p) => ({ ...p, stoch: stochAt(stochHistory, p.index, offset) })).filter((p) => isFiniteNumber(p.stoch));
  const highs = pivots.highs.slice(-(cfg.divergenceLookbackPivots || 5)).map((p) => ({ ...p, stoch: stochAt(stochHistory, p.index, offset) })).filter((p) => isFiniteNumber(p.stoch));
  const checks = [
    ['standard', lows, 'bull_standard'],
    ['hidden', lows, 'bull_hidden'],
    ['standard', highs, 'bear_standard'],
    ['hidden', highs, 'bear_hidden']
  ];
  // Every bull and bear candidate is evaluated; the most recent pivot pair wins (ties
  // keep the checks order above), so a newer bearish pair is never hidden behind an
  // older bullish one.
  let best = null;
  for (const [kind, list, mode] of checks) {
    if (list.length < 2) continue;
    const a = list[list.length - 2];
    const b = list[list.length - 1];
    const type = comparePair(a, b, mode);
    if (!type) continue;
    if (best && b.index <= best.b.index) continue;
    best = { kind, type, a, b };
  }
  if (best) {
    const { kind, type, a, b } = best;
    const ageCandles = latestIndex - b.index;
    const fresh = ageCandles <= (cfg.divergenceMaxAgeCandles || 80);
    return {
      type,
      kind,
      pivots: [
        { index: a.index, price: roundN(a.price, 2), stoch: roundN(a.stoch, 2), time: a.time },
        { index: b.index, price: roundN(b.price, 2), stoch: roundN(b.stoch, 2), time: b.time }
      ],
      ageCandles,
      strength: fresh ? roundN(1 - (ageCandles / (cfg.divergenceMaxAgeCandles || 80)), 4) : 0
    };
  }
  return { type: 'none', kind: null, pivots: [], ageCandles: null, strength: 0 };
}

export function buildDivergenceEvidence({ closedByTf, seriesByTf, cfg = ENGINE_CONFIG.model }) {
  const byTimeframe = {};
  let bullish = 0;
  let bearish = 0;
  for (const [timeframe, candles] of Object.entries(closedByTf || {})) {
    const stochHistory = seriesByTf && seriesByTf[timeframe] ? seriesByTf[timeframe].stochHistory : null;
    if (!Array.isArray(candles) || !Array.isArray(stochHistory) || candles.length < 10) {
      byTimeframe[timeframe] = { type: 'unknown', kind: null, reason: 'missing_price_or_stoch_history', strength: 0 };
      continue;
    }
    const pivots = swingPivots(candles);
    const offset = Math.max(0, candles.length - stochHistory.length);
    const found = divergenceOnPivots(pivots, stochHistory, candles.length - 1, cfg, offset);
    byTimeframe[timeframe] = found;
    // A stale divergence (strength 0) is still reported, never counted as confluence.
    if (found.strength > 0 && found.type === 'bullish') bullish++;
    if (found.strength > 0 && found.type === 'bearish') bearish++;
  }
  return { byTimeframe, confluence: { bullish, bearish } };
}

export function buildFlagModelEvidence({ candidateSetups, flagTradePlan, topDown, maEvidence, channelEvidence, divergenceEvidence }) {
  const flags = (candidateSetups || []).filter((c) => c && c.type === 'flag').map((c) => ({
    candidateId: c.candidateId || null,
    timeframe: c.timeframe,
    direction: c.direction,
    state: c.state,
    confidence: isFiniteNumber(c.confidence) ? c.confidence : null,
    ema21Hold: c.ema21Hold || null,
    ema200Side: c.ema200Side || null,
    breakoutLevel: isFiniteNumber(c.breakoutLevel) ? roundN(c.breakoutLevel, 2) : null,
    invalidation: isFiniteNumber(c.invalidation) ? roundN(c.invalidation, 2) : null,
    measuredTarget: isFiniteNumber(c.measuredTarget) ? roundN(c.measuredTarget, 2) : null,
    lifecycleState: c.state,
    withSentiment: topDown && topDown.sentiment
      ? ((c.direction === 'long' && topDown.sentiment === 'bull') || (c.direction === 'short' && topDown.sentiment === 'bear'))
      : null
  }));
  return {
    selectedPlanId: flagTradePlan ? flagTradePlan.planId : null,
    selectedCandidateId: flagTradePlan ? flagTradePlan.candidateId : null,
    flags,
    ma: maEvidence,
    channels: channelEvidence,
    divergence: divergenceEvidence
  };
}

export function buildModelEvidence(args) {
  const ma = buildMaEvidence(args);
  const direction = args.flagTradePlan ? args.flagTradePlan.direction : ((args.candidateSetups || []).find((c) => c && c.direction !== 'neutral') || {}).direction;
  const price = isFiniteNumber(args.price) ? args.price : null;
  const channels = buildChannelEvidence({ direction, price, geometryContext: args.geometryContext, topDown: args.topDown, cfg: args.cfg || ENGINE_CONFIG.model });
  const divergence = buildDivergenceEvidence(args);
  return buildFlagModelEvidence({
    candidateSetups: args.candidateSetups,
    flagTradePlan: args.flagTradePlan,
    topDown: args.topDown,
    maEvidence: ma,
    channelEvidence: channels,
    divergenceEvidence: divergence
  });
}

export default { buildMaEvidence, buildChannelEvidence, buildDivergenceEvidence, buildFlagModelEvidence, buildModelEvidence, levelsAhead, summarizePull };
