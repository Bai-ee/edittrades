#!/usr/bin/env node
/**
 * Fetches Binance spot klines (native interval, no derivation) for the EXTERNAL_4H_SMA200_V1
 * study (docs/research/EXTERNAL_4H_SMA200_STATUS.md). Default: 4h BTCUSDT/ETHUSDT/SOLUSDT
 * from each symbol's Binance listing to now, written to var/edge/4h-long/{SYM}_4h.json in
 * the same shape as var/edge/daily-long/{SYM}_1d.json:
 *   { symbol, timeframe, provider: "binance", candles: [{timestamp,open,high,low,close,volume,closeTime}] }
 * Same host-fallback pattern as scripts/research/capture-binance-1m.js
 * (api.binance.com -> data-api.binance.vision). No API key.
 *
 * Also used (via --interval 1d --out var/edge/daily-long) to (re)build the daily long-history
 * dataset that scripts/research/edge/spot-trend.js reads, since var/ is not checked in.
 *
 * Usage:
 *   node scripts/research/edge/fetch-4h-long.js [--symbols BTC,ETH,SOL] [--interval 4h]
 *     [--out var/edge/4h-long] [--delay-ms 150]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTS = ['https://api.binance.com/api/v3', 'https://data-api.binance.vision/api/v3'];
const SYMBOL_MAP = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
// Binance listing dates (source of "from" for each symbol's long history).
const DEFAULT_START = { BTC: '2017-08-17T00:00:00Z', ETH: '2017-08-17T00:00:00Z', SOL: '2020-08-11T00:00:00Z' };
const LIMIT = 1000;
const INTERVAL_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const MAX_RETRIES = 6;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let workingHostIdx = 0;

async function fetchKlinesPage(symbol, interval, startTimeMs, endTimeMs) {
  let lastErr = null;
  for (let hostAttempt = 0; hostAttempt < HOSTS.length; hostAttempt += 1) {
    const hostIdx = (workingHostIdx + hostAttempt) % HOSTS.length;
    const host = HOSTS[hostIdx];
    for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
      try {
        const url = `${host}/klines?symbol=${symbol}&interval=${interval}&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=${LIMIT}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (res.status === 451 || res.status === 403) { lastErr = new Error(`${host} -> HTTP ${res.status}`); break; }
        if (res.status === 429 || res.status >= 500) {
          const backoffMs = Math.min(30_000, 500 * 2 ** retry) + Math.random() * 250;
          lastErr = new Error(`${host} -> HTTP ${res.status}`);
          await sleep(backoffMs);
          continue;
        }
        if (!res.ok) throw new Error(`${host} -> HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        const rows = await res.json();
        workingHostIdx = hostIdx;
        return rows;
      } catch (err) {
        lastErr = err;
        const backoffMs = Math.min(30_000, 500 * 2 ** retry) + Math.random() * 250;
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(`all hosts failed for ${symbol} ${interval} startTime=${startTimeMs}: ${lastErr?.message || lastErr}`);
}

function toCandle(row, intervalMs) {
  const timestamp = row[0];
  return { timestamp, open: parseFloat(row[1]), high: parseFloat(row[2]), low: parseFloat(row[3]), close: parseFloat(row[4]), volume: parseFloat(row[5]), closeTime: timestamp + intervalMs };
}

async function captureSymbol(symbol, interval, startMs, nowMs, delayMs, onPage) {
  const binanceSymbol = SYMBOL_MAP[symbol];
  if (!binanceSymbol) throw new Error(`unknown symbol ${symbol}`);
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`unknown interval ${interval}`);
  const closedCutoffMs = Math.floor(nowMs / intervalMs) * intervalMs; // exclude the still-forming candle
  const candles = [];
  let cursor = startMs;
  let calls = 0;
  while (cursor < closedCutoffMs) {
    const endTime = Math.min(cursor + (LIMIT - 1) * intervalMs, closedCutoffMs - 1);
    const rows = await fetchKlinesPage(binanceSymbol, interval, cursor, endTime);
    calls += 1;
    if (!rows.length) break;
    for (const row of rows) {
      const c = toCandle(row, intervalMs);
      if (c.timestamp < closedCutoffMs) candles.push(c);
    }
    const lastOpenTime = rows[rows.length - 1][0];
    const nextCursor = lastOpenTime + intervalMs;
    if (nextCursor <= cursor) break; // safety: no progress
    cursor = nextCursor;
    if (onPage) onPage({ symbol, calls, cursor, candleCount: candles.length });
    await sleep(delayMs);
  }
  return { candles, calls };
}

function dedupeSort(candles) {
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Validate: monotone unique timestamps, gaps (count + largest), finite positive OHLC, high/low envelope. */
function validate(candles, intervalMs) {
  const issues = [];
  let gapCount = 0, largestGapCandles = 0, largestGapAfter = null;
  const seen = new Set();
  let prevTs = -Infinity;
  for (const c of candles) {
    if (seen.has(c.timestamp)) issues.push(`duplicate timestamp ${c.timestamp}`);
    seen.add(c.timestamp);
    if (c.timestamp <= prevTs) issues.push(`non-monotone timestamp at ${c.timestamp} (prev ${prevTs})`);
    const diff = c.timestamp - prevTs;
    if (Number.isFinite(prevTs !== -Infinity ? prevTs : NaN) && prevTs !== -Infinity && diff > intervalMs) {
      const missing = Math.round(diff / intervalMs) - 1;
      gapCount += 1;
      if (missing > largestGapCandles) { largestGapCandles = missing; largestGapAfter = prevTs; }
    }
    prevTs = c.timestamp;
    for (const [k, v] of Object.entries({ open: c.open, high: c.high, low: c.low, close: c.close })) {
      if (!Number.isFinite(v) || v <= 0) issues.push(`non-finite/non-positive ${k} at ${c.timestamp}: ${v}`);
    }
    if (!(c.high >= Math.max(c.open, c.close))) issues.push(`high < max(open,close) at ${c.timestamp}`);
    if (!(c.low <= Math.min(c.open, c.close))) issues.push(`low > min(open,close) at ${c.timestamp}`);
  }
  return { ok: issues.length === 0, issues: issues.slice(0, 20), issueCount: issues.length, gapCount, largestGapCandles, largestGapAfter: largestGapAfter != null ? new Date(largestGapAfter).toISOString() : null };
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbols = (args.symbols ? String(args.symbols).split(',') : ['BTC', 'ETH', 'SOL']).map((s) => s.trim());
  const interval = args.interval || '4h';
  const outDir = args.out || 'var/edge/4h-long';
  const delayMs = args['delay-ms'] ? Number(args['delay-ms']) : 150;
  const nowMs = Date.now();

  mkdirSync(outDir, { recursive: true });

  const manifest = { capturedAt: new Date().toISOString(), provider: 'binance', interval, symbols, files: {}, runtimeMs: null };
  const t0 = Date.now();

  for (const symbol of symbols) {
    const startMs = Date.parse(args[`start-${symbol.toLowerCase()}`] || DEFAULT_START[symbol] || '2017-08-17T00:00:00Z');
    console.log(`[fetch-4h-long] ${symbol} ${interval}: paginating from ${new Date(startMs).toISOString()}...`);
    const { candles: raw, calls } = await captureSymbol(symbol, interval, startMs, nowMs, delayMs, ({ calls: n, cursor, candleCount }) => {
      if (n % 20 === 0) console.log(`[fetch-4h-long] ${symbol}: call #${n}, cursor=${new Date(cursor).toISOString()}, candles so far=${candleCount}`);
    });
    const candles = dedupeSort(raw);
    const v = validate(candles, INTERVAL_MS[interval]);
    const file = `${symbol}_${interval}.json`;
    const body = JSON.stringify({ symbol, timeframe: interval, provider: 'binance', capturedAt: new Date().toISOString(), candles }, null, 2);
    writeFileSync(path.join(outDir, file), body);
    manifest.files[file] = {
      count: candles.length,
      from: candles.length ? new Date(candles[0].timestamp).toISOString() : null,
      closedThrough: candles.length ? new Date(candles[candles.length - 1].closeTime).toISOString() : null,
      calls,
      gapCount: v.gapCount,
      largestGapCandles: v.largestGapCandles,
      largestGapAfter: v.largestGapAfter,
      validationOk: v.ok,
      validationIssueCount: v.issueCount,
      validationIssuesSample: v.issues,
      sha256: sha256(body)
    };
    console.log(`[fetch-4h-long] ${symbol}: ${candles.length} candles, ${calls} calls, ${v.gapCount} gaps (largest ${v.largestGapCandles}), ok=${v.ok}`);
  }

  manifest.runtimeMs = Date.now() - t0;
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[fetch-4h-long] done in ${manifest.runtimeMs}ms. manifest -> ${path.join(outDir, 'manifest.json')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`[fetch-4h-long] ${err.stack || err.message}`); process.exit(1); });
}

export default { captureSymbol, toCandle, validate, dedupeSort };
