/**
 * S3 control: re-flag-breakout-4h (docs/PROMPT_S3_RETEST_ENTRY.md) - "the existing
 * breakout-close entry with the SAME exit rules, as the control" for re-flag-retest-4h.js.
 * Same detection/direction/entry as scripts/swing/rules/pb-4h-flag-continuation.js (a 4h
 * flag via lib/patternDetector.js detectFlagLifecycle, 1D trend-gated, entry on the exact
 * breakout close), but scored with the S3 exit/stop mechanics instead of
 * pb-4h-flag-continuation.js's own plain structure stop/48h hold - so the ONLY thing this
 * comparison isolates is entry timing (breakout close vs. retest), not the exit rules too.
 *
 * Entry: the 4h close that first closes past the flag border (ageCandles 0, i.e. the
 *   breakout candle itself - identical condition to pb-4h-flag-continuation.js).
 * Stop: the flag's own invalidation (no retest wick to reference at the breakout candle),
 *   floored by the production T-15 net floor (max(0.5 x ATR15m, 3 x round-trip cost)).
 * Target: the flag's measured move; skip when that is under 2.5R off the floored stop.
 * Exit: stop, target, 5 closed 4h candles back inside the flag range, or a 7-day hard cap -
 *   the SAME scoreSignal holdRule option re-flag-retest-4h.js uses.
 *
 * No lookahead: the 4h array is truncated to candlesByTf['4h'].slice(0, i + 1); the
 * cross-timeframe 1D trend array is defensively re-clipped to candles at or before the
 * current 4h candle's close time.
 */

import {
  detectFlagLifecycle, emaSeries, clipTo, isValidCandle, candleTime, trendFromStack,
  applyNetFloor, atr15mFrom, structureHoldRule, minRRGate, isFiniteNumber,
  HOLD_MAX_HOURS, MIN_GROSS_RR, NF_ATR_MULT, NF_COST_MULT, STRUCTURE_EXIT_N, EMA_FAST_PERIOD
} from '../retestShared.js';

const OWN_TF = '4h';
const TREND_TF = '1d';

export const meta = {
  id: 're-flag-breakout-4h',
  label: '4h flag breakout-close entry, S3 exit mechanics (control)',
  source: 'docs/PROMPT_S3_RETEST_ENTRY.md',
  tf: OWN_TF,
  holdMaxHours: HOLD_MAX_HOURS,
  stopKind: 'structure',
  notes: [
    'Control for re-flag-retest-4h.js: the SAME 1D-trend-gated 4h flag detection and the SAME breakout-close entry as pb-4h-flag-continuation.js, but scored with the S3 exit/stop mechanics below instead of that rule\'s own plain structure stop/48h hold - isolates entry timing (breakout close vs. retest) from the exit rules.',
    `Entry: the 4h close that first closes past the flag border (the breakout candle itself). Stop: invalidation, NF-floored (${NF_ATR_MULT}x ATR15m / ${NF_COST_MULT}x cost). TP1 = measured move; skipped when TP1 < ${MIN_GROSS_RR}R off the stop.`,
    `Exit: stop, target, ${STRUCTURE_EXIT_N} closed 4h candles back inside the flag range, or a 7-day hard cap (scoreSignal's holdRule option).`
  ].join('\n')
};

export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw4h = candlesByTf[OWN_TF];
  if (!Array.isArray(raw4h) || i >= raw4h.length) return null;
  const candles4h = raw4h.slice(0, i + 1);
  if (!candles4h.every(isValidCandle)) return null;

  const nowMs = candleTime(candles4h[candles4h.length - 1]);
  if (nowMs === null) return null;

  const dailyCandles = clipTo(candlesByTf[TREND_TF], nowMs);
  const trend = trendFromStack(dailyCandles);
  const direction = trend === 'bull' ? 'long' : trend === 'bear' ? 'short' : null;
  if (!direction) return null;

  const ema21_4h = emaSeries(candles4h.map((c) => c.close), EMA_FAST_PERIOD);
  const result = detectFlagLifecycle({ candles: candles4h, ema21History: ema21_4h }, direction);
  if (!result) return null;
  const { candidate } = result;

  // Only the exact 4h close the flag first broke out on (breakCount 1 -> ageCandles 0),
  // and only while still "triggering" - identical gate to pb-4h-flag-continuation.js.
  if (candidate.state !== 'triggering' || candidate.ageCandles !== 0) return null;
  if (!isFiniteNumber(candidate.measuredTarget)) return null;

  const entry = candles4h[candles4h.length - 1].close;
  const atr15m = atr15mFrom(ctx);
  const stop = applyNetFloor({ direction, entry, rawStop: candidate.invalidation, atr15m });
  if (!isFiniteNumber(stop)) return null;

  const tp1 = candidate.measuredTarget;
  if (!minRRGate(direction, entry, stop, tp1)) return null;

  const reason = [
    `1D trend ${trend} (EMA21/EMA200 stack + slope)`,
    `4h flag breakout close beyond ${direction === 'long' ? 'flagHigh' : 'flagLow'} (breakoutLevel ${candidate.breakoutLevel})`,
    `stop ${stop} (invalidation ${candidate.invalidation}, NF-floored)`,
    `TP1 = measured move ${tp1} (pole length ${candidate.poleHeight})`
  ];

  return {
    direction,
    entry,
    stop,
    tp1,
    reason,
    holdRule: structureHoldRule(candidate, OWN_TF)
  };
}

export default { meta, signalAt };
