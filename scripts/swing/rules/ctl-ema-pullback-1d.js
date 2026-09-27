/**
 * S0 swing research (docs/PROMPT_S0_SWING_RESEARCH.md, Agent S0-C - standard controls):
 * textbook EMA21/EMA200 pullback-and-reclaim, 1D closes only. No lookahead: the 1D
 * candle array is defensively re-sliced to `ctx.i` before use.
 *
 * EMA/ATR are computed directly from `candlesByTf['1d']` - no import from lib/.
 *
 * Trend: EMA21(1D) > EMA200(1D) on both the pullback candle and the entry candle =
 *   uptrend (mirror for downtrend). Requiring the stack on both candles avoids firing
 *   mid-crossover.
 * Pullback: the PRIOR daily close sits at/through EMA21 (<=  EMA21 in an uptrend, >=
 *   EMA21 in a downtrend) - "1D close pulls back to EMA21".
 * Entry: the CURRENT daily close reclaims EMA21 (closes back above it in an uptrend,
 *   back below it in a downtrend). Entry price = that close.
 * Stop: 1.5x ATR(14, Wilder) on 1D, measured from entry (spec line 32 states the stop
 *   as "1.5xATR(1D)" flat, not from the pullback extreme - that variant belongs to
 *   S0-B's `pb-ema21-pullback-1d`, which explicitly adds the pullback-extreme option).
 * Target: TP1 = 2R. No TP2 (spec doesn't ask for one).
 * Hold: 72h (spec doesn't state a hold for this rule; see this agent's handback).
 */

export const meta = {
  id: 'ctl-ema-pullback-1d',
  label: 'Control: EMA21/EMA200 pullback-and-reclaim (1D)',
  source: 'docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C',
  tf: '1d',
  holdMaxHours: 72,
  stopKind: 'atr',
  notes: 'Textbook EMA21 pullback in an EMA21>EMA200 stack, entering on the reclaim close; stop = 1.5xATR(14, 1D) from entry; TP1 = 2R. Hold bucket (72h) not specified in spec - chosen as the longest bucket for a daily-timeframe swing entry.'
};

const EMA_FAST = 21;
const EMA_SLOW = 200;
const ATR_PERIOD = 14;
const ATR_MULT = 1.5;

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

/** Wilder ATR series aligned to `candles`; null before the seed index. */
function atrSeries(candles, period) {
  const n = candles.length;
  const tr = new Array(n);
  for (let k = 0; k < n; k++) {
    const c = candles[k];
    if (k === 0) { tr[k] = c.high - c.low; continue; }
    const prevClose = candles[k - 1].close;
    tr[k] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  const out = new Array(n).fill(null);
  if (n < period) return out;
  let sum = 0;
  for (let k = 0; k < period; k++) sum += tr[k];
  out[period - 1] = sum / period;
  for (let k = period; k < n; k++) out[k] = (out[k - 1] * (period - 1) + tr[k]) / period;
  return out;
}

export function signalAt(ctx) {
  const { candlesByTf, i } = ctx || {};
  const raw = candlesByTf && candlesByTf['1d'];
  if (!Array.isArray(raw) || !Number.isInteger(i) || i < 0) return null;

  const candles = raw.slice(0, i + 1); // defensive: never trust anything past i
  const n = candles.length;
  if (n < 2) return null; // need a pullback candle + an entry candle

  const closes = candles.map((c) => c.close);
  const ema21 = emaSeries(closes, EMA_FAST);
  const ema200 = emaSeries(closes, EMA_SLOW);
  const atr = atrSeries(candles, ATR_PERIOD);

  const now = n - 1;
  const prev = n - 2;
  if (ema21[now] === null || ema200[now] === null || ema21[prev] === null || ema200[prev] === null || atr[now] === null) {
    return null; // insufficient history for EMA200/ATR
  }

  const current = candles[now];
  const pullback = candles[prev];
  const uptrend = ema21[now] > ema200[now] && ema21[prev] > ema200[prev];
  const downtrend = ema21[now] < ema200[now] && ema21[prev] < ema200[prev];

  let direction = null;
  if (uptrend && pullback.close <= ema21[prev] && current.close > ema21[now]) direction = 'long';
  else if (downtrend && pullback.close >= ema21[prev] && current.close < ema21[now]) direction = 'short';
  if (!direction) return null;

  const entry = current.close;
  const stopDist = ATR_MULT * atr[now];
  const stop = direction === 'long' ? entry - stopDist : entry + stopDist;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = direction === 'long' ? entry + 2 * risk : entry - 2 * risk;

  return {
    direction,
    entry,
    stop,
    tp1,
    reason: [
      `EMA21(1D) ${direction === 'long' ? '>' : '<'} EMA200(1D) on the pullback and entry candles (${direction === 'long' ? 'uptrend' : 'downtrend'})`,
      `prior 1D close ${pullback.close} pulled back ${direction === 'long' ? 'to/through' : 'up to'} EMA21 (${ema21[prev]}); current close ${entry} reclaimed EMA21 (${ema21[now]})`,
      `stop = 1.5x ATR14(1D) (${atr[now]}) from entry -> ${stop}; TP1 = 2R (${tp1})`
    ]
  };
}
