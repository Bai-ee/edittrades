/**
 * S3 shared helpers (docs/PROMPT_S3_RETEST_ENTRY.md) for the retest-entry rule family:
 * re-flag-retest-4h, re-flag-retest-1h, re-flag-breakout-4h (control), re-random-4h
 * (control). Lives outside scripts/swing/rules/ on purpose - scripts/swing/run.js's
 * loadRules loads every `.js` file directly under that directory and requires each one
 * to export `{meta, signalAt}` per the rule interface, so a shared helper module has to
 * sit one level up (a precedent scripts/swing/rules/ctl-random-4h.js already sets by
 * importing `rangeAt` from a sibling rule file instead - this module is the same idea,
 * just not itself a rule).
 *
 * Read-only imports from lib/ and config/ (CLAUDE.md: "Nothing under lib/, services/,
 * config/, api/, scripts/tracker/" means never EDIT those - importing production code
 * read-only is the established S0 playbook-rules pattern, e.g.
 * scripts/swing/rules/pb-4h-flag-continuation.js's own `detectFlagLifecycle` import):
 *   - `detectFlagLifecycle` (lib/patternDetector.js): the production flag detector,
 *     reused exactly as pb-4h-flag-continuation.js already does.
 *   - `netFloorStopDistance` (lib/flagTradePlan.js): the production T-15 net floor,
 *     reused exactly as lib/flagTradePlan.js's own buildPlanAttempt applies it live.
 *
 * NF_ATR_MULT/NF_COST_MULT below are hardcoded to the S3 prompt's own numbers (0.5, 3)
 * rather than read from `ENGINE_CONFIG.flagPlan.stopFloor` - engine rules are frozen
 * until 2026-10-08 (docs/AGENT_SESSION_RULES.md) so the two currently agree, but this
 * study should keep scoring exactly what the prompt specified even if that config value
 * moves later. `riskCfg` (the round-trip cost model, 0.34% long / 0.14% short) is still
 * read from `ENGINE_CONFIG.risk` - that IS the cost model the prompt's own "net of 0.34%
 * long / 0.14% short" line means, not a value to freeze independently.
 */

import { detectFlagLifecycle } from '../../lib/patternDetector.js';
import { netFloorStopDistance } from '../../lib/flagTradePlan.js';
import { ENGINE_CONFIG } from '../../config/engine.js';
import { INTERVAL_MS } from '../../services/scalpContext.js';

export { detectFlagLifecycle };

export const RETEST_TOLERANCE_ATR = 0.25; // "within 0.25 x ATR(tf) of the breakout level"
export const RETEST_STOP_BUFFER_ATR = 0.1; // "retest low - 0.1 x ATR"
export const MIN_GROSS_RR = 2.5; // "skip when TP1 < 2.5R off the stop"
export const NF_ATR_MULT = 0.5; // NF (0.5 x ATR15m, ...
export const NF_COST_MULT = 3; // ..., 3 x cost)
export const STRUCTURE_EXIT_N = 5; // "5 x timeframe candles closed back inside the flag"
export const HOLD_MAX_HOURS = 24 * 7; // long hard cap (7 days)

export const EMA_FAST_PERIOD = 21;
export const EMA_SLOW_PERIOD = 200;
export const TREND_SLOPE_LOOKBACK = 5; // candles, on the trend tf's own grid
export const MIN_TREND_CANDLES = EMA_SLOW_PERIOD + TREND_SLOPE_LOOKBACK + 1;

export function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

export function candleTime(c) {
  if (isFiniteNumber(c.closeTime)) return c.closeTime;
  if (isFiniteNumber(c.timestamp)) return c.timestamp;
  return null;
}

/** Keep only candles at or before `cutoffMs` - defensive re-clip for a cross-timeframe array. */
export function clipTo(candles, cutoffMs) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => {
    const t = candleTime(c);
    return t === null ? false : t <= cutoffMs;
  });
}

/**
 * SMA-seeded EMA, tail-aligned to `values` - the same formula
 * pb-4h-flag-continuation.js/pb-ema21-pullback-1d.js already use.
 */
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Same EMA21/EMA200 stack + slope trend read pb-4h-flag-continuation.js /
 * pb-ema21-pullback-1d.js use on 1D candles, generalized to any candle array so it can
 * also gate on 4h (re-flag-retest-1h's "1D/4h trend gate").
 * @returns {'bull'|'bear'|null}
 */
export function trendFromStack(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_TREND_CANDLES) return null;
  if (!candles.every(isValidCandle)) return null;
  const closes = candles.map((c) => c.close);
  const ema21 = emaSeries(closes, EMA_FAST_PERIOD);
  const ema200 = emaSeries(closes, EMA_SLOW_PERIOD);
  const last = closes.length - 1;
  const priorIdx = last - TREND_SLOPE_LOOKBACK;
  const ema21Last = ema21[last];
  const ema200Last = ema200[last];
  const ema21Prior = priorIdx >= 0 ? ema21[priorIdx] : null;
  if (!isFiniteNumber(ema21Last) || !isFiniteNumber(ema200Last) || !isFiniteNumber(ema21Prior)) return null;
  const closeLast = closes[last];
  const slope = ema21Last - ema21Prior;
  if (closeLast > ema21Last && ema21Last > ema200Last && slope > 0) return 'bull';
  if (closeLast < ema21Last && ema21Last < ema200Last && slope < 0) return 'bear';
  return null;
}

