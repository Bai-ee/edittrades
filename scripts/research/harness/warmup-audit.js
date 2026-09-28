/**
 * WP2 — indicator warm-up audit (Freqtrade `recursive-analysis` concept).
 *
 * Question: does the live engine compute different indicator values than research
 * because it only fetches a limited candle history?
 *
 * ---------------------------------------------------------------------------
 * Live trace (read-only; no live calls made by this file) — /api/scalp-context path:
 * ---------------------------------------------------------------------------
 *   services/scalpContext.js:112   const FETCH_LIMIT = 500;
 *   services/scalpContext.js:1218  await fetchCandles(task.pair, task.tf, FETCH_LIMIT, { now: safeNow });
 *     -- FETCH_LIMIT is ONE constant reused for every timeframe in TIMEFRAMES
 *        (1m,3m,5m,15m,1h,4h,1d). There is no per-timeframe override on this path.
 *   services/marketData.js:769     export async function getCandlesWithProvenance(symbol, interval, limit = 500, options = {})
 *     -- default matches FETCH_LIMIT; scalpContext always passes 500 explicitly anyway.
 *   services/marketData.js:166     async function fetchFromKraken(symbol, interval, limit = 500)
 *   services/marketData.js:~213    const candles = ohlcData.slice(-limit).map(...)
 *     -- Kraken's public OHLC endpoint returns up to ~720 raw points per call (no
 *        pagination used here); the code slices the LAST `limit` of those, so the
 *        effective live window is min(500, ~720) = 500 candles, for every timeframe,
 *        from 1m through 1d.
 *   services/scalpContext.js:1308  indicators = indicatorService.calculateAllIndicators(closed);
 *     -- `closed` = dropUnclosedCandles(rawCandles, tf, safeNow), rawCandles from the
 *        500-bar fetch above. This is the ONE call site for EMA21/EMA200/RSI/StochRSI
 *        on the live path.
 *   services/scalpContext.js:1316-1317  CANDLE_LIMITS[tf] (20 intraday / 10 daily) trims
 *        `closed` to `trimmed` for the PUBLISHED payload candles only, AFTER indicators
 *        are already computed on the full <=500-bar `closed` array. It does not affect
 *        indicator warm-up.
 *   services/scalpContext.js:1419,1572  buildGeometryContext({ candles: closed, ... })
 *   lib/geometry.js:53             export function atr(candles, n = ENGINE_CONFIG.geometry.atrPeriod)
 *   lib/advancedIndicators.js:98   export function calculateATR(candles, period = 14)
 *     -- config/engine.json:49,80 atrPeriod: 14. Same <=500-bar `closed` array as above.
 *   lib/advancedIndicators.js:14   export function calculateVWAP(candles, currentPrice, lookback)
 *     -- NOT called anywhere on the scalp-context/MCP path (only from api/indicators.js
 *        and api/analyze.js, separate non-MCP endpoints). VWAP is a windowed average,
 *        not a recursive filter, so "warm-up bias" does not apply to it the way it does
 *        to EMA/RSI/ATR — its value is a deliberate parameter (lookback), not an
 *        artifact of insufficient history. Included below for completeness only, and
 *        excluded from the decision-flip verdict.
 *
 * Indicator implementations exercised here (same functions the live path calls):
 *   services/indicators.js:16   calculateEMA21(prices)          -- EMA.calculate (technicalindicators), period 21
 *   services/indicators.js:32   calculateEMA200(prices)         -- EMA.calculate (technicalindicators), period 200
 *   services/indicators.js:49   calculateStochasticRSI(prices)  -- StochasticRSI.calculate, rsiPeriod 14/stochasticPeriod 14/k 3/d 3
 *   services/indicators.js:~168 (inline in calculateAllIndicators) RSI.calculate({ period: 14 })
 *     -- plain RSI has no separately exported function in services/indicators.js; it is
 *        inlined inside calculateAllIndicators (services/indicators.js:75), which is the
 *        single call scalpContext.js:1308 makes. This audit calls calculateAllIndicators
 *        directly (not the three sub-functions individually) so EMA21/EMA200/RSI/StochRSI
 *        are read from exactly the object the live path produces.
 *   lib/advancedIndicators.js:98  calculateATR(candles, 14)      -- hand-rolled Wilder smoothing
 *   lib/advancedIndicators.js:14  calculateVWAP(candles, currentPrice) -- reference only, see above
 *
 * ---------------------------------------------------------------------------
 * Method (Freqtrade `recursive-analysis` concept)
 * ---------------------------------------------------------------------------
 * For many sample points T per (symbol, timeframe), compute each indicator using only
 * the last W bars, W in TEST_WINDOWS (200, 300, 500, 1000, 2000 — 500 IS the live
 * limit), and compare against a long-history reference: as much prior history as the
 * fixture affords, capped at REFERENCE_CAP bars for performance (EMA200's seed-decay
 * factor (1 - 2/201)^n is already ~1e-20 by ~5800 bars past the seed, so a 6000-bar cap
 * is effectively "infinite history" for every indicator here). Report median/max % gap
 * per indicator x timeframe x window, and how often a decision-relevant state flips:
 * sign(close-EMA200), sign(close-EMA21), Stoch RSI condition, Stoch RSI K/D cross,
 * RSI zone, and (bonus) the engine's own UPTREND/DOWNTREND/FLAT trend label.
 *
 * Run: node scripts/research/harness/warmup-audit.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { calculateAllIndicators } from '../../../services/indicators.js';
import { calculateATR, calculateVWAP } from '../../../lib/advancedIndicators.js';

// services/scalpContext.js:112 (constant reused for every timeframe at :1218).
export const LIVE_FETCH_LIMIT = 500;

// Freqtrade sweeps {199,399,499,999,1999}; per WP2's instructions we use the actual
// live limit (500) plus 200/300/1000/2000.
export const TEST_WINDOWS = [200, 300, 500, 1000, 2000];

// Cap on the "long-history reference" window, for performance on the 5m/15m fixtures.
export const REFERENCE_CAP = 6000;
export const REFERENCE_FRACTION = 0.6;

/**
 * The reference window for a series of the given length: as much history as the
 * fixture affords (so a decent range of T remains samplable), capped at REFERENCE_CAP.
 * @param {number} seriesLength
 * @returns {number}
 */
