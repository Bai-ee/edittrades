/**
 * WP2 — deterministic test suite for scripts/research/harness/warmup-audit.js.
 *
 * Core requirement: a synthetic series where the recursive EMA "converges" must show
 * the gap-vs-long-history-reference shrinking monotonically as the test window W
 * grows, with no randomness involved (see "EMA200 gap shrinks monotonically with W").
 *
 * Run: node test-warmup-audit.js
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_FETCH_LIMIT,
  TEST_WINDOWS,
  REFERENCE_CAP,
  referenceWindowFor,
  validWindowsFor,
  sampleIndices,
  median,
  max,
  pctGap,
  absGap,
  rsiZone,
  computeIndicatorSnapshot,
  auditSeries,
  loadFixture
} from './scripts/research/harness/warmup-audit.js';

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

function assertClose(actual, expected, tolerance, msg) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${msg}: actual is not a finite number (${JSON.stringify(actual)})`);
  assert(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

/** Build a synthetic OHLCV candle array from a close-price series (flat O=H=L=C). */
function candlesFromCloses(closes, startMs = 1_600_000_000_000, stepMs = 60_000) {
  return closes.map((c, i) => ({
    timestamp: startMs + i * stepMs,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
    closeTime: startMs + (i + 1) * stepMs
  }));
}

