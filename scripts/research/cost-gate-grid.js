#!/usr/bin/env node
/**
 * Research-only (docs/COST_GATE_STUDY_2026-09-26.md). Reads a variant's
 * scripts/replay-rules.js .calls.jsonl output and applies a post-filter grid
 * (minStopPct x maxCostR) to test whether a cost-to-risk gate turns the flag
 * strategy's baseline expectancy positive. A post-filter is valid research
 * methodology here because it only ever REMOVES calls from an already-scored,
 * no-lookahead replay - it can't invent new trades or change how any kept
 * trade resolved.
 *
 * costR = dirCostPct(direction) / stopDistancePct, both in percent units
 * (dirCostPct: long 0.34, short 0.14 - docs/OWNER_DECISIONS_2026-09-24.md
 * D-cost decision, same convention scripts/replay-rules.js's netR_sens034/
 * netR_sens014 already encode per-direction). "Dir-cost net R" per call is
 * netR_sens034 for a long, netR_sens014 for a short (verified against
 * scripts/replay-rules.js lines ~96-178).
 *
 * Usage: node scripts/research/cost-gate-grid.js <label> <calls.jsonl> <manifest.json> [symbolsCsv]
 * Prints a JSON blob (grid cells + long/short splits for the 3 richest cells) to stdout.
 * Not wired into any test or deploy path; ad hoc CLI only.
 */
import { readFileSync } from 'node:fs';

