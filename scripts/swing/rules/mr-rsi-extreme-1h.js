/**
 * S1 mean-reversion rule: mr-rsi-extreme-1h (docs/PROMPT_S1_EDGE_SEARCH.md Agent D).
 *
 * RSI14(1h) beyond a hard extreme (< 25 long / > 75 short - past the 30/70 overbought/
 * oversold bands services/indicators.js itself flags) while the 1h close also sits inside
 * a horizontal support/resistance zone (any side - the RSI extreme carries the direction
 * here, the zone is a selectivity filter, not a second vote), computed the same way as
 * mr-zone-touch-1h (imported from it, not reimplemented, so both rules share one zone
 * definition). Stop = 1x ATR(1h) from entry; TP1 = EMA21(1h), only taken when it sits on
 * the profitable side of entry. Hold 24h.
 *
 * RSI14 is a local Wilder-smoothed implementation (SMA-seeded first average, Wilder
 * smoothing after) - the same method the `technicalindicators` library's RSI.calculate
 * uses (services/indicators.js's own RSI) - kept local so this module stays self-
 * contained on candlesByTf, matching every other scripts/swing/rules/*.js module.
 *
 * No lookahead: the 1h array is truncated to `candlesByTf['1h'].slice(0, i + 1)` before
 * any RSI/EMA/zone computation runs on it.
 */

import { computeZones, findTouchedZone } from './mr-zone-touch-1h.js';

const OWN_TF = '1h';
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 25;
const RSI_OVERBOUGHT = 75;
const EMA_TARGET_PERIOD = 21;
const STOP_ATR_MULTIPLE = 1;
const MIN_CANDLES = 60; // buffer above the RSI/EMA/zone minimums (mr-zone-touch-1h needs 50 for zones)

export const meta = {
  id: 'mr-rsi-extreme-1h',
  label: 'Mean reversion: RSI14(1h) extreme at a zone',
  source: 'docs/PROMPT_S1_EDGE_SEARCH.md Agent D',
  tf: OWN_TF,
  holdMaxHours: 24,
  stopKind: 'atr',
  notes: [
    `RSI14(1h) < ${RSI_OVERSOLD} (long) or > ${RSI_OVERBOUGHT} (short) - past services/indicators.js's own 30/70 bands - while price sits inside any horizontal S/R zone from lib/geometry.js (mr-zone-touch-1h's computeZones/findTouchedZone, reused not reimplemented); the zone is a selectivity filter here, not a second directional vote.`,
    'Stop = 1x ATR(1h) from entry (not zone-relative, unlike mr-zone-touch-1h); TP1 = EMA21(1h), only taken when it sits on the profitable side of entry.',
    'Hold 24h.'
  ].join('\n')
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

/** SMA-seeded EMA, tail-aligned to `values` (same formula every rule module in this dir uses). */
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

/**
 * Wilder RSI (SMA-seeded first average, Wilder smoothing after) - matches
 * technicalindicators' RSI.calculate, the function services/indicators.js's own `rsi`
 * field is built from.
 * @param {Array<number>} closes
 * @param {number} [period=14]
 * @returns {number|null}
 */
export function computeRSI(closes, period = RSI_PERIOD) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let k = 1; k <= period; k++) {
    const diff = closes[k] - closes[k - 1];
    if (diff >= 0) gainSum += diff; else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let k = period + 1; k < closes.length; k++) {
    const diff = closes[k] - closes[k - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * @param {Object} ctx - { symbol, tf, i, candlesByTf } per the S0/S1 swing-research contract
 * @returns {null|{direction:'long'|'short', entry:number, stop:number, tp1:number, reason:string[]}}
 */
export function signalAt(ctx) {
  const { i, candlesByTf } = ctx || {};
  if (!Number.isInteger(i) || i < 0 || !candlesByTf) return null;

  const raw1h = candlesByTf[OWN_TF];
  if (!Array.isArray(raw1h) || i >= raw1h.length) return null;
  const own1h = raw1h.slice(0, i + 1);
  if (own1h.length < MIN_CANDLES || !own1h.every(isValidCandle)) return null;

  const closes = own1h.map((c) => c.close);
  const rsi = computeRSI(closes);
  if (!isFiniteNumber(rsi)) return null;

  let direction = null;
  if (rsi < RSI_OVERSOLD) direction = 'long';
  else if (rsi > RSI_OVERBOUGHT) direction = 'short';
  if (!direction) return null;

  const price = closes[closes.length - 1];
  const zonesInfo = computeZones(own1h);
  if (!zonesInfo) return null;
  const touched = findTouchedZone(zonesInfo.zones, price);
  if (!touched) return null;

  const entry = price;
  const stop = direction === 'long' ? entry - STOP_ATR_MULTIPLE * zonesInfo.atr : entry + STOP_ATR_MULTIPLE * zonesInfo.atr;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const ema21Hist = emaSeries(closes, EMA_TARGET_PERIOD);
  const ema21 = ema21Hist[ema21Hist.length - 1];
  if (!isFiniteNumber(ema21)) return null;
  const tp1 = ema21;
  const profitable = direction === 'long' ? tp1 > entry : tp1 < entry;
  if (!profitable) return null;

  const reason = [
    `RSI14(1h) ${rsi.toFixed(2)} ${direction === 'long' ? `< ${RSI_OVERSOLD} (oversold extreme)` : `> ${RSI_OVERBOUGHT} (overbought extreme)`}, price ${entry} at a ${touched.side} zone [${touched.low}, ${touched.high}]`,
    `stop ${STOP_ATR_MULTIPLE}x ATR1h (${zonesInfo.atr}) from entry`,
    `TP1 = EMA21(1h) ${tp1}`
  ];

  return { direction, entry, stop, tp1, reason };
}

export default { meta, signalAt };
