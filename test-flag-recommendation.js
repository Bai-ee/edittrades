/**
 * Deterministic tests for the 21/200 flag recommendation record.
 *
 * Run: node test-flag-recommendation.js
 */

import { buildFlagRecommendation, compactRecommendation } from './lib/flagRecommendation.js';
import { INTERVAL_MS } from './services/scalpContext.js';

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

function hasCode(list, code) {
  return (list || []).some((r) => r.code === code);
}

const AS_OF = '2026-09-23T12:00:00.000Z';

function readyPlan(over = {}) {
  return {
    candidateId: 'BTC:1m:long:2026-09-23T11:50:00.000Z',
    planId: 'BTC:1m:long:2026-09-23T11:50:00.000Z|2026-09-23T12:00:00.000Z|TEST',
    timeframe: '1m',
    direction: 'long',
    status: 'ready',
    reasonCode: null,
    entryType: 'retest',
    entryCondition: 'closed candle retests 1000 and holds at or above it',
    entry: 1000,
    stop: 990,
    tp1: 1040,
    tp2: null,
    grossRR: 4,
    netRR: 3.2,
    stopDistancePct: 1,
    ...over
  };
}

function evidence(over = {}) {
  return {
    flags: [{
      candidateId: 'BTC:1m:long:2026-09-23T11:50:00.000Z',
      timeframe: '1m',
      direction: 'long',
      state: 'confirmed',
      confidence: 82,
      ema21Hold: 'hold',
      ema200Side: 'below',
      breakoutLevel: 1000,
      invalidation: 990,
      measuredTarget: 1040,
      lifecycleState: 'confirmed',
      withSentiment: true
    }],
    ma: {
      map: {
        '1m': {
          priceVsEma21: 'above',
          priceVsEma200: 'below',
          ema21: 998,
          ema200: 1010,
          unavailable: { ema21: null, ema200: null }
        },
        '1w': {
          priceVsEma21: 'above',
          priceVsEma200: 'unknown',
          ema21: 900,
          ema200: null,
          unavailable: { ema21: null, ema200: 'insufficient history for weekly EMA200' }
        }
      },
      pull: { direction: 'none' }
    },
    channels: {
      nearestLevelAhead: { timeframe: '1h', kind: 'resistance_zone', price: 1030 },
      levelsAhead: [{ timeframe: '1h', kind: 'resistance_zone', price: 1030 }],
      channels: {
        '1h': { edge: 'top', breakoutRisk: 'medium', positionPct: 88 }
      }
    },
    divergence: {
      confluence: { bullish: 1, bearish: 0 },
      byTimeframe: {
        '1m': { type: 'bullish', kind: 'standard', ageCandles: 3, strength: 0.9 }
      }
    },
    ...over
  };
}

function topDown(over = {}) {
  return {
    sentiment: 'bull',
    aligned: 4,
    score: 1,
    leans: { '1w': 'bull', '1d': 'bull', '4h': 'bull', '1h': 'bull' },
    weekly: { close: 1000, ema21: 950, ema21Slope: 3, ema200: null, reason: 'insufficient history for weekly EMA200' },
    above200: { count: 4, of: 7, weighted: 0.55 },
    ...over
  };
}

function rec({ plan = readyPlan(), ev = evidence(), td = topDown(), dataStatus = 'complete' } = {}) {
  return buildFlagRecommendation({
    symbol: 'BTC',
    asOf: AS_OF,
    dataStatus,
    flagTradePlan: plan,
    evidence: ev,
    topDown: td
  });
}

