// WP9 (Card 5.2) — MACD + OBV evidence. Registration: docs/research/harness/WP9_REGISTRATION.md
// (read that first; definitions here must match it exactly).
//
//   node scripts/research/edge/indicator-evidence.js
//
// H1: MACD(12,26,9) cross entries on 4h/1h perps (deep2y fixture) + a 4h spot long/flat variant
//     (var/edge/4h-long) vs the Card 1 SMA200 benchmark.
// H2: OBV-confirmed vs unconfirmed splits of the existing F1 4h Donchian breakout family
//     (var/edge/train-r1.json, read-only, not regenerated).
//
// Writes var/research/wp9/{h1.json,h2.json,REPORT.md}.
import fs from 'node:fs';
import { loadBars, macd, atr, obv, simulate, netR, stats, COSTS, lastClosedIdx } from './lib.js';

const H = 3600e3;
const HOLDOUT_START = Date.parse('2026-01-01T00:00:00Z');
const SYMBOLS = ['BTC', 'SOL', 'ETH'];
const ok = (...xs) => xs.every(Number.isFinite);

// ------------------------------------------------------------------ break-even (breakeven.js perTrade, reimplemented)
const BORROW_PER_H = 0.02;
const ACTUAL = { long: 0.20, short: 0.14 };
function perTrade(id, trades) {
  const t = trades.filter((x) => Number.isFinite(x.grossR) && x.riskPct > 0);
  if (!t.length) return { id, n: 0 };
  const sumG = t.reduce((s, x) => s + x.grossR, 0);
  const sumInv = t.reduce((s, x) => s + 1 / x.riskPct, 0);
  const sumB = t.reduce((s, x) => s + (BORROW_PER_H * x.hours) / x.riskPct, 0);
  const sumH = t.reduce((s, x) => s + x.hours / x.riskPct, 0);
  const longShare = t.filter((x) => x.dir === 'long').length / t.length;
  const actualRt = longShare * ACTUAL.long + (1 - longShare) * ACTUAL.short;
  return {
    id, n: t.length, grossR: sumG / t.length,
    beFree: sumG / sumInv, beBorrow: (sumG - sumB) / sumInv, actualRt,
    margin: (sumG - sumB) / sumInv / actualRt,
    maxBorrow: sumH > 0 ? (sumG - actualRt * sumInv) / sumH : null
  };
}

// ------------------------------------------------------------------ H1: MACD cross, perps (4h + 1h)
function macdCrossFamily(tf) {
  const trades = [];
  for (const sym of SYMBOLS) {
    const bars = { '5m': loadBars(sym, '5m'), [tf]: loadBars(sym, tf) };
    const b = bars[tf];
    const { macd: m, signal } = macd(b.c, 12, 26, 9);
    const a = atr(b, 14);
    const boundary = tf === '4h' ? 4 * H : H;
    const maxHoldH = tf === '4h' ? 60 * 24 : 20 * 24;
    let busyUntil = -Infinity;
    for (let i = 1; i < b.n; i++) {
      const tEntry = b.ct[i];
      if (tEntry < busyUntil) continue;
      if (!ok(m[i], signal[i], m[i - 1], signal[i - 1], a[i])) continue;
      const crossUp = m[i - 1] <= signal[i - 1] && m[i] > signal[i];
      const crossDn = m[i - 1] >= signal[i - 1] && m[i] < signal[i];
      const dir = crossUp ? 'long' : crossDn ? 'short' : null;
      if (!dir) continue;
      const risk = 1.5 * a[i];
      const stop = dir === 'long' ? b.c[i] - risk : b.c[i] + risk;
      const target = dir === 'long' ? b.c[i] + 2 * risk : b.c[i] - 2 * risk;
      const spec = {
        dir, stop, target, maxHoldH,
        exitAt(i5) {
          const p5 = bars['5m'];
          if (p5.ct[i5] % boundary !== 0) return false;
          const j = lastClosedIdx(b, p5.ct[i5]);
          if (j <= i || !Number.isFinite(m[j]) || !Number.isFinite(signal[j])) return false;
          return dir === 'long' ? m[j] <= signal[j] : m[j] >= signal[j];
        }
      };
      const tr = simulate(bars['5m'], { ...spec, entryTime: tEntry });
      if (!tr) continue;
      busyUntil = tr.exitTime;
      trades.push({ ...tr, sym, dir, netR: netR(tr, dir, COSTS.base) });
    }
  }
  return trades;
}

