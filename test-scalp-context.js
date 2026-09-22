/**
 * Deterministic, zero-dependency test suite for:
 *   - services/scalpContext.js
 *   - lib/structure.js
 *   - services/marketData.js provenance path (derived 3m, no synthetic in the connector)
 *
 * No network calls. All fixtures are synthetic and generated with a seeded
 * PRNG so runs are reproducible.
 *
 * Run: node test-scalp-context.js
 *
 * Interpretation notes (confirmed against the actual implementation once it
 * landed, documented here for anyone reconciling a failure):
 *   - Internal candle shape (input to dropUnclosedCandles/buildStructure,
 *     and returned by an injected fetchCandles) matches this repo's
 *     existing convention (see services/binance.js#fetchKlines):
 *       { timestamp, open, high, low, close, volume, closeTime }
 *   - deriveStochRsi(history) takes an array of already-computed
 *     Stochastic RSI points, i.e. Array<{ k: number, d: number }>
 *     (see the JSDoc directly above deriveStochRsi in
 *     services/scalpContext.js) - NOT raw prices and NOT candle objects.
 *   - findSwings(candles, lookback) returns { swingHighs, swingLows }
 *     (each an array of { price, timestamp }), not a flat array.
 *   - buildStructure's `support`/`resistance` composition is unspecified;
 *     tests only assert the documented invariants (side-of-price + sort
 *     order), not exact membership.
 */

import {
  SYMBOLS,
  TIMEFRAMES,
  CANDLE_LIMITS,
  INTERVAL_MS,
  dropUnclosedCandles,
  deriveStochRsi,
  normalizeJson,
  buildScalpContext,
  classifyRejection,
  buildStrategyTrace,
  buildTimeframeWindow,
  buildDecisionTrace,
  attachRisk,
  filterPayload,
  buildConfigSnapshot,
  filterFailedCandidateSetups,
  INCLUDE_TOKENS
} from './services/scalpContext.js';

import { findSwings, buildStructure } from './lib/structure.js';

import { ENGINE_CONFIG } from './config/engine.js';

import { evaluateAllStrategies } from './services/strategy.js';

import {
  aggregateToBuckets,
  getCandlesWithProvenance,
  DERIVED_INTERVALS,
  KRAKEN_NATIVE_INTERVALS
} from './services/marketData.js';

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, error: err });
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
    throw new Error(msg || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------

function toList(x) {
  if (Array.isArray(x)) return x;
  if (x instanceof Set) return [...x];
  if (x instanceof Map) return [...x.keys()];
  if (x && typeof x === 'object') return Object.keys(x);
  return [];
}

function lookup(mapLike, key) {
  if (mapLike instanceof Map) return mapLike.get(key);
  if (mapLike && typeof mapLike === 'object') return mapLike[key];
  return undefined;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function isSortedDesc(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[i - 1]) return false;
  return true;
}

function isSortedAsc(arr) {
  for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) return false;
  return true;
}

function deepEqual(a, b) {
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!a || !b || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(a[k], b[k]));
}

const NOW = Date.UTC(2024, 0, 16, 12, 0, 0); // fixed epoch, deterministic across runs

// ---------------------------------------------------------------------------
// Candle fixture generator (internal candle shape: timestamp/open/high/low/
// close/volume/closeTime), producing realistic, plausibly-priced OHLCV with
// closeTime = timestamp + intervalMs, on increasing, interval-aligned steps.
// ---------------------------------------------------------------------------

function makeCandles(interval, count, options = {}) {
  const stepMs = lookup(INTERVAL_MS, interval);
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new Error(`INTERVAL_MS has no valid entry for interval "${interval}"`);
  }

  const {
    now = NOW,
    basePrice = 100,
    drift = 0.00015,
    volAmplitude = 0.004,
    seed = 42,
    includeForming = true
  } = options;

  const rand = mulberry32(seed);
  const alignedNow = Math.floor(now / stepMs) * stepMs;
  const lastClosedOpen = alignedNow - stepMs;
  const firstOpen = lastClosedOpen - (count - 1) * stepMs;
  const totalCount = count + (includeForming ? 1 : 0);

  const candles = [];
  let price = basePrice;

  for (let i = 0; i < totalCount; i++) {
    const timestamp = firstOpen + i * stepMs;
    const open = price;
    const noise = (rand() - 0.5) * 2 * volAmplitude;
    const trendMove = drift * open;
    const close = Math.max(0.01, open + trendMove + noise * open);
    const high = Math.max(open, close) * (1 + rand() * volAmplitude * 0.5);
    const low = Math.min(open, close) * (1 - rand() * volAmplitude * 0.5);
    const volume = 100 + rand() * 50;

    candles.push({
      timestamp,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: round(volume),
      closeTime: timestamp + stepMs
    });

    price = close;
  }

  return candles;
}

// Deterministic "known extremes" day of intraday candles: every candle stays
// strictly within (spikeLowValue, spikeHighValue) except the two designated
// spike indices, guaranteeing the day's true max/min equal the spike values.
function buildKnownRangeCandles({ dayStartMs, count, stepMs, baseline, spikeHighIndex, spikeHighValue, spikeLowIndex, spikeLowValue, seed }) {
  const rand = mulberry32(seed);
  const candles = [];

  for (let i = 0; i < count; i++) {
    const timestamp = dayStartMs + i * stepMs;
    let open = baseline + (rand() - 0.5) * 4;
    let close = baseline + (rand() - 0.5) * 4;
    let high = Math.max(open, close) + 1 + rand() * 2;
    let low = Math.min(open, close) - 1 - rand() * 2;

    if (i === spikeHighIndex) {
      high = spikeHighValue;
      open = Math.min(open, high - 1);
      close = Math.min(close, high - 0.5);
    } else {
      high = Math.min(high, spikeHighValue - 0.5);
    }

    if (i === spikeLowIndex) {
      low = spikeLowValue;
      open = Math.max(open, low + 1);
      close = Math.max(close, low + 0.5);
    } else {
      low = Math.max(low, spikeLowValue + 0.5);
    }

    high = Math.max(high, open, close);
    low = Math.min(low, open, close);

    candles.push({
      timestamp,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: round(50 + rand() * 10),
      closeTime: timestamp + stepMs
    });
  }

  return candles;
}

