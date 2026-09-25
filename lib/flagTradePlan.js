/**
 * Engine-owned flag trade plan (signal-reliability minimum plan, work package 2).
 *
 * A flag candidate (`candidateSetups[]`) is an observation; `qual.actionable`/
 * `qual.decision` are labels, not a trade. This module is the one place that turns an
 * existing confirmed directional flag candidate into a single, reproducible trade call
 * - exact entry condition, final entry/stop/TP1(/TP2), gross R:R and net R:R after fees
 * (both gates: gross `flagPlan.minRR`, then net `flagPlan.minNetRR` - T6 phase 1, owner
 * decision D1, config 2026.09.24-3), `costR` (round-trip cost as a fraction of gross
 * risk), and an explicit ready/conditional/rejected status with a stable reason code.
 * It never adds
 * a detection signal, never widens a stop to pass a test, and never touches
 * `strategies.*`/`bestSignal` (see services/scalpContext.js, wired in after candidate
 * qualification, before decisionTrace).
 *
 * Entry model: the published entry is the candidate's own (already geometry-snapped)
 * `breakoutLevel`, read as a breakout-retest-hold trigger - not the live market price,
 * which would make the plan different on every request for the same candidate. `ready`
 * means an earlier closed candle closed through the breakout level and the latest
 * closed candle retested it within the configured ATR tolerance and closed on the hold
 * side (observeRetestHold); `conditional` means that sequence has not been observed.
 * Repricing is the engine's job on the next request - never the GPT's. See `docs/GPT_INSTRUCTIONS.md`.
 *
 * Candidate pool: only `type: 'flag'` (never `coil`, which is direction-neutral) and
 * `state: 'confirmed'` (proto/forming/triggering have no break to enter on yet;
 * failed/expired have nothing left to enter). A `chaseRisk: true` confirmed candidate
 * IS considered (so its rejection is explicit and visible), it just cannot pass.
 *
 * 4h-flat policy (work package 2, item 5, owner's written model): the 4h lean is
 * context elsewhere (`qual.reasons` already carries `ct:4h` on the candidate itself),
 * never a gate here. A flat or counter-trend 4h bias does not change this module's
 * ready/conditional/rejected verdict; `strategies.*`/`bestSignal` (which DO gate on 4h
 * flat, services/strategy.js) are read nowhere in this file and stay byte-identical.
 */

