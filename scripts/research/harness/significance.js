// R3 - Rule significance test, replicating jesse-ai/jesse's method exactly (research only).
//
// Source, read at the pinned SHA (see docs/research/harness/WP3_STATS.md "Source" section):
//   jesse-ai/jesse @ 840beb9cddddc35706adaba60557c1ba8e69b964
//   jesse/research/rule_significance_testing/{rule_significance.py,bootstrap.py}
//
// Method (ported line-for-line in spirit, see WP3_STATS.md for the deviation list):
//   1. log_returns[t]   = log(close[t+1] / close[t])                       (length n-1)
//   2. signals[t]       = the rule's own signal at bar t, +1/-1/0          (dropped: last bar)
//   3. detrended[t]     = log_returns[t] - mean(log_returns)               (removes drift)
//   4. rule_return[t]   = signals[t] * detrended[t]
//   5. observed_mean    = mean(rule_return)
//   6. stationary block bootstrap of (rule_return - observed_mean), 2000 resamples,
//      geometric block length (mean = meanBlockLength, restart probability = 1/meanBlockLength)
//   7. p_value          = fraction(simulated_means >= observed_mean)     (one-sided upper tail)
//      percentile       = 100 * fraction(simulated_means < observed_mean)
//
// Extension beyond Jesse (net-of-cost variant, item 1 of the WP3 brief): before step 1's
// detrending, a per-switch cost (log-return units) is subtracted from log_returns at every bar
// where the signal changed from the previous bar (see buildRuleReturnSeries). Jesse's own test
// has no notion of cost; this is our own addition, run alongside the gross (cost-free) result,
// never in place of it.
import { makeRng, mean, fractionGte, fractionLt, summarize } from './stats-lib.js';

// ---------------------------------------------------------------------------- core statistic

/** log(close[t+1]/close[t]) for t=0..n-2. */
export function logReturnsFromCloses(closes) {
  const n = closes.length;
  const out = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i < n - 1; i++) out[i] = Math.log(closes[i + 1] / closes[i]);
  return out;
}

/**
 * Build the rule-return series (Jesse §1-5 above), with an optional net-of-cost adjustment.
 *
 * @param {ArrayLike<number>} signalsIn - signal at bar t (+1/-1/0), same length as closes.
 * @param {ArrayLike<number>} closes
 * @param {{costPerSidePct?: number}} opts - costPerSidePct e.g. 0.15 for spot 0.15%/side.
 *   Charged (as a subtraction, in log-return units) at bar t whenever
 *   |signals[t] - signals[t-1]| > 0, scaled by that absolute signal change (so a long<->short
 *   flip, |change|=2, pays twice the single-side cost - i.e. an exit + an entry).
 */
export function buildRuleReturnSeries(signalsIn, closes, opts = {}) {
  const costPerSidePct = opts.costPerSidePct || 0;
  const logReturns = logReturnsFromCloses(closes);
  const nObs = logReturns.length;
  const signals = Float64Array.from(signalsIn).slice(0, nObs);

  let adjLogReturns = logReturns;
  if (costPerSidePct > 0) {
    adjLogReturns = new Float64Array(nObs);
    const costLog = Math.log(1 - costPerSidePct / 100); // negative
    for (let t = 0; t < nObs; t++) {
      const prevSignal = t === 0 ? 0 : signalsIn[t - 1];
      const switchMagnitude = Math.abs(signalsIn[t] - prevSignal);
      adjLogReturns[t] = logReturns[t] + switchMagnitude * costLog;
    }
  }

  const meanLogReturn = mean(adjLogReturns);
  const detrended = new Float64Array(nObs);
  for (let t = 0; t < nObs; t++) detrended[t] = adjLogReturns[t] - meanLogReturn;

  const ruleReturns = new Float64Array(nObs);
  for (let t = 0; t < nObs; t++) ruleReturns[t] = signals[t] * detrended[t];

  const observedMean = mean(ruleReturns);
  return { logReturns, adjLogReturns, meanLogReturn, detrended, signals, ruleReturns, observedMean, nObservations: nObs, costPerSidePct };
}

// ---------------------------------------------------------------------------- stationary block bootstrap
// Faithful port of jesse/research/rule_significance_testing/bootstrap.py's restart-probability
// construction (see file docstring). PRNG is mulberry32 (seeded, deterministic), not numpy's
// PCG64 - the ALGORITHM is identical, the raw numbers will differ from a literal Jesse run with
// "the same seed". Documented in WP3_STATS.md.

