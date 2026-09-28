// R3 significance test acceptance checks (WP3, research only). Plain asserts, matches the style
// of other test-*.js files in this repo.
import assert from 'node:assert';
import { buildRuleReturnSeries, runSignificanceTest, stationaryBootstrapMeans } from './scripts/research/harness/significance.js';
import { makeRng, mean } from './scripts/research/harness/stats-lib.js';

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

// ---------------------------------------------------------------------- (1) hand-computed tiny case

check('(1) hand-computed rule-return series on a 4-close toy example', () => {
  const closes = [100, 110, 99, 108];
  const signals = [1, -1, 1, 0]; // last one dropped (paired with a return that doesn't exist)
  const built = buildRuleReturnSeries(signals, closes);

  // Independent computation straight from the formula (log(next/prev), detrend by the sample
  // mean, multiply by the signal), not calling into buildRuleReturnSeries's own code.
  const lr = [Math.log(110 / 100), Math.log(99 / 110), Math.log(108 / 99)];
  const m = (lr[0] + lr[1] + lr[2]) / 3;
  const detrended = lr.map((x) => x - m);
  const ruleReturns = [signals[0] * detrended[0], signals[1] * detrended[1], signals[2] * detrended[2]];
  const observedMean = (ruleReturns[0] + ruleReturns[1] + ruleReturns[2]) / 3;

  near(built.meanLogReturn, m, 1e-12, 'meanLogReturn');
  near(built.observedMean, observedMean, 1e-12, 'observedMean');
  for (let i = 0; i < 3; i++) near(built.ruleReturns[i], ruleReturns[i], 1e-12, `ruleReturns[${i}]`);
});

check('(1b) net-of-cost subtracts a switch cost only on bars where the signal changed', () => {
  const closes = [100, 100, 100, 100, 100]; // flat prices: any nonzero net effect is pure cost
  const signals = [1, 1, -1, -1, 0]; // switches at t=0 (flat->long) and t=2 (long->short)
  const gross = buildRuleReturnSeries(signals, closes, { costPerSidePct: 0 });
  const net = buildRuleReturnSeries(signals, closes, { costPerSidePct: 0.15 });
  // With flat prices, gross log returns are all exactly 0 -> gross observedMean is 0.
  near(gross.observedMean, 0, 1e-12, 'gross observedMean on flat prices');
  // Net must differ (costs were charged) and adjLogReturns must be negative at both switch bars.
  assert.ok(net.observedMean !== gross.observedMean, 'net-of-cost observedMean must differ from gross on switch bars');
  const costLog = Math.log(1 - 0.0015);
  near(net.adjLogReturns[0], costLog, 1e-12, 'switch cost at t=0 (flat->long, |Δ|=1)');
  near(net.adjLogReturns[1], 0, 1e-12, 'no switch at t=1');
  near(net.adjLogReturns[2], 2 * costLog, 1e-12, 'switch cost at t=2 (long->short, |Δ|=2)');
});

// ---------------------------------------------------------------------- (2) determinism

check('(2) same seed + same data -> bit-identical result', () => {
  const rng = makeRng(7);
  const n = 200;
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + (rng() - 0.5) * 0.01));
  const signals = Array.from({ length: n }, () => (rng() < 0.5 ? 1 : -1));

  const a = runSignificanceTest(signals, closes, { nSimulations: 300, seed: 42, meanBlockLength: 10 });
  const b = runSignificanceTest(signals, closes, { nSimulations: 300, seed: 42, meanBlockLength: 10 });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'identical seed+data must reproduce identical output');

  const c = runSignificanceTest(signals, closes, { nSimulations: 300, seed: 43, meanBlockLength: 10 });
  assert.notStrictEqual(JSON.stringify(a), JSON.stringify(c), 'different seed should (almost certainly) change the bootstrap draw');
});

check('(2b) stationaryBootstrapMeans is deterministic and every mean is finite', () => {
  const centered = Array.from({ length: 50 }, (_, i) => Math.sin(i) * 0.01);
  const a = stationaryBootstrapMeans(centered, { nSimulations: 100, seed: 1, meanBlockLength: 10 });
  const b = stationaryBootstrapMeans(centered, { nSimulations: 100, seed: 1, meanBlockLength: 10 });
  assert.deepStrictEqual(Array.from(a), Array.from(b));
  assert.ok(Array.from(a).every(Number.isFinite), 'all simulated means finite');
});

// ---------------------------------------------------------------------- (3) random +-1 series -> p ~ uniform

check('(3) random signal, no real relationship to returns -> p-value roughly uniform over 50 data seeds', () => {
  const N_TRIALS = 50;
  const pValues = [];
  for (let s = 0; s < N_TRIALS; s++) {
    const dataRng = makeRng(1000 + s);
    const n = 250;
    const closes = [100];
    for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + (dataRng() - 0.5) * 0.01));
    const signals = Array.from({ length: n }, () => (dataRng() < 0.5 ? 1 : -1)); // independent of returns
    const r = runSignificanceTest(signals, closes, { nSimulations: 500, seed: 42, meanBlockLength: 10 });
    pValues.push(r.pValue);
  }
  const m = mean(pValues);
  const fracBelow05 = pValues.filter((p) => p < 0.05).length / N_TRIALS;
  // A well-calibrated test gives p ~ Uniform(0,1) under H0: mean ~0.5, ~5% below 0.05. With only
  // 50 draws we allow generous slack (this is a calibration sanity check, not a precise KS test).
  assert.ok(m > 0.25 && m < 0.75, `mean p-value should be roughly central, got ${m}`);
  assert.ok(fracBelow05 <= 0.30, `fraction of p<0.05 should not be wildly inflated under H0, got ${fracBelow05}`);
});

// ---------------------------------------------------------------------- (4) injected edge -> p < 0.01

check('(4) injected-edge synthetic series gives p < 0.01', () => {
  const rng = makeRng(99);
  const n = 500;
  const signals = new Array(n);
  const logReturns = new Array(n);
  for (let t = 0; t < n; t++) {
    const sign = t % 2 === 0 ? 1 : -1;
    signals[t] = sign;
    const noise = (rng() - 0.5) * 0.002; // +/-0.1%
    logReturns[t] = sign * 0.003 + noise; // the sign genuinely predicts the next return
  }
  const closes = [100];
  for (let t = 0; t < n; t++) closes.push(closes[t] * Math.exp(logReturns[t]));

  const r = runSignificanceTest([...signals, 0], closes, { nSimulations: 2000, seed: 42, meanBlockLength: 10 });
  assert.ok(r.observedMean > 0, `expected a positive observed mean, got ${r.observedMean}`);
  assert.ok(r.pValue < 0.01, `expected p < 0.01 for an injected edge, got ${r.pValue}`);
});

console.log(`\n${pass} check(s) passed.`);
