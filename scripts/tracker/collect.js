#!/usr/bin/env node
/**
 * EditTrades call tracker - collector (T1, docs/PLAN_CALL_TRACKER.md item 1-2).
 *
 * GET /api/scalp-context with `Authorization: Bearer $SCALP_CONTEXT_API_KEY` (env only,
 * never logged, never written), then per symbol append one call row to
 * data/calls/YYYY-MM-DD.jsonl and the payload's closed 1m/5m/15m candles to
 * data/candles/<tf>.jsonl. Dedupe: symbol+closedThrough for calls, symbol+t for candles.
 *
 * Account data never reaches disk: rows are built from an explicit field list, then
 * every key named account/wallet/performance/margin/holdings* or containing
 * wallet/balance/address is stripped at any depth, then the row is re-checked and the
 * write refused (fail closed) if any such key survived.
 *
 * Wallet value (owner decision 2026-09-23: the value may be public) goes to a separate
 * data/wallet.jsonl through walletRowFromPayload, an explicit whitelist: WALLET_KEYS
 * only, numbers only, nulls unless account.status is 'available'. The address, the
 * holdings breakdown and every other account field never reach disk.
 *
 * Trade journal (T2, docs/PLAN_TRADE_JOURNAL.md): pullJournal fetches the journal API's
 * public Blob files with plain HTTP - journal/manifest.json ({baseUrl, days[]}), then
 * each journal/YYYY-MM-DD.jsonl - into data/journal/ (dedupe by id). The store's base
 * URL comes from --journal-base, else JOURNAL_BLOB_BASE, else the store id inside
 * BLOB_READ_WRITE_TOKEN (the token itself is never sent, logged or written). Records
 * carry no account fields, but each one still goes through the same sensitive-key strip
 * and fail-closed re-check as the call rows. A failed pull warns; it never fails the run.
 *
 * Served calls (T3, docs/PLAN_SERVED_CALLS.md): pullServed fetches the calls the engine
 * served to the GPT from the same Blob base - served/manifest.json, then each
 * served/YYYY-MM-DD.jsonl from the newest stored served day minus one - and appends them
 * to data/calls/ as capture rows with source 'served' (appendServedCalls: a close already
 * captured by cron is dropped). Same strip and fail-closed re-check. A failed pull warns.
 *
 * Telegram alerts (T-1, docs/PLAN_TELEGRAM.md): pullTelegramStatus fetches
 * telegram/state.json from the same Blob base and writes data/telegram-status.json with
 * only the cron heartbeat and alert counters (telegramStatusFromState whitelist) for the
 * page's Status "Alerts" fact. A failed pull warns; it never fails the run.
 *
 * Telegram sent alerts + transitions: pullTelegramLogs fetches telegram/alerts/ and
 * telegram/transitions/ (manifest, then the day files from the newest stored day minus
 * one) into data/telegram-alerts/ (dedupe by id) and data/transitions/ (dedupe by
 * candidateId+at). Lines are rebuilt from a field whitelist (TELEGRAM_ALERT_FIELDS,
 * TRANSITION_FIELDS), then the same strip and fail-closed re-check. A failed pull warns.
 *
 * GOOD calls from the 1-minute alert log (T-12, docs/GAP_CHECK_2026-09-26.md): the
 * 10-minute capture cadence misses most GOOD calls (a GOOD window runs 2-5 min). Once the
 * Telegram alert log above is pulled, goodCallsFromAlertLines/goodCallsFromCaptureRows/
 * mergeGoodCalls/goodEndedTimesFromAlertLines (pure, below) turn it plus the stored
 * captures into one merged GOOD call per symbol+candidateId; score.js walks the result
 * into data/good-call-outcomes.jsonl.
 *
 * Usage: node collect.js [--data ./data] [--url <scalp-context url>] [--journal-base <url>] [--no-journal] [--no-served] [--no-telegram]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, appendCalls, appendServedCalls, appendCandles, appendWallet, appendJournal, readAllCalls, writeJson, telegramStatusFile, CANDLE_TIMEFRAMES,
  appendTelegramAlerts, appendTransitions, readTelegramAlerts, readTransitions
} from './store.js';
import { stripSensitive, findSensitiveKeys, recordsFromPayload, servedKey } from './records.js';

// Row building lives in records.js (shared with the engine's served-calls recorder).
export { isSensitiveKey, stripSensitive, findSensitiveKeys, slimCandidate, recordsFromPayload, servedKey } from './records.js';

export const DEFAULT_URL = 'https://snapshottradingview.vercel.app/api/scalp-context';

const TF_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };

/** The only keys a wallet.jsonl row may carry, in order. */
export const WALLET_KEYS = Object.freeze(['t', 'status', 'marginUsd', 'holdingsUsd', 'totalUsd', 'baselineUsd', 'pnlUsd', 'pnlPct']);

