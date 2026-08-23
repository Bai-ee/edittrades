#!/usr/bin/env node
/**
 * Risk Manager — deterministic validation harness
 *
 *   node scripts/validate-risk-manager.js
 *
 * Verifies the risk arithmetic independently of the UI. Every expected value
 * here is computed by hand or by an independent route, not by calling the same
 * function under test.
 *
 * Exit code 0 = all assertions hold.
 */

import {
  DEFAULT_RISK_POLICY,
  RISK_STATUS,
  calculateStopDistance,
  calculateAllowedRisk,
  calculatePositionSize,
  calculateRequiredMargin,
  estimateLiquidation,
  calculateRiskReward,
  calculatePortfolioRisk,
  calculateExposure,
  detectCorrelatedExposure,
  planTrade,
  summarizeAccount
} from '../public/js/riskManager.js';

let failures = 0;
let assertions = 0;

function ok(name, condition, detail = '') {
  assertions++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
    failures++;
  }
}

/** Compare floats within a tolerance. */
function near(name, actual, expected, tolerance = 0.01) {
  const good = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  ok(name, good, `got ${actual}, expected ~${expected}`);
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

const money = (n) => (Number.isFinite(n) ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'n/a');

/* ======================================================================
 * 1. STOP DISTANCE — including wrong-side stops
 * =================================================================== */
section('1. Stop distance and input validation');

const longStop = calculateStopDistance({ entry: 72000, stop: 69500, direction: 'LONG' });
ok('long stop valid', longStop.valid);
// (72000 - 69500) / 72000 = 0.0347222...
near('long stop distance = 3.472%', longStop.distancePct, 3.4722, 0.001);
near('long risk per unit = 2500', longStop.perUnit, 2500, 0.0001);

const shortStop = calculateStopDistance({ entry: 69500, stop: 72000, direction: 'SHORT' });
ok('short stop valid', shortStop.valid);
near('short stop distance = 3.597%', shortStop.distancePct, 3.5971, 0.001);

// Wrong-side stops must be rejected, not silently absolute-valued.
ok(
  'LONG with stop above entry rejected',
  calculateStopDistance({ entry: 100, stop: 110, direction: 'LONG' }).valid === false
);
ok(
  'SHORT with stop below entry rejected',
  calculateStopDistance({ entry: 100, stop: 90, direction: 'SHORT' }).valid === false
);
ok('stop equal to entry rejected', calculateStopDistance({ entry: 100, stop: 100, direction: 'LONG' }).valid === false);
ok('zero entry rejected', calculateStopDistance({ entry: 0, stop: 90, direction: 'LONG' }).valid === false);
ok('negative stop rejected', calculateStopDistance({ entry: 100, stop: -5, direction: 'LONG' }).valid === false);
ok('missing direction rejected', calculateStopDistance({ entry: 100, stop: 90 }).valid === false);
ok('bad direction rejected', calculateStopDistance({ entry: 100, stop: 90, direction: 'sideways' }).valid === false);
ok('lowercase direction accepted', calculateStopDistance({ entry: 100, stop: 90, direction: 'long' }).valid === true);

/* ======================================================================
 * 2. THE BRIEF'S WORKED EXAMPLE
 * =================================================================== */
section("2. Brief's worked example: $25k wallet, 1%, BTC 72000 -> 69500");

const allowed = calculateAllowedRisk({ walletBalance: 25000, riskPct: 1 });
near('allowed risk = $250', allowed.allowedRisk, 250);

const size = calculatePositionSize({
  allowedRisk: allowed.allowedRisk,
  stopDistance: longStop.distance,
  entry: 72000
});
// 250 / 0.0347222 = 7200 exactly
near('notional = $7,200', size.notional, 7200, 0.5);
near('units = 0.1 BTC', size.units, 0.1, 0.0001);
// The invariant that makes the whole method work.
near('loss at stop equals the risk budget', size.lossAtStop, 250, 0.01);
console.log(`        notional ${money(size.notional)}, units ${size.units.toFixed(6)} BTC, loss at stop ${money(size.lossAtStop)}`);

const margin2x = calculateRequiredMargin({ notional: size.notional, leverage: 2 });
near('margin at 2x = $3,600', margin2x.margin, 3600, 0.5);

/* ======================================================================
 * 3. LEVERAGE DOES NOT CHANGE RISK AT STOP
 * =================================================================== */
section('3. Leverage changes margin, never the loss at the stop');

const leverages = [1, 2, 3, 5, 10, 25];
let riskConstant = true;
let marginFalls = true;
let previousMargin = Infinity;

for (const lev of leverages) {
  const plan = planTrade({
    walletBalance: 25000,
    trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, leverage: lev, riskPct: 1 }
  });
  if (Math.abs(plan.trade.riskAmount - 250) > 0.01) riskConstant = false;
  if (Math.abs(plan.trade.notional - 7200) > 0.5) riskConstant = false;
  if (plan.trade.margin >= previousMargin) marginFalls = false;
  previousMargin = plan.trade.margin;
  console.log(`        ${String(lev).padStart(2)}x  notional ${money(plan.trade.notional)}  margin ${money(plan.trade.margin)}  risk ${money(plan.trade.riskAmount)}`);
}
ok('risk and notional identical across all leverage levels', riskConstant);
ok('margin decreases monotonically as leverage rises', marginFalls);

