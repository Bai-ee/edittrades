#!/usr/bin/env node
/**
 * Position-sizing / drawdown simulator (research only).
 *
 * Three input modes:
 *   --calls <file.calls.jsonl>   Replay real call records (dir-cost net R).
 *   --param win=P,winR=W,lossR=L Parametric two-outcome distribution (no file).
 *   --trades <file.jsonl> --shuffle   (R4, WP3) Trade-ORDER shuffle Monte Carlo on any study's
 *                                 trade list - see "Shuffle mode" below. `--trades` is reused: a
 *                                 plain number still means tradesPerPath (unchanged); a path
 *                                 triggers this mode.
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
 * Shuffle mode (R4, WP3 - additive, does not change the two modes above):
 *   node scripts/research/risk-sim.js --trades var/research/wp3/sma200-btc-trades.jsonl \
 *     --shuffle --units pct [--n-shuffles 2000] [--seed 42] [--field ret] [--out name]
 *   node scripts/research/risk-sim.js --trades docs/swing/re-flag-retest-1h.trades.jsonl \
 *     --shuffle --units R --risk-pct 1 [--n-shuffles 2000] [--seed 42]
 *   Shuffles the realized trade ORDER (each trade keeps its own return) N times and reports
 *   p5/p50/p95 max drawdown, longest losing streak and time under water, next to the one
 *   historical (unshuffled) path. `--units pct` expects a compounded fractional return per
 *   trade (0.0123 = +1.23%); `--units R` expects an R-multiple, compounded via `--risk-pct`
 *   (equity *= 1 + riskPct/100 * R). State which units a given trades.jsonl uses - the two
 *   compound differently.
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
    // R4 (WP3) - trade-order shuffle mode, additive, mutually exclusive with --calls/--param.
    // `--trades` is overloaded (pre-existing flag): a plain number keeps meaning tradesPerPath
    // exactly as before; anything else (a path) is the new shuffle-mode trades.jsonl input, so
    // existing `--trades 300` invocations are byte-for-byte unaffected.
    tradesFile: null,
    shuffle: false,
    units: 'pct',
    nShuffles: 2000,
    field: null,
    riskPct: 1,
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
      case '--trades': {
        const v = next();
        if (/^-?\d+(\.\d+)?$/.test(v)) out.trades = Number(v);
        else out.tradesFile = v; // R4: a trades.jsonl path for --shuffle mode
        break;
      }
      case '--trades-per-day': out.tradesPerDay = Number(next()); break;
      case '--seed': out.seed = Number(next()); break;
      case '--out': out.out = next(); break;
      case '--shuffle': out.shuffle = true; break;
      case '--units': out.units = next(); break; // 'pct' (compounded fractional return) | 'R' (R-multiples)
      case '--n-shuffles': out.nShuffles = Number(next()); break;
      case '--field': out.field = next(); break; // override the auto-detected JSONL field name
      case '--risk-pct': out.riskPct = Number(next()); break; // only used to convert R-units to equity growth
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown flag: ${a}`);
          process.exit(1);
        }
    }
  }
  if (out.tradesFile) {
    if (!out.shuffle) {
      console.error('--trades <file> currently only supports --shuffle mode; pass --shuffle too.');
      process.exit(1);
    }
    if (out.units !== 'pct' && out.units !== 'R') {
      console.error(`--units must be 'pct' or 'R', got ${out.units}`);
      process.exit(1);
    }
    return out;
  }
  if (!out.calls && !out.param) {
    console.error('Must pass either --calls <file>, --param win=..,winR=..,lossR=.., or --trades <file.jsonl> --shuffle');
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
// R4 (WP3) - trade-order shuffle Monte Carlo. Additive only; does not touch the --calls/--param
// modes above. Ports the shape of Jesse's monte_carlo_trades.py: shuffle the REALIZED trade
// list's order (each trade keeps its own return), rebuild the equity curve, and report the
// distribution of path-level risk metrics across shuffles. See
// docs/research/harness/WP3_STATS.md for the write-up and jesse/research/monte_carlo/
// monte_carlo_trades.py (read at 840beb9) for the reference behaviour.
// ---------------------------------------------------------------------------

/**
 * Load a generic trade list (JSONL, one JSON object per line) for --shuffle mode. Any study's
 * trade list works (SMA200 trades from sma4h-trend.js's `trades` array, swing-rule signal
 * outcomes, flag replays) as long as each line has a numeric return field.
 *
 * @param {string} filePath
 * @param {{units:'pct'|'R', field?:string|null}} opts
 *   units:'pct' expects a FRACTIONAL return (0.0123 = +1.23%, compounded multiplicatively).
 *   units:'R'   expects an R-multiple (compounded via --risk-pct, see simulateShufflePath).
 *   field defaults by units unless explicitly given: pct -> ret/retPct/pct/return,
 *   R -> r/R/netR/net_r (first matching numeric field wins, in that order).
 * @returns {number[]} the returns in file (i.e. realized chronological) order.
 */
