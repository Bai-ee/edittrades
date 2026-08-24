#!/usr/bin/env node

/**
 * BTC Decision Desk — orchestrator validation.
 *
 * Offline and deterministic. Every fixture is hand-built, `now` is a constant,
 * and no network is touched.
 *
 * The property under test throughout: a trade card appears ONLY when every
 * gate passes, and every refusal names its reason.
 *
 * Run: npm run validate:orchestrator
 */

import {
  decideBtcTrade,
  checkMarketData,
  calculateDynamicThreshold,
  rankCandidates,
  recommendationId,
  NO_POPUP_REASON,
  ABSOLUTE_MIN_CONFIDENCE
} from '../public/js/btcDecisionDesk.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}\n${'-'.repeat(name.length)}`);
}

// A fixed clock. Nothing in this suite may depend on the real one.
const NOW = Date.parse('2026-08-24T12:00:00Z');

/** One timeframe block, shaped like `/api/analyze-full` returns it. */
function tfBlock({ ageMinutes = 1 } = {}) {
  return {
    indicators: {
      price: { current: 110000 },
      metadata: { lastBarOpenTime: new Date(NOW - ageMinutes * 60000).toISOString() }
    }
  };
}

function analysisWith(strategies, tfOverrides = {}) {
  return {
    symbol: 'BTCUSDT',
    meta: { strategyVersion: 'test-1' },
    timeframes: {
      '4h': tfBlock(),
      '1h': tfBlock(),
      ...tfOverrides
    },
    strategies
  };
}

/** A tradeable-looking candidate. */
function candidate({ confidence = 75, direction = 'long', name = 'TREND_4H' } = {}) {
  return {
    [name]: {
      valid: true,
      direction,
      confidence,
      entryZone: { min: 109500, max: 110500 },
      stopLoss: direction === 'long' ? 107000 : 113000,
      targets: direction === 'long' ? [113000, 116000] : [107000, 104000],
      invalidationLevel: direction === 'long' ? 107000 : 113000,
      confidenceFactors: [
        { code: 'PRIMARY_TREND', label: 'Primary trend', points: 40, detail: 'aligned' },
        { code: 'MACRO_TREND', label: 'Macro', points: 35, detail: 'aligned' }
      ]
    }
  };
}

/** An account with enough history that the risk engine will size a trade. */
function healthyAccount() {
  return {
    walletValue: 25000,
    walletAvailable: true,
    snapshots: [{ at: '2026-08-01', walletValue: 25000 }],
    cashFlows: [],
    trades: [],
    openPositions: [],
    now: NOW
  };
}

const decide = (overrides = {}) =>
  decideBtcTrade({
    analysis: analysisWith(candidate()),
    account: healthyAccount(),
    now: NOW,
    ...overrides
  });

// ---------------------------------------------------------------------------
section('1. The happy path actually produces a card');
// ---------------------------------------------------------------------------

{
  const r = decide();
  assert(r.show === true, 'a clean, confident setup shows a card', r.reason || '');
  if (r.show) {
    const rec = r.recommendation;
    assert(rec.direction === 'long', 'direction is carried through');
    assert(rec.position && rec.position.notional > 0, 'a position size is present', JSON.stringify(rec.position));
    assert(rec.maxLoss && rec.maxLoss.amount > 0, 'a max loss is present', JSON.stringify(rec.maxLoss));
    assert(rec.confidenceFactors.length > 0, 'the WHY THIS TRADE breakdown is present');
    assert(rec.sizingFactors !== undefined, 'the WHY THIS SIZE breakdown is present');
    assert(typeof rec.recommendationId === 'string' && rec.recommendationId.length > 0,
      'the card has a stable id');
  }
}

// ---------------------------------------------------------------------------
section('2. Every refusal names its reason');
// ---------------------------------------------------------------------------

