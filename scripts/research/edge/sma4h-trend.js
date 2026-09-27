// EXTERNAL_4H_SMA200_V1 (research only, docs/research/EXTERNAL_4H_SMA200_STATUS.md — frozen
// registration, read that first). 4H spot long/cash filter: hold while close > SMA200(close),
// else cash. Decided on a closed bar's close, filled at the NEXT bar's open (not next close).
// No shorts, no stops, no TP, single position.
//
//   node scripts/research/edge/sma4h-trend.js [--out var/research/external-4h-sma200]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, sma, ema } from './lib.js';
import { runFilter } from './spot-trend.js';

const ANNUALIZE_4H = Math.sqrt(6 * 365); // 6 four-hour bars/day
const MS_DAY = 24 * 3600e3;

/** Same typed-array shape as lib.js loadBars(), built from an in-memory candle array (for tests/fixtures). */
export function barsFromCandles(candles) {
  const n = candles.length;
  const b = { n, t: new Float64Array(n), ct: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  for (let i = 0; i < n; i += 1) {
    const k = candles[i];
    b.t[i] = k.timestamp; b.ct[i] = k.closeTime ?? k.timestamp; b.o[i] = k.open; b.h[i] = k.high ?? Math.max(k.open, k.close); b.l[i] = k.low ?? Math.min(k.open, k.close); b.c[i] = k.close; b.v[i] = k.volume ?? 0;
  }
  return b;
}

// ---------------------------------------------------------------------- core backtest

/**
 * Pure backtest. Signal computed and position state carried across FULL history regardless
 * of [fromMs,toMs) (so a windowed run doesn't get artificially reset to flat at the window
 * boundary); only the reported series/stats are re-based to 1.0 at the window's first bar.
 *
 * @param {ReturnType<typeof loadBars>} bars
 * @param {{n?:number, costPerSide?:number, borrowPerHour?:number, fromMs?:number, toMs?:number}} opts
 */
export function runSma4h(bars, opts = {}) {
  const { n = 200, costPerSide = 0, borrowPerHour = 0, fromMs = -Infinity, toMs = Infinity } = opts;
  const smaArr = sma(bars.c, n);

  let inPos = false; // position held through the bar just finished processing
  let eq = 1;
  let windowStartEq = null, windowStartBh = null;
  let bh = 1;
  let peak = null, dd = 0, bpeak = null, bdd = 0;
  let entries = 0, exits = 0, switches = 0;
  let inBars = 0, totalBars = 0;
  let tradeEntryIdx = null, tradeEntryEq = null;
  let lastHighIdx = null, maxFlatBars = 0;
  const rets = [], trades = [], series = [];

  for (let j = 1; j < bars.n; j += 1) {
    if (!Number.isFinite(smaArr[j - 1])) { inPos = false; continue; } // warm-up: no decision yet from bar j-1's close

    const currTarget = bars.c[j - 1] > smaArr[j - 1]; // decision at close of bar j-1, filled at open of bar j
    const bhFactor = bars.c[j] / bars.c[j - 1];

    let barFactor;
    if (currTarget && inPos) barFactor = bhFactor; // continuing long
    else if (currTarget && !inPos) barFactor = bars.c[j] / bars.o[j]; // entry bar
    else if (!currTarget && inPos) barFactor = bars.o[j] / bars.c[j - 1]; // exit bar, then flat
    else barFactor = 1; // continuing flat

    const switched = currTarget !== inPos;
    const inWindow = bars.t[j] >= fromMs && bars.t[j] < toMs; // counters and trades only count in-window switches
    const before = eq;
    eq *= barFactor;
    if (currTarget) eq *= 1 - borrowPerHour * 4; // borrow on the 4h this bar was held (entry+continuing bars only; see doc)
    if (switched) {
      eq *= 1 - costPerSide;
      if (inWindow) switches += 1;
      if (currTarget) {
        if (inWindow) entries += 1;
        tradeEntryIdx = j; tradeEntryEq = before;
      } else {
        if (inWindow) exits += 1;
        if (tradeEntryIdx != null) {
          if (inWindow) trades.push(makeTrade(bars, tradeEntryIdx, j, tradeEntryEq, eq));
          tradeEntryIdx = null; tradeEntryEq = null;
        }
      }
    }
    bh *= bhFactor;

    if (inWindow) {
      if (windowStartEq == null) { windowStartEq = before; windowStartBh = bh / bhFactor; peak = before; bpeak = windowStartBh; lastHighIdx = j - 1; }
      totalBars += 1;
      if (currTarget) inBars += 1;
      rets.push(eq / before - 1);
      peak = Math.max(peak, eq); dd = 1 - eq / peak;
      bpeak = Math.max(bpeak, bh); bdd = 1 - bh / bpeak;
      if (eq >= peak - 1e-12) { maxFlatBars = Math.max(maxFlatBars, j - lastHighIdx); lastHighIdx = j; }
      series.push({ t: bars.t[j], close: bars.c[j], sma: smaArr[j], position: currTarget, eqNet: eq / windowStartEq, eqBh: bh / windowStartBh, dd, bhDd: bdd });
    }
    inPos = currTarget;
  }

  // Position still open at the end of data/window: mark it closed at the last bar for reporting.
  if (tradeEntryIdx != null && series.length) {
    const lastIdx = bars.n - 1;
    trades.push({ ...makeTrade(bars, tradeEntryIdx, lastIdx, tradeEntryEq, eq), open: true });
  }

  if (!series.length) {
    return { n, costPerSide, borrowPerHour, bars: 0, netCagr: 0, bhCagr: 0, sharpe: 0, sortino: 0, maxDD: 0, bhMaxDD: 0, calmar: 0, entries: 0, exits: 0, switches: 0, exposure: 0, avgHoldDays: 0, medianHoldDays: 0, turnoverPerYear: 0, maxFlatDays: 0, trades: [], series: [] };
  }

  const yrs = (totalBars * 4) / (24 * 365);
  const netEnd = series[series.length - 1].eqNet, bhEnd = series[series.length - 1].eqBh;
  const netCagr = netEnd ** (1 / yrs) - 1;
  const bhCagr = bhEnd ** (1 / yrs) - 1;
  const maxDD = Math.max(...series.map((s) => s.dd));
  const bhMaxDD = Math.max(...series.map((s) => s.bhDd));
  const closedTrades = trades.filter((t) => !t.open);
  const holdDaysArr = closedTrades.map((t) => t.holdDays).sort((a, b) => a - b);
  const wins = closedTrades.filter((t) => t.ret > 0);
  const losses = closedTrades.filter((t) => t.ret <= 0);

  return {
    n, costPerSide, borrowPerHour, bars: totalBars,
    netCagr, bhCagr,
    sharpe: sharpeOf(rets), sortino: sortinoOf(rets),
    maxDD, bhMaxDD, calmar: maxDD > 0 ? netCagr / maxDD : null,
    entries, exits, switches, exposure: inBars / totalBars,
    avgHoldDays: holdDaysArr.length ? holdDaysArr.reduce((a, b) => a + b, 0) / holdDaysArr.length : 0,
    medianHoldDays: holdDaysArr.length ? holdDaysArr[holdDaysArr.length >> 1] : 0,
    turnoverPerYear: switches / yrs,
    maxFlatDays: (maxFlatBars * 4) / 24,
    trades, win: closedTrades.length ? wins.length / closedTrades.length : 0,
    avgWin: wins.length ? wins.reduce((a, b) => a + b.ret, 0) / wins.length : 0,
    avgLoss: losses.length ? -losses.reduce((a, b) => a + b.ret, 0) / losses.length : 0,
    series
  };
}

function makeTrade(bars, entryIdx, exitIdx, entryEq, exitEq) {
  return {
    entryTime: new Date(bars.t[entryIdx]).toISOString(), exitTime: new Date(bars.t[exitIdx]).toISOString(),
    entryPrice: bars.o[entryIdx], exitPrice: bars.o[exitIdx], holdDays: ((exitIdx - entryIdx) * 4) / 24,
    ret: exitEq / entryEq - 1
  };
}

function sharpeOf(rets) {
  if (!rets.length) return 0;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / rets.length);
  return sd ? (mu / sd) * ANNUALIZE_4H : 0;
}

