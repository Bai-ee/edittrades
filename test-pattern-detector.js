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
import { detectFlag, detectFlagLifecycle, detectCandidateSetups, measuredMoveFor } from './lib/patternDetector.js';
import { snapCandidateLevels, resolveCoils, geometryTimeframeFor } from './lib/patternLifecycle.js';
import { buildQualification, attachQualification } from './lib/candidateQualifier.js';
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
  triggeringFlag,
  invalidationClose,
  staleBreak,
  protoFlag,
  reclaimFlag,
  expiredConfirmed,
  invalidationCloseAged
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
  'breakoutLevel', 'invalidation', 'ema21Hold', 'confidence', 'chaseRisk',
  'poleHeight', 'measuredTarget', 'measuredRR',
  'flagSlope', 'breakoutDistancePct', 'invalidationDistancePct'
].sort();

const SHORT_HOLD = { hold: 'hold_below', wick: 'wick_above', acceptance_below: 'acceptance_above', reclaim: 'reclaim' };

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

  // F1 item 7: cheap geometry, computed on real (not oriented) prices - a mirror
  // reflects the trend, so the slope's sign flips; the mirrored candle values keep the
  // two distance percentages close (not exact: the mirror pivot is not the exact price).
  assert(typeof long.flagSlope === 'number' || long.flagSlope === null, 'long flagSlope present');
  if (long.flagSlope !== null) assertClose(short.flagSlope, -long.flagSlope, 0.05, 'short flagSlope mirrors (sign flips)');
  assertClose(short.breakoutDistancePct, -long.breakoutDistancePct, 0.05, 'short breakoutDistancePct mirrors');
  assertClose(short.invalidationDistancePct, -long.invalidationDistancePct, 0.05, 'short invalidationDistancePct mirrors');
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


// --- Phase 9 helpers ---------------------------------------------------------

/** Lifecycle read, long on the fixture and short on its mirror. */
function lifecycleBoth(build) {
  return {
    long: detectFlagLifecycle(input(build()), 'long'),
    short: detectFlagLifecycle(input(mirror(build())), 'short')
  };
}

const reflect = (p) => 2 * FIXTURE_PIVOT - p;

/** A geometryContext-shaped object carrying only the snappable levels. */
function geometryWith({ zones = [], diagonals = [], confluence = [] }) {
  return {
    confidence: 100,
    horizontalSupportZones: zones,
    horizontalResistanceZones: [],
    diagonalSupport: diagonals[0] !== undefined ? { detected: true, currentLevel: diagonals[0] } : { detected: false },
    diagonalResistance: diagonals[1] !== undefined ? { detected: true, currentLevel: diagonals[1] } : { detected: false },
    confluenceZones: confluence
  };
}

/** The same geometry reflected around the fixture pivot (zone edges swap). */
function mirrorGeometry({ zones = [], diagonals = [], confluence = [] }) {
  const flip = (z) => ({ low: reflect(z.high), high: reflect(z.low) });
  return geometryWith({
    zones: zones.map(flip),
    diagonals: [diagonals[1], diagonals[0]].map((d) => (d === undefined ? undefined : reflect(d))),
    confluence: confluence.map(flip)
  });
}

