#!/usr/bin/env node
/**
 * T4 P4 (docs/PLAN_FLAG_PATHS.md "P4 - More opportunities") replay evaluation, SHADOW
 * MODE: does the breakout-close shadow entry (`lib/breakoutEntry.js`,
 * `scripts/tracker/breakout-entry.js`) hold up against the same 15-day labelled dataset
 * P0 measured base rates from? Read-only research: nothing here changes a threshold,
 * gate, or the production `flagTradePlan`/`flagRecommendation`.
 *
 * Input: a `scripts/replay-paths.js --out` JSONL (one row per candidate, its first
 * tightening point, and the path it took - see that script's own header for the row
 * shape) plus the SAME history dir (`scripts/replay.js loadHistoryDir`; 3m derived from
 * 1m the same way production does, `services/marketData.js`'s `aggregateToBuckets`).
 *
 * For every row whose `breakoutAt` is not null (it broke out - retest_go/runner/
 * false_break always qualify; chop only when a breakout close happened but the row's
 * 24-candle window ran out before resolving):
 *   1. Find the breakout candle's own close (the row's own timeframe, at `breakoutAt`,
 *      an OPEN-ms timestamp per `labelPath` - the candle's CLOSE time, and this shadow
 *      entry's `at`, is one interval later).
 *   2. Approximate `pathOutlook.chase` for the row the same way `lib/pathOutlook.js`
 *      does: the same backoff-bucket lookup against `config/engine.json`'s
 *      `pathOutlook.broken` table, using the row's own `features` (already computed by
 *      `scripts/replay-paths.js` with the identical `featuresAt` call `buildPathOutlook`
 *      uses) - "approximated" because this script duplicates that small classification
 *      instead of reconstructing a full production payload per row just to call
 *      `buildPathOutlook` itself.
 *   3. `shadowEntryFromBreakout` twice: gated on chase elevated/high (what production
 *      would actually have published) and ungated (every breakout, to see whether the
 *      chase filter is doing useful narrowing or just cutting sample size) - walked
 *      forward 1m for 24h with `walkShadow`.
 *   4. A comparison "retest entry" on the SAME row: entry = breakoutLevel (not the
 *      breakout close), stop = invalidation, tp1 = measuredTarget, published only when
 *      the row's own `retestAt` is not null (a retest touch actually occurred) and the
 *      same minRR/max-stop-% gates pass - walked from `retestAt`, not `breakoutAt`
 *      (a retest entry cannot fill before the retest happens).
 *
 * Reports n, fill (always 100% for the shadow entry - it is prefilled by construction,
 * never a zone search), win rate, gross expectancy R, net expectancy R (fee/slippage-
 * adjusted reward on a win, same -1 on a loss - see the report's own caveat), and max
 * losing streak; overall, by timeframe, and by chase bucket.
 *
 * Usage:
 *   node scripts/replay-breakout-entry.js --rows <rows.jsonl> --history <dir>
 *     [--symbols BTC,SOL,ETH] [--window-hours 24] [--json <file>]
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONFIG } from '../config/engine.js';
import { INTERVAL_MS, SYMBOLS } from '../services/scalpContext.js';
import { aggregateToBuckets } from '../services/marketData.js';
import { loadHistoryDir } from './replay.js';
import { readJsonl } from './replay-metrics.js';
import { PATHS } from './tracker/flag-paths.js';
import { netRiskReward, shadowEntryFromBreakout, walkShadow } from './tracker/breakout-entry.js';

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundN(v, n = 3) {
  if (!isFiniteNumber(v)) return null;
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// chase approximation (duplicates lib/pathOutlook.js's small backoff/chase
// classification - see this file's header for why it is not imported/reconstructed)
// ---------------------------------------------------------------------------

function backoffKeys(features, keys) {
  const out = [];
  for (let depth = keys.length; depth >= 1; depth--) {
    out.push(keys.slice(0, depth).map((k) => `${k}=${features[k]}`).join('|'));
  }
  out.push('all');
  return out;
}

function resolveBucket(table, keys) {
  for (const k of keys) {
    if (table && table[k]) return { key: k, ...table[k] };
  }
  return null;
}

function normalizeWeights(w) {
  const out = {};
  for (const p of PATHS) out[p] = isFiniteNumber(w && w[p]) ? w[p] : 0;
  out.fail_first = 0; // the 'broken' table never carries a real fail_first share
  return out;
}

/**
 * `pathOutlook.chase` for one row, approximated from `config/engine.json`'s
 * `pathOutlook.broken` table and the row's own (already-computed) `features` - same
 * backoff/resolution/classification `lib/pathOutlook.js`'s `buildPathOutlook` applies.
 * @returns {{chase:'low'|'elevated'|'high', key:string, n:number, cal:boolean}|null}
 *   null when no bucket resolves at all (features too sparse; never thrown).
 */