/* ======================================================================
 * 4. TIGHT AND WIDE STOPS
 * =================================================================== */
section('4. Extremely tight and very wide stops');

const tight = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 71928, riskPct: 1, leverage: 1 }
});
// 0.1% stop -> 250 / 0.001 = 250,000 notional
near('0.1% stop yields $250k notional', tight.trade.notional, 250000, 50);
near('tight stop still risks exactly $250', tight.trade.riskAmount, 250, 0.01);
console.log(`        tight: stop ${tight.trade.stopDistancePct.toFixed(3)}%, notional ${money(tight.trade.notional)}, margin ${money(tight.trade.margin)}`);
// A tight stop demands notional far above the wallet - margin check must catch it.
ok(
  'tight stop trips a policy failure (margin/exposure)',
  tight.status === RISK_STATUS.ABOVE_PLAN,
  `status was ${tight.status}`
);

const wide = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 36000, riskPct: 1, leverage: 1 }
});
// 50% stop -> 250 / 0.5 = 500 notional
near('50% stop yields $500 notional', wide.trade.notional, 500, 0.5);
near('wide stop still risks exactly $250', wide.trade.riskAmount, 250, 0.01);
console.log(`        wide:  stop ${wide.trade.stopDistancePct.toFixed(2)}%, notional ${money(wide.trade.notional)}`);

/* ======================================================================
 * 5. SHORT POSITIONS
 * =================================================================== */
section('5. Short positions');

const shortPlan = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'SHORT', entry: 69500, stop: 72000, target: 62000, riskPct: 1, leverage: 2 }
});
ok('short plan valid', shortPlan.valid);
near('short risks $250', shortPlan.trade.riskAmount, 250, 0.01);
// notional = 250 / 0.0359712 = 6950
near('short notional = $6,950', shortPlan.trade.notional, 6950, 1);
ok('short R:R available', shortPlan.riskReward.available);
// reward 7500 / risk 2500 = 3.0
near('short R:R = 3.0', shortPlan.riskReward.ratio, 3.0, 0.01);
console.log(`        short notional ${money(shortPlan.trade.notional)}, R:R ${shortPlan.riskReward.label}`);

