/**
 * Deterministic, zero-dependency test suite for:
 *   - config/engine.json + config/engine.js (phase 1 of the engine refinement plan)
 *
 * Phase 1 moves tunable constants out of services/strategy.js into one versioned
 * file and stamps `configVersion` into the payload. It changes no values, so this
 * suite pins the documented defaults: if a future phase edits a number, it has to
 * edit the expectation here too, deliberately.
 *
 * No network calls. The payload test injects its own candle fetcher and wallet
 * reader, exactly like test-scalp-context.js does.
 *
 * Run: node test-engine-config.js
 */

import {
  ENGINE_CONFIG,
  CONFIG_VERSION,
  rrForSetupType,
  rrForStrategy,
  setConfigOverride
} from './config/engine.js';

import {
  MAX_SCALP_STOP_DISTANCE_PCT,
  calculateSLTP,
  validateScalpStopDistance
} from './services/strategy.js';

import { buildScalpContext } from './services/scalpContext.js';
import { buildFlagTradePlan } from './lib/flagTradePlan.js';
import { readFileSync } from 'node:fs';

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

function assertArrayEqual(actual, expected, msg) {
  assert(Array.isArray(actual), `${msg}: not an array`);
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// ---------------------------------------------------------------------------
// Synthetic candles for the payload test
// ---------------------------------------------------------------------------

const INTERVAL_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
  '1h': 3600000, '4h': 14400000, '1d': 86400000
};

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

/**
 * Deterministic candle series: a gentle uptrend with no gaps, all closed.
 * @param {string} interval
 * @param {number} count
 * @returns {Array<Object>}
 */
function makeCandles(interval, count) {
  const step = INTERVAL_MS[interval];
  const out = [];
  for (let i = count; i > 0; i--) {
    const timestamp = NOW - i * step;
    const base = 100 + (count - i) * 0.05;
    out.push({
      timestamp,
      open: base,
      high: base + 0.3,
      low: base - 0.3,
      close: base + 0.1,
      volume: 10,
      closeTime: timestamp + step - 1
    });
  }
  return out;
}

async function fakeFetch(pair, interval, limit) {
  return {
    candles: makeCandles(interval, Math.min(limit, 260)),
    provider: 'kraken',
    synthetic: false,
    error: null
  };
}

async function fakeAccount() {
  return {
    status: 'unavailable',
    reason: 'test stub',
    address: null,
    fetchedAt: null,
    margin: { usd: null, byAsset: {} },
    holdings: [],
    holdingsUsd: null,
    unpriced: [],
    gas: { sol: null, minSol: 0.02, sufficient: null },
    performance: { baselineUsd: null, netPnlUsd: null, returnPct: null, source: null }
  };
}

// ---------------------------------------------------------------------------

