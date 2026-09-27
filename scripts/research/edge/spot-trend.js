// Spot trend filter (research only, docs/EDGE_SEARCH_2026-09-27.md): hold the coin while the
// daily close is above EMA(N), else cash. Decided on a close, applied from the next day.
// Cost per switch = one swap (0.10% Jupiter non-stable) + 0.05% slippage.
//   node scripts/research/edge/spot-trend.js [--dir var/edge/daily-long] [--from 2017-08-01] [--to 2024-10-01]
import { loadBars, ema } from './lib.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const dir = args.dir || 'var/edge/daily-long';
const from = Date.parse(args.from || '2017-01-01'), to = Date.parse(args.to || '2099-01-01');
const SWITCH_COST = 0.15 / 100;

export function runFilter(d, N, fromMs, toMs) {
  const e = ema(d.c, N);
  let eq = 1, bh = 1, inPos = false, switches = 0, peak = 1, dd = 0, bpeak = 1, bdd = 0, days = 0, inDays = 0;
  const rets = [], trades = []; let tradeStart = null;
  for (let i = 1; i < d.n; i++) {
    if (d.t[i] < fromMs || d.t[i] >= toMs || !Number.isFinite(e[i - 1])) continue;
    const r = d.c[i] / d.c[i - 1];
    days++; bh *= r; bpeak = Math.max(bpeak, bh); bdd = Math.max(bdd, 1 - bh / bpeak);
    const before = eq;
    if (inPos) { eq *= r; inDays++; }
    const want = d.c[i] > e[i];
    if (want !== inPos) {
      eq *= 1 - SWITCH_COST; switches++;
      if (want) tradeStart = eq; else if (tradeStart) { trades.push(eq / tradeStart - 1); tradeStart = null; }
      inPos = want;
    }
    rets.push(eq / before - 1);
    peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
  }
  const yrs = days / 365;
  const mu = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / rets.length);
  const wins = trades.filter((x) => x > 0);
  return {
    cagr: eq ** (1 / yrs) - 1, bhCagr: bh ** (1 / yrs) - 1, dd, bhDd: bdd, sharpe: sd ? (mu / sd) * Math.sqrt(365) : 0,
    exposure: inDays / days, trades: trades.length, win: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0,
    avgLoss: trades.length - wins.length ? -trades.filter((x) => x <= 0).reduce((s, x) => s + x, 0) / (trades.length - wins.length) : 0
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    const d = loadBars(sym, '1d', dir);
    console.log(`\n### ${sym} ${args.from || 'all'} -> ${args.to || 'now'}\n`);
    console.log('| EMA | CAGR | B&H CAGR | max DD | B&H DD | Sharpe | exposure | trades | win % | avg win | avg loss |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const N of [10, 15, 20, 30, 50, 100, 200]) {
      const r = runFilter(d, N, from, to);
      console.log(`| ${N} | ${pct(r.cagr)} | ${pct(r.bhCagr)} | ${pct(r.dd)} | ${pct(r.bhDd)} | ${r.sharpe.toFixed(2)} | ${pct(r.exposure)} | ${r.trades} | ${pct(r.win)} | ${pct(r.avgWin)} | ${pct(r.avgLoss)} |`);
    }
  }
}
