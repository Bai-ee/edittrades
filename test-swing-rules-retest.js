/**
 * S3 retest-entry rules test suite (docs/PROMPT_S3_RETEST_ENTRY.md).
 *
 * Deterministic, zero-network. Covers the shared contract per rule module
 * (re-flag-retest-4h, re-flag-retest-1h, re-flag-breakout-4h, re-random-4h):
 *   - null on insufficient / malformed history
 *   - the retest "wait" logic on a synthetic flag: no signal on the breakout candle
 *     itself, no signal on a non-retest extension, a signal on the exact candle a
 *     genuine retest prints
 *   - mirrors long/short on a reflected series
 *   - never reads candles after `i` (own timeframe and cross-timeframe trend arrays)
 *   - re-flag-retest-1h's extra 1D/4h dual trend gate (both must agree)
 *   - re-random-4h's seeded determinism
 *
 * Fixture note: the flag itself is a local, larger-pole builder (below), not
 * test/fixtures/flagFixtures.js's regression001 - that fixture's ~0.4%-of-price pole is
 * too small to clear the S3 rules' own 2.5R gate once the T-15 net floor (a ~1% of price
 * cost floor at these rules' 0.34%/0.14% direction costs) widens the stop, so a bigger
 * pole is needed here to exercise the "fires" paths at all; the fixture logic itself
 * (base/move/flag/push helpers) mirrors flagFixtures.js's own private `series()` builder.
 *
 * Run: node test-swing-rules-retest.js
 */

import { detectFlagLifecycle } from './lib/patternDetector.js';
import { seededDraw } from './scripts/swing/retestShared.js';
import * as reFlagRetest4h from './scripts/swing/rules/re-flag-retest-4h.js';
import * as reFlagRetest1h from './scripts/swing/rules/re-flag-retest-1h.js';
import * as reFlagBreakout4h from './scripts/swing/rules/re-flag-breakout-4h.js';
import * as reRandom4h from './scripts/swing/rules/re-random-4h.js';

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as test-swing-rules-playbook.js)
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

function assertRetestSignalShape(sig, msg) {
  assert(sig && (sig.direction === 'long' || sig.direction === 'short'), `${msg}: direction`);
  assert(Number.isFinite(sig.entry), `${msg}: entry`);
  assert(Number.isFinite(sig.stop), `${msg}: stop`);
  assert(Number.isFinite(sig.tp1), `${msg}: tp1`);
  assert(Array.isArray(sig.reason) && sig.reason.length > 0 && sig.reason.every((r) => typeof r === 'string'), `${msg}: reason[]`);
  assert(sig.holdRule && typeof sig.holdRule === 'object', `${msg}: holdRule present`);
  assert(Number.isFinite(sig.holdRule.insideLow) && Number.isFinite(sig.holdRule.insideHigh) && sig.holdRule.insideLow < sig.holdRule.insideHigh, `${msg}: holdRule.insideLow/insideHigh`);
  assertEqual(sig.holdRule.n, 5, `${msg}: holdRule.n`);
  assert(Number.isFinite(sig.holdRule.tfCandleMs) && sig.holdRule.tfCandleMs > 0, `${msg}: holdRule.tfCandleMs`);
  const gross = Math.abs(sig.tp1 - sig.entry) / Math.abs(sig.entry - sig.stop);
  assert(gross >= 2.5 - 1e-9, `${msg}: gross R:R must be >= 2.5 (got ${gross})`);
}

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const H4_MS = 4 * 3600000;
const H1_MS = 3600000;
const GEOMETRY_15M = { '15m': { atr: 40 } }; // ctx.geometry stub: NF's ATR15m input

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function emaSeriesLocal(values, period) {
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

/** `n` daily (or 4h) candles trending steadily in `direction`, ending at `endTs`. */
function buildTrend(n, direction, endTs, stepMs) {
  const step = direction === 'bull' ? 0.6 : -0.6;
  const startTs = endTs - n * stepMs;
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += step + Math.sin(i / 7) * 0.15;
    const close = price;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    const ts = startTs + i * stepMs;
    out.push({ timestamp: ts, open, high, low, close, closeTime: ts + stepMs });
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

function stampAt(candles, stepMs, startTs) {
  return candles.map((c, i) => ({ ...c, timestamp: startTs + i * stepMs, closeTime: startTs + (i + 1) * stepMs }));
}

function extraFutureCandles(lastCandle, stepMs, count) {
  const out = [];
  let close = lastCandle.close;
  let ts = (isFiniteNumber(lastCandle.closeTime) ? lastCandle.closeTime : lastCandle.timestamp);
  for (let k = 0; k < count; k++) {
    const open = close;
    close = open * (1 + (k % 2 === 0 ? 0.05 : -0.05));
    out.push({ timestamp: ts, open, high: Math.max(open, close) * 1.02, low: Math.min(open, close) * 0.98, close, closeTime: ts + stepMs });
    ts += stepMs;
  }
  return out;
}

/** mulberry32: deterministic PRNG (same technique as flagFixtures.js's private series() builder). */
function mulberry32Local(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Minimal OHLC series builder (base/move/flag), scaled up from flagFixtures.js's own private helper. */
function seriesBuilder(seed) {
  const rand = mulberry32Local(seed);
  const candles = [];
  const api = {
    candles,
    lastClose: () => (candles.length ? candles[candles.length - 1].close : 100000),
    push(open, close, opts = {}) {
      const top = Math.max(open, close);
      const bottom = Math.min(open, close);
      candles.push({
        open: round2(open),
        high: round2(opts.high ?? top + 2 + rand() * 3),
        low: round2(opts.low ?? bottom - 2 - rand() * 3),
        close: round2(close)
      });
      return api;
    },
    base(count, level = 100000) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        api.push(open, level + (rand() - 0.5) * 20);
      }
      return api;
    },
    move(count, perCandle) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        api.push(open, open + perCandle);
      }
      return api;
    },
    flag(count, high, low) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        const close = i % 2 === 0 ? low + (high - low) * 0.35 : low + (high - low) * 0.65;
        api.push(open, close, {
          high: Math.max(open, close, Math.min(high, Math.max(open, close) + 3)),
          low: Math.min(open, close, Math.max(low, Math.min(open, close) - 3))
        });
      }
      return api;
    }
  };
  return api;
}

