/**
 * EditTrades call tracker - file store (T1, docs/PLAN_CALL_TRACKER.md).
 *
 * Append-only JSONL under a data dir:
 *   calls/YYYY-MM-DD.jsonl   one line per symbol per capture (UTC day of closedThrough);
 *                            `source` 'cron' (this job) or 'served' (a call the GPT was
 *                            served, T3); rows written before T3 read as 'cron'
 *   candles/<tf>.jsonl       closed candles {symbol,t,o,h,l,c,v}, keyed by symbol+t
 *   outcomes.jsonl           one line per scored call (rewritten by score.js)
 *   wallet.jsonl             one whitelisted wallet-value sample per capture, keyed by t
 *                            (collect.js walletRowFromPayload; never the address or holdings)
 *   aggregates.json          derived numbers (rewritten by aggregate.js)
 *   journal/YYYY-MM-DD.jsonl the owner's trade journal (T2), pulled from the journal API's
 *                            Blob store by collect.js, one record per id (UTC day of receivedAt)
 *   journal-outcomes.jsonl   one line per scored journal `open` record (rewritten by score.js)
 *   telegram-alerts/YYYY-MM-DD.jsonl  one line per Telegram alert the cron sent (UTC day of
 *                            sentAt), pulled from Blob telegram/alerts/ by collect.js, keyed by id
 *   transitions/YYYY-MM-DD.jsonl      one line per engine candidate state / plan-status change
 *                            (UTC day of at), from Blob telegram/transitions/, keyed by candidateId+at
 *   alert-outcomes.jsonl     one line per sent alert joined to later transitions and scored
 *                            calls (rewritten by score.js)
 *
 * Node >= 20, fs only. No network, no secrets.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const CANDLE_TIMEFRAMES = ['1m', '5m', '15m'];

/** `--data <dir>` (default ./data), `--out <dir>` (default ./docs), plus any other --key value. */
export function parseArgs(argv = process.argv.slice(2)) {
  const opts = { data: './data', out: './docs' };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line is skipped, never fatal */ }
  }
  return out;
}

