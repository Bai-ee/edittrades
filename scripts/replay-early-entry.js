#!/usr/bin/env node
/**
 * T5 P0 (docs/PLAN_DIVERGENCE_OPPORTUNITIES.md "P0 item 2") replay evaluation: does an
 * EARLY entry - filled at the tightening point's own close, before confirmation - beat
 * the base rate, and does divergence/atLevel/sweepReclaim/counterTrend measurably change
 * that edge? Read-only research: nothing here changes a threshold, gate, or the
 * production `flagTradePlan`/`flagRecommendation`. No file under `api/`, `lib/`,
 * `services/` or `config/` is edited (this script only imports read-only helpers from
 * `lib/flagTradePlan.js` and `scripts/tracker/*.js`, the same pattern
 * `scripts/replay-breakout-entry.js` (T4 P4) already sets).
 *
 * Input: a `scripts/replay-paths.js --out` JSONL (one row per candidate's first
 * tightening point - MUST be a rerun after the T5 P0 `featuresAt` additions, so every row
 * carries `features.{divergence,atLevel,sweepReclaim,counterTrend}`, plus the additive
 * `tighteningClose`/`tp1Cap` row fields that script now writes) and the SAME history dir,
 * for its full 1m candles only (unlike `scripts/replay-breakout-entry.js`, this script
 * never needs to look up a candidate-tf candle itself - the entry prices it needs are
 * already on the row: `tighteningClose` for the early entry, `breakoutLevel` for the
 * retest entry, `invalidation` for the shared stop, `tp1Cap` (else `measuredTarget`) for
 * the shared TP1 - see `scripts/replay-paths.js`'s `tp1Ahead` for the cap rule, a
 * price-returning equivalent of `lib/flagTradePlan.js`'s private `nearestRoomAhead`).
 *
 * For every row with a valid direction/entry/stop/target:
 *   1. EARLY entry: entry = `row.tighteningClose` (the tightening candle's own close -
 *      i.e. filled before the candidate ever confirms/breaks out), stop = `invalidation`,
 *      tp1 = `tp1Cap` (else `measuredTarget`). Walked forward 1m from `row.detectedAt`
 *      (the tightening point) for `--window-hours` (default 24), prefilled (no fill-
 *      window search - the position is already filled at that close), via
 *      `scripts/tracker/breakout-entry.js`'s `walkShadow`.
 *   2. RETEST entry (comparison, same rows): entry = `row.breakoutLevel`, same stop/tp1,
 *      published only when `row.retestAt` is not null (an actual retest-hold touch
 *      occurred - same rule `scripts/replay-breakout-entry.js`'s `retestEntryFor` uses) -
 *      walked from `row.retestAt`, never before the retest can have happened.
 *   3. Gross R (`walkShadow`'s own `r`, computed from entry/stop/target - a win's R
 *      matches `grossRR` below) and net R after fees (`lib/flagTradePlan.js`'s
 *      `netRiskReward`, fixed per trial at entry time - a win credits it, a loss stays -1,
 *      the same convention `scripts/replay-breakout-entry.js`'s `stats()` uses and
 *      documents there).
 *
 * Reports n, win rate, gross/net expectancy R, and max losing streak - overall, by each
 * of the four new features on its own, and by the four-way combo
 * (divergence x atLevel x sweepReclaim x counterTrend), `calibrated` at n >= `--min-n`
 * (default 100), else 'uncalibrated' - for both the early and retest entry types. Also
 * prints the ROW-level (not trial-level) fail_first/runner path-label shares for the same
 * groupings, via `scripts/tracker/flag-paths.js`'s own `baseRates` (T4's own base-rate
 * function, reused unmodified) - this captures every row regardless of whether either
 * entry type actually produced a valid trial.
 *
 * Usage:
 *   node scripts/replay-early-entry.js --rows <rows.jsonl> --history <dir>
 *     [--symbols BTC,SOL,ETH] [--window-hours 24] [--min-n 100] [--json <file>]
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONFIG } from '../config/engine.js';
import { SYMBOLS } from '../services/scalpContext.js';
import { loadHistoryDir } from './replay.js';
import { readJsonl } from './replay-metrics.js';
import { PATHS, baseRates } from './tracker/flag-paths.js';
import { walkShadow } from './tracker/breakout-entry.js';
import { netRiskReward } from '../lib/flagTradePlan.js';

const T5_FEATURES = ['divergence', 'atLevel', 'sweepReclaim', 'counterTrend'];

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundN(v, n = 4) {
  if (!isFiniteNumber(v)) return null;
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// entry construction (shared shape/validity rule for both entry types - deliberately no
// minRR/maxStopPct production gate here, unlike shadowEntryFromBreakout: this is a
// measure-only comparison across every structurally valid setup, not a candidate for
// what production would publish - see docs/PLAN_DIVERGENCE_OPPORTUNITIES.md "Gate")
// ---------------------------------------------------------------------------

/**
 * @param {'long'|'short'|null} direction
 * @param {number} entry
 * @param {number} stop
 * @param {number} tp1
 * @param {{feeBps:number, slippageBps:number}} feeCfg
 * @returns {{entry:number, stop:number, tp1:number, grossRR:number, netRR:number|null}|null}
 */
