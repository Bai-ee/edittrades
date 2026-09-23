/**
 * Deterministic, zero-network test suite for lib/topDown.js (trading-model quick pass Q3).
 *
 * Run: node test-top-down.js
 */

import { ENGINE_CONFIG } from './config/engine.js';
import { weeklyFromDaily, buildWeeklyLean, buildTopDown, buildAboveBelow200 } from './lib/topDown.js';

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as the other suites)
// ---------------------------------------------------------------------------

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
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : String(err);
    console.log(`      ${msg}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const MONDAY0 = Date.UTC(2020, 0, 6, 0, 0, 0); // a Monday, UTC

/** `days` daily candles, one per day from MONDAY0, close from `priceAt(i)`. */
function dailyCandles(days, priceAt) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const ts = MONDAY0 + i * DAY_MS;
    const close = priceAt(i);
    const open = i === 0 ? close : priceAt(i - 1);
    out.push({
      timestamp: ts,
      open,
      high: Math.max(open, close) + 0.01,
      low: Math.min(open, close) - 0.01,
      close,
      volume: 1,
      closeTime: ts + DAY_MS
    });
  }
  return out;
}

const WEEKS_FOR_EMA21 = ENGINE_CONFIG.model.weeklyMinWeeksForEma21 + ENGINE_CONFIG.model.weeklySlopeLookbackWeeks + 6;

async function run() {
  console.log('\nlib/topDown.js\n');

  console.log('1) weeklyFromDaily');

  await test('aggregates full weeks aligned to Monday 00:00 UTC; a trailing partial week is dropped', () => {
    const days = 21; // exactly 3 full weeks
    const withPartial = dailyCandles(days + 3, (i) => 100 + i); // + a 4-day trailing partial week
    const weeks = weeklyFromDaily(withPartial);
    assertEqual(weeks.length, 3, 'the partial trailing week is dropped');
    for (const w of weeks) {
      assertEqual(w.days, 7, 'every kept week has 7 daily candles');
      assertEqual(new Date(w.timestamp).getUTCDay(), 1, 'each week starts on a Monday');
    }
    assertEqual(weeks[0].open, 100, 'first week open = first day close-basis open');
    assertEqual(weeks[0].high, 100 + 6 + 0.01, 'first week high = max of its 7 days');
    assertEqual(weeks[0].low, 100 - 0.01, 'first week low = min of its 7 days');
    assertEqual(weeks[0].close, 100 + 6, 'first week close = its 7th day close');
    assertEqual(weeks[2].close, 100 + 20, 'third week close');
  });

  await test('exactly N full weeks, nothing partial → all N weeks kept', () => {
    const weeks = weeklyFromDaily(dailyCandles(14, (i) => 100 + i));
    assertEqual(weeks.length, 2, 'two full weeks, none dropped');
  });

  await test('empty or malformed input → []', () => {
    assertEqual(weeklyFromDaily([]).length, 0, 'empty');
    assertEqual(weeklyFromDaily(null).length, 0, 'null');
    assertEqual(weeklyFromDaily([{ timestamp: NaN, open: 1, high: 1, low: 1, close: 1 }]).length, 0, 'malformed candle dropped');
  });

  console.log('\n2) buildWeeklyLean');

  await test('steady climb over enough weeks → bull, strength 100 (close above a rising weekly EMA21)', () => {
    const candles = dailyCandles(WEEKS_FOR_EMA21 * 7, (i) => 100 + i * 0.5);
    const lean = buildWeeklyLean(candles);
    assertEqual(lean.bias, 'bull', 'bull');
    assertEqual(lean.strength, 100, 'strength');
    assert(lean.ema21 !== null && lean.close > lean.ema21, 'close above weekly EMA21');
    assert(lean.ema21Slope > 0, 'rising EMA21 slope');
    assertEqual(lean.ema200, null, 'weekly EMA200 always null');
    assertEqual(lean.reason, 'insufficient history for weekly EMA200', 'reason names why ema200 is null');
  });

  await test('steady decline (mirror of the climb) → bear, strength 100', () => {
    const candles = dailyCandles(WEEKS_FOR_EMA21 * 7, (i) => 1000 - i * 0.5);
    const lean = buildWeeklyLean(candles);
    assertEqual(lean.bias, 'bear', 'bear');
    assertEqual(lean.strength, 100, 'strength identical to the bull case');
    assert(lean.close < lean.ema21, 'close below weekly EMA21');
    assert(lean.ema21Slope < 0, 'falling EMA21 slope');
  });

  await test('too few weeks for a weekly EMA21 → neutral with a reason, ema21 null, close still reported', () => {
    const candles = dailyCandles(7 * (ENGINE_CONFIG.model.weeklyMinWeeksForEma21 - 1), (i) => 100 + i);
    const lean = buildWeeklyLean(candles);
    assertEqual(lean.bias, 'neutral', 'neutral');
    assertEqual(lean.strength, 0, 'strength 0');
    assertEqual(lean.ema21, null, 'no EMA21 on thin data');
    assertEqual(lean.ema21Slope, null, 'no slope either');
    assertEqual(lean.ema200, null, 'ema200 still null');
    assertEqual(lean.reason, 'insufficient history for weekly EMA21', 'reason names the actual shortfall');
    assert(lean.close !== null, 'the last close is still reported even when the lean is neutral');
  });

  console.log('\n3) buildTopDown (weighted vote over 1w/1d/4h/1h)');

  const W = ENGINE_CONFIG.model.topDownWeights;

  await test('all four bull → sentiment bull, aligned 4/4, score 1', () => {
    const r = buildTopDown({ '1w': 'bull', '1d': 'bull', '4h': 'bull', '1h': 'bull' }, W);
    assertEqual(r.sentiment, 'bull', 'sentiment');
    assertEqual(r.aligned, 4, 'aligned');
    assertEqual(r.score, 1, 'score');
  });

  await test('all four bear (mirror of the bull case) → sentiment bear, aligned 4/4, identical score', () => {
    const r = buildTopDown({ '1w': 'bear', '1d': 'bear', '4h': 'bear', '1h': 'bear' }, W);
    assertEqual(r.sentiment, 'bear', 'sentiment');
    assertEqual(r.aligned, 4, 'aligned');
    assertEqual(r.score, 1, 'score identical to the bull case');
  });

  await test('mixed (2026-09-23 follow-up item 4): weighted sum 0 with an uneven bull/bear split → aligned is the larger side, not the neutral count', () => {
    // 1w bull(+4) + 1d bear(-3) + 4h neutral(0) + 1h bear(-1) = 0. 1 bull, 2 bear, 1 neutral.
    const r = buildTopDown({ '1w': 'bull', '1d': 'bear', '4h': 'neutral', '1h': 'bear' }, W);
    assertEqual(r.sentiment, 'mixed', 'mixed');
    assertEqual(r.aligned, 2, 'aligned = the larger side (2 bear), not the 1 neutral timeframe');
    assertEqual(r.score, 0, 'net conviction is 0');

    // Mirror: bull and bear swapped. Same weighted-sum-0 shape, same aligned by the rule
    // (2, now from the bull side) - not numerically mirrored (2 vs 2), because the
    // bull-favored tiebreak is an explicit asymmetric rule, not a symmetric score.
    const mirrored = buildTopDown({ '1w': 'bear', '1d': 'bull', '4h': 'neutral', '1h': 'bull' }, W);
    assertEqual(mirrored.sentiment, 'mixed', 'mirror is still mixed');
    assertEqual(mirrored.aligned, 2, 'mirror: aligned = the larger side (2 bull)');
    assertEqual(mirrored.score, 0, 'mirror conviction is 0 too');
  });

  await test('mixed tie (2 bull, 2 bear, equal-and-opposite weight) → aligned favors bull, long and mirrored short', () => {
    // bull = {1w(4), 1h(1)} = 5; bear = {1d(3), 4h(2)} = 5. Sum = 0, bullCount = bearCount = 2.
    const r = buildTopDown({ '1w': 'bull', '1d': 'bear', '4h': 'bear', '1h': 'bull' }, W);
    assertEqual(r.sentiment, 'mixed', 'mixed');
    assertEqual(r.aligned, 2, 'tie → bull count (2)');

    // Mirror: every lean flipped. bullCount and bearCount are still 2/2, and the rule
    // still resolves to the bull count - the same aligned value as the long case above,
    // by design (ties always favor bull, never "whichever side this market happened to
    // start from").
    const mirrored = buildTopDown({ '1w': 'bear', '1d': 'bull', '4h': 'bull', '1h': 'bear' }, W);
    assertEqual(mirrored.sentiment, 'mixed', 'mirror is still mixed');
    assertEqual(mirrored.aligned, 2, 'mirror tie → bull count (2) too, same tiebreak rule');
  });

  await test('higher-timeframe weight beats a lower-timeframe numeric majority', () => {
    // 1w bull(+4) outweighs 4h+1h bear (-2-1=-3): 1d neutral. Sum = +1 → bull, even
    // though 2 of the 4 timeframes (4h, 1h) lean bear and only 1 (1w) leans bull.
    const r = buildTopDown({ '1w': 'bull', '1d': 'neutral', '4h': 'bear', '1h': 'bear' }, W);
    assertEqual(r.sentiment, 'bull', 'higher timeframe wins');
    assertEqual(r.aligned, 1, 'only the 1w timeframe actually agrees with the result');
    assert(r.score > 0 && r.score < 1, `partial conviction: ${r.score}`);
  });

  console.log('\n4) buildAboveBelow200');

  const AW = ENGINE_CONFIG.model.above200Weights;

  await test('counts and weights: above/below/null are handled, weighted uses model.above200Weights', () => {
    const sides = { '1m': 'above', '3m': 'above', '5m': 'below', '15m': 'above', '1h': 'above', '4h': 'below', '1d': null };
    const { above200, below200 } = buildAboveBelow200(sides, AW);
    assertEqual(above200.of, 6, 'null (1d) excluded from the denominator');
    assertEqual(above200.count, 4, '4 of 6 above');
    assertEqual(below200.count, 2, 'mirror: of - count');
    assertEqual(below200.of, 6, 'same denominator');
    const expectedWeighted = (AW['1m'] + AW['3m'] + AW['15m'] + AW['1h']) / (AW['1m'] + AW['3m'] + AW['5m'] + AW['15m'] + AW['1h'] + AW['4h']);
    assertEqual(above200.weighted, Math.round(expectedWeighted * 10000) / 10000, 'weighted matches hand computation');
    assertEqual(Math.round((above200.weighted + below200.weighted) * 10000) / 10000, 1, 'above + below weighted sum to 1');
  });

  await test('all above → count = of, weighted 1; all below (mirror) → weighted 0', () => {
    const allAbove = { '1m': 'above', '1h': 'above', '4h': 'above', '1d': 'above' };
    const a = buildAboveBelow200(allAbove, AW);
    assertEqual(a.above200.count, a.above200.of, 'all above');
    assertEqual(a.above200.weighted, 1, 'weighted 1');
    assertEqual(a.below200.weighted, 0, 'mirror weighted 0');
    const allBelow = { '1m': 'below', '1h': 'below', '4h': 'below', '1d': 'below' };
    const b = buildAboveBelow200(allBelow, AW);
    assertEqual(b.above200.count, 0, 'none above');
    assertEqual(b.above200.weighted, 0, 'weighted 0');
  });

  await test('no data at all → of 0, weighted null, never throws', () => {
    const r = buildAboveBelow200({}, AW);
    assertEqual(r.above200.of, 0, 'of 0');
    assertEqual(r.above200.weighted, null, 'weighted null, not NaN or 0/0');
    assertEqual(r.below200.of, 0, 'below mirrors');
  });

  console.log('\n5) config');

  await test('every model constant lives in config/engine.json under "model"', () => {
    const m = ENGINE_CONFIG.model;
    assert(m && typeof m.topDownWeights === 'object', 'topDownWeights');
    assert(m && typeof m.above200Weights === 'object', 'above200Weights');
    assert(typeof m.weeklyMinWeeksForEma21 === 'number', 'weeklyMinWeeksForEma21');
    assert(typeof m.weeklySlopeLookbackWeeks === 'number', 'weeklySlopeLookbackWeeks');
    for (const tf of ['1w', '1d', '4h', '1h']) assert(typeof m.topDownWeights[tf] === 'number', `topDownWeights.${tf}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
