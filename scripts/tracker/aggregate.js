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
 * classCheck: per recommendation class (GOOD/WATCH/BAD, then DATA_UNAVAILABLE when
 * present), how its calls played out on plan or candidate levels (score.js levelSource),
 * since the phase start when given. Answers "did the filter block losers?". WATCH/BAD/
 * DATA_UNAVAILABLE never feed the tradable numbers; the GOOD row now can (see T-12 below).
 *
 * Served rows (T3, source 'served') feed calls and scoring like cron rows, but never the
 * capture-health numbers, last capture or run counts (those describe the cron job).
 * activity.served24h / servedGood24h count served rows (and GOOD ones) in the last 24 h.
 *
 * Telegram alerts (`alerts`, computeAlertAggregates): from data/alert-outcomes.jsonl
 * (score.js scoreAlerts) and data/transitions/: sent alerts by kind and verdict per day,
 * median latency (sentAt - producing candle close), "alerted -> later GOOD" rate (alerts
 * before any GET IN NOW whose candidate later reached a ready plan), "BE READY -> GET IN
 * NOW within 30 min" rate (BE READY alerts at least 30 min old), and engine transitions
 * per hour by timeframe over the last 24 h (span capped to the logged time).
 *
 * GOOD calls from the 1-minute alert log (T-12, docs/GAP_CHECK_2026-09-26.md):
 * `data/good-call-outcomes.jsonl` (score.js scoreGoodCalls) merges the Telegram cron's
 * per-minute GOOD/GOOD_ENDED alert log with the 10-minute captures, one row per
 * symbol+candidateId. When it has rows in a window, classCheck's GOOD row, windowBlock's
 * tradable/bySymbol/byTimeframe stats and the phase block's 30-plan target all read from it
 * instead of the capture-only ready-plan rows - the 10-minute captures are kept for
 * everything else (WATCH/BAD counterfactuals, levels fallback, wallet). Empty/missing falls
 * back to the old capture-only behavior. classCheck's GOOD row also carries
 * `oneMinLogCalls` / `capturedCalls` (how many of its calls came from each source) and
 * `medianGoodWindowMin` (GOOD->GOOD_ENDED span). `goodCallLogSince` (top level) is the
 * earliest day an alert-sourced GOOD call was seen, for the page's one-line note.
 *
 * Usage: node aggregate.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJson, outcomesFile, aggregatesFile, alertOutcomesFile, readTransitions, goodCallOutcomesFile } from './store.js';
import { round, median, isFiniteNumber } from './walk-outcome.js';
import { costR } from './costs.js';

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
  // Net R (T5 S1, fees + slippage): gross R minus round-trip cost in R, cost from
  // scripts/tracker/costs.js (mirrors lib/flagTradePlan.js's netRiskReward cost model -
  // see costs.js's own header). Only decided rows with usable entry/stop levels count;
  // outcomes.jsonl itself is never written to.
  const costRs = [];
  const netRs = [];
  for (const r of decided) {
    const gross = r.outcome === 'stop' ? -1 : r.r;
    if (!isFiniteNumber(gross)) continue;
    const cost = costR(r.entry, r.stop, r.direction);
    if (cost === null) continue;
    costRs.push(cost);
    netRs.push(gross - cost);
  }
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
    avgCostR: costRs.length ? round(costRs.reduce((a, b) => a + b, 0) / costRs.length) : null,
    netExpectancy: netRs.length ? round(netRs.reduce((a, b) => a + b, 0) / netRs.length) : null,
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

export const CLASS_CHECK_KEYS = ['GOOD', 'WATCH', 'BAD', 'DATA_UNAVAILABLE'];

/**
 * Per-class outcome check over rec rows (called at/after sinceMs when finite).
 *
 * GOOD row (T-12, docs/GAP_CHECK_2026-09-26.md): when `goodCallOutcomes` (score.js
 * scoreGoodCalls, the 1-minute alert log merged with captures) has any rows in the window,
 * the GOOD key's stats come from that merged set instead of the capture-only `rec` rows -
 * it counts every GOOD the engine emitted, not just the ones a 10-minute poll caught. Empty
 * `goodCallOutcomes` (older data, or the alert log missing) falls back to the capture-only
 * `rec` rows exactly as before. WATCH/BAD/DATA_UNAVAILABLE are always capture-only.
 * @param {Array<Object>} outcomes
 * @param {number|null} [sinceMs=null]
 * @param {Array<Object>} [goodCallOutcomes=[]] - score.js scoreGoodCalls rows
 */
