// R7 - Candle Monte Carlo: moving-block bootstrap of (Δlog close, Δlog high-rel, Δlog low-rel)
// tuples, used to synthesize N alternate 4h price paths and rerun a frozen strategy (runSma4h)
// on each, so a trend rule's headline CAGR/maxDD can be compared against a distribution instead
// of the one realized history. Research only.
//
// Source read at the pinned SHA (jesse-ai/jesse @ 840beb9): the *shape* of this is Jesse's
// MovingBlockBootstrapCandlesPipeline (jesse/candle_pipelines/moving_block_bootstrap.py) - a
// fixed-length moving-block bootstrap over multivariate (delta_close, delta_high, delta_low)
// tuples, blocks tiled (with replacement, uniformly-random starts) until the target length is
// reached. Two deliberate deviations, documented in docs/research/harness/WP3_STATS.md:
//   - Jesse's deltas are ABSOLUTE (close[i]-close[i-1], high[i]-close[i], close[i]-low[i]) on
//     1-minute candles inside its own engine. The WP3 brief calls for LOG deltas on 4h bars
//     (matches this repo's own convention - see scripts/research/edge/sma4h-trend.js's log-free
//     but ratio-based bar math, and significance.js's log returns), and high/low are expressed
//     RELATIVE TO THAT BAR'S OWN CLOSE, not the previous close.
//   - Jesse derives its block length from `batch_size // 10`; this harness registers a fixed
//     block length (30 bars = 5 days on 4h) up front, with a sensitivity sweep at 10/90, per the
//     WP3 brief (short blocks destroy trend persistence and bias trend-following rules toward
//     failure by construction - this is stated as a warning, not swept away).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from '../edge/lib.js';
import { runSma4h, barsFromCandles } from '../edge/sma4h-trend.js';
import { makeRng, summarize } from './stats-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------- deltas

/**
 * (Δlog close, Δlog high-relative, Δlog low-relative) tuples, one per bar i=1..n-1.
 * dClose[k]   = log(close[i]/close[i-1])   - the bar's own log return
 * dHighRel[k] = log(high[i]/close[i])      - that bar's high excursion above its own close
 * dLowRel[k]  = log(low[i]/close[i])       - that bar's low excursion below its own close
 * (k = i-1, so index 0 of the output corresponds to bar 1 of the input.)
 */
export function buildDeltaTuples(bars) {
  const n = bars.n;
  const m = Math.max(0, n - 1);
  const dClose = new Float64Array(m), dHighRel = new Float64Array(m), dLowRel = new Float64Array(m);
  for (let i = 1; i < n; i++) {
    const k = i - 1;
    dClose[k] = Math.log(bars.c[i] / bars.c[i - 1]);
    dHighRel[k] = Math.log(bars.h[i] / bars.c[i]);
    dLowRel[k] = Math.log(bars.l[i] / bars.c[i]);
  }
  return { dClose, dHighRel, dLowRel };
}

// ---------------------------------------------------------------------------- moving-block bootstrap

/**
 * Fixed-length moving-block bootstrap: tile contiguous blocks of `blockLength` SOURCE indices,
 * with uniformly-random start positions (blocks may overlap and repeat), until `targetLength`
 * indices are produced, then truncate to exactly `targetLength`. Mirrors Jesse's
 * `_bootstrap_blocks` (moving_block_bootstrap.py).
 *
 * @returns {Int32Array} indices into the source deltas array, length targetLength.
 */
export function movingBlockBootstrapIndices(nSource, targetLength, blockLength, rng) {
  if (nSource <= 0) return new Int32Array(0);
  const effectiveBlockLength = Math.max(1, Math.min(blockLength, nSource));
  const maxStart = nSource - effectiveBlockLength;
  const numBlocks = Math.ceil(targetLength / effectiveBlockLength) + 1;
  const out = new Int32Array(numBlocks * effectiveBlockLength);
  let w = 0;
  for (let b = 0; b < numBlocks; b++) {
    const start = Math.floor(rng() * (maxStart + 1));
    for (let j = 0; j < effectiveBlockLength; j++) out[w++] = start + j;
  }
  return out.slice(0, targetLength);
}

/**
 * Synthesize one alternate 4h path of length `pathLength` bars (plus an anchor bar) by
 * moving-block bootstrapping the source bars' delta tuples and rebuilding OHLC from them.
 * Returned in the same {n,t,ct,o,h,l,c,v} shape as loadBars()/barsFromCandles(), so it can be
 * fed straight into runSma4h. Timestamps are copied from the SOURCE bars (same 4h grid) so
 * runSma4h's bar-count-based CAGR/hold-time math is unaffected by the synthetic path's dates.
 *
 * @param {object} bars - real bars (source of the deltas and of the timestamp grid).
 * @param {{blockLength?:number, seed?:number, pathLength?:number, anchor?:number}} opts
 */
