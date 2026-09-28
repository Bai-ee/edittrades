// Look-ahead and correctness tests for scripts/research/edge/sma4h-trend.js (research only).
// Plain asserts, matches the style of other test-*.js files in this repo.
import assert from 'node:assert';
import { runSma4h, barsFromCandles } from './scripts/research/edge/sma4h-trend.js';

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

// ---------------------------------------------------------------------- fixture (N=3, hand-computable)
// Indices 0-2: flat warm-up (SMA3 needs 3 closes). Index 3: close breaks above the (still-lagging)
// SMA -> entry fills at bar 4's OPEN (deliberately gapped away from bar 3's close, to prove the
// entry-bar formula uses open[i+1], not close[i]). Index 6: close breaks back below the SMA ->
// exit fills at bar 7's OPEN (again gapped from bar 6's close, and bar 7's own close is
// deliberately wild to prove the exit-bar formula ignores it). Index 8-9: re-entry.
function makeFixtureCandles(n = 10, overrides = {}) {
  const base = [
    { o: 10, c: 10 }, // 0
    { o: 10, c: 10 }, // 1
    { o: 10, c: 10 }, // 2  sma3=10
    { o: 10, c: 16 }, // 3  decision(j=3): c2(10) > sma2(10)? no -> flat
    { o: 20, c: 24 }, // 4  decision used c3(16) > sma3(12) -> ENTRY, fill o4=20 (gap from c3=16)
    { o: 24, c: 30 }, // 5  continuing long
    { o: 30, c: 18 }, // 6  continuing long (decision used c5=30 > sma5=23.33)
    { o: 14, c: 12 }, // 7  decision used c6(18) > sma6(24)? no -> EXIT, fill o7=14 (gap from c6=18)
    { o: 12, c: 25 }, // 8  continuing flat (decision used c7=12 > sma7=20? no)
    { o: 25, c: 25 } // 9  decision used c8=25 > sma8=18.33 -> ENTRY, fill o9=25 (still open at end)
  ];
  const rows = base.slice(0, n).map((r, i) => ({ ...r, ...(overrides[i] || {}) }));
  return rows.map((r, i) => ({ timestamp: i * MS_4H, open: r.o, high: Math.max(r.o, r.c), low: Math.min(r.o, r.c), close: r.c, volume: 1, closeTime: (i + 1) * MS_4H }));
}

const fixtureBars = barsFromCandles(makeFixtureCandles());

// ---------------------------------------------------------------------- (iii) hand-computable fixture

check('(iii) hand-computed entries/exits/equity/costs on the N=3 fixture', () => {
  const r = runSma4h(fixtureBars, { n: 3, costPerSide: 0, borrowPerHour: 0 });
  assert.strictEqual(r.entries, 2, 'two entries (bar4, bar9)');
  assert.strictEqual(r.exits, 1, 'one exit (bar7)');
  assert.strictEqual(r.series.length, 7, 'series covers bars 3..9');

  const eqNet = r.series.map((s) => s.eqNet);
  const eqBh = r.series.map((s) => s.eqBh);
  const expectedNet = [1, 1.2, 1.5, 0.9, 0.7, 0.7, 0.7];
  const expectedBh = [1.6, 2.4, 3.0, 1.8, 1.2, 2.5, 2.5];
  expectedNet.forEach((v, i) => near(eqNet[i], v, 1e-9, `eqNet[${i}]`));
  expectedBh.forEach((v, i) => near(eqBh[i], v, 1e-9, `eqBh[${i}]`));

  const positions = r.series.map((s) => s.position);
  assert.deepStrictEqual(positions, [false, true, true, true, false, false, true]);

  near(r.maxDD, 8 / 15, 1e-9, 'maxDD');
  near(r.bhMaxDD, 0.6, 1e-9, 'bhMaxDD');

  assert.strictEqual(r.trades.length, 2, 'one closed trade + one still-open at series end');
  const closed = r.trades.find((t) => !t.open);
  assert.ok(closed, 'closed trade present');
  near(closed.entryPrice, 20, 1e-9);
  near(closed.exitPrice, 14, 1e-9);
  near(closed.ret, -0.3, 1e-9, 'closed trade return');
  near(closed.holdDays, 0.5, 1e-9);
  const open = r.trades.find((t) => t.open);
  assert.ok(open, 'open trade present');
  near(open.ret, 0, 1e-9, 'open trade marked flat at series end (entry bar itself)');

  near(r.win, 0, 1e-9, 'the only closed trade is a loss');
  near(r.avgLoss, 0.3, 1e-9);
  near(r.exposure, 4 / 7, 1e-9);
});