async function run() {
  console.log('\nEngine config (phase 1)\n');

  await test('config/engine.json parses and carries a configVersion', () => {
    const raw = JSON.parse(readFileSync(new URL('./config/engine.json', import.meta.url), 'utf8'));
    assertEqual(typeof raw.configVersion, 'string', 'configVersion is not a string');
    assert(/^\d{4}\.\d{2}\.\d{2}-\d+$/.test(raw.configVersion), `configVersion is not YYYY.MM.DD-N: ${raw.configVersion}`);
    assertEqual(CONFIG_VERSION, raw.configVersion, 'loader and file disagree on configVersion');
  });

  await test('documented defaults: scalp stop cap and stop buffer', () => {
    assertEqual(ENGINE_CONFIG.scalp.maxStopDistancePct, 3.0, 'maxStopDistancePct drifted');
    assertEqual(ENGINE_CONFIG.stops.structureBuffer, 0.003, 'structureBuffer drifted');
  });

  await test('documented defaults: entry zone buffers', () => {
    assertEqual(ENGINE_CONFIG.entryZones.emaBuffer, 0.004, 'emaBuffer drifted');
    assertEqual(ENGINE_CONFIG.entryZones.aggressiveBuffer, 0.0003, 'aggressiveBuffer drifted');
    assertEqual(ENGINE_CONFIG.entryZones.breakoutBuffer, 0.0002, 'breakoutBuffer drifted');
    assertEqual(ENGINE_CONFIG.entryZones.microScalpBand, 0.005, 'microScalpBand drifted');
  });

  await test('documented defaults: R:R targets per setup type and strategy', () => {
    assertArrayEqual(rrForSetupType('Swing'), [3.0, 4.0, 5.0], 'Swing R:R drifted');
    assertArrayEqual(rrForSetupType('Scalp'), [3.0, 4.5], 'Scalp R:R drifted');
    assertArrayEqual(rrForSetupType('4h'), [3.0, 4.0], 'TREND_4H R:R drifted');
    assertArrayEqual(rrForStrategy('SCALP_1H'), [3.0, 4.5], 'SCALP_1H R:R drifted');
    assertArrayEqual(rrForStrategy('TREND_RIDER'), [3.0, 4.5], 'TREND_RIDER R:R drifted');
    assertArrayEqual(rrForStrategy('MICRO_SCALP'), [3.0, 4.0], 'MICRO_SCALP R:R drifted');
    assertArrayEqual(ENGINE_CONFIG.riskReward.default, [1.0, 2.0], 'calculateSLTP default R:R drifted');
  });

  await test('documented defaults: STANDARD and AGGRESSIVE thresholds', () => {
    const std = ENGINE_CONFIG.thresholds.STANDARD;
    assertEqual(std.emaPullbackMax, 1.0, 'STANDARD.emaPullbackMax drifted');
    assertEqual(std.emaPullbackMax1H, 1.5, 'STANDARD.emaPullbackMax1H drifted');
    assertEqual(std.microScalpEmaBand, 0.25, 'STANDARD.microScalpEmaBand drifted');
    assertEqual(std.minHtfBiasConfidence, 60, 'STANDARD.minHtfBiasConfidence drifted');
    assertEqual(std.maxSwingEmaDist1D, 3.0, 'STANDARD.maxSwingEmaDist1D drifted');
    assertEqual(std.allowFlat4HForScalp, false, 'STANDARD.allowFlat4HForScalp drifted');
    assertEqual(std.min15mStochAlign, true, 'STANDARD.min15mStochAlign drifted');

    const agg = ENGINE_CONFIG.thresholds.AGGRESSIVE;
    assertEqual(agg.emaPullbackMax, 1.75, 'AGGRESSIVE.emaPullbackMax drifted');
    assertEqual(agg.emaPullbackMax1H, 2.5, 'AGGRESSIVE.emaPullbackMax1H drifted');
    assertEqual(agg.microScalpEmaBand, 0.75, 'AGGRESSIVE.microScalpEmaBand drifted');
    assertEqual(agg.minHtfBiasConfidence, 40, 'AGGRESSIVE.minHtfBiasConfidence drifted');
    assertEqual(agg.maxSwingEmaDist1D, 5.0, 'AGGRESSIVE.maxSwingEmaDist1D drifted');
    assertEqual(agg.allowFlat4HForScalp, true, 'AGGRESSIVE.allowFlat4HForScalp drifted');
    assertEqual(agg.min15mStochAlign, false, 'AGGRESSIVE.min15mStochAlign drifted');
  });

  await test('config is deep-frozen at runtime', () => {
    assert(Object.isFrozen(ENGINE_CONFIG), 'root not frozen');
    assert(Object.isFrozen(ENGINE_CONFIG.thresholds.STANDARD), 'nested object not frozen');
    assert(Object.isFrozen(ENGINE_CONFIG.riskReward.byStrategy.SCALP_1H), 'nested array not frozen');
    try {
      ENGINE_CONFIG.scalp.maxStopDistancePct = 99;
    } catch {
      // strict-mode modules throw; either way the value must not change
    }
    assertEqual(ENGINE_CONFIG.scalp.maxStopDistancePct, 3.0, 'a threshold was mutated at runtime');
  });

  await test('documented defaults: the flag-plan net gate ships on at 2.0 (T6 phase 1, owner decision D1, variant V1c)', () => {
    assertEqual(ENGINE_CONFIG.flagPlan.minNetRR, 2.0, 'flagPlan.minNetRR drifted from the shipped V1c floor');
  });

  await test('setConfigOverride (T6 phase 0): deep-merges onto the base config, leaves siblings untouched, restores on null', () => {
    const before = ENGINE_CONFIG.flagPlan.minNetRR;
    try {
      setConfigOverride({ flagPlan: { minNetRR: 1.5 } });
      assertEqual(ENGINE_CONFIG.flagPlan.minNetRR, 1.5, 'override did not apply');
      assertEqual(ENGINE_CONFIG.flagPlan.minRR, 3.0, 'deep-merge dropped an untouched sibling key');
      assertEqual(ENGINE_CONFIG.scalp.maxStopDistancePct, 3.0, 'an unrelated config block was disturbed');
      assert(Object.isFrozen(ENGINE_CONFIG), 'overridden config is not frozen');
      assert(Object.isFrozen(ENGINE_CONFIG.flagPlan), 'overridden nested block is not frozen');
    } finally {
      setConfigOverride(null);
    }
    assertEqual(ENGINE_CONFIG.flagPlan.minNetRR, before, 'override was not cleared');
  });

  await test('T6 completion plan A7: setConfigOverride throws on configVersion/thresholds instead of silently not applying (snapshotted elsewhere at module load)', () => {
    let threw = false;
    try { setConfigOverride({ configVersion: '2099.01.01-1' }); } catch (err) { threw = true; assert(/configVersion/.test(err.message), 'error names configVersion'); }
    assert(threw, 'configVersion override must throw');
    assertEqual(ENGINE_CONFIG.configVersion, CONFIG_VERSION, 'base config untouched after the throw');

    threw = false;
    try { setConfigOverride({ thresholds: { STANDARD: { emaPullbackMax: 5 } } }); } catch (err) { threw = true; assert(/thresholds/.test(err.message), 'error names thresholds'); }
    assert(threw, 'thresholds override must throw');
    assertEqual(ENGINE_CONFIG.thresholds.STANDARD.emaPullbackMax, 1.0, 'base thresholds untouched after the throw');

    // A sibling key in the same override call is fine to reject alongside - the whole
    // call is refused, nothing partially applies.
    threw = false;
    try { setConfigOverride({ thresholds: {}, flagPlan: { minNetRR: 1.5 } }); } catch { threw = true; }
    assert(threw, 'a mixed override with thresholds still throws (all or nothing)');
    assertEqual(ENGINE_CONFIG.flagPlan.minNetRR, 2.0, 'flagPlan was never touched by the refused call');
  });

  await test('setConfigOverride: an array override replaces the base array outright (no element merge)', () => {
    const baseTfs = ENGINE_CONFIG.flag.timeframes;
    try {
      setConfigOverride({ flag: { timeframes: ['1m', '3m', '5m', '15m', '1h'] } });
      assertArrayEqual(ENGINE_CONFIG.flag.timeframes, ['1m', '3m', '5m', '15m', '1h'], 'array override did not replace');
      assertEqual(ENGINE_CONFIG.flag.maxImpulseCandles, 20, 'a sibling scalar in the same block was disturbed');
    } finally {
      setConfigOverride(null);
    }
    assertArrayEqual(ENGINE_CONFIG.flag.timeframes, baseTfs, 'override was not cleared');
  });

  await test('setConfigOverride is a live ES module binding: another module\'s default `cfg = ENGINE_CONFIG` param sees it with no code change there', () => {
    const candidate = {
      candidateId: 'TEST:1m:long:override', timeframe: '1m', type: 'flag', direction: 'long', state: 'confirmed',
      confidence: 80, chaseRisk: false, breakoutLevel: 1000, invalidation: 999, measuredTarget: 1003
    };
    const params = {
      candidateSetups: [candidate],
      geometryContext: {},
      tfEntries: { '1m': { closedThrough: new Date(NOW).toISOString() }, '15m': { closedThrough: new Date(NOW).toISOString() } },
      marketByTf: { '1m': { price: 1000, atr: 5 } },
      candlesByTf: {},
      intervalMsByTf: INTERVAL_MS,
      geometryTimeframes: ['15m'],
      now: NOW,
      configVersion: 'TEST'
    };
    try {
      const shipped = buildFlagTradePlan(params); // no cfg arg: uses the module's own default ENGINE_CONFIG (net gate on, 2.0)
      assertEqual(shipped.grossRR, 3, 'sanity: gross RR 3 meets the floor');
      assertClose(shipped.netRR, 0.333, 0.001, 'sanity: thin net RR, published on every plan');
      assertEqual(shipped.status, 'rejected', 'the shipped default net gate must already reject this thin-net-RR plan');
      assertEqual(shipped.reasonCode, 'stop_inside_costs', 'reasonCode');

      setConfigOverride({ flagPlan: { minNetRR: null } });
      const overridden = buildFlagTradePlan(params); // same call, no cfg arg: override now live, no import in lib/flagTradePlan.js changed
      assertEqual(overridden.grossRR, shipped.grossRR, 'gross RR unaffected by the override');
      assert(overridden.status !== 'rejected' || overridden.reasonCode !== 'stop_inside_costs', 'the live override (net gate off) was not seen by lib/flagTradePlan.js\'s own default cfg param');
    } finally {
      setConfigOverride(null);
    }
  });

  await test('unknown keys fall back instead of returning undefined', () => {
    assertArrayEqual(rrForSetupType('NoSuchSetup'), [3.0, 4.0], 'setup-type fallback drifted');
    assertArrayEqual(rrForStrategy('NO_SUCH_STRATEGY'), [1.0, 2.0], 'strategy fallback drifted');
  });

  await test('strategy.js sources the scalp stop cap from config', () => {
    assertEqual(MAX_SCALP_STOP_DISTANCE_PCT, ENGINE_CONFIG.scalp.maxStopDistancePct, 'cap no longer tracks config');
    assertEqual(MAX_SCALP_STOP_DISTANCE_PCT, 3.0, 'cap value changed — the 3% invariant is not negotiable');
  });

  await test('strategy.js holds no second copy of the moved constants', () => {
    const src = readFileSync(new URL('./services/strategy.js', import.meta.url), 'utf8');
    assert(!/emaPullbackMax:\s*1\.0/.test(src), 'THRESHOLDS literals still live in strategy.js');
    assert(!/const buffer = 0\.004/.test(src), 'EMA entry buffer literal still in strategy.js');
    assert(!/const buffer = 0\.003/.test(src), 'structure stop buffer literal still in strategy.js');
    assert(!/MAX_SCALP_STOP_DISTANCE_PCT = 3\.0/.test(src), 'scalp cap literal still in strategy.js');
  });

  await test('calculateSLTP reads R:R from config and stays direction-symmetric', () => {
    const structures = { '4h': { swingHigh: 110, swingLow: 90 } };
    const long = calculateSLTP(100, 'long', structures, 'Scalp', rrForSetupType('Scalp'));
    const short = calculateSLTP(100, 'short', structures, 'Scalp', rrForSetupType('Scalp'));
    const buffer = ENGINE_CONFIG.stops.structureBuffer;

    assertEqual(long.stopSource, '4h', 'long stop did not come from structure');
    assertEqual(short.stopSource, '4h', 'short stop did not come from structure');

    // The buffer is multiplicative, so a long stop below 90 and a short stop above 110
    // are not equidistant from 100. Symmetry here means one mirrored formula, not one
    // number: each side buffers its own structural level, then targets R off its own risk.
    assert(Math.abs(long.stopLoss - 90 * (1 - buffer)) < 1e-9, 'long stop is not the buffered swing low');
    assert(Math.abs(short.stopLoss - 110 * (1 + buffer)) < 1e-9, 'short stop is not the buffered swing high');
    assert(long.riskAmount > 0 && short.riskAmount > 0, 'risk must be positive on both sides');
    const [rr1, rr2] = rrForSetupType('Scalp');
    assert(Math.abs(long.targets[0] - (100 + long.riskAmount * rr1)) < 1e-9, 'long TP1 does not use the configured R:R');
    assert(Math.abs(long.targets[1] - (100 + long.riskAmount * rr2)) < 1e-9, 'long TP2 does not use the configured R:R');
    assert(Math.abs(short.targets[0] - (100 - short.riskAmount * rr1)) < 1e-9, 'short TP1 does not use the configured R:R');
    assert(Math.abs(short.targets[1] - (100 - short.riskAmount * rr2)) < 1e-9, 'short TP2 does not use the configured R:R');
  });

  await test('calculateSLTP percentage fallback uses the configured stop cap, both directions', () => {
    // No structure on the correct side -> percentage stop at exactly the policy distance.
    const pct = ENGINE_CONFIG.scalp.maxStopDistancePct / 100;
    const long = calculateSLTP(100, 'long', {}, 'Scalp', rrForSetupType('Scalp'));
    const short = calculateSLTP(100, 'short', {}, 'Scalp', rrForSetupType('Scalp'));
    assertEqual(long.stopSource, 'percentage', 'long did not fall back to a percentage stop');
    assertEqual(short.stopSource, 'percentage', 'short did not fall back to a percentage stop');
    assert(Math.abs(long.stopLoss - 100 * (1 - pct)) < 1e-9, 'long percentage stop is not at the configured distance');
    assert(Math.abs(short.stopLoss - 100 * (1 + pct)) < 1e-9, 'short percentage stop is not at the configured distance');
  });

  await test('the scalp stop guard still rejects beyond the configured cap, both directions', () => {
    const cap = ENGINE_CONFIG.scalp.maxStopDistancePct;
    assert(validateScalpStopDistance(100, 100 * (1 - cap / 100)).valid, 'long stop exactly at the cap was rejected');
    assert(validateScalpStopDistance(100, 100 * (1 + cap / 100)).valid, 'short stop exactly at the cap was rejected');
    assert(!validateScalpStopDistance(100, 95).valid, 'long stop 5% away was accepted');
    assert(!validateScalpStopDistance(100, 105).valid, 'short stop 5% away was accepted');
    assertEqual(validateScalpStopDistance(100, 95).maxDistancePct, cap, 'guard is not reading the configured cap');
  });

  await test('payload carries configVersion and the bumped schemaVersion', async () => {
    const payload = await buildScalpContext({
      symbols: ['BTC'],
      timeframes: ['1m', '5m', '15m', '1h', '4h', '1d'],
      now: NOW,
      fetchCandles: fakeFetch,
      fetchAccount: fakeAccount
    });
    assertEqual(payload.schemaVersion, '1.23.0', 'schemaVersion was not bumped');
    assertEqual(payload.configVersion, CONFIG_VERSION, 'payload configVersion does not match the loader');
    assertEqual(typeof payload.configVersion, 'string', 'configVersion is not a string in the payload');
  });

  await test('OpenAPI documents configVersion as required', () => {
    const yaml = readFileSync(new URL('./openapi/scalp-context.yaml', import.meta.url), 'utf8');
    assert(/^\s+configVersion:\s*$/m.test(yaml), 'configVersion property missing from the schema');
    assert(/^\s+- configVersion$/m.test(yaml), 'configVersion missing from the required list');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