const money = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * One whitelisted wallet-value sample from the payload's account block, or null when the
 * payload has no valid closedThrough. Built key by key (nothing is copied wholesale):
 * t = closedThrough, status = account.status (a short lowercase word, else 'unknown';
 * 'absent' when there is no account block), and numbers from account.margin.usd,
 * account.holdingsUsd and account.performance.{baselineUsd, netPnlUsd, returnPct}.
 * Any status other than 'available' writes nulls. Throws if the key set is not WALLET_KEYS.
 * @param {Object} payload
 * @returns {Object|null}
 */
export function walletRowFromPayload(payload) {
  const ms = Date.parse(payload && payload.closedThrough);
  if (!Number.isFinite(ms)) return null;
  const account = payload.account && typeof payload.account === 'object' ? payload.account : null;
  const raw = account ? account.status : 'absent';
  const status = typeof raw === 'string' && /^[a-z_]{1,24}$/.test(raw) ? raw : 'unknown';
  const row = { t: new Date(ms).toISOString(), status, marginUsd: null, holdingsUsd: null, totalUsd: null, baselineUsd: null, pnlUsd: null, pnlPct: null };
  if (status === 'available') {
    const perf = account.performance && typeof account.performance === 'object' ? account.performance : {};
    row.marginUsd = money(account.margin && typeof account.margin === 'object' ? account.margin.usd : null);
    row.holdingsUsd = money(account.holdingsUsd);
    row.totalUsd = row.marginUsd !== null && row.holdingsUsd !== null ? money(row.marginUsd + row.holdingsUsd) : null;
    row.baselineUsd = money(perf.baselineUsd);
    row.pnlUsd = money(perf.netPnlUsd);
    row.pnlPct = money(perf.returnPct);
  }
  if (Object.keys(row).join() !== WALLET_KEYS.join()) throw new Error('refusing to write: wallet row keys are not the whitelist');
  for (const k of WALLET_KEYS.slice(2)) {
    if (row[k] !== null && typeof row[k] !== 'number') throw new Error('refusing to write: wallet row value is not a number');
  }
  return row;
}

/**
 * Closed candles per timeframe from the payload: {tf: [{symbol,t,o,h,l,c,v}]}. A candle
 * is kept only if its close (t + interval) is at or before that timeframe's closedThrough.
 */