check('(iii) cost per side is applied exactly at each switch, nowhere else', () => {
  const cost = 0.01;
  const r0 = runSma4h(fixtureBars, { n: 3, costPerSide: 0, borrowPerHour: 0 });
  const rc = runSma4h(fixtureBars, { n: 3, costPerSide: cost, borrowPerHour: 0 });
  // Bar4 (entry) and bar7 (exit) are switch bars -> ratio vs the zero-cost run should be
  // exactly (1-cost) from that bar onward, cumulatively (one factor per switch crossed).
  near(rc.series[0].eqNet / r0.series[0].eqNet, 1, 1e-9, 'bar3: no switch yet');
  near(rc.series[1].eqNet / r0.series[1].eqNet, 1 - cost, 1e-9, 'bar4: entry cost applied');
  near(rc.series[2].eqNet / r0.series[2].eqNet, 1 - cost, 1e-9, 'bar5: cost carried, no new switch');
  near(rc.series[4].eqNet / r0.series[4].eqNet, (1 - cost) ** 2, 1e-9, 'bar7: exit cost stacks on entry cost');
});

// ---------------------------------------------------------------------- (i) no look-ahead: future bars

check('(i) appending future bars (incl. a huge spike) does not change any prior decision/position/equity', () => {
  const r1 = runSma4h(fixtureBars, { n: 3 });
  const future = makeFixtureCandles(10).concat([
    { timestamp: 10 * MS_4H, open: 25, high: 100000, low: 24, close: 100000, volume: 1, closeTime: 11 * MS_4H }, // huge spike
    { timestamp: 11 * MS_4H, open: 100000, high: 100000, low: 1, close: 1, volume: 1, closeTime: 12 * MS_4H },
    { timestamp: 12 * MS_4H, open: 1, high: 5, low: 1, close: 5, volume: 1, closeTime: 13 * MS_4H }
  ]);
  const r2 = runSma4h(barsFromCandles(future), { n: 3 });
  assert.strictEqual(r2.series.length > r1.series.length, true, 'extended run has more bars');
  for (let i = 0; i < r1.series.length; i += 1) {
    assert.deepStrictEqual(r2.series[i], r1.series[i], `series[${i}] must be identical after appending future bars`);
  }
  assert.strictEqual(r2.entries >= r1.entries, true);
});

// ---------------------------------------------------------------------- (ii) no look-ahead: mutate one bar

check('(ii) mutating bar i\'s close only changes fills from i+1 onward, never bar i\'s own (exit-bar) return', () => {
  const base = runSma4h(fixtureBars, { n: 3 });
  // Bar 7 is an EXIT bar: its own return uses open[7]/close[6], not close[7] -> mutating
  // close[7] must leave bar 7's own recorded return (and everything before it) untouched,
  // while still being free to change what happens from bar 8 (fill i+1) onward.
  const mutated = barsFromCandles(makeFixtureCandles(10, { 7: { c: 50 } }));
  const r2 = runSma4h(mutated, { n: 3 });

  // series indices 0..4 correspond to bars t3..t7 (5 entries: idx0=bar3 ... idx4=bar7).
  for (let i = 0; i <= 4; i += 1) {
    assert.strictEqual(r2.series[i].position, base.series[i].position, `position[${i}] unaffected`);
    near(r2.series[i].eqNet, base.series[i].eqNet, 1e-9, `eqNet[${i}] unaffected (bar7 exit return ignores its own close)`);
  }
  // From bar 8 (fill i+1 = 7+1) onward the decision can differ (c[7] shot up to 50, so the
  // strategy re-enters at bar 8 instead of staying flat).
  assert.notStrictEqual(r2.series[5].position, base.series[5].position, 'bar8 decision changes once c[7] changes');
});

// ---------------------------------------------------------------------- (iv) insufficient history

check('(iv) insufficient history (< N bars) produces no trades', () => {
  const shortBars = barsFromCandles(makeFixtureCandles(5)); // N=200 default, only 5 bars
  const r = runSma4h(shortBars, { n: 200 });
  assert.strictEqual(r.entries, 0);
  assert.strictEqual(r.trades.length, 0);
  assert.strictEqual(r.series.length, 0);
  assert.strictEqual(r.bars, 0);
});

// ---------------------------------------------------------------------- (v) staying above SMA -> one entry

check('(v) staying above the SMA the whole time yields exactly one entry, not many', () => {
  // Arithmetic sequence with constant +1 step: sma3[i] = c[i]-1 for i>=2, so close[i] > sma3[i]
  // holds for EVERY bar once defined -> exactly one entry, zero exits, continuously long.
  const K = 40;
  const candles = Array.from({ length: K }, (_, i) => ({ timestamp: i * MS_4H, open: 10 + i - 1, high: 10 + i, low: 10 + i - 1, close: 10 + i, volume: 1, closeTime: (i + 1) * MS_4H }));
  const bars = barsFromCandles(candles);
  const r = runSma4h(bars, { n: 3 });
  assert.strictEqual(r.entries, 1, 'exactly one entry');
  assert.strictEqual(r.exits, 0, 'never exits');
  assert.ok(r.series.every((s) => s.position === true), 'long on every reported bar');
});

console.log(`\n${pass} checks passed`);
if (process.exitCode) { console.error('SOME CHECKS FAILED'); } else { console.log('ALL CHECKS PASSED'); }