export function referenceWindowFor(seriesLength) {
  return Math.max(1, Math.min(REFERENCE_CAP, Math.floor(seriesLength * REFERENCE_FRACTION)));
}

/**
 * Test windows that are strictly smaller than the reference window (a window that
 * isn't shorter than the reference isn't testing anything).
 * @param {number} referenceWindow
 * @returns {number[]}
 */
export function validWindowsFor(referenceWindow) {
  return TEST_WINDOWS.filter((w) => w < referenceWindow);
}

/**
 * Evenly spaced sample indices T in [referenceWindow-1, seriesLength-1].
 * @param {number} seriesLength
 * @param {number} referenceWindow
 * @param {number} [maxSamples=120]
 * @returns {number[]}
 */
export function sampleIndices(seriesLength, referenceWindow, maxSamples = 120) {
  const start = referenceWindow - 1;
  const end = seriesLength - 1;
  if (start >= end) return start === end ? [start] : [];
  const span = end - start;
  const count = Math.min(maxSamples, span + 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = start + Math.round((i * span) / Math.max(1, count - 1));
    if (out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

/** @param {number[]} values */
export function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}

/** @param {number[]} values */
export function max(values) {
  const arr = values.filter((v) => Number.isFinite(v));
  return arr.length === 0 ? null : Math.max(...arr);
}

/**
 * Relative % gap between a test value and the reference value.
 * @param {number} test
 * @param {number} ref
 */
export function pctGap(test, ref) {
  if (!Number.isFinite(test) || !Number.isFinite(ref)) return null;
  if (ref === 0) return test === 0 ? 0 : Infinity;
  return (Math.abs(test - ref) / Math.abs(ref)) * 100;
}

/** Absolute gap (used for 0-100-bounded oscillators, where a point difference reads better than %). */
export function absGap(test, ref) {
  if (!Number.isFinite(test) || !Number.isFinite(ref)) return null;
  return Math.abs(test - ref);
}

/**
 * RSI zone per the engine's own thresholds (services/indicators.js:283-284:
 * overbought: currentRSI > 70, oversold: currentRSI < 30).
 * @param {number} rsi
 */
export function rsiZone(rsi) {
  if (!Number.isFinite(rsi)) return null;
  if (rsi > 70) return 'OVERBOUGHT';
  if (rsi < 30) return 'OVERSOLD';
  return 'NEUTRAL';
}

/**
 * Compute the engine's indicator snapshot at the end of a candle slice.
 * @param {Array<Object>} candleSlice - closed candles, oldest first, ending at T
 * @returns {Object|null}
 */
export function computeIndicatorSnapshot(candleSlice) {
  if (!Array.isArray(candleSlice) || candleSlice.length === 0) return null;
  let ind;
  try {
    ind = calculateAllIndicators(candleSlice);
  } catch {
    return null;
  }
  const atrRes = calculateATR(candleSlice, 14);
  const close = candleSlice[candleSlice.length - 1].close;
  let vwap = null;
  try {
    vwap = calculateVWAP(candleSlice, close);
  } catch {
    vwap = null;
  }
  return {
    n: candleSlice.length,
    close,
    ema21: ind.ema ? ind.ema.ema21 : null,
    ema200: ind.ema ? ind.ema.ema200 : null,
    rsi: ind.rsi ? ind.rsi.value : null,
    stochK: ind.stochRSI ? ind.stochRSI.k : null,
    stochD: ind.stochRSI ? ind.stochRSI.d : null,
    stochCondition: ind.stochRSI ? ind.stochRSI.condition : null,
    trend: ind.analysis ? ind.analysis.trend : null,
    atr: atrRes ? atrRes.atr : null,
    atrPct: atrRes ? atrRes.atrPct : null,
    vwap: vwap ? vwap.value : null
  };
}

const NUMERIC_FIELDS = ['ema21', 'ema200', 'rsi', 'stochK', 'stochD', 'atr', 'vwap'];

function emptyFieldStats() {
  return { pct: [], abs: [] };
}

/**
 * Run the warm-up audit on one (symbol, timeframe) candle series.
 * @param {Array<Object>} candles - closed candles, oldest first, one symbol/timeframe
 * @param {Object} [opts]
 * @param {number} [opts.maxSamples=120]
 * @returns {Object}
 */
export function auditSeries(candles, opts = {}) {
  const { maxSamples = 120 } = opts;
  const seriesLength = candles.length;
  const referenceWindow = referenceWindowFor(seriesLength);
  const windows = validWindowsFor(referenceWindow);
  const skippedWindows = TEST_WINDOWS.filter((w) => !windows.includes(w));
  const samples = sampleIndices(seriesLength, referenceWindow, maxSamples);

  const perWindow = {};
  for (const w of windows) {
    perWindow[w] = {
      fields: Object.fromEntries(NUMERIC_FIELDS.map((f) => [f, emptyFieldStats()])),
      flips: { ema200Sign: 0, ema21Sign: 0, stochCondition: 0, stochCross: 0, rsiZone: 0, trend: 0 },
      n: 0
    };
  }

  let usedSamples = 0;
  for (const T of samples) {
    const refSlice = candles.slice(Math.max(0, T - referenceWindow + 1), T + 1);
    const ref = computeIndicatorSnapshot(refSlice);
    if (!ref) continue;
    usedSamples++;

    const refEma200Sign = Number.isFinite(ref.ema200) ? Math.sign(ref.close - ref.ema200) || 1 : null;
    const refEma21Sign = Number.isFinite(ref.ema21) ? Math.sign(ref.close - ref.ema21) || 1 : null;
    const refStochCross = Number.isFinite(ref.stochK) && Number.isFinite(ref.stochD)
      ? Math.sign(ref.stochK - ref.stochD) || 1
      : null;
    const refRsiZone = rsiZone(ref.rsi);

    for (const w of windows) {
      const slice = candles.slice(Math.max(0, T - w + 1), T + 1);
      const test = computeIndicatorSnapshot(slice);
      const bucket = perWindow[w];
      if (!test) continue;
      bucket.n++;

      for (const field of NUMERIC_FIELDS) {
        const p = pctGap(test[field], ref[field]);
        const a = absGap(test[field], ref[field]);
        if (p !== null && Number.isFinite(p)) bucket.fields[field].pct.push(p);
        if (a !== null) bucket.fields[field].abs.push(a);
      }

      if (refEma200Sign !== null && Number.isFinite(test.ema200)) {
        const s = Math.sign(test.close - test.ema200) || 1;
        if (s !== refEma200Sign) bucket.flips.ema200Sign++;
      }
      if (refEma21Sign !== null && Number.isFinite(test.ema21)) {
        const s = Math.sign(test.close - test.ema21) || 1;
        if (s !== refEma21Sign) bucket.flips.ema21Sign++;
      }
      if (test.stochCondition && ref.stochCondition && test.stochCondition !== ref.stochCondition) {
        bucket.flips.stochCondition++;
      }
      if (refStochCross !== null && Number.isFinite(test.stochK) && Number.isFinite(test.stochD)) {
        const s = Math.sign(test.stochK - test.stochD) || 1;
        if (s !== refStochCross) bucket.flips.stochCross++;
      }
      const testRsiZone = rsiZone(test.rsi);
      if (refRsiZone !== null && testRsiZone !== null && testRsiZone !== refRsiZone) {
        bucket.flips.rsiZone++;
      }
      if (test.trend && ref.trend && test.trend !== ref.trend) {
        bucket.flips.trend++;
      }
    }
  }

  const summary = {};
  for (const w of windows) {
    const bucket = perWindow[w];
    const fields = {};
    for (const field of NUMERIC_FIELDS) {
      fields[field] = {
        medianPctGap: median(bucket.fields[field].pct),
        maxPctGap: max(bucket.fields[field].pct),
        medianAbsGap: median(bucket.fields[field].abs),
        maxAbsGap: max(bucket.fields[field].abs)
      };
    }
    const n = bucket.n || 1;
    summary[w] = {
      n: bucket.n,
      fields,
      flipRatePct: {
        ema200Sign: (bucket.flips.ema200Sign / n) * 100,
        ema21Sign: (bucket.flips.ema21Sign / n) * 100,
        stochCondition: (bucket.flips.stochCondition / n) * 100,
        stochCross: (bucket.flips.stochCross / n) * 100,
        rsiZone: (bucket.flips.rsiZone / n) * 100,
        trend: (bucket.flips.trend / n) * 100
      }
    };
  }

  return {
    seriesLength,
    referenceWindow,
    windows,
    skippedWindows,
    sampleCount: usedSamples,
    summary
  };
}

/**
 * Load a captured-candle fixture (shape: { symbol, timeframe, provider, capturedAt, candles }).
 * @param {string} filePath
 * @returns {Array<Object>}
 */
export function loadFixture(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const candles = Array.isArray(raw) ? raw : raw.candles;
  if (!Array.isArray(candles)) throw new Error(`${filePath}: no candles array`);
  return candles;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
  const FIXTURES = [
    { symbol: 'BTC', tf: '4h', file: 'var/edge/4h-long/BTC_4h.json' },
    { symbol: 'ETH', tf: '4h', file: 'var/edge/4h-long/ETH_4h.json' },
    { symbol: 'SOL', tf: '4h', file: 'var/edge/4h-long/SOL_4h.json' },
    { symbol: 'BTC', tf: '1d', file: 'var/edge/daily-long/BTC_1d.json' },
    { symbol: 'ETH', tf: '1d', file: 'var/edge/daily-long/ETH_1d.json' },
    { symbol: 'SOL', tf: '1d', file: 'var/edge/daily-long/SOL_1d.json' },
    { symbol: 'BTC', tf: '5m', file: 'test/fixtures/history/deep2y-2026-09-26/BTC_5m.json' },
    { symbol: 'ETH', tf: '5m', file: 'test/fixtures/history/deep2y-2026-09-26/ETH_5m.json' },
    { symbol: 'SOL', tf: '5m', file: 'test/fixtures/history/deep2y-2026-09-26/SOL_5m.json' },
    { symbol: 'BTC', tf: '15m', file: 'test/fixtures/history/deep2y-2026-09-26/BTC_15m.json' },
    { symbol: 'ETH', tf: '15m', file: 'test/fixtures/history/deep2y-2026-09-26/ETH_15m.json' },
    { symbol: 'SOL', tf: '15m', file: 'test/fixtures/history/deep2y-2026-09-26/SOL_15m.json' },
    { symbol: 'BTC', tf: '1h', file: 'test/fixtures/history/deep2y-2026-09-26/BTC_1h.json' },
    { symbol: 'ETH', tf: '1h', file: 'test/fixtures/history/deep2y-2026-09-26/ETH_1h.json' },
    { symbol: 'SOL', tf: '1h', file: 'test/fixtures/history/deep2y-2026-09-26/SOL_1h.json' }
  ];

  const results = [];
  for (const fx of FIXTURES) {
    const candles = loadFixture(path.join(repoRoot, fx.file));
    const result = auditSeries(candles);
    results.push({ symbol: fx.symbol, tf: fx.tf, ...result });
    console.log(`\n${fx.symbol}/${fx.tf}  (n=${candles.length}, reference=${result.referenceWindow}, samples=${result.sampleCount}${result.skippedWindows.length ? `, skipped W=[${result.skippedWindows.join(',')}] (insufficient history)` : ''})`);
    console.log('  W     ema21%med/max   ema200%med/max   rsi-pt med/max   stochK-pt med/max   atr%med/max   flips% e200/e21/stochCond/stochX/rsiZ/trend');
    for (const w of result.windows) {
      const s = result.summary[w];
      const f = s.fields;
      const fmt = (v) => (v === null ? 'n/a' : v.toFixed(2));
      console.log(
        `  ${String(w).padEnd(5)} ${fmt(f.ema21.medianPctGap)}/${fmt(f.ema21.maxPctGap)}` +
        `   ${fmt(f.ema200.medianPctGap)}/${fmt(f.ema200.maxPctGap)}` +
        `   ${fmt(f.rsi.medianAbsGap)}/${fmt(f.rsi.maxAbsGap)}` +
        `   ${fmt(f.stochK.medianAbsGap)}/${fmt(f.stochK.maxAbsGap)}` +
        `   ${fmt(f.atr.medianPctGap)}/${fmt(f.atr.maxPctGap)}` +
        `   ${fmt(s.flipRatePct.ema200Sign)}/${fmt(s.flipRatePct.ema21Sign)}/${fmt(s.flipRatePct.stochCondition)}/${fmt(s.flipRatePct.stochCross)}/${fmt(s.flipRatePct.rsiZone)}/${fmt(s.flipRatePct.trend)}`
      );
    }
  }

  const outDir = path.join(repoRoot, 'var/research/wp2');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'warmup-audit-results.json');
  writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), liveFetchLimit: LIVE_FETCH_LIMIT, testWindows: TEST_WINDOWS, referenceCap: REFERENCE_CAP, results }, null, 2));
  console.log(`\nWrote ${outFile}`);
}