async function run() {
  console.log('\nlib/flagRecommendation.js\n');

  await test('GOOD: ready engine-owned plan, >=3 gross R, aligned context, exact supports and change condition', () => {
    const r = rec();
    assertEqual(r.class, 'GOOD', 'class');
    assertEqual(r.readiness, 'ready', 'readiness');
    assert(hasCode(r.supports, 'ready_flag_plan'), 'ready plan support');
    assert(hasCode(r.supports, 'rr_ok'), 'gross RR support');
    assert(/Gross R:R to TP1 is 4, meeting the 3R floor/.test(r.supports.find((x) => x.code === 'rr_ok').text), 'rr_ok cites grossRR and the floor');
    assert(!hasCode(r.opposes, 'net_rr_low'), 'net 3.2 >= 3: no fee warning');
    assert(hasCode(r.supports, 'top_down_context'), 'top-down support');
    assert(hasCode(r.supports, 'divergence_agrees'), 'divergence support');
    assert(hasCode(r.changeConditions, 'call_changes_on_invalidation'), 'change condition');
    assert(r.factorStates.some((f) => f.code === 'ema200_side' && /not a veto/.test(f.explanation)), 'EMA200 side is context, not veto');
    assert(r.unknowns.some((u) => u.code === 'level_context_missing') === false, 'nearest level was known');
  });

  await test('GOOD: long below EMA200 remains valid when the plan and other factors support it', () => {
    const r = rec();
    assertEqual(r.class, 'GOOD', 'class');
    assert(r.factorStates.some((f) => f.code === 'ema200_side' && f.state === 'below'), 'counter-EMA200 context recorded');
  });

  await test('WATCH: conditional plan names the exact entry condition that would change the call', () => {
    const r = rec({ plan: readyPlan({ status: 'conditional', reasonCode: 'awaiting_retest' }) });
    assertEqual(r.class, 'WATCH', 'class');
    assert(hasCode(r.changeConditions, 'entry_condition'), 'entry condition change');
    assert(/closed candle retests/.test(r.changeConditions.find((c) => c.code === 'entry_condition').text), 'condition text copied');
  });

  await test('WATCH: no flagTradePlan does not fall back to legacy bestSignal authority', () => {
    const r = rec({ plan: null, ev: evidence({ flags: [] }) });
    assertEqual(r.class, 'WATCH', 'class');
    assertEqual(r.readiness, 'no_plan', 'readiness');
    assert(hasCode(r.changeConditions, 'need_confirmed_flag_plan'), 'needed event');
    assert(r.factorStates.some((f) => /legacy bestSignal is not/.test(f.explanation)), 'legacy authority warning');
  });

  await test('BAD: rejected rr_below_min cites grossRR and the floor (long + short mirror)', () => {
    for (const direction of ['long', 'short']) {
      const r = rec({ plan: readyPlan({ direction, status: 'rejected', reasonCode: 'rr_below_min', grossRR: 2.9, netRR: 2.1 }) });
      assertEqual(r.class, 'BAD', `${direction}: class`);
      assert(hasCode(r.opposes, 'rr_below_min'), `${direction}: rr rejection`);
      assertEqual(r.primaryReason.code, 'rr_below_min', `${direction}: primary reason`);
      assert(/gross R:R to TP1 is 2\.9, below the 3R floor/.test(r.primaryReason.text), `${direction}: text cites grossRR and floor, got ${r.primaryReason.text}`);
    }
  });

  await test('owner decision 1a + T6 phase 1: gross >= floor but net < floor is never BAD; fees_heavy warns (long + short mirror, ready + conditional)', () => {
    for (const direction of ['long', 'short']) {
      const ready = rec({ plan: readyPlan({ direction, grossRR: 3.16, netRR: 0.023 }), td: topDown({ sentiment: direction === 'short' ? 'bear' : 'bull' }) });
      assertEqual(ready.class, 'GOOD', `${direction}: ready plan with gross 3.16 stays GOOD`);
      assert(hasCode(ready.supports, 'rr_ok'), `${direction}: rr_ok support`);
      const warn = ready.opposes.find((x) => x.code === 'fees_heavy');
      assert(warn && /Net R:R after fees is 0\.023; fees eat the edge/.test(warn.text), `${direction}: fees_heavy text, got ${warn && warn.text}`);

      const cond = rec({ plan: readyPlan({ direction, status: 'conditional', reasonCode: 'awaiting_retest', grossRR: 3.16, netRR: 0.023 }) });
      assertEqual(cond.class, 'WATCH', `${direction}: conditional stays WATCH`);
      assert(hasCode(cond.opposes, 'fees_heavy'), `${direction}: conditional also warns`);
    }
  });

  await test('DATA_UNAVAILABLE: stale required plan data does not become bearish or bullish evidence', () => {
    const r = rec({ plan: readyPlan({ status: 'rejected', reasonCode: 'stale_data' }) });
    assertEqual(r.class, 'DATA_UNAVAILABLE', 'class');
    assert(hasCode(r.unknowns, 'stale_data'), 'stale unknown');
    assert(hasCode(r.changeConditions, 'fresh_closed_candles'), 'fresh data event');
    assertEqual(r.supports.length, 0, 'no support fabricated');
  });

  await test('mixed top-down context lowers quality but does not veto a ready plan', () => {
    const r = rec({ td: topDown({ sentiment: 'mixed', aligned: 2, score: 0, leans: { '1w': 'bull', '1d': 'bear', '4h': 'bear', '1h': 'bull' } }) });
    assertEqual(r.class, 'GOOD', 'class');
    assert(hasCode(r.opposes, 'top_down_context'), 'mixed context is opposing/contextual');
  });

  await test('channel/level context cites first level ahead and preserves engine-owned TP1 authority', () => {
    const r = rec();
    const support = r.supports.find((s) => s.code === 'first_level_ahead');
    assert(support && support.text.includes('1030'), 'first level price cited');
    assert(/TP1 is engine-owned/.test(support.text), 'does not reprices TP1');
  });

  await test('divergence conflict is opposing evidence, not an automatic veto', () => {
    const r = rec({ ev: evidence({ divergence: { confluence: { bullish: 1, bearish: 1 }, byTimeframe: {} } }) });
    assertEqual(r.class, 'GOOD', 'class still good');
    assert(hasCode(r.supports, 'divergence_agrees'), 'agreeing divergence');
    assert(hasCode(r.opposes, 'divergence_conflicts'), 'conflicting divergence');
  });

  await test('missing weekly EMA200 stays visible as unknown provenance in model evidence, not a class veto', () => {
    const r = rec();
    assertEqual(r.class, 'GOOD', 'class');
    assert(r.factorStates.some((f) => f.code === 'ema200_side'), 'EMA200 context present');
    assertEqual(evidence().ma.map['1w'].unavailable.ema200, 'insufficient history for weekly EMA200', 'fixture carries missing weekly EMA200 reason');
  });

  await test('same input produces byte-stable recommendation records', () => {
    const a = rec();
    const b = rec();
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'stable JSON');
  });

  await test('mirror short: aligned bear setup gets equivalent GOOD class and bearish divergence support', () => {
    const plan = readyPlan({
      candidateId: 'BTC:1m:short:2026-09-23T11:50:00.000Z',
      planId: 'BTC:1m:short:2026-09-23T11:50:00.000Z|2026-09-23T12:00:00.000Z|TEST',
      direction: 'short',
      entryCondition: 'closed candle retests 1000 and holds at or below it',
      stop: 1010,
      tp1: 960
    });
    const ev = evidence({
      flags: [{ ...evidence().flags[0], candidateId: plan.candidateId, direction: 'short', ema200Side: 'above' }],
      ma: { map: { '1m': { priceVsEma21: 'below', priceVsEma200: 'above', ema21: 1002, ema200: 990, unavailable: { ema21: null, ema200: null } } } },
      divergence: { confluence: { bullish: 0, bearish: 1 }, byTimeframe: {} }
    });
    const r = rec({ plan, ev, td: topDown({ sentiment: 'bear', aligned: 4, leans: { '1w': 'bear', '1d': 'bear', '4h': 'bear', '1h': 'bear' } }) });
    assertEqual(r.class, 'GOOD', 'class');
    assert(hasCode(r.supports, 'divergence_agrees'), 'bearish divergence agrees');
    assert(r.factorStates.some((f) => f.code === 'ema200_side' && f.state === 'above'), 'short above EMA200 recorded as context');
  });

  const NOW_MS = Date.parse(AS_OF);
  const freshness = (over = {}) => ['1m', '3m', '5m'].map((tf) => ({ tf, closedThroughIso: over[tf] === undefined ? AS_OF : over[tf], intervalMs: INTERVAL_MS[tf], graceMs: 5000 }));
  const noPlan = (flagFreshness, dataStatus = 'complete') => buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus, flagTradePlan: null, evidence: evidence({ flags: [] }), topDown: topDown(), flagFreshness, now: NOW_MS });

  await test('review fix 5: no plan + stale 1m -> DATA_UNAVAILABLE naming 1m, not WATCH', () => {
    const r = noPlan(freshness({ '1m': '2026-09-23T11:50:00.000Z' }));
    assertEqual(r.class, 'DATA_UNAVAILABLE', 'class');
    assert(hasCode(r.unknowns, 'stale_data:1m'), `unknowns name 1m: ${JSON.stringify(r.unknowns.map((u) => u.code))}`);
    assert(!r.unknowns.some((u) => /3m|5m/.test(u.code)), 'fresh timeframes are not named');
    // Phase 2: undirected context follows; the stale timeframe stays first.
    assertEqual(compactRecommendation(r).unknowns[0], 'stale_data:1m', 'compact form carries the code first');
  });

  await test('review fix 5: no plan + missing 3m closedThrough -> DATA_UNAVAILABLE naming 3m', () => {
    const r = noPlan(freshness({ '3m': null }));
    assertEqual(r.class, 'DATA_UNAVAILABLE', 'class');
    assert(hasCode(r.unknowns, 'missing_data:3m'), 'missing 3m named');
  });

  await test('review fix 5: no plan + all flag timeframes fresh -> WATCH as before; dataStatus unavailable -> DATA_UNAVAILABLE', () => {
    assertEqual(noPlan(freshness()).class, 'WATCH', 'fresh -> WATCH');
    assertEqual(noPlan(freshness(), 'unavailable').class, 'DATA_UNAVAILABLE', 'unavailable -> DATA_UNAVAILABLE');
  });

  await test('review fix 9 + T6 phase 1: the gross floor is read from flagPlan.minRR, the net floor from flagPlan.minNetRR, only', () => {
    const plan = readyPlan({ netRR: 3.2 });
    // planCfg fully replaces the default here (no minNetRR key -> undefined -> falls back to minRR for the net-floor text, same as the pre-phase-1 informational read).
    const strict = buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus: 'complete', flagTradePlan: plan, evidence: evidence(), topDown: topDown(), planCfg: { minRR: 4 } });
    assertEqual(strict.class, 'GOOD', 'a 4R floor never turns net 3.2 into BAD');
    assert(hasCode(strict.opposes, 'fees_heavy'), 'net below the (fallback) 4R floor is warned');
    assert(/meeting the 4R floor/.test(strict.supports.find((x) => x.code === 'rr_ok').text), 'rr_ok cites flagPlan.minRR');
    // Default planCfg (real ENGINE_CONFIG.flagPlan, minNetRR 2.0): net 3.2 clears it -> net_rr_ok, not fees_heavy.
    const loose = buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus: 'complete', flagTradePlan: plan, evidence: evidence(), topDown: topDown(), cfg: { minRR: 10, decisionWeights: {} } });
    assertEqual(loose.class, 'GOOD', 'a stray model.minRR is ignored');
    assert(!hasCode(loose.opposes, 'fees_heavy'), 'model.minRR does not set the net floor');
    assert(hasCode(loose.supports, 'net_rr_ok'), 'net 3.2 clears the shipped 2.0 net floor');
  });

  await test('review nit 13: an explicit 0 weight is honoured (?? not ||)', () => {
    const r = buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus: 'complete', flagTradePlan: readyPlan(), evidence: evidence(), topDown: topDown(), cfg: { decisionWeights: { readiness: 0, pattern: 20, topDown: 15, maContext: 10, channel: 10, divergence: 10 } } });
    const readiness = r.factorStates.find((f) => f.code === 'score_readiness');
    assertEqual(readiness.state, 0, 'readiness contributes 0 with weight 0');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
