/**
 * S0 swing research (docs/PROMPT_S0_SWING_RESEARCH.md, Agent S0-C - standard controls):
 * deterministic tests for the four control rule modules under scripts/swing/rules/
 * (ctl-donchian-20d, ctl-ema-pullback-1d, ctl-4h-range-break, ctl-random-4h). Every
 * fixture is hand-built (no fixture files), covering the shared contract's own test
 * list: null on insufficient history, mirrored long/short, no lookahead past `ctx.i`,
 * and (random rule only) reproducibility for a fixed seed.
 *
 * Run: node test-swing-rules-controls.js
 */

import { meta as donchianMeta, signalAt as donchianSignal } from './scripts/swing/rules/ctl-donchian-20d.js';
import { meta as emaMeta, signalAt as emaSignal } from './scripts/swing/rules/ctl-ema-pullback-1d.js';
import { meta as rangeMeta, signalAt as rangeSignal, rangeAt, dailyBias } from './scripts/swing/rules/ctl-4h-range-break.js';
import { meta as randomMeta, signalAt as randomSignal, seededDraw, RANDOM_SEED } from './scripts/swing/rules/ctl-random-4h.js';

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
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// synthetic candle builders
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const H4_MS = 4 * 3600000;

function dailyCandle(ts, close, spread = 0.5) {
  return { timestamp: ts, open: close - spread * 0.2, high: close + spread, low: close - spread, close, volume: 1, closeTime: ts + DAY_MS };
}

function h4Candle(ts, close, spread = 0.5) {
  return { timestamp: ts, open: close - spread * 0.2, high: close + spread, low: close - spread, close, volume: 1, closeTime: ts + H4_MS };
}

/** Linear daily ramp (monotonic): closes[k] = start + step*k. */
function buildDailyRamp({ days, start, step, spread = 0.3, startTs = Date.UTC(2025, 0, 1) }) {
  const out = [];
  for (let k = 0; k < days; k++) out.push(dailyCandle(startTs + k * DAY_MS, start + step * k, spread));
  return out;
}

/** Flat 4h range of `count` candles at `price` +/- `spread`. */
function flat4h(count, price, spread = 1, startTs = Date.UTC(2025, 5, 1)) {
  const out = [];
  for (let k = 0; k < count; k++) out.push(h4Candle(startTs + k * H4_MS, price, spread));
  return out;
}

// ---------------------------------------------------------------------------
// fixtures (validated empirically: each trigger fixture is confirmed non-null
// before being used in a lookahead/mirror assertion)
// ---------------------------------------------------------------------------

function donchianLongDaily() {
  return buildDailyRamp({ days: 230, start: 100, step: 1.0, spread: 0.3 });
}
function donchianShortDaily() {
  return buildDailyRamp({ days: 230, start: 400, step: -1.0, spread: 0.3 });
}

function emaLongDaily() {
  const candles = buildDailyRamp({ days: 230, start: 100, step: 0.5, spread: 0.5 });
  const last = candles.length - 1;
  const base = candles[last - 2].close;
  candles[last - 1] = dailyCandle(candles[last - 1].timestamp, base - 50, 0.5); // pullback through EMA21
  candles[last] = dailyCandle(candles[last].timestamp, base + 50, 0.5); // reclaim above EMA21
  return candles;
}
function emaShortDaily() {
  const candles = buildDailyRamp({ days: 230, start: 300, step: -0.5, spread: 0.5 });
  const last = candles.length - 1;
  const base = candles[last - 2].close;
  candles[last - 1] = dailyCandle(candles[last - 1].timestamp, base + 50, 0.5); // bounce up to EMA21
  candles[last] = dailyCandle(candles[last].timestamp, base - 50, 0.5); // reclaim below EMA21
  return candles;
}

function rangeLongFixture() {
  const candles4h = flat4h(6, 100, 1).concat([h4Candle(Date.UTC(2025, 5, 1) + 6 * H4_MS, 110, 1)]);
  const daily = buildDailyRamp({ days: 210, start: 100, step: 0.3 });
  return { candles4h, daily };
}
function rangeShortFixture() {
  const candles4h = flat4h(6, 100, 1).concat([h4Candle(Date.UTC(2025, 5, 1) + 6 * H4_MS, 90, 1)]);
  const daily = buildDailyRamp({ days: 210, start: 300, step: -0.3 });
  return { candles4h, daily };
}

const RULES = [
  { id: 'ctl-donchian-20d', meta: donchianMeta, signalAt: donchianSignal, tf: '1d' },
  { id: 'ctl-ema-pullback-1d', meta: emaMeta, signalAt: emaSignal, tf: '1d' },
  { id: 'ctl-4h-range-break', meta: rangeMeta, signalAt: rangeSignal, tf: '4h' },
  { id: 'ctl-random-4h', meta: randomMeta, signalAt: randomSignal, tf: '4h' }
];

