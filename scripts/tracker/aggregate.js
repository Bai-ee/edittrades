#!/usr/bin/env node
/**
 * EditTrades call tracker - aggregates (T1, docs/PLAN_CALL_TRACKER.md item 4).
 *
 * Reads data/outcomes.jsonl, data/calls/*.jsonl and data/candles/1m.jsonl; writes
 * data/aggregates.json. Numbers only - nothing here tunes a threshold. R is gross
 * (before fees/slippage); the plan's own netRR is averaged alongside.
 *
 * "Tradable" calls = plan calls with status ready (what the tiles use). Class and
 * reason tables use recommendation calls. Win rate = tp1 / (tp1 + stop); expectancy =
 * mean gross R over decided calls (tp1 = +R, stop = -1).
 *
 * Usage: node aggregate.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJson, outcomesFile, aggregatesFile } from './store.js';
import { round, median, isFiniteNumber } from './walk-outcome.js';

const DAY = 24 * 60 * 60 * 1000;
export const CAPTURE_GAP_MINUTES = 20;
export const DAILY_LOG_DAYS = 7;
export const DAILY_LOG_MAX_ROWS = 400;

const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : 'unknown');
const isDecided = (r) => r.outcome === 'tp1' || r.outcome === 'stop';
export const isTradable = (r) => r.kind === 'plan' && r.planStatus === 'ready';
export const isRec = (r) => r.kind === 'rec';

/** Core numbers for any set of outcome rows. */
export function statsFor(rows) {
  const decided = rows.filter(isDecided)
    .sort((a, b) => Date.parse(a.resolvedAt || a.calledAt) - Date.parse(b.resolvedAt || b.calledAt));
  const wins = decided.filter((r) => r.outcome === 'tp1');
  const losses = decided.length - wins.length;
  let streak = 0;
  let maxLosingStreak = 0;
  for (const r of decided) {
    if (r.outcome === 'stop') { streak++; maxLosingStreak = Math.max(maxLosingStreak, streak); } else streak = 0;
  }
  const rs = decided.map((r) => (r.outcome === 'stop' ? -1 : r.r)).filter(isFiniteNumber);
  const winRs = wins.map((r) => r.r).filter(isFiniteNumber);
  const net = rows.filter((r) => r.filledAt && isFiniteNumber(r.netRR)).map((r) => r.netRR);
  const count = (o) => rows.filter((r) => r.outcome === o).length;
  return {
    calls: rows.length,
    fills: rows.filter((r) => r.filledAt).length,
    wins: wins.length,
    losses,
    open: count('open'),
    pending: count('pending'),
    expired: count('expired'),
    notFilled: count('not_filled'),
    rejected: count('rejected'),
    noLevels: count('no_levels'),
    winRate: decided.length ? round(wins.length / decided.length) : null,
    avgWinR: winRs.length ? round(winRs.reduce((a, b) => a + b, 0) / winRs.length) : null,
    expectancy: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null,
    avgNetRR: net.length ? round(net.reduce((a, b) => a + b, 0) / net.length) : null,
    maxLosingStreak,
    medianMinutesToTP1: median(wins.map((r) => r.minutesToResolution).filter(isFiniteNumber))
  };
}

/** [{key, ...statsFor(group)}], largest group first. */
export function groupStats(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r) ?? 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...statsFor(g) }))
    .sort((a, b) => b.calls - a.calls || String(a.key).localeCompare(String(b.key)));
}

function reasonCounts(rows) {
  const has = (r, s) => typeof r.reasonCode === 'string' && r.reasonCode.includes(s);
  const planOrRec = rows.filter((r) => isRec(r) || r.kind === 'plan');
  return {
    chase: planOrRec.filter((r) => has(r, 'chase')).length,
    rr_below_min: planOrRec.filter((r) => has(r, 'rr_below_min')).length,
    room: planOrRec.filter((r) => has(r, 'room')).length
  };
}

function windowBlock(rows, sinceMs) {
  const inWin = rows.filter((r) => Date.parse(r.calledAt) >= sinceMs);
  const tradable = inWin.filter(isTradable);
  return {
    tradable: statsFor(tradable),
    byClass: groupStats(inWin.filter(isRec), (r) => r.class),
    byReason: groupStats(inWin.filter(isRec), (r) => r.reasonCode),
    bySymbol: groupStats(tradable, (r) => r.symbol),
    byTimeframe: groupStats(tradable, (r) => r.timeframe),
    byPlanStatus: groupStats(inWin.filter((r) => r.kind === 'plan'), (r) => r.planStatus),
    reasonCounts: reasonCounts(inWin)
  };
}