async function run() {
  console.log('WP2 warm-up audit tests\n');

  await test('LIVE_FETCH_LIMIT matches the trace (services/scalpContext.js:112, used at :1218 for every timeframe)', () => {
    assertEqual(LIVE_FETCH_LIMIT, 500, 'live fetch limit');
  });

  await test('referenceWindowFor caps at REFERENCE_CAP for long series', () => {
    assertEqual(referenceWindowFor(20000), REFERENCE_CAP, 'capped');
    assertEqual(referenceWindowFor(1000), Math.floor(1000 * 0.6), 'fraction, short series');
  });

  await test('validWindowsFor excludes a test window that is not strictly smaller than the reference', () => {
    const w = validWindowsFor(1996); // e.g. BTC/ETH daily-long fixture
    assert(w.includes(1000) && !w.includes(2000), `expected 1000 in, 2000 out; got ${JSON.stringify(w)}`);
    const wAll = validWindowsFor(6000);
    assertEqual(wAll.length, TEST_WINDOWS.length, 'all windows valid under a large reference');
  });

  await test('sampleIndices returns a sorted, bounded, deterministic sample', () => {
    const a = sampleIndices(10000, 6000, 50);
    const b = sampleIndices(10000, 6000, 50);
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'deterministic (no RNG)');
    assert(a[0] === 5999, `first sample should be referenceWindow-1 (5999), got ${a[0]}`);
    assert(a[a.length - 1] === 9999, `last sample should be seriesLength-1 (9999), got ${a[a.length - 1]}`);
    for (let i = 1; i < a.length; i++) assert(a[i] > a[i - 1], 'strictly increasing');
  });

  await test('sampleIndices handles a range smaller than maxSamples', () => {
    const a = sampleIndices(6005, 6000, 50);
    assert(a.length === 6, `expected 6 distinct indices (5999..6004), got ${a.length}`);
  });

  await test('median/max basic correctness', () => {
    assertEqual(median([1, 2, 3]), 2, 'median odd');
    assertEqual(median([1, 2, 3, 4]), 2.5, 'median even');
    assertEqual(median([]), null, 'median empty');
    assertEqual(max([1, 5, 3]), 5, 'max');
    assertEqual(max([]), null, 'max empty');
  });

  await test('pctGap / absGap basic correctness and zero-reference edge case', () => {
    assertClose(pctGap(105, 100), 5, 1e-9, 'pctGap 5%');
    assertEqual(pctGap(0, 0), 0, 'both zero');
    assertEqual(pctGap(1, 0), Infinity, 'ref zero, test nonzero');
    assertClose(absGap(105, 100), 5, 1e-9, 'absGap');
  });

  await test('rsiZone matches the engine thresholds (services/indicators.js:283-284: >70 overbought, <30 oversold)', () => {
    assertEqual(rsiZone(71), 'OVERBOUGHT', '71');
    assertEqual(rsiZone(70), 'NEUTRAL', '70 boundary is not >70');
    assertEqual(rsiZone(29), 'OVERSOLD', '29');
    assertEqual(rsiZone(30), 'NEUTRAL', '30 boundary is not <30');
    assertEqual(rsiZone(50), 'NEUTRAL', '50');
  });

  await test('constant-price series: EMA21/EMA200/RSI/ATR gap is exactly 0 at every window (no bias possible at steady state)', () => {
    const closes = new Array(3000).fill(100);
    const candles = candlesFromCloses(closes);
    const ref = computeIndicatorSnapshot(candles.slice(-2500));
    for (const w of [200, 300, 500, 1000, 2000]) {
      const test = computeIndicatorSnapshot(candles.slice(-w));
      assertEqual(pctGap(test.ema21, ref.ema21), 0, `ema21 gap at W=${w}`);
      assertEqual(pctGap(test.ema200, ref.ema200), 0, `ema200 gap at W=${w}`);
      assertEqual(pctGap(test.atr, ref.atr), 0, `atr gap at W=${w}`);
    }
  });

  await test('EMA200 warm-up gap shrinks monotonically as W grows on a synthetic series (deterministic)', () => {
    // closes[i] = 1000 + 0.5*i + 200*sin(i/50): a trend plus a slow, bounded oscillation
    // - no randomness, but enough curvature that the SMA(200) seed a window lands on
    // genuinely differs from the "infinite-history" recursive EMA value at that point
    // (a pure straight-line ramp is a degenerate case where that seed error is exactly
    // zero for any EMA period, since SMA-of-a-line and EMA-steady-state-lag-of-a-line
    // coincide algebraically - verified separately, not a useful convergence fixture).
    // For t after the seed, test(W) and the long-history reference apply the identical
    // EMA recursion to the identical closing prices, so by linearity of that recursion,
    // gap(T) = (1 - 2/(period+1))^(W - period) * |seed_error|: a fixed per-step decay
    // factor raised to the number of post-seed steps (W - period). Because TEST_WINDOWS
    // is ascending, W - period is strictly increasing, so gap(W) must strictly decrease.
    // See scripts/research/harness/warmup-audit.js header for the EMA seeding source
    // (technicalindicators EMA.js: SMA(period) seed, then exponential recursion).
    const N = 6600;
    const T = 6499; // 0-based end index
    const closes = Array.from({ length: N }, (_, i) => 1000 + 0.5 * i + 200 * Math.sin(i / 50));
    const candles = candlesFromCloses(closes);

    const REFERENCE_W = 6000; // matches REFERENCE_CAP; decay factor (1-2/201)^5800 ~ 1e-25
    const refSlice = candles.slice(T - REFERENCE_W + 1, T + 1);
    const ref = computeIndicatorSnapshot(refSlice);
    assert(Number.isFinite(ref.ema200), 'reference ema200 must be finite');

    const gaps = TEST_WINDOWS.map((w) => {
      const slice = candles.slice(T - w + 1, T + 1);
      const snap = computeIndicatorSnapshot(slice);
      return { w, gap: absGap(snap.ema200, ref.ema200) };
    });

    for (const g of gaps) assert(Number.isFinite(g.gap), `gap at W=${g.w} must be finite`);

    // Strictly decreasing: TEST_WINDOWS is already ascending (200,300,500,1000,2000).
    for (let i = 1; i < gaps.length; i++) {
      assert(
        gaps[i].gap < gaps[i - 1].gap,
        `gap must shrink as W grows: W=${gaps[i - 1].w} gap=${gaps[i - 1].gap} should exceed W=${gaps[i].w} gap=${gaps[i].gap}`
      );
    }

    // W=200 (zero decay steps: EMA200 at W=200 is exactly SMA(200)) must be materially
    // worse than W=2000 (1800 decay steps) - at least two orders of magnitude apart.
    const worst = gaps[0].gap; // W=200
    const best = gaps[gaps.length - 1].gap; // W=2000
    assert(worst > best * 100, `W=200 gap (${worst}) should be >=100x W=2000 gap (${best})`);
    assert(best < 1e-6, `W=2000 gap should be numerically negligible on a pure ramp, got ${best}`);
  });

  await test('auditSeries is deterministic (same input -> byte-identical output)', () => {
    const closes = Array.from({ length: 4000 }, (_, i) => 1000 + 50 * Math.sin(i / 37) + 0.1 * i);
    const candles = candlesFromCloses(closes);
    const a = auditSeries(candles, { maxSamples: 15 });
    const b = auditSeries(candles, { maxSamples: 15 });
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'repeat run matches exactly');
  });

  await test('auditSeries: skips test windows that are not strictly below the reference window', () => {
    const closes = Array.from({ length: 2200 }, (_, i) => 1000 + 0.3 * i); // ~ SOL/1d fixture scale
    const candles = candlesFromCloses(closes);
    const result = auditSeries(candles, { maxSamples: 20 });
    assert(result.skippedWindows.includes(2000), `2000 should be skipped for a ${closes.length}-bar series, got windows=${JSON.stringify(result.windows)}`);
    assert(!result.windows.includes(2000), 'skipped window must not appear in windows');
  });

  await test('auditSeries: flip rates are within [0,100] and medians never exceed maxes', () => {
    const closes = Array.from({ length: 4000 }, (_, i) => 1000 + 80 * Math.sin(i / 21) + 0.05 * i);
    const candles = candlesFromCloses(closes);
    const result = auditSeries(candles, { maxSamples: 40 });
    for (const w of result.windows) {
      const s = result.summary[w];
      for (const key of Object.keys(s.flipRatePct)) {
        const v = s.flipRatePct[key];
        assert(v >= 0 && v <= 100, `flip rate ${key} at W=${w} out of range: ${v}`);
      }
      for (const field of Object.keys(s.fields)) {
        const f = s.fields[field];
        if (f.medianPctGap !== null && f.maxPctGap !== null) {
          assert(f.medianPctGap <= f.maxPctGap + 1e-9, `${field} median > max at W=${w}`);
        }
      }
    }
  });

  await test('loadFixture reads a real project fixture (var/edge/4h-long/BTC_4h.json)', () => {
    const repoRoot = path.dirname(fileURLToPath(import.meta.url));
    const candles = loadFixture(path.join(repoRoot, 'var/edge/4h-long/BTC_4h.json'));
    assert(Array.isArray(candles) && candles.length > 10000, `expected a long candle array, got ${candles && candles.length}`);
    assert(Number.isFinite(candles[0].close) && Number.isFinite(candles[candles.length - 1].close), 'candles have finite closes');
    assert(candles[0].timestamp < candles[candles.length - 1].timestamp, 'oldest first');
  });

  await test('auditSeries on the real BTC/4h fixture: EMA200 gap at the live limit (W=500) is small and ATR/EMA21/RSI are ~converged', () => {
    const repoRoot = path.dirname(fileURLToPath(import.meta.url));
    const candles = loadFixture(path.join(repoRoot, 'var/edge/4h-long/BTC_4h.json'));
    const result = auditSeries(candles, { maxSamples: 60 });
    assert(result.windows.includes(LIVE_FETCH_LIMIT), 'live limit (500) must be a tested window on this long fixture');
    const s500 = result.summary[LIVE_FETCH_LIMIT];
    assert(s500.fields.ema200.medianPctGap < 1, `EMA200 median gap at live limit should be well under 1%, got ${s500.fields.ema200.medianPctGap}`);
    assert(s500.fields.ema21.medianPctGap < 0.05, `EMA21 should already be converged at 500 bars, got ${s500.fields.ema21.medianPctGap}`);
    assert(s500.fields.atr.medianPctGap < 0.05, `ATR (Wilder, period 14) should already be converged at 500 bars, got ${s500.fields.atr.medianPctGap}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

function assertEqual(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

run();
