#!/usr/bin/env node
/**
 * EditTrades call tracker - called-flag scorer (public homepage "called flags").
 *
 * A called flag = every Telegram alert of kind LOCK_OPPORTUNITY in the pulled alert log
 * (one per symbol+candidateId). Owner's success rule (fixed):
 *   RIGHT = price moves 1x ATR(14) of the flag's own timeframe in the called direction BEFORE
 *           it moves 1x ATR against, within 12 candles of that timeframe, measured from the
 *           entry level at the alert time.
 *   WRONG = -1 ATR first (a single 1m candle touching both bands counts WRONG).
 *   FLAT  = neither within 12 candles (shown, excluded from the rate).
 *   OPEN  = window not finished yet.   no_data = window ended with no candles / no ATR.
 * ATR(14) is simple mean of the last 14 true ranges of that timeframe's candles,
 * built by bucketing stored 1m candles (epoch-aligned) that CLOSED at or before the alert
 * time (no lookahead). Nothing is invented: missing data -> open / no_data.
 *
 * Writes data/called-flag-outcomes.jsonl (per call) and data/called-flags.json (summary).
 * No imports from lib/.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readCandles, readJsonl, writeJsonl, writeJson, readTelegramAlerts } from './store.js';
import { isFiniteNumber, round } from './walk-outcome.js';

export const CALLED_FLAG_KIND = 'LOCK_OPPORTUNITY';
export const ATR_PERIOD = 14;
export const WINDOW_CANDLES = 12;
export const FINAL_CALLED_OUTCOMES = new Set(['right', 'wrong', 'flat', 'no_data']);
export const RULE_TEXT = 'A flag is right if price moves 1 ATR (14) of its own timeframe in the called direction before moving 1 ATR against it, within 12 candles of that timeframe; flat if neither happens (excluded from the rate).';
const TF_MS = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };
const DAY = 86_400_000;

export const calledFlagOutcomesFile = (dataDir) => path.join(dataDir, 'called-flag-outcomes.jsonl');
export const calledFlagsSummaryFile = (dataDir) => path.join(dataDir, 'called-flags.json');
export const calledFlagId = (c) => `flag|${c.symbol}|${c.candidateId}`;

/** One call per symbol+candidateId from LOCK_OPPORTUNITY alert lines (earliest sentAt wins). */
export function calledFlagsFromAlerts(alertRows) {
  const byKey = new Map();
  for (const r of alertRows || []) {
    if (!r || r.kind !== CALLED_FLAG_KIND || !r.symbol) continue;
    const at = Date.parse(r.sentAt);
    if (!Number.isFinite(at)) continue;
    if (r.direction !== 'long' && r.direction !== 'short') continue;
    if (!TF_MS[r.timeframe] || !isFiniteNumber(r.entry)) continue;
    const key = `${r.symbol}|${r.candidateId || r.id || r.sentAt}`;
    const prev = byKey.get(key);
    if (prev && Date.parse(prev.calledAt) <= at) continue;
    byKey.set(key, {
      callId: `flag|${key}`, calledAt: new Date(at).toISOString(), symbol: r.symbol, candidateId: r.candidateId || null,
      timeframe: r.timeframe, direction: r.direction, entry: r.entry,
      stop: isFiniteNumber(r.stop) ? r.stop : null, tp1: isFiniteNumber(r.tp1) ? r.tp1 : null
    });
  }
  return [...byKey.values()].sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt));
}

/** Bucket ascending 1m candles into epoch-aligned tf candles that closed at or before `untilMs`. */
export function bucketCandles(candles1m, tfMs, untilMs = Infinity) {
  const per = tfMs / 60_000;
  const buckets = new Map();
  for (const c of candles1m || []) {
    const b = Math.floor(c.timestamp / tfMs) * tfMs;
    if (b + tfMs > untilMs) continue;
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, { timestamp: b, open: c.open, high: c.high, low: c.low, close: c.close, n: 1 });
    else { // input is ascending, so the latest 1m candle seen is the bucket close
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.n++;
    }
  }
  // a bucket must be (nearly) full to count; a half-built one would understate range
  return [...buckets.values()].filter((b) => b.n >= Math.ceil(per * 0.8)).sort((a, b) => a.timestamp - b.timestamp);
}

/** Mean true range of the last `period` tf candles (needs period + 1 candles), else null. */
export function atrOf(bars, period = ATR_PERIOD) {
  if (!bars || bars.length < period + 1) return null;
  const tail = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i++) {
    sum += Math.max(tail[i].high - tail[i].low, Math.abs(tail[i].high - tail[i - 1].close), Math.abs(tail[i].low - tail[i - 1].close));
  }
  const atr = sum / period;
  return atr > 0 ? atr : null;
}