export function candlesFromPayload(payload) {
  const out = {};
  for (const tf of CANDLE_TIMEFRAMES) out[tf] = [];
  const symbols = payload && payload.symbols && typeof payload.symbols === 'object' ? payload.symbols : {};
  for (const [symbol, sym] of Object.entries(symbols)) {
    for (const tf of CANDLE_TIMEFRAMES) {
      const frame = sym && sym.timeframes && sym.timeframes[tf];
      if (!frame || !Array.isArray(frame.candles)) continue;
      const through = Date.parse(frame.closedThrough ?? payload.closedThrough);
      for (const c of frame.candles) {
        const t = Date.parse(c && c.t);
        if (!Number.isFinite(t)) continue;
        if (Number.isFinite(through) && t + TF_MS[tf] > through) continue;
        if (![c.o, c.h, c.l, c.c].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
        out[tf].push({ symbol, t: new Date(t).toISOString(), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v ?? null });
      }
    }
  }
  return out;
}


/**
 * Kraken public 1m OHLC (no key; ~12 h retention) so the candle store stays contiguous at
 * 1-minute resolution whatever the capture cadence. The payload only carries the last 20
 * 1m candles. The final Kraken row is the still-open candle and is dropped.
 * @returns {Array<{symbol:string,t:string,o:number,h:number,l:number,c:number,v:number|null}>}
 */
export const KRAKEN_PAIRS = Object.freeze({ BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD' });

export function candlesFromKraken(symbol, result) {
  if (!result || typeof result !== 'object') return [];
  const key = Object.keys(result).find((k) => k !== 'last' && Array.isArray(result[k]));
  const rows = key ? result[key] : [];
  const out = [];
  for (const r of rows.slice(0, -1)) {
    if (!Array.isArray(r) || r.length < 7) continue;
    const [ts, o, h, l, c, , v] = r;
    const t = Number(ts) * 1000;
    const nums = [o, h, l, c].map(Number);
    if (!Number.isFinite(t) || !nums.every(Number.isFinite)) continue;
    out.push({ symbol, t: new Date(t).toISOString(), o: nums[0], h: nums[1], l: nums[2], c: nums[3], v: Number.isFinite(Number(v)) ? Number(v) : null });
  }
  return out;
}

export async function backfillKraken1m(dataDir, symbols = Object.keys(KRAKEN_PAIRS)) {
  let added = 0;
  for (const symbol of symbols) {
    const pair = KRAKEN_PAIRS[symbol];
    if (!pair) continue;
    try {
      const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) { console.warn(`[tracker:collect] kraken ${symbol} HTTP ${res.status}`); continue; }
      const body = await res.json();
      if (Array.isArray(body.error) && body.error.length) { console.warn(`[tracker:collect] kraken ${symbol}: ${body.error.join(';')}`); continue; }
      added += appendCandles(dataDir, '1m', candlesFromKraken(symbol, body.result));
    } catch (err) {
      console.warn(`[tracker:collect] kraken ${symbol} failed: ${err.message}`);
    }
  }
  return added;
}

// ---------------------------------------------------------------- journal (T2)

/**
 * Public Blob base URL (https://<storeid>.public.blob.vercel-storage.com) from a Blob
 * read-write token (`vercel_blob_rw_<storeId>_<secret>`), or null. Only the store id is used.
 */
export function blobBaseFromToken(token) {
  const m = typeof token === 'string' ? token.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/) : null;
  return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com` : null;
}

/** Journal base URL: explicit option, JOURNAL_BLOB_BASE, else derived from BLOB_READ_WRITE_TOKEN. */
export function resolveJournalBase(opts = {}, env = process.env) {
  const explicit = typeof opts['journal-base'] === 'string' ? opts['journal-base'] : env.JOURNAL_BLOB_BASE;
  const base = explicit || blobBaseFromToken(env.BLOB_READ_WRITE_TOKEN);
  return base ? String(base).replace(/\/+$/, '') : null;
}

/**
 * Journal records made safe to store: plain objects with an id and receivedAt, sensitive
 * keys stripped at any depth; throws (nothing written) if any survives the strip.
 */
export function journalRecordsFromLines(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || !Number.isFinite(Date.parse(r.receivedAt))) continue;
    const clean = stripSensitive(r);
    if (findSensitiveKeys(clean).length) throw new Error('refusing to write: sensitive keys survived strip in a journal record');
    out.push(clean);
  }
  return out;
}

function parseLines(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line skipped */ }
  }
  return rows;
}

/**
 * Pull the journal day files listed in the manifest into data/journal/.
 * @param {string} dataDir
 * @param {string} base - public Blob base URL
 * @param {Function} [fetchImpl=fetch]
 * @param {number} [nowMs=Date.now()] - cache-buster
 * @returns {Promise<{days:number, added:number, duplicates:number}>}
 */
export async function pullJournal(dataDir, base, fetchImpl = fetch, nowMs = Date.now()) {
  const get = async (url) => {
    const res = await fetchImpl(`${url}?t=${nowMs}`, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`journal HTTP ${res.status}`);
    return res.text();
  };
  const manifestText = await get(`${base}/journal/manifest.json`);
  if (manifestText === null) return { days: 0, added: 0, duplicates: 0 };
  const manifest = JSON.parse(manifestText);
  const days = Array.isArray(manifest.days) ? manifest.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const fileBase = typeof manifest.baseUrl === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(manifest.baseUrl) ? manifest.baseUrl : base;
  const rows = [];
  for (const day of days) {
    const text = await get(`${fileBase}/journal/${day}.jsonl`);
    if (text !== null) rows.push(...parseLines(text));
  }
  const result = appendJournal(dataDir, journalRecordsFromLines(rows));
  return { days: days.length, ...result };
}

// ---------------------------------------------------------------- served calls (T3)

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Served-call rows made safe to store: plain objects with a symbol, a valid closedThrough
 * and a flagRecommendation; sensitive keys stripped at any depth; source forced to
 * 'served'. Throws (nothing written) if any sensitive key survives the strip.
 */
export function servedRowsFromLines(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.symbol !== 'string' || !Number.isFinite(Date.parse(r.closedThrough))) continue;
    if (!r.flagRecommendation || typeof r.flagRecommendation !== 'object') continue;
    const clean = { ...stripSensitive(r), source: 'served' };
    if (findSensitiveKeys(clean).length) throw new Error('refusing to write: sensitive keys survived strip in a served row');
    out.push(clean);
  }
  return out;
}

/**
 * Pull served-call day files into data/calls/, from the newest stored served day minus one
 * (all listed days when none is stored yet).
 * @param {string} dataDir
 * @param {string} base - public Blob base URL
 * @param {Function} [fetchImpl=fetch]
 * @param {number} [nowMs=Date.now()] - cache-buster
 * @returns {Promise<{days:number, added:number, duplicates:number}>}
 */
export async function pullServed(dataDir, base, fetchImpl = fetch, nowMs = Date.now()) {
  const get = async (url) => {
    const res = await fetchImpl(`${url}?t=${nowMs}`, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`served HTTP ${res.status}`);
    return res.text();
  };
  const manifestText = await get(`${base}/served/manifest.json`);
  if (manifestText === null) return { days: 0, added: 0, duplicates: 0 };
  const manifest = JSON.parse(manifestText);
  const listed = Array.isArray(manifest.days) ? manifest.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const newest = readAllCalls(dataDir)
    .filter((r) => r.source === 'served')
    .map((r) => Date.parse(r.servedAt || r.capturedAt))
    .filter(Number.isFinite)
    .reduce((m, ms) => Math.max(m, ms), -Infinity);
  const from = Number.isFinite(newest) ? new Date(newest - DAY_MS).toISOString().slice(0, 10) : null;
  const days = from ? listed.filter((d) => d >= from) : listed;
  const fileBase = typeof manifest.baseUrl === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(manifest.baseUrl) ? manifest.baseUrl : base;
  const rows = [];
  for (const day of days) {
    const text = await get(`${fileBase}/served/${day}.jsonl`);
    if (text !== null) rows.push(...parseLines(text));
  }
  const result = appendServedCalls(dataDir, servedRowsFromLines(rows), servedKey);
  return { days: days.length, ...result };
}

// ---------------------------------------------------------------- Telegram alerts (T-1)

const isoOrNull = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const shortWord = (v) => (typeof v === 'string' && /^[A-Z_]{1,20}$/.test(v) ? v : null);

/**
 * The only Telegram fields the tracker keeps: cron heartbeat, today's alert count and the
 * last alert's time/symbol/kind. Everything else in the state (ids, reasons) is dropped.
 */
export function telegramStatusFromState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const alerts = s.alerts && typeof s.alerts === 'object' ? s.alerts : {};
  const last = alerts.last && typeof alerts.last === 'object' ? alerts.last : null;
  return {
    cronLastRunAt: isoOrNull(s.cron && s.cron.lastRunAt),
    alertsDay: typeof alerts.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(alerts.day) ? alerts.day : null,
    alertsToday: Number.isInteger(alerts.today) && alerts.today >= 0 ? alerts.today : 0,
    lastAlert: last && isoOrNull(last.at) ? { at: isoOrNull(last.at), symbol: shortWord(last.symbol), kind: shortWord(last.kind) } : null
  };
}

/**
 * Pull telegram/state.json into data/telegram-status.json (whitelisted). 404 -> no file
 * written, returns null.
 */
export async function pullTelegramStatus(dataDir, base, fetchImpl = fetch, nowMs = Date.now()) {
  const res = await fetchImpl(`${base}/telegram/state.json?t=${nowMs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
  const status = telegramStatusFromState(JSON.parse(await res.text()));
  writeJson(telegramStatusFile(dataDir), status);
  return status;
}

// ---------------------------------------------------------------- Telegram sent alerts + transitions

/** The only fields a stored sent-alert line keeps (lib/telegramLog.js alertLogLine), in order. */
export const TELEGRAM_ALERT_FIELDS = Object.freeze(['id', 'sentAt', 'kind', 'event', 'symbol', 'timeframe', 'direction', 'candidateId', 'signature', 'verdict', 'etaMin',
  'breakout', 'invalidation', 'entry', 'stop', 'tp1', 'grossRR', 'netRR', 'roomR', 'closedThrough', 'silent', 'level', 'tracked', 'delivered', 'text']);
/** The only fields a stored transition line keeps (lib/telegram.js diffCandidates), in order. */
export const TRANSITION_FIELDS = Object.freeze(['at', 'closedThrough', 'symbol', 'timeframe', 'direction', 'candidateId', 'from', 'to', 'planStatus', 'planFrom',
  'reasonCode', 'class', 'breakout', 'invalidation', 'measuredRR']);

const scalarOrNull = (v) => (v === null || v === undefined ? null : typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? v : null);

function whitelistRows(rows, fields, required, what) {
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || required.some((k) => r[k] === undefined || r[k] === null)) continue;
    const row = {};
    for (const k of fields) row[k] = scalarOrNull(r[k]);
    if (typeof row.text === 'string') row.text = row.text.slice(0, 200);
    const clean = stripSensitive(row);
    if (findSensitiveKeys(clean).length) throw new Error(`refusing to write: sensitive keys survived strip in a ${what} line`);
    out.push(clean);
  }
  return out;
}

