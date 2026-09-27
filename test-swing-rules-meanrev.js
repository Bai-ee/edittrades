/**
 * S1 mean-reversion rules test suite (docs/PROMPT_S1_EDGE_SEARCH.md Agent D - "D - mean-
 * reversion at zones"). Deterministic, zero-network. For each of the four rule modules
 * under scripts/swing/rules/ (mr-zone-touch-1h, mr-channel-fade-4h, mr-rsi-extreme-1h,
 * mr-random-1h) this asserts, per the shared S0/S1 contract:
 *   - returns null on insufficient history
 *   - mirrors long/short on a synthetic or real-fixture series
 *   - never reads candles after `i` (own timeframe and, for mr-zone-touch-1h, the
 *     cross-timeframe 15m/4h/1D arrays), verified by comparing a call against a properly
 *     truncated copy to a call against a longer array with extra "future" candles
 *     appended past `i` / past the current candle's close time
 *   - (mr-random-1h only) seeded reproducibility
 *
 * Fixture strategy: hand-built series rarely satisfy lib/geometry.js's production zone/
 * diagonal gates (>=2 zone touches within tolerance, or a diagonal's >=3 touches / >=20
 * candle span / >=3 ATR bounce). mr-zone-touch-1h and mr-rsi-extreme-1h scan the real
 * deep60-2026-09-24 fixture (the shared S0/S1 contract's own data source) for a genuine
 * trigger instead of trying to fabricate one, exactly as test-swing-rules-playbook.js does
 * for pb-channel-edge-4h. mr-channel-fade-4h reuses test/fixtures/geometryFixtures.js's
 * `legs`/`r4` builders (the same ones test-geometry.js's own risingChannel() fixture is
 * built from) to construct a channel deterministically, truncated so price sits at the
 * upper edge instead of that fixture's own mid-channel cut.
 *
 * Run: node test-swing-rules-meanrev.js
 */

