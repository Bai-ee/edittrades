#!/usr/bin/env node
/**
 * Adaptive Risk Engine — deterministic validation harness
 *
 *   node scripts/validate-adaptive-risk.js
 *
 * Verifies the adaptive layer independently of the UI. Expected values here are
 * computed by hand or by an independent route, not by calling the same function
 * under test.
 *
 * Exit code 0 = all assertions hold.
 */

import { DEFAULT_RISK_POLICY } from '../public/js/riskManager.js';
import {
  STRATEGY_PRESETS,
  LEVELS,
  STRATEGY_VERSION,
  ADAPTIVE_CONSTANTS,
  calculateAdjustedEquity,
  buildEquityCurve,
  calculateDrawdown,
  calculateRecentPerformance,
  calculateRiskLevel,
  calculateLevelProgress,
  calculateOpenRisk,
  calculateDirectionalConcentration,
  calculateStrategyEnvelope,
  calculateConfidenceMultiplier,
  evaluateNoTradeConstraints,
  recommendTrade,
  evaluatePosition,
  analyzeStrategyPerformance
} from '../public/js/adaptiveRisk.js';

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
 * FIXTURE BUILDERS
 *
 * Every fixture is expressed in R and percentages so the same builder can
 * produce a $2k and a $200k account that are identical in every ratio.
 * =================================================================== */

const DAY = 86400000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (days) => new Date(T0 + days * DAY).toISOString();

/**
 * Build a consistent account: a wallet that starts at `wallet`, a sequence of
 * closed trades each risking `riskPct` of the STARTING wallet, and a snapshot
 * after every trade so the equity curve matches the trade record exactly.
 */
function buildAccount({
  wallet = 25000,
  rs = [],
  riskPct = 1,
  dayStep = 1,
  startDay = 0,
  strategy = 'STANDARD',
  level = 0,
  confidence = 50,
  leverage = 2,
  cashFlows = []
} = {}) {
  const risk = wallet * (riskPct / 100);
  const snapshots = [{ at: at(startDay), walletValue: wallet }];
  const trades = [];
  let value = wallet;

  rs.forEach((r, i) => {
    const day = startDay + (i + 1) * dayStep;
    value += r * risk;
    trades.push({
      id: `t${i + 1}`,
      asset: 'BTC',
      direction: 'LONG',
      status: 'CLOSED',
      strategy,
      level,
      confidence,
      leverage,
      riskAmount: risk,
      realizedPnl: r * risk,
      closedAt: at(day),
      openedAt: at(day - dayStep)
    });
    snapshots.push({ at: at(day), walletValue: value });
  });

  return {
    walletValue: value,
    cashFlows,
    snapshots,
    trades,
    openPositions: [],
    dataStale: false,
    walletAvailable: true,
    now: at(startDay + rs.length * dayStep + 1)
  };
}

/** previousLevelState pinning an account at a level with no pending progress. */
function pinLevel(account, level) {
  return {
    level,
    tradesAtLevelChange: account.trades.length,
    since: account.trades.length ? account.trades[account.trades.length - 1].closedAt : at(0),
    indexAtLevelChange: null
  };
}

/* ======================================================================
 * 1. ADJUSTED EQUITY AND CASH FLOWS
 * =================================================================== */
section('1. Adjusted equity — deposits and withdrawals are not performance');

const equityState = calculateAdjustedEquity({
  walletValue: 35000,
  cashFlows: [
    { id: 'c1', type: 'DEPOSIT', amount: 10000, at: at(10) },
    { id: 'c2', type: 'WITHDRAWAL', amount: 2000, at: at(20) }
  ]
});
near('adjusted equity IS wallet value', equityState.adjustedEquity, 35000, 0.001);
near('deposits summed', equityState.deposits, 10000, 0.001);
near('withdrawals summed', equityState.withdrawals, 2000, 0.001);
near('net contributed', equityState.netContributed, 8000, 0.001);
ok('missing wallet marked invalid', calculateAdjustedEquity({ walletValue: null }).valid === false);

// A $10,000 wallet receiving a $10,000 deposit and ending at $20,000 has made
// exactly nothing. This is the single property the level system rests on.
const depositCurve = buildEquityCurve({
  snapshots: [
    { at: at(0), walletValue: 10000 },
    { at: at(10), walletValue: 20000 }
  ],
  cashFlows: [{ id: 'd1', type: 'DEPOSIT', amount: 10000, at: at(5) }]
});
near('deposit registers as ZERO growth', depositCurve.totalGrowthPct, 0, 0.0001);
near('deposit leaves the index at 1.0', depositCurve.index, 1, 0.0001);
ok('the deposit was actually applied', depositCurve.flowsApplied === 1);

// A withdrawal must not read as a loss.
const withdrawalCurve = buildEquityCurve({
  snapshots: [
    { at: at(0), walletValue: 20000 },
    { at: at(10), walletValue: 15000 }
  ],
  cashFlows: [{ id: 'w1', type: 'WITHDRAWAL', amount: 5000, at: at(5) }]
});
near('withdrawal registers as ZERO loss', withdrawalCurve.totalGrowthPct, 0, 0.0001);
near('withdrawal drawdown is zero', calculateDrawdown({ equityCurve: withdrawalCurve }).currentDrawdownPct, 0, 0.0001);

// Real growth alongside a deposit: 10k -> (deposit 10k) -> 22k is +10% on the
// 20k baseline, not +120%.
const mixedCurve = buildEquityCurve({
  snapshots: [
    { at: at(0), walletValue: 10000 },
    { at: at(10), walletValue: 22000 }
  ],
  cashFlows: [{ id: 'd2', type: 'DEPOSIT', amount: 10000, at: at(5) }]
});
// (22000 - 10000 - 10000) / 10000 = 0.20 on the pre-flow base.
near('growth alongside a deposit measured on the pre-flow base', mixedCurve.totalGrowthPct, 20, 0.0001);

// Unclassified movement counts as performance — the documented default rule.
const unclassified = buildEquityCurve({
  snapshots: [
    { at: at(0), walletValue: 10000 },
    { at: at(10), walletValue: 11000 }
  ],
  cashFlows: []
});
near('unclassified change counts as performance', unclassified.totalGrowthPct, 10, 0.0001);

/* ======================================================================
 * 2. EQUITY CURVE AND DRAWDOWN
 * =================================================================== */
section('2. Equity curve chaining and drawdown');

const curve = buildEquityCurve({
  snapshots: [
    { at: at(0), walletValue: 10000 },
    { at: at(1), walletValue: 11000 }, // +10%
    { at: at(2), walletValue: 12100 }, // +10%
    { at: at(3), walletValue: 9680 } //  -20%
  ],
  cashFlows: []
});
// 1.0 * 1.1 * 1.1 * 0.8 = 0.968
near('growths chain multiplicatively', curve.index, 0.968, 0.0001);
near('total growth = -3.2%', curve.totalGrowthPct, -3.2, 0.0001);

const dd = calculateDrawdown({ equityCurve: curve });
// peak index 1.21, current 0.968 -> (1.21 - 0.968) / 1.21 = 20%
near('current drawdown = 20%', dd.currentDrawdownPct, 20, 0.0001);
near('max drawdown = 20%', dd.maxDrawdownPct, 20, 0.0001);
ok('peakAt reported', dd.peakAt === Date.parse(at(2)), `got ${dd.peakAt}`);
ok('alias fields carry the same percent numbers', dd.currentDrawdown === dd.currentDrawdownPct && dd.maxDrawdown === dd.maxDrawdownPct);
ok('drawdown on an empty curve is zero, not NaN', calculateDrawdown({ equityCurve: null }).currentDrawdownPct === 0);
console.log(`        index ${curve.index.toFixed(4)}, peak ${dd.peak.toFixed(4)}, drawdown ${dd.currentDrawdownPct.toFixed(2)}%`);

// A recovery past the old peak resets the drawdown to zero but not maxDrawdown.
const recovered = calculateDrawdown({
  equityCurve: buildEquityCurve({
    snapshots: [
      { at: at(0), walletValue: 10000 },
      { at: at(1), walletValue: 8000 },
      { at: at(2), walletValue: 12000 }
    ],
    cashFlows: []
  })
});
near('recovery clears current drawdown', recovered.currentDrawdownPct, 0, 0.0001);
near('but max drawdown is remembered', recovered.maxDrawdownPct, 20, 0.0001);

/* ======================================================================
 * 3. RECENT PERFORMANCE
 * =================================================================== */
section('3. Recent performance over the last N closed trades');

