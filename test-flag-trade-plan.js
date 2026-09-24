/**
 * Deterministic tests for lib/flagTradePlan.js (signal-reliability minimum plan, work
 * package 2): the one engine-owned flag trade plan built from a symbol's confirmed
 * directional flag candidates.
 *
 * Section 1 uses hand-built candidate/geometry objects (same convention as
 * test-pattern-detector.js's "F1 item 8" qualification test) so every number in a
 * rejection/cap/RR case is exact and intentional. Section 2 runs the full
 * buildScalpContext pipeline on the existing REGRESSION_001 flag fixture with flat
 * (quiet) higher timeframes, to prove the 4h-flat policy and legacy-output parity end
 * to end, not just at the unit level.
 *
 * Run: node test-flag-trade-plan.js
 */

import { buildFlagTradePlan, costRFraction, netRiskReward } from './lib/flagTradePlan.js';
import { buildScalpContext, INTERVAL_MS } from './services/scalpContext.js';
import { ENGINE_CONFIG } from './config/engine.js';
import { FIXTURE_PIVOT, withTimes, regression001, mirror } from './test/fixtures/flagFixtures.js';

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
// Section 1 fixtures: hand-built, symbol-agnostic single-candidate scenarios
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const FRESH_1M = new Date(NOW).toISOString();
const FRESH_15M = new Date(NOW).toISOString();

/** One confirmed long flag candidate, entry=1000/stop=990/target=1040 (net RR ~3.17, stop 1%). */
function longCandidate(overrides = {}) {
  return {
    candidateId: 'BTC:1m:long:2026-09-23T11:55:00.000Z',
    timeframe: '1m',
    type: 'flag',
    direction: 'long',
    state: 'confirmed',
    confidence: 80,
    chaseRisk: false,
    breakoutLevel: 1000,
    invalidation: 990,
    measuredTarget: 1040,
    ...overrides
  };
}

/** Mirror of longCandidate around 1000 (short direction, same distances). */
function shortCandidate(overrides = {}) {
  return {
    candidateId: 'BTC:1m:short:2026-09-23T11:55:00.000Z',
    timeframe: '1m',
    type: 'flag',
    direction: 'short',
    state: 'confirmed',
    confidence: 80,
    chaseRisk: false,
    breakoutLevel: 1000,
    invalidation: 1010,
    measuredTarget: 960,
    ...overrides
  };
}

/**
 * Closed 1m candles around a 1000 breakout level (atr 5 -> 0.5 tolerance). 'retest':
 * inside, breakout close, then a retest-hold close (ready). 'breakout': inside, then the
 * breakout candle alone as the latest close (not ready). Short mirrors around 1000.
 */
function levelCandles(direction, kind) {
  const m = (v) => (direction === 'short' ? 2000 - v : v);
  const bar = (i, open, high, low, close) => {
    const hi = Math.max(m(high), m(low));
    const lo = Math.min(m(high), m(low));
    return { timestamp: NOW - (3 - i) * 60000, open: m(open), high: hi, low: lo, close: m(close) };
  };
  const inside = bar(0, 996, 998, 994, 995);
  const breakout = bar(1, 995, 1006, 995, 1005);
  const retest = bar(2, 1005, 1006, 1000.3, 1003);
  if (kind === 'continuation') return [inside, breakout, retest, bar(3, 1003, 1009, 1002, 1008)];
  if (kind === 'fallback') return [inside, breakout, retest, bar(3, 1003, 1004, 997, 998)];
  // T6 completion plan A3: the "retest" candle's wick reaches through the stop (990 for
  // long, invalidation is entry-10) before closing back on the hold side (1003) - not a
  // valid hold; a live position would have been stopped out on this candle's wick.
  if (kind === 'stopWick') return [inside, breakout, bar(2, 1005, 1006, 985, 1003)];
  return kind === 'retest' ? [inside, breakout, retest] : [bar(0, 996, 998, 994, 995), bar(1, 995, 998, 994, 996), { ...breakout, timestamp: NOW - 60000 }];
}

/** buildFlagTradePlan's fixed context, one confirmed candidate, no geometry, price at entry. */
function baseParams({ candidate, price = 1000, atr = 5, geometryContext = {}, now = NOW, closedThrough = FRESH_1M, geometryClosedThrough = FRESH_15M, candles = null, shadowVariants = undefined }) {
  return {
    candidateSetups: [candidate],
    geometryContext,
    tfEntries: {
      [candidate.timeframe]: { closedThrough },
      '15m': { closedThrough: geometryClosedThrough }
    },
    marketByTf: { [candidate.timeframe]: { price, atr } },
    candlesByTf: candles ? { [candidate.timeframe]: candles } : {},
    intervalMsByTf: INTERVAL_MS,
    geometryTimeframes: ['15m'],
    now,
    configVersion: 'TEST-CFG-1',
    shadowVariants
  };
}