/**
 * A ~7% pole + tight flag + breakout close (ends exactly on the breakout candle, like
 * flagFixtures.js's `triggeringFlag()`), sized so the measured move clears the S3 rules'
 * 2.5R gate under the T-15 net floor (see this file's own header note).
 */
function buildFlagBreakout(seed = 1) {
  const s = seriesBuilder(seed);
  s.base(60).move(6, 1200); // pole ~7200 on a 100000 base
  const poleTop = s.lastClose();
  const flagHigh = poleTop - 30;
  const flagLow = poleTop - 300;
  s.flag(6, flagHigh, flagLow);
  s.push(s.lastClose(), flagHigh + 60, { high: flagHigh + 70 }); // the breakout close
  return s.candles;
}

/** Detect the candidate a triggering flag produces, for building a precise retest candle. */
function candidateOf(candles, direction) {
  const ema = emaSeriesLocal(candles.map((c) => c.close), 21);
  const result = detectFlagLifecycle({ candles, ema21History: ema }, direction);
  assert(result, 'expected a flag candidate from the fixture');
  return result;
}

/**
 * A retest candle that touches the breakout level exactly and closes just on the hold
 * side of it - the minimal case that satisfies retestPrintAt's reached/held/!stopBreached
 * check regardless of ATR size.
 */
function retestCandleFor(candidate, direction, stepMs, afterCandle) {
  const { breakoutLevel } = candidate;
  const sign = direction === 'short' ? -1 : 1;
  const close = breakoutLevel + sign * Math.abs(breakoutLevel) * 0.0002; // just past the level, on the hold side
  const low = direction === 'long' ? breakoutLevel : Math.min(close, breakoutLevel) - Math.abs(breakoutLevel) * 0.0001;
  const high = direction === 'long' ? Math.max(close, breakoutLevel) + Math.abs(breakoutLevel) * 0.0001 : breakoutLevel;
  const open = afterCandle.close;
  const ts = isFiniteNumber(afterCandle.closeTime) ? afterCandle.closeTime : afterCandle.timestamp + stepMs;
  return { timestamp: ts, open, high, low, close, closeTime: ts + stepMs };
}

/** A candle that extends well past the breakout without ever coming back near it. */
function extensionCandleFor(candidate, direction, stepMs, afterCandle) {
  const sign = direction === 'short' ? -1 : 1;
  const close = candidate.breakoutLevel + sign * Math.abs(candidate.breakoutLevel) * 0.02;
  const low = direction === 'long' ? close - Math.abs(close) * 0.001 : close;
  const high = direction === 'long' ? close : close + Math.abs(close) * 0.001;
  const open = afterCandle.close;
  const ts = isFiniteNumber(afterCandle.closeTime) ? afterCandle.closeTime : afterCandle.timestamp + stepMs;
  return { timestamp: ts, open, high, low, close, closeTime: ts + stepMs };
}

