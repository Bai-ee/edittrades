#!/usr/bin/env node
/**
 * EditTrades call tracker - spot trend filter, paper only (docs/PLAN_SPOT_TREND_2026-09-27.md P1).
 *
 * Rule (docs/EDGE_SEARCH_2026-09-27.md): hold a coin while its daily close is above EMA20 of
 * daily closes, else hold USDC. Weight when IN = min(1, VOL_TARGET / 20-day realized vol);
 * decided on the UTC daily close, applied from the next day. Paper ledger: equal share per
 * coin, SWITCH_COST per unit of weight changed. No orders, no wallet, no secrets.
 *
 * Self-contained on purpose (the tracker repo runs without an engine checkout). The math
 * mirrors scripts/research/edge/lib.js `ema` and spot-portfolio.js `portfolioSeries`;
 * test-tracker.js checks parity against both.
 *
 * Writes under <data>/spot-trend/:
 *   days.jsonl    one row per symbol per closed UTC day {date, symbol, close, ema20, state, vol20, weight}
 *   flips.jsonl   one row per state change {date, symbol, from, to, close, ema20, weight, live, recordedAt};
 *                 live = after meta.startDate (P2 alerts only on those; earlier rows are history)
 *   ledger.json   paper equity vs buy & hold from the first live day (meta.startDate)
 *   meta.json     {startDate}: the latest closed day at the first run; the ledger starts there
 * Idempotent: rows already present (symbol+date) are skipped, so the 10-minute cadence is harmless.
 *
 * Usage: node spot-trend.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, ensureDir, readJsonl, appendJsonl, readJson, writeJson } from './store.js';

export const SPOT_SYMBOLS = Object.freeze({ BTC: 'XBTUSD', ETH: 'ETHUSD', SOL: 'SOLUSD' });
export const EMA_PERIOD = 20;
export const VOL_WINDOW = 20;
export const VOL_TARGET = 0.4;
export const SWITCH_COST = 0.0015;
const DAY_MS = 86_400_000;

export const spotDir = (dataDir) => path.join(dataDir, 'spot-trend');

/** EMA seeded with the SMA of the first `p` values; NaN before index p-1 (research lib.js `ema`). */
export function emaSeries(x, p) {
  const out = new Array(x.length).fill(NaN);
  const k = 2 / (p + 1);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    if (i < p - 1) { s += x[i]; continue; }
    if (i === p - 1) { s += x[i]; out[i] = s / p; continue; }
    out[i] = x[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Annualized realized vol of the VOL_WINDOW daily log returns ending at close i, or NaN. */
function realizedVol(c, i) {
  if (i < VOL_WINDOW) return NaN;
  let s = 0;
  for (let j = i - VOL_WINDOW + 1; j <= i; j++) s += Math.log(c[j] / c[j - 1]) ** 2;
  return Math.sqrt((s / VOL_WINDOW) * 365);
}

/** Kraken public OHLC (interval 1440) -> closed daily candles {t (ms, UTC open), c}. */
export function dailyFromKraken(result, nowMs) {
  if (!result || typeof result !== 'object') return [];
  const key = Object.keys(result).find((k) => k !== 'last');
  const rows = key && Array.isArray(result[key]) ? result[key] : [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 5) continue;
    const t = Number(r[0]) * 1000, c = Number(r[4]);
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    if (t + DAY_MS > nowMs) continue; // still forming
    out.push({ t, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * One state row per closed day with a defined EMA. `volTarget` null -> weight 0/1.
 * @param {Array<{t:number,c:number}>} candles - closed daily candles, ascending
 */
export function dailyStates(symbol, candles, volTarget = VOL_TARGET) {
  const c = candles.map((k) => k.c);
  const e = emaSeries(c, EMA_PERIOD);
  const rows = [];
  for (let i = 0; i < candles.length; i++) {
    if (!Number.isFinite(e[i])) continue;
    const vol = realizedVol(c, i);
    const state = c[i] > e[i] ? 'IN' : 'OUT';
    let weight = state === 'IN' ? 1 : 0;
    if (weight && volTarget) weight = Number.isFinite(vol) ? Math.min(1, volTarget / vol) : null;
    rows.push({ date: new Date(candles[i].t).toISOString().slice(0, 10), symbol, close: c[i], ema20: e[i], state, vol20: Number.isFinite(vol) ? vol : null, weight });
  }
  return rows;
}

const r4 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
/** Stored rows carry 4-decimal ema20/vol20/weight; the math above stays unrounded. */
const roundRow = (r) => ({ ...r, ema20: r4(r.ema20), vol20: r4(r.vol20), weight: r4(r.weight) });

/** State changes between consecutive rows of one symbol. */
export function flipsFrom(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].state !== rows[i - 1].state) {
      const r = rows[i];
      out.push({ date: r.date, symbol: r.symbol, from: rows[i - 1].state, to: r.state, close: r.close, ema20: r.ema20, weight: r.weight });
    }
  }
  return out;
}

/**
 * Per-day portfolio return for one symbol from its closes and weights: the weight set on
 * close i-1 earns day i's return, minus SWITCH_COST x |weight change| booked on close i
 * (research spot-portfolio.js `portfolioSeries`). Returns Map(date -> {ret, bh}).
 */
export function symbolReturns(rows) {
  const out = new Map();
  let w = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i].close / rows[i - 1].close - 1;
    const target = rows[i].weight ?? 0;
    const ret = w * r - Math.abs(target - w) * SWITCH_COST;
    w = target;
    out.set(rows[i].date, { ret, bh: r });
  }
  return out;
}

