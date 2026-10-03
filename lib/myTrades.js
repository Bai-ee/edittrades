/**
 * My trades (owner 2026-10-03): the owner enters trades by hand off the alerts, so the alerts'
 * backtest says nothing about the owner's own picks. Every lock the owner took ("I'm in") and
 * that has since closed is written to `state.myTrades` with its net R after fees, and `/mytrades`
 * compares the owner's results with the backtest of every alert on the same timeframes.
 *
 * Closed = a filled lock that reached `tp1`, `stopped`, `ended` (open past the lock's max hold,
 * marked at the price then) or `unlocked` (owner closed it; the exit is the mark at the tap when
 * the webhook knew it, else the trade is kept with no R and left out of the stats).
 *
 * Net R = gross R from the fill - round-trip fees in R of the stop distance (same cost model as
 * the tracker and the flag-flow backtest: config/engine.json risk.costBpsByDirection).
 *
 * Pure functions, no I/O.
 */
import { feeR } from './flagFlow.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

/** Closed trades kept (oldest dropped first). */
export const MY_TRADES_MAX = 300;
/** Below this many trades the summary says the sample is too small to judge. */
export const MY_TRADES_MIN_N = 30;
const CLOSED_FILLED = Object.freeze(['tp1', 'stopped', 'ended', 'unlocked']);

/**
 * Net R per trade of every LOCK OPPORTUNITY alert by timeframe: the 200-day flag-flow backtest,
 * entry at the alert price, card stop and target, net of fees (docs/FLAG_FLOW_BACKTEST_2026-10-03.md,
 * "min5" run, variant A). A reference line, not live data.
 */
export const ALERT_BASELINE_NET_R = Object.freeze({ '1m': -2.57, '3m': -0.97, '5m': -0.69, '15m': -0.30, '1h': -0.17, '4h': -0.19 });
export const ALERT_BASELINE_ALL = -1.55;

/**
 * One journal row for a lock the owner took that has closed, else null.
 * @param {Object} lock - lib/tradeLock.js lock
 * @returns {Object|null}
 */
export function myTradeOf(lock) {
  if (!isObj(lock) || !CLOSED_FILLED.includes(lock.status) || !lock.filledAt || !isObj(lock.levels)) return null;
  const dir = lock.direction === 'short' ? 'short' : 'long';
  const sign = dir === 'short' ? -1 : 1;
  const fill = isNum(lock.fillPrice) ? lock.fillPrice : lock.levels.entry;
  const stop = lock.levels.stop;
  const exit = isNum(lock.endPrice) ? lock.endPrice : null;
  const risk = isNum(fill) && isNum(stop) ? Math.abs(fill - stop) : 0;
  const grossR = risk > 0 && isNum(exit) ? r2((sign * (exit - fill)) / risk) : null;
  const fees = risk > 0 ? feeR(fill, stop, dir) : null;
  const netR = isNum(grossR) && isNum(fees) ? r2(grossR - fees) : null;
  return {
    ref: lock.ref, symbol: lock.symbol, tf: lock.timeframe, dir, how: lock.status,
    fill, stop, tp: isNum(lock.levels.tp1) ? lock.levels.tp1 : null, exit,
    grossR, feeR: isNum(fees) ? r2(fees) : null, netR,
    filledAt: lock.filledAt, closedAt: lock.endedAt || lock.statusAt || null
  };
}

/** Keep well-formed rows only, newest MY_TRADES_MAX. */
export function normalizeMyTrades(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((t) => isObj(t) && /^[0-9a-f]{8}$/.test(String(t.ref)) && typeof t.symbol === 'string' && typeof t.tf === 'string')
    .slice(-MY_TRADES_MAX);
}

/**
 * Add every newly closed taken lock in `locks` to `state.myTrades` (once per ref). Mutates state.
 * @returns {Array<Object>} the rows added
 */