// Short liquidation must sit ABOVE entry; long liquidation BELOW.
const shortLiq = estimateLiquidation({ entry: 69500, direction: 'SHORT', leverage: 5 });
const longLiq = estimateLiquidation({ entry: 72000, direction: 'LONG', leverage: 5 });
ok('short liquidation is above entry', shortLiq.available && shortLiq.price > 69500, `got ${shortLiq.price}`);
ok('long liquidation is below entry', longLiq.available && longLiq.price < 72000, `got ${longLiq.price}`);
// Exact isolated solve (equity = maintenance margin), not the first-order
// approximation this previously asserted:
//   long:  entry * (1 - 1/L) / (1 - mmr) = 72000 * 0.8 / 0.995 = 57,889.45
// The old expectation of 57,960 came from `entry * (1 - (1/L - mmr))`, which
// is conservative for longs but ANTI-conservative for shorts — it reported
// more room than the model implies, by about entry * mmr / L.
near('long liq at 5x ~= 57,889.45 (exact solve)', longLiq.price, 57889.45, 0.5);
near(
  'short liq at 5x ~= 83,052.5 -> exact 82,985.07',
  shortLiq.price,
  (69500 * (1 + 1 / 5)) / (1 + 0.005),
  0.5
);

/* ======================================================================
 * 6. LIQUIDATION EDGE CASES
 * =================================================================== */
section('6. Liquidation availability and stop-vs-liquidation safety');

const noLev = estimateLiquidation({ entry: 72000, direction: 'LONG', leverage: 1 });
ok('1x long reports no liquidation rather than a bogus number', noLev.available === false);
ok('reason given for unavailable liquidation', typeof noLev.reason === 'string' && noLev.reason.length > 0);
ok('liquidation always marked as an estimate', longLiq.isEstimate === true);

// At 25x on a 3.47% stop, liquidation (~3.5% away) sits at/inside the stop.
const dangerous = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1, leverage: 25 }
});
const liqCheck = dangerous.evaluation.checks.find((c) => c.id === 'liquidation');
ok(
  'high leverage flags the liquidation check',
  liqCheck && (liqCheck.state === 'fail' || liqCheck.state === 'warn'),
  `state was ${liqCheck && liqCheck.state}`
);
console.log(`        25x: est. liq ${money(dangerous.liquidation.price)} vs stop ${money(69500)} -> ${liqCheck.state}`);

/* ======================================================================
 * 7. RISK / REWARD
 * =================================================================== */
section('7. Risk / reward');

const rr = calculateRiskReward({ entry: 72000, stop: 69500, target: 80000, direction: 'LONG' });
// 8000 / 2500 = 3.2
near('R:R = 3.2', rr.ratio, 3.2, 0.001);
ok('R:R label formatted', rr.label === '1 : 3.2', `got ${rr.label}`);
ok('missing target reports unavailable', calculateRiskReward({ entry: 72000, stop: 69500, direction: 'LONG' }).available === false);
ok(
  'LONG target below entry rejected',
  calculateRiskReward({ entry: 72000, stop: 69500, target: 70000, direction: 'LONG' }).available === false
);
ok(
  'SHORT target above entry rejected',
  calculateRiskReward({ entry: 69500, stop: 72000, target: 75000, direction: 'SHORT' }).available === false
);

/* ======================================================================
 * 8. PORTFOLIO RISK AND EXPOSURE
 * =================================================================== */
section('8. Portfolio open risk and exposure');

const book = [
  { asset: 'BTC', direction: 'LONG', plannedRisk: 250, margin: 3600, notional: 7200, status: 'OPEN' },
  { asset: 'SOL', direction: 'LONG', plannedRisk: 180, margin: 2400, notional: 6000, status: 'OPEN' },
  { asset: 'ETH', direction: 'SHORT', plannedRisk: 125, margin: 2000, notional: 5800, status: 'OPEN' }
];

const portfolio = calculatePortfolioRisk({ positions: book, walletBalance: 25000 });
near('open risk = $555', portfolio.openRisk, 555, 0.01);
near('open risk = 2.22% of wallet', portfolio.openRiskPct, 2.22, 0.01);
ok('counts 3 positions', portfolio.positionCount === 3);

