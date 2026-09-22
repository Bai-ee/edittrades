/**
 * Deterministic, zero-dependency test suite for:
 *   - services/strategy.js#calculateSLTP
 *   - MICRO_SCALP stop selection + normalization side invariant
 *
 * No network calls. Fixture at fixtures/eth-scalp-sltp.json is a real capture
 * from live ETH data at the moment the "wrong-side stop" bug was reproduced
 * and is read as-is (not regenerated).
 *
 * Run: node test-strategy-sltp.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_SCALP_STOP_DISTANCE_PCT,
  applyScalpStopPolicy,
  calculateSLTP,
  evaluateMicroScalp,
  evaluateStrategy,
  normalizeMicroScalpResult,
  validateScalpStopDistance
} from './services/strategy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Tiny test runner (mirrors test-scalp-context.js style)
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

function assertClose(actual, expected, eps, msg) {
  const e = eps === undefined ? 1e-6 : eps;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > e) {
    throw new Error(msg || `expected ${expected} (+/- ${e}), got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Small deterministic PRNG (mulberry32), same pattern as test-scalp-context.js
// ---------------------------------------------------------------------------

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

const BUFFER = 0.003;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Running test-strategy-sltp.js\n');

  const fixturePath = path.join(__dirname, 'fixtures', 'eth-scalp-sltp.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  // -------------------------------------------------------------------------
  // 1) ETH regression - the real bug
  // -------------------------------------------------------------------------
  console.log('1) ETH regression (real captured fixture)');

  await test('5m and 15m swing lows sit ABOVE entryZoneLong.min (pre-fix behaviour would have failed)', () => {
    assert(
      fixture.structures['5m'].swingLow * (1 - BUFFER) > fixture.entryZoneLong.min,
      `expected buffered 5m swingLow to sit above entryZoneLong.min (the bug this fixture reproduces)`
    );
    assert(
      fixture.structures['15m'].swingLow * (1 - BUFFER) > fixture.entryZoneLong.min,
      `expected buffered 15m swingLow to sit above entryZoneLong.min (the bug this fixture reproduces)`
    );
  });

  await test('calculateSLTP skips 5m/15m (wrong side) and lands on 4h structure', () => {
    const { min, max } = fixture.entryZoneLong;
    const entryMid = (min + max) / 2;

    const result = calculateSLTP(entryMid, 'long', fixture.structures, 'Scalp', [3.0, 4.5], fixture.entryZoneLong);

    assertEqual(result.stopSource, '4h', `expected stopSource '4h', got ${JSON.stringify(result.stopSource)}`);
    assert(result.stopLoss < min, `expected stopLoss (${result.stopLoss}) < entryZoneLong.min (${min})`);
    assertClose(result.stopLoss, fixture.structures['4h'].swingLow * 0.997, 1e-6, `expected stopLoss ~= 4h swingLow * 0.997`);
    assertEqual(result.invalidationLevel, fixture.structures['4h'].swingLow, `expected invalidationLevel to be the raw 4h swingLow`);
    assert(result.riskAmount > 0, `expected positive riskAmount, got ${result.riskAmount}`);

    // targets ascending, both above entry
    assert(result.targets[0] > entryMid, `expected tp1 (${result.targets[0]}) > entry (${entryMid})`);
    assert(result.targets[1] > result.targets[0], `expected tp2 (${result.targets[1]}) > tp1 (${result.targets[0]})`);
  });

  // -------------------------------------------------------------------------
  // 2) Mirrored long/short pairs
  // -------------------------------------------------------------------------
  console.log('\n2) mirrored long/short pairs (Scalp order: 5m -> 15m -> 4h)');

  const ENTRY = 100;
  const BOUNDS = { min: 99, max: 101 };

  await test('2a. first candidate (5m) valid -> stopSource 5m (long)', () => {
    const structures = {
      '5m': { swingLow: 95, swingHigh: 105 },
      '15m': { swingLow: 90, swingHigh: 110 },
      '4h': { swingLow: 80, swingHigh: 120 }
    };
    const result = calculateSLTP(ENTRY, 'long', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, '5m');
    assertClose(result.stopLoss, 95 * 0.997, 1e-9);
    assertEqual(result.invalidationLevel, 95);
  });

  await test('2a. first candidate (5m) valid -> stopSource 5m (short mirror)', () => {
    const structures = {
      '5m': { swingLow: 95, swingHigh: 105 },
      '15m': { swingLow: 90, swingHigh: 110 },
      '4h': { swingLow: 80, swingHigh: 120 }
    };
    const result = calculateSLTP(ENTRY, 'short', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, '5m');
    assertClose(result.stopLoss, 105 * 1.003, 1e-9);
    assertEqual(result.invalidationLevel, 105);
  });

  await test('2b. first (5m) wrong side, second (15m) valid -> stopSource 15m (long)', () => {
    const structures = {
      '5m': { swingLow: 99.5, swingHigh: null },
      '15m': { swingLow: 90, swingHigh: null },
      '4h': { swingLow: 50, swingHigh: null }
    };
    const result = calculateSLTP(ENTRY, 'long', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, '15m');
    assertClose(result.stopLoss, 90 * 0.997, 1e-9);
    assertEqual(result.invalidationLevel, 90);
  });

  await test('2b. first (5m) wrong side, second (15m) valid -> stopSource 15m (short mirror)', () => {
    const structures = {
      '5m': { swingHigh: 100.5, swingLow: null },
      '15m': { swingHigh: 110, swingLow: null },
      '4h': { swingHigh: 150, swingLow: null }
    };
    const result = calculateSLTP(ENTRY, 'short', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, '15m');
    assertClose(result.stopLoss, 110 * 1.003, 1e-9);
    assertEqual(result.invalidationLevel, 110);
  });

  await test('2c. first two (5m, 15m) wrong side, third (4h) valid -> stopSource 4h (long)', () => {
    const structures = {
      '5m': { swingLow: 99.5, swingHigh: null },
      '15m': { swingLow: 99.6, swingHigh: null },
      '4h': { swingLow: 50, swingHigh: null }
    };
    const result = calculateSLTP(ENTRY, 'long', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, '4h');
    assertClose(result.stopLoss, 50 * 0.997, 1e-9);
    assertEqual(result.invalidationLevel, 50);
  });

  await test('2c. first two (5m, 15m) wrong side, third (4h) valid -> stopSource 4h (short mirror)', () => {
    const structures = {
      '5m': { swingHigh: 100.5, swingLow: null },
      '15m': { swingHigh: 100.4, swingLow: null },
      '4h': { swingHigh: 150, swingLow: null }
    };
    const result = calculateSLTP(ENTRY, 'short', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, '4h');
    assertClose(result.stopLoss, 150 * 1.003, 1e-9);
    assertEqual(result.invalidationLevel, 150);
  });

  await test('2d. all candidates wrong side -> percentage fallback, correct side of bounds (long)', () => {
    const structures = {
      '5m': { swingLow: 99.5, swingHigh: null },
      '15m': { swingLow: 99.6, swingHigh: null },
      '4h': { swingLow: 99.7, swingHigh: null }
    };
    const result = calculateSLTP(ENTRY, 'long', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, 'percentage');
    // Anchored at the entry mid, not the zone edge, so the stop sits exactly at the
    // policy distance and stays admissible under validateScalpStopDistance.
    assertClose(result.stopLoss, ENTRY * (1 - MAX_SCALP_STOP_DISTANCE_PCT / 100), 1e-9);
    assert(result.stopLoss < BOUNDS.min, `expected stopLoss (${result.stopLoss}) < bounds.min (${BOUNDS.min})`);
    assertEqual(validateScalpStopDistance(ENTRY, result.stopLoss).valid, true,
      'the percentage fallback must survive the scalp distance gate');
  });

  await test('2d. all candidates wrong side -> percentage fallback, correct side of bounds (short mirror)', () => {
    const structures = {
      '5m': { swingHigh: 100.5, swingLow: null },
      '15m': { swingHigh: 100.4, swingLow: null },
      '4h': { swingHigh: 100.3, swingLow: null }
    };
    const result = calculateSLTP(ENTRY, 'short', structures, 'Scalp', [1, 2], BOUNDS);
    assertEqual(result.stopSource, 'percentage');
    assertClose(result.stopLoss, ENTRY * (1 + MAX_SCALP_STOP_DISTANCE_PCT / 100), 1e-9);
    assert(result.stopLoss > BOUNDS.max, `expected stopLoss (${result.stopLoss}) > bounds.max (${BOUNDS.max})`);
    assertEqual(validateScalpStopDistance(ENTRY, result.stopLoss).valid, true,
      'the percentage fallback must survive the scalp distance gate');
  });

  await test('2e. null/NaN/zero/negative swing levels are skipped in favour of the next valid one (long)', () => {
    const invalidValues = [null, NaN, 0, -10];
    for (const bad of invalidValues) {
      const structures = {
        '5m': { swingLow: bad, swingHigh: null },
        // '15m' intentionally omitted entirely (missing structure)
        '4h': { swingLow: 50, swingHigh: null }
      };
      const result = calculateSLTP(ENTRY, 'long', structures, 'Scalp', [1, 2], BOUNDS);
      assertEqual(result.stopSource, '4h', `bad=${bad}: expected stopSource '4h', got ${JSON.stringify(result.stopSource)}`);
      assertClose(result.stopLoss, 50 * 0.997, 1e-9, `bad=${bad}: unexpected stopLoss ${result.stopLoss}`);
    }
  });

  await test('2e. null/NaN/zero/negative swing levels are skipped in favour of the next valid one (short mirror)', () => {
    const invalidValues = [null, NaN, 0, -10];
    for (const bad of invalidValues) {
      const structures = {
        '5m': { swingHigh: bad, swingLow: null },
        // '15m' intentionally omitted entirely (missing structure)
        '4h': { swingHigh: 150, swingLow: null }
      };
      const result = calculateSLTP(ENTRY, 'short', structures, 'Scalp', [1, 2], BOUNDS);
      assertEqual(result.stopSource, '4h', `bad=${bad}: expected stopSource '4h', got ${JSON.stringify(result.stopSource)}`);
      assertClose(result.stopLoss, 150 * 1.003, 1e-9, `bad=${bad}: unexpected stopLoss ${result.stopLoss}`);
    }
  });

  // -------------------------------------------------------------------------
  // 3) Side invariant holds universally
  // -------------------------------------------------------------------------
  console.log('\n3) side invariant across a generated matrix');

  await test('stopLoss always lands on the correct side of the bounds/entry, riskAmount always positive', () => {
    const rand = mulberry32(1234567);
    const setupTypes = ['Scalp', 'Swing', '4h', 'TrendRider', 'SomeUnknownType'];
    const directions = ['long', 'short'];
    const timeframes = ['3d', '1d', '4h', '15m', '5m'];
    const LAYOUTS = 10;
    const entryPrice = 100;

    let casesRun = 0;

    for (const setupType of setupTypes) {
      for (const direction of directions) {
        for (let layout = 0; layout < LAYOUTS; layout++) {
          for (const useBounds of [false, true]) {
            const structures = {};
            for (const tf of timeframes) {
              // 10% chance the timeframe is entirely absent
              if (rand() < 0.1) continue;

              const r = rand();
              let val;
              if (r < 0.15) val = null;
              else if (r < 0.3) val = NaN;
              else if (r < 0.4) val = 0;
              else if (r < 0.5) val = -(rand() * 100 + 1);
              else val = entryPrice + (rand() - 0.5) * 40; // plausible price, either side of entry

              structures[tf] = { swingLow: val, swingHigh: val };
            }

            const entryBounds = useBounds ? { min: 97, max: 103 } : null;
            const result = calculateSLTP(entryPrice, direction, structures, setupType, [1, 2], entryBounds);
            casesRun++;

            const lowerLimit = entryBounds ? entryBounds.min : entryPrice;
            const upperLimit = entryBounds ? entryBounds.max : entryPrice;
            const ctx = `setupType=${setupType} direction=${direction} layout=${layout} useBounds=${useBounds} stopSource=${result.stopSource}`;

            if (direction === 'long') {
              assert(result.stopLoss < lowerLimit, `long stopLoss ${result.stopLoss} not below lowerLimit ${lowerLimit} [${ctx}]`);
            } else {
              assert(result.stopLoss > upperLimit, `short stopLoss ${result.stopLoss} not above upperLimit ${upperLimit} [${ctx}]`);
            }
            assert(result.riskAmount > 0, `riskAmount not positive: ${result.riskAmount} [${ctx}]`);
          }
        }
      }
    }

    const expectedCases = setupTypes.length * directions.length * LAYOUTS * 2;
    assertEqual(casesRun, expectedCases, `expected to run ${expectedCases} generated cases, ran ${casesRun}`);
  });

  // -------------------------------------------------------------------------
  // 4) Setup-type ordering
  // -------------------------------------------------------------------------
  console.log('\n4) setup-type ordering');

  await test('Swing reads 3d before 1d before 4h', () => {
    const allValid = {
      '3d': { swingLow: 70, swingHigh: null },
      '1d': { swingLow: 80, swingHigh: null },
      '4h': { swingLow: 90, swingHigh: null }
    };
    let result = calculateSLTP(100, 'long', allValid, 'Swing', [1, 2], null);
    assertEqual(result.stopSource, '3d', `expected 3d to win when all valid, got ${result.stopSource}`);

    const skip3d = {
      '3d': { swingLow: 100.5, swingHigh: null }, // wrong side (>= entryPrice fallback of 100)
      '1d': { swingLow: 80, swingHigh: null },
      '4h': { swingLow: 90, swingHigh: null }
    };
    result = calculateSLTP(100, 'long', skip3d, 'Swing', [1, 2], null);
    assertEqual(result.stopSource, '1d', `expected 1d to win when 3d invalid, got ${result.stopSource}`);

    const skip3dAnd1d = {
      '3d': { swingLow: 100.5, swingHigh: null },
      '1d': { swingLow: 100.6, swingHigh: null },
      '4h': { swingLow: 90, swingHigh: null }
    };
    result = calculateSLTP(100, 'long', skip3dAnd1d, 'Swing', [1, 2], null);
    assertEqual(result.stopSource, '4h', `expected 4h to win when 3d and 1d invalid, got ${result.stopSource}`);
  });

  for (const setupType of ['4h', 'TrendRider', 'SomeUnknownType']) {
    await test(`'${setupType}' reads 4h before 1d and ignores 5m/15m entirely (5m would win if consulted)`, () => {
      // 5m is deliberately the most favourable candidate - it must NOT be picked.
      const favourable5m = { swingLow: 50, swingHigh: null };

      const both4hAnd1dValid = {
        '5m': favourable5m,
        '15m': { swingLow: 60, swingHigh: null },
        '4h': { swingLow: 90, swingHigh: null },
        '1d': { swingLow: 80, swingHigh: null }
      };
      let result = calculateSLTP(100, 'long', both4hAnd1dValid, setupType, [1, 2], null);
      assertEqual(result.stopSource, '4h', `expected 4h to win, got ${result.stopSource}`);

      const only1dValid = {
        '5m': favourable5m,
        '15m': { swingLow: 60, swingHigh: null },
        '4h': { swingLow: 100.5, swingHigh: null }, // wrong side, skipped
        '1d': { swingLow: 80, swingHigh: null }
      };
      result = calculateSLTP(100, 'long', only1dValid, setupType, [1, 2], null);
      assertEqual(result.stopSource, '1d', `expected 1d to win when 4h invalid (5m must be ignored), got ${result.stopSource}`);
    });
  }

  // -------------------------------------------------------------------------
  // 5) entryBounds omitted -> validate against entryPrice
  // -------------------------------------------------------------------------
  console.log('\n5) entryBounds omitted (falls back to entryPrice)');

  await test('a swing accepted under the entryPrice fallback would be rejected against a tighter hypothetical zone edge (long)', () => {
    const structures = { '4h': { swingLow: 96, swingHigh: null } }; // candidate = 96 * 0.997 = 95.712

    // No entryBounds -> compared against entryPrice (100) -> accepted.
    const withoutBounds = calculateSLTP(100, 'long', structures, '4h', [1, 2], null);
    assertEqual(withoutBounds.stopSource, '4h', `expected 4h accepted under entryPrice fallback, got ${withoutBounds.stopSource}`);
    assertClose(withoutBounds.stopLoss, 96 * 0.997, 1e-9);

    // Same candidate against a hypothetical tighter zone edge (min: 95) -> rejected -> falls through to percentage.
    const withTighterBounds = calculateSLTP(100, 'long', structures, '4h', [1, 2], { min: 95, max: 105 });
    assertEqual(withTighterBounds.stopSource, 'percentage', `expected candidate rejected against tighter zone edge, got ${withTighterBounds.stopSource}`);
  });

  await test('a swing rejected under the entryPrice fallback (long)', () => {
    const structures = { '4h': { swingLow: 100.5, swingHigh: null } }; // candidate = 100.5 * 0.997 = 100.2015 > 100
    const result = calculateSLTP(100, 'long', structures, '4h', [1, 2], null);
    assertEqual(result.stopSource, 'percentage', `expected candidate rejected against entryPrice fallback, got ${result.stopSource}`);
    assert(result.stopLoss < 100, `expected percentage stop below entryPrice, got ${result.stopLoss}`);
  });

  await test('entryPrice fallback also applies to short direction', () => {
    const acceptedStructures = { '4h': { swingHigh: 104, swingLow: null } }; // candidate = 104 * 1.003 = 104.312 > 100
    const accepted = calculateSLTP(100, 'short', acceptedStructures, '4h', [1, 2], null);
    assertEqual(accepted.stopSource, '4h');
    assertClose(accepted.stopLoss, 104 * 1.003, 1e-9);

    const rejectedStructures = { '4h': { swingHigh: 99.5, swingLow: null } }; // candidate = 99.5 * 1.003 = 99.7985 < 100
    const rejected = calculateSLTP(100, 'short', rejectedStructures, '4h', [1, 2], null);
    assertEqual(rejected.stopSource, 'percentage');
    assert(rejected.stopLoss > 100, `expected percentage stop above entryPrice, got ${rejected.stopLoss}`);
  });

  // -------------------------------------------------------------------------
  // 6) Signal-level integration (validator invariants, asserted directly)
  // -------------------------------------------------------------------------
  console.log('\n6) signal-level integration (validator invariants)');

  await test('produced stop/targets satisfy the repo validator invariants for a long (stopLoss < entryZone.min, tp1 > entryZone.max)', () => {
    const entryZone = fixture.entryZoneLong;
    const entryMid = (entryZone.min + entryZone.max) / 2;
    const result = calculateSLTP(entryMid, 'long', fixture.structures, 'Scalp', [3.0, 4.5], entryZone);

    assert(result.stopLoss < entryZone.min, `validator invariant violated: stopLoss (${result.stopLoss}) >= entryZone.min (${entryZone.min})`);
    assert(result.targets[0] > entryZone.max, `validator invariant violated: tp1 (${result.targets[0]}) <= entryZone.max (${entryZone.max})`);
  });

  await test('produced stop/targets satisfy the repo validator invariants for a short (synthetic case)', () => {
    const entryZone = { min: 98, max: 102 };
    const entryMid = (entryZone.min + entryZone.max) / 2;
    const structures = { '4h': { swingHigh: 110, swingLow: null } };
    const result = calculateSLTP(entryMid, 'short', structures, '4h', [1.0, 2.0], entryZone);

    assert(result.stopLoss > entryZone.max, `validator invariant violated: stopLoss (${result.stopLoss}) <= entryZone.max (${entryZone.max})`);
    assert(result.targets[0] < entryZone.min, `validator invariant violated: tp1 (${result.targets[0]}) >= entryZone.min (${entryZone.min})`);
  });

  await test('SCALP_1H stop-distance gate accepts stops at or inside the 3% limit', () => {
    assertEqual(MAX_SCALP_STOP_DISTANCE_PCT, 3, 'test assumes the engine percentage-stop policy is 3%');
    assertEqual(validateScalpStopDistance(100, 97).valid, true, 'long stop at 3% should pass');
    assertEqual(validateScalpStopDistance(100, 103).valid, true, 'short stop at 3% should pass');
    assertEqual(validateScalpStopDistance(100, 97.01).valid, true, 'long stop inside 3% should pass');
  });

  await test('SCALP_1H stop-distance gate rejects the 6.56% BTC-scale stop and mirrored shorts', () => {
    const long = validateScalpStopDistance(100, 93.44);
    const short = validateScalpStopDistance(100, 106.56);
    assertEqual(long.valid, false, '6.56% long stop should be rejected');
    assertEqual(short.valid, false, '6.56% short stop should be rejected');
    assertClose(long.distancePct, 6.56, 1e-9);
    assertClose(short.distancePct, 6.56, 1e-9);
  });

  await test('SCALP_1H stop-distance gate rejects invalid numeric inputs', () => {
    assertEqual(validateScalpStopDistance(0, 97).valid, false, 'zero entry should be rejected');
    assertEqual(validateScalpStopDistance(100, Number.NaN).valid, false, 'NaN stop should be rejected');
    assertEqual(validateScalpStopDistance(100, -1).valid, false, 'negative stop should be rejected');
  });

  // -------------------------------------------------------------------------
  // 6b) Scalp stop policy through the real call paths
  //
  // These drive evaluateStrategy(sym, data, 'Scalp') and evaluateMicroScalp(data),
  // not applyScalpStopPolicy directly, so removing either production call site
  // (services/strategy.js SCALP_1H / MICRO_SCALP) makes them fail.
  // -------------------------------------------------------------------------
  console.log('\n6b) scalp stop policy through evaluateStrategy + evaluateMicroScalp');

  const PCT = MAX_SCALP_STOP_DISTANCE_PCT / 100;
  const REJECT_RE = /scalp stop distance .* exceeds 3\.00% maximum/;

  /**
   * Minimal multiTimeframeData that satisfies the SCALP_1H guardrails in
   * evaluateStrategy: 1h trending, 1h/15m near the 21 EMA and in the entry zone,
   * and 15m Stoch RSI aligned. Structures carry the stop candidates; the 1h/15m
   * swing on the breakout side is left null so the pullback entry zone is used
   * and the entry geometry stays deterministic.
   */
  function scalpMtf({ isLong, s5, s15, s4h }) {
    const trend = isLong ? 'UPTREND' : 'DOWNTREND';
    const cond = isLong ? 'BULLISH' : 'BEARISH';
    const tf = () => ({
      indicators: {
        price: { current: 100 },
        ema: { ema21: 100, ema200: isLong ? 95 : 105 },
        analysis: { trend, distanceFrom21EMA: 0.2, pullbackState: 'ENTRY_ZONE' },
        stochRSI: { condition: cond, k: isLong ? 40 : 60, d: isLong ? 35 : 65, history: [] }
      },
      structure: { swingHigh: null, swingLow: null },
      candleCount: 100
    });
    const m = { '3d': tf(), '1d': tf(), '4h': tf(), '1h': tf(), '15m': tf(), '5m': tf(), '1m': tf() };
    const side = (level) => (isLong ? { swingHigh: null, swingLow: level } : { swingHigh: level, swingLow: null });
    m['4h'].structure = side(s4h);
    m['15m'].structure = side(s15);
    m['5m'].structure = side(s5);
    return m;
  }

  /** Same idea for evaluateMicroScalp, which reads swings off indicators, not structure. */
  function microMtf({ isLong, s5, s15, s4h }) {
    const trend = isLong ? 'UPTREND' : 'DOWNTREND';
    const stochCond = isLong ? 'OVERSOLD' : 'OVERBOUGHT';
    const k = isLong ? 20 : 85;
    const tf = () => ({
      indicators: {
        trend,
        pullback: { state: 'ENTRY_ZONE', distanceFrom21EMA: 0.1 },
        ema21: 100,
        currentPrice: 100,
        stoch: { condition: stochCond, k, d: k },
        analysis: { trend, distanceFrom21EMA: 0.1, pullbackState: 'ENTRY_ZONE' },
        ema: { ema21: 100, ema200: isLong ? 95 : 105 },
        stochRSI: { condition: stochCond, k, d: k },
        price: { current: 100 }
      },
      structure: { swingHigh: null, swingLow: null },
      candleCount: 100
    });
    const m = { '3d': tf(), '1d': tf(), '4h': tf(), '1h': tf(), '15m': tf(), '5m': tf(), '1m': tf() };
    for (const [tfKey, level] of [['5m', s5], ['15m', s15], ['4h', s4h]]) {
      m[tfKey].indicators.swingLow = isLong ? level : null;
      m[tfKey].indicators.swingHigh = isLong ? null : level;
    }
    return m;
  }

  // 5m/15m levels sit inside the entry zone once buffered, so the selector skips
  // them and only the 4h level is eligible - the shape that produced BTC's 6.5%
  // "1H scalp" stop. The no-structure variant leaves nothing on the correct side.
  const SCALP_CASES = {
    long:  { wide: { s5: 99.95, s15: 99.92, s4h: 94.18 },   tight: { s5: 99.95, s15: 99.92, s4h: 98.196 },  none: { s5: 99.95, s15: 99.92, s4h: 99.90 } },
    short: { wide: { s5: 99.85, s15: 99.88, s4h: 105.79 },  tight: { s5: 99.85, s15: 99.88, s4h: 101.797 }, none: { s5: 99.85, s15: 99.88, s4h: 99.89 } }
  };
  const MICRO_CASES = {
    long:  { wide: { s5: 99.9, s15: 99.85, s4h: 94.2828 },   tight: { s5: 99.9, s15: 99.85, s4h: 98.2949 },   none: { s5: 99.9, s15: 99.85, s4h: 99.8 } },
    short: { wide: { s5: 100.1, s15: 100.15, s4h: 105.6829 }, tight: { s5: 100.1, s15: 100.15, s4h: 101.6949 }, none: { s5: 100.1, s15: 100.15, s4h: 100.12 } }
  };

  for (const dir of ['long', 'short']) {
    const isLong = dir === 'long';

    // ---- SCALP_1H via evaluateStrategy ------------------------------------

    await test(`SCALP_1H (${dir}): evaluateStrategy rejects a ~6% structural stop`, () => {
      const { signal } = evaluateStrategy('TESTUSDT', scalpMtf({ isLong, ...SCALP_CASES[dir].wide }), 'Scalp', 'STANDARD');
      assertEqual(signal.valid, false, 'a 6% scalp stop must not produce a valid signal');
      assertEqual(signal.direction, 'NO_TRADE');
      assertEqual(signal.stopLoss, null, 'a rejected setup must not carry a stop');
      assert(REJECT_RE.test(signal.reason), `expected a stop-distance rejection, got: ${signal.reason}`);
    });

    await test(`SCALP_1H (${dir}): evaluateStrategy accepts a sub-3% structural stop`, () => {
      const { signal } = evaluateStrategy('TESTUSDT', scalpMtf({ isLong, ...SCALP_CASES[dir].tight }), 'Scalp', 'STANDARD');
      assertEqual(signal.valid, true, `a ~2% structural stop must stay tradeable: ${signal.reason}`);
      assertEqual(signal.direction, dir);
      const mid = (signal.entryZone.min + signal.entryZone.max) / 2;
      const distance = validateScalpStopDistance(mid, signal.stopLoss);
      assertEqual(distance.valid, true, `stop ${signal.stopLoss} is ${distance.distancePct}% from entry`);
      assert(distance.distancePct > 1.5 && distance.distancePct < 3,
        `expected a structural stop inside the limit, got ${distance.distancePct}%`);
      assert(isLong ? signal.stopLoss < signal.entryZone.min : signal.stopLoss > signal.entryZone.max,
        'stop must sit beyond the entry zone');
      assert(['5m', '15m', '4h'].includes(signal.stopSource),
        `a structural stop must publish its timeframe as stopSource, got ${JSON.stringify(signal.stopSource)}`);
    });

    await test(`SCALP_1H (${dir}): evaluateStrategy accepts the percentage fallback`, () => {
      const { signal } = evaluateStrategy('TESTUSDT', scalpMtf({ isLong, ...SCALP_CASES[dir].none }), 'Scalp', 'STANDARD');
      assertEqual(signal.valid, true, `the percentage fallback must stay tradeable: ${signal.reason}`);
      const mid = (signal.entryZone.min + signal.entryZone.max) / 2;
      // evaluateStrategy rounds prices on the way out (96.903 -> 96.9), so this
      // compares within the rounding granularity. The edge-anchored fallback this
      // replaced would land at 96.612 here - far outside the tolerance.
      assertClose(signal.stopLoss, isLong ? mid * (1 - PCT) : mid * (1 + PCT), 0.01,
        'the fallback must be anchored at the entry mid, exactly at the policy distance');
      const edgeAnchored = isLong ? signal.entryZone.min * (1 - PCT) : signal.entryZone.max * (1 + PCT);
      assert(Math.abs(signal.stopLoss - edgeAnchored) > 0.1,
        'the fallback must NOT be anchored at the entry-zone edge (the pre-fix behaviour)');
      // signal.valid above is the proof the engine accepted its own fallback: the
      // gate runs on the unrounded stop inside evaluateStrategy. Re-deriving the
      // distance from the rounded output lands a hair over the limit (96.9 vs
      // 96.903 -> 3.003%), so this asserts the published stop is within the policy
      // plus that rounding granularity rather than re-running the gate on it.
      const publishedDistance = validateScalpStopDistance(mid, signal.stopLoss);
      assert(publishedDistance.distancePct <= MAX_SCALP_STOP_DISTANCE_PCT + 0.01,
        `published stop is ${publishedDistance.distancePct}% from entry, beyond the policy`);
      assertEqual(signal.stopSource, 'percentage',
        'a percentage fallback must publish stopSource so a scheduled run can tell it from a structural stop');
    });

    // ---- MICRO_SCALP via evaluateMicroScalp -------------------------------

    await test(`MICRO_SCALP (${dir}): evaluateMicroScalp rejects a ~6% structural stop`, () => {
      const result = evaluateMicroScalp(microMtf({ isLong, ...MICRO_CASES[dir].wide }));
      assertEqual(result.eligible, false, 'a 6% micro-scalp stop must not be eligible');
      assertEqual(result.signal, null, 'a rejected setup must not carry a signal');
      assert(REJECT_RE.test(result.reason), `expected a stop-distance rejection, got: ${result.reason}`);
    });

    await test(`MICRO_SCALP (${dir}): evaluateMicroScalp accepts a sub-3% structural stop`, () => {
      const result = evaluateMicroScalp(microMtf({ isLong, ...MICRO_CASES[dir].tight }));
      assertEqual(result.eligible, true, 'a ~2% structural stop must stay eligible');
      assertEqual(result.signal.valid, true);
      assertEqual(result.signal.stopSource, '4h');
      const distance = validateScalpStopDistance(100, result.signal.stopLoss);
      assert(distance.distancePct > 1.5 && distance.distancePct < 3,
        `expected a structural stop inside the limit, got ${distance.distancePct}%`);
    });

    await test(`MICRO_SCALP (${dir}): evaluateMicroScalp accepts the percentage fallback`, () => {
      const result = evaluateMicroScalp(microMtf({ isLong, ...MICRO_CASES[dir].none }));
      assertEqual(result.eligible, true, 'the percentage fallback must stay eligible');
      assertEqual(result.signal.stopSource, 'percentage');
      // MICRO_SCALP entry is the mean of the 15m and 5m EMA21, both 100 here.
      assertClose(result.signal.stopLoss, isLong ? 100 * (1 - PCT) : 100 * (1 + PCT), 1e-9);
    });
  }

  // ---- policy-level cases that the call paths cannot reach -----------------

  await test('an entry zone wider than the stop policy yields NO_TRADE, not an in-zone stop', () => {
    // The mid-anchored fallback cannot clear a zone this wide, so the policy must
    // refuse rather than place a stop inside the zone it is meant to invalidate.
    const structures = { '5m': { swingLow: 99.95, swingHigh: null }, '15m': { swingLow: 99.92, swingHigh: null }, '4h': { swingLow: 99.9, swingHigh: null } };
    const result = applyScalpStopPolicy(ENTRY, 'long', structures, [3.0, 4.5], { min: 95, max: 105 });
    assertEqual(result.ok, false, 'a zone wider than the stop policy must not produce a signal');
  });

  await test('the fallback distance and the gate limit stay coupled', () => {
    // calculateSLTP builds the scalp fallback at MAX_SCALP_STOP_DISTANCE_PCT. If the
    // two ever diverge, the engine starts rejecting its own fallback silently.
    const structures = { '5m': { swingLow: 99.95, swingHigh: null }, '15m': { swingLow: 99.92, swingHigh: null }, '4h': { swingLow: 99.9, swingHigh: null } };
    const sltp = calculateSLTP(ENTRY, 'long', structures, 'Scalp', [3.0, 4.5], { min: 99.6, max: 100.2 });
    assertEqual(sltp.stopSource, 'percentage');
    const distance = validateScalpStopDistance(ENTRY, sltp.stopLoss);
    assertClose(distance.distancePct, MAX_SCALP_STOP_DISTANCE_PCT, 1e-9);
    assertEqual(distance.valid, true, 'the fallback must sit at, not beyond, the gate limit');
  });

  await test('non-scalp setups keep the original edge-anchored fallback', () => {
    // Only scalps are distance-gated. Swing/4H/TrendRider must be unaffected by the
    // scalp fix, so their fallback stays anchored at the entry-zone edge.
    const bounds = { min: 99, max: 101 };
    const longStructures = { '4h': { swingLow: 99.7, swingHigh: null }, '1d': { swingLow: 99.8, swingHigh: null } };
    for (const setupType of ['4h', 'Swing', 'TrendRider']) {
      const sltp = calculateSLTP(ENTRY, 'long', longStructures, setupType, [1, 2], bounds);
      assertEqual(sltp.stopSource, 'percentage', `${setupType}: expected the percentage fallback`);
      assertClose(sltp.stopLoss, bounds.min * (1 - PCT), 1e-9,
        `${setupType}: fallback must stay anchored at the entry-zone edge`);
    }
  });

  // -------------------------------------------------------------------------
  // 7) MICRO_SCALP stop selection (same side-aware selector, 5m -> 15m -> 4h -> pct)
  // -------------------------------------------------------------------------
  console.log('\n7) MICRO_SCALP stop selection and normalization');

  // MICRO_SCALP entry = avg(15m EMA21, 5m EMA21), zone = +/-0.5%, targets 3R/4R.
  function microStops(entry, direction, structures) {
    const zone = { min: entry * 0.995, max: entry * 1.005 };
    const sltp = calculateSLTP(entry, direction, structures, 'Scalp', [3.0, 4.0], zone);
    return { zone, sltp };
  }

  await test('MICRO_SCALP long: valid 5m low wins and behavior is unchanged', () => {
    const { zone, sltp } = microStops(100, 'long', {
      '5m': { swingLow: 99, swingHigh: 104 },
      '15m': { swingLow: 97, swingHigh: 105 },
      '4h': { swingLow: 90, swingHigh: 112 }
    });
    assertEqual(sltp.stopSource, '5m', 'expected the first candidate (5m) to win');
    assertClose(sltp.stopLoss, 99 * 0.997, 1e-9, 'stop should be the 5m low minus the 0.3% buffer');
    assert(sltp.stopLoss < zone.min, 'long stop must sit below entryZone.min');
    assertClose(sltp.targets[0], 100 + (sltp.riskAmount * 3.0), 1e-9, 'TP1 must stay at 3R');
    assertClose(sltp.targets[1], 100 + (sltp.riskAmount * 4.0), 1e-9, 'TP2 must stay at 4R');
  });

  await test('MICRO_SCALP short: valid 5m high wins and behavior is unchanged', () => {
    const { zone, sltp } = microStops(100, 'short', {
      '5m': { swingLow: 96, swingHigh: 101 },
      '15m': { swingLow: 95, swingHigh: 103 },
      '4h': { swingLow: 88, swingHigh: 110 }
    });
    assertEqual(sltp.stopSource, '5m', 'expected the first candidate (5m) to win');
    assertClose(sltp.stopLoss, 101 * 1.003, 1e-9, 'stop should be the 5m high plus the 0.3% buffer');
    assert(sltp.stopLoss > zone.max, 'short stop must sit above entryZone.max');
    assertClose(sltp.targets[0], 100 - (sltp.riskAmount * 3.0), 1e-9, 'TP1 must stay at 3R');
    assertClose(sltp.targets[1], 100 - (sltp.riskAmount * 4.0), 1e-9, 'TP2 must stay at 4R');
  });

  await test('MICRO_SCALP mirrored wrong-side: 5m on the wrong side falls through to 15m', () => {
    const longCase = microStops(100, 'long', {
      '5m': { swingLow: 101, swingHigh: 104 },   // above the entry zone - wrong side
      '15m': { swingLow: 98, swingHigh: 105 },
      '4h': { swingLow: 90, swingHigh: 112 }
    });
    assertEqual(longCase.sltp.stopSource, '15m', 'long should skip the wrong-side 5m low');
    assert(longCase.sltp.stopLoss < longCase.zone.min, 'long stop must sit below entryZone.min');

    const shortCase = microStops(100, 'short', {
      '5m': { swingLow: 96, swingHigh: 99 },     // below the entry zone - wrong side
      '15m': { swingLow: 95, swingHigh: 102 },
      '4h': { swingLow: 88, swingHigh: 110 }
    });
    assertEqual(shortCase.sltp.stopSource, '15m', 'short should skip the wrong-side 5m high');
    assert(shortCase.sltp.stopLoss > shortCase.zone.max, 'short stop must sit above entryZone.max');
  });

  await test('MICRO_SCALP falls back to 4h when both 5m and 15m are wrong-side', () => {
    const longCase = microStops(100, 'long', {
      '5m': { swingLow: 101, swingHigh: 104 },
      '15m': { swingLow: 100.5, swingHigh: 105 },
      '4h': { swingLow: 92, swingHigh: 112 }
    });
    assertEqual(longCase.sltp.stopSource, '4h', 'long should fall through to the 4h structure');
    assertClose(longCase.sltp.stopLoss, 92 * 0.997, 1e-9, '4h low minus buffer');
    assert(longCase.sltp.stopLoss < longCase.zone.min, 'long stop must sit below entryZone.min');

    const shortCase = microStops(100, 'short', {
      '5m': { swingLow: 96, swingHigh: 99 },
      '15m': { swingLow: 95, swingHigh: 99.5 },
      '4h': { swingLow: 88, swingHigh: 108 }
    });
    assertEqual(shortCase.sltp.stopSource, '4h', 'short should fall through to the 4h structure');
    assertClose(shortCase.sltp.stopLoss, 108 * 1.003, 1e-9, '4h high plus buffer');
    assert(shortCase.sltp.stopLoss > shortCase.zone.max, 'short stop must sit above entryZone.max');
  });

  await test('MICRO_SCALP percentage fallback stays outside the entry zone', () => {
    const longCase = microStops(100, 'long', {
      '5m': { swingLow: 101, swingHigh: 104 },
      '15m': { swingLow: 100.5, swingHigh: 105 },
      '4h': { swingLow: 100.2, swingHigh: 112 }
    });
    assertEqual(longCase.sltp.stopSource, 'percentage', 'no candidate qualifies, expected percentage fallback');
    assert(longCase.sltp.stopLoss < longCase.zone.min, 'percentage long stop must sit below entryZone.min');

    const shortCase = microStops(100, 'short', {
      '5m': { swingLow: 96, swingHigh: 99 },
      '15m': { swingLow: 95, swingHigh: 99.5 },
      '4h': { swingLow: 88, swingHigh: 99.8 }
    });
    assertEqual(shortCase.sltp.stopSource, 'percentage', 'no candidate qualifies, expected percentage fallback');
    assert(shortCase.sltp.stopLoss > shortCase.zone.max, 'percentage short stop must sit above entryZone.max');
  });

  await test('MICRO_SCALP skips null, NaN, zero and negative structure levels', () => {
    const { zone, sltp } = microStops(100, 'long', {
      '5m': { swingLow: null, swingHigh: 104 },
      '15m': { swingLow: Number.NaN, swingHigh: 105 },
      '4h': { swingLow: 93, swingHigh: 112 }
    });
    assertEqual(sltp.stopSource, '4h', 'null/NaN candidates must be skipped');
    assert(sltp.stopLoss < zone.min, 'long stop must sit below entryZone.min');

    const zeroNeg = microStops(100, 'long', {
      '5m': { swingLow: 0, swingHigh: 104 },
      '15m': { swingLow: -5, swingHigh: 105 },
      '4h': { swingLow: 94, swingHigh: 112 }
    });
    assertEqual(zeroNeg.sltp.stopSource, '4h', 'zero/negative candidates must be skipped');
  });

  await test('normalizeMicroScalpResult rejects a wrong-side long stop', () => {
    const bad = normalizeMicroScalpResult({
      valid: true,
      direction: 'long',
      confidence: 70,
      reason: 'fixture',
      entry: { min: 99.5, max: 100.5 },
      stopLoss: 101,                       // above the entry zone - must not survive
      invalidation_level: 101,
      targets: { tp1: 103, tp2: 104 },
      riskReward: { tp1RR: 3, tp2RR: 4 }
    }, 'ETHUSDT');
    assertEqual(bad.valid, false, 'a wrong-side long stop must not normalize to valid=true');
    assertEqual(bad.direction, 'NO_TRADE', 'rejected signal must be NO_TRADE');
    assertEqual(bad.stopLoss, null, 'rejected signal must not expose a stop');
  });

  await test('normalizeMicroScalpResult rejects a wrong-side short stop', () => {
    const bad = normalizeMicroScalpResult({
      valid: true,
      direction: 'short',
      confidence: 70,
      reason: 'fixture',
      entry: { min: 99.5, max: 100.5 },
      stopLoss: 99,                        // below the entry zone - must not survive
      invalidation_level: 99,
      targets: { tp1: 97, tp2: 96 },
      riskReward: { tp1RR: 3, tp2RR: 4 }
    }, 'ETHUSDT');
    assertEqual(bad.valid, false, 'a wrong-side short stop must not normalize to valid=true');
    assertEqual(bad.direction, 'NO_TRADE', 'rejected signal must be NO_TRADE');
  });

  await test('normalizeMicroScalpResult keeps a correct-side signal valid and intact', () => {
    const good = normalizeMicroScalpResult({
      valid: true,
      direction: 'long',
      confidence: 68,
      reason: 'fixture',
      entry: { min: 99.5, max: 100.5 },
      stopLoss: 98.5,
      invalidation_level: 98.8,
      targets: { tp1: 104, tp2: 106 },
      riskReward: { tp1RR: 3, tp2RR: 4 },
      stopSource: '5m'
    }, 'ETHUSDT');
    assertEqual(good.valid, true, 'a correct-side signal must stay valid');
    assertEqual(good.stopLoss, 98.5, 'stop must be preserved unchanged');
    assertEqual(good.stopSource, '5m', 'stopSource must remain available for diagnostics');
    assert(good.stopLoss < good.entryZone.min, 'side invariant must hold on the normalized output');
  });

  await test('normalized MICRO_SCALP output always satisfies the side invariant', () => {
    const entries = [50, 100, 2716.5, 86500];
    for (const entry of entries) {
      for (const direction of ['long', 'short']) {
        for (const layout of [
          { '5m': { swingLow: entry * 0.99, swingHigh: entry * 1.01 } },
          { '5m': { swingLow: entry * 1.02, swingHigh: entry * 0.98 } },   // both wrong-side
          { '5m': { swingLow: null, swingHigh: null }, '4h': { swingLow: entry * 0.9, swingHigh: entry * 1.1 } },
          {}
        ]) {
          const { zone, sltp } = microStops(entry, direction, layout);
          const normalized = normalizeMicroScalpResult({
            valid: true,
            direction,
            confidence: 65,
            reason: 'matrix fixture',
            entry: zone,
            stopLoss: sltp.stopLoss,
            invalidation_level: sltp.invalidationLevel,
            targets: { tp1: sltp.targets[0], tp2: sltp.targets[1] },
            riskReward: { tp1RR: 3, tp2RR: 4 },
            stopSource: sltp.stopSource
          }, 'MATRIX');

          if (normalized.valid) {
            if (direction === 'long') {
              assert(normalized.stopLoss < normalized.entryZone.min,
                `long stop ${normalized.stopLoss} must be below entryZone.min ${normalized.entryZone.min}`);
            } else {
              assert(normalized.stopLoss > normalized.entryZone.max,
                `short stop ${normalized.stopLoss} must be above entryZone.max ${normalized.entryZone.max}`);
            }
          }
          assert(sltp.riskAmount > 0, `riskAmount must stay positive (entry ${entry}, ${direction})`);
        }
      }
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