const perfAccount = buildAccount({ rs: [1, -1, 1, 1, -1, 1, 1, -1, 1, 1, -1, 1] });
const perf = calculateRecentPerformance({ trades: perfAccount.trades, window: 10 });
ok('window respects N=10 out of 12 closed trades', perf.count === 10, `got ${perf.count}`);
ok('total closed still reported', perf.totalClosed === 12);
// last 10 of [1,-1,1,1,-1,1,1,-1,1,1,-1,1] = [1,1,-1,1,1,-1,1,1,-1,1] -> 7 wins, 3 losses
ok('wins counted', perf.wins === 7, `got ${perf.wins}`);
ok('losses counted', perf.losses === 3, `got ${perf.losses}`);
near('win rate = 70%', perf.winRate, 70, 0.0001);
near('net R = +4R -> netRPct 400', perf.netRPct, 400, 0.0001);
near('average R = +0.4R -> avgRPct 40', perf.avgRPct, 40, 0.0001);
near('expectancy = 0.4R', perf.expectancy, 0.4, 0.0001);
ok('trailing streak = +1', perf.streak === 1, `got ${perf.streak}`);
near('consistency = 100% (every trade inside [-1R, +2R])', perf.consistency, 100, 0.0001);
ok('sample marked sufficient', perf.sufficient === true);

const thin = calculateRecentPerformance({ trades: buildAccount({ rs: [3, 3, 3] }).trades, window: 10 });
ok('fewer than 5 trades marked insufficient', thin.sufficient === false && thin.neutral === true);
console.log(`        3 winning trades -> sufficient=${thin.sufficient} (must be treated as NEUTRAL, never positive)`);

const outlier = calculateRecentPerformance({ trades: buildAccount({ rs: [50, -1, -1, -1, -1] }).trades });
near('a +50R trade is winsorised to +2R for progression', outlier.winsorisedNetR, -2, 0.0001);
near('raw net R is still reported honestly', outlier.netR, 46, 0.0001);
near('the outlier drops consistency to 80%', outlier.consistency, 80, 0.0001);

const streaky = calculateRecentPerformance({ trades: buildAccount({ rs: [1, 1, -1, -1, -1, -1] }).trades });
ok('losing streak reported as -4', streaky.streak === -4, `got ${streaky.streak}`);

/* ======================================================================
 * 4. TRADE CORRECTIONS RECALCULATE HISTORY
 * =================================================================== */
section('4. Correcting a trade re-derives the whole history');

const beforeCorrection = buildAccount({ rs: [1, 1, 1, 1, 1, 1, 1, 1] });
const afterCorrection = buildAccount({ rs: [1, 1, 1, 1, 1, 1, 1, -3] });
const perfBefore = calculateRecentPerformance({ trades: beforeCorrection.trades });
const perfAfter = calculateRecentPerformance({ trades: afterCorrection.trades });
ok('win rate recalculated after a correction', perfBefore.winRate === 100 && perfAfter.winRate === 87.5,
  `${perfBefore.winRate} -> ${perfAfter.winRate}`);
ok('consistency recalculated (the -3R falls outside the band)', perfAfter.consistency === 87.5, `got ${perfAfter.consistency}`);
const ddBefore = calculateDrawdown({ equityCurve: buildEquityCurve(beforeCorrection) });
const ddAfter = calculateDrawdown({ equityCurve: buildEquityCurve(afterCorrection) });
ok('drawdown recalculated after a correction', ddBefore.currentDrawdownPct === 0 && ddAfter.currentDrawdownPct > 0,
  `${ddBefore.currentDrawdownPct} -> ${ddAfter.currentDrawdownPct}`);
console.log(`        correction turned a 0% drawdown into ${ddAfter.currentDrawdownPct.toFixed(2)}%`);

/* ======================================================================
 * 5. RISK LEVEL — SLOW UP
 * =================================================================== */
section('5. Level up is slow, earned, and capped at one level per evaluation');

const evaluate = (account, previousLevelState) =>
  calculateRiskLevel({
    adjustedEquity: account.walletValue,
    equityCurve: buildEquityCurve(account),
    trades: account.trades,
    openPositions: account.openPositions || [],
    previousLevelState,
    now: account.now
  });

ok('a brand-new account with no trades is level 0', evaluate(buildAccount({ rs: [] }), null).level === 0);
ok('level 0 is the documented starting baseline', LEVELS.find((l) => l.level === 0).key === 'BASELINE');

// LEVEL_UP_TRADES['1'] = 8. Seven qualifying trades must not be enough.
const winSeq = [1, -1, 1, 1, -1, 1, 1, -1];
const sevenTrades = evaluate(buildAccount({ rs: winSeq.slice(0, 7) }), { level: 0, tradesAtLevelChange: 0 });
ok('7 qualifying trades do NOT advance the level', sevenTrades.level === 0, `got ${sevenTrades.level}`);
ok('the trade-count gate is what blocks it', sevenTrades.progress.blockedBy.includes('TRADES_SINCE_LEVEL'));

const eightTrades = evaluate(buildAccount({ rs: winSeq }), { level: 0, tradesAtLevelChange: 0 });
ok('the 8th qualifying trade advances to level 1', eightTrades.level === 1, `got ${eightTrades.level}`);
ok('promotion recorded as a transition', eightTrades.transitions.some((t) => t.type === 'PROMOTION'));
ok('promotion resets the trade counter', eightTrades.tradesSinceLevelChange === 0);
console.log(`        7 trades -> level ${sevenTrades.level} (${sevenTrades.progressPct.toFixed(0)}% progress), 8 trades -> level ${eightTrades.level}`);

// Never more than one level in a single evaluation, however good the record.
const stellar = evaluate(buildAccount({ rs: Array(40).fill(2) }), { level: 0, tradesAtLevelChange: 0 });
ok('40 perfect trades still advance only ONE level', stellar.level === 1, `got ${stellar.level}`);

// Requirements grow with the level.
ok('trade requirement grows with level',
  ADAPTIVE_CONSTANTS.LEVEL_UP_TRADES['1'] < ADAPTIVE_CONSTANTS.LEVEL_UP_TRADES['3'] &&
  ADAPTIVE_CONSTANTS.LEVEL_UP_TRADES['3'] < ADAPTIVE_CONSTANTS.LEVEL_UP_TRADES['5']);
ok('drawdown ceiling for promotion tightens with level',
  ADAPTIVE_CONSTANTS.LEVEL_UP_MAX_DRAWDOWN_PCT['1'] > ADAPTIVE_CONSTANTS.LEVEL_UP_MAX_DRAWDOWN_PCT['5']);

/* ======================================================================
 * 6. ONE HUGE WINNER DOES NOT BUY A LEVEL
 * =================================================================== */
section('6. A single outsized winner cannot leap levels');

const oneBigWin = evaluate(buildAccount({ rs: [50] }), { level: 0, tradesAtLevelChange: 0 });
ok('a single +50R trade leaves the account at level 0', oneBigWin.level === 0, `got ${oneBigWin.level}`);
ok('progress stays low after one huge win', oneBigWin.progressPct < 20, `got ${oneBigWin.progressPct}`);
console.log(`        one +50R trade -> level ${oneBigWin.level}, progress ${oneBigWin.progressPct.toFixed(1)}%`);

// Even with the trade count satisfied, a book carried by one outlier fails the
// winsorised-average and win-rate gates.
const outlierCarried = evaluate(
  buildAccount({ rs: [50, -1, -1, -1, -1, -1, -1, -1] }),
  { level: 0, tradesAtLevelChange: 0 }
);
ok('8 trades carried by one +50R outlier do not promote', outlierCarried.level <= 0, `got ${outlierCarried.level}`);
ok('the winsorised-growth gate blocks it', outlierCarried.progress.blockedBy.includes('POSITIVE_GROWTH'));
ok('the win-rate floor blocks it too', outlierCarried.progress.blockedBy.includes('WIN_RATE_FLOOR'));

// The winsorisation cap itself.
ok('per-trade contribution capped at +2R', ADAPTIVE_CONSTANTS.WINSOR_R_CAP === 2);
const winsorCheck = calculateRecentPerformance({ trades: buildAccount({ rs: [50, 50, 50, 50, 50] }).trades });
near('five +50R trades contribute only +10R to progression', winsorCheck.winsorisedNetR, 10, 0.0001);

/* ======================================================================
 * 7. CONSISTENT RESULTS ADVANCE PROGRESS MONOTONICALLY
 * =================================================================== */
section('7. Progress within a level is monotonic and bounded 0..100');

let previousProgress = -1;
let progressMonotonic = true;
let progressBounded = true;
for (let n = 1; n <= 7; n++) {
  const state = evaluate(buildAccount({ rs: Array(n).fill(1) }), { level: 0, tradesAtLevelChange: 0 });
  if (state.progressPct < previousProgress - 1e-9) progressMonotonic = false;
  if (state.progressPct < 0 || state.progressPct > 100) progressBounded = false;
  previousProgress = state.progressPct;
}
ok('progress never decreases as consistent wins accumulate', progressMonotonic);
ok('progress stays within 0..100', progressBounded);

const halfway = evaluate(buildAccount({ rs: [1, 1, 1, 1] }), { level: 0, tradesAtLevelChange: 0 });
near('4 of 8 required trades = 50% of the trade component', halfway.progress.components.trades, 0.5, 0.0001);
ok('tradesToNext counts down', halfway.tradesToNext === 4, `got ${halfway.tradesToNext}`);

/* ======================================================================
 * 8. FAST DOWN
 * =================================================================== */
section('8. Level down is immediate and can drop more than one level');