import { ENGINE_CONFIG } from '../config/engine.js';
import { assessFreshnessAll } from './freshness.js';
import { geometryTimeframeFor } from './patternLifecycle.js';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// 84466.1 -> "84,466.10" (same text as lib/flagRecommendation.js's chase remedy).
function fmtPrice(value) {
  if (!isFiniteNumber(value)) return 'n/a';
  const [int, dec] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Higher timeframe ranks higher in selection (item 2: "higher candidate timeframe").
// 15m/1h are ranked ahead of 5m for forward-compatibility (T6 completion plan C4) -
// inert today since config.flag.timeframes stays [1m,3m,5m] (V1c, not V-C's widening;
// see docs/OWNER_DECISIONS_2026-09-24.md D-variant) - so neither ever appears in the
// candidate pool this ranks. Ready the moment that config changes, no code change needed.
const FLAG_TF_RANK = { '1m': 0, '3m': 1, '5m': 2, '15m': 3, '1h': 4 };

/**
 * The nearest horizontal-zone edge strictly ahead of `entry`, short of `measuredTarget`,
 * in the candidate's own direction, plus whether any zone overlaps `entry` itself.
 * Mirrors lib/candidateQualifier.js's roomBlockedReasons boolean check, but returns the
 * capping price instead of just a flag - this module needs the number, not a label.
 *
 * Owner decision 2026-09-24 item 4b (`docs/OWNER_DECISIONS_2026-09-24.md`): the two
 * reads are scoped differently on purpose. `touchesEntry` (a hard `room_at_entry`
 * rejection) reads only `ownGeometry` - the candidate's own mapped geometry timeframe
 * (`geometryTimeframeFor(candidate.timeframe)`), same scoping as decision 4a's
 * `room:blocked` - so a zone on a farther timeframe can never reject a 1m/3m/5m flag's
 * plan outright. `nearestEdge` (the TP1 cap) keeps scanning every timeframe in
 * `geometryContext`, unchanged: a 4h level ahead is exactly the kind of major S/R level
 * the owner's "major S/R overrides" rule means to cap a target at.
 * @param {'long'|'short'} direction
 * @param {number} entry
 * @param {number} measuredTarget
 * @param {Object|null} geometryContext - the symbol's geometryContext (all timeframes) - feeds nearestEdge only
 * @param {Object|null} ownGeometry - geometryContext[geometryTimeframeFor(candidate.timeframe)] - feeds touchesEntry only
 * @returns {{touchesEntry:boolean, nearestEdge:number|null}}
 */
function nearestRoomAhead(direction, entry, measuredTarget, geometryContext, ownGeometry) {
  const sign = direction === 'short' ? -1 : 1;
  const orientedEntry = sign * entry;
  const orientedTarget = sign * measuredTarget;
  let nearestOriented = null;

  for (const g of Object.values(geometryContext || {})) {
    if (!g) continue;
    const zones = direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones;
    if (!Array.isArray(zones)) continue;
    for (const z of zones) {
      if (!isFiniteNumber(z.low) || !isFiniteNumber(z.high)) continue;
      const near = direction === 'long' ? z.low : z.high; // edge facing price from entry
      const orientedNear = sign * near;
      if (orientedNear > orientedEntry && orientedNear < orientedTarget) {
        if (nearestOriented === null || orientedNear < nearestOriented) nearestOriented = orientedNear;
      }
    }
  }

  let touchesEntry = false;
  if (ownGeometry) {
    const ownZones = direction === 'long' ? ownGeometry.horizontalResistanceZones : ownGeometry.horizontalSupportZones;
    if (Array.isArray(ownZones)) {
      touchesEntry = ownZones.some((z) => isFiniteNumber(z.low) && isFiniteNumber(z.high) && z.low <= entry && z.high >= entry);
    }
  }

  return { touchesEntry, nearestEdge: nearestOriented === null ? null : sign * nearestOriented };
}

/**
 * Round-trip cost as a fraction of entry: `costBpsByDirection[direction] / 10000` when
 * `direction` is `'long'`/`'short'` and that key is a finite number (T6 completion plan
 * C1, D-cost decision, `docs/OWNER_DECISIONS_2026-09-24.md` - positions are funded from
 * USDC/USDT, so a long pays the extra swap in/out (34 bps) and a short does not (14
 * bps), already round-trip figures, not doubled again); else the legacy flat
 * `2 * (feeBps + slippageBps) / 10000` (the shipped 20 bps fallback, and the only path
 * a caller that never passes `direction` - `scripts/tracker/breakout-entry.js`'s
 * vendored copy, frozen since T6 completion plan A1 - ever takes, so that vendored
 * copy's parity test is unaffected by this addition).
 * @param {{feeBps:number, slippageBps:number, costBpsByDirection?:{long?:number, short?:number}}} riskCfg
 * @param {'long'|'short'|null|undefined} [direction]
 * @returns {number}
 */
function roundTripCostPctFor(riskCfg, direction) {
  const byDir = riskCfg && riskCfg.costBpsByDirection;
  const dirBps = byDir && (direction === 'long' || direction === 'short') && isFiniteNumber(byDir[direction]) ? byDir[direction] : null;
  return dirBps !== null ? dirBps / 10000 : (2 * ((riskCfg.feeBps || 0) + (riskCfg.slippageBps || 0))) / 10000;
}

/**
 * Round-trip fee+slippage cost, in R (a fraction of gross risk): the same cost amount
 * `netRiskReward` (below) charges against the gross risk/reward, expressed as
 * `cost / |entry - stop|` instead of folded into a ratio. Mirrors
 * `scripts/tracker/costs.js`'s `costR` (which computes it from a resolved trade's own
 * entry/stop) - this is the engine's own copy for a plan not yet resolved. T6 phase 1:
 * published on every plan once entry/stop are known, and drives `stop_inside_costs`
 * (costR >= 0.5) vs the plainer `net_rr_below_min`. T6 completion plan C1: direction-
 * dependent when `direction` and `riskCfg.costBpsByDirection` are both given (see
 * `roundTripCostPctFor`); omit `direction` for the legacy flat cost.
 * @param {number} entry
 * @param {number} stop
 * @param {{feeBps:number, slippageBps:number}} riskCfg
 * @param {'long'|'short'|null|undefined} [direction]
 * @returns {number|null}
 */
export function costRFraction(entry, stop, riskCfg, direction) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || entry <= 0) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return roundN((entry * roundTripCostPctFor(riskCfg, direction)) / risk, 3);
}

