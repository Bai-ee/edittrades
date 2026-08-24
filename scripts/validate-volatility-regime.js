#!/usr/bin/env node

/**
 * Volatility Regime — offline validation harness.
 *
 * Runs entirely on synthetic, deterministic candle series. No network, no
 * clock, no randomness: the same inputs must produce the same regime forever,
 * because this feeds position sizing.
 *
 * The defect this suite exists to prevent regressing:
 * `calculateATR` used to classify volatility against ABSOLUTE ATR% thresholds
 * (LOW < 0.5%, HIGH > 2.0%) applied to every symbol on every timeframe. A
 * mid-cap on a 5m chart sits above 2% essentially always, so the classifier
 * saturated at HIGH and carried zero information. Section 2 below asserts that
 * a series can no longer be classified by its absolute price scale.
 *
 * Run: npm run validate:volatility
 */

import {
  calculateATR,
  VOLATILITY_REGIME_PERCENTILES,
  MIN_ATR_OBSERVATIONS_FOR_PERCENTILE
} from '../lib/advancedIndicators.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, detail = '') {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertEqual(actual, expected, label) {
  assert(actual === expected, label, `expected ${expected}, got ${actual}`);
}

function section(name) {
  console.log(`\n${name}`);
  console.log('-'.repeat(name.length));
}

/**
 * Build a deterministic candle series.
 *
 * `ranges` gives the high-low spread of each bar as a FRACTION of price, so a
 * series can be generated at any absolute price scale with identical relative
 * volatility. That is precisely the property the old absolute-threshold
 * classifier could not see.
 */
function buildCandles({ basePrice, ranges }) {
  const candles = [];
  let close = basePrice;
  for (let i = 0; i < ranges.length; i++) {
    const span = close * ranges[i];
    const open = close;
    const high = open + span / 2;
    const low = open - span / 2;
    // Close flat at the open so price does not drift: drift would change the
    // ATR% denominator and confound what this suite is measuring.
    candles.push({ open, high, low, close: open, volume: 1000 });
    close = open;
  }
  return candles;
}

/** n bars of constant relative range. */
function flatRanges(n, pct) {
  return new Array(n).fill(pct / 100);
}

// ---------------------------------------------------------------------------
section('1. Contract and degenerate inputs');
// ---------------------------------------------------------------------------

assertEqual(calculateATR(null), null, 'null candles returns null');
assertEqual(calculateATR([]), null, 'empty candles returns null');
assertEqual(calculateATR(buildCandles({ basePrice: 100, ranges: flatRanges(5, 1) })), null,
  'fewer candles than period+1 returns null');

{
  const c = buildCandles({ basePrice: 100, ranges: flatRanges(30, 1) });
  const r = calculateATR(c, 14, { timeframe: '4h' });
  assert(r !== null, 'sufficient candles returns a result');
  assertEqual(r.timeframe, '4h', 'timeframe is echoed back');
  assert(typeof r.atr === 'number' && r.atr > 0, 'atr is a positive number');
  assert(typeof r.atrPct === 'number' && r.atrPct > 0, 'atrPct is a positive number');
}

{
  // A zero/negative close must not produce Infinity or NaN downstream.
  const c = buildCandles({ basePrice: 100, ranges: flatRanges(30, 1) });
  c[c.length - 1].close = 0;
  assertEqual(calculateATR(c), null, 'zero final close returns null rather than Infinity');
}

// ---------------------------------------------------------------------------
section('2. Scale invariance (the bug this replaces)');
// ---------------------------------------------------------------------------

{
  // Same relative volatility profile, three wildly different price scales.
  const profile = [...flatRanges(120, 0.4), ...flatRanges(40, 3.0)];
  const btcLike = calculateATR(buildCandles({ basePrice: 64000, ranges: profile }), 14, { timeframe: '5m' });
  const midCap = calculateATR(buildCandles({ basePrice: 12.5, ranges: profile }), 14, { timeframe: '5m' });
  const microCap = calculateATR(buildCandles({ basePrice: 0.00042, ranges: profile }), 14, { timeframe: '5m' });

  assertEqual(btcLike.volatilityState, midCap.volatilityState,
    'identical relative volatility classifies identically at $64,000 and $12.50');
  assertEqual(midCap.volatilityState, microCap.volatilityState,
    'identical relative volatility classifies identically at $12.50 and $0.00042');

  assert(Math.abs(btcLike.atrPercentile - microCap.atrPercentile) < 1e-6,
    'percentile is invariant to absolute price scale',
    `${btcLike.atrPercentile} vs ${microCap.atrPercentile}`);

  // The old code rounded ATR to 2dp, which annihilated sub-cent assets.
  assert(microCap.atr > 0,
    'ATR of a sub-cent asset survives (no toFixed(2) in the calculation path)',
    `atr=${microCap.atr}`);
}

// ---------------------------------------------------------------------------
section('3. Regime classification follows the percentile, not the price');
// ---------------------------------------------------------------------------