export function classCheck(outcomes, sinceMs = null, goodCallOutcomes = []) {
  const since = isFiniteNumber(sinceMs);
  const recs = outcomes.filter((r) => isRec(r) && (!since || Date.parse(r.calledAt) >= sinceMs));
  const goodMerged = (goodCallOutcomes || []).filter((r) => r && r.calledAt && (!since || Date.parse(r.calledAt) >= sinceMs));
  const rows = [];
  for (const key of CLASS_CHECK_KEYS) {
    const g = key === 'GOOD' && goodMerged.length ? goodMerged : recs.filter((r) => r.class === key);
    if (key === 'DATA_UNAVAILABLE' && !g.length) continue;
    const s = statsFor(g);
    const decided = g.filter(isDecided);
    const row = {
      key,
      calls: s.calls,
      scored: s.wins + s.losses,
      wins: s.wins,
      losses: s.losses,
      open: s.open + s.pending,
      notFilled: s.notFilled + s.expired,
      noLevels: s.noLevels,
      winRate: s.winRate,
      expectancy: s.expectancy,
      fromPlan: decided.filter((r) => r.levelSource === 'plan').length,
      fromCandidate: decided.filter((r) => r.levelSource === 'candidate').length
    };
    if (key === 'GOOD') {
      row.oneMinLogCalls = g.filter((r) => Array.isArray(r.sources) && r.sources.includes('alert-1m')).length;
      row.capturedCalls = g.filter((r) => Array.isArray(r.sources) && r.sources.includes('capture')).length;
      row.medianGoodWindowMin = median(g.map((r) => r.goodWindowMin).filter(isFiniteNumber));
    }
    rows.push(row);
  }
  return { since: since ? new Date(sinceMs).toISOString() : null, rows };
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

/**
 * @param {Array<Object>} rows - outcomes.jsonl rows
 * @param {number} sinceMs
 * @param {Array<Object>} [goodCallOutcomes=[]] - T-12 merged GOOD calls; when non-empty,
 *   `tradable`/`bySymbol`/`byTimeframe` read from it instead of the capture-only ready-plan
 *   rows (same fallback rule as classCheck above). byClass/byReason/byPlanStatus stay
 *   capture-only - "everything else" (WATCH/BAD counterfactuals, rejected plans).
 */
function windowBlock(rows, sinceMs, goodCallOutcomes = []) {
  const inWin = rows.filter((r) => Date.parse(r.calledAt) >= sinceMs);
  const goodInWin = (goodCallOutcomes || []).filter((r) => r && Date.parse(r.calledAt) >= sinceMs);
  const tradable = goodInWin.length ? goodInWin : inWin.filter(isTradable);
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
 * Config-boundary marker (T6 completion plan C3): the most recent configVersion
 * change seen across tradable (ready-plan) outcome rows, chronologically, with gross +
 * net stats split before/after it. Every scored call already carries its own capture's
 * `configVersion` (score.js's `baseCall`). Null when every row shares one
 * configVersion (nothing shipped mid-window yet) or there are fewer than 2 rows.
 * @param {Array<Object>} outcomes
 * @returns {{at:string, fromVersion:string, toVersion:string, before:Object, after:Object}|null}
 */
export function configBoundary(outcomes) {
  const rows = (outcomes || [])
    .filter((r) => r && isTradable(r) && r.configVersion && r.calledAt)
    .sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt));
  if (rows.length < 2) return null;
  let boundaryIdx = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].configVersion !== rows[i - 1].configVersion) boundaryIdx = i;
  }
  if (boundaryIdx === -1) return null;
  return {
    at: rows[boundaryIdx].calledAt,
    fromVersion: rows[boundaryIdx - 1].configVersion,
    toVersion: rows[boundaryIdx].configVersion,
    before: statsFor(rows.slice(0, boundaryIdx)),
    after: statsFor(rows.slice(boundaryIdx))
  };
}

export const READY_WITHIN_MIN = 30;
export const ALERT_LOG_DAYS = 14;
const countBy = (rows, key) => rows.reduce((m, r) => { const k = r[key] ?? 'none'; m[k] = (m[k] || 0) + 1; return m; }, {});
const rate = (hits, n) => (n ? round(hits / n) : null);
/** An alert about a candidate before any GET IN NOW (not GOOD, not a TP1/stop/nudge/ended TRACK message). */
const isPreGood = (r) => Boolean(r.candidateId) && r.laterGood !== null && r.kind !== 'GOOD' && r.verdict !== 'GET IN NOW'
  && (!r.event || r.event === 'setup' || String(r.event).startsWith('state:'));

