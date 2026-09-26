import { ENGINE_CONFIG } from '../config/engine.js';
import { assessFreshness } from './freshness.js';
import { levelsAhead, buildChannelEvidence } from './modelEvidence.js';
import { geometryTimeframeFor } from './patternLifecycle.js';

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

// Phase 2 (recommendation completeness): deterministic price text for change conditions,
// e.g. 84466.1 -> "84,466.10". Never locale-dependent.
function fmtPrice(value) {
  if (!isFiniteNumber(value)) return 'n/a';
  const [int, dec] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

const WATCH_STATE_RANK = { triggering: 0, forming: 1, proto: 2 };
// Owner decision "D-variant revised" (2026-09-24, docs/OWNER_DECISIONS_2026-09-24.md):
// with the net gate off, net_rr_low is a fixed 1.0R "thin after fees" floor,
// independent of flagPlan.minRR/minNetRR.
const NET_RR_LOW_THRESHOLD = 1.0;
// Smallest timeframe wins the tie-break (see selectWatchCandidate's own doc comment).
// 15m/1h ranked after 5m for forward-compatibility (T6 completion plan C4) - inert
// today since config.flag.timeframes stays [1m,3m,5m]; see FLAG_TF_RANK's own comment
// in lib/flagTradePlan.js for the mirrored (opposite-direction) trade-plan ranking.
const FLAG_TF_ORDER = { '1m': 0, '3m': 1, '5m': 2, '15m': 3, '1h': 4 };

/**
 * The nearest not-yet-confirmed directional flag on the default flag timeframes, named on
 * a no-plan WATCH: triggering > forming > proto, then highest confidence, then smallest
 * timeframe, then candidateId (total order, so the same set always picks the same one).
 * @param {Array<Object>|null} candidates - the symbol's default candidateSetups
 * @param {Array<string>} [excludeTfs] - timeframes whose closed candles are stale/missing
 * @returns {Object|null}
 */
export function selectWatchCandidate(candidates, excludeTfs = []) {
  const pool = (candidates || []).filter((c) => c && c.type === 'flag'
    && (c.direction === 'long' || c.direction === 'short')
    && WATCH_STATE_RANK[c.state] !== undefined
    && !excludeTfs.includes(c.timeframe));
  if (pool.length === 0) return null;
  return pool.slice().sort((a, b) => {
    const st = WATCH_STATE_RANK[a.state] - WATCH_STATE_RANK[b.state];
    if (st !== 0) return st;
    const conf = (isFiniteNumber(b.confidence) ? b.confidence : -1) - (isFiniteNumber(a.confidence) ? a.confidence : -1);
    if (conf !== 0) return conf;
    const tf = (FLAG_TF_ORDER[a.timeframe] ?? 99) - (FLAG_TF_ORDER[b.timeframe] ?? 99);
    if (tf !== 0) return tf;
    return String(a.candidateId).localeCompare(String(b.candidateId));
  })[0];
}

function candidateSummary(c) {
  if (!c) return null;
  return {
    candidateId: c.candidateId || null,
    timeframe: c.timeframe,
    direction: c.direction,
    state: c.state,
    breakout: isFiniteNumber(c.breakoutLevel) ? c.breakoutLevel : null,
    invalidation: isFiniteNumber(c.invalidation) ? c.invalidation : null,
    measuredRR: isFiniteNumber(c.measuredRR) ? c.measuredRR : null
  };
}

/** Concrete no-plan change condition for the named candidate (mirrored long/short). */
function watchChangeText(c, minRR, flagTfs) {
  if (!c) return `a ${flagTfs.join('/')} flag must form (none detected)`;
  const up = c.direction === 'long';
  if (!isFiniteNumber(c.breakoutLevel)) return `${c.timeframe} ${c.direction} flag must finish forming and publish a breakout level`;
  let text = `${c.timeframe} close ${up ? 'above' : 'below'} ${fmtPrice(c.breakoutLevel)}, then a retest that holds it, then plan ready`;
  if (isFiniteNumber(c.measuredRR) && c.measuredRR < minRR) text += ` (measured move ${c.measuredRR}R; needs >= ${minRR}R)`;
  if (isFiniteNumber(c.invalidation)) text += `; a close ${up ? 'below' : 'above'} ${fmtPrice(c.invalidation)} voids it`;
  return text;
}

/** The exact remedy for a hard plan rejection (mirrored long/short). */
function rejectionRemedyText(plan, minRR, maxStopPct, minNetRR) {
  const up = plan.direction !== 'short';
  const tf = plan.timeframe;
  switch (plan.reasonCode) {
    case 'chase':
      return `wait for a ${tf} retest of ${fmtPrice(plan.entry)} that holds ${up ? 'above' : 'below'} it`;
    case 'rr_below_min': {
      const capped = isFiniteNumber(plan.tp2) && isFiniteNumber(plan.tp1) ? `, TP1 capped at ${fmtPrice(plan.tp1)}` : '';
      return `a flag whose measured move is >= ${minRR}R gross to TP1 (now ${plan.grossRR ?? 'n/a'}R${capped})`;
    }
    case 'room_at_entry':
      return `a flag whose entry is clear of ${up ? 'resistance' : 'support'} (entry ${fmtPrice(plan.entry)} sits inside a ${up ? 'resistance' : 'support'} zone)`;
    case 'stop_distance_exceeds_cap':
      return `a flag whose stop is within ${maxStopPct}% of entry (now ${plan.stopDistancePct ?? 'n/a'}%)`;
    case 'invalid_levels':
      return `a flag with its stop ${up ? 'below' : 'above'} and measured target ${up ? 'above' : 'below'} the breakout`;
    case 'net_rr_below_min':
    case 'stop_inside_costs':
      return `a flag whose net R:R after fees is >= ${minNetRR}R (now ${plan.netRR ?? 'n/a'}R, gross ${plan.grossRR ?? 'n/a'}R)${isFiniteNumber(plan.costR) ? ` - round-trip cost alone is ${plan.costR}R of this stop's risk` : ''}`;
    default:
      return 'A fresh flag plan must pass levels, stop distance, and gross R:R checks.';
  }
}

// Delivery pass (schema 1.25.0): candle length per flag timeframe, for the readiness
// call's "next close" arithmetic. Same values as services/scalpContext.js INTERVAL_MS
// (not imported: scalpContext imports this module).
const TF_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };

