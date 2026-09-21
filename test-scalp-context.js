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
  buildScalpContext
} from './services/scalpContext.js';

import { findSwings, buildStructure } from './lib/structure.js';

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
