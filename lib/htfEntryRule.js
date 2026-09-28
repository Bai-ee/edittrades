/**
 * T-20 HTF-anchored entries (docs/PROMPT_T20_HTF_ENTRY.md, owner decision 2026-09-27:
 * "larger stops, gauge total direction over time, the 1 and 5 minute become entries for
 * the 1 hour"). Pure rule, no lookahead, no store: direction from the 4h/1D EMA21/EMA200
 * stack, entry from the EXISTING 1m/5m flag detector (lib/patternDetector.js) reaching
 * `triggering` in that direction, stop from the 1h swing that anchors the trade
 * (NF-floored, 3% scalp-capped), target from the last 1h impulse projected from that same
 * swing. `lib/htfEntryLive.js` calls these SAME functions against live candles;
 * `scripts/swing/rules/htf-entry-1m.js` re-exports this module unchanged for the S0-style
 * swing harness (scripts/swing/run.js) - one implementation, never two that happen to agree.
 *
 * Shares building blocks with the S3 retest-entry family (lib/retestShared.js) - EMA
 * series, candle clipping, candle validity - rather than re-deriving them, and the
 * production T-15 net floor (lib/flagTradePlan.js `netFloorStopDistance`/`netRiskReward`),
 * imported read-only. This file adds only what T-20 needs on top: the 4h+1D dual-stack
 * direction read (EMA21-vs-EMA200 stack only, no slope requirement - distinct from
 * retestShared's `trendFromStack`), the 1h swing/impulse geometry, the 1m/5m trigger
 * check, and the plan assembly (stop/tp1/tp2/R:R).
 *
 * No lookahead: every candle array a caller passes in is assumed already clipped to
 * closes <= "now" (candlesByTf slices, cross-timeframe clipTo) - this module never reads
 * past the end of an array it is given, and `signalAt` re-clips defensively itself.
 *
 * Interpretive design notes (the prompt names outcomes, not formulas, for two spots):
 *   - "1h measured target (last 1h impulse projected from the swing)": the anchor swing
 *     (the same pivot the stop is built from) plus the height of the leg that put it in
 *     place - the nearest OPPOSITE swingPivots() pivot strictly before the anchor, in
 *     price. A long's anchor is the newest confirmed swing low; its impulse leg is (the
 *     swing high immediately before that low) minus (the low); target = anchor + that
 *     height. Mirrored for a short. See `swingAnchorAndTarget`.
 *   - "room on 1h": the prompt's line 8 prose; the deliverable's own payload contract
 *     (`symbols.<SYM>.htfEntry`) does not list a `room` key - `geometryContext['1h']`
 *     already publishes `roomToNextSupport`/`roomToNextResistance` (lib/geometry.js,
 *     unchanged), so no new field is added here; the live wiring may read that existing
 *     field alongside `htfEntry` when composing a card.
 */

import { swingPivots } from './geometry.js';
import { detectFlagLifecycle } from './patternDetector.js';
import { netFloorStopDistance, netRiskReward } from './flagTradePlan.js';
import { ENGINE_CONFIG } from '../config/engine.js';
import { INTERVAL_MS } from '../services/scalpContext.js';
import {
  emaSeries, clipTo, candleTime, isValidCandle, isFiniteNumber
} from './retestShared.js';

export const EMA_FAST_PERIOD = 21;
export const EMA_SLOW_PERIOD = 200;
export const MIN_STACK_CANDLES = EMA_SLOW_PERIOD; // enough closes for ema200[last] to exist

export const MIN_GROSS_RR = 2.5; // "require TP1 >= 2.5R off that stop"
export const MIN_NET_RR = 1.0; // "net R:R >= 1.0"
export const NF_ATR_MULT = 0.5; // NF floor: max(0.5 x ATR15m, ...
export const NF_COST_MULT = 3; // ..., 3 x cost)
export const STOP_SWING_BUFFER_ATR = 0.1; // "minus/plus 0.1 x ATR(1h)"
export const HOLD_MAX_HOURS = 72; // "EXIT . time (72h)"
export const COOLDOWN_HOURS = 4; // "one trigger per symbol per HTF regime per 4h"
export const COOLDOWN_MS = COOLDOWN_HOURS * 3600000;
// 3m is production-only (no fixture in the swing harness's native timeframes, same as
// scripts/swing/run.js's own note: "3m is derived production-side and not reconstructed
// here"); the live wiring (lib/htfEntryLive.js) checks 1m/3m/5m, the replay checks 1m/5m.
export const TRIGGER_TIMEFRAMES = Object.freeze(['1m', '5m']);
export const LIVE_TRIGGER_TIMEFRAMES = Object.freeze(['1m', '3m', '5m']);

