#!/usr/bin/env node
/**
 * S1 agent H (docs/PROMPT_S1_EDGE_SEARCH.md "H - long 1-minute history"): pulls 1-minute
 * BTC/SOL/ETH candles from Binance's public klines endpoint, paginated forward from a
 * start date to now, and writes them in the same file shape the rest of the replay
 * tooling already reads (`scripts/replay.js` `loadHistoryDir` / `readHistoryFile`):
 *
 *   { symbol, timeframe, provider, capturedAt, candles: [{ timestamp, open, high, low,
 *     close, volume, closeTime }] }
 *
 * `closeTime` follows this repo's own convention (`scripts/replay.js` `closeTimeOf`:
 * `candle.timestamp + INTERVAL_MS[tf]`), i.e. the open time of the NEXT candle - not
 * Binance's own close-time field (open + 59999 ms), so a candle reads "closed" at the
 * same instant every other fixture and the production pipeline already agree on.
 *
 * No API key. Two public hosts are tried in order per call, cached once one works for
 * the rest of the run (api.binance.com 451-blocks some regions; data-api.binance.vision
 * is the unrestricted market-data mirror):
 *   - https://api.binance.com/api/v3/klines
 *   - https://data-api.binance.vision/api/v3/klines
 *
 * 5m/15m/1h/4h are DERIVED from the captured 1m (production's own
 * `services/marketData.js` `aggregateToBuckets` - UTC-epoch-aligned buckets, incomplete
 * trailing/leading buckets dropped), not copied from `deep60-2026-09-24`: deep60's own
 * 5m/15m/1h/4h files only span its own ~85.5-day capture window, and `loadHistoryDir`
 * requires every `NATIVE_TIMEFRAMES` file to exist with enough history for
 * `replay.minComputeCandles` warmup - copying deep60's short files verbatim silently
 * bounded every downstream replay (`replay.js`/`replay-rules.js`/`swing/run.js`) to that
 * same ~85-day window, defeating the point of a 2-year fixture. 1d is still copied
 * verbatim from deep60 (Kraken) - it already spans the full 2024-10-05+ window natively.
 *
 * Usage:
 *   node scripts/research/capture-binance-1m.js [--symbols BTC,SOL,ETH]
 *     [--start 2024-10-01T00:00:00Z] [--out test/fixtures/history/deep2y-2026-09-26]
 *     [--delay-ms 150]
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateToBuckets } from '../../services/marketData.js';

const HOSTS = ['https://api.binance.com/api/v3', 'https://data-api.binance.vision/api/v3'];
const SYMBOL_MAP = { BTC: 'BTCUSDT', SOL: 'SOLUSDT', ETH: 'ETHUSDT' };
const LIMIT = 1000;
const INTERVAL_MS_1M = 60_000;
const MAX_RETRIES = 6;
const DERIVED_TF_MS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000, '4h': 4 * 60 * 60_000 };

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let workingHostIdx = 0;

/** Fetch one page of klines, trying hosts in order, retrying transient failures with backoff. */
async function fetchKlinesPage(symbol, startTimeMs, endTimeMs) {
  let lastErr = null;
  for (let hostAttempt = 0; hostAttempt < HOSTS.length; hostAttempt += 1) {
    const hostIdx = (workingHostIdx + hostAttempt) % HOSTS.length;
    const host = HOSTS[hostIdx];
    for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
      try {
        const url = `${host}/klines?symbol=${symbol}&interval=1m&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=${LIMIT}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (res.status === 451 || res.status === 403) {
          // Geo/permission block - not transient, try next host immediately.
          lastErr = new Error(`${host} -> HTTP ${res.status}`);
          break;
        }
        if (res.status === 429 || res.status >= 500) {
          const backoffMs = Math.min(30_000, 500 * 2 ** retry) + Math.random() * 250;
          lastErr = new Error(`${host} -> HTTP ${res.status}`);
          await sleep(backoffMs);
          continue;
        }
        if (!res.ok) {
          throw new Error(`${host} -> HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        }
        const rows = await res.json();
        workingHostIdx = hostIdx; // remember what worked
        return rows;
      } catch (err) {
        lastErr = err;
        const backoffMs = Math.min(30_000, 500 * 2 ** retry) + Math.random() * 250;
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(`all hosts failed for ${symbol} startTime=${startTimeMs}: ${lastErr?.message || lastErr}`);
}

/** Binance kline row -> this repo's candle shape (closeTime = timestamp + 60_000, repo convention). */
function toCandle(row) {
  const timestamp = row[0];
  return {
    timestamp,
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    closeTime: timestamp + INTERVAL_MS_1M
  };
}

/** Paginate forward from startMs to nowMs (exclusive of the still-forming last minute). */
async function captureSymbol(symbol, startMs, nowMs, delayMs, onPage) {
  const binanceSymbol = SYMBOL_MAP[symbol];
  if (!binanceSymbol) throw new Error(`unknown symbol ${symbol}`);
  const closedCutoffMs = Math.floor(nowMs / INTERVAL_MS_1M) * INTERVAL_MS_1M; // exclude the forming candle
  const candles = [];
  let cursor = startMs;
  let calls = 0;
  while (cursor < closedCutoffMs) {
    const endTime = Math.min(cursor + (LIMIT - 1) * INTERVAL_MS_1M, closedCutoffMs - 1);
    const rows = await fetchKlinesPage(binanceSymbol, cursor, endTime);
    calls += 1;
    if (!rows.length) break;
    for (const row of rows) {
      const c = toCandle(row);
      if (c.timestamp < closedCutoffMs) candles.push(c);
    }
    const last = rows[rows.length - 1];
    const lastOpenTime = last[0];
    const nextCursor = lastOpenTime + INTERVAL_MS_1M;
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

function findGaps(candles, stepMs) {
  const gaps = [];
  for (let i = 1; i < candles.length; i += 1) {
    const diff = candles[i].timestamp - candles[i - 1].timestamp;
    if (diff > stepMs) {
      gaps.push({ afterTimestamp: candles[i - 1].timestamp, beforeTimestamp: candles[i].timestamp, missingCandles: Math.round(diff / stepMs) - 1 });
    }
  }
  return gaps;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Overlap validation: Binance 1m vs deep60's Kraken-derived 1m, close-to-close, by shared timestamp. */
function compareOverlap(binanceCandles, krakenCandles) {
  const krakenByTs = new Map(krakenCandles.map((c) => [c.timestamp, c]));
  const diffs = [];
  let matched = 0;
  for (const b of binanceCandles) {
    const k = krakenByTs.get(b.timestamp);
    if (!k) continue;
    matched += 1;
    if (k.close > 0) diffs.push(Math.abs(b.close - k.close) / k.close * 100);
  }
  return {
    matchedTimestamps: matched,
    medianAbsDiffPct: diffs.length ? Number(median(diffs).toFixed(6)) : null,
    meanAbsDiffPct: diffs.length ? Number((diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(6)) : null,
    maxAbsDiffPct: diffs.length ? Number(Math.max(...diffs).toFixed(6)) : null,
    p95AbsDiffPct: diffs.length ? Number(([...diffs].sort((a, b) => a - b)[Math.floor(diffs.length * 0.95)]).toFixed(6)) : null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbols = (args.symbols ? String(args.symbols).split(',') : ['BTC', 'SOL', 'ETH']).map((s) => s.trim());
  const startMs = Date.parse(args.start || '2024-10-01T00:00:00Z');
  const nowMs = Date.now();
  const delayMs = args['delay-ms'] ? Number(args['delay-ms']) : 150;
  const outDir = args.out || 'test/fixtures/history/deep2y-2026-09-26';
  const deep60Dir = args.deep60 || 'test/fixtures/history/deep60-2026-09-24';

  mkdirSync(outDir, { recursive: true });

  const manifest = {
    capturedAt: new Date().toISOString(),
    provider: 'binance (1m native; 5m/15m/1h/4h derived from 1m via services/marketData.js aggregateToBuckets) + kraken (1d, copied verbatim from deep60-2026-09-24)',
    symbols,
    timeframes: ['1m', '5m', '15m', '1h', '4h', '1d'],
    startRequested: new Date(startMs).toISOString(),
    files: {},
    validation: { overlapWindow: null, bySymbol: {} },
    runtimeMs: null
  };

  const t0 = Date.now();

  for (const symbol of symbols) {
    console.log(`[capture] ${symbol}: paginating 1m from ${new Date(startMs).toISOString()}...`);
    const { candles: raw, calls } = await captureSymbol(symbol, startMs, nowMs, delayMs, ({ calls: n, cursor, candleCount }) => {
      if (n % 50 === 0) console.log(`[capture] ${symbol}: call #${n}, cursor=${new Date(cursor).toISOString()}, candles so far=${candleCount}`);
    });
    const candles = dedupeSort(raw);
    const gaps = findGaps(candles, INTERVAL_MS_1M);
    const file = `${symbol}_1m.json`;
    writeFileSync(path.join(outDir, file), JSON.stringify({ symbol, timeframe: '1m', provider: 'binance', capturedAt: new Date().toISOString(), candles }, null, 2));
    manifest.files[file] = {
      count: candles.length,
      from: candles.length ? new Date(candles[0].timestamp).toISOString() : null,
      closedThrough: candles.length ? new Date(candles[candles.length - 1].closeTime).toISOString() : null,
      calls,
      gapCount: gaps.length,
      gapsSampled: gaps.slice(0, 10)
    };
    console.log(`[capture] ${symbol}: ${candles.length} candles, ${calls} calls, ${gaps.length} gaps`);

    // Validate against deep60's Kraken-derived 1m over the overlap window.
    const deep60File = path.join(deep60Dir, `${symbol}_1m.json`);
    let overlapStart = null;
    let overlapEnd = null;
    if (existsSync(deep60File)) {
      const deep60Data = JSON.parse(readFileSync(deep60File, 'utf8'));
      const krakenCandles = deep60Data.candles || [];
      overlapStart = krakenCandles.length ? krakenCandles[0].timestamp : null;
      overlapEnd = krakenCandles.length ? krakenCandles[krakenCandles.length - 1].timestamp : null;
      const overlapBinance = overlapStart != null ? candles.filter((c) => c.timestamp >= overlapStart && c.timestamp <= overlapEnd) : [];
      const cmp = compareOverlap(overlapBinance, krakenCandles);
      manifest.validation.bySymbol[symbol] = {
        '1m': {
          overlapFrom: overlapStart != null ? new Date(overlapStart).toISOString() : null,
          overlapTo: overlapEnd != null ? new Date(overlapEnd).toISOString() : null,
          krakenCandleCount: krakenCandles.length,
          binanceCandidatesInWindow: overlapBinance.length,
          ...cmp
        }
      };
      if (!manifest.validation.overlapWindow && overlapStart != null) {
        manifest.validation.overlapWindow = { from: new Date(overlapStart).toISOString(), to: new Date(overlapEnd).toISOString() };
      }
      console.log(`[capture] ${symbol}: overlap matched=${cmp.matchedTimestamps} medianAbsDiffPct=${cmp.medianAbsDiffPct}`);
    } else {
      manifest.validation.bySymbol[symbol] = {};
      console.log(`[capture] ${symbol}: no deep60 1m file found at ${deep60File}, skipping overlap validation`);
    }

    // Derive 5m/15m/1h/4h from the full 2-year 1m series (production's own bucketing),
    // so higher timeframes cover the same span as 1m instead of deep60's short window.
    for (const [tf, bucketMs] of Object.entries(DERIVED_TF_MS)) {
      const derived = aggregateToBuckets(candles, INTERVAL_MS_1M, bucketMs);
      const file = `${symbol}_${tf}.json`;
      writeFileSync(path.join(outDir, file), JSON.stringify({ symbol, timeframe: tf, provider: 'binance (derived from 1m)', capturedAt: new Date().toISOString(), candles: derived }, null, 2));
      manifest.files[file] = {
        count: derived.length,
        from: derived.length ? new Date(derived[0].timestamp).toISOString() : null,
        closedThrough: derived.length ? new Date(derived[derived.length - 1].closeTime).toISOString() : null,
        derivedFrom1m: true
      };
      console.log(`[capture] ${symbol}: derived ${tf} -> ${derived.length} candles`);

      // Validate against deep60's Kraken-native version of this tf over its overlap window.
      const deep60TfFile = path.join(deep60Dir, `${symbol}_${tf}.json`);
      if (existsSync(deep60TfFile)) {
        const deep60TfData = JSON.parse(readFileSync(deep60TfFile, 'utf8'));
        const krakenTfCandles = deep60TfData.candles || [];
        const tfOverlapStart = krakenTfCandles.length ? krakenTfCandles[0].timestamp : null;
        const tfOverlapEnd = krakenTfCandles.length ? krakenTfCandles[krakenTfCandles.length - 1].timestamp : null;
        const derivedInWindow = tfOverlapStart != null ? derived.filter((c) => c.timestamp >= tfOverlapStart && c.timestamp <= tfOverlapEnd) : [];
        const cmp = compareOverlap(derivedInWindow, krakenTfCandles);
        manifest.validation.bySymbol[symbol][tf] = {
          overlapFrom: tfOverlapStart != null ? new Date(tfOverlapStart).toISOString() : null,
          overlapTo: tfOverlapEnd != null ? new Date(tfOverlapEnd).toISOString() : null,
          krakenCandleCount: krakenTfCandles.length,
          derivedCandidatesInWindow: derivedInWindow.length,
          ...cmp
        };
        console.log(`[capture] ${symbol}: ${tf} overlap matched=${cmp.matchedTimestamps} medianAbsDiffPct=${cmp.medianAbsDiffPct}`);
      } else {
        console.log(`[capture] ${symbol}: no deep60 ${tf} file found at ${deep60TfFile}, skipping ${tf} overlap validation`);
      }
    }
  }

  // 1d is copied verbatim from deep60 (Kraken) - it already spans the full 2024-10-05+
  // window natively, no derivation needed.
  for (const symbol of symbols) {
    const tf = '1d';
    const src = path.join(deep60Dir, `${symbol}_${tf}.json`);
    const dst = path.join(outDir, `${symbol}_${tf}.json`);
    if (!existsSync(src)) {
      console.log(`[capture] skip copy ${symbol}_${tf}.json: source missing`);
      continue;
    }
    copyFileSync(src, dst);
    const data = JSON.parse(readFileSync(dst, 'utf8'));
    const c = data.candles || [];
    manifest.files[`${symbol}_${tf}.json`] = {
      count: c.length,
      from: c.length ? new Date(c[0].timestamp).toISOString() : null,
      closedThrough: c.length ? new Date(c[c.length - 1].closeTime ?? c[c.length - 1].timestamp).toISOString() : null,
      derivedFrom1m: false,
      source: `copied from ${deep60Dir}/${symbol}_${tf}.json (kraken)`
    };
  }

  manifest.runtimeMs = Date.now() - t0;
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[capture] done in ${manifest.runtimeMs}ms. manifest -> ${path.join(outDir, 'manifest.json')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[capture-binance-1m] ${err.stack || err.message}`);
    process.exit(1);
  });
}

export default { captureSymbol, toCandle, compareOverlap, dedupeSort, findGaps };
