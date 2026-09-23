#!/usr/bin/env node
/**
 * EditTrades call tracker - scorer (T1, docs/PLAN_CALL_TRACKER.md item 3).
 *
 * Turns stored capture rows into calls, then walks each call against stored closed 1m
 * candles with the vendored engine walkOutcome (./walk-outcome.js). No network.
 *
 * Calls (a new call each time the signature changes from the symbol's previous capture):
 *   plan/ready        flagTradePlan ready; filled at the ready close at its entry level
 *                     (prefilled), then walked for stop vs TP1. R is gross; the plan's
 *                     own netRR is carried alongside, never recomputed.
 *   plan/conditional  scored only through the ready plan it later became (same
 *                     candidateId, within 24 h): outcome copied from that ready call;
 *                     never ready within 24 h -> not_filled; before that -> pending.
 *   plan/rejected     recorded for reason-code counts; outcome `rejected`, not walked.
 *   rec/<class>       each flagRecommendation class change (GOOD/WATCH/BAD/DATA_UNAVAILABLE).
 *                     GOOD on a ready plan: same prefilled walk. Any other class whose
 *                     same-capture plan carries levels: a counterfactual level-touch walk
 *                     (entry touched within 15 1m candles). No levels: `no_levels`.
 *
 * Outcomes: pending | not_filled | open | tp1 | stop | expired | rejected | no_levels.
 * Window: 24 h from the call close, then `expired`. Idempotent: final outcomes are kept
 * as written; only pending/open calls are re-scored, and a row's scoredAt changes only
 * when its content does.
 *
 * Usage: node score.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJsonl, outcomesFile } from './store.js';
import { walkOutcome, isFiniteNumber, FILL_WINDOW_CANDLES } from './walk-outcome.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
export const FINAL_OUTCOMES = new Set(['tp1', 'stop', 'not_filled', 'expired', 'rejected', 'no_levels']);

function levelsOf(plan) {
  if (!plan || !isFiniteNumber(plan.entry) || !isFiniteNumber(plan.stop) || !isFiniteNumber(plan.tp1)) return null;
  return { entry: plan.entry, stop: plan.stop, tp1: plan.tp1 };
}

function baseCall(row, kind, sig) {
  return {
    callId: `${kind}|${row.symbol}|${sig}|${row.closedThrough}`,
    kind,
    symbol: row.symbol,
    calledAt: row.closedThrough,
    capturedAt: row.capturedAt ?? null,
    configVersion: row.configVersion ?? null,
    schemaVersion: row.schemaVersion ?? null,
    price: row.price ?? null,
    markDriftBps: row.mark && isFiniteNumber(row.mark.driftBps) ? row.mark.driftBps : null
  };
}

function planFields(plan) {
  const lv = levelsOf(plan);
  return {
    timeframe: plan ? plan.timeframe ?? null : null,
    direction: plan ? plan.direction ?? null : null,
    candidateId: plan ? plan.candidateId ?? null : null,
    planStatus: plan ? plan.status ?? null : null,
    planReasonCode: plan ? plan.reasonCode ?? null : null,
    entry: lv ? lv.entry : null,
    stop: lv ? lv.stop : null,
    tp1: lv ? lv.tp1 : null,
    grossRR: plan && isFiniteNumber(plan.grossRR) ? plan.grossRR : null,
    netRR: plan && isFiniteNumber(plan.netRR) ? plan.netRR : null,
    entryCondition: plan ? plan.entryCondition ?? null : null
  };
}

/**
 * Calls from stored capture rows (any order in; chronological per symbol out).
 * @param {Array<Object>} rows - data/calls rows
 * @returns {Array<Object>}
 */
