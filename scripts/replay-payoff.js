#!/usr/bin/env node
/**
 * Trade payoff of the flag-flow alerts (docs/FLAG_FLOW_BACKTEST_2026-10-03.md, "Trade payoff").
 *
 * Takes the outcome rows of scripts/replay-flag-flow.js (alert-price run: `anchor` = the open of
 * the 1m candle right after the alert) and walks real 1m candles forward from the alert:
 *   entry = anchor, stop = the card's SL, target = the card's TP (measured move).
 *   stop first -> loss, target first -> win, one 1m candle touching both -> loss. No time limit;
 *   a trade still open at the end of data is `unresolved` and left out of the stats.
 *   R = (exit - entry) / (entry - stop) in the trade direction, so a win is reward/risk measured
 *   from the ALERT price, a loss is -1R.
 *   Net R = gross R - round-trip cost in R: ENGINE_CONFIG.risk.costBpsByDirection[dir] / 1e4 * entry / risk
 *   (the conversion scripts/tracker/costs.js costR uses).
 * Variants: A card target; B card target, half off at +1R then stop to breakeven (a stop or
 * breakeven touch in the same candle as the +1R touch exits the rest at breakeven); C target = 2R.
 * A row whose alert price is already past the target (reward <= 0) or the stop is `skipped`.
 *
 * No lookahead: only candles with open time >= calledAt are read, in order; the result of a
 * trade never depends on a candle after its resolution.
 *
 * Usage: node scripts/replay-payoff.js --dir <backtest dir> [--suffix -alertpx] [--history <dir>] [--runs min5,min1]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CONFIG } from '../config/engine.js';

const HALF_SPLIT = Date.parse('2026-06-18T00:00:00Z');
const DEFAULT_HISTORY = '/Users/bballi/Documents/Repos/snapshot_tradingview/test/fixtures/history/deep2y-2026-09-26';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 1m candles as column arrays (ascending). */
export function columns(candles) {
  return { ts: candles.map((c) => c.timestamp), h: candles.map((c) => c.high), l: candles.map((c) => c.low), n: candles.length };
}

const lowerBound = (ts, x) => { let lo = 0; let hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; };

/** Round-trip cost in R of the initial risk. */
export function costInR(entry, stop, direction, bps = ENGINE_CONFIG.risk.costBpsByDirection) {
  const risk = Math.abs(entry - stop);
  return risk > 0 && isNum(bps[direction]) ? (bps[direction] / 10000) * entry / risk : null;
}

/**
 * Walk one trade. `variant`: 'A' | 'B' | 'C'.
 * @returns {{status:'resolved', grossR:number, minutes:number, exit:string} | {status:'unresolved'} | {status:'skipped', why:string}}
 */
export function walkTrade({ direction, entry, stop, target, calledMs }, cols, variant = 'A') {
  const sign = direction === 'long' ? 1 : -1;
  const risk = (entry - stop) * sign;
  if (!(risk > 0)) return { status: 'skipped', why: 'stop_passed' };
  let rewardR = ((target - entry) * sign) / risk;
  if (variant === 'C') rewardR = 2;
  if (!(rewardR > 0)) return { status: 'skipped', why: 'target_passed' };
  const tp = entry + sign * rewardR * risk;
  const oneR = entry + sign * risk;
  const split = variant === 'B' && rewardR > 1;
  const hitStop = (i, level) => (sign === 1 ? cols.l[i] <= level : cols.h[i] >= level);
  const hitUp = (i, level) => (sign === 1 ? cols.h[i] >= level : cols.l[i] <= level);
  const done = (grossR, i, exit) => ({ status: 'resolved', grossR, minutes: (cols.ts[i] + 60_000 - calledMs) / 60_000, exit });
  let i = lowerBound(cols.ts, calledMs);
  let phase = 1;
  for (; i < cols.n; i++) {
    if (phase === 1) {
      if (hitStop(i, stop)) return done(-1, i, 'stop');
      if (split) {
        if (hitUp(i, oneR)) {
          if (hitStop(i, entry)) return done(0.5, i, 'breakeven'); // the same candle also came back to entry: assume it did
          if (hitUp(i, tp)) return done(0.5 + 0.5 * rewardR, i, 'target');
          phase = 2;
        }
      } else if (hitUp(i, tp)) return done(rewardR, i, 'target');
    } else {
      if (hitStop(i, entry)) return done(0.5, i, 'breakeven');
      if (hitUp(i, tp)) return done(0.5 + 0.5 * rewardR, i, 'target');
    }
  }
  return { status: 'unresolved' };
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);

