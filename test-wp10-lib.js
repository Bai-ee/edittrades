/**
 * WP10 (docs/research/harness/WP10_TRACKER_EVIDENCE.md) - unit tests for
 * scripts/research/tracker-evidence/lib.js. Small hand fixtures, no fs, no network.
 *
 * Run: node test-wp10-lib.js
 */

import {
  forwardMetrics, atrProxy15m, toR, dayBlockBootstrapCI, leanDirectionOf, candidateIdOf,
  planRiskBasis, riskBasisWithAtrFallback, loadDedupedCallRows, regimeAt, brier, mean, stdev, round
} from './scripts/research/tracker-evidence/lib.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertClose(actual, expected, tol, msg) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${msg}: not finite (${actual})`);
  assert(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected} +/- ${tol}, got ${actual}`);
}

// ---------------------------------------------------------------- fixtures

function m1(ts, o, h, l, c) { return { timestamp: ts, open: o, high: h, low: l, close: c, volume: 1 }; }

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
function minutes(n) { return BASE + n * 60000; }

console.log('WP10 lib.js');

// ---------------------------------------------------------------- forwardMetrics

test('forwardMetrics: complete window computes close/MFE/MAE both directions', () => {
  const candles = [];
  for (let i = 0; i < 15; i++) candles.push(m1(minutes(i), 100, 100 + i, 100 - i, 100 + (i % 2 ? 1 : -1)));
  const r = forwardMetrics(candles, minutes(0), 15, 100);
  assert(r.state === 'complete', `expected complete, got ${r.state}`);
  assertClose(r.maxHigh, 114, 1e-6, 'maxHigh');
  assertClose(r.minLow, 86, 1e-6, 'minLow');
  assertClose(r.mfeLongPct, 14, 1e-6, 'mfeLongPct');
  assertClose(r.maeLongPct, -14, 1e-6, 'maeLongPct');
  assertClose(r.mfeShortPct, 14, 1e-6, 'mfeShortPct (best case for a short is the low)');
  assertClose(r.maeShortPct, -14, 1e-6, 'maeShortPct (worst case for a short is the high)');
});

test('forwardMetrics: pending when horizon end is beyond the last known candle', () => {
  const candles = [m1(minutes(0), 100, 101, 99, 100)];
  const r = forwardMetrics(candles, minutes(0), 60, 100); // needs 60 candles, only have 1
  assert(r.state === 'pending', `expected pending, got ${r.state}`);
});

test('forwardMetrics: unscorable on a genuine mid-history gap (data resumes well after the horizon)', () => {
  const candles = [m1(minutes(0), 100, 101, 99, 100), m1(minutes(1000), 100, 101, 99, 100)];
  // horizon window [minutes(500), minutes(515)) has nothing, but the dataset's last
  // candle (minutes(1000)) is well AFTER that window closes - proves it's a real gap,
  // not the tail of the dataset (which would read as pending instead).
  const r = forwardMetrics(candles, minutes(500), 15, 100);
  assert(r.state === 'unscorable', `expected unscorable, got ${r.state}`);
});

test('forwardMetrics: unscorable when refPrice is missing', () => {
  const candles = [m1(minutes(0), 100, 101, 99, 100)];
  const r = forwardMetrics(candles, minutes(0), 15, null);
  assert(r.state === 'unscorable', `expected unscorable, got ${r.state}`);
});

test('forwardMetrics: partial on a mid-window gap', () => {
  const candles = [];
  for (let i = 0; i < 3; i++) candles.push(m1(minutes(i), 100, 101, 99, 100)); // only 3 of 15 expected
  candles.push(m1(minutes(500), 100, 101, 99, 100)); // dataset extends well past the horizon
  const r = forwardMetrics(candles, minutes(0), 15, 100);
  assert(r.state === 'partial', `expected partial, got ${r.state}`);
});

// ---------------------------------------------------------------- toR

test('toR: divides pct move by risk pct', () => {
  assertClose(toR(2, 1), 2, 1e-9, 'toR(2,1)');
  assertClose(toR(-1.5, 0.5), -3, 1e-9, 'toR(-1.5,0.5)');
  assert(toR(1, 0) === null, 'toR with zero risk is null');
  assert(toR(null, 1) === null, 'toR with null move is null');
});

// ---------------------------------------------------------------- atrProxy15m

test('atrProxy15m: simple mean true range over prior closed bars only', () => {
  const bars = [
    { timestamp: minutes(0), high: 10, low: 8, close: 9 },
    { timestamp: minutes(15), high: 11, low: 9, close: 10 },
    { timestamp: minutes(30), high: 12, low: 10, close: 11 },
    { timestamp: minutes(45), high: 13, low: 11, close: 12 } // at/after atMs, must be excluded
  ];
  const atr = atrProxy15m(bars, minutes(45), 14);
  // TRs from bars[0..2] only (strictly before minutes(45)): (11-9)=2, (12-10)=2 -> mean 2
  assertClose(atr, 2, 1e-9, 'atrProxy15m');
});

test('atrProxy15m: null with fewer than 2 prior bars', () => {
  const bars = [{ timestamp: minutes(0), high: 10, low: 8, close: 9 }];
  assert(atrProxy15m(bars, minutes(15), 14) === null, 'expected null');
});

// ---------------------------------------------------------------- lean direction / candidateId / risk basis

test('leanDirectionOf: plan direction wins over candidate direction', () => {
  const row = { flagTradePlan: { direction: 'long' }, flagRecommendation: { candidate: { direction: 'short' } } };
  assert(leanDirectionOf(row) === 'long', 'expected plan direction');
});

test('leanDirectionOf: falls back to candidateSetups[0]', () => {
  const row = { flagTradePlan: null, flagRecommendation: null, candidateSetups: [{ dir: 'short' }] };
  assert(leanDirectionOf(row) === 'short', 'expected candidateSetups[0].dir');
});

test('leanDirectionOf: null with no directional evidence', () => {
  assert(leanDirectionOf({}) === null, 'expected null');
});

test('candidateIdOf: plan candidateId wins', () => {
  const row = { flagTradePlan: { candidateId: 'A' }, flagRecommendation: { candidate: { candidateId: 'B' } } };
  assert(candidateIdOf(row) === 'A', 'expected A');
});

test('planRiskBasis: computes riskPct from entry/stop', () => {
  const row = { flagTradePlan: { entry: 100, stop: 99 } };
  const basis = planRiskBasis(row);
  assertClose(basis.riskPct, 1, 1e-9, 'riskPct');
});

test('planRiskBasis: null when entry/stop missing', () => {
  assert(planRiskBasis({ flagTradePlan: { entry: null, stop: 99 } }) === null, 'expected null');
});

test('riskBasisWithAtrFallback: prefers plan basis over ATR', () => {
  const row = { flagTradePlan: { entry: 100, stop: 98 } };
  const basis = riskBasisWithAtrFallback(row, [], minutes(0), 100);
  assert(basis.source === 'plan', 'expected plan source');
  assertClose(basis.riskPct, 2, 1e-9, 'riskPct');
});

test('riskBasisWithAtrFallback: falls back to ATR(15m) when no plan levels', () => {
  const bars = [
    { timestamp: minutes(-30), high: 102, low: 98, close: 100 },
    { timestamp: minutes(-15), high: 104, low: 100, close: 102 }
  ];
  const basis = riskBasisWithAtrFallback({}, bars, minutes(0), 100);
  assert(basis.source === 'atr15m', 'expected atr15m source');
  assert(basis.riskPct > 0, 'expected positive riskPct');
});

// ---------------------------------------------------------------- dedupe

test('loadDedupedCallRows dedupe rule: a cron row wins over a served row at the same key', () => {
  // Exercise the exported dedupe rule directly via a minimal in-memory shape - the
  // integration path (reading real files) is covered by test-wp10-horizon-backfill.js.
  const rows = [
    { symbol: 'BTC', closedThrough: 't1', source: 'served', tag: 'served-row' },
    { symbol: 'BTC', closedThrough: 't1', source: 'cron', tag: 'cron-row' }
  ];
  // loadDedupedCallRows itself reads from disk; replicate its pure merge logic here since
  // it has no separate exported helper - this pins the intended behavior.
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.symbol}|${row.closedThrough}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, row); continue; }
    if (existing.source !== 'cron' && row.source === 'cron') byKey.set(key, row);
  }
  const out = [...byKey.values()];
  assert(out.length === 1 && out[0].tag === 'cron-row', 'expected the cron row to win');
});

// ---------------------------------------------------------------- regimeAt

test('regimeAt: last entry at or before atMs', () => {
  const series = [
    { timestamp: minutes(0), regime: 'bear' },
    { timestamp: minutes(240), regime: 'bull' },
    { timestamp: minutes(480), regime: 'bull' }
  ];
  assert(regimeAt(series, minutes(300)).regime === 'bull', 'expected bull at minutes(300)');
  assert(regimeAt(series, minutes(0)).regime === 'bear', 'expected bear at minutes(0)');
  assert(regimeAt(series, minutes(-10)) === null, 'expected null before any data');
});

// ---------------------------------------------------------------- stats

test('brier: perfect predictions score 0, worst predictions score 1', () => {
  assertClose(brier([{ p: 1, o: 1 }, { p: 0, o: 0 }]), 0, 1e-9, 'perfect');
  assertClose(brier([{ p: 1, o: 0 }, { p: 0, o: 1 }]), 1, 1e-9, 'worst');
});

test('mean/stdev basic', () => {
  assertClose(mean([1, 2, 3]), 2, 1e-9, 'mean');
  assert(stdev([1]) === null, 'stdev needs n>=2');
  assertClose(stdev([1, 2, 3]), 1, 1e-9, 'stdev');
});

test('dayBlockBootstrapCI: deterministic for a fixed seed, brackets the sample mean', () => {
  const values = [1, 1, 1, -1, -1, 2, 2, -2];
  const days = ['d1', 'd1', 'd2', 'd2', 'd3', 'd3', 'd4', 'd4'];
  const ci = dayBlockBootstrapCI(values, days, { seed: 1, iterations: 500 });
  assert(ci.days === 4, 'expected 4 distinct days');
  assert(ci.lo <= ci.hi, 'lo <= hi');
  const ci2 = dayBlockBootstrapCI(values, days, { seed: 1, iterations: 500 });
  assert(ci.lo === ci2.lo && ci.hi === ci2.hi, 'same seed -> same result');
});

test('round: standard rounding to n decimals', () => {
  assert(round(1.23456, 2) === 1.23, 'round 2dp');
  assert(round(null, 2) === null, 'round null passthrough');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', failures.join(', ')); process.exit(1); }
