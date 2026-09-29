/**
 * T-24 prediction rule (docs/PROMPT_T24_PREDICTION_TRACKER.md, Agent A - "rule + replay").
 * Pure, no I/O, no lookahead, deterministic: same candles in -> same call out, always.
 *
 * v1 rule ("simple, stated in the file header" per the prompt): five independent
 * bullish/bearish votes, one point each, no weighting:
 *   1. close > EMA21 on `timeframe`            (bearish mirror: close < EMA21)
 *   2. EMA21 > EMA200 on `timeframe`            (bearish mirror: EMA21 < EMA200)
 *   3. close > EMA21 on the next timeframe up   (bearish mirror: close < EMA21)
 *   4. Stoch RSI %K rising and < 80             (bearish mirror: falling and > 20)
 *   5. the last confirmed swing pivot is a higher high (bearish mirror: a lower low;
 *      a higher low / lower high / no pivot casts no vote either way)
 * `score` = sum of the five votes (+1/-1/0 each). `over` when score >= +2, `under` when
 * score <= -2, otherwise `no_call`. `confidence` = |score| / 5.
 *
 * A vote that cannot be computed (not enough history for that ONE input - typically the
 * higher-timeframe EMA21 or a swing pivot) casts no vote (0) rather than failing the whole
 * call; only `candles` itself being too short to seed EMA200 fails the whole call with
 * `no_call` / confidence 0 and every `inputs.*` null. This is the "higher-tf tie-break"
 * behaviour: a short/missing `higherCandles` never turns into over/under by default, it
 * just removes one vote from the score.
 *
 * Reuses existing pure helpers rather than reimplementing indicators:
 *   - `emaSeries` (lib/retestShared.js) - the SMA-seeded EMA lib/htfEntryRule.js already
 *     uses for its own 4h/1D EMA21/EMA200 stack.
 *   - `swingPivots` / `higherHighs` / `lowerLows` (lib/geometry.js) - the same confirmed-
 *     pivot detector Geometry A/B and lib/htfEntryRule.js's 1h swing anchor use.
 *   - `calculateStochasticRSI` (services/indicators.js) - the one Stoch RSI calculation in
 *     the codebase (technicalindicators' StochasticRSI, rsiPeriod/stochasticPeriod 14,
 *     kPeriod/dPeriod 3); `lib/` already imports across the services/ boundary for a
 *     leaf helper (lib/htfEntryRule.js pulls `INTERVAL_MS` from services/scalpContext.js),
 *     so this is the same established pattern, not a new one.
 *
 * `candles` / `higherCandles` shape: closed candles, oldest -> newest, the same
 * `{timestamp, open, high, low, close, volume, closeTime}` object every lib/geometry.js
 * consumer already passes (test/fixtures/history/*.json's own shape).
 */

import { ENGINE_CONFIG } from '../config/engine.js';
import { swingPivots, higherHighs, lowerLows } from './geometry.js';
import { emaSeries, isValidCandle, isFiniteNumber } from './retestShared.js';
import { calculateStochasticRSI } from '../services/indicators.js';

export const PREDICTION_TIMEFRAMES = Object.freeze(['5m', '15m', '1h', '4h']);
export const PREDICTION_SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL']);
export const HIGHER_TF = Object.freeze({ '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d' });

export const EMA_FAST_PERIOD = 21;
export const EMA_SLOW_PERIOD = 200;
// "candles ... >= 210" (the shared contract): EMA200 needs 200 closes to seed plus a small
// buffer so the EMA21/EMA200/stoch/swing reads are past their own warm-up noise.
export const MIN_CANDLES = EMA_SLOW_PERIOD + 10;
export const RULE_VERSION = 'pred-1';

const OVER_THRESHOLD = 2;
const UNDER_THRESHOLD = -2;
const VOTE_COUNT = 5;

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clampK(k) {
  return isFiniteNumber(k) ? Math.min(100, Math.max(0, k)) : null;
}