function chaseFor(row, cfg = ENGINE_CONFIG) {
  const tableCfg = cfg.pathOutlook;
  const table = tableCfg && tableCfg.broken;
  if (!table || !row || !row.features) return null;
  const keys = Array.isArray(tableCfg.keys) && tableCfg.keys.length ? tableCfg.keys : ['tf', 'structureSteps', 'roomR', 'compression'];
  const bucket = resolveBucket(table, backoffKeys(row.features, keys));
  if (!bucket) return null;

  const w = normalizeWeights(bucket.w);
  const allBucket = table.all;
  const baselineRunner = isFiniteNumber(allBucket && allBucket.w && allBucket.w.runner) ? allBucket.w.runner : 0;
  const runnerDominant = w.retest_go > 0 ? w.runner >= w.retest_go * 1.2 : w.runner > 0;
  const chase = runnerDominant ? 'high' : (w.runner > baselineRunner ? 'elevated' : 'low');
  const n = isFiniteNumber(bucket.n) ? bucket.n : 0;
  const minN = isFiniteNumber(tableCfg.minN) ? tableCfg.minN : 100;
  return { chase, key: bucket.key, n, cal: n >= minN };
}

// ---------------------------------------------------------------------------
// retest-entry comparison (same gates as shadowEntryFromBreakout, entry fixed at
// breakoutLevel instead of the breakout close - see this file's header, item 4)
// ---------------------------------------------------------------------------

function retestEntryFor(row, cfg) {
  if (row.retestAt === null || row.retestAt === undefined) return null;
  const direction = row.direction === 'long' || row.direction === 'short' ? row.direction : null;
  const entry = row.breakoutLevel;
  const stop = row.invalidation;
  const tp1 = row.measuredTarget;
  if (!direction || !isFiniteNumber(entry) || !isFiniteNumber(stop) || !isFiniteNumber(tp1)) return null;

  const sign = direction === 'short' ? -1 : 1;
  if (!(sign * (entry - stop) > 0) || !(sign * (tp1 - entry) > 0)) return null;

  const grossRisk = Math.abs(entry - stop);
  if (!(grossRisk > 0)) return null;
  const grossRR = roundN(Math.abs(tp1 - entry) / grossRisk, 3);
  if (grossRR === null || grossRR < cfg.minRR) return null;

  const stopDistancePct = (grossRisk / entry) * 100;
  if (!(stopDistancePct <= cfg.maxStopPct)) return null;

  const netRR = roundN(netRiskReward(entry, stop, tp1, cfg), 3);
  return { entry: roundN(entry, 2), stop: roundN(stop, 2), tp1: roundN(tp1, 2), grossRR, netRR };
}

// ---------------------------------------------------------------------------
// candle lookup
// ---------------------------------------------------------------------------