function buildEntry(direction, entry, stop, tp1, feeCfg) {
  if ((direction !== 'long' && direction !== 'short') || !isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(tp1)) return null;
  const sign = direction === 'short' ? -1 : 1;
  if (!(sign * (entry - stop) > 0) || !(sign * (tp1 - entry) > 0)) return null;
  const grossRisk = Math.abs(entry - stop);
  if (!(grossRisk > 0)) return null;
  const grossRR = roundN(Math.abs(tp1 - entry) / grossRisk, 3);
  const netRR = roundN(netRiskReward(entry, stop, tp1, feeCfg), 3);
  return { entry: roundN(entry, 2), stop: roundN(stop, 2), tp1: roundN(tp1, 2), grossRR, netRR };
}

/**
 * One row -> its early trial and (if a retest touch occurred) its retest trial. Both
 * share the same stop (`invalidation`) and tp1 (`tp1Cap` else `measuredTarget`) - only
 * the entry price and the walk's start time differ, per this file's header.
 * @param {Object} row - a scripts/replay-paths.js output row (T5 P0 fields required)
 * @param {Array<{timestamp:number, high:number, low:number}>} candles1m - this symbol's full ascending 1m candles
 * @param {{feeBps:number, slippageBps:number}} feeCfg
 * @param {number} windowMs
 * @returns {{row:Object, early:Object|null, retest:Object|null}}
 */
export function evaluateRow(row, candles1m, feeCfg, windowMs) {
  const direction = row.direction === 'long' || row.direction === 'short' ? row.direction : null;
  if (!direction) return { row, early: null, retest: null };

  const stop = row.invalidation;
  const tp1 = isFiniteNumber(row.tp1Cap) ? row.tp1Cap : row.measuredTarget;
  const features = row.features || {};

  let early = null;
  const earlyEntry = buildEntry(direction, row.tighteningClose, stop, tp1, feeCfg);
  const fromMs = typeof row.detectedAt === 'string' ? Date.parse(row.detectedAt) : NaN;
  if (earlyEntry && isFiniteNumber(fromMs)) {
    const walked = walkShadow({ dir: direction, entry: earlyEntry.entry, stop: earlyEntry.stop, tp1: earlyEntry.tp1 }, candles1m, fromMs, windowMs);
    early = { ...earlyEntry, ...walked, at: fromMs, features };
  }

  let retest = null;
  if (isFiniteNumber(row.retestAt)) {
    const retestEntry = buildEntry(direction, row.breakoutLevel, stop, tp1, feeCfg);
    if (retestEntry) {
      const walked = walkShadow({ dir: direction, entry: retestEntry.entry, stop: retestEntry.stop, tp1: retestEntry.tp1 }, candles1m, row.retestAt, windowMs);
      retest = { ...retestEntry, ...walked, at: row.retestAt, features };
    }
  }

  return { row, early, retest };
}