// Drawdown alone, with no losing streak at the close: 12 wins to a peak, one
// large loss, then a win. Drawdown ~14.5% caps the level at 1.
const crashAccount = buildAccount({ riskPct: 2, rs: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -10, 1] });
const crashed = evaluate(crashAccount, { level: 5, tradesAtLevelChange: 12 });
ok('drawdown demotes several levels in one evaluation', crashed.level <= 1, `got level ${crashed.level}`);
ok('the drop is more than one level', 5 - crashed.level > 1, `dropped ${5 - crashed.level}`);
ok('demotion recorded with a reason', crashed.transitions.some((t) => t.type === 'DEMOTION' && t.reason.length > 0));
console.log(`        drawdown ${crashed.currentDrawdownPct.toFixed(2)}% took level 5 -> ${crashed.level} in one evaluation`);

// Losing streaks demote on their own.
const streakAccount = buildAccount({ rs: [1, 1, 1, 1, 1, 1, -1, -1, -1] });
const streakDemoted = evaluate(streakAccount, { level: 3, tradesAtLevelChange: 9 });
ok('a 3-trade losing streak demotes one level', streakDemoted.level === 2, `got ${streakDemoted.level}`);
const longStreak = evaluate(buildAccount({ rs: [1, 1, 1, 1, 1, -1, -1, -1, -1, -1] }), { level: 3, tradesAtLevelChange: 10 });
ok('a 5-trade losing streak demotes two levels', longStreak.level === 1, `got ${longStreak.level}`);

// Severe drawdown reaches the defensive floor.
const severe = buildAccount({ riskPct: 2, rs: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -20, 1] });
const severeState = evaluate(severe, { level: 4, tradesAtLevelChange: 12 });
ok('a severe drawdown reaches a negative level', severeState.level < 0, `got ${severeState.level}`);
console.log(`        drawdown ${severeState.currentDrawdownPct.toFixed(2)}% -> level ${severeState.level}`);

// Open-risk pressure demotes even with a clean record.
const pressured = calculateRiskLevel({
  adjustedEquity: 25000,
  equityCurve: buildEquityCurve(buildAccount({ rs: [1, 1, 1, 1, 1, 1] })),
  trades: buildAccount({ rs: [1, 1, 1, 1, 1, 1] }).trades,
  openPositions: [
    { id: 'p1', asset: 'BTC', direction: 'LONG', notional: 20000, entry: 100, stop: 85, unrealizedPnl: 0 }
  ],
  previousLevelState: { level: 3, tradesAtLevelChange: 6 },
  now: at(20)
});
ok('open-risk pressure demotes', pressured.level < 3, `got ${pressured.level}`);
ok('the reason is reported', pressured.transitions.some((t) => t.code === 'OPEN_RISK_PRESSURE'));

/* ======================================================================
 * 9. LEVEL 5 CAP AND NEGATIVE LEVELS
 * =================================================================== */
section('9. Level 5 is the cap; -1 and -2 are defensive');

const atCap = evaluate(buildAccount({ rs: Array(30).fill(0).map((_, i) => (i % 4 === 3 ? -1 : 1)) }), {
  level: 5,
  tradesAtLevelChange: 0
});
ok('a qualifying level-5 account stays at 5', atCap.level === 5, `got ${atCap.level}`);
ok('level 5 reports 100% progress', atCap.progressPct === 100);
ok('level 5 has no next level', atCap.nextLevel === null && atCap.tradesToNext === null);

const cap5 = calculateStrategyEnvelope({ level: 5, strategy: 'STANDARD' });
const cap4 = calculateStrategyEnvelope({ level: 4, strategy: 'STANDARD' });
ok('level 5 percentage envelope is the widest STANDARD offers', cap5.maxRiskPct > cap4.maxRiskPct);
near('level 5 STANDARD ceiling is 3.00%', cap5.maxRiskPct, 3.0, 0.0001);
// Dollar sizes still grow with the wallet even though the percentage does not.
const cap5Small = 10000 * (cap5.maxRiskPct / 100);
const cap5Large = 1000000 * (cap5.maxRiskPct / 100);
ok('at the cap, dollar risk still scales with the wallet', cap5Large === cap5Small * 100);

const defensive1 = calculateStrategyEnvelope({ level: -1, strategy: 'STANDARD' });
const defensive2 = calculateStrategyEnvelope({ level: -2, strategy: 'STANDARD' });
const baseline = calculateStrategyEnvelope({ level: 0, strategy: 'STANDARD' });
ok('level -1 cuts the risk band', defensive1.maxRiskPct < baseline.maxRiskPct);
ok('level -1 cuts the leverage cap', defensive1.maxLeverage < baseline.maxLeverage);
ok('level -2 is tighter still', defensive2.maxRiskPct < defensive1.maxRiskPct && defensive2.maxLeverage <= defensive1.maxLeverage);
ok('level -2 permits a single position', defensive2.maxOpenPositions === 1);
console.log(`        -2: ${defensive2.maxRiskPct}% / ${defensive2.maxLeverage}x   -1: ${defensive1.maxRiskPct}% / ${defensive1.maxLeverage}x   0: ${baseline.maxRiskPct}% / ${baseline.maxLeverage}x   5: ${cap5.maxRiskPct}% / ${cap5.maxLeverage}x`);

// Level -2 under drawdown blocks new trades outright.
const lockdown = evaluateNoTradeConstraints({
  envelope: defensive2,
  openRiskState: calculateOpenRisk({ openPositions: [], adjustedEquity: 25000 }),
  concentration: calculateDirectionalConcentration({ openPositions: [] }),
  adjustedEquity: 25000,
  drawdown: { currentDrawdownPct: 21 },
  level: -2
});
ok('level -2 with a 21% drawdown blocks new trades', lockdown.allowed === false);
ok('the lockdown blocker is explicit', lockdown.blockers.some((b) => b.code === 'LOCKDOWN'));

/* ======================================================================
 * 10. INACTIVITY NEVER DEMOTES
 * =================================================================== */
section('10. Inactivity preserves the earned level');

const dormantAccount = buildAccount({ rs: winSeq });
dormantAccount.now = at(400); // ~13 months after the last close
const dormant = evaluate(dormantAccount, { level: 3, tradesAtLevelChange: 8 });
ok('a long gap does NOT demote', dormant.level === 3, `got ${dormant.level}`);
ok('staleRecentData is set', dormant.staleRecentData === true);
ok('no demotion transition was recorded', dormant.transitions.every((t) => t.type !== 'DEMOTION'));
ok('promotion is paused while stale', dormant.progress.blockedBy.includes('ACTIVE'));

const dormantEnvelope = calculateStrategyEnvelope({
  level: 3,
  strategy: 'STANDARD',
  recentPerformance: calculateRecentPerformance({ trades: dormantAccount.trades, now: dormantAccount.now }),
  drawdown: calculateDrawdown({ equityCurve: buildEquityCurve(dormantAccount) })
});
const activeEnvelope = calculateStrategyEnvelope({
  level: 3,
  strategy: 'STANDARD',
  recentPerformance: calculateRecentPerformance({ trades: dormantAccount.trades, now: at(10) }),
  drawdown: calculateDrawdown({ equityCurve: buildEquityCurve(dormantAccount) })
});
near('returning traders take a 0.75x haircut', dormantEnvelope.baseRiskPct / activeEnvelope.baseRiskPct, 0.75, 0.0001);
ok('the haircut is labelled, not silent', dormantEnvelope.haircut.returningApplied === true);

// The haircut persists for the first few trades after the gap, then lifts.
const gapHistory = [
  ...buildAccount({ rs: [1, -1, 1, 1, -1, 1] }).trades,
  ...buildAccount({ rs: [1], startDay: 200 }).trades.map((t) => ({ ...t, id: 'r1' }))
];
const justBack = calculateRecentPerformance({ trades: gapHistory, now: at(202) });
ok('one trade after a 194-day gap is still "returning"', justBack.stale === false && justBack.returning === true);
ok('and the gap itself was detected', justBack.inactivity.gapFound === true && justBack.inactivity.tradesSinceReturn === 1);

const freshAccountPerf = calculateRecentPerformance({ trades: buildAccount({ rs: [1, 1] }).trades, now: at(3) });
ok('a brand-new account is NOT treated as returning from a break',
  freshAccountPerf.returning === false && freshAccountPerf.stale === false);
near('so STANDARD level 0 still equals the base policy 1%',
  calculateStrategyEnvelope({ level: 0, strategy: 'STANDARD', recentPerformance: freshAccountPerf }).baseRiskPct,
  DEFAULT_RISK_POLICY.defaultRiskPerTradePct, 1e-9);
console.log(`        dormant level ${dormant.level} preserved; base risk ${activeEnvelope.baseRiskPct.toFixed(3)}% -> ${dormantEnvelope.baseRiskPct.toFixed(3)}%`);

/* ======================================================================
 * 11. SCALE INVARIANCE
 * =================================================================== */
section('11. $2k, $20k and $200k progress identically');