export function extractCalls(rows) {
  const sorted = [...rows].sort((a, b) => Date.parse(a.closedThrough) - Date.parse(b.closedThrough));
  const last = new Map(); // symbol -> {plan, rec}
  const calls = [];
  for (const row of sorted) {
    if (!row || !row.symbol || !row.closedThrough) continue;
    const prev = last.get(row.symbol) || { plan: null, rec: null };
    const plan = row.flagTradePlan || null;

    let planSig = null;
    if (plan && plan.status === 'ready' && levelsOf(plan)) planSig = `ready|${plan.candidateId}|${plan.entry}|${plan.stop}|${plan.tp1}`;
    else if (plan && plan.status === 'conditional') planSig = `conditional|${plan.candidateId}`;
    else if (plan && plan.status === 'rejected') planSig = `rejected|${plan.candidateId}|${plan.reasonCode}`;
    if (planSig && planSig !== prev.plan) {
      calls.push({ ...baseCall(row, 'plan', planSig), class: null, reasonCode: plan.reasonCode ?? null, ...planFields(plan) });
    }

    const rec = row.flagRecommendation || null;
    let recSig = null;
    if (rec && rec.class) {
      const code = rec.primaryReason && rec.primaryReason.code ? rec.primaryReason.code : null;
      recSig = `${rec.class}|${rec.candidateId || '-'}|${code || '-'}`;
      if (recSig !== prev.rec) {
        const linked = plan && rec.candidateId && plan.candidateId === rec.candidateId ? plan : null;
        calls.push({
          ...baseCall(row, 'rec', recSig),
          class: rec.class,
          reasonCode: code,
          ...planFields(linked),
          candidateId: rec.candidateId ?? null,
          readiness: rec.readiness ?? null
        });
      }
    }
    last.set(row.symbol, { plan: planSig, rec: recSig });
  }
  return calls;
}

/** Index of the fill candle in `candles` for a touch fill (same rule as walkOutcome). */
function touchFillIndex(candles, fromMs, entry) {
  let start = 0;
  while (start < candles.length && candles[start].timestamp < fromMs) start++;
  const end = Math.min(candles.length, start + FILL_WINDOW_CANDLES);
  for (let i = start; i < end; i++) if (candles[i].low <= entry && candles[i].high >= entry) return i;
  return -1;
}

/**
 * Walk one call's levels over the 24 h window after its close.
 * @returns {{outcome:string, r:number|null, filledAt:string|null, resolvedAt:string|null, minutesToResolution:number|null}}
 */
export function walkCall(call, candles1m, nowMs, prefilled) {
  const fromMs = Date.parse(call.calledAt);
  const windowEnd = fromMs + WINDOW_MS;
  const slice = (candles1m || []).filter((c) => c.timestamp >= fromMs && c.timestamp < windowEnd);
  const coverageEnd = slice.length ? slice[slice.length - 1].timestamp + MINUTE : fromMs;
  const windowClosed = Math.max(nowMs, coverageEnd) >= windowEnd;
  const empty = { r: null, filledAt: null, resolvedAt: null, minutesToResolution: null };

  const res = walkOutcome({
    candles1m: slice,
    fromMs,
    direction: call.direction,
    entryMin: call.entry,
    entryMax: call.entry,
    stop: call.stop,
    target: call.tp1,
    fillWindowCandles: FILL_WINDOW_CANDLES,
    maxHoldCandles: slice.length + 1,
    prefilled
  });

  if (res.status === 'invalid_levels') return { outcome: 'no_levels', ...empty };
  if (res.status === 'not_filled') {
    if (prefilled) return { outcome: windowClosed ? 'expired' : 'open', ...empty, filledAt: call.calledAt };
    const final = slice.length >= FILL_WINDOW_CANDLES || windowClosed;
    return { outcome: final ? 'not_filled' : 'pending', ...empty };
  }

  const fillIdx = prefilled ? 0 : touchFillIndex(slice, fromMs, call.entry);
  const filledAtMs = prefilled ? fromMs : slice[fillIdx].timestamp;
  const filledAt = new Date(filledAtMs).toISOString();
  if (res.status === 'win' || res.status === 'loss') {
    const exitCandle = slice[fillIdx + res.holdCandles - 1];
    const resolvedMs = exitCandle ? exitCandle.timestamp + MINUTE : null;
    return {
      outcome: res.status === 'win' ? 'tp1' : 'stop',
      r: res.r,
      filledAt,
      resolvedAt: resolvedMs ? new Date(resolvedMs).toISOString() : null,
      minutesToResolution: resolvedMs ? Math.round((resolvedMs - filledAtMs) / MINUTE) : null
    };
  }
  return { outcome: windowClosed ? 'expired' : 'open', ...empty, filledAt };
}

function stableJson(row) {
  const { scoredAt, ...rest } = row;
  return JSON.stringify(rest);
}