// ---------------------------------------------------------------------------
// re-flag-retest-4h
// ---------------------------------------------------------------------------

async function testReFlagRetest4h() {
  console.log('\nre-flag-retest-4h');
  const mod = reFlagRetest4h;

  await test('meta shape', () => {
    assertEqual(mod.meta.id, 're-flag-retest-4h');
    assertEqual(mod.meta.tf, '4h');
    assertEqual(mod.meta.holdMaxHours, 24 * 7);
    assert(['atr', 'structure', 'pct'].includes(mod.meta.stopKind), 'stopKind enum');
  });

  const dailyEnd = 1_735_000_000_000;
  const daily = buildTrend(230, 'bull', dailyEnd, DAY_MS);
  const rawFlag = buildFlagBreakout(1); // ends exactly on the breakout candle (ageCandles 0)
  const four = stampAt(rawFlag, H4_MS, dailyEnd - rawFlag.length * H4_MS);

  await test('insufficient history: short 4h array returns null', () => {
    const tiny = four.slice(0, 10);
    assertEqual(mod.signalAt({ i: tiny.length - 1, candlesByTf: { '4h': tiny, '1d': daily }, geometry: GEOMETRY_15M }), null);
  });

  await test('insufficient history: short/absent 1D trend returns null', () => {
    assertEqual(mod.signalAt({ i: four.length - 1, candlesByTf: { '4h': four, '1d': daily.slice(-50) }, geometry: GEOMETRY_15M }), null);
  });

  await test('insufficient history: empty/malformed ctx returns null', () => {
    assertEqual(mod.signalAt({}), null);
    assertEqual(mod.signalAt({ i: -1, candlesByTf: {} }), null);
    assertEqual(mod.signalAt(undefined), null);
  });

  await test('wait logic: no signal on the breakout candle itself (retest has not happened yet)', () => {
    const sig = mod.signalAt({ symbol: 'TEST', tf: '4h', i: four.length - 1, candlesByTf: { '4h': four, '1d': daily }, geometry: GEOMETRY_15M });
    assertEqual(sig, null);
  });

  const candResult = candidateOf(four, 'long');

  await test('wait logic: no signal on a non-retest extension past the breakout', () => {
    const ext = extensionCandleFor(candResult.candidate, 'long', H4_MS, four[four.length - 1]);
    const withExt = four.concat([ext]);
    const sig = mod.signalAt({ symbol: 'TEST', tf: '4h', i: withExt.length - 1, candlesByTf: { '4h': withExt, '1d': daily }, geometry: GEOMETRY_15M });
    assertEqual(sig, null);
  });

  let longSignal;
  let longWithRetest;
  await test('long: fires on the exact candle a genuine retest prints', () => {
    const retest = retestCandleFor(candResult.candidate, 'long', H4_MS, four[four.length - 1]);
    longWithRetest = four.concat([retest]);
    longSignal = mod.signalAt({ symbol: 'TEST', tf: '4h', i: longWithRetest.length - 1, candlesByTf: { '4h': longWithRetest, '1d': daily }, geometry: GEOMETRY_15M });
    assertRetestSignalShape(longSignal, 'long signal');
    assertEqual(longSignal.direction, 'long');
    assertEqual(longSignal.entry, retest.close, 'entry is the retest close');
    assert(longSignal.stop < longSignal.entry, 'stop below entry for a long');
    assert(longSignal.tp1 > longSignal.entry, 'tp1 (measured move) above entry for a long');
  });

  await test('short: mirrors the long signal on a reflected series', () => {
    const pivot = 100000;
    const fourAndRetestShort = mirrorCandles(longWithRetest, pivot);
    const dailyShort = mirrorCandles(daily, 105);
    const shortSignal = mod.signalAt({ symbol: 'TEST', tf: '4h', i: fourAndRetestShort.length - 1, candlesByTf: { '4h': fourAndRetestShort, '1d': dailyShort }, geometry: GEOMETRY_15M });
    assertRetestSignalShape(shortSignal, 'short signal');
    assertEqual(shortSignal.direction, 'short');
    assert(shortSignal.stop > shortSignal.entry, 'stop above entry for a short');
    assert(shortSignal.tp1 < shortSignal.entry, 'tp1 below entry for a short');
    assertClose(shortSignal.entry, 2 * pivot - longSignal.entry, 0.5, 'entry mirrors');
    assertClose(shortSignal.tp1, 2 * pivot - longSignal.tp1, 0.5, 'tp1 mirrors');
    // Stop deliberately does NOT mirror to the exact price: the T-15 net floor's cost
    // term is direction-dependent (34 bps long / 14 bps short round-trip,
    // ENGINE_CONFIG.risk costBpsByDirection - positions are funded from USDC/USDT, so a
    // long pays the extra swap in/out and a short does not), so a mirrored short is
    // floored to a tighter stop than the long's mirror image would be. Only the
    // side-of-entry and gross-R:R checks (assertRetestSignalShape above) apply here.
  });

  await test('never reads candles after i: own 4h array', () => {
    const i = longWithRetest.length - 1;
    const withFuture = longWithRetest.concat(extraFutureCandles(longWithRetest[i], H4_MS, 10));
    const a = mod.signalAt({ i, candlesByTf: { '4h': longWithRetest, '1d': daily }, geometry: GEOMETRY_15M });
    const b = mod.signalAt({ i, candlesByTf: { '4h': withFuture, '1d': daily }, geometry: GEOMETRY_15M });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });

  await test('never reads candles after i: cross-timeframe 1D array', () => {
    const i = longWithRetest.length - 1;
    const nowMs = longWithRetest[i].closeTime;
    const withFutureDaily = daily.concat([
      { timestamp: nowMs + DAY_MS, open: 1e9, high: 1e9, low: 1e9, close: 1e9, closeTime: nowMs + 2 * DAY_MS }
    ]);
    const a = mod.signalAt({ i, candlesByTf: { '4h': longWithRetest, '1d': daily }, geometry: GEOMETRY_15M });
    const b = mod.signalAt({ i, candlesByTf: { '4h': longWithRetest, '1d': withFutureDaily }, geometry: GEOMETRY_15M });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future daily candles past the current 4h close must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });
}