export const HTF_ENTRY_PREFIX = 'htf_';

export const meta = {
  id: 'htf-entry-1m',
  label: 'HTF-anchored entry: 4h+1D direction, 1h stop/target, 1m/5m trigger (T-20)',
  source: 'docs/PROMPT_T20_HTF_ENTRY.md',
  tf: '1m',
  holdMaxHours: HOLD_MAX_HOURS,
  stopKind: 'structure',
  notes: [
    'Direction: EMA21 > EMA200 on BOTH 4h and 1D and price above EMA21(4h) = long (short mirrored); no slope requirement, unlike the S3 family\'s trendFromStack.',
    'Trigger: a 1m or 5m flag (lib/patternDetector.js detectFlagLifecycle) reaching triggering (the exact breakout candle, ageCandles 0) in the HTF direction. 5m is only checked on a 5m-aligned close (no re-firing across the 4 intervening 1m ticks).',
    `Stop: the 1h swing anchor minus/plus ${STOP_SWING_BUFFER_ATR} ATR(1h), NF-floored (${NF_ATR_MULT}x ATR15m / ${NF_COST_MULT}x cost, lib/flagTradePlan.js netFloorStopDistance), then gated (never widened) by the 3% scalp cap.`,
    'TP1: the last 1h impulse (nearest opposite swing pivot before the anchor) projected from that same anchor; requires >= 2.5R gross and >= 1.0R net off the floored stop. TP2: the next 1h/4h horizontal zone ahead of TP1, if any.',
    'Exits: stop, TP1, a 72h hold cap (time exit), or a structure exit modelled here as one 1h-interval close beyond the anchor-defined structureStop (holdRule n=1) - the replay samples hourly from the signal\'s own trigger time rather than recalendared exchange 1h boundaries (documented approximation); the live alert (lib/htfEntryLive.js) checks the real 1h close.'
  ].join('\n')
};

// ---------------------------------------------------------------------------
// Direction: 4h + 1D EMA21/EMA200 stack
// ---------------------------------------------------------------------------

/**
 * EMA21-vs-EMA200 stack on the last candle of `candles` - no slope requirement (distinct
 * from retestShared.js's `trendFromStack`, which also requires a rising/falling EMA21 and
 * close-vs-EMA21 on the SAME timeframe it is called on; T-20 only requires close-vs-EMA21
 * on 4h, in `htfDirectionAt` below, not on 1D).
 * @returns {{ema21:number, ema200:number, close:number}|null}
 */
export function emaStackAt(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_STACK_CANDLES || !candles.every(isValidCandle)) return null;
  const closes = candles.map((c) => c.close);
  const ema21 = emaSeries(closes, EMA_FAST_PERIOD);
  const ema200 = emaSeries(closes, EMA_SLOW_PERIOD);
  const last = closes.length - 1;
  const e21 = ema21[last];
  const e200 = ema200[last];
  if (!isFiniteNumber(e21) || !isFiniteNumber(e200)) return null;
  return { ema21: e21, ema200: e200, close: closes[last] };
}

/**
 * T-20 direction (docs/PROMPT_T20_HTF_ENTRY.md): LONG when EMA21 > EMA200 on BOTH 4h and
 * 1D AND price is above EMA21(4h); SHORT the mirror; else null.
 * @param {Object} p
 * @param {Array<Object>} p.candles4h - ascending, closed, already clipped to <= now
 * @param {Array<Object>} p.candles1d - ascending, closed, already clipped to <= now
 * @returns {'long'|'short'|null}
 */
export function htfDirectionAt({ candles4h, candles1d }) {
  const s4 = emaStackAt(candles4h);
  const s1d = emaStackAt(candles1d);
  if (!s4 || !s1d) return null;
  if (s4.ema21 > s4.ema200 && s1d.ema21 > s1d.ema200 && s4.close > s4.ema21) return 'long';
  if (s4.ema21 < s4.ema200 && s1d.ema21 < s1d.ema200 && s4.close < s4.ema21) return 'short';
  return null;
}

