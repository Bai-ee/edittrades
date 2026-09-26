#!/usr/bin/env node
/**
 * Net-floor shadow scoring (T-13, owner 2026-09-26): the first scored GOOD calls were
 * +0.47R gross but -2.37R net - BTC stops of 0.02-0.07 % sit inside Jupiter's round-trip
 * cost (0.34 % long / 0.14 % short), so even winners lose. `NF` widens the stop to
 * max(0.5 x ATR(15m), 3 x round-trip cost), keeps TP1, and calls the trade only when
 * gross >= 2.5 and net >= 1.0. SHADOW MODE until the rule freeze ends (2026-10-08): this
 * script only measures what NF would have done beside the live rule - never traded,
 * never feeds flagTradePlan, flagRecommendation, class logic, alerts or any gate.
 *
 * One row per candidateId the live rule called ready (first ready moment), from:
 *   - capture / served call rows with flagTradePlan.status 'ready' (the engine's own
 *     flagTradePlan.shadow.NF when the row carries it - served rows do, since the served
 *     recorder keeps the pre-filter payload - `nfSource: 'engine'`), and
 *   - the Telegram cron's per-minute GOOD alert log (data/telegram-alerts/), which catches
 *     GOOD windows the 10-minute capture misses (docs/GAP_CHECK_2026-09-26.md).
 * Rows without an engine NF are BACKFILLED here (`nfSource: 'backfill'`): same floor,
 * ATR(15m) = Wilder ATR(14) over the stored 15m candles closed by the ready moment
 * (`atrSource: 'none'` -> cost floor only when fewer than 15 exist), same gates, filled
 * at the live ready close. The engine's NF also re-checks the retest-hold against the
 * wider stop; the backfill cannot, so it is an approximation, labelled as such.
 *
 * Both legs are walked forward on 1m candles from the ready close (prefilled, 24 h
 * window, walkShadow): `live` with the plan's own stop, `nf` with the floored stop (only
 * when NF is ready). Net R per leg uses costs.js's direction cost (netR). Idempotent: a
 * row whose legs are both terminal is kept exactly as written.
 *
 * Usage: node nf-shadow.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJsonl, writeJson, readTelegramAlerts } from './store.js';
import { isFiniteNumber } from './walk-outcome.js';
import { walkShadow } from './breakout-entry.js';
import { netR as netRAt, COST_BPS_BY_DIRECTION } from './costs.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = DAY_MS;
const M15_MS = 15 * 60 * 1000;

/** Mirrors services/scalpContext.js FLAG_PLAN_SHADOW_VARIANTS `NF` (test-tracker.js asserts it). */
export const NF_RULE = Object.freeze({ minRR: 2.5, minNetRR: 1.0, atrMult: 0.5, costMult: 3, atrPeriod: 14, maxStopPct: 3 });

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function nfShadowOutcomesFile(dataDir) {
  return path.join(dataDir, 'nf-shadow-outcomes.jsonl');
}

export function nfShadowSummaryFile(dataDir) {
  return path.join(dataDir, 'nf-shadow.json');
}

/**
 * Wilder ATR(period) over the 15m candles that CLOSED at or before `atMs` (a candle
 * opening at t closes at t + 15m), same formula as lib/advancedIndicators.js calculateATR.
 * Null with fewer than period + 1 candles.
 */