function emptyInputs() {
  return { ema21Side: null, ema200Side: null, higherEma21Side: null, stoch: null, lastSwing: null };
}

function noCall(reason) {
  return { direction: 'no_call', confidence: 0, inputs: emptyInputs(), reason };
}

/**
 * Vote 3: close vs EMA21 on the higher timeframe. Returns `{ side, vote }` where `side` is
 * `'above'|'below'|'flat'|null` (null = could not be computed - too few/invalid candles)
 * and `vote` is the score contribution (0 when `side` is null or `'flat'`).
 */
function higherEma21Vote(higherCandles) {
  if (!Array.isArray(higherCandles) || higherCandles.length < EMA_FAST_PERIOD || !higherCandles.every(isValidCandle)) {
    return { side: null, vote: 0 };
  }
  const closes = higherCandles.map((c) => c.close);
  const series = emaSeries(closes, EMA_FAST_PERIOD);
  const last = closes.length - 1;
  const ema21 = series[last];
  if (!isFiniteNumber(ema21)) return { side: null, vote: 0 };
  const close = closes[last];
  if (close > ema21) return { side: 'above', vote: 1 };
  if (close < ema21) return { side: 'below', vote: -1 };
  return { side: 'flat', vote: 0 };
}

/**
 * Vote 4: Stoch RSI %K direction. `stoch` is null when there is not enough history for the
 * indicator (should not happen once `candles.length >= MIN_CANDLES`, defensive only).
 */
function stochVote(closes) {
  let history;
  try {
    history = calculateStochasticRSI(closes);
  } catch {
    return { stoch: null, vote: 0 };
  }
  if (!Array.isArray(history) || history.length < 2) return { stoch: null, vote: 0 };
  const kLast = clampK(history[history.length - 1].k);
  const kPrev = clampK(history[history.length - 2].k);
  if (!isFiniteNumber(kLast) || !isFiniteNumber(kPrev)) return { stoch: null, vote: 0 };

  const direction = kLast > kPrev ? 'rising' : (kLast < kPrev ? 'falling' : 'flat');
  const bullish = direction === 'rising' && kLast < 80;
  const bearish = direction === 'falling' && kLast > 20;
  const stoch = { k: roundN(kLast, 2), direction, bullish, bearish };
  return { stoch, vote: bullish ? 1 : (bearish ? -1 : 0) };
}

/**
 * Vote 5: the last confirmed swing pivot (whichever of `pivots.highs`/`pivots.lows` has
 * the more recent index). `label` is `'higher_high'`/`'lower_low'` only when that pivot
 * continues an active run (geometry.js `higherHighs`/`lowerLows`) - a higher low or a
 * lower high casts no vote either way, per the prompt's literal "last swing higher-high"
 * / "last swing lower-low" wording.
 */
function lastSwingVote(pivots) {
  const highs = pivots.highs || [];
  const lows = pivots.lows || [];
  const lastHigh = highs.length ? highs[highs.length - 1] : null;
  const lastLow = lows.length ? lows[lows.length - 1] : null;

  let kind = null;
  if (lastHigh && (!lastLow || lastHigh.index > lastLow.index)) kind = 'high';
  else if (lastLow) kind = 'low';
  if (!kind) return { lastSwing: { kind: null, label: 'none' }, vote: 0 };

  if (kind === 'high') {
    const label = higherHighs(pivots).active ? 'higher_high' : 'other';
    return { lastSwing: { kind, label }, vote: label === 'higher_high' ? 1 : 0 };
  }
  const label = lowerLows(pivots).active ? 'lower_low' : 'other';
  return { lastSwing: { kind, label }, vote: label === 'lower_low' ? -1 : 0 };
}

