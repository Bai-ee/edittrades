#!/usr/bin/env node
/**
 * WP5 (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md, R5 in EXTERNAL_HARNESS_REFERENCES.md):
 * cross-venue OHLCV + perp funding-rate history via direct public REST (no new deps, mirrors the
 * host-fallback / pagination pattern of scripts/research/capture-binance-1m.js and
 * scripts/research/edge/fetch-4h-long.js). Research only; read-only public endpoints, no API keys.
 *
 * OHLCV (spot, for apples-to-apples comparison with the existing var/edge/4h-long Binance SPOT
 * fixture that scripts/research/edge/sma4h-trend.js reads):
 *   - OKX  GET https://www.okx.com/api/v5/market/history-candles  (works from this machine)
 *   - Bybit GET https://api.bybit.com/v5/market/kline              (this machine: 403, CloudFront
 *     country block - same class of restriction as Binance's 451 on api.binance.com; code path is
 *     written and would work from an unblocked host)
 *
 * Perp funding-rate history (BTC/ETH/SOL):
 *   - Bybit       GET  /v5/market/funding/history        (403 here, see above)
 *   - OKX         GET  /api/v5/public/funding-rate-history (works; ~3 months depth only, reported)
 *   - Binance fapi GET /fapi/v1/fundingRate               (451 here, same geo-block as spot)
 *   - Hyperliquid POST /info {type:"fundingHistory"}      (works; hourly, from ~2023-06)
 *
 * Usage:
 *   node scripts/research/edge/fetch-venue.js candles --venue okx --market spot \
 *     --symbols BTC,ETH,SOL --intervals 4h,1d --out var/edge/venues/okx
 *   node scripts/research/edge/fetch-venue.js candles --venue bybit --market spot \
 *     --symbols BTC,ETH,SOL --intervals 4h,1d --out var/edge/venues/bybit
 *   node scripts/research/edge/fetch-venue.js funding --venues bybit,okx,binance,hyperliquid \
 *     --symbols BTC,ETH,SOL --since 2024-09-01T00:00:00Z --out var/edge/venues/funding
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INTERVAL_MS = { '4h': 14_400_000, '1d': 86_400_000 };
const MAX_RETRIES = 5;
const UA = 'Mozilla/5.0 (research harness; scripts/research/edge/fetch-venue.js)';

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
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
function backoffMs(retry) { return Math.min(20_000, 400 * 2 ** retry) + Math.random() * 200; }

async function fetchJson(url, opts = {}) {
  let lastErr = null;
  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) }, method: opts.method || 'GET', body: opts.body, signal: AbortSignal.timeout(20_000) });
      if (res.status === 451 || res.status === 403) {
        return { blocked: true, status: res.status, url };
      }
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); await sleep(backoffMs(retry)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      return { blocked: false, status: res.status, json: await res.json() };
    } catch (err) {
      lastErr = err;
      await sleep(backoffMs(retry));
    }
  }
  throw new Error(`all retries failed for ${url}: ${lastErr?.message || lastErr}`);
}

// ---------------------------------------------------------------------- shared candle helpers (pure, tested)

/** Dedupe by timestamp (last write wins) and sort ascending. */
export function dedupeSortCandles(candles) {
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Drop candles that are not yet closed: either explicitly unconfirmed (OKX `confirm==='0'`) or
 * whose closeTime is after the closed-bar cutoff (defensive, covers venues with no confirm flag).
 */
export function dropUnfinished(candles, closedCutoffMs) {
  return candles.filter((c) => (c.confirm === undefined || c.confirm === '1') && c.closeTime <= closedCutoffMs);
}

/** Same validation shape as fetch-4h-long.js: monotone/unique timestamps, gaps, OHLC bounds. */
export function validateCandles(candles, intervalMs) {
  const issues = [];
  let gapCount = 0, largestGapCandles = 0, largestGapAfter = null;
  const seen = new Set();
  let prevTs = -Infinity;
  for (const c of candles) {
    if (seen.has(c.timestamp)) issues.push(`duplicate timestamp ${c.timestamp}`);
    seen.add(c.timestamp);
    if (c.timestamp <= prevTs) issues.push(`non-monotone timestamp at ${c.timestamp} (prev ${prevTs})`);
    const diff = c.timestamp - prevTs;
    if (prevTs !== -Infinity && diff > intervalMs) {
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

// ---------------------------------------------------------------------- OKX

const OKX_SPOT = { BTC: 'BTC-USDT', ETH: 'ETH-USDT', SOL: 'SOL-USDT' };
const OKX_SWAP = { BTC: 'BTC-USDT-SWAP', ETH: 'ETH-USDT-SWAP', SOL: 'SOL-USDT-SWAP' };
const OKX_BAR = { '4h': '4H', '1d': '1Dutc' }; // 4H is already UTC-aligned on OKX; 1D defaults to UTC+8, so use the "utc" variant

/** OKX history-candles row -> our candle shape. row[8] ("confirm"): "0" = still forming, "1" = closed. */
export function okxRowToCandle(row, intervalMs) {
  const timestamp = Number(row[0]);
  return { timestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closeTime: timestamp + intervalMs, confirm: row[8] };
}

async function fetchOkxCandlePage(instId, bar, afterTs) {
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100${afterTs ? `&after=${afterTs}` : ''}`;
  const r = await fetchJson(url);
  if (r.blocked) return { blocked: true, status: r.status };
  if (r.json.code !== '0') throw new Error(`okx history-candles error ${r.json.code}: ${r.json.msg}`);
  return { blocked: false, rows: r.json.data };
}

/** Paginate OKX history-candles backward from now to the venue's earliest available bar. */
export async function fetchOkxCandles(instId, interval, delayMs = 200, maxPages = 2000) {
  const bar = OKX_BAR[interval];
  const intervalMs = INTERVAL_MS[interval];
  let cursor = null;
  const raw = [];
  let calls = 0;
  for (; calls < maxPages; calls += 1) {
    const page = await fetchOkxCandlePage(instId, bar, cursor);
    if (page.blocked) return { candles: [], calls, blocked: true, status: page.status };
    if (!page.rows.length) break;
    for (const row of page.rows) raw.push(okxRowToCandle(row, intervalMs));
    cursor = page.rows[page.rows.length - 1][0];
    if (page.rows.length < 100) break; // short page = reached the venue's earliest bar
    await sleep(delayMs);
  }
  return { candles: raw, calls, blocked: false };
}

async function fetchOkxFundingPage(instId, afterTs) {
  const url = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${instId}&limit=100${afterTs ? `&after=${afterTs}` : ''}`;
  const r = await fetchJson(url);
  if (r.blocked) return { blocked: true, status: r.status };
  if (r.json.code !== '0') throw new Error(`okx funding-rate-history error ${r.json.code}: ${r.json.msg}`);
  return { blocked: false, rows: r.json.data };
}

/** Paginate OKX funding-rate-history backward. Depth is venue-limited (~3 months); reported, not assumed. */
export async function fetchOkxFunding(instId, delayMs = 200, maxPages = 100) {
  let cursor = null;
  const raw = [];
  let calls = 0;
  for (; calls < maxPages; calls += 1) {
    const page = await fetchOkxFundingPage(instId, cursor);
    if (page.blocked) return { events: [], calls, blocked: true, status: page.status };
    if (!page.rows.length) break;
    for (const row of page.rows) raw.push({ time: Number(row.fundingTime), rate: Number(row.fundingRate) });
    cursor = page.rows[page.rows.length - 1].fundingTime;
    if (page.rows.length < 100) break;
    await sleep(delayMs);
  }
  return { events: raw, calls, blocked: false };
}

// ---------------------------------------------------------------------- Bybit (403 CloudFront country block
// on this machine, same class of restriction as Binance's 451 on api.binance.com - code path kept correct
// for a host where it isn't blocked; see the report for what was actually observed here).

const BYBIT_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const BYBIT_INTERVAL = { '4h': '240', '1d': 'D' };

export function bybitRowToCandle(row, intervalMs) {
  const timestamp = Number(row[0]);
  return { timestamp, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]), closeTime: timestamp + intervalMs };
}

async function fetchBybitCandlePage(category, symbol, interval, startMs, endMs) {
  const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&start=${startMs}&end=${endMs}&limit=1000`;
  const r = await fetchJson(url);
  if (r.blocked) return { blocked: true, status: r.status };
  if (r.json.retCode !== 0) throw new Error(`bybit kline error ${r.json.retCode}: ${r.json.retMsg}`);
  return { blocked: false, rows: r.json.result.list }; // descending, [start, open, high, low, close, volume, turnover]
}

/** Paginate Bybit kline forward from startMs to nowMs (Bybit returns each page newest-first). */
export async function fetchBybitCandles(category, symbol, interval, startMs, nowMs, delayMs = 200) {
  const intervalMs = INTERVAL_MS[interval];
  const closedCutoffMs = Math.floor(nowMs / intervalMs) * intervalMs;
  const raw = [];
  let cursor = startMs;
  let calls = 0;
  while (cursor < closedCutoffMs) {
    const endTime = Math.min(cursor + 999 * intervalMs, closedCutoffMs - 1);
    const page = await fetchBybitCandlePage(category, symbol, BYBIT_INTERVAL[interval] || interval, cursor, endTime);
    calls += 1;
    if (page.blocked) return { candles: [], calls, blocked: true, status: page.status };
    if (!page.rows.length) break;
    for (const row of page.rows) raw.push(bybitRowToCandle(row, intervalMs));
    const oldestOpenAsc = Math.min(...page.rows.map((r) => Number(r[0])));
    const nextCursor = oldestOpenAsc + intervalMs === cursor ? cursor + intervalMs : Math.max(...page.rows.map((r) => Number(r[0]))) + intervalMs;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
    await sleep(delayMs);
  }
  return { candles: raw, calls, blocked: false };
}

async function fetchBybitFundingPage(symbol, startMs, endMs) {
  const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${startMs}&endTime=${endMs}&limit=200`;
  const r = await fetchJson(url);
  if (r.blocked) return { blocked: true, status: r.status };
  if (r.json.retCode !== 0) throw new Error(`bybit funding error ${r.json.retCode}: ${r.json.retMsg}`);
  return { blocked: false, rows: r.json.result.list }; // [{symbol, fundingRate, fundingRateTimestamp}]
}

export async function fetchBybitFunding(symbol, startMs, nowMs, delayMs = 200) {
  const raw = [];
  let cursor = startMs;
  let calls = 0;
  const stepMs = 200 * 8 * 3_600_000; // 200 events * 8h/event, bybit linear funds every 8h
  while (cursor < nowMs) {
    const endTime = Math.min(cursor + stepMs, nowMs);
    const page = await fetchBybitFundingPage(symbol, cursor, endTime);
    calls += 1;
    if (page.blocked) return { events: [], calls, blocked: true, status: page.status };
    for (const row of page.rows) raw.push({ time: Number(row.fundingRateTimestamp), rate: Number(row.fundingRate) });
    cursor = endTime + 1;
    await sleep(delayMs);
  }
  return { events: raw, calls, blocked: false };
}

// ---------------------------------------------------------------------- Binance fapi funding (451 here)

const BINANCE_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };

async function fetchBinanceFapiFundingPage(symbol, startMs, endMs) {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const r = await fetchJson(url);
  if (r.blocked) return { blocked: true, status: r.status };
  return { blocked: false, rows: r.json }; // ascending [{symbol, fundingRate, fundingTime}]
}

export async function fetchBinanceFapiFunding(symbol, startMs, nowMs, delayMs = 200) {
  const raw = [];
  let cursor = startMs;
  let calls = 0;
  const stepMs = 1000 * 8 * 3_600_000;
  while (cursor < nowMs) {
    const endTime = Math.min(cursor + stepMs, nowMs);
    const page = await fetchBinanceFapiFundingPage(symbol, cursor, endTime);
    calls += 1;
    if (page.blocked) return { events: [], calls, blocked: true, status: page.status };
    if (!page.rows.length) { cursor = endTime + 1; await sleep(delayMs); continue; }
    for (const row of page.rows) raw.push({ time: Number(row.fundingTime), rate: Number(row.fundingRate) });
    cursor = endTime + 1;
    await sleep(delayMs);
  }
  return { events: raw, calls, blocked: false };
}

// ---------------------------------------------------------------------- Hyperliquid funding (hourly, from ~2023-06)

export async function fetchHyperliquidFunding(coin, startMs, nowMs, delayMs = 150) {
  const raw = [];
  let cursor = startMs;
  let calls = 0;
  while (cursor < nowMs) {
    const r = await fetchJson('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fundingHistory', coin, startTime: cursor, endTime: nowMs })
    });
    calls += 1;
    if (r.blocked) return { events: [], calls, blocked: true, status: r.status };
    const rows = r.json;
    if (!rows.length) break;
    for (const row of rows) raw.push({ time: Number(row.time), rate: Number(row.fundingRate) });
    const lastT = rows[rows.length - 1].time;
    if (lastT + 1 <= cursor) break;
    cursor = lastT + 1;
    if (rows.length < 500) break; // short page = caught up to now
    await sleep(delayMs);
  }
  return { events: raw, calls, blocked: false };
}