/** Equal-share paper portfolio vs buy & hold from `startDate` (inclusive: first day earning is the next). */
export function paperLedger(rowsBySymbol, startDate) {
  const series = Object.entries(rowsBySymbol).map(([sym, rows]) => [sym, symbolReturns(rows.filter((r) => r.date >= startDate))]);
  const dates = [...new Set(series.flatMap(([, m]) => [...m.keys()]))].sort();
  let equity = 1, bh = 1;
  const rows = [];
  for (const date of dates) {
    const legs = series.map(([, m]) => m.get(date)).filter(Boolean);
    if (!legs.length) continue;
    equity *= 1 + legs.reduce((s, x) => s + x.ret, 0) / legs.length;
    bh *= 1 + legs.reduce((s, x) => s + x.bh, 0) / legs.length;
    rows.push({ date, equity, bh });
  }
  return { startDate, rows };
}

/**
 * Write new day/flip rows and rebuild the ledger from `candlesBySymbol` (already closed-only).
 * Pure apart from files under <data>/spot-trend/.
 */
export function updateSpotTrend(dataDir, candlesBySymbol, nowMs = Date.now()) {
  const dir = spotDir(dataDir);
  ensureDir(dir);
  const daysFile = path.join(dir, 'days.jsonl'), flipsFile = path.join(dir, 'flips.jsonl');
  const haveDays = new Set(readJsonl(daysFile).map((r) => `${r.symbol}|${r.date}`));
  const haveFlips = new Set(readJsonl(flipsFile).map((r) => `${r.symbol}|${r.date}`));
  const rowsBySymbol = {};
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    const rows = dailyStates(symbol, candles);
    if (rows.length) rowsBySymbol[symbol] = rows;
  }

  const metaFile = path.join(dir, 'meta.json');
  let meta = readJson(metaFile, null);
  const latest = Object.values(rowsBySymbol).map((rows) => rows.at(-1).date).sort().at(-1) || null;
  if (!meta || !meta.startDate) {
    meta = { startDate: latest };
    if (latest) writeJson(metaFile, meta);
  }

  // `live` flips (after startDate) are the ones P2 may alert on; earlier ones are history.
  const newDays = [], newFlips = [];
  for (const [symbol, rows] of Object.entries(rowsBySymbol)) {
    for (const r of rows) if (!haveDays.has(`${symbol}|${r.date}`)) newDays.push(roundRow(r));
    for (const f of flipsFrom(rows)) {
      if (!haveFlips.has(`${symbol}|${f.date}`)) newFlips.push({ ...roundRow(f), live: Boolean(meta.startDate) && f.date > meta.startDate, recordedAt: new Date(nowMs).toISOString() });
    }
  }
  appendJsonl(daysFile, newDays);
  appendJsonl(flipsFile, newFlips);
  const ledger = meta.startDate ? paperLedger(rowsBySymbol, meta.startDate) : { startDate: null, rows: [] };
  writeJson(path.join(dir, 'ledger.json'), ledger);
  return { days: newDays.length, flips: newFlips.length, startDate: meta.startDate, latest, ledgerDays: ledger.rows.length };
}

async function fetchKrakenDaily(pair, nowMs) {
  const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (Array.isArray(body.error) && body.error.length) throw new Error(body.error.join(';'));
  return dailyFromKraken(body.result, nowMs);
}

async function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const candlesBySymbol = {};
  for (const [symbol, pair] of Object.entries(SPOT_SYMBOLS)) {
    try {
      candlesBySymbol[symbol] = await fetchKrakenDaily(pair, nowMs);
    } catch (err) {
      console.warn(`[tracker:spot-trend] kraken ${symbol} failed: ${err.message}`);
    }
  }
  const r = updateSpotTrend(opts.data, candlesBySymbol, nowMs);
  console.log(`[tracker:spot-trend] +${r.days} day row(s), +${r.flips} flip(s), latest ${r.latest}, ledger from ${r.startDate} (${r.ledgerDays} day(s))`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`[tracker:spot-trend] ${err.message}`); process.exit(1); });
}