export function synthesizePath(bars, opts = {}) {
  const { blockLength = 30, seed = 42, pathLength = bars.n - 1, anchor = 100 } = opts;
  const { dClose, dHighRel, dLowRel } = buildDeltaTuples(bars);
  const rng = makeRng(seed);
  const idx = movingBlockBootstrapIndices(dClose.length, pathLength, blockLength, rng);

  const n = pathLength + 1; // +1 for the anchor bar
  const candles = new Array(n);
  candles[0] = { timestamp: bars.t[0], closeTime: bars.ct[0], open: anchor, high: anchor, low: anchor, close: anchor, volume: bars.v[0] || 0 };
  let prevClose = anchor;
  for (let i = 1; i < n; i++) {
    const k = idx[i - 1];
    const close = prevClose * Math.exp(dClose[k]);
    const open = prevClose; // no overnight gap in the reconstruction, matches Jesse's own pipeline
    let high = close * Math.exp(dHighRel[k]);
    let low = close * Math.exp(dLowRel[k]);
    // enforce a valid OHLC envelope (mirrors Jesse's own max/min.reduce enforcement step)
    high = Math.max(open, close, high);
    low = Math.min(open, close, low);
    candles[i] = { timestamp: bars.t[i], closeTime: bars.ct[i], open, high, low, close, volume: bars.v[i] || 0 };
    prevClose = close;
  }
  return barsFromCandles(candles);
}

// ---------------------------------------------------------------------------- runner

/**
 * Rerun runSma4h(N) on `nPaths` synthetic paths and summarize the CAGR / maxDD distribution
 * against the real (historical) result on `bars`.
 *
 * @param {object} bars - real 4h bars for one symbol.
 * @param {{n:number, blockLength?:number, nPaths?:number, seed?:number, costPerSide?:number}} opts
 */
export function runMonteCarlo(bars, opts = {}) {
  const { n, blockLength = 30, nPaths = 500, seed = 42, costPerSide = 0.0015 } = opts;
  const historical = runSma4h(bars, { n, costPerSide });

  const netCagrs = new Array(nPaths), maxDDs = new Array(nPaths), bhCagrs = new Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    const synthetic = synthesizePath(bars, { blockLength, seed: seed * 1_000_003 + p, pathLength: bars.n - 1 });
    const r = runSma4h(synthetic, { n, costPerSide });
    netCagrs[p] = r.netCagr;
    maxDDs[p] = r.maxDD;
    bhCagrs[p] = r.bhCagr;
  }

  return {
    n, blockLength, nPaths, seed, costPerSide,
    historical: { netCagr: historical.netCagr, maxDD: historical.maxDD, bhCagr: historical.bhCagr },
    synthetic: {
      netCagr: summarize(netCagrs),
      maxDD: summarize(maxDDs),
      bhCagr: summarize(bhCagrs),
    },
  };
}

// ---------------------------------------------------------------------------- CLI

//   node scripts/research/harness/montecarlo.js [--symbols BTC,ETH,SOL] [--n-paths 500]
//     [--block-length 30] [--seed 42] [--dir var/edge/4h-long] [--out var/research/wp3]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
  const symbols = (args.symbols || 'BTC,ETH,SOL').split(',');
  const nPaths = args['n-paths'] ? Number(args['n-paths']) : 500;
  const blockLength = args['block-length'] ? Number(args['block-length']) : 30;
  const seed = args.seed ? Number(args.seed) : 42;
  const dir = path.join(REPO_ROOT, args.dir || 'var/edge/4h-long');
  const outDir = path.join(REPO_ROOT, args.out || 'var/research/wp3');
  mkdirSync(outDir, { recursive: true });

  const results = {};
  for (const sym of symbols) {
    const bars = loadBars(sym, '4h', dir);
    results[sym] = {};
    for (const n of [200, 840]) {
      results[sym][`SMA${n}`] = runMonteCarlo(bars, { n, blockLength, nPaths, seed });
    }
  }

  // Block-length sensitivity (10/90 vs the registered 30), BTC SMA200 only - see
  // docs/research/harness/WP3_STATS.md "Scope of the sensitivity sweep".
  const btcBars = loadBars('BTC', '4h', dir);
  const sensitivity = [10, 30, 90].map((bl) => runMonteCarlo(btcBars, { n: 200, blockLength: bl, nPaths: Math.min(nPaths, 300), seed }));

  const out = { generatedAt: new Date().toISOString(), symbols, nPaths, registeredBlockLength: blockLength, seed, results, sensitivity };
  writeFileSync(path.join(outDir, 'montecarlo.json'), JSON.stringify(out, null, 2));

  console.log(`\n### R7 candle Monte Carlo - synthetic vs historical CAGR/maxDD (block length ${blockLength}, ${nPaths} paths, seed ${seed})\n`);
  console.log('| symbol | SMA | hist netCAGR | synth netCAGR p5/p50/p95 | hist maxDD | synth maxDD p5/p50/p95 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const sym of symbols) {
    for (const key of ['SMA200', 'SMA840']) {
      const r = results[sym][key];
      const pct = (x) => `${(x * 100).toFixed(1)}%`;
      console.log(`| ${sym} | ${key} | ${pct(r.historical.netCagr)} | ${pct(r.synthetic.netCagr.p5)}/${pct(r.synthetic.netCagr.p50)}/${pct(r.synthetic.netCagr.p95)} | ${pct(r.historical.maxDD)} | ${pct(r.synthetic.maxDD.p5)}/${pct(r.synthetic.maxDD.p50)}/${pct(r.synthetic.maxDD.p95)} |`);
    }
  }
  console.log(`\nWrote ${path.relative(REPO_ROOT, path.join(outDir, 'montecarlo.json'))}`);
}