// ---------------------------------------------------------------------------
// 1h swing anchor + impulse-projected target
// ---------------------------------------------------------------------------

/**
 * The 1h swing that anchors the T-20 stop, plus the last-impulse-projected target (see
 * this module's header for the interpretation). "Last confirmed pivot" = the newest
 * CONFIRMED swingPivots() low (long) / high (short) - confirmed needs `pivotRight` closed
 * candles after it, so the newest `pivotRight` candles can never supply one
 * (lib/geometry.js's own no-lookahead rule, inherited unchanged here).
 * @param {Array<Object>} candles1h - ascending, closed, already clipped to <= now
 * @param {'long'|'short'} direction
 * @param {Object} [cfg=ENGINE_CONFIG.geometry]
 * @returns {{anchor:{price:number,time:number|null}, impulseHeight:number, target:number}|null}
 */
export function swingAnchorAndTarget(candles1h, direction, cfg = ENGINE_CONFIG.geometry) {
  if (!Array.isArray(candles1h) || candles1h.length === 0) return null;
  const pivots = swingPivots(candles1h, cfg.pivotLeft, cfg.pivotRight);
  const anchors = direction === 'short' ? pivots.highs : pivots.lows;
  const opposites = direction === 'short' ? pivots.lows : pivots.highs;
  if (anchors.length === 0 || opposites.length === 0) return null;
  const anchor = anchors[anchors.length - 1];
  const before = opposites.filter((p) => p.index < anchor.index);
  const oppositePivot = before.length ? before[before.length - 1] : opposites[opposites.length - 1];
  const impulseHeight = Math.abs(oppositePivot.price - anchor.price);
  if (!(impulseHeight > 0)) return null;
  const sign = direction === 'short' ? -1 : 1;
  const target = anchor.price + sign * impulseHeight;
  return { anchor: { price: anchor.price, time: anchor.time }, impulseHeight, target };
}

// ---------------------------------------------------------------------------
// Stop: 1h swing +/- buffer, NF-floored, scalp-capped
// ---------------------------------------------------------------------------

/**
 * The T-20 stop: the 1h swing anchor minus/plus STOP_SWING_BUFFER_ATR x ATR(1h), then
 * NF-floored (max(NF_ATR_MULT x ATR15m, NF_COST_MULT x round-trip cost) - the SAME
 * lib/flagTradePlan.js `netFloorStopDistance` production floor, imported read-only, never
 * re-derived). Direction-exact: a long's stop is always below entry, a short's above -
 * `netFloorStopDistance` only ever widens the distance, never flips the side.
 * @returns {number|null}
 */
export function htfStop({ direction, entry, anchorPrice, atr1h, atr15m, riskCfg = ENGINE_CONFIG.risk }) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(anchorPrice) || !isFiniteNumber(atr1h)) return null;
  const sign = direction === 'short' ? -1 : 1;
  const rawStop = anchorPrice - sign * STOP_SWING_BUFFER_ATR * atr1h;
  const nf = netFloorStopDistance({ direction, entry, stop: rawStop, atr15m, riskCfg, atrMult: NF_ATR_MULT, costMult: NF_COST_MULT });
  const stop = nf ? entry - sign * nf.distance : rawStop;
  const risk = Math.abs(entry - stop);
  return risk > 0 ? stop : null;
}

/**
 * CLAUDE.md / ENGINE_CONFIG.scalp.maxStopDistancePct hard rule: a stop wider than the cap
 * is NO_TRADE - never clamped, never raised past it, per "Do not raise the threshold."
 */
export function stopWithinScalpCap(entry, stop, cfg = ENGINE_CONFIG.scalp) {
  if (!isFiniteNumber(entry) || entry <= 0 || !isFiniteNumber(stop)) return false;
  return stopPct(entry, stop) <= cfg.maxStopDistancePct;
}