/**
 * Net-of-fees R:R for one leg: round-trip cost (one fill in, one fill out) is charged
 * against the reward and added to the risk, both as a fraction of `entry`. Never
 * adjusts `entry` or `stop` themselves - "never move the stop closer simply to pass
 * either test" (work package 2, item 4). T6 completion plan C1: direction-dependent
 * when `direction` and `riskCfg.costBpsByDirection` are both given; omit `direction`
 * for the legacy flat `feeBps`+`slippageBps` cost (see `roundTripCostPctFor`).
 *
 * Exported (T4 P4, docs/PLAN_FLAG_PATHS.md) so `scripts/tracker/breakout-entry.js` can
 * keep a byte-for-byte vendored copy (it cannot import `lib/`) and a parity test can
 * prove it has not drifted - same precedent as `observeRetestHold` below and
 * `scripts/tracker/flag-paths.js`'s vendored copy of it. That vendored copy never
 * passes `direction`, so it always takes the flat-cost branch, unchanged by this
 * addition - the parity test still holds.
 * @param {number} entry
 * @param {number} stop
 * @param {number} target
 * @param {{feeBps:number, slippageBps:number}} riskCfg
 * @param {'long'|'short'|null|undefined} [direction]
 * @returns {number|null}
 */
export function netRiskReward(entry, stop, target, riskCfg, direction) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(target) || entry <= 0) return null;
  const grossRisk = Math.abs(entry - stop);
  const grossReward = Math.abs(target - entry);
  if (grossRisk <= 0 || grossReward <= 0) return null;

  const costAmount = entry * roundTripCostPctFor(riskCfg, direction);

  const netRisk = grossRisk + costAmount;
  const netReward = grossReward - costAmount;
  if (netRisk <= 0 || netReward <= 0) return null;
  return netReward / netRisk;
}

/**
 * Closed-candle breakout-retest-hold check (review fix 1). `ready` only when BOTH were
 * observed in order on the candidate's own timeframe:
 *   (a) an earlier closed candle closed through the breakout level (above for a long,
 *       below for a short), then
 *   (b) a later closed candle's low (high for a short) reached the level within
 *       `toleranceAtr` ATR and closed on the hold side (at/above for a long, at/below for
 *       a short), and the latest close is still on the hold side.
 * No close through the level yet -> `awaiting_breakout`; closed through but no retest-hold
 * seen yet, or the latest close fell back through the level -> `awaiting_retest`. Without candles the sequence cannot
 * be observed, so the result is never `ready`.
 * T6 completion plan A3 (docs/PLAN_T6_COMPLETION_V2.md): a retest candle whose wick
 * reaches through the STOP (`low <= stop` for a long, `high >= stop` for a short) before
 * closing back on the hold side is not a valid hold - in a live position that wick would
 * have triggered the stop loss already, so crediting it as "held" would call a plan
 * `ready` off a candle that would have stopped the trade out. Checked independently of
 * the entry-side reached/held checks below (a retest candle can be malformed in either
 * direction: never reaching entry, or reaching entry but also breaching the stop).
 * @param {Object} p
 * @param {'long'|'short'} p.direction
 * @param {number} p.entry
 * @param {number} p.stop - the plan's own invalidation; a retest candle that wicks past
 *   it is disqualified regardless of where it closed.
 * @param {Array<{timestamp:number, high:number, low:number, close:number}>|null} p.candles - ascending closed candles
 * @param {number|null} p.fromMs - ignore candles opening before this (flag start)
 * @param {number|null} p.currentPrice
 * @param {number|null} p.atrValue
 * @param {number} p.toleranceAtr
 * @returns {{status:'ready'|'conditional', reasonCode:string|null}}
 */