function summarize(id, trades, phase) {
  const t = trades.filter((x) => (phase === 'train' ? x.entryTime < HOLDOUT_START : x.entryTime >= HOLDOUT_START));
  const s = stats(t);
  const gross = stats(t, 'grossR').mean;
  const be = perTrade(id, t);
  return { id, phase, n: s.n, mean: s.mean, median: s.median, t: s.t, win: s.win, gross, ...be };
}

// ------------------------------------------------------------------ H1 spot variant: 4h MACD long/flat vs SMA200
function load4h(sym) {
  const c = JSON.parse(fs.readFileSync(`var/edge/4h-long/${sym}_4h.json`, 'utf8')).candles;
  return { n: c.length, t: c.map((x) => x.timestamp), o: c.map((x) => x.open), c: c.map((x) => x.close) };
}

// Same fill/cost convention as sma4h-trend.js:runSma4h (decide at close j-1, fill at open j, cost
// per switch), reimplemented for a MACD condition since runSma4h is hardcoded to an SMA signal.
function runMacdSpot(b, costPerSide, fromMs = -Infinity, toMs = Infinity) {
  const { macd: m, signal } = macd(b.c, 12, 26, 9);
  let inPos = false, eq = 1, bh = 1, bars = 0, switches = 0, entries = 0;
  let peak = 1, dd = 0;
  for (let j = 1; j < b.n; j++) {
    if (!Number.isFinite(m[j - 1]) || !Number.isFinite(signal[j - 1])) continue;
    const want = m[j - 1] > signal[j - 1];
    if (b.t[j] < fromMs) { inPos = want; continue; } // carry state into the window, no cost charged before it
    if (b.t[j] >= toMs) break;
    const bhFactor = b.c[j] / b.c[j - 1];
    let factor;
    if (want && inPos) factor = bhFactor;
    else if (want && !inPos) { factor = b.c[j] / b.o[j]; entries += 1; }
    else if (!want && inPos) factor = b.o[j] / b.c[j - 1];
    else factor = 1;
    if (want !== inPos) { factor *= 1 - costPerSide; switches += 1; }
    eq *= factor; bh *= bhFactor; inPos = want; bars += 1;
    peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
  }
  const yrs = (bars * 4) / (24 * 365);
  return { netCagr: yrs > 0 ? eq ** (1 / yrs) - 1 : 0, bhCagr: yrs > 0 ? bh ** (1 / yrs) - 1 : 0, switches, entries, maxDD: dd, bars };
}

// ------------------------------------------------------------------ H2: OBV confirmation of F1 4h Donchian breakouts
function seriesDonchian(x, n) {
  const hi = new Float64Array(x.length).fill(NaN), lo = new Float64Array(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) {
    let H_ = -Infinity, L_ = Infinity;
    for (let j = i - n; j < i; j++) { if (x[j] > H_) H_ = x[j]; if (x[j] < L_) L_ = x[j]; }
    hi[i] = H_; lo[i] = L_;
  }
  return { hi, lo };
}

function h2() {
  const raw = JSON.parse(fs.readFileSync('var/edge/train-r1.json', 'utf8'));
  const ids = ['F1-don-4h-N20-k2', 'F1-don-4h-N20-k2-reg', 'F1-don-4h-N20-k3', 'F1-don-4h-N20-k3-reg',
    'F1-don-4h-N55-k2', 'F1-don-4h-N55-k2-reg', 'F1-don-4h-N55-k3', 'F1-don-4h-N55-k3-reg'];
  const obvBySym = {};
  const barsBySym = {};
  for (const sym of SYMBOLS) {
    const b = loadBars(sym, '4h');
    const o = obv(b);
    const { hi, lo } = seriesDonchian(Array.from(o), 20);
    obvBySym[sym] = { o, hi, lo };
    barsBySym[sym] = b;
  }
  const rows = [];
  for (const id of ids) {
    const trades = (raw.trades[id] || []).filter((x) => x.entryTime < HOLDOUT_START);
    const tagged = trades.map((tr) => {
      const b = barsBySym[tr.sym];
      const j = lastClosedIdx(b, tr.entryTime);
      const { o, hi, lo } = obvBySym[tr.sym];
      let confirmed = null;
      if (j >= 0 && Number.isFinite(hi[j]) && Number.isFinite(lo[j])) {
        confirmed = tr.dir === 'long' ? o[j] > hi[j] : o[j] < lo[j];
      }
      return { ...tr, confirmed };
    });
    const groups = {
      all: tagged,
      confirmed: tagged.filter((x) => x.confirmed === true),
      unconfirmed: tagged.filter((x) => x.confirmed === false)
    };
    for (const [split, arr] of Object.entries(groups)) {
      const s = stats(arr);
      const gross = stats(arr, 'grossR').mean;
      const be = perTrade(`${id}/${split}`, arr);
      rows.push({ id, split, n: s.n, mean: s.mean, median: s.median, t: s.t, win: s.win, gross, ...be });
    }
  }
  return rows;
}

