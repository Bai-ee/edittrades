/**
 * S0 swing research (docs/PROMPT_S0_SWING_RESEARCH.md, Agent S0-C - standard controls):
 * textbook prior-24h-range breakout, 4h closes, gated by 1D bias. No lookahead: the 4h
 * array is defensively re-sliced to `ctx.i`. The 1D array has no per-rule index in the
 * shared ctx (only `i` is defined, scoped to `meta.tf` = '4h'), so this rule relies on
 * the harness's own contract ("every array sliced to closes <= this candle") for
 * `candlesByTf['1d']` - it is used as given, not re-sliced by index.
 *
 * EMA/Donchian-style range are computed directly from the candle arrays - no import
 * from lib/.
 *
 * Range: the prior 6 closed 4h candles (24h), current candle excluded - rangeHigh/Low/
 *   mid/height.
 * Bias: 1D EMA21 vs EMA200 stack on the most recently closed daily candle available at
 *   this 4h close (bullish if EMA21(1D) > EMA200(1D), bearish if reversed, no trade if
 *   equal or 1D history is short).
 * Entry: current 4h close outside the prior-24h range, in the 1D bias direction.
 * Stop: range midpoint.
 * Target: TP1 = entry +/- one range-height (a measured move projected off the
 *   breakout, per spec line 33's "TP1 = range height").
 * Hold: 24h (spec-stated).
 */

export const meta = {
  id: 'ctl-4h-range-break',
  label: 'Control: prior-24h range breakout (4h, 1D-bias-aligned)',
  source: 'docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C',
  tf: '4h',
  holdMaxHours: 24,
  stopKind: 'structure',
  notes: 'Breaks the prior 6x4h (24h) range in the EMA21/EMA200(1D) bias direction; stop = range midpoint; TP1 = one range-height measured move. Hold 24h per spec.'
};

const RANGE_LOOKBACK_4H = 6; // 6 x 4h = 24h
const EMA_FAST = 21;
const EMA_SLOW = 200;

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

/** 1D EMA21/EMA200 bias off the given (already-sliced-by-the-harness) daily array. Null if too short or flat. */
export function dailyBias(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < EMA_SLOW) return null;
  const closes = dailyCandles.map((c) => c.close);
  const ema21 = emaSeries(closes, EMA_FAST);
  const ema200 = emaSeries(closes, EMA_SLOW);
  const last = closes.length - 1;
  if (ema21[last] === null || ema200[last] === null) return null;
  if (ema21[last] > ema200[last]) return 'long';
  if (ema21[last] < ema200[last]) return 'short';
  return null;
}

/** Prior-24h 4h range (excludes the current candle) + midpoint/height. Null if too short. */
export function rangeAt(candles4h) {
  const n = candles4h.length;
  if (n < RANGE_LOOKBACK_4H + 1) return null;
  const { high, low } = highLow(candles4h, n - 1 - RANGE_LOOKBACK_4H, n - 1);
  return { high, low, mid: (high + low) / 2, height: high - low };
}

export function signalAt(ctx) {
  const { candlesByTf, i } = ctx || {};
  const raw4h = candlesByTf && candlesByTf['4h'];
  const daily = candlesByTf && candlesByTf['1d'];
  if (!Array.isArray(raw4h) || !Number.isInteger(i) || i < 0) return null;

  const candles4h = raw4h.slice(0, i + 1); // defensive: never trust anything past i
  const range = rangeAt(candles4h);
  if (!range || !(range.height > 0)) return null;

  const bias = dailyBias(daily);
  if (!bias) return null;

  const current = candles4h[candles4h.length - 1];
  let direction = null;
  if (bias === 'long' && current.close > range.high) direction = 'long';
  else if (bias === 'short' && current.close < range.low) direction = 'short';
  if (!direction) return null;

  const entry = current.close;
  const stop = range.mid;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = direction === 'long' ? entry + range.height : entry - range.height;

  return {
    direction,
    entry,
    stop,
    tp1,
    reason: [
      `4h close ${entry} broke ${direction === 'long' ? 'above the prior-24h high' : 'below the prior-24h low'} (${direction === 'long' ? range.high : range.low})`,
      `1D EMA21/EMA200 bias: ${bias}`,
      `stop at the 24h range midpoint (${stop}); TP1 = entry +/- one range-height (${range.height}) -> ${tp1}`
    ]
  };
}
