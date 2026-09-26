/**
 * Deterministic tests for the 21/200 flag recommendation record.
 *
 * Run: node test-flag-recommendation.js
 */

import { buildFlagRecommendation, compactRecommendation, selectWatchCandidate, nextCloseEta, roomAhead, buildClarity, qualWords } from './lib/flagRecommendation.js';
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

function rec({ plan = readyPlan(), ev = evidence(), td = topDown(), dataStatus = 'complete', planCfg } = {}) {
  return buildFlagRecommendation({
    symbol: 'BTC',
    asOf: AS_OF,
    dataStatus,
    flagTradePlan: plan,
    evidence: ev,
    topDown: td,
    ...(planCfg ? { planCfg } : {})
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
    assert(/Gross R:R to TP1 is 4, meeting the 2\.5R floor/.test(r.supports.find((x) => x.code === 'rr_ok').text), 'rr_ok cites grossRR and the floor');
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

  await test('T6 completion plan C4: FLAG_TF_ORDER is forward-compatible for 15m/1h - still loses the tie to 5m (smallest timeframe wins), even though neither is in the default candidate pool today', () => {
    const fiveMin = { candidateId: 'BTC:5m:long:X', type: 'flag', direction: 'long', state: 'forming', timeframe: '5m', confidence: 70 };
    const fifteenMin = { candidateId: 'BTC:15m:long:Y', type: 'flag', direction: 'long', state: 'forming', timeframe: '15m', confidence: 70 };
    const oneHour = { candidateId: 'BTC:1h:long:Z', type: 'flag', direction: 'long', state: 'forming', timeframe: '1h', confidence: 70 };
    assertEqual(selectWatchCandidate([fifteenMin, fiveMin]).candidateId, fiveMin.candidateId, '5m still wins over 15m on a tie');
    assertEqual(selectWatchCandidate([oneHour, fifteenMin]).candidateId, fifteenMin.candidateId, '15m wins over 1h on a tie (still smallest-first)');
  });

  await test('T6 completion plan C2: setup is copied straight through from flagTradePlan.setup, in both the full record and the default-payload compact form (long + short mirror)', () => {
    const setupFields = {
      candidateId: 'BTC:3m:long:setup', timeframe: '3m', direction: 'long', entry: 1000, stop: 990, tp1: 1040,
      grossRR: 4, netRR: 2.7, entryCondition: "a closed candle closes above 1000, then a later closed candle's low reaches within 0.1 ATR of 1000 and closes at or above it"
    };
    const r = rec({ plan: readyPlan({ setup: setupFields }) });
    assertEqual(r.class, 'GOOD', 'sanity: class unaffected by setup (still GOOD on the ready plan)');
    assertEqual(JSON.stringify(r.setup), JSON.stringify(setupFields), 'full record: setup copied through exactly');
    const compact = compactRecommendation(r);
    assertEqual(JSON.stringify(compact.setup), JSON.stringify(setupFields), 'compact (default-payload) record also carries setup, not stripped');
  });

  await test('T6 completion plan C2: no flagTradePlan.setup -> recommendation.setup is null, not omitted, in both forms', () => {
    const r = rec({ plan: readyPlan() }); // readyPlan() has no setup key at all
    assertEqual(r.setup, null, 'full record: setup null when flagTradePlan carries none');
    assertEqual(compactRecommendation(r).setup, null, 'compact record: same');

    const rNoPlan = rec({ plan: null, ev: evidence({ flags: [] }) });
    assertEqual(rNoPlan.setup, null, 'no plan at all -> setup null, not thrown');
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
      const r = rec({ plan: readyPlan({ direction, status: 'rejected', reasonCode: 'rr_below_min', grossRR: 2.4, netRR: 2.1 }) });
      assertEqual(r.class, 'BAD', `${direction}: class`);
      assert(hasCode(r.opposes, 'rr_below_min'), `${direction}: rr rejection`);
      assertEqual(r.primaryReason.code, 'rr_below_min', `${direction}: primary reason`);
      assert(/gross R:R to TP1 is 2\.4, below the 2\.5R floor/.test(r.primaryReason.text), `${direction}: text cites grossRR and floor, got ${r.primaryReason.text}`);
    }
  });

  await test('T6 completion plan A2: BAD on net_rr_below_min cites the net floor and grossRR (long + short mirror)', () => {
    for (const direction of ['long', 'short']) {
      const r = rec({ plan: readyPlan({ direction, status: 'rejected', reasonCode: 'net_rr_below_min', grossRR: 3.5, netRR: 1.2, costR: 0.3 }), planCfg: { minRR: 3, minNetRR: 2.0 } });
      assertEqual(r.class, 'BAD', `${direction}: class`);
      assert(hasCode(r.opposes, 'net_rr_below_min'), `${direction}: net rejection is opposes[0]`);
      assertEqual(r.primaryReason.code, 'net_rr_below_min', `${direction}: primary reason`);
      assert(/net R:R after fees is 1\.2, below the 2R floor/.test(r.primaryReason.text), `${direction}: text cites netRR and the net floor, got ${r.primaryReason.text}`);
      assert(hasCode(r.changeConditions, 'new_valid_plan'), `${direction}: remedy event`);
      const remedy = r.changeConditions.find((c) => c.code === 'new_valid_plan');
      assert(/net R:R after fees is >= 2R/.test(remedy.text), `${direction}: remedy names the net floor, got ${remedy.text}`);
    }
  });

  await test('T6 completion plan A2: BAD on stop_inside_costs cites the cost fraction of risk (long + short mirror)', () => {
    for (const direction of ['long', 'short']) {
      // The real BTC 0.066%-stop incident: gross 3.30 passes, net 0.07 fails hard, costR ~3.0.
      const r = rec({ plan: readyPlan({ direction, status: 'rejected', reasonCode: 'stop_inside_costs', grossRR: 3.3, netRR: 0.07, costR: 3.04 }), planCfg: { minRR: 3, minNetRR: 2.0 } });
      assertEqual(r.class, 'BAD', `${direction}: class`);
      assert(hasCode(r.opposes, 'stop_inside_costs'), `${direction}: cost rejection is opposes[0]`);
      assertEqual(r.primaryReason.code, 'stop_inside_costs', `${direction}: primary reason`);
      assert(/round-trip cost is 3\.04R of this stop's risk/.test(r.primaryReason.text), `${direction}: text cites costR, got ${r.primaryReason.text}`);
    }
  });

  await test('D-variant revised: gross >= floor but net < 1.0R is never BAD; net_rr_low warns (long + short mirror, ready + conditional)', () => {
    for (const direction of ['long', 'short']) {
      const ready = rec({ plan: readyPlan({ direction, grossRR: 3.16, netRR: 0.023 }), td: topDown({ sentiment: direction === 'short' ? 'bear' : 'bull' }) });
      assertEqual(ready.class, 'GOOD', `${direction}: ready plan with gross 3.16 stays GOOD`);
      assert(hasCode(ready.supports, 'rr_ok'), `${direction}: rr_ok support`);
      const warn = ready.opposes.find((x) => x.code === 'net_rr_low');
      assert(warn && /Net R:R after fees is 0\.023; thin after fees/.test(warn.text), `${direction}: net_rr_low text, got ${warn && warn.text}`);

      const cond = rec({ plan: readyPlan({ direction, status: 'conditional', reasonCode: 'awaiting_retest', grossRR: 3.16, netRR: 0.023 }) });
      assertEqual(cond.class, 'WATCH', `${direction}: conditional stays WATCH`);
      assert(hasCode(cond.opposes, 'net_rr_low'), `${direction}: conditional also warns`);
    }
  });

  await test('net gate override: gross >= floor but net < minNetRR is never BAD; fees_heavy warns (long mirror)', () => {
    const ready = rec({ plan: readyPlan({ grossRR: 3.16, netRR: 1.5 }), planCfg: { minRR: 2.5, minNetRR: 2.0 } });
    assertEqual(ready.class, 'GOOD', 'ready plan with gross 3.16 stays GOOD under a net override');
    const warn = ready.opposes.find((x) => x.code === 'fees_heavy');
    assert(warn && /Net R:R after fees is 1\.5; fees eat the edge/.test(warn.text), `fees_heavy text, got ${warn && warn.text}`);
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

  await test('review fix 9 + D-variant revised: the gross floor is read from flagPlan.minRR, the net floor from flagPlan.minNetRR (or the fixed 1.0R floor when off), never model cfg', () => {
    const plan = readyPlan({ netRR: 3.2 });
    // planCfg fully replaces the default here; no minNetRR key -> undefined -> net gate
    // off -> the fixed 1.0R net_rr_low floor applies, not flagPlan.minRR (the old
    // fallback-to-minRR net floor was removed by D-variant revised).
    const strict = buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus: 'complete', flagTradePlan: plan, evidence: evidence(), topDown: topDown(), planCfg: { minRR: 4 } });
    assertEqual(strict.class, 'GOOD', 'a 4R gross floor never turns net 3.2 into BAD');
    assert(!hasCode(strict.opposes, 'fees_heavy'), 'net gate off: no fees_heavy, the old minRR-fallback floor is gone');
    assert(hasCode(strict.supports, 'net_rr_ok'), 'net 3.2 clears the fixed 1.0R net_rr_low floor');
    assert(/meeting the 4R floor/.test(strict.supports.find((x) => x.code === 'rr_ok').text), 'rr_ok cites flagPlan.minRR');
    // Default planCfg (real ENGINE_CONFIG.flagPlan, minNetRR null): net gate stays off regardless of a stray model.minRR.
    const loose = buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus: 'complete', flagTradePlan: plan, evidence: evidence(), topDown: topDown(), cfg: { minRR: 10, decisionWeights: {} } });
    assertEqual(loose.class, 'GOOD', 'a stray model.minRR is ignored');
    assert(!hasCode(loose.opposes, 'fees_heavy'), 'model.minRR does not set the net floor');
    assert(hasCode(loose.supports, 'net_rr_ok'), 'net 3.2 clears the fixed 1.0R net_rr_low floor');
  });

  await test('review nit 13: an explicit 0 weight is honoured (?? not ||)', () => {
    const r = buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus: 'complete', flagTradePlan: readyPlan(), evidence: evidence(), topDown: topDown(), cfg: { decisionWeights: { readiness: 0, pattern: 20, topDown: 15, maContext: 10, channel: 10, divergence: 10 } } });
    const readiness = r.factorStates.find((f) => f.code === 'score_readiness');
    assertEqual(readiness.state, 0, 'readiness contributes 0 with weight 0');
  });

  // Delivery pass (schema 1.25.0): readiness call + room line.
  await test('1.25.0 nextCloseEta: 01:12 closed on 5m -> 01:15 (3 min); on a boundary -> a full interval; bad input -> nulls', () => {
    assertEqual(JSON.stringify(nextCloseEta('2026-09-24T01:12:00.000Z', '5m')), JSON.stringify({ etaMin: 3, at: '2026-09-24T01:15:00.000Z' }), '5m');
    assertEqual(JSON.stringify(nextCloseEta('2026-09-24T01:15:00.000Z', '5m')), JSON.stringify({ etaMin: 5, at: '2026-09-24T01:20:00.000Z' }), 'boundary');
    assertEqual(nextCloseEta('2026-09-24T01:12:00.000Z', '3m').etaMin, 3, '3m: 01:12 -> 01:15');
    assertEqual(nextCloseEta('2026-09-24T01:13:00.000Z', '3m').etaMin, 2, '3m: 01:13 -> 01:15');
    assertEqual(nextCloseEta('2026-09-24T01:12:00.000Z', '1m').etaMin, 1, '1m');
    assertEqual(JSON.stringify(nextCloseEta(null, '5m')), JSON.stringify({ etaMin: null, at: null }), 'no asOf');
    assertEqual(JSON.stringify(nextCloseEta('2026-09-24T01:12:00.000Z', '1w')), JSON.stringify({ etaMin: null, at: null }), 'unknown tf');
  });

  await test('1.25.0 action: GET IN NOW / BE READY (conditional) / BE READY (setup on BAD) / STAND DOWN (BAD, DATA_UNAVAILABLE) - long + short mirror', () => {
    for (const direction of ['long', 'short']) {
      const good = rec({ plan: readyPlan({ direction }) });
      assertEqual(good.action.call, 'GET IN NOW', `${direction}: GOOD`);
      assertEqual(good.action.etaMin, 0, `${direction}: eta 0`);
      assertEqual(good.action.at, AS_OF, `${direction}: at asOf`);
      const cond = rec({ plan: readyPlan({ direction, status: 'conditional', reasonCode: 'awaiting_retest' }) });
      assertEqual(JSON.stringify(cond.action), JSON.stringify({ call: 'BE READY', etaMin: 1, at: '2026-09-23T12:01:00.000Z', note: 'closed candle retests 1000 and holds at or above it' }), `${direction}: conditional -> BE READY on 1m`);
      const setup = { candidateId: 'BTC:5m:x', timeframe: '5m', direction, entry: 1000, stop: direction === 'long' ? 990 : 1010, tp1: direction === 'long' ? 1040 : 960, grossRR: 4, netRR: 3, entryCondition: 'trigger sentence' };
      const badSetup = rec({ plan: readyPlan({ direction, status: 'rejected', reasonCode: 'chase', tp1: null, setup }) });
      assertEqual(badSetup.class, 'BAD', `${direction}: class stays BAD`);
      assertEqual(JSON.stringify(badSetup.action), JSON.stringify({ call: 'BE READY', etaMin: 5, at: '2026-09-23T12:05:00.000Z', note: 'trigger sentence' }), `${direction}: setup -> BE READY on 5m`);
      const bad = rec({ plan: readyPlan({ direction, status: 'rejected', reasonCode: 'rr_below_min', grossRR: 2.4 }) });
      assertEqual(JSON.stringify([bad.action.call, bad.action.etaMin, bad.action.at]), JSON.stringify(['STAND DOWN', null, null]), `${direction}: BAD no setup`);
      assert(/measured move is >= 2.5R/.test(bad.action.note), `${direction}: note = remedy, got ${bad.action.note}`);
    }
    const na = rec({ dataStatus: 'unavailable' });
    assertEqual(JSON.stringify([na.action.call, na.action.etaMin, na.room]), JSON.stringify(['STAND DOWN', null, null]), 'DATA_UNAVAILABLE');
    assertEqual(compactRecommendation(rec()).action.call, 'GET IN NOW', 'compact carries action');
  });

  await test('1.25.0 action: WAIT on a forming/triggering candidate, eta to its timeframe (long + short mirror)', () => {
    for (const direction of ['long', 'short']) {
      for (const [state, tf, eta] of [['forming', '3m', 3], ['triggering', '5m', 5]]) {
        const c = { candidateId: `BTC:${tf}:${direction}:x`, type: 'flag', direction, state, timeframe: tf, confidence: 70, breakoutLevel: 1000, invalidation: direction === 'long' ? 990 : 1010 };
        const r = buildFlagRecommendation({ symbol: 'BTC', asOf: '2026-09-23T12:00:00.000Z', dataStatus: 'complete', flagTradePlan: null, evidence: evidence({ flags: [] }), topDown: topDown(), candidates: [c] });
        assertEqual(r.action.call, 'WAIT', `${direction} ${state}`);
        assertEqual(r.action.etaMin, eta, `${direction} ${state}: eta`);
        assert(r.action.note && r.action.note.startsWith(`${tf} close ${direction === 'long' ? 'above' : 'below'} 1,000.00`), `${direction}: note = change condition, got ${r.action.note}`);
      }
    }
  });

  await test('1.25.0 room: capped TP1 names the zone timeframe, uncapped is the measured move; pts and R vs stop (long + short mirror)', () => {
    for (const direction of ['long', 'short']) {
      const m = (p) => (direction === 'long' ? p : 2000 - p);
      const zone = direction === 'long' ? { low: 1030, high: 1035 } : { low: 965, high: 970 };
      const g = { '1h': { horizontalResistanceZones: direction === 'long' ? [zone] : [], horizontalSupportZones: direction === 'short' ? [zone] : [] } };
      const cappedPlan = { direction, entry: 1000, stop: m(990), tp1: m(1030), tp2: m(1040) };
      assertEqual(JSON.stringify(roomAhead(cappedPlan, g)), JSON.stringify({ toLevel: 'tp1_cap', levelPrice: m(1030), levelSource: `1h ${direction === 'long' ? 'resistance' : 'support'}`, pts: 30, r: 3, stop: m(990) }), `${direction}: capped`);
      assertEqual(JSON.stringify(roomAhead({ direction, entry: 1000, stop: m(990), tp1: m(1040), tp2: null }, g)), JSON.stringify({ toLevel: 'measured_target', levelPrice: m(1040), levelSource: 'measured move', pts: 40, r: 4, stop: m(990) }), `${direction}: measured`);
      assertEqual(roomAhead({ direction, entry: 1000, stop: m(990), tp1: null }, g), null, `${direction}: no TP1 -> null`);
      const r = rec({ plan: readyPlan({ direction, stop: m(990), tp1: m(1040) }) });
      assertEqual(r.room.r, 4, `${direction}: record room from the live plan`);
    }
    assertEqual(rec({ plan: null, ev: evidence({ flags: [] }) }).room, null, 'no plan/setup -> null');
  });

  // Alert clarity (schema 1.27.0, docs/PLAN_ALERT_CLARITY.md): presentation only.
  const mirC = (dir, p) => (dir === 'long' ? p : 2 * 83000 - p);
  const clarCand = (dir, reasons, over = {}) => ({ candidateId: `BTC:3m:${dir}:c`, timeframe: '3m', direction: dir, state: 'triggering', breakoutLevel: 83000, invalidation: mirC(dir, 82720), qual: { decision: 'wait', reasons }, ...over });

  await test('1.27.0 clarity gate: rr under the plan floor, room, chase block; rr over the floor and non-blocking codes pass (long + short)', () => {
    for (const dir of ['long', 'short']) {
      const rr = buildClarity({ candidate: clarCand(dir, ['rr:1.9']), minRR: 2.5 }).gate;
      assertEqual(JSON.stringify(rr), JSON.stringify({ passable: false, blockers: ['rr:1.9'], text: `R 1.9 under 2.5 floor; needs TP beyond ${dir === 'long' ? '83,700.00' : '82,300.00'}`, minRR: 2.5 }), `${dir}: rr`);
      const room = buildClarity({ candidate: clarCand(dir, ['conflict:5m-short', 'room:blocked-15m']), minRR: 2.5 }).gate;
      assertEqual(JSON.stringify(room), JSON.stringify({ passable: false, blockers: ['room:blocked-15m'], text: 'a 15m level blocks the measured target', minRR: 2.5 }), `${dir}: room`);
      const chase = buildClarity({ candidate: clarCand(dir, ['chase', 'rr:2.1']), minRR: 2.5 }).gate;
      assertEqual(chase.passable, false, `${dir}: chase`);
      assertEqual(JSON.stringify(chase.blockers), JSON.stringify(['chase', 'rr:2.1']), `${dir}: chase + rr, qual order`);
      assert(chase.text.startsWith('price ran past the breakout; R 2.1 under 2.5 floor'), chase.text);
      const none = buildClarity({ candidate: clarCand(dir, ['rr:2.8', 'ct:4h', 'ema200:counter', 'stoch:ob-cross']), minRR: 2.5 }).gate;
      assertEqual(JSON.stringify(none), JSON.stringify({ passable: true, blockers: [], text: null, minRR: 2.5 }), `${dir}: nothing blocking`);
      const dead = buildClarity({ candidate: clarCand(dir, [], { state: 'failed', qual: { decision: 'dont', reasons: [] } }) }).gate;
      assertEqual(JSON.stringify(dead), JSON.stringify({ passable: false, blockers: [], text: 'flag failed', minRR: 2.5 }), `${dir}: dont`);
    }
  });

  await test('1.27.0 clarity killIf: close back through the breakout, mirrored; EMA21 reclaim/acceptance prefix', () => {
    assertEqual(buildClarity({ candidate: clarCand('long', []) }).killIf.text, 'close back below 83,000.00 after a probe = defended, stand down', 'long');
    assertEqual(buildClarity({ candidate: clarCand('short', []) }).killIf.text, 'close back above 83,000.00 after a probe = defended, stand down', 'short');
    assertEqual(buildClarity({ candidate: clarCand('long', [], { ema21Hold: 'reclaim' }) }).killIf.text, 'EMA21 reclaim already — close back below 83,000.00 after a probe = defended, stand down', 'reclaim');
    assertEqual(buildClarity({ candidate: clarCand('short', [], { ema21Hold: 'acceptance_above' }) }).killIf.text, 'EMA21 acceptance already — close back above 83,000.00 after a probe = defended, stand down', 'acceptance');
    assertEqual(buildClarity({ candidate: clarCand('long', [], { ema21Hold: 'hold' }) }).killIf.level, 83000, 'level = breakout');
    assertEqual(JSON.stringify(buildClarity({ candidate: clarCand('long', [], { breakoutLevel: null }) }).killIf), JSON.stringify({ level: null, text: 'no breakout level yet' }), 'no breakout');
  });

  await test('1.27.0 clarity otherSide: nearest opposing zone on the geometry timeframe, confluence when closer; null without a zone (long + short)', () => {
    for (const dir of ['long', 'short']) {
      const z = (lo, hi) => (dir === 'long' ? { low: lo, high: hi } : { low: mirC(dir, hi), high: mirC(dir, lo) });
      const g = { '15m': { horizontalSupportZones: dir === 'long' ? [z(82500, 82600), z(82000, 82100)] : [], horizontalResistanceZones: dir === 'short' ? [z(82500, 82600)] : [], confluenceZones: [] } };
      const o = buildClarity({ candidate: clarCand(dir, []), geometryContext: g }).otherSide;
      const lo = dir === 'long' ? 82500 : 83400;
      const hi = dir === 'long' ? 82600 : 83500;
      assertEqual(JSON.stringify(o), JSON.stringify({ low: lo, high: hi, source: `15m ${dir === 'long' ? 'support' : 'resistance'}`, text: `if it fails, rotation to ${dir === 'long' ? '82,500.00–82,600.00' : '83,400.00–83,500.00'} (15m ${dir === 'long' ? 'support' : 'resistance'})` }), `${dir}: nearest zone`);
      const gc = { '15m': { ...g['15m'], confluenceZones: [z(82800, 82850)] } };
      assertEqual(buildClarity({ candidate: clarCand(dir, []), geometryContext: gc }).otherSide.source, '15m confluence', `${dir}: closer confluence wins`);
      const ahead = { '15m': { horizontalSupportZones: [], horizontalResistanceZones: [dir === 'long' ? { low: 83300, high: 83400 } : { low: 82600, high: 82700 }], confluenceZones: [] } };
      assertEqual(JSON.stringify(buildClarity({ candidate: clarCand(dir, []), geometryContext: ahead }).otherSide), JSON.stringify({ low: null, high: null, source: null, text: null }), `${dir}: zone only ahead -> null`);
      assertEqual(buildClarity({ candidate: clarCand(dir, []), geometryContext: { '1h': g['15m'] } }).otherSide.text, null, `${dir}: other geometry timeframe ignored`);
    }
  });

  await test('1.27.0 clarity context: non-blocking qual codes in words (blockers live in gate.text); td 2/4 = split; divergence one line with counts', () => {
    const words = {
      'room:blocked-15m': 'a 15m level blocks the measured target', chase: 'price ran past the breakout', 'rr:1.9': 'measured move only 1.9R',
      'conflict:5m-short': 'opposite 5m short flag active', 'stoch:ob-cross': 'Stoch RSI overbought with a bearish cross',
      'stoch:os-cross': 'Stoch RSI oversold with a bullish cross', 'ema200:counter': 'against EMA200', 'ct:4h': '4h lean against the trade'
    };
    for (const [code, text] of Object.entries(words)) assertEqual(qualWords(code), text, code);
    const c = clarCand('long', ['conflict:5m-short', 'stoch:ob-cross', 'ema200:counter', 'ct:4h', 'chase', 'rr:1.9', 'room:blocked-15m']);
    const cl = buildClarity({ candidate: c, topDown: { sentiment: 'bull', aligned: 2 }, divergence: { bullish: 1, bearish: 2 } });
    assertEqual(JSON.stringify(cl.gate.blockers), JSON.stringify(['chase', 'rr:1.9', 'room:blocked-15m']), 'blockers in gate');
    assertEqual(JSON.stringify(cl.context), JSON.stringify([
      'opposite 5m short flag active', 'Stoch RSI overbought with a bearish cross', 'against EMA200', '4h lean against the trade',
      'Top-down: split 2/4', 'Divergence: 1 tf agrees, 2 against'
    ]), 'order + words');
    assertEqual(JSON.stringify(cl.divergence), JSON.stringify({ agree: 1, conflict: 2 }), 'divergence counts');
    const td = (s, n, dir) => buildClarity({ candidate: clarCand(dir, []), topDown: { sentiment: s, aligned: n } }).context[0];
    assertEqual(td('bear', 2, 'long'), 'Top-down: split 2/4', 'bear 2/4 is split, not bear');
    assertEqual(td('bull', 4, 'short'), 'Counter-trend: top-down bull 4/4, against the short', 'counter-trend');
    assertEqual(td('bull', 3, 'long'), 'Top-down: bull 3/4', 'aligned');
    const d = (div) => buildClarity({ candidate: clarCand('short', []), divergence: div }).context;
    assertEqual(JSON.stringify(d({ bullish: 0, bearish: 2 })), JSON.stringify(['Divergence: 2 tf agrees']), 'short agrees only');
    assertEqual(JSON.stringify(d({ bullish: 3, bearish: 0 })), JSON.stringify(['Divergence: 3 tf against']), 'short against only');
    assertEqual(JSON.stringify(d({ bullish: 0, bearish: 0 })), JSON.stringify([]), 'none -> no line');
  });

  await test('1.27.0 clarity on the record: subject = plan candidate, else SETUP candidate, else WATCH candidate; compact carries it; null on DATA_UNAVAILABLE', () => {
    const build = (plan, candidates) => buildFlagRecommendation({ symbol: 'BTC', asOf: AS_OF, dataStatus: 'complete', flagTradePlan: plan, evidence: evidence({ flags: [] }), topDown: topDown(), candidates, geometryContext: null });
    const pc = { candidateId: readyPlan().candidateId, type: 'flag', timeframe: '1m', direction: 'long', state: 'confirmed', confidence: 82, breakoutLevel: 1000, invalidation: 990, qual: { decision: 'actionable', reasons: [] } };
    const wc = { candidateId: 'BTC:3m:long:w', type: 'flag', timeframe: '3m', direction: 'long', state: 'triggering', confidence: 70, breakoutLevel: 100, invalidation: 99, qual: { decision: 'wait', reasons: ['rr:1.9'] } };
    const planned = build(readyPlan(), [wc, pc]);
    assertEqual(planned.clarity.candidateId, pc.candidateId, 'plan subject');
    assertEqual(planned.clarity.gate.passable, true, 'plan candidate passable');
    assertEqual(JSON.stringify(compactRecommendation(planned).clarity), JSON.stringify(planned.clarity), 'compact = full');
    const sc = { ...wc, candidateId: 'BTC:5m:long:s', timeframe: '5m', state: 'confirmed' };
    const withSetup = build({ ...readyPlan(), candidateId: 'missing', status: 'rejected', reasonCode: 'chase', setup: { candidateId: sc.candidateId, timeframe: '5m', direction: 'long', entry: 100, stop: 99, tp1: 103 } }, [wc, sc]);
    assertEqual(withSetup.clarity.candidateId, sc.candidateId, 'setup subject when the plan candidate is not on file');
    const watch = build(null, [wc]);
    assertEqual(watch.clarity.candidateId, 'BTC:3m:long:w', 'watch subject');
    assertEqual(watch.clarity.gate.passable, false, 'blocked watch');
    assertEqual(watch.class, 'WATCH', 'class unchanged by clarity');
    assertEqual(JSON.stringify(watch.action), JSON.stringify(build(null, [{ ...wc, qual: { decision: 'wait', reasons: [] } }]).action), 'action unchanged by clarity');
    assertEqual(build(null, []).clarity, null, 'no candidate -> null');
    assertEqual(rec({ dataStatus: 'unavailable' }).clarity, null, 'unavailable -> null');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
