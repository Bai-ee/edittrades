/**
 * S0-B playbook rule: pb-ema21-pullback-1d.
 *
 * Direction from the 1D EMA21/EMA200 stack and slope (MASTER_PLAN_TRADING_MODEL.md
 * M-6, M-6b: EMA21/EMA200 set direction on every timeframe, higher timeframes carry
 * more weight); entry timed on the 4h close that reclaims the 4h EMA21 right after a
 * pullback to it, matching M-1's top-down-then-drill-down read (1D direction, 4h
 * timing) and M-5's "flag on the EMA21" idea applied to a swing pullback instead of a
 * flag box. Stop uses the pullback extreme unless 1.5x ATR(4h) is tighter, and TP1's
 * 3R-minimum spirit (M-9) is respected structurally by the 2R/prior-1D-swing pairing
 * below (2R to TP1, TP2 further out at the prior swing).
 *
 * Self-contained on purpose: EMA/ATR/pivots are computed directly from candlesByTf so
 * this module has no dependency on lib/, services/, or config/ (S0-B may not touch
 * those directories) and no dependency on the harness's indicatorsByTf/topDown/geometry
 * shapes, which are still being built in parallel (S0-A).
 *
 * No lookahead: the rule's own timeframe (4h) is truncated to `candlesByTf['4h'].slice(0,
 * i + 1)`; the cross-timeframe 1D array is defensively re-clipped to candles whose
 * closeTime/timestamp is at or before the current 4h candle's close time, so a harness
 * bug (or a test) that hands this rule a longer 1D array than it should see cannot leak
 * a future daily candle into the trend read.
 */

const OWN_TF = '4h';
const TREND_TF = '1d';

const EMA_FAST_PERIOD = 21;
const EMA_SLOW_PERIOD = 200;
const TREND_SLOPE_LOOKBACK_DAYS = 5;
const MIN_DAILY_CANDLES = EMA_SLOW_PERIOD + TREND_SLOPE_LOOKBACK_DAYS + 1;

const ATR_PERIOD_4H = 14;
const MIN_4H_CANDLES = Math.max(EMA_FAST_PERIOD, ATR_PERIOD_4H) + 2;

const ATR_STOP_MULTIPLE = 1.5;
const TP1_R_MULTIPLE = 2;
const SWING_PIVOT_LEFT = 3;
const SWING_PIVOT_RIGHT = 3;

export const meta = {
  id: 'pb-ema21-pullback-1d',
  label: '1D-trend EMA21 pullback (4h entry)',
  source: 'docs/MASTER_PLAN_TRADING_MODEL.md M-1, M-6, M-6b, M-9',
  tf: OWN_TF,
  holdMaxHours: 72,
  stopKind: 'structure',
  notes: [
    'M-1/M-6b: direction comes from the higher timeframe (1D EMA21/EMA200 stack + slope), entry is timed on the lower timeframe (4h close).',
    'M-5/M-6: the EMA21 pulls price back to it without being a target; entry is the first 4h close that reclaims EMA21(4h) right after price touched or closed through it.',
    'M-9: stop is the tighter of the pullback extreme or 1.5x ATR(4h) so a losing trade stays small; TP1 is 2R and TP2 reaches for the prior 1D swing, keeping reward ahead of the 3R-minimum spirit.'
  ].join('\n')
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function candleTime(c) {
  if (isFiniteNumber(c.closeTime)) return c.closeTime;
  if (isFiniteNumber(c.timestamp)) return c.timestamp;
  return null;
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

/** SMA-seeded EMA, tail-aligned 1:1 to `values`; entries before `period - 1` are null. */
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

/** Simple (non-Wilder) N-period average true range ending at the series' last candle. */
export function simpleAtr(candles, period) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const n = candles.length;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    sum += tr;
  }
  return sum / period;
}

/**
 * 1D trend from the EMA21/EMA200 stack and the EMA21 slope over the last
 * TREND_SLOPE_LOOKBACK_DAYS candles. Returns null (neutral / indeterminate / insufficient
 * history) when the stack does not agree with the slope direction.
 */
export function dailyTrend(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < MIN_DAILY_CANDLES) return null;
  if (!dailyCandles.every(isValidCandle)) return null;
  const closes = dailyCandles.map((c) => c.close);
  const ema21 = emaSeries(closes, EMA_FAST_PERIOD);
  const ema200 = emaSeries(closes, EMA_SLOW_PERIOD);
  const last = closes.length - 1;
  const priorIdx = last - TREND_SLOPE_LOOKBACK_DAYS;
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

/** Fractal swing pivots (needs `right` confirming candles, so the tail can't be one). */
function findPivots(candles, left, right, useHigh) {
  const out = [];
  for (let k = left; k < candles.length - right; k++) {
    const val = useHigh ? candles[k].high : candles[k].low;
    let ok = true;
    for (let j = k - left; j < k && ok; j++) {
      const v = useHigh ? candles[j].high : candles[j].low;
      if (!(useHigh ? val > v : val < v)) ok = false;
    }
    for (let j = k + 1; j <= k + right && ok; j++) {
      const v = useHigh ? candles[j].high : candles[j].low;
      if (!(useHigh ? val >= v : val <= v)) ok = false;
    }
    if (ok) out.push({ index: k, price: val });
  }
  return out;
}

