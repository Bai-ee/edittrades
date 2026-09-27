// R3 applied: runs significance.js (Jesse-method bootstrap, gross + net-of-cost) against the
// repo's own registered signals - SMA200 / SMA840 long-flat on 4h spot, daily EMA20 spot, and
// the re-flag-retest-1h swing rule's entry series (item 5 of the WP3 brief). Research only.
//
//   node scripts/research/harness/significance-apply.js [--out var/research/wp3]
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, ema } from '../edge/lib.js';
import { runSma4h } from '../edge/sma4h-trend.js';
import { runSignificanceTest, blockLengthSensitivity } from './significance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SYMBOLS = ['BTC', 'ETH', 'SOL'];
const SPOT_COST_PER_SIDE = 0.15; // % , per CLAUDE.md / BREAKEVEN_COSTS_2026-09-27.md
const SEED = 42;
const N_SIM = 2000;
const BLOCK_LENGTH = 10;

// ---------------------------------------------------------------------------- signal builders

/** SMA long/flat signal (+1/0), reusing runSma4h's own position decision - no reimplementation. */
function smaSignal(bars, n) {
  const r = runSma4h(bars, { n }); // full history, no window -> series covers every post-warm-up bar
  const closes = r.series.map((s) => s.close);
  const signals = r.series.map((s) => (s.position ? 1 : 0));
  return { closes, signals, nBars: r.series.length };
}

/** Daily EMA20 long/flat signal (+1/0). Same convention as spot-trend.js runFilter: decision at
 * bar i uses close[i] vs EMA(N)[i], applied to bar i's own forward return (log(close[i+1]/close[i])). */
function dailyEmaSignal(bars, n = 20) {
  const e = ema(bars.c, n);
  const closes = [], signals = [];
  for (let i = 0; i < bars.n; i++) {
    if (!Number.isFinite(e[i])) continue; // warm-up
    closes.push(bars.c[i]);
    signals.push(bars.c[i] > e[i] ? 1 : 0);
  }
  return { closes, signals, nBars: closes.length };
}

/** re-flag-retest-1h entry signal (+1 long / -1 short / 0 elsewhere), reconstructed against the
 * full 1h price history (test/fixtures/history/deep2y-2026-09-26). Every entry timestamp in the
 * study JSON was confirmed present in this fixture (see docs/research/harness/WP3_STATS.md). */
function reFlagRetestSignal(symbol) {
  const studyPath = path.join(REPO_ROOT, 'docs', 'swing', 're-flag-retest-1h.json');
  const study = JSON.parse(readFileSync(studyPath, 'utf8'));
  const perSym = study.perSymbol[symbol];
  if (!perSym || !Array.isArray(perSym.signals) || !perSym.signals.length) return null;

  const fixtureDir = path.join(REPO_ROOT, 'test', 'fixtures', 'history', 'deep2y-2026-09-26');
  const bars = loadBars(symbol, '1h', fixtureDir);
  const idxByT = new Map();
  for (let i = 0; i < bars.n; i++) idxByT.set(bars.t[i], i);

  const signals = new Array(bars.n).fill(0);
  let matched = 0, unmatched = 0;
  for (const sig of perSym.signals) {
    const t = Date.parse(sig.closedThrough);
    const idx = idxByT.get(t);
    if (idx == null) { unmatched += 1; continue; }
    matched += 1;
    signals[idx] = sig.direction === 'short' ? -1 : 1;
  }
  const closes = Array.from(bars.c);
  return { closes, signals, nBars: bars.n, matched, unmatched, totalEntries: perSym.signals.length };
}

// ---------------------------------------------------------------------------- run all targets

