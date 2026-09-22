/**
 * Deterministic, zero-network test suite for lib/patternDetector.js (phase 4 of the
 * engine refinement plan).
 *
 * Every long fixture has a short mirror built by reflecting prices around a pivot
 * (test/fixtures/flagFixtures.js `mirror`). Each case asserts the long read, then the
 * same structure with the direction flipped.
 *
 * Run: node test-pattern-detector.js
 */

import { readFileSync } from 'node:fs';
import { ENGINE_CONFIG } from './config/engine.js';
import { detectFlag, detectCandidateSetups } from './lib/patternDetector.js';
import { calculateEMA21 } from './services/indicators.js';
import { buildScalpContext, INTERVAL_MS } from './services/scalpContext.js';
import {
  FIXTURE_PIVOT,
  mirror,
  withTimes,
  regression001,
  wickReclaim,
  acceptanceBelow,
  extendedBreakout,
  noImpulse,
  formingFlag,
  triggeringFlag
} from './test/fixtures/flagFixtures.js';

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
    console.log(`  ✗ ${name}`);
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : String(err);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OUTPUT_KEYS = [
  'type', 'direction', 'state', 'impulseStrength', 'compressionScore', 'flagHigh', 'flagLow',
  'breakoutLevel', 'invalidation', 'ema21Hold', 'confidence', 'chaseRisk'
].sort();

const SHORT_HOLD = { hold: 'hold_below', wick: 'wick_above', acceptance_below: 'acceptance_above' };

function input(candles, stochRsi = null) {
  return { candles, ema21History: calculateEMA21(candles.map((c) => c.close)), stochRsi };
}

/** Detect long on the fixture and short on its mirror; assert they are the same flag. */
function detectBoth(build, stochLong = null) {
  const stochShort = stochLong ? { ...stochLong, slopeK: -stochLong.slopeK } : null;
  const long = detectFlag(input(build(), stochLong), 'long');
  const short = detectFlag(input(mirror(build()), stochShort), 'short');
  return { long, short };
}

function assertMirrored(long, short) {
  assert(long && short, 'both directions must produce a flag');
  assertEqual(JSON.stringify(Object.keys(long).sort()), JSON.stringify(OUTPUT_KEYS), 'long output shape');
  assertEqual(JSON.stringify(Object.keys(short).sort()), JSON.stringify(OUTPUT_KEYS), 'short output shape');
  assertEqual(long.type, 'flag', 'long type');
  assertEqual(short.type, 'flag', 'short type');
  assertEqual(long.direction, 'long', 'long direction');
  assertEqual(short.direction, 'short', 'short direction');
  assertEqual(short.state, long.state, 'state must match across mirror');
  assertEqual(short.ema21Hold, SHORT_HOLD[long.ema21Hold], 'ema21Hold must be the mirrored label');
  assertEqual(short.chaseRisk, long.chaseRisk, 'chaseRisk must match across mirror');
  assertEqual(short.impulseStrength, long.impulseStrength, 'impulseStrength must match across mirror');
  assertEqual(short.compressionScore, long.compressionScore, 'compressionScore must match across mirror');
  assertEqual(short.confidence, long.confidence, 'confidence must match across mirror');
  const tol = 0.02;
  assertClose(short.flagHigh, 2 * FIXTURE_PIVOT - long.flagLow, tol, 'short flagHigh mirrors long flagLow');
  assertClose(short.flagLow, 2 * FIXTURE_PIVOT - long.flagHigh, tol, 'short flagLow mirrors long flagHigh');
  assertClose(short.breakoutLevel, 2 * FIXTURE_PIVOT - long.breakoutLevel, tol, 'short breakoutLevel mirrors long');
  assertClose(short.invalidation, 2 * FIXTURE_PIVOT - long.invalidation, tol, 'short invalidation mirrors long');
  // Direction-specific geometry: long breaks up through the flag high, short down through the flag low.
  assertEqual(long.breakoutLevel, long.flagHigh, 'long breakoutLevel is the flag high');
  assertEqual(long.invalidation, long.flagLow, 'long invalidation is the flag low');
  assertEqual(short.breakoutLevel, short.flagLow, 'short breakoutLevel is the flag low');
  assertEqual(short.invalidation, short.flagHigh, 'short invalidation is the flag high');
}