// ---------------------------------------------------------------------------
// trial stats
// ---------------------------------------------------------------------------

function maxLosingStreak(trials) {
  let max = 0;
  let cur = 0;
  for (const t of trials.slice().sort((a, b) => a.at - b.at)) {
    if (t.outcome === 'stop') { cur++; if (cur > max) max = cur; }
    else if (t.outcome === 'tp1') { cur = 0; }
    // open/expired: unresolved, neither extends nor resets a streak
  }
  return max;
}

/**
 * @param {Array<Object>} trials - each carries {at, outcome, r, netRR}
 * @param {number} minN
 */
function statsFor(trials, minN) {
  const n = trials.length;
  const resolved = trials.filter((t) => t.outcome === 'tp1' || t.outcome === 'stop');
  const wins = resolved.filter((t) => t.outcome === 'tp1');
  const grossSum = trials.reduce((s, t) => s + (t.outcome === 'tp1' ? t.r : t.outcome === 'stop' ? -1 : 0), 0);
  // Net expectancy: a win's fee/slippage-adjusted reward (netRR, fixed per trial at entry
  // time) in place of gross r; a loss stays -1 - same convention
  // scripts/replay-breakout-entry.js's stats() uses (see that file's own comment): this
  // slightly understates true net cost on a stop-out, since round-trip fees are paid on a
  // loss too, not only a win; directionally correct, not a claimed penny-exact figure.
  const netSum = trials.reduce((s, t) => s + (t.outcome === 'tp1' ? (isFiniteNumber(t.netRR) ? t.netRR : 0) : t.outcome === 'stop' ? -1 : 0), 0);
  return {
    n,
    resolvedN: resolved.length,
    unresolvedN: n - resolved.length,
    winRate: resolved.length ? roundN((wins.length / resolved.length) * 100, 2) : null,
    grossExpectancyR: n ? roundN(grossSum / n, 4) : null,
    netExpectancyR: n ? roundN(netSum / n, 4) : null,
    maxLosingStreak: maxLosingStreak(trials),
    calibrated: n >= minN
  };
}

/** One-feature groups (divergence / atLevel / sweepReclaim / counterTrend), each on its own. */
function byFeatureGroups(trials, minN) {
  const out = {};
  for (const name of T5_FEATURES) {
    const groups = new Map();
    for (const t of trials) {
      const key = t.features ? t.features[name] : undefined;
      if (key === undefined || key === null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    out[name] = [...groups.entries()]
      .map(([key, ts]) => ({ key, ...statsFor(ts, minN) }))
      .sort((a, b) => b.n - a.n);
  }
  return out;
}

/** The four-way combo key, shared by trial grouping and the row-level path-share table. */
function comboKey(features) {
  return T5_FEATURES.map((name) => `${name}=${features[name]}`).join('|');
}

function byComboGroups(trials, minN) {
  const groups = new Map();
  for (const t of trials) {
    if (!t.features) continue;
    const key = comboKey(t.features);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.entries()]
    .map(([key, ts]) => ({ key, ...statsFor(ts, minN) }))
    .sort((a, b) => b.n - a.n);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export function buildReport(evaluated, rows, { windowHours, minN }) {
  const earlyTrials = evaluated.map((e) => e.early).filter(Boolean);
  const retestTrials = evaluated.map((e) => e.retest).filter(Boolean);

  const pathShares = {
    overall: baseRates(rows, () => 'all', minN),
    byFeature: Object.fromEntries(T5_FEATURES.map((name) => [name, baseRates(rows, (r) => r.features && r.features[name], minN)])),
    byCombo: baseRates(rows, (r) => (r.features ? comboKey(r.features) : null), minN).sort((a, b) => b.n - a.n)
  };

  const entryReport = (trials) => ({
    overall: statsFor(trials, minN),
    byFeature: byFeatureGroups(trials, minN),
    byCombo: byComboGroups(trials, minN)
  });

  return {
    windowHours,
    minN,
    rowCount: rows.length,
    pathShares,
    early: entryReport(earlyTrials),
    retest: entryReport(retestTrials)
  };
}

function printStatsRow(title, s) {
  console.log(`  ${title}: n=${s.n} (${s.calibrated ? 'calibrated' : 'uncalibrated'}) resolved=${s.resolvedN} winRate=${s.winRate === null ? '-' : `${s.winRate}%`} grossExp=${s.grossExpectancyR === null ? '-' : `${s.grossExpectancyR}R`} netExp=${s.netExpectancyR === null ? '-' : `${s.netExpectancyR}R`} maxLosingStreak=${s.maxLosingStreak}`);
}

function printEntryReport(title, r) {
  console.log(`\n=== ${title} ===`);
  printStatsRow('overall', r.overall);
  for (const [name, table] of Object.entries(r.byFeature)) {
    console.log(`  -- by ${name} --`);
    for (const t of table) printStatsRow(`    ${name}=${t.key}`, t);
  }
  console.log('  -- by combo (divergence x atLevel x sweepReclaim x counterTrend), top 25 by n --');
  for (const t of r.byCombo.slice(0, 25)) printStatsRow(`    ${t.key}`, t);
}

function printBaseRateTable(title, table) {
  console.log(`\n${title}`);
  if (!table.length) { console.log('  (no data)'); return; }
  const header = ['key', 'n', 'calibrated', ...PATHS];
  const body = table.map((t) => [String(t.key), t.n, t.calibrated ? 'yes' : 'uncalibrated', ...PATHS.map((p) => (t.shares[p] === null ? '-' : t.shares[p]))]);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)));
  for (const row of all) console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join('  '));
}