export function observeRetestHold({ direction, entry, stop, candles, fromMs, currentPrice, atrValue, toleranceAtr }) {
  const sign = direction === 'short' ? -1 : 1;
  const closedThrough = (c) => isFiniteNumber(c.close) && sign * (c.close - entry) > 0;

  if (!Array.isArray(candles) || candles.length < 2 || !isFiniteNumber(atrValue) || atrValue <= 0) {
    const through = isFiniteNumber(currentPrice) && sign * (currentPrice - entry) > 0;
    return { status: 'conditional', reasonCode: through ? 'awaiting_retest' : 'awaiting_breakout' };
  }

  const windowed = isFiniteNumber(fromMs) ? candles.filter((c) => !isFiniteNumber(c.timestamp) || c.timestamp >= fromMs) : candles;
  const last = windowed.length ? windowed[windowed.length - 1] : null;
  const breakoutIdx = windowed.findIndex(closedThrough);
  if (breakoutIdx === -1) return { status: 'conditional', reasonCode: 'awaiting_breakout' };
  if (!last || breakoutIdx >= windowed.length - 1) return { status: 'conditional', reasonCode: 'awaiting_retest' };

  // Any closed candle after the breakout that reached the level, closed on the hold
  // side, and never wicked through the stop is the observed retest-hold. It does not
  // have to be the latest close: once seen, the plan stays ready while the latest close
  // is still on the hold side (chase risk is the candidate's own field, checked
  // separately). A later close back through the level returns the plan to awaiting_retest.
  const tolerance = toleranceAtr * atrValue;
  const stopBreached = (c) => isFiniteNumber(stop) && (direction === 'short' ? c.high >= stop : c.low <= stop);
  const isRetestHold = (c) => {
    const reached = direction === 'short' ? c.high >= entry - tolerance : c.low <= entry + tolerance;
    const held = isFiniteNumber(c.close) && sign * (c.close - entry) >= 0;
    return reached && held && !stopBreached(c);
  };
  const retestIdx = windowed.findIndex((c, i) => i > breakoutIdx && isRetestHold(c));
  const lastHeld = isFiniteNumber(last.close) && sign * (last.close - entry) >= 0;
  if (retestIdx !== -1 && lastHeld) return { status: 'ready', reasonCode: null };
  return { status: 'conditional', reasonCode: 'awaiting_retest' };
}

/**
 * Build one candidate's plan attempt: always returns a verdict (never skips a
 * confirmed flag silently), so a rejection is explicit rather than an absence.
 * @param {Object} candidate - a finalized (snapped, qualified) candidateSetups entry
 * @param {Object} ctx
 * @param {Object|null} ctx.geometryContext
 * @param {number|null} ctx.currentPrice - candidate.timeframe's latest close
 * @param {number|null} ctx.atrValue - candidate.timeframe's ATR
 * @param {Array<Object>|null} ctx.candles - candidate.timeframe's closed candles (ascending)
 * @param {string|null} ctx.ownClosedThroughIso
 * @param {Array<{tf:string, closedThroughIso:string|null, intervalMs:number}>} ctx.geometryFreshnessReqs -
 *   one entry per geometry timeframe that can feed the TP1 cap (nearestRoomAhead reads
 *   all of them, not just the one candidate.timeframe borrows) - all must be fresh.
 * @param {number} ctx.intervalMs - INTERVAL_MS[candidate.timeframe]
 * @param {number} ctx.now
 * @param {Object} [cfg=ENGINE_CONFIG]
 * @returns {Object} a plan attempt (see buildFlagTradePlan for the published shape)
 */
