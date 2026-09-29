/**
 * T-24 prediction rule tests (docs/PROMPT_T24_PREDICTION_TRACKER.md, `lib/predictionRule.js`).
 *
 * Deterministic, zero-network, pure-function coverage: determinism (same input -> same
 * output, no mutation), both directions, no_call (cancelling votes), short-history /
 * malformed-candle rejection, the higher-timeframe "tie-break" (a missing or too-short
 * `higherCandles` drops that one vote rather than failing the call, which can be the exact
 * difference between `no_call` and `over`/`under`), confidence/score consistency, the
 * exported constants, and the `scripts/swing/rules/pred-next-candle.js` re-export identity
 * (same precedent as test-htf-entry-rule.js's one-line check on htf-entry-1m.js).
 *
 * Run: node test-prediction-rule.js
 */

import {
  predictNextCandle, PREDICTION_TIMEFRAMES, PREDICTION_SYMBOLS, HIGHER_TF,
  EMA_FAST_PERIOD, EMA_SLOW_PERIOD, MIN_CANDLES, RULE_VERSION
} from './lib/predictionRule.js';
import * as predNextCandleRule from './scripts/swing/rules/pred-next-candle.js';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'mismatch'}: expected ${b}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const H1_MS = 3600000;
const H4_MS = 4 * 3600000;
const END_TS = Date.parse('2026-01-01T00:00:00Z');

/** Deterministic PRNG (same construction as lib/advancedIndicators.js mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A bounded random walk, closed candles ascending, `{timestamp,open,high,low,close,volume,closeTime}`. */
function walk(seed, n, { startPrice = 30000, vol = 60, stepMs = H1_MS, endTs = END_TS } = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = Math.max(1, price + (rnd() - 0.5) * vol);
    const close = price;
    const high = Math.max(open, close) + rnd() * vol * 0.3;
    const low = Math.min(open, close) - rnd() * vol * 0.3;
    out.push({ open, high, low, close, volume: 100 });
  }
  const startTs = endTs - n * stepMs;
  return out.map((c, idx) => ({ ...c, timestamp: startTs + idx * stepMs, closeTime: startTs + idx * stepMs + stepMs }));
}

/** Drifting series with a sine ripple (same shape as test-htf-entry-rule.js's own `drift`). */
function drift(n, direction, { startPrice = 30000, step = 6, amp = 1.5, stepMs = H1_MS, endTs = END_TS } = {}) {
  const s = direction === 'up' ? step : -step;
  const startTs = endTs - n * stepMs;
  const out = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += s + Math.sin(i / 7) * amp;
    const close = price;
    const high = Math.max(open, close) + 3;
    const low = Math.min(open, close) - 3;
    const ts = startTs + i * stepMs;
    out.push({ timestamp: ts, open, high, low, close, volume: 100, closeTime: ts + stepMs });
  }
  return out;
}

// Clear bullish/bearish fixtures (drift-based): all of votes 1/2/3 agree, score = +-3.
const BULL_1H = drift(230, 'up', { startPrice: 30000 });
const BULL_4H = drift(60, 'up', { startPrice: BULL_1H[0].close, stepMs: H4_MS });
const BEAR_1H = drift(230, 'down', { startPrice: 30000 });
const BEAR_4H = drift(60, 'down', { startPrice: BEAR_1H[0].close, stepMs: H4_MS });

// Cancelling fixture (flat, no drift): score lands at 0.
const FLAT_1H = drift(230, 'up', { startPrice: 30000, step: 0, amp: 0.4 });
const FLAT_4H = drift(60, 'up', { startPrice: FLAT_1H[0].close, step: 0, amp: 0.4, stepMs: H4_MS });

