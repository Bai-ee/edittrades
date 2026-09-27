/**
 * S0-B playbook rules test suite (docs/PROMPT_S0_SWING_RESEARCH.md, Agent S0-B).
 *
 * Deterministic, zero-network. For each of the three rule modules under
 * scripts/swing/rules/ (pb-ema21-pullback-1d, pb-4h-flag-continuation,
 * pb-channel-edge-4h) this asserts, per the shared contract:
 *   - returns null on insufficient history
 *   - mirrors long/short on a synthetic (or real-fixture) series
 *   - never reads candles after `i` (own timeframe and, where relevant, the
 *     cross-timeframe 1D trend array), verified by comparing a call against a
 *     properly truncated copy to a call against a longer array with extra
 *     "future" candles appended past `i` / past the current candle's close time
 *
 * Run: node test-swing-rules-playbook.js
 */

import { readFileSync } from 'node:fs';
import * as pbEma from './scripts/swing/rules/pb-ema21-pullback-1d.js';
import * as pbFlag from './scripts/swing/rules/pb-4h-flag-continuation.js';
import * as pbChannel from './scripts/swing/rules/pb-channel-edge-4h.js';
import { triggeringFlag, mirror as flagMirror } from './test/fixtures/flagFixtures.js';

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as the other suites, e.g. test-pattern-detector.js)
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
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : String(err);
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

function assertClose(actual, expected, tolerance, msg) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${msg}: actual is not a finite number (${JSON.stringify(actual)})`);
  assert(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

function assertSignalShape(sig, msg) {
  assert(sig && (sig.direction === 'long' || sig.direction === 'short'), `${msg}: direction`);
  assert(Number.isFinite(sig.entry), `${msg}: entry`);
  assert(Number.isFinite(sig.stop), `${msg}: stop`);
  assert(Number.isFinite(sig.tp1), `${msg}: tp1`);
  if (sig.tp2 !== undefined) assert(Number.isFinite(sig.tp2), `${msg}: tp2`);
  assert(Array.isArray(sig.reason) && sig.reason.length > 0 && sig.reason.every((r) => typeof r === 'string'), `${msg}: reason[]`);
}

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const H4_MS = 4 * 3600000;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** SMA-seeded EMA, tail-aligned to `values` (mirrors the rule modules' own formula). */
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

/** `n` daily candles trending steadily in `direction` ('bull'|'bear'), ending at `endTs`. */
function buildDailyTrend(n, direction, endTs) {
  const step = direction === 'bull' ? 0.6 : -0.6;
  const startTs = endTs - n * DAY_MS;
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += step + Math.sin(i / 7) * 0.15;
    const close = price;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    const ts = startTs + i * DAY_MS;
    out.push({ timestamp: ts, open, high, low, close, closeTime: ts + DAY_MS });
  }
  return out;
}

/** Reflect an OHLC series around `pivot` (p -> 2*pivot - p, high/low swapped). */
function mirrorCandles(candles, pivot) {
  return candles.map((c) => ({
    ...c,
    open: 2 * pivot - c.open,
    high: 2 * pivot - c.low,
    low: 2 * pivot - c.high,
    close: 2 * pivot - c.close
  }));
}

/**
 * `n` 4h candles: a steady uptrend, then an explicit pullback-to-EMA21 candle and a
 * reclaim candle on the last two closes (pb-ema21-pullback-1d's trigger). Uses the
 * algebraic identity close[k] <= ema[k] <=> close[k] <= ema[k-1] (an SMA-seeded EMA's
 * own value at k is a convex combination of close[k] and ema[k-1]) to place the
 * pullback/reclaim closes without needing to solve the recursion.
 */
function build4hPullbackReclaim(n, endTs) {
  const startTs = endTs - n * H4_MS;
  const step = 0.3;
  const out = [];
  let price = 100;
  for (let i = 0; i < n - 2; i++) {
    const open = price;
    price += step;
    const close = price;
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    const ts = startTs + i * H4_MS;
    out.push({ timestamp: ts, open, high, low, close, closeTime: ts + H4_MS });
  }
  const emaBeforePullback = emaSeries(out.map((c) => c.close), 21);
  const emaAtSecondLast = emaBeforePullback[emaBeforePullback.length - 2];

  const idxA = n - 2;
  const closeA = emaAtSecondLast - 0.3; // <= ema[idxA-1] => close[idxA] <= ema[idxA]
  const openA = out[out.length - 1].close;
  const tsA = startTs + idxA * H4_MS;
  out.push({ timestamp: tsA, open: openA, high: Math.max(openA, closeA) + 0.1, low: closeA - 0.5, close: closeA, closeTime: tsA + H4_MS });

  const emaAfterPullback = emaSeries(out.map((c) => c.close), 21);
  const emaAtLastMinus1 = emaAfterPullback[emaAfterPullback.length - 1];
  const idxB = n - 1;
  const closeB = emaAtLastMinus1 + 0.5; // > ema[idxB-1] => close[idxB] > ema[idxB]
  const openB = closeA;
  const tsB = startTs + idxB * H4_MS;
  out.push({ timestamp: tsB, open: openB, high: closeB + 0.2, low: Math.min(openB, closeB) - 0.1, close: closeB, closeTime: tsB + H4_MS });
  return out;
}

function stampAt(candles, stepMs, startTs) {
  return candles.map((c, i) => ({ ...c, timestamp: startTs + i * stepMs, closeTime: startTs + (i + 1) * stepMs }));
}

function readFixtureCandles(symbol, tf) {
  const url = new URL(`./test/fixtures/history/deep60-2026-09-24/${symbol}_${tf}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')).candles;
}

