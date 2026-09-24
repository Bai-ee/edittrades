#!/usr/bin/env node
/**
 * Replay harness (engine refinement plan, phase 10).
 *
 * Runs the production pipeline - `buildScalpContext()` - over stored candle history one
 * close at a time and writes one JSONL line per (close, symbol). Nothing here
 * re-implements a detector, indicator or strategy: the harness only decides which
 * candles the pipeline is allowed to see.
 *
 * No lookahead. At each close `cut`, `fetchCandles` goes through the production
 * `getCandlesWithProvenance()` with `now = cut` and an injected Kraken reader that only
 * holds candles with `closeTime <= cut`. Kraken answers `limit` rows of which the newest
 * is still forming, so the reader answers the `limit - 1` closed rows before the cut:
 * the pipeline sees the same 499 closed candles per timeframe as production, and 3m is
 * derived from 719 closed 1m candles by the production derivation (~239 buckets).
 *
 * Usage:
 *   node scripts/replay.js --capture BTC,SOL,ETH --out test/fixtures/history/<date>/ [--backfill-1m <minutes>]
 *   node scripts/replay.js --history <dir> [--symbols BTC] [--timeframes 1m,3m,...]
 *                          [--from <iso|ms>] [--to <iso|ms>] [--step <n>] [--out <file.jsonl>]
 *
 * History files: `<dir>/<SYMBOL>_<tf>.json`, either the fetch's candle array or an
 * object with a `candles` array (what --capture writes). 3m is never read from a file:
 * production derives it from 1m, so the replay does too.
 *
 * `--step n` emits every n-th close of the clock timeframe (the smallest replayed
 * timeframe; 1m by default). `--step 240` on a 1m clock is one line per 4h.
 *
 * `--backfill-1m <minutes>` extends the 1m capture further back than Kraken's 720-row
 * OHLC window by bucketing Kraken public trades into 1m candles. A 60-minute overlap
 * with the OHLC window is compared candle by candle and the result is written to
 * manifest.json; OHLC rows win wherever both exist. It is resumable: progress is
 * checkpointed to `<out>/<SYMBOL>_1m.backfill.json` and picked back up on a rerun of the
 * same command, and Kraken rate-limit responses (`EAPI:Rate limit exceeded`, HTTP 429)
 * are retried with increasing backoff instead of aborting the run. The checkpoint holds
 * the Kraken Trades `since` cursor plus the completed 1m candles folded so far (not raw
 * trades - trades arrive in chronological pages, so a candle's minute is final the
 * moment a later trade's minute is seen, and only the still-open partial minute plus a
 * `prevClose` gap-fill cursor need to stay live). This keeps a multi-month checkpoint's
 * size proportional to candles (~1 per minute of depth), not trades, of which a single
 * symbol can see millions over a deep backfill. A checkpoint written before this format
 * (a raw `trades` array) is converted to the candle format on load, then resumes as
 * normal - the merged result is identical either way.
 *
 * `--derive-deep` (automatic whenever `--backfill-1m` is used) aggregates the backfilled
 * 1m candles into UTC-aligned 5m/15m/1h candles and prepends them to those timeframes'
 * OHLC rows wherever OHLC doesn't reach that far back (Kraken's 720-row OHLC window is
 * ~30 days for 1h, deeper than 5m/15m but still shallower than a multi-month backfill) -
 * OHLC still wins on overlap, recorded per timeframe in manifest.json the same way as the
 * 1m backfill. 4h/1d are never derived: their 720-row OHLC windows (120 days / ~2 years)
 * already reach past any realistic backfill depth.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONFIG } from '../config/engine.js';
import { buildScalpContext, dropUnclosedCandles, INTERVAL_MS, SYMBOLS, TIMEFRAMES } from '../services/scalpContext.js';
import { getCandlesWithProvenance, DERIVED_INTERVALS, aggregateToBuckets } from '../services/marketData.js';

/** Timeframes read from history files (3m is derived, never stored). */
export const NATIVE_TIMEFRAMES = TIMEFRAMES.filter((tf) => !DERIVED_INTERVALS[tf]);

/** Production requests this many rows per timeframe (FETCH_LIMIT in services/scalpContext.js); used only by --capture. */
const CAPTURE_LIMIT = 720;

