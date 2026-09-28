#!/usr/bin/env node
/**
 * T-20 HTF-entry study analysis (docs/PROMPT_T20_HTF_ENTRY.md deliverable 4) - reads the
 * per-rule JSON files scripts/swing/run.js writes under docs/swing/<id>.json and produces
 * the standard table (n, filled %, win %, gross/net R mean+median, bootstrap 90% lower
 * bound, median stop %, median hold, signals/week, OOS halves, R histogram) without
 * re-running the harness. Read-only: no fs writes besides the printed JSON.
 *
 * Same shape as scripts/swing/analyze-retest.js (S3), extended with the two columns that
 * study did not need: `bootstrapMeanLowerBound90` (scripts/tracker/aggregate.js, the SAME
 * seeded-resample function the tracker's own RETEST_1H/HTF_1M classes use) and
 * signals/week (fixture span: `deep2y-2026-09-26` is 2024-10-01 -> 2026-09-27, ~103.7
 * weeks - the same span docs/RETEST_ENTRY_STUDY_2026-09-27.md quotes for this identical
 * fixture, reused here rather than re-derived).
 *
 * Usage: node scripts/swing/analyze-htf.js <rule-id> [<rule-id> ...]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { bootstrapMeanLowerBound90 } from '../tracker/aggregate.js';

const RESOLVED = new Set(['win', 'loss', 'timeout', 'structure_exit']);
const grossR = (row) => (row.outcome.status === 'loss' ? -1 : row.outcome.r);

// deep2y-2026-09-26 manifest: startRequested 2024-10-01T00:00:00.000Z, closedThrough
// 2026-09-27T03:06:00.000Z - the same span docs/RETEST_ENTRY_STUDY_2026-09-27.md's own
// "Method" section quotes ("~103.7 weeks") for this identical fixture.
export const FIXTURE_WEEKS = 103.7;

function bucket(r) {
  if (r <= 0) return '-1';
  if (r <= 1) return '0-1';
  if (r <= 2) return '1-2';
  if (r <= 3) return '2-3';
  return '>=3';
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(v, n = 4) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

export function analyzeRows(rows, weeks = FIXTURE_WEEKS) {
  const resolved = rows.filter((r) => RESOLVED.has(r.outcome.status));
  const wins = resolved.filter((r) => grossR(r) > 0);
  const grossRs = resolved.map(grossR);
  const netDirRs = resolved.map((r) => r.netDir).filter((v) => v !== null);
  const netMean = netDirRs.length ? netDirRs.reduce((a, b) => a + b, 0) / netDirRs.length : null;
  const grossMean = grossRs.length ? grossRs.reduce((a, b) => a + b, 0) / grossRs.length : null;
  const stopPcts = rows.map((r) => Math.abs(r.entry - r.stop) / r.entry * 100);
  const holds = resolved.map((r) => r.outcome.holdCandles);
  const histCounts = { '-1': 0, '0-1': 0, '1-2': 0, '2-3': 0, '>=3': 0 };
  for (const g of grossRs) histCounts[bucket(g)]++;
  return {
    n: rows.length,
    resolved: resolved.length,
    filledPct: rows.length ? round((resolved.length / rows.length) * 100, 2) : null,
    winPct: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    grossMeanR: round(grossMean, 4),
    grossMedianR: round(median(grossRs), 4),
    netMeanR: round(netMean, 4),
    netMedianR: round(median(netDirRs), 4),
    netBootstrapLowerBound90: bootstrapMeanLowerBound90(netDirRs),
    medianStopPct: stopPcts.length ? round(median(stopPcts), 3) : null,
    medianHoldHours: holds.length ? round(median(holds) / 60, 2) : null,
    signalsPerWeek: weeks > 0 ? round(rows.length / weeks, 3) : null,
    histogram: histCounts
  };
}

function splitHalvesMedian(resolvedRows) {
  const mid = Math.floor(resolvedRows.length / 2);
  const first = resolvedRows.slice(0, mid).map((r) => r.netDir).filter((v) => v !== null);
  const second = resolvedRows.slice(mid).map((r) => r.netDir).filter((v) => v !== null);
  return {
    firstHalfMedian: round(median(first), 4),
    secondHalfMedian: round(median(second), 4),
    firstHalfMean: round(first.length ? first.reduce((a, b) => a + b, 0) / first.length : null, 4),
    secondHalfMean: round(second.length ? second.reduce((a, b) => a + b, 0) / second.length : null, 4)
  };
}

export function analyzeRule(id, outDir = 'docs/swing', weeks = FIXTURE_WEEKS) {
  const file = path.join(outDir, `${id}.json`);
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const perSymbol = {};
  let combinedRows = [];
  for (const [sym, data] of Object.entries(j.perSymbol)) {
    perSymbol[sym] = analyzeRows(data.signals, weeks);
    combinedRows = combinedRows.concat(data.signals);
  }
  const combined = analyzeRows(combinedRows, weeks);
  const resolvedSorted = combinedRows.filter((r) => RESOLVED.has(r.outcome.status));
  const oos = splitHalvesMedian(resolvedSorted);
  return { meta: j.meta, perSymbol, combined, oos };
}

function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('usage: node scripts/swing/analyze-htf.js <rule-id> [<rule-id> ...]');
    process.exit(1);
  }
  const out = {};
  for (const id of ids) out[id] = analyzeRule(id);
  console.log(JSON.stringify(out, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('analyze-htf.js');
if (isMain) main();
