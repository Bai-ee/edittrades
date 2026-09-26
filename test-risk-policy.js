/**
 * Deterministic, zero-dependency test suite for lib/execution/riskPolicy.js (T-8, wallet-
 * aware risk policy). No network calls.
 *
 * Run: node test-risk-policy.js
 */

import {
  RISK_DEFAULTS, RISK_PCT_PER_TRADE_MAX,
  readRiskPolicyConfig, normalizeRiskPrefs, riskOverrideBound, applyRiskPrefs, evaluateRiskPolicy
} from './lib/execution/riskPolicy.js';

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

const LONG_INTENT = { symbol: 'BTC', sizeUsd: 1000, leverage: 5, entry: 100000, stop: 98000 }; // 2% stop
const SHORT_INTENT = { symbol: 'BTC', sizeUsd: 1000, leverage: 5, entry: 100000, stop: 102000 }; // 2% stop, mirrored

async function run() {
  console.log('\nRisk policy (T-8)\n');

  console.log('1) readRiskPolicyConfig');

  await test('defaults with no env', () => {
    const cfg = readRiskPolicyConfig({});
    assertEqual(cfg.pctPerTrade, RISK_DEFAULTS.pctPerTrade);
    assertEqual(cfg.maxExposurePct, RISK_DEFAULTS.maxExposurePct);
    assertEqual(cfg.maxPerSymbolPct, RISK_DEFAULTS.maxPerSymbolPct);
    assertEqual(cfg.dailyDrawdownPct, RISK_DEFAULTS.dailyDrawdownPct);
    assertEqual(cfg.weeklyDrawdownPct, RISK_DEFAULTS.weeklyDrawdownPct);
    assertEqual(cfg.minFreeGasSol, RISK_DEFAULTS.minFreeGasSol);
  });

  await test('env overrides valid positive numbers', () => {
    const cfg = readRiskPolicyConfig({ RISK_PCT_PER_TRADE: '1', RISK_MAX_EXPOSURE_PCT: '40' });
    assertEqual(cfg.pctPerTrade, 1);
    assertEqual(cfg.maxExposurePct, 40);
    assertEqual(cfg.maxPerSymbolPct, RISK_DEFAULTS.maxPerSymbolPct); // untouched
  });

  await test('invalid / non-positive env falls back to the default', () => {
    const cfg = readRiskPolicyConfig({ RISK_PCT_PER_TRADE: 'abc', RISK_MAX_EXPOSURE_PCT: '-5', RISK_DAILY_DRAWDOWN_PCT: '0' });
    assertEqual(cfg.pctPerTrade, RISK_DEFAULTS.pctPerTrade);
    assertEqual(cfg.maxExposurePct, RISK_DEFAULTS.maxExposurePct);
    assertEqual(cfg.dailyDrawdownPct, RISK_DEFAULTS.dailyDrawdownPct);
  });

  console.log('\n2) equity_unavailable');

  await test('null equity refuses with equity_unavailable and nulls everything else', () => {
    const r = evaluateRiskPolicy({ equityUsd: null, intent: LONG_INTENT });
    assertEqual(r.ok, false);
    assertEqual(r.reasons.length, 1);
    assertEqual(r.reasons[0], 'equity_unavailable');
    assertEqual(r.suggestedSizeUsd, null);
    assertEqual(r.suggestedLeverage, null);
    assertEqual(r.riskUsd, null);
    assertEqual(r.riskPct, null);
    assertEqual(r.exposurePct, null);
    assertEqual(r.drawdown.dayPct, null);
    assertEqual(r.drawdown.weekPct, null);
  });

  await test('zero or negative equity is also unavailable, never treated as infinite', () => {
    assertEqual(evaluateRiskPolicy({ equityUsd: 0, intent: LONG_INTENT }).reasons[0], 'equity_unavailable');
    assertEqual(evaluateRiskPolicy({ equityUsd: -50, intent: LONG_INTENT }).reasons[0], 'equity_unavailable');
  });

  console.log('\n3) risk-per-trade sizing and mirrored long/short');

  await test('a 2% stop with 0.5% risk-per-trade sizes a $500 max loss position', () => {
    const equityUsd = 100000; // 0.5% of 100k = $500 risk budget
    const r = evaluateRiskPolicy({ equityUsd, intent: { ...LONG_INTENT, sizeUsd: 1000 } });
    assertClose(r.riskUsd, 20, 0.01, 'riskUsd (1000 * 2%)'); // $1000 * 2% = $20 loss at stop
    assertClose(r.riskPct, 0.02, 0.001, 'riskPct (20 / 100000)');
    assertEqual(r.reasons.includes('risk_pct_over'), false);
    assertClose(r.suggestedSizeUsd, 25000, 1, 'suggestedSizeUsd = 500 / 2%');
  });

  await test('long and short mirror: identical stop distance gives identical risk numbers', () => {
    const equityUsd = 50000;
    const rl = evaluateRiskPolicy({ equityUsd, intent: LONG_INTENT });
    const rs = evaluateRiskPolicy({ equityUsd, intent: SHORT_INTENT });
    assertEqual(rl.riskUsd, rs.riskUsd);
    assertEqual(rl.riskPct, rs.riskPct);
    assertEqual(rl.suggestedSizeUsd, rs.suggestedSizeUsd);
    assertEqual(rl.suggestedLeverage, rs.suggestedLeverage);
  });

  await test('risk_pct_over fires when the intent size risks more than the per-trade cap', () => {
    const equityUsd = 1000; // 0.5% = $5 budget
    const r = evaluateRiskPolicy({ equityUsd, intent: { ...LONG_INTENT, sizeUsd: 5000 } }); // 2% of 5000 = $100 loss
    assert(r.reasons.includes('risk_pct_over'), `expected risk_pct_over, got ${r.reasons}`);
    assertEqual(r.ok, false);
  });

  await test('suggestedSizeUsd respects an injected env cap (maxSizeCapUsd)', () => {
    const equityUsd = 1000000; // huge equity -> uncapped suggestion would be enormous
    const r = evaluateRiskPolicy({ equityUsd, intent: LONG_INTENT, policy: { maxSizeCapUsd: 200 } });
    assertEqual(r.suggestedSizeUsd, 200);
  });

  await test('suggestedLeverage is capped by both the liquidation model and an injected env cap', () => {
    const equityUsd = 100000;
    const uncapped = evaluateRiskPolicy({ equityUsd, intent: LONG_INTENT });
    assert(uncapped.suggestedLeverage >= 1, 'expected a positive suggested leverage');
    const capped = evaluateRiskPolicy({ equityUsd, intent: LONG_INTENT, policy: { maxLeverageCap: 2 } });
    assertEqual(capped.suggestedLeverage, Math.min(uncapped.suggestedLeverage, 2));
  });

  console.log('\n4) exposure');

  await test('exposure_over fires once total notional (existing + intent) exceeds the cap', () => {
    const equityUsd = 10000; // 25% default cap = $2500
    const openPositions = [{ symbol: 'ETH', sizeUsd: 2000 }];
    const r = evaluateRiskPolicy({ equityUsd, openPositions, intent: { ...LONG_INTENT, sizeUsd: 600 } });
    assertClose(r.exposurePct, 26, 0.01);
    assert(r.reasons.includes('exposure_over'), `expected exposure_over, got ${r.reasons}`);
  });

  await test('exposurePctBefore is the existing exposure only, exposurePct includes the new intent (for a before -> after ticket line)', () => {
    const equityUsd = 10000;
    const r = evaluateRiskPolicy({ equityUsd, openPositions: [{ symbol: 'ETH', sizeUsd: 300 }], intent: { ...LONG_INTENT, sizeUsd: 200 } });
    assertClose(r.exposurePctBefore, 3, 0.01);
    assertClose(r.exposurePct, 5, 0.01);
  });

  await test('exposure under the cap does not refuse', () => {
    const equityUsd = 10000;
    const r = evaluateRiskPolicy({ equityUsd, openPositions: [{ symbol: 'ETH', sizeUsd: 500 }], intent: { ...LONG_INTENT, sizeUsd: 500 } });
    assertClose(r.exposurePct, 10, 0.01);
    assertEqual(r.reasons.includes('exposure_over'), false);
  });

  await test('symbol_exposure_over fires when one symbol alone exceeds its per-symbol cap', () => {
    const equityUsd = 10000; // 15% default per-symbol cap = $1500
    const openPositions = [{ symbol: 'BTC', sizeUsd: 1000 }, { symbol: 'ETH', sizeUsd: 5000 }];
    const r = evaluateRiskPolicy({ equityUsd, openPositions, intent: { ...LONG_INTENT, symbol: 'BTC', sizeUsd: 600 } });
    assertClose(r.symbolExposurePct, 16, 0.01);
    assert(r.reasons.includes('symbol_exposure_over'), `expected symbol_exposure_over, got ${r.reasons}`);
    // Overall exposure (1000+5000+600=6600 / 10000 = 66%) also breaches — both reasons present.
    assert(r.reasons.includes('exposure_over'));
  });

  await test('a position in a different symbol does not count toward this symbol\'s exposure', () => {
    const equityUsd = 10000;
    const openPositions = [{ symbol: 'ETH', sizeUsd: 1400 }];
    const r = evaluateRiskPolicy({ equityUsd, openPositions, intent: { ...LONG_INTENT, symbol: 'BTC', sizeUsd: 100 } });
    assertClose(r.symbolExposurePct, 1, 0.01);
    assertEqual(r.reasons.includes('symbol_exposure_over'), false);
  });

  console.log('\n5) drawdown');

  await test('daily_drawdown fires when today\'s loss exceeds the daily cap', () => {
    const equityUsd = 10000; // day-start equity 10300, loss 300 -> 300/10300 ~= 2.91%... use bigger loss
    const r = evaluateRiskPolicy({ equityUsd, dailyPnlUsd: -400 }); // base 10400, 400/10400 ~= 3.85% > 3% default
    assert(r.drawdown.dayPct > 3, `expected dayPct > 3, got ${r.drawdown.dayPct}`);
    assert(r.reasons.includes('daily_drawdown'), `expected daily_drawdown, got ${r.reasons}`);
  });

  await test('a positive or zero daily PnL never trips daily_drawdown', () => {
    const equityUsd = 10000;
    assertEqual(evaluateRiskPolicy({ equityUsd, dailyPnlUsd: 500 }).drawdown.dayPct, 0);
    assertEqual(evaluateRiskPolicy({ equityUsd, dailyPnlUsd: 0 }).drawdown.dayPct, 0);
    assertEqual(evaluateRiskPolicy({ equityUsd, dailyPnlUsd: 500 }).reasons.includes('daily_drawdown'), false);
  });

  await test('weekly_drawdown fires independently of the daily figure', () => {
    const equityUsd = 10000;
    const r = evaluateRiskPolicy({ equityUsd, dailyPnlUsd: -50, weekPnlUsd: -1000 }); // base 11000, ~9.09% > 8%
    assertEqual(r.reasons.includes('daily_drawdown'), false);
    assert(r.reasons.includes('weekly_drawdown'), `expected weekly_drawdown, got ${r.reasons}`);
  });

  await test('drawdown pct is null only when equity itself is unavailable, never a bare loss', () => {
    const r = evaluateRiskPolicy({ equityUsd: null, dailyPnlUsd: -100 });
    assertEqual(r.drawdown.dayPct, null);
  });

  console.log('\n6) gas');

  await test('gas_low fires when free SOL is under the threshold', () => {
    const r = evaluateRiskPolicy({ equityUsd: 10000, freeGasSol: 0.01 });
    assert(r.reasons.includes('gas_low'), `expected gas_low, got ${r.reasons}`);
  });

  await test('gas at or above the threshold does not refuse, and an unknown gas figure is silently skipped', () => {
    assertEqual(evaluateRiskPolicy({ equityUsd: 10000, freeGasSol: 0.05 }).reasons.includes('gas_low'), false);
    assertEqual(evaluateRiskPolicy({ equityUsd: 10000 }).reasons.includes('gas_low'), false);
  });

  console.log('\n7) all reason codes can combine on one refusal');

  await test('a single evaluation can carry every reason code at once', () => {
    const r = evaluateRiskPolicy({
      equityUsd: 1000,
      openPositions: [{ symbol: 'BTC', sizeUsd: 900 }],
      dailyPnlUsd: -100,
      weekPnlUsd: -200,
      freeGasSol: 0.001,
      intent: { symbol: 'BTC', sizeUsd: 900, leverage: 5, entry: 100000, stop: 90000 } // 10% stop, huge risk
    });
    assertEqual(r.ok, false);
    for (const code of ['risk_pct_over', 'exposure_over', 'symbol_exposure_over', 'daily_drawdown', 'weekly_drawdown', 'gas_low']) {
      assert(r.reasons.includes(code), `expected ${code} among ${JSON.stringify(r.reasons)}`);
    }
  });

  console.log('\n8) no intent (status-style snapshot)');

  await test('with no intent, exposure/drawdown still compute but risk/sizing stay null', () => {
    const r = evaluateRiskPolicy({ equityUsd: 10000, openPositions: [{ symbol: 'BTC', sizeUsd: 1000 }], dailyPnlUsd: -50 });
    assertClose(r.exposurePct, 10, 0.01);
    assertEqual(r.riskUsd, null);
    assertEqual(r.riskPct, null);
    assertEqual(r.suggestedSizeUsd, null);
    assertEqual(r.suggestedLeverage, null);
    assertEqual(r.ok, true);
  });

  console.log('\n9) prefs bounds (normalizeRiskPrefs, riskOverrideBound, applyRiskPrefs)');

  await test('normalizeRiskPrefs drops unknown keys and non-positive / non-numeric values', () => {
    const out = normalizeRiskPrefs({ pctPerTrade: 0.3, maxExposurePct: -1, notAKey: 99, minFreeGasSol: 'nope' });
    assertEqual(out.pctPerTrade, 0.3);
    assertEqual('maxExposurePct' in out, false);
    assertEqual('notAKey' in out, false);
    assertEqual('minFreeGasSol' in out, false);
  });

  await test('normalizeRiskPrefs on garbage input returns an empty object, never throws', () => {
    assertEqual(Object.keys(normalizeRiskPrefs(null)).length, 0);
    assertEqual(Object.keys(normalizeRiskPrefs('nonsense')).length, 0);
  });

  await test('riskOverrideBound caps pctPerTrade at RISK_PCT_PER_TRADE_MAX even when env allows more', () => {
    const envConfig = { pctPerTrade: 5 }; // a misconfigured env asking for 5% per trade
    assertEqual(riskOverrideBound('pctPerTrade', envConfig), RISK_PCT_PER_TRADE_MAX);
  });

  await test('riskOverrideBound for other keys is exactly the env value (tighten-only)', () => {
    const envConfig = { maxExposurePct: 25 };
    assertEqual(riskOverrideBound('maxExposurePct', envConfig), 25);
  });

  await test('applyRiskPrefs accepts an in-bound override', () => {
    const envConfig = readRiskPolicyConfig({});
    const merged = applyRiskPrefs(envConfig, { pctPerTrade: 0.2 });
    assertEqual(merged.pctPerTrade, 0.2);
    assertEqual(merged.maxExposurePct, envConfig.maxExposurePct); // untouched
  });

  await test('applyRiskPrefs ignores an out-of-bound override (never loosens beyond env)', () => {
    const envConfig = readRiskPolicyConfig({}); // pctPerTrade default 0.5
    const merged = applyRiskPrefs(envConfig, { pctPerTrade: 1.5 }); // above env default -> ignored
    assertEqual(merged.pctPerTrade, envConfig.pctPerTrade);
  });

  await test('applyRiskPrefs ignores an override above the absolute 2% ceiling even if env itself allows more', () => {
    const envConfig = { ...readRiskPolicyConfig({}), pctPerTrade: 3 }; // misconfigured env
    const merged = applyRiskPrefs(envConfig, { pctPerTrade: 2.5 }); // above the absolute ceiling
    assertEqual(merged.pctPerTrade, 3); // override rejected, env value (however misconfigured) stands
  });

  await test('applyRiskPrefs never throws on garbage prefs', () => {
    const envConfig = readRiskPolicyConfig({});
    const merged = applyRiskPrefs(envConfig, null);
    assertEqual(merged.pctPerTrade, envConfig.pctPerTrade);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