// ---------------------------------------------------------------------------
// re-flag-retest-1h
// ---------------------------------------------------------------------------

async function testReFlagRetest1h() {
  console.log('\nre-flag-retest-1h');
  const mod = reFlagRetest1h;

  await test('meta shape', () => {
    assertEqual(mod.meta.id, 're-flag-retest-1h');
    assertEqual(mod.meta.tf, '1h');
    assertEqual(mod.meta.holdMaxHours, 24 * 7);
  });

  const dailyEnd = 1_735_000_000_000;
  const daily = buildTrend(230, 'bull', dailyEnd, DAY_MS);
  const fourBull = buildTrend(230, 'bull', dailyEnd, H4_MS);
  const fourBear = buildTrend(230, 'bear', dailyEnd, H4_MS);
  const rawFlag = buildFlagBreakout(2);
  const one = stampAt(rawFlag, H1_MS, dailyEnd - rawFlag.length * H1_MS);

  await test('insufficient history: short 1h array returns null', () => {
    const tiny = one.slice(0, 10);
    assertEqual(mod.signalAt({ i: tiny.length - 1, candlesByTf: { '1h': tiny, '1d': daily, '4h': fourBull }, geometry: GEOMETRY_15M }), null);
  });

  await test('insufficient history: empty/malformed ctx returns null', () => {
    assertEqual(mod.signalAt({}), null);
    assertEqual(mod.signalAt({ i: -1, candlesByTf: {} }), null);
  });

  const candResult = candidateOf(one, 'long');
  const retest = retestCandleFor(candResult.candidate, 'long', H1_MS, one[one.length - 1]);
  const oneWithRetest = one.concat([retest]);

  await test('dual trend gate: 1D bull + 4h BEAR (disagree) returns null even with a genuine retest', () => {
    const sig = mod.signalAt({ symbol: 'TEST', tf: '1h', i: oneWithRetest.length - 1, candlesByTf: { '1h': oneWithRetest, '1d': daily, '4h': fourBear }, geometry: GEOMETRY_15M });
    assertEqual(sig, null);
  });

  let longSignal;
  await test('dual trend gate: 1D bull + 4h bull (agree) fires the retest signal', () => {
    longSignal = mod.signalAt({ symbol: 'TEST', tf: '1h', i: oneWithRetest.length - 1, candlesByTf: { '1h': oneWithRetest, '1d': daily, '4h': fourBull }, geometry: GEOMETRY_15M });
    assertRetestSignalShape(longSignal, 'dual-gate long signal');
    assertEqual(longSignal.direction, 'long');
    assertEqual(longSignal.entry, retest.close, 'entry is the retest close');
  });

  await test('wait logic: no signal on the breakout candle itself', () => {
    const sig = mod.signalAt({ symbol: 'TEST', tf: '1h', i: one.length - 1, candlesByTf: { '1h': one, '1d': daily, '4h': fourBull }, geometry: GEOMETRY_15M });
    assertEqual(sig, null);
  });

  await test('never reads candles after i: own 1h array', () => {
    const i = oneWithRetest.length - 1;
    const withFuture = oneWithRetest.concat(extraFutureCandles(oneWithRetest[i], H1_MS, 10));
    const a = mod.signalAt({ i, candlesByTf: { '1h': oneWithRetest, '1d': daily, '4h': fourBull }, geometry: GEOMETRY_15M });
    const b = mod.signalAt({ i, candlesByTf: { '1h': withFuture, '1d': daily, '4h': fourBull }, geometry: GEOMETRY_15M });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 1h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });

  await test('never reads candles after i: cross-timeframe 4h trend array', () => {
    const i = oneWithRetest.length - 1;
    const nowMs = oneWithRetest[i].closeTime;
    const withFutureFour = fourBull.concat([
      { timestamp: nowMs + H4_MS, open: -1e9, high: -1e9, low: -1e9, close: -1e9, closeTime: nowMs + 2 * H4_MS }
    ]);
    const a = mod.signalAt({ i, candlesByTf: { '1h': oneWithRetest, '1d': daily, '4h': fourBull }, geometry: GEOMETRY_15M });
    const b = mod.signalAt({ i, candlesByTf: { '1h': oneWithRetest, '1d': daily, '4h': withFutureFour }, geometry: GEOMETRY_15M });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past the current 1h close must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });
}

