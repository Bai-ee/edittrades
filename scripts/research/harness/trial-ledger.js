// Card 4.2 - Global trial ledger + deflated Sharpe ratio (Bailey & Lopez de Prado 2014,
// "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and
// Non-Normality", Journal of Portfolio Management 40(5)). Research only.
//
// Formula (documented here in full; implemented in deflatedSharpeRatio() below):
//
//   SR0 = sqrt(V[{SR_n}]) * [ (1-gamma) * Z^-1(1 - 1/N) + gamma * Z^-1(1 - 1/(N*e)) ]
//
//     gamma  = Euler-Mascheroni constant (0.5772156649...)
//     Z^-1   = inverse standard normal CDF (probit)
//     N      = number of independent trials run before this one was selected
//     V[{SR_n}] = cross-sectional variance of the (estimated) Sharpe ratios of those N trials -
//                 this is the paper's proxy for "the variance a zero-skill Sharpe estimator would
//                 have shown by chance across N trials". SR0 is the EXPECTED MAXIMUM Sharpe ratio
//                 achievable by chance alone given N trials - the benchmark the selected
//                 strategy must beat, not zero.
//
//   DSR = PSR(SR0) = Phi( (SR_hat - SR0) * sqrt(T-1) / sqrt(1 - gamma3*SR_hat + ((gamma4-1)/4)*SR_hat^2) )
//
//     SR_hat = the selected strategy's own observed (non-annualized, per-period) Sharpe ratio
//     T      = number of return observations used to estimate SR_hat
//     gamma3 = skewness of the strategy's per-period returns
//     gamma4 = kurtosis (NOT excess; a normal distribution has kurtosis=3) of those returns
//     Phi    = standard normal CDF
//
//   DSR is the probability that the strategy's TRUE Sharpe ratio exceeds SR0 (the chance
//   benchmark), correcting simultaneously for (a) how many trials were tried before this one was
//   picked (SR0 grows with N), and (b) non-normality of the return series (the PSR denominator).
//
// V[{SR_n}] approximation used here (documented deviation - see docs/research/harness/
// WP3_STATS.md "DSR approximations"): we do not have full per-trial return series for every
// trial category in the ledger (only summary stats survive for most of them). Where a genuine
// per-trial Sharpe-like statistic IS available - the edge-search rounds (var/edge/train-r1.json,
// var/edge/train.json), which report a per-config t-statistic `t = mean/(sd/sqrt(n))`, i.e.
// SR_trial = t/sqrt(n) - we use the cross-sectional variance of those 52 SR_trial estimates as
// the V[{SR_n}] plug-in. This is an approximation (those 52 trials are not the same trials being
// deflated), documented, not a claim that it equals the true sampling variance of the SMA200/840
// Sharpe estimator specifically.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from '../edge/lib.js';
import { runSma4h } from '../edge/sma4h-trend.js';
import { mean, variance, skewness, kurtosis, sharpeRatio, normalCdf, normalInvCdf, EULER_MASCHERONI } from './stats-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAIN_REPO_ROOT = path.resolve(REPO_ROOT, '..', 'snapshot_tradingview'); // read-only sibling checkout

// ---------------------------------------------------------------------------- deflated Sharpe ratio

/**
 * @param {{srHat:number, T:number, skew:number, kurt:number, nTrials:number, varSrTrials:number}} p
 * @returns {{sr0:number, z:number, dsr:number}}
 */
export function deflatedSharpeRatio({ srHat, T, skew, kurt, nTrials, varSrTrials }) {
  if (nTrials < 1) throw new Error('nTrials must be >= 1');
  if (T < 2) throw new Error('T must be >= 2');
  const gamma = EULER_MASCHERONI;
  const sr0 = nTrials <= 1 || varSrTrials <= 0
    ? 0 // a single trial (or a zero-dispersion set of trials) has no selection-bias benchmark to beat
    : Math.sqrt(varSrTrials) * ((1 - gamma) * normalInvCdf(1 - 1 / nTrials) + gamma * normalInvCdf(1 - 1 / (nTrials * Math.E)));
  const denomSq = 1 - skew * srHat + ((kurt - 1) / 4) * srHat * srHat;
  const denom = Math.sqrt(Math.max(1e-12, denomSq));
  const z = (srHat - sr0) * Math.sqrt(T - 1) / denom;
  const dsr = normalCdf(z);
  return { sr0, z, dsr };
}

