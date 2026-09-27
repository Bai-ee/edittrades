/**
 * S0-B playbook rule: pb-4h-flag-continuation.
 *
 * A momentum-continuation flag on the 4h timeframe, taken only in the direction of the
 * 1D trend (MASTER_PLAN_TRADING_MODEL.md M-1: read the higher timeframe first, drill
 * down for the entry) and only the strategy's own EMA21/EMA200 stack read of that
 * trend, not a veto (M-2/M-6: alignment/direction inputs never cancel a trade on their
 * own here - this rule simply declines to fire counter-trend rather than reversing the
 * flag). The flag itself is M-5's setup ("a flag is compressed price coming off a
 * longer pump/dump, riding the EMA21") and M-5b's measured-move target (pole length
 * projected from the breakout) applied on 4h candles via the production flag detector.
 *
 * Reuses `lib/patternDetector.js` (`detectFlagLifecycle`) read-only, per the S0
 * playbook-rules contract - the detector is timeframe-agnostic (it only reasons about
 * candle counts and an EMA21 series aligned to them), so calling it on 4h candles is
 * exactly "the same pole/consolidation rule in 4h terms". EMA21 is computed locally
 * (self-contained, no dependency on indicatorsByTf) with the same SMA-seeded formula
 * `lib/topDown.js` uses.
 *
 * No lookahead: the 4h array is truncated to `candlesByTf['4h'].slice(0, i + 1)`; the
 * cross-timeframe 1D trend array is defensively re-clipped to candles at or before the
 * current 4h candle's close time.
 */

import { detectFlagLifecycle } from '../../../lib/patternDetector.js';

const OWN_TF = '4h';
const TREND_TF = '1d';

const EMA_FAST_PERIOD = 21;
const EMA_SLOW_PERIOD = 200;
const TREND_SLOPE_LOOKBACK_DAYS = 5;
const MIN_DAILY_CANDLES = EMA_SLOW_PERIOD + TREND_SLOPE_LOOKBACK_DAYS + 1;

export const meta = {
  id: 'pb-4h-flag-continuation',
  label: '4h flag continuation, with 1D trend',
  source: 'docs/MASTER_PLAN_TRADING_MODEL.md M-1, M-5, M-5b, M-6',
  tf: OWN_TF,
  holdMaxHours: 48,
  stopKind: 'structure',
  notes: [
    'M-1/M-6: 1D EMA21/EMA200 stack + slope sets the direction; the flag is only taken with that direction, never against it.',
    'M-5: the setup is a flag on the EMA21 (impulse then compression); this rule reuses lib/patternDetector.js on 4h candles instead of re-deriving the same pole/consolidation logic.',
    'M-5b: TP1 is the measured move (pole length projected from the breakout); stop is the flag invalidation level (opposite border), fired on the exact 4h close that first closes past the flag border.'
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
function emaSeries(values, period) {
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

/** Same 1D EMA21/EMA200 stack + slope trend read as pb-ema21-pullback-1d.js. */
function dailyTrend(dailyCandles) {
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

function clipTo(candles, cutoffMs) {
  if (!Array.isArray(candles)) return [];
  return candles.filter((c) => {
    const t = candleTime(c);
    return t === null ? false : t <= cutoffMs;
  });
}

/**
 * @param {Object} ctx - { symbol, tf, i, candlesByTf } per the S0 swing-research contract
 * @returns {null|{direction:'long'|'short', entry:number, stop:number, tp1:number, reason:string[]}}
 */
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
  const trend = dailyTrend(dailyCandles);
  const direction = trend === 'bull' ? 'long' : trend === 'bear' ? 'short' : null;
  if (!direction) return null;

  const ema21_4h = emaSeries(candles4h.map((c) => c.close), EMA_FAST_PERIOD);
  const result = detectFlagLifecycle({ candles: candles4h, ema21History: ema21_4h }, direction);
  if (!result) return null;

  const { candidate } = result;
  // Only the exact 4h close the flag first broke out on (breakCount 1 -> ageCandles 0),
  // and only while it is still "triggering" (not yet confirmed by a second close, not
  // expired/failed) - the breakout close itself, per the contract's "entry breakout close".
  if (candidate.state !== 'triggering' || candidate.ageCandles !== 0) return null;
  if (!isFiniteNumber(candidate.measuredTarget)) return null;

  const entry = candles4h[candles4h.length - 1].close;
  const stop = candidate.invalidation;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = candidate.measuredTarget;

  const reason = [
    `1D trend ${trend} (EMA21/EMA200 stack + ${TREND_SLOPE_LOOKBACK_DAYS}d EMA21 slope)`,
    `4h flag breakout close beyond ${direction === 'long' ? 'flagHigh' : 'flagLow'} (breakoutLevel ${candidate.breakoutLevel})`,
    `TP1 = measured move from pole length ${candidate.poleHeight} (measuredRR ${candidate.measuredRR})`
  ];

  return { direction, entry, stop, tp1, reason };
}

export default { meta, signalAt };