const scaleSeq = [1, -1, 1, 1, -1, 1, 1, -1, 1, 1];
const scaled = [2000, 20000, 200000].map((wallet) => {
  const account = buildAccount({ wallet, rs: scaleSeq });
  const state = evaluate(account, { level: 0, tradesAtLevelChange: 0 });
  const recommendation = recommendTrade({
    account: { ...account, previousLevelState: { level: 0, tradesAtLevelChange: 0 } },
    request: { asset: 'BTC', strategy: 'STANDARD', confidence: 60, entry: 72000, stop: 69500 }
  });
  return { wallet, state, recommendation };
});

ok('all three wallets reach the same level',
  scaled[0].state.level === scaled[1].state.level && scaled[1].state.level === scaled[2].state.level,
  scaled.map((s) => `${s.wallet}:${s.state.level}`).join(' '));
ok('all three wallets show identical progress',
  Math.abs(scaled[0].state.progressPct - scaled[1].state.progressPct) < 1e-9 &&
  Math.abs(scaled[1].state.progressPct - scaled[2].state.progressPct) < 1e-9,
  scaled.map((s) => `${s.wallet}:${s.state.progressPct}`).join(' '));
ok('all three wallets show identical drawdown',
  Math.abs(scaled[0].state.currentDrawdownPct - scaled[2].state.currentDrawdownPct) < 1e-9);
ok('all three recommend the same risk PERCENTAGE',
  Math.abs(scaled[0].recommendation.maxLoss.pct - scaled[2].recommendation.maxLoss.pct) < 1e-9,
  scaled.map((s) => `${s.wallet}:${s.recommendation.maxLoss.pct}`).join(' '));
// Notional scales exactly 100x between the $2k and $200k wallets.
near('dollar sizes scale exactly with the wallet',
  scaled[2].recommendation.position.notional / scaled[0].recommendation.position.notional, 100, 1e-6);
console.log(`        level ${scaled[0].state.level}, progress ${scaled[0].state.progressPct.toFixed(2)}%, risk ${scaled[0].recommendation.maxLoss.pct.toFixed(4)}% at every wallet size`);
console.log(`        notionals: ${scaled.map((s) => money(s.recommendation.position.notional)).join('  ')}`);

/* ======================================================================
 * 12. STRATEGY PRESETS
 * =================================================================== */
section('12. STANDARD anchors to DEFAULT_RISK_POLICY; AGGRESSIVE permits more');

const std0 = STRATEGY_PRESETS.STANDARD.levels['0'];
near('STANDARD level 0 base risk == policy default 1%', std0.baseRiskPct, DEFAULT_RISK_POLICY.defaultRiskPerTradePct, 1e-9);
near('STANDARD level 0 max risk == policy max 2%', std0.maxRiskPct, DEFAULT_RISK_POLICY.maxRiskPerTradePct, 1e-9);
near('STANDARD level 0 heat == Elder 6%', std0.maxPortfolioHeatPct, DEFAULT_RISK_POLICY.maxTotalOpenRiskPct, 1e-9);
near('STANDARD level 0 leverage == policy 3x', std0.maxLeverage, DEFAULT_RISK_POLICY.maxLeverage, 1e-9);
near('STANDARD level 0 notional == policy 200%', std0.maxNotionalExposurePct, DEFAULT_RISK_POLICY.maxNotionalExposurePct, 1e-9);
near('STANDARD level 0 directional == policy 4%', std0.maxDirectionalRiskPct, DEFAULT_RISK_POLICY.maxCorrelatedDirectionRiskPct, 1e-9);
near('STANDARD level 0 margin utilisation == policy 30%', std0.maxMarginUtilizationPct, DEFAULT_RISK_POLICY.maxMarginUtilizationPct, 1e-9);

const agg0 = STRATEGY_PRESETS.AGGRESSIVE.levels['0'];
ok('AGGRESSIVE permits more risk at every level',
  Object.keys(STRATEGY_PRESETS.STANDARD.levels).every(
    (k) => STRATEGY_PRESETS.AGGRESSIVE.levels[k].maxRiskPct > STRATEGY_PRESETS.STANDARD.levels[k].maxRiskPct
  ));
ok('AGGRESSIVE permits at least as much leverage at every level',
  Object.keys(STRATEGY_PRESETS.STANDARD.levels).every(
    (k) => STRATEGY_PRESETS.AGGRESSIVE.levels[k].maxLeverage >= STRATEGY_PRESETS.STANDARD.levels[k].maxLeverage
  ));
ok('AGGRESSIVE heat is clamped at the 12% Turtle ceiling',
  Object.values(STRATEGY_PRESETS.AGGRESSIVE.levels).every((l) => l.maxPortfolioHeatPct <= 12));
ok('STANDARD reacts to a bad run more strongly than AGGRESSIVE',
  STRATEGY_PRESETS.STANDARD.recentPerformanceSensitivity > STRATEGY_PRESETS.AGGRESSIVE.recentPerformanceSensitivity);
ok('STANDARD keeps the top of the band out of the slider\'s reach',
  STRATEGY_PRESETS.STANDARD.confidenceRange.max < STRATEGY_PRESETS.AGGRESSIVE.confidenceRange.max);

// Envelopes widen monotonically from -2 to 5 in both presets.
for (const key of ['STANDARD', 'AGGRESSIVE']) {
  const rows = [-2, -1, 0, 1, 2, 3, 4, 5].map((l) => STRATEGY_PRESETS[key].levels[String(l)]);
  ok(`${key} risk band widens monotonically -2 -> 5`,
    rows.every((row, i) => i === 0 || row.maxRiskPct >= rows[i - 1].maxRiskPct));
  ok(`${key} heat widens monotonically -2 -> 5`,
    rows.every((row, i) => i === 0 || row.maxPortfolioHeatPct >= rows[i - 1].maxPortfolioHeatPct));
  ok(`${key} min < base < max at every level`,
    rows.every((row) => row.minRiskPct < row.baseRiskPct && row.baseRiskPct < row.maxRiskPct));
}

// A losing run is cut harder under STANDARD than under AGGRESSIVE.
const badRun = calculateRecentPerformance({ trades: buildAccount({ rs: [1, 1, -1, -1, -1, -1] }).trades });
const stdCut = calculateStrategyEnvelope({ level: 0, strategy: 'STANDARD', recentPerformance: badRun });
const aggCut = calculateStrategyEnvelope({ level: 0, strategy: 'AGGRESSIVE', recentPerformance: badRun });
ok('a bad run cuts the STANDARD band harder', stdCut.haircut.performance < aggCut.haircut.performance,
  `${stdCut.haircut.performance} vs ${aggCut.haircut.performance}`);
console.log(`        bad run haircut: STANDARD x${stdCut.haircut.performance.toFixed(3)}, AGGRESSIVE x${aggCut.haircut.performance.toFixed(3)}`);

// Good results never widen the envelope directly.
const goodRun = calculateRecentPerformance({ trades: buildAccount({ rs: [2, 2, 2, 2, 2, 2] }).trades });
const goodEnvelope = calculateStrategyEnvelope({ level: 0, strategy: 'STANDARD', recentPerformance: goodRun });
near('a winning run never widens the envelope', goodEnvelope.maxRiskPct, std0.maxRiskPct, 1e-9);
const thinGood = calculateRecentPerformance({ trades: buildAccount({ rs: [3, 3, 3] }).trades });
const thinEnvelope = calculateStrategyEnvelope({ level: 0, strategy: 'STANDARD', recentPerformance: thinGood });
near('an insufficient sample is neutral, not positive', thinEnvelope.maxRiskPct, std0.maxRiskPct, 1e-9);

/* ======================================================================
 * 13. CONFIDENCE
 * =================================================================== */
section('13. Confidence moves risk inside the envelope and nowhere else');

const env0 = calculateStrategyEnvelope({ level: 0, strategy: 'STANDARD' });
const c0 = calculateConfidenceMultiplier({ confidence: 0, strategy: 'STANDARD', envelope: env0 });
const c50 = calculateConfidenceMultiplier({ confidence: 50, strategy: 'STANDARD', envelope: env0 });
const c100 = calculateConfidenceMultiplier({ confidence: 100, strategy: 'STANDARD', envelope: env0 });
near('confidence 0 maps to the envelope minimum (0.5%)', c0.riskPct, 0.5, 1e-9);
near('confidence 50 maps exactly to the base (1.0%)', c50.riskPct, 1.0, 1e-9);
near('confidence 100 under STANDARD is clamped to 1.8%, not 2%', c100.riskPct, 1.8, 1e-9);
ok('the clamp is reported', c100.clampedByStrategy === true && c100.clampedConfidence === 90);
ok('confidence never exceeds the envelope maximum', c100.riskPct <= env0.maxRiskPct);
near('the multiplier is relative to base', c100.multiplier, 1.8, 1e-9);

const envAgg = calculateStrategyEnvelope({ level: 0, strategy: 'AGGRESSIVE' });
near('confidence 100 under AGGRESSIVE reaches its 3% ceiling',
  calculateConfidenceMultiplier({ confidence: 100, strategy: 'AGGRESSIVE', envelope: envAgg }).riskPct, 3.0, 1e-9);