import { readFileSync } from 'node:fs';
import * as zoneRule from './scripts/swing/rules/mr-zone-touch-1h.js';
import * as fadeRule from './scripts/swing/rules/mr-channel-fade-4h.js';
import * as rsiRule from './scripts/swing/rules/mr-rsi-extreme-1h.js';
import * as rndRule from './scripts/swing/rules/mr-random-1h.js';
import { legs, r4 } from './test/fixtures/geometryFixtures.js';

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as test-swing-rules-controls.js / -playbook.js)
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
  assert(sig.direction === 'long' ? sig.stop < sig.entry : sig.stop > sig.entry, `${msg}: stop on the correct side of entry`);
  assert(Array.isArray(sig.reason) && sig.reason.length > 0 && sig.reason.every((r) => typeof r === 'string'), `${msg}: reason[]`);
}

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const H1_MS = 3600000;
const M15_MS = 900000;
const H4_MS = 14400000;
const DAY_MS = 86400000;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function readFixtureCandles(symbol, tf) {
  const url = new URL(`./test/fixtures/history/deep60-2026-09-24/${symbol}_${tf}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')).candles;
}

/** Reflect a real candle series around `pivot` (price -> 2*pivot - price, high/low swapped). */
function mirrorCandles(candles, pivot) {
  return candles.map((c) => ({
    ...c,
    open: 2 * pivot - c.open,
    high: 2 * pivot - c.low,
    low: 2 * pivot - c.high,
    close: 2 * pivot - c.close
  }));
}

function extraFutureCandles(lastCandle, stepMs, count) {
  const out = [];
  let close = lastCandle.close;
  let ts = isFiniteNumber(lastCandle.closeTime) ? lastCandle.closeTime : lastCandle.timestamp;
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

function flat1h(count, price = 100, spread = 1, startTs = Date.UTC(2025, 5, 1)) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const t = startTs + k * H1_MS;
    out.push({ timestamp: t, open: price, high: price + spread, low: price - spread, close: price, closeTime: t + H1_MS });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) meta shape
// ---------------------------------------------------------------------------

const RULES = [
  { id: 'mr-zone-touch-1h', mod: zoneRule, tf: '1h' },
  { id: 'mr-channel-fade-4h', mod: fadeRule, tf: '4h' },
  { id: 'mr-rsi-extreme-1h', mod: rsiRule, tf: '1h' },
  { id: 'mr-random-1h', mod: rndRule, tf: '1h' }
];

async function testMetaShape() {
  console.log('\n1) meta shape\n');
  for (const rule of RULES) {
    await test(`${rule.id}: meta has id/label/source/tf/holdMaxHours/stopKind/notes`, () => {
      assertEqual(rule.mod.meta.id, rule.id, 'meta.id');
      assert(typeof rule.mod.meta.label === 'string' && rule.mod.meta.label.length > 0, 'meta.label');
      assertEqual(rule.mod.meta.tf, rule.tf, 'meta.tf');
      assert([24, 48, 72].includes(rule.mod.meta.holdMaxHours), 'meta.holdMaxHours must be 24/48/72');
      assert(['atr', 'structure', 'pct'].includes(rule.mod.meta.stopKind), 'meta.stopKind');
      assert(typeof rule.mod.meta.notes === 'string' && rule.mod.meta.notes.length > 0, 'meta.notes');
    });
  }
}

// ---------------------------------------------------------------------------
// 2) null on insufficient history / malformed ctx
// ---------------------------------------------------------------------------

async function testInsufficientHistory() {
  console.log('\n2) null on insufficient history / malformed ctx\n');

  await test('mr-zone-touch-1h: null with only 10 1h candles (needs 50 for zones)', () => {
    const c = flat1h(10);
    assertEqual(zoneRule.signalAt({ symbol: 'BTC', tf: '1h', i: c.length - 1, candlesByTf: { '1h': c } }), null);
  });

  await test('mr-zone-touch-1h: null on empty/malformed ctx', () => {
    assertEqual(zoneRule.signalAt({}), null);
    assertEqual(zoneRule.signalAt({ i: -1, candlesByTf: {} }), null);
  });

  await test('mr-channel-fade-4h: null with only 10 4h candles', () => {
    const tiny = Array.from({ length: 10 }, (_, k) => ({
      timestamp: k * H4_MS, open: 100, high: 101, low: 99, close: 100, closeTime: (k + 1) * H4_MS
    }));
    assertEqual(fadeRule.signalAt({ i: tiny.length - 1, candlesByTf: { '4h': tiny } }), null);
  });

  await test('mr-channel-fade-4h: null on empty/malformed ctx', () => {
    assertEqual(fadeRule.signalAt({}), null);
    assertEqual(fadeRule.signalAt({ i: -1, candlesByTf: {} }), null);
  });

  await test('mr-rsi-extreme-1h: null with only 10 1h candles (needs 60)', () => {
    const c = flat1h(10);
    assertEqual(rsiRule.signalAt({ symbol: 'BTC', tf: '1h', i: c.length - 1, candlesByTf: { '1h': c } }), null);
  });

  await test('mr-rsi-extreme-1h: null on empty/malformed ctx', () => {
    assertEqual(rsiRule.signalAt({}), null);
    assertEqual(rsiRule.signalAt({ i: -1, candlesByTf: {} }), null);
  });

  await test('mr-random-1h: null with only 10 1h candles (needs 30 for ATR)', () => {
    const c = flat1h(10);
    assertEqual(rndRule.signalAt({ symbol: 'BTC', tf: '1h', i: c.length - 1, candlesByTf: { '1h': c } }), null);
  });

  await test('mr-random-1h: null without a symbol', () => {
    const c = flat1h(40);
    assertEqual(rndRule.signalAt({ tf: '1h', i: c.length - 1, candlesByTf: { '1h': c } }), null);
  });

  await test('mr-random-1h: null on empty/malformed ctx', () => {
    assertEqual(rndRule.signalAt({}), null);
    assertEqual(rndRule.signalAt({ i: -1, candlesByTf: {}, symbol: 'BTC' }), null);
  });
}

// ---------------------------------------------------------------------------
// 3) mr-zone-touch-1h: real-fixture trigger, mirror, no-lookahead (own + cross tf)
// ---------------------------------------------------------------------------

async function testZoneTouch() {
  console.log('\n3) mr-zone-touch-1h\n');

  const sym = 'BTC';
  const c1h = readFixtureCandles(sym, '1h');
  const c15m = readFixtureCandles(sym, '15m');
  const c4h = readFixtureCandles(sym, '4h');
  const c1d = readFixtureCandles(sym, '1d');

  let hitIdx = null;
  for (let k = 50; k < c1h.length && hitIdx === null; k++) {
    if (zoneRule.signalAt({ symbol: sym, tf: '1h', i: k, candlesByTf: { '1h': c1h, '15m': c15m, '4h': c4h, '1d': c1d } })) hitIdx = k;
  }

  let baseSignal;
  await test('fires a real zone-touch signal on the BTC 1h fixture', () => {
    assert(hitIdx !== null, 'expected at least one zone-touch signal in the fixture window');
    baseSignal = zoneRule.signalAt({ symbol: sym, tf: '1h', i: hitIdx, candlesByTf: { '1h': c1h, '15m': c15m, '4h': c4h, '1d': c1d } });
    assertSignalShape(baseSignal, 'fixture signal');
  });

  await test('mirrors to the opposite direction on a reflected copy of every timeframe', () => {
    const slice = c1h.slice(0, hitIdx + 1);
    const pivot = slice.reduce((a, c) => a + c.close, 0) / slice.length;
    const mirroredSig = zoneRule.signalAt({
      symbol: sym,
      tf: '1h',
      i: hitIdx,
      candlesByTf: {
        '1h': mirrorCandles(c1h, pivot),
        '15m': mirrorCandles(c15m, pivot),
        '4h': mirrorCandles(c4h, pivot),
        '1d': mirrorCandles(c1d, pivot)
      }
    });
    assertSignalShape(mirroredSig, 'mirrored signal');
    assert(mirroredSig.direction !== baseSignal.direction, 'mirrored series flips direction');
    const tol = 0.5;
    assertClose(mirroredSig.entry, 2 * pivot - baseSignal.entry, tol, 'entry mirrors');
    assertClose(mirroredSig.stop, 2 * pivot - baseSignal.stop, tol, 'stop mirrors');
    assertClose(mirroredSig.tp1, 2 * pivot - baseSignal.tp1, tol, 'tp1 mirrors');
  });

  await test('never reads candles after i, on any of the four timeframes', () => {
    const ext1h = c1h.concat(extraFutureCandles(c1h[c1h.length - 1], H1_MS, 20));
    const ext15m = c15m.concat(extraFutureCandles(c15m[c15m.length - 1], M15_MS, 40));
    const ext4h = c4h.concat(extraFutureCandles(c4h[c4h.length - 1], H4_MS, 20));
    const ext1d = c1d.concat(extraFutureCandles(c1d[c1d.length - 1], DAY_MS, 20));
    const withFuture = zoneRule.signalAt({ symbol: sym, tf: '1h', i: hitIdx, candlesByTf: { '1h': ext1h, '15m': ext15m, '4h': ext4h, '1d': ext1d } });
    assertEqual(JSON.stringify(withFuture), JSON.stringify(baseSignal), 'appending future candles on any timeframe must not change the result');
  });

  await test('computeZones/findTouchedZone/deriveLean helpers: null on insufficient history', () => {
    assertEqual(zoneRule.computeZones(flat1h(10)), null, 'computeZones needs 50 candles');
    assertEqual(zoneRule.findTouchedZone(null, 100), null, 'findTouchedZone guards non-array zones');
    assertEqual(zoneRule.deriveLean(flat1h(10)), null, 'deriveLean needs 25+ candles');
  });
}

// ---------------------------------------------------------------------------
// 4) mr-channel-fade-4h: deterministic channel fixture, mirror, no-lookahead
// ---------------------------------------------------------------------------

/**
 * Same rising-channel construction as test-geometry.js's own risingChannel() fixture
 * (lower line 80 + 0.25/candle, upper line 10 above, legs of 8 candles), but cut after 57
 * candles instead of that fixture's own `.slice(0, -4)` (mid-channel): at 57 candles price
 * sits at positionPct ~87 in a still-rising channel - the upper-edge fade this rule
 * targets, mirrored by test-geometry.js's own risingChannel() sitting at the *lower* edge
 * of a falling channel once reflected.
 */
function fadeChannelFixture() {
  const points = [];
  for (let k = 0; k <= 8; k++) points.push(r4(80 + 0.25 * k * 8 + (k % 2 ? 10 : 0)));
  return legs(points, 8).slice(0, 57);
}

function mirrorAroundLocal(candles, pivot) {
  return candles.map((c) => ({
    ...c,
    open: r4(2 * pivot - c.open),
    high: r4(2 * pivot - c.low),
    low: r4(2 * pivot - c.high),
    close: r4(2 * pivot - c.close)
  }));
}

async function testChannelFade() {
  console.log('\n4) mr-channel-fade-4h\n');

  const candles = fadeChannelFixture();
  const i = candles.length - 1;

  let baseSignal;
  await test('fires a short fade at the upper edge of a rising channel', () => {
    baseSignal = fadeRule.signalAt({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': candles } });
    assertSignalShape(baseSignal, 'fade signal');
    assertEqual(baseSignal.direction, 'short', 'upper-edge fade in a rising channel is short');
    assert(baseSignal.tp2 === undefined, 'mr-channel-fade-4h has no tp2 (mid-channel only)');
  });

  await test('mirrors to a long fade at the lower edge of a falling channel', () => {
    const pivot = 100; // GEOMETRY_PIVOT convention (test/fixtures/geometryFixtures.js)
    const mirrored = mirrorAroundLocal(candles, pivot);
    const mirroredSig = fadeRule.signalAt({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': mirrored } });
    assertSignalShape(mirroredSig, 'mirrored fade signal');
    assertEqual(mirroredSig.direction, 'long', 'mirrored fade flips to long');
    const tol = 0.05;
    assertClose(mirroredSig.entry, 2 * pivot - baseSignal.entry, tol, 'entry mirrors');
    assertClose(mirroredSig.stop, 2 * pivot - baseSignal.stop, tol, 'stop mirrors');
    assertClose(mirroredSig.tp1, 2 * pivot - baseSignal.tp1, tol, 'tp1 mirrors');
  });

  await test('never reads candles after i', () => {
    const withFuture = candles.concat(extraFutureCandles(candles[candles.length - 1], H4_MS, 10));
    const a = fadeRule.signalAt({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': candles } });
    const b = fadeRule.signalAt({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': withFuture } });
    assertEqual(JSON.stringify(b), JSON.stringify(a), 'appending future 4h candles past i must not change the result');
    assert(a !== null, 'sanity: base case still fires');
  });

  await test('does not fire the with-trend case pb-channel-edge-4h already covers (lower edge of the same rising channel)', () => {
    const withTrendCandles = legs((() => {
      const pts = [];
      for (let k = 0; k <= 8; k++) pts.push(r4(80 + 0.25 * k * 8 + (k % 2 ? 10 : 0)));
      return pts;
    })(), 8).slice(0, -4); // test-geometry.js's own risingChannel(): mid-channel, not an edge
    const sig = fadeRule.signalAt({ symbol: 'BTC', tf: '4h', i: withTrendCandles.length - 1, candlesByTf: { '4h': withTrendCandles } });
    assertEqual(sig, null, 'mid-channel is neither edge - no fade signal');
  });
}

// ---------------------------------------------------------------------------
// 5) mr-rsi-extreme-1h: real-fixture trigger, mirror, no-lookahead
// ---------------------------------------------------------------------------

async function testRsiExtreme() {
  console.log('\n5) mr-rsi-extreme-1h\n');

  const sym = 'BTC';
  const c1h = readFixtureCandles(sym, '1h');

  let hitIdx = null;
  for (let k = 60; k < c1h.length && hitIdx === null; k++) {
    if (rsiRule.signalAt({ symbol: sym, tf: '1h', i: k, candlesByTf: { '1h': c1h } })) hitIdx = k;
  }

  let baseSignal;
  await test('fires a real RSI-extreme-at-a-zone signal on the BTC 1h fixture', () => {
    assert(hitIdx !== null, 'expected at least one RSI-extreme signal in the fixture window');
    baseSignal = rsiRule.signalAt({ symbol: sym, tf: '1h', i: hitIdx, candlesByTf: { '1h': c1h } });
    assertSignalShape(baseSignal, 'fixture signal');
  });

  await test('mirrors to the opposite direction on a reflected copy', () => {
    const slice = c1h.slice(0, hitIdx + 1);
    const pivot = slice.reduce((a, c) => a + c.close, 0) / slice.length;
    const mirroredSig = rsiRule.signalAt({ symbol: sym, tf: '1h', i: hitIdx, candlesByTf: { '1h': mirrorCandles(c1h, pivot) } });
    assertSignalShape(mirroredSig, 'mirrored signal');
    assert(mirroredSig.direction !== baseSignal.direction, 'mirrored series flips direction');
    const tol = 0.5;
    assertClose(mirroredSig.entry, 2 * pivot - baseSignal.entry, tol, 'entry mirrors');
    assertClose(mirroredSig.stop, 2 * pivot - baseSignal.stop, tol, 'stop mirrors');
    assertClose(mirroredSig.tp1, 2 * pivot - baseSignal.tp1, tol, 'tp1 mirrors');
  });

  await test('never reads candles after i', () => {
    const ext = c1h.concat(extraFutureCandles(c1h[c1h.length - 1], H1_MS, 20));
    const withFuture = rsiRule.signalAt({ symbol: sym, tf: '1h', i: hitIdx, candlesByTf: { '1h': ext } });
    assertEqual(JSON.stringify(withFuture), JSON.stringify(baseSignal), 'appending future 1h candles past i must not change the result');
  });

  await test('computeRSI: null on insufficient history, 0-100 bounded, extremes on monotonic series', () => {
    assertEqual(rsiRule.computeRSI([1, 2, 3]), null, 'needs period+1 closes');
    const rising = Array.from({ length: 30 }, (_, k) => 100 + k);
    const falling = Array.from({ length: 30 }, (_, k) => 200 - k);
    assert(rsiRule.computeRSI(rising) > 90, 'a clean uptrend reads a very high RSI');
    assert(rsiRule.computeRSI(falling) < 10, 'a clean downtrend reads a very low RSI');
  });
}

// ---------------------------------------------------------------------------
// 6) mr-random-1h: real-fixture trigger, seeded reproducibility, no-lookahead
// ---------------------------------------------------------------------------

async function testRandom() {
  console.log('\n6) mr-random-1h\n');

  await test('seededDraw is a pure deterministic function of (seed, symbol, timestamp)', () => {
    const a = rndRule.seededDraw(rndRule.RANDOM_SEED, 'BTC', 1780000000000);
    const b = rndRule.seededDraw(rndRule.RANDOM_SEED, 'BTC', 1780000000000);
    assertEqual(a, b, 'same inputs must give the same draw');
    assert(a >= 0 && a < 1, 'draw is in [0,1)');
    const c = rndRule.seededDraw(rndRule.RANDOM_SEED, 'ETH', 1780000000000);
    assert(a !== c, 'sanity: different symbol should (almost certainly) give a different draw');
  });

  await test('signalAt is reproducible: two calls on the same ctx return the identical signal', () => {
    const c = flat1h(35);
    const ctx = { symbol: 'SOL', tf: '1h', i: c.length - 1, candlesByTf: { '1h': c } };
    const r1 = rndRule.signalAt(ctx);
    const r2 = rndRule.signalAt(ctx);
    assertEqual(JSON.stringify(r1), JSON.stringify(r2), 'repeated calls on the same ctx must match exactly');
  });

  await test('produces both directions across a spread of seeds/timestamps (no direction bias baked in)', () => {
    const base = flat1h(30);
    const seen = new Set();
    for (let k = 0; k < 60; k++) {
      const ts = base[base.length - 1].timestamp + (k + 1) * H1_MS;
      const extended = base.concat([{ timestamp: ts, open: 100, high: 101 + (k % 3), low: 99, close: 100 + (k % 2 === 0 ? 1 : -1), closeTime: ts + H1_MS }]);
      const r = rndRule.signalAt({ symbol: 'BTC', tf: '1h', i: extended.length - 1, candlesByTf: { '1h': extended } });
      if (r) seen.add(r.direction);
    }
    assert(seen.has('long') && seen.has('short'), `expected both directions across seeds, saw: ${[...seen].join(',')}`);
  });

  const sym = 'ETH';
  const c1h = readFixtureCandles(sym, '1h');
  let hitIdx = null;
  for (let k = 30; k < c1h.length && hitIdx === null; k++) {
    if (rndRule.signalAt({ symbol: sym, tf: '1h', i: k, candlesByTf: { '1h': c1h } })) hitIdx = k;
  }

  await test('fires on the real ETH 1h fixture and never reads candles after i', () => {
    assert(hitIdx !== null, 'expected at least one random signal in the fixture window');
    const base = rndRule.signalAt({ symbol: sym, tf: '1h', i: hitIdx, candlesByTf: { '1h': c1h } });
    assertSignalShape(base, 'fixture signal');
    const ext = c1h.concat(extraFutureCandles(c1h[c1h.length - 1], H1_MS, 20));
    const withFuture = rndRule.signalAt({ symbol: sym, tf: '1h', i: hitIdx, candlesByTf: { '1h': ext } });
    assertEqual(JSON.stringify(withFuture), JSON.stringify(base), 'appending future 1h candles past i must not change the result');
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Running S1 Agent D mean-reversion rule tests...\n');
  await testMetaShape();
  await testInsufficientHistory();
  await testZoneTouch();
  await testChannelFade();
  await testRsiExtreme();
  await testRandom();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:', failures.join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