/** Statistics for a list of {grossR, netR, minutes, exitAt} trades, plus unresolved / skipped counts. */
export function statsOf(trades, unresolved = 0, skipped = 0) {
  const n = trades.length;
  const wins = trades.filter((t) => t.grossR > 0);
  const losses = trades.filter((t) => t.grossR <= 0);
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  let eq = 0; let peak = 0; let dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitAt - b.exitAt)) { eq += t.netR; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    n, unresolved, skipped, winRate: n ? r3(wins.length / n) : null,
    avgWinR: wins.length ? r3(sum(wins, (t) => t.grossR) / wins.length) : null,
    avgLossR: losses.length ? r3(sum(losses, (t) => t.grossR) / losses.length) : null,
    expectancyGrossR: n ? r3(sum(trades, (t) => t.grossR) / n) : null,
    expectancyNetR: n ? r3(sum(trades, (t) => t.netR) / n) : null,
    totalNetR: r3(sum(trades, (t) => t.netR)), medianMinutes: median(trades.map((t) => t.minutes)), maxDrawdownR: r3(dd)
  };
}

const rrBand = (rr) => (rr < 1 ? '<1R' : rr < 2 ? '1-2R' : '2R+');

/** All variants x splits for outcome rows. `colsBySymbol`: symbol -> columns(1m candles). */
export function payoffForRows(rows, colsBySymbol) {
  const out = {};
  for (const variant of ['A', 'B', 'C']) {
    const trades = [];
    let unresolved = 0;
    const skipped = { stop_passed: 0, target_passed: 0 };
    for (const r of rows) {
      const calledMs = Date.parse(r.calledAt);
      const target = isNum(r.tp1) ? r.tp1 : null;
      if (!isNum(r.anchor) || !isNum(r.stop) || (variant !== 'C' && target === null)) { skipped.target_passed++; continue; }
      const w = walkTrade({ direction: r.direction, entry: r.anchor, stop: r.stop, target, calledMs }, colsBySymbol[r.symbol], variant);
      if (w.status === 'skipped') { skipped[w.why]++; continue; }
      if (w.status === 'unresolved') { unresolved++; continue; }
      const cost = costInR(r.anchor, r.stop, r.direction);
      const sign = r.direction === 'long' ? 1 : -1;
      const rewardR = isNum(target) ? ((target - r.anchor) * sign) / ((r.anchor - r.stop) * sign) : null;
      trades.push({
        grossR: w.grossR, netR: w.grossR - cost, minutes: w.minutes, exitAt: calledMs + w.minutes * 60_000, exit: w.exit,
        timeframe: r.timeframe, score: `${r.flow.score}/7`, rr: rrBand(rewardR ?? 2), half: calledMs < HALF_SPLIT ? 'first100d' : 'last100d'
      });
    }
    const skippedN = skipped.stop_passed + skipped.target_passed;
    const by = (key) => Object.fromEntries([...new Set(trades.map((t) => t[key]))].sort().map((k) => [k, statsOf(trades.filter((t) => t[key] === k))]));
    out[variant] = {
      overall: { ...statsOf(trades, unresolved, skippedN), skippedBy: skipped, exits: Object.fromEntries([...new Set(trades.map((t) => t.exit))].map((e) => [e, trades.filter((t) => t.exit === e).length])), avgCostR: r3(trades.reduce((a, t) => a + (t.grossR - t.netR), 0) / (trades.length || 1)) },
      byTimeframe: by('timeframe'), byScore: by('score'), byRR: by('rr'), byHalf: by('half')
    };
  }
  return out;
}

function main() {
  const o = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  if (!o.dir) throw new Error('--dir <backtest dir> required');
  const suffix = typeof o.suffix === 'string' ? o.suffix : '-alertpx';
  const history = o.history || DEFAULT_HISTORY;
  const runs = String(o.runs || 'min5,min1').split(',');
  const cols = {};
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    const raw = JSON.parse(readFileSync(path.join(history, `${sym}_1m.json`), 'utf8'));
    cols[sym] = columns(Array.isArray(raw) ? raw : raw.candles);
  }
  for (const run of runs) {
    const rows = readFileSync(path.join(o.dir, `outcomes-${run}${suffix}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const res = { run, rows: rows.length, costBpsByDirection: ENGINE_CONFIG.risk.costBpsByDirection, ...payoffForRows(rows, cols) };
    writeFileSync(path.join(o.dir, `payoff-${run}.json`), JSON.stringify(res, null, 2));
    console.log(run, JSON.stringify(['A', 'B', 'C'].map((v) => [v, res[v].overall.n, res[v].overall.expectancyNetR])));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