// Monotonic across the whole slider.
let confidenceMonotonic = true;
let lastRisk = -1;
for (let c = 0; c <= 100; c += 5) {
  const r = calculateConfidenceMultiplier({ confidence: c, strategy: 'STANDARD', envelope: env0 }).riskPct;
  if (r < lastRisk - 1e-12) confidenceMonotonic = false;
  lastRisk = r;
}
ok('risk is non-decreasing across the slider', confidenceMonotonic);

// Out-of-range and rubbish input.
ok('confidence above 100 is clamped', calculateConfidenceMultiplier({ confidence: 500, strategy: 'STANDARD', envelope: env0 }).riskPct <= env0.maxRiskPct);
ok('negative confidence is clamped to the minimum', calculateConfidenceMultiplier({ confidence: -50, strategy: 'STANDARD', envelope: env0 }).riskPct === env0.minRiskPct);
near('missing confidence falls back to neutral', calculateConfidenceMultiplier({ strategy: 'STANDARD', envelope: env0 }).riskPct, env0.baseRiskPct, 1e-9);

// Confidence cannot widen a haircut envelope back out.
const cutEnvelope = calculateStrategyEnvelope({ level: 0, strategy: 'STANDARD', recentPerformance: badRun });
ok('confidence 100 on a haircut envelope stays inside the haircut band',
  calculateConfidenceMultiplier({ confidence: 100, strategy: 'STANDARD', envelope: cutEnvelope }).riskPct <= cutEnvelope.maxRiskPct);
ok('and that band is below the untouched band',
  cutEnvelope.maxRiskPct < env0.maxRiskPct);

/* ======================================================================
 * 14. SIZING
 * =================================================================== */
section('14. Sizing: technical stop, derived stop, caps, and no-trade');

const cleanAccount = {
  walletValue: 25000,
  cashFlows: [],
  snapshots: [{ at: at(0), walletValue: 25000 }],
  trades: [],
  openPositions: [],
  dataStale: false,
  walletAvailable: true,
  now: at(1)
};

// The base engine's worked example must reproduce exactly at level 0 / conf 50.
const normal = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 69500 }
});
ok('decision is TRADE', normal.decision === 'TRADE', normal.blockers.map((b) => b.code).join(','));
near('risk = 1% of equity', normal.maxLoss.pct, 1, 1e-9);
near('max loss = $250', normal.maxLoss.amount, 250, 0.01);
near('notional = $7,200 — identical to riskManager.js', normal.position.notional, 7200, 0.5);
near('units = 0.1 BTC', normal.position.units, 0.1, 1e-6);
ok('stop source is TECHNICAL', normal.stop.source === 'TECHNICAL');
near('stop distance = 3.472%', normal.stop.distancePct, 3.4722, 0.001);
ok('a clean trade reports no blockers', normal.blockers.length === 0);
ok('the strategy version is stamped', normal.strategyVersion === STRATEGY_VERSION);
ok('an inputs hash is returned', typeof normal.inputsHash === 'string' && normal.inputsHash.length > 4);
console.log(`        ${money(normal.position.notional)} notional, ${money(normal.maxLoss.amount)} max loss, ${normal.position.leverage}x, margin ${money(normal.position.margin)}`);

// A short.
const short = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 69500, stop: 72000 }
});
ok('direction inferred as SHORT from entry/stop', short.detail.direction === 'SHORT');
near('short risks the same $250', short.maxLoss.amount, 250, 0.01);

// A wrong-side stop is rejected, never absolute-valued.
const wrongSide = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 75000, direction: 'LONG' }
});
ok('a wrong-side stop returns INCOMPLETE', wrongSide.decision === 'INCOMPLETE');
ok('and explains why', wrongSide.warnings.some((w) => /below entry/i.test(w)), JSON.stringify(wrongSide.warnings));

// No stop supplied -> derived.
const derived = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, direction: 'LONG' }
});
ok('no stop -> stop.source is DERIVED', derived.stop.source === 'DERIVED');
near('STANDARD derives a 5% adverse move at level 0 / conf 50', derived.stop.distancePct, 5, 1e-9);
near('and the implied stop price follows', derived.stop.price, 72000 * 0.95, 0.01);
near('max loss still equals the risk budget', derived.maxLoss.amount, 250, 0.01);
near('notional = 250 / 0.05 = $5,000', derived.position.notional, 5000, 0.5);
ok('the assumption is surfaced as a warning', derived.warnings.some((w) => /assumption/i.test(w)));
ok('and as a factor', derived.factors.some((f) => f.code === 'DERIVED_STOP'));

// Low confidence widens the derived stop; it can never tighten it.
const derivedLow = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 0, entry: 72000, direction: 'LONG' }
});
const derivedHigh = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 100, entry: 72000, direction: 'LONG' }
});
ok('low confidence widens the derived stop', derivedLow.stop.distancePct > derived.stop.distancePct);
ok('high confidence never tightens it below the base', derivedHigh.stop.distancePct >= STRATEGY_PRESETS.STANDARD.derivedStop.basePct);

// Very wide stop.
const wide = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 36000 }
});
near('a 50% stop yields a $500 notional', wide.position.notional, 500, 0.5);
near('and still risks exactly $250', wide.maxLoss.amount, 250, 0.01);

// Very tight stop: the SIZE is cut, the stop is never widened.
const tight = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 71928 }
});
near('the 0.1% stop is preserved exactly', tight.stop.distancePct, 0.1, 1e-9);
ok('the stop price is untouched', tight.stop.price === 71928);
near('notional cut to the 200% exposure cap', tight.position.notional, 50000, 0.5);
ok('the reduction is reported as a factor', tight.factors.some((f) => f.code === 'NOTIONAL_CAP'));
ok('the required leverage breaches the cap -> NO_TRADE', tight.decision === 'NO_TRADE');
ok('and the blocker names the cap', tight.blockers.some((b) => b.code === 'LEVERAGE_CAP'));
console.log(`        tight stop: notional cut ${money(250 / 0.001)} -> ${money(tight.position.notional)}, decision ${tight.decision}`);

// Every blocker carries the full renderable shape.
const blockerShapeOk = tight.blockers.every(
  (b) => typeof b.code === 'string' && typeof b.label === 'string' && b.current !== undefined && b.limit !== undefined && typeof b.remedy === 'string' && b.remedy.length > 0
);
ok('every blocker carries { code, label, current, limit, remedy }', blockerShapeOk, JSON.stringify(tight.blockers));

// Missing / unavailable wallet data.
ok('unavailable wallet -> INCOMPLETE',
  recommendTrade({ account: { ...cleanAccount, walletAvailable: false }, request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50 } }).decision === 'INCOMPLETE');
const staleResult = recommendTrade({
  account: { ...cleanAccount, dataStale: true },
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 69500 }
});
ok('stale wallet data -> INCOMPLETE', staleResult.decision === 'INCOMPLETE');
ok('stale data explains itself rather than showing a confident number',
  staleResult.blockers.some((b) => b.code === 'STALE_WALLET_DATA') && staleResult.warnings.length > 0);

/* ======================================================================
 * 15. OPEN POSITIONS, RISK RECYCLING AND CONCENTRATION
 * =================================================================== */
section('15. Open positions consume capacity until they are CLOSED');

// A stop beyond breakeven does NOT free the whole budget.
const breakevenBook = calculateOpenRisk({
  openPositions: [{ id: 'x', direction: 'LONG', notional: 10000, entry: 100, stop: 105, unrealizedPnl: 0 }],
  adjustedEquity: 25000
});
near('risk to a profit-locking stop is zero', breakevenBook.positions[0].riskToStop, 0, 1e-9);
near('but the closure reserve still consumes 0.5% of notional', breakevenBook.consumedRisk, 50, 1e-9);
ok('the floor is flagged', breakevenBook.positions[0].floorApplied === true);
ok('closure reserve documented at 0.5%', ADAPTIVE_CONSTANTS.CLOSURE_RESERVE === 0.005);

// Unrealised P&L is asymmetric.
const openLoss = calculateOpenRisk({
  openPositions: [{ id: 'x', direction: 'LONG', notional: 10000, entry: 100, stop: 98, unrealizedPnl: -500 }],
  adjustedEquity: 25000
});
const openGain = calculateOpenRisk({
  openPositions: [{ id: 'x', direction: 'LONG', notional: 10000, entry: 100, stop: 98, unrealizedPnl: 500 }],
  adjustedEquity: 25000
});
near('unrealised LOSS is added at full weight (200 + 500)', openLoss.consumedRisk, 700, 1e-9);
near('unrealised GAIN does not reduce consumed risk', openGain.consumedRisk, 200, 1e-9);
near('unrealised GAIN is credited at only 25%', openGain.unrealizedGainCredited, 125, 1e-9);
ok('the asymmetry favours caution', openLoss.consumedRisk > openGain.consumedRisk);
console.log(`        same position: -$500 open -> ${money(openLoss.consumedRisk)} consumed, +$500 open -> ${money(openGain.consumedRisk)} consumed`);