const exposure = calculateExposure({ positions: book, walletBalance: 25000 });
near('margin used = $8,000', exposure.marginUsed, 8000, 0.01);
near('notional exposure = $19,000', exposure.notionalExposure, 19000, 0.01);
near('available = $17,000', exposure.available, 17000, 0.01);
near('margin utilisation = 32%', exposure.marginUtilizationPct, 32, 0.01);
near('notional exposure = 76% of wallet', exposure.notionalExposurePct, 76, 0.01);
console.log(`        margin ${money(exposure.marginUsed)} (${exposure.marginUtilizationPct}%), notional ${money(exposure.notionalExposure)} (${exposure.notionalExposurePct}%)`);

// CLOSED and CANCELLED trades must not count toward live risk.
const withClosed = [...book, { asset: 'XRP', direction: 'LONG', plannedRisk: 900, margin: 5000, notional: 9000, status: 'CLOSED' }];
near('closed trades excluded from open risk', calculatePortfolioRisk({ positions: withClosed, walletBalance: 25000 }).openRisk, 555, 0.01);
near('closed trades excluded from margin', calculateExposure({ positions: withClosed, walletBalance: 25000 }).marginUsed, 8000, 0.01);

// Empty book
const empty = calculatePortfolioRisk({ positions: [], walletBalance: 25000 });
ok('empty book -> zero open risk', empty.openRisk === 0 && empty.positionCount === 0);

/* ======================================================================
 * 9. THE BRIEF'S PORTFOLIO SCENARIO
 * =================================================================== */
section("9. Brief's scenario: adding a 4th trade to a $555 book");

const added = planTrade({
  walletBalance: 25000,
  positions: book,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1, leverage: 2 }
});
near('open risk before = $555', added.portfolio.before.openRisk, 555, 0.01);
near('open risk after = $805', added.portfolio.after.openRisk, 805, 0.01);
near('open risk after = 3.22%', added.portfolio.after.openRiskPct, 3.22, 0.01);
console.log(`        before ${money(added.portfolio.before.openRisk)} (${added.portfolio.before.openRiskPct.toFixed(2)}%) -> after ${money(added.portfolio.after.openRisk)} (${added.portfolio.after.openRiskPct.toFixed(2)}%)`);

/* ======================================================================
 * 10. CORRELATED EXPOSURE
 * =================================================================== */
section('10. Correlated / concentrated exposure');

const threeLongs = [
  { asset: 'BTC', direction: 'LONG', plannedRisk: 250, status: 'OPEN' },
  { asset: 'ETH', direction: 'LONG', plannedRisk: 180, status: 'OPEN' },
  { asset: 'SOL', direction: 'LONG', plannedRisk: 125, status: 'OPEN' }
];
const conc = detectCorrelatedExposure({ positions: threeLongs });
ok('three longs flagged as concentrated', conc.concentrated === true);
ok('direction reported as LONG', conc.direction === 'LONG');
// The rule counts direction and risk share; it never computes a correlation.
// Claiming "CORRELATED" asserted a measurement that was never made.
ok(
  'label reads DIRECTIONAL LONG CONCENTRATION',
  conc.label === 'DIRECTIONAL LONG CONCENTRATION',
  conc.label
);
ok('lists the assets', Array.isArray(conc.positions) && conc.positions.length === 3);

const mixed = detectCorrelatedExposure({ positions: book }); // 2 long, 1 short
ok('2 long + 1 short not flagged by count rule', mixed.concentrated === false, JSON.stringify(mixed));

// Two heavily-weighted same-direction positions should still trip the share rule.
const twoHeavy = [
  { asset: 'BTC', direction: 'LONG', plannedRisk: 400, status: 'OPEN' },
  { asset: 'ETH', direction: 'LONG', plannedRisk: 400, status: 'OPEN' },
  { asset: 'XRP', direction: 'SHORT', plannedRisk: 50, status: 'OPEN' }
];
ok('two dominant longs flagged by risk-share rule', detectCorrelatedExposure({ positions: twoHeavy }).concentrated === true);

