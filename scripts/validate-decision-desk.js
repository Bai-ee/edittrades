/**
 * Decision desk — integration validation
 *
 * Exercises the five cases the brief specifies, end to end through the shared
 * decision context, with the deterministic layers stubbed by fixtures.
 *
 * The property under test in every case is the same: does the assembled
 * context tell the truth about what it knows? Specifically, that macro cannot
 * validate a weak setup, that a dead price feed cannot produce a confident
 * recommendation, and that absent risk sizing is visible rather than implied.
 *
 *   node scripts/validate-decision-desk.js
 */

import {
  buildMarketBlock,
  buildSetupBlock,
  buildMacroBlock,
  buildRiskBlock,
  buildDecisionContext,
  toAIPayload
} from '../services/decisionContext.js';
import * as systemHealth from '../services/systemHealth.js';
import * as provenance from '../services/dataProvenance.js';
import aiContract from '../services/aiContract.js';
import { planTrade, DEFAULT_RISK_POLICY } from '../public/js/riskManager.js';

let assertions = 0;
let failures = 0;

function ok(label, condition, detail = '') {
  assertions++;
  if (condition) console.log(`  ok    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const NOW = Date.parse('2026-08-23T12:00:00Z');

/* ---------------------------------------------------------------------
 * Fixtures. Synthetic by design and confined to this harness.
 * ------------------------------------------------------------------ */

function liveCandles(interval, bars = 400) {
  const arr = Array.from({ length: bars }, (_, i) => ({
    timestamp: NOW - (bars - i) * 60_000,
    open: 77000, high: 77100, low: 76900, close: 77000, volume: 12
  }));
  return provenance.attachProvenance(arr, provenance.makeProvenance({
    source: 'kraken', fetchedAt: NOW - 3000, interval, lastBarTime: NOW - 60_000, now: NOW
  }));
}

const liveTicker = {
  symbol: 'BTCUSDT',
  price: 77000,
  priceChangePercent: 1.2,
  provenance: provenance.makeProvenance({ source: 'kraken', fetchedAt: NOW - 2000, interval: '1m', now: NOW })
};

const goodSetup = {
  htfBias: { direction: 'long', confidence: 68, source: '1d' },
  signal: {
    valid: true, direction: 'LONG', selectedStrategy: 'TREND_4H', confidence: 72,
    entryZone: { min: 76800, max: 77200 }, stopLoss: 73500, targets: [84000, 88000],
    reason: '4H uptrend with 15m pullback to EMA21'
  }
};

const weakSetup = {
  htfBias: { direction: 'neutral', confidence: 12, source: '1d' },
  signal: {
    valid: false, direction: 'NO_TRADE', selectedStrategy: 'NO_TRADE', confidence: 0,
    entryZone: { min: null, max: null }, stopLoss: null, targets: [null, null],
    reason: '4H is flat; no directional structure'
  }
};

const neutralMacro = {
  current: {
    state: 'NEAR VALUE', economicValue: 56037.6, premiumDiscount: 37.6, percentile: 54,
    weightsApplied: { realizedPrice: 0.45, ma200w: 0.35, minerCost: 0.2 },
    convergence: { available: true, within: 2, total: 3, agreement: 'MODERATE AGREEMENT' }
  },
  meta: { stale: false, dataFetchedAt: '2026-08-23T06:00:00Z', sources: {} }
};

const euphoricMacro = {
  current: {
    state: 'EUPHORIC', economicValue: 41000, premiumDiscount: 288, percentile: 97,
    weightsApplied: { realizedPrice: 0.45, ma200w: 0.35, minerCost: 0.2 },
    convergence: { available: true, within: 3, total: 3, agreement: 'HIGH AGREEMENT' }
  },
  meta: { stale: false, dataFetchedAt: '2026-08-23T06:00:00Z', sources: {} }
};

const deepDiscountMacro = {
  current: {
    state: 'DEEP DISCOUNT', economicValue: 92000, premiumDiscount: -22.1, percentile: 4,
    weightsApplied: { realizedPrice: 0.45, ma200w: 0.35, minerCost: 0.2 },
    convergence: { available: true, within: 3, total: 3, agreement: 'HIGH AGREEMENT' }
  },
  meta: { stale: false, dataFetchedAt: '2026-08-23T06:00:00Z', sources: {} }
};

function buildHealth({ marketProv, macro, riskAvailable = true }) {
  return systemHealth.buildSystemHealth({
    marketData: systemHealth.assessMarketData(marketProv),
    bitcoinMacro: systemHealth.assessBitcoinMacro(macro || {}),
    riskPersistence: systemHealth.assessRiskPersistence({ available: riskAvailable }),
    ai: systemHealth.assessAI({ configured: true })
  });
}

console.log('\nDecision desk — integration validation\n');

/* =====================================================================
 * CASE 1 — good setup, neutral macro, within risk
 * ================================================================== */
section('Case 1: good setup + neutral macro + within risk');

const c1Candles = { '4h': liveCandles('4h'), '1h': liveCandles('1h') };
const c1Plan = planTrade({
  walletBalance: 20000,
  positions: [],
  policy: DEFAULT_RISK_POLICY,
  trade: { asset: 'BTC', direction: 'LONG', entry: 77000, stop: 73500, target: 84000, riskPct: 1, leverage: 2 }
});

const c1 = buildDecisionContext({
  symbol: 'BTCUSDT',
  market: buildMarketBlock({ symbol: 'BTCUSDT', ticker: liveTicker, candlesByInterval: c1Candles }),
  setup: buildSetupBlock(goodSetup),
  macro: buildMacroBlock(neutralMacro),
  risk: buildRiskBlock(c1Plan),
  health: buildHealth({
    marketProv: { '4h': provenance.getProvenance(c1Candles['4h']), '1h': provenance.getProvenance(c1Candles['1h']) },
    macro: neutralMacro
  })
});

ok('decision is ready', c1.decisionReady === true);
ok('market is LIVE from a named provider', c1.market.freshness === 'LIVE' && c1.market.source === 'kraken');
ok('setup is valid', c1.setup.valid === true);
ok('macro bias is NEUTRAL', c1.macro.bias === 'NEUTRAL', c1.macro.bias);
ok('macro is not degraded', c1.macro.degraded === false);
ok('risk was evaluated', c1.risk.available === true);
ok('planned loss equals the risk budget', Math.abs(c1.risk.plannedLossUsd - 200) < 0.01,
   String(c1.risk.plannedLossUsd));
ok('policy state is WITHIN PLAN', c1.risk.policyState === 'WITHIN PLAN', c1.risk.policyState);
ok('system health is OK', c1.systemHealth.overall === 'OK', JSON.stringify(c1.systemHealth.warnings));
ok('no health headline is shown', systemHealth.healthHeadline(c1) === null);

/* =====================================================================
 * CASE 2 — good setup, euphoric macro, high concentration
 * ================================================================== */
section('Case 2: good setup + euphoric macro + concentrated book');

const concentratedBook = [
  { asset: 'BTC', direction: 'LONG', plannedRisk: 200, margin: 2000, notional: 4000, status: 'OPEN' },
  { asset: 'ETH', direction: 'LONG', plannedRisk: 180, margin: 1800, notional: 3600, status: 'OPEN' },
  { asset: 'SOL', direction: 'LONG', plannedRisk: 160, margin: 1600, notional: 3200, status: 'OPEN' }
];
const c2Plan = planTrade({
  walletBalance: 20000,
  positions: concentratedBook,
  policy: DEFAULT_RISK_POLICY,
  trade: { asset: 'BTC', direction: 'LONG', entry: 77000, stop: 73500, target: 84000, riskPct: 1, leverage: 2 }
});

const c2 = buildDecisionContext({
  symbol: 'BTCUSDT',
  market: buildMarketBlock({ symbol: 'BTCUSDT', ticker: liveTicker, candlesByInterval: c1Candles }),
  setup: buildSetupBlock(goodSetup),
  macro: buildMacroBlock(euphoricMacro),
  risk: buildRiskBlock(c2Plan),
  health: buildHealth({ marketProv: { '4h': provenance.getProvenance(c1Candles['4h']) }, macro: euphoricMacro })
});

ok('euphoric macro reads CAUTION_EXTENDED', c2.macro.bias === 'CAUTION_EXTENDED', c2.macro.bias);
ok('concentration is reported', typeof c2.risk.concentration === 'string' && c2.risk.concentration.length > 0,
   String(c2.risk.concentration));
ok(
  'concentration is labelled DIRECTIONAL, not CORRELATED',
  /DIRECTIONAL/.test(c2.risk.concentration) && !/CORRELATED/.test(c2.risk.concentration),
  c2.risk.concentration
);
ok('total open risk rises above the single-trade risk', c2.risk.totalOpenRiskPct > c2.risk.riskPct,
   `${c2.risk.totalOpenRiskPct} vs ${c2.risk.riskPct}`);
ok('the setup itself is still valid', c2.setup.valid === true);
ok(
  'macro being extended does NOT invalidate the setup',
  c2.setup.valid === true && c2.macro.bias === 'CAUTION_EXTENDED'
);

/* =====================================================================
 * CASE 3 — weak setup, deep discount macro
 * Macro must not rescue a setup the engine rejected.
 * ================================================================== */
section('Case 3: weak setup + deep discount macro');

const c3 = buildDecisionContext({
  symbol: 'BTCUSDT',
  market: buildMarketBlock({ symbol: 'BTCUSDT', ticker: liveTicker, candlesByInterval: c1Candles }),
  setup: buildSetupBlock(weakSetup),
  macro: buildMacroBlock(deepDiscountMacro),
  risk: buildRiskBlock(null),
  health: buildHealth({ marketProv: { '4h': provenance.getProvenance(c1Candles['4h']) }, macro: deepDiscountMacro })
});

ok('macro is SUPPORTIVE', c3.macro.bias === 'SUPPORTIVE', c3.macro.bias);
ok('the setup remains invalid', c3.setup.valid === false);
ok('a supportive macro does not make the setup valid', c3.setup.valid === false && c3.macro.bias === 'SUPPORTIVE');
ok('no entry is produced', c3.setup.entryZone?.min === null || c3.setup.entryZone === null);
ok('no stop is produced', c3.setup.stop === null);
ok(
  'macro and setup stay in separate blocks',
  Object.prototype.hasOwnProperty.call(c3, 'macro') && Object.prototype.hasOwnProperty.call(c3, 'setup')
);

/* =====================================================================
 * CASE 4 — good setup, unavailable market data
 * No confident recommendation may be produced.
 * ================================================================== */
section('Case 4: good setup + unavailable market data');

const deadProv = { '4h': provenance.unavailableProvenance({ interval: '4h', providerFailures: [
  { provider: 'kraken', error: '500' }, { provider: 'bitfinex', error: 'timeout' }
] }) };

const c4 = buildDecisionContext({
  symbol: 'BTCUSDT',
  market: buildMarketBlock({ symbol: 'BTCUSDT', ticker: null, candlesByInterval: {} }),
  setup: buildSetupBlock(goodSetup),
  macro: buildMacroBlock(neutralMacro),
  risk: buildRiskBlock(null),
  health: buildHealth({ marketProv: deadProv, macro: neutralMacro })
});

ok('market block reports unavailable', c4.market.available === false);
ok('no price is invented', c4.market.price === null);
ok('freshness is UNAVAILABLE', c4.market.freshness === 'UNAVAILABLE');
ok('decisionReady is FALSE', c4.decisionReady === false);
ok('market-data health is FAILED', c4.systemHealth.marketData === 'FAILED');
ok('overall health is FAILED', c4.systemHealth.overall === 'FAILED');
ok('headline warns the operator', systemHealth.healthHeadline(c4) === 'MARKET DATA UNAVAILABLE',
   String(systemHealth.healthHeadline(c4)));
ok('failed providers are named', c4.systemHealth.failedProviders.length === 2,
   JSON.stringify(c4.systemHealth.failedProviders));

// The AI must be told, explicitly, what it does not have.
const c4ai = toAIPayload(c4);
const c4built = aiContract.buildPromptBody({
  instruction: 'Comment on this setup.',
  payload: c4ai.payload,
  requiredPaths: c4ai.requiredPaths,
  dataHealth: c4ai.dataHealth
});
ok('AI payload flags the missing price', c4built.missing.includes('market.price'), c4built.missing.join(','));
ok('AI prompt states the missing inputs', /MISSING INPUTS \(\d+\)/.test(c4built.prompt));
ok('AI prompt carries the data-health block', /DATA HEALTH:/.test(c4built.prompt));

/* =====================================================================
 * CASE 5 — good setup, Risk Manager unavailable
 * Analysis continues, but the absence of sizing must be explicit.
 * ================================================================== */
section('Case 5: good setup + Risk Manager unavailable');

const c5 = buildDecisionContext({
  symbol: 'BTCUSDT',
  market: buildMarketBlock({ symbol: 'BTCUSDT', ticker: liveTicker, candlesByInterval: c1Candles }),
  setup: buildSetupBlock(goodSetup),
  macro: buildMacroBlock(neutralMacro),
  risk: buildRiskBlock(null),
  health: systemHealth.buildSystemHealth({
    marketData: systemHealth.assessMarketData({ '4h': provenance.getProvenance(c1Candles['4h']) }),
    bitcoinMacro: systemHealth.assessBitcoinMacro(neutralMacro),
    riskPersistence: systemHealth.assessRiskPersistence({ available: false }),
    ai: systemHealth.assessAI({ configured: true })
  })
});

ok('analysis still proceeds', c5.setup.available === true && c5.market.available === true);
ok('risk block reports unavailable', c5.risk.available === false);
ok(
  'the reason names sizing explicitly',
  /position sizing was not assessed/i.test(c5.risk.reason),
  c5.risk.reason
);
ok('no position size is implied', c5.risk.positionNotional === undefined);
ok('risk persistence health is FAILED', c5.systemHealth.riskPersistence === 'FAILED');
ok('headline reports the storage error', systemHealth.healthHeadline(c5) === 'RISK STORAGE ERROR');

const c5ai = toAIPayload(c5);
const c5built = aiContract.buildPromptBody({
  instruction: 'Comment on this setup.',
  payload: c5ai.payload,
  requiredPaths: c5ai.requiredPaths,
  dataHealth: c5ai.dataHealth
});
ok('AI is told risk sizing is missing', c5built.missing.some((m) => m.startsWith('risk.')),
   c5built.missing.join(','));

/* =====================================================================
 * MACRO DEGRADATION — a renormalised composite must be visible
 * ================================================================== */
section('Macro degradation is visible');

const degradedMacro = {
  current: {
    state: 'NEAR VALUE', economicValue: 48000, premiumDiscount: 60, percentile: 61,
    weightsApplied: { ma200w: 0.636, minerCost: 0.364 }
  },
  meta: { stale: false, sources: {} }
};
const degradedBlock = buildMacroBlock(degradedMacro);
ok('a 2-anchor composite is flagged degraded', degradedBlock.degraded === true);
ok('anchors used is reported', degradedBlock.anchorsUsed === 2, String(degradedBlock.anchorsUsed));

const dh = systemHealth.assessBitcoinMacro(degradedMacro);
ok('health says DEGRADED', dh.status === 'DEGRADED');
ok('detail uses the brief\'s wording', /2 \/ 3 CORE ANCHORS AVAILABLE/.test(dh.detail), dh.detail);
ok(
  'a warning explains it is a different model',
  dh.warnings.some((w) => /different model/i.test(w)),
  JSON.stringify(dh.warnings)
);

/* =====================================================================
 * AI CONTRACT
 * ================================================================== */
section('AI contract');

ok('contract forbids inventing a price', /MAY NOT[\s\S]*price/i.test(aiContract.DATA_CONTRACT));
ok('contract forbids inventing wallet balance', /wallet balance/i.test(aiContract.DATA_CONTRACT));
ok('contract forbids inventing liquidation', /liquidation price/i.test(aiContract.DATA_CONTRACT));
ok('contract forbids emitting a rating', /Emit a rating, grade, score or priority/i.test(aiContract.DATA_CONTRACT));
ok('contract forbids predicting a timeline', /Predict a timeline/i.test(aiContract.DATA_CONTRACT));
ok('contract requires naming missing inputs', /MISSING INPUTS — mandatory/.test(aiContract.DATA_CONTRACT));
ok('contract requires flagging degraded sources', /DEGRADED SOURCES — mandatory/.test(aiContract.DATA_CONTRACT));
ok('contract forbids overriding the engine decision', /signal\.valid/.test(aiContract.DATA_CONTRACT));

// Absence must be visible in the serialised block, not silently dropped.
const serialized = aiContract.serializeDataBlock({ price: undefined, stop: null, entry: 77000 });
ok('undefined serialises as MISSING', /"price":\s*"MISSING"/.test(serialized), serialized);
ok('null is preserved', /"stop":\s*null/.test(serialized));
ok('real values pass through', /"entry":\s*77000/.test(serialized));

ok('temperature is clamped', aiContract.clampTemperature(2) <= 0.4, String(aiContract.clampTemperature(2)));
ok('negative temperature is clamped to 0', aiContract.clampTemperature(-5) === 0);
ok('a non-numeric temperature falls back safely', aiContract.clampTemperature('hot') <= 0.4);
ok('models are pinned to dated snapshots', /\d{4}-\d{2}-\d{2}/.test(aiContract.AI_MODELS.commentary),
   aiContract.AI_MODELS.commentary);

/* ==================================================================== */
console.log(`\n${'='.repeat(62)}`);
console.log(failures === 0
  ? `All ${assertions} assertions passed.`
  : `${failures} of ${assertions} assertions FAILED.`);
console.log(`${'='.repeat(62)}\n`);

process.exit(failures === 0 ? 0 : 1);