// Multiple open trades and directional concentration.
const threeLongs = [
  { id: 'a', asset: 'BTC', direction: 'LONG', notional: 5000, entry: 100, stop: 98, margin: 1000, unrealizedPnl: 0 },
  { id: 'b', asset: 'ETH', direction: 'LONG', notional: 5000, entry: 100, stop: 98, margin: 1000, unrealizedPnl: 0 },
  { id: 'c', asset: 'SOL', direction: 'LONG', notional: 5000, entry: 100, stop: 98, margin: 1000, unrealizedPnl: 0 }
];
const concentrated = calculateDirectionalConcentration({ openPositions: threeLongs });
ok('three same-direction positions are flagged', concentrated.concentrated === true);
ok('the label says DIRECTIONAL CONCENTRATION, not correlation',
  concentrated.label === 'DIRECTIONAL CONCENTRATION — 3 LONG', concentrated.label);
ok('and the note refuses to claim a measured correlation', /not a measured correlation/i.test(concentrated.note));
ok('a mixed book is not flagged',
  calculateDirectionalConcentration({
    openPositions: [threeLongs[0], threeLongs[1], { ...threeLongs[2], direction: 'SHORT', stop: 102 }]
  }).concentrated === false);

const multiOpen = calculateOpenRisk({ openPositions: threeLongs, adjustedEquity: 25000 });
near('three positions consume 300 of risk', multiOpen.consumedRisk, 300, 1e-9);
ok('all three counted', multiOpen.count === 3);

// Open risk over the limit -> NO_TRADE, whatever the confidence.
const hotAccount = {
  ...cleanAccount,
  openPositions: [{ id: 'h', asset: 'ETH', direction: 'LONG', notional: 20000, entry: 100, stop: 92, margin: 4000, unrealizedPnl: 0 }]
};
const hotMax = recommendTrade({
  account: hotAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 100, entry: 72000, stop: 69500 }
});
ok('open risk 6.4% over a 6% limit -> NO_TRADE', hotMax.decision === 'NO_TRADE');
ok('confidence 100 does NOT clear the no-trade', hotMax.confidence === 90 && hotMax.decision === 'NO_TRADE');
const heatBlocker = hotMax.blockers.find((b) => b.code === 'OPEN_RISK_LIMIT');
ok('the blocker is renderable', heatBlocker && heatBlocker.current === '6.4%' && heatBlocker.limit === '6%',
  JSON.stringify(heatBlocker));
console.log(`        "${heatBlocker.label} ${heatBlocker.current} · limit ${heatBlocker.limit} · ${heatBlocker.remedy}"`);

// Max open positions.
const fullBook = {
  ...cleanAccount,
  openPositions: [1, 2, 3, 4].map((i) => ({
    id: `p${i}`, asset: `A${i}`, direction: i % 2 ? 'LONG' : 'SHORT',
    notional: 1000, entry: 100, stop: i % 2 ? 99 : 101, margin: 300, unrealizedPnl: 0
  }))
};
const full = recommendTrade({
  account: fullBook,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 69500 }
});
ok('a full book blocks a fifth position at level 0', full.decision === 'NO_TRADE');
ok('the position-count blocker names the limit',
  full.blockers.some((b) => b.code === 'MAX_OPEN_POSITIONS' && b.limit === 4));

// A partially-consumed book REDUCES the trade rather than blocking it.
const partialBook = {
  ...cleanAccount,
  openPositions: [
    { id: 'l', asset: 'BTC', direction: 'LONG', notional: 10000, entry: 100, stop: 93.125, margin: 2000, unrealizedPnl: 0 },
    { id: 's', asset: 'ETH', direction: 'SHORT', notional: 10000, entry: 100, stop: 106.875, margin: 2000, unrealizedPnl: 0 }
  ]
};
const reduced = recommendTrade({
  account: partialBook,
  request: { asset: 'SOL', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 69500 }
});
near('the book already consumes 5.5% of equity', reduced.detail.openRisk.consumedRiskPct, 5.5, 1e-6);
ok('the trade is reduced, not blocked', reduced.decision === 'TRADE', reduced.blockers.map((b) => b.code).join(','));
near('risk cut from 1.0% to the remaining 0.5% of heat', reduced.maxLoss.pct, 0.5, 1e-6);
ok('the reduction is reported as a factor', reduced.factors.some((f) => f.code === 'PORTFOLIO_CLAMP'));
console.log(`        book at 5.5% heat -> requested 1.00% reduced to ${reduced.maxLoss.pct.toFixed(2)}% (${money(reduced.maxLoss.amount)})`);

// A hedging trade in the opposite direction is not blocked by the one-way cap.
const oneWayBook = {
  ...cleanAccount,
  // 3 x $20,000 notional with a 2% stop = $400 risk each = 4.8% of equity one
  // way, past the 4% directional cap but under the 6% heat limit.
  openPositions: threeLongs.map((p) => ({ ...p, notional: 20000, stop: 98, margin: 1000 }))
};
const hedge = evaluateNoTradeConstraints({
  envelope: env0,
  openRiskState: calculateOpenRisk({ openPositions: oneWayBook.openPositions, adjustedEquity: 25000 }),
  concentration: calculateDirectionalConcentration({ openPositions: oneWayBook.openPositions }),
  adjustedEquity: 25000,
  drawdown: { currentDrawdownPct: 0 },
  level: 0,
  direction: 'SHORT'
});
ok('a SHORT is not blocked by a LONG one-way limit',
  !hedge.blockers.some((b) => b.code === 'DIRECTIONAL_LIMIT'));
const addOn = evaluateNoTradeConstraints({
  envelope: env0,
  openRiskState: calculateOpenRisk({ openPositions: oneWayBook.openPositions, adjustedEquity: 25000 }),
  concentration: calculateDirectionalConcentration({ openPositions: oneWayBook.openPositions }),
  adjustedEquity: 25000,
  drawdown: { currentDrawdownPct: 0 },
  level: 0,
  direction: 'LONG'
});
ok('but another LONG is', addOn.blockers.some((b) => b.code === 'DIRECTIONAL_LIMIT'));

/* ======================================================================
 * 16. LEVERAGE NEVER CHANGES THE LOSS AT THE STOP
 * =================================================================== */
section('16. Leverage moves margin only');

let leverageRiskConstant = true;
let leverageMarginFalls = true;
let previousMargin = Infinity;
const leverageRows = [];
for (const lev of [1, 1.5, 2, 3]) {
  const plan = recommendTrade({
    account: cleanAccount,
    request: {
      asset: 'BTC', strategy: 'STANDARD', confidence: 50,
      entry: 72000, stop: 69500, override: { leverage: lev }
    }
  });
  if (Math.abs(plan.maxLoss.amount - 250) > 0.01) leverageRiskConstant = false;
  if (Math.abs(plan.position.notional - 7200) > 0.5) leverageRiskConstant = false;
  if (plan.position.margin >= previousMargin) leverageMarginFalls = false;
  previousMargin = plan.position.margin;
  leverageRows.push(`${lev}x margin ${money(plan.position.margin)} loss ${money(plan.maxLoss.amount)}`);
}
ok('changing leverage alone leaves max loss and notional unchanged', leverageRiskConstant);
ok('margin falls monotonically as leverage rises', leverageMarginFalls);
console.log(`        ${leverageRows.join('   ')}`);

// The engine picks the LOWEST leverage that fits the margin budget.
const lowLeverage = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 25, entry: 72000, stop: 69500 }
});
ok('a position that fits at 1x is recommended at 1x', lowLeverage.position.leverage === 1, `got ${lowLeverage.position.leverage}`);
const needsLeverage = recommendTrade({
  account: cleanAccount,
  request: { asset: 'BTC', strategy: 'STANDARD', confidence: 90, entry: 72000, stop: 69500 }
});
ok('a larger position raises leverage only as far as it must',
  needsLeverage.position.leverage > 1 && needsLeverage.position.leverage <= env0.maxLeverage,
  `got ${needsLeverage.position.leverage}`);
near('margin x leverage still reconstructs notional',
  needsLeverage.position.margin * needsLeverage.position.leverage, needsLeverage.position.notional, 0.01);

/* ======================================================================
 * 17. evaluatePosition
 * =================================================================== */
section('17. evaluatePosition — ADD / HOLD / REDUCE / EXIT / PROTECT_PROFIT');

const provenAccount = buildAccount({ rs: [1, -1, 1, 1, -1, 1, 1, -1] });
provenAccount.previousLevelState = { level: 2, tradesAtLevelChange: 8 };
const basePosition = {
  id: 'p1', asset: 'BTC', direction: 'LONG', notional: 7200, entry: 72000,
  stop: 69500, leverage: 2, margin: 3600, riskAmount: 250
};
const judge = (overrides, account = provenAccount) => {
  const position = { ...basePosition, ...overrides };
  return evaluatePosition({ account: { ...account, openPositions: [position] }, position, strategy: 'STANDARD' });
};

const held = judge({ unrealizedPnl: 50 });
ok('a compliant position returns HOLD', held.action === 'HOLD', held.action);

