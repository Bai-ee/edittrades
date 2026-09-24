/**
 * Deterministic tests for scripts/replay-rules.js (T6 phase 0,
 * docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md "Phase 0"): the variant table, the scoring/
 * stats pure functions, and the alternate stop/target construction (V5/V6), all with
 * hand-built inputs so every number is exact. Section 4 runs the real replay pipeline
 * (setConfigOverride + replaySymbol) on a short slice of the deep-2026-09-24 fixture, to
 * prove the override hook actually reaches buildScalpContext end to end - not just at
 * the unit level (test-engine-config.js covers the hook itself; this proves this
 * script's own wiring of it).
 *
 * Run: node test-replay-rules.js
 */

import {
  VARIANTS,
  parseArgs,
  walkPlan,
  statsFor,
  splitHalves,
  passesOOSRule,
  buildVariantMetrics,
  nearestStructureStop,
  buildStructurePlan,
  buildAtrFloorPlan,
  runVariant,
  HOLD_24H_CANDLES
} from './scripts/replay-rules.js';
import { ENGINE_CONFIG } from './config/engine.js';
import { existsSync } from 'node:fs';

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

function assertClose(actual, expected, tolerance, msg) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${msg}: actual is not a finite number (${JSON.stringify(actual)})`);
  assert(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// synthetic 1m candles
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 20, 0, 0, 0);

/** Flat candles at `price` for `count` minutes starting at `startMs`. */
function flat(startMs, count, price) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = startMs + i * 60000;
    out.push({ timestamp: t, open: price, high: price, low: price, close: price, closeTime: t + 60000 });
  }
  return out;
}

function withCandle(candles, index, patch) {
  const out = candles.slice();
  out[index] = { ...out[index], ...patch };
  return out;
}

async function run() {
  console.log('\nscripts/replay-rules.js\n');
  console.log('1) variant table + CLI args\n');

  await test('VARIANTS: every phase-0 id is present with a valid gate and a label', () => {
    const expected = ['V0', 'V1a', 'V1b', 'V1c', 'V2', 'V3a', 'V3b', 'V4', 'V5', 'V6', 'V7'];
    for (const id of expected) {
      assert(VARIANTS[id], `${id} missing from VARIANTS`);
      assert(typeof VARIANTS[id].label === 'string' && VARIANTS[id].label.length > 0, `${id}: label`);
      assert(['config', 'structure', 'atrFloor', 'scout'].includes(VARIANTS[id].gate), `${id}: gate`);
    }
  });

  await test('VARIANTS: V0 is a true baseline (no override)', () => {
    assertEqual(VARIANTS.V0.override, null, 'V0 override');
  });

  await test('VARIANTS: net-gate variants only touch flagPlan.minNetRR, never minRR or the 3% stop cap', () => {
    for (const id of ['V1a', 'V1b', 'V1c', 'V3a', 'V3b']) {
      const o = VARIANTS[id].override;
      assert(o.flagPlan && typeof o.flagPlan.minNetRR === 'number', `${id}: minNetRR`);
      assert(o.flagPlan.minRR === undefined, `${id}: must not touch gross minRR`);
      assert(o.scalp === undefined, `${id}: must not touch the scalp stop cap block`);
    }
  });

  await test('VARIANTS: V2/V3 widen flag.timeframes to include 15m and 1h only (never 4h/1d)', () => {
    for (const id of ['V2', 'V3a', 'V3b', 'V4']) {
      const tfs = VARIANTS[id].override.flag.timeframes;
      assert(tfs.includes('15m') && tfs.includes('1h'), `${id}: missing 15m/1h`);
      assert(!tfs.includes('4h') && !tfs.includes('1d'), `${id}: out-of-scope timeframe leaked in (master plan "out of scope")`);
    }
  });

  await test('VARIANTS: V4 is the only variant that lowers gross minRR, and it stays >= 2.5', () => {
    for (const [id, v] of Object.entries(VARIANTS)) {
      const minRR = v.override && v.override.flagPlan && v.override.flagPlan.minRR;
      if (id === 'V4') assertEqual(minRR, 2.5, 'V4 minRR');
      else assert(minRR === undefined || minRR === null, `${id}: gross minRR must not be lowered (hard rule)`);
    }
  });

  await test('parseArgs: reads variant/history/symbols/step/out/summary', () => {
    const args = parseArgs(['--variant', 'V1b', '--history', 'test/fixtures/history/deep-2026-09-24', '--symbols', 'BTC,SOL', '--step', '5', '--out', 'a.jsonl', '--summary', 'b.json']);
    assertEqual(args.variant, 'V1b', 'variant');
    assertEqual(args.history, 'test/fixtures/history/deep-2026-09-24', 'history');
    assert(Array.isArray(args.symbols) && args.symbols.length === 2, 'symbols');
    assertEqual(args.step, 5, 'step');
    assertEqual(args.out, 'a.jsonl', 'out');
    assertEqual(args.summary, 'b.json', 'summary');
  });

  await test('parseArgs: step defaults to 1, symbols/out/summary default to null', () => {
    const args = parseArgs(['--variant', 'V0', '--history', 'h']);
    assertEqual(args.step, 1, 'step default');
    assertEqual(args.symbols, null, 'symbols default');
    assertEqual(args.out, null, 'out default');
  });

  console.log('\n2) walkPlan (production fill rules: prefilled, 24h hold)\n');

  await test('walkPlan: a long that reaches target after the fill candle scores a win, gross R matches the target ratio', () => {
    // entry 100, stop 99, target 103 -> rTarget = 3. Fill candle stays flat; target touched on candle 2.
    let candles = flat(NOW, 10, 100);
    candles = withCandle(candles, 2, { high: 103, low: 100, close: 103 });
    const scored = walkPlan({ candles1m: candles, closedThroughIso: new Date(NOW).toISOString(), direction: 'long', entry: 100, stop: 99, target: 103 });
    assertEqual(scored.outcome, 'win', 'outcome');
    assertEqual(scored.grossR, 3, 'grossR');
    assertClose(scored.netR, 3 - (2 * (ENGINE_CONFIG.risk.feeBps + ENGINE_CONFIG.risk.slippageBps) / 10000) * 100, 0.0001, 'netR');
    assertEqual(scored.timeToTP1Candles, 3, 'timeToTP1Candles (fill=candle0, target on candle index 2 -> holdCandles 3)');
  });

  await test('walkPlan: a short that hits its stop scores a loss at exactly -1R gross', () => {
    let candles = flat(NOW, 10, 100);
    candles = withCandle(candles, 1, { high: 101, low: 99, close: 100 });
    const scored = walkPlan({ candles1m: candles, closedThroughIso: new Date(NOW).toISOString(), direction: 'short', entry: 100, stop: 101, target: 94 });
    assertEqual(scored.outcome, 'loss', 'outcome');
    assertEqual(scored.grossR, -1, 'grossR');
    assert(scored.netR < -1, 'netR must be worse than -1 (fees add on top of a loss)');
  });

  await test('walkPlan: neither stop nor target touched within the 24h window scores open, gross/net R are null', () => {
    const candles = flat(NOW, HOLD_24H_CANDLES + 10, 100); // flat forever, never moves
    const scored = walkPlan({ candles1m: candles, closedThroughIso: new Date(NOW).toISOString(), direction: 'long', entry: 100, stop: 90, target: 130 });
    assertEqual(scored.outcome, 'open', 'outcome');
    assertEqual(scored.grossR, null, 'grossR');
    assertEqual(scored.netR, null, 'netR');
  });

  await test('walkPlan: the 0.14% sensitivity column is milder and the 0.34% column harsher than the shipped 0.20% cost, on a loss', () => {
    let candles = flat(NOW, 5, 100);
    candles = withCandle(candles, 1, { high: 101, low: 99, close: 100 });
    const scored = walkPlan({ candles1m: candles, closedThroughIso: new Date(NOW).toISOString(), direction: 'short', entry: 100, stop: 101, target: 94 });
    assert(scored.netR_sens014 > scored.netR, 'a lower assumed cost (0.14%, D3) must never look worse than the shipped 0.20% cost');
    assert(scored.netR_sens034 < scored.netR, 'a higher assumed cost (0.34%, D3 USDC-funded estimate) must never look better than the shipped 0.20% cost');
  });

  console.log('\n3) stats, OOS split, structure/ATR-floor plan construction\n');

  function call({ outcome, grossR, netR, stopDistancePct = 1, firstReadyAt, timeToTP1Candles = null, holdCandles = null }) {
    return { outcome, grossR, netR, netR_sens014: netR, netR_sens034: netR, stopDistancePct, firstReadyAt, timeToTP1Candles, holdCandles };
  }

  await test('statsFor: n/resolvedN/winRate/expectancy/maxLosingStreak on a hand-built mix', () => {
    const calls = [
      call({ outcome: 'win', grossR: 3, netR: 2.5, firstReadyAt: '2026-09-10T00:00:00.000Z', timeToTP1Candles: 10, holdCandles: 10 }),
      call({ outcome: 'loss', grossR: -1, netR: -1.3, firstReadyAt: '2026-09-11T00:00:00.000Z', holdCandles: 20 }),
      call({ outcome: 'loss', grossR: -1, netR: -1.3, firstReadyAt: '2026-09-12T00:00:00.000Z', holdCandles: 5 }),
      call({ outcome: 'open', grossR: null, netR: null, firstReadyAt: '2026-09-13T00:00:00.000Z' })
    ];
    const s = statsFor(calls);
    assertEqual(s.n, 4, 'n');
    assertEqual(s.resolvedN, 3, 'resolvedN');
    assertEqual(s.unresolvedN, 1, 'unresolvedN');
    assertClose(s.winRate, (1 / 3) * 100, 0.01, 'winRate (of resolved only)');
    assertClose(s.grossExpectancyR, (3 - 1 - 1 + 0) / 4, 0.0001, 'grossExpectancyR (unresolved contributes 0, divides by n)');
    assertClose(s.netExpectancyR, (2.5 - 1.3 - 1.3 + 0) / 4, 0.0001, 'netExpectancyR');
    assertEqual(s.maxLosingStreak, 2, 'maxLosingStreak (two losses back to back, sorted by time)');
  });

  await test('statsFor: a win right after two losses resets the streak (order matters, not just totals)', () => {
    const calls = [
      call({ outcome: 'loss', grossR: -1, netR: -1, firstReadyAt: '2026-09-10T00:00:00.000Z' }),
      call({ outcome: 'loss', grossR: -1, netR: -1, firstReadyAt: '2026-09-11T00:00:00.000Z' }),
      call({ outcome: 'win', grossR: 3, netR: 3, firstReadyAt: '2026-09-12T00:00:00.000Z' }),
      call({ outcome: 'loss', grossR: -1, netR: -1, firstReadyAt: '2026-09-13T00:00:00.000Z' })
    ];
    assertEqual(statsFor(calls).maxLosingStreak, 2, 'streak resets on a win');
  });

  await test('splitHalves + passesOOSRule: both halves net-positive with n>=20 passes; anything less does not', () => {
    const spanFromMs = Date.parse('2026-09-01T00:00:00.000Z');
    const spanToMs = Date.parse('2026-09-16T00:00:00.000Z'); // 15 days, boundary at day 10
    const makeCalls = (n, day) => Array.from({ length: n }, (_, i) => call({
      outcome: 'win', grossR: 2, netR: 1.5, firstReadyAt: new Date(spanFromMs + (day * 86400000) + i * 60000).toISOString()
    }));
    const passingCalls = [...makeCalls(10, 2), ...makeCalls(10, 12)]; // 10 in first half (day 2), 10 in second (day 12) -> n=20
    const halves = splitHalves(passingCalls, spanFromMs, spanToMs);
    assertEqual(halves.first.n, 10, 'first half n');
    assertEqual(halves.second.n, 10, 'second half n');
    assert(passesOOSRule(passingCalls, halves), 'both halves positive, n=20 -> should pass');

    const tooFewCalls = [...makeCalls(5, 2), ...makeCalls(5, 12)]; // n=10, both halves still positive
    assert(!passesOOSRule(tooFewCalls, splitHalves(tooFewCalls, spanFromMs, spanToMs)), 'n<20 must not pass even if both halves are positive');

    const oneSidedCalls = [...makeCalls(15, 2), ...[call({ outcome: 'loss', grossR: -1, netR: -1, firstReadyAt: new Date(spanFromMs + 12 * 86400000).toISOString() })].concat(makeCalls(4, 12))];
    const oneSidedHalves = splitHalves(oneSidedCalls, spanFromMs, spanToMs);
    assert(oneSidedHalves.second.netExpectancyR <= oneSidedHalves.first.netExpectancyR, 'sanity: the loss dragged the second half down');
  });

  await test('buildVariantMetrics: coverage.totalDays matches the span and goodPerDay divides by it', () => {
    const spanFromMs = Date.parse('2026-09-01T00:00:00.000Z');
    const spanToMs = Date.parse('2026-09-06T00:00:00.000Z'); // 5 days
    const calls = [call({ outcome: 'win', grossR: 1, netR: 1, firstReadyAt: '2026-09-02T00:00:00.000Z' })];
    const m = buildVariantMetrics(calls, { spanFromMs, spanToMs });
    assertEqual(m.coverage.totalDays, 5, 'totalDays');
    assertClose(m.coverage.goodPerDay, 0.2, 0.001, 'goodPerDay');
    assertEqual(m.coverage.daysWithGoodCount, 1, 'daysWithGoodCount');
  });

  function geo(tf, { support = [], resistance = [], atr = null } = {}) {
    return { [tf]: { horizontalSupportZones: support, horizontalResistanceZones: resistance, atr } };
  }

  await test('nearestStructureStop: picks the nearest 15m support behind a long entry, buffered below its low edge', () => {
    const geometryContext = geo('15m', { support: [{ low: 90, high: 92 }, { low: 80, high: 82 }] });
    const stop = nearestStructureStop('long', 100, geometryContext, ['15m'], 0.01);
    assertClose(stop, 90 * 0.99, 0.001, 'nearest support is 90-92, not 80-82; buffered 1% below 90');
  });

  await test('nearestStructureStop (short mirror): nearest resistance ahead of price on the stop side, buffered above', () => {
    const geometryContext = geo('15m', { resistance: [{ low: 108, high: 110 }, { low: 118, high: 120 }] });
    const stop = nearestStructureStop('short', 100, geometryContext, ['15m'], 0.01);
    assertClose(stop, 110 * 1.01, 0.001, 'nearest resistance is 108-110; buffered 1% above 110');
  });

  await test('nearestStructureStop: null when no zone exists behind entry', () => {
    const geometryContext = geo('15m', { support: [{ low: 105, high: 107 }] }); // ahead of a long entry at 100, not behind
    assertEqual(nearestStructureStop('long', 100, geometryContext, ['15m'], 0.01), null, 'no support behind entry');
  });

  await test('buildStructurePlan (V5): with no 15m/1h zones at all, falls back to the candidate\'s own invalidation/measured target', () => {
    const candidate = { chaseRisk: false, direction: 'long', breakoutLevel: 1000, invalidation: 990, measuredTarget: 1030 };
    const plan = buildStructurePlan(candidate, {}, ENGINE_CONFIG); // net gate off by default (minNetRR null); gross RR exactly 3 passes
    assert(plan, 'expected a fallback plan, not null');
    assertEqual(plan.stop, 990, 'stop falls back to the candidate\'s own invalidation');
    assertEqual(plan.tp1, 1030, 'target falls back to the candidate\'s own measured target');
    assertEqual(plan.grossRR, 3, 'grossRR');
  });

  await test('buildStructurePlan (V5): a valid structural stop/target passes both gates (long + short mirror)', () => {
    const cfg = { ...ENGINE_CONFIG, flagPlan: { ...ENGINE_CONFIG.flagPlan, minNetRR: 1.0 } };
    const longCandidate = { chaseRisk: false, direction: 'long', breakoutLevel: 1000, invalidation: 999, measuredTarget: 1100 };
    const longGeo = geo('15m', { support: [{ low: 990, high: 992 }], resistance: [{ low: 1050, high: 1052 }] });
    const longPlan = buildStructurePlan(longCandidate, longGeo, cfg);
    assert(longPlan, 'long: expected a valid plan');
    assertClose(longPlan.stop, 990 * (1 - cfg.stops.structureBuffer), 0.01, 'long stop uses the structural zone, not invalidation');
    assertEqual(longPlan.tp1, 1050, 'long target is the near edge of the resistance zone ahead');

    const shortCandidate = { chaseRisk: false, direction: 'short', breakoutLevel: 1000, invalidation: 1001, measuredTarget: 900 };
    const shortGeo = geo('15m', { resistance: [{ low: 1008, high: 1010 }], support: [{ low: 950, high: 952 }] });
    const shortPlan = buildStructurePlan(shortCandidate, shortGeo, cfg);
    assert(shortPlan, 'short: expected a valid plan');
    assertClose(shortPlan.stop, 1010 * (1 + cfg.stops.structureBuffer), 0.01, 'short stop uses the structural zone');
    assertEqual(shortPlan.tp1, 952, 'short target is the near edge of the support zone ahead');
  });

  await test('buildStructurePlan (V5): chaseRisk candidates are never considered', () => {
    const candidate = { chaseRisk: true, direction: 'long', breakoutLevel: 1000, invalidation: 990, measuredTarget: 1100 };
    assertEqual(buildStructurePlan(candidate, {}, ENGINE_CONFIG), null, 'chase candidates must be skipped');
  });

  await test('buildAtrFloorPlan (V6): floors the stop at 0.5x ATR(15m) when the candidate\'s own stop is tighter, target fixed at 3x', () => {
    const cfg = { ...ENGINE_CONFIG, flagPlan: { ...ENGINE_CONFIG.flagPlan, minNetRR: 1.0 } };
    const candidate = { chaseRisk: false, direction: 'long', breakoutLevel: 1000, invalidation: 999.5 }; // own stop distance 0.5, tighter than the floor
    const geometryContext = geo('15m', {}, );
    geometryContext['15m'].atr = 4; // floor = 0.5 * 4 = 2, wider than the candidate's own 0.5
    const plan = buildAtrFloorPlan(candidate, geometryContext, cfg);
    assert(plan, 'expected a valid plan');
    assertEqual(plan.stop, 998, 'stop floored to entry - 2 (0.5x ATR), not entry - 0.5');
    assertEqual(plan.tp1, 1006, 'target fixed at entry + 3x the floored stop distance');
    assertEqual(plan.grossRR, 3, 'gross RR is exactly 3 by construction');
  });

  await test('buildAtrFloorPlan (V6): keeps the candidate\'s own (wider) stop when it already clears the ATR floor', () => {
    const cfg = { ...ENGINE_CONFIG, flagPlan: { ...ENGINE_CONFIG.flagPlan, minNetRR: 1.0 } };
    const candidate = { chaseRisk: false, direction: 'short', breakoutLevel: 1000, invalidation: 1005 }; // own stop distance 5
    const geometryContext = geo('15m');
    geometryContext['15m'].atr = 4; // floor = 2, tighter than the candidate's own 5
    const plan = buildAtrFloorPlan(candidate, geometryContext, cfg);
    assert(plan, 'expected a valid plan');
    assertEqual(plan.stop, 1005, 'the wider candidate stop is kept, never tightened');
    assertEqual(plan.tp1, 985, 'target fixed at entry - 3x the (unfloored) stop distance');
  });

  console.log('\n4) end-to-end wiring: the override hook actually reaches buildScalpContext through this script\n');

  const HISTORY_DIR = 'test/fixtures/history/deep-2026-09-24';
  // T6 completion plan A7: fails, does not silently skip, when the fixture is missing -
  // a quietly-shrinking test count on a machine without the (gitignored) fixture would
  // hide real breakage instead of surfacing it. Recreate it with
  // `node scripts/replay.js --capture BTC,SOL,ETH --out test/fixtures/history/deep-2026-09-24/ --backfill-1m 20880`.
  const HAS_FIXTURE = existsSync(`${HISTORY_DIR}/manifest.json`);

  await test('runVariant: V0 and V1b share the same replayed closes but V1b never publishes a plan below its net floor', async () => {
    assert(HAS_FIXTURE, `fixture history missing at ${HISTORY_DIR} - see this section's header comment to recreate it`);
    const opts = { historyDir: HISTORY_DIR, symbols: ['BTC'], step: 1, from: '2026-09-20T00:00:00Z', to: '2026-09-20T06:00:00Z' };
    const v0 = await runVariant({ variantId: 'V0', ...opts });
    const v1b = await runVariant({ variantId: 'V1b', ...opts });
    assertEqual(v0.buildMs.totalCloses, v1b.buildMs.totalCloses, 'both variants replay the same number of closes');
    for (const c of v1b.goodCalls) assert(c.plannedNetRR === null || c.plannedNetRR >= 1.5, `V1b GOOD call ${c.candidateId} published below its own net floor`);
    // Every V1b GOOD call's net RR floor is a subset condition of V0's own set (net gate only removes calls, never adds).
    const v0Ids = new Set(v0.goodCalls.map((c) => c.candidateId));
    for (const c of v1b.goodCalls) assert(v0Ids.has(c.candidateId), `V1b surfaced a candidateId (${c.candidateId}) V0 never reached ready on`);
  });

  await test('runVariant: ENGINE_CONFIG is restored to the on-disk default after the run (override hook cleans up)', async () => {
    assert(HAS_FIXTURE, `fixture history missing at ${HISTORY_DIR} - see this section's header comment to recreate it`);
    await runVariant({ historyDir: HISTORY_DIR, symbols: ['BTC'], step: 5, from: '2026-09-20T00:00:00Z', to: '2026-09-20T01:00:00Z', variantId: 'V2' });
    assertEqual(ENGINE_CONFIG.flag.timeframes.length, 3, 'V2 override (5 flag timeframes) must not leak past the run');
    assert(ENGINE_CONFIG.flag.timeframes.includes('1m') && ENGINE_CONFIG.flag.timeframes.includes('5m'), 'base flag.timeframes restored');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