function flagCandidate(timeframe, overrides) {
  return { timeframe, type: 'flag', confidence: 50, durationCandles: 4, levelSource: { breakout: 'flag', invalidation: 'flag' }, ...overrides };
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

  await test('F1 item 1: proto - impulse qualifies, 1 or 2 pullback candles, no entry call (long + short mirror)', () => {
    for (const n of [1, 2]) {
      const { long, short } = detectBoth(() => protoFlag(n));
      assertMirrored(long, short);
      assertEqual(long.state, 'proto', `${n}-candle pullback: long state`);
      assertEqual(short.state, 'proto', `${n}-candle pullback: short state`);
      assertEqual(long.chaseRisk, false, 'proto has no entry call, chaseRisk false');
    }
  });

  await test('F1 item 3: EMA21 reclaim within reclaimCandles keeps the flag alive, ema21Hold "reclaim" (long + short mirror)', () => {
    const { long, short } = detectBoth(reclaimFlag);
    assertMirrored(long, short);
    assertEqual(long.ema21Hold, 'reclaim', 'long ema21Hold');
    assertEqual(short.ema21Hold, 'reclaim', 'short ema21Hold');
    assert(long.state !== 'failed', `a timely reclaim must not fail the flag, got ${long.state}`);
    // Acceptance-fail is unchanged: reclaiming once does not excuse a later acceptance.
    assertEqual(detectFlag(input(acceptanceBelow()), 'long').ema21Hold, 'acceptance_below', 'acceptance still wins over any reclaim label');
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

  await test('measured move (quick pass Q1): poleHeight/measuredTarget/measuredRR are internally consistent and mirror; coils carry none of them', () => {
    const { long, short } = detectBoth(regression001);
    assert(typeof long.poleHeight === 'number' && long.poleHeight > 0, 'poleHeight present and positive');
    assertClose(long.measuredTarget, long.breakoutLevel + long.poleHeight, 1e-9, 'long measuredTarget = breakout + poleHeight');
    const expectedLongRR = Math.round((Math.abs(long.measuredTarget - long.breakoutLevel) / Math.abs(long.breakoutLevel - long.invalidation)) * 100) / 100;
    assertEqual(long.measuredRR, expectedLongRR, 'long measuredRR');
    assertClose(short.measuredTarget, short.breakoutLevel - short.poleHeight, 1e-9, 'short measuredTarget = breakout - poleHeight');
    assertClose(short.poleHeight, long.poleHeight, 0.05, 'poleHeight mirrors');
    assertEqual(short.measuredRR, long.measuredRR, 'measuredRR identical across the mirror');
    assertClose(short.measuredTarget, 2 * FIXTURE_PIVOT - long.measuredTarget, 0.1, 'measuredTarget mirrors around the fixture pivot');

    const bull = flagCandidate('1m', { direction: 'long', state: 'forming', flagHigh: 110, flagLow: 100, breakoutLevel: 110, invalidation: 100, poleHeight: 20, measuredTarget: 130, measuredRR: 1.5, confidence: 55, durationCandles: 6 });
    const bear = flagCandidate('1m', { direction: 'short', state: 'forming', flagHigh: 111, flagLow: 102, breakoutLevel: 102, invalidation: 111, poleHeight: 18, measuredTarget: 84, measuredRR: 1.3, confidence: 62, durationCandles: 4 });
    const coil = resolveCoils([bull, bear])[0];
    assertEqual(coil.type, 'coil', 'coil type');
    for (const k of ['poleHeight', 'measuredTarget', 'measuredRR']) assert(!(k in coil), `coil must not carry ${k}`);
  });

  await test('measured move (2026-09-23 follow-up item 2): poleHeight/measuredTarget carry no float noise, long and mirrored short', () => {
    const { long, short } = detectBoth(regression001);
    const clean2dp = (v) => Math.round(v * 100) / 100 === v;
    assert(clean2dp(long.poleHeight), `long.poleHeight has float noise: ${long.poleHeight}`);
    assert(clean2dp(long.measuredTarget), `long.measuredTarget has float noise: ${long.measuredTarget}`);
    assert(clean2dp(short.poleHeight), `short.poleHeight has float noise: ${short.poleHeight}`);
    assert(clean2dp(short.measuredTarget), `short.measuredTarget has float noise: ${short.measuredTarget}`);
    // measuredMoveFor's own output, called again after a geometry snap (as scalpContext.js does).
    const snapped = measuredMoveFor({ breakoutLevel: 100385.07572138119, invalidation: 99999.66881508446, poleHeight: 388.6999999999971, sign: 1 });
    assert(clean2dp(snapped.measuredTarget), `snapped measuredTarget has float noise: ${snapped.measuredTarget}`);
  });

  await test('measured move: recomputing from a snapped breakoutLevel (measuredMoveFor) matches the direct formula, both directions', () => {
    const long = measuredMoveFor({ breakoutLevel: 112, invalidation: 100, poleHeight: 20, sign: 1 });
    assertEqual(long.measuredTarget, 132, 'long target from a snapped (moved) breakout level');
    assertEqual(long.measuredRR, Math.round((20 / 12) * 100) / 100, 'long RR from the snapped level');
    const short = measuredMoveFor({ breakoutLevel: 98, invalidation: 110, poleHeight: 20, sign: -1 });
    assertEqual(short.measuredTarget, 78, 'short target from a snapped breakout level');
    assertEqual(short.measuredRR, Math.round((20 / 12) * 100) / 100, 'short RR mirrors');
    assertEqual(measuredMoveFor({ breakoutLevel: 100, invalidation: 100, poleHeight: 20, sign: 1 }).measuredRR, null, 'zero denominator -> null RR');
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


  // --- Phase 9: lifecycle ------------------------------------------------------

  await test('phase 9: every phase 4 fixture keeps its state through the lifecycle read, levelSource "flag" with no geometry', () => {
    for (const build of [regression001, formingFlag, triggeringFlag, wickReclaim, acceptanceBelow, extendedBreakout]) {
      for (const [dir, candles] of [['long', build()], ['short', mirror(build())]]) {
        const flag = detectFlag(input(candles), dir);
        const life = detectFlagLifecycle(input(candles), dir);
        assert(flag && life, `${build.name} ${dir}: both reads must find the flag`);
        assertEqual(life.candidate.state, flag.state, `${build.name} ${dir}: state`);
        for (const k of Object.keys(flag)) assertEqual(life.candidate[k], flag[k], `${build.name} ${dir}: ${k} unchanged`);
        const snapped = snapCandidateLevels({ timeframe: '1m', ...life.candidate }, null, life.atr);
        assertEqual(JSON.stringify(snapped.levelSource), JSON.stringify({ breakout: 'flag', invalidation: 'flag' }), `${build.name} ${dir}: levelSource`);
        assertEqual(snapped.breakoutLevel, flag.breakoutLevel, `${build.name} ${dir}: breakoutLevel`);
        assertEqual(snapped.invalidation, flag.invalidation, `${build.name} ${dir}: invalidation`);
      }
    }
  });

  await test('phase 9: durationCandles and ageCandles count on a scripted forming → triggering → confirmed sequence (long + short)', () => {
    const full = regression001();
    const reads = [3, 2, 1, 0].map((cut) => {
      const candles = full.slice(0, full.length - cut);
      return { long: detectFlagLifecycle(input(candles), 'long').candidate, short: detectFlagLifecycle(input(mirror(candles)), 'short').candidate };
    });
    assertEqual(reads.map((r) => r.long.state).join(','), 'forming,forming,triggering,confirmed', 'states');
    for (let i = 1; i < reads.length; i++) {
      assertEqual(reads[i].long.durationCandles, reads[i - 1].long.durationCandles + 1, `duration grows one per candle (step ${i})`);
    }
    assertEqual(reads[0].long.ageCandles, undefined, 'forming has no ageCandles');
    assertEqual(reads[1].long.ageCandles, undefined, 'forming has no ageCandles');
    assertEqual(reads[2].long.ageCandles, 0, 'break candle is the last candle → age 0');
    assertEqual(reads[3].long.ageCandles, 1, 'one candle after the break → age 1');
    for (const r of reads) {
      assertEqual(r.short.state, r.long.state, 'short state mirrors');
      assertEqual(r.short.durationCandles, r.long.durationCandles, 'short duration mirrors');
      assertEqual(r.short.ageCandles, r.long.ageCandles, 'short age mirrors');
      assertEqual(r.long.failReason, undefined, 'no failReason unless failed');
    }
  });

  await test('phase 9: every failReason is reachable (acceptance_below/above, invalidation_close, stale), long + short', () => {
    const cases = [
      [acceptanceBelow, 'acceptance_below', 'acceptance_above'],
      [invalidationClose, 'invalidation_close', 'invalidation_close'],
      [staleBreak, 'stale', 'stale']
    ];
    for (const [build, longReason, shortReason] of cases) {
      const { long, short } = lifecycleBoth(build);
      assertEqual(long.candidate.state, 'failed', `${build.name}: long state`);
      assertEqual(short.candidate.state, 'failed', `${build.name}: short state`);
      assertEqual(long.candidate.failReason, longReason, `${build.name}: long failReason`);
      assertEqual(short.candidate.failReason, shortReason, `${build.name}: short failReason`);
      assertEqual(long.candidate.ageCandles, undefined, `${build.name}: failed has no ageCandles`);
      assert(Number.isInteger(long.candidate.durationCandles), `${build.name}: durationCandles`);
    }
    // stale is a lifecycle read only: the phase 4 detector still calls that window triggering.
    assertEqual(detectFlag(input(staleBreak()), 'long').state, 'triggering', 'detectFlag unchanged on the stale window');
  });

  await test('F1 item 5: a confirmed flag past maxBreakoutAge reads expired with chaseRisk true, then disappears past expiredTtlCandles (long + short mirror)', () => {
    const cfg = ENGINE_CONFIG.flag;
    const withinTtl = cfg.maxBreakoutAge + Math.floor(cfg.expiredTtlCandles / 2);
    const pastTtl = cfg.maxBreakoutAge + cfg.expiredTtlCandles + 1;
    for (const [dir, build] of [['long', () => expiredConfirmed(withinTtl)], ['short', () => mirror(expiredConfirmed(withinTtl))]]) {
      const flag = detectFlag(input(build()), dir);
      assert(flag, `${dir}: expected a candidate within the expired TTL`);
      assertEqual(flag.state, 'expired', `${dir}: state`);
      assertEqual(flag.chaseRisk, true, `${dir}: expired always carries chaseRisk`);
    }
    assertEqual(detectFlag(input(expiredConfirmed(pastTtl)), 'long'), null, 'long: gone past maxBreakoutAge + expiredTtlCandles');
    assertEqual(detectFlag(input(mirror(expiredConfirmed(pastTtl))), 'short'), null, 'short mirror: gone past the same TTL');
  });

  // --- Phase 9: geometry snap --------------------------------------------------

  await test('phase 9: invalidation and breakout snap outward to zone edges within snapTolAtr, levelSource "zone" (long + short mirror)', () => {
    const { long, short } = lifecycleBoth(regression001);
    const atr = long.atr;
    const tol = ENGINE_CONFIG.lifecycle.snapTolAtr * atr;
    const lc = long.candidate;
    const spec = { zones: [
      { low: lc.invalidation - 0.4 * tol, high: lc.invalidation + 0.1 * tol },
      { low: lc.breakoutLevel + 0.3 * tol, high: lc.breakoutLevel + 2 * tol }
    ] };
    const snappedLong = snapCandidateLevels({ timeframe: '1m', ...lc }, geometryWith(spec), atr);
    assertClose(snappedLong.invalidation, lc.invalidation - 0.4 * tol, 1e-6, 'long invalidation → zone edge beyond the flag low (the edge inside the flag is skipped)');
    assertClose(snappedLong.breakoutLevel, lc.breakoutLevel + 0.3 * tol, 1e-6, 'long breakout → nearest zone edge above');
    assertEqual(JSON.stringify(snappedLong.levelSource), JSON.stringify({ breakout: 'zone', invalidation: 'zone' }), 'long levelSource');

    const snappedShort = snapCandidateLevels({ timeframe: '1m', ...short.candidate }, mirrorGeometry(spec), short.atr);
    assertClose(snappedShort.invalidation, reflect(snappedLong.invalidation), 0.02, 'short invalidation mirrors');
    assertClose(snappedShort.breakoutLevel, reflect(snappedLong.breakoutLevel), 0.02, 'short breakout mirrors');
    assertEqual(JSON.stringify(snappedShort.levelSource), JSON.stringify(snappedLong.levelSource), 'short levelSource mirrors');
    assertEqual(snappedShort.state, short.candidate.state, 'state unchanged by snapping');
  });

  await test('phase 9: diagonal and confluence sources are recorded; equal distance prefers confluence', () => {
    const { long } = lifecycleBoth(regression001);
    const lc = long.candidate;
    const tol = ENGINE_CONFIG.lifecycle.snapTolAtr * long.atr;
    const diag = snapCandidateLevels({ timeframe: '1m', ...lc }, geometryWith({ diagonals: [lc.invalidation - 0.5 * tol] }), long.atr);
    assertEqual(diag.levelSource.invalidation, 'diagonal', 'diagonal support snaps invalidation');
    assertEqual(diag.levelSource.breakout, 'flag', 'nothing near the breakout');
    const both = snapCandidateLevels({ timeframe: '1m', ...lc }, geometryWith({
      zones: [{ low: lc.breakoutLevel + 0.5 * tol, high: lc.breakoutLevel + 3 * tol }],
      confluence: [{ low: lc.breakoutLevel + 0.5 * tol, high: lc.breakoutLevel + 3 * tol }]
    }), long.atr);
    assertEqual(both.levelSource.breakout, 'confluence', 'confluence wins a tie');
  });

  await test('phase 9: nothing within tolerance (or only on the wrong side) keeps the flag levels, levelSource "flag" (long + short)', () => {
    const { long, short } = lifecycleBoth(regression001);
    const lc = long.candidate;
    const tol = ENGINE_CONFIG.lifecycle.snapTolAtr * long.atr;
    const spec = { zones: [
      { low: lc.invalidation - 3 * tol, high: lc.invalidation - 1.5 * tol },
      { low: lc.breakoutLevel + 1.5 * tol, high: lc.breakoutLevel + 4 * tol }
    ] };
    for (const [c, g, atr] of [[lc, geometryWith(spec), long.atr], [short.candidate, mirrorGeometry(spec), short.atr]]) {
      const out = snapCandidateLevels({ timeframe: '1m', ...c }, g, atr);
      assertEqual(out.breakoutLevel, c.breakoutLevel, `${c.direction}: breakout kept`);
      assertEqual(out.invalidation, c.invalidation, `${c.direction}: invalidation kept`);
      assertEqual(JSON.stringify(out.levelSource), JSON.stringify({ breakout: 'flag', invalidation: 'flag' }), `${c.direction}: levelSource`);
    }
    // A level above the breakout is never an invalidation, even when it is the nearest.
    const wrongSide = snapCandidateLevels({ timeframe: '1m', ...lc, invalidation: lc.breakoutLevel - 0.1 * tol },
      geometryWith({ diagonals: [undefined, lc.breakoutLevel + 0.05 * tol] }), long.atr);
    assertEqual(wrongSide.levelSource.invalidation, 'flag', 'wrong-side level ignored for invalidation');
    // Levels inside the flag never tighten either edge.
    const inside = snapCandidateLevels({ timeframe: '1m', ...lc }, geometryWith({ zones: [
      { low: lc.invalidation + 0.05 * tol, high: lc.breakoutLevel - 0.05 * tol }
    ] }), long.atr);
    assertEqual(JSON.stringify(inside.levelSource), JSON.stringify({ breakout: 'flag', invalidation: 'flag' }), 'inside-flag levels ignored');
  });

  await test('phase 9: geometryTimeframeFor maps 1m/3m/5m to 15m and keeps a geometry timeframe as itself', () => {
    for (const tf of ['1m', '3m', '5m']) assertEqual(geometryTimeframeFor(tf), '15m', tf);
    for (const tf of ['15m', '1h', '4h']) assertEqual(geometryTimeframeFor(tf), tf, tf);
  });

  // --- Phase 9: coil -------------------------------------------------------------

  await test('phase 9: an overlapping bull + bear forming pair becomes one neutral coil', () => {
    const bull = flagCandidate('1m', { direction: 'long', state: 'forming', flagHigh: 110, flagLow: 100, breakoutLevel: 110, invalidation: 100, confidence: 55, durationCandles: 6 });
    const bear = flagCandidate('1m', { direction: 'short', state: 'forming', flagHigh: 111, flagLow: 102, breakoutLevel: 102, invalidation: 111, confidence: 62, durationCandles: 4 });
    const out = resolveCoils([bull, bear]);
    assertEqual(out.length, 1, 'one coil replaces the pair');
    const coil = out[0];
    assertEqual(coil.type, 'coil', 'type');
    assertEqual(coil.direction, 'neutral', 'direction');
    assertEqual(coil.state, 'forming', 'state');
    assertEqual(coil.high, 111, 'high = widest');
    assertEqual(coil.low, 100, 'low = widest');
    assertEqual(coil.breakoutLevelUp, 110, 'up = bull breakout');
    assertEqual(coil.breakoutLevelDown, 102, 'down = bear breakout');
    assertEqual(coil.durationCandles, 6, 'duration = the older side');
    assertEqual(coil.confidence, 62, 'confidence = the stronger side');
    // Order does not matter.
    assertEqual(JSON.stringify(resolveCoils([bear, bull])), JSON.stringify(out), 'bear-first input gives the same coil');
  });

  await test('phase 9: coil resolves when one side triggers (either side); non-overlapping or settled pairs are untouched', () => {
    const bull = flagCandidate('1m', { direction: 'long', state: 'forming', flagHigh: 110, flagLow: 100, breakoutLevel: 110, invalidation: 100 });
    const bear = flagCandidate('1m', { direction: 'short', state: 'forming', flagHigh: 111, flagLow: 102, breakoutLevel: 102, invalidation: 111 });
    const upBreak = resolveCoils([{ ...bull, state: 'triggering' }, bear]);
    assertEqual(upBreak.length, 1, 'long triggers → one candidate');
    assertEqual(upBreak[0].direction, 'long', 'long kept');
    const downBreak = resolveCoils([bull, { ...bear, state: 'triggering' }]);
    assertEqual(downBreak.length, 1, 'short triggers → one candidate');
    assertEqual(downBreak[0].direction, 'short', 'short kept');
    const apart = resolveCoils([bull, { ...bear, flagHigh: 130, flagLow: 120 }]);
    assertEqual(apart.length, 2, 'no overlap → both flags stay');
    const settled = resolveCoils([{ ...bull, state: 'confirmed' }, bear]);
    assertEqual(settled.length, 2, 'confirmed + forming is not a coil case');
  });

  // --- Integration through buildScalpContext ---------------------------------

  for (const [label, candles, direction] of [
    ['long', regression001(), 'long'],
    ['short mirror', mirror(regression001()), 'short']
  ]) {
    await test(`REGRESSION_001 (${label}): 1m candidate survives while SCALP_1H stays NO_TRADE`, async () => {
      const payload = await buildWith1m(candles);
      const btc = payload.symbols.BTC;
      assertEqual(payload.schemaVersion, '1.17.0', 'schemaVersion');
      assert(Array.isArray(btc.candidateSetups), 'candidateSetups must be an array');
      const hit = btc.candidateSetups.find((c) => c.timeframe === '1m' && c.direction === direction);
      assert(hit, `expected a 1m ${direction} candidate, got ${JSON.stringify(btc.candidateSetups)}`);
      assertEqual(hit.state, 'confirmed', 'candidate state');
      assertEqual(btc.strategies.SCALP_1H.valid, false, 'SCALP_1H.valid');
      assertEqual(btc.strategies.SCALP_1H.direction, 'NO_TRADE', 'SCALP_1H.direction');
      assert(!('candidateSetups' in btc.strategies), 'candidates must not leak into strategies');
      assert(btc.decisionTrace.candidateSetups.includes(`1m:${direction}:confirmed`), 'decisionTrace references the candidate');
      assert(hit.levelSource && typeof hit.levelSource.breakout === 'string' && typeof hit.levelSource.invalidation === 'string', 'levelSource recorded (phase 9)');
      assertEqual(hit.ageCandles, 1, 'ageCandles (phase 9)');
      assert(Number.isInteger(hit.durationCandles), 'durationCandles (phase 9)');
      // F1 item 6: stable identity. impulseStart/impulseEnd are not separately published
      // (byte budget, item 9 - see lib/patternLifecycle.js identifyCandidate): impulseStart
      // is candidateId's own last colon-segment; impulseEnd is firstDetectedAt minus one
      // candle of the timeframe.
      assert(!Number.isNaN(Date.parse(hit.firstDetectedAt)), 'firstDetectedAt is a time (F1 item 6)');
      const impulseStartFromId = hit.candidateId.split(':').slice(3).join(':');
      assertEqual(hit.candidateId, `BTC:1m:${direction}:${impulseStartFromId}`, 'candidateId shape (F1 item 6)');
      assert(!Number.isNaN(Date.parse(impulseStartFromId)), 'candidateId embeds a valid impulseStart time');
      assert(Date.parse(impulseStartFromId) <= Date.parse(hit.firstDetectedAt), 'impulseStart at or before firstDetectedAt');
      assert(!('impulseStart' in hit) && !('impulseEnd' in hit), 'impulseStart/impulseEnd are not separately published (byte budget)');
      assert(!('impulseStartCandlesAgo' in hit) && !('failedAtCandlesAgo' in hit), 'internal candle-count offsets are stripped');
      // F1 item 8: qual attached, never changing the candidate's own fields.
      assert(hit.qual && ['low', 'med', 'high'].includes(hit.qual.quality), 'qual.quality (F1 item 8)');
      assert(['watch', 'wait', 'dont', 'actionable'].includes(hit.qual.decision), 'qual.decision (F1 item 8)');
      assert(Array.isArray(hit.qual.reasons), 'qual.reasons (F1 item 8)');
      assertEqual(hit.qual.decision, 'actionable', 'confirmed, chaseRisk false, RR high -> actionable');
      for (const c of btc.candidateSetups) {
        assert(ENGINE_CONFIG.flag.timeframes.includes(c.timeframe), `unexpected timeframe ${c.timeframe}`);
      }
    });
  }

  await test('F1 item 6: candidateId/impulseStart stay identical while the same flag runs through forming → triggering → confirmed (long + short mirror)', async () => {
    // Timestamps are fixed once against the full series, then sliced - not re-anchored to
    // NOW per cut the way buildWith1m's withTimes(...) would (that re-anchoring is a test
    // fixture convenience, not how real candles behave, and would shift every earlier
    // candle's ISO time as the array length changes).
    for (const [dir, fullTimed] of [['long', withTimes(regression001(), NOW)], ['short', withTimes(mirror(regression001()), NOW)]]) {
      const ids = [];
      for (const cut of [3, 2, 1, 0]) {
        const slice = fullTimed.slice(0, fullTimed.length - cut);
        const payload = await buildScalpContext({
          symbols: ['BTC'],
          now: NOW,
          fetchCandles: async (pair, interval) => (interval === '1m' ? slice : quietCandles(interval, 300, NOW)),
          fetchAccount: async () => ({ status: 'disabled', margin: { usd: null, byAsset: {} } })
        });
        const hit = payload.symbols.BTC.candidateSetups.find((c) => c.timeframe === '1m' && c.direction === dir);
        assert(hit, `${dir} cut=${cut}: expected a candidate`);
        ids.push({ id: hit.candidateId, state: hit.state });
      }
      const distinctIds = new Set(ids.map((x) => x.id));
      assertEqual(distinctIds.size, 1, `${dir}: candidateId must stay the same across states, got ${JSON.stringify(ids)}`);
      assertEqual(ids.map((x) => x.state).join(','), 'forming,forming,triggering,confirmed', `${dir}: states advanced as expected`);
    }
  });

  await test('F1 item 4: a failed candidate stays visible with failReason/failedAt inside failedTtlCandles; older follows includeFailed (long + short mirror)', async () => {
    const cfg = ENGINE_CONFIG.flag;
    const withinTtl = cfg.failedTtlCandles; // failedAtCandlesAgo == extra for this fixture (see flagFixtures.js)
    const pastTtl = cfg.failedTtlCandles + 3;
    for (const [dir, build] of [['long', invalidationCloseAged], ['short', (n) => mirror(invalidationCloseAged(n))]]) {
      const visible = await buildWith1m(build(withinTtl));
      const vHit = visible.symbols.BTC.candidateSetups.find((c) => c.timeframe === '1m' && c.direction === dir);
      assert(vHit, `${dir}: failed candidate must still be published within failedTtlCandles`);
      assertEqual(vHit.state, 'failed', `${dir}: state`);
      assertEqual(vHit.failReason, 'invalidation_close', `${dir}: failReason`);
      assert(!Number.isNaN(Date.parse(vHit.failedAt)), `${dir}: failedAt is a time`);

      const hiddenDefault = await buildWith1m(build(pastTtl));
      const hHit = hiddenDefault.symbols.BTC.candidateSetups.find((c) => c.timeframe === '1m' && c.direction === dir);
      assert(!hHit, `${dir}: a failure past failedTtlCandles must not appear in the default payload`);
      assert(hiddenDefault.symbols.BTC.decisionTrace.candidateSetups.some((s) => s.startsWith(`1m:${dir}:failed:invalidation_close`)), `${dir}: decisionTrace still references it regardless`);

      const hiddenWithFlag = await buildScalpContext({
        symbols: ['BTC'],
        now: NOW,
        includeFailed: true,
        fetchCandles: async (pair, interval) => (interval === '1m' ? withTimes(build(pastTtl), NOW) : quietCandles(interval, 300, NOW)),
        fetchAccount: async () => ({ status: 'disabled', margin: { usd: null, byAsset: {} } })
      });
      const fHit = hiddenWithFlag.symbols.BTC.candidateSetups.find((c) => c.timeframe === '1m' && c.direction === dir);
      assert(fHit, `${dir}: includeFailed:true must still surface an older failure`);
      assertEqual(fHit.state, 'failed', `${dir}: includeFailed state`);
    }
  });

  await test('F1 item 8: qual codes - conflict/stoch/room/ema200/ct/chase/rr and the decision rule (long + short mirror)', () => {
    const base = { timeframe: '1m', type: 'flag', direction: 'long', state: 'confirmed', confidence: 80, chaseRisk: false, measuredRR: 5, breakoutLevel: 110, measuredTarget: 130, ema200Side: 'below' };
    const mirrorBase = { ...base, direction: 'short', breakoutLevel: 90, measuredTarget: 70, ema200Side: 'above' };

    for (const [dir, cand] of [['long', base], ['short', mirrorBase]]) {
      const opposite = dir === 'long' ? 'short' : 'long';
      const conflicting = { timeframe: '3m', type: 'flag', direction: opposite, state: 'forming' };
      const stochRsiByTf = { '1m': { state: dir === 'long' ? 'OVERBOUGHT' : 'OVERSOLD', cross: dir === 'long' ? 'BEARISH_CROSS' : 'BULLISH_CROSS' } };
      const geometryContext = {
        '15m': {
          horizontalResistanceZones: dir === 'long' ? [{ low: 115, high: 120 }] : [],
          horizontalSupportZones: dir === 'short' ? [{ low: 75, high: 80 }] : []
        }
      };
      const q = buildQualification(cand, [cand, conflicting], { geometryContext, stochRsiByTf, fourHourBias: opposite });
      assert(q.reasons.includes(`conflict:3m-${opposite}`), `${dir}: conflict code, got ${JSON.stringify(q.reasons)}`);
      assert(q.reasons.includes(dir === 'long' ? 'stoch:ob-cross' : 'stoch:os-cross'), `${dir}: stoch code`);
      assert(q.reasons.includes('room:blocked-15m'), `${dir}: room:blocked code on the 1m candidate's mapped 15m`);
      assert(q.reasons.includes('ema200:counter'), `${dir}: ema200:counter code`);
      assert(q.reasons.includes('ct:4h'), `${dir}: ct:4h code`);
      assertEqual(q.decision, 'wait', `${dir}: a blocking room:blocked keeps confirmed at wait, not actionable`);
      assertEqual(q.quality, 'high', `${dir}: confidence 80 bands to high`);

      const clean = buildQualification({ ...cand, ema200Side: null, breakoutLevel: dir === 'long' ? 110 : 90, measuredTarget: dir === 'long' ? 130 : 70 }, [cand], {});
      assertEqual(clean.reasons.length, 0, `${dir}: no reasons with nothing else present`);
      assertEqual(clean.decision, 'actionable', `${dir}: confirmed with nothing blocking -> actionable`);

      const chasing = buildQualification({ ...cand, chaseRisk: true }, [cand], {});
      assert(chasing.reasons.includes('chase'), `${dir}: chase code`);
      assertEqual(chasing.decision, 'wait', `${dir}: chase blocks actionable`);

      const lowRR = buildQualification({ ...cand, measuredRR: 1.5 }, [cand], {});
      assert(lowRR.reasons.includes('rr:1.5'), `${dir}: rr:<x> code`);
      assertEqual(lowRR.decision, 'wait', `${dir}: RR below 3 blocks actionable`);

      for (const [state, decision] of [['proto', 'watch'], ['forming', 'watch'], ['triggering', 'wait'], ['failed', 'dont'], ['expired', 'dont']]) {
        const d = buildQualification({ ...cand, state }, [cand], {});
        assertEqual(d.decision, decision, `${dir} ${state}: decision`);
      }
    }

    const setups = [
      { timeframe: '1m', type: 'flag', direction: 'long', state: 'confirmed', confidence: 30, chaseRisk: false, measuredRR: 4 },
      { timeframe: '3m', type: 'flag', direction: 'long', state: 'forming', confidence: 55 }
    ];
    attachQualification(setups, {});
    assert(setups[0].qual && setups[0].qual.quality === 'low', 'attachQualification bands low confidence to low');
    assert(setups[1].qual && setups[1].qual.quality === 'med', 'attachQualification bands mid confidence to med');
    assertEqual(setups[0].direction, 'long', 'attachQualification never changes the candidate itself');
  });

  await test('owner decision 4a: room:blocked reads only the candidate\'s mapped geometry timeframe (long + short mirror)', () => {
    const long = { timeframe: '3m', type: 'flag', direction: 'long', state: 'confirmed', confidence: 80, chaseRisk: false, measuredRR: 5, breakoutLevel: 110, measuredTarget: 130 };
    const short = { ...long, direction: 'short', breakoutLevel: 90, measuredTarget: 70 };
    for (const [dir, cand] of [['long', long], ['short', short]]) {
      const zone = dir === 'long' ? { low: 115, high: 120 } : { low: 75, high: 80 };
      const at = (tf) => ({ [tf]: { horizontalResistanceZones: dir === 'long' ? [zone] : [], horizontalSupportZones: dir === 'short' ? [zone] : [] } });

      const own = buildQualification(cand, [cand], { geometryContext: at('15m') });
      assertEqual(JSON.stringify(own.reasons), JSON.stringify(['room:blocked-15m']), `${dir}: a zone on the mapped 15m blocks`);
      assertEqual(own.decision, 'wait', `${dir}: mapped-tf block keeps confirmed at wait`);

      for (const farther of ['1h', '4h']) {
        const far = buildQualification(cand, [cand], { geometryContext: at(farther) });
        assert(!far.reasons.some((r) => r.startsWith('room:blocked')), `${dir}: a zone only on ${farther} must not block, got ${JSON.stringify(far.reasons)}`);
        assertEqual(far.decision, 'actionable', `${dir}: ${farther}-only zone leaves the confirmed flag actionable`);
      }

      const both = buildQualification(cand, [cand], { geometryContext: { ...at('15m'), ...at('1h'), ...at('4h') } });
      assertEqual(JSON.stringify(both.reasons), JSON.stringify(['room:blocked-15m']), `${dir}: one code, own tf only, even with farther zones present`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
