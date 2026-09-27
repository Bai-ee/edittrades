#!/usr/bin/env node
/**
 * WP5 item 2 (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md, R5): does the SMA200/SMA840
 * spot-trend result (docs/research/EXTERNAL_4H_SMA200_STATUS.md, sma4h-trend.js) depend on one
 * data vendor? Diffs OKX 4h spot candles (fetch-venue.js) against the existing Binance 4h spot
 * fixture (var/edge/4h-long, fetch-4h-long.js), then reruns runSma4h at N=200 and N=840,
 * 0.15%/side, on each venue over their common overlap window.
 *
 * Bybit is not included here: this host cannot reach it (403, CloudFront country block - see
 * var/edge/venues/bybit/manifest.json and docs/research/harness/WP5_VENUES.md).
 *
 * Command: node scripts/research/edge/cross-venue-check.js
 * Output:  var/research/cross-venue/{REPORT.md,rows.json}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from './lib.js';
import { runSma4h } from './sma4h-trend.js';

const SYMBOLS = ['BTC', 'ETH', 'SOL'];
const COST_PER_SIDE = 0.0015; // 0.15%/side, spot

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Close-price diff on shared timestamps + missing-bar counts each direction, within the overlap window. */
function diffCandles(a, b) {
  const bByT = new Map(); for (let i = 0; i < b.n; i += 1) bByT.set(b.t[i], b.c[i]);
  const overlapStart = Math.max(a.t[0], b.t[0]);
  const overlapEnd = Math.min(a.t[a.n - 1], b.t[b.n - 1]);
  const diffs = [];
  let matched = 0, missingInB = 0;
  for (let i = 0; i < a.n; i += 1) {
    if (a.t[i] < overlapStart || a.t[i] > overlapEnd) continue;
    const bc = bByT.get(a.t[i]);
    if (bc == null) { missingInB += 1; continue; }
    matched += 1;
    diffs.push((Math.abs(a.c[i] - bc) / bc) * 100);
  }
  const aByT = new Map(); for (let i = 0; i < a.n; i += 1) aByT.set(a.t[i], true);
  let missingInA = 0;
  for (let i = 0; i < b.n; i += 1) { if (b.t[i] >= overlapStart && b.t[i] <= overlapEnd && !aByT.has(b.t[i])) missingInA += 1; }
  return {
    overlapFrom: new Date(overlapStart).toISOString(), overlapTo: new Date(overlapEnd).toISOString(),
    matched, missingInSecondVenue: missingInB, missingInFirstVenue: missingInA,
    medianAbsDiffPct: median(diffs), meanAbsDiffPct: diffs.length ? diffs.reduce((s, x) => s + x, 0) / diffs.length : null,
    maxAbsDiffPct: diffs.length ? Math.max(...diffs) : null,
    p95AbsDiffPct: diffs.length ? [...diffs].sort((x, y) => x - y)[Math.floor(diffs.length * 0.95)] : null
  };
}

function runN(bars, n, fromMs, toMs) {
  const r = runSma4h(bars, { n, costPerSide: COST_PER_SIDE, borrowPerHour: 0, fromMs, toMs });
  return { netCagr: r.netCagr, bhCagr: r.bhCagr, sharpe: r.sharpe, maxDD: r.maxDD, entries: r.entries, bars: r.bars };
}