export function recordMyTrades(state, locks) {
  if (!isObj(state)) return [];
  const journal = normalizeMyTrades(state.myTrades);
  const seen = new Set(journal.map((t) => t.ref));
  const added = [];
  for (const l of Array.isArray(locks) ? locks : []) {
    const row = myTradeOf(l);
    if (row && !seen.has(row.ref)) { journal.push(row); seen.add(row.ref); added.push(row); }
  }
  state.myTrades = journal.slice(-MY_TRADES_MAX);
  return added;
}

/** Summary over trades with a known net R. */
export function myTradesStats(trades) {
  const rows = normalizeMyTrades(trades).filter((t) => isNum(t.netR));
  const wins = rows.filter((t) => t.netR > 0);
  const losses = rows.filter((t) => t.netR <= 0);
  const mean = (a, k) => (a.length ? r2(a.reduce((s, t) => s + t[k], 0) / a.length) : null);
  const total = r2(rows.reduce((s, t) => s + t.netR, 0));
  const byTf = {};
  for (const t of rows) {
    const b = byTf[t.tf] || (byTf[t.tf] = { n: 0, net: 0 });
    b.n += 1;
    b.net += t.netR;
  }
  for (const k of Object.keys(byTf)) byTf[k] = { n: byTf[k].n, netPerTrade: r2(byTf[k].net / byTf[k].n) };
  // The alerts' backtest weighted by the owner's own timeframe mix (same trades, alert rules).
  const known = rows.filter((t) => isNum(ALERT_BASELINE_NET_R[t.tf]));
  const baseline = known.length ? r2(known.reduce((s, t) => s + ALERT_BASELINE_NET_R[t.tf], 0) / known.length) : null;
  return {
    n: rows.length, unknown: normalizeMyTrades(trades).length - rows.length,
    winRate: rows.length ? r2((wins.length / rows.length) * 100) : null,
    avgWinR: mean(wins, 'netR'), avgLossR: mean(losses, 'netR'), avgFeeR: mean(rows.filter((t) => isNum(t.feeR)), 'feeR'),
    netPerTrade: rows.length ? r2(total / rows.length) : null, totalNetR: total, byTf, baseline
  };
}

const fmtR = (v) => (isNum(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R` : 'n/a');
const TF_ORDER = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
const HOW = { tp1: 'target', stopped: 'stop', ended: 'time', unlocked: 'closed' };

/** The /mytrades reply (plain text lines; the caller escapes / wraps). */
export function formatMyTrades(trades) {
  const all = normalizeMyTrades(trades);
  if (!all.length) {
    return [
      'MY TRADES · none yet',
      "Tap 🔒 Lock on an alert, then I'm in when you enter. When it closes (target, stop, or Unlock when you exit) it lands here with its net R after fees."
    ].join('\n');
  }
  const s = myTradesStats(all);
  const lines = [`MY TRADES · ${s.n} closed${s.unknown ? ` (+${s.unknown} with no exit price)` : ''}`];
  if (s.n) {
    lines.push(
      `Net ${fmtR(s.netPerTrade)} per trade · total ${fmtR(s.totalNetR)}`,
      `Win ${s.winRate}% · avg win ${fmtR(s.avgWinR)} · avg loss ${fmtR(s.avgLossR)} · fees ${isNum(s.avgFeeR) ? `${s.avgFeeR.toFixed(2)}R` : 'n/a'}`
    );
    if (isNum(s.baseline)) lines.push(`Every alert, same timeframes: ${fmtR(s.baseline)} per trade (200-day backtest)`);
    const tfs = Object.keys(s.byTf).sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));
    if (tfs.length) lines.push(tfs.map((tf) => `${tf} ${s.byTf[tf].n}: ${fmtR(s.byTf[tf].netPerTrade)}`).join(' · '));
    if (s.n < MY_TRADES_MIN_N) lines.push(`Small sample: ${s.n}/${MY_TRADES_MIN_N} trades before this means much.`);
  }
  const last = all.slice(-5).reverse().map((t) => `${t.symbol} ${t.tf} ${t.dir === 'short' ? '▼' : '▲'} ${HOW[t.how] || t.how} ${fmtR(t.netR)}`);
  lines.push('Last:', ...last);
  return lines.join('\n');
}
