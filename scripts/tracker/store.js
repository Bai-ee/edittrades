/**
 * EditTrades call tracker - file store (T1, docs/PLAN_CALL_TRACKER.md).
 *
 * Append-only JSONL under a data dir:
 *   calls/YYYY-MM-DD.jsonl   one line per symbol per capture (UTC day of closedThrough)
 *   candles/<tf>.jsonl       closed candles {symbol,t,o,h,l,c,v}, keyed by symbol+t
 *   outcomes.jsonl           one line per scored call (rewritten by score.js)
 *   aggregates.json          derived numbers (rewritten by aggregate.js)
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