/** The candle in `candles` (ascending) whose own `timestamp` === `ms`, or null. */
function candleAt(candles, ms) {
  if (!Array.isArray(candles) || !isFiniteNumber(ms)) return null;
  // History files are sorted ascending; binary search on timestamp equality.
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = candles[mid].timestamp;
    if (t === ms) return candles[mid];
    if (t < ms) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// one row -> a shadow trial + a retest trial
// ---------------------------------------------------------------------------

/**
 * @param {Object} row - a scripts/replay-paths.js output row
 * @param {Object} fullByTf - tf -> full ascending candles (native + derived 3m), this symbol
 * @param {Array<Object>} candles1m - this symbol's full ascending 1m candles
 * @param {Object} shadowCfg - {minRR, maxStopPct, feeBps, slippageBps}
 * @param {number} windowMs
 * @returns {{row:Object, chase:Object|null, shadowGated:Object|null, shadowUngated:Object|null, retest:Object|null}}
 */
function evaluateRow(row, fullByTf, candles1m, shadowCfg, windowMs) {
  if (row.breakoutAt === null || row.breakoutAt === undefined) return null;

  const tf = row.timeframe;
  const intervalMs = INTERVAL_MS[tf];
  const breakoutCandle = candleAt(fullByTf[tf] || [], row.breakoutAt);
  const breakoutClose = breakoutCandle ? breakoutCandle.close : null;
  const breakoutCloseMs = isFiniteNumber(row.breakoutAt) && isFiniteNumber(intervalMs) ? row.breakoutAt + intervalMs : null;

  const chase = chaseFor(row);

  const base = { dir: row.direction, breakoutLevel: row.breakoutLevel, invalidation: row.invalidation, measuredTarget: row.measuredTarget, breakoutClose };
  const shadowEntry = isFiniteNumber(breakoutClose) ? shadowEntryFromBreakout(base, shadowCfg) : null;

  let shadowGated = null;
  let shadowUngated = null;
  if (shadowEntry && isFiniteNumber(breakoutCloseMs)) {
    const walked = walkShadow({ dir: row.direction, entry: shadowEntry.entry, stop: shadowEntry.stop, tp1: shadowEntry.tp1 }, candles1m, breakoutCloseMs, windowMs);
    const trial = { ...shadowEntry, ...walked, at: breakoutCloseMs };
    shadowUngated = trial;
    if (chase && (chase.chase === 'elevated' || chase.chase === 'high')) shadowGated = trial;
  }

  const retestEntry = retestEntryFor(row, shadowCfg);
  let retest = null;
  if (retestEntry && isFiniteNumber(row.retestAt)) {
    const walked = walkShadow({ dir: row.direction, entry: retestEntry.entry, stop: retestEntry.stop, tp1: retestEntry.tp1 }, candles1m, row.retestAt, windowMs);
    retest = { ...retestEntry, ...walked, at: row.retestAt };
  }

  return { row, chase, shadowGated, shadowUngated, retest };
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

function maxLosingStreak(trials) {
  let max = 0;
  let cur = 0;
  for (const t of trials) {
    if (t.outcome === 'stop') { cur++; if (cur > max) max = cur; }
    else if (t.outcome === 'tp1') { cur = 0; }
    // open/expired: unresolved, neither extends nor resets a streak
  }
  return max;
}

/**
 * @param {Array<Object>} trials - each carries {at, outcome, r, netRR}, sorted by `at`
 *   by the caller before this is called.
 */
function stats(trials) {
  const n = trials.length;
  const resolved = trials.filter((t) => t.outcome === 'tp1' || t.outcome === 'stop');
  const wins = resolved.filter((t) => t.outcome === 'tp1');
  const grossSum = trials.reduce((s, t) => s + (t.outcome === 'tp1' ? t.r : t.outcome === 'stop' ? -1 : 0), 0);
  // Net expectancy: a win's fee/slippage-adjusted reward (netRR, fixed per trial at
  // entry time) in place of gross r; a loss stays -1 (same "lost the defined risk unit"
  // convention flagTradePlan.js's grossRR/netRR pair already uses side by side - this
  // slightly understates true net cost on a stop-out, since round-trip fees are paid on
  // a loss too, not only a win; directionally correct, not a claimed penny-exact figure).
  const netSum = trials.reduce((s, t) => s + (t.outcome === 'tp1' ? (isFiniteNumber(t.netRR) ? t.netRR : 0) : t.outcome === 'stop' ? -1 : 0), 0);
  return {
    n,
    fillPct: n ? 100 : null, // prefilled by construction - never a fill-window search
    resolvedN: resolved.length,
    unresolvedN: n - resolved.length,
    winRate: resolved.length ? roundN((wins.length / resolved.length) * 100, 2) : null,
    grossExpectancyR: n ? roundN(grossSum / n, 4) : null,
    netExpectancyR: n ? roundN(netSum / n, 4) : null,
    maxLosingStreak: maxLosingStreak(trials)
  };
}

function byKey(trials, keyFn) {
  const groups = new Map();
  for (const t of trials) {
    const k = keyFn(t);
    if (k === null || k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = {};
  for (const [k, rows] of groups) out[k] = stats(rows.slice().sort((a, b) => a.at - b.at));
  return out;
}

function report(evaluated, windowHours) {
  // tf/direction/chase are attached per-trial for grouping (not part of the published
  // shadow/retest entry shape itself).
  const tag = (srcKey) => evaluated
    .filter((e) => e[srcKey])
    .map((e) => ({ ...e[srcKey], tf: e.row.timeframe, direction: e.row.direction, chase: e.chase ? e.chase.chase : 'unresolved' }));

  const gatedTagged = tag('shadowGated').sort((a, b) => a.at - b.at);
  const ungatedTagged = tag('shadowUngated').sort((a, b) => a.at - b.at);
  const retestTagged = tag('retest').sort((a, b) => a.at - b.at);

  return {
    windowHours,
    breakoutRows: evaluated.length,
    shadow: {
      gated: {
        overall: stats(gatedTagged),
        byTf: byKey(gatedTagged, (t) => t.tf),
        byChase: byKey(gatedTagged, (t) => t.chase)
      },
      ungated: {
        overall: stats(ungatedTagged),
        byTf: byKey(ungatedTagged, (t) => t.tf),
        byChase: byKey(ungatedTagged, (t) => t.chase)
      }
    },
    retest: {
      overall: stats(retestTagged),
      byTf: byKey(retestTagged, (t) => t.tf)
    }
  };
}

function printStatsTable(title, s) {
  console.log(`\n${title}`);
  console.log(`  n=${s.n} fill=${s.fillPct === null ? '-' : `${s.fillPct}%`} resolved=${s.resolvedN} unresolved=${s.unresolvedN} winRate=${s.winRate === null ? '-' : `${s.winRate}%`} grossExp=${s.grossExpectancyR === null ? '-' : `${s.grossExpectancyR}R`} netExp=${s.netExpectancyR === null ? '-' : `${s.netExpectancyR}R`} maxLosingStreak=${s.maxLosingStreak}`);
}

function printGroup(title, group) {
  console.log(`\n=== ${title} ===`);
  printStatsTable('overall', group.overall);
  for (const [k, s] of Object.entries(group.byTf || {})) printStatsTable(`tf=${k}`, s);
  for (const [k, s] of Object.entries(group.byChase || {})) printStatsTable(`chase=${k}`, s);
}

function printReport(r) {
  console.log(`\nbreakout rows evaluated: ${r.breakoutRows} (window ${r.windowHours}h)`);
  printGroup('shadow entry - chase-gated (what production would publish)', r.shadow.gated);
  printGroup('shadow entry - ungated (every breakout, chase filter removed)', r.shadow.ungated);
  printGroup('retest-hold comparison entry (same rows, entry at breakoutLevel, retestAt required)', r.retest);
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
    json: typeof opts.json === 'string' ? opts.json : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rows || !args.history) throw new Error('need --rows <rows.jsonl> --history <dir>');

  const symbols = args.symbols || SYMBOLS;
  const history = loadHistoryDir(args.history, symbols);
  const rows = readJsonl(args.rows).filter((r) => symbols.includes(r.symbol));

  const fullByTfBySymbol = {};
  const candles1mBySymbol = {};
  for (const symbol of symbols) {
    const full3m = aggregateToBuckets(history[symbol]['1m'] || [], INTERVAL_MS['1m'], INTERVAL_MS['3m']);
    fullByTfBySymbol[symbol] = { ...history[symbol], '3m': full3m };
    candles1mBySymbol[symbol] = history[symbol]['1m'] || [];
  }

  const shadowCfg = {
    minRR: ENGINE_CONFIG.flagPlan.minRR,
    maxStopPct: ENGINE_CONFIG.scalp.maxStopDistancePct,
    feeBps: ENGINE_CONFIG.risk.feeBps,
    slippageBps: ENGINE_CONFIG.risk.slippageBps
  };
  const windowMs = args.windowHours * 60 * 60 * 1000;

  const evaluated = [];
  for (const row of rows) {
    if (row.breakoutAt === null || row.breakoutAt === undefined) continue;
    const fullByTf = fullByTfBySymbol[row.symbol];
    const candles1m = candles1mBySymbol[row.symbol];
    if (!fullByTf || !candles1m) continue;
    const e = evaluateRow(row, fullByTf, candles1m, shadowCfg, windowMs);
    if (e) evaluated.push(e);
  }

  const r = report(evaluated, args.windowHours);
  printReport(r);
  if (args.json) writeFileSync(args.json, `${JSON.stringify(r, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[replay-breakout-entry] ${err.stack || err.message}`);
    process.exit(1);
  });
}

export default { chaseFor, retestEntryFor, evaluateRow, stats, byKey, report, parseArgs };