const exited = judge({ unrealizedPnl: -400 });
ok('a position 1.6R underwater returns EXIT', exited.action === 'EXIT', exited.action);
ok('EXIT explains itself in R, not in price', exited.rationale.some((r) => /R/.test(r)));

const overLeveraged = judge({ leverage: 10, unrealizedPnl: 0 });
ok('leverage over the cap returns REDUCE', overLeveraged.action === 'REDUCE', overLeveraged.action);
ok('REDUCE carries a renderable blocker',
  overLeveraged.blockers.some((b) => b.code === 'LEVERAGE_CAP' && typeof b.remedy === 'string'));

const added = judge({ unrealizedPnl: 300 });
ok('a +1.2R position at level 2 permits ADD', added.action === 'ADD', added.action);
ok('ADD is sized, not open-ended', added.addition && added.addition.notional > 0);
ok('ADD stays inside the single-trade ceiling',
  added.addition.riskPct <= added.envelope.maxRiskPct + 1e-9, `${added.addition.riskPct}`);
ok('ADD treats the existing risk as not freed',
  added.rationale.some((r) => /not freed/i.test(r)));
ok('ADD is capped at half the existing notional',
  added.addition.notional <= basePosition.notional * ADAPTIVE_CONSTANTS.ADD_MAX_SHARE_OF_NOTIONAL + 1e-9);

// ADD is refused at an unproven level even with the same open profit.
const unprovenAccount = buildAccount({ rs: [1, -1, 1, 1, -1, 1, 1, -1] });
unprovenAccount.previousLevelState = { level: 0, tradesAtLevelChange: 8 };
const notAdded = judge({ unrealizedPnl: 300 }, unprovenAccount);
ok('the same position at level 0 does not permit ADD', notAdded.action !== 'ADD', notAdded.action);

// PROTECT_PROFIT — rule-based.
const protectedRule = judge({ unrealizedPnl: 600 }, unprovenAccount);
ok('PROTECT_PROFIT offered at +2.4R', protectedRule.protectProfit !== null);
ok('rule-based when no technical level is supplied', protectedRule.protectProfit.source === 'RULE');
// mark = 72000 * (1 + 600/7200) = 78000; half the gain locked -> stop 75000
near('the rule locks half the open gain', protectedRule.protectProfit.proposedStop, 75000, 0.01);
near('locked profit = $300', protectedRule.protectProfit.lockedProfit, 300, 0.01);
near('remaining give-back = $300', protectedRule.protectProfit.remainingRisk, 300, 0.01);

// At exactly +1R the rule goes to breakeven, not beyond.
const protectedBreakeven = judge({ unrealizedPnl: 250 }, unprovenAccount);
near('at +1R the stop moves to breakeven', protectedBreakeven.protectProfit.proposedStop, 72000, 0.01);
near('breakeven locks nothing', protectedBreakeven.protectProfit.lockedProfit, 0, 0.01);

// A supplied technical level takes priority; none is ever invented.
const protectedTechnical = judge({ unrealizedPnl: 600, technicalLevel: 73500 }, unprovenAccount);
ok('a supplied technical level wins', protectedTechnical.protectProfit.source === 'TECHNICAL');
near('and is used verbatim', protectedTechnical.protectProfit.proposedStop, 73500, 1e-9);
ok('an unusable technical level falls back to the rule, never to an invented level',
  judge({ unrealizedPnl: 600, technicalLevel: 60000 }, unprovenAccount).protectProfit.source === 'RULE');
ok('no PROTECT_PROFIT below the trigger', judge({ unrealizedPnl: 100 }, unprovenAccount).protectProfit === null);

ok('every verdict says it is not a price prediction',
  [held, exited, overLeveraged, added].every((r) => r.rationale.some((line) => /not a price prediction/i.test(line))));
console.log(`        HOLD / EXIT / REDUCE / ADD all reachable; PROTECT_PROFIT rule stop ${money(protectedRule.protectProfit.proposedStop)}, technical ${money(protectedTechnical.protectProfit.proposedStop)}`);

/* ======================================================================
 * 18. LEARNING PROPOSALS
 * =================================================================== */
section('18. analyzeStrategyPerformance proposes, never mutates');

ok('no trades -> no proposals', analyzeStrategyPerformance({ trades: [] }).length === 0);

// 12 losing trades is under the 20-trade minimum: nothing may be proposed.
const tooFew = buildAccount({ rs: Array(12).fill(-1) }).trades.map((t) => ({ ...t, strategy: 'AGGRESSIVE' }));
ok('a 12-trade sample proposes nothing', analyzeStrategyPerformance({ trades: tooFew }).length === 0);
ok('the minimum sample is documented at 20', ADAPTIVE_CONSTANTS.MIN_SAMPLE_FOR_PROPOSAL === 20);

// 24 losing AGGRESSIVE trades at high confidence and 5x leverage.
const badGroup = buildAccount({ rs: Array(24).fill(-1) }).trades.map((t) => ({
  ...t, strategy: 'AGGRESSIVE', confidence: 90, leverage: 5, level: 2, drawdownStateAtEntry: 'NORMAL'
}));
const proposals = analyzeStrategyPerformance({ trades: badGroup });
ok('a losing group produces proposals', proposals.length > 0);
ok('proposals carry the full shape',
  proposals.every((p) => p.id && p.scope && p.current && p.proposed && p.reason && Number.isFinite(p.sampleSize) && p.confidence),
  JSON.stringify(proposals[0]));
ok('every proposal meets the minimum sample size',
  proposals.every((p) => p.sampleSize >= ADAPTIVE_CONSTANTS.MIN_SAMPLE_FOR_PROPOSAL));
ok('the strategy group is identified', proposals.some((p) => p.scope === 'strategy = AGGRESSIVE'));
ok('the confidence band is identified', proposals.some((p) => p.scope === 'confidenceBand = HIGH'));
ok('the leverage band is identified', proposals.some((p) => p.scope === 'leverageBand = 3-5x'));
ok('proposals for a losing group reduce risk', proposals.every((p) => p.id.startsWith('reduce:')));
console.log(`        ${proposals.length} proposals, e.g. "${proposals[0].proposed}" (n=${proposals[0].sampleSize}, confidence ${proposals[0].confidence})`);

// Upward proposals need a bigger sample than downward ones.
const goodSmall = buildAccount({ rs: Array(24).fill(1) }).trades.map((t) => ({ ...t, strategy: 'STANDARD', confidence: 50, leverage: 2 }));
const goodLarge = buildAccount({ rs: Array(36).fill(1) }).trades.map((t) => ({ ...t, strategy: 'STANDARD', confidence: 50, leverage: 2 }));
ok('a 24-trade winning group is too small for an upward proposal',
  analyzeStrategyPerformance({ trades: goodSmall }).every((p) => !p.id.startsWith('increase:')));
ok('a 36-trade winning group may propose a small increase',
  analyzeStrategyPerformance({ trades: goodLarge }).some((p) => p.id.startsWith('increase:')));
ok('upward proposals stay capped by the level envelope',
  analyzeStrategyPerformance({ trades: goodLarge })
    .filter((p) => p.id.startsWith('increase:'))
    .every((p) => /capped by the level envelope/i.test(p.proposed)));

// Nothing is mutated.
const presetSnapshot = JSON.stringify(STRATEGY_PRESETS);
const constantsSnapshot = JSON.stringify(ADAPTIVE_CONSTANTS);
analyzeStrategyPerformance({ trades: badGroup });
ok('presets are unchanged after analysis', JSON.stringify(STRATEGY_PRESETS) === presetSnapshot);
ok('constants are unchanged after analysis', JSON.stringify(ADAPTIVE_CONSTANTS) === constantsSnapshot);

// Deterministic ordering.
ok('proposal order is deterministic',
  JSON.stringify(analyzeStrategyPerformance({ trades: badGroup })) ===
  JSON.stringify(analyzeStrategyPerformance({ trades: badGroup })));

/* ======================================================================
 * 19. DETERMINISM
 * =================================================================== */
section('19. Determinism');

const runA = recommendTrade({ account: cleanAccount, request: { asset: 'BTC', strategy: 'STANDARD', confidence: 62, entry: 72000, stop: 69500 } });
const runB = recommendTrade({ account: cleanAccount, request: { asset: 'BTC', strategy: 'STANDARD', confidence: 62, entry: 72000, stop: 69500 } });
ok('identical inputs give byte-identical output', JSON.stringify(runA) === JSON.stringify(runB));
ok('and an identical inputs hash', runA.inputsHash === runB.inputsHash);
const runC = recommendTrade({ account: cleanAccount, request: { asset: 'BTC', strategy: 'STANDARD', confidence: 63, entry: 72000, stop: 69500 } });
ok('a changed input changes the hash', runA.inputsHash !== runC.inputsHash);
ok('the engine never reads the clock', !/Date\.now|Math\.random/.test(
  (await import('node:fs')).readFileSync(new URL('../public/js/adaptiveRisk.js', import.meta.url), 'utf8')
));
console.log(`        inputsHash ${runA.inputsHash} -> ${runC.inputsHash} on a one-point confidence change`);