// ---------------------------------------------------------------------------
// re-flag-breakout-4h (control)
// ---------------------------------------------------------------------------

async function testReFlagBreakout4h() {
  console.log('\nre-flag-breakout-4h');
  const mod = reFlagBreakout4h;

  await test('meta shape', () => {
    assertEqual(mod.meta.id, 're-flag-breakout-4h');
    assertEqual(mod.meta.tf, '4h');
    assertEqual(mod.meta.holdMaxHours, 24 * 7);
  });

  await test('insufficient history: empty/malformed ctx returns null', () => {
    assertEqual(mod.signalAt({}), null);
    assertEqual(mod.signalAt({ i: -1, candlesByTf: {} }), null);
  });

  const dailyEnd = 1_735_000_000_000;
  const daily = buildTrend(230, 'bull', dailyEnd, DAY_MS);
  const rawFlag = buildFlagBreakout(3);
  const four = stampAt(rawFlag, H4_MS, dailyEnd - rawFlag.length * H4_MS);

  let longSignal;
  await test('long: fires on the breakout close itself (not the retest)', () => {
    longSignal = mod.signalAt({ symbol: 'TEST', tf: '4h', i: four.length - 1, candlesByTf: { '4h': four, '1d': daily }, geometry: GEOMETRY_15M });
    assertRetestSignalShape(longSignal, 'breakout-control long signal');
    assertEqual(longSignal.entry, four[four.length - 1].close, 'entry is the breakout close');
  });

  await test('short: mirrors the long signal on a reflected series', () => {
    const pivot = 100000;
    const fourShort = mirrorCandles(four, pivot);
    const dailyShort = mirrorCandles(daily, 105);
    const shortSignal = mod.signalAt({ symbol: 'TEST', tf: '4h', i: fourShort.length - 1, candlesByTf: { '4h': fourShort, '1d': dailyShort }, geometry: GEOMETRY_15M });
    assertRetestSignalShape(shortSignal, 'breakout-control short signal');
    assertEqual(shortSignal.direction, 'short');
    assertClose(shortSignal.entry, 2 * pivot - longSignal.entry, 0.5, 'entry mirrors');
    assertClose(shortSignal.tp1, 2 * pivot - longSignal.tp1, 0.5, 'tp1 mirrors');
    // Stop does not mirror exactly - see re-flag-retest-4h's own mirror test for why
    // (the T-15 net floor's round-trip cost term is direction-dependent, 34 bps long /
    // 14 bps short).
  });

  await test('never reads candles after i: own 4h array', () => {
    const i = four.length - 1;
    const withFuture = four.concat(extraFutureCandles(four[i], H4_MS, 10));
    const a = mod.signalAt({ i, candlesByTf: { '4h': four, '1d': daily }, geometry: GEOMETRY_15M });
    const b = mod.signalAt({ i, candlesByTf: { '4h': withFuture, '1d': daily }, geometry: GEOMETRY_15M });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });
}

