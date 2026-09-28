#!/usr/bin/env node
/**
 * WP10 item 6 — R10+ drift-baseline report.
 *
 * Freezes a baseline from the earliest half of scored calls (expectancy, TP/stop rates,
 * cost drag, frequency, calibration proxy) and states INSUFFICIENT/OK/WATCH/ALERT for the
 * latest window against simple, explicitly provisional rules. Never changes anything -
 * this is a report generator, not a monitor; it is not wired to run automatically and
 * touches no live config.
 *
 * "Scored calls" here = the tracker's own `data/outcomes.jsonl` rows with a resolved
 * tp1/stop outcome (kind rec+plan combined - the only rows with a definite win/loss and an
 * R). Split chronologically by `calledAt` into an earlier baseline half and a later
 * "current window" half. With five capture days total, both halves are necessarily small;
 * INSUFFICIENT is the expected, correct state today, not a bug in the rule.
 *
 * Read-only. Usage: node scripts/research/tracker-evidence/drift.js [--data <dir>] [--out <dir>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { readTrackerOutcomes, mean, round, isFiniteNumber } from './lib.js';
import { netR as netRFromCosts } from '../../tracker/costs.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { data: '../edittrades-tracker/data', out: 'var/research/wp10-tracker-evidence' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

// Provisional thresholds (documented here, not tuned against this dataset - there is not
// enough data yet to tune anything; these are round, defensible starting numbers a human
// should revisit once n is large enough to matter).
export const MIN_N = 30;
export const THRESHOLDS = Object.freeze({
  watchExpectancyDropR: 0.2,
  alertExpectancyDropR: 0.5,
  watchTp1RateDropPct: 15,
  alertTp1RateDropPct: 30
});

/**
 * The tracker's own flag-plan ledger only (`kind: 'plan'` - ready/conditional-then-ready
 * ), not the `rec`-kind WATCH/BAD counterfactual walks: a `rec` row and a `plan` row can
 * describe the SAME event (score.js scores a ready plan both as a plan and, at the same
 * moment, as a GOOD rec), so mixing kinds double-counts identical trades. `rec`-kind
 * WATCH/BAD counterfactual rows also carry a known cost-model artifact worth flagging
 * separately, not folding into a baseline/current split: many are 1m/3m-timeframe
 * candidates with very tight stops (well under 0.1% of entry), and the tracker's flat
 * round-trip cost model (`costs.js`, 14-34bps) turns that into several R of cost drag per
 * trade once expressed as a fraction of that tiny stop distance - see
 * `docs/research/harness/WP10_TRACKER_EVIDENCE.md` for the worked example.
 */
export function resolvedRows(outcomeRows) {
  return outcomeRows.filter((r) => r.kind === 'plan' && (r.outcome === 'tp1' || r.outcome === 'stop') && isFiniteNumber(r.r));
}

export function statsOf(rows) {
  const n = rows.length;
  const tp1 = rows.filter((r) => r.outcome === 'tp1').length;
  const grossR = rows.map((r) => r.r);
  const netR = rows.map((r) => {
    if (!isFiniteNumber(r.entry) || !isFiniteNumber(r.stop)) return r.r;
    const net = netRFromCosts(r.entry, r.stop, r.r, r.direction);
    return net === null ? r.r : net;
  });
  const days = new Set(rows.map((r) => (r.calledAt ? r.calledAt.slice(0, 10) : null)).filter(Boolean));
  return {
    n,
    tp1Rate: n ? round((tp1 / n) * 100, 2) : null,
    stopRate: n ? round(((n - tp1) / n) * 100, 2) : null,
    meanGrossR: mean(grossR),
    meanNetR: mean(netR),
    costDragR: (isFiniteNumber(mean(grossR)) && isFiniteNumber(mean(netR))) ? round(mean(grossR) - mean(netR), 4) : null,
    callsPerDay: days.size ? round(n / days.size, 2) : null,
    dayCount: days.size
  };
}

/** OK/WATCH/ALERT/INSUFFICIENT per THRESHOLDS, comparing `current` against `baseline`. Never mutates anything. */
export function driftState(baseline, current) {
  if (baseline.n < MIN_N || current.n < MIN_N) return { state: 'INSUFFICIENT', reason: `n<${MIN_N} (baseline n=${baseline.n}, current n=${current.n})` };
  const expectancyDrop = isFiniteNumber(baseline.meanNetR) && isFiniteNumber(current.meanNetR) ? round(baseline.meanNetR - current.meanNetR, 4) : null;
  const tp1RateDrop = isFiniteNumber(baseline.tp1Rate) && isFiniteNumber(current.tp1Rate) ? round(baseline.tp1Rate - current.tp1Rate, 2) : null;
  if ((expectancyDrop !== null && expectancyDrop >= THRESHOLDS.alertExpectancyDropR) || (tp1RateDrop !== null && tp1RateDrop >= THRESHOLDS.alertTp1RateDropPct)) {
    return { state: 'ALERT', expectancyDrop, tp1RateDrop };
  }
  if ((expectancyDrop !== null && expectancyDrop >= THRESHOLDS.watchExpectancyDropR) || (tp1RateDrop !== null && tp1RateDrop >= THRESHOLDS.watchTp1RateDropPct)) {
    return { state: 'WATCH', expectancyDrop, tp1RateDrop };
  }
  return { state: 'OK', expectancyDrop, tp1RateDrop };
}

export function run(dataDir) {
  const outcomeRows = readTrackerOutcomes(dataDir);
  const resolved = resolvedRows(outcomeRows).sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt));
  const mid = Math.floor(resolved.length / 2);
  const baselineRows = resolved.slice(0, mid);
  const currentRows = resolved.slice(mid);
  const baseline = statsOf(baselineRows);
  const current = statsOf(currentRows);
  const drift = driftState(baseline, current);
  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    thresholds: THRESHOLDS,
    minN: MIN_N,
    totalResolved: resolved.length,
    baseline,
    current,
    drift,
    note: 'Never auto-retunes, retrains, promotes or changes leverage/stops. This report is evidence for a human decision only.'
  };
}

function main() {
  const opts = parseArgs();
  const result = run(opts.data);
  mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'drift.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`[wp10:drift] baseline n=${result.baseline.n} current n=${result.current.n} -> ${result.drift.state} -> ${outFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