/** Kraken pair names for the trade backfill. Mirrors SYMBOL_MAP in services/marketData.js, which is not exported. */
const KRAKEN_PAIRS = { BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD' };

/** Wallet reads never run in a replay: every build sees an unavailable account. */
const REPLAY_ACCOUNT = Object.freeze({ status: 'unavailable', margin: { usd: null, byAsset: {} } });

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function closeTimeOf(candle, tf) {
  return Number.isFinite(candle.closeTime) ? candle.closeTime : candle.timestamp + INTERVAL_MS[tf];
}

/**
 * The newest `count` candles of `candles` that closed at or before `cutMs`.
 * Binary search: history files are sorted ascending by timestamp.
 * @returns {Array<Object>}
 */
export function closedRows(candles, tf, cutMs, count) {
  if (!Array.isArray(candles) || candles.length === 0 || count <= 0) return [];
  let lo = 0;
  let hi = candles.length; // first index whose close is after the cut
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (closeTimeOf(candles[mid], tf) <= cutMs) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(Math.max(0, lo - count), lo);
}

/** Read one history file: a bare candle array or `{ candles }`. Sorted, de-duplicated by timestamp. */
export function readHistoryFile(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const candles = Array.isArray(raw) ? raw : raw && Array.isArray(raw.candles) ? raw.candles : null;
  if (!candles) throw new Error(`${file}: expected a candle array or { candles: [] }`);
  const byTs = new Map();
  for (const c of candles) byTs.set(c.timestamp, c);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Load `<dir>/<SYMBOL>_<tf>.json` for each symbol and native timeframe that exists.
 * @returns {Object} symbol -> tf -> candles
 */
export function loadHistoryDir(dir, symbols) {
  const out = {};
  for (const symbol of symbols) {
    out[symbol] = {};
    for (const tf of NATIVE_TIMEFRAMES) {
      const file = path.join(dir, `${symbol}_${tf}.json`);
      if (existsSync(file)) out[symbol][tf] = readHistoryFile(file);
    }
    if (Object.keys(out[symbol]).length === 0) throw new Error(`no history files for ${symbol} in ${dir}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Truncated fetch into the production pipeline
// ---------------------------------------------------------------------------

/**
 * A `fetchCandles` for buildScalpContext that can only see candles closed by `cutMs`.
 * Routed through the production getCandlesWithProvenance so the 3m derivation and the
 * provenance envelope are production code; only the Kraken HTTP call is replaced.
 *
 * @param {Object} historyByTf - tf -> ascending candles for one symbol
 * @param {number} cutMs
 * @param {Function} [onServe] - (tf, rows) spy, for the no-lookahead test
 */
export function makeReplayFetch(historyByTf, cutMs, onServe = null) {
  const fetchKraken = async (pair, tf, limit) => {
    const rows = closedRows(historyByTf[tf], tf, cutMs, limit - 1);
    if (onServe) onServe(tf, rows);
    if (rows.length === 0) throw new Error(`no replay history for ${tf} at ${new Date(cutMs).toISOString()}`);
    return rows;
  };
  return (pair, interval, limit) => getCandlesWithProvenance(pair, interval, limit, { allowSynthetic: false, fetchKraken, now: cutMs });
}

/** Closed candles the pipeline would receive for `tf` at `cutMs` (production limit 500). */
async function servedCount(historyByTf, tf, cutMs) {
  const env = await makeReplayFetch(historyByTf, cutMs)(null, tf, 500);
  return dropUnclosedCandles(env.candles, tf, cutMs).length;
}

/** Clock: close times of the smallest replayed timeframe (a derived one ticks on its base's bucket boundaries). */
export function clockCloses(historyByTf, timeframes) {
  const clockTf = [...timeframes].sort((a, b) => INTERVAL_MS[a] - INTERVAL_MS[b])[0];
  const derived = DERIVED_INTERVALS[clockTf];
  const source = historyByTf[derived ? derived.base : clockTf] || [];
  const tf = derived ? derived.base : clockTf;
  const closes = source.map((c) => closeTimeOf(c, tf));
  return { clockTf, closes: derived ? closes.filter((t) => t % INTERVAL_MS[clockTf] === 0) : closes };
}

/** Swallow the pipeline's per-build console output; a replay makes hundreds of builds. */
async function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** One production build of one symbol at `cutMs`. */
export function buildAt(symbol, historyByTf, cutMs, timeframes = TIMEFRAMES, onServe = null) {
  return quietly(() => buildScalpContext({
    symbols: [symbol],
    timeframes,
    now: cutMs,
    includeFailed: true, // failed candidates carry failReason, which the metrics read
    slimFailed: false, // metrics track failed candidates by durationCandles (startedAt)
    fetchCandles: makeReplayFetch(historyByTf, cutMs, onServe),
    fetchAccount: async () => REPLAY_ACCOUNT
  }));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Compact per-close record. `candidateLifecycle` and `confluence` are additions to the
 * phase 10 line shape: the metrics need a candidate's identity and failReason, and the
 * REGRESSION_002 replay proof needs the confluence components, neither of which the
 * decisionTrace strings carry. Quick pass Q4 adds the entry/stop/target levels each
 * strategy and confirmed candidate carried at this close (nested additions only - no new
 * top-level key), so scripts/replay-outcomes.js can walk them forward without a second
 * pipeline run.
 */
export function toReplayLine(payload, symbol, cutMs) {
  const s = payload.symbols[symbol];
  const t = s.decisionTrace;
  const setups = s.candidateSetups || [];
  return {
    closedThrough: new Date(cutMs).toISOString(),
    symbol,
    dataStatus: payload.dataStatus,
    strategies: Object.fromEntries(t.strategies.map((x) => {
      const full = s.strategies && s.strategies[x.name];
      return [x.name, {
        valid: x.valid,
        rejectedAt: x.rejectedAt,
        direction: full && full.direction !== 'NO_TRADE' ? full.direction : null,
        entryZone: full ? full.entryZone : null,
        stopLoss: full ? full.stopLoss : null,
        targets: full ? full.targets : null
      }];
    })),
    candidates: setups.map((c) => `${c.timeframe}:${c.direction}:${c.state}:${c.confidence}`),
    candidateLifecycle: setups.map((c) => {
      const tfClose = s.timeframes[c.timeframe] && s.timeframes[c.timeframe].closedThrough;
      const startMs = tfClose && Number.isInteger(c.durationCandles)
        ? Date.parse(tfClose) - c.durationCandles * INTERVAL_MS[c.timeframe]
        : null;
      return {
        ref: `${c.timeframe}:${c.direction}`,
        startedAt: startMs === null ? null : new Date(startMs).toISOString(),
        state: c.state,
        failReason: c.failReason || null,
        breakoutLevel: isFiniteNumber(c.breakoutLevel) ? c.breakoutLevel : null,
        invalidation: isFiniteNumber(c.invalidation) ? c.invalidation : null,
        measuredTarget: isFiniteNumber(c.measuredTarget) ? c.measuredTarget : null
      };
    }),
    geometry: t.geometry,
    confluence: Object.entries(s.geometryContext || {}).flatMap(([tf, g]) => ((g && g.confluenceZones) || [])
      .map((z) => `${tf}:${z.components.join('+')}:${z.distancePct}`)),
    gate: { needsVisualConfirmation: t.needsVisualConfirmation, codes: t.unresolvedGeometry },
    // Signal-reliability minimum plan, work package 3: the exact selected flag trade
    // plan at this close, verbatim (or null) - scripts/replay-outcomes.js walks it
    // forward exactly as published, never a re-derived candidate.
    flagTradePlan: s.flagTradePlan || null
  };
}

function parseTime(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  const ms = Number.isFinite(n) ? n : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`bad time: ${v}`);
  return ms;
}

/**
 * Replay one symbol. Starts at the first close where every replayed timeframe has
 * `replay.minComputeCandles` closed candles, then emits every `step`-th close in
 * [from, to].
 * @returns {Promise<{lines:Array<Object>, clockTf:string, firstEligible:string|null}>}
 */
export async function replaySymbol({ symbol, historyByTf, timeframes = TIMEFRAMES, from = null, to = null, step = 1, onLine = null, onPayload = null }) {
  const { clockTf, closes } = clockCloses(historyByTf, timeframes);
  const min = ENGINE_CONFIG.replay.minComputeCandles;
  let first = -1;
  for (let i = 0; i < closes.length; i++) {
    let ok = true;
    for (const tf of timeframes) {
      if ((await servedCount(historyByTf, tf, closes[i])) < min) { ok = false; break; }
    }
    if (ok) { first = i; break; }
  }
  const lines = [];
  if (first === -1) return { lines, clockTf, firstEligible: null };

  const fromMs = parseTime(from);
  const toMs = parseTime(to);
  const selected = closes.slice(first).filter((t) => (fromMs === null || t >= fromMs) && (toMs === null || t <= toMs));
  for (let i = 0; i < selected.length; i += Math.max(1, step)) {
    const cut = selected[i];
    const payload = await buildAt(symbol, historyByTf, cut, timeframes);
    const line = toReplayLine(payload, symbol, cut);
    if (onPayload) onPayload(payload, line);
    if (onLine) onLine(line);
    lines.push(line);
  }
  return { lines, clockTf, firstEligible: new Date(closes[first]).toISOString() };
}

// ---------------------------------------------------------------------------
// Capture (network: Kraken public endpoints only)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One page of Kraken public Trades, with retry/backoff. Both a Kraken-reported rate
 * limit (`error: ["EAPI:Rate limit exceeded"]` or the older "Too many requests" text)
 * and a plain HTTP 429 are treated as rate limiting and retried with increasing sleep
 * rather than thrown. `fetchImpl`/`retryDelayMs`/`log` are injectable for tests; the
 * defaults (global `fetch`, a capped exponential backoff, `console.error`) are what the
 * CLI uses.
 * @param {string} pair - Kraken pair name, e.g. 'XBTUSD'
 * @param {string} sinceNs - nanosecond cursor
 * @param {Object} [opts]
 * @returns {Promise<{trades: Array, last: string}>}
 */
export async function krakenTrades(pair, sinceNs, opts = {}) {
  const {
    fetchImpl = fetch,
    maxAttempts = 12,
    retryDelayMs = (attempt) => Math.min(30000, 2000 * (attempt + 1)),
    log = () => {}
  } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(`https://api.kraken.com/0/public/Trades?pair=${pair}&since=${sinceNs}`);
    } catch (err) {
      log(`[replay] ${pair} trades fetch error: ${err.message} (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(retryDelayMs(attempt));
      continue;
    }
    let body = null;
    try { body = await res.json(); } catch { /* handled as bad response / rate limit below */ }
    const rateLimited = res.status === 429 || (body && Array.isArray(body.error) && body.error.some((e) => /rate limit|too many requests/i.test(e)));
    if (rateLimited) {
      log(`[replay] ${pair} rate limited (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(retryDelayMs(attempt));
      continue;
    }
    if (!body || !body.result) throw new Error(`Kraken Trades: bad response (status ${res.status})`);
    if (body.error && body.error.length) throw new Error(`Kraken Trades: ${body.error.join(', ')}`);
    const key = Object.keys(body.result).find((k) => k !== 'last');
    return { trades: body.result[key], last: body.result.last };
  }
  throw new Error(`Kraken Trades: rate limited after ${maxAttempts} attempts`);
}

/**
 * Bucket trades into 1m candles over [startMs, endMs). A minute without trades is flat
 * at the previous close, volume 0. `seedPrevClose` lets a resumed backfill continue the
 * gap-fill rule across a checkpoint boundary instead of restarting it at null.
 */
export function tradesTo1m(trades, startMs, endMs, seedPrevClose = null) {
  const step = INTERVAL_MS['1m'];
  const byMinute = new Map();
  for (const [price, volume, time] of trades) {
    const ms = Math.round(Number(time) * 1000);
    if (ms < startMs || ms >= endMs) continue;
    const t = Math.floor(ms / step) * step;
    const p = Number(price);
    const v = Number(volume);
    const c = byMinute.get(t);
    if (!c) byMinute.set(t, { timestamp: t, open: p, high: p, low: p, close: p, volume: v, closeTime: t + step });
    else { c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; c.volume += v; }
  }
  const out = [];
  let prev = seedPrevClose;
  for (let t = Math.floor(startMs / step) * step; t < endMs; t += step) {
    const c = byMinute.get(t);
    if (c) { c.volume = Number(c.volume.toFixed(8)); out.push(c); prev = c.close; }
    else if (prev !== null) out.push({ timestamp: t, open: prev, high: prev, low: prev, close: prev, volume: 0, closeTime: t + step });
  }
  return out;
}

/**
 * Fold one page of raw Kraken trades into `state` (`{ candles, partial, prevClose,
 * tradesSeen }`), in place. Trades within `[startMs, endMs)` are bucketed into 1m
 * candles exactly as `tradesTo1m` does, but incrementally: trades arrive in
 * chronological order (Kraken's `since` cursor pagination guarantees it), so once a
 * trade's minute is later than the open `partial` bucket, that bucket - and any
 * trade-less gap minutes before the new one, flat at `prevClose` - is final and moves
 * into `candles`. This is what lets the checkpoint hold candles instead of the trades
 * that built them.
 */
function foldTradesIntoState(state, trades, startMs, endMs) {
  const step = INTERVAL_MS['1m'];
  for (const [price, volume, time] of trades) {
    state.tradesSeen++;
    const ms = Math.round(Number(time) * 1000);
    if (ms < startMs || ms >= endMs) continue;
    const t = Math.floor(ms / step) * step;
    const p = Number(price);
    const v = Number(volume);
    if (state.partial && state.partial.timestamp === t) {
      state.partial.high = Math.max(state.partial.high, p);
      state.partial.low = Math.min(state.partial.low, p);
      state.partial.close = p;
      state.partial.volume += v;
    } else {
      closePartialThrough(state, t);
      state.partial = { timestamp: t, open: p, high: p, low: p, close: p, volume: v, closeTime: t + step };
    }
  }
}

/**
 * Finalizes the open `partial` 1m bucket - proven closed once a trade in a later minute
 * is seen, or the backfill itself ends - flat-filling any gap minutes between it and
 * `uptoTs` (exclusive) at `prevClose`, same rule as `tradesTo1m`. A no-op with no open
 * partial (before the first trade, or when called twice at the same boundary).
 */
function closePartialThrough(state, uptoTs) {
  if (!state.partial) return;
  const step = INTERVAL_MS['1m'];
  state.partial.volume = Number(state.partial.volume.toFixed(8));
  state.candles.push(state.partial);
  state.prevClose = state.partial.close;
  for (let t = state.partial.timestamp + step; t < uptoTs; t += step) {
    state.candles.push({ timestamp: t, open: state.prevClose, high: state.prevClose, low: state.prevClose, close: state.prevClose, volume: 0, closeTime: t + step });
  }
  state.partial = null;
}

/** Fresh fold state: no candles yet, no open bucket, no gap-fill cursor. */
function newFoldState() {
  return { candles: [], partial: null, prevClose: null, tradesSeen: 0 };
}

/**
 * Backfill 1m candles from Kraken public Trades further back than Kraken's 720-row OHLC
 * window. Resumable via `opts.checkpointFile`: progress is written to disk every
 * `flushEveryPages` pages and on completion, so a killed or crashed run continues from
 * where it left off on a rerun instead of re-paginating from the start. The checkpoint
 * holds the Kraken Trades `since` cursor and the fold state (`candles` completed so far,
 * the still-open `partial` minute, and the `prevClose` gap-fill cursor) rather than raw
 * trades, so its size stays proportional to backfill depth (~1 candle/minute) instead of
 * trade volume. A checkpoint from before this format (a raw `trades` array) is folded
 * into the same state once on load, via `foldTradesIntoState`, then resumes exactly as a
 * native checkpoint would - the merged result is identical either way. `startMs` is
 * pinned from the checkpoint's first run (the requested depth is a fixed historical
 * range, independent of "now"), and `overlapEnd` only ever grows to match the freshest
 * OHLC pull, so a later resume also covers any gap opened by real time elapsing between
 * runs.
 * @param {string} symbol
 * @param {Array<Object>} ohlc1m - ascending, closed 1m OHLC candles from Kraken
 * @param {number} minutes - how far back of trades to backfill, from `ohlc1m`'s oldest row
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable fetch, passed through to krakenTrades
 * @param {Function} [opts.retryDelayMs] - injectable backoff schedule
 * @param {string|null} [opts.checkpointFile] - path to persist/resume progress; no file, no persistence
 * @param {number} [opts.flushEveryPages]
 * @param {number} [opts.logEveryPages]
 * @param {number} [opts.pageDelayMs] - sleep between successful pages (default 1100, Kraken's public rate limit)
 * @param {Function} [opts.log]
 */
export async function backfill1m(symbol, ohlc1m, minutes, opts = {}) {
  const pair = KRAKEN_PAIRS[symbol];
  if (!pair) throw new Error(`no Kraken pair for ${symbol}`);
  const {
    fetchImpl,
    retryDelayMs,
    checkpointFile = null,
    flushEveryPages = 50,
    logEveryPages = 10,
    pageDelayMs = 1100, // politeness sleep between successful pages; overridable so tests don't pay it
    log = (msg) => console.error(msg)
  } = opts;
  const step = INTERVAL_MS['1m'];
  const oldest = ohlc1m[0].timestamp;

  let checkpoint = null;
  if (checkpointFile && existsSync(checkpointFile)) {
    try { checkpoint = JSON.parse(readFileSync(checkpointFile, 'utf8')); } catch (err) {
      log(`[replay] ${symbol} backfill: checkpoint unreadable (${err.message}), starting fresh`);
    }
  }

  const resumable = checkpoint && checkpoint.symbol === symbol
    && Number.isFinite(checkpoint.startMs) && Number.isFinite(checkpoint.overlapEnd)
    && typeof checkpoint.since === 'string'
    && (Array.isArray(checkpoint.trades) || Array.isArray(checkpoint.candles));

  let startMs;
  let overlapEnd;
  let since;
  let state;
  let done;

  const persist = () => {
    if (checkpointFile) {
      writeFileSync(checkpointFile, JSON.stringify({
        symbol, startMs, overlapEnd, since, done,
        candles: state.candles, partial: state.partial, prevClose: state.prevClose, tradesSeen: state.tradesSeen
      }));
    }
  };

  if (resumable) {
    startMs = checkpoint.startMs;
    overlapEnd = Math.max(checkpoint.overlapEnd, oldest + 60 * step);
    since = checkpoint.since;
    done = checkpoint.done === true && overlapEnd <= checkpoint.overlapEnd;
    if (Array.isArray(checkpoint.trades)) {
      // Pre-format checkpoint: fold its buffered raw trades into fold state once, then
      // persist immediately so the (possibly huge) raw-trade file is replaced on disk
      // right away rather than re-converted on every future load, then carry on exactly
      // as a native (candle) checkpoint would.
      state = newFoldState();
      foldTradesIntoState(state, checkpoint.trades, startMs, overlapEnd);
      log(`[replay] ${symbol} backfill: converting a legacy (raw-trade) checkpoint (${checkpoint.trades.length} buffered trades) to the candle checkpoint format`);
      persist();
    } else {
      state = {
        candles: checkpoint.candles.map((c) => ({ ...c })),
        partial: checkpoint.partial ? { ...checkpoint.partial } : null,
        prevClose: Number.isFinite(checkpoint.prevClose) ? checkpoint.prevClose : null,
        tradesSeen: Number.isFinite(checkpoint.tradesSeen) ? checkpoint.tradesSeen : 0
      };
    }
    log(`[replay] ${symbol} backfill: resuming from checkpoint (${state.candles.length} candles buffered, since ${since})`);
  } else {
    startMs = oldest - minutes * step;
    overlapEnd = oldest + 60 * step;
    since = String(BigInt(startMs) * 1000000n);
    state = newFoldState();
    done = false;
  }

  let pagesFetched = 0;
  while (!done) {
    const page = await krakenTrades(pair, since, { fetchImpl, retryDelayMs, log });
    pagesFetched++;
    if (page.trades.length) foldTradesIntoState(state, page.trades, startMs, overlapEnd);
    const lastMs = page.trades.length ? Number(page.trades[page.trades.length - 1][2]) * 1000 : 0;
    done = page.trades.length === 0 || lastMs >= overlapEnd || page.last === since;
    since = page.last;
    if (pagesFetched % logEveryPages === 0 || done) {
      log(`[replay] ${symbol} backfill: page ${pagesFetched}, ${state.tradesSeen} trades so far${lastMs ? `, at ${new Date(lastMs).toISOString()}` : ''}`);
    }
    if (checkpointFile && (pagesFetched % flushEveryPages === 0 || done)) persist();
    if (!done) await sleep(pageDelayMs);
  }

  // The final minute (or gap since the last real trade) is only provably closed once the
  // backfill itself ends - fold it in the same way a later trade's minute would.
  closePartialThrough(state, overlapEnd);

  const built = state.candles;
  const ohlcByTs = new Map(ohlc1m.map((c) => [c.timestamp, c]));
  let compared = 0;
  let mismatches = 0;
  for (const c of built) {
    const o = ohlcByTs.get(c.timestamp);
    if (!o) continue;
    compared++;
    if (['open', 'high', 'low', 'close'].some((k) => Math.abs(o[k] - c[k]) > 1e-9)) mismatches++;
  }
  const merged = [...built.filter((c) => !ohlcByTs.has(c.timestamp)), ...ohlc1m].sort((a, b) => a.timestamp - b.timestamp);
  return { candles: merged, report: { minutes, trades: state.tradesSeen, overlapCompared: compared, overlapMismatches: mismatches } };
}

/**
 * Timeframes deep-derived from backfilled 1m via aggregateToBuckets, wherever native
 * OHLC doesn't reach that far back: 5m/15m always (their 720-row OHLC window is only
 * ~2.5/7.5 days), 1h once the backfill goes deeper than its 720-row/~30-day window. 4h
 * (720 rows = 120 days) and 1d (720 rows = ~2 years) are never derived - their native
 * windows already reach past any realistic backfill depth.
 */
export const DERIVE_DEEP_TIMEFRAMES = ['5m', '15m', '1h'];

/**
 * Aggregate 1m candles into `tf`-width, UTC-aligned buckets (production's own
 * `aggregateToBuckets`, so a partial trailing bucket is dropped exactly as it is on the
 * request path) and prepend them to `ohlcCandles` wherever OHLC doesn't reach that far
 * back. OHLC wins on any overlapping timestamp - same rule as the 1m trade backfill -
 * and the overlap is reported the same way.
 * @param {Array<Object>} candles1m - ascending 1m candles (backfilled + OHLC)
 * @param {'5m'|'15m'} tf
 * @param {Array<Object>} ohlcCandles - ascending, closed OHLC rows for `tf`
 * @returns {{candles: Array<Object>, report: Object}}
 */
export function deriveTimeframe(candles1m, tf, ohlcCandles) {
  const derived = aggregateToBuckets(candles1m, INTERVAL_MS['1m'], INTERVAL_MS[tf]);
  const ohlcByTs = new Map(ohlcCandles.map((c) => [c.timestamp, c]));
  let compared = 0;
  let mismatches = 0;
  for (const c of derived) {
    const o = ohlcByTs.get(c.timestamp);
    if (!o) continue;
    compared++;
    if (['open', 'high', 'low', 'close'].some((k) => Math.abs(o[k] - c[k]) > 1e-9)) mismatches++;
  }
  const merged = [...derived.filter((c) => !ohlcByTs.has(c.timestamp)), ...ohlcCandles].sort((a, b) => a.timestamp - b.timestamp);
  return { candles: merged, report: { derivedFrom: '1m', derivedBuckets: derived.length, overlapCompared: compared, overlapMismatches: mismatches } };
}

/**
 * Save a live pull, one file per symbol and native timeframe, through the production
 * fetch (strict: no synthetic data). Unclosed candles are dropped before writing.
 *
 * With `backfillMinutes > 0`, 1m is extended by `backfill1m` (checkpointed to
 * `<outDir>/<SYMBOL>_1m.backfill.json`) and, unless `deriveDeep` is explicitly false,
 * `deriveDeep` also extends 5m/15m from those backfilled 1m candles via `deriveTimeframe`.
 * Neither runs, and neither the checkpoint file nor the manifest's `deriveDeep` entries
 * are touched, when `backfillMinutes` is 0 - capture without backfill is unchanged.
 */
export async function captureHistory({ symbols, outDir, backfillMinutes = 0, deriveDeep, now = Date.now(), fetchImpl, log }) {
  mkdirSync(outDir, { recursive: true });
  const deep = deriveDeep === undefined ? backfillMinutes > 0 : Boolean(deriveDeep);
  const manifest = { capturedAt: new Date(now).toISOString(), provider: 'kraken', symbols, timeframes: NATIVE_TIMEFRAMES, files: {}, backfill1m: {}, deriveDeep: {} };
  for (const symbol of symbols) {
    let candles1mFinal = null;
    for (const tf of NATIVE_TIMEFRAMES) {
      const env = await getCandlesWithProvenance(`${symbol}USDT`, tf, CAPTURE_LIMIT, { allowSynthetic: false, now });
      if (env.error || env.provider !== 'kraken') throw new Error(`${symbol} ${tf}: ${env.error || `provider ${env.provider}`}`);
      let candles = dropUnclosedCandles(env.candles, tf, now);
      if (tf === '1m' && backfillMinutes > 0) {
        const checkpointFile = path.join(outDir, `${symbol}_1m.backfill.json`);
        const r = await backfill1m(symbol, candles, backfillMinutes, { fetchImpl, checkpointFile, log });
        candles = r.candles;
        manifest.backfill1m[symbol] = r.report;
        candles1mFinal = candles;
      }
      if (deep && candles1mFinal && DERIVE_DEEP_TIMEFRAMES.includes(tf)) {
        const d = deriveTimeframe(candles1mFinal, tf, candles);
        candles = d.candles;
        manifest.deriveDeep[symbol] = manifest.deriveDeep[symbol] || {};
        manifest.deriveDeep[symbol][tf] = d.report;
      }
      const file = `${symbol}_${tf}.json`;
      writeFileSync(path.join(outDir, file), JSON.stringify({ symbol, timeframe: tf, provider: env.provider, capturedAt: manifest.capturedAt, candles }));
      manifest.files[file] = { count: candles.length, from: new Date(candles[0].timestamp).toISOString(), closedThrough: new Date(closeTimeOf(candles[candles.length - 1], tf)).toISOString() };
    }
    // Written after every symbol (not only at the end): a multi-hour capture that is
    // killed or crashes mid-run still leaves a manifest describing whichever symbols
    // finished, alongside their files and the per-symbol backfill1m checkpoint for
    // whichever symbol was in progress.
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
  return {
    capture: list(opts.capture),
    history: typeof opts.history === 'string' ? opts.history : null,
    symbols: list(opts.symbols),
    timeframes: list(opts.timeframes),
    from: opts.from ?? null,
    to: opts.to ?? null,
    step: opts.step ? Number(opts.step) : 1,
    out: typeof opts.out === 'string' ? opts.out : null,
    backfillMinutes: opts['backfill-1m'] ? Number(opts['backfill-1m']) : 0,
    // undefined (not just true/false) when the flag is absent, so captureHistory's own
    // "on whenever backfill runs" default applies instead of being overridden to false.
    deriveDeep: opts['derive-deep'] ? true : undefined
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.capture) {
    if (!args.out) throw new Error('--capture needs --out <dir>');
    const manifest = await captureHistory({ symbols: args.capture, outDir: args.out, backfillMinutes: args.backfillMinutes, deriveDeep: args.deriveDeep });
    console.error(JSON.stringify(manifest, null, 2));
    return;
  }
  if (!args.history) throw new Error('need --history <dir> (or --capture)');
  const symbols = args.symbols || SYMBOLS;
  const timeframes = args.timeframes || TIMEFRAMES;
  for (const tf of timeframes) if (!INTERVAL_MS[tf]) throw new Error(`unknown timeframe ${tf}`);
  const history = loadHistoryDir(args.history, symbols);
  const sink = args.out ? createWriteStream(args.out) : process.stdout;
  for (const symbol of symbols) {
    const started = Date.now();
    const r = await replaySymbol({
      symbol,
      historyByTf: history[symbol],
      timeframes,
      from: args.from,
      to: args.to,
      step: args.step,
      onLine: (line) => sink.write(`${JSON.stringify(line)}\n`)
    });
    const ms = Date.now() - started;
    console.error(`[replay] ${symbol}: ${r.lines.length} closes (clock ${r.clockTf}, first eligible ${r.firstEligible}) in ${ms} ms${r.lines.length ? ` (${(ms / r.lines.length).toFixed(1)} ms/close)` : ''}`);
  }
  if (args.out) sink.end();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[replay] ${err.message}`);
    process.exit(1);
  });
}