// ---------------------------------------------------------------------------
// re-random-4h (control)
// ---------------------------------------------------------------------------

async function testReRandom4h() {
  console.log('\nre-random-4h');
  const mod = reRandom4h;

  await test('meta shape', () => {
    assertEqual(mod.meta.id, 're-random-4h');
    assertEqual(mod.meta.tf, '4h');
    assertEqual(mod.meta.holdMaxHours, 24 * 7);
  });

  const rawFlag = buildFlagBreakout(4);
  const dailyEnd = 1_735_000_000_000;
  const four = stampAt(rawFlag, H4_MS, dailyEnd - rawFlag.length * H4_MS);
  const candResult = candidateOf(four, 'long');
  const retest = retestCandleFor(candResult.candidate, 'long', H4_MS, four[four.length - 1]);
  const withRetest = four.concat([retest]);
  const retestTs = withRetest[withRetest.length - 1].timestamp;

  await test('insufficient history: empty/malformed ctx, or missing symbol, returns null', () => {
    assertEqual(mod.signalAt({}), null);
    assertEqual(mod.signalAt({ i: -1, candlesByTf: {} }), null);
    assertEqual(mod.signalAt({ i: withRetest.length - 1, candlesByTf: { '4h': withRetest }, geometry: GEOMETRY_15M }), null, 'missing symbol');
  });

  // Find one symbol string the seeded draw sends 'long' (matches this long-only fixture)
  // and one it sends 'short' (no short flag exists here), for concrete positive/negative
  // assertions instead of a soft "either way" check.
  const candidates = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];
  let longSymbol = null;
  let shortSymbol = null;
  for (const sym of candidates) {
    const draw = seededDraw(mod.RANDOM_SEED, sym, retestTs);
    if (draw < 0.5 && !longSymbol) longSymbol = sym;
    if (draw >= 0.5 && !shortSymbol) shortSymbol = sym;
    if (longSymbol && shortSymbol) break;
  }
  assert(longSymbol && shortSymbol, 'test setup: expected both a long-drawing and a short-drawing symbol among the candidates');

  await test('no 1D trend gate: fires the retest mechanics when the seeded draw matches the fixture\'s long flag', () => {
    const ctx = { symbol: longSymbol, tf: '4h', i: withRetest.length - 1, candlesByTf: { '4h': withRetest }, geometry: GEOMETRY_15M };
    const sig = mod.signalAt(ctx);
    assertRetestSignalShape(sig, 'random-control long-draw signal');
    assertEqual(sig.direction, 'long');
  });

  await test('no 1D trend gate: skips (never forces a trade) when the seeded draw picks the direction with no flag', () => {
    const ctx = { symbol: shortSymbol, tf: '4h', i: withRetest.length - 1, candlesByTf: { '4h': withRetest }, geometry: GEOMETRY_15M };
    assertEqual(mod.signalAt(ctx), null);
  });

  await test('deterministic: the same ctx scores identically on repeated calls', () => {
    const ctx = { symbol: longSymbol, tf: '4h', i: withRetest.length - 1, candlesByTf: { '4h': withRetest }, geometry: GEOMETRY_15M };
    const a = mod.signalAt(ctx);
    const b = mod.signalAt(ctx);
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'same ctx must score identically');
  });

  await test('never reads candles after i', () => {
    const i = withRetest.length - 1;
    const withFuture = withRetest.concat(extraFutureCandles(withRetest[i], H4_MS, 10));
    const ctxA = { symbol: longSymbol, tf: '4h', i, candlesByTf: { '4h': withRetest }, geometry: GEOMETRY_15M };
    const ctxB = { symbol: longSymbol, tf: '4h', i, candlesByTf: { '4h': withFuture }, geometry: GEOMETRY_15M };
    const a = mod.signalAt(ctxA);
    const b = mod.signalAt(ctxB);
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Running S3 retest-entry rule tests...\n');
  await testReFlagRetest4h();
  await testReFlagRetest1h();
  await testReFlagBreakout4h();
  await testReRandom4h();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:', failures.join(', '));
    process.exit(1);
  }
}

main();