/** Sent-alert lines made safe to store: whitelisted scalar fields, a string id and a valid sentAt. */
export function telegramAlertRowsFromLines(rows) {
  return whitelistRows(rows, TELEGRAM_ALERT_FIELDS, ['id', 'sentAt'], 'telegram alert')
    .filter((r) => typeof r.id === 'string' && Number.isFinite(Date.parse(r.sentAt)));
}

/** Transition lines made safe to store: whitelisted scalar fields, a candidateId and a valid at. */
export function transitionRowsFromLines(rows) {
  return whitelistRows(rows, TRANSITION_FIELDS, ['at', 'candidateId'], 'transition')
    .filter((r) => typeof r.candidateId === 'string' && Number.isFinite(Date.parse(r.at)));
}

/**
 * Pull one telegram/<kind>/ log (manifest, then day files from the newest stored day minus
 * one) and append it. 404 manifest -> nothing.
 */
async function pullDayLog({ dataDir, base, fetchImpl, nowMs, prefix, newestMs, toRows, append }) {
  const get = async (url) => {
    const res = await fetchImpl(`${url}?t=${nowMs}`, { headers: { Accept: '*/*' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${prefix} HTTP ${res.status}`);
    return res.text();
  };
  const manifestText = await get(`${base}/${prefix}/manifest.json`);
  if (manifestText === null) return { days: 0, added: 0, duplicates: 0 };
  const manifest = JSON.parse(manifestText);
  const listed = Array.isArray(manifest.days) ? manifest.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const from = Number.isFinite(newestMs) ? new Date(newestMs - DAY_MS).toISOString().slice(0, 10) : null;
  const days = from ? listed.filter((d) => d >= from) : listed;
  const fileBase = typeof manifest.baseUrl === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(manifest.baseUrl) ? manifest.baseUrl : base;
  const rows = [];
  for (const day of days) {
    const text = await get(`${fileBase}/${prefix}/${day}.jsonl`);
    if (text !== null) rows.push(...parseLines(text));
  }
  return { days: days.length, ...append(dataDir, toRows(rows)) };
}

const newestOf = (rows, key) => rows.map((r) => Date.parse(r[key])).filter(Number.isFinite).reduce((m, ms) => Math.max(m, ms), -Infinity);

/**
 * Pull the cron's sent-alert and transition logs into data/telegram-alerts/ and data/transitions/.
 * @returns {Promise<{alerts:{days:number, added:number, duplicates:number}, transitions:{days:number, added:number, duplicates:number}}>}
 */
export async function pullTelegramLogs(dataDir, base, fetchImpl = fetch, nowMs = Date.now()) {
  const alerts = await pullDayLog({
    dataDir, base, fetchImpl, nowMs, prefix: 'telegram/alerts', newestMs: newestOf(readTelegramAlerts(dataDir), 'sentAt'),
    toRows: telegramAlertRowsFromLines, append: appendTelegramAlerts
  });
  const transitions = await pullDayLog({
    dataDir, base, fetchImpl, nowMs, prefix: 'telegram/transitions', newestMs: newestOf(readTransitions(dataDir), 'at'),
    toRows: transitionRowsFromLines, append: appendTransitions
  });
  return { alerts, transitions };
}

// ---------------------------------------------------------------- GOOD calls from the 1-minute alert log (T-12)
//
// docs/GAP_CHECK_2026-09-26.md: the 10-minute capture cadence misses most GOOD calls (a
// GOOD window runs 2-5 min, sometimes under 1). The Telegram cron already logs every GOOD
// and GOOD_ENDED alert at 1-minute resolution (lib/telegramLog.js alertLogLine), pulled
// above into data/telegram-alerts/. These functions turn that log into GOOD call records
// and merge them with whatever the 10-minute captures separately saw, so the tracker's
// GOOD-call count reflects every GOOD the engine actually emitted, not just the ones a
// 10-minute poll happened to land inside. Pure - no fs, no network. score.js calls these
// to merge + walk-outcome score the result into data/good-call-outcomes.jsonl.

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * One GOOD call per symbol+candidateId, from the first (earliest sentAt) kind GOOD line
 * for that pair. Later GOOD lines for the same pair (a repeat send, e.g. TRACK/NUDGE) are
 * ignored - the first sighting is the call.
 * @param {Array<Object>} alertRows - data/telegram-alerts lines (lib/telegramLog.js alertLogLine shape)
 * @returns {Array<Object>} {symbol, candidateId, calledAt, timeframe, direction, entry, stop, tp1, grossRR, netRR, source:'alert-1m'}
 */
export function goodCallsFromAlertLines(alertRows) {
  const good = (alertRows || [])
    .filter((r) => r && r.kind === 'GOOD' && typeof r.symbol === 'string' && typeof r.candidateId === 'string' && Number.isFinite(Date.parse(r.sentAt)))
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const byKey = new Map();
  for (const r of good) {
    const key = `${r.symbol}|${r.candidateId}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      symbol: r.symbol,
      candidateId: r.candidateId,
      calledAt: r.sentAt,
      timeframe: typeof r.timeframe === 'string' ? r.timeframe : null,
      direction: r.direction === 'long' || r.direction === 'short' ? r.direction : null,
      entry: isFiniteNum(r.entry) ? r.entry : null,
      stop: isFiniteNum(r.stop) ? r.stop : null,
      tp1: isFiniteNum(r.tp1) ? r.tp1 : null,
      grossRR: isFiniteNum(r.grossRR) ? r.grossRR : null,
      netRR: isFiniteNum(r.netRR) ? r.netRR : null,
      source: 'alert-1m'
    });
  }
  return [...byKey.values()];
}

/**
 * symbol+candidateId -> the GOOD_ENDED line's sentAt that closed it. A GOOD_ENDED line
 * carries no candidateId of its own (lib/telegram.js diffAlerts pushes it as
 * `{kind:'GOOD_ENDED', symbol, text}`), but the engine holds one active GOOD candidate per
 * symbol at a time, so it always closes whichever candidateId is currently open for that
 * symbol.
 * @param {Array<Object>} alertRows
 * @returns {Map<string,string>} key `symbol|candidateId` -> endedAt (ISO)
 */
export function goodEndedTimesFromAlertLines(alertRows) {
  const events = (alertRows || [])
    .filter((r) => r && (r.kind === 'GOOD' || r.kind === 'GOOD_ENDED') && typeof r.symbol === 'string' && Number.isFinite(Date.parse(r.sentAt)))
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  const open = new Map(); // symbol -> candidateId
  const ended = new Map(); // symbol|candidateId -> endedAt
  for (const r of events) {
    if (r.kind === 'GOOD') {
      if (typeof r.candidateId === 'string' && !open.has(r.symbol)) open.set(r.symbol, r.candidateId);
    } else if (open.has(r.symbol)) {
      ended.set(`${r.symbol}|${open.get(r.symbol)}`, r.sentAt);
      open.delete(r.symbol);
    }
  }
  return ended;
}

/**
 * One GOOD call per symbol+candidateId from stored capture rows, at the first (earliest
 * closedThrough) capture where the recommendation is GOOD - the same event the 10-minute
 * poll used to be the tracker's only source of GOOD calls. Levels come from the matching
 * flagTradePlan (same candidateId), else the flag candidate's own breakout/invalidation/
 * measured target (mirrors score.js's candidateLevels fallback).
 * @param {Array<Object>} rows - data/calls rows (readAllCalls)
 * @returns {Array<Object>} {symbol, candidateId, calledAt, timeframe, direction, entry, stop, tp1, grossRR, netRR, source:'capture'}
 */
export function goodCallsFromCaptureRows(rows) {
  const sorted = [...(rows || [])].filter((r) => r && r.symbol && r.closedThrough)
    .sort((a, b) => Date.parse(a.closedThrough) - Date.parse(b.closedThrough));
  const byKey = new Map();
  for (const row of sorted) {
    const rec = row.flagRecommendation || null;
    if (!rec || rec.class !== 'GOOD' || typeof rec.candidateId !== 'string') continue;
    const key = `${row.symbol}|${rec.candidateId}`;
    if (byKey.has(key)) continue;
    const plan = row.flagTradePlan && row.flagTradePlan.candidateId === rec.candidateId ? row.flagTradePlan : null;
    const cand = rec.candidate && typeof rec.candidate === 'object' ? rec.candidate : null;
    let entry = plan && isFiniteNum(plan.entry) ? plan.entry : null;
    let stop = plan && isFiniteNum(plan.stop) ? plan.stop : null;
    let tp1 = plan && isFiniteNum(plan.tp1) ? plan.tp1 : null;
    const grossRR = plan && isFiniteNum(plan.grossRR) ? plan.grossRR : null;
    const netRR = plan && isFiniteNum(plan.netRR) ? plan.netRR : null;
    if ((entry === null || stop === null || tp1 === null) && cand && isFiniteNum(cand.breakout) && isFiniteNum(cand.invalidation)) {
      const sign = cand.direction === 'long' ? 1 : -1;
      const cEntry = cand.breakout;
      const cStop = cand.invalidation;
      const cTp1 = isFiniteNum(cand.measuredTarget) ? cand.measuredTarget
        : (isFiniteNum(cand.measuredRR) && cand.measuredRR > 0 ? cEntry + sign * cand.measuredRR * Math.abs(cEntry - cStop) : null);
      if (cTp1 !== null) { entry = cEntry; stop = cStop; tp1 = cTp1; }
    }
    byKey.set(key, {
      symbol: row.symbol, candidateId: rec.candidateId, calledAt: row.closedThrough,
      timeframe: (plan && plan.timeframe) || (cand && cand.timeframe) || null,
      direction: (plan && plan.direction) || (cand && cand.direction) || null,
      entry, stop, tp1, grossRR, netRR, source: 'capture'
    });
  }
  return [...byKey.values()];
}

const hasGoodLevels = (o) => isFiniteNum(o && o.entry) && isFiniteNum(o && o.stop) && isFiniteNum(o && o.tp1);

/**
 * Merge alert-sourced GOOD calls with capture-derived ones by symbol+candidateId: the
 * earlier calledAt wins; capture levels are used only when the alert line carried none.
 * One row per symbol+candidateId (no duplicates) - `sources` lists every origin that saw
 * it. When `alertCalls` is empty (the alert log is missing or not yet ingested), every
 * capture call passes through unchanged with `sources: ['capture']`.
 * @param {Array<Object>} alertCalls - goodCallsFromAlertLines output
 * @param {Array<Object>} captureCalls - goodCallsFromCaptureRows output
 * @returns {Array<Object>}
 */
export function mergeGoodCalls(alertCalls, captureCalls) {
  const byKey = new Map();
  for (const c of captureCalls || []) {
    if (!c || !c.symbol || !c.candidateId) continue;
    byKey.set(`${c.symbol}|${c.candidateId}`, { ...c, sources: ['capture'] });
  }
  for (const a of alertCalls || []) {
    if (!a || !a.symbol || !a.candidateId) continue;
    const key = `${a.symbol}|${a.candidateId}`;
    const cap = byKey.get(key);
    if (!cap) { byKey.set(key, { ...a, sources: ['alert-1m'] }); continue; }
    const calledAt = Date.parse(a.calledAt) <= Date.parse(cap.calledAt) ? a.calledAt : cap.calledAt;
    const levels = hasGoodLevels(a)
      ? { entry: a.entry, stop: a.stop, tp1: a.tp1, grossRR: a.grossRR, netRR: a.netRR }
      : { entry: cap.entry, stop: cap.stop, tp1: cap.tp1, grossRR: cap.grossRR, netRR: cap.netRR };
    byKey.set(key, {
      symbol: a.symbol, candidateId: a.candidateId, calledAt,
      timeframe: a.timeframe || cap.timeframe || null,
      direction: a.direction || cap.direction || null,
      ...levels,
      sources: ['alert-1m', 'capture']
    });
  }
  return [...byKey.values()];
}

/** Write one payload's calls and candles into `dataDir`. */
export function ingestPayload(dataDir, payload, capturedAtMs = Date.now()) {
  const rows = recordsFromPayload(payload, capturedAtMs);
  const calls = appendCalls(dataDir, rows);
  const candles = {};
  const byTf = candlesFromPayload(payload);
  for (const tf of CANDLE_TIMEFRAMES) candles[tf] = appendCandles(dataDir, tf, byTf[tf]);
  const walletRow = walletRowFromPayload(payload);
  const wallet = appendWallet(dataDir, walletRow);
  return { symbols: rows.map((r) => r.symbol), closedThrough: payload.closedThrough ?? null, calls, candles, wallet, walletStatus: walletRow ? walletRow.status : null };
}

async function main() {
  const opts = parseArgs();
  const key = process.env.SCALP_CONTEXT_API_KEY;
  if (!key) throw new Error('SCALP_CONTEXT_API_KEY is not set');
  const url = typeof opts.url === 'string' ? opts.url : DEFAULT_URL;

  const res = await fetch(url, {
    // TRACKER_CLIENT_HEADER: the engine skips served-call recording for its own tracker (T3).
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'X-EditTrades-Client': 'tracker' },
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`scalp-context returned HTTP ${res.status}`);
  const payload = await res.json();

  const result = ingestPayload(opts.data, payload);
  if (!opts['no-kraken']) result.kraken1m = await backfillKraken1m(opts.data);
  let journal = 'off';
  const journalBase = opts['no-journal'] ? null : resolveJournalBase(opts);
  if (journalBase) {
    try {
      const j = await pullJournal(opts.data, journalBase);
      journal = `+${j.added} (dup ${j.duplicates}, ${j.days} day file(s))`;
    } catch (err) {
      journal = 'failed';
      console.warn(`[tracker:collect] journal pull failed: ${err.message}`);
    }
  }
  let served = 'off';
  const servedBase = opts['no-served'] ? null : resolveJournalBase(opts);
  if (servedBase) {
    try {
      const s = await pullServed(opts.data, servedBase);
      served = `+${s.added} (dup ${s.duplicates}, ${s.days} day file(s))`;
    } catch (err) {
      served = 'failed';
      console.warn(`[tracker:collect] served pull failed: ${err.message}`);
    }
  }
  let telegram = 'off';
  const telegramBase = opts['no-telegram'] ? null : resolveJournalBase(opts);
  if (telegramBase) {
    try {
      const t = await pullTelegramStatus(opts.data, telegramBase);
      telegram = t ? `cron ${t.cronLastRunAt || 'never'}, ${t.alertsToday} alert(s) on ${t.alertsDay || '-'}` : 'none yet';
    } catch (err) {
      telegram = 'failed';
      console.warn(`[tracker:collect] telegram pull failed: ${err.message}`);
    }
    try {
      const l = await pullTelegramLogs(opts.data, telegramBase);
      telegram += `; sent-alert log +${l.alerts.added} (dup ${l.alerts.duplicates}), transitions +${l.transitions.added} (dup ${l.transitions.duplicates})`;
    } catch (err) {
      telegram += '; logs failed';
      console.warn(`[tracker:collect] telegram log pull failed: ${err.message}`);
    }
  }
  console.log(`[tracker:collect] closedThrough=${result.closedThrough} symbols=${result.symbols.join(',')} `
    + `calls +${result.calls.added} (dup ${result.calls.duplicates}) `
    + `candles 1m +${result.candles['1m']} 5m +${result.candles['5m']} 15m +${result.candles['15m']} `
    + `wallet +${result.wallet} (${result.walletStatus}) journal ${journal} served ${served} telegram ${telegram}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[tracker:collect] ${err.message}`);
    process.exit(1);
  });
}