/**
 * `predictNextCandle({ symbol, timeframe, candles, higherCandles }) -> { direction,
 * confidence, inputs, reason }` per the T-24 shared contract. Pure, deterministic, no
 * lookahead (only ever reads `candles`/`higherCandles` as given - the caller is
 * responsible for clipping to closed candles).
 */
export function predictNextCandle({ symbol, timeframe, candles, higherCandles } = {}) {
  const tag = `${symbol || '?'} ${timeframe || '?'}`;

  if (!Array.isArray(candles) || candles.length < MIN_CANDLES || !candles.every(isValidCandle)) {
    const got = Array.isArray(candles) ? candles.length : 0;
    return noCall(`${tag}: insufficient history (need >= ${MIN_CANDLES} valid closed candles, got ${got})`);
  }

  const closes = candles.map((c) => c.close);
  const ema21Series = emaSeries(closes, EMA_FAST_PERIOD);
  const ema200Series = emaSeries(closes, EMA_SLOW_PERIOD);
  const last = closes.length - 1;
  const close = closes[last];
  const ema21 = ema21Series[last];
  const ema200 = ema200Series[last];
  if (!isFiniteNumber(ema21) || !isFiniteNumber(ema200)) {
    return noCall(`${tag}: EMA21/EMA200 could not be computed from ${candles.length} candles`);
  }

  let score = 0;
  const parts = [];

  // Vote 1: close vs EMA21 (this timeframe)
  let ema21Side = 'flat';
  if (close > ema21) { ema21Side = 'above'; score += 1; parts.push('close>EMA21(tf)'); }
  else if (close < ema21) { ema21Side = 'below'; score -= 1; parts.push('close<EMA21(tf)'); }

  // Vote 2: EMA21 vs EMA200 (this timeframe)
  let ema200Side = 'flat';
  if (ema21 > ema200) { ema200Side = 'above'; score += 1; parts.push('EMA21>EMA200(tf)'); }
  else if (ema21 < ema200) { ema200Side = 'below'; score -= 1; parts.push('EMA21<EMA200(tf)'); }

  // Vote 3: close vs EMA21 (higher timeframe) - no vote when unavailable
  const higher = higherEma21Vote(higherCandles);
  if (higher.vote > 0) parts.push('close>EMA21(higherTf)');
  else if (higher.vote < 0) parts.push('close<EMA21(higherTf)');
  score += higher.vote;

  // Vote 4: Stoch RSI %K direction
  const stoch = stochVote(closes);
  if (stoch.vote > 0) parts.push('stochRSI rising<80');
  else if (stoch.vote < 0) parts.push('stochRSI falling>20');
  score += stoch.vote;

  // Vote 5: last confirmed swing pivot
  const pivots = swingPivots(candles, ENGINE_CONFIG.geometry.pivotLeft, ENGINE_CONFIG.geometry.pivotRight);
  const swing = lastSwingVote(pivots);
  if (swing.vote > 0) parts.push('lastSwing higher_high');
  else if (swing.vote < 0) parts.push('lastSwing lower_low');
  score += swing.vote;

  const direction = score >= OVER_THRESHOLD ? 'over' : (score <= UNDER_THRESHOLD ? 'under' : 'no_call');
  const confidence = roundN(Math.abs(score) / VOTE_COUNT, 2);

  return {
    direction,
    confidence,
    inputs: {
      ema21Side,
      ema200Side,
      higherEma21Side: higher.side,
      stoch: stoch.stoch,
      lastSwing: swing.lastSwing
    },
    reason: `${tag}: score ${score >= 0 ? '+' : ''}${score}/${VOTE_COUNT} (${parts.length ? parts.join(', ') : 'no signal'}) -> ${direction}`
  };
}

export default {
  predictNextCandle,
  PREDICTION_TIMEFRAMES,
  PREDICTION_SYMBOLS,
  HIGHER_TF,
  EMA_FAST_PERIOD,
  EMA_SLOW_PERIOD,
  MIN_CANDLES,
  RULE_VERSION
};