function aggregateCandles(candles, groupSize) {
  const out = [];
  for (let i = 0; i + groupSize <= candles.length; i += groupSize) {
    const group = candles.slice(i, i + groupSize);
    out.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: round(group.reduce((s, c) => s + c.volume, 0)),
      closeTime: group[group.length - 1].closeTime
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// deriveStochRsi fixture helper: history is Array<{k:number,d:number}> of
// already-computed Stochastic RSI points (see services/scalpContext.js).
// ---------------------------------------------------------------------------

function stochHistory(pairs) {
  return pairs.map(([k, d]) => ({ k, d }));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Running test-scalp-context.js\n');

  console.log('module exports');
  await test('services/scalpContext.js exposes the pinned contract', () => {
    assert(typeof dropUnclosedCandles === 'function', 'dropUnclosedCandles missing/not a function');
    assert(typeof deriveStochRsi === 'function', 'deriveStochRsi missing/not a function');
    assert(typeof normalizeJson === 'function', 'normalizeJson missing/not a function');
    assert(typeof buildScalpContext === 'function', 'buildScalpContext missing/not a function');
    assert(SYMBOLS !== undefined, 'SYMBOLS missing');
    assert(TIMEFRAMES !== undefined, 'TIMEFRAMES missing');
    assert(CANDLE_LIMITS !== undefined, 'CANDLE_LIMITS missing');
    assert(INTERVAL_MS !== undefined, 'INTERVAL_MS missing');
    assert(toList(TIMEFRAMES).length > 0, 'TIMEFRAMES is empty');
  });

  await test('lib/structure.js exposes the pinned contract', () => {
    assert(typeof findSwings === 'function', 'findSwings missing/not a function');
    assert(typeof buildStructure === 'function', 'buildStructure missing/not a function');
  });

  const timeframesList = toList(TIMEFRAMES);
  const unitInterval = timeframesList.includes('15m') ? '15m' : (timeframesList.includes('1h') ? '1h' : timeframesList[0]);

  // -------------------------------------------------------------------------
  // 1) Closed-candle filtering
  // -------------------------------------------------------------------------
  console.log('\n1) closed-candle filtering (dropUnclosedCandles)');

  await test('drops exactly the still-forming last candle', () => {
    const candles = makeCandles(unitInterval, 12, { now: NOW, includeForming: true, seed: 11 });
    const before = structuredClone(candles);
    const result = dropUnclosedCandles(candles, unitInterval, NOW);

    assert(Array.isArray(result), 'result is not an array');
    assertEqual(result.length, 12, `expected 12 closed candles, got ${result.length}`);
    assertEqual(result[result.length - 1].timestamp, candles[candles.length - 2].timestamp, 'last kept candle should be the second-to-last input candle');
    assert(deepEqual(candles, before), 'input array was mutated');
  });

  await test('keeps a candle whose closeTime === now', () => {
    const stepMs = lookup(INTERVAL_MS, unitInterval);
    const alignedNow = Math.floor(NOW / stepMs) * stepMs;
    const c1 = { timestamp: alignedNow - 2 * stepMs, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closeTime: alignedNow - stepMs };
    const c2 = { timestamp: alignedNow - stepMs, open: 1.5, high: 2.5, low: 1, close: 2, volume: 12, closeTime: alignedNow };
    const result = dropUnclosedCandles([c1, c2], unitInterval, alignedNow);
    assertEqual(result.length, 2, `expected both candles kept when closeTime === now, got ${result.length}`);
  });

  await test('drops garbage entries (NaN close, missing fields) while keeping valid ones', () => {
    const stepMs = lookup(INTERVAL_MS, unitInterval);
    const alignedNow = Math.floor(NOW / stepMs) * stepMs;
    const good1 = { timestamp: alignedNow - 4 * stepMs, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closeTime: alignedNow - 3 * stepMs };
    const nanClose = { timestamp: alignedNow - 3 * stepMs, open: 1, high: 2, low: 0.5, close: NaN, volume: 10, closeTime: alignedNow - 2 * stepMs };
    const missingFields = { timestamp: alignedNow - 2 * stepMs, open: 1, close: 1.2, closeTime: alignedNow - stepMs };
    const good2 = { timestamp: alignedNow - stepMs, open: 1.2, high: 2.2, low: 0.9, close: 1.8, volume: 9, closeTime: alignedNow };

    const candles = [good1, nanClose, missingFields, good2];
    const result = dropUnclosedCandles(candles, unitInterval, alignedNow);

    assertEqual(result.length, 2, `expected only the 2 valid closed candles to survive, got ${result.length}: ${JSON.stringify(result)}`);
    assert(result.every((c) => Number.isFinite(c.close)), 'a surviving candle has a non-finite close');
    assert(result.every((c) => Number.isFinite(c.high) && Number.isFinite(c.low)), 'a surviving candle is missing high/low');
  });

  // -------------------------------------------------------------------------
  // 2) Stoch RSI derivation
  // -------------------------------------------------------------------------
  console.log('\n2) Stoch RSI derivation (deriveStochRsi)');

  await test('null-safe on null and [] (all fields null)', () => {
    for (const input of [null, []]) {
      const result = deriveStochRsi(input);
      assert(result && typeof result === 'object', `deriveStochRsi(${JSON.stringify(input)}) did not return an object`);
      for (const key of ['k', 'd', 'state', 'cross', 'slopeK', 'slopeD']) {
        assertEqual(result[key], null, `expected ${key} to be null for ${JSON.stringify(input)}, got ${JSON.stringify(result[key])}`);
      }
    }
  });

  await test('null-safe on a 1-element history (k/d/state computed, cross/slope null - insufficient history)', () => {
    const result = deriveStochRsi(stochHistory([[55, 45]]));
    assertEqual(result.k, 55);
    assertEqual(result.d, 45);
    assertEqual(result.state, 'BULLISH', `expected BULLISH from a single point, got ${result.state}`);
    assertEqual(result.cross, null, 'cross should be null with only 1 point of history');
    assertEqual(result.slopeK, null, 'slopeK should be null with only 1 point of history');
    assertEqual(result.slopeD, null, 'slopeD should be null with only 1 point of history');
  });

  await test('OVERBOUGHT fixture (k>80 and d>80) yields state OVERBOUGHT', () => {
    const result = deriveStochRsi(stochHistory([[70, 72], [90, 85]]));
    assertEqual(result.state, 'OVERBOUGHT', `expected OVERBOUGHT, got ${result.state}`);
  });

  await test('OVERSOLD fixture (k<20 and d<20) yields state OVERSOLD', () => {
    const result = deriveStochRsi(stochHistory([[30, 28], [10, 15]]));
    assertEqual(result.state, 'OVERSOLD', `expected OVERSOLD, got ${result.state}`);
  });

  await test('BULLISH fixture (k > d, mid-range) yields state BULLISH', () => {
    const result = deriveStochRsi(stochHistory([[45, 55], [60, 40]]));
    assertEqual(result.state, 'BULLISH', `expected BULLISH, got ${result.state}`);
  });

  await test('BEARISH fixture (k < d, mid-range) yields state BEARISH', () => {
    const result = deriveStochRsi(stochHistory([[55, 45], [40, 60]]));
    assertEqual(result.state, 'BEARISH', `expected BEARISH, got ${result.state}`);
  });

  await test('NEUTRAL fixture (k === d) yields state NEUTRAL', () => {
    const result = deriveStochRsi(stochHistory([[48, 52], [50, 50]]));
    assertEqual(result.state, 'NEUTRAL', `expected NEUTRAL, got ${result.state}`);
  });

  await test('BULLISH_CROSS fixture (k crosses above d) yields cross BULLISH_CROSS and correct slopes', () => {
    const result = deriveStochRsi(stochHistory([[40, 50], [60, 50]]));
    assertEqual(result.cross, 'BULLISH_CROSS', `expected BULLISH_CROSS, got ${result.cross}`);
    assertEqual(result.slopeK, 20, `expected slopeK=20, got ${result.slopeK}`);
    assertEqual(result.slopeD, 0, `expected slopeD=0, got ${result.slopeD}`);
  });

  await test('BEARISH_CROSS fixture (k crosses below d) yields cross BEARISH_CROSS and correct slopes', () => {
    const result = deriveStochRsi(stochHistory([[60, 50], [40, 50]]));
    assertEqual(result.cross, 'BEARISH_CROSS', `expected BEARISH_CROSS, got ${result.cross}`);
    assertEqual(result.slopeK, -20, `expected slopeK=-20, got ${result.slopeK}`);
    assertEqual(result.slopeD, 0, `expected slopeD=0, got ${result.slopeD}`);
  });

  await test('NONE fixture (sustained, no crossing) yields cross NONE', () => {
    const result = deriveStochRsi(stochHistory([[60, 40], [65, 45]]));
    assertEqual(result.cross, 'NONE', `expected NONE, got ${result.cross}`);
    assertEqual(result.slopeK, 5, `expected slopeK=5, got ${result.slopeK}`);
    assertEqual(result.slopeD, 5, `expected slopeD=5, got ${result.slopeD}`);
  });

  // -------------------------------------------------------------------------
  // 3) Structure (lib/structure.js)
  // -------------------------------------------------------------------------
  console.log('\n3) structure (findSwings / buildStructure)');

  const STEP_15M = 15 * 60 * 1000;
  const DAY_PREV_START = Date.UTC(2024, 0, 15, 0, 0, 0);
  const DAY_CUR_START = Date.UTC(2024, 0, 16, 0, 0, 0);

  const prevDay15m = buildKnownRangeCandles({
    dayStartMs: DAY_PREV_START,
    count: 96,
    stepMs: STEP_15M,
    baseline: 95,
    spikeHighIndex: 40,
    spikeHighValue: 105,
    spikeLowIndex: 70,
    spikeLowValue: 85,
    seed: 101
  });

  const curDay15mSoFar = buildKnownRangeCandles({
    dayStartMs: DAY_CUR_START,
    count: 48, // 00:00 -> 12:00 UTC, matches NOW
    stepMs: STEP_15M,
    baseline: 101,
    spikeHighIndex: 20,
    spikeHighValue: 112,
    spikeLowIndex: 10,
    spikeLowValue: 90,
    seed: 202
  });

  const all15m = [...prevDay15m, ...curDay15mSoFar];
  const all1h = aggregateCandles(all15m, 4);
  const prevDay1d = aggregateCandles(prevDay15m, prevDay15m.length); // single candle for the previous UTC day only

  const PRICE = 100;
  const EMA21 = 95;
  const EMA200 = 80;

  const baseStructureInput = {
    candles1d: prevDay1d,
    candles1h: all1h,
    candles15m: all15m,
    price: PRICE,
    ema21: EMA21,
    ema200: EMA200,
    now: NOW
  };

  let structureResult;
  await test('buildStructure derives prevDay/session extremes from the correct UTC day', () => {
    structureResult = buildStructure(baseStructureInput);
    assert(structureResult && typeof structureResult === 'object', 'buildStructure did not return an object');
    assertEqual(structureResult.prevDayHigh, 105, 'prevDayHigh should come from the previous UTC day (2024-01-15)');
    assertEqual(structureResult.prevDayLow, 85, 'prevDayLow should come from the previous UTC day (2024-01-15)');
    assertEqual(structureResult.sessionHigh, 112, 'sessionHigh should come from the current UTC day so far (2024-01-16)');
    assertEqual(structureResult.sessionLow, 90, 'sessionLow should come from the current UTC day so far (2024-01-16)');
  });

  await test('support levels are all below price and sorted nearest-first (descending)', () => {
    assert(Array.isArray(structureResult.support), 'support is not an array');
    assert(structureResult.support.length > 0, 'expected at least one support level given ema21/ema200/prevDayLow/sessionLow are all below price');
    assert(structureResult.support.every((v) => v < PRICE), `all support levels must be < price(${PRICE}): ${JSON.stringify(structureResult.support)}`);
    assert(isSortedDesc(structureResult.support), `support must be sorted nearest-first (descending): ${JSON.stringify(structureResult.support)}`);
  });

  await test('resistance levels are all above price and sorted nearest-first (ascending)', () => {
    assert(Array.isArray(structureResult.resistance), 'resistance is not an array');
    assert(structureResult.resistance.length > 0, 'expected at least one resistance level given prevDayHigh/sessionHigh are above price');
    assert(structureResult.resistance.every((v) => v > PRICE), `all resistance levels must be > price(${PRICE}): ${JSON.stringify(structureResult.resistance)}`);
    assert(isSortedAsc(structureResult.resistance), `resistance must be sorted nearest-first (ascending): ${JSON.stringify(structureResult.resistance)}`);
  });

  await test('aboveEma21/aboveEma200 reflect price vs given EMAs (above case)', () => {
    assertEqual(structureResult.aboveEma21, true, `price(${PRICE}) > ema21(${EMA21}) should give aboveEma21=true`);
    assertEqual(structureResult.aboveEma200, true, `price(${PRICE}) > ema200(${EMA200}) should give aboveEma200=true`);
  });

  await test('aboveEma21/aboveEma200 reflect price vs given EMAs (below case)', () => {
    const below = buildStructure({ ...baseStructureInput, price: 50 });
    assertEqual(below.aboveEma21, false, `price(50) < ema21(${EMA21}) should give aboveEma21=false`);
    assertEqual(below.aboveEma200, false, `price(50) < ema200(${EMA200}) should give aboveEma200=false`);
  });

  await test('empty inputs return nulls without throwing', () => {
    const result = buildStructure({ candles1d: [], candles1h: [], candles15m: [], price: 100, ema21: null, ema200: null, now: NOW });
    assert(result && typeof result === 'object', 'buildStructure did not return an object for empty input');
    assertEqual(result.prevDayHigh, null, 'prevDayHigh should be null for empty candles1d');
    assertEqual(result.prevDayLow, null, 'prevDayLow should be null for empty candles1d');
    assertEqual(result.sessionHigh, null, 'sessionHigh should be null for empty candles1h/15m');
    assertEqual(result.sessionLow, null, 'sessionLow should be null for empty candles1h/15m');
  });

  await test('findSwings identifies swing points on an obvious zigzag and does not throw on tiny/empty input', () => {
    const highs = [100, 101, 102, 103, 104, 105, 106, 120, 106, 105, 104, 103, 102, 101, 100];
    const lows = [99, 100, 101, 102, 103, 104, 105, 90, 105, 104, 103, 102, 101, 100, 99];
    const candles = highs.map((h, i) => ({
      timestamp: NOW - (highs.length - i) * 60000,
      open: h - 1,
      high: h,
      low: lows[i],
      close: h - 0.5,
      volume: 10,
      closeTime: NOW - (highs.length - i) * 60000 + 60000
    }));

    const swings = findSwings(candles, 3);
    assert(swings && typeof swings === 'object', 'findSwings did not return an object');
    assert(Array.isArray(swings.swingHighs), 'swingHighs is not an array');
    assert(Array.isArray(swings.swingLows), 'swingLows is not an array');
    assert(swings.swingHighs.length > 0, 'expected at least one swing high on an obvious zigzag');
    assert(swings.swingHighs.some((s) => s.price === 120), 'expected the peak at 120 to be detected as a swing high');
    assert(swings.swingLows.length > 0, 'expected at least one swing low on an obvious zigzag');
    assert(swings.swingLows.some((s) => s.price === 90), 'expected the trough at 90 to be detected as a swing low');

    for (const input of [[], [candles[0]], null]) {
      const r = findSwings(input, 3);
      assert(r && Array.isArray(r.swingHighs) && Array.isArray(r.swingLows), `findSwings(${JSON.stringify(input)}) should return empty arrays, not throw`);
    }
  });

  // -------------------------------------------------------------------------
  // 4) Partial failure tolerance (buildScalpContext)
  // -------------------------------------------------------------------------
  console.log('\n4) partial failure tolerance (buildScalpContext)');

  const HEALTHY_SYMBOL = 'SCALPTEST_HEALTHY';
  const PARTIAL_SYMBOL = 'SCALPTEST_PARTIAL';
  const DEAD_SYMBOL = 'SCALPTEST_DEAD';
  const partialBadTimeframe = timeframesList[0];

  function makeFetchCandles({ deadMatch, badMatch }) {
    return async function fetchCandles(pair, interval, limit) {
      const p = String(pair).toUpperCase();
      if (deadMatch && p.includes(deadMatch)) {
        throw new Error(`synthetic-fetch-failure: symbol fully down (${pair} ${interval})`);
      }
      if (badMatch && p.includes(badMatch.symbol) && interval === badMatch.interval) {
        throw new Error(`synthetic-fetch-failure: single timeframe down (${pair} ${interval})`);
      }
      const count = Math.max(520, (Number(limit) || 0) + 20);
      return makeCandles(interval, count, { now: NOW, seed: seedFromString(`${pair}|${interval}`) });
    };
  }

  let case4Result;
  await test('resolves with dataStatus=partial, warnings present, healthy symbol intact, nothing throws', async () => {
    const fetchCandles = makeFetchCandles({
      deadMatch: DEAD_SYMBOL,
      badMatch: { symbol: PARTIAL_SYMBOL, interval: partialBadTimeframe }
    });

    case4Result = await buildScalpContext({
      symbols: [HEALTHY_SYMBOL, PARTIAL_SYMBOL, DEAD_SYMBOL],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles
    });

    assert(case4Result && typeof case4Result === 'object', 'buildScalpContext did not resolve to an object');
    assertEqual(case4Result.dataStatus, 'partial', `expected dataStatus 'partial', got ${JSON.stringify(case4Result.dataStatus)}`);
    assert(Array.isArray(case4Result.warnings), 'warnings is not an array');
    assert(case4Result.warnings.length > 0, 'expected at least one warning');

    assert(case4Result.symbols && typeof case4Result.symbols === 'object', 'symbols missing from result');
    const healthy = case4Result.symbols[HEALTHY_SYMBOL];
    assert(healthy, `expected healthy symbol "${HEALTHY_SYMBOL}" present in result.symbols`);
    assert(healthy.timeframes && typeof healthy.timeframes === 'object', 'healthy symbol missing timeframes');

    for (const tf of timeframesList) {
      const tfData = healthy.timeframes[tf];
      assert(tfData, `healthy symbol missing timeframe data for "${tf}"`);
      assert(Array.isArray(tfData.candles) && tfData.candles.length > 0, `healthy symbol has no candles for "${tf}"`);
    }
  });

  // -------------------------------------------------------------------------
  // 5) JSON normalization
  // -------------------------------------------------------------------------
  console.log('\n5) JSON normalization (normalizeJson)');

  await test('scalars: NaN/Infinity/-Infinity/undefined -> null', () => {
    assertEqual(normalizeJson(NaN), null);
    assertEqual(normalizeJson(Infinity), null);
    assertEqual(normalizeJson(-Infinity), null);
    assertEqual(normalizeJson(undefined), null);
    assertEqual(normalizeJson(42), 42);
    assertEqual(normalizeJson('ok'), 'ok');
    assertEqual(normalizeJson(null), null);
  });

  await test('array elements are normalized, length/order preserved', () => {
    const out = normalizeJson([1, NaN, Infinity, -Infinity, undefined, 'x']);
    assert(Array.isArray(out), 'expected an array back');
    assertEqual(out.length, 6, `expected length 6, got ${out.length}`);
    assertEqual(out[0], 1);
    assertEqual(out[1], null);
    assertEqual(out[2], null);
    assertEqual(out[3], null);
    assertEqual(out[4], null);
    assertEqual(out[5], 'x');
  });

  await test('object properties: NaN/Infinity normalized to null; undefined removed or nulled', () => {
    const out = normalizeJson({ a: NaN, b: 1, c: undefined, d: 'ok', e: Infinity });
    assertEqual(out.b, 1);
    assertEqual(out.d, 'ok');
    assertEqual(out.a, null);
    assertEqual(out.e, null);
    assert(!('c' in out) || out.c === null, `expected 'c' removed or null, got ${JSON.stringify(out.c)}`);
  });

  await test('nested structures survive recursively and stringify cleanly', () => {
    const input = {
      list: [{ v: NaN }, { v: Infinity }, { v: -Infinity }],
      nested: { deep: { bad: undefined, good: 5, arr: [undefined, NaN, 3] } }
    };
    const out = normalizeJson(input);
    assertEqual(out.list[0].v, null);
    assertEqual(out.list[1].v, null);
    assertEqual(out.list[2].v, null);
    assertEqual(out.nested.deep.good, 5);
    assert(!('bad' in out.nested.deep) || out.nested.deep.bad === null);
    assertEqual(out.nested.deep.arr[1], null);
    assertEqual(out.nested.deep.arr[2], 3);

    const str = JSON.stringify(out);
    assert(!str.includes('NaN'), 'stringified output still contains NaN');
    assert(!str.includes('Infinity'), 'stringified output still contains Infinity');
  });

  function walkForBadValues(value, path, bad) {
    if (value === undefined) {
      bad.push(`${path} is undefined`);
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      bad.push(`${path} is ${value}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walkForBadValues(v, `${path}[${i}]`, bad));
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) walkForBadValues(value[k], `${path}.${k}`, bad);
    }
  }

  await test('buildScalpContext output (from case 4) contains no NaN/Infinity/undefined (recursive walk)', () => {
    assert(case4Result, 'case 4 result not available (did an earlier test fail?)');
    const bad = [];
    walkForBadValues(case4Result, '$', bad);
    assert(bad.length === 0, `found ${bad.length} unclean value(s): ${bad.slice(0, 10).join('; ')}`);
  });

  await test('buildScalpContext output (from case 4) round-trips cleanly through JSON.stringify/parse', () => {
    assert(case4Result, 'case 4 result not available (did an earlier test fail?)');
    let str;
    try {
      str = JSON.stringify(case4Result);
    } catch (err) {
      throw new Error(`JSON.stringify threw: ${err.message}`);
    }
    assert(typeof str === 'string' && str.length > 0, 'JSON.stringify produced an empty/invalid string');
    const roundTripped = JSON.parse(str);
    const bad = [];
    walkForBadValues(roundTripped, '$', bad);
    assert(bad.length === 0, `round-tripped output has ${bad.length} unclean value(s): ${bad.slice(0, 10).join('; ')}`);
  });

  // -------------------------------------------------------------------------
  // 6) Candle limits and size
  // -------------------------------------------------------------------------
  console.log('\n6) candle limits and payload size (buildScalpContext, fully healthy)');

  const HEALTHY_A = 'SCALPTEST_ONE';
  const HEALTHY_B = 'SCALPTEST_TWO';

  let case6Result;
  let case6DurationMs;
  await test('fully healthy build resolves without error and is timed', async () => {
    const fetchCandles = makeFetchCandles({ deadMatch: null, badMatch: null });
    const t0 = Date.now();
    case6Result = await buildScalpContext({
      symbols: [HEALTHY_A, HEALTHY_B],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles
    });
    case6DurationMs = Date.now() - t0;
    assert(case6Result && typeof case6Result === 'object', 'buildScalpContext did not resolve to an object');
  });

  await test('every timeframe emits at most CANDLE_LIMITS[tf] candles, none still-forming', () => {
    assert(case6Result, 'case 6 result not available (did the previous test fail?)');
    for (const sym of [HEALTHY_A, HEALTHY_B]) {
      const symData = case6Result.symbols[sym];
      assert(symData, `expected symbol "${sym}" present in a fully healthy build`);
      for (const tf of timeframesList) {
        const tfData = symData.timeframes[tf];
        assert(tfData, `symbol "${sym}" missing timeframe "${tf}"`);
        const candles = tfData.candles;
        assert(Array.isArray(candles), `symbol "${sym}" timeframe "${tf}" candles is not an array`);

        const limit = lookup(CANDLE_LIMITS, tf);
        if (Number.isFinite(limit)) {
          assert(candles.length <= limit, `symbol "${sym}" timeframe "${tf}" emitted ${candles.length} candles, exceeds CANDLE_LIMITS[${tf}]=${limit}`);
        }

        for (const c of candles) {
          const ref = typeof c.t === 'string' ? Date.parse(c.t)
            : typeof c.t === 'number' ? c.t
            : typeof c.closeTime === 'number' ? c.closeTime
            : typeof c.timestamp === 'number' ? c.timestamp
            : NaN;
          assert(Number.isFinite(ref), `symbol "${sym}" timeframe "${tf}" has a candle with no resolvable time field: ${JSON.stringify(c)}`);
          assert(ref <= NOW, `symbol "${sym}" timeframe "${tf}" has a still-forming candle (time ${ref} > now ${NOW})`);
        }
      }
    }
  });

  await test('payload size stays well under Vercel response limits', () => {
    assert(case6Result, 'case 6 result not available');
    const str = JSON.stringify(case6Result);
    const bytes = Buffer.byteLength(str, 'utf8');
    console.log(`      payload size: ${bytes} bytes, build duration: ${case6DurationMs}ms`);
    assert(bytes < 4_500_000, `payload size ${bytes} bytes exceeds 4.5MB budget`);
  });

  // -------------------------------------------------------------------------
  // 7) Live-data integrity: derived 3m, no synthetic, honest status
  // -------------------------------------------------------------------------
  console.log('\n7) live-data integrity (derived 3m, no synthetic in the connector)');

  // Build 1m candles on exact UTC minute boundaries so bucket alignment is explicit.
  function oneMinuteCandles(startMs, count, opts = {}) {
    const { skip = [] } = opts;
    const out = [];
    for (let i = 0; i < count; i++) {
      if (skip.includes(i)) continue;
      const ts = startMs + (i * 60000);
      const base = 100 + i;
      out.push({
        timestamp: ts,
        open: base,
        high: base + 2,
        low: base - 3,
        close: base + 1,
        volume: 10 + i,
        closeTime: ts + 60000
      });
    }
    return out;
  }

  await test('connector never asks Kraken for interval=3 - 3m is derived from 1m', async () => {
    assertEqual(DERIVED_INTERVALS['3m'].base, '1m', '3m must be declared as derived from 1m');
    assert(!KRAKEN_NATIVE_INTERVALS.includes('3m'), '3m must not be listed as a Kraken-native interval');

    const requested = [];
    const bucketStart = Date.UTC(2024, 0, 16, 11, 0, 0);
    const result = await getCandlesWithProvenance('BTCUSDT', '3m', 5, {
      allowSynthetic: false,
      now: bucketStart + (60 * 60000),
      fetchKraken: async (symbol, interval, limit) => {
        requested.push(interval);
        return oneMinuteCandles(bucketStart, 60);
      }
    });

    assert(requested.length > 0, 'expected the provider to be called at least once');
    for (const interval of requested) {
      assert(interval !== '3m' && interval !== 3 && interval !== '3',
        `provider was asked for a 3m interval (${JSON.stringify(interval)}) - Kraken rejects it`);
      assertEqual(interval, '1m', 'the 3m feed must be built from 1m candles only');
    }
    assertEqual(result.provider, 'kraken-derived', 'derived 3m must be labelled kraken-derived');
    assertEqual(result.derivedFrom, '1m', 'derivedFrom must record the base timeframe');
    assertEqual(result.synthetic, false, 'derived 3m must never be flagged synthetic');
    assert(result.candles.length > 0, 'expected derived 3m candles');
  });

  await test('3m buckets aggregate OHLCV correctly and are UTC-aligned', () => {
    const bucketStart = Date.UTC(2024, 0, 16, 11, 0, 0);
    const src = oneMinuteCandles(bucketStart, 6);
    const out = aggregateToBuckets(src, 60000, 180000);

    assertEqual(out.length, 2, 'six 1m candles must produce exactly two complete 3m buckets');

    const first = out[0];
    assertEqual(first.timestamp, bucketStart, 'bucket timestamp must be the UTC-aligned bucket start');
    assertEqual(first.closeTime, bucketStart + 180000, 'bucket closeTime must be start + 3 minutes');
    assertEqual(first.open, src[0].open, 'bucket open must be the first candle open');
    assertEqual(first.close, src[2].close, 'bucket close must be the final candle close');
    assertEqual(first.high, Math.max(src[0].high, src[1].high, src[2].high), 'bucket high must be the max high');
    assertEqual(first.low, Math.min(src[0].low, src[1].low, src[2].low), 'bucket low must be the min low');
    assertEqual(first.volume, src[0].volume + src[1].volume + src[2].volume, 'bucket volume must be the sum');

    assertEqual(out[1].timestamp, bucketStart + 180000, 'second bucket must start one interval later');

    for (const candle of out) {
      assertEqual(candle.timestamp % 180000, 0, 'every bucket must be aligned to a UTC 3-minute boundary');
    }
  });

  await test('incomplete 3m buckets are excluded', () => {
    const bucketStart = Date.UTC(2024, 0, 16, 11, 0, 0);

    // Second bucket is missing its middle 1m candle -> incomplete, must be dropped.
    const gapped = oneMinuteCandles(bucketStart, 6, { skip: [4] });
    const out = aggregateToBuckets(gapped, 60000, 180000);
    assertEqual(out.length, 1, 'a bucket missing a source candle must be excluded');
    assertEqual(out[0].timestamp, bucketStart, 'only the complete bucket may survive');

    // A trailing partial bucket (only 2 of 3 candles) must also be dropped.
    const trailing = oneMinuteCandles(bucketStart, 5);
    const out2 = aggregateToBuckets(trailing, 60000, 180000);
    assertEqual(out2.length, 1, 'a trailing partial bucket must be excluded');
  });

  await test('a still-forming 1m candle cannot complete a 3m bucket', async () => {
    const bucketStart = Date.UTC(2024, 0, 16, 11, 0, 0);
    // now sits inside the second bucket: its third 1m candle has not closed yet.
    const now = bucketStart + 180000 + 120000;
    const result = await getCandlesWithProvenance('BTCUSDT', '3m', 10, {
      allowSynthetic: false,
      now,
      fetchKraken: async () => oneMinuteCandles(bucketStart, 6)
    });
    assertEqual(result.candles.length, 1, 'only the fully closed 3m bucket may be returned');
    assertEqual(result.candles[0].timestamp, bucketStart, 'the surviving bucket must be the closed one');
  });

  await test('a provider failure returns unavailable rather than synthetic data', async () => {
    const result = await getCandlesWithProvenance('BTCUSDT', '3m', 10, {
      allowSynthetic: false,
      now: NOW,
      fetchKraken: async () => { throw new Error('kraken down'); }
    });
    assertEqual(result.provider, null, 'a failed strict fetch must not claim a provider');
    assertEqual(result.synthetic, false, 'a failed strict fetch must not produce synthetic data');
    assertEqual(result.candles.length, 0, 'a failed strict fetch must return no candles');
    assert(typeof result.error === 'string' && result.error.length > 0, 'the failure reason must be reported');
  });

  await test('failed live data cannot produce dataStatus=complete', async () => {
    const failingTf = timeframesList[1] || timeframesList[0];
    const result = await buildScalpContext({
      symbols: ['INTEGRITY_A'],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles: async (pair, interval, limit) => {
        if (interval === failingTf) {
          return { candles: [], provider: null, synthetic: false, error: 'live feed down' };
        }
        return {
          candles: makeCandles(interval, 520, { now: NOW, seed: seedFromString(`${pair}|${interval}`) }),
          provider: 'kraken',
          synthetic: false,
          error: null
        };
      }
    });

    assertEqual(result.dataStatus, 'partial', 'a failed timeframe must downgrade dataStatus to partial');
    assert(result.warnings.length > 0, 'a failed timeframe must record a warning');
    assert(result.warnings.some((w) => String(w).includes(failingTf)), 'the warning must name the failed timeframe');
    assert(result.symbols.INTEGRITY_A.source.provider !== 'kraken',
      'a symbol with a failed timeframe must not be labelled as fully kraken-sourced');
  });

  await test('synthetic data cannot enter the connector or be labelled kraken', async () => {
    const result = await buildScalpContext({
      symbols: ['INTEGRITY_B'],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles: async (pair, interval, limit) => ({
        candles: makeCandles(interval, 520, { now: NOW, seed: seedFromString(`${pair}|${interval}`) }),
        provider: 'synthetic',
        synthetic: true,
        error: null
      })
    });

    const symbol = result.symbols.INTEGRITY_B;
    assert(symbol.source.provider !== 'kraken' && symbol.source.provider !== 'kraken-derived',
      `synthetic data was labelled as live (${symbol.source.provider})`);
    assertEqual(result.dataStatus, 'unavailable', 'an all-synthetic feed leaves the connector with no usable data');
    assert(result.warnings.length > 0, 'rejected synthetic data must record warnings');
    assert(result.warnings.some((w) => String(w).toLowerCase().includes('synthetic')),
      'the warning must state that synthetic data was rejected');

    for (const tf of timeframesList) {
      assertEqual(symbol.timeframes[tf].candles.length, 0, `synthetic ${tf} candles must not reach the payload`);
    }
  });

  await test('a fully live feed is labelled kraken and reports complete', async () => {
    const result = await buildScalpContext({
      symbols: ['INTEGRITY_C'],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles: async (pair, interval, limit) => ({
        candles: makeCandles(interval, 520, { now: NOW, seed: seedFromString(`${pair}|${interval}`) }),
        provider: interval === '3m' ? 'kraken-derived' : 'kraken',
        synthetic: false,
        error: null
      })
    });

    assertEqual(result.dataStatus, 'complete', 'a fully live feed must report complete');
    assertEqual(result.warnings.length, 0, 'a fully live feed must record no warnings');
    assertEqual(result.symbols.INTEGRITY_C.source.provider, 'kraken', 'a fully live feed must be labelled kraken');
  });

  await test('each trimmed strategy carries the engine execution contract', async () => {
    const result = await buildScalpContext({
      symbols: ['INTEGRITY_C'],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles: async (pair, interval, limit) => ({
        candles: makeCandles(interval, 520, { now: NOW, seed: seedFromString(`${pair}|${interval}`) }),
        provider: interval === '3m' ? 'kraken-derived' : 'kraken',
        synthetic: false,
        error: null
      })
    });

    const strategies = result.symbols.INTEGRITY_C.strategies;
    assert(Object.keys(strategies).length > 0, 'expected at least one evaluated strategy');

    for (const [name, s] of Object.entries(strategies)) {
      // Pre-existing fields must keep their meaning.
      assert(typeof s.valid === 'boolean', `${name}: valid must stay a boolean`);
      assert(typeof s.direction === 'string', `${name}: direction must stay a string`);
      assert(typeof s.confidence === 'number', `${name}: confidence must stay a number`);

      // Execution contract: present on every strategy, never fabricated.
      assert(s.entryZone && typeof s.entryZone === 'object', `${name}: entryZone missing`);
      assert(s.entryZone.min === null || Number.isFinite(s.entryZone.min), `${name}: entryZone.min must be a finite number or null`);
      assert(s.entryZone.max === null || Number.isFinite(s.entryZone.max), `${name}: entryZone.max must be a finite number or null`);
      assert(s.stopLoss === null || Number.isFinite(s.stopLoss), `${name}: stopLoss must be a finite number or null`);
      assert(s.invalidationLevel === null || Number.isFinite(s.invalidationLevel), `${name}: invalidationLevel must be a finite number or null`);
      assert(Array.isArray(s.targets), `${name}: targets must be an array`);
      assert(s.targets.every(Number.isFinite), `${name}: targets must contain only finite numbers`);
      assert(s.riskReward && typeof s.riskReward === 'object', `${name}: riskReward missing`);
      assert(s.riskReward.tp1RR === null || Number.isFinite(s.riskReward.tp1RR), `${name}: tp1RR must be a finite number or null`);
      assert(s.riskReward.tp2RR === null || Number.isFinite(s.riskReward.tp2RR), `${name}: tp2RR must be a finite number or null`);
      assert(s.stopSource === null || typeof s.stopSource === 'string', `${name}: stopSource must be a string or null`);

      // An invalid strategy must not carry levels a caller could act on.
      if (!s.valid) {
        assertEqual(s.entryZone.min, null, `${name}: an invalid strategy must not expose an entry zone`);
        assertEqual(s.stopLoss, null, `${name}: an invalid strategy must not expose a stop`);
        assertEqual(s.targets.length, 0, `${name}: an invalid strategy must not expose targets`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 8) decisionTrace
  // -------------------------------------------------------------------------
  console.log('\n8) decisionTrace (buildScalpContext)');

  const STRATEGY_NAMES_LIST = ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP'];

  await test('decisionTrace is present for every symbol, one entry per strategy name', () => {
    assert(case6Result, 'case 6 result not available');
    for (const sym of [HEALTHY_A, HEALTHY_B]) {
      const trace = case6Result.symbols[sym].decisionTrace;
      assert(trace && typeof trace === 'object', `${sym}: decisionTrace missing`);
      assertEqual(trace.configVersion, case6Result.configVersion, `${sym}: decisionTrace.configVersion does not match payload configVersion`);
      assert(typeof trace.evaluatedAt === 'string' && trace.evaluatedAt.length > 0, `${sym}: decisionTrace.evaluatedAt missing`);
      assert(Array.isArray(trace.strategies), `${sym}: decisionTrace.strategies is not an array`);
      assertEqual(trace.strategies.length, STRATEGY_NAMES_LIST.length, `${sym}: expected one trace entry per strategy`);

      const seen = new Set();
      for (const entry of trace.strategies) {
        assert(STRATEGY_NAMES_LIST.includes(entry.name), `${sym}: unexpected strategy name "${entry.name}" in trace`);
        assert(!seen.has(entry.name), `${sym}: strategy "${entry.name}" appears more than once in trace`);
        seen.add(entry.name);
        assert(typeof entry.ran === 'boolean', `${sym}: ${entry.name}.ran must be boolean`);
        assert(typeof entry.valid === 'boolean', `${sym}: ${entry.name}.valid must be boolean`);
        if (!entry.valid) {
          assert(typeof entry.reason === 'string' && entry.reason.length > 0, `${sym}: rejected strategy "${entry.name}" must carry a non-empty reason`);
          assert(typeof entry.rejectedAt === 'string' && entry.rejectedAt.length > 0, `${sym}: rejected strategy "${entry.name}" must carry a rejectedAt code`);
        } else {
          assertEqual(entry.rejectedAt, null, `${sym}: a valid strategy must not carry rejectedAt`);
        }
      }
      assertEqual(seen.size, STRATEGY_NAMES_LIST.length, `${sym}: every canonical strategy name must appear exactly once`);

      assert(Array.isArray(trace.candidateSetups), `${sym}: decisionTrace.candidateSetups must be an array`);
      const expectedRefs = case6Result.symbols[sym].candidateSetups.map(({ timeframe, direction, state }) => `${timeframe}:${direction}:${state}`);
      assert(deepEqual(trace.candidateSetups, expectedRefs),
        `${sym}: decisionTrace.candidateSetups must reference the symbol's candidateSetups one-to-one`);
      assert(Array.isArray(trace.geometry), `${sym}: decisionTrace.geometry must be the compact per-timeframe summary (phase 7)`);
    }
  });

  await test('decisionTrace.window covers every requested timeframe, to === that timeframe\'s closedThrough', () => {
    assert(case6Result, 'case 6 result not available');
    for (const sym of [HEALTHY_A, HEALTHY_B]) {
      const symData = case6Result.symbols[sym];
      const window = symData.decisionTrace.window;
      assert(window && typeof window === 'object', `${sym}: decisionTrace.window missing`);
      for (const tf of timeframesList) {
        const w = window[tf];
        assert(w, `${sym}: decisionTrace.window missing timeframe "${tf}"`);
        assertEqual(w.to, symData.timeframes[tf].closedThrough, `${sym}: window[${tf}].to must equal timeframes[${tf}].closedThrough`);
        assert(Number.isInteger(w.closedCandles) && w.closedCandles >= 0, `${sym}: window[${tf}].closedCandles must be a non-negative integer`);
        if (w.closedCandles > 0) {
          assert(typeof w.from === 'string' && w.from.length > 0, `${sym}: window[${tf}].from must be set when candles exist`);
        }
      }
    }
  });

  await test('decisionTrace stays within the ~2KB per-symbol budget', () => {
    assert(case6Result, 'case 6 result not available');
    for (const sym of [HEALTHY_A, HEALTHY_B]) {
      const bytes = Buffer.byteLength(JSON.stringify(case6Result.symbols[sym].decisionTrace), 'utf8');
      assert(bytes <= 2048, `${sym}: decisionTrace is ${bytes} bytes, exceeds the 2KB budget`);
    }
  });

  await test('classifyRejection maps known reason text to stable codes', () => {
    assertEqual(classifyRejection('Setup rejected: scalp stop distance 6.18% exceeds 3.00% maximum'), 'stop-distance');
    assertEqual(classifyRejection('4H trend is FLAT - no trade allowed per STANDARD mode rules (override conditions not met)'), 'htf-flat');
    assertEqual(classifyRejection('Setup rejected: confidence 42.0% below minimum 55%'), 'confidence');
    assertEqual(classifyRejection('Strategy evaluation failed: boom'), 'evaluation-error');
    assertEqual(classifyRejection('something entirely unrecognized'), 'setup-conditions');
    assertEqual(classifyRejection(null), 'unspecified');
  });

  await test('classifyRejection recognizes "21 EMA" word order, not just "EMA21"', () => {
    // evaluateSwingSetup's invalidationReasons push "Price too far from 21 EMA" -
    // the reversed word order the original ema-distance regex missed entirely.
    assertEqual(classifyRejection('Price too far from 21 EMA'), 'ema-distance');
    assertEqual(classifyRejection('Price too far from 21 EMA; 1h breaking down'), 'ema-distance');
    assertEqual(classifyRejection('Setup rejected: price too far from EMA21 (2.40% > 2%)'), 'ema-distance', 'the original EMA21 order must still classify');
  });

  await test('classifyRejection maps SWING\'s missing-3d/1d "no signal returned" to insufficient-data, not evaluation-error', () => {
    // evaluateSwingSetup returns bare null when 3d/1d/4h data is missing, which
    // normalizeStrategyResult turns into this exact generic reason text. It is a data
    // gap, not a thrown exception, so it must not share evaluation-error's code.
    assertEqual(classifyRejection('Strategy evaluation failed - no signal returned'), 'insufficient-data');
    // A real exception's reason text still classifies as evaluation-error.
    assertEqual(classifyRejection('Strategy evaluation failed: TypeError: boom'), 'evaluation-error');
  });

  await test('classifyRejection maps the "No clean SWING / 4H Trend" final fallback to no-setup (phase 5, item I)', () => {
    const fallback = 'No clean SWING / 4H Trend / 1H Scalp / Micro-Scalp setup. 4H: UPTREND, 1H: UPTREND. HTF bias: long (60% confidence)';
    assertEqual(classifyRejection(fallback), 'no-setup');
  });

  await test('SCALP_1H hits the "No clean SWING / 4H Trend" fallback and classifies as no-setup via the real evaluateAllStrategies call path', () => {
    // 4H trending (so the earlier "4H trend is FLAT" gate never fires) but 1H flat: Scalp's
    // PRIORITY 4 block (evaluateStrategy, setupType='Scalp') requires a non-flat 1H trend, so
    // its inner logic is skipped entirely and nothing else in that call applies - it falls
    // through to evaluateStrategy's PRIORITY 5 fallback, which normalizeToCanonical maps to
    // SCALP_1H.reason verbatim.
    const tf = (trend) => ({
      indicators: {
        price: { current: 100 },
        ema: { ema21: 100, ema200: 95 },
        analysis: { trend, distanceFrom21EMA: 5, pullbackState: 'OVEREXTENDED' },
        stochRSI: { condition: 'NEUTRAL', k: 50, d: 50, history: [] }
      },
      structure: { swingHigh: null, swingLow: null },
      candleCount: 100
    });
    const mtf = {
      '3d': tf('UPTREND'), '1d': tf('UPTREND'), '4h': tf('UPTREND'),
      '1h': tf('FLAT'), '15m': tf('FLAT'), '5m': tf('FLAT'), '1m': tf('FLAT')
    };

    const result = evaluateAllStrategies('NOSETUPUSDT', mtf, 'STANDARD');
    assertEqual(result.strategies.SCALP_1H.valid, false, 'test fixture must produce a rejected SCALP_1H setup');
    assert(/No clean SWING \/ 4H Trend/i.test(result.strategies.SCALP_1H.reason), `expected the "No clean SWING..." fallback reason, got: ${result.strategies.SCALP_1H.reason}`);
    assertEqual(classifyRejection(result.strategies.SCALP_1H.reason), 'no-setup');

    const trace = buildStrategyTrace(result.strategies);
    const scalpEntry = trace.find((e) => e.name === 'SCALP_1H');
    assertEqual(scalpEntry.rejectedAt, 'no-setup', `expected rejectedAt "no-setup", got: ${JSON.stringify(scalpEntry.rejectedAt)}`);
  });

  // Minimal multiTimeframeData that satisfies the SCALP_1H guardrails in
  // evaluateStrategy: 1h trending, 1h/15m near the 21 EMA and in the entry zone,
  // 15m Stoch RSI aligned, and a 4h structural swing far enough away to produce
  // a stop beyond the 3% cap. Mirrors test-strategy-sltp.js section 6b, which
  // proves this same shape reproduces BTC's real "6.18% stop" rejection.
  function wideStopScalpMtf() {
    const tf = () => ({
      indicators: {
        price: { current: 100 },
        ema: { ema21: 100, ema200: 95 },
        analysis: { trend: 'UPTREND', distanceFrom21EMA: 0.2, pullbackState: 'ENTRY_ZONE' },
        stochRSI: { condition: 'BULLISH', k: 40, d: 35, history: [] }
      },
      structure: { swingHigh: null, swingLow: null },
      candleCount: 100
    });
    const m = { '3d': tf(), '1d': tf(), '4h': tf(), '1h': tf(), '15m': tf(), '5m': tf(), '1m': tf() };
    m['4h'].structure = { swingHigh: null, swingLow: 94.18 };
    m['15m'].structure = { swingHigh: null, swingLow: 99.92 };
    m['5m'].structure = { swingHigh: null, swingLow: 99.95 };
    return m;
  }

  await test('a rejected scalp stop shows rejectedAt: "stop-distance" via the real evaluateAllStrategies call path', () => {
    const result = evaluateAllStrategies('TESTUSDT', wideStopScalpMtf(), 'STANDARD');
    assertEqual(result.strategies.SCALP_1H.valid, false, 'test fixture must produce a rejected SCALP_1H setup');
    assert(/scalp stop distance/i.test(result.strategies.SCALP_1H.reason), `expected a stop-distance rejection reason, got: ${result.strategies.SCALP_1H.reason}`);

    const trace = buildDecisionTrace({
      rawStrategies: result.strategies,
      bestSignal: result.bestSignal,
      evaluatedAt: new Date(NOW).toISOString(),
      window: {}
    });
    const scalpEntry = trace.strategies.find((e) => e.name === 'SCALP_1H');
    assert(scalpEntry, 'SCALP_1H entry missing from decisionTrace.strategies');
    assertEqual(scalpEntry.valid, false);
    assertEqual(scalpEntry.rejectedAt, 'stop-distance', `expected rejectedAt "stop-distance", got: ${JSON.stringify(scalpEntry.rejectedAt)}`);
    assert(scalpEntry.reason === result.strategies.SCALP_1H.reason, 'decisionTrace reason must match the engine-produced reason verbatim');
  });

  await test('SWING with no 3d/1d data shows rejectedAt: "insufficient-data" via the real evaluateAllStrategies call path', () => {
    const mtf = wideStopScalpMtf();
    delete mtf['3d'];
    delete mtf['1d'];

    const result = evaluateAllStrategies('TESTUSDT', mtf, 'STANDARD');
    assertEqual(result.strategies.SWING.valid, false, 'SWING must not produce a signal without 3d/1d data');
    assert(/no signal returned/i.test(result.strategies.SWING.reason), `expected the "no signal returned" reason, got: ${result.strategies.SWING.reason}`);
    assertEqual(classifyRejection(result.strategies.SWING.reason), 'insufficient-data');

    const trace = buildDecisionTrace({
      rawStrategies: result.strategies,
      bestSignal: result.bestSignal,
      evaluatedAt: new Date(NOW).toISOString(),
      window: {}
    });
    const swingEntry = trace.strategies.find((e) => e.name === 'SWING');
    assertEqual(swingEntry.rejectedAt, 'insufficient-data', `expected rejectedAt "insufficient-data", got: ${JSON.stringify(swingEntry.rejectedAt)}`);
  });

  await test('buildStrategyTrace marks every canonical name ran:false when strategies is null (top-level evaluation failure)', () => {
    const entries = buildStrategyTrace(null);
    assertEqual(entries.length, STRATEGY_NAMES_LIST.length);
    for (const e of entries) {
      assertEqual(e.ran, false);
      assertEqual(e.valid, false);
      assertEqual(e.rejectedAt, 'evaluation-error');
    }
  });

  await test('buildTimeframeWindow reports zero candles and null bounds for an empty compute window', () => {
    const window = buildTimeframeWindow({}, {}, ['1h']);
    assertEqual(window['1h'].from, null);
    assertEqual(window['1h'].to, null);
    assertEqual(window['1h'].closedCandles, 0);
  });

  // -------------------------------------------------------------------------
  // 8b) compute depth (phase 6)
  // -------------------------------------------------------------------------
  console.log('\n8b) compute depth (buildScalpContext, phase 6)');

  await test('compute window is >= 200 closed candles per timeframe, production-sized fixture, through the real build path', async () => {
    // Mirrors production sizing without hardcoding it: FETCH_LIMIT (services/scalpContext.js)
    // is passed to fetchCandles as `limit`, so deriving candle counts from that argument -
    // rather than a fixed number - means this test fails if FETCH_LIMIT is ever lowered
    // below what yields 200 closed candles.
    //
    // Non-3m: production returns ~(limit - 1) closed candles (the newest bar is still
    // forming). At FETCH_LIMIT=500 that is 499, matching the measured baseline
    // (docs/RULE_OWNER_MATRIX.md).
    //
    // 3m: derived from 1m under Kraken's 720-row cap (services/marketData.js
    // getCandlesWithProvenance: baseLimit = min(720, (limit + 2) * 3)). At
    // FETCH_LIMIT=500, baseLimit=720 -> 240 three-minute buckets, one still forming -> 239
    // closed. This is the documented shallowest window; 239 still clears the 200-candle
    // floor EMA200 needs.
    const productionSizedFetch = async (pair, interval, limit) => {
      const count = interval === '3m'
        ? Math.max(0, Math.floor(Math.min(720, (limit + 2) * 3) / 3) - 1)
        : Math.max(0, limit - 1);
      return {
        candles: makeCandles(interval, count, { now: NOW, seed: seedFromString(`depth|${pair}|${interval}`), includeForming: false }),
        provider: interval === '3m' ? 'kraken-derived' : 'kraken',
        synthetic: false,
        error: null
      };
    };

    const result = await buildScalpContext({
      symbols: ['DEPTHTEST'],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles: productionSizedFetch
    });

    const window = result.symbols.DEPTHTEST.decisionTrace.window;
    for (const tf of timeframesList) {
      assert(window[tf], `${tf}: missing from decisionTrace.window`);
      assert(window[tf].closedCandles >= 200,
        `${tf}: compute window is ${window[tf].closedCandles} closed candles, below the 200-candle floor`);
    }
    if (timeframesList.includes('3m')) {
      assertEqual(window['3m'].closedCandles, 239, 'documented shallowest window: 3m should land at 239 closed candles under FETCH_LIMIT=500');
    }

    // Depth proven above; published candle counts must stay exactly as before
    // (30/30/30/24/24/20/10) even against this deeper, production-sized fixture.
    const tfEntries = result.symbols.DEPTHTEST.timeframes;
    for (const tf of timeframesList) {
      const limit = lookup(CANDLE_LIMITS, tf);
      if (Number.isFinite(limit)) {
        assertEqual(tfEntries[tf].candles.length, limit, `${tf}: published candle count changed, expected ${limit}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 9) risk (phase 3)
  // -------------------------------------------------------------------------
  console.log('\n9) risk (buildScalpContext, phase 3)');

  const RISK_FIXTURE_SYMBOL = 'INTEGRITY_C';
  const riskFetchCandles = async (pair, interval) => ({
    candles: makeCandles(interval, 520, { now: NOW, seed: seedFromString(`${pair}|${interval}`) }),
    provider: interval === '3m' ? 'kraken-derived' : 'kraken',
    synthetic: false,
    error: null
  });

  async function fakeAccountWithMargin(usd) {
    return {
      status: 'available',
      reason: null,
      address: 'FAKE_TEST_ADDRESS',
      fetchedAt: new Date(NOW).toISOString(),
      margin: { usd, byAsset: { USDC: usd } },
      holdings: [],
      holdingsUsd: 0,
      unpriced: [],
      gas: { sol: 1, minSol: 0.02, sufficient: true },
      performance: { baselineUsd: usd, netPnlUsd: 0, returnPct: 0, source: 'test' }
    };
  }

  async function fakeAccountUnavailable() {
    return {
      status: 'unavailable',
      reason: 'test stub',
      address: null,
      fetchedAt: null,
      margin: { usd: null, byAsset: {} },
      holdings: [],
      holdingsUsd: null,
      unpriced: [],
      gas: { sol: null, minSol: 0.02, sufficient: null },
      performance: { baselineUsd: null, netPnlUsd: null, returnPct: null, source: null }
    };
  }

  let riskAvailableResult;
  await test('setup: fixture produces at least one valid and one invalid strategy', async () => {
    riskAvailableResult = await buildScalpContext({
      symbols: [RISK_FIXTURE_SYMBOL],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles: riskFetchCandles,
      fetchAccount: () => fakeAccountWithMargin(1000)
    });
    const s = riskAvailableResult.symbols[RISK_FIXTURE_SYMBOL].strategies;
    assert(Object.values(s).some((v) => v.valid), 'fixture must produce at least one valid strategy');
    assert(Object.values(s).some((v) => !v.valid), 'fixture must produce at least one invalid strategy');
  });

  await test('margin available: every valid strategy is sized against collateralUsd, not the whole wallet', () => {
    const s = riskAvailableResult.symbols[RISK_FIXTURE_SYMBOL].strategies;
    const expectedCollateral = Math.min(ENGINE_CONFIG.risk.defaultMarginUsd, 1000); // fakeAccountWithMargin(1000)
    for (const [name, entry] of Object.entries(s)) {
      if (!entry.valid) {
        assert(!('risk' in entry), `${name}: an invalid strategy must not carry a risk block`);
        continue;
      }
      assert(entry.risk && typeof entry.risk === 'object', `${name}: valid strategy missing a risk block`);
      assertEqual(entry.risk.collateralUsd, expectedCollateral, `${name}: risk.collateralUsd must be min(defaultMarginUsd, wallet margin), not the whole wallet`);
      assert(Number.isInteger(entry.risk.maxLeverage) && entry.risk.maxLeverage > 0, `${name}: risk.maxLeverage must be a positive integer`);
      assert(Number.isInteger(entry.risk.suggestedLeverage) && entry.risk.suggestedLeverage > 0, `${name}: risk.suggestedLeverage must be a positive integer`);
      assert(Number.isFinite(entry.risk.lossAtStopUsd), `${name}: risk.lossAtStopUsd must be finite`);
      assert(entry.risk.lossAtStopUsd < expectedCollateral, `${name}: lossAtStopUsd (${entry.risk.lossAtStopUsd}) must stay under the tiny collateral it was sized against, not the $1000 wallet`);
      assert(Number.isFinite(entry.risk.lossAtStopPct), `${name}: risk.lossAtStopPct must be finite`);
      assertEqual(entry.risk.reason, null, `${name}: reason must be null when margin is available`);
    }
  });

  await test('risk.lossAtStopPctOfWallet is measured against the whole wallet, not collateralUsd (phase 5, item H)', () => {
    const s = riskAvailableResult.symbols[RISK_FIXTURE_SYMBOL].strategies;
    const walletMarginUsd = 1000; // fakeAccountWithMargin(1000)
    for (const [name, entry] of Object.entries(s)) {
      if (!entry.valid) continue;
      assert(Number.isFinite(entry.risk.lossAtStopPctOfWallet), `${name}: risk.lossAtStopPctOfWallet must be finite when margin is available`);
      const expected = Math.round(((entry.risk.lossAtStopUsd / walletMarginUsd) * 100) * 100) / 100;
      assertEqual(entry.risk.lossAtStopPctOfWallet, expected, `${name}: lossAtStopPctOfWallet must be lossAtStopUsd / whole wallet margin, not collateralUsd`);
      assert(entry.risk.lossAtStopPctOfWallet < entry.risk.lossAtStopPct, `${name}: measured against the $1000 wallet, the wallet-relative figure must be smaller than the collateral-relative one`);
    }
  });

  await test('account unavailable: every valid strategy carries risk:null-shaped with a reason, invalid strategies still get none', async () => {
    const result = await buildScalpContext({
      symbols: [RISK_FIXTURE_SYMBOL],
      timeframes: timeframesList,
      now: NOW,
      fetchCandles: riskFetchCandles,
      fetchAccount: fakeAccountUnavailable
    });
    const s = result.symbols[RISK_FIXTURE_SYMBOL].strategies;
    let sawValid = false;
    for (const [name, entry] of Object.entries(s)) {
      if (!entry.valid) {
        assert(!('risk' in entry), `${name}: an invalid strategy must not carry a risk block`);
        continue;
      }
      sawValid = true;
      assertEqual(entry.risk.maxLeverage, null, `${name}: maxLeverage must be null without margin`);
      assertEqual(entry.risk.suggestedLeverage, null, `${name}: suggestedLeverage must be null without margin`);
      assertEqual(entry.risk.lossAtStopUsd, null, `${name}: lossAtStopUsd must be null without margin`);
      assertEqual(entry.risk.lossAtStopPct, null, `${name}: lossAtStopPct must be null without margin`);
      assertEqual(entry.risk.lossAtStopPctOfWallet, null, `${name}: lossAtStopPctOfWallet must be null without margin`);
      assertEqual(entry.risk.collateralUsd, null, `${name}: collateralUsd must be null without margin`);
      assertEqual(entry.risk.reason, 'account unavailable', `${name}: expected the account-unavailable reason`);
    }
    assert(sawValid, 'fixture must still produce a valid strategy with the account unavailable');
  });

  await test('attachRisk never invents margin and never touches an invalid strategy', () => {
    const strategies = {
      VALID_ONE: { valid: true, entryZone: { min: 99, max: 101 }, stopLoss: 97 },
      INVALID_ONE: { valid: false, entryZone: { min: null, max: null }, stopLoss: null }
    };
    attachRisk(strategies, { status: 'unavailable', margin: { usd: null } });
    assertEqual(strategies.VALID_ONE.risk.reason, 'account unavailable');
    assertEqual(strategies.VALID_ONE.risk.collateralUsd, null);
    assertEqual(strategies.INVALID_ONE.risk, undefined, 'attachRisk must not add a risk key to an invalid strategy');
  });

  await test('attachRisk sizes against collateralUsd (min of config default and wallet margin), not the whole wallet', () => {
    const bigWallet = {
      VALID_ONE: { valid: true, entryZone: { min: 99, max: 101 }, stopLoss: 97 }
    };
    attachRisk(bigWallet, { status: 'available', margin: { usd: 5000 } });
    assertEqual(bigWallet.VALID_ONE.risk.collateralUsd, ENGINE_CONFIG.risk.defaultMarginUsd, 'collateral must be capped at the config default, not the $5000 wallet');

    const smallWallet = {
      VALID_TWO: { valid: true, entryZone: { min: 99, max: 101 }, stopLoss: 97 }
    };
    attachRisk(smallWallet, { status: 'available', margin: { usd: 3 } });
    assertEqual(smallWallet.VALID_TWO.risk.collateralUsd, 3, 'a wallet smaller than the default must not be inflated to it');
  });

  await test('the wallet-risk cap is measured against the whole wallet, not the small collateral it trades', () => {
    // A large wallet with a very tight (0.1%) stop: if the wallet-risk cap were computed
    // against the small $10 collateral instead of the $5000 wallet, 2% of $10 = $0.20
    // would force leverage down to ~2x. Measured against the real wallet, 2% of $5000
    // is a much larger budget and the stop-distance cap binds instead.
    const strategies = {
      TIGHT: { valid: true, entryZone: { min: 99.95, max: 100.05 }, stopLoss: 99.9 }
    };
    attachRisk(strategies, { status: 'available', margin: { usd: 5000 } });
    const wrongBasisCap = Math.floor(((ENGINE_CONFIG.risk.maxWalletRiskPct / 100) * ENGINE_CONFIG.risk.defaultMarginUsd) / (0.1 / 100 * ENGINE_CONFIG.risk.defaultMarginUsd));
    assert(strategies.TIGHT.risk.suggestedLeverage > wrongBasisCap, `expected the wallet-total basis to allow more leverage than the collateral-only basis (${wrongBasisCap}), got ${strategies.TIGHT.risk.suggestedLeverage}`);
  });

  // -------------------------------------------------------------------------
  // 10) payload controls (filterPayload, buildConfigSnapshot, phase 5)
  // -------------------------------------------------------------------------
  console.log('\n10) payload controls (filterPayload, buildConfigSnapshot, phase 5)');

  await test('buildScalpContext (case 6) carries schemaVersion 1.8.0 and a config snapshot', () => {
    assert(case6Result, 'case 6 result not available');
    assertEqual(case6Result.schemaVersion, '1.8.0', 'schemaVersion must be bumped to 1.8.0');
    assert(case6Result.config && typeof case6Result.config === 'object', 'payload is missing the top-level config snapshot');
    assertEqual(case6Result.config.scalp.maxStopDistancePct, ENGINE_CONFIG.scalp.maxStopDistancePct, 'config.scalp.maxStopDistancePct must mirror ENGINE_CONFIG');
    assertEqual(case6Result.config.risk.maxLeverage, ENGINE_CONFIG.risk.maxLeverage, 'config.risk.maxLeverage must mirror ENGINE_CONFIG');
    assertEqual(case6Result.config.flag.includeFailed, ENGINE_CONFIG.flag.includeFailed, 'config.flag.includeFailed must mirror ENGINE_CONFIG by default');
  });

  await test('buildConfigSnapshot stays within the 600 byte budget (item G)', () => {
    const bytes = Buffer.byteLength(JSON.stringify(buildConfigSnapshot()), 'utf8');
    assert(bytes <= 600, `config snapshot is ${bytes} bytes, exceeds the 600 byte budget`);
  });

  await test('buildConfigSnapshot(includeFailed) reflects the value passed in, not just the static config', () => {
    assertEqual(buildConfigSnapshot(true).flag.includeFailed, true);
    assertEqual(buildConfigSnapshot(false).flag.includeFailed, false);
  });

  await test('INCLUDE_TOKENS is the closed set of valid include values', () => {
    for (const token of ['timeframes', 'strategies', 'candidates', 'geometry', 'account', 'trace', 'config']) {
      assert(INCLUDE_TOKENS.includes(token), `INCLUDE_TOKENS is missing "${token}"`);
    }
  });

  await test('filterFailedCandidateSetups drops state:failed by default, keeps everything with includeFailed:true', () => {
    const setups = [{ state: 'failed', timeframe: '1m' }, { state: 'confirmed', timeframe: '1m' }, { state: 'forming', timeframe: '5m' }];
    const filtered = filterFailedCandidateSetups(setups, false);
    assertEqual(filtered.length, 2, 'includeFailed:false must drop only the failed entry');
    assert(filtered.every((s) => s.state !== 'failed'), 'a failed entry survived includeFailed:false');

    const unfiltered = filterFailedCandidateSetups(setups, true);
    assertEqual(unfiltered.length, 3, 'includeFailed:true must keep every entry, including failed');
    assert(unfiltered === setups || deepEqual(unfiltered, setups), 'includeFailed:true must not drop or reorder anything');
  });

  await test('filterFailedCandidateSetups never mutates its input', () => {
    const setups = [{ state: 'failed' }, { state: 'confirmed' }];
    const before = JSON.stringify(setups);
    filterFailedCandidateSetups(setups, false);
    assertEqual(JSON.stringify(setups), before, 'the input array/objects must be untouched');
  });

  await test('filterPayload({}) is deep-equal to an unfiltered build, key order and all', () => {
    assert(case6Result, 'case 6 result not available');
    const before = JSON.stringify(case6Result);
    const filtered = filterPayload(case6Result, {});
    assertEqual(JSON.stringify(filtered), before, 'filterPayload({}) must be byte-identical to the unfiltered payload');
    assertEqual(JSON.stringify(case6Result), before, 'filterPayload must not mutate its input');
  });

  await test('filterPayload(payload, undefined opts) is also a no-op', () => {
    assert(case6Result, 'case 6 result not available');
    const before = JSON.stringify(case6Result);
    const filtered = filterPayload(case6Result);
    assertEqual(JSON.stringify(filtered), before, 'omitting opts entirely must behave like {}');
  });

  await test('filterPayload never mutates the input payload (symbols/include/compact all set)', () => {
    assert(case6Result, 'case 6 result not available');
    const before = JSON.stringify(case6Result);
    filterPayload(case6Result, { symbols: [HEALTHY_A, 'BOGUS'], include: ['timeframes', 'bogus'], compact: true });
    assertEqual(JSON.stringify(case6Result), before, 'a fully-loaded filter call must not mutate the input');
  });

  await test('filterPayload symbols: narrows to the requested symbol only', () => {
    assert(case6Result, 'case 6 result not available');
    const filtered = filterPayload(case6Result, { symbols: [HEALTHY_A] });
    assertEqual(Object.keys(filtered.symbols).join(','), HEALTHY_A, 'expected only the requested symbol');
  });

  await test('filterPayload symbols: lowercase input still matches (case-insensitive)', () => {
    assert(case6Result, 'case 6 result not available');
    const filtered = filterPayload(case6Result, { symbols: [HEALTHY_A.toLowerCase()] });
    assertEqual(Object.keys(filtered.symbols).join(','), HEALTHY_A, 'a lowercase symbol must still match');
  });

  await test('filterPayload symbols: an unknown symbol is ignored, warned about, never an error', () => {
    assert(case6Result, 'case 6 result not available');
    const filtered = filterPayload(case6Result, { symbols: ['NOPE'] });
    assertEqual(Object.keys(filtered.symbols).sort().join(','), [HEALTHY_A, HEALTHY_B].sort().join(','), 'an all-unknown symbols filter must fall back to the full set');
    assert(filtered.warnings.some((w) => w.includes('NOPE')), 'expected a warning naming the ignored symbol');
    assertEqual(filtered.warnings.length, case6Result.warnings.length + 1, 'exactly one warning line must be added for the ignored symbol');
  });

  await test('filterPayload include: narrows per-symbol sections, core fields survive, top level untouched by default', () => {
    assert(case6Result, 'case 6 result not available');
    const filtered = filterPayload(case6Result, { include: ['strategies'] });
    const sym = filtered.symbols[HEALTHY_A];
    assert(!('timeframes' in sym), 'timeframes must be dropped');
    assert(!('candidateSetups' in sym), 'candidateSetups must be dropped');
    assert(!('decisionTrace' in sym), 'decisionTrace must be dropped');
    assert('strategies' in sym, 'strategies must survive');
    assert('price' in sym && 'source' in sym && 'structure' in sym && 'bestSignal' in sym, 'core identity fields must survive regardless of include');
  });

  await test('filterPayload include: "account" and "config" gate the top-level blocks', () => {
    assert(case6Result, 'case 6 result not available');
    const filtered = filterPayload(case6Result, { include: ['strategies'] });
    assert(!('account' in filtered), 'account must be dropped when include narrows to sections that exclude it');
    assert(!('config' in filtered), 'config must be dropped when include narrows to sections that exclude it');

    const withAccount = filterPayload(case6Result, { include: ['strategies', 'account', 'config'] });
    assert('account' in withAccount, 'account must survive when explicitly included');
    assert('config' in withAccount, 'config must survive when explicitly included');
  });

  await test('filterPayload include: an unknown value is ignored, warned about, and the payload stays full', () => {
    assert(case6Result, 'case 6 result not available');
    const filtered = filterPayload(case6Result, { include: ['bogus'] });
    assert('timeframes' in filtered.symbols[HEALTHY_A], 'an all-unknown include filter must fall back to the full payload');
    assert(filtered.warnings.some((w) => w.includes('bogus')), 'expected a warning naming the ignored include value');
  });

  await test('filterPayload compact: drops candles only, every other timeframe field survives', () => {
    assert(case6Result, 'case 6 result not available');
    const filtered = filterPayload(case6Result, { compact: true });
    for (const tf of timeframesList) {
      const original = case6Result.symbols[HEALTHY_A].timeframes[tf];
      const compacted = filtered.symbols[HEALTHY_A].timeframes[tf];
      assertEqual(compacted.candles.length, 0, `${tf}: compact must drop candles`);
      assertEqual(compacted.ema21, original.ema21, `${tf}: compact must not touch ema21`);
      assertEqual(compacted.trend, original.trend, `${tf}: compact must not touch trend`);
      assertEqual(compacted.stochRsi.k, original.stochRsi.k, `${tf}: compact must not touch stochRsi`);
      assertEqual(compacted.candleCount, original.candleCount, `${tf}: compact must not touch candleCount`);
    }
  });

  // -------------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error in test runner:', err);
  process.exit(1);
});
