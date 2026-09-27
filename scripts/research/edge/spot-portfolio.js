// Equal-thirds EMA20 spot trend portfolio, with optional vol targeting (docs/EDGE_SEARCH_2026-09-27.md).
//   node scripts/research/edge/spot-portfolio.js   (needs var/edge/daily-long/*_1d.json)
import { loadBars, ema } from './lib.js';
const C = 0.0015;
// Portfolio: equal thirds BTC/ETH/SOL (SOL from 2020-08, before that halves), EMA20 filter, optional vol target.
const load = s => loadBars(s, '1d', 'var/edge/daily-long');
const D = { BTC: load('BTC'), ETH: load('ETH'), SOL: load('SOL') };
function series(d, N, volTarget) {
  const e = ema(d.c, N); const out = new Map(); let w = 0;
  for (let i = 21; i < d.n; i++) {
    const r = d.c[i] / d.c[i-1] - 1;
    let ret = w * r;
    // new weight from close i
    let target = d.c[i] > e[i] ? 1 : 0;
    if (target && volTarget) { let s = 0; for (let j = i - 19; j <= i; j++) s += Math.log(d.c[j] / d.c[j-1]) ** 2; const vol = Math.sqrt(s / 20 * 365); target = Math.min(1, volTarget / vol); }
    ret -= Math.abs(target - w) * C; w = target;
    out.set(d.t[i], { ret, bh: r });
  }
  return out;
}
for (const vt of [null, 0.6, 0.4]) {
  const S = Object.fromEntries(Object.entries(D).map(([k, d]) => [k, series(d, 20, vt)]));
  const days = [...S.BTC.keys()].sort((a, b) => a - b);
  const byYear = {}; let eq = 1, bh = 1, pk = 1, dd = 0, bpk = 1, bdd = 0; const rs = [], brs = [];
  for (const t of days) {
    const legs = ['BTC', 'ETH', 'SOL'].map(k => S[k].get(t)).filter(Boolean);
    const r = legs.reduce((s, x) => s + x.ret, 0) / legs.length, b = legs.reduce((s, x) => s + x.bh, 0) / legs.length;
    eq *= 1 + r; bh *= 1 + b; rs.push(r); brs.push(b);
    pk = Math.max(pk, eq); dd = Math.max(dd, 1 - eq / pk); bpk = Math.max(bpk, bh); bdd = Math.max(bdd, 1 - bh / bpk);
    const y = new Date(t).getUTCFullYear(); byYear[y] ??= [1, 1]; byYear[y][0] *= 1 + r; byYear[y][1] *= 1 + b;
  }
  const sh = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); return (m / sd * Math.sqrt(365)).toFixed(2); };
  const yrs = days.length / 365;
  console.log(`\nEMA20 portfolio${vt ? `, vol target ${vt * 100}%` : ''}: CAGR ${((eq ** (1 / yrs) - 1) * 100).toFixed(0)}% (B&H ${((bh ** (1 / yrs) - 1) * 100).toFixed(0)}%), maxDD ${(dd * 100).toFixed(0)}% (B&H ${(bdd * 100).toFixed(0)}%), Sharpe ${sh(rs)} (B&H ${sh(brs)})`);
  console.log('  ' + Object.entries(byYear).map(([y, [a, b]]) => `${y}: ${((a - 1) * 100).toFixed(0)}% vs ${((b - 1) * 100).toFixed(0)}%`).join(' | '));
}