export function stopPct(entry, stop) {
  if (!isFiniteNumber(entry) || entry <= 0 || !isFiniteNumber(stop)) return null;
  return Math.round((Math.abs(entry - stop) / entry) * 100 * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// R:R gates
// ---------------------------------------------------------------------------

/** Gross R:R: target must be ahead of entry in `direction` and risk must be positive. */
export function grossRR(direction, entry, stop, tp1) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(tp1)) return null;
  const sign = direction === 'short' ? -1 : 1;
  if (!(sign * (tp1 - entry) > 0)) return null;
  const risk = Math.abs(entry - stop);
  return risk > 0 ? Math.abs(tp1 - entry) / risk : null;
}

// ---------------------------------------------------------------------------
// Trigger: 1m/5m (live: +3m) flag reaching `triggering`
// ---------------------------------------------------------------------------

const TF_STEP_MS = { '1m': 60000, '3m': 180000, '5m': 300000 };

/**
 * Does `tf`'s own candle grid close a fresh candle at `cutMs`? 1m always does (the outer
 * harness/live tick IS the 1m close); 5m/3m only close once every 5/3 minutes - checking
 * their flag state on every 1m tick would re-detect the SAME breakout candle for the
 * intervening ticks, since the trigger tf's own array does not advance in between.
 * Boundary-aligned rather than memoized: stateless, no lookahead, no module-level cache.
 */
export function closesAt(tf, cutMs) {
  if (tf === '1m') return true;
  const stepMs = TF_STEP_MS[tf];
  return isFiniteNumber(stepMs) && isFiniteNumber(cutMs) ? cutMs % stepMs === 0 : false;
}

/**
 * The T-20 trigger: the first candle of a 1m/3m/5m flag reaching `triggering` in
 * `direction` (state === 'triggering', ageCandles === 0 - the exact breakout close, so
 * "entry = the trigger close" per the prompt). Checks every timeframe in `tfs` whose own
 * grid closes a fresh candle at `cutMs` (see `closesAt`); the first tf in `tfs` order to
 * fire wins (deterministic tie-break when more than one trigger on the same tick).
 * @param {Object} p
 * @param {Object} p.candlesByTf - `{ [tf]: candles }`, already clipped to <= cutMs
 * @param {Array<string>} [p.tfs=TRIGGER_TIMEFRAMES]
 * @param {'long'|'short'} p.direction
 * @param {number} p.cutMs
 * @returns {{tf:string, candidate:Object, entry:number}|null}
 */