/**
 * Telegram alert numbers (see header). Renders from empty input.
 * @param {Array<Object>} alertOutcomes - score.js scoreAlerts rows
 * @param {Array<Object>} transitions - data/transitions lines
 * @param {number} [nowMs=Date.now()]
 */
export function computeAlertAggregates(alertOutcomes = [], transitions = [], nowMs = Date.now()) {
  const rows = (alertOutcomes || []).filter((r) => r && Number.isFinite(Date.parse(r.sentAt)));
  const trs = (transitions || []).filter((t) => t && Number.isFinite(Date.parse(t.at)));
  const since7d = nowMs - 7 * DAY;
  const r7 = rows.filter((r) => Date.parse(r.sentAt) >= since7d);
  const latencies = r7.map((r) => r.latencyMin).filter(isFiniteNumber).sort((a, b) => a - b);
  const before = r7.filter(isPreGood);
  const beReady = r7.filter((r) => r.verdict === 'BE READY' && r.candidateId && Date.parse(r.sentAt) <= nowMs - READY_WITHIN_MIN * 60_000);
  const readyFast = beReady.filter((r) => isFiniteNumber(r.readyAfterMin) && r.readyAfterMin <= READY_WITHIN_MIN);
  const since24h = nowMs - DAY;
  const t24 = trs.filter((t) => Date.parse(t.at) >= since24h);
  const firstMs = trs.reduce((m, t) => Math.min(m, Date.parse(t.at)), Infinity);
  const hours = Number.isFinite(firstMs) ? Math.max(1, Math.min(24, (nowMs - Math.max(firstMs, since24h)) / 3_600_000)) : null;
  const perTf = countBy(t24, 'timeframe');
  const transitionsPerHour = hours === null ? {} : Object.fromEntries(Object.entries(perTf).sort(([a], [b]) => a.localeCompare(b)).map(([tf, n]) => [tf, round(n / hours, 2)]));
  const days = [...new Set([...rows.map((r) => String(r.sentAt).slice(0, 10)), ...trs.map((t) => String(t.at).slice(0, 10))])].sort().reverse().slice(0, ALERT_LOG_DAYS);
  const byDay = days.map((day) => {
    const d = rows.filter((r) => String(r.sentAt).slice(0, 10) === day);
    const lat = d.map((r) => r.latencyMin).filter(isFiniteNumber).sort((a, b) => a - b);
    const dBefore = d.filter(isPreGood);
    return {
      day,
      alerts: d.length,
      byKind: countBy(d, 'kind'),
      byVerdict: countBy(d.filter((r) => r.verdict), 'verdict'),
      medianLatencyMin: median(lat),
      laterGood: dBefore.filter((r) => r.laterGood).length,
      laterGoodOf: dBefore.length,
      transitions: trs.filter((t) => String(t.at).slice(0, 10) === day).length
    };
  });
  return {
    label: 'provisional; not evidence of an edge',
    tiles: {
      alerts7d: r7.length,
      alertsToday: rows.filter((r) => String(r.sentAt).slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10)).length,
      medianLatencyMin: median(latencies),
      latencyN: latencies.length,
      laterGoodRate: rate(before.filter((r) => r.laterGood).length, before.length),
      laterGoodN: before.length,
      beReadyToGoRate: rate(readyFast.length, beReady.length),
      beReadyN: beReady.length,
      transitions24h: t24.length,
      transitionsPerHour
    },
    byKind7d: countBy(r7, 'kind'),
    byVerdict7d: countBy(r7.filter((r) => r.verdict), 'verdict'),
    byOutcome7d: countBy(r7.filter((r) => r.outcome), 'outcome'),
    byDay
  };
}

/**
 * Everything the page and report need.
 * @param {Array<Object>} outcomes
 * @param {Array<Object>} captureRows
 * @param {Object<string, Array<Object>>} candles1mBySymbol
 * @param {number} [nowMs=Date.now()]
 * @param {{phaseStartMs?: number, goodCallOutcomes?: Array<Object>}} [opts] phaseStartMs adds
 *   `phase` (ready-plan stats called since then); goodCallOutcomes (T-12, score.js
 *   scoreGoodCalls) feeds the 30-plan target, the headline 7d tiles and the class-check GOOD
 *   row from the 1-minute alert log merged with captures - empty/omitted falls back to the
 *   capture-only ready-plan rows exactly as before.
 */