export function loadGenericTrades(filePath, opts = {}) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(REPO_ROOT, filePath);
  const units = opts.units || 'pct';
  const candidateFields = opts.field
    ? [opts.field]
    : (units === 'R' ? ['r', 'R', 'netR', 'net_r'] : ['ret', 'retPct', 'pct', 'return']);
  const lines = fs.readFileSync(abs, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    let value;
    for (const f of candidateFields) {
      if (typeof rec[f] === 'number' && Number.isFinite(rec[f])) { value = rec[f]; break; }
    }
    if (value === undefined) continue;
    out.push(value);
  }
  return out;
}

function fisherYatesShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * One deterministic pass over a (possibly shuffled) trade sequence: equity, max drawdown,
 * longest losing streak, and time under water. No risk-management overlays (no daily cap /
 * pause / kill switch) - R4 is specifically about order-shuffle risk, distinct from the
 * riskPct/dailyCap/pause/kill rule grid used by the --calls/--param modes above.
 */
function simulateShufflePath(returns, units, riskPct) {
  const riskFrac = riskPct / 100;
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  let lossRun = 0;
  let longestLossStreak = 0;
  let underwaterTrades = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    equity *= units === 'R' ? (1 + riskFrac * r) : (1 + r);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    if (equity < peak) underwaterTrades += 1;
    if (r < 0) {
      lossRun += 1;
      if (lossRun > longestLossStreak) longestLossStreak = lossRun;
    } else {
      lossRun = 0;
    }
  }
  return {
    finalEquity: equity,
    maxDD,
    longestLossStreak,
    timeUnderWaterFrac: returns.length ? underwaterTrades / returns.length : 0,
  };
}

/**
 * Shuffle the realized trade order N times and rebuild the equity curve each time (pure
 * function, no file I/O). Reports p5/p50/p95 of max drawdown, longest losing streak and time
 * under water across the shuffles, plus the one historical (unshuffled) path for comparison.
 *
 * @param {number[]} returns - per-trade returns in their ORIGINAL realized (chronological) order.
 * @param {{nShuffles?:number, seed?:number, units?:'pct'|'R', riskPct?:number}} opts
 */
export function shuffleTradeOrder(returns, opts = {}) {
  const { nShuffles = 2000, seed = 42, units = 'pct', riskPct = 1 } = opts;
  if (units !== 'pct' && units !== 'R') throw new Error(`units must be 'pct' or 'R', got ${units}`);
  if (!returns || returns.length < 2) throw new Error(`shuffleTradeOrder needs at least 2 trades, got ${returns ? returns.length : 0}`);
  const rng = makeRng(seed);
  const maxDDs = [], streaks = [], uwFracs = [], finals = [];
  for (let s = 0; s < nShuffles; s++) {
    const perm = fisherYatesShuffle(returns, rng);
    const sim = simulateShufflePath(perm, units, riskPct);
    maxDDs.push(sim.maxDD);
    streaks.push(sim.longestLossStreak);
    uwFracs.push(sim.timeUnderWaterFrac);
    finals.push(sim.finalEquity);
  }
  maxDDs.sort((a, b) => a - b);
  streaks.sort((a, b) => a - b);
  uwFracs.sort((a, b) => a - b);
  finals.sort((a, b) => a - b);
  const pick = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))];
  return {
    nShuffles,
    seed,
    units,
    riskPct: units === 'R' ? riskPct : null,
    nTrades: returns.length,
    maxDD: { p5: pick(maxDDs, 0.05), p50: pick(maxDDs, 0.50), p95: pick(maxDDs, 0.95) },
    longestLossStreak: { p5: pick(streaks, 0.05), p50: pick(streaks, 0.50), p95: pick(streaks, 0.95) },
    timeUnderWaterFrac: { p5: pick(uwFracs, 0.05), p50: pick(uwFracs, 0.50), p95: pick(uwFracs, 0.95) },
    finalEquityX: { p5: pick(finals, 0.05), p50: pick(finals, 0.50), p95: pick(finals, 0.95) },
    historical: simulateShufflePath(returns, units, riskPct),
  };
}

