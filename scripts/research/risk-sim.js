#!/usr/bin/env node
/**
 * Position-sizing / drawdown simulator (research only).
 *
 * Two input modes:
 *   --calls <file.calls.jsonl>   Replay real call records (dir-cost net R).
 *   --param win=P,winR=W,lossR=L Parametric two-outcome distribution (no file).
 *
 * Two simulation methods (file mode only runs both; param mode has no real
 * sequence, so it only runs the bootstrap method):
 *   (a) historical  - one deterministic pass over the actual chronological
 *                     sequence of filtered, resolved calls.
 *   (b) bootstrap   - Monte Carlo: N paths of M trades, each trade resampled
 *                     with replacement from the filtered R distribution
 *                     (file mode) or drawn iid from the parametric
 *                     win/winR/lossR distribution (param mode).
 *
 * Equity is compounding: risk = riskPct% of CURRENT equity per trade,
 * equity_{i+1} = equity_i * (1 + riskPct/100 * R_i).
 *
 * Usage:
 *   node scripts/research/risk-sim.js --calls var/replay-rules/V6.calls.jsonl \
 *     [--filter-min-stop 0.5] [--filter-max-costr 0.35] \
 *     [--paths 10000] [--trades 300] [--trades-per-day 5] [--seed 42] [--out name]
 *
 *   node scripts/research/risk-sim.js --param win=0.31,winR=2.6,lossR=1.3 \
 *     [--paths 10000] [--trades 300] [--trades-per-day 5] [--seed 42] [--out name]
 *
 * Output: markdown tables to stdout, full JSON to var/risk-sim/<name>.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    calls: null,
    param: null,
    filterMinStop: 0,
    filterMaxCostR: Infinity,
    paths: 10000,
    trades: 300,
    tradesPerDay: 5,
    seed: 42,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--calls': out.calls = next(); break;
      case '--param': out.param = next(); break;
      case '--filter-min-stop': out.filterMinStop = Number(next()); break;
      case '--filter-max-costr': out.filterMaxCostR = Number(next()); break;
      case '--paths': out.paths = Number(next()); break;
      case '--trades': out.trades = Number(next()); break;
      case '--trades-per-day': out.tradesPerDay = Number(next()); break;
      case '--seed': out.seed = Number(next()); break;
      case '--out': out.out = next(); break;
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown flag: ${a}`);
          process.exit(1);
        }
    }
  }
  if (!out.calls && !out.param) {
    console.error('Must pass either --calls <file> or --param win=..,winR=..,lossR=..');
    process.exit(1);
  }
  if (out.param) {
    const parsed = {};
    for (const kv of out.param.split(',')) {
      const [k, v] = kv.split('=');
      parsed[k.trim()] = Number(v);
    }
    if (!('win' in parsed) || !('winR' in parsed) || !('lossR' in parsed)) {
      console.error('--param needs win=,winR=,lossR= (e.g. win=0.31,winR=2.6,lossR=1.3)');
      process.exit(1);
    }
    out.param = parsed;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) - deterministic, reproducible runs, no dependency.
// ---------------------------------------------------------------------------

function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// File-mode input loading
// ---------------------------------------------------------------------------

function loadCalls(filePath, filterMinStop, filterMaxCostR) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(REPO_ROOT, filePath);
  const lines = fs.readFileSync(abs, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.outcome !== 'win' && rec.outcome !== 'loss') continue; // resolved only
    if (typeof rec.stopDistancePct !== 'number' || rec.stopDistancePct <= 0) continue;
    if (rec.stopDistancePct < filterMinStop) continue;

    const costPct = rec.direction === 'short' ? 0.14 : 0.34;
    const costR = costPct / rec.stopDistancePct;
    if (costR > filterMaxCostR) continue;

    const R = rec.direction === 'short' ? rec.netR_sens014 : rec.netR_sens034;
    if (typeof R !== 'number' || !Number.isFinite(R)) continue;

    const day = String(rec.firstReadyAt || '').slice(0, 10); // UTC day (YYYY-MM-DD)
    records.push({ R, day, t: rec.firstReadyAt, symbol: rec.symbol, direction: rec.direction });
  }
  records.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return records;
}

// ---------------------------------------------------------------------------
// Rule grid
// ---------------------------------------------------------------------------

const RISK_PCT_GRID = [0.5, 0.75, 1, 2];
const DAILY_LOSS_CAP_GRID = [null, 3];       // R units lost in a day
const PAUSE_AFTER_LOSSES_GRID = [null, 6];   // consecutive losses that trigger a day pause
const KILL_SWITCH_DD_GRID = [null, 0.15];    // equity drawdown from peak

function ruleGridCells() {
  const cells = [];
  for (const riskPct of RISK_PCT_GRID) {
    for (const dailyLossCapR of DAILY_LOSS_CAP_GRID) {
      for (const pauseAfterLosses of PAUSE_AFTER_LOSSES_GRID) {
        for (const killSwitchDD of KILL_SWITCH_DD_GRID) {
          cells.push({ riskPct, dailyLossCapR, pauseAfterLosses, killSwitchDD });
        }
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Core single-path simulator
//
// `returns` and `dayIds` are parallel arrays (same length) walked in order.
// Day-scoped rules (dailyLossCapR, pauseAfterLosses -> "sit out rest of day")
// reset when dayIds[i] changes. The kill switch is NOT day-scoped: once
// tripped it stops the path for good (spec: "stop trading the path").
// ---------------------------------------------------------------------------

function simulateOnePath(returns, dayIds, rules) {
  const { riskPct, dailyLossCapR, pauseAfterLosses, killSwitchDD } = rules;
  const riskFrac = riskPct / 100;

  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  let consecLosses = 0; // resets each day (drives the pause rule)
  let runLosses = 0; // never resets on a day boundary (drives the longest-streak metric)
  let longestStreak = 0;
  let dailyRSum = 0;
  let dayPauseActive = false;
  let killed = false;
  let killTriggered = false;
  let currentDay = null;
  let tradesTaken = 0;
  let tradesSkipped = 0;

  for (let i = 0; i < returns.length; i++) {
    const day = dayIds[i];
    if (day !== currentDay) {
      currentDay = day;
      dailyRSum = 0;
      dayPauseActive = false;
      consecLosses = 0; // a new day resets the losing-streak count for the pause rule
    }

    if (killed || dayPauseActive) {
      tradesSkipped++;
      continue;
    }

    const R = returns[i];
    equity = equity * (1 + riskFrac * R);
    tradesTaken++;
    dailyRSum += R;

    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;

    if (R < 0) {
      consecLosses++;
      runLosses++;
      if (runLosses > longestStreak) longestStreak = runLosses;
    } else {
      consecLosses = 0;
      runLosses = 0;
    }

    if (killSwitchDD != null && dd >= killSwitchDD) {
      killed = true;
      killTriggered = true;
    }
    if (dailyLossCapR != null && dailyRSum <= -dailyLossCapR) {
      dayPauseActive = true;
    }
    if (pauseAfterLosses != null && consecLosses >= pauseAfterLosses) {
      dayPauseActive = true;
    }
  }

  return {
    finalEquity: equity,
    maxDD,
    longestLossStreak: longestStreak,
    killTriggered,
    tradesTaken,
    tradesSkipped,
  };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sortedAsc[idx];
}

function aggregateBootstrap(pathResults, killSwitchActive) {
  const finalEq = pathResults.map((r) => r.finalEquity).sort((a, b) => a - b);
  const maxDDs = pathResults.map((r) => r.maxDD).sort((a, b) => a - b);
  const streaks = pathResults.map((r) => r.longestLossStreak).sort((a, b) => a - b);
  const n = pathResults.length;
  const ddGe20 = pathResults.filter((r) => r.maxDD >= 0.20).length / n;
  const ddGe30 = pathResults.filter((r) => r.maxDD >= 0.30).length / n;
  const killP = killSwitchActive ? pathResults.filter((r) => r.killTriggered).length / n : null;

  return {
    paths: n,
    medianFinalEquityX: median(finalEq),
    p5FinalEquityX: percentile(finalEq, 0.05),
    medianMaxDD: median(maxDDs),
    p95MaxDD: percentile(maxDDs, 0.95),
    probDDge20: ddGe20,
    probDDge30: ddGe30,
    medianLongestLossStreak: median(streaks),
    p95LongestLossStreak: percentile(streaks, 0.95),
    probKillTriggered: killP,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap path generation
// ---------------------------------------------------------------------------

function buildBootstrapReturns(rng, tradesPerPath, tradesPerDay, sampler) {
  const returns = new Array(tradesPerPath);
  const dayIds = new Array(tradesPerPath);
  for (let i = 0; i < tradesPerPath; i++) {
    returns[i] = sampler(rng);
    dayIds[i] = Math.floor(i / tradesPerDay);
  }
  return { returns, dayIds };
}

function makeFileSampler(records) {
  const rs = records.map((r) => r.R);
  return (rng) => rs[Math.floor(rng() * rs.length)];
}

function makeParamSampler(win, winR, lossR) {
  return (rng) => (rng() < win ? winR : -lossR);
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function runHistorical(records, rules) {
  const returns = records.map((r) => r.R);
  const dayIds = records.map((r) => r.day);
  const single = simulateOnePath(returns, dayIds, rules);
  return { n: returns.length, ...single };
}

function runBootstrap(rng, sampler, opts, rules) {
  const { paths, tradesPerPath, tradesPerDay } = opts;
  const results = new Array(paths);
  for (let p = 0; p < paths; p++) {
    const { returns, dayIds } = buildBootstrapReturns(rng, tradesPerPath, tradesPerDay, sampler);
    results[p] = simulateOnePath(returns, dayIds, rules);
  }
  return aggregateBootstrap(results, rules.killSwitchDD != null);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtX(x) { return Number.isFinite(x) ? `${x.toFixed(2)}x` : 'n/a'; }
function fmtPct(x) { return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a'; }
function fmtProb(x) { return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`; }
function ruleLabel(cell) {
  const dc = cell.dailyLossCapR == null ? 'none' : `${cell.dailyLossCapR}R`;
  const pa = cell.pauseAfterLosses == null ? 'none' : `${cell.pauseAfterLosses}`;
  const ks = cell.killSwitchDD == null ? 'none' : `${(cell.killSwitchDD * 100).toFixed(0)}%`;
  return `risk ${cell.riskPct}% | dailyCap ${dc} | pause ${pa} | kill ${ks}`;
}

function printBootstrapTable(title, rows) {
  console.log(`\n### ${title} (bootstrap, N paths, per-path metrics aggregated)\n`);
  console.log('| riskPct | dailyCapR | pauseAfterLosses | killDD | median finalX | p5 finalX | median maxDD | p95 maxDD | P(DD>=20%) | P(DD>=30%) | med streak | p95 streak | P(kill) |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const { cell, agg } = row;
    console.log(
      `| ${cell.riskPct}% | ${cell.dailyLossCapR ?? 'none'} | ${cell.pauseAfterLosses ?? 'none'} | ${cell.killSwitchDD != null ? `${(cell.killSwitchDD * 100).toFixed(0)}%` : 'none'} `
      + `| ${fmtX(agg.medianFinalEquityX)} | ${fmtX(agg.p5FinalEquityX)} | ${fmtPct(agg.medianMaxDD)} | ${fmtPct(agg.p95MaxDD)} `
      + `| ${fmtProb(agg.probDDge20)} | ${fmtProb(agg.probDDge30)} | ${agg.medianLongestLossStreak} | ${agg.p95LongestLossStreak} | ${fmtProb(agg.probKillTriggered)} |`
    );
  }
}

function printHistoricalTable(title, rows) {
  console.log(`\n### ${title} (historical, one deterministic pass over the real sequence)\n`);
  console.log('| riskPct | dailyCapR | pauseAfterLosses | killDD | finalX | maxDD | longest streak | kill? | trades taken/skipped |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const { cell, single } = row;
    console.log(
      `| ${cell.riskPct}% | ${cell.dailyLossCapR ?? 'none'} | ${cell.pauseAfterLosses ?? 'none'} | ${cell.killSwitchDD != null ? `${(cell.killSwitchDD * 100).toFixed(0)}%` : 'none'} `
      + `| ${fmtX(single.finalEquity)} | ${fmtPct(single.maxDD)} | ${single.longestLossStreak} | ${single.killTriggered ? 'yes' : 'no'} | ${single.tradesTaken}/${single.tradesSkipped} |`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rng = makeRng(args.seed);
  const cells = ruleGridCells();

  let mode, scenarioLabel, sampler, records = null;

  if (args.calls) {
    mode = 'file';
    records = loadCalls(args.calls, args.filterMinStop, args.filterMaxCostR);
    if (records.length < 2) {
      console.error(`Only ${records.length} resolved calls survived filters in ${args.calls} - need at least 2.`);
      process.exit(1);
    }
    sampler = makeFileSampler(records);
    scenarioLabel = path.basename(args.calls, path.extname(args.calls));
    const wins = records.filter((r) => r.R > 0).length;
    console.log(`# Risk sim: file mode - ${args.calls}`);
    console.log(`Filters: minStop=${args.filterMinStop}%, maxCostR=${args.filterMaxCostR}`);
    console.log(`Resolved+filtered calls: ${records.length} (win rate ${(100 * wins / records.length).toFixed(1)}%)`);
  } else {
    mode = 'param';
    const { win, winR, lossR } = args.param;
    sampler = makeParamSampler(win, winR, lossR);
    scenarioLabel = `param_win${win}_winR${winR}_lossR${lossR}`;
    console.log(`# Risk sim: param mode - win=${win}, winR=${winR}, lossR=${lossR}`);
    console.log(`Expectancy per trade: ${(win * winR - (1 - win) * lossR).toFixed(4)}R`);
  }

  console.log(`Paths=${args.paths}, tradesPerPath=${args.trades}, tradesPerDay=${args.tradesPerDay}, seed=${args.seed}`);

  const bootstrapRows = [];
  for (const cell of cells) {
    const agg = runBootstrap(rng, sampler, { paths: args.paths, tradesPerPath: args.trades, tradesPerDay: args.tradesPerDay }, cell);
    bootstrapRows.push({ cell, agg });
  }
  printBootstrapTable(scenarioLabel, bootstrapRows);

  let historicalRows = null;
  if (mode === 'file') {
    historicalRows = [];
    for (const cell of cells) {
      const single = runHistorical(records, cell);
      historicalRows.push({ cell, single });
    }
    printHistoricalTable(scenarioLabel, historicalRows);
  }

  const outName = args.out || scenarioLabel;
  const outDir = path.join(REPO_ROOT, 'var', 'risk-sim');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${outName}.json`);
  const jsonOut = {
    generatedAt: new Date().toISOString(),
    mode,
    input: args.calls || args.param,
    filters: mode === 'file' ? { minStop: args.filterMinStop, maxCostR: args.filterMaxCostR } : null,
    resolvedCallCount: records ? records.length : null,
    paths: args.paths,
    tradesPerPath: args.trades,
    tradesPerDay: args.tradesPerDay,
    seed: args.seed,
    bootstrap: bootstrapRows.map(({ cell, agg }) => ({ cell, agg })),
    historical: historicalRows ? historicalRows.map(({ cell, single }) => ({ cell, single })) : null,
  };
  fs.writeFileSync(outPath, JSON.stringify(jsonOut, null, 2));
  console.log(`\nWrote ${path.relative(REPO_ROOT, outPath)}`);
}

main();
