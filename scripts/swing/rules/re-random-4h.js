/**
 * S3 control: re-random-4h (docs/PROMPT_S3_RETEST_ENTRY.md) - "seeded control with the
 * retest mechanics": the SAME retest entry, NF-floored stop, measured-move target, gross
 * R:R gate and structure-exit/7-day-cap mechanics as re-flag-retest-4h.js, but the
 * direction is a seeded coin flip (same FNV-1a -> mulberry32 technique as
 * scripts/swing/rules/ctl-random-4h.js / mr-random-1h.js) instead of the 1D trend read.
 * A flag is still required in that randomly-chosen direction (detectFlagLifecycle is run
 * on whichever direction the draw picked) and the signal is skipped when that direction
 * has no qualifying retest print at this candle - same "skip, don't force a trade"
 * convention ctl-random-4h.js already uses. This isolates what the 1D trend gate is
 * worth: the entry/stop/target/exit mechanics are held fixed, only the direction source
 * changes (trend read vs. coin flip).
 *
 * Entry: a close within 0.25 x ATR(4h) of the breakout level, in the randomly drawn
 *   direction, that holds - identical print condition to re-flag-retest-4h.js.
 * Stop: min(retest low - 0.1 x ATR(4h), invalidation), NF-floored.
 * Target: the flag's measured move; skip when that is under 2.5R off the floored stop.
 * Exit: stop, target, 5 closed 4h candles back inside the flag range, or a 7-day hard cap.
 *
 * No lookahead: the 4h array is truncated to candlesByTf['4h'].slice(0, i + 1).
 */

import {
  detectFlagLifecycle, emaSeries, isValidCandle, retestPrintAt, nfFlooredRetestStop,
  atr15mFrom, structureHoldRule, minRRGate, seededDraw, isFiniteNumber,
  HOLD_MAX_HOURS, RETEST_TOLERANCE_ATR, RETEST_STOP_BUFFER_ATR, MIN_GROSS_RR,
  NF_ATR_MULT, NF_COST_MULT, STRUCTURE_EXIT_N, EMA_FAST_PERIOD
} from '../retestShared.js';

const OWN_TF = '4h';

export const meta = {
  id: 're-random-4h',
  label: 'Control: seeded random direction, retest-entry mechanics (S3)',
  source: 'docs/PROMPT_S3_RETEST_ENTRY.md',
  tf: OWN_TF,
  holdMaxHours: HOLD_MAX_HOURS,
  stopKind: 'structure',
  notes: [
    'Null baseline for re-flag-retest-4h.js: seeded (RANDOM_SEED=2026) deterministic random direction at every 4h close, no 1D trend gate - same FNV-1a -> mulberry32 seeding as ctl-random-4h.js/mr-random-1h.js. Requires a qualifying flag + retest print in the randomly drawn direction; skipped (not forced) otherwise.',
    `Entry/stop/target mechanics identical to re-flag-retest-4h.js: retest within ${RETEST_TOLERANCE_ATR} ATR(4h), stop min(retest low - ${RETEST_STOP_BUFFER_ATR} ATR, invalidation) NF-floored (${NF_ATR_MULT}x ATR15m / ${NF_COST_MULT}x cost), TP1 = measured move, skipped when TP1 < ${MIN_GROSS_RR}R off the stop.`,
    `Exit: stop, target, ${STRUCTURE_EXIT_N} closed 4h candles back inside the flag range, or a 7-day hard cap - isolates what the 1D trend gate is worth against otherwise-identical mechanics.`
  ].join('\n')
};

export const RANDOM_SEED = 2026;

export function signalAt(ctx) {
  const { i, candlesByTf, symbol } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf || !symbol) return null;

  const raw4h = candlesByTf[OWN_TF];
  if (!Array.isArray(raw4h) || i >= raw4h.length) return null;
  const candles4h = raw4h.slice(0, i + 1);
  if (!candles4h.every(isValidCandle)) return null;

  const current = candles4h[candles4h.length - 1];
  const draw = seededDraw(RANDOM_SEED, symbol, current.timestamp);
  const direction = draw < 0.5 ? 'long' : 'short';

  const ema21_4h = emaSeries(candles4h.map((c) => c.close), EMA_FAST_PERIOD);
  const result = detectFlagLifecycle({ candles: candles4h, ema21History: ema21_4h }, direction);
  if (!result) return null;
  const { candidate, atr } = result;

  const print = retestPrintAt({ candidate, atr, direction, current });
  if (!print) return null;

  const atr15m = atr15mFrom(ctx);
  const stop = nfFlooredRetestStop({ direction, entry: print.entry, retestExtreme: print.retestExtreme, invalidation: candidate.invalidation, atr, atr15m });
  if (!isFiniteNumber(stop)) return null;

  const tp1 = candidate.measuredTarget;
  if (!minRRGate(direction, print.entry, stop, tp1)) return null;

  const reason = [
    `seeded random draw ${draw.toFixed(4)} (seed ${RANDOM_SEED}, symbol ${symbol}, ts ${current.timestamp}) -> ${direction}, no trend gate`,
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
