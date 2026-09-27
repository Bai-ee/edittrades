/**
 * S1 mean-reversion rule: mr-random-1h (docs/PROMPT_S1_EDGE_SEARCH.md Agent D) - seeded
 * null-baseline control for the mean-reversion-at-zones family. Same seeding technique as
 * `scripts/swing/rules/ctl-random-4h.js` (FNV-1a hash of `seed:symbol:timestamp` feeding a
 * mulberry32 PRNG - deterministic per (symbol, candle), independent of call order),
 * reimplemented locally rather than imported so this control does not couple to the S0-C
 * control family's own module/seed. Direction: PRNG draw < 0.5 -> long, else short, at
 * every 1h close - no trend/zone/RSI condition. Stop = 1x ATR(1h) from entry (ATR via
 * `lib/geometry.js` `atr`, the same function `mr-rsi-extreme-1h` uses for its own stop);
 * TP1 = entry +/- 2x that risk. Hold 24h. Every real rule in this family
 * (mr-zone-touch-1h, mr-channel-fade-4h, mr-rsi-extreme-1h) must beat this on net
 * expectancy.
 *
 * No lookahead: candles are truncated to `candlesByTf['1h'].slice(0, i + 1)` before ATR
 * is computed on them.
 */

import { atr as geometryAtr } from '../../../lib/geometry.js';

const OWN_TF = '1h';
const STOP_ATR_MULTIPLE = 1;
const TP_R_MULTIPLE = 2;
const MIN_CANDLES = 30; // buffer above lib/geometry.js atr()'s default period (14)

export const meta = {
  id: 'mr-random-1h',
  label: 'Control: seeded random long/short (1h) - mean-reversion family null baseline',
  source: 'docs/PROMPT_S1_EDGE_SEARCH.md Agent D',
  tf: OWN_TF,
  holdMaxHours: 24,
  stopKind: 'atr',
  notes: [
    'Null baseline for the mean-reversion-at-zones family: seeded (RANDOM_SEED=1337) deterministic random direction at every 1h close, no trend/zone/RSI condition.',
    "Same stop/TP mechanics (1x ATR(1h) stop, 2R target) as mr-rsi-extreme-1h's stop convention, so it is comparable to the family it baselines, not just structurally similar to ctl-random-4h.",
    'Seeding technique mirrors ctl-random-4h.js (FNV-1a -> mulberry32) but reimplemented locally, not imported, so this family control does not couple to the S0-C control module.'
  ].join('\n')
};

export const RANDOM_SEED = 1337;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidCandle(c) {
  return c && isFiniteNumber(c.open) && isFiniteNumber(c.high) && isFiniteNumber(c.low) && isFiniteNumber(c.close);
}

/** FNV-1a, 32-bit unsigned. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let k = 0; k < str.length; k++) {
    h ^= str.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: deterministic PRNG from a 32-bit seed, returns a fn producing floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exported for tests: the deterministic [0,1) draw for a given (seed, symbol, timestamp). */
export function seededDraw(seed, symbol, timestamp) {
  const hash = fnv1a(`${seed}:${symbol}:${timestamp}`);
  return mulberry32(hash)();
}

/**
 * @param {Object} ctx - { symbol, tf, i, candlesByTf } per the S0/S1 swing-research contract
 * @returns {null|{direction:'long'|'short', entry:number, stop:number, tp1:number, reason:string[]}}
 */
export function signalAt(ctx) {
  const { candlesByTf, i, symbol } = ctx || {};
  const raw1h = candlesByTf && candlesByTf[OWN_TF];
  if (!Array.isArray(raw1h) || !Number.isInteger(i) || i < 0 || !symbol) return null;

  const candles1h = raw1h.slice(0, i + 1); // defensive: never trust anything past i
  if (candles1h.length < MIN_CANDLES || !candles1h.every(isValidCandle)) return null;

  const a = geometryAtr(candles1h);
  if (!a || !isFiniteNumber(a.atr) || a.atr <= 0) return null;

  const current = candles1h[candles1h.length - 1];
  const draw = seededDraw(RANDOM_SEED, symbol, current.timestamp);
  const direction = draw < 0.5 ? 'long' : 'short';

  const entry = current.close;
  const stop = direction === 'long' ? entry - STOP_ATR_MULTIPLE * a.atr : entry + STOP_ATR_MULTIPLE * a.atr;
  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;

  const tp1 = direction === 'long' ? entry + TP_R_MULTIPLE * risk : entry - TP_R_MULTIPLE * risk;

  return {
    direction,
    entry,
    stop,
    tp1,
    reason: [
      `seeded random draw ${draw.toFixed(4)} (seed ${RANDOM_SEED}, symbol ${symbol}, ts ${current.timestamp}) -> ${direction}`,
      `stop ${STOP_ATR_MULTIPLE}x ATR1h (${a.atr}) from entry`,
      `TP1 = entry +/- ${TP_R_MULTIPLE}R (${tp1})`
    ]
  };
}

export default { meta, signalAt };