{
  // Long calm history, then a sustained expansion. The final bar should rank
  // at the very top of its own distribution.
  const expanding = [...flatRanges(150, 0.3), ...flatRanges(30, 4.0)];
  const r = calculateATR(buildCandles({ basePrice: 500, ranges: expanding }), 14, { timeframe: '1h' });
  assert(r.atrPercentile >= VOLATILITY_REGIME_PERCENTILES.HIGH_ABOVE,
    'a volatility expansion ranks above the HIGH boundary', `percentile=${r.atrPercentile}`);
  assert(r.volatilityState === 'HIGH' || r.volatilityState === 'EXTREME',
    'a volatility expansion classifies HIGH or EXTREME', `got ${r.volatilityState}`);
}

{
  // Long violent history, then a sustained contraction.
  const contracting = [...flatRanges(150, 4.0), ...flatRanges(40, 0.3)];
  const r = calculateATR(buildCandles({ basePrice: 500, ranges: contracting }), 14, { timeframe: '1h' });
  assert(r.atrPercentile < VOLATILITY_REGIME_PERCENTILES.LOW_BELOW,
    'a volatility contraction ranks below the LOW boundary', `percentile=${r.atrPercentile}`);
  assertEqual(r.volatilityState, 'LOW', 'a volatility contraction classifies LOW');
}

{
  // A perfectly uniform series is, by definition, typical of itself.
  const r = calculateATR(buildCandles({ basePrice: 500, ranges: flatRanges(200, 1.2) }), 14, { timeframe: '4h' });
  assertEqual(r.volatilityState, 'NORMAL', 'a uniform series classifies NORMAL');
  assert(r.atrPercentile > 20 && r.atrPercentile < 80,
    'a uniform series ranks mid-distribution (midrank handles ties)',
    `percentile=${r.atrPercentile}`);
}

// ---------------------------------------------------------------------------
section('4. Insufficient history is UNKNOWN, never a fabricated regime');
// ---------------------------------------------------------------------------

{
  const r = calculateATR(buildCandles({ basePrice: 100, ranges: flatRanges(40, 1) }), 14, { timeframe: '15m' });
  assert(r !== null, 'short-but-usable series still returns ATR');
  assertEqual(r.volatilityState, 'UNKNOWN', 'too little history classifies UNKNOWN');
  assertEqual(r.atrPercentile, null, 'too little history reports a null percentile, not 50');
  assert(r.sampleSize < MIN_ATR_OBSERVATIONS_FOR_PERCENTILE,
    'sampleSize reports the shortfall honestly', `sampleSize=${r.sampleSize}`);
}

{
  const n = MIN_ATR_OBSERVATIONS_FOR_PERCENTILE + 14 + 2;
  const r = calculateATR(buildCandles({ basePrice: 100, ranges: flatRanges(n, 1) }), 14);
  assert(r.sampleSize >= MIN_ATR_OBSERVATIONS_FOR_PERCENTILE,
    'just-enough history crosses the threshold', `sampleSize=${r.sampleSize}`);
  assert(r.atrPercentile !== null, 'just-enough history produces a percentile');
  assert(r.volatilityState !== 'UNKNOWN', 'just-enough history produces a real regime');
}

// ---------------------------------------------------------------------------
section('5. Determinism and self-exclusion');
// ---------------------------------------------------------------------------

{
  const candles = buildCandles({ basePrice: 777, ranges: [...flatRanges(120, 0.8), ...flatRanges(20, 2.4)] });
  const a = calculateATR(candles, 14, { timeframe: '4h' });
  const b = calculateATR(candles, 14, { timeframe: '4h' });
  assertEqual(JSON.stringify(a), JSON.stringify(b), 'identical inputs produce identical output');
}

{
  // The current observation must not be part of the distribution it is ranked
  // against, or an extreme reading would dilute its own percentile.
  const candles = buildCandles({ basePrice: 100, ranges: flatRanges(200, 1.0) });
  const r = calculateATR(candles, 14);
  assert(r.sampleSize === Math.min(500, r.sampleSize),
    'sampleSize respects the lookback cap');
  const rCapped = calculateATR(candles, 14, { lookback: 80 });
  assertEqual(rCapped.sampleSize, 80, 'lookback caps the trailing window');
}

// ---------------------------------------------------------------------------
section('6. No NaN or Infinity may escape');
// ---------------------------------------------------------------------------

{
  const shapes = [
    { basePrice: 100, ranges: flatRanges(200, 0.0) },     // zero-range bars
    { basePrice: 1e-8, ranges: flatRanges(200, 1.0) },    // extreme small scale
    { basePrice: 1e9, ranges: flatRanges(200, 1.0) }      // extreme large scale
  ];
  for (const shape of shapes) {
    const r = calculateATR(buildCandles(shape), 14);
    if (r === null) continue;
    const numeric = [r.atr, r.atrPct, r.atrPercentile].filter((v) => v !== null);
    assert(numeric.every((v) => Number.isFinite(v)),
      `no NaN/Infinity at basePrice=${shape.basePrice}`,
      JSON.stringify({ atr: r.atr, atrPct: r.atrPct, pct: r.atrPercentile }));
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(56));
console.log(`Volatility regime: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log('All volatility regime assertions passed.');