// ---------------------------------------------------------------------------- per-trial Sharpe proxy (edge-search)

function loadEdgeSearchSharpeProxies() {
  const files = [
    { file: path.join(REPO_ROOT, 'var/edge/train-r1.json'), label: 'edge-search-round1' },
    { file: path.join(REPO_ROOT, 'var/edge/train.json'), label: 'edge-search-round2' },
  ];
  const proxies = [];
  const counts = {};
  for (const { file, label } of files) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    counts[label] = raw.rows.length;
    for (const row of raw.rows) {
      if (typeof row.t === 'number' && typeof row.n === 'number' && row.n > 0 && Number.isFinite(row.t)) {
        proxies.push(row.t / Math.sqrt(row.n)); // SR_trial ~= t / sqrt(n), since t = SR*sqrt(n)
      }
    }
  }
  return { proxies, counts };
}

// ---------------------------------------------------------------------------- daily resample of a runSma4h series

/** Resample a runSma4h() `series` (per-4h-bar eqNet) to end-of-UTC-day equity, then return the
 * day-over-day simple returns. T = number of daily returns. */
export function dailyReturnsFromSeries(series) {
  if (!series.length) return [];
  const dayEndEq = [];
  let curDay = null, lastEq = null;
  for (const s of series) {
    const day = new Date(s.t).toISOString().slice(0, 10);
    if (day !== curDay) {
      if (curDay !== null) dayEndEq.push(lastEq);
      curDay = day;
    }
    lastEq = s.eqNet;
  }
  dayEndEq.push(lastEq);
  const rets = [];
  for (let i = 1; i < dayEndEq.length; i++) rets.push(dayEndEq[i] / dayEndEq[i - 1] - 1);
  return rets;
}

// ---------------------------------------------------------------------------- ledger

const SMA_SENSITIVITY_N = [125, 150, 175, 200, 225, 250, 300]; // registered in EXTERNAL_4H_SMA200_STATUS.md

export function buildLedgerCategories() {
  const edgeSearch = loadEdgeSearchSharpeProxies();
  const swingRuleCount = readdirSync(path.join(REPO_ROOT, 'docs/swing')).filter((f) => f.endsWith('.json')).length;

  let replayVariantCount;
  try {
    replayVariantCount = readdirSync(path.join(MAIN_REPO_ROOT, 'var/replay-rules')).filter((f) => f.endsWith('.summary.json')).length;
  } catch {
    replayVariantCount = 13; // fallback if the sibling checkout is unavailable: V0..V7,V1a-c,V3a-b,V-B,V-D per the WP3 brief
  }

  const categories = [
    { id: 'edge-search-round1', source: 'var/edge/train-r1.json (train phase)', count: edgeSearch.counts['edge-search-round1'], note: 'Round 1 edge-search grid, per-config n/mean/t reported directly.' },
    { id: 'edge-search-round2', source: 'var/edge/train.json (train phase)', count: edgeSearch.counts['edge-search-round2'], note: 'Round 2 edge-search grid, same schema.' },
    { id: 'swing-rules', source: 'docs/swing/*.json', count: swingRuleCount, note: 'One registered rule study per file (aggregate stats only, no per-trial t-stat).' },
    { id: 'replay-rules-variants', source: '../snapshot_tradingview/var/replay-rules/*.summary.json', count: replayVariantCount, note: 'Engine replay variants V0..V7 (V1a/b/c, V3a/b), V-B, V-D, 15-day window.' },
    { id: 'sma-sensitivity', source: 'docs/research/EXTERNAL_4H_SMA200_STATUS.md sensitivity section', count: SMA_SENSITIVITY_N.length * 3, note: `N in {${SMA_SENSITIVITY_N.join(',')}} x {BTC,ETH,SOL}, S3 costs.` },
    { id: 'card4-exploratory-20week', source: 'docs/research/RESEARCH_BACKLOG.md Card 4 exploratory table', count: 6, note: '{BTC,ETH,SOL} x {SMA200, 20-week SMA(N=840)}, 2020-23/2024-26 split reported but not counted as separate trials.' },
    { id: 'card7-exploratory-sma140-z', source: 'docs/research/RESEARCH_BACKLOG.md Card 7 (PeterLP123 vol-normalized trend z)', count: 9, note: 'Count taken from the report text ("6 of 9 rows", "8 of 9") - the exact per-row breakdown was not preserved as data, only the count. Documented deviation.' },
  ];
  const totalTrials = categories.reduce((s, c) => s + c.count, 0);
  return { categories, totalTrials, edgeSearchProxies: edgeSearch.proxies };
}