const DIR_COST_PCT = { long: 0.34, short: 0.14 };
const MIN_STOP_GRID = [null, 0.1, 0.3, 0.5, 0.8, 1.0, 1.4];
const MAX_COSTR_GRID = [null, 0.25, 0.35, 0.5];

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function round(v, d = 4) {
  if (!isNum(v)) return null;
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

function median(values) {
  const xs = values.filter(isNum).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function dirCostNetR(c) {
  // scripts/replay-rules.js: netR_sens034 (0.34% round trip) for long, netR_sens014 (0.14%) for short.
  if (c.direction === 'long') return c.netR_sens034;
  if (c.direction === 'short') return c.netR_sens014;
  return c.netR; // fallback, shouldn't occur for scored flag calls
}

function costRFor(c) {
  const dc = DIR_COST_PCT[c.direction];
  if (!isNum(dc) || !isNum(c.stopDistancePct) || c.stopDistancePct <= 0) return null;
  return dc / c.stopDistancePct;
}

function maxLosingStreak(calls) {
  let max = 0, cur = 0;
  for (const c of calls.slice().sort((a, b) => Date.parse(a.firstReadyAt) - Date.parse(b.firstReadyAt))) {
    if (c.outcome === 'loss') { cur++; if (cur > max) max = cur; }
    else if (c.outcome === 'win') cur = 0;
  }
  return max;
}

function statsFor(calls, spanFromMs, spanToMs) {
  const n = calls.length;
  const resolved = calls.filter((c) => c.outcome === 'win' || c.outcome === 'loss');
  const wins = resolved.filter((c) => c.outcome === 'win');
  const losses = resolved.filter((c) => c.outcome === 'loss');
  const dirNet = calls.map(dirCostNetR);
  const grossSum = calls.reduce((s, c) => s + (isNum(c.grossR) ? c.grossR : 0), 0);
  const dirNetSum = dirNet.reduce((s, v) => s + (isNum(v) ? v : 0), 0);
  const avgWinR = wins.length ? wins.reduce((s, c) => s + dirCostNetR(c), 0) / wins.length : null;
  const avgLossR = losses.length ? losses.reduce((s, c) => s + dirCostNetR(c), 0) / losses.length : null; // negative
  const beWinPct = (isNum(avgWinR) && isNum(avgLossR) && (avgWinR + Math.abs(avgLossR)) > 0)
    ? round((Math.abs(avgLossR) / (avgWinR + Math.abs(avgLossR))) * 100, 2)
    : null;
  const totalDays = spanToMs && spanFromMs ? (spanToMs - spanFromMs) / 86400000 : null;
  const boundary = spanFromMs && spanToMs ? spanFromMs + (spanToMs - spanFromMs) / 2 : null;
  const firstHalf = boundary ? calls.filter((c) => Date.parse(c.firstReadyAt) < boundary) : [];
  const secondHalf = boundary ? calls.filter((c) => Date.parse(c.firstReadyAt) >= boundary) : [];
  const halfExp = (cs) => {
    if (!cs.length) return null;
    const s = cs.reduce((acc, c) => acc + (isNum(dirCostNetR(c)) ? dirCostNetR(c) : 0), 0);
    return round(s / cs.length, 4);
  };
  const firstNet = halfExp(firstHalf);
  const secondNet = halfExp(secondHalf);
  return {
    n,
    resolved: resolved.length,
    winPct: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    avgGrossR: n ? round(grossSum / n, 4) : null,
    avgDirCostNetR: n ? round(dirNetSum / n, 4) : null,
    medianNetR: median(resolved.map(dirCostNetR)),
    avgRealizedWinR: round(avgWinR, 4),
    avgRealizedLossR: round(avgLossR, 4),
    netBreakevenWinPct: beWinPct,
    maxLosingStreak: maxLosingStreak(calls),
    callsPerDay: totalDays ? round(n / totalDays, 3) : null,
    oosFirstHalfN: firstHalf.length,
    oosSecondHalfN: secondHalf.length,
    oosFirstHalfNetR: firstNet,
    oosSecondHalfNetR: secondNet,
    oosPass: isNum(firstNet) && isNum(secondNet) && firstNet > 0 && secondNet > 0
  };
}

function filterCalls(calls, minStopPct, maxCostR) {
  return calls.filter((c) => {
    if (isNum(minStopPct) && !(isNum(c.stopDistancePct) && c.stopDistancePct >= minStopPct)) return false;
    if (isNum(maxCostR)) {
      const cr = costRFor(c);
      if (!(isNum(cr) && cr <= maxCostR)) return false;
    }
    return true;
  });
}

function buildGrid(calls, spanFromMs, spanToMs) {
  const cells = [];
  for (const minStopPct of MIN_STOP_GRID) {
    for (const maxCostR of MAX_COSTR_GRID) {
      const filtered = filterCalls(calls, minStopPct, maxCostR);
      cells.push({ minStopPct: minStopPct ?? 'none', maxCostR: maxCostR ?? 'none', ...statsFor(filtered, spanFromMs, spanToMs) });
    }
  }
  return cells;
}

function readSpan(manifestPath, symbols) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  let fromMs = null, toMs = null;
  for (const symbol of symbols) {
    const entry = manifest.files && manifest.files[`${symbol}_1m.json`];
    if (!entry) continue;
    const f = Date.parse(entry.from);
    const t = Date.parse(entry.closedThrough);
    if (fromMs === null || f < fromMs) fromMs = f;
    if (toMs === null || t > toMs) toMs = t;
  }
  return { fromMs, toMs };
}

function main() {
  const [label, callsPath, manifestPath, symbolsCsv] = process.argv.slice(2);
  if (!label || !callsPath || !manifestPath) {
    console.error('usage: node cost-gate-grid.js <label> <calls.jsonl> <manifest.json> [symbolsCsv]');
    process.exit(1);
  }
  const symbols = (symbolsCsv || 'BTC,SOL,ETH').split(',');
  const raw = readFileSync(callsPath, 'utf8').trim();
  const calls = raw ? raw.split('\n').map((l) => JSON.parse(l)) : [];
  const { fromMs, toMs } = readSpan(manifestPath, symbols);

  const cells = buildGrid(calls, fromMs, toMs);

  // Best 3 cells by avgDirCostNetR among cells with n >= 30, tie-broken by n desc.
  const eligible = cells.filter((c) => c.n >= 30 && isNum(c.avgDirCostNetR));
  const best3 = eligible.slice().sort((a, b) => b.avgDirCostNetR - a.avgDirCostNetR || b.n - a.n).slice(0, 3);

  const longShortForBest3 = best3.map((cell) => {
    const filtered = filterCalls(calls, cell.minStopPct === 'none' ? null : cell.minStopPct, cell.maxCostR === 'none' ? null : cell.maxCostR);
    const longOnly = filtered.filter((c) => c.direction === 'long');
    const shortOnly = filtered.filter((c) => c.direction === 'short');
    return {
      cell: { minStopPct: cell.minStopPct, maxCostR: cell.maxCostR },
      long: statsFor(longOnly, fromMs, toMs),
      short: statsFor(shortOnly, fromMs, toMs)
    };
  });

  console.log(JSON.stringify({
    label,
    n: calls.length,
    spanFromIso: fromMs ? new Date(fromMs).toISOString() : null,
    spanToIso: toMs ? new Date(toMs).toISOString() : null,
    totalDays: fromMs && toMs ? round((toMs - fromMs) / 86400000, 2) : null,
    cells,
    best3,
    longShortForBest3
  }, null, 2));
}

main();
