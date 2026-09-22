/**
 * Deterministic, zero-network test suite for lib/chartRender.js (phase 8b) and the
 * buildScalpContext `chart` hook that feeds it.
 *
 * Pixel checks decode the real PNG and sample the rows the layout maps a price to, so
 * an overlay drawn at the wrong height, or not at all, fails here.
 *
 * Run: node test-chart-render.js
 */

import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import * as PImage from 'pureimage';
import {
  parseChartArg,
  buildChartSpec,
  computeLayout,
  renderChart,
  renderContextChart,
  ChartRequestError,
  CHART_SYMBOLS,
  CHART_TIMEFRAMES,
  CHART_COLORS,
  CHART_WIDTH,
  CHART_HEIGHT,
  CHART_MAX_BYTES
} from './lib/chartRender.js';
import { buildScalpContext, SYMBOLS, TIMEFRAMES, INTERVAL_MS, CANDLE_LIMITS } from './services/scalpContext.js';
import { FIXTURE_PIVOT, withTimes, triggeringFlag } from './test/fixtures/flagFixtures.js';

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
    console.log(`  ✗ ${name}\n      ${err && err.message ? err.message : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertThrowsChartError(fn, code, msg) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof ChartRequestError, `${msg}: expected ChartRequestError, got ${err && err.name}`);
    assertEqual(err.name, 'ChartRequestError', `${msg}: error name`);
    assertEqual(err.code, code, `${msg}: error code`);
    return;
  }
  throw new Error(`${msg}: expected a ChartRequestError(${code})`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 22, 12, 0, 30);

/** A spec-ready payload for one symbol/timeframe from plain candle objects. */
function payloadFor(symbol, timeframe, candles, { ema21 = null, ema200 = null, geometry = null, candidates = [] } = {}) {
  return {
    closedThrough: '2026-09-22T12:00:00.000Z',
    symbols: {
      [symbol]: {
        timeframes: { [timeframe]: { candles, ema21, ema200, closedThrough: '2026-09-22T12:00:00.000Z' } },
        geometryContext: geometry ? { [timeframe]: geometry } : {},
        candidateSetups: candidates.map((c) => ({ timeframe, ...c }))
      }
    }
  };
}

/** n flat-ish candles oscillating in [99, 102]. */
function flatCandles(n) {
  return Array.from({ length: n }, (_, i) => {
    const up = i % 2 === 0;
    return { t: new Date(NOW - (n - i) * 3600000).toISOString(), o: up ? 100 : 101, h: 102, l: 99, c: up ? 101 : 100, v: 1 };
  });
}

/** Sinusoidal closed candles so the real build finds pivots, zones and diagonals. */
function waveCandles(interval, count) {
  const step = INTERVAL_MS[interval];
  const firstOpen = Math.floor(NOW / step) * step - count * step;
  return Array.from({ length: count }, (_, i) => {
    const mid = FIXTURE_PIVOT * (1 + 0.01 * Math.sin(i / 6) + 0.00005 * i);
    const open = mid * (1 - 0.001 * Math.cos(i));
    const close = mid * (1 + 0.001 * Math.cos(i * 1.3));
    return {
      timestamp: firstOpen + i * step,
      open,
      high: Math.max(open, close) * 1.0015,
      low: Math.min(open, close) * 0.9985,
      close,
      volume: 100,
      closeTime: firstOpen + (i + 1) * step
    };
  });
}

function buildFixtureContext(chart = null) {
  return buildScalpContext({
    symbols: ['BTC'],
    now: NOW,
    chart,
    fetchCandles: async (pair, interval) => (interval === '1m' ? withTimes(triggeringFlag(), NOW) : waveCandles(interval, 500)),
    fetchAccount: async () => ({ status: 'unavailable', margin: { usd: null, byAsset: {} } })
  });
}

async function decode(png) {
  return PImage.decodePNGFromStream(Readable.from([png]));
}

function pixelHex(bitmap, x, y) {
  const v = bitmap.getPixelRGBA(x, y) >>> 0;
  return `#${(v >>> 8).toString(16).padStart(6, '0')}`;
}