export function appendJsonl(file, rows) {
  if (!rows.length) return;
  ensureDir(path.dirname(file));
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function writeJsonl(file, rows) {
  ensureDir(path.dirname(file));
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- calls

export function callsDir(dataDir) {
  return path.join(dataDir, 'calls');
}

/** data/calls/YYYY-MM-DD.jsonl for the UTC day of `iso` (falls back to today). */
export function callsFileFor(dataDir, iso) {
  const ms = Date.parse(iso);
  const day = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 10);
  return path.join(callsDir(dataDir), `${day}.jsonl`);
}

export function callKey(row) {
  return `${row.symbol}|${row.closedThrough}`;
}

/** Every stored call row, oldest first (files are day-named, lines are append order). */
export function readAllCalls(dataDir) {
  const dir = callsDir(dataDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const rows = [];
  for (const f of files) rows.push(...readJsonl(path.join(dir, f)));
  for (const row of rows) if (!row.source) row.source = 'cron';
  rows.sort((a, b) => (Date.parse(a.closedThrough) - Date.parse(b.closedThrough)) || String(a.symbol).localeCompare(String(b.symbol)));
  return rows;
}

/**
 * Append call rows, skipping any symbol+closedThrough already stored (a cron that sees
 * the same close twice writes nothing the second time).
 * @returns {{added:number, duplicates:number}}
 */
export function appendCalls(dataDir, rows) {
  const byFile = new Map();
  for (const row of rows) {
    const file = callsFileFor(dataDir, row.closedThrough);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(row);
  }
  let added = 0;
  let duplicates = 0;
  for (const [file, fileRows] of byFile) {
    const seen = new Set(readJsonl(file).map(callKey));
    const fresh = [];
    for (const row of fileRows) {
      const key = callKey(row);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      fresh.push(row);
    }
    appendJsonl(file, fresh);
    added += fresh.length;
  }
  return { added, duplicates };
}

/**
 * Append served-call rows (T3). A row is dropped when a cron row with the same
 * symbol+closedThrough is stored (already tracked) or when a served row with the same
 * `servedKeyOf` key is stored; two served rows at one close are both kept only if their
 * class or plan status differ.
 * @param {string} dataDir
 * @param {Array<Object>} rows - source 'served'
 * @param {(row: Object) => string} servedKeyOf
 * @returns {{added:number, duplicates:number}}
 */
export function appendServedCalls(dataDir, rows, servedKeyOf) {
  const byFile = new Map();
  for (const row of rows) {
    const file = callsFileFor(dataDir, row.closedThrough);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(row);
  }
  let added = 0;
  let duplicates = 0;
  for (const [file, fileRows] of byFile) {
    const existing = readJsonl(file);
    const cron = new Set(existing.filter((r) => r.source !== 'served').map(callKey));
    const served = new Set(existing.filter((r) => r.source === 'served').map(servedKeyOf));
    const fresh = [];
    for (const row of fileRows) {
      const key = servedKeyOf(row);
      if (cron.has(callKey(row)) || served.has(key)) { duplicates++; continue; }
      served.add(key);
      fresh.push(row);
    }
    appendJsonl(file, fresh);
    added += fresh.length;
  }
  return { added, duplicates };
}

// ---------------------------------------------------------------- candles

export function candleFile(dataDir, tf) {
  return path.join(dataDir, 'candles', `${tf}.jsonl`);
}

/**
 * Append closed candles for one timeframe, skipping symbol+t already stored.
 * @param {Array<{symbol:string,t:string,o:number,h:number,l:number,c:number,v:number}>} candles
 * @returns {number} rows added
 */
export function appendCandles(dataDir, tf, candles) {
  const file = candleFile(dataDir, tf);
  const seen = new Set(readJsonl(file).map((c) => `${c.symbol}|${c.t}`));
  const fresh = [];
  for (const c of candles) {
    const key = `${c.symbol}|${c.t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(c);
  }
  fresh.sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || a.symbol.localeCompare(b.symbol));
  appendJsonl(file, fresh);
  return fresh.length;
}

/**
 * Stored candles for one timeframe, as symbol -> ascending walkOutcome candles
 * ({timestamp (open time, ms), open, high, low, close, volume}).
 */
export function readCandles(dataDir, tf) {
  const bySymbol = new Map();
  for (const c of readJsonl(candleFile(dataDir, tf))) {
    const ts = Date.parse(c.t);
    if (!Number.isFinite(ts)) continue;
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, new Map());
    bySymbol.get(c.symbol).set(ts, { timestamp: ts, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v });
  }
  const out = {};
  for (const [symbol, m] of bySymbol) out[symbol] = [...m.values()].sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

// ---------------------------------------------------------------- outcomes

export function outcomesFile(dataDir) {
  return path.join(dataDir, 'outcomes.jsonl');
}

export function aggregatesFile(dataDir) {
  return path.join(dataDir, 'aggregates.json');
}

// ---------------------------------------------------------------- wallet

export function walletFile(dataDir) {
  return path.join(dataDir, 'wallet.jsonl');
}

/**
 * Append one whitelisted wallet sample, skipping a `t` already stored.
 * @returns {number} rows added (0 or 1)
 */
export function appendWallet(dataDir, row) {
  if (!row || !row.t) return 0;
  const file = walletFile(dataDir);
  if (readJsonl(file).some((r) => r.t === row.t)) return 0;
  appendJsonl(file, [row]);
  return 1;
}

/** Stored wallet samples, oldest first. */
export function readWallet(dataDir) {
  return readJsonl(walletFile(dataDir)).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// ---------------------------------------------------------------- Telegram alerts (T-1)

/** Whitelisted Telegram alert status pulled from Blob telegram/state.json (collect.js). */
export function telegramStatusFile(dataDir) {
  return path.join(dataDir, 'telegram-status.json');
}

// ---------------------------------------------------------------- journal (T2)

export function journalDir(dataDir) {
  return path.join(dataDir, 'journal');
}

export function journalOutcomesFile(dataDir) {
  return path.join(dataDir, 'journal-outcomes.jsonl');
}

/** Every stored journal record, oldest first by receivedAt. */
export function readJournal(dataDir) {
  const dir = journalDir(dataDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const rows = [];
  for (const f of files) rows.push(...readJsonl(path.join(dir, f)));
  return rows.sort((a, b) => (Date.parse(a.receivedAt) || 0) - (Date.parse(b.receivedAt) || 0));
}

/**
 * Append journal records into data/journal/<UTC day of receivedAt>.jsonl, skipping any
 * id already stored in any day file.
 * @returns {{added:number, duplicates:number}}
 */
export function appendJournal(dataDir, records) {
  const seen = new Set(readJournal(dataDir).map((r) => r.id));
  const byFile = new Map();
  let duplicates = 0;
  for (const r of records) {
    const ms = Date.parse(r && r.receivedAt);
    if (!r || typeof r.id !== 'string' || !Number.isFinite(ms)) continue;
    if (seen.has(r.id)) { duplicates++; continue; }
    seen.add(r.id);
    const file = path.join(journalDir(dataDir), `${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(r);
  }
  let added = 0;
  for (const [file, rows] of byFile) {
    appendJsonl(file, rows);
    added += rows.length;
  }
  return { added, duplicates };
}

// ---------------------------------------------------------------- Telegram sent alerts + transitions

export function telegramAlertsDir(dataDir) {
  return path.join(dataDir, 'telegram-alerts');
}

export function transitionsDir(dataDir) {
  return path.join(dataDir, 'transitions');
}

export function alertOutcomesFile(dataDir) {
  return path.join(dataDir, 'alert-outcomes.jsonl');
}

export const telegramAlertKey = (r) => r.id;
export const transitionRowKey = (r) => `${r.candidateId}|${r.at}`;

function readDayDir(dir, timeKey) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const rows = [];
  for (const f of files) rows.push(...readJsonl(path.join(dir, f)));
  return rows.sort((a, b) => (Date.parse(a[timeKey]) || 0) - (Date.parse(b[timeKey]) || 0));
}

/** Append rows into <dir>/<UTC day of row[timeKey]>.jsonl, skipping keys already stored in any day file. */
function appendDayDir(dir, rows, timeKey, keyOf) {
  const seen = new Set(readDayDir(dir, timeKey).map(keyOf));
  const byFile = new Map();
  let duplicates = 0;
  for (const r of rows) {
    const ms = Date.parse(r && r[timeKey]);
    if (!r || !Number.isFinite(ms)) continue;
    const key = keyOf(r);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    const file = path.join(dir, `${new Date(ms).toISOString().slice(0, 10)}.jsonl`);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(r);
  }
  let added = 0;
  for (const [file, fileRows] of byFile) {
    appendJsonl(file, fileRows);
    added += fileRows.length;
  }
  return { added, duplicates };
}

/** Every stored sent-alert line, oldest first by sentAt. */
export function readTelegramAlerts(dataDir) {
  return readDayDir(telegramAlertsDir(dataDir), 'sentAt');
}

/** Every stored transition line, oldest first by at. */
export function readTransitions(dataDir) {
  return readDayDir(transitionsDir(dataDir), 'at');
}

/** @returns {{added:number, duplicates:number}} dedupe by id */
export function appendTelegramAlerts(dataDir, rows) {
  return appendDayDir(telegramAlertsDir(dataDir), rows, 'sentAt', telegramAlertKey);
}

/** @returns {{added:number, duplicates:number}} dedupe by candidateId+at */
export function appendTransitions(dataDir, rows) {
  return appendDayDir(transitionsDir(dataDir), rows, 'at', transitionRowKey);
}