/** Score one call. candles1m ascending, {timestamp, open, high, low, close}. */
export function scoreCalledFlag(call, candles1m, nowMs = Date.now()) {
  const empty = (outcome, extra = {}) => ({ outcome, atr: null, resolvedAt: null, maxFavorableAtr: null, maxAdverseAtr: null, ...extra });
  const tfMs = TF_MS[call.timeframe];
  const calledMs = Date.parse(call.calledAt);
  if (!tfMs || !Number.isFinite(calledMs) || !isFiniteNumber(call.entry) || (call.direction !== 'long' && call.direction !== 'short')) return empty('no_data');
  const windowEnd = calledMs + WINDOW_CANDLES * tfMs;
  const ended = nowMs >= windowEnd;
  const atr = atrOf(bucketCandles(candles1m, tfMs, calledMs));
  if (atr === null) return empty(ended ? 'no_data' : 'open');
  const sign = call.direction === 'long' ? 1 : -1;
  const up = call.entry + sign * atr;
  const down = call.entry - sign * atr;
  let fav = 0;
  let adv = 0;
  let seen = 0;
  for (const c of candles1m || []) {
    if (c.timestamp < calledMs) continue;
    if (c.timestamp >= windowEnd || c.timestamp >= nowMs) break;
    seen++;
    const best = sign === 1 ? c.high - call.entry : call.entry - c.low;
    const worst = sign === 1 ? call.entry - c.low : c.high - call.entry;
    fav = Math.max(fav, best / atr);
    adv = Math.max(adv, worst / atr);
    const hitAgainst = sign === 1 ? c.low <= down : c.high >= down;
    const hitFor = sign === 1 ? c.high >= up : c.low <= up;
    if (hitAgainst || hitFor) {
      return { outcome: hitAgainst ? 'wrong' : 'right', atr: round(atr, 6), resolvedAt: new Date(c.timestamp + 60_000).toISOString(), maxFavorableAtr: round(fav, 3), maxAdverseAtr: round(adv, 3) };
    }
  }
  const base = { atr: round(atr, 6), resolvedAt: null, maxFavorableAtr: round(fav, 3), maxAdverseAtr: round(adv, 3) };
  if (!ended) return { outcome: 'open', ...base };
  return { outcome: seen ? 'flat' : 'no_data', ...base, resolvedAt: seen ? new Date(windowEnd).toISOString() : null };
}

/** Idempotent: a row whose outcome is final is kept as scored before. */
export function scoreCalledFlags(calls, candlesBySymbol, previous = [], nowMs = Date.now()) {
  const prevById = new Map((previous || []).map((r) => [r.callId, r]));
  const nowIso = new Date(nowMs).toISOString();
  const rows = [];
  for (const call of calls || []) {
    if (!call || !call.symbol) continue;
    const callId = call.callId || calledFlagId(call);
    const prev = prevById.get(callId);
    const result = prev && FINAL_CALLED_OUTCOMES.has(prev.outcome)
      ? { outcome: prev.outcome, atr: prev.atr, resolvedAt: prev.resolvedAt, maxFavorableAtr: prev.maxFavorableAtr, maxAdverseAtr: prev.maxAdverseAtr }
      : scoreCalledFlag(call, (candlesBySymbol || {})[call.symbol] || [], nowMs);
    const row = { callId, calledAt: call.calledAt, symbol: call.symbol, candidateId: call.candidateId ?? null, timeframe: call.timeframe, direction: call.direction, entry: call.entry, stop: call.stop ?? null, tp1: call.tp1 ?? null, ...result };
    row.scoredAt = prev && prev.scoredAt && JSON.stringify({ ...prev, scoredAt: 0 }) === JSON.stringify({ ...row, scoredAt: 0 }) ? prev.scoredAt : nowIso;
    rows.push(row);
  }
  return rows;
}

const emptySide = () => ({ called: 0, right: 0, wrong: 0, flat: 0, open: 0 });
function windowOf(rows) {
  const w = { long: emptySide(), short: emptySide(), total: emptySide(), rate: null };
  for (const r of rows) {
    const side = r.direction === 'short' ? w.short : w.long;
    for (const s of [side, w.total]) {
      s.called++;
      if (r.outcome === 'right' || r.outcome === 'wrong' || r.outcome === 'flat' || r.outcome === 'open') s[r.outcome]++;
    }
  }
  const decided = w.total.right + w.total.wrong;
  w.rate = decided ? Math.round((w.total.right / decided) * 100) : null;
  return w;
}

export function summarizeCalledFlags(rows, nowMs = Date.now()) {
  const list = (rows || []).filter((r) => r && Number.isFinite(Date.parse(r.calledAt))).sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt));
  const inLast = (days) => list.filter((r) => Date.parse(r.calledAt) > nowMs - days * DAY);
  return {
    rule: RULE_TEXT,
    since: list.length ? list[0].calledAt : null,
    windows: { '24h': windowOf(inLast(1)), '7d': windowOf(inLast(7)), '30d': windowOf(inLast(30)) },
    recent: list.slice(-20).map((r) => ({ calledAt: r.calledAt, symbol: r.symbol, timeframe: r.timeframe, direction: r.direction, outcome: r.outcome }))
  };
}

/** Score the pulled alert log and write called-flag-outcomes.jsonl + called-flags.json. */
export function scoreCalledFlagsDataDir(dataDir, nowMs = Date.now()) {
  const calls = calledFlagsFromAlerts(readTelegramAlerts(dataDir));
  const rows = scoreCalledFlags(calls, readCandles(dataDir, '1m'), readJsonl(calledFlagOutcomesFile(dataDir)), nowMs);
  writeJsonl(calledFlagOutcomesFile(dataDir), rows);
  writeJson(calledFlagsSummaryFile(dataDir), summarizeCalledFlags(rows, nowMs));
  return rows;
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const rows = scoreCalledFlagsDataDir(opts.data, nowMs);
  console.log(`[tracker:called-flags] ${rows.length} called flag(s) -> ${calledFlagsSummaryFile(opts.data)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