/** Build the {srHat,T,skew,kurt} inputs for one SMA(n) x symbol combo, from var/edge/4h-long. */
export function dsrInputsForSma(symbol, n, dir) {
  const bars = loadBars(symbol, '4h', dir || path.join(REPO_ROOT, 'var/edge/4h-long'));
  const r = runSma4h(bars, { n, costPerSide: 0.0015 });
  const daily = dailyReturnsFromSeries(r.series);
  return {
    srHat: sharpeRatio(daily),
    T: daily.length,
    skew: skewness(daily),
    kurt: kurtosis(daily),
  };
}

export function buildFullLedger(opts = {}) {
  const { categories, totalTrials, edgeSearchProxies } = buildLedgerCategories();
  const varSrTrials = variance(edgeSearchProxies); // sample variance (ddof=1) of the 52 SR proxies

  const targets = [];
  for (const symbol of ['BTC', 'ETH', 'SOL']) {
    for (const n of [200, 840]) {
      const inputs = dsrInputsForSma(symbol, n, opts.dir);
      const result = deflatedSharpeRatio({ ...inputs, nTrials: totalTrials, varSrTrials });
      targets.push({ target: `SMA${n}-${symbol}`, ...inputs, ...result });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    categories,
    totalTrials,
    sharpeProxy: { source: 'edge-search t / sqrt(n), 52 configs', n: edgeSearchProxies.length, variance: varSrTrials, mean: mean(edgeSearchProxies) },
    dsr: targets,
  };
}

// ---------------------------------------------------------------------------- CLI

//   node scripts/research/harness/trial-ledger.js [--out var/research/wp3]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
  const outDir = path.join(REPO_ROOT, args.out || 'var/research/wp3');
  mkdirSync(outDir, { recursive: true });

  const ledger = buildFullLedger();
  writeFileSync(path.join(outDir, 'trial-ledger.json'), JSON.stringify(ledger, null, 2));

  console.log('\n### Card 4.2 trial ledger\n');
  console.log('| category | source | count |');
  console.log('| --- | --- | --- |');
  for (const c of ledger.categories) console.log(`| ${c.id} | ${c.source} | ${c.count} |`);
  console.log(`\n**Total trials: ${ledger.totalTrials}**\n`);
  console.log(`Sharpe-proxy variance (edge-search, n=${ledger.sharpeProxy.n}): ${ledger.sharpeProxy.variance.toExponential(4)}\n`);

  console.log('### Deflated Sharpe ratio - SMA200 / SMA840 spot, BTC/ETH/SOL (daily-sampled)\n');
  console.log('| target | SR_hat (daily) | T (days) | skew | kurtosis | SR0 (chance benchmark) | DSR |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of ledger.dsr) {
    console.log(`| ${r.target} | ${r.srHat.toFixed(4)} | ${r.T} | ${r.skew.toFixed(3)} | ${r.kurt.toFixed(3)} | ${r.sr0.toFixed(4)} | ${r.dsr.toFixed(4)} |`);
  }
  console.log(`\nWrote ${path.relative(REPO_ROOT, path.join(outDir, 'trial-ledger.json'))}`);
}