function buildPlanAttempt(candidate, ctx, cfg = ENGINE_CONFIG) {
  const { geometryContext, currentPrice, atrValue, candles, ownClosedThroughIso, geometryFreshnessReqs, intervalMs, now } = ctx;
  const firstDetectedMs = typeof candidate.firstDetectedAt === 'string' ? Date.parse(candidate.firstDetectedAt) : NaN;
  // The flag's own first candle opens one interval before firstDetectedAt (a close time);
  // no earlier candle (e.g. the impulse leg) may count as the breakout close.
  const fromMs = isFiniteNumber(firstDetectedMs) && isFiniteNumber(intervalMs) ? firstDetectedMs - intervalMs : null;
  const direction = candidate.direction;

  // Fixed shape for every attempt regardless of where it stops, so a rejected plan and
  // a ready one are never structurally different objects - only the values differ.
  const shape = {
    candidateId: candidate.candidateId || null,
    timeframe: candidate.timeframe,
    direction,
    confidence: isFiniteNumber(candidate.confidence) ? candidate.confidence : null,
    status: 'rejected',
    reasonCode: null,
    entryType: null,
    entryCondition: null,
    entry: null,
    stop: null,
    tp1: null,
    tp2: null,
    grossRR: null,
    netRR: null,
    costR: null,
    stopDistancePct: null
  };

  const freshness = assessFreshnessAll(
    [{ tf: candidate.timeframe, closedThroughIso: ownClosedThroughIso, intervalMs }, ...geometryFreshnessReqs],
    now,
    cfg.freshness.graceMs
  );
  if (!freshness.fresh) {
    const missing = freshness.reason === 'missing_closed_through' || freshness.reason === 'invalid_closed_through';
    return { ...shape, reasonCode: missing ? 'missing_data' : 'stale_data' };
  }

  const entry = candidate.breakoutLevel;
  const stop = candidate.invalidation;
  const measuredTarget = candidate.measuredTarget;
  const sign = direction === 'short' ? -1 : 1;

  const stopOnRightSide = isFiniteNumber(entry) && isFiniteNumber(stop) && sign * (entry - stop) > 0;
  const targetAhead = isFiniteNumber(entry) && isFiniteNumber(measuredTarget) && sign * (measuredTarget - entry) > 0;
  if (!isFiniteNumber(entry) || !stopOnRightSide || !targetAhead) {
    return { ...shape, reasonCode: 'invalid_levels' };
  }

  if (candidate.chaseRisk === true) {
    return { ...shape, reasonCode: 'chase', entry: roundN(entry, 2), stop: roundN(stop, 2) };
  }

  const ownGeometryTf = geometryTimeframeFor(candidate.timeframe);
  const ownGeometry = ownGeometryTf && geometryContext ? geometryContext[ownGeometryTf] : null;
  const { touchesEntry, nearestEdge } = nearestRoomAhead(direction, entry, measuredTarget, geometryContext, ownGeometry);
  if (touchesEntry) {
    return { ...shape, reasonCode: 'room_at_entry', entry: roundN(entry, 2), stop: roundN(stop, 2) };
  }
  const tp1 = nearestEdge !== null ? nearestEdge : measuredTarget;
  const tp2 = nearestEdge !== null && sign * (measuredTarget - tp1) > 0 ? measuredTarget : null;

  const stopDistancePct = roundN((Math.abs(entry - stop) / entry) * 100, 3);
  if (stopDistancePct === null || stopDistancePct > cfg.scalp.maxStopDistancePct) {
    return { ...shape, reasonCode: 'stop_distance_exceeds_cap', entry: roundN(entry, 2), stop: roundN(stop, 2), tp1: roundN(tp1, 2), stopDistancePct };
  }

  // Owner decision 2026-09-23 (item 1a): the 3R floor is GROSS price R to TP1. Net R
  // after fees is published on every plan from here on, gross-gated or not.
  const grossRR = roundN(Math.abs(tp1 - entry) / Math.abs(entry - stop), 3);
  const netRR = roundN(netRiskReward(entry, stop, tp1, cfg.risk, direction), 3);
  const costR = costRFraction(entry, stop, cfg.risk, direction);
  if (grossRR === null || grossRR < cfg.flagPlan.minRR) {
    return { ...shape, reasonCode: 'rr_below_min', entry: roundN(entry, 2), stop: roundN(stop, 2), tp1: roundN(tp1, 2), tp2: roundN(tp2, 2), stopDistancePct, grossRR, netRR, costR };
  }

  // T6 phase 1 net gate (docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md, owner decision D1 -
  // variant V1c, config 2026.09.24-3): after the gross gate, a plan whose net R:R
  // doesn't clear flagPlan.minNetRR is rejected. `stop_inside_costs` is the more
  // specific code for the "can't pay its own costs" case (the round-trip cost alone is
  // already >= half the position's risk, costR >= 0.5) - the BTC 0.066%-stop case from
  // section 1a (costR ~3.0) is `stop_inside_costs`, not the plainer `net_rr_below_min`.
  // `null` turns the gate off (scripts/replay-rules.js's V0/pre-net-gate variants).
  if (isFiniteNumber(cfg.flagPlan.minNetRR) && (netRR === null || netRR < cfg.flagPlan.minNetRR)) {
    const reasonCode = isFiniteNumber(costR) && costR >= 0.5 ? 'stop_inside_costs' : 'net_rr_below_min';
    return { ...shape, reasonCode, entry: roundN(entry, 2), stop: roundN(stop, 2), tp1: roundN(tp1, 2), tp2: roundN(tp2, 2), stopDistancePct, grossRR, netRR, costR };
  }

  const entryType = 'retest';
  const entryText = roundN(entry, 2);
  const tolAtr = cfg.flagPlan.entryToleranceAtr;
  const entryCondition = direction === 'long'
    ? `a closed candle closes above ${entryText}, then a later closed candle's low reaches within ${tolAtr} ATR of ${entryText} and closes at or above it`
    : `a closed candle closes below ${entryText}, then a later closed candle's high reaches within ${tolAtr} ATR of ${entryText} and closes at or below it`;

  const { status, reasonCode } = observeRetestHold({ direction, entry, stop, candles, fromMs, currentPrice, atrValue, toleranceAtr: tolAtr });

  return {
    ...shape,
    status,
    reasonCode,
    entryType,
    entryCondition,
    entry: roundN(entry, 2),
    stop: roundN(stop, 2),
    tp1: roundN(tp1, 2),
    tp2: roundN(tp2, 2),
    grossRR,
    netRR,
    costR,
    stopDistancePct
  };
}