// A two-position book is trivially 100% one-directional, so the share rule
// must not fire there or it becomes constant noise. Magnitude is still covered
// by the correlated heat cap.
const twoOnly = [
  { asset: 'BTC', direction: 'LONG', plannedRisk: 250, margin: 3600, notional: 7200, status: 'OPEN' },
  { asset: 'SOL', direction: 'LONG', plannedRisk: 180, margin: 2400, notional: 6000, status: 'PLANNED' }
];
const twoOnlyResult = detectCorrelatedExposure({ positions: twoOnly });
ok('two-position all-long book not flagged', twoOnlyResult.concentrated === false,
  `share was ${twoOnlyResult.riskSharePct}%`);
near('but dominant direction risk is still reported', twoOnlyResult.directionRisk, 430, 0.01);

// The heat cap still catches two oversized correlated longs (5.2% > 4% cap).
const twoBig = [
  { asset: 'BTC', direction: 'LONG', plannedRisk: 700, margin: 3600, notional: 7200, status: 'OPEN' },
  { asset: 'ETH', direction: 'LONG', plannedRisk: 600, margin: 2400, notional: 6000, status: 'OPEN' }
];
const bigPlan = planTrade({
  walletBalance: 25000,
  positions: twoBig,
  trade: { asset: 'SOL', direction: 'SHORT', entry: 150, stop: 158, riskPct: 0.5, leverage: 1 }
});
ok(
  'oversized correlated longs still fail the heat cap without the share rule',
  bigPlan.evaluation.checks.find((c) => c.id === 'concentration').state === 'fail',
  bigPlan.evaluation.checks.find((c) => c.id === 'concentration').detail
);

/* ======================================================================
 * 11. POLICY BREACHES
 * =================================================================== */
section('11. Policy evaluation');

const overRisk = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 5, leverage: 1 }
});
ok('5% risk exceeds 2% policy -> ABOVE PLAN', overRisk.status === RISK_STATUS.ABOVE_PLAN, overRisk.status);
ok(
  'position-risk check marked fail',
  overRisk.evaluation.checks.find((c) => c.id === 'position-risk').state === 'fail'
);

const overLev = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1, leverage: 10 }
});
ok(
  'leverage 10x exceeds 3x policy',
  overLev.evaluation.checks.find((c) => c.id === 'leverage').state === 'fail'
);

// Portfolio already at 5.5%; a further 1% breaches the 6% heat limit (Elder).
const hotBook = [{ asset: 'ETH', direction: 'SHORT', plannedRisk: 1375, margin: 2000, notional: 4000, status: 'OPEN' }];
const overHeat = planTrade({
  walletBalance: 25000,
  positions: hotBook,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1, leverage: 2 }
});
near('open risk after = 6.5%', overHeat.portfolio.after.openRiskPct, 6.5, 0.01);
ok(
  'portfolio heat breach detected against 6% policy',
  overHeat.evaluation.checks.find((c) => c.id === 'portfolio-risk').state === 'fail'
);
ok('policy heat default is Elder 6%', DEFAULT_RISK_POLICY.maxTotalOpenRiskPct === 6.0);