function extraFutureCandles(lastCandle, stepMs, count) {
  const out = [];
  let close = lastCandle.close;
  let ts = (isFiniteNumber(lastCandle.closeTime) ? lastCandle.closeTime : lastCandle.timestamp);
  for (let k = 0; k < count; k++) {
    const open = close;
    close = open * (1 + (k % 2 === 0 ? 0.05 : -0.05));
    out.push({
      timestamp: ts,
      open,
      high: Math.max(open, close) * 1.02,
      low: Math.min(open, close) * 0.98,
      close,
      closeTime: ts + stepMs
    });
    ts += stepMs;
  }
  return out;
}

// ---------------------------------------------------------------------------
// pb-ema21-pullback-1d
// ---------------------------------------------------------------------------

async function testPbEma21Pullback() {
  console.log('\npb-ema21-pullback-1d');

  await test('meta shape', () => {
    assertEqual(pbEma.meta.id, 'pb-ema21-pullback-1d');
    assertEqual(pbEma.meta.tf, '4h');
    assert(['atr', 'structure', 'pct'].includes(pbEma.meta.stopKind), 'stopKind enum');
    assert(typeof pbEma.meta.notes === 'string' && pbEma.meta.notes.split('\n').length === 3, '3-line notes');
  });

  const dailyEnd = 1_735_000_000_000;
  const daily = buildDailyTrend(230, 'bull', dailyEnd);
  const four = build4hPullbackReclaim(40, dailyEnd - 40 * H4_MS);

  await test('insufficient history: short daily returns null', () => {
    const shortDaily = daily.slice(-50);
    const sig = pbEma.signalAt({ i: four.length - 1, candlesByTf: { '4h': four, '1d': shortDaily } });
    assertEqual(sig, null);
  });

  await test('insufficient history: short 4h returns null', () => {
    const shortFour = four.slice(-10);
    const sig = pbEma.signalAt({ i: shortFour.length - 1, candlesByTf: { '4h': shortFour, '1d': daily } });
    assertEqual(sig, null);
  });

  await test('insufficient history: empty/malformed ctx returns null', () => {
    assertEqual(pbEma.signalAt({}), null);
    assertEqual(pbEma.signalAt({ i: -1, candlesByTf: {} }), null);
    assertEqual(pbEma.signalAt(undefined), null);
  });

  let longSignal;
  await test('long: fires on reclaim after pullback in a 1D uptrend', () => {
    longSignal = pbEma.signalAt({ symbol: 'TEST', tf: '4h', i: four.length - 1, candlesByTf: { '4h': four, '1d': daily } });
    assertSignalShape(longSignal, 'long signal');
    assertEqual(longSignal.direction, 'long');
    assert(longSignal.stop < longSignal.entry, 'stop below entry for a long');
    assert(longSignal.tp1 > longSignal.entry, 'tp1 above entry for a long');
    assertClose(longSignal.tp1 - longSignal.entry, 2 * (longSignal.entry - longSignal.stop), 1e-6, 'tp1 is 2R');
  });

  await test('short: mirrors the long signal on a reflected series', () => {
    const pivot = 105;
    const dailyShort = mirrorCandles(daily, pivot);
    const fourShort = mirrorCandles(four, pivot);
    const shortSignal = pbEma.signalAt({ symbol: 'TEST', tf: '4h', i: fourShort.length - 1, candlesByTf: { '4h': fourShort, '1d': dailyShort } });
    assertSignalShape(shortSignal, 'short signal');
    assertEqual(shortSignal.direction, 'short');
    assert(shortSignal.stop > shortSignal.entry, 'stop above entry for a short');
    assert(shortSignal.tp1 < shortSignal.entry, 'tp1 below entry for a short');
    assertClose(shortSignal.entry, 2 * pivot - longSignal.entry, 0.02, 'entry mirrors');
    assertClose(shortSignal.stop, 2 * pivot - longSignal.stop, 0.02, 'stop mirrors');
    assertClose(shortSignal.tp1, 2 * pivot - longSignal.tp1, 0.02, 'tp1 mirrors');
    if (longSignal.tp2 !== undefined || shortSignal.tp2 !== undefined) {
      assert(longSignal.tp2 !== undefined && shortSignal.tp2 !== undefined, 'tp2 present on both sides or neither');
      assertClose(shortSignal.tp2, 2 * pivot - longSignal.tp2, 0.02, 'tp2 mirrors');
    }
  });

  await test('never reads candles after i: own 4h array', () => {
    const i = four.length - 1;
    const truncated = four.slice(0, i + 1);
    const withFuture = truncated.concat(extraFutureCandles(truncated[truncated.length - 1], H4_MS, 10));
    const a = pbEma.signalAt({ i, candlesByTf: { '4h': truncated, '1d': daily } });
    const b = pbEma.signalAt({ i, candlesByTf: { '4h': withFuture, '1d': daily } });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });

  await test('never reads candles after i: cross-timeframe 1D array', () => {
    const i = four.length - 1;
    const nowMs = four[i].closeTime;
    const withFutureDaily = daily.concat([
      { timestamp: nowMs + DAY_MS, open: 1e9, high: 1e9, low: 1e9, close: 1e9, closeTime: nowMs + 2 * DAY_MS },
      { timestamp: nowMs + 2 * DAY_MS, open: -1e9, high: -1e9, low: -1e9, close: -1e9, closeTime: nowMs + 3 * DAY_MS }
    ]);
    const a = pbEma.signalAt({ i, candlesByTf: { '4h': four, '1d': daily } });
    const b = pbEma.signalAt({ i, candlesByTf: { '4h': four, '1d': withFutureDaily } });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future daily candles past the current 4h close must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });
}

