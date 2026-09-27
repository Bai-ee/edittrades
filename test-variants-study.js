/**
 * Unit tests for the S2 rule-variants study (scripts/research/variants.js,
 * docs/PROMPT_S2_VARIANTS.md). Pure-function tests only, on synthetic candle paths
 * (mirrored long/short, no lookahead) - a full replay needs history fixtures and is
 * exercised manually via `npm run study:variants`.
 */

import {
  rsiSlopeScore, ema21HoldCategory, recomputeConfidenceRsi, mirrorNearestRoomAhead,
  macdHistogramSign, goldenPocketZone, buildResearchPlan, selectBestAttempt,
  walkTrail1R, rescoreGpEntryRow, statsFor, splitHalvesByMedian, passesOOSByMedian
} from './scripts/research/variants.js';
import { ENGINE_CONFIG } from './config/engine.js';

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
    console.log(`    ${err.stack ? err.stack.split('\n').slice(0, 4).join('\n    ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg || 'not close'}: expected ~${expected}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// synthetic candle builders (no lookahead: every helper below only ever reads
// candles up to the index/time under test)
// ---------------------------------------------------------------------------

/** A flat OHLC candle at `price`, `ts` ms - open=high=low=close so pivot/ATR logic reads one clean number per index. */
function flat(ts, price) {
  return { timestamp: ts, closeTime: ts + 60000, open: price, high: price, low: price, close: price };
}

/**
 * A long-direction swing: a pivot LOW at index 5 (price 100, pivotLeft/Right=3 satisfied
 * by higher neighbors) then a pivot HIGH at index 15 (price 200). Range=100, so the golden
 * pocket (0.618-0.65 retracement from the high) is [135, 138.2]. Index 19 is left open for
 * the caller to set as an entry/retracement candle.
 */
function buildLongSwingCandles() {
  const prices = [150, 150, 150, 150, 150, 100, 105, 110, 115, 130, 140, 150, 160, 170, 180, 200, 195, 190, 185, 138];
  return prices.map((p, i) => flat(i * 60000, p));
}

/** Mirror of buildLongSwingCandles: a pivot HIGH at index 5 (200) then a pivot LOW at index 15 (100). GP zone (short) = [161.8, 165]. */
function buildShortSwingCandles() {
  const prices = [150, 150, 150, 150, 150, 200, 195, 190, 185, 170, 160, 150, 140, 130, 120, 100, 105, 110, 115, 163];
  return prices.map((p, i) => flat(i * 60000, p));
}

/** A monotonic run with no fractal pivot at all - goldenPocketZone must return null (no completed swing yet), never guess one. */
function buildNoPivotCandles() {
  return Array.from({ length: 20 }, (_, i) => flat(i * 60000, 100 + i));
}

/**
 * A flat run (`flatN` candles at `flatPrice`) followed by a clean trend (`trendN` candles
 * moving by `step` each) - a perfectly LINEAR ramp the whole way through makes MACD's line
 * and its own signal line converge to the same slope (histogram -> 0), so the "kink" from
 * flat into a fresh trend is what gives a clean, unambiguous histogram sign at the end.
 */
function buildKinkTrendCandles(flatN, trendN, flatPrice, step) {
  const flatPart = Array.from({ length: flatN }, (_, i) => flat(i * 60000, flatPrice));
  const trendPart = Array.from({ length: trendN }, (_, i) => flat((flatN + i) * 60000, flatPrice + (i + 1) * step));
  return flatPart.concat(trendPart);
}

// ---------------------------------------------------------------------------

(async () => {
  console.log('\n=== S2 variants-study unit tests ===\n');

  // ===== rsiSlopeScore =====
  await test('rsiSlopeScore: rising RSI scores 1 for a long (sign +1)', () => {
    assertEqual(rsiSlopeScore([40, 45], 1), 1);
  });
  await test('rsiSlopeScore: falling RSI scores 0 for a long', () => {
    assertEqual(rsiSlopeScore([45, 40], 1), 0);
  });
  await test('rsiSlopeScore: mirrored for a short (sign -1) - falling RSI supports a short', () => {
    assertEqual(rsiSlopeScore([45, 40], -1), 1);
    assertEqual(rsiSlopeScore([40, 45], -1), 0);
  });
  await test('rsiSlopeScore: insufficient history or flat scores neutral 0.5', () => {
    assertEqual(rsiSlopeScore([50], 1), 0.5);
    assertEqual(rsiSlopeScore(null, 1), 0.5);
    assertEqual(rsiSlopeScore([50, 50], 1), 0.5);
  });

  // ===== ema21HoldCategory =====
  await test('ema21HoldCategory normalizes direction-specific labels', () => {
    assertEqual(ema21HoldCategory('hold'), 'hold');
    assertEqual(ema21HoldCategory('hold_below'), 'hold');
    assertEqual(ema21HoldCategory('wick'), 'wick');
    assertEqual(ema21HoldCategory('wick_above'), 'wick');
    assertEqual(ema21HoldCategory('acceptance_below'), 'acceptance');
    assertEqual(ema21HoldCategory('reclaim'), 'reclaim');
    assertEqual(ema21HoldCategory(null), 'none');
    assertEqual(ema21HoldCategory('bogus'), 'none');
  });

  // ===== recomputeConfidenceRsi =====
  await test('recomputeConfidenceRsi matches the manual weighted formula (long)', () => {
    const cfg = ENGINE_CONFIG;
    const w = cfg.flag.confidence.weights;
    const candidate = { direction: 'long', impulseStrength: cfg.flag.confidence.impulseFullAtr, compressionScore: 1, ema21Hold: 'hold' };
    // impulseTerm=1 (impulseStrength==impulseFullAtr), compressionTerm=1, ema21Term=1 (hold), rsiTerm=1 (rising RSI, long)
    const expected = Math.round(100 * (w.impulse * 1 + w.compression * 1 + w.ema21 * 1 + w.stoch * 1) * 10000) / 10000;
    assertEqual(recomputeConfidenceRsi(candidate, [40, 45], cfg), expected);
  });
  await test('recomputeConfidenceRsi mirrors for a short (falling RSI supports a short)', () => {
    const cfg = ENGINE_CONFIG;
    const w = cfg.flag.confidence.weights;
    const candidate = { direction: 'short', impulseStrength: 0, compressionScore: 0, ema21Hold: 'acceptance_above' };
    // impulseTerm=0, compressionTerm=0, ema21Term=0 (acceptance), rsiTerm=1 (falling RSI, short)
    const expected = Math.round(100 * (w.stoch * 1) * 10000) / 10000;
    assertEqual(recomputeConfidenceRsi(candidate, [45, 40], cfg), expected);
  });

  // ===== mirrorNearestRoomAhead =====
  await test('mirrorNearestRoomAhead: a zone overlapping entry on the OWN geometry hard-blocks (touchesEntry)', () => {
    const own = { horizontalResistanceZones: [{ low: 99, high: 101 }], horizontalSupportZones: [] };
    const r = mirrorNearestRoomAhead('long', 100, 120, {}, own);
    assert(r.touchesEntry === true, 'expected touchesEntry');
  });
  await test('mirrorNearestRoomAhead: nearest edge ahead of entry, short of target, caps TP1 (long)', () => {
    const ctx = { '15m': { horizontalResistanceZones: [{ low: 110, high: 112 }], horizontalSupportZones: [] } };
    const r = mirrorNearestRoomAhead('long', 100, 120, ctx, null);
    assertEqual(r.touchesEntry, false);
    assertEqual(r.nearestEdge, 110);
  });
  await test('mirrorNearestRoomAhead: mirrored for a short (nearest support edge below entry)', () => {
    const ctx = { '15m': { horizontalResistanceZones: [], horizontalSupportZones: [{ low: 88, high: 90 }] } };
    const r = mirrorNearestRoomAhead('short', 100, 80, ctx, null);
    assertEqual(r.touchesEntry, false);
    assertEqual(r.nearestEdge, 90);
  });
  await test('mirrorNearestRoomAhead: no zone ahead returns nearestEdge null', () => {
    const r = mirrorNearestRoomAhead('long', 100, 120, {}, null);
    assertEqual(r.nearestEdge, null);
  });

  // ===== macdHistogramSign =====
  await test('macdHistogramSign: a fresh uptrend (kinked off a flat base) scores +1', () => {
    assertEqual(macdHistogramSign(buildKinkTrendCandles(40, 20, 100, 2)), 1);
  });
  await test('macdHistogramSign: mirrored fresh downtrend scores -1', () => {
    assertEqual(macdHistogramSign(buildKinkTrendCandles(40, 20, 200, -2)), -1);
  });
  await test('macdHistogramSign: insufficient history returns null', () => {
    assertEqual(macdHistogramSign(buildKinkTrendCandles(5, 5, 100, 1)), null);
  });

  // ===== goldenPocketZone =====
  await test('goldenPocketZone (long): 0.618-0.65 retracement of the last completed low->high leg', () => {
    const gp = goldenPocketZone('long', buildLongSwingCandles(), ENGINE_CONFIG);
    assert(gp !== null, 'expected a zone');
    assertClose(gp.low, 135, 0.01);
    assertClose(gp.high, 138.2, 0.01);
  });
  await test('goldenPocketZone (short): mirrored high->low leg', () => {
    const gp = goldenPocketZone('short', buildShortSwingCandles(), ENGINE_CONFIG);
    assert(gp !== null, 'expected a zone');
    assertClose(gp.low, 161.8, 0.01);
    assertClose(gp.high, 165, 0.01);
  });
  await test('goldenPocketZone: no completed swing pair returns null, never guesses one', () => {
    assertEqual(goldenPocketZone('long', buildNoPivotCandles(), ENGINE_CONFIG), null);
  });

  // ===== buildResearchPlan =====
  const baseCandidateLong = {
    candidateId: 'c-long', timeframe: '1m', direction: 'long', chaseRisk: false,
    breakoutLevel: 100, invalidation: 99, measuredTarget: 106,
    firstDetectedAt: new Date(0).toISOString()
  };
  const baseCandidateShort = {
    candidateId: 'c-short', timeframe: '1m', direction: 'short', chaseRisk: false,
    breakoutLevel: 100, invalidation: 101, measuredTarget: 94,
    firstDetectedAt: new Date(0).toISOString()
  };
  const emptyCtx = { geometryContext: {}, historyByTf: { '1m': [flat(0, 100)] }, cutMs: 60000 };

  await test('buildResearchPlan: chaseRisk candidates are rejected outright', () => {
    const r = buildResearchPlan({ ...baseCandidateLong, chaseRisk: true }, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null });
    assertEqual(r, null);
  });
  await test('buildResearchPlan: own stop/room target, grossRR gate (long)', () => {
    // risk=1 (100-99), reward=6 (106-100) -> grossRR=6, clears minRR 2.5
    const r = buildResearchPlan(baseCandidateLong, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null });
    assert(r !== null, 'expected a plan');
    assertEqual(r.entry, 100);
    assertEqual(r.stop, 99);
    assertEqual(r.tp1, 106);
    assertEqual(r.grossRR, 6);
  });
  await test('buildResearchPlan: mirrored for a short', () => {
    const r = buildResearchPlan(baseCandidateShort, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null });
    assert(r !== null, 'expected a plan');
    assertEqual(r.stop, 101);
    assertEqual(r.tp1, 94);
  });
  await test('buildResearchPlan: gross R:R below minRR is rejected', () => {
    const thin = { ...baseCandidateLong, measuredTarget: 100.5 }; // grossRR = 0.5
    const r = buildResearchPlan(thin, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null });
    assertEqual(r, null);
  });
  await test('buildResearchPlan: minNetRR gate rejects when set high, passes when off', () => {
    const strict = buildResearchPlan(baseCandidateLong, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: 50 });
    assertEqual(strict, null);
    const off = buildResearchPlan(baseCandidateLong, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null });
    assert(off !== null, 'expected a plan with the net gate off');
  });
  await test('buildResearchPlan: stopMode nf widens a too-thin stop to max(0.5x ATR15m, 3x direction cost)', () => {
    const thinStopCandidate = { ...baseCandidateLong, invalidation: 99.99, measuredTarget: 130 }; // own stop distance 0.01
    const ctx = { geometryContext: { '15m': { atr: 4 } }, historyByTf: emptyCtx.historyByTf, cutMs: emptyCtx.cutMs };
    const r = buildResearchPlan(thinStopCandidate, ctx, ENGINE_CONFIG, { stopMode: 'nf', targetMode: 'room', minRR: 2.5, minNetRR: 1.0 });
    assert(r !== null, 'expected a plan');
    // atrFloor = 0.5*4=2; costFloor = 3*0.34%*100=1.02 (long); floor=max(2,1.02)=2 > own 0.01 -> stop widens to entry-2=98
    assertEqual(r.stop, 98);
  });
  await test('buildResearchPlan: stopMode nf rejects when ATR(15m) is missing (never guesses)', () => {
    const r = buildResearchPlan(baseCandidateLong, emptyCtx, ENGINE_CONFIG, { stopMode: 'nf', targetMode: 'room', minRR: 2.5, minNetRR: 1.0 });
    assertEqual(r, null);
  });
  await test('buildResearchPlan: stopMode atr1x + targetMode fixedRR fixes grossRR exactly at minRR (mirrored long/short)', () => {
    const ctx = { geometryContext: { '15m': { atr: 2 } }, historyByTf: emptyCtx.historyByTf, cutMs: emptyCtx.cutMs };
    const long = buildResearchPlan(baseCandidateLong, ctx, ENGINE_CONFIG, { stopMode: 'atr1x', targetMode: 'fixedRR', minRR: 2.5, minNetRR: null });
    assertEqual(long.stop, 98); // entry(100) - 1xATR(2)
    assertEqual(long.grossRR, 2.5);
    assertEqual(long.tp1, 105); // 100 + 2*2.5
    const short = buildResearchPlan(baseCandidateShort, ctx, ENGINE_CONFIG, { stopMode: 'atr1x', targetMode: 'fixedRR', minRR: 2.5, minNetRR: null });
    assertEqual(short.stop, 102); // entry(100) + 1xATR(2)
    assertEqual(short.grossRR, 2.5);
    assertEqual(short.tp1, 95); // 100 - 2*2.5
  });
  await test('buildResearchPlan: directionFilter rejects the non-matching direction', () => {
    const r = buildResearchPlan(baseCandidateLong, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, directionFilter: 'short' });
    assertEqual(r, null);
    const keep = buildResearchPlan(baseCandidateShort, emptyCtx, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, directionFilter: 'short' });
    assert(keep !== null, 'short should survive its own filter');
  });
  await test('buildResearchPlan: requireMacdTf accepts agreement and rejects conflict (mirrored)', () => {
    const upTrend = { '1m': buildKinkTrendCandles(40, 20, 100, 2) };
    const downTrend = { '1m': buildKinkTrendCandles(40, 20, 200, -2) };
    const cutMs = 60 * 60000;
    const longAgrees = buildResearchPlan(baseCandidateLong, { geometryContext: {}, historyByTf: upTrend, cutMs }, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, requireMacdTf: 'own' });
    assert(longAgrees !== null, 'long + uptrend MACD should pass');
    const longConflicts = buildResearchPlan(baseCandidateLong, { geometryContext: {}, historyByTf: downTrend, cutMs }, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, requireMacdTf: 'own' });
    assertEqual(longConflicts, null);
    const shortAgrees = buildResearchPlan(baseCandidateShort, { geometryContext: {}, historyByTf: downTrend, cutMs }, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 2.5, minNetRR: null, requireMacdTf: 'own' });
    assert(shortAgrees !== null, 'short + downtrend MACD should pass');
  });
  await test('buildResearchPlan: requireGpFilter accepts a breakout inside the pocket, rejects outside (mirrored)', () => {
    const cutMs = 20 * 60000;
    const longInside = { ...baseCandidateLong, breakoutLevel: 136.5, invalidation: 134, measuredTarget: 200 };
    const rIn = buildResearchPlan(longInside, { geometryContext: {}, historyByTf: { '1m': buildLongSwingCandles() }, cutMs }, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 0.01, minNetRR: null, requireGpFilter: true });
    assert(rIn !== null, 'breakout inside the golden pocket should pass');
    const longOutside = { ...baseCandidateLong, breakoutLevel: 150, invalidation: 147, measuredTarget: 200 };
    const rOut = buildResearchPlan(longOutside, { geometryContext: {}, historyByTf: { '1m': buildLongSwingCandles() }, cutMs }, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 0.01, minNetRR: null, requireGpFilter: true });
    assertEqual(rOut, null);
    const cutMsShort = 20 * 60000;
    const shortInside = { ...baseCandidateShort, breakoutLevel: 163.5, invalidation: 167, measuredTarget: 50 };
    const rShortIn = buildResearchPlan(shortInside, { geometryContext: {}, historyByTf: { '1m': buildShortSwingCandles() }, cutMs: cutMsShort }, ENGINE_CONFIG, { stopMode: 'own', targetMode: 'room', minRR: 0.01, minNetRR: null, requireGpFilter: true });
    assert(rShortIn !== null, 'mirrored short breakout inside the pocket should pass');
  });

  // ===== selectBestAttempt =====
  await test('selectBestAttempt: ready beats conditional beats rejected', () => {
    const best = selectBestAttempt([
      { candidateId: 'a', timeframe: '1m', confidence: 10, status: 'rejected' },
      { candidateId: 'b', timeframe: '1m', confidence: 5, status: 'ready' },
      { candidateId: 'c', timeframe: '1m', confidence: 90, status: 'conditional' }
    ]);
    assertEqual(best.candidateId, 'b');
  });
  await test('selectBestAttempt: ties on status break by confidence desc, then timeframe rank, then candidateId', () => {
    const byConfidence = selectBestAttempt([
      { candidateId: 'x', timeframe: '1m', confidence: 40, status: 'ready' },
      { candidateId: 'y', timeframe: '1m', confidence: 60, status: 'ready' }
    ]);
    assertEqual(byConfidence.candidateId, 'y');
    const byTimeframe = selectBestAttempt([
      { candidateId: 'x', timeframe: '1m', confidence: 50, status: 'ready' },
      { candidateId: 'y', timeframe: '5m', confidence: 50, status: 'ready' }
    ]);
    assertEqual(byTimeframe.candidateId, 'y');
    const byId = selectBestAttempt([
      { candidateId: 'b', timeframe: '1m', confidence: 50, status: 'ready' },
      { candidateId: 'a', timeframe: '1m', confidence: 50, status: 'ready' }
    ]);
    assertEqual(byId.candidateId, 'a');
  });

  // ===== walkTrail1R =====
  function candlesFromPath(path) {
    // path: array of {high, low, close}; timestamps ascending 1m apart from t=0.
    return path.map((p, i) => ({ timestamp: i * 60000, high: p.high, low: p.low, close: p.close }));
  }
  const commonWalk = { fillWindowCandles: 15, maxHoldCandles: 100 };

  await test('walkTrail1R: not filled when entry is never touched', () => {
    const candles1m = candlesFromPath([{ high: 90, low: 85, close: 88 }, { high: 91, low: 86, close: 89 }]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'long', entry: 100, stop: 95, target: 120, ...commonWalk });
    assertEqual(r.status, 'not_filled');
  });
  await test('walkTrail1R: immediate stop-out before ever arming (long)', () => {
    const candles1m = candlesFromPath([
      { high: 100, low: 100, close: 100 }, // fill
      { high: 100, low: 94, close: 95 }    // stops out (stop=95) before any +1R close
    ]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'long', entry: 100, stop: 95, target: 120, ...commonWalk });
    assertEqual(r.status, 'loss');
    assertEqual(r.r, -1);
  });
  await test('walkTrail1R: mirrored immediate stop-out (short)', () => {
    const candles1m = candlesFromPath([
      { high: 100, low: 100, close: 100 },
      { high: 106, low: 100, close: 105 } // stop=105 hit before any +1R close
    ]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'short', entry: 100, stop: 105, target: 80, ...commonWalk });
    assertEqual(r.status, 'loss');
    assertEqual(r.r, -1);
  });
  await test('walkTrail1R: arms at +1R close, trails, locks in a positive R on the pullback (long)', () => {
    // risk=5 (entry 100, stop 95). Candle2 closes at 106 (+1.2R) -> arms, bestClose=106, trailStop=101.
    // Candle3 closes at 110 (+2R) -> bestClose=110, trailStop=105. Candle4 wicks back down through 105 -> stopped at 105 = +1R.
    const candles1m = candlesFromPath([
      { high: 100, low: 100, close: 100 },
      { high: 106, low: 100, close: 106 },
      { high: 110, low: 106, close: 110 },
      { high: 110, low: 104, close: 106 }
    ]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'long', entry: 100, stop: 95, target: 200, ...commonWalk });
    assertEqual(r.status, 'win');
    assertEqual(r.r, 1); // stopped at the trailed level (105), exactly +1R, never gives back more
  });
  await test('walkTrail1R: mirrored trail-and-lock-in (short)', () => {
    // risk=5 (entry 100, stop 105). Candle2 closes at 94 (+1.2R) -> arms, bestClose=94, trailStop=99.
    const candles1m = candlesFromPath([
      { high: 100, low: 100, close: 100 },
      { high: 100, low: 94, close: 94 },
      { high: 100, low: 90, close: 90 },
      { high: 100, low: 88, close: 94 }
    ]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'short', entry: 100, stop: 105, target: 0, ...commonWalk });
    assertEqual(r.status, 'win');
    assert(r.r > 0, 'expected a locked-in positive R, not a full loss');
  });
  await test('walkTrail1R: same-candle stop resolves before target (never a false intrabar win)', () => {
    const candles1m = candlesFromPath([
      { high: 100, low: 100, close: 100 },
      { high: 130, low: 94, close: 96 } // touches both stop(95) and target(120) in one candle
    ]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'long', entry: 100, stop: 95, target: 120, ...commonWalk });
    assertEqual(r.status, 'loss');
  });
  await test('walkTrail1R: a target touch on the fill candle itself never counts (needs a later candle)', () => {
    const candles1m = candlesFromPath([
      { high: 130, low: 100, close: 125 } // fills AND touches target in the same candle
    ]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'long', entry: 100, stop: 95, target: 120, ...commonWalk });
    assert(r.status !== 'win', 'a same-candle fill+target must not count as a win');
  });
  await test('walkTrail1R: timeout marks to market at the final close when neither stop nor target is hit', () => {
    const candles1m = candlesFromPath([
      { high: 100, low: 100, close: 100 },
      { high: 103, low: 99, close: 102 }
    ]);
    const r = walkTrail1R({ candles1m, fromMs: 0, direction: 'long', entry: 100, stop: 95, target: 120, fillWindowCandles: 15, maxHoldCandles: 2 });
    assertEqual(r.status, 'timeout');
    assertClose(r.r, 0.4, 0.001); // (102-100)/5
  });

  // ===== rescoreGpEntryRow =====
  await test('rescoreGpEntryRow: excludes a call when no completed swing exists yet', () => {
    const row = { timeframe: '1m', direction: 'long', firstReadyAt: new Date(19 * 60000).toISOString(), entry: 100, stop: 99, tp1: 106 };
    const historyByTf = { '1m': buildNoPivotCandles() };
    assertEqual(rescoreGpEntryRow(row, historyByTf, ENGINE_CONFIG), null);
  });
  await test('rescoreGpEntryRow: excludes a call whose zone is never touched within 24h', () => {
    // Same swing (low@5=100, high@15=200) but the ready-close candle (index19) sits far
    // above the zone [135, 138.2], and price never comes back down within the search window.
    const swingPrefix = buildLongSwingCandles().slice(0, 19);
    const staysAway = Array.from({ length: 30 }, (_, i) => flat((19 + i) * 60000, 250)); // never dips into the zone
    const historyByTf = { '1m': swingPrefix.concat(staysAway) };
    const row = { timeframe: '1m', direction: 'long', firstReadyAt: new Date(19 * 60000).toISOString(), entry: 100, stop: 99, tp1: 106 };
    assertEqual(rescoreGpEntryRow(row, historyByTf, ENGINE_CONFIG), null);
  });
  await test('rescoreGpEntryRow: fills at the pocket\'s near edge on first touch, keeps stop/TP1', () => {
    const swing = buildLongSwingCandles();
    const touch = Array.from({ length: 10 }, (_, i) => flat((20 + i) * 60000, 137)); // dips into [135, 138.2]
    const historyByTf = { '1m': swing.concat(touch) };
    const row = { timeframe: '1m', direction: 'long', firstReadyAt: new Date(19 * 60000).toISOString(), entry: 100, stop: 130, tp1: 150 };
    const rescored = rescoreGpEntryRow(row, historyByTf, ENGINE_CONFIG);
    assert(rescored !== null, 'expected a rescored row');
    assertEqual(rescored.entry, 138.2); // gp.high, the near/shallow edge for a long
    assertEqual(rescored.stop, 130); // unchanged
    assertEqual(rescored.tp1, 150); // unchanged
  });

  // ===== statsFor / splitHalvesByMedian / passesOOSByMedian =====
  await test('statsFor: median is robust to a single dominating outlier the mean is not', () => {
    const rows = [
      { status: 'win', grossR: 1, netR: 1, stopDistancePct: 1, firstReadyAt: '2026-01-01T00:00:00Z' },
      { status: 'win', grossR: 1, netR: 1, stopDistancePct: 1, firstReadyAt: '2026-01-01T00:00:00Z' },
      { status: 'loss', grossR: -1, netR: -500, stopDistancePct: 0.01, firstReadyAt: '2026-01-01T00:00:00Z' }
    ];
    const s = statsFor(rows);
    assertEqual(s.n, 3);
    assert(s.meanNetR < -160, 'mean should be dragged deeply negative by the outlier');
    assertEqual(s.medianNetR, 1);
  });
  await test('passesOOSByMedian: requires median net R > 0 in BOTH halves', () => {
    const early = { status: 'win', grossR: 1, netR: 1, stopDistancePct: 1, firstReadyAt: '2026-01-01T00:00:00Z' };
    const late = { status: 'loss', grossR: -1, netR: -1, stopDistancePct: 1, firstReadyAt: '2026-01-20T00:00:00Z' };
    const halves = splitHalvesByMedian([early, late], Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-30T00:00:00Z'));
    assertEqual(passesOOSByMedian(halves), false);
    const halvesBothPositive = splitHalvesByMedian([early, { ...early, firstReadyAt: '2026-01-25T00:00:00Z' }], Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-30T00:00:00Z'));
    assertEqual(passesOOSByMedian(halvesBothPositive), true);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('Failures:', failures.join(', '));
    process.exitCode = 1;
  }
})();
