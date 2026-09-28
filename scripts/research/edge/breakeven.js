// Break-even cost table (research only, docs/research/BREAKEVEN_COSTS_2026-09-27.md).
// For every strategy already studied, the all-in round-trip cost (fees + slippage, % of notional)
// at which its net result hits zero, next to what EditTrades actually pays.
//   node scripts/research/edge/breakeven.js [--main ../snapshot_tradingview]
// Sources (read-only): edge-search trades (var/edge/train-r1.json here, round 2 from --main),
// replay-rules calls (--main var/replay-rules), swing aggregates (docs/swing), 4h/1d candles.
import fs from 'node:fs';
import path from 'node:path';
import { runSma4h } from './sma4h-trend.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const MAIN = args.main || '../snapshot_tradingview';
const BORROW_PER_H = Number(args.borrow ?? 0.02); // % per hour; 0.02 = old doc-based proxy, measured 2026-09-27 ≈ 0.0015 (WP6)
const ACTUAL = { long: 0.20, short: 0.14, spotPerSide: 0.15 }; // % round trip (perps), % per side (spot)

// Per-trade R data: netR_i = grossR_i - (c + b*h_i) / risk_i  =>  c* = (sum grossR - sum b*h/risk) / sum 1/risk
function perTrade(id, source, trades) {
  const t = trades.filter((x) => Number.isFinite(x.grossR) && x.riskPct > 0);
  if (!t.length) return null;
  const sumG = t.reduce((s, x) => s + x.grossR, 0);
  const sumInv = t.reduce((s, x) => s + 1 / x.riskPct, 0);
  const sumB = t.reduce((s, x) => s + (BORROW_PER_H * x.hours) / x.riskPct, 0);
  const sumH = t.reduce((s, x) => s + x.hours / x.riskPct, 0);
  const longShare = t.filter((x) => x.dir === 'long').length / t.length;
  const actualRt = longShare * ACTUAL.long + (1 - longShare) * ACTUAL.short;
  const medRisk = [...t].sort((a, b) => a.riskPct - b.riskPct)[Math.floor(t.length / 2)].riskPct;
  return {
    id, source, n: t.length, grossR: sumG / t.length, medStopPct: medRisk,
    beFree: sumG / sumInv, // break-even round trip with zero borrow
    beBorrow: (sumG - sumB) / sumInv, // break-even round trip with 0.02%/h borrow on the actual holds
    actualRt, exact: true,
    maxBorrow: sumH > 0 ? (sumG - actualRt * sumInv) / sumH : null // %/h at which net R = 0 given actual fees
  };
}

const rows = [];

// 1. Edge-search families (round 1 regenerated here, round 2 from the main checkout).
for (const f of ['var/edge/train-r1.json', path.join(MAIN, 'var/edge/train.json')]) {
  if (!fs.existsSync(f)) { console.error(`skip missing ${f}`); continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [id, tr] of Object.entries(d.trades)) {
    const r = perTrade(id, 'edge-search (2y, train)', tr.map((x) => ({ grossR: x.grossR, riskPct: x.riskPct, hours: x.hours, dir: x.dir })));
    if (r) rows.push(r);
  }
}

