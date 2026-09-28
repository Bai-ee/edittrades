// Card 4.2 trial ledger + deflated Sharpe ratio acceptance checks (WP3, research only).
import assert from 'node:assert';
import { deflatedSharpeRatio, dailyReturnsFromSeries, buildLedgerCategories } from './scripts/research/harness/trial-ledger.js';
import { normalCdf, normalInvCdf } from './scripts/research/harness/stats-lib.js';

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

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) < eps, `${msg}: expected ${b}, got ${a} (diff ${Math.abs(a - b)})`);
}

// ---------------------------------------------------------------------- (1) normal-distribution primitives, known constants

check('(1) normalCdf matches well-known Z-table constants', () => {
  near(normalCdf(0), 0.5, 1e-9, 'Phi(0)');
  near(normalCdf(1.6448536), 0.95, 1e-4, 'Phi(1.6449) ~ 0.95 (one-sided 95%)');
  near(normalCdf(1.9599640), 0.975, 1e-4, 'Phi(1.9600) ~ 0.975 (one-sided 97.5% / two-sided 95%)');
  near(normalCdf(2.5758293), 0.995, 1e-4, 'Phi(2.5758) ~ 0.995');
  near(normalCdf(-1.6448536), 0.05, 1e-4, 'Phi(-1.6449) ~ 0.05 (symmetry)');
});

check('(1b) normalInvCdf round-trips normalCdf to within tolerance', () => {
  for (const x of [-2.5, -1, -0.1, 0.1, 1, 2.5]) {
    near(normalInvCdf(normalCdf(x)), x, 1e-6, `invCdf(cdf(${x}))`);
  }
  near(normalInvCdf(0.975), 1.9599640, 1e-4, 'invCdf(0.975)');
});

// ---------------------------------------------------------------------- (2) DSR hand-check on toy cases

check('(2) DSR = exactly 0.5 when SR_hat = 0 and there is no cross-trial dispersion (SR0 = 0)', () => {
  // With varSrTrials = 0, SR0 is forced to 0 regardless of nTrials (see deflatedSharpeRatio).
  // With SR_hat = 0 too, z = (0-0)*sqrt(T-1)/denom = 0 exactly, and Phi(0) = 0.5 exactly -
  // this is an exact arithmetic identity, not an approximation, so it is immune to any small
  // numerical error in the erf-based normalCdf implementation.
  const { dsr, sr0, z } = deflatedSharpeRatio({ srHat: 0, T: 500, skew: 0.3, kurt: 5, nTrials: 50, varSrTrials: 0 });
  assert.strictEqual(sr0, 0);
  assert.strictEqual(z, 0);
  // normalCdf(0) is ~0.5 to within the erf rational approximation's documented ~1.5e-7 error,
  // not bit-exact - see stats-lib.js's erf().
  near(dsr, 0.5, 1e-6, 'dsr');
});

check('(2b) DSR = exactly 0.5 when SR_hat = 0 and nTrials = 1 (no selection bias to correct for)', () => {
  const { dsr, sr0 } = deflatedSharpeRatio({ srHat: 0, T: 200, skew: 0, kurt: 3, nTrials: 1, varSrTrials: 0.02 });
  assert.strictEqual(sr0, 0, 'a single trial has no chance-of-the-best-of-N benchmark');
  near(dsr, 0.5, 1e-6, 'dsr');
});

