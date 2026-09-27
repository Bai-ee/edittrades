// Tests for scripts/research/edge/wp7-engine.js (research only,
// docs/research/harness/WP7_SPOT_REGISTRATION.md — frozen registration, read that first).
// Plain asserts, matches the style of other test-*.js files in this repo.
import assert from 'node:assert';
import { runSma4h, barsFromCandles } from './scripts/research/edge/sma4h-trend.js';
import {
  runBinaryFilter, smaWantSeries, volTargetWeight, applyBuffer, simulateDCA, xirr
} from './scripts/research/edge/wp7-engine.js';

const MS_4H = 4 * 3600e3;
let pass = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function near(a, b, eps = 1e-9, msg = '') {
  assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a} (diff ${Math.abs(a - b)})`);
}

// ---------------------------------------------------------------------- (1) cross-check vs runSma4h

// Same N=3 fixture as test-sma4h-trend.js, reused via the existing exported barsFromCandles().
function makeFixtureCandles() {
  const base = [
    { o: 10, c: 10 }, { o: 10, c: 10 }, { o: 10, c: 10 }, { o: 10, c: 16 },
    { o: 20, c: 24 }, { o: 24, c: 30 }, { o: 30, c: 18 }, { o: 14, c: 12 },
    { o: 12, c: 25 }, { o: 25, c: 25 }
  ];
  return base.map((r, i) => ({ timestamp: i * MS_4H, open: r.o, high: Math.max(r.o, r.c), low: Math.min(r.o, r.c), close: r.c, volume: 1, closeTime: (i + 1) * MS_4H }));
}
const fixtureBars = barsFromCandles(makeFixtureCandles());

check('runBinaryFilter reproduces runSma4h exactly on an SMA want-series (no cost)', () => {
  const trusted = runSma4h(fixtureBars, { n: 3, costPerSide: 0, borrowPerHour: 0 });
  const want = smaWantSeries(fixtureBars, 3);
  const mine = runBinaryFilter(fixtureBars, want, { costPerSide: 0, barHours: 4 });
  near(mine.netCagr, trusted.netCagr, 1e-9, 'netCagr');
  near(mine.bhCagr, trusted.bhCagr, 1e-9, 'bhCagr');
  near(mine.maxDD, trusted.maxDD, 1e-9, 'maxDD');
  near(mine.bhMaxDD, trusted.bhMaxDD, 1e-9, 'bhMaxDD');
  assert.strictEqual(mine.entries, trusted.entries, 'entries');
  assert.strictEqual(mine.exits, trusted.exits, 'exits');
  assert.strictEqual(mine.trades.filter((t) => !t.open).length, trusted.trades.filter((t) => !t.open).length, 'closed trade count');
  const eqNetMine = mine.series.map((s) => s.eqNet);
  const eqNetTrusted = trusted.series.map((s) => s.eqNet);
  assert.deepStrictEqual(eqNetMine.length, eqNetTrusted.length, 'series length');
  eqNetMine.forEach((v, i) => near(v, eqNetTrusted[i], 1e-9, `eqNet[${i}]`));
});

check('runBinaryFilter reproduces runSma4h with cost applied (0.15%/side)', () => {
  const trusted = runSma4h(fixtureBars, { n: 3, costPerSide: 0.0015, borrowPerHour: 0 });
  const want = smaWantSeries(fixtureBars, 3);
  const mine = runBinaryFilter(fixtureBars, want, { costPerSide: 0.0015, barHours: 4 });
  near(mine.netCagr, trusted.netCagr, 1e-9, 'netCagr with cost');
  near(mine.series[mine.series.length - 1].eqNet, trusted.series[trusted.series.length - 1].eqNet, 1e-9, 'final eqNet with cost');
});

// ---------------------------------------------------------------------- (2) vol target caps at 1

check('volTargetWeight caps at 1 when targetVol > realizedVol', () => {
  near(volTargetWeight(0.4, 0.1), 1, 1e-12, 'capped at 1');
  near(volTargetWeight(0.4, 0.8), 0.5, 1e-12, 'uncapped ratio');
  assert.strictEqual(volTargetWeight(0.4, 0), 0, 'zero vol -> zero weight, not Infinity');
  assert.strictEqual(volTargetWeight(0.4, NaN), 0, 'NaN vol -> zero weight');
});

// ---------------------------------------------------------------------- (3) buffer suppresses small rebalances

check('applyBuffer suppresses moves inside the band and snaps to target outside it', () => {
  assert.strictEqual(applyBuffer(0.5, 0.55, 0.1), 0.5, 'gap 0.05 <= buffer 0.1 -> no change');
  assert.strictEqual(applyBuffer(0.5, 0.6, 0.1), 0.5, 'gap exactly at buffer -> no change (strict >)');
  assert.strictEqual(applyBuffer(0.5, 0.65, 0.1), 0.65, 'gap 0.15 > buffer 0.1 -> full snap to target');
  assert.strictEqual(applyBuffer(0.5, 0.3, 0), 0.3, 'buffer 0 -> always snaps to target');
});

// ---------------------------------------------------------------------- (4) DCA accounting hand fixture

// 4 weekly (Monday, 00:00 UTC) bars. want[] decided at close[j-1], acted at bar j's open, same
// convention as runBinaryFilter. costPerSide = 1% for round hand-computed numbers.
// j=0 Monday0 o=c=100 (decision null -> flat, no buy, cash sits)
// j=1 Monday1 o=100 c=110 (decision want[0]=true -> BUY at 100)
// j=2 Monday2 o=110 c=121 (decision want[1]=true -> still long, BUY new cash at 110)
// j=3 Monday3 o=90  c=90  (decision want[2]=false -> SELL all at 90)
function mondayBars() {
  const week = 7 * 24 * 3600e3;
  // 2026-09-28 is a Monday, 00:00 UTC.
  const t0 = Date.UTC(2026, 8, 28, 0, 0, 0);
  const rows = [
    { o: 100, c: 100 }, { o: 100, c: 110 }, { o: 110, c: 121 }, { o: 90, c: 90 }
  ];
  return rows.map((r, i) => ({ timestamp: t0 + i * week, open: r.o, high: Math.max(r.o, r.c), low: Math.min(r.o, r.c), close: r.c, volume: 1, closeTime: t0 + i * week + 1 }));
}
const dcaBars = barsFromCandles(mondayBars());
const dcaWant = [true, true, false, null]; // want[j] decided at close of bar j; want[3] unused (no bar 4)

check('simulateDCA: hand-computed contributions, buys, sell, and cost on every trade', () => {
  const r = simulateDCA(dcaBars, dcaWant, { contribution: 100, costPerSide: 0.01 });
  near(r.contributed, 400, 1e-9, 'contributed = 4 x $100');
  // j=1: notional=200, fee=2, units=(200-2)/100=1.98
  // j=2: notional=100, fee=1, units += 99/110 -> units=1.98+0.9=2.88
  // j=3: sell all 2.88 units at 90 -> notional=259.2, fee=2.592
  near(r.costPaid, 2 + 1 + 2.592, 1e-6, 'cost paid on every trade (buy, buy, sell)');
  // finalValue: cash after j=3 = 100 (week4 contribution) + (259.2 - 2.592) = 356.608; units=0
  near(r.finalValue, 356.608, 1e-6, 'final account value');
  near(r.rows[1].units, 1.98, 1e-9, 'units after first buy');
  near(r.rows[2].units, 2.88, 1e-9, 'units after second buy');
  near(r.rows[3].units, 0, 1e-12, 'units after sell-to-flat');
  near(r.rows[3].cash, 356.608, 1e-6, 'cash after sell-to-flat');
  assert.ok(r.maxDD >= 0, 'maxDD computed without error');
});

check('simulateDCA: plain-DCA arm (always long) never sells and pays cost on every weekly buy', () => {
  const alwaysLong = [true, true, true, null];
  const r = simulateDCA(dcaBars, alwaysLong, { contribution: 100, costPerSide: 0.01 });
  near(r.contributed, 400, 1e-9, 'contributed = 4 x $100');
  assert.strictEqual(r.rows.every((row) => row.cash < 1e-6 || row === r.rows[0]), true, 'cash deployed same bar once long');
  // j=0: decision null -> flat, contribution sits as cash (100, 0 units)
  near(r.rows[0].cash, 100, 1e-9, 'week 0 not yet invested (no decision before first bar)');
  near(r.rows[0].units, 0, 1e-12, 'week 0 no units yet');
});

// ---------------------------------------------------------------------- (5) xirr sanity

check('xirr: single contribution + terminal value reduces to the compound-growth rate', () => {
  const t0 = Date.UTC(2021, 0, 1), t1 = Date.UTC(2022, 0, 1); // exactly 365 days (2021 is not a leap year)
  const cashflows = [{ t: t0, amount: -100 }, { t: t1, amount: 150 }];
  const r = xirr(cashflows);
  near(r, 0.5, 1e-6, 'IRR = 50% for an exact 1-year 100 -> 150 cashflow pair');
});

console.log(`\n${pass} check(s) passed`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