// ---------------------------------------------------------------------------
// pb-4h-flag-continuation
// ---------------------------------------------------------------------------

async function testPbFlagContinuation() {
  console.log('\npb-4h-flag-continuation');

  await test('meta shape', () => {
    assertEqual(pbFlag.meta.id, 'pb-4h-flag-continuation');
    assertEqual(pbFlag.meta.tf, '4h');
    assert(['atr', 'structure', 'pct'].includes(pbFlag.meta.stopKind), 'stopKind enum');
    assert(typeof pbFlag.meta.notes === 'string' && pbFlag.meta.notes.split('\n').length === 3, '3-line notes');
  });

  const dailyEnd = 1_735_000_000_000;
  const daily = buildDailyTrend(230, 'bull', dailyEnd);
  const rawFlag = triggeringFlag(); // production fixture: pole -> flag -> breakout close, state triggering
  const four = stampAt(rawFlag, H4_MS, dailyEnd - rawFlag.length * H4_MS);

  await test('insufficient history: short 4h array returns null', () => {
    const tiny = four.slice(0, 10);
    const sig = pbFlag.signalAt({ i: tiny.length - 1, candlesByTf: { '4h': tiny, '1d': daily } });
    assertEqual(sig, null);
  });

  await test('insufficient history: short/absent 1D trend returns null', () => {
    const sig = pbFlag.signalAt({ i: four.length - 1, candlesByTf: { '4h': four, '1d': daily.slice(-50) } });
    assertEqual(sig, null);
  });

  await test('insufficient history: empty/malformed ctx returns null', () => {
    assertEqual(pbFlag.signalAt({}), null);
    assertEqual(pbFlag.signalAt({ i: -1, candlesByTf: {} }), null);
  });

  let longSignal;
  await test('long: fires on the 4h flag breakout close, with-trend', () => {
    longSignal = pbFlag.signalAt({ symbol: 'TEST', tf: '4h', i: four.length - 1, candlesByTf: { '4h': four, '1d': daily } });
    assertSignalShape(longSignal, 'long signal');
    assertEqual(longSignal.direction, 'long');
    assertEqual(longSignal.entry, four[four.length - 1].close, 'entry is the breakout close');
    assert(longSignal.stop < longSignal.entry, 'stop (invalidation) below entry for a long');
    assert(longSignal.tp1 > longSignal.entry, 'tp1 (measured move) above entry for a long');
  });

  await test('short: mirrors the long signal on the flag fixture\'s reflection', () => {
    const pivot = 100_000; // flagFixtures.FIXTURE_PIVOT
    const fourShort = flagMirror(four, pivot);
    const dailyShort = mirrorCandles(daily, 105);
    const shortSignal = pbFlag.signalAt({ symbol: 'TEST', tf: '4h', i: fourShort.length - 1, candlesByTf: { '4h': fourShort, '1d': dailyShort } });
    assertSignalShape(shortSignal, 'short signal');
    assertEqual(shortSignal.direction, 'short');
    assert(shortSignal.stop > shortSignal.entry, 'stop above entry for a short');
    assert(shortSignal.tp1 < shortSignal.entry, 'tp1 below entry for a short');
    assertClose(shortSignal.entry, 2 * pivot - longSignal.entry, 0.05, 'entry mirrors');
    assertClose(shortSignal.stop, 2 * pivot - longSignal.stop, 0.05, 'stop mirrors');
    assertClose(shortSignal.tp1, 2 * pivot - longSignal.tp1, 0.05, 'tp1 mirrors');
  });

  await test('never reads candles after i: own 4h array', () => {
    const i = four.length - 1;
    const withFuture = four.concat(extraFutureCandles(four[i], H4_MS, 10));
    const a = pbFlag.signalAt({ i, candlesByTf: { '4h': four, '1d': daily } });
    const b = pbFlag.signalAt({ i, candlesByTf: { '4h': withFuture, '1d': daily } });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });

  await test('never reads candles after i: cross-timeframe 1D array', () => {
    const i = four.length - 1;
    const nowMs = four[i].closeTime;
    const withFutureDaily = daily.concat([
      { timestamp: nowMs + DAY_MS, open: 1e9, high: 1e9, low: 1e9, close: 1e9, closeTime: nowMs + 2 * DAY_MS }
    ]);
    const a = pbFlag.signalAt({ i, candlesByTf: { '4h': four, '1d': daily } });
    const b = pbFlag.signalAt({ i, candlesByTf: { '4h': four, '1d': withFutureDaily } });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future daily candles past the current 4h close must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });
}