export function stationaryBootstrapMeans(centered, { nSimulations = 2000, seed = 42, meanBlockLength = 10 } = {}) {
  if (meanBlockLength < 1) throw new Error('meanBlockLength must be at least 1');
  const n = centered.length;
  const out = new Float64Array(nSimulations);
  if (n === 0) return out;
  const rng = makeRng(seed);
  const restartProbability = 1 / meanBlockLength;

  for (let s = 0; s < nSimulations; s++) {
    // Phase A: which observation indices restart a new block (index 0 always restarts).
    const restartPositions = [0];
    for (let i = 1; i < n; i++) {
      if (rng() < restartProbability) restartPositions.push(i);
    }
    // Phase B: a uniformly-random source index for each block (drawn after all restarts are
    // known, same two-phase order as bootstrap.py).
    const numBlocks = restartPositions.length;
    const blockStarts = new Int32Array(numBlocks);
    for (let b = 0; b < numBlocks; b++) blockStarts[b] = Math.floor(rng() * n);

    // Phase C: walk observation indices in order, tracking which block we are in (monotonic
    // in i, so a single advancing pointer suffices - equivalent to bootstrap.py's cumsum trick).
    let sum = 0;
    let bp = 0;
    for (let i = 0; i < n; i++) {
      if (bp + 1 < numBlocks && restartPositions[bp + 1] === i) bp += 1;
      const offset = i - restartPositions[bp];
      const idx = (blockStarts[bp] + offset) % n;
      sum += centered[idx];
    }
    out[s] = sum / n;
  }
  return out;
}

// ---------------------------------------------------------------------------- top-level test

/**
 * @param {ArrayLike<number>} signals - +1/-1/0 per bar.
 * @param {ArrayLike<number>} closes - same length as signals.
 * @param {{nSimulations?:number, seed?:number, meanBlockLength?:number, costPerSidePct?:number}} opts
 */
export function runSignificanceTest(signals, closes, opts = {}) {
  const { nSimulations = 2000, seed = 42, meanBlockLength = 10, costPerSidePct = 0 } = opts;
  const built = buildRuleReturnSeries(signals, closes, { costPerSidePct });
  const centered = new Float64Array(built.nObservations);
  for (let i = 0; i < built.nObservations; i++) centered[i] = built.ruleReturns[i] - built.observedMean;

  const simulatedMeans = stationaryBootstrapMeans(centered, { nSimulations, seed, meanBlockLength });
  const pValue = fractionGte(simulatedMeans, built.observedMean);
  const percentile = 100 * fractionLt(simulatedMeans, built.observedMean);

  return {
    observedMean: built.observedMean,
    pValue,
    percentile,
    nObservations: built.nObservations,
    nSignalsNonZero: built.signals.reduce((a, x) => a + (x !== 0 ? 1 : 0), 0),
    nSimulations,
    seed,
    meanBlockLength,
    costPerSidePct,
    simulatedMeansSummary: summarize(simulatedMeans),
  };
}

/** Convenience: run gross (cost-free) and net-of-cost side by side. */
export function runGrossAndNet(signals, closes, opts = {}) {
  const { costPerSidePct = 0.15, ...rest } = opts;
  const gross = runSignificanceTest(signals, closes, { ...rest, costPerSidePct: 0 });
  const net = runSignificanceTest(signals, closes, { ...rest, costPerSidePct });
  return { gross, net };
}

/** Sensitivity sweep over mean block length (registered default 10, sensitivity 5/20 per WP3 brief). */
export function blockLengthSensitivity(signals, closes, opts = {}) {
  const { blockLengths = [5, 10, 20], ...rest } = opts;
  return blockLengths.map((meanBlockLength) => runSignificanceTest(signals, closes, { ...rest, meanBlockLength }));
}

// ---------------------------------------------------------------------------- CLI (ad hoc use)
// node scripts/research/harness/significance.js --signals var/research/wp3/<file>.json
// Expects {signals:[...], closes:[...]} JSON. For the repo's actual applied targets (SMA200,
// SMA840, daily EMA20, re-flag-retest-1h) see significance-apply.js, which builds the signal
// series from the repo's own bar data instead of a hand-authored fixture file.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
  if (!args.signals) { console.error('Usage: --signals <file.json with {signals,closes}> [--seed N] [--n-sim N] [--block-length N] [--cost-per-side PCT]'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(args.signals, 'utf8'));
  const opts = {
    seed: args.seed ? Number(args.seed) : 42,
    nSimulations: args['n-sim'] ? Number(args['n-sim']) : 2000,
    meanBlockLength: args['block-length'] ? Number(args['block-length']) : 10,
    costPerSidePct: args['cost-per-side'] ? Number(args['cost-per-side']) : 0,
  };
  const result = runSignificanceTest(data.signals, data.closes, opts);
  console.log(JSON.stringify(result, null, 2));
}