// Correlated-direction heat cap: 3 longs at 1.5% each = 4.5% one way,
// past the 4% correlated cap even though total heat (4.5%) is under 6%.
const correlatedHeat = [
  { asset: 'BTC', direction: 'LONG', plannedRisk: 375, margin: 1000, notional: 2000, status: 'OPEN' },
  { asset: 'ETH', direction: 'LONG', plannedRisk: 375, margin: 1000, notional: 2000, status: 'OPEN' },
  { asset: 'SOL', direction: 'LONG', plannedRisk: 375, margin: 1000, notional: 2000, status: 'OPEN' }
];
const overCorrelated = planTrade({
  walletBalance: 25000,
  positions: correlatedHeat,
  trade: { asset: 'AVAX', direction: 'LONG', entry: 40, stop: 38, riskPct: 1.5, leverage: 2 }
});
near('total heat still under the 6% cap', overCorrelated.portfolio.after.openRiskPct, 6.0, 0.01);
ok(
  'correlated-direction cap breached even though total heat is not',
  overCorrelated.evaluation.checks.find((c) => c.id === 'concentration').state === 'fail',
  overCorrelated.evaluation.checks.find((c) => c.id === 'concentration').detail
);

// Aggregate notional cap catches the tight-stop case that passes risk checks.
ok('notional exposure cap defaults to 200%', DEFAULT_RISK_POLICY.maxNotionalExposurePct === 200);
const tightNotional = calculateExposure({
  positions: [{ direction: 'LONG', plannedRisk: 250, margin: 250000, notional: 250000, status: 'PLANNED' }],
  walletBalance: 25000
});
ok('1000% notional exposure breaches the cap', tightNotional.exceedsNotionalPolicy === true);
const normalNotional = calculateExposure({ positions: book, walletBalance: 25000 });
ok('76% notional exposure does not breach the cap', normalNotional.exceedsNotionalPolicy === false);

const clean = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, target: 80000, riskPct: 1, leverage: 2 }
});
ok('clean single trade is WITHIN PLAN', clean.status === RISK_STATUS.WITHIN_PLAN, clean.status);
ok('status vocabulary never says SAFE', !JSON.stringify(clean).includes('"SAFE"'));
console.log(`        clean trade: ${clean.evaluation.passed}/${clean.evaluation.total} checks passed, status ${clean.status}`);

/* ======================================================================
 * 12. INVALID INPUT HANDLING
 * =================================================================== */
section('12. Invalid and missing inputs');

const noWallet = planTrade({ trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500 } });
ok('missing wallet -> invalid, INCOMPLETE', noWallet.valid === false && noWallet.status === RISK_STATUS.INCOMPLETE);

const wrongSide = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 69500, stop: 72000, riskPct: 1 }
});
ok('wrong-side stop -> invalid', wrongSide.valid === false);
ok('wrong-side stop explains why', wrongSide.errors.some((e) => /below entry/i.test(e)), JSON.stringify(wrongSide.errors));

const negWallet = planTrade({
  walletBalance: -5000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1 }
});
ok('negative wallet rejected', negWallet.valid === false);

// ABSENT vs INVALID.
//
// This test previously asserted that riskPct: 0 "falls back to the policy
// default 1%" — locking in the hazard. 0, -1, NaN and 'abc' all silently
// produced a fully-sized 1% position with nothing saying a substitution had
// occurred, and risk.html feeds this field from free text, so clearing the box
// sized a real trade. Present-but-invalid is now an error; only genuine
// absence takes the default, and it says so.
const zeroRisk = calculateAllowedRisk({ walletBalance: 25000, riskPct: 0 });
ok('riskPct 0 is rejected, not silently defaulted', zeroRisk.valid === false, JSON.stringify(zeroRisk));

for (const bad of [-1, NaN, 'abc']) {
  const r = calculateAllowedRisk({ walletBalance: 25000, riskPct: bad });
  ok(`riskPct ${JSON.stringify(bad)} is rejected`, r.valid === false, JSON.stringify(r));
}

const absentRisk = calculateAllowedRisk({ walletBalance: 25000, riskPct: undefined });
near('absent riskPct takes the policy default', absentRisk.riskPct, DEFAULT_RISK_POLICY.defaultRiskPerTradePct, 0.0001);
ok('absent riskPct is flagged as defaulted', absentRisk.usedDefaultRisk === true);

ok('missing target does not invalidate the plan', clean.valid === true && planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1, leverage: 2 }
}).riskReward.available === false);