// ---------------------------------------------------------------------------
// pb-channel-edge-4h
// ---------------------------------------------------------------------------

async function testPbChannelEdge() {
  console.log('\npb-channel-edge-4h');

  await test('meta shape', () => {
    assertEqual(pbChannel.meta.id, 'pb-channel-edge-4h');
    assertEqual(pbChannel.meta.tf, '4h');
    assert(['atr', 'structure', 'pct'].includes(pbChannel.meta.stopKind), 'stopKind enum');
    assert(typeof pbChannel.meta.notes === 'string' && pbChannel.meta.notes.split('\n').length === 3, '3-line notes');
  });

  await test('insufficient history: short array returns null', () => {
    const tiny = Array.from({ length: 10 }, (_, k) => ({
      timestamp: k * H4_MS, open: 100, high: 101, low: 99, close: 100, closeTime: (k + 1) * H4_MS
    }));
    assertEqual(pbChannel.signalAt({ i: tiny.length - 1, candlesByTf: { '4h': tiny } }), null);
  });

  await test('insufficient history: empty/malformed ctx returns null', () => {
    assertEqual(pbChannel.signalAt({}), null);
    assertEqual(pbChannel.signalAt({ i: -1, candlesByTf: {} }), null);
  });

  // Hand-built series rarely satisfy fitDiagonal's production gates (>=3 touches, >=20
  // candle span, >=3 ATR bounce between touches); use the real capture fixture (named in
  // the shared S0 contract as the standard replay/test data source) to find a genuine
  // 4h channel-edge signal instead of trying to fabricate one.
  const candles = readFixtureCandles('SOL', '4h');
  let hitIdx = null;
  for (let k = 30; k < candles.length && hitIdx === null; k++) {
    if (pbChannel.signalAt({ i: k, candlesByTf: { '4h': candles } })) hitIdx = k;
  }

  let longOrShortSignal;
  let fixtureSlice;
  await test('fires a real channel-edge signal on the SOL 4h fixture', () => {
    assert(hitIdx !== null, 'expected at least one channel-edge signal in the fixture window');
    fixtureSlice = candles.slice(0, hitIdx + 1);
    longOrShortSignal = pbChannel.signalAt({ symbol: 'SOL', tf: '4h', i: hitIdx, candlesByTf: { '4h': fixtureSlice } });
    assertSignalShape(longOrShortSignal, 'fixture signal');
  });

  await test('mirrors to the opposite direction on a reflected copy', () => {
    const closes = fixtureSlice.map((c) => c.close);
    const pivot = closes.reduce((a, b) => a + b, 0) / closes.length;
    const mirrored = mirrorCandles(fixtureSlice, pivot);
    const mirroredSignal = pbChannel.signalAt({ symbol: 'SOL', tf: '4h', i: hitIdx, candlesByTf: { '4h': mirrored } });
    assertSignalShape(mirroredSignal, 'mirrored signal');
    assert(mirroredSignal.direction !== longOrShortSignal.direction, 'mirrored series flips direction');
    const tol = 0.05;
    assertClose(mirroredSignal.entry, 2 * pivot - longOrShortSignal.entry, tol, 'entry mirrors');
    assertClose(mirroredSignal.stop, 2 * pivot - longOrShortSignal.stop, tol, 'stop mirrors');
    assertClose(mirroredSignal.tp1, 2 * pivot - longOrShortSignal.tp1, tol, 'tp1 mirrors');
    assertClose(mirroredSignal.tp2, 2 * pivot - longOrShortSignal.tp2, tol, 'tp2 mirrors');
  });

  await test('never reads candles after i', () => {
    const withFuture = fixtureSlice.concat(extraFutureCandles(fixtureSlice[fixtureSlice.length - 1], H4_MS, 10));
    const a = pbChannel.signalAt({ i: hitIdx, candlesByTf: { '4h': fixtureSlice } });
    const b = pbChannel.signalAt({ i: hitIdx, candlesByTf: { '4h': withFuture } });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Running S0-B swing playbook rule tests...\n');
  await testPbEma21Pullback();
  await testPbFlagContinuation();
  await testPbChannelEdge();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:', failures.join(', '));
    process.exit(1);
  }
}

main();