// ---------------------------------------------------------------------- shared funding math (pure, tested)

/** Dedupe funding events by (time) and sort ascending. */
export function mergeFundingEvents(events) {
  const byT = new Map();
  for (const e of events) byT.set(e.time, e);
  return [...byT.values()].sort((a, b) => a.time - b.time);
}

/**
 * Sum funding paid/received over one trade's hold window [entryMs, exitMs).
 * A long PAYS when rate > 0 (cost), a short RECEIVES when rate > 0 (rebate) - i.e. short cost = -sum(rate).
 * Convention: an event exactly at entryMs is included (you already hold going into it); an event
 * exactly at exitMs is NOT (you've already closed by then). Returned in the same "percent of notional"
 * units the rest of the harness uses (breakeven.js, lib.js netR): rate 0.0001 (0.01%) -> 0.01.
 */
export function sumFundingOverHold(events, entryMs, exitMs, dir) {
  let sumRate = 0, count = 0;
  for (const e of events) {
    if (e.time >= entryMs && e.time < exitMs) { sumRate += e.rate; count += 1; }
  }
  const pct = (dir === 'short' ? -sumRate : sumRate) * 100;
  return { fundingPct: pct, count };
}

// ---------------------------------------------------------------------- CLI

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'candles') return runCandles(args);
  if (cmd === 'funding') return runFunding(args);
  console.error('usage: fetch-venue.js candles|funding [--venue(s) ...] [--symbols BTC,ETH,SOL] [--out DIR]');
  process.exit(1);
}