function sortinoOf(rets) {
  if (!rets.length) return 0;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const downside = rets.filter((x) => x < 0);
  if (!downside.length) return 0;
  const dsd = Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / rets.length);
  return dsd ? (mu / dsd) * ANNUALIZE_4H : 0;
}

// ---------------------------------------------------------------------- year / attribution / regime

export function perYear(series) {
  const byYear = new Map();
  let prevStratEq = 1, prevBhEq = 1, prevYear = null;
  for (const s of series) {
    const y = new Date(s.t).getUTCFullYear();
    if (y !== prevYear) {
      if (prevYear != null) byYear.get(prevYear).stratEndEq = prevStratEq, byYear.get(prevYear).bhEndEq = prevBhEq;
      byYear.set(y, { stratStartEq: prevStratEq, bhStartEq: prevBhEq, stratEndEq: null, bhEndEq: null });
      prevYear = y;
    }
    prevStratEq = s.eqNet; prevBhEq = s.eqBh;
  }
  if (prevYear != null) byYear.get(prevYear).stratEndEq = prevStratEq, byYear.get(prevYear).bhEndEq = prevBhEq;
  const out = {};
  for (const [y, v] of byYear) out[y] = { stratRet: v.stratEndEq / v.stratStartEq - 1, bhRet: v.bhEndEq / v.bhStartEq - 1 };
  return out;
}

/** Q9: split B&H log return into bars where the strategy is long vs flat. */
export function attribution(series) {
  let capturedLog = 0, avoidedLog = 0;
  for (let i = 1; i < series.length; i += 1) {
    const r = Math.log(series[i].eqBh / series[i - 1].eqBh);
    if (series[i].position) capturedLog += r; else avoidedLog += r;
  }
  return { capturedLog, avoidedLog, capturedPct: Math.exp(capturedLog) - 1, avoidedPct: Math.exp(avoidedLog) - 1, totalLog: capturedLog + avoidedLog };
}