/* ======================================================================
 * 13. SIZE OVERRIDE (the interactive slider path)
 * =================================================================== */
section('13. Position-size override drives risk backwards');

const override = planTrade({
  walletBalance: 25000,
  trade: {
    asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500,
    riskPct: 1, leverage: 2, notionalOverride: 14400 // double the recommended size
  }
});
near('doubled notional doubles dollar risk', override.trade.riskAmount, 500, 0.5);
near('doubled notional doubles risk percent', override.trade.riskPct, 2, 0.01);
near('margin follows notional', override.trade.margin, 7200, 0.5);
console.log(`        override notional ${money(override.trade.notional)} -> risk ${money(override.trade.riskAmount)} (${override.trade.riskPct.toFixed(2)}%)`);

// Halving size must halve risk — the relationship the slider is meant to teach.
const halved = planTrade({
  walletBalance: 25000,
  trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1, leverage: 2, notionalOverride: 3600 }
});
near('halved notional halves dollar risk', halved.trade.riskAmount, 125, 0.5);

/* ======================================================================
 * 14. ACCOUNT SUMMARY
 * =================================================================== */
section('14. Account summary');

const summary = summarizeAccount({ walletBalance: 25000, positions: book });
near('summary open risk', summary.openRisk, 555, 0.01);
near('summary margin used', summary.marginUsed, 8000, 0.01);
near('summary available', summary.available, 17000, 0.01);
ok('summary counts positions', summary.positionCount === 3);
ok('summary has a status', Object.values(RISK_STATUS).includes(summary.status), summary.status);

const noWalletSummary = summarizeAccount({ walletBalance: null, positions: [] });
ok('no wallet -> INCOMPLETE', noWalletSummary.status === RISK_STATUS.INCOMPLETE);

const concentratedSummary = summarizeAccount({ walletBalance: 25000, positions: threeLongs });
ok('three longs -> CAUTION', concentratedSummary.status === RISK_STATUS.CAUTION, concentratedSummary.status);

/* ======================================================================
 * 15. INTERNAL CONSISTENCY SWEEP
 * =================================================================== */
section('15. Invariant sweep across many combinations');

let sweepFailures = 0;
let sweepCount = 0;
for (const wallet of [1000, 25000, 500000]) {
  for (const riskPct of [0.25, 1, 2]) {
    for (const lev of [1, 2, 5]) {
      for (const [entry, stop] of [[72000, 69500], [100, 92], [3.5, 3.1], [69500, 72000]]) {
        const dir = stop < entry ? 'LONG' : 'SHORT';
        const plan = planTrade({
          walletBalance: wallet,
          trade: { asset: 'X', direction: dir, entry, stop, riskPct, leverage: lev }
        });
        sweepCount++;
        if (!plan.valid) { sweepFailures++; continue; }
        const expectedRisk = wallet * (riskPct / 100);
        // Invariant 1: dollar risk always equals wallet x risk%
        if (Math.abs(plan.trade.riskAmount - expectedRisk) > 0.01) sweepFailures++;
        // Invariant 2: notional x stopDistance always equals the risk
        else if (Math.abs(plan.trade.notional * plan.trade.stopDistance - expectedRisk) > 0.01) sweepFailures++;
        // Invariant 3: margin x leverage always reconstructs notional
        else if (Math.abs(plan.trade.margin * lev - plan.trade.notional) > 0.01) sweepFailures++;
      }
    }
  }
}
ok(`all ${sweepCount} combinations hold the three core invariants`, sweepFailures === 0, `${sweepFailures} failed`);

/* ======================================================================
 * 16. REGRESSIONS — defects this harness previously did not cover
 * =================================================================== */
console.log('\n16. Regressions from the production-desk audit');
console.log('-----------------------------------------------');

