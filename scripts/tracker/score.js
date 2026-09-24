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
 *                     (entry touched within 15 1m candles), mode counterfactual_level_touch.
 *                     No plan levels but a flag candidate (candidateLevels): entry =
 *                     breakout, stop = invalidation, tp1 = measuredTarget, else entry +/-
 *                     measuredRR x risk; same touch walk, mode counterfactual_candidate.
 *                     Neither: `no_levels`. Candidate-level rows stay kind 'rec', so they
 *                     never reach the tradable (ready plan) stats.
 *
 * `levelSource` on every engine row: 'plan' (plan rows, and rec rows on same-capture plan
 * levels), 'candidate' (rec rows on candidate levels), null (no levels).
 *
 * Every call carries `dims` (callDims): filter dimensions copied from its capture row,
 * including `source` ('cron', or 'served' for a call the GPT was served, T3). A served
 * row is scored exactly like a cron row; it only adds a capture point.
 *
 * Outcomes: pending | not_filled | open | tp1 | stop | expired | rejected | no_levels.
 * Window: 24 h from the call close, then `expired`. Idempotent: final outcomes are kept
 * as written; only pending/open calls are re-scored, and a row's scoredAt changes only
 * when its content does. One exception: a written `no_levels` rec row whose call now has
 * candidate levels is re-scored once (rows from before candidate scoring existed).
 *
 * Journal (T2): each journal `open` record with entry/stop/tp1 and a direction is scored
 * like a ready plan (filled at entry at its time, walked for stop vs TP1 over 24 h). A
 * later `close` record for the same symbol (the first one not already used by an earlier
 * open) overrides the walk: its reported `resultR`, else R from its `exitPrice`, outcome
 * `closed`. `dims` are copied from the engine call named by engineRef.candidateId when it
 * is in the outcomes store; else a minimal set from engineRef. Written to
 * data/journal-outcomes.jsonl, fully recomputed each run (scoredAt kept when unchanged).
 *
 * Usage: node score.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJsonl, outcomesFile, readJournal, journalOutcomesFile } from './store.js';
import { walkOutcome, isFiniteNumber, FILL_WINDOW_CANDLES } from './walk-outcome.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
export const FINAL_OUTCOMES = new Set(['tp1', 'stop', 'not_filled', 'expired', 'rejected', 'no_levels']);

function levelsOf(plan) {
  if (!plan || !isFiniteNumber(plan.entry) || !isFiniteNumber(plan.stop) || !isFiniteNumber(plan.tp1)) return null;
  return { entry: plan.entry, stop: plan.stop, tp1: plan.tp1 };
}

/**
 * Counterfactual levels from a recommendation's flag candidate, or null. tp1 is the
 * candidate's measuredTarget when present, else entry + sign x measuredRR x |entry - stop|.
 * Geometry must be stop < entry < tp1 (long) or tp1 < entry < stop (short).
 * @param {Object} rec - flagRecommendation
 * @returns {{direction:string, entry:number, stop:number, tp1:number}|null}
 */
export function candidateLevels(rec) {
  const c = rec && rec.candidate && typeof rec.candidate === 'object' ? rec.candidate : null;
  if (!c || (c.direction !== 'long' && c.direction !== 'short')) return null;
  const entry = c.breakout;
  const stop = c.invalidation;
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop)) return null;
  const sign = c.direction === 'long' ? 1 : -1;
  let tp1 = null;
  if (isFiniteNumber(c.measuredTarget)) tp1 = c.measuredTarget;
  else if (isFiniteNumber(c.measuredRR) && c.measuredRR > 0) tp1 = entry + sign * c.measuredRR * Math.abs(entry - stop);
  if (tp1 === null) return null;
  const ok = sign === 1 ? stop < entry && entry < tp1 : tp1 < entry && entry < stop;
  return ok ? { direction: c.direction, entry, stop, tp1 } : null;
}

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * Filter dimensions copied from the capture row at call time (the page's equity-curve
 * filters read these): the recommendation's class/reason and supports/opposes/unknowns
 * codes, the plan status at the capture, candidate fields, and the derived top-down
 * (`td:*`), EMA200 side and divergence state. Mark drift is `markDriftBps` on the call.
 * @param {Object} row - capture row
 * @returns {Object}
 */
