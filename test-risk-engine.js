/**
 * Deterministic, zero-dependency test suite for lib/riskEngine.js (phase 3 of the engine
 * refinement plan). No network calls.
 *
 * Run: node test-risk-engine.js
 */

import { ENGINE_CONFIG } from './config/engine.js';
import {
  maxLeverageForStop,
  positionPlan,
  positionRisk,
  maxStopDistanceForBudget,
  stopHierarchy
} from './lib/riskEngine.js';

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
// MISS_002 fixture (from the playbook)
// ---------------------------------------------------------------------------

const MISS_002_LONG = {
  side: 'long',
  entry: 86289.01,
  notional: 931.73,
  collateral: 9.34,
  leverage: 99.77,
  liquidationPrice: 85657.61
};
const MISS_002_STOP_PRICE = 86250;

// Mirror MISS_002 around its own entry price so a short position reproduces the exact
// same distances (and therefore the exact same stopDistancePct/lossAtStopUsd/etc) with
// every side flipped. This is what "short mirror of the same fixture" means: one
// parameterised path, verified on both sides from the same real numbers.
function mirrorAroundEntry(price, entry) {
  return entry + (entry - price);
}

const MISS_002_SHORT = {
  side: 'short',
  entry: MISS_002_LONG.entry,
  notional: MISS_002_LONG.notional,
  collateral: MISS_002_LONG.collateral,
  leverage: MISS_002_LONG.leverage,
  liquidationPrice: mirrorAroundEntry(MISS_002_LONG.liquidationPrice, MISS_002_LONG.entry)
};
const MISS_002_SHORT_STOP_PRICE = mirrorAroundEntry(MISS_002_STOP_PRICE, MISS_002_LONG.entry);