async function run() {
  console.log('\nscripts/swing/rules/ctl-*.js (S0-C standard controls)\n');

  console.log('1) meta shape\n');
  for (const rule of RULES) {
    await test(`${rule.id}: meta has id/label/source/tf/holdMaxHours/stopKind`, () => {
      assertEqual(rule.meta.id, rule.id, 'meta.id');
      assert(typeof rule.meta.label === 'string' && rule.meta.label.length > 0, 'meta.label');
      assertEqual(rule.meta.tf, rule.tf, 'meta.tf');
      assert([24, 48, 72].includes(rule.meta.holdMaxHours), 'meta.holdMaxHours must be 24/48/72');
      assert(['atr', 'structure', 'pct'].includes(rule.meta.stopKind), 'meta.stopKind');
      assert(typeof rule.meta.notes === 'string' && rule.meta.notes.length > 0, 'meta.notes');
    });
  }

  console.log('\n2) null on insufficient history\n');

  await test('ctl-donchian-20d: null with only 30 daily candles (needs EMA200)', () => {
    const candles = buildDailyRamp({ days: 30, start: 100, step: 1.0 });
    const r = donchianSignal({ symbol: 'BTC', tf: '1d', i: candles.length - 1, candlesByTf: { '1d': candles } });
    assertEqual(r, null, 'expected null');
  });

  await test('ctl-ema-pullback-1d: null with only 30 daily candles (needs EMA200)', () => {
    const candles = buildDailyRamp({ days: 30, start: 100, step: 1.0 });
    const r = emaSignal({ symbol: 'BTC', tf: '1d', i: candles.length - 1, candlesByTf: { '1d': candles } });
    assertEqual(r, null, 'expected null');
  });

  await test('ctl-4h-range-break: null with only 3 4h candles (needs 6 + current)', () => {
    const candles4h = flat4h(3, 100, 1);
    const daily = buildDailyRamp({ days: 210, start: 100, step: 0.3 });
    const r = rangeSignal({ symbol: 'BTC', tf: '4h', i: candles4h.length - 1, candlesByTf: { '4h': candles4h, '1d': daily } });
    assertEqual(r, null, 'expected null');
  });

  await test('ctl-4h-range-break: null when 1D history is too short for EMA200 bias', () => {
    const { candles4h } = rangeLongFixture();
    const shortDaily = buildDailyRamp({ days: 30, start: 100, step: 0.3 });
    const r = rangeSignal({ symbol: 'BTC', tf: '4h', i: candles4h.length - 1, candlesByTf: { '4h': candles4h, '1d': shortDaily } });
    assertEqual(r, null, 'expected null');
  });

  await test('ctl-random-4h: null with only 3 4h candles (needs 6 + current for range mechanics)', () => {
    const candles4h = flat4h(3, 100, 1);
    const r = randomSignal({ symbol: 'BTC', tf: '4h', i: candles4h.length - 1, candlesByTf: { '4h': candles4h } });
    assertEqual(r, null, 'expected null');
  });

  console.log('\n3) mirrors long/short on a synthetic series\n');

  await test('ctl-donchian-20d: long on a monotonic uptrend, short on a monotonic downtrend', () => {
    const longDaily = donchianLongDaily();
    const rLong = donchianSignal({ symbol: 'BTC', tf: '1d', i: longDaily.length - 1, candlesByTf: { '1d': longDaily } });
    assert(rLong, 'expected a long signal');
    assertEqual(rLong.direction, 'long', 'direction');
    assertEqual(rLong.entry, longDaily[longDaily.length - 1].close, 'entry = current close');
    assert(rLong.stop < rLong.entry, 'long stop below entry');
    assert(rLong.tp1 > rLong.entry, 'long tp1 above entry');
    assertEqual(Math.round((rLong.tp1 - rLong.entry) * 1000), Math.round(2 * (rLong.entry - rLong.stop) * 1000), 'tp1 = entry + 2R');

    const shortDaily = donchianShortDaily();
    const rShort = donchianSignal({ symbol: 'BTC', tf: '1d', i: shortDaily.length - 1, candlesByTf: { '1d': shortDaily } });
    assert(rShort, 'expected a short signal');
    assertEqual(rShort.direction, 'short', 'direction');
    assertEqual(rShort.entry, shortDaily[shortDaily.length - 1].close, 'entry = current close');
    assert(rShort.stop > rShort.entry, 'short stop above entry');
    assert(rShort.tp1 < rShort.entry, 'short tp1 below entry');
    assertEqual(Math.round((rShort.entry - rShort.tp1) * 1000), Math.round(2 * (rShort.stop - rShort.entry) * 1000), 'tp1 = entry - 2R');
  });

  await test('ctl-ema-pullback-1d: long on an uptrend pullback+reclaim, short on a downtrend bounce+reclaim', () => {
    const longDaily = emaLongDaily();
    const rLong = emaSignal({ symbol: 'BTC', tf: '1d', i: longDaily.length - 1, candlesByTf: { '1d': longDaily } });
    assert(rLong, 'expected a long signal');
    assertEqual(rLong.direction, 'long', 'direction');
    assert(rLong.stop < rLong.entry, 'long stop below entry');
    assert(rLong.tp1 > rLong.entry, 'long tp1 above entry');

    const shortDaily = emaShortDaily();
    const rShort = emaSignal({ symbol: 'BTC', tf: '1d', i: shortDaily.length - 1, candlesByTf: { '1d': shortDaily } });
    assert(rShort, 'expected a short signal');
    assertEqual(rShort.direction, 'short', 'direction');
    assert(rShort.stop > rShort.entry, 'short stop above entry');
    assert(rShort.tp1 < rShort.entry, 'short tp1 below entry');
  });

  await test('ctl-4h-range-break: long on an upside break in an up 1D bias, short on a downside break in a down 1D bias', () => {
    const { candles4h: longCandles, daily: longDaily } = rangeLongFixture();
    const rLong = rangeSignal({ symbol: 'BTC', tf: '4h', i: longCandles.length - 1, candlesByTf: { '4h': longCandles, '1d': longDaily } });
    assert(rLong, 'expected a long signal');
    assertEqual(rLong.direction, 'long', 'direction');
    assert(rLong.stop < rLong.entry, 'long stop below entry');
    assert(rLong.tp1 > rLong.entry, 'long tp1 above entry');

    const { candles4h: shortCandles, daily: shortDaily } = rangeShortFixture();
    const rShort = rangeSignal({ symbol: 'BTC', tf: '4h', i: shortCandles.length - 1, candlesByTf: { '4h': shortCandles, '1d': shortDaily } });
    assert(rShort, 'expected a short signal');
    assertEqual(rShort.direction, 'short', 'direction');
    assert(rShort.stop > rShort.entry, 'short stop above entry');
    assert(rShort.tp1 < rShort.entry, 'short tp1 below entry');
  });

  await test('ctl-4h-range-break: dailyBias/rangeAt helpers agree with the fixtures used above', () => {
    const { candles4h: longCandles, daily: longDaily } = rangeLongFixture();
    assertEqual(dailyBias(longDaily), 'long', 'dailyBias long fixture');
    const range = rangeAt(longCandles);
    assert(range && range.height > 0, 'rangeAt returns a positive-height range');
  });

  await test('ctl-random-4h: produces both directions across a spread of seeds/timestamps (no direction bias baked in)', () => {
    const candles4h = flat4h(6, 100, 1);
    const seen = new Set();
    for (let k = 0; k < 40; k++) {
      const ts = Date.UTC(2025, 5, 1) + (6 + k) * H4_MS;
      const extended = candles4h.concat([h4Candle(ts, 100 + (k % 2 === 0 ? 5 : -5), 1)]);
      const r = randomSignal({ symbol: 'BTC', tf: '4h', i: extended.length - 1, candlesByTf: { '4h': extended } });
      if (r) seen.add(r.direction);
    }
    assert(seen.has('long') && seen.has('short'), `expected both directions across seeds, saw: ${[...seen].join(',')}`);
  });

  console.log('\n4) never reads candles after i (truncated-copy equivalence)\n');

  await test('ctl-donchian-20d: identical result whether or not future candles are appended after i', () => {
    const base = donchianLongDaily();
    const i = base.length - 1;
    const future = buildDailyRamp({ days: 20, start: 5, step: -50, spread: 0.3, startTs: base[base.length - 1].timestamp + DAY_MS }); // wild crash after i
    const extended = base.concat(future);
    const rTruncated = donchianSignal({ symbol: 'BTC', tf: '1d', i, candlesByTf: { '1d': base } });
    const rExtended = donchianSignal({ symbol: 'BTC', tf: '1d', i, candlesByTf: { '1d': extended } });
    assert(rTruncated, 'sanity: truncated fixture should still signal');
    assertEqual(JSON.stringify(rExtended), JSON.stringify(rTruncated), 'appending future candles after i must not change the result');
  });

  await test('ctl-ema-pullback-1d: identical result whether or not future candles are appended after i', () => {
    const base = emaLongDaily();
    const i = base.length - 1;
    const future = buildDailyRamp({ days: 20, start: 5, step: -50, spread: 0.3, startTs: base[base.length - 1].timestamp + DAY_MS });
    const extended = base.concat(future);
    const rTruncated = emaSignal({ symbol: 'BTC', tf: '1d', i, candlesByTf: { '1d': base } });
    const rExtended = emaSignal({ symbol: 'BTC', tf: '1d', i, candlesByTf: { '1d': extended } });
    assert(rTruncated, 'sanity: truncated fixture should still signal');
    assertEqual(JSON.stringify(rExtended), JSON.stringify(rTruncated), 'appending future candles after i must not change the result');
  });

  await test('ctl-4h-range-break: identical result whether or not future 4h candles are appended after i', () => {
    const { candles4h, daily } = rangeLongFixture();
    const i = candles4h.length - 1;
    const future = flat4h(20, 5, 1, candles4h[candles4h.length - 1].timestamp + H4_MS); // crash + flatten after i
    const extended = candles4h.concat(future);
    const rTruncated = rangeSignal({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': candles4h, '1d': daily } });
    const rExtended = rangeSignal({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': extended, '1d': daily } });
    assert(rTruncated, 'sanity: truncated fixture should still signal');
    assertEqual(JSON.stringify(rExtended), JSON.stringify(rTruncated), 'appending future candles after i must not change the result');
  });

  await test('ctl-random-4h: identical result whether or not future 4h candles are appended after i', () => {
    const candles4h = flat4h(6, 100, 1).concat([h4Candle(Date.UTC(2025, 5, 1) + 6 * H4_MS, 108, 1)]);
    const i = candles4h.length - 1;
    const future = flat4h(20, 5, 1, candles4h[candles4h.length - 1].timestamp + H4_MS);
    const extended = candles4h.concat(future);
    const rTruncated = randomSignal({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': candles4h } });
    const rExtended = randomSignal({ symbol: 'BTC', tf: '4h', i, candlesByTf: { '4h': extended } });
    assertEqual(JSON.stringify(rExtended), JSON.stringify(rTruncated), 'appending future candles after i must not change the result');
  });

  console.log('\n5) ctl-random-4h: seeded reproducibility\n');

  await test('seededDraw is a pure deterministic function of (seed, symbol, timestamp)', () => {
    const a = seededDraw(RANDOM_SEED, 'BTC', 1780000000000);
    const b = seededDraw(RANDOM_SEED, 'BTC', 1780000000000);
    assertEqual(a, b, 'same inputs must give the same draw');
    assert(a >= 0 && a < 1, 'draw is in [0,1)');
    const c = seededDraw(RANDOM_SEED, 'ETH', 1780000000000);
    assert(a !== c, 'sanity: different symbol should (almost certainly) give a different draw');
  });

  await test('signalAt is reproducible: two calls on the same ctx return the identical signal', () => {
    const candles4h = flat4h(6, 100, 1).concat([h4Candle(Date.UTC(2025, 5, 1) + 6 * H4_MS, 108, 1)]);
    const ctx = { symbol: 'SOL', tf: '4h', i: candles4h.length - 1, candlesByTf: { '4h': candles4h } };
    const r1 = randomSignal(ctx);
    const r2 = randomSignal(ctx);
    assertEqual(JSON.stringify(r1), JSON.stringify(r2), 'repeated calls on the same ctx must match exactly');
  });

  await test('ctl-random-4h: same stop/TP mechanics as ctl-4h-range-break (shared rangeAt)', () => {
    // ts offset +7ms picked so the seeded draw lands 'long' (< 0.5), matching this
    // fixture's entry (108) sitting above the range midpoint (100) - a 'short' draw
    // here would be geometrically invalid (stop above entry) and correctly skipped.
    const candles4h = flat4h(6, 100, 1).concat([h4Candle(Date.UTC(2025, 5, 1) + 6 * H4_MS + 7, 108, 1)]);
    const range = rangeAt(candles4h);
    const r = randomSignal({ symbol: 'BTC', tf: '4h', i: candles4h.length - 1, candlesByTf: { '4h': candles4h } });
    assert(r, 'expected a signal at this fixture');
    assertEqual(r.stop, range.mid, 'random rule stop must equal the shared range midpoint');
    const expectedTp1 = r.direction === 'long' ? r.entry + range.height : r.entry - range.height;
    assertEqual(r.tp1, expectedTp1, 'random rule tp1 must equal entry +/- one range-height');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('Failed tests:', failures.join(', '));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