const TREND_BUCKETS = [
  { label: 'strong bull (>+30%/90d)', test: (r) => r > 0.30 },
  { label: 'moderate bull (0..30%/90d)', test: (r) => r > 0 && r <= 0.30 },
  { label: 'sideways (-20..0%/90d)', test: (r) => r > -0.20 && r <= 0 },
  { label: 'bear (<-20%/90d)', test: (r) => r <= -0.20 }
];

/** Trailing 90-day (540-bar) B&H return regime, trailing only. */
export function regimeByTrend(bars, series) {
  const idxByT = new Map(); for (let i = 0; i < bars.n; i += 1) idxByT.set(bars.t[i], i);
  const buckets = TREND_BUCKETS.map((b) => ({ ...b, stratSum: 0, bhSum: 0, nLong: 0, n: 0 }));
  for (let k = 1; k < series.length; k += 1) {
    const i = idxByT.get(series[k].t);
    if (i == null || i < 540) continue;
    const r90 = bars.c[i] / bars.c[i - 540] - 1;
    const b = buckets.find((x) => x.test(r90));
    if (!b) continue;
    b.n += 1; if (series[k].position) b.nLong += 1;
    b.stratSum += series[k].eqNet / series[k - 1].eqNet - 1;
    b.bhSum += series[k].eqBh / series[k - 1].eqBh - 1;
  }
  return buckets.map((b) => ({ label: b.label, n: b.n, exposure: b.n ? b.nLong / b.n : 0, stratMeanRet: b.n ? b.stratSum / b.n : 0, bhMeanRet: b.n ? b.bhSum / b.n : 0 }));
}

/** Trailing 30-day (180-bar) realized-vol terciles; cut points from the full sample (descriptive). */
export function regimeByVol(bars, series) {
  const logRet = new Float64Array(bars.n).fill(NaN);
  for (let i = 1; i < bars.n; i += 1) logRet[i] = Math.log(bars.c[i] / bars.c[i - 1]);
  const vol = new Float64Array(bars.n).fill(NaN);
  for (let i = 180; i < bars.n; i += 1) {
    let s = 0, sq = 0;
    for (let j = i - 179; j <= i; j += 1) { s += logRet[j]; sq += logRet[j] * logRet[j]; }
    const m = s / 180;
    vol[i] = Math.sqrt(sq / 180 - m * m);
  }
  const sample = [...vol].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sample.length) return [];
  const t1 = sample[Math.floor(sample.length / 3)], t2 = sample[Math.floor((2 * sample.length) / 3)];
  const idxByT = new Map(); for (let i = 0; i < bars.n; i += 1) idxByT.set(bars.t[i], i);
  const labels = ['T1 low vol (trailing 30d)', 'T2 mid vol (trailing 30d)', 'T3 high vol (trailing 30d)'];
  const buckets = labels.map((label) => ({ label, stratSum: 0, bhSum: 0, nLong: 0, n: 0 }));
  for (let k = 1; k < series.length; k += 1) {
    const i = idxByT.get(series[k].t);
    if (i == null || !Number.isFinite(vol[i])) continue;
    const bi = vol[i] <= t1 ? 0 : vol[i] <= t2 ? 1 : 2;
    const b = buckets[bi];
    b.n += 1; if (series[k].position) b.nLong += 1;
    b.stratSum += series[k].eqNet / series[k - 1].eqNet - 1;
    b.bhSum += series[k].eqBh / series[k - 1].eqBh - 1;
  }
  return buckets.map((b) => ({ label: b.label, n: b.n, exposure: b.n ? b.nLong / b.n : 0, stratMeanRet: b.n ? b.stratSum / b.n : 0, bhMeanRet: b.n ? b.bhSum / b.n : 0 }));
}

// ---------------------------------------------------------------------- daily overlap vs EMA20 baseline

/** Local re-derivation of spot-trend.js's own signal (`c[i] > EMA(N)[i]`) for the overlap table only — does not modify spot-trend.js. */
function dailyEmaPosition(d, nEma = 20) {
  const e = ema(d.c, nEma);
  const out = new Map();
  for (let i = 0; i < d.n; i += 1) out.set(d.t[i], Number.isFinite(e[i]) ? d.c[i] > e[i] : false);
  return out;
}

/** SMA4h position as-of the last 4h bar of each UTC day. */
function dailySma4hPosition(series) {
  const out = new Map();
  for (const s of series) {
    const day = Math.floor(s.t / MS_DAY) * MS_DAY;
    out.set(day, s.position); // series is time-ordered, so the last write per day wins
  }
  return out;
}

export function overlapTable(dailyBars, series) {
  const emaPos = dailyEmaPosition(dailyBars, 20);
  const smaPos = dailySma4hPosition(series);
  const groups = { both: { n: 0, fwd: [] }, smaOnly: { n: 0, fwd: [] }, emaOnly: { n: 0, fwd: [] }, neither: { n: 0, fwd: [] } };
  for (let i = 0; i < dailyBars.n - 1; i += 1) {
    const day = dailyBars.t[i];
    const sma4hLong = smaPos.get(day);
    const emaLong = emaPos.get(day);
    if (sma4hLong == null || emaLong == null) continue;
    const fwdRet = dailyBars.c[i + 1] / dailyBars.c[i] - 1;
    const g = sma4hLong && emaLong ? 'both' : sma4hLong && !emaLong ? 'smaOnly' : !sma4hLong && emaLong ? 'emaOnly' : 'neither';
    groups[g].n += 1; groups[g].fwd.push(fwdRet);
  }
  const total = Object.values(groups).reduce((a, g) => a + g.n, 0);
  const out = {};
  for (const [k, v] of Object.entries(groups)) out[k] = { days: v.n, fraction: total ? v.n / total : 0, fwdMeanRet: v.fwd.length ? v.fwd.reduce((a, b) => a + b, 0) / v.fwd.length : 0 };
  return out;
}