function runTarget(label, closes, signals) {
  const gross = runSignificanceTest(signals, closes, { nSimulations: N_SIM, seed: SEED, meanBlockLength: BLOCK_LENGTH, costPerSidePct: 0 });
  const net = runSignificanceTest(signals, closes, { nSimulations: N_SIM, seed: SEED, meanBlockLength: BLOCK_LENGTH, costPerSidePct: SPOT_COST_PER_SIDE });
  return { label, nBars: closes.length, gross, net };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
  const outDir = path.join(REPO_ROOT, args.out || 'var/research/wp3');
  mkdirSync(outDir, { recursive: true });

  const results = [];

  for (const sym of SYMBOLS) {
    const bars4h = loadBars(sym, '4h', path.join(REPO_ROOT, 'var/edge/4h-long'));
    const s200 = smaSignal(bars4h, 200);
    results.push({ target: `SMA200-4h-${sym}`, ...runTarget(`SMA200 4h ${sym}`, s200.closes, s200.signals), nBars: s200.nBars });
    const s840 = smaSignal(bars4h, 840);
    results.push({ target: `SMA840-4h-${sym}`, ...runTarget(`SMA840 4h ${sym}`, s840.closes, s840.signals), nBars: s840.nBars });

    const barsD = loadBars(sym, '1d', path.join(REPO_ROOT, 'var/edge/daily-long'));
    const ema20 = dailyEmaSignal(barsD, 20);
    results.push({ target: `dailyEMA20-${sym}`, ...runTarget(`daily EMA20 ${sym}`, ema20.closes, ema20.signals), nBars: ema20.nBars });

    const flagRes = reFlagRetestSignal(sym);
    if (flagRes) {
      const r = runTarget(`re-flag-retest-1h ${sym}`, flagRes.closes, flagRes.signals);
      results.push({ target: `re-flag-retest-1h-${sym}`, ...r, nBars: flagRes.nBars, entriesMatched: flagRes.matched, entriesUnmatched: flagRes.unmatched, totalEntries: flagRes.totalEntries });
    } else {
      results.push({ target: `re-flag-retest-1h-${sym}`, skipped: true, reason: 'no signals for symbol in docs/swing/re-flag-retest-1h.json' });
    }
  }

  // Block-length sensitivity (5/10/20) on two flagship targets, gross only (see WP3_STATS.md
  // "Scope of the sensitivity sweep" for why this is not run on all 12 targets).
  const btc4h = loadBars('BTC', '4h', path.join(REPO_ROOT, 'var/edge/4h-long'));
  const sma200Btc = smaSignal(btc4h, 200);
  const sensSma200Btc = blockLengthSensitivity(sma200Btc.signals, sma200Btc.closes, { nSimulations: N_SIM, seed: SEED, blockLengths: [5, 10, 20] });

  const flagBtc = reFlagRetestSignal('BTC');
  const sensFlagBtc = blockLengthSensitivity(flagBtc.signals, flagBtc.closes, { nSimulations: N_SIM, seed: SEED, blockLengths: [5, 10, 20] });

  const out = {
    generatedAt: new Date().toISOString(),
    seed: SEED, nSimulations: N_SIM, registeredBlockLength: BLOCK_LENGTH, costPerSidePct: SPOT_COST_PER_SIDE,
    results,
    sensitivity: {
      'SMA200-4h-BTC': sensSma200Btc.map((r) => ({ meanBlockLength: r.meanBlockLength, observedMean: r.observedMean, pValue: r.pValue, percentile: r.percentile })),
      're-flag-retest-1h-BTC': sensFlagBtc.map((r) => ({ meanBlockLength: r.meanBlockLength, observedMean: r.observedMean, pValue: r.pValue, percentile: r.percentile })),
    },
  };

  writeFileSync(path.join(outDir, 'significance.json'), JSON.stringify(out, null, 2));

  console.log('\n### R3 significance - gross vs net-of-cost (block length 10, seed 42, 2000 sims)\n');
  console.log('| target | n obs | observed mean (gross) | p (gross) | pctile (gross) | observed mean (net) | p (net) | pctile (net) |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    if (r.skipped) { console.log(`| ${r.target} | - | skipped: ${r.reason} | | | | | |`); continue; }
    console.log(`| ${r.target} | ${r.nBars} | ${r.gross.observedMean.toExponential(3)} | ${r.gross.pValue.toFixed(4)} | ${r.gross.percentile.toFixed(1)} | ${r.net.observedMean.toExponential(3)} | ${r.net.pValue.toFixed(4)} | ${r.net.percentile.toFixed(1)} |`);
  }
  console.log(`\nWrote ${path.relative(REPO_ROOT, path.join(outDir, 'significance.json'))}`);
}

main();