function main() {
  const outDir = 'var/research/cross-venue';
  fs.mkdirSync(outDir, { recursive: true });
  const rows = { diffs: {}, sma: {} };

  for (const sym of SYMBOLS) {
    const binance = loadBars(sym, '4h', 'var/edge/4h-long');
    const okxFile = `var/edge/venues/okx/${sym}_4h.json`;
    if (!fs.existsSync(okxFile)) { console.error(`skip ${sym}: ${okxFile} missing (run fetch-venue.js candles first)`); continue; }
    const okxRaw = JSON.parse(fs.readFileSync(okxFile, 'utf8')).candles;
    const okx = { n: okxRaw.length, t: okxRaw.map((c) => c.timestamp), o: okxRaw.map((c) => c.open), h: okxRaw.map((c) => c.high), l: okxRaw.map((c) => c.low), c: okxRaw.map((c) => c.close) };

    const d = diffCandles(okx, binance);
    rows.diffs[sym] = d;
    console.log(`[cross-venue] ${sym}: matched=${d.matched} missingInBinance=${d.missingInSecondVenue} missingInOkx=${d.missingInFirstVenue} medianAbsDiffPct=${d.medianAbsDiffPct?.toFixed(4)}%`);

    // Common overlap window (OKX starts later than Binance for every symbol here).
    const fromMs = Date.parse(d.overlapFrom), toMs = Date.parse(d.overlapTo);
    rows.sma[sym] = {};
    for (const n of [200, 840]) {
      rows.sma[sym][`N${n}`] = {
        binance_fullHistory: runN(binance, n, -Infinity, Infinity),
        binance_overlapWindow: runN(binance, n, fromMs, toMs),
        okx_overlapWindow: runN(okx, n, fromMs, toMs)
      };
    }
  }

  const pct = (x, d2 = 2) => (x == null ? 'n/a' : `${(x * 100).toFixed(d2)}%`);
  const out = [];
  out.push('## Cross-venue check — OKX spot vs Binance spot (4h)\n');
  out.push('Bybit candles are not included: this host cannot reach api.bybit.com (403, CloudFront country block - see var/edge/venues/bybit/manifest.json).\n');
  out.push('| symbol | overlap window | matched bars | missing in Binance | missing in OKX | median \\|Δclose\\| | mean \\|Δclose\\| | max \\|Δclose\\| | p95 \\|Δclose\\| |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const sym of SYMBOLS) {
    const d = rows.diffs[sym]; if (!d) continue;
    out.push(`| ${sym} | ${d.overlapFrom.slice(0, 10)} -> ${d.overlapTo.slice(0, 10)} | ${d.matched} | ${d.missingInSecondVenue} | ${d.missingInFirstVenue} | ${d.medianAbsDiffPct?.toFixed(4)}% | ${d.meanAbsDiffPct?.toFixed(4)}% | ${d.maxAbsDiffPct?.toFixed(4)}% | ${d.p95AbsDiffPct?.toFixed(4)}% |`);
  }
  out.push('');
  out.push('## SMA200 / SMA840 rerun on OKX vs Binance (0.15%/side, common overlap window per symbol)\n');
  out.push('"Binance full history" is the existing BREAKEVEN_COSTS_2026-09-27.md headline number (different, longer window) - shown for reference only, not for the venue comparison. The venue comparison is Binance vs OKX over the identical overlap window.\n');
  out.push('| symbol | N | Binance full-history netCAGR | Binance overlap netCAGR | OKX overlap netCAGR | Binance overlap Sharpe | OKX overlap Sharpe | Binance overlap maxDD | OKX overlap maxDD | Binance entries | OKX entries |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const sym of SYMBOLS) {
    if (!rows.sma[sym]) continue;
    for (const n of [200, 840]) {
      const s = rows.sma[sym][`N${n}`];
      out.push(`| ${sym} | ${n} | ${pct(s.binance_fullHistory.netCagr)} | ${pct(s.binance_overlapWindow.netCagr)} | ${pct(s.okx_overlapWindow.netCagr)} | ${s.binance_overlapWindow.sharpe.toFixed(2)} | ${s.okx_overlapWindow.sharpe.toFixed(2)} | ${pct(s.binance_overlapWindow.maxDD)} | ${pct(s.okx_overlapWindow.maxDD)} | ${s.binance_overlapWindow.entries} | ${s.okx_overlapWindow.entries} |`);
    }
  }
  out.push('');
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), `${out.join('\n')}\n`);
  fs.writeFileSync(path.join(outDir, 'rows.json'), JSON.stringify(rows, null, 1));
  console.log(out.join('\n'));
  console.log(`\n[cross-venue] wrote ${outDir}/{REPORT.md,rows.json}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
export default { diffCandles, runN };