check('(2c) DSR reproduces the classical PSR formula when varSrTrials = 0 (SR0 = 0) for a positive SR_hat, normal returns', () => {
  // Independent hand-computation of the exact same formula, done inline here rather than by
  // calling into the library, per the repo's "hand-computed tiny case" test convention.
  const srHat = 0.10, T = 101, skew = 0, kurt = 3;
  const denom = Math.sqrt(1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat); // = sqrt(1 + 0.5*srHat^2) for normal returns
  const zExpected = srHat * Math.sqrt(T - 1) / denom;
  const dsrExpected = normalCdf(zExpected);
  const { dsr, z } = deflatedSharpeRatio({ srHat, T, skew, kurt, nTrials: 50, varSrTrials: 0 });
  near(z, zExpected, 1e-9, 'z');
  near(dsr, dsrExpected, 1e-9, 'dsr');
  // Sanity: sqrt(1.005) denom, z = 0.1*10/1.0025 ~ 0.9975, Phi(0.9975) ~ 0.8407.
  near(dsr, 0.8407, 2e-3, 'dsr numeric ballpark vs a hand Z-table lookup');
});

check('(2d) more trials -> higher SR0 -> lower DSR, holding everything else fixed (monotonic deflation)', () => {
  const base = { srHat: 0.08, T: 500, skew: 0.2, kurt: 4, varSrTrials: 0.01 };
  const few = deflatedSharpeRatio({ ...base, nTrials: 5 });
  const many = deflatedSharpeRatio({ ...base, nTrials: 5000 });
  assert.ok(many.sr0 > few.sr0, `SR0 should grow with nTrials: ${many.sr0} vs ${few.sr0}`);
  assert.ok(many.dsr < few.dsr, `DSR should shrink as nTrials grows: ${many.dsr} vs ${few.dsr}`);
});

check('(2e) more return dispersion in the trial set (higher varSrTrials) also raises SR0 and lowers DSR', () => {
  const base = { srHat: 0.08, T: 500, skew: 0.2, kurt: 4, nTrials: 100 };
  const low = deflatedSharpeRatio({ ...base, varSrTrials: 0.001 });
  const high = deflatedSharpeRatio({ ...base, varSrTrials: 0.05 });
  assert.ok(high.sr0 > low.sr0);
  assert.ok(high.dsr < low.dsr);
});

// ---------------------------------------------------------------------- (3) daily resample

check('(3) dailyReturnsFromSeries collapses multiple same-day bars to one end-of-day return', () => {
  const series = [
    { t: Date.parse('2026-01-01T00:00:00Z'), eqNet: 1.00 },
    { t: Date.parse('2026-01-01T04:00:00Z'), eqNet: 1.02 },
    { t: Date.parse('2026-01-01T20:00:00Z'), eqNet: 1.05 }, // day 1 ends at 1.05
    { t: Date.parse('2026-01-02T00:00:00Z'), eqNet: 1.10 },
    { t: Date.parse('2026-01-02T20:00:00Z'), eqNet: 1.155 }, // day 2 ends at 1.155
  ];
  const rets = dailyReturnsFromSeries(series);
  assert.strictEqual(rets.length, 1); // 2 days -> 1 day-over-day return
  const expected = 1.155 / 1.05 - 1;
  const [actual] = rets;
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
});

check('(3b) dailyReturnsFromSeries returns an empty array for an empty series', () => {
  assert.deepStrictEqual(dailyReturnsFromSeries([]), []);
});

// ---------------------------------------------------------------------- (4) ledger category counts

check('(4) buildLedgerCategories sums to the trial count enumerated in the WP3 brief', () => {
  const { categories, totalTrials } = buildLedgerCategories();
  const byId = Object.fromEntries(categories.map((c) => [c.id, c.count]));
  assert.strictEqual(byId['edge-search-round1'], 38, 'round 1 = 38 configs per the brief');
  assert.strictEqual(byId['edge-search-round2'], 14, 'round 2 = 14 configs per the brief');
  assert.strictEqual(byId['swing-rules'], 17, 'docs/swing/*.json = 17 rules per the brief');
  assert.strictEqual(totalTrials, categories.reduce((s, c) => s + c.count, 0), 'totalTrials must equal the sum of category counts');
  assert.ok(totalTrials >= 100, `expected a substantial trial count, got ${totalTrials}`);
});

console.log(`\n${pass} check(s) passed.`);