export function computeAggregates(outcomes, captureRows, candles1mBySymbol = {}, nowMs = Date.now(), opts = {}) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const recs = outcomes.filter(isRec);
  const tradable = outcomes.filter(isTradable);
  const goodCallOutcomes = opts.goodCallOutcomes || [];
  const w7 = windowBlock(outcomes, nowMs - 7 * DAY, goodCallOutcomes);
  const w30 = windowBlock(outcomes, nowMs - 30 * DAY, goodCallOutcomes);
  const goodCallLogSince = (() => {
    const days = goodCallOutcomes
      .filter((r) => r && Array.isArray(r.sources) && r.sources.includes('alert-1m') && r.calledAt)
      .map((r) => String(r.calledAt).slice(0, 10));
    return days.length ? days.sort()[0] : null;
  })();
  const cronRows = captureRows.filter((r) => r.source !== 'served');
  const servedRows = captureRows.filter((r) => r.source === 'served');
  const lastCapture = cronRows.reduce((m, r) => (r.capturedAt && (!m || r.capturedAt > m) ? r.capturedAt : m), null);
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

  // Tracker runs = distinct capture minutes (one run writes one row per symbol).
  const runMinutes = [...new Set(cronRows.map((r) => (r.capturedAt ? r.capturedAt.slice(0, 16) : null)).filter(Boolean))].sort();
  const since24h = nowMs - DAY;
  const since48h = nowMs - 2 * DAY;
  const in24h = (r) => Date.parse(r.calledAt) >= since24h;
  const goods = recs.filter((r) => r.class === 'GOOD' && r.calledAt);
  const served24h = servedRows.filter((r) => Date.parse(r.servedAt || r.capturedAt) >= since24h);

  const t7 = w7.tradable;
  // T6 completion plan C3: GOOD/hour and SETUPs/day, both over the same 7-day window
  // t7 already uses. GOOD/hour counts distinct GOOD rec calls (same dedup extractCalls
  // already gives every call - one row per class change, not per capture); SETUPs/day
  // counts distinct 'setup'-kind calls (extractCalls dedupes those by their own
  // candidateId+entry+stop+tp1 signature, T6 completion plan C2).
  const HOURS_7D = 7 * 24;
  const good7dRows = recs.filter((r) => r.class === 'GOOD' && Date.parse(r.calledAt) >= nowMs - 7 * DAY);
  const setup7dRows = outcomes.filter((r) => r.kind === 'setup' && Date.parse(r.calledAt) >= nowMs - 7 * DAY);
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
      netExpectancy7d: t7.netExpectancy,
      losingStreak7d: t7.maxLosingStreak,
      goodPerHour7d: round(good7dRows.length / HOURS_7D, 4),
      setupsPerDay7d: round(setup7dRows.length / 7, 3)
    },
    totals: { outcomes: outcomes.length, recCalls: recs.length, tradable: statsFor(tradable) },
    windows: { '7d': w7, '30d': w30 },
    configBoundary: configBoundary(outcomes),
    byDay,
    openCalls,
    dailyLog,
    captures: captureStats(cronRows, candles1mBySymbol),
    activity: {
      firstRun: runMinutes.length ? `${runMinutes[0]}:00.000Z` : null,
      runs: runMinutes.length,
      runTimes48h: runMinutes.map((m) => `${m}:00.000Z`).filter((iso) => Date.parse(iso) >= since48h),
      recCalls24h: recs.filter(in24h).length,
      good24h: goods.filter(in24h).length,
      ready24h: tradable.filter(in24h).length,
      lastGoodAt: goods.reduce((m, r) => (!m || r.calledAt > m ? r.calledAt : m), null),
      served24h: served24h.length,
      servedGood24h: served24h.filter((r) => r.flagRecommendation && r.flagRecommendation.class === 'GOOD').length
    },
    classCheck: classCheck(outcomes, opts.phaseStartMs, goodCallOutcomes),
    alerts: computeAlertAggregates(opts.alertOutcomes || [], opts.transitions || [], nowMs),
    goodCallLogSince,
    phase: isFiniteNumber(opts.phaseStartMs)
      ? {
          startedAt: new Date(opts.phaseStartMs).toISOString(),
          tradable: statsFor((goodCallOutcomes.length ? goodCallOutcomes : tradable).filter((r) => Date.parse(r.calledAt) >= opts.phaseStartMs))
        }
      : null
  };
}

export function aggregateDataDir(dataDir, nowMs = Date.now(), opts = {}) {
  const agg = computeAggregates(readJsonl(outcomesFile(dataDir)), readAllCalls(dataDir), readCandles(dataDir, '1m'), nowMs,
    { alertOutcomes: readJsonl(alertOutcomesFile(dataDir)), transitions: readTransitions(dataDir), goodCallOutcomes: readJsonl(goodCallOutcomesFile(dataDir)), ...opts });
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
