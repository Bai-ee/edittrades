#!/usr/bin/env node
/**
 * S3 retest-entry study analysis (docs/PROMPT_S3_RETEST_ENTRY.md) - reads the per-rule
 * JSON files scripts/swing/run.js writes under docs/swing/<id>.json and produces the
 * combined-table + R-outcome-histogram numbers the study report needs, without
 * re-running the harness. Read-only: no fs writes besides the printed JSON.
 *
 * Usage: node scripts/swing/analyze-retest.js <rule-id> [<rule-id> ...]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RESOLVED = new Set(['win', 'loss', 'timeout', 'structure_exit']);
const grossR = (row) => (row.outcome.status === 'loss' ? -1 : row.outcome.r);

function bucket(r) {
  if (r <= 0) return '-1';
  if (r <= 1) return '0-1';
  if (r <= 2) return '1-2';
  if (r <= 3) return '2-3';
  return '>=3';
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(v, n = 4) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : null;
}

function analyzeRows(rows) {
  const resolved = rows.filter((r) => RESOLVED.has(r.outcome.status));
  const wins = resolved.filter((r) => grossR(r) > 0);
  const grossRs = resolved.map(grossR);
  const netDirRs = resolved.map((r) => r.netDir).filter((v) => v !== null);
  const netMedian = median(netDirRs);
  const netMean = netDirRs.length ? netDirRs.reduce((a, b) => a + b, 0) / netDirRs.length : null;
  const grossMean = grossRs.length ? grossRs.reduce((a, b) => a + b, 0) / grossRs.length : null;
  const grossMedian = median(grossRs);
  const stopPcts = rows.map((r) => Math.abs(r.entry - r.stop) / r.entry * 100);
  const holds = resolved.map((r) => r.outcome.holdCandles);
  const histCounts = { '-1': 0, '0-1': 0, '1-2': 0, '2-3': 0, '>=3': 0 };
  for (const g of grossRs) histCounts[bucket(g)]++;
  const structureExits = resolved.filter((r) => r.outcome.status === 'structure_exit').length;
  const timeouts = resolved.filter((r) => r.outcome.status === 'timeout' || r.outcome.status === 'data_end').length;
  return {
    n: rows.length,
    resolved: resolved.length,
    filledPct: rows.length ? round((resolved.length / rows.length) * 100, 2) : null,
    winPct: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    grossMeanR: round(grossMean, 4),
    grossMedianR: round(grossMedian, 4),
    netMeanR: round(netMean, 4),
    netMedianR: round(netMedian, 4),
    medianStopPct: stopPcts.length ? round(median(stopPcts), 3) : null,
    medianHoldHours: holds.length ? round(median(holds) / 60, 2) : null,
    structureExits,
    timeouts,
    histogram: histCounts
  };
}

function splitHalvesMedian(resolvedRows) {
  const mid = Math.floor(resolvedRows.length / 2);
  const first = resolvedRows.slice(0, mid).map((r) => r.netDir).filter((v) => v !== null);
  const second = resolvedRows.slice(mid).map((r) => r.netDir).filter((v) => v !== null);
  return { firstHalfMedian: round(median(first), 4), secondHalfMedian: round(median(second), 4) };
}

function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('usage: node scripts/swing/analyze-retest.js <rule-id> [<rule-id> ...]');
    process.exit(1);
  }
  const out = {};
  for (const id of ids) {
    const file = path.join('docs/swing', `${id}.json`);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const perSymbol = {};
    let combinedRows = [];
    for (const [sym, data] of Object.entries(j.perSymbol)) {
      perSymbol[sym] = analyzeRows(data.signals);
      combinedRows = combinedRows.concat(data.signals);
    }
    const combined = analyzeRows(combinedRows);
    const resolvedSorted = combinedRows.filter((r) => RESOLVED.has(r.outcome.status));
    const oos = splitHalvesMedian(resolvedSorted);
    const daysSpan = null; // computed by the caller from the fixture span if needed
    out[id] = { meta: j.meta, perSymbol, combined, oos, daysSpan };
  }
  console.log(JSON.stringify(out, null, 2));
}

main();