async function runCandles(args) {
  const venue = args.venue || 'okx';
  const market = args.market || 'spot';
  const symbols = (args.symbols ? String(args.symbols).split(',') : ['BTC', 'ETH', 'SOL']).map((s) => s.trim());
  const intervals = (args.intervals ? String(args.intervals).split(',') : ['4h', '1d']);
  const outDir = args.out || `var/edge/venues/${venue}`;
  mkdirSync(outDir, { recursive: true });
  const nowMs = Date.now();
  const manifest = { capturedAt: new Date().toISOString(), venue, market, symbols, intervals, files: {}, runtimeMs: null };
  const t0 = Date.now();

  for (const symbol of symbols) {
    for (const interval of intervals) {
      const intervalMs = INTERVAL_MS[interval];
      const closedCutoffMs = Math.floor(nowMs / intervalMs) * intervalMs;
      let result;
      if (venue === 'okx') {
        const instId = (market === 'perp' ? OKX_SWAP : OKX_SPOT)[symbol];
        console.log(`[fetch-venue] okx ${market} ${symbol} ${interval}: paginating from now...`);
        result = await fetchOkxCandles(instId, interval);
      } else if (venue === 'bybit') {
        const category = market === 'perp' ? 'linear' : 'spot';
        const startMs = Date.parse('2018-01-01T00:00:00Z');
        console.log(`[fetch-venue] bybit ${category} ${symbol} ${interval}: paginating from ${new Date(startMs).toISOString()}...`);
        result = await fetchBybitCandles(category, BYBIT_SYMBOL[symbol], interval, startMs, nowMs);
      } else {
        throw new Error(`unknown venue ${venue}`);
      }
      const file = `${symbol}_${interval}.json`;
      if (result.blocked) {
        manifest.files[file] = { blocked: true, status: result.status, note: `${venue} candles unreachable from this host (HTTP ${result.status})` };
        console.log(`[fetch-venue] ${venue} ${symbol} ${interval}: BLOCKED (HTTP ${result.status})`);
        continue;
      }
      const finished = dropUnfinished(dedupeSortCandles(result.candles), closedCutoffMs);
      const v = validateCandles(finished, intervalMs);
      const body = JSON.stringify({ symbol, timeframe: interval, provider: venue, market, capturedAt: new Date().toISOString(), candles: finished }, null, 2);
      writeFileSync(path.join(outDir, file), body);
      manifest.files[file] = {
        count: finished.length,
        from: finished.length ? new Date(finished[0].timestamp).toISOString() : null,
        closedThrough: finished.length ? new Date(finished[finished.length - 1].closeTime).toISOString() : null,
        calls: result.calls,
        gapCount: v.gapCount, largestGapCandles: v.largestGapCandles, largestGapAfter: v.largestGapAfter,
        validationOk: v.ok, validationIssueCount: v.issueCount, validationIssuesSample: v.issues,
        sha256: sha256(body)
      };
      console.log(`[fetch-venue] ${venue} ${symbol} ${interval}: ${finished.length} candles, ${result.calls} calls, ${v.gapCount} gaps, ok=${v.ok}`);
    }
  }
  manifest.runtimeMs = Date.now() - t0;
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[fetch-venue] done in ${manifest.runtimeMs}ms -> ${outDir}/manifest.json`);
}

async function runFunding(args) {
  const venues = (args.venues ? String(args.venues).split(',') : ['bybit', 'okx', 'binance', 'hyperliquid']).map((s) => s.trim());
  const symbols = (args.symbols ? String(args.symbols).split(',') : ['BTC', 'ETH', 'SOL']).map((s) => s.trim());
  const sinceMs = Date.parse(args.since || '2023-01-01T00:00:00Z');
  const outDir = args.out || 'var/edge/venues/funding';
  mkdirSync(outDir, { recursive: true });
  const nowMs = Date.now();
  const manifest = { capturedAt: new Date().toISOString(), venues, symbols, since: new Date(sinceMs).toISOString(), files: {}, runtimeMs: null };
  const t0 = Date.now();

  for (const venue of venues) {
    for (const symbol of symbols) {
      console.log(`[fetch-venue] funding ${venue} ${symbol}: fetching...`);
      let result;
      if (venue === 'okx') result = await fetchOkxFunding(OKX_SWAP[symbol]);
      else if (venue === 'bybit') result = await fetchBybitFunding(BYBIT_SYMBOL[symbol], sinceMs, nowMs);
      else if (venue === 'binance') result = await fetchBinanceFapiFunding(BINANCE_SYMBOL[symbol], sinceMs, nowMs);
      else if (venue === 'hyperliquid') result = await fetchHyperliquidFunding(symbol, sinceMs, nowMs);
      else throw new Error(`unknown funding venue ${venue}`);

      const file = `${venue}_${symbol}.json`;
      if (result.blocked) {
        manifest.files[file] = { blocked: true, status: result.status, note: `${venue} funding unreachable from this host (HTTP ${result.status})` };
        console.log(`[fetch-venue] funding ${venue} ${symbol}: BLOCKED (HTTP ${result.status})`);
        continue;
      }
      const events = mergeFundingEvents(result.events);
      const body = JSON.stringify({ venue, symbol, capturedAt: new Date().toISOString(), events }, null, 2);
      writeFileSync(path.join(outDir, file), body);
      manifest.files[file] = {
        count: events.length,
        from: events.length ? new Date(events[0].time).toISOString() : null,
        to: events.length ? new Date(events[events.length - 1].time).toISOString() : null,
        calls: result.calls,
        sha256: sha256(body)
      };
      console.log(`[fetch-venue] funding ${venue} ${symbol}: ${events.length} events, ${result.calls} calls, ${manifest.files[file].from} -> ${manifest.files[file].to}`);
    }
  }
  manifest.runtimeMs = Date.now() - t0;
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[fetch-venue] done in ${manifest.runtimeMs}ms -> ${outDir}/manifest.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`[fetch-venue] ${err.stack || err.message}`); process.exit(1); });
}

export default {
  dedupeSortCandles, dropUnfinished, validateCandles,
  okxRowToCandle, fetchOkxCandles, fetchOkxFunding,
  bybitRowToCandle, fetchBybitCandles, fetchBybitFunding,
  fetchBinanceFapiFunding, fetchHyperliquidFunding,
  mergeFundingEvents, sumFundingOverHold
};