// 2. Replay-rules engine variants (per call, 1m/3m/5m candles).
const tfMin = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60 };
const rrDir = path.join(MAIN, 'var/replay-rules');
if (fs.existsSync(rrDir)) {
  for (const f of fs.readdirSync(rrDir).filter((x) => x.endsWith('.calls.jsonl'))) {
    const calls = fs.readFileSync(path.join(rrDir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const r = perTrade(f.replace('.calls.jsonl', ''), 'engine replay variant (15d)', calls.map((c) => ({
      grossR: c.grossR, riskPct: c.stopDistancePct, hours: ((c.holdCandles || 0) * (tfMin[c.timeframe] || 1)) / 60, dir: c.direction
    })));
    if (r) rows.push(r);
  }
}

// 3. Swing rules (aggregates only: c* ~ grossExpR x medianStop - borrow x medianHold; approximate).
for (const f of fs.readdirSync('docs/swing').filter((x) => x.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join('docs/swing', f), 'utf8'));
  const s = d.combined?.stats;
  if (!s || !s.resolved || !Number.isFinite(s.grossExpR)) continue;
  rows.push({
    id: d.meta?.id || f.replace('.json', ''), source: 'swing study (85d, aggregate)', n: s.resolved, grossR: s.grossExpR, medStopPct: s.medianStopPct,
    beFree: s.grossExpR * s.medianStopPct, beBorrow: s.grossExpR * s.medianStopPct - BORROW_PER_H * (s.medianHoldHours || 0),
    actualRt: ACTUAL.long, exact: false,
    maxBorrow: s.medianHoldHours > 0 ? (s.grossExpR * s.medianStopPct - ACTUAL.long) / s.medianHoldHours : null
  });
}

// 4. Spot long/flat trend rules: per-side cost where net CAGR = 0 and where net CAGR = B&H CAGR.
const load4h = (sym) => {
  const c = JSON.parse(fs.readFileSync(`var/edge/4h-long/${sym}_4h.json`, 'utf8')).candles;
  return { n: c.length, t: c.map((x) => x.timestamp), o: c.map((x) => x.open), h: c.map((x) => x.high), l: c.map((x) => x.low), c: c.map((x) => x.close) };
};
const daily = (sym) => {
  const c = JSON.parse(fs.readFileSync(`var/edge/daily-long/${sym}_1d.json`, 'utf8')).candles;
  return { n: c.length, t: c.map((x) => x.timestamp), o: c.map((x) => x.open), h: c.map((x) => x.high), l: c.map((x) => x.low), c: c.map((x) => x.close) };
};
// Daily EMA20 long/cash with next-open fill (same engine as runSma4h, EMA instead of SMA): reuse runSma4h by
// passing an SMA-free series is not possible, so a small local loop mirrors spot-trend.js semantics.
function runEmaDaily(b, n, costPerSide) {
  const k = 2 / (n + 1); const e = []; let prev = null;
  for (let i = 0; i < b.n; i++) { prev = i < n - 1 ? null : prev == null ? b.c.slice(0, n).reduce((s, x) => s + x, 0) / n : b.c[i] * k + prev * (1 - k); e.push(prev); }
  let eq = 1, bh = 1, inPos = false, days = 0;
  for (let j = n + 1; j < b.n; j++) {
    const want = b.c[j - 1] > e[j - 1];
    let f = 1;
    if (want && inPos) f = b.c[j] / b.c[j - 1];
    else if (want && !inPos) f = (b.c[j] / b.o[j]) * (1 - costPerSide);
    else if (!want && inPos) f = (b.o[j] / b.c[j - 1]) * (1 - costPerSide);
    eq *= f; bh *= b.c[j] / b.c[j - 1]; inPos = want; days++;
  }
  const yrs = days / 365;
  return { netCagr: eq ** (1 / yrs) - 1, bhCagr: bh ** (1 / yrs) - 1 };
}
function solve(fn, target) { // per-side cost in fraction where fn(c) = target; fn decreasing in c
  let lo = 0, hi = 0.2;
  if (fn(lo) < target) return -1; // fails even at zero cost
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fn(m) >= target) lo = m; else hi = m; }
  return lo;
}
const spot = [];
for (const sym of ['BTC', 'ETH', 'SOL']) {
  const b4 = load4h(sym); const bd = daily(sym);
  for (const [id, fn] of [
    ['4h SMA200 (Card 1)', (c) => runSma4h(b4, { n: 200, costPerSide: c })],
    ['4h SMA840 ≈ 20-week (Card 4)', (c) => runSma4h(b4, { n: 840, costPerSide: c })],
    ['daily EMA20 (live spot tracker)', (c) => runEmaDaily(bd, 20, c)]
  ]) {
    const base = fn(ACTUAL.spotPerSide / 100);
    const r0 = fn(0);
    spot.push({
      sym, id, grossCagr: r0.netCagr, netCagr: base.netCagr, bhCagr: base.bhCagr,
      beZero: solve((c) => fn(c).netCagr, 0), beHold: solve((c) => fn(c).netCagr, fn(0).bhCagr)
    });
  }
}

// Output
const verdict = (r) => (r.beFree <= 0 ? 'no gross edge' : r.beFree < r.actualRt ? 'fees kill' : r.beBorrow < r.actualRt ? 'borrow kills' : r.n < 30 ? 'survives (n<30)' : 'survives');
const p = (x, d = 2) => (x == null ? '—' : `${x.toFixed(d)}%`);
rows.sort((a, b) => (b.beBorrow / b.actualRt) - (a.beBorrow / a.actualRt));
const out = [];
out.push('## Perps / trade-level strategies — break-even round trip vs actual\n');
out.push(`Break-even = all-in round-trip fees + slippage (% of notional) at which mean net R = 0. “with borrow” also charges ${BORROW_PER_H}%/h on each trade's actual hold. Actual = ${ACTUAL.long}% long / ${ACTUAL.short}% short round trip, weighted by the strategy's side mix. Margin = break-even with borrow ÷ actual; > 1 survives. Max borrow = hourly borrow at which net R = 0 given actual fees (Jupiter docs ≈ 0.024%/h). “≈” rows use aggregate grossExpR × median stop (approximate). Verdict: *no gross edge* = negative before any cost; *borrow kills* = positive with fees only, negative once borrow is charged.\n`);
out.push('| rank | strategy | source | n | gross R/trade | median stop | break-even (no borrow) | break-even (with borrow) | actual | margin | max borrow %/h | verdict |');
out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
rows.forEach((r, i) => out.push(`| ${i + 1} | ${r.id} | ${r.source}${r.exact ? '' : ' ≈'} | ${r.n} | ${r.grossR.toFixed(3)} | ${p(r.medStopPct)} | ${p(r.beFree, 3)} | ${p(r.beBorrow, 3)} | ${p(r.actualRt)} | ${r.beBorrow > 0 ? (r.beBorrow / r.actualRt).toFixed(2) + '×' : '—'} | ${r.maxBorrow == null ? '—' : r.maxBorrow <= 0 ? '0' : r.maxBorrow.toFixed(4)} | ${verdict(r)} |`));
out.push('\n## Spot long/flat trend rules — break-even per side vs actual 0.15%/side\n');
out.push('| symbol | rule | gross CAGR | net CAGR @0.15% | B&H CAGR | break-even per side (net = 0) | break-even per side (net = B&H) |');
out.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const s of spot) out.push(`| ${s.sym} | ${s.id} | ${p(s.grossCagr * 100, 0)} | ${p(s.netCagr * 100, 0)} | ${p(s.bhCagr * 100, 0)} | ${s.beZero < 0 ? 'none' : p(s.beZero * 100)} | ${s.beHold < 0 ? 'never beats B&H' : p(s.beHold * 100)} |`);
const md = out.join('\n');
const outDir = `var/research/breakeven${args.borrow ? `-b${args.borrow}` : ''}`;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/REPORT.md`, `${md}\n`);
fs.writeFileSync(`${outDir}/rows.json`, JSON.stringify({ perps: rows, spot }, null, 1));
console.log(md);