// H2 — the aggregate notional cap was computed but never evaluated on the
// planned-trade path. A 0.4% stop at 20x sized to 250% of the wallet and
// reported WITHIN PLAN with every check passing.
{
  const loosePolicy = { ...DEFAULT_RISK_POLICY, maxLeverage: 25 };
  const huge = planTrade({
    walletBalance: 25000,
    positions: [],
    policy: loosePolicy,
    trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 71712, riskPct: 1, leverage: 20 }
  });
  const notionalCheck = (huge.evaluation?.checks || []).find((c) => c.id === 'notional-exposure');
  ok('notional-exposure check exists', !!notionalCheck, JSON.stringify(huge.evaluation?.checks?.map(c => c.id)));
  ok('250% notional fails the notional check', notionalCheck && notionalCheck.state === 'fail',
     notionalCheck && notionalCheck.detail);
  ok('250% notional does not report WITHIN PLAN', huge.status !== 'WITHIN PLAN', huge.status);
}

// M1 — cross margin must refuse a per-position liquidation estimate.
{
  const cross = estimateLiquidation({ entry: 72000, direction: 'LONG', leverage: 5, marginMode: 'cross' });
  ok('cross margin returns no liquidation price', cross.available === false && cross.price === undefined);
  ok('cross margin states the account-level reason',
     typeof cross.reason === 'string' && cross.reason.includes('ACCOUNT'), cross.reason);

  const spot = estimateLiquidation({ entry: 72000, direction: 'LONG', leverage: 1, instrument: 'spot' });
  ok('spot is not liquidatable', spot.available === false && spot.notApplicable === true);
}

// M3 — above 1/mmr the position is liquidatable at entry; the old first-order
// form returned a price on the WRONG SIDE of entry (72,288 for a long at 72,000).
{
  const absurd = estimateLiquidation({ entry: 72000, direction: 'LONG', leverage: 1000 });
  ok('1000x returns no liquidation price', absurd.available === false, JSON.stringify(absurd));
  const shortAbsurd = estimateLiquidation({ entry: 69500, direction: 'SHORT', leverage: 1000 });
  ok('1000x short returns no liquidation price', shortAbsurd.available === false);
}

// M4 — a stop a hair from entry must not size to a nine-figure notional.
{
  const hair = planTrade({
    walletBalance: 25000,
    trade: { asset: 'BTC', direction: 'LONG', entry: 100, stop: 100 - 1e-10, riskPct: 1 }
  });
  ok('stop within epsilon of entry is rejected', hair.valid === false, JSON.stringify(hair.errors || hair));
}

// M7 — a clean unleveraged trade should not grade worse than a leveraged one.
{
  const spotClean = planTrade({
    walletBalance: 25000,
    positions: [],
    trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, target: 80000, riskPct: 1, leverage: 1 }
  });
  const liqCheck = (spotClean.evaluation?.checks || []).find((c) => c.id === 'liquidation');
  ok('1x long scores liquidation as pass, not unknown', liqCheck && liqCheck.state === 'pass',
     liqCheck && `${liqCheck.state}: ${liqCheck.detail}`);
  ok('clean 1x trade reads WITHIN PLAN', spotClean.status === 'WITHIN PLAN', spotClean.status);
}

// Leverage must never change the loss at the stop.
{
  const losses = [1, 2, 3, 5, 10, 25].map((lev) => planTrade({
    walletBalance: 25000,
    trade: { asset: 'BTC', direction: 'LONG', entry: 72000, stop: 69500, riskPct: 1, leverage: lev }
  }).trade.lossAtStop);
  const spread = Math.max(...losses) - Math.min(...losses);
  ok('loss at stop is invariant to leverage', spread < 1e-9, `spread ${spread}`);
}

console.log(`\n${'='.repeat(62)}`);
console.log(failures === 0
  ? `All ${assertions} assertions passed.`
  : `${failures} of ${assertions} assertions FAILED.`);
console.log(`${'='.repeat(62)}\n`);

process.exit(failures === 0 ? 0 : 1);