async function run() {
  console.log('\nRisk engine (phase 3)\n');

  // -------------------------------------------------------------------------
  // maxLeverageForStop
  // -------------------------------------------------------------------------
  console.log('1) maxLeverageForStop');

  await test('a 3% stop caps leverage well under 100x', () => {
    const cap = maxLeverageForStop(3.0);
    assert(Number.isInteger(cap), 'cap must be an integer');
    assert(cap < 100, `expected well under 100x, got ${cap}`);
    assert(cap > 1, `expected a usable cap, got ${cap}`);
  });

  await test('a 0.5% stop yields a higher cap than a 3% stop', () => {
    const tight = maxLeverageForStop(3.0);
    const loose = maxLeverageForStop(0.5);
    assert(loose > tight, `expected 0.5% cap (${loose}) > 3% cap (${tight})`);
  });

  await test('the cap never exceeds cfg.maxLeverage', () => {
    const cap = maxLeverageForStop(0.05);
    assert(cap <= ENGINE_CONFIG.risk.maxLeverage, `cap ${cap} exceeded configured maxLeverage`);
  });

  await test('invalid stop distance returns null, not a guess', () => {
    assertEqual(maxLeverageForStop(0), null);
    assertEqual(maxLeverageForStop(-1), null);
    assertEqual(maxLeverageForStop(NaN), null);
    assertEqual(maxLeverageForStop(null), null);
  });

  // -------------------------------------------------------------------------
  // positionPlan
  // -------------------------------------------------------------------------
  console.log('\n2) positionPlan');

  await test('margin unavailable -> nulls, not a fabricated plan', () => {
    const plan = positionPlan({ marginUsd: null, stopDistancePct: 3 });
    assertEqual(plan.leverage, null);
    assertEqual(plan.notionalUsd, null);
    assertEqual(plan.lossAtStopUsd, null);
    assertEqual(plan.lossAtStopPct, null);
    assertEqual(plan.capped, false);
    assertEqual(plan.capReason, null);

    const zeroMargin = positionPlan({ marginUsd: 0, stopDistancePct: 3 });
    assertEqual(zeroMargin.leverage, null, 'zero margin must not be treated as available');
  });

  await test('requested leverage above the stop-distance cap is capped with a reason', () => {
    const plan = positionPlan({ marginUsd: 10, stopDistancePct: 3, leverageRequested: 100, maxWalletRiskPct: 90 });
    const cap = maxLeverageForStop(3, ENGINE_CONFIG.risk);
    assertEqual(plan.leverage, cap, 'leverage should land exactly on the stop-distance cap');
    assertEqual(plan.capped, true);
    assertEqual(plan.capReason, 'stop-distance');
  });

  await test('wallet-risk cap binds before the stop-distance cap when it is tighter', () => {
    // 0.5% stop leaves the stop-distance cap wide (well above the exchange max, clamped
    // to it); a tight 1% wallet-risk budget binds first instead.
    const plan = positionPlan({ marginUsd: 10, stopDistancePct: 0.5, leverageRequested: 100, maxWalletRiskPct: 1 });
    assertEqual(plan.capped, true);
    assertEqual(plan.capReason, 'wallet-risk');
    assertEqual(plan.leverage, Math.floor((1 / 100) / (0.5 / 100)), 'wallet-risk leverage math drifted');
  });

  await test('requested leverage within every cap is not reported as capped', () => {
    const plan = positionPlan({ marginUsd: 10, stopDistancePct: 3, leverageRequested: 5, maxWalletRiskPct: 90 });
    assertEqual(plan.capped, false);
    assertEqual(plan.capReason, null);
    assertEqual(plan.leverage, 5);
  });

  await test('walletMarginUsd, when given, is the basis for the wallet-risk cap instead of marginUsd', () => {
    // Small collateral (10), tight stop (0.1%): if the wallet-risk cap were measured
    // against the $10 collateral, 2% of $10 = $0.20 budget forces leverage down hard.
    // Measured against a much larger real wallet, the budget is generous instead.
    const collateralOnly = positionPlan({ marginUsd: 10, stopDistancePct: 0.1, leverageRequested: 100, maxWalletRiskPct: 2 });
    const walletBacked = positionPlan({ marginUsd: 10, walletMarginUsd: 5000, stopDistancePct: 0.1, leverageRequested: 100, maxWalletRiskPct: 2 });
    assert(walletBacked.leverage > collateralOnly.leverage, `expected the wallet-backed cap (${walletBacked.leverage}) to allow more leverage than the collateral-only cap (${collateralOnly.leverage})`);
  });

  await test('omitting walletMarginUsd preserves the original single-basis behavior', () => {
    const withDefault = positionPlan({ marginUsd: 10, stopDistancePct: 0.5, leverageRequested: 100, maxWalletRiskPct: 1 });
    const explicitSame = positionPlan({ marginUsd: 10, walletMarginUsd: 10, stopDistancePct: 0.5, leverageRequested: 100, maxWalletRiskPct: 1 });
    assertEqual(withDefault.leverage, explicitSame.leverage);
    assertEqual(withDefault.capReason, explicitSame.capReason);
  });

  await test('notional and loss figures are internally consistent', () => {
    const plan = positionPlan({ marginUsd: 10, stopDistancePct: 3, leverageRequested: 5, maxWalletRiskPct: 90 });
    assertClose(plan.notionalUsd, 5 * 10, 1e-9, 'notionalUsd');
    assertClose(plan.lossAtStopUsd, plan.notionalUsd * 0.03, 1e-6, 'lossAtStopUsd');
    assertClose(plan.lossAtStopPct, (plan.lossAtStopUsd / 10) * 100, 1e-6, 'lossAtStopPct');
  });

  // -------------------------------------------------------------------------
  // positionRisk - MISS_002 exact numbers, both directions
  // -------------------------------------------------------------------------
  console.log('\n3) positionRisk (MISS_002 fixture, long and short mirror)');

  await test('MISS_002 long: stopDistancePct, lossAtStopUsd, lossAtStopPctOfCollateral, stopBeforeLiquidation', () => {
    const r = positionRisk(MISS_002_LONG, MISS_002_STOP_PRICE);
    assertClose(r.stopDistancePct, 0.045, 0.002, 'stopDistancePct');
    assertClose(r.lossAtStopUsd, 0.42, 0.02, 'lossAtStopUsd');
    assertClose(r.lossAtStopPctOfCollateral, 4.5, 0.1, 'lossAtStopPctOfCollateral');
    assertClose(r.distanceToLiquidationPct, 0.7317, 0.01, 'distanceToLiquidationPct');
    assertEqual(r.stopBeforeLiquidation, true, 'stopBeforeLiquidation');
    assertEqual(r.executable, 'intrabar', 'executable');
  });

  await test('MISS_002 short mirror: identical distances and figures, sides flipped', () => {
    const long = positionRisk(MISS_002_LONG, MISS_002_STOP_PRICE);
    const short = positionRisk(MISS_002_SHORT, MISS_002_SHORT_STOP_PRICE);
    assertClose(short.stopDistancePct, long.stopDistancePct, 1e-6, 'short stopDistancePct must mirror long');
    assertClose(short.lossAtStopUsd, long.lossAtStopUsd, 1e-6, 'short lossAtStopUsd must mirror long');
    assertClose(short.lossAtStopPctOfCollateral, long.lossAtStopPctOfCollateral, 1e-6, 'short lossAtStopPctOfCollateral must mirror long');
    assertClose(short.distanceToLiquidationPct, long.distanceToLiquidationPct, 1e-6, 'short distanceToLiquidationPct must mirror long');
    assertEqual(short.stopBeforeLiquidation, true, 'short stopBeforeLiquidation');
    assertEqual(short.executable, 'intrabar', 'short executable');
  });

  await test('positionRisk on an invalid position returns an all-null shape, never a guess', () => {
    const r = positionRisk({ side: 'long', entry: null, notional: 1, collateral: 1, liquidationPrice: 1 }, 100);
    assertEqual(r.stopDistancePct, null);
    assertEqual(r.lossAtStopUsd, null);
    assertEqual(r.lossAtStopPctOfCollateral, null);
    assertEqual(r.distanceToLiquidationPct, null);
    assertEqual(r.stopBeforeLiquidation, null);
    assertEqual(r.executable, null);
  });

  await test('a stop past liquidation is never reported as before it', () => {
    const r = positionRisk(MISS_002_LONG, 85000); // below liquidationPrice for a long
    assertEqual(r.stopBeforeLiquidation, false);
  });

  // -------------------------------------------------------------------------
  // maxStopDistanceForBudget
  // -------------------------------------------------------------------------
  console.log('\n4) maxStopDistanceForBudget');

  await test('a real budget yields a positive price distance under the naive (fee-free) distance', () => {
    const distance = maxStopDistanceForBudget(MISS_002_LONG, 1, { feeBps: 5, slippageBps: 5 });
    const naive = MISS_002_LONG.entry * (1 / MISS_002_LONG.notional);
    assert(distance > 0, 'expected a positive distance');
    assert(distance < naive, 'execution cost must shrink the naive distance');
  });

  await test('a budget fully consumed by fee/slippage returns null, not zero pretending to be a number', () => {
    const distance = maxStopDistanceForBudget(MISS_002_LONG, 0.01, { feeBps: 5, slippageBps: 5 });
    assertEqual(distance, null);
  });

  await test('invalid inputs return null', () => {
    assertEqual(maxStopDistanceForBudget({ entry: null, notional: 1 }, 1), null);
    assertEqual(maxStopDistanceForBudget(MISS_002_LONG, 0), null);
    assertEqual(maxStopDistanceForBudget(MISS_002_LONG, -5), null);
  });

  // -------------------------------------------------------------------------
  // stopHierarchy - MISS_002 compatibility boundary, both directions
  // -------------------------------------------------------------------------
  console.log('\n5) stopHierarchy (MISS_002 compatibility boundary)');

  function liquidationCeilingPct(position) {
    const distanceToLiquidationPct = (Math.abs(position.entry - position.liquidationPrice) / position.entry) * 100;
    return distanceToLiquidationPct - ENGINE_CONFIG.risk.liquidationBufferPct;
  }

  await test('long: a structural invalidation safely inside the liquidation ceiling is compatible', () => {
    const ceiling = liquidationCeilingPct(MISS_002_LONG);
    const safeDistancePct = ceiling - 0.05;
    const invalidation = MISS_002_LONG.entry * (1 - safeDistancePct / 100);
    // Generous budget so only the liquidation-safety check is exercised here.
    const r = stopHierarchy(MISS_002_LONG, invalidation, 100);
    assertEqual(r.compatible, true, r.reason || 'expected compatible');
    assertEqual(r.reason, null);
    assertClose(r.protectiveStop, invalidation, 0.5, 'protectiveStop should equal the thesis level when compatible');
    assertEqual(r.thesisInvalidation, invalidation);
  });

  await test('long: a structural invalidation beyond the liquidation ceiling ("~0.7% away") is incompatible with a recommended leverage', () => {
    const ceiling = liquidationCeilingPct(MISS_002_LONG);
    const unsafeDistancePct = ceiling + 0.05;
    const invalidation = MISS_002_LONG.entry * (1 - unsafeDistancePct / 100);
    const r = stopHierarchy(MISS_002_LONG, invalidation, 100);
    assertEqual(r.compatible, false);
    assert(typeof r.reason === 'string' && r.reason.length > 0, 'expected a reason');
    assertEqual(r.thesisInvalidation, invalidation, 'thesis level must be echoed back unchanged, never tightened');
    assert(Number.isInteger(r.recommendedLeverage) && r.recommendedLeverage > 0, `expected a recommended leverage, got ${r.recommendedLeverage}`);
    assert(r.recommendedLeverage < MISS_002_LONG.leverage, 'recommended leverage should be lower than the reckless original');
    assert(r.protectiveStop > invalidation, 'protectiveStop must sit closer to entry than the unreachable thesis level, for a long');
  });

  await test('short mirror: same boundary, both outcomes', () => {
    const ceiling = liquidationCeilingPct(MISS_002_SHORT);

    const safeDistancePct = ceiling - 0.05;
    const safeInvalidation = MISS_002_SHORT.entry * (1 + safeDistancePct / 100);
    const compatibleResult = stopHierarchy(MISS_002_SHORT, safeInvalidation, 100);
    assertEqual(compatibleResult.compatible, true, compatibleResult.reason || 'expected compatible');

    const unsafeDistancePct = ceiling + 0.05;
    const unsafeInvalidation = MISS_002_SHORT.entry * (1 + unsafeDistancePct / 100);
    const incompatibleResult = stopHierarchy(MISS_002_SHORT, unsafeInvalidation, 100);
    assertEqual(incompatibleResult.compatible, false);
    assertEqual(incompatibleResult.thesisInvalidation, unsafeInvalidation);
    assert(Number.isInteger(incompatibleResult.recommendedLeverage) && incompatibleResult.recommendedLeverage > 0, 'expected a recommended leverage');
  });

  await test('a loss budget tighter than the liquidation ceiling binds instead, with its own reason', () => {
    // Structural level is well inside the liquidation ceiling, but the budget is tiny.
    const safeDistancePct = liquidationCeilingPct(MISS_002_LONG) - 0.1;
    const invalidation = MISS_002_LONG.entry * (1 - safeDistancePct / 100);
    const r = stopHierarchy(MISS_002_LONG, invalidation, 0.01);
    assertEqual(r.compatible, false);
    assert(/loss budget/i.test(r.reason), `expected a loss-budget reason, got: ${r.reason}`);
    assert(isFinitePositive(r.recommendedNotional), 'expected a recommended notional');
    assert(r.recommendedNotional < MISS_002_LONG.notional, 'recommended notional should shrink to fit the tiny budget');
  });

  await test('a structural invalidation on the wrong side of entry is never compatible', () => {
    const wrongSide = MISS_002_LONG.entry * 1.01; // above entry, invalid for a long
    const r = stopHierarchy(MISS_002_LONG, wrongSide, 100);
    assertEqual(r.compatible, false);
    assert(/wrong side/i.test(r.reason), `expected a wrong-side reason, got: ${r.reason}`);
  });

  await test('invalid position or invalidation input returns nulls, never a guess', () => {
    const r = stopHierarchy({ side: 'long', entry: null }, 100, 1);
    assertEqual(r.protectiveStop, null);
    assertEqual(r.compatible, false);
    assertEqual(r.recommendedLeverage, null);
    assertEqual(r.recommendedNotional, null);
  });

  function isFinitePositive(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