export function checkHtfTrigger({ candlesByTf, tfs = TRIGGER_TIMEFRAMES, direction, cutMs }) {
  for (const tf of tfs) {
    if (!closesAt(tf, cutMs)) continue;
    const candles = candlesByTf[tf];
    if (!Array.isArray(candles) || candles.length < EMA_FAST_PERIOD + 1) continue;
    const ema21 = emaSeries(candles.map((c) => c.close), EMA_FAST_PERIOD);
    let result;
    try {
      result = detectFlagLifecycle({ candles, ema21History: ema21 }, direction);
    } catch {
      result = null;
    }
    if (!result) continue;
    const { candidate } = result;
    if (candidate.state !== 'triggering' || candidate.ageCandles !== 0) continue;
    const last = candles[candles.length - 1];
    if (!last || !isFiniteNumber(last.close)) continue;
    return { tf, candidate, entry: last.close };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

/** The nearest 1h/4h horizontal zone edge strictly ahead of `from`, in `direction` - TP2. */
function nextZoneBeyond({ direction, from, geometry1h, geometry4h }) {
  const sign = direction === 'short' ? -1 : 1;
  let nearest = null;
  for (const g of [geometry1h, geometry4h]) {
    if (!g) continue;
    const zones = direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones;
    if (!Array.isArray(zones)) continue;
    for (const z of zones) {
      const near = direction === 'long' ? z.low : z.high;
      if (!isFiniteNumber(near)) continue;
      if (sign * (near - from) > 0 && (nearest === null || sign * (near - nearest) < 0)) nearest = near;
    }
  }
  return nearest;
}

/**
 * The full T-20 plan for a fired trigger: stop (NF-floored, scalp-capped), tp1 (1h
 * impulse projected from the swing anchor), tp2 (next 1h/4h zone ahead of tp1, if any),
 * gross/net R:R. Always returns a verdict (never throws) - a rejection is explicit,
 * mirroring lib/flagTradePlan.js's own "never skip silently" convention.
 * @returns {{status:'ready'|'rejected', reasonCode:string|null, stop:number|null,
 *   structureStop:number|null, tp1:number|null, tp2:number|null, grossRR:number|null,
 *   netRR:number|null, stopPct:number|null, anchor:number|null}}
 */
export function buildHtfPlan({ direction, entry, candles1h, atr1h, atr15m, geometry1h, geometry4h, riskCfg = ENGINE_CONFIG.risk }) {
  const shape = { status: 'rejected', reasonCode: null, stop: null, structureStop: null, tp1: null, tp2: null, grossRR: null, netRR: null, stopPct: null, anchor: null };
  if (!isFiniteNumber(entry) || !isFiniteNumber(atr1h) || atr1h <= 0) return { ...shape, reasonCode: 'invalid_inputs' };

  const swing = swingAnchorAndTarget(candles1h, direction);
  if (!swing) return { ...shape, reasonCode: 'no_1h_swing' };
  const { anchor, target } = swing;

  const sign = direction === 'short' ? -1 : 1;
  const structureStop = anchor.price - sign * STOP_SWING_BUFFER_ATR * atr1h;
  const stop = htfStop({ direction, entry, anchorPrice: anchor.price, atr1h, atr15m, riskCfg });
  if (!isFiniteNumber(stop)) return { ...shape, reasonCode: 'invalid_stop', structureStop, anchor: anchor.price };

  const stopDistancePct = stopPct(entry, stop);
  if (!stopWithinScalpCap(entry, stop)) {
    return { ...shape, reasonCode: 'stop_exceeds_scalp_cap', stop, structureStop, stopPct: stopDistancePct, anchor: anchor.price };
  }

  const tp1 = target;
  const gross = grossRR(direction, entry, stop, tp1);
  if (!isFiniteNumber(gross) || gross < MIN_GROSS_RR) {
    return { ...shape, reasonCode: 'rr_below_min', stop, structureStop, tp1, grossRR: gross, stopPct: stopDistancePct, anchor: anchor.price };
  }

  const net = netRiskReward(entry, stop, tp1, riskCfg, direction);
  if (!isFiniteNumber(net) || net < MIN_NET_RR) {
    return { ...shape, reasonCode: 'net_rr_below_min', stop, structureStop, tp1, grossRR: gross, netRR: net, stopPct: stopDistancePct, anchor: anchor.price };
  }

  const tp2 = nextZoneBeyond({ direction, from: tp1, geometry1h, geometry4h });

  return {
    status: 'ready',
    reasonCode: null,
    stop,
    structureStop,
    tp1,
    tp2,
    grossRR: Math.round(gross * 1000) / 1000,
    netRR: Math.round(net * 1000) / 1000,
    stopPct: stopDistancePct,
    anchor: anchor.price
  };
}

/**
 * The T-20 structure-exit `holdRule` (scripts/swing/run.js's `scoreSignal` option): exit
 * the instant a 1h-interval close lands beyond `structureStop` in the wrong direction -
 * modelled as `n: 1` on a one-sided "inside" band (the safe side of structureStop), so the
 * FIRST close on the wrong side trips it immediately (scoreSignalWithHoldRule increments
 * on "inside", exits at streak >= n - n=1 makes the very first non-safe close the exit).
 * Replay-only note: this samples hourly from the signal's own trigger time (`fromMs +
 * k*3600000`), not recalendared to real exchange 1h candle closes - a documented
 * approximation (see this module's header); the live alert (lib/htfEntryLive.js) checks
 * the real 1h close directly.
 */
export function htfStructureHoldRule(structureStop, direction) {
  return direction === 'short'
    ? { insideLow: structureStop, insideHigh: Infinity, n: 1, tfCandleMs: INTERVAL_MS['1h'] }
    : { insideLow: -Infinity, insideHigh: structureStop, n: 1, tfCandleMs: INTERVAL_MS['1h'] };
}

/** `htf_<SYM>_<tf>_<direction>_<closeIso>` - stable id, embeds the exact trigger candle. */
export function htfCandidateId(symbol, tf, direction, closeIso) {
  return `${HTF_ENTRY_PREFIX}${symbol}_${tf}_${direction}_${closeIso}`;
}

export function isHtfCandidateId(id) {
  return typeof id === 'string' && id.startsWith(HTF_ENTRY_PREFIX);
}

// ---------------------------------------------------------------------------
// Harness-facing entry point (scripts/swing/run.js RULE INTERFACE)
// ---------------------------------------------------------------------------

/**
 * Called once per closed 1m candle, no lookahead. Ties together direction (4h+1D stack),
 * trigger (1m/5m flag reaching triggering), and plan (1h swing stop/target) - the SAME
 * functions `lib/htfEntryLive.js` calls against live data (parity test:
 * test-htf-entry-rule.js), so replay and live can never quietly drift apart.
 * @param {Object} ctx - scripts/swing/run.js's buildCtx shape: { i, candlesByTf, geometry }
 * @returns {{direction, entry, stop, tp1, tp2, reason, holdRule}|null}
 */
export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw1m = candlesByTf['1m'];
  if (!Array.isArray(raw1m) || i >= raw1m.length) return null;
  const candles1m = raw1m.slice(0, i + 1);
  if (!candles1m.length) return null;
  const cutMs = candleTime(candles1m[candles1m.length - 1]);
  if (cutMs === null) return null;

  const candles4h = clipTo(candlesByTf['4h'], cutMs);
  const candles1d = clipTo(candlesByTf['1d'], cutMs);
  const direction = htfDirectionAt({ candles4h, candles1d });
  if (!direction) return null;

  const candles5m = clipTo(candlesByTf['5m'], cutMs);
  const trigger = checkHtfTrigger({ candlesByTf: { '1m': candles1m, '5m': candles5m }, tfs: TRIGGER_TIMEFRAMES, direction, cutMs });
  if (!trigger) return null;

  const candles1h = clipTo(candlesByTf['1h'], cutMs);
  const geometry1h = ctx.geometry && ctx.geometry['1h'];
  const geometry4h = ctx.geometry && ctx.geometry['4h'];
  const geometry15m = ctx.geometry && ctx.geometry['15m'];
  const atr1h = geometry1h && isFiniteNumber(geometry1h.atr) ? geometry1h.atr : null;
  const atr15m = geometry15m && isFiniteNumber(geometry15m.atr) ? geometry15m.atr : null;
  if (!isFiniteNumber(atr1h)) return null;

  const plan = buildHtfPlan({ direction, entry: trigger.entry, candles1h, atr1h, atr15m, geometry1h, geometry4h });
  if (plan.status !== 'ready') return null;

  const reason = [
    `4h+1D EMA21/EMA200 stack agree ${direction} (price ${direction === 'long' ? 'above' : 'below'} EMA21(4h))`,
    `${trigger.tf} flag reached triggering ${direction} at ${trigger.entry} (breakout candle, ageCandles 0)`,
    `stop ${plan.stop} (1h swing anchor ${plan.anchor} ${direction === 'long' ? '-' : '+'} ${STOP_SWING_BUFFER_ATR} ATR, NF-floored, ${plan.stopPct}% <= 3% scalp cap)`,
    `TP1 ${plan.tp1} = last 1h impulse projected from the anchor (${plan.grossRR}R gross, ${plan.netRR}R net)`
  ];

  return {
    direction,
    entry: trigger.entry,
    stop: plan.stop,
    tp1: plan.tp1,
    tp2: isFiniteNumber(plan.tp2) ? plan.tp2 : undefined,
    reason,
    holdRule: htfStructureHoldRule(plan.structureStop, direction)
  };
}

export default {
  meta,
  emaStackAt,
  htfDirectionAt,
  swingAnchorAndTarget,
  htfStop,
  stopWithinScalpCap,
  stopPct,
  grossRR,
  closesAt,
  checkHtfTrigger,
  buildHtfPlan,
  htfStructureHoldRule,
  htfCandidateId,
  isHtfCandidateId,
  signalAt,
  EMA_FAST_PERIOD,
  EMA_SLOW_PERIOD,
  MIN_GROSS_RR,
  MIN_NET_RR,
  NF_ATR_MULT,
  NF_COST_MULT,
  STOP_SWING_BUFFER_ATR,
  HOLD_MAX_HOURS,
  COOLDOWN_HOURS,
  COOLDOWN_MS,
  TRIGGER_TIMEFRAMES,
  LIVE_TRIGGER_TIMEFRAMES,
  HTF_ENTRY_PREFIX
};