export function callDims(row) {
  const rec = row.flagRecommendation && typeof row.flagRecommendation === 'object' ? row.flagRecommendation : null;
  const plan = row.flagTradePlan && typeof row.flagTradePlan === 'object' ? row.flagTradePlan : null;
  const cand = rec && rec.candidate && typeof rec.candidate === 'object' ? rec.candidate : null;
  const lists = { supports: strList(rec && rec.supports), opposes: strList(rec && rec.opposes), unknowns: strList(rec && rec.unknowns) };
  const find = (pred) => {
    for (const side of ['supports', 'opposes', 'unknowns']) {
      const token = lists[side].find(pred);
      if (token) return { side, token };
    }
    return null;
  };
  const timeframe = (plan && plan.timeframe) || (cand && cand.timeframe) || null;
  const td = find((t) => t.startsWith('td:'));
  const ema = (timeframe && find((t) => t.startsWith(`ema200:${timeframe}:`))) || find((t) => t.startsWith('ema200:') && !t.endsWith(':missing'));
  const all = [...lists.supports, ...lists.opposes, ...lists.unknowns];
  const agrees = all.includes('divergence_agrees');
  const conflicts = all.includes('divergence_conflicts');
  return {
    closedThrough: row.closedThrough ?? null,
    recClass: rec ? rec.class ?? null : null,
    recReason: rec && rec.primaryReason ? rec.primaryReason.code ?? null : null,
    planStatusAtCall: plan ? plan.status ?? null : null,
    candidateTimeframe: cand ? cand.timeframe ?? null : null,
    candidateDirection: cand ? cand.direction ?? null : null,
    candidateState: cand ? cand.state ?? null : null,
    topDown: td ? td.side : null,
    topDownToken: td ? td.token : null,
    ema200Side: ema ? ema.token.split(':')[2] ?? null : null,
    ema200Token: ema ? ema.token : null,
    divergence: agrees && conflicts ? 'mixed' : agrees ? 'agrees' : conflicts ? 'conflicts' : 'none',
    source: row.source === 'served' ? 'served' : 'cron',
    ...lists
  };
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
    markDriftBps: row.mark && isFiniteNumber(row.mark.driftBps) ? row.mark.driftBps : null,
    dims: callDims(row)
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
      calls.push({ ...baseCall(row, 'plan', planSig), class: null, reasonCode: plan.reasonCode ?? null, ...planFields(plan), levelSource: 'plan' });
    }

    const rec = row.flagRecommendation || null;
    let recSig = null;
    if (rec && rec.class) {
      const code = rec.primaryReason && rec.primaryReason.code ? rec.primaryReason.code : null;
      recSig = `${rec.class}|${rec.candidateId || '-'}|${code || '-'}`;
      if (recSig !== prev.rec) {
        const linked = plan && rec.candidateId && plan.candidateId === rec.candidateId ? plan : null;
        const fields = planFields(linked);
        let levelSource = fields.entry !== null ? 'plan' : null;
        const cand = levelSource ? null : candidateLevels(rec);
        if (cand) {
          Object.assign(fields, cand);
          if (fields.timeframe === null) fields.timeframe = rec.candidate.timeframe ?? null;
          levelSource = 'candidate';
        }
        calls.push({
          ...baseCall(row, 'rec', recSig),
          class: rec.class,
          reasonCode: code,
          ...fields,
          candidateId: rec.candidateId ?? null,
          readiness: rec.readiness ?? null,
          levelSource
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
    // Final rows are kept as written; rows scored before `dims`/`levelSource` existed get
    // them once. A `no_levels` rec row that now has candidate levels is re-scored.
    const rescore = prev && prev.outcome === 'no_levels' && call.levelSource === 'candidate';
    if (prev && FINAL_OUTCOMES.has(prev.outcome) && !rescore) {
      const kept = prev.dims ? prev : { ...prev, dims: call.dims };
      rows.set(call.callId, 'levelSource' in kept ? kept : { ...kept, levelSource: call.levelSource });
      continue;
    }
    if (call.kind === 'plan' && call.planStatus === 'conditional') continue;
    const candles = candlesBySymbol[call.symbol] || [];

    if (call.kind === 'plan' && call.planStatus === 'rejected') {
      finish(call, { outcome: 'rejected', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null }, { mode: 'not_walked' });
    } else if (call.kind === 'plan') {
      finish(call, walkCall(call, candles, nowMs, true), { mode: 'ready_prefilled' });
    } else if (call.entry === null) {
      finish(call, { outcome: 'no_levels', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null }, { mode: 'not_walked' });
    } else if (call.class === 'GOOD' && call.planStatus === 'ready' && call.levelSource === 'plan') {
      finish(call, walkCall(call, candles, nowMs, true), { mode: 'ready_prefilled' });
    } else if (call.levelSource === 'candidate') {
      finish(call, walkCall(call, candles, nowMs, false), { mode: 'counterfactual_candidate' });
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

// ---------------------------------------------------------------- journal (T2)

const tradeTime = (r) => r.saidAt || r.receivedAt;

/** Signed R of an exit against entry/stop, or null. */
export function rFromExit(direction, entry, stop, exit) {
  if (![entry, stop, exit].every(isFiniteNumber) || entry === stop) return null;
  const risk = Math.abs(entry - stop);
  const move = direction === 'short' ? entry - exit : exit - entry;
  return Math.round((move / risk) * 10000) / 10000;
}

/** dims for a journal trade: the linked engine call's, else a minimal set from engineRef. */
function journalDims(record, outcomes) {
  const ref = record.engineRef && typeof record.engineRef === 'object' ? record.engineRef : null;
  const id = ref && ref.candidateId;
  if (id) {
    const tMs = Date.parse(tradeTime(record));
    const linked = outcomes
      .filter((o) => o && o.candidateId === id && o.dims)
      .sort((a, b) => Math.abs(Date.parse(a.calledAt) - tMs) - Math.abs(Date.parse(b.calledAt) - tMs))[0];
    if (linked) return { dims: linked.dims, linkedCallId: linked.callId };
  }
  return {
    dims: {
      recClass: ref ? ref.recClass ?? null : null,
      recReason: ref ? ref.reasonCode ?? null : null,
      planStatusAtCall: null, candidateTimeframe: null, candidateDirection: record.direction ?? null, candidateState: null,
      topDown: null, topDownToken: null, ema200Side: null, ema200Token: null, divergence: 'none', supports: [], opposes: [], unknowns: []
    },
    linkedCallId: null
  };
}

/**
 * Score journal `open` records.
 * @param {Array<Object>} records - journal records (any order)
 * @param {Object<string, Array<Object>>} candlesBySymbol - 1m candles, ascending
 * @param {Array<Object>} [outcomes=[]] - engine outcomes (for dims via engineRef.candidateId)
 * @param {Array<Object>} [previous=[]] - existing journal-outcomes rows (scoredAt kept when unchanged)
 * @param {number} [nowMs=Date.now()]
 * @returns {Array<Object>}
 */
export function scoreJournal(records, candlesBySymbol, outcomes = [], previous = [], nowMs = Date.now()) {
  const sorted = [...(records || [])].filter((r) => r && r.id && Number.isFinite(Date.parse(tradeTime(r))))
    .sort((a, b) => Date.parse(tradeTime(a)) - Date.parse(tradeTime(b)));
  const usedCloses = new Set();
  const prevById = new Map(previous.map((r) => [r.callId, r]));
  const nowIso = new Date(nowMs).toISOString();
  const rows = [];
  for (const rec of sorted) {
    if (rec.kind !== 'open') continue;
    const openMs = Date.parse(tradeTime(rec));
    const close = sorted.find((c) => c.kind === 'close' && !usedCloses.has(c.id) && c.symbol && c.symbol === rec.symbol
      && Date.parse(tradeTime(c)) > openMs);
    if (close) usedCloses.add(close.id);
    const call = {
      callId: `journal|${rec.id}`,
      kind: 'journal',
      journalId: rec.id,
      symbol: rec.symbol ?? null,
      calledAt: new Date(openMs).toISOString(),
      direction: rec.direction ?? null,
      entry: isFiniteNumber(rec.entry) ? rec.entry : null,
      stop: isFiniteNumber(rec.stop) ? rec.stop : null,
      tp1: isFiniteNumber(rec.tp1) ? rec.tp1 : null,
      sizeUsd: isFiniteNumber(rec.sizeUsd) ? rec.sizeUsd : null,
      recClass: rec.engineRef && rec.engineRef.recClass ? rec.engineRef.recClass : null,
      candidateId: rec.engineRef && rec.engineRef.candidateId ? rec.engineRef.candidateId : null,
      closeId: close ? close.id : null,
      ...journalDims(rec, outcomes)
    };
    let result;
    let mode;
    const reported = close ? (isFiniteNumber(close.resultR) ? close.resultR : rFromExit(call.direction, call.entry, call.stop, close.exitPrice)) : null;
    if (close && reported !== null) {
      const closeMs = Date.parse(tradeTime(close));
      result = { outcome: 'closed', r: reported, filledAt: call.calledAt, resolvedAt: new Date(closeMs).toISOString(), minutesToResolution: Math.round((closeMs - openMs) / MINUTE) };
      mode = isFiniteNumber(close.resultR) ? 'reported_result_r' : 'reported_exit_price';
    } else if (call.entry !== null && call.stop !== null && call.tp1 !== null && (call.direction === 'long' || call.direction === 'short')) {
      result = walkCall(call, candlesBySymbol[call.symbol] || [], nowMs, true);
      mode = 'ready_prefilled';
    } else {
      result = { outcome: 'no_levels', r: null, filledAt: null, resolvedAt: null, minutesToResolution: null };
      mode = 'not_walked';
    }
    const row = { ...call, ...result, mode, rUnits: 'gross_R_before_fees_slippage' };
    const prev = prevById.get(row.callId);
    row.scoredAt = prev && stableJson(prev) === stableJson(row) ? prev.scoredAt : nowIso;
    rows.push(row);
  }
  return rows;
}

/** Score the journal in `dataDir` against its 1m candles and engine outcomes; write journal-outcomes.jsonl. */
export function scoreJournalDataDir(dataDir, nowMs = Date.now()) {
  const rows = scoreJournal(readJournal(dataDir), readCandles(dataDir, '1m'), readJsonl(outcomesFile(dataDir)),
    readJsonl(journalOutcomesFile(dataDir)), nowMs);
  writeJsonl(journalOutcomesFile(dataDir), rows);
  return rows;
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
  const journal = scoreJournalDataDir(opts.data, nowMs);
  console.log(`[tracker:score] ${journal.length} journal trade(s) -> ${journalOutcomesFile(opts.data)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:score] ${err.message}`);
    process.exit(1);
  }
}