function roundTo(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Next close of `tf` strictly after `asOfIso` (a closed-through time), as minutes from
 * asOf and an ISO time. Closes sit on UTC multiples of the interval, so 01:12 on 5m ->
 * 01:15 (3 min); 01:15 on 5m -> 01:20 (5 min). Null pair when either input is unusable.
 * @param {string|null} asOfIso
 * @param {string|null} tf
 * @returns {{etaMin:number|null, at:string|null}}
 */
export function nextCloseEta(asOfIso, tf) {
  const t = typeof asOfIso === 'string' ? Date.parse(asOfIso) : NaN;
  const iv = TF_MS[tf];
  if (!isFiniteNumber(t) || !isFiniteNumber(iv)) return { etaMin: null, at: null };
  const next = (Math.floor(t / iv) + 1) * iv;
  return { etaMin: Math.ceil((next - t) / 60000), at: new Date(next).toISOString() };
}

/**
 * The first level ahead of a plan/setup entry: the TP1 cap zone edge when TP1 is capped,
 * else the measured target (which is TP1 itself). Found by matching TP1 against the
 * zone edges lib/flagTradePlan.js's nearestRoomAhead scans (every geometry timeframe).
 * @returns {{toLevel:string, levelPrice:number, levelSource:string, pts:number, r:number|null, stop:number}|null}
 */
export function roomAhead(levels, geometryContext) {
  if (!levels) return null;
  const { direction, entry, stop, tp1, tp2 } = levels;
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(tp1) || (direction !== 'long' && direction !== 'short')) return null;
  let capTf = null;
  const order = ['15m', '1h', '4h', ...Object.keys(geometryContext || {}).filter((k) => !['15m', '1h', '4h'].includes(k)).sort()];
  for (const gtf of order) {
    const g = geometryContext ? geometryContext[gtf] : null;
    const zones = g ? (direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones) : null;
    if (!Array.isArray(zones)) continue;
    if (zones.some((z) => roundTo(direction === 'long' ? z.low : z.high, 2) === roundTo(tp1, 2))) { capTf = gtf; break; }
  }
  const capped = capTf !== null || isFiniteNumber(tp2);
  const kind = direction === 'long' ? 'resistance' : 'support';
  const risk = Math.abs(entry - stop);
  const pts = roundTo(Math.abs(tp1 - entry), 2);
  return {
    toLevel: capped ? 'tp1_cap' : 'measured_target',
    levelPrice: roundTo(tp1, 2),
    levelSource: capped ? (capTf ? `${capTf} ${kind}` : kind) : 'measured move',
    pts,
    r: risk > 0 ? roundTo(Math.abs(tp1 - entry) / risk, 2) : null,
    stop: roundTo(stop, 2)
  };
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

// Alert clarity (schema 1.27.0, docs/PLAN_ALERT_CLARITY.md): plain words for the
// candidate qualification codes (lib/candidateQualifier.js). Same wording as the
// Telegram reason table (lib/telegram.js REASON_PHRASES/REASON_PATTERNS), duplicated
// here so GPT and Telegram read one text.
const QUAL_WORDS = [
  [/^room:blocked-(\w+)$/, (m) => `a ${m[1]} level blocks the measured target`],
  [/^chase$/, () => 'price ran past the breakout'],
  [/^rr:([\d.]+)$/, (m) => `measured move only ${m[1]}R`],
  [/^conflict:(\w+)-(long|short)$/, (m) => `opposite ${m[1]} ${m[2]} flag active`],
  [/^stoch:ob-cross$/, () => 'Stoch RSI overbought with a bearish cross'],
  [/^stoch:os-cross$/, () => 'Stoch RSI oversold with a bullish cross'],
  [/^ema200:counter$/, () => 'against EMA200'],
  [/^ct:4h$/, () => '4h lean against the trade']
];

/** A qualification code in words; an unmapped code comes back as itself. */
export function qualWords(code) {
  const c = String(code || '');
  for (const [re, fn] of QUAL_WORDS) {
    const m = c.match(re);
    if (m) return fn(m);
  }
  return c;
}

/**
 * True for a qual code that stops the flag passing the plan gates: a blocked measured
 * target, a chase, or a measured move under the plan's own gross R floor (`rr:<x>` with
 * x < minRR; the qualifier's own rr cut is 3, which the plan gate does not enforce).
 */
function isGateBlocker(code, minRR) {
  if (/^room:blocked/.test(code) || code === 'chase') return true;
  const m = String(code).match(/^rr:([\d.]+)$/);
  return Boolean(m) && isFiniteNumber(minRR) && Number(m[1]) < minRR;
}

/** Nearest geometry zone on the opposing side of `entry` (below a long, above a short). */
function otherSideZone(direction, entry, gtf, g) {
  if (!g || !isFiniteNumber(entry)) return null;
  const up = direction === 'long';
  let best = null;
  const consider = (z, source) => {
    if (!z || !isFiniteNumber(z.low) || !isFiniteNumber(z.high)) return;
    const beyond = up ? z.high < entry : z.low > entry;
    if (!beyond) return;
    const dist = up ? entry - z.high : z.low - entry;
    if (!best || dist < best.dist) best = { low: z.low, high: z.high, source: `${gtf} ${source}`, dist };
  };
  for (const z of g.horizontalSupportZones || []) consider(z, 'support');
  for (const z of g.horizontalResistanceZones || []) consider(z, 'resistance');
  for (const z of g.confluenceZones || []) consider(z, 'confluence');
  return best;
}

/**
 * Alert clarity for one candidate (schema 1.27.0): presentation derived from the
 * candidate's `qual`, `ema21Hold`, its geometry timeframe's zones, top-down and
 * divergence. Never a gate, never changes the class or the plan.
 * @param {Object} p
 * @param {Object|null} p.candidate - a candidateSetups entry (with qual)
 * @param {Object|null} [p.topDown]
 * @param {{bullish:number, bearish:number}|null} [p.divergence] - model.divergence.confluence
 * @param {Object|null} [p.geometryContext]
 * @param {number} [p.minRR] - flagPlan.minRR
 * @returns {Object|null}
 */
export function buildClarity({ candidate, topDown = null, divergence = null, geometryContext = null, minRR = ENGINE_CONFIG.flagPlan.minRR }) {
  const c = candidate;
  if (!c || (c.direction !== 'long' && c.direction !== 'short')) return null;
  const up = c.direction === 'long';
  const brk = isFiniteNumber(c.breakoutLevel) ? c.breakoutLevel : null;
  const reasons = c.qual && Array.isArray(c.qual.reasons) ? c.qual.reasons : [];

  // Gate: can this flag pass the plan gates at all?
  const blockers = reasons.filter((code) => isGateBlocker(code, minRR));
  const texts = blockers.map((code) => {
    const m = code.match(/^rr:([\d.]+)$/);
    if (!m) return qualWords(code);
    const risk = brk !== null && isFiniteNumber(c.invalidation) ? Math.abs(brk - c.invalidation) : null;
    const need = risk ? brk + (up ? 1 : -1) * minRR * risk : null;
    return `R ${m[1]} under ${minRR} floor${need !== null ? `; needs TP beyond ${fmtPrice(need)}` : ''}`;
  });
  const dead = c.qual && c.qual.decision === 'dont';
  if (dead && texts.length === 0) texts.push(`flag ${c.state || 'not live'}`);
  const gate = { passable: !dead && blockers.length === 0, blockers, text: texts.length ? texts.join('; ') : null };

  // Kill line before the void: a close back through the breakout after a probe.
  const hold = typeof c.ema21Hold === 'string' ? c.ema21Hold : '';
  const holdWord = hold === 'reclaim' ? 'reclaim' : (hold.startsWith('acceptance') ? 'acceptance' : null);
  const killText = brk === null
    ? 'no breakout level yet'
    : `close back ${up ? 'below' : 'above'} ${fmtPrice(brk)} after a probe = defended, stand down`;
  const killIf = { level: brk, text: `${holdWord ? `EMA21 ${holdWord} already — ` : ''}${killText}` };

  // Other side: where a failed breakout rotates to, on the candidate's geometry timeframe.
  const gtf = geometryTimeframeFor(c.timeframe);
  const zone = otherSideZone(c.direction, brk, gtf, gtf && geometryContext ? geometryContext[gtf] : null);
  const otherSide = zone
    ? { low: zone.low, high: zone.high, source: zone.source, text: `if it fails, rotation to ${fmtPrice(zone.low)}–${fmtPrice(zone.high)} (${zone.source})` }
    : { low: null, high: null, source: null, text: null };

  // Context: every qual code in words, blocking first, then top-down and divergence.
  const context = [...blockers, ...reasons.filter((code) => !blockers.includes(code))].map(qualWords);
  if (topDown && typeof topDown.sentiment === 'string' && isFiniteNumber(topDown.aligned)) {
    const s = topDown.sentiment;
    const n = topDown.aligned;
    if (n === 2) context.push('Top-down: split 2/4');
    else if ((s === 'bull' && !up) || (s === 'bear' && up)) context.push(`Counter-trend: top-down ${s} ${n}/4, against the ${c.direction}`);
    else context.push(`Top-down: ${s} ${n}/4`);
  }
  let div = null;
  if (divergence) {
    const agree = (up ? divergence.bullish : divergence.bearish) || 0;
    const conflict = (up ? divergence.bearish : divergence.bullish) || 0;
    div = { agree, conflict };
    const parts = [agree > 0 ? `${agree} tf agrees` : null, conflict > 0 ? `${conflict}${agree > 0 ? '' : ' tf'} against` : null].filter(Boolean);
    if (parts.length) context.push(`Divergence: ${parts.join(', ')}`);
  }

  return { candidateId: c.candidateId || null, gate, killIf, otherSide, context, divergence: div };
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
  candidates = null,
  geometryContext = null,
  cfg = ENGINE_CONFIG.model,
  planCfg = ENGINE_CONFIG.flagPlan
}) {
  // One R:R floor, owned by the flag plan config (review fix 9) - never a second copy.
  // Owner decision 2026-09-23 (1a): the floor is gross price R; netRR is information.
  const minRR = planCfg.minRR;
  // T6 phase 1 (owner decision D1, variant V1c): the real net gate. null when off
  // (scripts/replay-rules.js's pre-net-gate variants).
  const minNetRR = planCfg.minNetRR;
  const ev = evidenceForRecommendation(evidence, topDown);
  const supports = [];
  const opposes = [];
  const unknowns = [];
  const changeConditions = [];
  const factorStates = [];
  let watchCandidate = null;

  if (dataStatus === 'unavailable') {
    unknowns.push(reason('market_data_unavailable', `${symbol} market data is unavailable`, [ref('dataStatus')]));
    return finish('DATA_UNAVAILABLE', 'market_data_unavailable');
  }

  // Flag-timeframe freshness (review fix 5), computed once: gates the no-plan branch and
  // is cited as context everywhere else.
  const gaps = [];
  for (const req of flagFreshness || []) {
    const f = assessFreshness({ closedThroughIso: req.closedThroughIso, now, intervalMs: req.intervalMs, graceMs: req.graceMs });
    if (f.fresh) continue;
    const kind = f.reason === 'stale' || f.reason === 'closed_through_in_future' ? 'stale_data' : 'missing_data';
    gaps.push({ tf: req.tf, kind });
  }
  const findCandidate = (id) => (candidates || []).find((c) => c && c.candidateId && c.candidateId === id) || null;

  if (!flagTradePlan) {
    // No plan: before calling it WATCH, the flag timeframes themselves must be fresh -
    // a missing or stale 1m/3m/5m series cannot be read as "no flag" (review fix 5).
    if (gaps.length > 0) {
      for (const g of gaps) {
        unknowns.push(reason(`${g.kind}:${g.tf}`, `${symbol} ${g.tf} closed candles are ${g.kind === 'stale_data' ? 'stale' : 'missing'}; no flag call is made on them.`, [ref(`timeframes.${g.tf}.closedThrough`, g.tf)]));
      }
      changeConditions.push(reason('fresh_closed_candles', `Refresh ${gaps.map((g) => g.tf).join('/')} closed candles and rebuild.`, [ref('timeframes')]));
      // Context stays undirected here: no candidate is named on stale candles.
      addContext({ direction: null, candidate: null, plan: null });
      return finish('DATA_UNAVAILABLE', unknowns[0].code);
    }
    watchCandidate = candidates ? selectWatchCandidate(candidates) : null;
    const flagTfs = (ENGINE_CONFIG.flag && ENGINE_CONFIG.flag.timeframes) || ['1m', '3m', '5m'];
    const changeText = candidates
      ? watchChangeText(watchCandidate, minRR, flagTfs)
      : ((ev.flags && ev.flags.length > 0)
        ? 'A detected flag must become an engine-owned ready plan.'
        : 'A flag must form, confirm, and produce an engine-owned trade plan.');
    changeConditions.push(reason('need_confirmed_flag_plan', changeText, [watchCandidate ? ref('candidateSetups', watchCandidate.timeframe) : ref('flagTradePlan')]));
    factorStates.push(factor('flag_plan', 'missing', 'No engine-owned flagTradePlan is present; legacy bestSignal is not the 21/200 recommendation.', [ref('flagTradePlan')], 'against'));
    if (watchCandidate) {
      supports.push(reason(`candidate:${watchCandidate.timeframe}-${watchCandidate.direction}-${watchCandidate.state}`, `Nearest flag is a ${watchCandidate.state} ${watchCandidate.timeframe} ${watchCandidate.direction} (confidence ${watchCandidate.confidence ?? 'n/a'}), breakout ${fmtPrice(watchCandidate.breakoutLevel)}, invalidation ${fmtPrice(watchCandidate.invalidation)}.`, [ref('candidateSetups', watchCandidate.timeframe)]));
    }
    addContext({ direction: watchCandidate ? watchCandidate.direction : null, candidate: watchCandidate, plan: null });
    return finish('WATCH', 'need_confirmed_flag_plan');
  }

  const planCandidate = findCandidate(flagTradePlan.candidateId);
  factorStates.push(factor('trade_readiness', flagTradePlan.status, `Plan status is ${flagTradePlan.status}${flagTradePlan.reasonCode ? ` (${flagTradePlan.reasonCode})` : ''}.`, [ref('flagTradePlan.status'), ref('flagTradePlan.reasonCode')], flagTradePlan.status === 'ready' ? 'support' : 'against'));

  if (flagTradePlan.reasonCode === 'missing_data' || flagTradePlan.reasonCode === 'stale_data') {
    unknowns.push(reason(flagTradePlan.reasonCode, `The selected flag plan is ${flagTradePlan.reasonCode}; the engine will not infer missing or stale candle data.`, [ref('flagTradePlan.reasonCode')]));
    changeConditions.push(reason('fresh_closed_candles', 'Refresh the required closed candles and rebuild the plan.', [ref('flagTradePlan')]));
    addContext({ direction: null, candidate: null, plan: null });
    return finish('DATA_UNAVAILABLE', flagTradePlan.reasonCode);
  }

  if (flagTradePlan.status === 'rejected') {
    // T6 phase 1: net_rr_below_min/stop_inside_costs follow the same hard-rejection
    // mapping as the gross rr_below_min gate (owner decision D1, variant V1c) - a
    // fee-rejected plan is BAD, not DATA_UNAVAILABLE.
    const hardBad = ['invalid_levels', 'chase', 'room_at_entry', 'stop_distance_exceeds_cap', 'rr_below_min', 'net_rr_below_min', 'stop_inside_costs'];
    if (hardBad.includes(flagTradePlan.reasonCode)) {
      const netCodes = ['net_rr_below_min', 'stop_inside_costs'];
      const rrText = flagTradePlan.reasonCode === 'rr_below_min'
        ? `The engine rejected the flag plan: gross R:R to TP1 is ${flagTradePlan.grossRR ?? 'unavailable'}, below the ${minRR}R floor.`
        : netCodes.includes(flagTradePlan.reasonCode)
          ? `The engine rejected the flag plan: net R:R after fees is ${flagTradePlan.netRR ?? 'unavailable'}, below the ${minNetRR ?? 'n/a'}R floor${isFiniteNumber(flagTradePlan.costR) ? ` (round-trip cost is ${flagTradePlan.costR}R of this stop's risk)` : ''}.`
          : `The engine rejected the flag plan: ${flagTradePlan.reasonCode}.`;
      const rrRefs = flagTradePlan.reasonCode === 'rr_below_min' ? [ref('flagTradePlan.reasonCode'), ref('flagTradePlan.grossRR')]
        : netCodes.includes(flagTradePlan.reasonCode) ? [ref('flagTradePlan.reasonCode'), ref('flagTradePlan.netRR'), ref('flagTradePlan.costR')]
          : [ref('flagTradePlan.reasonCode')];
      // The disqualifying reason is always opposes[0]; the context block follows it.
      opposes.push(reason(flagTradePlan.reasonCode, rrText, rrRefs));
      const maxStopPct = ENGINE_CONFIG.scalp ? ENGINE_CONFIG.scalp.maxStopDistancePct : 3;
      changeConditions.push(reason('new_valid_plan', rejectionRemedyText(flagTradePlan, minRR, maxStopPct, minNetRR), [ref('flagTradePlan')]));
      addContext({ direction: flagTradePlan.direction, candidate: planCandidate, plan: flagTradePlan });
      return finish('BAD', flagTradePlan.reasonCode);
    }
    unknowns.push(reason('unclassified_rejection', `The engine rejected the plan with ${flagTradePlan.reasonCode || 'no reason code'}.`, [ref('flagTradePlan.reasonCode')]));
    return finish('DATA_UNAVAILABLE', 'unclassified_rejection');
  }

  // Ready or conditional from here: gross R:R already met the floor in the engine.
  if (isFiniteNumber(flagTradePlan.grossRR)) {
    supports.push(reason('rr_ok', `Gross R:R to TP1 is ${flagTradePlan.grossRR}, meeting the ${minRR}R floor.`, [ref('flagTradePlan.grossRR')]));
  }
  // net_rr_ok / net_rr_low (T6 phase 1 owner decision D1; thresholds revised 2026-09-24,
  // owner decision "D-variant revised" - docs/OWNER_DECISIONS_2026-09-24.md, supersedes
  // D-variant, minRR 2.5 live/net gate off). When the net gate is on (minNetRR set - a
  // research override only, production ships with it off), a plan that reached here
  // already cleared it in the engine - this is confirmation, not a new check. When it's
  // off (null, the shipped default), net R:R is purely informational against a fixed
  // 1.0R "thin after fees" floor unrelated to minRR/minNetRR - a non-blocking oppose,
  // never BAD, never gates the class.
  if (isFiniteNumber(minNetRR)) {
    if (isFiniteNumber(flagTradePlan.netRR) && flagTradePlan.netRR >= minNetRR) {
      supports.push(reason('net_rr_ok', `Net R:R after fees is ${flagTradePlan.netRR}, meeting the ${minNetRR}R floor.`, [ref('flagTradePlan.netRR')]));
    } else {
      opposes.push(reason('fees_heavy', `Net R:R after fees is ${flagTradePlan.netRR ?? 'unavailable'}; fees eat the edge.`, [ref('flagTradePlan.netRR')]));
    }
  } else if (isFiniteNumber(flagTradePlan.netRR) && flagTradePlan.netRR >= NET_RR_LOW_THRESHOLD) {
    supports.push(reason('net_rr_ok', `Net R:R after fees is ${flagTradePlan.netRR}.`, [ref('flagTradePlan.netRR')]));
  } else {
    opposes.push(reason('net_rr_low', `Net R:R after fees is ${flagTradePlan.netRR ?? 'unavailable'}; thin after fees.`, [ref('flagTradePlan.netRR')]));
  }

  if (flagTradePlan.status === 'conditional') {
    supports.push(reason('valid_conditional_plan', `The engine has a valid conditional ${flagTradePlan.direction} flag plan with TP1 ${flagTradePlan.tp1}, gross R:R ${flagTradePlan.grossRR} and net R:R ${flagTradePlan.netRR}.`, [ref('flagTradePlan')]));
    changeConditions.push(reason('entry_condition', flagTradePlan.entryCondition || 'The published entry condition must be observed on a closed candle.', [ref('flagTradePlan.entryCondition')]));
    addContext({ direction: flagTradePlan.direction, candidate: planCandidate, plan: flagTradePlan });
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

  addContext({ direction: flagTradePlan.direction, candidate: planCandidate, plan: flagTradePlan });

  changeConditions.push(reason('call_changes_on_invalidation', `Call changes if price invalidates the plan at ${flagTradePlan.stop}, TP1 becomes blocked below ${minRR}R gross, or required data goes stale.`, [ref('flagTradePlan.stop'), ref('flagTradePlan.grossRR')]));

  const scored = scoreContext({ plan: flagTradePlan, evidence: ev, cfg });
  factorStates.push(factor('quality_score', scored.points, `Quality score is ${scored.points}/100 from deterministic context weights, not win odds.`, [ref('model.decisionWeights', null, 'config')], 'context'));
  for (const item of scored.contributions) factorStates.push(factor(`score_${item.code}`, item.points, `${item.code} contributes ${item.points}/${item.max}.`, [ref('model.decisionWeights', null, 'config')], 'context'));

  return finish('GOOD', 'ready_flag_plan', scored);

  /**
   * Phase 2 context block: top-down, EMA200 count and side, 4h lean, first level ahead on
   * the candidate's own geometry timeframe, TP1 cap, divergence, freshness. Supports /
   * opposes / unknowns only - never changes the class (alignment, EMA200 and divergence
   * never veto; an unknown never improves anything). Undirected (no candidate) context
   * is cited as unknown.
   */
  function addContext({ direction, candidate, plan }) {
    const dir = direction === 'long' || direction === 'short' ? direction : null;
    const dirSent = dir ? directionSentiment(dir) : null;
    const place = (sign) => (sign === 'support' ? supports : sign === 'oppose' ? opposes : unknowns);
    const tf = candidate ? candidate.timeframe : (plan ? plan.timeframe : null);

    // Top-down alignment.
    if (!topDown) {
      unknowns.push(reason('td:unknown', 'Top-down sentiment is unavailable.', [ref('topDown')]));
    } else {
      const code = `td:${topDown.sentiment}:${topDown.aligned}/4`;
      const sign = !dir ? 'unknown' : (topDown.sentiment === dirSent ? 'support' : 'oppose');
      place(sign).push(reason(code, `Top-down sentiment is ${topDown.sentiment} with ${topDown.aligned}/4 aligned${dir ? ` for a ${dir}` : ''}; alignment is confidence, not a veto.`, [ref('topDown')]));
    }

    // EMA200 count across timeframes.
    const a200 = topDown && topDown.above200 ? topDown.above200 : null;
    if (!a200 || !isFiniteNumber(a200.count) || !isFiniteNumber(a200.of) || a200.of === 0) {
      unknowns.push(reason('a200:unknown', 'EMA200 count is unavailable.', [ref('topDown.above200')]));
    } else {
      const withCount = dir === 'short' ? a200.of - a200.count : a200.count;
      const sign = !dir || withCount * 2 === a200.of ? 'unknown' : (withCount * 2 > a200.of ? 'support' : 'oppose');
      place(sign).push(reason(`a200:${a200.count}/${a200.of}`, `Price is above EMA200 on ${a200.count} of ${a200.of} timeframes; EMA200 is context, not a filter.`, [ref('topDown.above200')]));
    }

    // EMA200 side of the candidate's own timeframe.
    if (tf) {
      const maItem = ev.ma && ev.ma.map ? ev.ma.map[tf] : null;
      const side = candidate && candidate.ema200Side ? candidate.ema200Side : (maItem ? maItem.priceVsEma200 : null);
      const known = side === 'above' || side === 'below';
      const sign = !dir || !known ? 'unknown' : ((dir === 'long') === (side === 'above') ? 'support' : 'oppose');
      place(sign).push(reason(`ema200:${tf}:${known ? side : 'unknown'}`, `${tf} price is ${known ? side : 'unknown vs'} EMA200; context, not a veto.`, [ref(`candidateSetups.ema200Side`, tf)]));
    }

    // Weekly EMA200 is never guessed.
    const weekly = topDown && topDown.weekly ? topDown.weekly : null;
    if (weekly && !isFiniteNumber(weekly.ema200)) {
      unknowns.push(reason('ema200:1w:missing', `Weekly EMA200 is unavailable (${weekly.reason || 'insufficient weekly history'}).`, [ref('topDown.weekly')]));
    }

    // 4h lean vs direction.
    const lean4h = topDown && topDown.leans ? topDown.leans['4h'] : null;
    if (!lean4h) {
      unknowns.push(reason('4h:unknown', '4h lean is unavailable.', [ref('topDown.leans.4h')]));
    } else if (!dir || lean4h === 'neutral') {
      unknowns.push(reason(`4h:${lean4h === 'neutral' ? 'flat' : lean4h}`, `4h lean is ${lean4h}.`, [ref('topDown.leans.4h')]));
    } else if (lean4h === dirSent) {
      supports.push(reason('4h:with', `4h lean is ${lean4h}, with the ${dir}.`, [ref('topDown.leans.4h')]));
    } else {
      opposes.push(reason('ct:4h', `4h lean is ${lean4h}, against the ${dir}; context, not a veto.`, [ref('topDown.leans.4h')]));
    }

    // Candidate qualification risks already computed (conflict / stoch exhaustion / R:R).
    if (candidate && candidate.qual && Array.isArray(candidate.qual.reasons)) {
      for (const code of candidate.qual.reasons) {
        if (/^(conflict:|stoch:|rr:)/.test(code) && !opposes.some((r) => r.code === code)) {
          opposes.push(reason(code, `Candidate qualification: ${code}.`, [ref('candidateSetups.qual.reasons', tf)]));
        }
      }
    }

    // First level ahead beyond the breakout on the candidate's own geometry timeframe.
    if (dir && tf) {
      const entry = plan && isFiniteNumber(plan.entry) ? plan.entry : (candidate && isFiniteNumber(candidate.breakoutLevel) ? candidate.breakoutLevel : null);
      const target = candidate && isFiniteNumber(candidate.measuredTarget)
        ? candidate.measuredTarget
        : (plan ? (isFiniteNumber(plan.tp2) ? plan.tp2 : plan.tp1) : null);
      const gtf = geometryTimeframeFor(tf);
      const g = gtf && geometryContext ? geometryContext[gtf] : null;
      const first = g && isFiniteNumber(entry) ? levelsAhead({ direction: dir, price: entry, geometryContext: { [gtf]: g } })[0] : null;
      if (!first) {
        unknowns.push(reason('level:none', `No ${gtf || 'geometry'} level detected beyond the breakout${isFiniteNumber(entry) ? ` ${fmtPrice(entry)}` : ''}.`, [ref('geometryContext', gtf)]));
      } else {
        const sign = dir === 'short' ? -1 : 1;
        const blocks = isFiniteNumber(target) && sign * (target - first.price) > 0;
        (blocks ? opposes : supports).push(reason(`level:${gtf}:${first.price}`, `First ${gtf} ${first.kind} beyond breakout ${fmtPrice(entry)} is ${fmtPrice(first.price)}, ${blocks ? 'before' : 'beyond'} the measured target ${fmtPrice(target)}.`, [ref('geometryContext', gtf)]));
      }
    }

    // Channel-edge breakout risk on the same geometry timeframe (M-4). Only medium/high
    // risk is cited; a low-risk or absent channel adds nothing.
    if (dir && tf) {
      const gtf = geometryTimeframeFor(tf);
      const g = gtf && geometryContext ? geometryContext[gtf] : null;
      const ch = g && g.channel ? buildChannelEvidence({ direction: dir, price: null, geometryContext: { [gtf]: g }, topDown, cfg }).channels[gtf] : null;
      if (ch && (ch.breakoutRisk === 'high' || ch.breakoutRisk === 'medium')) {
        // At the fade edge (short at top, long at bottom) a break runs over the trade; at
        // the break edge a likely break is the trade's own continuation, a medium one is a
        // rejection risk nobody can call yet.
        const fade = (dir === 'short' && ch.edge === 'top') || (dir === 'long' && ch.edge === 'bottom');
        const sign = fade ? 'oppose' : (ch.breakoutRisk === 'high' ? 'support' : 'unknown');
        const text = fade
          ? `Fade at the ${gtf} channel ${ch.edge} (${ch.positionPct}%): ${ch.breakoutRisk} risk the channel breaks through against the ${dir}.`
          : `At the ${gtf} channel ${ch.edge} (${ch.positionPct}%): ${ch.breakoutRisk} breakout odds for the ${dir}; rejection is the risk.`;
        place(sign).push(reason(`chan:${gtf}:${ch.edge}:${ch.breakoutRisk}`, text, [ref('geometryContext.channel', gtf)]));
      }
    }

    // TP1 capped before the measured move by an earlier level.
    if (plan && isFiniteNumber(plan.tp1) && isFiniteNumber(plan.tp2)) {
      opposes.push(reason(`tp1_capped:${plan.tp1}`, `TP1 is capped at ${fmtPrice(plan.tp1)} by a level before the measured target ${fmtPrice(plan.tp2)}.`, [ref('flagTradePlan.tp1'), ref('flagTradePlan.tp2')]));
    }

    // Stoch RSI divergence (M-7): confirmation or conflict, never a veto.
    const div = ev.divergence && ev.divergence.confluence ? ev.divergence.confluence : null;
    if (!div) {
      unknowns.push(reason('divergence_missing', 'Stoch RSI divergence could not be evaluated.', [ref('model.divergence')]));
    } else if (!dir) {
      unknowns.push(reason('divergence_undirected', `Divergence: ${div.bullish || 0} bullish, ${div.bearish || 0} bearish timeframe(s); no candidate direction to compare.`, [ref('model.divergence')]));
    } else {
      const agree = dir === 'short' ? div.bearish : div.bullish;
      const conflict = dir === 'short' ? div.bullish : div.bearish;
      if (agree > 0) supports.push(reason('divergence_agrees', `${agree} timeframe(s) show ${dir === 'short' ? 'bearish' : 'bullish'} Stoch RSI divergence.`, [ref('model.divergence')]));
      if (conflict > 0) opposes.push(reason('divergence_conflicts', `${conflict} timeframe(s) show ${oppositeDirection(dir)} divergence against the setup.`, [ref('model.divergence')]));
      if (!(agree > 0) && !(conflict > 0)) unknowns.push(reason('divergence_absent', 'No confirming or opposing Stoch RSI divergence was detected.', [ref('model.divergence')]));
    }

    // Data freshness (only when the flag-timeframe freshness inputs were supplied).
    if (flagFreshness) {
      if (gaps.length > 0) {
        if (!unknowns.some((u) => /^(stale|missing)_data:/.test(u.code))) {
          unknowns.push(reason(`data_stale:${gaps.map((x) => x.tf).join('/')}`, `${gaps.map((x) => x.tf).join('/')} closed candles are stale or missing.`, [ref('timeframes')]));
        }
      } else if (dataStatus === 'partial') {
        unknowns.push(reason('data_partial', 'Some timeframes are unavailable; flag timeframes are fresh.', [ref('dataStatus')]));
      } else {
        supports.push(reason('data_fresh', `${flagFreshness.map((x) => x.tf).join('/')} closed candles are fresh.`, [ref('timeframes')]));
      }
    }
  }

  /**
   * Delivery pass (schema 1.25.0): the readiness call, derived only from fields already
   * computed above - never a new gate, never changes the class.
   *   GOOD -> GET IN NOW (etaMin 0, at asOf)
   *   conditional live plan, else a SETUP -> BE READY (eta to that timeframe's next close,
   *     note = the trigger sentence)
   *   WATCH with a forming/triggering candidate -> WAIT (eta to its next close, note =
   *     the change condition)
   *   anything else (BAD with no setup, DATA_UNAVAILABLE, WATCH with nothing forming) ->
   *     STAND DOWN (etaMin/at null)
   */
  function buildAction(klass, setup) {
    const firstChange = changeConditions[0] ? changeConditions[0].text : null;
    const standDown = (note) => ({ call: 'STAND DOWN', etaMin: null, at: null, note: note || null });
    if (klass === 'DATA_UNAVAILABLE') return standDown(firstChange || (unknowns[0] ? unknowns[0].text : null));
    if (klass === 'GOOD' && flagTradePlan) {
      return { call: 'GET IN NOW', etaMin: 0, at: asOf || null, note: `${flagTradePlan.timeframe} ${flagTradePlan.direction} ready: entry ${fmtPrice(flagTradePlan.entry)}, stop ${fmtPrice(flagTradePlan.stop)}, TP1 ${fmtPrice(flagTradePlan.tp1)}` };
    }
    if (flagTradePlan && flagTradePlan.status === 'conditional') {
      return { call: 'BE READY', ...nextCloseEta(asOf, flagTradePlan.timeframe), note: flagTradePlan.entryCondition || firstChange };
    }
    if (setup) return { call: 'BE READY', ...nextCloseEta(asOf, setup.timeframe), note: setup.entryCondition || null };
    if (klass === 'WATCH' && watchCandidate && (watchCandidate.state === 'forming' || watchCandidate.state === 'triggering')) {
      return { call: 'WAIT', ...nextCloseEta(asOf, watchCandidate.timeframe), note: firstChange };
    }
    return standDown(firstChange);
  }

  /** Room for the live valid plan, else the SETUP, else a rejected plan that has levels. */
  function buildRoom(setup) {
    const p = flagTradePlan;
    if (p && (p.status === 'ready' || p.status === 'conditional')) return roomAhead(p, geometryContext);
    if (setup) return roomAhead(setup, geometryContext);
    if (p && p.status === 'rejected' && p.reasonCode !== 'stale_data' && p.reasonCode !== 'missing_data') return roomAhead(p, geometryContext);
    return null;
  }

  function finish(klass, primaryCode, scored = null) {
    const primaryReason = [...supports, ...opposes, ...unknowns, ...changeConditions].find((r) => r.code === primaryCode)
      || reason(primaryCode, primaryCode, []);
    const setup = flagTradePlan ? flagTradePlan.setup ?? null : null;
    // Alert clarity subject: the plan's candidate, else the SETUP's, else the WATCH candidate.
    const subject = klass === 'DATA_UNAVAILABLE' ? null
      : ((flagTradePlan && findCandidate(flagTradePlan.candidateId)) || (setup && findCandidate(setup.candidateId)) || watchCandidate);
    return {
      class: klass,
      setupId: flagTradePlan ? flagTradePlan.planId : null,
      candidateId: flagTradePlan ? flagTradePlan.candidateId : null,
      candidate: candidateSummary(watchCandidate),
      asOf,
      primaryReason,
      supports,
      opposes,
      unknowns,
      changeConditions,
      factorStates,
      qualityBand: scored ? qualityBand(scored.points) : null,
      readiness: flagTradePlan ? flagTradePlan.status : 'no_plan',
      // SETUP tier (T6 completion plan C2): copied straight through from
      // flagTradePlan.setup (lib/flagTradePlan.js computes it - the best still-
      // conditional attempt in the pool, distinct from this record's own class/plan).
      // Never recomputed here, never influences class/primaryReason/supports/opposes.
      setup,
      action: buildAction(klass, setup),
      room: klass === 'DATA_UNAVAILABLE' ? null : buildRoom(setup),
      clarity: subject ? buildClarity({ candidate: subject, topDown, divergence: ev.divergence && ev.divergence.confluence ? ev.divergence.confluence : null, geometryContext, minRR }) : null,
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
    candidate: full.candidate === undefined ? null : full.candidate,
    asOf: full.asOf,
    primaryReason: full.primaryReason ? { code: full.primaryReason.code, text: full.primaryReason.text } : null,
    readiness: full.readiness,
    setup: full.setup ?? null,
    action: full.action ?? null,
    room: full.room ?? null,
    clarity: full.clarity ?? null,
    qualityBand: full.qualityBand,
    policyVersion: full.policyVersion,
    supports: codes(full.supports),
    opposes: codes(full.opposes),
    unknowns: codes(full.unknowns),
    changeConditions: (full.changeConditions || []).map((r) => ({ code: r.code, text: r.text })),
    trace: full.trace
  };
}

export default { buildFlagRecommendation, compactRecommendation, selectWatchCandidate, nextCloseEta, roomAhead, buildClarity, qualWords };
