/**
 * S3 playbook rule: re-flag-retest-4h (docs/PROMPT_S3_RETEST_ENTRY.md, owner review of ten
 * real trade charts, 2026-09-27: breakout-close entries are late, stops at the obvious
 * invalidation get probed, measured-move targets on a fixed clock time out flat).
 *
 * Same detection/direction gate as scripts/swing/rules/pb-4h-flag-continuation.js (a 4h
 * flag via lib/patternDetector.js detectFlagLifecycle, only taken with the 1D EMA21/EMA200
 * stack + slope trend), but a different entry: instead of the breakout close itself, this
 * rule waits for the retest - price coming back within 0.25 x ATR(4h) of the breakout
 * level and printing a close back in the trade direction
 * (scripts/swing/retestShared.js retestPrintAt, one candle at a time, no cross-call
 * memory - see that function's own header for what a multi-bar hold does).
 *
 * Entry: the retest candle's close.
 * Stop: min(retest low - 0.1 x ATR(4h), invalidation) for a long (mirrored short), then
 *   floored by the production T-15 net floor (max(0.5 x ATR15m, 3 x round-trip cost) -
 *   lib/flagTradePlan.js netFloorStopDistance, imported read-only).
 * Target: the flag's measured move (pole length projected from the breakout); skip when
 *   that is under 2.5R off the floored stop.
 * Exit: stop, target, 5 closed 4h candles back inside the flag range (structure failure),
 *   or a 7-day hard cap - scripts/swing/run.js scoreSignal's `holdRule` option.
 *
 * No lookahead: the 4h array is truncated to candlesByTf['4h'].slice(0, i + 1); the
 * cross-timeframe 1D trend array is defensively re-clipped to candles at or before the
 * current 4h candle's close time (same pattern pb-4h-flag-continuation.js uses).
 */

import {
  detectFlagLifecycle, emaSeries, clipTo, isValidCandle, candleTime, trendFromStack,
  retestPrintAt, nfFlooredRetestStop, atr15mFrom, structureHoldRule, minRRGate, isFiniteNumber,
  HOLD_MAX_HOURS, RETEST_TOLERANCE_ATR, RETEST_STOP_BUFFER_ATR, MIN_GROSS_RR,
  NF_ATR_MULT, NF_COST_MULT, STRUCTURE_EXIT_N, EMA_FAST_PERIOD
} from '../retestShared.js';

const OWN_TF = '4h';
const TREND_TF = '1d';

export const meta = {
  id: 're-flag-retest-4h',
  label: '4h flag retest entry, with 1D trend (S3)',
  source: 'docs/PROMPT_S3_RETEST_ENTRY.md',
  tf: OWN_TF,
  holdMaxHours: HOLD_MAX_HOURS,
  stopKind: 'structure',
  notes: [
    `Entry: after the 4h flag (lib/patternDetector.js detectFlagLifecycle, 1D EMA21/EMA200 stack + slope trend gate, same as pb-4h-flag-continuation.js) reaches triggering, wait for a close within ${RETEST_TOLERANCE_ATR} ATR(4h) of the breakout level that holds in the trade direction; entry = that close.`,
    `Stop: min(retest low - ${RETEST_STOP_BUFFER_ATR} ATR, invalidation) (mirrored short), floored by the T-15 net floor (lib/flagTradePlan.js netFloorStopDistance, ${NF_ATR_MULT}x ATR15m / ${NF_COST_MULT}x round-trip cost). TP1 = measured move; skipped when TP1 < ${MIN_GROSS_RR}R off the stop.`,
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
  const { candidate, atr } = result;

  const current = candles4h[candles4h.length - 1];
  const print = retestPrintAt({ candidate, atr, direction, current });
  if (!print) return null;

  const atr15m = atr15mFrom(ctx);
  const stop = nfFlooredRetestStop({ direction, entry: print.entry, retestExtreme: print.retestExtreme, invalidation: candidate.invalidation, atr, atr15m });
  if (!isFiniteNumber(stop)) return null;

  const tp1 = candidate.measuredTarget;
  if (!minRRGate(direction, print.entry, stop, tp1)) return null;

  const reason = [
    `1D trend ${trend} (EMA21/EMA200 stack + slope)`,
    `4h retest of breakout ${candidate.breakoutLevel} within ${RETEST_TOLERANCE_ATR} ATR(4h), closed ${direction === 'long' ? 'above' : 'below'} it at ${print.entry}`,
    `stop ${stop} (retest extreme +/- ${RETEST_STOP_BUFFER_ATR} ATR vs invalidation ${candidate.invalidation}, NF-floored)`,
    `TP1 = measured move ${tp1} (pole length ${candidate.poleHeight})`
  ];

  return {
    direction,
    entry: print.entry,
    stop,
    tp1,
    reason,
    holdRule: structureHoldRule(candidate, OWN_TF)
  };
}

export default { meta, signalAt };
