#!/usr/bin/env node
/**
 * EditTrades call tracker - called-flag scorer (public homepage "called flags").
 *
 * A called flag = every Telegram alert of kind LOCK_OPPORTUNITY in the pulled alert log
 * (one per symbol+candidateId). Owner's success rule (fixed):
 *   RIGHT = price moves 1x ATR(14) of the flag's own timeframe in the called direction BEFORE
 *           it moves 1x ATR against, within 12 candles of that timeframe, measured from the
 *           price when the alert was sent (open of the first 1m candle at/after the alert; else
 *           the last 1m close before it). `entryOffsetAtr` records how far past the entry level
 *           that price already was, in the trade direction.
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
export const RULE_TEXT = 'A flag is right if price moves 1 ATR (14) of its own timeframe in the called direction before moving 1 ATR against it, within 12 candles of that timeframe, measured from the price when the alert was sent; flat if neither happens (excluded from the rate).';
const TF_MS = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };
const DAY = 86_400_000;

export const calledFlagOutcomesFile = (dataDir) => path.join(dataDir, 'called-flag-outcomes.jsonl');
export const calledFlagsSummaryFile = (dataDir) => path.join(dataDir, 'called-flags.json');
export const flagCalibrationFile = (dataDir) => path.join(dataDir, 'flag-calibration.json');
export const calledFlagId = (c) => `flag|${c.symbol}|${c.candidateId}`;

/** Compact flow fields carried onto each call; null for legacy alert lines (no `flow`). */
export function flowOf(f) {
  if (!f || typeof f !== 'object' || !isFiniteNumber(f.score)) return null;
  return {
    score: f.score, of: isFiniteNumber(f.of) ? f.of : 7, rr: isFiniteNumber(f.rr) ? f.rr : null,
    nextTf: f.nextTf === 'agrees' || f.nextTf === 'mixed' || f.nextTf === 'disagrees' ? f.nextTf : null
  };
}

/**
 * Flow fields read back from a stored alert's text, for lines stored before the collector kept
 * `flow` (snapshot: thesis "... · 3m agrees", "Checklist 5/7"). R:R from the alert's own levels.
 */