/**
 * Score every call. `previous` rows with a final outcome are returned unchanged.
 * @param {Array<Object>} calls - extractCalls output
 * @param {Object<string, Array<Object>>} candlesBySymbol - 1m candles, ascending
 * @param {Array<Object>} [previous=[]] - existing outcomes.jsonl rows
 * @param {number} [nowMs=Date.now()]
 * @returns {Array<Object>}
 */
export function scoreCalls(calls, candlesBySymbol, previous = [], nowMs = Date.now()) {
  const prevById = new Map(previous.map((r) => [r.callId, r]));
  const nowIso = new Date(nowMs).toISOString();
  const rows = new Map();

  const finish = (call, result, extra) => {
    const row = {
      ...call,
      ...result,
      mode: extra.mode,
      rUnits: 'gross_R_before_fees_slippage',
      becameReady: extra.becameReady ?? null,
      readyCallId: extra.readyCallId ?? null
    };
    const prev = prevById.get(call.callId);
    row.scoredAt = prev && stableJson(prev) === stableJson(row) ? prev.scoredAt : nowIso;
    rows.set(call.callId, row);
    return row;
  };

  // Pass 1: everything except conditional plans (they link to pass-1 ready calls).
  for (const call of calls) {
    const prev = prevById.get(call.callId);
    if (prev && FINAL_OUTCOMES.has(prev.outcome)) { rows.set(call.callId, prev); continue; }
    if (call.kind === 'plan' && call.planStatus === 'conditional') continue;
    const candles = candlesBySymbol[call.symbol] || [];

    if (call.kind === 'plan' && call.planStatus === 'rejected') {
      finish(call, { outcome: 'rejected', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null }, { mode: 'not_walked' });
    } else if (call.kind === 'plan') {
      finish(call, walkCall(call, candles, nowMs, true), { mode: 'ready_prefilled' });
    } else if (call.entry === null) {
      finish(call, { outcome: 'no_levels', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null }, { mode: 'not_walked' });
    } else if (call.class === 'GOOD' && call.planStatus === 'ready') {
      finish(call, walkCall(call, candles, nowMs, true), { mode: 'ready_prefilled' });
    } else {
      finish(call, walkCall(call, candles, nowMs, false), { mode: 'counterfactual_level_touch' });
    }
  }

  // Pass 2: conditional plans, scored only through the ready plan they became.
  const readyCalls = calls.filter((c) => c.kind === 'plan' && c.planStatus === 'ready');
  for (const call of calls) {
    if (!(call.kind === 'plan' && call.planStatus === 'conditional')) continue;
    if (rows.has(call.callId)) continue; // final already
    const fromMs = Date.parse(call.calledAt);
    const ready = readyCalls.find((r) => r.symbol === call.symbol && r.candidateId === call.candidateId
      && Date.parse(r.calledAt) >= fromMs && Date.parse(r.calledAt) < fromMs + WINDOW_MS);
    if (ready) {
      const scored = rows.get(ready.callId);
      finish(call, {
        outcome: scored.outcome, r: scored.r, filledAt: scored.filledAt,
        resolvedAt: scored.resolvedAt, minutesToResolution: scored.minutesToResolution
      }, { mode: 'ready_prefilled', becameReady: true, readyCallId: ready.callId });
    } else {
      const closed = nowMs >= fromMs + WINDOW_MS;
      finish(call, { outcome: closed ? 'not_filled' : 'pending', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null },
        { mode: 'awaiting_ready', becameReady: false });
    }
  }

  return calls.map((c) => rows.get(c.callId)).filter(Boolean);
}

/** Read calls + candles + previous outcomes from `dataDir`, write outcomes.jsonl. */
export function scoreDataDir(dataDir, nowMs = Date.now()) {
  const calls = extractCalls(readAllCalls(dataDir));
  const candles = readCandles(dataDir, '1m');
  const previous = readJsonl(outcomesFile(dataDir));
  const rows = scoreCalls(calls, candles, previous, nowMs);
  writeJsonl(outcomesFile(dataDir), rows);
  return rows;
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const rows = scoreDataDir(opts.data, nowMs);
  const counts = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
  console.log(`[tracker:score] ${rows.length} call(s) -> ${outcomesFile(opts.data)} ${JSON.stringify(counts)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:score] ${err.message}`);
    process.exit(1);
  }
}