async function run() {
  console.log('\nlib/flagTradePlan.js\n');
  console.log('1) hand-built single-candidate cases\n');

  await test('ready (long): breakout close, then a retest-hold close; valid levels, gross RR>=3, stop<=3%', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 1003, candles: levelCandles('long', 'retest') }));
    assert(plan, 'expected a plan');
    assertEqual(plan.status, 'ready', 'status');
    assertEqual(plan.reasonCode, null, 'reasonCode');
    assertEqual(plan.entryType, 'retest', 'entryType');
    assertEqual(plan.entry, 1000, 'entry');
    assertEqual(plan.stop, 990, 'stop');
    assertEqual(plan.tp1, 1040, 'tp1');
    assertEqual(plan.tp2, null, 'tp2 (no cap, TP1 already the full measured move)');
    assertEqual(plan.grossRR, 4, 'grossRR = |tp1 - entry| / |entry - stop|');
    assertClose(plan.netRR, 2.731, 0.001, 'netRR (T6 completion plan C1: a long pays the 34bps dir-cost, not the flat 20bps)');
    assertEqual(plan.entryCondition, "a closed candle closes above 1000, then a later closed candle's low reaches within 0.1 ATR of 1000 and closes at or above it", 'entryCondition');
    assert(plan.candidateId && plan.planId && plan.planId.includes(plan.candidateId), 'planId embeds candidateId');
  });

  await test('ready (short mirror): breakout close below, then a retest-hold close', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), price: 997, candles: levelCandles('short', 'retest') }));
    assertEqual(plan.status, 'ready', 'status');
    assertEqual(plan.entry, 1000, 'entry');
    assertEqual(plan.stop, 1010, 'stop');
    assertEqual(plan.tp1, 960, 'tp1');
    assertEqual(plan.grossRR, 4, 'grossRR');
    assertClose(plan.netRR, 3.386, 0.001, 'netRR (T6 completion plan C1: a short pays the cheaper 14bps dir-cost, not the flat 20bps)');
    assertEqual(plan.entryCondition, "a closed candle closes below 1000, then a later closed candle's high reaches within 0.1 ATR of 1000 and closes at or below it", 'entryCondition');
  });

  await test('ready persists (long + short mirror): retest-hold seen, then a continuation close still on the hold side', () => {
    const l = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 1008, candles: levelCandles('long', 'continuation') }));
    assertEqual(l.status, 'ready', 'long status');
    const s = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), price: 992, candles: levelCandles('short', 'continuation') }));
    assertEqual(s.status, 'ready', 'short status');
  });

  await test('T6 completion plan A3: a retest candle that wicks through the stop before closing back on the hold side is not a valid hold (long + short mirror)', () => {
    const l = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 1003, candles: levelCandles('long', 'stopWick') }));
    assertEqual(l.status, 'conditional', 'long status: the wick to 985 breached the 990 stop, so this is not a hold');
    assertEqual(l.reasonCode, 'awaiting_retest', 'long reasonCode');
    const s = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), price: 997, candles: levelCandles('short', 'stopWick') }));
    assertEqual(s.status, 'conditional', 'short status: the wick breached the 1010 stop');
    assertEqual(s.reasonCode, 'awaiting_retest', 'short reasonCode');
  });

  await test('awaiting_retest again (long + short mirror): retest-hold seen, then the latest close falls back through the level', () => {
    const l = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 998, candles: levelCandles('long', 'fallback') }));
    assertEqual(l.status, 'conditional', 'long status');
    assertEqual(l.reasonCode, 'awaiting_retest', 'long reasonCode');
    const s = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), price: 1002, candles: levelCandles('short', 'fallback') }));
    assertEqual(s.status, 'conditional', 'short status');
    assertEqual(s.reasonCode, 'awaiting_retest', 'short reasonCode');
  });

  await test('conditional/awaiting_retest (long): the breakout candle alone is not ready', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 1005, candles: levelCandles('long', 'breakout') }));
    assertEqual(plan.status, 'conditional', 'status');
    assertEqual(plan.reasonCode, 'awaiting_retest', 'reasonCode');
  });

  await test('conditional/awaiting_retest (short mirror): the breakout candle alone is not ready', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), price: 995, candles: levelCandles('short', 'breakout') }));
    assertEqual(plan.status, 'conditional', 'status');
    assertEqual(plan.reasonCode, 'awaiting_retest', 'reasonCode');
  });

  await test('conditional/awaiting_breakout: candles never closed through the level (long + short mirror)', () => {
    for (const [cand, dir] of [[longCandidate(), 'long'], [shortCandidate(), 'short']]) {
      const candles = levelCandles(dir, 'breakout').slice(0, 2);
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles }));
      assertEqual(plan.status, 'conditional', `${dir} status`);
      assertEqual(plan.reasonCode, 'awaiting_breakout', `${dir} reasonCode`);
    }
  });

  await test('conditional/awaiting_retest: retest reached the level but closed back through it (long + short mirror)', () => {
    for (const [cand, dir] of [[longCandidate(), 'long'], [shortCandidate(), 'short']]) {
      const candles = levelCandles(dir, 'retest');
      const last = candles[2];
      candles[2] = dir === 'long' ? { ...last, low: 997, close: 998 } : { ...last, high: 1003, close: 1002 };
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles }));
      assertEqual(plan.reasonCode, 'awaiting_retest', `${dir} reasonCode`);
    }
  });

  await test('entryCondition rounds entry to 2 decimals', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ breakoutLevel: 1000.123456, invalidation: 990, measuredTarget: 1045 }), price: 1010 }));
    assert(plan.entryCondition.includes('1000.12') && !plan.entryCondition.includes('1000.123'), plan.entryCondition);
  });

  await test('conditional/awaiting_retest (long): price already ran past the entry level, no candles to observe a retest hold', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 1010 }));
    assertEqual(plan.status, 'conditional', 'status');
    assertEqual(plan.reasonCode, 'awaiting_retest', 'reasonCode');
    assertEqual(plan.entry, 1000, 'entry is still published exactly, unmoved');
  });

  await test('conditional/awaiting_retest (short mirror)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), price: 990 }));
    assertEqual(plan.status, 'conditional', 'status');
    assertEqual(plan.reasonCode, 'awaiting_retest', 'reasonCode');
  });

  await test('conditional/awaiting_breakout (long): price has not reached the entry trigger yet', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 995 }));
    assertEqual(plan.status, 'conditional', 'status');
    assertEqual(plan.reasonCode, 'awaiting_breakout', 'reasonCode');
  });

  await test('conditional/awaiting_breakout (short mirror)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), price: 1005 }));
    assertEqual(plan.status, 'conditional', 'status');
    assertEqual(plan.reasonCode, 'awaiting_breakout', 'reasonCode');
  });

  await test('rejected/invalid_levels: wrong-side stop (long stop above entry)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ invalidation: 1010 }) }));
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'invalid_levels', 'reasonCode');
    assertEqual(plan.entry, null, 'no numbers published on an invalid-levels rejection');
  });

  await test('rejected/invalid_levels: wrong-side stop (short mirror, stop below entry)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate({ invalidation: 990 }) }));
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'invalid_levels', 'reasonCode');
  });

  await test('rejected/invalid_levels: missing measuredTarget', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ measuredTarget: null }) }));
    assertEqual(plan.reasonCode, 'invalid_levels', 'reasonCode');
  });

  await test('rejected/invalid_levels: target behind the entry (not ahead in the trade direction)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ measuredTarget: 990 }) }));
    assertEqual(plan.reasonCode, 'invalid_levels', 'reasonCode');
  });

  await test('rejected/chase: chaseRisk true never yields ready/conditional (long)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ chaseRisk: true }) }));
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'chase', 'reasonCode');
  });

  await test('rejected/chase (short mirror)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate({ chaseRisk: true }) }));
    assertEqual(plan.reasonCode, 'chase', 'reasonCode');
  });

  await test('rejected/room_at_entry: a horizontal zone overlaps the entry itself (long)', () => {
    const geometryContext = { '15m': { horizontalResistanceZones: [{ low: 995, high: 1005 }], horizontalSupportZones: [] } };
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), geometryContext }));
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'room_at_entry', 'reasonCode');
  });

  await test('rejected/room_at_entry (short mirror, support zone overlaps entry)', () => {
    const geometryContext = { '15m': { horizontalSupportZones: [{ low: 995, high: 1005 }], horizontalResistanceZones: [] } };
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate(), geometryContext }));
    assertEqual(plan.reasonCode, 'room_at_entry', 'reasonCode');
  });

  await test('owner decision 4b: a zone touching entry on a FARTHER geometry timeframe never triggers room_at_entry (long + short mirror)', () => {
    // longCandidate/shortCandidate are 1m -> own mapped geometry timeframe is 15m
    // (geometryTimeframeFor). A zone on 4h (farther) that happens to sit on the entry
    // price must not reject the plan outright - only the candidate's own 15m read does.
    for (const [candidateFn, dir] of [[longCandidate, 'long'], [shortCandidate, 'short']]) {
      const key = dir === 'long' ? 'horizontalResistanceZones' : 'horizontalSupportZones';
      const geometryContext = { '4h': { [key]: [{ low: 995, high: 1005 }] } };
      const plan = buildFlagTradePlan(baseParams({ candidate: candidateFn(), geometryContext, candles: levelCandles(dir, 'retest'), geometryClosedThrough: FRESH_15M }));
      assert(plan.reasonCode !== 'room_at_entry', `${dir}: a 4h-only zone on entry must not reject the plan (decision 4b)`);
    }
  });

  await test('owner decision 4b: the TP1 cap still reads every geometry timeframe, including a farther one (long + short mirror)', () => {
    // Same farther-timeframe (4h) zone as above, but ahead of entry (not touching it) -
    // the TP1 cap (nearestEdge) is explicitly NOT rescoped by decision 4b; a major level
    // on any timeframe still caps the measured-move target ("major S/R overrides").
    const longPlan = buildFlagTradePlan(baseParams({
      candidate: longCandidate({ invalidation: 998 }),
      geometryContext: { '4h': { horizontalResistanceZones: [{ low: 1020, high: 1025 }], horizontalSupportZones: [] } },
      candles: levelCandles('long', 'retest')
    }));
    assertEqual(longPlan.tp1, 1020, 'a 4h zone ahead still caps TP1');
    const shortPlan = buildFlagTradePlan(baseParams({
      candidate: shortCandidate({ invalidation: 1002 }),
      geometryContext: { '4h': { horizontalSupportZones: [{ low: 975, high: 980 }], horizontalResistanceZones: [] } },
      candles: levelCandles('short', 'retest')
    }));
    assertEqual(shortPlan.tp1, 980, 'a 4h zone ahead still caps TP1 (short)');
  });

  await test('nearest-level cap: a zone between entry and measured target caps TP1, TP2 keeps the rest (long)', () => {
    // Tighter stop (2) than the baseline fixture so R:R still clears 3 after the cap.
    const candidate = longCandidate({ invalidation: 998 });
    const geometryContext = { '15m': { horizontalResistanceZones: [{ low: 1020, high: 1025 }], horizontalSupportZones: [] } };
    const plan = buildFlagTradePlan(baseParams({ candidate, geometryContext, candles: levelCandles(candidate.direction, 'retest') }));
    assertEqual(plan.status, 'ready', 'status (still passes after the cap)');
    assertEqual(plan.tp1, 1020, 'tp1 capped to the zone\'s near edge');
    assertEqual(plan.tp2, 1040, 'tp2 keeps the measured target, since it is still beyond the capped TP1');
    assertEqual(plan.grossRR, 10, 'grossRR uses the capped TP1, not the raw measured target');
    assertClose(plan.netRR, 3.074, 0.001, 'netRR uses the capped TP1, not the raw measured target (T6 completion plan C1: 34bps long dir-cost)');
  });

  await test('nearest-level cap (short mirror)', () => {
    const candidate = shortCandidate({ invalidation: 1002 });
    const geometryContext = { '15m': { horizontalSupportZones: [{ low: 975, high: 980 }], horizontalResistanceZones: [] } };
    const plan = buildFlagTradePlan(baseParams({ candidate, geometryContext, candles: levelCandles(candidate.direction, 'retest') }));
    assertEqual(plan.status, 'ready', 'status');
    assertEqual(plan.tp1, 980, 'tp1 capped to the zone\'s near edge (short: upper edge)');
    assertEqual(plan.tp2, 960, 'tp2 keeps the measured target');
    assertEqual(plan.grossRR, 10, 'grossRR uses the capped TP1 (short)');
  });

  await test('a zone entirely beyond the measured target never caps or blocks anything', () => {
    const geometryContext = { '15m': { horizontalResistanceZones: [{ low: 1100, high: 1110 }], horizontalSupportZones: [] } };
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), geometryContext, candles: levelCandles('long', 'retest') }));
    assertEqual(plan.status, 'ready', 'status');
    assertEqual(plan.tp1, 1040, 'tp1 is the uncapped measured target');
    assertEqual(plan.tp2, null, 'tp2');
  });

  await test('owner decision 1a: gross R:R of exactly 3 passes even though net R:R after fees is below 3 (long + short mirror)', () => {
    // entry 1000, stop 985/1015 (risk 15), target 1045/955 (reward 45, gross RR 3.0
    // exactly). D-variant revised: minNetRR ships null by default, so a thin net R:R
    // never rejects on its own - only the gross floor gates here.
    for (const cand of [longCandidate({ invalidation: 985, measuredTarget: 1045 }), shortCandidate({ invalidation: 1015, measuredTarget: 955 })]) {
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles: levelCandles(cand.direction, 'retest') }));
      assertEqual(plan.status, 'ready', `${cand.direction}: status (gross floor met)`);
      assertEqual(plan.reasonCode, null, `${cand.direction}: reasonCode`);
      assertEqual(plan.grossRR, 3, `${cand.direction}: grossRR`);
      assert(plan.netRR < 3, `${cand.direction}: netRR ${plan.netRR} is below gross R:R but the off-by-default net gate never rejects it`);
    }
  });

  await test('T6 completion plan C1: dir-cost is a real gate difference, not just a reported number - a long can fail net_rr_below_min where the mirrored short still readies', () => {
    // Same gross geometry as the two tests above, but risk narrowed back to 10 (reward
    // 30, gross RR 3.0): the long's 34bps dir-cost now pushes net R:R under a 2.0
    // override floor (1.985), while the short's cheaper 14bps still clears it (2.509) -
    // dir-cost is direction-dependent at the GATE, not only in reporting. minNetRR ships
    // null by default (D-variant revised), so this test overrides it on to reach the gate.
    const cfg = withMinNetRR(2.0);
    const longPlan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ measuredTarget: 1030 }), candles: levelCandles('long', 'retest') }), cfg);
    assertEqual(longPlan.status, 'rejected', 'long: the 34bps dir-cost now fails the net gate on this fixture');
    assertEqual(longPlan.reasonCode, 'net_rr_below_min', 'long: reasonCode (costR stays well under 0.5)');
    assert(longPlan.netRR < 2.0, `long netRR ${longPlan.netRR} must be below the 2.0 override floor`);

    const shortPlan = buildFlagTradePlan(baseParams({ candidate: shortCandidate({ measuredTarget: 970 }), candles: levelCandles('short', 'retest') }), cfg);
    assertEqual(shortPlan.status, 'ready', 'short: the same gross geometry still readies - only the direction-dependent cost differs');
    assert(shortPlan.netRR >= 2.0, `short netRR ${shortPlan.netRR} must clear the 2.0 override floor`);
  });

  await test('rejected/rr_below_min: gross R:R 2.4 is below the 2.5 floor (long + short mirror)', () => {
    for (const cand of [longCandidate({ measuredTarget: 1024 }), shortCandidate({ measuredTarget: 976 })]) {
      const plan = buildFlagTradePlan(baseParams({ candidate: cand }));
      assertEqual(plan.status, 'rejected', `${cand.direction}: status`);
      assertEqual(plan.reasonCode, 'rr_below_min', `${cand.direction}: reasonCode`);
      assertEqual(plan.grossRR, 2.4, `${cand.direction}: grossRR published on the rejection`);
      assert(typeof plan.netRR === 'number', `${cand.direction}: netRR still published as information`);
    }
  });

  await test('never moves the stop to manufacture 3R: a rejected R:R plan still publishes the real stop (long + short mirror)', () => {
    const long = buildFlagTradePlan(baseParams({ candidate: longCandidate({ measuredTarget: 1029 }) }));
    assertEqual(long.stop, 990, 'stop is the candidate\'s own invalidation, unmoved');
    const short = buildFlagTradePlan(baseParams({ candidate: shortCandidate({ measuredTarget: 971 }) }));
    assertEqual(short.stop, 1010, 'short stop is the candidate\'s own invalidation, unmoved');
  });

  // T6 phase 1 net gate (docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md, owner decision D1 -
  // variant V1c): flagPlan.minNetRR ships ON at 2.0 (config 2026.09.24-3). A cfg
  // override is how scripts/replay-rules.js replayed the variants in-process (phase 0)
  // and how these tests reach the off/other-threshold code paths directly.
  function withMinNetRR(minNetRR) {
    return { ...ENGINE_CONFIG, flagPlan: { ...ENGINE_CONFIG.flagPlan, minNetRR } };
  }

  await test('net gate override (2.0): a gross-passing plan whose round-trip cost alone eats over half its risk is rejected stop_inside_costs (long + short mirror), levels kept', () => {
    // T6 completion plan C1: risk scaled to each direction's own dir-cost amount (34bps
    // long / 14bps short of entry) so costR/netRR land on the SAME clean numbers the
    // flat-cost fixture used - risk = cost/2 always yields costR=2.0, netRR=1/3.
    // D-variant revised: minNetRR ships null, so stop_inside_costs only fires under an
    // explicit override here (this reasonCode is research-only in production now).
    for (const cand of [longCandidate({ invalidation: 998.3, measuredTarget: 1005.1 }), shortCandidate({ invalidation: 1000.7, measuredTarget: 997.9 })]) {
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles: levelCandles(cand.direction, 'retest') }), withMinNetRR(2.0));
      assertEqual(plan.status, 'rejected', `${cand.direction}: status`);
      assertEqual(plan.reasonCode, 'stop_inside_costs', `${cand.direction}: reasonCode (costR >= 0.5)`);
      assertEqual(plan.grossRR, 3, `${cand.direction}: grossRR still published`);
      assertClose(plan.netRR, 0.333, 0.001, `${cand.direction}: netRR still published`);
      assertClose(plan.costR, 2.0, 0.001, `${cand.direction}: costR (round-trip dir-cost is 2x this stop's own risk)`);
      assertEqual(plan.entry, 1000, `${cand.direction}: entry unmoved`);
      assertEqual(plan.stop, cand.invalidation, `${cand.direction}: stop unmoved`);
      assertEqual(plan.tp1, cand.measuredTarget, `${cand.direction}: tp1 unmoved`);
    }
  });

  await test('net gate override: the real BTC 0.066%-stop incident (section 1a) is rejected stop_inside_costs, not ready', () => {
    // entry 83,409.4 / stop 83,464.3 / tp1 83,228 - the one GOOD call the whole T6 plan is about.
    // T6 completion plan C1: this incident is a short, so its dir-cost (14bps) is
    // CHEAPER than the flat 20bps this test originally assumed - netR is healthier
    // (0.38 vs the old 0.07), but costR (2.13) is still far over the 0.5 threshold, so
    // the incident is still caught, still stop_inside_costs, under a net gate override.
    // D-variant revised: minNetRR ships null in production, so this reasonCode is
    // research-only now; the override reaches the same code path direct.
    const cand = {
      candidateId: 'BTC:1m:short:incident', timeframe: '1m', type: 'flag', direction: 'short', state: 'confirmed',
      confidence: 80, chaseRisk: false, breakoutLevel: 83409.4, invalidation: 83464.3, measuredTarget: 83228
    };
    const plan = buildFlagTradePlan(baseParams({ candidate: cand }), withMinNetRR(2.0));
    assertClose(plan.grossRR, 3.30, 0.01, 'grossRR matches the incident (3.30)');
    assertClose(plan.netRR, 0.376, 0.001, 'netRR at the short (14bps) dir-cost');
    assertClose(plan.costR, 2.127, 0.001, 'costR at the short (14bps) dir-cost - still far over the 0.5 threshold');
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'stop_inside_costs', 'reasonCode');
  });

  // T6 completion plan C1: the fixtures below scale risk proportionally to each
  // direction's own dir-cost (34bps long / 14bps short of entry, cost = entry * bps)
  // so grossRR, netRR and costR land on the SAME clean numbers the pre-C1 flat-cost
  // fixtures used - a direction-neutral way to keep the "long + short mirror" loops
  // meaningful once the cost itself is no longer direction-neutral.
  await test('shipped default (2.0): a wider-stop plan clears the net gate and ships ready (long + short mirror)', () => {
    for (const cand of [longCandidate({ invalidation: 991.5, measuredTarget: 1034 }), shortCandidate({ invalidation: 1003.5, measuredTarget: 986 })]) {
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles: levelCandles(cand.direction, 'retest') }));
      assertEqual(plan.status, 'ready', `${cand.direction}: status`);
      assertEqual(plan.reasonCode, null, `${cand.direction}: reasonCode`);
      assertEqual(plan.grossRR, 4, `${cand.direction}: grossRR`);
      assertClose(plan.netRR, 2.571, 0.001, `${cand.direction}: netRR clears the 2.0 floor`);
      assertClose(plan.costR, 0.4, 0.001, `${cand.direction}: costR under the 0.5 stop_inside_costs threshold`);
    }
  });

  await test('rejected/net_rr_below_min (not costs-heavy): the same wider-stop plan fails a stricter override while costR stays under 0.5 (long + short mirror)', () => {
    for (const cand of [longCandidate({ invalidation: 991.5, measuredTarget: 1034 }), shortCandidate({ invalidation: 1003.5, measuredTarget: 986 })]) {
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles: levelCandles(cand.direction, 'retest') }), withMinNetRR(3.0));
      assertEqual(plan.status, 'rejected', `${cand.direction}: status`);
      assertEqual(plan.reasonCode, 'net_rr_below_min', `${cand.direction}: reasonCode (costR < 0.5, so the plainer code)`);
      assertClose(plan.costR, 0.4, 0.001, `${cand.direction}: costR`);
    }
  });

  await test('net gate boundary: net R:R exactly at the shipped 2.0 floor passes, not rejected (long + short mirror)', () => {
    for (const cand of [longCandidate({ invalidation: 989.8, measuredTarget: 1030.6 }), shortCandidate({ invalidation: 1004.2, measuredTarget: 987.4 })]) {
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles: levelCandles(cand.direction, 'retest') }));
      assertEqual(plan.status, 'ready', `${cand.direction}: status`);
      assertEqual(plan.reasonCode, null, `${cand.direction}: reasonCode`);
      assertClose(plan.netRR, 2.0, 0.001, `${cand.direction}: netRR at the floor`);
    }
  });

  await test('net gate off via explicit override: the thin-net-R:R plan ships ready when minNetRR is set to null (long + short mirror)', () => {
    for (const cand of [longCandidate({ invalidation: 999, measuredTarget: 1003 }), shortCandidate({ invalidation: 1001, measuredTarget: 997 })]) {
      const plan = buildFlagTradePlan(baseParams({ candidate: cand, candles: levelCandles(cand.direction, 'retest') }), withMinNetRR(null));
      assertEqual(plan.status, 'ready', `${cand.direction}: status (net gate explicitly off)`);
      assertEqual(plan.reasonCode, null, `${cand.direction}: reasonCode`);
    }
  });

  await test('net gate never overrides the gross gate: a gross-failing plan stays rr_below_min even with a lenient net override', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ measuredTarget: 1024 }) }), withMinNetRR(5));
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'rr_below_min', 'the gross gate runs first and short-circuits');
  });

  // T6 completion plan C1 (D-cost decision, docs/OWNER_DECISIONS_2026-09-24.md): direct
  // unit coverage of costRFraction/netRiskReward's new optional `direction` param,
  // beyond the end-to-end buildFlagTradePlan cases above.
  await test('costRFraction/netRiskReward: direction-dependent when direction is given (long 34bps, short 14bps), unchanged when omitted', () => {
    const riskCfg = ENGINE_CONFIG.risk;
    // costRFraction is cost-as-a-fraction-of-risk: costAmount (entry * bps/10000) / |entry-stop|.
    assertClose(costRFraction(1000, 990, riskCfg, 'long'), 0.34, 0.001, 'long: (34/10000 * 1000) / |1000-990|');
    assertClose(costRFraction(1000, 990, riskCfg, 'short'), 0.14, 0.001, 'short: (14/10000 * 1000) / 10');
    assertEqual(costRFraction(1000, 990, riskCfg), 0.2, 'direction omitted: flat (2*(5+5)/10000 * 1000) / 10');
    assertEqual(costRFraction(1000, 990, riskCfg, 'flat'), 0.2, 'an unrecognized direction token also falls back to flat');

    assertClose(netRiskReward(1000, 990, 1040, riskCfg, 'long'), (40 - 3.4) / (10 + 3.4), 0.0001, 'long netRR uses the 34bps cost amount (3.4 price units)');
    assertClose(netRiskReward(1000, 990, 1040, riskCfg, 'short'), (40 - 1.4) / (10 + 1.4), 0.0001, 'short netRR uses the 14bps cost amount (1.4 price units)');
    assertClose(netRiskReward(1000, 990, 1040, riskCfg), (40 - 2) / (10 + 2), 0.0001, 'direction omitted: flat cost amount (2), unchanged from before C1');
  });

  await test('costRFraction/netRiskReward: a missing costBpsByDirection key falls back to flat even when direction is given', () => {
    const bareCfg = { feeBps: 5, slippageBps: 5 };
    assertEqual(costRFraction(1000, 990, bareCfg, 'long'), 0.2, 'no costBpsByDirection on this cfg -> flat cost regardless of direction');
    assertClose(netRiskReward(1000, 990, 1040, bareCfg, 'short'), (40 - 2) / (10 + 2), 0.0001, 'same for netRiskReward');
  });

  await test('rejected/stop_distance_exceeds_cap: a 5% stop exceeds the 3% scalp cap (long)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate({ invalidation: 950, measuredTarget: 1200 }) }));
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'stop_distance_exceeds_cap', 'reasonCode');
    assertClose(plan.stopDistancePct, 5, 0.01, 'stopDistancePct');
  });

  await test('rejected/stop_distance_exceeds_cap (short mirror)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: shortCandidate({ invalidation: 1050, measuredTarget: 800 }) }));
    assertEqual(plan.reasonCode, 'stop_distance_exceeds_cap', 'reasonCode');
  });

  await test('rejected/stale_data: the candidate\'s own timeframe is stale', () => {
    const staleIso = new Date(NOW - 20 * INTERVAL_MS['1m']).toISOString();
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), closedThrough: staleIso }));
    assertEqual(plan.status, 'rejected', 'status');
    assertEqual(plan.reasonCode, 'stale_data', 'reasonCode');
    assertEqual(plan.entry, null, 'no numbers published on a stale-data rejection');
  });

  await test('rejected/stale_data: the borrowed geometry timeframe (15m) is stale even though 1m is fresh', () => {
    const staleIso = new Date(NOW - 20 * INTERVAL_MS['15m']).toISOString();
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), geometryClosedThrough: staleIso }));
    assertEqual(plan.reasonCode, 'stale_data', 'reasonCode');
  });

  await test('rejected/missing_data: closedThrough missing entirely fails closed, not treated as fresh', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), closedThrough: null }));
    assertEqual(plan.reasonCode, 'missing_data', 'reasonCode');
  });

  await test('4h-flat policy: buildFlagTradePlan takes no 4h/bias input, so it cannot be gated by it', () => {
    // The function signature itself proves this: no bias/trend argument exists, so a
    // caller cannot pass 4h context in even if it wanted to affect the verdict.
    const src = buildFlagTradePlan.toString();
    const paramList = src.slice(src.indexOf('(') + 1, src.indexOf(')'));
    assert(!/bias|trend|4h/i.test(paramList), `buildFlagTradePlan's parameters must not name a bias/trend/4h input, got: ${paramList}`);
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), candles: levelCandles('long', 'retest') }));
    assertEqual(plan.status, 'ready', 'a confirmed flag still reaches ready with no 4h information supplied at all');
  });

  await test('null when no confirmed directional flag candidate exists (coil / proto / forming / triggering / failed / expired)', () => {
    const nonEligible = [
      { type: 'coil', direction: 'neutral', state: 'forming', timeframe: '1m' },
      { ...longCandidate(), state: 'proto' },
      { ...longCandidate(), state: 'forming' },
      { ...longCandidate(), state: 'triggering' },
      { ...longCandidate(), state: 'failed' },
      { ...longCandidate(), state: 'expired' }
    ];
    for (const candidate of nonEligible) {
      const plan = buildFlagTradePlan(baseParams({ candidate }));
      assert(plan === null, `expected null for state=${candidate.state}/type=${candidate.type}, got ${JSON.stringify(plan)}`);
    }
  });

  await test('stable identity: identical input always produces the same plan object (deterministic)', () => {
    const params = baseParams({ candidate: longCandidate() });
    const a = buildFlagTradePlan(params);
    const b = buildFlagTradePlan(baseParams({ candidate: longCandidate() }));
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'two independent builds of the same input must match exactly');
    assert(a.planId.includes('TEST-CFG-1'), 'planId embeds configVersion');
  });

  await test('never mutates its inputs (candidateSetups, geometryContext)', () => {
    const geometryContext = { '15m': { horizontalResistanceZones: [{ low: 1020, high: 1025 }], horizontalSupportZones: [] } };
    const candidate = longCandidate();
    const params = baseParams({ candidate, geometryContext });
    const before = JSON.stringify({ candidateSetups: params.candidateSetups, geometryContext: params.geometryContext });
    buildFlagTradePlan(params);
    const after = JSON.stringify({ candidateSetups: params.candidateSetups, geometryContext: params.geometryContext });
    assertEqual(after, before, 'inputs must be unchanged after building a plan');
  });

  await test('selection: valid (ready/conditional) beats rejected regardless of confidence/timeframe', () => {
    const validLow = longCandidate({ candidateId: 'BTC:1m:long:A', timeframe: '1m', confidence: 10 });
    const rejectedHigh = { ...shortCandidate({ candidateId: 'BTC:3m:short:B', timeframe: '3m', confidence: 99 }), chaseRisk: true };
    const params = baseParams({ candidate: validLow });
    params.candidateSetups = [validLow, rejectedHigh];
    params.tfEntries['3m'] = { closedThrough: FRESH_1M };
    params.marketByTf['3m'] = { price: 1000, atr: 5 };
    const plan = buildFlagTradePlan(params);
    assertEqual(plan.candidateId, 'BTC:1m:long:A', 'the valid attempt wins even with lower confidence and a smaller timeframe');
  });

  await test('selection: among valid attempts, highest confidence wins', () => {
    const low = longCandidate({ candidateId: 'BTC:1m:long:LOW', confidence: 40 });
    const high = longCandidate({ candidateId: 'BTC:1m:long:HIGH', confidence: 90 });
    const params = baseParams({ candidate: low });
    params.candidateSetups = [low, high];
    const plan = buildFlagTradePlan(params);
    assertEqual(plan.candidateId, 'BTC:1m:long:HIGH', 'higher-confidence attempt selected');
  });

  await test('selection: a ready plan outranks a higher-confidence conditional plan', () => {
    const ready = longCandidate({ candidateId: 'BTC:1m:long:READY', confidence: 40 });
    const conditional = longCandidate({ candidateId: 'BTC:1m:long:COND', confidence: 95 });
    const params = baseParams({ candidate: ready, price: 1000 });
    params.candidateSetups = [conditional, ready];
    params.marketByTf['1m'] = { price: 1010, atr: 5 };
    params.marketByTf[ready.timeframe] = { price: 1003, atr: 5 };
    params.candlesByTf['1m'] = levelCandles('long', 'retest');
    // Same timeframe map cannot hold two different prices, so use 3m for the conditional.
    conditional.timeframe = '3m';
    params.tfEntries['3m'] = { closedThrough: FRESH_1M };
    params.marketByTf['3m'] = { price: 1010, atr: 5 };
    const plan = buildFlagTradePlan(params);
    assertEqual(plan.candidateId, 'BTC:1m:long:READY', 'the ready setup is the one published');
  });

  await test('selection: confidence tied, higher candidate timeframe wins (5m > 3m > 1m)', () => {
    const oneMin = longCandidate({ candidateId: 'BTC:1m:long:X', timeframe: '1m', confidence: 80 });
    const fiveMin = longCandidate({ candidateId: 'BTC:5m:long:Y', timeframe: '5m', confidence: 80 });
    const params = baseParams({ candidate: oneMin });
    params.candidateSetups = [oneMin, fiveMin];
    params.tfEntries['5m'] = { closedThrough: FRESH_1M };
    params.marketByTf['5m'] = { price: 1000, atr: 5 };
    const plan = buildFlagTradePlan(params);
    assertEqual(plan.candidateId, 'BTC:5m:long:Y', 'the 5m attempt wins the timeframe tie-break');
  });

  await test('T6 completion plan C4: FLAG_TF_RANK is forward-compatible for 15m/1h - ranks ahead of 5m on a confidence tie, even though neither is in the default candidate pool today', () => {
    const fiveMin = longCandidate({ candidateId: 'BTC:5m:long:X', timeframe: '5m', confidence: 80 });
    const fifteenMin = longCandidate({ candidateId: 'BTC:15m:long:Y', timeframe: '15m', confidence: 80 });
    const params = baseParams({ candidate: fiveMin });
    params.candidateSetups = [fiveMin, fifteenMin];
    params.tfEntries['15m'] = { closedThrough: FRESH_1M };
    params.marketByTf['15m'] = { price: 1000, atr: 5 };
    const plan = buildFlagTradePlan(params);
    assertEqual(plan.candidateId, 'BTC:15m:long:Y', 'the 15m attempt wins the timeframe tie-break over 5m');
  });

  await test('selection: confidence and timeframe tied, lexicographically-smaller candidateId wins (stable tie-break)', () => {
    const a = longCandidate({ candidateId: 'BTC:1m:long:2026-09-23T11:00:00.000Z', confidence: 80 });
    const b = longCandidate({ candidateId: 'BTC:1m:long:2026-09-23T12:00:00.000Z', confidence: 80 });
    const params = baseParams({ candidate: a });
    params.candidateSetups = [b, a]; // order in the input must not matter
    const plan = buildFlagTradePlan(params);
    assertEqual(plan.candidateId, a.candidateId, 'the lexicographically-earlier candidateId wins deterministically');
  });

  // -------------------------------------------------------------------------
  // Section 1b: shadowVariants (T6 completion plan D-variant, revised 2026-09-24,
  // docs/OWNER_DECISIONS_2026-09-24.md) - v3 (gross minRR 3.0, the former live rule)
  // computed shadow-only, real ATR/retest-hold, never the live plan.
  // -------------------------------------------------------------------------
  console.log('\n1b) shadowVariants (T6 completion plan D-variant, revised)\n');

  const V3_VARIANT = [{ id: 'v3', minRR: 3.0 }];

  await test('shadowVariants omitted: no shadow key at all (backward compatible)', () => {
    const plan = buildFlagTradePlan(baseParams({ candidate: longCandidate(), price: 1003, candles: levelCandles('long', 'retest') }));
    assertEqual(plan.shadow, undefined, 'no shadowVariants arg means no shadow field, same shape as before this feature');
  });

  await test('shadow variant with an identical outcome to the live plan publishes nothing (long + short)', () => {
    for (const candidateFn of [longCandidate, shortCandidate]) {
      const cand = candidateFn(); // grossRR 4.0 - ready under both minRR 2.5 (live) and 3.0 (shadow)
      const plan = buildFlagTradePlan(baseParams({
        candidate: cand, price: cand.direction === 'long' ? 1003 : 997,
        candles: levelCandles(cand.direction, 'retest'), shadowVariants: V3_VARIANT
      }));
      assertEqual(plan.status, 'ready', `${cand.direction}: live plan is ready`);
      assertEqual(plan.shadow, undefined, `${cand.direction}: v3 agrees with the live plan (also ready, same candidate) - nothing published`);
    }
  });

  await test('shadow variant that differs (ready live at the 2.5 floor, rejected rr_below_min under the stricter v3) publishes shadow.v3, full retest-hold semantics (long + short)', () => {
    for (const dir of ['long', 'short']) {
      // T6 completion plan C1: risk widened to 15 (from the default 10) so netRR stays
      // healthy under the 34bps long dir-cost too - net gate is off by default
      // (D-variant revised), but a wide stop keeps this fixture representative.
      const cand = dir === 'long' ? longCandidate({ invalidation: 985, measuredTarget: 1043.5 }) : shortCandidate({ invalidation: 1015, measuredTarget: 956.5 }); // grossRR 2.9
      const plan = buildFlagTradePlan(baseParams({
        candidate: cand, price: dir === 'long' ? 1003 : 997,
        candles: levelCandles(dir, 'retest'), shadowVariants: V3_VARIANT
      }));
      assertEqual(plan.status, 'ready', `${dir}: live plan ready (grossRR 2.9 >= shipped minRR 2.5)`);
      assertEqual(plan.reasonCode, null, `${dir}: live reasonCode`);
      assert(plan.shadow && plan.shadow.v3, `${dir}: shadow.v3 is published (v3's outcome differs from live)`);
      const v3 = plan.shadow.v3;
      assertEqual(v3.status, 'rejected', `${dir}: v3's stricter 3.0 gross floor rejects this candidate`);
      assertEqual(v3.reasonCode, 'rr_below_min', `${dir}: reasonCode`);
      assertEqual(v3.candidateId, cand.candidateId, `${dir}: same candidate as the live (ready) plan`);
      assertEqual(v3.entry, 1000, `${dir}: entry matches the candidate's own breakoutLevel, unmoved`);
      assertEqual(v3.stop, cand.invalidation, `${dir}: stop unmoved`);
      assertEqual(v3.grossRR, 2.9, `${dir}: grossRR`);
      assert(typeof v3.planId === 'string' && v3.planId.includes(cand.candidateId), `${dir}: shadow planId follows the live planId's own format`);
    }
  });

  await test('shadow variant that itself stays rejected (grossRR below both floors) publishes nothing', () => {
    const cand = longCandidate({ measuredTarget: 1015 }); // grossRR 1.5 - below v3's 3.0 floor too
    const plan = buildFlagTradePlan(baseParams({ candidate: cand, shadowVariants: V3_VARIANT }));
    assertEqual(plan.status, 'rejected', 'live plan rejected');
    assertEqual(plan.reasonCode, 'rr_below_min', 'live reasonCode');
    assertEqual(plan.shadow, undefined, 'v3 also rejects rr_below_min on the same candidate - identical outcome, nothing published');
  });

  await test('an unknown/malformed variant entry (no id, no minRR) is skipped without throwing', () => {
    const cand = longCandidate({ measuredTarget: 1029 }); // grossRR 2.9 - ready live (>=2.5), rejected under v3 (<3.0)
    const plan = buildFlagTradePlan(baseParams({
      candidate: cand, price: 1003, candles: levelCandles('long', 'retest'),
      shadowVariants: [{ id: 'broken' }, { minRR: 3.0 }, null, { id: 'v3', minRR: 3.0 }]
    }));
    assertEqual(JSON.stringify(Object.keys(plan.shadow || {})), JSON.stringify(['v3']), 'only the one well-formed variant is evaluated and (since it differs) published');
  });

  await test('pure and deterministic: calling twice with the same input yields a deep-equal shadow object', () => {
    const params = baseParams({
      candidate: longCandidate({ measuredTarget: 1029 }), price: 1003,
      candles: levelCandles('long', 'retest'), shadowVariants: V3_VARIANT
    });
    const a = buildFlagTradePlan(params);
    const b = buildFlagTradePlan(baseParams({
      candidate: longCandidate({ measuredTarget: 1029 }), price: 1003,
      candles: levelCandles('long', 'retest'), shadowVariants: V3_VARIANT
    }));
    assertEqual(JSON.stringify(a.shadow), JSON.stringify(b.shadow), 'identical inputs produce a byte-identical shadow object');
  });

  // -------------------------------------------------------------------------
  // Section 1c: SETUP tier (T6 completion plan C2) - the best still-conditional
  // attempt in the pool, surfaced even when a different candidate wins the live plan.
  // -------------------------------------------------------------------------
  console.log('\n1c) SETUP tier (T6 completion plan C2)\n');

  /** A second candidate on a different timeframe, breakout-close-only candles (conditional/awaiting_retest, valid economics). */
  function setupParams(readyCand, conditionalCand, dir) {
    const params = baseParams({ candidate: readyCand, price: dir === 'long' ? 1003 : 997, candles: levelCandles(dir, 'retest') });
    params.candidateSetups = [readyCand, conditionalCand];
    params.tfEntries['3m'] = { closedThrough: FRESH_1M };
    params.marketByTf['3m'] = { price: 1000, atr: 5 };
    params.candlesByTf['3m'] = levelCandles(dir, 'breakout');
    return params;
  }

  await test("setup surfaces a different candidate's still-conditional attempt even when the live plan is already ready (long + short mirror)", () => {
    for (const dir of ['long', 'short']) {
      const readyCand = dir === 'long' ? longCandidate() : shortCandidate();
      const conditionalCand = dir === 'long'
        ? longCandidate({ candidateId: 'BTC:3m:long:setup', timeframe: '3m' })
        : shortCandidate({ candidateId: 'BTC:3m:short:setup', timeframe: '3m' });
      const plan = buildFlagTradePlan(setupParams(readyCand, conditionalCand, dir));
      assertEqual(plan.status, 'ready', `${dir}: live plan is the 1m ready candidate`);
      assertEqual(plan.candidateId, readyCand.candidateId, `${dir}: live plan matches the ready candidate, not the conditional one`);
      assert(plan.setup, `${dir}: setup is published`);
      assertEqual(plan.setup.candidateId, conditionalCand.candidateId, `${dir}: setup surfaces the DIFFERENT (3m, still-conditional) candidate`);
      assertEqual(plan.setup.timeframe, '3m', `${dir}: setup timeframe`);
      assertEqual(plan.setup.direction, dir, `${dir}: setup direction`);
      assertEqual(plan.setup.entry, 1000, `${dir}: setup entry (breakoutLevel, unmoved)`);
      assertEqual(plan.setup.stop, conditionalCand.invalidation, `${dir}: setup stop unmoved`);
      assertEqual(plan.setup.grossRR, 4, `${dir}: setup grossRR (same default candidate economics as the ready one)`);
      assert(typeof plan.setup.netRR === 'number', `${dir}: setup netRR published (dir-cost, T6 completion plan C1)`);
      assert(typeof plan.setup.entryCondition === 'string' && plan.setup.entryCondition.length > 0, `${dir}: setup carries the exact trigger sentence`);
    }
  });

  await test('no qualifying conditional attempt: setup is null, not omitted (long + short mirror)', () => {
    for (const dir of ['long', 'short']) {
      const readyCand = dir === 'long' ? longCandidate() : shortCandidate();
      const plan = buildFlagTradePlan(baseParams({ candidate: readyCand, price: dir === 'long' ? 1003 : 997, candles: levelCandles(dir, 'retest') }));
      assertEqual(plan.status, 'ready', `${dir}: sanity, live plan ready`);
      assertEqual(plan.setup, null, `${dir}: no other conditional candidate exists - setup is null, not undefined`);
      assert('setup' in plan, `${dir}: the setup key itself is always present`);
    }
  });

  await test('SETUP fixture that becomes ready: once the retest-hold close lands, setup drops to null and the plan itself is now ready (long + short mirror)', () => {
    for (const dir of ['long', 'short']) {
      const cand = dir === 'long'
        ? longCandidate({ candidateId: 'BTC:3m:long:setup2', timeframe: '3m' })
        : shortCandidate({ candidateId: 'BTC:3m:short:setup2', timeframe: '3m' });
      const params = baseParams({ candidate: cand, price: 1000, candles: levelCandles(dir, 'breakout') });
      const conditional = buildFlagTradePlan(params);
      assertEqual(conditional.status, 'conditional', `${dir}: sole candidate is conditional (breakout close only)`);
      assert(conditional.setup && conditional.setup.candidateId === cand.candidateId, `${dir}: the sole conditional candidate is also its own setup`);

      params.candlesByTf[cand.timeframe] = levelCandles(dir, 'retest');
      params.marketByTf[cand.timeframe] = { price: dir === 'long' ? 1003 : 997, atr: 5 };
      const ready = buildFlagTradePlan(params);
      assertEqual(ready.status, 'ready', `${dir}: same candidate now clears the retest-hold`);
      assertEqual(ready.candidateId, cand.candidateId, `${dir}: same candidate`);
      assertEqual(ready.setup, null, `${dir}: no longer any conditional-status attempt in the pool - setup drops to null`);
    }
  });

  await test('SETUP fixture that voids: once the candidate leaves the confirmed pool (failed/expired), setup drops to null (long + short mirror)', () => {
    for (const dir of ['long', 'short']) {
      const cand = dir === 'long'
        ? longCandidate({ candidateId: 'BTC:3m:long:setup3', timeframe: '3m' })
        : shortCandidate({ candidateId: 'BTC:3m:short:setup3', timeframe: '3m' });
      const params = baseParams({ candidate: cand, price: 1000, candles: levelCandles(dir, 'breakout') });
      const conditional = buildFlagTradePlan(params);
      assertEqual(conditional.status, 'conditional', `${dir}: sanity, sole candidate is conditional`);
      assert(conditional.setup, `${dir}: setup published while the candidate is still confirmed`);

      params.candidateSetups = [{ ...cand, state: 'failed' }];
      const voided = buildFlagTradePlan(params);
      assertEqual(voided, null, `${dir}: a failed candidate drops out of the confirmed pool entirely - no plan at all, no setup`);
    }
  });

  // -------------------------------------------------------------------------
  // Section 2: full pipeline, 4h-flat policy + legacy-output parity
  // -------------------------------------------------------------------------
  console.log('\n2) full buildScalpContext pipeline (REGRESSION_001 fixture, flat higher timeframes)\n');

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

  const PIPE_NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

  async function buildWith1m(candles1m) {
    return buildScalpContext({
      symbols: ['BTC'],
      now: PIPE_NOW,
      fetchCandles: async (pair, interval) => (interval === '1m' ? withTimes(candles1m, PIPE_NOW) : quietCandles(interval, 300, PIPE_NOW)),
      fetchAccount: async () => ({ status: 'disabled', margin: { usd: null, byAsset: {} } })
    });
  }

  await test('4h-flat policy end to end: legacy strategies stay blocked by 4h-flat while the flag plan is decided on its own merits', async () => {
    const result = await buildWith1m(regression001());
    const sym = result.symbols.BTC;
    assertEqual(sym.timeframes['4h'].trend, 'FLAT', '4h trend is flat in this fixture');
    assertEqual(sym.bestSignal, null, 'legacy bestSignal stays null (blocked by 4h-flat, untouched by this plan)');
    assert(/4H trend is FLAT/i.test(sym.strategies.SCALP_1H.reason || ''), 'SCALP_1H still cites the 4h-flat rejection verbatim');

    const plan = sym.flagTradePlan;
    assert(plan, 'the confirmed 1m flag candidate must still produce a plan verdict');
    assert(plan.reasonCode !== 'stale_data' && plan.reasonCode !== 'missing_data', 'the plan is decided on its own data, not blocked by anything 4h-related');
    assert(!/4h|4H/.test(String(plan.reasonCode)), 'no 4h-flavored rejection code exists on the flag plan');
  });

  await test('legacy-output parity: strategies/bestSignal for the mirrored short candle set are unaffected by the flag plan', async () => {
    const result = await buildWith1m(mirror(regression001()));
    const sym = result.symbols.BTC;
    assertEqual(sym.bestSignal, null, 'still blocked by 4h-flat, mirrored case');
    assert(/4H trend is FLAT/i.test(sym.strategies.SCALP_1H.reason || ''), 'SCALP_1H rejection reason unchanged, mirrored case');
    assert(sym.flagTradePlan, 'a plan verdict still exists for the mirrored short candidate');
    assertEqual(sym.flagTradePlan.direction, 'short', 'the selected plan reflects the short candidate');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
