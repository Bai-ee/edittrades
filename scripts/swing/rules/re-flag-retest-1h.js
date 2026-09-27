/**
 * S3 playbook rule: re-flag-retest-1h (docs/PROMPT_S3_RETEST_ENTRY.md) - the same
 * retest-entry rule as re-flag-retest-4h.js, run on 1h flags, with a 1D/4h trend gate
 * (BOTH the 1D and the 4h EMA21/EMA200 stack + slope read must agree, per the prompt's
 * "same rule on 1h flags with a 1D/4h trend gate" - a 1h flag is much closer to noise
 * than a 4h one, so the extra 4h confirmation is the compensating filter).
 *
 * Entry: after the 1h flag (lib/patternDetector.js detectFlagLifecycle) reaches
 *   triggering, wait for a close within 0.25 x ATR(1h) of the breakout level that holds
 *   in the trade direction; entry = that close.
 * Stop: min(retest low - 0.1 x ATR(1h), invalidation) for a long (mirrored short), then
 *   floored by the production T-15 net floor (max(0.5 x ATR15m, 3 x round-trip cost)).
 * Target: the flag's measured move; skip when that is under 2.5R off the floored stop.
 * Exit: stop, target, 5 closed 1h candles back inside the flag range, or a 7-day hard cap.
 *
 * No lookahead: the 1h array is truncated to candlesByTf['1h'].slice(0, i + 1); both
 * cross-timeframe trend arrays (1D, 4h) are defensively re-clipped to candles at or
 * before the current 1h candle's close time.
 */

import {
  detectFlagLifecycle, emaSeries, clipTo, isValidCandle, candleTime, trendFromStack,
  retestPrintAt, nfFlooredRetestStop, atr15mFrom, structureHoldRule, minRRGate, isFiniteNumber,
  HOLD_MAX_HOURS, RETEST_TOLERANCE_ATR, RETEST_STOP_BUFFER_ATR, MIN_GROSS_RR,
  NF_ATR_MULT, NF_COST_MULT, STRUCTURE_EXIT_N, EMA_FAST_PERIOD
} from '../retestShared.js';

const OWN_TF = '1h';
const TREND_TF_D = '1d';
const TREND_TF_4H = '4h';

export const meta = {
  id: 're-flag-retest-1h',
  label: '1h flag retest entry, with 1D/4h trend gate (S3)',
  source: 'docs/PROMPT_S3_RETEST_ENTRY.md',
  tf: OWN_TF,
  holdMaxHours: HOLD_MAX_HOURS,
  stopKind: 'structure',
  notes: [
    `Same rule as re-flag-retest-4h.js on 1h flags, gated by BOTH the 1D and the 4h EMA21/EMA200 stack + slope trend (must agree) rather than 1D alone - re-flag-retest-4h.js's own docstring covers the shared mechanics.`,
    `Entry: a close within ${RETEST_TOLERANCE_ATR} ATR(1h) of the breakout level that holds in the trade direction, after the 1h flag reaches triggering. Stop: min(retest low - ${RETEST_STOP_BUFFER_ATR} ATR, invalidation), NF-floored (${NF_ATR_MULT}x ATR15m / ${NF_COST_MULT}x cost). TP1 = measured move; skipped when TP1 < ${MIN_GROSS_RR}R off the stop.`,
    `Exit: stop, target, ${STRUCTURE_EXIT_N} closed 1h candles back inside the flag range, or a 7-day hard cap.`
  ].join('\n')
};

export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw1h = candlesByTf[OWN_TF];
  if (!Array.isArray(raw1h) || i >= raw1h.length) return null;
  const candles1h = raw1h.slice(0, i + 1);
  if (!candles1h.every(isValidCandle)) return null;

  const nowMs = candleTime(candles1h[candles1h.length - 1]);
  if (nowMs === null) return null;

  const dailyCandles = clipTo(candlesByTf[TREND_TF_D], nowMs);
  const fourHCandles = clipTo(candlesByTf[TREND_TF_4H], nowMs);
  const dailyTrend = trendFromStack(dailyCandles);
  const fourHTrend = trendFromStack(fourHCandles);
  const direction = (dailyTrend === 'bull' && fourHTrend === 'bull') ? 'long'
    : (dailyTrend === 'bear' && fourHTrend === 'bear') ? 'short'
      : null;
  if (!direction) return null;

  const ema21_1h = emaSeries(candles1h.map((c) => c.close), EMA_FAST_PERIOD);
  const result = detectFlagLifecycle({ candles: candles1h, ema21History: ema21_1h }, direction);
  if (!result) return null;
  const { candidate, atr } = result;

  const current = candles1h[candles1h.length - 1];
  const print = retestPrintAt({ candidate, atr, direction, current });
  if (!print) return null;

  const atr15m = atr15mFrom(ctx);
  const stop = nfFlooredRetestStop({ direction, entry: print.entry, retestExtreme: print.retestExtreme, invalidation: candidate.invalidation, atr, atr15m });
  if (!isFiniteNumber(stop)) return null;

  const tp1 = candidate.measuredTarget;
  if (!minRRGate(direction, print.entry, stop, tp1)) return null;

  const reason = [
    `1D trend ${dailyTrend} AND 4h trend ${fourHTrend} (EMA21/EMA200 stack + slope, both required)`,
    `1h retest of breakout ${candidate.breakoutLevel} within ${RETEST_TOLERANCE_ATR} ATR(1h), closed ${direction === 'long' ? 'above' : 'below'} it at ${print.entry}`,
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