// ------------------------------------------------------------------ run
fs.mkdirSync('var/research/wp9', { recursive: true });

const h1Rows = [];
for (const tf of ['4h', '1h']) {
  const trades = macdCrossFamily(tf);
  h1Rows.push(summarize(`MACD-cross-${tf}-perps-all`, trades, 'train'));
  h1Rows.push(summarize(`MACD-cross-${tf}-perps-long`, trades.filter((t) => t.dir === 'long'), 'train'));
  h1Rows.push(summarize(`MACD-cross-${tf}-perps-short`, trades.filter((t) => t.dir === 'short'), 'train'));
  // Holdout only if train-phase "all" clears fees-with-borrow (margin > 1) — pre-registered rule.
  const trainAll = h1Rows[h1Rows.length - 3];
  if (trainAll.n >= 10 && trainAll.margin > 1) h1Rows.push(summarize(`MACD-cross-${tf}-perps-all`, trades, 'holdout'));
}

const spotRows = [];
for (const sym of SYMBOLS) {
  const b = load4h(sym);
  const train = runMacdSpot(b, 0.0015, -Infinity, HOLDOUT_START);
  const full = runMacdSpot(b, 0.0015);
  spotRows.push({ sym, trainNetCagr: train.netCagr, trainBhCagr: train.bhCagr, trainSwitches: train.switches, fullNetCagr: full.netCagr, fullBhCagr: full.bhCagr, fullSwitches: full.switches, fullMaxDD: full.maxDD });
}
// Card 1 SMA200 benchmark (net CAGR @0.15%, full history) for comparison, from
// docs/research/BREAKEVEN_COSTS_2026-09-27.md (already-generated, not recomputed here).
const SMA200_BENCH = { BTC: { net: 0.42, bh: 0.40 }, ETH: { net: 0.71, bh: 0.28 }, SOL: { net: 1.02, bh: 0.83 } };

const h2Rows = h2();

fs.writeFileSync('var/research/wp9/h1.json', JSON.stringify({ h1Rows, spotRows, SMA200_BENCH }, null, 1));
fs.writeFileSync('var/research/wp9/h2.json', JSON.stringify({ h2Rows }, null, 1));

// ------------------------------------------------------------------ console + markdown
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '-');

console.log('\n=== H1: MACD-cross perps (base costs: 0.20% long / 0.14% short RT + 0.02%/h borrow) ===\n');
console.log('| config | phase | n | win% | gross R | net R | t | margin | max borrow %/h |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of h1Rows) console.log(`| ${r.id} | ${r.phase} | ${r.n} | ${pct(r.win)} | ${f(r.gross)} | ${f(r.mean)} | ${f(r.t, 1)} | ${r.margin != null ? f(r.margin, 2) + 'x' : '-'} | ${r.maxBorrow == null ? '-' : f(r.maxBorrow, 4)} |`);

console.log('\n=== H1 spot: 4h MACD long/flat (0.15%/side) vs SMA200 benchmark ===\n');
console.log('| sym | MACD net CAGR (train) | B&H (train) | MACD net CAGR (full) | B&H (full) | switches (full) | maxDD (full) | SMA200 net CAGR (full, Card1) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of spotRows) console.log(`| ${r.sym} | ${pct(r.trainNetCagr)} | ${pct(r.trainBhCagr)} | ${pct(r.fullNetCagr)} | ${pct(r.fullBhCagr)} | ${r.fullSwitches} | ${pct(r.fullMaxDD)} | ${pct(SMA200_BENCH[r.sym].net)} |`);

console.log('\n=== H2: OBV confirmation of F1 4h Donchian breakouts (train phase, own-20-bar-Donchian OBV confirmation) ===\n');
console.log('| config | split | n | win% | gross R | net R | t | margin |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of h2Rows) console.log(`| ${r.id} | ${r.split} | ${r.n} | ${pct(r.win)} | ${f(r.gross)} | ${f(r.mean)} | ${f(r.t, 1)} | ${r.margin != null ? f(r.margin, 2) + 'x' : '-'} |`);
