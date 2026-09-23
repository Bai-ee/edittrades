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
 * Usage: node collect.js [--data ./data] [--url <scalp-context url>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, appendCalls, appendCandles, CANDLE_TIMEFRAMES } from './store.js';

export const DEFAULT_URL = 'https://snapshottradingview.vercel.app/api/scalp-context';

const TF_MS = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };

/** True for a key that could carry account, wallet, or balance data. */
export function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  if (k === 'account' || k === 'wallet' || k === 'performance' || k === 'margin') return true;
  if (k.startsWith('holdings')) return true;
  return k.includes('wallet') || k.includes('balance') || k.includes('address');
}

/** Deep copy of `value` with every sensitive key removed at any depth. */
export function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out;
  }
  return value;
}

/** Paths of any sensitive keys left in `value` (empty = clean). */
export function findSensitiveKeys(value, at = '$', found = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findSensitiveKeys(v, `${at}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) found.push(`${at}.${k}`);
      findSensitiveKeys(v, `${at}.${k}`, found);
    }
  }
  return found;
}

function slimCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    id: c.candidateId ?? null,
    tf: c.timeframe ?? null,
    dir: c.direction ?? null,
    state: c.state ?? null,
    breakout: c.breakoutLevel ?? null,
    invalidation: c.invalidation ?? null,
    measuredRR: c.measuredRR ?? null,
    qual: c.qual ?? null
  };
}

/**
 * One stripped call row per symbol from a scalp-context payload. Throws (nothing is
 * written) if any sensitive key survives the strip.
 * @param {Object} payload
 * @param {number} [capturedAtMs=Date.now()]
 * @returns {Array<Object>}
 */
export function recordsFromPayload(payload, capturedAtMs = Date.now()) {
  const symbols = payload && payload.symbols && typeof payload.symbols === 'object' ? payload.symbols : {};
  const rows = [];
  for (const [symbol, sym] of Object.entries(symbols)) {
    if (!sym || typeof sym !== 'object') continue;
    const mark = sym.mark && typeof sym.mark === 'object'
      ? { price: sym.mark.price ?? null, driftBps: sym.mark.driftBps ?? null, status: sym.mark.status ?? null }
      : null;
    const row = {
      capturedAt: new Date(capturedAtMs).toISOString(),
      closedThrough: payload.closedThrough ?? null,
      schemaVersion: payload.schemaVersion ?? null,
      configVersion: payload.configVersion ?? null,
      dataStatus: payload.dataStatus ?? null,
      symbol,
      price: sym.price ?? null,
      mark,
      flagTradePlan: sym.flagTradePlan ?? null,
      flagRecommendation: sym.flagRecommendation ?? null,
      candidateSetups: Array.isArray(sym.candidateSetups) ? sym.candidateSetups.map(slimCandidate).filter(Boolean) : [],
      bias: sym.decisionTrace && sym.decisionTrace.bias !== undefined ? sym.decisionTrace.bias : null
    };
    const clean = stripSensitive(row);
    const leaked = findSensitiveKeys(clean);
    if (leaked.length) throw new Error(`refusing to write: sensitive keys survived strip (${leaked.length})`);
    rows.push(clean);
  }
  return rows;
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

/** Write one payload's calls and candles into `dataDir`. */
export function ingestPayload(dataDir, payload, capturedAtMs = Date.now()) {
  const rows = recordsFromPayload(payload, capturedAtMs);
  const calls = appendCalls(dataDir, rows);
  const candles = {};
  const byTf = candlesFromPayload(payload);
  for (const tf of CANDLE_TIMEFRAMES) candles[tf] = appendCandles(dataDir, tf, byTf[tf]);
  return { symbols: rows.map((r) => r.symbol), closedThrough: payload.closedThrough ?? null, calls, candles };
}

async function main() {
  const opts = parseArgs();
  const key = process.env.SCALP_CONTEXT_API_KEY;
  if (!key) throw new Error('SCALP_CONTEXT_API_KEY is not set');
  const url = typeof opts.url === 'string' ? opts.url : DEFAULT_URL;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`scalp-context returned HTTP ${res.status}`);
  const payload = await res.json();

  const result = ingestPayload(opts.data, payload);
  console.log(`[tracker:collect] closedThrough=${result.closedThrough} symbols=${result.symbols.join(',')} `
    + `calls +${result.calls.added} (dup ${result.calls.duplicates}) `
    + `candles 1m +${result.candles['1m']} 5m +${result.candles['5m']} 15m +${result.candles['15m']}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[tracker:collect] ${err.message}`);
    process.exit(1);
  });
}