const STATUS_RANK = { ready: 0, conditional: 1, rejected: 2 };

/**
 * Select the single best plan attempt for a symbol: valid (ready/conditional) before
 * rejected, then highest detector confidence, then higher candidate timeframe, then
 * stable `candidateId` (lexicographic - the id embeds an ISO timestamp, so this is also
 * a deterministic recency order for ties). Never a partial ranking: every comparison
 * has a total order, so the same candidate set always selects the same attempt.
 * @param {Array<Object>} attempts
 * @returns {Object|null}
 */
function selectBest(attempts) {
  if (attempts.length === 0) return null;
  return attempts.slice().sort((a, b) => {
    const statusDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (statusDiff !== 0) return statusDiff;
    const confDiff = (b.confidence ?? -1) - (a.confidence ?? -1);
    if (confDiff !== 0) return confDiff;
    const tfDiff = (FLAG_TF_RANK[b.timeframe] ?? -1) - (FLAG_TF_RANK[a.timeframe] ?? -1);
    if (tfDiff !== 0) return tfDiff;
    return String(a.candidateId).localeCompare(String(b.candidateId));
  })[0];
}

/**
 * Build the symbol's single published flag trade plan, or null when no confirmed
 * directional flag candidate exists at all this build.
 * @param {Object} p
 * @param {Array<Object>} p.candidateSetups - finalized (snapped, qualified) candidates
 * @param {Object|null} p.geometryContext
 * @param {Object} p.tfEntries - this symbol's per-timeframe entries (for closedThrough)
 * @param {Object} p.marketByTf - `{ [tf]: { price, atr } }` (services/scalpContext.js, internal)
 * @param {Object} [p.candlesByTf] - `{ [tf]: closedCandles[] }` for the retest-hold check
 * @param {Object} p.intervalMsByTf - INTERVAL_MS
 * @param {Array<string>} p.geometryTimeframes - ENGINE_CONFIG.geometry.timeframes
 * @param {number} p.now
 * @param {string} p.configVersion
 * @param {Array<{id:string, minRR:number}>} [p.shadowVariants] - T6 completion plan B2
 *   (docs/OWNER_DECISIONS_2026-09-24.md D-variant, owner-approved 2026-09-24): research
 *   only, never shipped as the live plan. For each variant, the same candidate pool is
 *   re-attempted with `flagPlan.minRR` overridden to `variant.minRR` (every other config
 *   value, including `flagPlan.minNetRR`, stays the live default) - same ATR, same
 *   candles, same retest-hold rule, same `selectBest` tie-break as the live plan, exact
 *   engine semantics, no tracker-side approximation. Published on the returned plan as
 *   `shadow.<variant.id>` only when that variant's selected outcome (status, reasonCode,
 *   or candidateId) differs from the live plan - identical outcomes publish nothing, so a
 *   variant that changes nothing on this build costs one extra pass, zero extra bytes.
 * @param {Object} [cfg=ENGINE_CONFIG]
 * @returns {Object|null} the live plan, plus `setup` (T6 completion plan C2: the best
 *   still-conditional attempt in the same pool, `null` when none - see the `setup`
 *   assignment below for field shape) and `shadow` (when `shadowVariants` produced one).
 */