/** An x between two candle centres, clear of wicks and bodies. */
function gapX(layout, i) {
  return Math.round((layout.xOf(i) + layout.xOf(i + 1)) / 2);
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('\nparseChartArg');

  await test('absent chart argument is null (no chart)', () => {
    assertEqual(parseChartArg(undefined), null, 'undefined');
    assertEqual(parseChartArg(null), null, 'null');
  });

  await test('"BTC:1m" parses; case is normalised', () => {
    const r = parseChartArg('BTC:1m');
    assertEqual(`${r.symbol}:${r.timeframe}`, 'BTC:1m', 'parse');
    const lower = parseChartArg(' sol:4H ');
    assertEqual(`${lower.symbol}:${lower.timeframe}`, 'SOL:4h', 'normalise');
  });

  await test('more than one chart is rejected, never truncated', async () => {
    await assertThrowsChartError(() => parseChartArg('BTC:1m,SOL:5m'), 'multiple_charts', 'comma list');
    await assertThrowsChartError(() => parseChartArg(['BTC:1m', 'SOL:5m']), 'multiple_charts', 'repeated arg');
    await assertThrowsChartError(() => parseChartArg('BTC:1m:SOL'), 'multiple_charts', 'extra colon');
  });

  await test('malformed, unknown symbol and unknown timeframe are named errors', async () => {
    await assertThrowsChartError(() => parseChartArg('BTC'), 'invalid_format', 'no timeframe');
    await assertThrowsChartError(() => parseChartArg(''), 'invalid_format', 'empty');
    await assertThrowsChartError(() => parseChartArg(42), 'invalid_format', 'number');
    await assertThrowsChartError(() => parseChartArg('XRP:1m'), 'unknown_symbol', 'symbol');
    await assertThrowsChartError(() => parseChartArg('BTC:2h'), 'unknown_timeframe', 'timeframe');
  });

  await test('chart symbols/timeframes match what the payload carries', () => {
    assertEqual(CHART_SYMBOLS.join(','), SYMBOLS.join(','), 'symbols');
    assertEqual(CHART_TIMEFRAMES.join(','), TIMEFRAMES.join(','), 'timeframes');
  });

  console.log('\nrenderChart');

  const flat = flatCandles(24);

  await test('renders a fixture to a PNG under budget', async () => {
    const png = await renderChart(buildChartSpec(payloadFor('BTC', '1h', flat, { ema21: 100.5, ema200: 98 }), { symbol: 'BTC', timeframe: '1h' }));
    assert(Buffer.isBuffer(png), 'buffer');
    assertEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic bytes');
    assert(png.length <= CHART_MAX_BYTES, `size ${png.length} > ${CHART_MAX_BYTES}`);
    const bmp = await decode(png);
    assertEqual(`${bmp.width}x${bmp.height}`, `${CHART_WIDTH}x${CHART_HEIGHT}`, 'dimensions');
  });

  await test('unknown symbol / timeframe throw ChartRequestError, never a blank image', async () => {
    const spec = buildChartSpec(payloadFor('BTC', '1h', flat), { symbol: 'BTC', timeframe: '1h' });
    await assertThrowsChartError(() => renderChart({ ...spec, symbol: 'DOGE' }), 'unknown_symbol', 'renderChart symbol');
    await assertThrowsChartError(() => renderChart({ ...spec, timeframe: '2h' }), 'unknown_timeframe', 'renderChart timeframe');
    await assertThrowsChartError(() => buildChartSpec(payloadFor('BTC', '1h', flat), { symbol: 'XRP', timeframe: '1h' }), 'unknown_symbol', 'spec symbol');
    await assertThrowsChartError(() => buildChartSpec(payloadFor('BTC', '1h', flat), { symbol: 'SOL', timeframe: '1h' }), 'no_data', 'symbol missing from payload');
    await assertThrowsChartError(() => buildChartSpec(payloadFor('BTC', '1h', []), { symbol: 'BTC', timeframe: '1h' }), 'no_data', 'empty window');
  });

  // Synthetic series: candles in [99, 102] (overlays within 1.5 of that span join the
  // range), EMA21 flat at 103.2, EMA200 flat at 98.8, a support zone at 97.6-98.2, a
  // long candidate with flagHigh 102.6 / flagLow 98.5.
  const n = flat.length;
  const synthetic = payloadFor('BTC', '1h', flat, {
    ema21: 103.2,
    ema200: 98.8,
    geometry: {
      horizontalSupportZones: [{ low: 97.6, high: 98.2, touches: 3, side: 'support' }],
      horizontalResistanceZones: [],
      diagonalSupport: { detected: false },
      diagonalResistance: { detected: false },
      channel: { detected: false }
    },
    candidates: [{ type: 'flag', direction: 'long', flagHigh: 102.6, flagLow: 98.5, breakoutLevel: 102.6, invalidation: 98.5 }]
  });
  const series = { ema21: Array(n).fill(103.2), ema200: Array(n).fill(98.8) };
  const spec = buildChartSpec(synthetic, { symbol: 'BTC', timeframe: '1h' }, series);
  const layout = computeLayout(spec);
  const bmp = await decode(await renderChart(spec));

  await test('EMA21 and EMA200 lines sit on the rows their prices map to', () => {
    for (const i of [2, 11, 20]) {
      assertEqual(pixelHex(bmp, gapX(layout, i), layout.yOf(103.2)), CHART_COLORS.ema21, `EMA21 at candle ${i}`);
      assertEqual(pixelHex(bmp, gapX(layout, i), layout.yOf(98.8)), CHART_COLORS.ema200, `EMA200 at candle ${i}`);
    }
    // A few rows away from the line is background, so the line is not a smear.
    assertEqual(pixelHex(bmp, gapX(layout, 11), layout.yOf(103.2) - 6), CHART_COLORS.background, 'above EMA21');
  });

  await test('a support zone is a band between its low and high rows', () => {
    const x = gapX(layout, 8);
    assertEqual(pixelHex(bmp, x, layout.yOf(97.9)), CHART_COLORS.zoneSupport, 'band middle');
    assertEqual(pixelHex(bmp, x, layout.yOf(98.2) + 1), CHART_COLORS.zoneSupport, 'band top edge');
    assertEqual(pixelHex(bmp, x, layout.yOf(97.6) - 1), CHART_COLORS.zoneSupport, 'band bottom edge');
    assertEqual(pixelHex(bmp, x, layout.yOf(97.6) + 4), CHART_COLORS.background, 'below band');
  });

  await test('an overlay far outside the candle span does not flatten the candles', () => {
    const far = JSON.parse(JSON.stringify(synthetic));
    far.symbols.BTC.timeframes['1h'].ema200 = 50;
    const L = computeLayout(buildChartSpec(far, { symbol: 'BTC', timeframe: '1h' }));
    assert(L.min > 90, `range reached down to ${L.min}`);
  });

  await test('candidate flag high/low are dashed lines at their rows', () => {
    for (const price of [102.6, 98.5]) {
      const y = layout.yOf(price);
      let on = 0;
      let off = 0;
      for (let x = 12; x < 300; x++) {
        const hex = pixelHex(bmp, x, y);
        if (hex === CHART_COLORS.candidateLong) on++;
        else if (hex === CHART_COLORS.background || hex === CHART_COLORS.grid) off++;
      }
      assert(on > 50, `flag line at ${price}: ${on} coloured px`);
      assert(off > 20, `flag line at ${price} is not dashed (${off} gap px)`);
    }
  });

  await test('diagonals of a detected channel are drawn in the channel colour at their current level', async () => {
    const withChannel = JSON.parse(JSON.stringify(synthetic));
    Object.assign(withChannel.symbols.BTC.geometryContext['1h'], {
      diagonalSupport: { detected: true, slope: 0.05, currentLevel: 99.2 },
      diagonalResistance: { detected: true, slope: 0.05, currentLevel: 102.8 },
      channel: { detected: true, upper: 102.8, lower: 99.2, slope: 'rising' }
    });
    const s = buildChartSpec(withChannel, { symbol: 'BTC', timeframe: '1h' }, series);
    const L = computeLayout(s);
    const b = await decode(await renderChart(s));
    const x = L.xOf(n - 1);
    const near = (y) => [y - 1, y, y + 1].some((yy) => pixelHex(b, x, yy) === CHART_COLORS.channel);
    assert(near(L.yOf(99.2)), 'lower channel line at its current level');
    assert(near(L.yOf(102.8)), 'upper channel line at its current level');
  });

  await test('1m/3m/5m draw candles + EMAs + candidate only (geometry ignored)', async () => {
    const onOneMinute = payloadFor('BTC', '1m', flat, {
      ema21: 103.2,
      geometry: { horizontalSupportZones: [{ low: 97.6, high: 98.2, side: 'support' }], horizontalResistanceZones: [] }
    });
    const s = buildChartSpec(onOneMinute, { symbol: 'BTC', timeframe: '1m' });
    assertEqual(s.geometry, null, 'geometry dropped for 1m');
    const L = computeLayout(s);
    const b = await decode(await renderChart(s));
    const x = gapX(L, 8);
    for (let y = 0; y < CHART_HEIGHT; y++) assert(pixelHex(b, x, y) !== CHART_COLORS.zoneSupport, `zone band pixel on 1m at row ${y}`);
  });

  console.log('\nbuildScalpContext chart hook + budgets');

  const bare = await buildFixtureContext();
  let captured1m;
  const with1m = await buildFixtureContext({ symbol: 'BTC', timeframe: '1m', onSeries: (s) => { captured1m = s; } });
  let captured4h;
  const with4h = await buildFixtureContext({ symbol: 'BTC', timeframe: '4h', onSeries: (s) => { captured4h = s; } });

  await test('the chart hook leaves the payload byte-identical', () => {
    assertEqual(JSON.stringify(with1m), JSON.stringify(bare), '1m hook');
    assertEqual(JSON.stringify(with4h), JSON.stringify(bare), '4h hook');
  });

  await test('the hook hands over EMA series aligned to the published window', () => {
    assertEqual(captured4h.ema21.length, CANDLE_LIMITS['4h'], '4h window length');
    assertEqual(captured1m.ema200.length, CANDLE_LIMITS['1m'], '1m window length');
    const tf = bare.symbols.BTC.timeframes['4h'];
    assertEqual(captured4h.ema21[captured4h.ema21.length - 1], tf.ema21, 'last EMA21 equals timeframes.4h.ema21');
    assertEqual(captured4h.ema200[captured4h.ema200.length - 1], tf.ema200, 'last EMA200 equals timeframes.4h.ema200');
  });

  const budgets = {};
  for (const [tf, captured] of [['1m', captured1m], ['4h', captured4h]]) {
    await test(`BTC:${tf} from a full build: PNG <= 150 KB, render <= 1.5 s`, async () => {
      const r = await renderContextChart(bare, { symbol: 'BTC', timeframe: tf }, captured);
      budgets[tf] = r;
      assertEqual(r.png.subarray(0, 4).toString('hex'), '89504e47', 'PNG magic');
      assert(r.bytes <= CHART_MAX_BYTES, `bytes ${r.bytes}`);
      assert(r.durationMs <= 1500, `durationMs ${r.durationMs}`);
    });
  }
  if (budgets['1m'] && budgets['4h']) {
    console.log(`    budgets: 1m ${budgets['1m'].bytes} B ${budgets['1m'].durationMs} ms, 4h ${budgets['4h'].bytes} B ${budgets['4h'].durationMs} ms`);
  }

  console.log('\nopenapi');

  await test('OpenAPI documents the chart param and an image/png response, ChatGPT-safe', () => {
    const yaml = readFileSync(new URL('./openapi/scalp-context.yaml', import.meta.url), 'utf8');
    assert(/\n {8}- name: chart\n {10}in: query\n {10}required: false/.test(yaml), 'chart query param');
    assert(/\n {12}image\/png:\n {14}schema:\n {16}type: string\n {16}format: binary/.test(yaml), 'image/png response');
    assert(/\n {8}"400":/.test(yaml), '400 response');
    assert(!/\b(oneOf|anyOf|allOf|not):/.test(yaml), 'no composition keywords');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