/* ======================================================================
 * 20. INVARIANT SWEEP
 * =================================================================== */
section('20. Invariant sweep across wallets x levels x strategies x confidences');

// A clean, level-neutral history: 70% win rate, no losing streak, no drawdown.
// Pinning tradesAtLevelChange to the trade count means no promotion is pending,
// so each level under test is held exactly where it is put.
const sweepSeq = [1, -1, 1, 1, -1, 1, 1, -1, 1, 1];

let sweepCount = 0;
let sweepTrades = 0;
let sweepBlocked = 0;
let sweepFailures = 0;
const sweepFailureDetail = [];

for (const wallet of [2000, 25000, 200000]) {
  const account = buildAccount({ wallet, rs: sweepSeq });
  for (const level of [-2, -1, 0, 1, 3, 5]) {
    for (const strategyKey of ['STANDARD', 'AGGRESSIVE']) {
      for (const confidence of [0, 25, 50, 75, 100]) {
        sweepCount++;
        const result = recommendTrade({
          account: { ...account, previousLevelState: pinLevel(account, level) },
          request: { asset: 'BTC', strategy: strategyKey, confidence, entry: 72000, stop: 69500 }
        });

        if (result.decision !== 'TRADE') {
          sweepBlocked++;
          continue;
        }
        sweepTrades++;

        if (result.level !== level) {
          sweepFailures++;
          sweepFailureDetail.push(`level drifted ${level} -> ${result.level}`);
          continue;
        }

        const equity = account.walletValue;
        const eps = Math.max(1e-6, result.position.notional * 1e-9);
        const stopFraction = result.stop.distancePct / 100;

        // 1. Max loss never exceeds the envelope ceiling on equity.
        if (result.maxLoss.amount > (result.envelope.maxRiskPct / 100) * equity + eps) {
          sweepFailures++;
          sweepFailureDetail.push(`maxLoss ${result.maxLoss.amount} > cap ${(result.envelope.maxRiskPct / 100) * equity}`);
          continue;
        }
        // 2. notional x stop distance == max loss.
        if (Math.abs(result.position.notional * stopFraction - result.maxLoss.amount) > eps) {
          sweepFailures++;
          sweepFailureDetail.push(`notional x stop != maxLoss (${result.position.notional * stopFraction} vs ${result.maxLoss.amount})`);
          continue;
        }
        // 3. margin x leverage == notional.
        if (Math.abs(result.position.margin * result.position.leverage - result.position.notional) > eps) {
          sweepFailures++;
          sweepFailureDetail.push(`margin x leverage != notional`);
          continue;
        }
        // 4. Leverage never exceeds the level/strategy cap.
        if (result.position.leverage > result.envelope.maxLeverage + 1e-9) {
          sweepFailures++;
          sweepFailureDetail.push(`leverage ${result.position.leverage} > cap ${result.envelope.maxLeverage}`);
        }
      }
    }
  }
}

ok(`all ${sweepCount} combinations hold every invariant`, sweepFailures === 0,
  `${sweepFailures} failed: ${sweepFailureDetail.slice(0, 3).join(' | ')}`);
ok('the sweep actually produced tradeable results', sweepTrades > sweepCount * 0.5, `${sweepTrades} of ${sweepCount}`);
console.log(`        ${sweepTrades} TRADE, ${sweepBlocked} NO_TRADE/INCOMPLETE across ${sweepCount} combinations`);

// The same sweep must be scale-invariant in percentage terms.
let scaleFailures = 0;
for (const level of [-2, 0, 3, 5]) {
  for (const strategyKey of ['STANDARD', 'AGGRESSIVE']) {
    for (const confidence of [0, 50, 100]) {
      const results = [2000, 25000, 200000].map((wallet) => {
        const account = buildAccount({ wallet, rs: sweepSeq });
        return recommendTrade({
          account: { ...account, previousLevelState: pinLevel(account, level) },
          request: { asset: 'BTC', strategy: strategyKey, confidence, entry: 72000, stop: 69500 }
        });
      });
      if (new Set(results.map((r) => r.decision)).size !== 1) scaleFailures++;
      else if (Math.max(...results.map((r) => r.maxLoss.pct)) - Math.min(...results.map((r) => r.maxLoss.pct)) > 1e-9) scaleFailures++;
    }
  }
}
ok('every sweep cell is scale-invariant in percentage terms', scaleFailures === 0, `${scaleFailures} cells differed`);

/* ======================================================================
 * 21. ADVERSARIAL PROPERTY — a worsening history can never raise risk
 * =================================================================== */
section('21. Adversarial: monotonically worsening history -> non-increasing risk %');

/**
 * Append -1R losses one at a time to a winning history and confirm the
 * recommended risk percentage never rises. Every mechanism in the engine that
 * could raise it — level, envelope, performance haircut, confidence — must be
 * one-way for this to hold.
 */
function worseningSweep({ wins, confidence, strategyKey, startLevel, lossR = -1 }) {
  const risks = [];
  const decisions = [];
  for (let losses = 0; losses <= 14; losses++) {
    const rs = [...Array(wins).fill(1), ...Array(losses).fill(lossR)];
    const account = buildAccount({ rs });
    const result = recommendTrade({
      account: { ...account, previousLevelState: { level: startLevel, tradesAtLevelChange: 0 } },
      request: { asset: 'BTC', strategy: strategyKey, confidence, entry: 72000, stop: 69500 }
    });
    risks.push(result.detail.riskPct);
    decisions.push(result.decision);
  }
  return { risks, decisions };
}

let propertyViolations = 0;
const propertyCases = [];
for (const strategyKey of ['STANDARD', 'AGGRESSIVE']) {
  for (const confidence of [0, 50, 100]) {
    for (const startLevel of [0, 2, 5]) {
      const { risks } = worseningSweep({ wins: 6, confidence, strategyKey, startLevel });
      for (let i = 1; i < risks.length; i++) {
        if (risks[i] > risks[i - 1] + 1e-9) {
          propertyViolations++;
          propertyCases.push(`${strategyKey}/c${confidence}/L${startLevel}: step ${i} ${risks[i - 1]} -> ${risks[i]}`);
        }
      }
    }
  }
}
ok('across 18 worsening histories the risk % is never increased', propertyViolations === 0,
  propertyCases.slice(0, 3).join(' | '));

const showcase = worseningSweep({ wins: 6, confidence: 50, strategyKey: 'STANDARD', startLevel: 2 });
console.log(`        STANDARD, level 2, confidence 50 — risk % as losses accumulate:`);
console.log(`        ${showcase.risks.map((r) => r.toFixed(3)).join(' -> ')}`);
ok('the sequence actually ends lower than it started', showcase.risks[showcase.risks.length - 1] < showcase.risks[0]);
ok('the run ends at the defensive floor with a minimal envelope',
  showcase.risks[showcase.risks.length - 1] < 0.2, `${showcase.risks[showcase.risks.length - 1]}%`);

// A run of -2R losses drives the drawdown past the defensive threshold, which
// is a NO_TRADE rather than a very small trade.
const severeRun = worseningSweep({ wins: 6, confidence: 100, strategyKey: 'STANDARD', startLevel: 2, lossR: -2 });
let severeViolations = 0;
for (let i = 1; i < severeRun.risks.length; i++) {
  if (severeRun.risks[i] > severeRun.risks[i - 1] + 1e-9) severeViolations++;
}
ok('a -2R losing run is also monotonically non-increasing', severeViolations === 0);
ok('and it eventually reaches NO_TRADE', severeRun.decisions.includes('NO_TRADE'),
  severeRun.decisions.join(','));
console.log(`        -2R run: ${severeRun.risks.map((r) => r.toFixed(3)).join(' -> ')}`);
console.log(`        -2R run decisions: ${severeRun.decisions.join(' ')}`);

// The mirror image: an improving history must never be punished, but neither
// may it raise risk beyond what the LEVEL permits.
const improvingRisks = [];
for (let wins = 0; wins <= 12; wins++) {
  const account = buildAccount({ rs: Array(wins).fill(1) });
  const result = recommendTrade({
    account: { ...account, previousLevelState: { level: 0, tradesAtLevelChange: 0 } },
    request: { asset: 'BTC', strategy: 'STANDARD', confidence: 50, entry: 72000, stop: 69500 }
  });
  improvingRisks.push(result.detail.riskPct);
}
ok('a winning run never lifts risk above the next level\'s base',
  Math.max(...improvingRisks) <= STRATEGY_PRESETS.STANDARD.levels['1'].baseRiskPct + 1e-9,
  `max ${Math.max(...improvingRisks)}`);
console.log(`        improving history: ${improvingRisks.map((r) => r.toFixed(2)).join(' -> ')} (levels, not results, widen the envelope)`);

/* ======================================================================
 * SUMMARY
 * =================================================================== */

console.log(`\n${'='.repeat(62)}`);
console.log(failures === 0
  ? `All ${assertions} assertions passed.`
  : `${failures} of ${assertions} assertions FAILED.`);
console.log(`${'='.repeat(62)}\n`);

process.exit(failures === 0 ? 0 : 1);