/** Quiet chop for the timeframes that are not under test, aligned to `now`. */
function quietCandles(interval, count, now) {
  const step = INTERVAL_MS[interval];
  const alignedNow = Math.floor(now / step) * step;
  const firstOpen = alignedNow - count * step;
  const out = [];
  for (let i = 0; i < count; i++) {
    const wobble = ((i * 7919) % 17) - 8;
    const open = FIXTURE_PIVOT + wobble;
    const close = FIXTURE_PIVOT - wobble;
    out.push({
      timestamp: firstOpen + i * step,
      open,
      high: Math.max(open, close) + 5,
      low: Math.min(open, close) - 5,
      close,
      volume: 100,
      closeTime: firstOpen + (i + 1) * step
    });
  }
  return out;
}

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

async function buildWith1m(candles1m) {
  return buildScalpContext({
    symbols: ['BTC'],
    now: NOW,
    fetchCandles: async (pair, interval) => (interval === '1m' ? withTimes(candles1m, NOW) : quietCandles(interval, 300, NOW)),
    fetchAccount: async () => ({ status: 'disabled', margin: { usd: null, byAsset: {} } })
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('\nlib/patternDetector.js\n');

  await test('config: every flag threshold lives in config/engine.json under "flag"', () => {
    const f = ENGINE_CONFIG.flag;
    for (const key of ['minImpulseAtr', 'maxContractionRatio', 'wickToleranceAtr', 'minCandles',
      'atrPeriod', 'maxImpulseCandles', 'maxFlagCandles', 'acceptanceCloses', 'confirmCloses',
      'maxBreakoutAge', 'chaseAtr']) {
      assert(typeof f[key] === 'number' && Number.isFinite(f[key]), `flag.${key} missing or not a number`);
    }
    assertEqual(JSON.stringify(f.timeframes), JSON.stringify(['1m', '3m', '5m']), 'flag.timeframes');
    const w = f.confidence.weights;
    assertClose(w.impulse + w.compression + w.ema21 + w.stoch, 1, 1e-9, 'confidence weights sum to 1');
  });

  await test('one code path: the detector never branches on "long"/"short" outside orient and labels', () => {
    const src = readFileSync(new URL('./lib/patternDetector.js', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const hits = code.split('\n').filter((l) => /===\s*'(long|short)'|'(long|short)'\s*===/.test(l));
    assertEqual(hits.length, 1, `expected exactly one direction comparison (sign), found: ${hits.join(' | ')}`);
  });

  await test('REGRESSION_001_BTC_1M_FLAG: impulse → EMA21 hold → compression → break is confirmed (long + short mirror)', () => {
    const { long, short } = detectBoth(regression001);
    assertMirrored(long, short);
    assertEqual(long.state, 'confirmed', 'state');
    assertEqual(long.ema21Hold, 'hold', 'ema21Hold');
    assertEqual(long.chaseRisk, false, 'chaseRisk');
    assert(long.impulseStrength >= ENGINE_CONFIG.flag.minImpulseAtr, 'impulse meets minImpulseAtr');
  });

  await test('forming → triggering → confirmed is derived from the last candles (long + short mirror)', () => {
    const forming = detectBoth(formingFlag);
    const triggering = detectBoth(triggeringFlag);
    const confirmed = detectBoth(regression001);
    assertMirrored(forming.long, forming.short);
    assertMirrored(triggering.long, triggering.short);
    assertEqual(forming.long.state, 'forming', 'forming state');
    assertEqual(triggering.long.state, 'triggering', 'triggering state');
    assertEqual(confirmed.long.state, 'confirmed', 'confirmed state');
    assertEqual(forming.long.breakoutLevel, confirmed.long.breakoutLevel, 'same flag across the lifecycle');
  });

  await test('wick below EMA21 then reclaim → ema21Hold "wick", candidate survives (short: "wick_above")', () => {
    const { long, short } = detectBoth(wickReclaim);
    assertMirrored(long, short);
    assertEqual(long.ema21Hold, 'wick', 'long ema21Hold');
    assertEqual(short.ema21Hold, 'wick_above', 'short ema21Hold');
    assert(long.state !== 'failed', `a wick must not fail the flag, got ${long.state}`);
  });

  await test('close and hold below EMA21 → "acceptance_below", state failed (short: "acceptance_above")', () => {
    const { long, short } = detectBoth(acceptanceBelow);
    assertMirrored(long, short);
    assertEqual(long.ema21Hold, 'acceptance_below', 'long ema21Hold');
    assertEqual(short.ema21Hold, 'acceptance_above', 'short ema21Hold');
    assertEqual(long.state, 'failed', 'state');
  });

  await test('extended breakout (> chaseAtr × ATR beyond the flag) → chaseRisk true (long + short mirror)', () => {
    const { long, short } = detectBoth(extendedBreakout);
    assertMirrored(long, short);
    assertEqual(long.chaseRisk, true, 'long chaseRisk');
    assertEqual(short.chaseRisk, true, 'short chaseRisk');
  });

  await test('no impulse → empty array, both directions, fixture and mirror', () => {
    assertEqual(detectCandidateSetups(input(noImpulse())).length, 0, 'long-side fixture');
    assertEqual(detectCandidateSetups(input(mirror(noImpulse()))).length, 0, 'mirrored fixture');
  });

  await test('an up-flag yields no short candidate, and its mirror no long candidate', () => {
    for (const build of [regression001, formingFlag, wickReclaim, acceptanceBelow, extendedBreakout]) {
      assertEqual(detectFlag(input(build()), 'short'), null, `${build.name}: short on long fixture`);
      assertEqual(detectFlag(input(mirror(build())), 'long'), null, `${build.name}: long on short mirror`);
    }
  });

  await test('Stoch RSI alignment feeds confidence symmetrically', () => {
    const aligned = detectBoth(regression001, { slopeK: 5 });
    const against = detectBoth(regression001, { slopeK: -5 });
    assertMirrored(aligned.long, aligned.short);
    assertMirrored(against.long, against.short);
    assert(aligned.long.confidence > against.long.confidence, 'rising K must raise long confidence');
  });

  await test('deterministic: same input, same output', () => {
    const a = detectCandidateSetups(input(regression001()));
    const b = detectCandidateSetups(input(regression001()));
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'repeat call');
  });

  await test('guards: unknown direction throws; too few or malformed candles → null', () => {
    let threw = false;
    try { detectFlag(input(regression001()), 'sideways'); } catch { threw = true; }
    assert(threw, 'unknown direction must throw');
    assertEqual(detectFlag({ candles: regression001().slice(0, 10), ema21History: [] }, 'long'), null, 'short series');
    const broken = regression001();
    broken[broken.length - 1] = { ...broken[broken.length - 1], close: NaN };
    assertEqual(detectFlag({ candles: broken, ema21History: [] }, 'long'), null, 'NaN candle');
    assertEqual(detectFlag({ candles: regression001(), ema21History: null }, 'long'), null, 'no EMA21');
  });

  // --- Integration through buildScalpContext ---------------------------------

  for (const [label, candles, direction] of [
    ['long', regression001(), 'long'],
    ['short mirror', mirror(regression001()), 'short']
  ]) {
    await test(`REGRESSION_001 (${label}): 1m candidate survives while SCALP_1H stays NO_TRADE`, async () => {
      const payload = await buildWith1m(candles);
      const btc = payload.symbols.BTC;
      assertEqual(payload.schemaVersion, '1.7.0', 'schemaVersion');
      assert(Array.isArray(btc.candidateSetups), 'candidateSetups must be an array');
      const hit = btc.candidateSetups.find((c) => c.timeframe === '1m' && c.direction === direction);
      assert(hit, `expected a 1m ${direction} candidate, got ${JSON.stringify(btc.candidateSetups)}`);
      assertEqual(hit.state, 'confirmed', 'candidate state');
      assertEqual(btc.strategies.SCALP_1H.valid, false, 'SCALP_1H.valid');
      assertEqual(btc.strategies.SCALP_1H.direction, 'NO_TRADE', 'SCALP_1H.direction');
      assert(!('candidateSetups' in btc.strategies), 'candidates must not leak into strategies');
      assert(btc.decisionTrace.candidateSetups.includes(`1m:${direction}:confirmed`), 'decisionTrace references the candidate');
      for (const c of btc.candidateSetups) {
        assert(ENGINE_CONFIG.flag.timeframes.includes(c.timeframe), `unexpected timeframe ${c.timeframe}`);
      }
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