export function atr15mAt(candles15m, atMs, period = NF_RULE.atrPeriod) {
  const closed = (Array.isArray(candles15m) ? candles15m : []).filter((c) => c && isFiniteNumber(c.timestamp) && c.timestamp + M15_MS <= atMs);
  if (closed.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closed.length; i++) {
    const c = closed[i];
    const p = closed[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = ((atr * (period - 1)) + trs[i]) / period;
  return atr;
}

/**
 * The NF plan for a live call: stop floored at max(atrMult x ATR(15m), costMult x
 * direction cost), TP1 unchanged, ready when gross >= minRR, net >= minNetRR and the
 * floored stop is within the 3 % cap. Vendored mirror of lib/flagTradePlan.js
 * netFloorStopDistance + netRiskReward (direction cost).
 * @returns {{ready:boolean, stop:number, grossRR:number, netRR:number|null, stopPct:number, floorPct:number}|null}
 */
export function backfillNetFloor({ direction, entry, stop, tp1, atr15m }) {
  if (![entry, stop, tp1].every(isFiniteNumber) || entry <= 0 || (direction !== 'long' && direction !== 'short')) return null;
  const sign = direction === 'short' ? -1 : 1;
  if (sign * (entry - stop) <= 0 || sign * (tp1 - entry) <= 0) return null;
  const costPct = COST_BPS_BY_DIRECTION[direction] / 10000;
  const floor = Math.max(isFiniteNumber(atr15m) && atr15m > 0 ? NF_RULE.atrMult * atr15m : 0, NF_RULE.costMult * costPct * entry);
  const dist = Math.max(Math.abs(entry - stop), floor);
  const reward = Math.abs(tp1 - entry);
  const cost = costPct * entry;
  const grossRR = reward / dist;
  const netRR = reward - cost > 0 ? (reward - cost) / (dist + cost) : null;
  const stopPct = (dist / entry) * 100;
  const ready = grossRR >= NF_RULE.minRR && netRR !== null && netRR >= NF_RULE.minNetRR && stopPct <= NF_RULE.maxStopPct;
  return { ready, stop: roundN(entry - sign * dist, 2), grossRR: roundN(grossRR, 3), netRR: roundN(netRR, 3), stopPct: roundN(stopPct, 3), floorPct: roundN((floor / entry) * 100, 3) };
}

/** The live calls to score: first ready moment per candidateId, from call rows and GOOD alerts. */
export function liveReadyCalls(callRows, alertRows) {
  const byId = new Map();
  const consider = (c) => {
    if (!c.candidateId || !isFiniteNumber(Date.parse(c.readyAt))) return;
    const prev = byId.get(c.candidateId);
    if (!prev) { byId.set(c.candidateId, c); return; }
    // Earliest ready moment wins; an engine NF on either row is kept.
    const earlier = Date.parse(c.readyAt) < Date.parse(prev.readyAt) ? c : prev;
    const other = earlier === c ? prev : c;
    byId.set(c.candidateId, { ...earlier, engineNF: earlier.engineNF || other.engineNF || null });
  };
  for (const r of Array.isArray(callRows) ? callRows : []) {
    const p = r && r.flagTradePlan;
    if (!p || p.status !== 'ready' || !r.closedThrough) continue;
    const nf = p.shadow && p.shadow.NF && p.shadow.NF.candidateId === p.candidateId ? p.shadow.NF : null;
    consider({ candidateId: p.candidateId, symbol: r.symbol, timeframe: p.timeframe ?? null, direction: p.direction, readyAt: r.closedThrough, entry: p.entry, stop: p.stop, tp1: p.tp1, source: r.source === 'served' ? 'served' : 'capture', engineNF: nf });
  }
  for (const a of Array.isArray(alertRows) ? alertRows : []) {
    if (!a || a.kind !== 'GOOD' || !a.closedThrough) continue;
    consider({ candidateId: a.candidateId, symbol: a.symbol, timeframe: a.timeframe ?? null, direction: a.direction, readyAt: a.closedThrough, entry: a.entry, stop: a.stop, tp1: a.tp1, source: 'telegram', engineNF: null });
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.readyAt) - Date.parse(b.readyAt) || a.candidateId.localeCompare(b.candidateId));
}

const isTerminal = (o) => o === 'tp1' || o === 'stop' || o === 'expired';

function leg(direction, entry, stop, tp1, candles1m, fromMs) {
  const walk = walkShadow({ dir: direction, entry, stop, tp1 }, candles1m, fromMs, WINDOW_MS);
  const grossR = walk.outcome === 'stop' ? -1 : walk.outcome === 'tp1' ? walk.r : null;
  const net = isFiniteNumber(grossR) ? netRAt(entry, stop, grossR, direction) : null;
  return {
    stop,
    outcome: walk.outcome,
    r: walk.r,
    netR: net === null ? null : roundN(net, 4),
    filled: (candles1m || []).some((c) => c.timestamp >= fromMs),
    resolvedAt: isFiniteNumber(walk.resolvedAt) ? new Date(walk.resolvedAt).toISOString() : null
  };
}

/**
 * One row per live ready call: the live leg and (when NF is ready) the NF leg.
 * @param {Array<Object>} callRows - readAllCalls output
 * @param {Array<Object>} alertRows - readTelegramAlerts output
 * @param {Object<string, Array<Object>>} candles1mBySymbol
 * @param {Object<string, Array<Object>>} candles15mBySymbol
 * @param {Array<Object>} [previous=[]]
 * @param {number} [nowMs=Date.now()]
 */
export function computeNfShadowRows(callRows, alertRows, candles1mBySymbol, candles15mBySymbol, previous = [], nowMs = Date.now()) {
  const prevById = new Map((previous || []).map((r) => [r.candidateId, r]));
  const nowIso = new Date(nowMs).toISOString();
  const out = [];
  for (const c of liveReadyCalls(callRows, alertRows)) {
    const prev = prevById.get(c.candidateId);
    if (prev && isTerminal(prev.live && prev.live.outcome) && (!prev.nf || !prev.nf.ready || isTerminal(prev.nf.outcome))) { out.push(prev); continue; }
    if (![c.entry, c.stop, c.tp1].every(isFiniteNumber)) continue;
    const fromMs = Date.parse(c.readyAt);
    const candles1m = (candles1mBySymbol && candles1mBySymbol[c.symbol]) || [];
    let nf;
    let nfSource;
    let atrSource = null;
    if (c.engineNF && typeof c.engineNF.ready === 'boolean') {
      nf = { ready: c.engineNF.ready && c.engineNF.status === 'ready', stop: c.engineNF.stop, grossRR: c.engineNF.grossRR, netRR: c.engineNF.netRR, stopPct: c.engineNF.stopPct, floorPct: c.engineNF.floorPct };
      nfSource = 'engine';
    } else {
      const atr = atr15mAt(candles15mBySymbol && candles15mBySymbol[c.symbol], fromMs);
      atrSource = isFiniteNumber(atr) ? '15m' : 'none';
      nf = backfillNetFloor({ direction: c.direction, entry: c.entry, stop: c.stop, tp1: c.tp1, atr15m: atr });
      nfSource = 'backfill';
    }
    const liveLeg = leg(c.direction, c.entry, c.stop, c.tp1, candles1m, fromMs);
    const nfLeg = nf && nf.ready && isFiniteNumber(nf.stop) ? leg(c.direction, c.entry, nf.stop, c.tp1, candles1m, fromMs) : null;
    const livePct = (Math.abs(c.entry - c.stop) / c.entry) * 100;
    out.push({
      candidateId: c.candidateId, symbol: c.symbol, timeframe: c.timeframe, direction: c.direction, readyAt: c.readyAt, source: c.source,
      entry: c.entry, tp1: c.tp1,
      live: { ...liveLeg, stopPct: roundN(livePct, 3) },
      nf: nf ? { ready: nf.ready, grossRR: nf.grossRR, netRR: nf.netRR, stopPct: nf.stopPct, floorPct: nf.floorPct, ...(nfLeg || { stop: nf.stop, outcome: null, r: null, netR: null, filled: false, resolvedAt: null }) } : null,
      nfSource, atrSource,
      computedAt: isTerminal(liveLeg.outcome) && (!nfLeg || isTerminal(nfLeg.outcome)) ? nowIso : null
    });
  }
  return out;
}

function legStats(legs, spanDays) {
  const decided = legs.filter((l) => l.outcome === 'tp1' || l.outcome === 'stop');
  const avg = (arr) => (arr.length ? roundN(arr.reduce((a, b) => a + b, 0) / arr.length, 4) : null);
  return {
    calls: legs.length,
    callsPerDay: spanDays > 0 ? roundN(legs.length / spanDays, 2) : null,
    fills: legs.filter((l) => l.filled).length,
    resolvedN: decided.length,
    winRate: decided.length ? roundN(decided.filter((l) => l.outcome === 'tp1').length / decided.length, 4) : null,
    grossExpectancyR: avg(decided.map((l) => l.r).filter(isFiniteNumber)),
    netExpectancyR: avg(decided.map((l) => l.netR).filter(isFiniteNumber))
  };
}

/**
 * Side by side, over the same live ready calls: `live` (every call, its own stop) and
 * `nf` (the calls NF would have taken, floored stop). calls/day over the span from the
 * first ready call to now.
 */
export function nfShadowSummary(rows, nowMs = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  const first = list.reduce((m, r) => Math.min(m, Date.parse(r.readyAt)), Infinity);
  const spanDays = Number.isFinite(first) ? Math.max((nowMs - first) / DAY_MS, 1 / 24) : 0;
  return {
    n: list.length,
    spanDays: roundN(spanDays, 2),
    engineRows: list.filter((r) => r.nfSource === 'engine').length,
    backfillRows: list.filter((r) => r.nfSource === 'backfill').length,
    live: legStats(list.map((r) => r.live).filter(Boolean), spanDays),
    nf: legStats(list.map((r) => r.nf).filter((l) => l && l.ready), spanDays)
  };
}

/** Read calls + GOOD alerts + candles + previous rows from `dataDir`, write both files. */
export function nfShadowDataDir(dataDir, nowMs = Date.now()) {
  const rows = computeNfShadowRows(readAllCalls(dataDir), readTelegramAlerts(dataDir), readCandles(dataDir, '1m'), readCandles(dataDir, '15m'), readJsonl(nfShadowOutcomesFile(dataDir)), nowMs);
  writeJsonl(nfShadowOutcomesFile(dataDir), rows);
  const summary = { generatedAt: new Date(nowMs).toISOString(), ...nfShadowSummary(rows, nowMs) };
  writeJson(nfShadowSummaryFile(dataDir), summary);
  return { rows, summary };
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const { summary: s } = nfShadowDataDir(opts.data, nowMs);
  const fmt = (l) => `calls=${l.calls} (${l.callsPerDay ?? '-'}/day) fills=${l.fills} resolved=${l.resolvedN} win=${l.winRate ?? '-'} gross=${l.grossExpectancyR ?? '-'}R net=${l.netExpectancyR ?? '-'}R`;
  console.log(`[tracker:nf-shadow] n=${s.n} (engine ${s.engineRows}, backfill ${s.backfillRows}) span=${s.spanDays}d`);
  console.log(`[tracker:nf-shadow] live ${fmt(s.live)}`);
  console.log(`[tracker:nf-shadow] NF   ${fmt(s.nf)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:nf-shadow] ${err.message}`);
    process.exit(1);
  }
}

export default { NF_RULE, nfShadowOutcomesFile, nfShadowSummaryFile, atr15mAt, backfillNetFloor, liveReadyCalls, computeNfShadowRows, nfShadowSummary, nfShadowDataDir };