// ---------------------------------------------------------------------- CLI

function pct(x) { return x == null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(2)}%`; }
function num(x, d = 2) { return x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d); }

const SCENARIOS = {
  S1_frictionless: { costPerSide: 0, borrowPerHour: 0 },
  S2_spot_fee: { costPerSide: 0.0010, borrowPerHour: 0 },
  S3_edittrades_spot: { costPerSide: 0.0015, borrowPerHour: 0 },
  S4a_perp_proxy_borrow01: { costPerSide: 0.0017, borrowPerHour: 0.0001 },
  S4b_perp_proxy_borrow024: { costPerSide: 0.0017, borrowPerHour: 0.00024 }
};

function main(outDir) {
  const symbols = ['BTC', 'ETH', 'SOL'];
  const barsBySym = Object.fromEntries(symbols.map((s) => [s, loadBars(s, '4h', 'var/edge/4h-long')]));
  const N = 200;

  // Warm-up-eligible start per symbol (first bar with a valid decision), for window (a).
  const eligibleStart = {};
  for (const s of symbols) {
    const sm = sma(barsBySym[s].c, N);
    let idx = -1;
    for (let i = 1; i < barsBySym[s].n; i += 1) if (Number.isFinite(sm[i - 1])) { idx = i; break; }
    eligibleStart[s] = idx >= 0 ? barsBySym[s].t[idx] : Infinity;
  }
  const commonFromMs = Math.max(eligibleStart.SOL, eligibleStart.BTC, eligibleStart.ETH);
  const windows = { a_full_history: null, b_common_window: { fromMs: commonFromMs, toMs: Infinity } };

  const commands = [
    'node scripts/research/edge/fetch-4h-long.js --symbols BTC,ETH,SOL --interval 4h --out var/edge/4h-long',
    'node scripts/research/edge/fetch-4h-long.js --symbols BTC,ETH,SOL --interval 1d --out var/edge/daily-long',
    'node scripts/research/edge/sma4h-trend.js --out var/research/external-4h-sma200',
    'npm run test:sma4h'
  ];
  writeFileSync(path.join(outDir, 'commands.txt'), `${commands.join('\n')}\n`);

  const summary = { generatedAt: new Date().toISOString(), n: N, scenarios: SCENARIOS, windows: { a_full_history: 'per-symbol, from first eligible bar to now', b_common_window: { fromMs: commonFromMs, fromIso: new Date(commonFromMs).toISOString() } }, bySymbol: {} };
  const tradesJsonl = [];
  const equityRows = ['time,symbol,close,sma200,position,strat_equity,bh_equity,strat_dd,bh_dd'];
  const fullHistoryS3 = {}; // sym -> runSma4h() result at S3, window (a) — reused for charts.html

  for (const sym of symbols) {
    const bars = barsBySym[sym];
    summary.bySymbol[sym] = { windows: {} };
    for (const [winName, win] of Object.entries(windows)) {
      const fromMs = win ? win.fromMs : -Infinity;
      const toMs = win ? win.toMs : Infinity;
      const winOut = { scenarios: {} };
      const gross = runSma4h(bars, { n: N, costPerSide: 0, borrowPerHour: 0, fromMs, toMs });
      for (const [scName, sc] of Object.entries(SCENARIOS)) {
        const r = runSma4h(bars, { n: N, ...sc, fromMs, toMs });
        winOut.scenarios[scName] = {
          netCagr: r.netCagr, grossCagr: gross.netCagr, costDrag: gross.netCagr - r.netCagr,
          bhCagr: r.bhCagr, sharpe: r.sharpe, sortino: r.sortino, maxDD: r.maxDD, bhMaxDD: r.bhMaxDD, calmar: r.calmar,
          entries: r.entries, exits: r.exits, switches: r.switches, exposure: r.exposure,
          avgHoldDays: r.avgHoldDays, medianHoldDays: r.medianHoldDays, turnoverPerYear: r.turnoverPerYear,
          maxFlatDays: r.maxFlatDays, win: r.win, avgWin: r.avgWin, avgLoss: r.avgLoss, bars: r.bars,
          perYear: perYear(r.series)
        };
        if (scName === 'S3_edittrades_spot') {
          winOut.attribution = attribution(r.series);
          winOut.regimeByTrend = regimeByTrend(bars, r.series);
          winOut.regimeByVol = regimeByVol(bars, r.series);
          if (winName === 'a_full_history') {
            fullHistoryS3[sym] = r;
            for (const t of r.trades) tradesJsonl.push(JSON.stringify({ symbol: sym, window: winName, scenario: scName, ...t }));
            for (const s of downsampleDaily(r.series)) equityRows.push([new Date(s.t).toISOString(), sym, s.close, s.sma, s.position ? 1 : 0, s.eqNet.toFixed(6), s.eqBh.toFixed(6), s.dd.toFixed(6), s.bhDd.toFixed(6)].join(','));
          }
        }
      }
      summary.bySymbol[sym].windows[winName] = winOut;
    }
  }

  // Sensitivity: N sweep at S3, full-history window, all three symbols.
  summary.sensitivity = {};
  for (const sym of symbols) {
    summary.sensitivity[sym] = [125, 150, 175, 200, 225, 250, 300].map((n) => {
      const r = runSma4h(barsBySym[sym], { n, ...SCENARIOS.S3_edittrades_spot, fromMs: -Infinity, toMs: Infinity });
      return { n, netCagr: r.netCagr, sharpe: r.sharpe, maxDD: r.maxDD, trades: r.entries };
    });
  }

  // Baseline C: existing daily EMA20 spot filter (unmodified spot-trend.js), same windows.
  summary.baselineC = {};
  const dailyBySym = Object.fromEntries(symbols.map((s) => [s, loadBars(s, '1d', 'var/edge/daily-long')]));
  for (const sym of symbols) {
    const d = dailyBySym[sym];
    summary.baselineC[sym] = {
      a_full_history: runFilter(d, 20, -Infinity, Infinity),
      b_common_window: runFilter(d, 20, commonFromMs, Infinity)
    };
  }
  // Overlap table vs EMA20, full-history window, S3 series.
  summary.overlap = {};
  for (const sym of symbols) {
    const r = runSma4h(barsBySym[sym], { n: N, ...SCENARIOS.S3_edittrades_spot, fromMs: -Infinity, toMs: Infinity });
    summary.overlap[sym] = overlapTable(dailyBySym[sym], r.series);
  }

  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'trades.jsonl'), `${tradesJsonl.join('\n')}\n`);
  writeFileSync(path.join(outDir, 'equity.csv'), `${equityRows.join('\n')}\n`);
  writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(summary));
  writeFileSync(path.join(outDir, 'charts.html'), buildChartsHtml(summary, fullHistoryS3));
  console.log(`[sma4h-trend] wrote ${outDir}/{summary.json,trades.jsonl,equity.csv,REPORT.md,commands.txt,charts.html}`);
}

function downsampleDaily(series) {
  const byDay = new Map();
  for (const s of series) byDay.set(Math.floor(s.t / MS_DAY), s); // last bar of the day wins
  return [...byDay.values()].sort((a, b) => a.t - b.t);
}

function renderReport(summary) {
  const lines = [];
  lines.push('# EXTERNAL_4H_SMA200_V1 — results (research only)');
  lines.push('');
  lines.push(`Generated ${summary.generatedAt}. N=${summary.n}. See docs/research/EXTERNAL_4H_SMA200_STATUS.md for the frozen registration.`);
  lines.push('');
  for (const sym of Object.keys(summary.bySymbol)) {
    lines.push(`## ${sym}`);
    for (const [winName, win] of Object.entries(summary.bySymbol[sym].windows)) {
      lines.push(`### ${sym} — ${winName}`);
      lines.push('');
      lines.push('| scenario | net CAGR | gross CAGR | cost drag | B&H CAGR | Sharpe | Sortino | maxDD | B&H maxDD | Calmar | trades(entries) | exposure | avg hold(d) | turnover/yr | win% |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const [scName, s] of Object.entries(win.scenarios)) {
        lines.push(`| ${scName} | ${pct(s.netCagr)} | ${pct(s.grossCagr)} | ${pct(s.costDrag)} | ${pct(s.bhCagr)} | ${num(s.sharpe)} | ${num(s.sortino)} | ${pct(s.maxDD)} | ${pct(s.bhMaxDD)} | ${num(s.calmar)} | ${s.entries} | ${pct(s.exposure)} | ${num(s.avgHoldDays, 1)} | ${num(s.turnoverPerYear, 1)} | ${pct(s.win)} |`);
      }
      lines.push('');
      lines.push(`Attribution (Q9, S3, ${winName}): B&H log return captured while long = ${num(win.attribution.capturedLog, 4)} (${pct(win.attribution.capturedPct)}); avoided while flat = ${num(win.attribution.avoidedLog, 4)} (${pct(win.attribution.avoidedPct)}).`);
      lines.push('');
      lines.push(`Regime by trailing 90d B&H return (S3, ${winName}):`);
      lines.push('| regime | n bars | exposure | strategy mean 4h ret | B&H mean 4h ret |');
      lines.push('|---|---|---|---|---|');
      for (const b of win.regimeByTrend) lines.push(`| ${b.label} | ${b.n} | ${pct(b.exposure)} | ${(b.stratMeanRet * 100).toFixed(4)}% | ${(b.bhMeanRet * 100).toFixed(4)}% |`);
      lines.push('');
      lines.push(`Regime by trailing 30d realized-vol tercile (S3, ${winName}, descriptive):`);
      lines.push('| regime | n bars | exposure | strategy mean 4h ret | B&H mean 4h ret |');
      lines.push('|---|---|---|---|---|');
      for (const b of win.regimeByVol) lines.push(`| ${b.label} | ${b.n} | ${pct(b.exposure)} | ${(b.stratMeanRet * 100).toFixed(4)}% | ${(b.bhMeanRet * 100).toFixed(4)}% |`);
      lines.push('');
    }
  }
  lines.push('## Sensitivity (SENSITIVITY — S3, informational; strategy is frozen at N=200)');
  lines.push('');
  for (const sym of Object.keys(summary.sensitivity)) {
    lines.push(`### ${sym}`);
    lines.push('| N | net CAGR | Sharpe | maxDD | trades |');
    lines.push('|---|---|---|---|---|');
    for (const r of summary.sensitivity[sym]) lines.push(`| ${r.n} | ${pct(r.netCagr)} | ${num(r.sharpe)} | ${pct(r.maxDD)} | ${r.trades} |`);
    lines.push('');
  }
  lines.push('## Baseline C — daily EMA20 spot filter (unmodified spot-trend.js)');
  lines.push('');
  lines.push('| symbol | window | CAGR | B&H CAGR | maxDD | B&H maxDD | Sharpe | exposure | trades | win% |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const [sym, w] of Object.entries(summary.baselineC)) {
    for (const [winName, r] of Object.entries(w)) {
      lines.push(`| ${sym} | ${winName} | ${pct(r.cagr)} | ${pct(r.bhCagr)} | ${pct(r.dd)} | ${pct(r.bhDd)} | ${num(r.sharpe)} | ${pct(r.exposure)} | ${r.trades} | ${pct(r.win)} |`);
    }
  }
  lines.push('');
  lines.push('## Daily overlap: SMA4h(200) vs daily EMA20 (full history, S3 series)');
  lines.push('');
  lines.push('| symbol | group | days | fraction | fwd 1-day B&H mean ret |');
  lines.push('|---|---|---|---|---|');
  for (const [sym, groups] of Object.entries(summary.overlap)) {
    for (const [g, v] of Object.entries(groups)) lines.push(`| ${sym} | ${g} | ${v.days} | ${pct(v.fraction)} | ${(v.fwdMeanRet * 100).toFixed(4)}% |`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------- charts.html (inline SVG, no libraries)

function scaleLinear(d0, d1, r0, r1) { const s = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0); return (x) => r0 + (x - d0) * s; }
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function svgPanel(title, note, innerSvg, w = 900, h = 300) {
  return `<div class="panel"><h3>${esc(title)}</h3>${note ? `<p class="note">${esc(note)}</p>` : ''}<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${innerSvg}</svg></div>`;
}

function poly(pts, color, w = 1.4) { return `<polyline fill="none" stroke="${color}" stroke-width="${w}" points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}"/>`; }

/** Price + SMA200 (log scale), long-shaded spans, entry/exit markers. */
function priceChart(symbol, daily, trades) {
  const W = 900, H = 320, L = 55, R = 20, T = 15, B = 25;
  const t0 = daily[0].t, t1 = daily[daily.length - 1].t;
  const x = scaleLinear(t0, t1, L, W - R);
  const logs = daily.flatMap((d) => [Math.log(d.close), Math.log(d.sma)]).filter(Number.isFinite);
  const y = scaleLinear(Math.min(...logs), Math.max(...logs), H - B, T);
  let svg = '';
  // long-shaded spans
  let spanStart = null;
  for (let i = 0; i < daily.length; i += 1) {
    if (daily[i].position && spanStart == null) spanStart = daily[i].t;
    if ((!daily[i].position || i === daily.length - 1) && spanStart != null) {
      const endT = daily[i].position ? daily[i].t : daily[i].t;
      svg += `<rect x="${x(spanStart).toFixed(1)}" y="${T}" width="${Math.max(1, x(endT) - x(spanStart)).toFixed(1)}" height="${H - T - B}" fill="#2e7d32" opacity="0.10"/>`;
      spanStart = daily[i].position ? spanStart : null;
    }
  }
  svg += poly(daily.map((d) => [x(d.t), y(Math.log(d.close))]), '#1976d2', 1.3);
  svg += poly(daily.map((d) => [x(d.t), y(Math.log(d.sma))]), '#e65100', 1.1);
  for (const tr of trades) {
    const et = Date.parse(tr.entryTime), xt = Date.parse(tr.exitTime);
    if (et >= t0 && et <= t1) svg += `<circle cx="${x(et).toFixed(1)}" cy="${y(Math.log(tr.entryPrice)).toFixed(1)}" r="2.6" fill="#2e7d32"/>`;
    if (xt >= t0 && xt <= t1) svg += `<circle cx="${x(xt).toFixed(1)}" cy="${y(Math.log(tr.exitPrice)).toFixed(1)}" r="2.6" fill="#c62828"/>`;
  }
  svg += `<text x="${L}" y="${T + 10}" font-size="10" fill="#1976d2">close (log)</text><text x="${L + 90}" y="${T + 10}" font-size="10" fill="#e65100">SMA200</text><text x="${L + 160}" y="${T + 10}" font-size="10" fill="#2e7d32">entry</text><text x="${L + 200}" y="${T + 10}" font-size="10" fill="#c62828">exit</text><text x="${L + 240}" y="${T + 10}" font-size="10" fill="#2e7d32" opacity="0.6">shaded = long</text>`;
  return svgPanel(`${symbol} price + SMA200 (log scale), long-shaded, entries/exits`, null, svg, W, H);
}

function equityChart(symbol, daily) {
  const W = 900, H = 260, L = 55, R = 20, T = 15, B = 25;
  const t0 = daily[0].t, t1 = daily[daily.length - 1].t;
  const x = scaleLinear(t0, t1, L, W - R);
  const logs = daily.flatMap((d) => [Math.log(d.eqNet), Math.log(d.eqBh)]);
  const y = scaleLinear(Math.min(...logs), Math.max(...logs), H - B, T);
  let svg = poly(daily.map((d) => [x(d.t), y(Math.log(d.eqNet))]), '#1976d2', 1.5);
  svg += poly(daily.map((d) => [x(d.t), y(Math.log(d.eqBh))]), '#9e9e9e', 1.2);
  svg += `<text x="${L}" y="${T + 10}" font-size="10" fill="#1976d2">strategy (S3, net)</text><text x="${L + 130}" y="${T + 10}" font-size="10" fill="#9e9e9e">B&amp;H</text>`;
  return svgPanel(`${symbol} equity vs B&H (log scale)`, null, svg, W, H);
}

function ddChart(symbol, daily) {
  const W = 900, H = 220, L = 55, R = 20, T = 15, B = 25;
  const t0 = daily[0].t, t1 = daily[daily.length - 1].t;
  const x = scaleLinear(t0, t1, L, W - R);
  const y = scaleLinear(0, 1, H - B, T);
  let svg = poly(daily.map((d) => [x(d.t), y(d.dd)]), '#1976d2', 1.3);
  svg += poly(daily.map((d) => [x(d.t), y(d.bhDd)]), '#9e9e9e', 1.1);
  svg += `<text x="${L}" y="${T + 10}" font-size="10" fill="#1976d2">strategy DD</text><text x="${L + 110}" y="${T + 10}" font-size="10" fill="#9e9e9e">B&amp;H DD</text>`;
  return svgPanel(`${symbol} drawdown (strategy vs B&H)`, null, svg, W, H);
}

function exposureChart(symbol, daily) {
  const W = 900, H = 200, L = 55, R = 20, T = 15, B = 25;
  const win = 90; // rolling 90-day exposure
  const roll = daily.map((_, i) => {
    const lo = Math.max(0, i - win + 1);
    const slice = daily.slice(lo, i + 1);
    return slice.reduce((s, d) => s + (d.position ? 1 : 0), 0) / slice.length;
  });
  const t0 = daily[0].t, t1 = daily[daily.length - 1].t;
  const x = scaleLinear(t0, t1, L, W - R);
  const y = scaleLinear(0, 1, H - B, T);
  const svg = poly(daily.map((d, i) => [x(d.t), y(roll[i])]), '#6a1b9a', 1.3);
  return svgPanel(`${symbol} rolling 90-day exposure (fraction of time long)`, null, svg, W, H);
}

function yearlyBarChart(symbol, perYearMap) {
  const W = 900, H = 260, L = 55, R = 20, T = 15, B = 35;
  const years = Object.keys(perYearMap).sort();
  const vals = years.map((y) => perYearMap[y]);
  const maxAbs = Math.max(0.2, ...vals.flatMap((v) => [Math.abs(v.stratRet), Math.abs(v.bhRet)]));
  const y0 = scaleLinear(-maxAbs, maxAbs, H - B, T);
  const bw = (W - L - R) / years.length;
  let svg = `<line x1="${L}" y1="${y0(0).toFixed(1)}" x2="${W - R}" y2="${y0(0).toFixed(1)}" stroke="#999" stroke-width="1"/>`;
  years.forEach((yr, i) => {
    const cx = L + i * bw;
    const sH = y0(0) - y0(vals[i].stratRet), bH = y0(0) - y0(vals[i].bhRet);
    svg += `<rect x="${(cx + bw * 0.15).toFixed(1)}" y="${(sH >= 0 ? y0(vals[i].stratRet) : y0(0)).toFixed(1)}" width="${(bw * 0.3).toFixed(1)}" height="${Math.abs(sH).toFixed(1)}" fill="#1976d2"/>`;
    svg += `<rect x="${(cx + bw * 0.55).toFixed(1)}" y="${(bH >= 0 ? y0(vals[i].bhRet) : y0(0)).toFixed(1)}" width="${(bw * 0.3).toFixed(1)}" height="${Math.abs(bH).toFixed(1)}" fill="#9e9e9e"/>`;
    svg += `<text x="${(cx + bw / 2).toFixed(1)}" y="${H - 8}" font-size="9" text-anchor="middle">${yr}</text>`;
  });
  svg += `<text x="${L}" y="${T + 10}" font-size="10" fill="#1976d2">strategy (S3)</text><text x="${L + 110}" y="${T + 10}" font-size="10" fill="#9e9e9e">B&amp;H</text>`;
  return svgPanel(`${symbol} calendar-year return: strategy vs B&H`, null, svg, W, H);
}

function symbolComparisonChart(summary) {
  const W = 900, H = 240, L = 55, R = 20, T = 15, B = 30;
  const symbols = Object.keys(summary.bySymbol);
  const rows = symbols.map((s) => ({ sym: s, strat: summary.bySymbol[s].windows.a_full_history.scenarios.S3_edittrades_spot.netCagr, bh: summary.bySymbol[s].windows.a_full_history.scenarios.S3_edittrades_spot.bhCagr }));
  const maxV = Math.max(0.2, ...rows.flatMap((r) => [r.strat, r.bh]));
  const y0 = scaleLinear(0, maxV, H - B, T);
  const bw = (W - L - R) / symbols.length;
  let svg = '';
  rows.forEach((r, i) => {
    const cx = L + i * bw;
    svg += `<rect x="${(cx + bw * 0.15).toFixed(1)}" y="${y0(r.strat).toFixed(1)}" width="${(bw * 0.3).toFixed(1)}" height="${(H - B - y0(r.strat)).toFixed(1)}" fill="#1976d2"/>`;
    svg += `<rect x="${(cx + bw * 0.55).toFixed(1)}" y="${y0(r.bh).toFixed(1)}" width="${(bw * 0.3).toFixed(1)}" height="${(H - B - y0(r.bh)).toFixed(1)}" fill="#9e9e9e"/>`;
    svg += `<text x="${(cx + bw / 2).toFixed(1)}" y="${H - 10}" font-size="11" text-anchor="middle">${r.sym}</text>`;
  });
  svg += `<text x="${L}" y="${T + 10}" font-size="10" fill="#1976d2">net CAGR (S3, full history)</text><text x="${L + 200}" y="${T + 10}" font-size="10" fill="#9e9e9e">B&amp;H CAGR</text>`;
  return svgPanel('BTC / ETH / SOL — net CAGR vs B&H (S3, full history)', null, svg, W, H);
}

function sensitivityChart(sensitivity) {
  const W = 900, H = 260, L = 55, R = 20, T = 15, B = 25;
  const colors = { BTC: '#1976d2', ETH: '#7b1fa2', SOL: '#00838f' };
  const ns = sensitivity.BTC.map((r) => r.n);
  const x = scaleLinear(ns[0], ns[ns.length - 1], L, W - R);
  const all = Object.values(sensitivity).flatMap((rows) => rows.map((r) => r.netCagr));
  const y = scaleLinear(Math.min(0, ...all), Math.max(...all), H - B, T);
  let svg = `<line x1="${L}" y1="${y(0).toFixed(1)}" x2="${W - R}" y2="${y(0).toFixed(1)}" stroke="#999"/>`;
  let lx = L;
  for (const [sym, rows] of Object.entries(sensitivity)) {
    svg += poly(rows.map((r) => [x(r.n), y(r.netCagr)]), colors[sym] || '#333', 1.6);
    svg += `<text x="${lx}" y="${T + 10}" font-size="10" fill="${colors[sym] || '#333'}">${sym}</text>`;
    lx += 60;
  }
  ns.forEach((n) => { svg += `<text x="${x(n).toFixed(1)}" y="${H - 8}" font-size="9" text-anchor="middle">${n}</text>`; });
  return svgPanel('SENSITIVITY — net CAGR vs N (S3, full history, informational)', 'N=200 is the frozen strategy; this sweep is reported, not selected on.', svg, W, H);
}

function buildChartsHtml(summary, fullHistoryS3) {
  const panels = [];
  const btcDaily = downsampleDaily(fullHistoryS3.BTC.series);
  panels.push(priceChart('BTC', btcDaily, fullHistoryS3.BTC.trades));
  panels.push(equityChart('BTC', btcDaily));
  panels.push(ddChart('BTC', btcDaily));
  panels.push(yearlyBarChart('BTC', perYear(fullHistoryS3.BTC.series)));
  panels.push(symbolComparisonChart(summary));
  panels.push(sensitivityChart(summary.sensitivity));
  panels.push(exposureChart('BTC', btcDaily));
  return `<!doctype html><html><head><meta charset="utf-8"><title>EXTERNAL_4H_SMA200_V1 charts</title>
<style>body{font:14px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#fafafa;color:#222;margin:0;padding:24px}
h1{font-size:18px}.panel{background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:12px 16px;margin:0 0 20px}
.panel h3{margin:0 0 4px;font-size:13px;color:#333}.note{margin:0 0 8px;font-size:11px;color:#777}
.wrap{max-width:960px;margin:0 auto}svg{display:block}</style></head>
<body><div class="wrap">
<h1>EXTERNAL_4H_SMA200_V1 — charts (research only)</h1>
<p class="note">Generated ${esc(summary.generatedAt)}. Daily-downsampled for size. See docs/research/EXTERNAL_4H_SMA200_STATUS.md and REPORT.md for full numbers.</p>
${panels.join('\n')}
</div></body></html>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
  const outDir = args.out || 'var/research/external-4h-sma200';
  mkdirSync(outDir, { recursive: true });
  main(outDir);
}

export default { runSma4h, perYear, attribution, regimeByTrend, regimeByVol, overlapTable, barsFromCandles, SCENARIOS };