export function flowFromText(r) {
  const text = r && typeof r.text === 'string' ? r.text : '';
  const m = /Checklist (\d+)\/(\d+)/.exec(text);
  if (!m) return null;
  const next = /\b(agrees|mixed|disagrees)\b/.exec(text);
  const risk = isFiniteNumber(r.entry) && isFiniteNumber(r.stop) ? Math.abs(r.entry - r.stop) : null;
  const rr = risk && isFiniteNumber(r.tp1) ? Math.round((Math.abs(r.tp1 - r.entry) / risk) * 100) / 100 : null;
  return flowOf({ score: Number(m[1]), of: Number(m[2]), rr, nextTf: next ? next[1] : null });
}

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
      stop: isFiniteNumber(r.stop) ? r.stop : null, tp1: isFiniteNumber(r.tp1) ? r.tp1 : null,
      flow: flowOf(r.flow) || flowFromText(r)
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
  const empty = (outcome, extra = {}) => ({ outcome, atr: null, anchor: null, entryOffsetAtr: null, resolvedAt: null, maxFavorableAtr: null, maxAdverseAtr: null, ...extra });
  const tfMs = TF_MS[call.timeframe];
  const calledMs = Date.parse(call.calledAt);
  if (!tfMs || !Number.isFinite(calledMs) || !isFiniteNumber(call.entry) || (call.direction !== 'long' && call.direction !== 'short')) return empty('no_data');
  const windowEnd = calledMs + WINDOW_CANDLES * tfMs;
  const ended = nowMs >= windowEnd;
  const atr = atrOf(bucketCandles(candles1m, tfMs, calledMs));
  if (atr === null) return empty(ended ? 'no_data' : 'open');
  const sign = call.direction === 'long' ? 1 : -1;
  // Anchor = the alert price: open of the first 1m candle at/after the alert, else the last 1m close before it.
  let anchor = null;
  for (const c of candles1m || []) { if (c.timestamp >= calledMs) { anchor = c.open; break; } }
  if (!isFiniteNumber(anchor)) {
    for (let k = (candles1m || []).length - 1; k >= 0; k--) { if (candles1m[k].timestamp < calledMs) { anchor = candles1m[k].close; break; } }
  }
  if (!isFiniteNumber(anchor)) return empty(ended ? 'no_data' : 'open', { atr: round(atr, 6) });
  const entryOffsetAtr = round(((anchor - call.entry) * sign) / atr, 3);
  const up = anchor + sign * atr;
  const down = anchor - sign * atr;
  let fav = 0;
  let adv = 0;
  let seen = 0;
  for (const c of candles1m || []) {
    if (c.timestamp < calledMs) continue;
    if (c.timestamp >= windowEnd || c.timestamp >= nowMs) break;
    seen++;
    const best = sign === 1 ? c.high - anchor : anchor - c.low;
    const worst = sign === 1 ? anchor - c.low : c.high - anchor;
    fav = Math.max(fav, best / atr);
    adv = Math.max(adv, worst / atr);
    const hitAgainst = sign === 1 ? c.low <= down : c.high >= down;
    const hitFor = sign === 1 ? c.high >= up : c.low <= up;
    if (hitAgainst || hitFor) {
      return { outcome: hitAgainst ? 'wrong' : 'right', atr: round(atr, 6), anchor: round(anchor, 6), entryOffsetAtr, resolvedAt: new Date(c.timestamp + 60_000).toISOString(), maxFavorableAtr: round(fav, 3), maxAdverseAtr: round(adv, 3) };
    }
  }
  const base = { atr: round(atr, 6), anchor: round(anchor, 6), entryOffsetAtr, resolvedAt: null, maxFavorableAtr: round(fav, 3), maxAdverseAtr: round(adv, 3) };
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
    // A final kept from before the alert-price rule (no `anchor`) is re-scored once under it.
    const result = prev && FINAL_CALLED_OUTCOMES.has(prev.outcome) && prev.anchor != null
      ? { outcome: prev.outcome, atr: prev.atr, anchor: prev.anchor ?? null, entryOffsetAtr: prev.entryOffsetAtr ?? null, resolvedAt: prev.resolvedAt, maxFavorableAtr: prev.maxFavorableAtr, maxAdverseAtr: prev.maxAdverseAtr }
      : scoreCalledFlag(call, (candlesBySymbol || {})[call.symbol] || [], nowMs);
    const row = { callId, calledAt: call.calledAt, symbol: call.symbol, candidateId: call.candidateId ?? null, timeframe: call.timeframe, direction: call.direction, entry: call.entry, stop: call.stop ?? null, tp1: call.tp1 ?? null, flow: flowOf(call.flow), ...result };
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
  const all = (rows || []).filter((r) => r && Number.isFinite(Date.parse(r.calledAt))).sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt));
  const list = all.filter((r) => r.flow); // headline = current system only (calls carrying `flow`)
  const legacyRows = all.filter((r) => !r.flow);
  const inLast = (days) => list.filter((r) => Date.parse(r.calledAt) > nowMs - days * DAY);
  const lw = windowOf(legacyRows).total;
  const legacyDecided = lw.right + lw.wrong;
  return {
    rule: RULE_TEXT,
    since: list.length ? list[0].calledAt : null,
    windows: { '24h': windowOf(inLast(1)), '7d': windowOf(inLast(7)), '30d': windowOf(inLast(30)) },
    recent: list.slice(-20).map((r) => ({ calledAt: r.calledAt, symbol: r.symbol, timeframe: r.timeframe, direction: r.direction, outcome: r.outcome })),
    legacy: { ...lw, rate: legacyDecided ? Math.round((lw.right / legacyDecided) * 100) : null }
  };
}

// ---- calibration: which flow-call slices hit the owner's target, from real counts only ----
const TF_ORDER = Object.keys(TF_MS);
const TF_SETS = [TF_ORDER, TF_ORDER.slice(1), TF_ORDER.slice(2), TF_ORDER.slice(3)];
const rrKey = (rr) => (rr === null || rr === undefined ? null : rr < 1 ? '<1R' : rr < 2 ? '1-2R' : '2R+');

function bucketOf(key, rows, minN) {
  let right = 0, wrong = 0, flat = 0;
  for (const r of rows) { if (r.outcome === 'right') right++; else if (r.outcome === 'wrong') wrong++; else if (r.outcome === 'flat') flat++; }
  const n = right + wrong;
  const rate = n ? Math.round((right / n) * 100) : null;
  return { key, n, right, wrong, flat, rate, status: n < minN ? 'thin' : null };
}

function withStatus(b, target) {
  return { ...b, status: b.status === 'thin' ? 'thin' : b.rate >= target ? 'meets' : 'below' };
}

function groupBuckets(rows, keys, keyOf, { target, minN }) {
  return keys.map((k) => withStatus(bucketOf(k, rows.filter((r) => keyOf(r) === k), minN), target));
}