// Higher-tf tie-break fixtures (found by search over the walk PRNG, see docs/PREDICTION_STUDY_2026-09-28.md
// "how these fixtures were found"): baseline (no higherCandles) is exactly `no_call`;
// adding a sufficient higherCandles array supplies the deciding 5th/4th vote and crosses
// the +-2 threshold. seed=7 -> over, seed=5 -> under (mirror).
const TIE_OVER_1H = walk(7, 215, { vol: 60 });
const TIE_OVER_4H = walk(200007, 40, { startPrice: TIE_OVER_1H[0].close, vol: 80, stepMs: H4_MS });
const TIE_UNDER_1H = walk(5, 215, { vol: 60 });
const TIE_UNDER_4H = walk(100005, 40, { startPrice: TIE_UNDER_1H[0].close, vol: 80, stepMs: H4_MS });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log('T-24 prediction rule tests (lib/predictionRule.js)\n');

  await test('exported constants match the shared contract exactly', () => {
    assertDeepEqual([...PREDICTION_TIMEFRAMES], ['5m', '15m', '1h', '4h'], 'PREDICTION_TIMEFRAMES');
    assertDeepEqual([...PREDICTION_SYMBOLS], ['BTC', 'ETH', 'SOL'], 'PREDICTION_SYMBOLS');
    assertDeepEqual(HIGHER_TF, { '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d' }, 'HIGHER_TF');
    assertEqual(EMA_FAST_PERIOD, 21);
    assertEqual(EMA_SLOW_PERIOD, 200);
    assertEqual(MIN_CANDLES >= 210, true, 'MIN_CANDLES must be >= 210 per the shared contract');
    assertEqual(RULE_VERSION, 'pred-1');
  });

  await test('determinism: identical input (same array reference) yields identical output', () => {
    const r1 = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BULL_1H, higherCandles: BULL_4H });
    const r2 = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BULL_1H, higherCandles: BULL_4H });
    assertDeepEqual(r1, r2);
  });

  await test('determinism: a deep-cloned copy of the same candles yields the identical result (no hidden mutation/identity dependence)', () => {
    const clonedCandles = BULL_1H.map((c) => ({ ...c }));
    const clonedHigher = BULL_4H.map((c) => ({ ...c }));
    const r1 = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BULL_1H, higherCandles: BULL_4H });
    const r2 = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: clonedCandles, higherCandles: clonedHigher });
    assertDeepEqual(r1, r2);
    // and calling predictNextCandle must not have mutated the input arrays
    assertEqual(BULL_1H.length, 230);
    assertEqual(clonedCandles[0].close, BULL_1H[0].close);
  });

  await test('bullish direction: a clean uptrend (price/EMA21/EMA200 stacked bullish) calls "over"', () => {
    const r = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BULL_1H, higherCandles: BULL_4H });
    assertEqual(r.direction, 'over');
    assertEqual(r.inputs.ema21Side, 'above');
    assertEqual(r.inputs.ema200Side, 'above');
    assertEqual(r.inputs.higherEma21Side, 'above');
    assert(r.confidence > 0, 'confidence must be > 0 for a called direction');
  });

  await test('bearish direction: a clean downtrend (price/EMA21/EMA200 stacked bearish) calls "under"', () => {
    const r = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BEAR_1H, higherCandles: BEAR_4H });
    assertEqual(r.direction, 'under');
    assertEqual(r.inputs.ema21Side, 'below');
    assertEqual(r.inputs.ema200Side, 'below');
    assertEqual(r.inputs.higherEma21Side, 'below');
    assert(r.confidence > 0, 'confidence must be > 0 for a called direction');
  });

  await test('no_call: cancelling votes (flat/no-net-drift series) never force a direction', () => {
    const r = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: FLAT_1H, higherCandles: FLAT_4H });
    assertEqual(r.direction, 'no_call');
    assertEqual(r.confidence, 0);
  });

  await test('short history: fewer than MIN_CANDLES returns no_call, confidence 0, every input null', () => {
    const shortCandles = walk(1, 50);
    const r = predictNextCandle({ symbol: 'ETH', timeframe: '1h', candles: shortCandles, higherCandles: [] });
    assertEqual(r.direction, 'no_call');
    assertEqual(r.confidence, 0);
    assertDeepEqual(r.inputs, { ema21Side: null, ema200Side: null, higherEma21Side: null, stoch: null, lastSwing: null });
    assert(/insufficient history/.test(r.reason), 'reason should explain the rejection');
  });

  await test('short history boundary: exactly MIN_CANDLES - 1 is still rejected', () => {
    const candles = walk(2, MIN_CANDLES - 1);
    const r = predictNextCandle({ symbol: 'SOL', timeframe: '5m', candles, higherCandles: [] });
    assertEqual(r.direction, 'no_call');
    assertEqual(r.inputs.ema21Side, null);
  });

  await test('sufficient history boundary: exactly MIN_CANDLES computes normally (not the insufficient-history path)', () => {
    const candles = walk(2, MIN_CANDLES);
    const r = predictNextCandle({ symbol: 'SOL', timeframe: '5m', candles, higherCandles: [] });
    assert(!/insufficient history/.test(r.reason), 'MIN_CANDLES candles must be enough to compute EMA21/EMA200');
    assert(r.inputs.ema21Side !== null, 'ema21Side should be computed once history is sufficient');
  });

  await test('malformed input: non-array candles never throws, returns no_call', () => {
    const r1 = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: undefined, higherCandles: [] });
    const r2 = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: null, higherCandles: [] });
    const r3 = predictNextCandle();
    assertEqual(r1.direction, 'no_call');
    assertEqual(r2.direction, 'no_call');
    assertEqual(r3.direction, 'no_call');
  });

  await test('malformed input: an invalid candle (NaN close) anywhere in the series rejects the whole call', () => {
    const candles = walk(3, MIN_CANDLES).map((c, i) => (i === 100 ? { ...c, close: NaN } : c));
    const r = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles, higherCandles: [] });
    assertEqual(r.direction, 'no_call');
    assert(/insufficient history/.test(r.reason));
  });

  await test('higher-tf tie-break (bullish): missing higherCandles is a no-vote (no_call); a sufficient one supplies the deciding vote and calls "over"', () => {
    const withoutHigher = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: TIE_OVER_1H, higherCandles: [] });
    const withHigher = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: TIE_OVER_1H, higherCandles: TIE_OVER_4H });
    assertEqual(withoutHigher.direction, 'no_call', 'baseline fixture must be a genuine tie without the higher-tf vote');
    assertEqual(withoutHigher.inputs.higherEma21Side, null);
    assertEqual(withHigher.direction, 'over');
    assertEqual(withHigher.inputs.higherEma21Side, 'above');
    // every OTHER input must be identical - only the higher-tf vote changed
    assertEqual(withoutHigher.inputs.ema21Side, withHigher.inputs.ema21Side);
    assertEqual(withoutHigher.inputs.ema200Side, withHigher.inputs.ema200Side);
    assertDeepEqual(withoutHigher.inputs.stoch, withHigher.inputs.stoch);
    assertDeepEqual(withoutHigher.inputs.lastSwing, withHigher.inputs.lastSwing);
  });

  await test('higher-tf tie-break (bearish mirror): same mechanism, calls "under"', () => {
    const withoutHigher = predictNextCandle({ symbol: 'ETH', timeframe: '1h', candles: TIE_UNDER_1H, higherCandles: [] });
    const withHigher = predictNextCandle({ symbol: 'ETH', timeframe: '1h', candles: TIE_UNDER_1H, higherCandles: TIE_UNDER_4H });
    assertEqual(withoutHigher.direction, 'no_call');
    assertEqual(withHigher.direction, 'under');
    assertEqual(withHigher.inputs.higherEma21Side, 'below');
  });

  await test('higher-tf too-short: fewer than EMA_FAST_PERIOD higher candles is treated the same as missing (no vote)', () => {
    const tooShortHigher = TIE_OVER_4H.slice(0, EMA_FAST_PERIOD - 1);
    const r = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: TIE_OVER_1H, higherCandles: tooShortHigher });
    assertEqual(r.direction, 'no_call');
    assertEqual(r.inputs.higherEma21Side, null);
  });

  await test('higher-tf invalid candle: a NaN in the higher-tf series is treated the same as missing (no vote, no throw)', () => {
    const corruptHigher = TIE_OVER_4H.map((c, i) => (i === 5 ? { ...c, high: NaN } : c));
    const r = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: TIE_OVER_1H, higherCandles: corruptHigher });
    assertEqual(r.inputs.higherEma21Side, null);
    assertEqual(r.direction, 'no_call');
  });

  await test('confidence = |score| / 5, derived consistently with the reported direction thresholds', () => {
    const bull = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BULL_1H, higherCandles: BULL_4H });
    const tieOver = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: TIE_OVER_1H, higherCandles: TIE_OVER_4H });
    // BULL_1H stacks votes 1/2/3 all bullish -> score +3 -> confidence 0.6
    assertEqual(bull.confidence, 0.6);
    // TIE_OVER crosses the threshold at score +2 -> confidence 0.4
    assertEqual(tieOver.confidence, 0.4);
  });

  await test('direction/score invariant holds across every fixture used in this file: over only at score>=+2, under only at score<=-2', () => {
    const cases = [
      predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BULL_1H, higherCandles: BULL_4H }),
      predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BEAR_1H, higherCandles: BEAR_4H }),
      predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: FLAT_1H, higherCandles: FLAT_4H }),
      predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: TIE_OVER_1H, higherCandles: [] }),
      predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: TIE_OVER_1H, higherCandles: TIE_OVER_4H }),
      predictNextCandle({ symbol: 'ETH', timeframe: '1h', candles: TIE_UNDER_1H, higherCandles: [] }),
      predictNextCandle({ symbol: 'ETH', timeframe: '1h', candles: TIE_UNDER_1H, higherCandles: TIE_UNDER_4H })
    ];
    for (const r of cases) {
      const scoreMatch = /score ([+-]\d+)\/5/.exec(r.reason);
      assert(scoreMatch, `reason must encode the score: ${r.reason}`);
      const score = Number(scoreMatch[1]);
      if (r.direction === 'over') assert(score >= 2, `over must have score >= 2, got ${score}`);
      else if (r.direction === 'under') assert(score <= -2, `under must have score <= -2, got ${score}`);
      else assert(score > -2 && score < 2, `no_call must have -2 < score < 2, got ${score}`);
      assertEqual(r.confidence, Math.round((Math.abs(score) / 5) * 100) / 100, 'confidence must equal |score|/5');
    }
  });

  await test('inputs.stoch shape: k in [0,100], direction enum, bullish/bearish never both true', () => {
    const r = predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: BULL_1H, higherCandles: BULL_4H });
    if (r.inputs.stoch) {
      assert(r.inputs.stoch.k >= 0 && r.inputs.stoch.k <= 100, 'k must be clamped to [0,100]');
      assert(['rising', 'falling', 'flat'].includes(r.inputs.stoch.direction));
      assert(!(r.inputs.stoch.bullish && r.inputs.stoch.bearish), 'bullish and bearish are mutually exclusive');
    }
  });

  await test('inputs.lastSwing shape: kind in [null,high,low], label in the known enum', () => {
    const cases = [BULL_1H, BEAR_1H, FLAT_1H, TIE_OVER_1H].map((c) => predictNextCandle({ symbol: 'BTC', timeframe: '1h', candles: c, higherCandles: [] }));
    for (const r of cases) {
      assert([null, 'high', 'low'].includes(r.inputs.lastSwing.kind));
      assert(['none', 'higher_high', 'lower_low', 'other'].includes(r.inputs.lastSwing.label));
    }
  });

  await test('scripts/swing/rules/pred-next-candle.js re-exports lib/predictionRule.js unchanged (same functions/constants, precedent: htf-entry-1m.js)', () => {
    assertEqual(predNextCandleRule.predictNextCandle, predictNextCandle, 'predictNextCandle must be the SAME function reference');
    assertDeepEqual([...predNextCandleRule.PREDICTION_TIMEFRAMES], [...PREDICTION_TIMEFRAMES]);
    assertDeepEqual([...predNextCandleRule.PREDICTION_SYMBOLS], [...PREDICTION_SYMBOLS]);
    assertDeepEqual(predNextCandleRule.HIGHER_TF, HIGHER_TF);
    assertEqual(predNextCandleRule.default.predictNextCandle, predictNextCandle);
  });

  await test('every PREDICTION_TIMEFRAMES entry has a HIGHER_TF mapping', () => {
    for (const tf of PREDICTION_TIMEFRAMES) {
      assert(typeof HIGHER_TF[tf] === 'string' && HIGHER_TF[tf].length > 0, `HIGHER_TF missing an entry for ${tf}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed tests:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main();