/**
 * The S3 retest-entry check, evaluated on the CURRENT (last) candle of the candidate's
 * own series only - no cross-call memory. Has price come back within
 * `RETEST_TOLERANCE_ATR` x ATR(tf) of the breakout level and printed a close back in the
 * trade direction, without a wick through the flag's own invalidation? A candle that
 * qualifies is its own retest-entry signal; a flag that keeps closing on the hold side
 * for several bars in a row prints a fresh candidate on each one, same as every other
 * per-candle rule in this harness (documented, not an oversight - see each rule's own
 * meta.notes).
 * @param {Object} p
 * @param {Object} p.candidate - detectFlagLifecycle's candidate
 * @param {number|null} p.atr - detectFlagLifecycle's own returned ATR(tf)
 * @param {'long'|'short'} p.direction
 * @param {{high:number, low:number, close:number}} p.current - the candidate's own last candle
 * @returns {{entry:number, retestExtreme:number}|null} retestExtreme = this candle's low
 *   (long) / high (short), for the stop formula below.
 */
export function retestPrintAt({ candidate, atr, direction, current }) {
  if (!candidate || !isFiniteNumber(atr) || atr <= 0) return null;
  if (!(candidate.state === 'triggering' || candidate.state === 'confirmed')) return null;
  if (candidate.chaseRisk) return null;
  if (!isFiniteNumber(candidate.ageCandles) || candidate.ageCandles < 1) return null; // no retest on the breakout candle itself
  if (!isFiniteNumber(candidate.measuredTarget)) return null;

  const { breakoutLevel, invalidation } = candidate;
  if (!isFiniteNumber(breakoutLevel) || !isFiniteNumber(invalidation)) return null;
  const sign = direction === 'short' ? -1 : 1;
  const tol = RETEST_TOLERANCE_ATR * atr;

  const reached = sign === 1 ? current.low <= breakoutLevel + tol : current.high >= breakoutLevel - tol;
  if (!reached) return null;
  const held = sign * (current.close - breakoutLevel) >= 0;
  if (!held) return null;
  const stopBreached = sign === 1 ? current.low <= invalidation : current.high >= invalidation;
  if (stopBreached) return null;

  return { entry: current.close, retestExtreme: sign === 1 ? current.low : current.high };
}

/**
 * Floor a raw stop with the production T-15 net floor (`netFloorStopDistance`,
 * `max(NF_ATR_MULT x ATR15m, NF_COST_MULT x round-trip cost)`), imported read-only from
 * lib/flagTradePlan.js - never re-derived.
 * @returns {number|null} the final stop price, or null when the resulting risk is not > 0
 */
export function applyNetFloor({ direction, entry, rawStop, atr15m }) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(rawStop)) return null;
  const sign = direction === 'short' ? -1 : 1;
  const nf = netFloorStopDistance({ direction, entry, stop: rawStop, atr15m, riskCfg: ENGINE_CONFIG.risk, atrMult: NF_ATR_MULT, costMult: NF_COST_MULT });
  const stop = nf ? entry - sign * nf.distance : rawStop;
  const risk = Math.abs(entry - stop);
  return risk > 0 ? stop : null;
}

/**
 * The S3 stop formula: `min(retest low - RETEST_STOP_BUFFER_ATR x ATR, invalidation)`
 * for a long (mirrored for a short), then NF-floored (`applyNetFloor` above).
 */
export function nfFlooredRetestStop({ direction, entry, retestExtreme, invalidation, atr, atr15m }) {
  const sign = direction === 'short' ? -1 : 1;
  const rawStop = sign === 1
    ? Math.min(retestExtreme - RETEST_STOP_BUFFER_ATR * atr, invalidation)
    : Math.max(retestExtreme + RETEST_STOP_BUFFER_ATR * atr, invalidation);
  return applyNetFloor({ direction, entry, rawStop, atr15m });
}

/** `ctx.geometry['15m'].atr`, defensively - the ATR the production net floor is priced off. */
export function atr15mFrom(ctx) {
  const g15 = ctx && ctx.geometry && ctx.geometry['15m'];
  return g15 && isFiniteNumber(g15.atr) ? g15.atr : null;
}

/**
 * Gross R:R gate: `false` unless the target is ahead of entry in the trade direction and
 * at least `MIN_GROSS_RR` off the (already floored) stop - "skip when TP1 < 2.5R off the
 * stop".
 */
export function minRRGate(direction, entry, stop, tp1) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(tp1)) return false;
  const sign = direction === 'short' ? -1 : 1;
  if (!(sign * (tp1 - entry) > 0)) return false;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return false;
  return Math.abs(tp1 - entry) / risk >= MIN_GROSS_RR;
}

/**
 * `scoreSignal`'s `holdRule` option (scripts/swing/run.js): exit once `STRUCTURE_EXIT_N`
 * consecutive closed `tf` candles print back inside `[candidate.flagLow,
 * candidate.flagHigh]` - the pre-breakout consolidation box, already in real (un-oriented)
 * price space regardless of direction (lib/patternDetector.js's own `flagHigh`/`flagLow`
 * fields).
 */
export function structureHoldRule(candidate, tf) {
  return {
    insideLow: candidate.flagLow,
    insideHigh: candidate.flagHigh,
    n: STRUCTURE_EXIT_N,
    tfCandleMs: INTERVAL_MS[tf]
  };
}

/** FNV-1a, 32-bit unsigned - same seeding technique ctl-random-4h.js/mr-random-1h.js use. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let k = 0; k < str.length; k++) {
    h ^= str.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: deterministic PRNG from a 32-bit seed, returns a fn producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exported for tests: the deterministic [0,1) draw for a given (seed, symbol, timestamp). */
export function seededDraw(seed, symbol, timestamp) {
  const hash = fnv1a(`${seed}:${symbol}:${timestamp}`);
  return mulberry32(hash)();
}