{
  assert(decide({ hasActiveBtcTrade: true }).reason === NO_POPUP_REASON.ACTIVE_BTC_TRADE,
    'an open BTC position suppresses the card');

  assert(decide({ analysis: analysisWith({}) }).reason === NO_POPUP_REASON.NO_CANDIDATE,
    'no valid strategy means NO_CANDIDATE');

  const weak = decide({ analysis: analysisWith(candidate({ confidence: 40 })) });
  assert(weak.reason === NO_POPUP_REASON.BELOW_QUALITY_FLOOR,
    'a setup under the hard floor is refused as BELOW_QUALITY_FLOOR', weak.reason);

  const stale = decide({
    analysis: analysisWith(candidate(), { '4h': tfBlock({ ageMinutes: 60 * 24 }) })
  });
  assert(stale.reason === NO_POPUP_REASON.STALE_MARKET_DATA,
    'a day-old 4h bar is refused as STALE_MARKET_DATA', stale.reason);

  const missing = decide({
    analysis: { symbol: 'BTCUSDT', meta: {}, timeframes: { '4h': tfBlock() }, strategies: candidate() }
  });
  assert(missing.reason === NO_POPUP_REASON.INCOMPLETE_MARKET_DATA,
    'a missing required timeframe is refused as INCOMPLETE_MARKET_DATA', missing.reason);

  const shown = decide();
  const dismissed = decide({ dismissedIds: [shown.recommendation.recommendationId] });
  assert(dismissed.reason === NO_POPUP_REASON.DISMISSED,
    'a dismissed card does not reappear', dismissed.reason);

  const broke = decide({ account: { walletValue: 0, walletAvailable: true, snapshots: [], cashFlows: [], trades: [], openPositions: [], now: NOW } });
  assert(broke.show === false && broke.reason === NO_POPUP_REASON.ADAPTIVE_RISK_NO_TRADE,
    'an account the risk engine refuses to size shows no card', broke.reason);
}

// ---------------------------------------------------------------------------
section('3. The quality floor cannot be negotiated down');
// ---------------------------------------------------------------------------

{
  // Every input that could plausibly be argued as a reason to relax the bar.
  const attempts = [
    { label: 'high volatility', marketVolatility: { volatilityState: 'HIGH', atrPercentile: 85 } },
    { label: 'extreme volatility', marketVolatility: { volatilityState: 'EXTREME', atrPercentile: 97 } },
    { label: 'aggressive allowed', aggressiveAllowed: true },
    { label: 'calm market', marketVolatility: { volatilityState: 'LOW', atrPercentile: 5 } }
  ];

  for (const attempt of attempts) {
    const justUnder = decide({
      analysis: analysisWith(candidate({ confidence: ABSOLUTE_MIN_CONFIDENCE - 1 })),
      ...attempt
    });
    assert(justUnder.show === false,
      `${attempt.label} cannot let a sub-floor setup through`,
      `${justUnder.reason}`);
  }

  // The dynamic threshold may only ever rise above the floor.
  const cases = [
    {},
    { volatilityState: 'HIGH' },
    { volatilityState: 'EXTREME' },
    { drawdownPct: 20 },
    { volatilityState: 'EXTREME', drawdownPct: 20, missingLayers: ['VOLUME'] }
  ];
  const allAtOrAbove = cases.every((c) => calculateDynamicThreshold(c).threshold >= ABSOLUTE_MIN_CONFIDENCE);
  assert(allAtOrAbove, 'the dynamic threshold never falls below the floor');

  assert(calculateDynamicThreshold({ volatilityState: 'LOW' }).threshold === ABSOLUTE_MIN_CONFIDENCE,
    'a calm market does not lower the bar (it just does not raise it)');
  assert(calculateDynamicThreshold({ volatilityState: 'EXTREME' }).threshold > ABSOLUTE_MIN_CONFIDENCE,
    'extreme volatility raises the bar');
  assert(calculateDynamicThreshold({ drawdownPct: 20 }).threshold > ABSOLUTE_MIN_CONFIDENCE,
    'deep drawdown raises the bar');
}

// ---------------------------------------------------------------------------
section('4. AGGRESSIVE is available, never automatic');
// ---------------------------------------------------------------------------

{
  const off = decide({ aggressiveAllowed: false, analysis: analysisWith(candidate({ confidence: 95 })) });
  assert(off.show && off.recommendation.strategyPreset === 'STANDARD',
    'with the toggle OFF, AGGRESSIVE is never selected',
    off.recommendation && off.recommendation.strategyPreset);

  const onButMarginal = decide({ aggressiveAllowed: true, analysis: analysisWith(candidate({ confidence: 62 })) });
  assert(onButMarginal.show && onButMarginal.recommendation.strategyPreset === 'STANDARD',
    'with the toggle ON, a marginal setup still gets STANDARD',
    onButMarginal.recommendation && onButMarginal.recommendation.strategyPreset);

  const onAndStrong = decide({ aggressiveAllowed: true, analysis: analysisWith(candidate({ confidence: 95 })) });
  assert(onAndStrong.show && onAndStrong.recommendation.strategyPreset === 'AGGRESSIVE',
    'with the toggle ON, a clearly strong setup may use AGGRESSIVE',
    onAndStrong.recommendation && onAndStrong.recommendation.strategyPreset);
}

// ---------------------------------------------------------------------------
section('5. One primary trade, chosen deterministically');
// ---------------------------------------------------------------------------

