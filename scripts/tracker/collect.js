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
 * Usage: node collect.js [--data ./data] [--url <scalp-context url>] [--journal-base <url>] [--no-journal] [--no-served]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, appendCalls, appendServedCalls, appendCandles, appendWallet, appendJournal, readAllCalls, CANDLE_TIMEFRAMES } from './store.js';
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
  console.log(`[tracker:collect] closedThrough=${result.closedThrough} symbols=${result.symbols.join(',')} `
    + `calls +${result.calls.added} (dup ${result.calls.duplicates}) `
    + `candles 1m +${result.candles['1m']} 5m +${result.candles['5m']} 15m +${result.candles['15m']} `
    + `wallet +${result.wallet} (${result.walletStatus}) journal ${journal} served ${served}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[tracker:collect] ${err.message}`);
    process.exit(1);
  });
}