function printShuffleTable(label, result) {
  console.log(`\n### R4 trade-order shuffle - ${label} (${result.nShuffles} shuffles, seed ${result.seed}, units=${result.units}${result.riskPct != null ? `, riskPct=${result.riskPct}%` : ''})\n`);
  console.log(`nTrades=${result.nTrades}`);
  console.log('| metric | p5 | p50 | p95 | historical (unshuffled) |');
  console.log('| --- | --- | --- | --- | --- |');
  console.log(`| max drawdown | ${fmtPct(result.maxDD.p5)} | ${fmtPct(result.maxDD.p50)} | ${fmtPct(result.maxDD.p95)} | ${fmtPct(result.historical.maxDD)} |`);
  console.log(`| longest losing streak | ${result.longestLossStreak.p5} | ${result.longestLossStreak.p50} | ${result.longestLossStreak.p95} | ${result.historical.longestLossStreak} |`);
  console.log(`| time under water | ${fmtPct(result.timeUnderWaterFrac.p5)} | ${fmtPct(result.timeUnderWaterFrac.p50)} | ${fmtPct(result.timeUnderWaterFrac.p95)} | ${fmtPct(result.historical.timeUnderWaterFrac)} |`);
  console.log(`| final equity | ${fmtX(result.finalEquityX.p5)} | ${fmtX(result.finalEquityX.p50)} | ${fmtX(result.finalEquityX.p95)} | ${fmtX(result.historical.finalEquity)} |`);
}

function runShuffleMode(args) {
  const returns = loadGenericTrades(args.tradesFile, { units: args.units, field: args.field });
  if (returns.length < 2) {
    console.error(`Only ${returns.length} usable trade(s) found in ${args.tradesFile} (units=${args.units}, field=${args.field || 'auto'}) - need at least 2.`);
    process.exit(1);
  }
  console.log(`# Risk sim: shuffle mode - ${args.tradesFile}`);
  console.log(`Loaded ${returns.length} trades, units=${args.units}${args.field ? `, field=${args.field}` : ''}`);
  const result = shuffleTradeOrder(returns, { nShuffles: args.nShuffles, seed: args.seed, units: args.units, riskPct: args.riskPct });
  const label = path.basename(args.tradesFile, path.extname(args.tradesFile));
  printShuffleTable(label, result);

  const outName = args.out || `${label}-shuffle`;
  const outDir = path.join(REPO_ROOT, 'var', 'risk-sim');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${outName}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'shuffle', input: args.tradesFile, ...result }, null, 2));
  console.log(`\nWrote ${path.relative(REPO_ROOT, outPath)}`);
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

  if (args.tradesFile) {
    runShuffleMode(args);
    return;
  }

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

// Guard added for WP3 (R4): this file is now also `import`ed for its pure functions
// (shuffleTradeOrder, loadGenericTrades) by test-wp3-risk-shuffle.js. Without this guard,
// importing the module for those functions would re-run the CLI against the importer's
// process.argv. Running the file directly (`node scripts/research/risk-sim.js ...`) is
// unaffected: import.meta.url still equals `file://${process.argv[1]}` in that case.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