export function buildFlagTradePlan({ candidateSetups, geometryContext, tfEntries, marketByTf, candlesByTf, intervalMsByTf, geometryTimeframes, now, configVersion, shadowVariants }, cfg = ENGINE_CONFIG) {
  const pool = (candidateSetups || []).filter((c) => c && c.type === 'flag' && c.state === 'confirmed');
  if (pool.length === 0) return null;

  // Every geometry timeframe that can feed the TP1 cap (nearestRoomAhead reads all of
  // geometryContext, not just one borrowed timeframe) must be fresh for any attempt.
  const geometryFreshnessReqs = (geometryTimeframes || []).map((tf) => ({
    tf,
    closedThroughIso: tfEntries[tf] ? tfEntries[tf].closedThrough : null,
    intervalMs: intervalMsByTf[tf]
  }));

  // cfg-independent: shared by the live attempt and every shadow variant's re-attempt.
  const ctxFor = (candidate) => {
    const market = marketByTf[candidate.timeframe] || {};
    return {
      geometryContext,
      currentPrice: isFiniteNumber(market.price) ? market.price : null,
      atrValue: isFiniteNumber(market.atr) ? market.atr : null,
      candles: candlesByTf && Array.isArray(candlesByTf[candidate.timeframe]) ? candlesByTf[candidate.timeframe] : null,
      ownClosedThroughIso: tfEntries[candidate.timeframe] ? tfEntries[candidate.timeframe].closedThrough : null,
      geometryFreshnessReqs,
      intervalMs: intervalMsByTf[candidate.timeframe],
      now
    };
  };

  const attempts = pool.map((candidate) => buildPlanAttempt(candidate, ctxFor(candidate), cfg));
  const selected = selectBest(attempts);
  if (!selected) return null;

  const closedThroughIso = tfEntries[selected.timeframe] ? tfEntries[selected.timeframe].closedThrough : null;
  const planId = selected.candidateId ? `${selected.candidateId}|${closedThroughIso || 'unknown'}|${configVersion}` : null;

  const { confidence, ...published } = selected;
  const live = { ...published, planId };

  // SETUP tier (T6 completion plan C2): the best still-conditional attempt in the SAME
  // pool, surfaced even when a DIFFERENT candidate won the live plan's own selection.
  // Every 'conditional' status already implies the gross gate passed (grossRR >=
  // flagPlan.minRR) and, when the net gate is on, the net gate too (netRR >=
  // flagPlan.minNetRR) - buildPlanAttempt only reaches observeRetestHold after both -
  // so no separate "3R" filter is needed here, the status already encodes it. Reuses
  // `attempts` (no extra buildPlanAttempt calls). Distinct from the live plan: informational
  // only, never GO IN, never gates class/recommendation on its own - flagRecommendation.js
  // copies this straight through as its own `setup` field, published in the default payload.
  const bestConditional = selectBest(attempts.filter((a) => a.status === 'conditional'));
  live.setup = bestConditional
    ? {
      candidateId: bestConditional.candidateId,
      timeframe: bestConditional.timeframe,
      direction: bestConditional.direction,
      entry: bestConditional.entry,
      stop: bestConditional.stop,
      tp1: bestConditional.tp1,
      grossRR: bestConditional.grossRR,
      netRR: bestConditional.netRR,
      entryCondition: bestConditional.entryCondition
    }
    : null;

  // Chase SETUP (owner priority 2026-09-24): a confirmed flag rejected only for `chase`
  // still gets a SETUP when no genuine conditional attempt exists - the same candidate
  // re-attempted without the chase flag must clear every other gate (room, stop cap,
  // gross/net R), and its trigger is the retest the chase remedy already names. The live
  // plan (status/reasonCode, hence class BAD/chase) is untouched.
  if (!live.setup) {
    const chaseRetest = selectBest(pool
      .filter((c) => c.chaseRisk === true)
      .map((c) => buildPlanAttempt({ ...c, chaseRisk: false }, ctxFor(c), cfg))
      .filter((a) => a.status === 'conditional' || a.status === 'ready'));
    if (chaseRetest) {
      live.setup = {
        candidateId: chaseRetest.candidateId,
        timeframe: chaseRetest.timeframe,
        direction: chaseRetest.direction,
        entry: chaseRetest.entry,
        stop: chaseRetest.stop,
        tp1: chaseRetest.tp1,
        grossRR: chaseRetest.grossRR,
        netRR: chaseRetest.netRR,
        entryCondition: `wait for a ${chaseRetest.timeframe} retest of ${fmtPrice(chaseRetest.entry)} that holds ${chaseRetest.direction === 'short' ? 'below' : 'above'} it`
      };
    }
  }

  if (Array.isArray(shadowVariants) && shadowVariants.length > 0) {
    const shadow = {};
    for (const variant of shadowVariants) {
      if (!variant || typeof variant.id !== 'string' || !variant.id || !isFiniteNumber(variant.minRR)) continue;
      const shadowCfg = { ...cfg, flagPlan: { ...cfg.flagPlan, minRR: variant.minRR } };
      const shadowAttempts = pool.map((candidate) => buildPlanAttempt(candidate, ctxFor(candidate), shadowCfg));
      const shadowSelected = selectBest(shadowAttempts);
      if (!shadowSelected) continue;
      const differs = shadowSelected.status !== live.status
        || shadowSelected.reasonCode !== live.reasonCode
        || shadowSelected.candidateId !== live.candidateId;
      if (!differs) continue;
      const shadowClosedThroughIso = tfEntries[shadowSelected.timeframe] ? tfEntries[shadowSelected.timeframe].closedThrough : null;
      const shadowPlanId = shadowSelected.candidateId
        ? `${shadowSelected.candidateId}|${shadowClosedThroughIso || 'unknown'}|${configVersion}`
        : null;
      const { confidence: shadowConfidence, ...shadowPublished } = shadowSelected;
      shadow[variant.id] = { ...shadowPublished, planId: shadowPlanId };
    }
    if (Object.keys(shadow).length > 0) live.shadow = shadow;
  }

  return live;
}

export default { buildFlagTradePlan };