{
  const many = {
    ...candidate({ confidence: 70, name: 'MICRO_SCALP' }),
    ...candidate({ confidence: 82, name: 'SWING' }),
    ...candidate({ confidence: 82, name: 'TREND_4H' }),
    ...candidate({ confidence: 65, name: 'SCALP_1H' })
  };

  const ranked = rankCandidates(many);
  assert(ranked[0].confidence === 82, 'highest confidence ranks first');
  assert(ranked[0].name === 'SWING', 'ties break on the fixed priority order, not insertion order', ranked[0].name);

  // Same input, same answer — every time.
  const a = JSON.stringify(rankCandidates(many).map((c) => c.name));
  const b = JSON.stringify(rankCandidates(many).map((c) => c.name));
  assert(a === b, 'ranking is deterministic');

  const r = decide({ analysis: analysisWith(many) });
  assert(r.show && r.recommendation.strategy === 'SWING',
    'exactly one primary recommendation is surfaced');
  assert(r.diagnostics.candidates.length === 4,
    'the alternatives are still reported in diagnostics', String(r.diagnostics.candidates.length));
}

// ---------------------------------------------------------------------------
section('6. Recommendation identity is stable');
// ---------------------------------------------------------------------------

{
  const c = { name: 'TREND_4H', direction: 'long', entryZone: { min: 109500, max: 110500 }, stopLoss: 107000 };
  assert(recommendationId(c, 'v1') === recommendationId(c, 'v1'), 'the same trade produces the same id');

  // A one-cent drift is not a new recommendation — otherwise a dismissed card
  // reappears on every refresh.
  const drifted = { ...c, entryZone: { min: 109500.004, max: 110500.004 } };
  assert(recommendationId(c, 'v1') === recommendationId(drifted, 'v1'),
    'sub-dollar price drift does not mint a new id');

  const movedStop = { ...c, stopLoss: 106000 };
  assert(recommendationId(c, 'v1') !== recommendationId(movedStop, 'v1'),
    'a materially different stop IS a new recommendation');

  const flipped = { ...c, direction: 'short' };
  assert(recommendationId(c, 'v1') !== recommendationId(flipped, 'v1'),
    'the opposite direction is a new recommendation');
}

// ---------------------------------------------------------------------------
section('7. Purity and degenerate inputs');
// ---------------------------------------------------------------------------

{
  const a = JSON.stringify(decide());
  const b = JSON.stringify(decide());
  assert(a === b, 'identical inputs produce identical output');

  for (const [label, input] of [
    ['no arguments at all', undefined],
    ['empty object', {}],
    ['null analysis', { analysis: null, account: healthyAccount(), now: NOW }],
    ['null account', { analysis: analysisWith(candidate()), account: null, now: NOW }],
    ['garbage strategies', { analysis: analysisWith({ X: null, Y: 'nope', Z: { valid: true } }), account: healthyAccount(), now: NOW }]
  ]) {
    let threw = null;
    let result = null;
    try {
      result = input === undefined ? decideBtcTrade() : decideBtcTrade(input);
    } catch (err) {
      threw = err;
    }
    assert(threw === null, `${label}: does not throw`, threw ? String(threw && threw.message) : '');
    assert(result && result.show === false, `${label}: shows no card`, JSON.stringify(result && result.reason));
    assert(result && typeof result.reason === 'string', `${label}: still names a reason`, JSON.stringify(result && result.reason));
  }
}

// ---------------------------------------------------------------------------
section('8. Market data gate in isolation');
// ---------------------------------------------------------------------------

{
  const fresh = checkMarketData({ analysis: analysisWith(candidate()), now: NOW });
  assert(fresh.length === 0, 'fresh required timeframes raise no problem', JSON.stringify(fresh));

  // 4h budget is 1.25 bars = 300 minutes. 290 passes, 310 does not.
  const justFresh = checkMarketData({
    analysis: analysisWith(candidate(), { '4h': tfBlock({ ageMinutes: 290 }) }), now: NOW
  });
  assert(justFresh.length === 0, 'a 4h bar just inside the budget passes', JSON.stringify(justFresh));

  const justStale = checkMarketData({
    analysis: analysisWith(candidate(), { '4h': tfBlock({ ageMinutes: 310 }) }), now: NOW
  });
  assert(justStale.length === 1 && justStale[0].code === NO_POPUP_REASON.STALE_MARKET_DATA,
    'a 4h bar just outside the budget fails', JSON.stringify(justStale));
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log(`Orchestrator: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log('All orchestrator assertions passed.');