/** Capture health: counts, gaps, DATA_UNAVAILABLE, mark drift, 1m candle coverage. */
export function captureStats(captureRows, candles1mBySymbol = {}) {
  const bySymbol = new Map();
  for (const row of captureRows) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
    bySymbol.get(row.symbol).push(Date.parse(row.closedThrough));
  }
  let gaps = 0;
  let longestGapMinutes = 0;
  for (const times of bySymbol.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      const mins = (times[i] - times[i - 1]) / 60_000;
      if (mins > CAPTURE_GAP_MINUTES) { gaps++; longestGapMinutes = Math.max(longestGapMinutes, mins); }
    }
  }
  const drifts = captureRows.map((r) => (r.mark && isFiniteNumber(r.mark.driftBps) ? Math.abs(r.mark.driftBps) : null)).filter(isFiniteNumber);
  const sortedDrift = [...drifts].sort((a, b) => a - b);
  let missing1m = 0;
  for (const candles of Object.values(candles1mBySymbol)) {
    if (candles.length < 2) continue;
    const span = (candles[candles.length - 1].timestamp - candles[0].timestamp) / 60_000 + 1;
    missing1m += Math.max(0, span - candles.length);
  }
  return {
    captures: captureRows.length,
    symbols: [...bySymbol.keys()].sort(),
    gaps,
    longestGapMinutes: round(longestGapMinutes, 1),
    dataUnavailable: captureRows.filter((r) => (r.flagRecommendation && r.flagRecommendation.class === 'DATA_UNAVAILABLE')
      || (r.dataStatus && r.dataStatus !== 'complete')).length,
    markDriftBps: {
      samples: drifts.length,
      medianAbs: median(sortedDrift),
      p95Abs: sortedDrift.length ? sortedDrift[Math.min(sortedDrift.length - 1, Math.floor(sortedDrift.length * 0.95))] : null,
      maxAbs: sortedDrift.length ? sortedDrift[sortedDrift.length - 1] : null,
      notOk: captureRows.filter((r) => r.mark && r.mark.status && r.mark.status !== 'ok').length
    },
    candles1m: Object.fromEntries(Object.entries(candles1mBySymbol).map(([s, c]) => [s, c.length])),
    missing1mCandles: missing1m
  };
}

/**
 * Everything the page and report need.
 * @param {Array<Object>} outcomes
 * @param {Array<Object>} captureRows
 * @param {Object<string, Array<Object>>} candles1mBySymbol
 * @param {number} [nowMs=Date.now()]
 * @param {{phaseStartMs?: number}} [opts] phaseStartMs adds `phase` (ready-plan stats called since then)
 */
export function computeAggregates(outcomes, captureRows, candles1mBySymbol = {}, nowMs = Date.now(), opts = {}) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const recs = outcomes.filter(isRec);
  const tradable = outcomes.filter(isTradable);
  const w7 = windowBlock(outcomes, nowMs - 7 * DAY);
  const w30 = windowBlock(outcomes, nowMs - 30 * DAY);
  const lastCapture = captureRows.reduce((m, r) => (r.capturedAt && (!m || r.capturedAt > m) ? r.capturedAt : m), null);
  const lastClosedThrough = captureRows.reduce((m, r) => (r.closedThrough && (!m || r.closedThrough > m) ? r.closedThrough : m), null);

  const days = [...new Set(outcomes.map((r) => dayOf(r.calledAt)))].sort().reverse();
  const byDay = days.map((day) => {
    const rows = outcomes.filter((r) => dayOf(r.calledAt) === day);
    const t = statsFor(rows.filter(isTradable));
    return {
      day,
      recCalls: rows.filter(isRec).length,
      good: rows.filter((r) => isRec(r) && r.class === 'GOOD').length,
      watch: rows.filter((r) => isRec(r) && r.class === 'WATCH').length,
      bad: rows.filter((r) => isRec(r) && r.class === 'BAD').length,
      dataUnavailable: rows.filter((r) => isRec(r) && r.class === 'DATA_UNAVAILABLE').length,
      ready: t.calls, fills: t.fills, wins: t.wins, losses: t.losses, expectancy: t.expectancy
    };
  });

  const logSince = nowMs - DAILY_LOG_DAYS * DAY;
  const dailyLog = outcomes
    .filter((r) => Date.parse(r.calledAt) >= logSince && (isRec(r) || r.planStatus !== 'rejected'))
    .sort((a, b) => Date.parse(b.calledAt) - Date.parse(a.calledAt))
    .slice(0, DAILY_LOG_MAX_ROWS);

  const openCalls = outcomes
    .filter((r) => r.outcome === 'open' || r.outcome === 'pending')
    .sort((a, b) => Date.parse(b.calledAt) - Date.parse(a.calledAt));

  const t7 = w7.tradable;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    label: 'provisional; not evidence of an edge',
    rUnits: 'gross_R_before_fees_slippage',
    tiles: {
      lastCapture,
      lastClosedThrough,
      callsToday: recs.filter((r) => dayOf(r.calledAt) === today).length,
      goodToday: recs.filter((r) => r.class === 'GOOD' && dayOf(r.calledAt) === today).length,
      fills7d: t7.fills,
      winRate7d: t7.winRate,
      expectancy7d: t7.expectancy,
      losingStreak7d: t7.maxLosingStreak
    },
    totals: { outcomes: outcomes.length, recCalls: recs.length, tradable: statsFor(tradable) },
    windows: { '7d': w7, '30d': w30 },
    byDay,
    openCalls,
    dailyLog,
    captures: captureStats(captureRows, candles1mBySymbol),
    phase: isFiniteNumber(opts.phaseStartMs)
      ? { startedAt: new Date(opts.phaseStartMs).toISOString(), tradable: statsFor(tradable.filter((r) => Date.parse(r.calledAt) >= opts.phaseStartMs)) }
      : null
  };
}

export function aggregateDataDir(dataDir, nowMs = Date.now(), opts = {}) {
  const agg = computeAggregates(readJsonl(outcomesFile(dataDir)), readAllCalls(dataDir), readCandles(dataDir, '1m'), nowMs, opts);
  writeJson(aggregatesFile(dataDir), agg);
  return agg;
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const agg = aggregateDataDir(opts.data, nowMs);
  console.log(`[tracker:aggregate] ${agg.totals.outcomes} outcome row(s), ${agg.captures.captures} capture row(s) -> ${aggregatesFile(opts.data)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:aggregate] ${err.message}`);
    process.exit(1);
  }
}
