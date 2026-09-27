/**
 * S0 swing research (docs/PROMPT_S0_SWING_RESEARCH.md, Agent S0-C - standard controls):
 * textbook 20-day Donchian breakout, 1D closes only. No lookahead: every array this
 * module reads is defensively re-sliced to `ctx.i` before use, never trusting the
 * caller's own slicing alone (the contract's "every array sliced to closes <= this
 * candle" is treated as a hint, not a guarantee this file relies on).
 *
 * EMA/ATR/Donchian are computed directly from `candlesByTf['1d']` closes/highs/lows -
 * no import from lib/ or services/ (S0-C hard rule: no changes under those dirs, and
 * this keeps the rule module fully self-contained per the shared contract).
 *
 * Entry: 1D close breaks above the highest high of the PRIOR 20 daily candles (long) or
 *   below the lowest low of the prior 20 (short) - the classic Donchian breakout
 *   definition (prior N candles, current candle excluded from the channel itself).
 * Bias gate: only take the breakout in the 1D EMA200 direction - close > EMA200 for
 *   long, close < EMA200 for short (read literally from spec line 31: "in the 1D EMA200
 *   direction"; no slope requirement, just price vs. EMA200 on the same candle).
 * Stop: opposite 10-day Donchian extreme (10-day low for a long, 10-day high for a
 *   short), same "prior N, current excluded" convention.
 * Target: TP1 = 2R off that stop distance. No TP2 (spec doesn't ask for one).
 * Hold: 72h (spec doesn't state a hold for this rule; 72h is the longest of the three
 *   allowed buckets (24/48/72) - documented contract gap, see this agent's handback).
 */

export const meta = {
  id: 'ctl-donchian-20d',
  label: 'Control: 20-day Donchian breakout (1D, EMA200-aligned)',
  source: 'docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C',
  tf: '1d',
  holdMaxHours: 72,
  stopKind: 'structure',
  notes: 'Textbook Donchian(20) breakout gated by EMA200(1D) bias; stop = opposite Donchian(10); TP1 = 2R. Hold bucket (72h) not specified in spec - chosen as the longest bucket for a daily-timeframe swing entry.'
};

const EMA_PERIOD = 200;
const ENTRY_LOOKBACK = 20;
const STOP_LOOKBACK = 10;

/** Full-length EMA series (Wilder-style seed: SMA of the first `period` values), aligned to `values`; null before the seed index. */
function emaSeries(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n < period) return out;
  const alpha = 2 / (period + 1);
  let sum = 0;
  for (let k = 0; k < period; k++) sum += values[k];
  out[period - 1] = sum / period;
  for (let k = period; k < n; k++) out[k] = values[k] * alpha + out[k - 1] * (1 - alpha);
  return out;
}

/** Highest high / lowest low over `candles[from..to)` (half-open, both ends clamped to the array). */
function highLow(candles, from, to) {
  const start = Math.max(0, from);
  const end = Math.min(candles.length, to);
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = start; k < end; k++) {
    if (candles[k].high > hi) hi = candles[k].high;
    if (candles[k].low < lo) lo = candles[k].low;
  }
  return { high: hi, low: lo };
}

export function signalAt(ctx) {
  const { candlesByTf, i } = ctx || {};
  const raw = candlesByTf && candlesByTf['1d'];
  if (!Array.isArray(raw) || !Number.isInteger(i) || i < 0) return null;

  const candles = raw.slice(0, i + 1); // defensive: never trust anything past i
  const n = candles.length;
  if (n < ENTRY_LOOKBACK + 1) return null; // need >=20 prior + current

  const closes = candles.map((c) => c.close);
  const ema200 = emaSeries(closes, EMA_PERIOD);
  const ema200Now = ema200[n - 1];
  if (ema200Now === null) return null; // insufficient history for EMA200

  const current = candles[n - 1];
  const bias = current.close > ema200Now ? 'long' : current.close < ema200Now ? 'short' : null;
  if (!bias) return null;

  const entryWindow = highLow(candles, n - 1 - ENTRY_LOOKBACK, n - 1); // prior 20, excludes current
  const stopWindow = highLow(candles, n - 1 - STOP_LOOKBACK, n - 1); // prior 10, excludes current

  let direction = null;
  if (bias === 'long' && current.close > entryWindow.high) direction = 'long';
  else if (bias === 'short' && current.close < entryWindow.low) direction = 'short';
  if (!direction) return null;

  const entry = current.close;
  const stop = direction === 'long' ? stopWindow.low : stopWindow.high;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = direction === 'long' ? entry + 2 * risk : entry - 2 * risk;

  return {
    direction,
    entry,
    stop,
    tp1,
    reason: [
      `1D close ${entry} broke ${direction === 'long' ? 'above the 20-day high' : 'below the 20-day low'} ` +
        `(${direction === 'long' ? entryWindow.high : entryWindow.low}) of the prior 20 daily candles`,
      `EMA200(1D) bias ${bias}: close ${current.close} vs EMA200 ${ema200Now}`,
      `stop at the opposite 10-day Donchian extreme (${stop}); TP1 = 2R (${tp1})`
    ]
  };
}