/** Nearest-in-time prior 1D swing beyond `entry` (high above for long, low below for short). */
function priorSwingTarget(dailyCandles, entry, direction) {
  const pivots = findPivots(dailyCandles, SWING_PIVOT_LEFT, SWING_PIVOT_RIGHT, direction === 'long');
  const beyond = pivots.filter((p) => (direction === 'long' ? p.price > entry : p.price < entry));
  if (beyond.length === 0) return null;
  beyond.sort((a, b) => b.index - a.index);
  return beyond[0].price;
}

/** Re-clip a cross-timeframe candle array to closes at or before `cutoffMs` (no lookahead). */
function clipTo(candles, cutoffMs) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => {
    const t = candleTime(c);
    return t === null ? false : t <= cutoffMs;
  });
}

/**
 * @param {Object} ctx - { symbol, tf, i, candlesByTf } per the S0 swing-research contract
 * @returns {null|{direction:'long'|'short', entry:number, stop:number, tp1:number, tp2?:number, reason:string[]}}
 */
export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw4h = candlesByTf[OWN_TF];
  if (!Array.isArray(raw4h) || i >= raw4h.length) return null;
  const candles4h = raw4h.slice(0, i + 1);
  if (candles4h.length < MIN_4H_CANDLES || !candles4h.every(isValidCandle)) return null;

  const lastIdx4h = candles4h.length - 1;
  const nowMs = candleTime(candles4h[lastIdx4h]);
  if (nowMs === null) return null;

  const dailyCandles = clipTo(candlesByTf[TREND_TF], nowMs);
  const trend = dailyTrend(dailyCandles);
  if (trend !== 'bull' && trend !== 'bear') return null;

  const closes4h = candles4h.map((c) => c.close);
  const ema21_4h = emaSeries(closes4h, EMA_FAST_PERIOD);
  const emaLast = ema21_4h[lastIdx4h];
  const emaPrev = ema21_4h[lastIdx4h - 1];
  if (!isFiniteNumber(emaLast) || !isFiniteNumber(emaPrev)) return null;

  const atr4h = simpleAtr(candles4h, ATR_PERIOD_4H);
  if (!isFiniteNumber(atr4h) || atr4h <= 0) return null;

  const closeLast = candles4h[lastIdx4h].close;
  const closePrev = candles4h[lastIdx4h - 1].close;

  const direction = trend === 'bull' ? 'long' : 'short';
  const reclaimedLong = direction === 'long' && closePrev <= emaPrev && closeLast > emaLast;
  const reclaimedShort = direction === 'short' && closePrev >= emaPrev && closeLast < emaLast;
  if (!reclaimedLong && !reclaimedShort) return null;

  // Pullback extreme: scan back over the contiguous run of closes on the wrong side of
  // EMA21 that ends at the prior candle (at least that one candle).
  let idx = lastIdx4h - 1;
  let extreme = direction === 'long' ? candles4h[idx].low : candles4h[idx].high;
  while (idx >= 0 && isFiniteNumber(ema21_4h[idx])
    && (direction === 'long' ? candles4h[idx].close <= ema21_4h[idx] : candles4h[idx].close >= ema21_4h[idx])) {
    extreme = direction === 'long' ? Math.min(extreme, candles4h[idx].low) : Math.max(extreme, candles4h[idx].high);
    idx--;
  }

  const entry = closeLast;
  const atrStop = direction === 'long' ? entry - ATR_STOP_MULTIPLE * atr4h : entry + ATR_STOP_MULTIPLE * atr4h;
  const stop = direction === 'long' ? Math.max(extreme, atrStop) : Math.min(extreme, atrStop);
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = direction === 'long' ? entry + TP1_R_MULTIPLE * risk : entry - TP1_R_MULTIPLE * risk;
  const swingTarget = priorSwingTarget(dailyCandles, entry, direction);

  const reason = [
    `1D trend ${trend} (EMA21/EMA200 stack + ${TREND_SLOPE_LOOKBACK_DAYS}d EMA21 slope)`,
    `4h close reclaimed EMA21(4h) after a pullback (prev close ${closePrev} vs EMA21 ${roundLog(emaPrev)}, now ${closeLast} vs ${roundLog(emaLast)})`,
    `stop = ${direction === 'long' ? 'max' : 'min'}(pullback extreme ${roundLog(extreme)}, ${ATR_STOP_MULTIPLE}x ATR4h ${roundLog(atrStop)})`
  ];

  const signal = { direction, entry, stop, tp1, reason };
  if (isFiniteNumber(swingTarget)) signal.tp2 = swingTarget;
  return signal;
}

function roundLog(v) {
  return isFiniteNumber(v) ? Math.round(v * 100) / 100 : v;
}

export default { meta, signalAt };