function printReport(r) {
  console.log(`\nrows evaluated: ${r.rowCount} (window ${r.windowHours}h, minN ${r.minN})`);
  printBaseRateTable('path-label shares - overall', r.pathShares.overall);
  for (const [name, table] of Object.entries(r.pathShares.byFeature)) printBaseRateTable(`path-label shares - by ${name}`, table);
  printBaseRateTable('path-label shares - by combo (top 25 by n)', r.pathShares.byCombo.slice(0, 25));
  printEntryReport('EARLY entry (tightening-point close, before confirmation)', r.early);
  printEntryReport('RETEST entry (comparison: breakoutLevel, after breakout close + retest-hold)', r.retest);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
  return {
    rows: typeof opts.rows === 'string' ? opts.rows : null,
    history: typeof opts.history === 'string' ? opts.history : null,
    symbols: list(opts.symbols),
    windowHours: opts['window-hours'] ? Number(opts['window-hours']) : 24,
    minN: opts['min-n'] ? Number(opts['min-n']) : 100,
    json: typeof opts.json === 'string' ? opts.json : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rows || !args.history) throw new Error('need --rows <rows.jsonl> --history <dir>');

  const symbols = args.symbols || SYMBOLS;
  const history = loadHistoryDir(args.history, symbols);
  const rows = readJsonl(args.rows).filter((r) => symbols.includes(r.symbol));

  const candles1mBySymbol = {};
  for (const symbol of symbols) candles1mBySymbol[symbol] = (history[symbol] && history[symbol]['1m']) || [];

  const feeCfg = { feeBps: ENGINE_CONFIG.risk.feeBps, slippageBps: ENGINE_CONFIG.risk.slippageBps };
  const windowMs = args.windowHours * 60 * 60 * 1000;

  const evaluated = [];
  for (const row of rows) {
    const candles1m = candles1mBySymbol[row.symbol];
    if (!candles1m) continue;
    evaluated.push(evaluateRow(row, candles1m, feeCfg, windowMs));
  }

  const report = buildReport(evaluated, rows, { windowHours: args.windowHours, minN: args.minN });
  printReport(report);
  if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[replay-early-entry] ${err.stack || err.message}`);
    process.exit(1);
  });
}

export default { evaluateRow, buildReport, parseArgs };