const tfLabel = (tfs) => `${tfs[0]}\u2013${tfs[tfs.length - 1]}`;
function ruleKeeps(rule, r) {
  const f = r.flow;
  if (f.score < Number(rule.minScore.split('/')[0])) return false;
  if (!rule.timeframes.includes(r.timeframe)) return false;
  if (rule.minRR !== null && !(f.rr !== null && f.rr >= rule.minRR)) return false;
  if (rule.nextTf && f.nextTf !== rule.nextTf) return false;
  return true;
}
function ruleText(rule) {
  return `${rule.minScore}+` + ` on ${tfLabel(rule.timeframes)}` +
    (rule.minRR !== null ? ` with R:R \u2265 ${rule.minRR}` : '') + (rule.nextTf ? `${rule.minRR !== null ? ' and' : ' with'} the next timeframe agreeing` : '');
}

/** Pure. rows = outcome rows; only flow calls inside the rolling `windowDays` (default 30) are used. */
export function calibrateCalledFlags(rows, nowMs = Date.now(), { target = 70, minN = 30, windowDays = 30 } = {}) {
  const inWin = (rows || []).filter((r) => r && Number.isFinite(Date.parse(r.calledAt)) && Date.parse(r.calledAt) > nowMs - windowDays * DAY);
  const flowRows = inWin.filter((r) => r.flow);
  const legacyCount = inWin.length - flowRows.length;
  const decided = flowRows.filter((r) => r.outcome === 'right' || r.outcome === 'wrong');
  const opts = { target, minN };
  const symbols = [...new Set(flowRows.map((r) => r.symbol))].sort();
  const buckets = {
    score: groupBuckets(flowRows, ['5/7', '6/7', '7/7'], (r) => `${r.flow.score}/7`, opts),
    timeframe: groupBuckets(flowRows, TF_ORDER, (r) => r.timeframe, opts),
    symbol: groupBuckets(flowRows, symbols, (r) => r.symbol, opts),
    direction: groupBuckets(flowRows, ['long', 'short'], (r) => r.direction, opts),
    rr: groupBuckets(flowRows, ['<1R', '1-2R', '2R+'], (r) => rrKey(r.flow.rr), opts),
    nextTf: groupBuckets(flowRows, ['agrees', 'mixed', 'disagrees'], (r) => r.flow.nextTf, opts)
  };

  const rules = [];
  for (const minScore of [5, 6, 7]) for (const minRR of [null, 1, 1.5, 2]) for (const nextTf of [null, 'agrees']) for (const timeframes of TF_SETS) {
    const rule = { minScore: `${minScore}/7`, timeframes, minRR, nextTf };
    let right = 0, wrong = 0;
    for (const r of decided) if (ruleKeeps(rule, r)) { if (r.outcome === 'right') right++; else wrong++; }
    const n = right + wrong;
    const exact = n ? (right / n) * 100 : -1;
    const projected = { n, right, wrong, rate: n ? Math.round(exact) : null };
    rules.push({ rule, projected, exact, tier: n >= minN && exact >= target ? 0 : n >= minN ? 1 : 2 });
  }
  rules.sort((a, b) => a.tier - b.tier ||
    (a.tier === 0 ? b.projected.n - a.projected.n || b.exact - a.exact : b.exact - a.exact || b.projected.n - a.projected.n));

  const reasonOf = (c) => {
    const { n, rate } = c.projected;
    if (n < minN) return `Not enough data yet: best rule has ${n} calls; needs ${minN}.`;
    return c.tier === 0 ? `${ruleText(c.rule)} hit ${rate}% over ${n} calls.` : `Best rule (${ruleText(c.rule)}) hit ${rate}% over ${n} calls, below the ${target}% target.`;
  };
  const shape = (c) => ({ rule: c.rule, projected: c.projected, reason: reasonOf(c) });
  const best = rules[0];
  const status = best.tier === 0 ? 'meets' : best.tier === 1 ? 'below' : 'needs_data';
  return {
    generatedAt: new Date(nowMs).toISOString(), target, minN, scored: decided.length, legacyCount, buckets,
    recommended: { status, ...shape(best) },
    candidates: rules.slice(0, 5).map(shape)
  };
}

/** Score the pulled alert log and write called-flag-outcomes.jsonl + called-flags.json. */
export function scoreCalledFlagsDataDir(dataDir, nowMs = Date.now()) {
  const calls = calledFlagsFromAlerts(readTelegramAlerts(dataDir));
  const rows = scoreCalledFlags(calls, readCandles(dataDir, '1m'), readJsonl(calledFlagOutcomesFile(dataDir)), nowMs);
  writeJsonl(calledFlagOutcomesFile(dataDir), rows);
  writeJson(calledFlagsSummaryFile(dataDir), summarizeCalledFlags(rows, nowMs));
  writeJson(flagCalibrationFile(dataDir), calibrateCalledFlags(rows, nowMs, { target: 70, minN: 30 }));
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
