// WP7 spot trend arm evidence (research only, docs/research/harness/WP7_SPOT_REGISTRATION.md —
// frozen registration, read that first). Generic long/flat + weighted backtest engine, DCA
// accounting, vol-target/no-trade-buffer sizing, break-even bisection. All new code; the only
// reuse of existing files is read-only imports (`sma`, `ema`, `donchian` from `lib.js`).
//
// Decision-then-next-open-fill convention throughout, identical to sma4h-trend.js's runSma4h:
// a want[] array holds the boolean/decision computed from data available AT THE CLOSE of bar i
// (want[i]); the position implied by want[j-1] is filled at bar j's OPEN.
import { sma, ema, donchian } from './lib.js';

const MS_DAY = 24 * 3600e3;

// ---------------------------------------------------------------------- signal builders

/** want[i] = true iff close[i] > SMA(n)[i]; null during warm-up. */
export function smaWantSeries(bars, n) {
  const s = sma(bars.c, n);
  const out = new Array(bars.n).fill(null);
  for (let i = 0; i < bars.n; i += 1) if (Number.isFinite(s[i])) out[i] = bars.c[i] > s[i];
  return out;
}

/** want[i] = true iff close[i] > EMA(n)[i]; null during warm-up. */
export function emaWantSeries(bars, n) {
  const e = ema(bars.c, n);
  const out = new Array(bars.n).fill(null);
  for (let i = 0; i < bars.n; i += 1) if (Number.isFinite(e[i])) out[i] = bars.c[i] > e[i];
  return out;
}

/**
 * DONCHIAN_4W_V1: long when close[i] > highest HIGH of the n bars before i; flat when
 * close[i] < lowest LOW of the n bars before i; otherwise hold the previous state. Uses the
 * existing, unmodified `donchian(bars, n)` from lib.js for the channel (hi/lo at i excludes i).
 */
export function donchianWantSeries(bars, n) {
  const { hi, lo } = donchian(bars, n);
  const out = new Array(bars.n).fill(null);
  let state = null;
  for (let i = 0; i < bars.n; i += 1) {
    if (!Number.isFinite(hi[i]) || !Number.isFinite(lo[i])) continue;
    if (state == null) state = false; // first eligible bar: start flat unless it breaks out same bar
    if (bars.c[i] > hi[i]) state = true;
    else if (bars.c[i] < lo[i]) state = false;
    out[i] = state;
  }
  return out;
}

/** First index with a non-null decision (the strategy's own eligible start, for window (b)). */
export function eligibleStartIdx(want) {
  for (let i = 0; i < want.length; i += 1) if (want[i] != null) return i;
  return -1;
}

// ---------------------------------------------------------------------- generic binary long/flat engine

function annualizeFactor(barHours) { return Math.sqrt((24 / barHours) * 365); }

function sharpeOf(rets, ann) {
  if (!rets.length) return 0;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / rets.length);
  return sd ? (mu / sd) * ann : 0;
}

function makeTrade(bars, entryIdx, exitIdx, entryEq, exitEq, barHours) {
  return {
    entryTime: new Date(bars.t[entryIdx]).toISOString(), exitTime: new Date(bars.t[exitIdx]).toISOString(),
    entryPrice: bars.o[entryIdx], exitPrice: bars.o[exitIdx], holdDays: ((exitIdx - entryIdx) * barHours) / 24,
    ret: exitEq / entryEq - 1
  };
}

const EMPTY = { bars: 0, netCagr: 0, bhCagr: 0, sharpe: 0, maxDD: 0, bhMaxDD: 0, calmar: null, entries: 0, exits: 0, switches: 0, exposure: 0, avgHoldDays: 0, turnoverPerYear: 0, win: 0, trades: [], series: [] };

/**
 * Generic long/flat backtest: same accounting shape as sma4h-trend.js's runSma4h, generalized
 * over any want[] decision series (not just an SMA) and any bar interval (barHours).
 *
 * @param {ReturnType<typeof import('./lib.js').loadBars>} bars
 * @param {(boolean|null)[]} want - want[i] decided at close of bar i; null = warm-up (treated as flat, not counted)
 * @param {{costPerSide?:number, fromMs?:number, toMs?:number, barHours?:number}} opts
 */
export function runBinaryFilter(bars, want, opts = {}) {
  const { costPerSide = 0, fromMs = -Infinity, toMs = Infinity, barHours = 4 } = opts;
  const ann = annualizeFactor(barHours);
  let inPos = false, eq = 1, bh = 1, peak = null, dd = 0, bpeak = null, bdd = 0;
  let entries = 0, exits = 0, switches = 0, inBars = 0, totalBars = 0;
  let tradeEntryIdx = null, tradeEntryEq = null;
  let windowStartEq = null, windowStartBh = null;
  const rets = [], trades = [], series = [];

  for (let j = 1; j < bars.n; j += 1) {
    const decision = want[j - 1];
    if (decision == null) { inPos = false; continue; }
    const currTarget = !!decision;
    const bhFactor = bars.c[j] / bars.c[j - 1];
    let barFactor;
    if (currTarget && inPos) barFactor = bhFactor;
    else if (currTarget && !inPos) barFactor = bars.c[j] / bars.o[j];
    else if (!currTarget && inPos) barFactor = bars.o[j] / bars.c[j - 1];
    else barFactor = 1;

    const switched = currTarget !== inPos;
    const inWindow = bars.t[j] >= fromMs && bars.t[j] < toMs;
    const before = eq;
    eq *= barFactor;
    if (switched) {
      eq *= 1 - costPerSide;
      if (inWindow) switches += 1;
      if (currTarget) {
        if (inWindow) entries += 1;
        tradeEntryIdx = j; tradeEntryEq = before;
      } else {
        if (inWindow) exits += 1;
        if (tradeEntryIdx != null) {
          if (inWindow) trades.push(makeTrade(bars, tradeEntryIdx, j, tradeEntryEq, eq, barHours));
          tradeEntryIdx = null; tradeEntryEq = null;
        }
      }
    }
    bh *= bhFactor;

    if (inWindow) {
      if (windowStartEq == null) { windowStartEq = before; windowStartBh = bh / bhFactor; peak = before; bpeak = windowStartBh; }
      totalBars += 1;
      if (currTarget) inBars += 1;
      rets.push(eq / before - 1);
      peak = Math.max(peak, eq); dd = 1 - eq / peak;
      bpeak = Math.max(bpeak, bh); bdd = 1 - bh / bpeak;
      series.push({ t: bars.t[j], close: bars.c[j], position: currTarget, eqNet: eq / windowStartEq, eqBh: bh / windowStartBh, dd, bhDd: bdd });
    }
    inPos = currTarget;
  }

  if (tradeEntryIdx != null && series.length) trades.push({ ...makeTrade(bars, tradeEntryIdx, bars.n - 1, tradeEntryEq, eq, barHours), open: true });
  if (!series.length) return { ...EMPTY, costPerSide };

  const yrs = (totalBars * barHours) / (24 * 365);
  const netEnd = series[series.length - 1].eqNet, bhEnd = series[series.length - 1].eqBh;
  const netCagr = netEnd ** (1 / yrs) - 1, bhCagr = bhEnd ** (1 / yrs) - 1;
  const maxDD = Math.max(...series.map((s) => s.dd)), bhMaxDD = Math.max(...series.map((s) => s.bhDd));
  const closed = trades.filter((t) => !t.open);
  const holdDaysArr = closed.map((t) => t.holdDays);
  const wins = closed.filter((t) => t.ret > 0);

  return {
    costPerSide, bars: totalBars, netCagr, bhCagr, sharpe: sharpeOf(rets, ann), maxDD, bhMaxDD,
    calmar: maxDD > 0 ? netCagr / maxDD : null, entries, exits, switches, exposure: inBars / totalBars,
    avgHoldDays: holdDaysArr.length ? holdDaysArr.reduce((a, b) => a + b, 0) / holdDaysArr.length : 0,
    turnoverPerYear: switches / yrs, win: closed.length ? wins.length / closed.length : 0, trades, series
  };
}

// ---------------------------------------------------------------------- vol-target + no-trade buffer (Card 7.1)

/** Trailing-`window`-bar annualized realized vol of log returns ending at close i (any bar interval; periodsPerYear sets the annualization). */
export function realizedVol(c, i, window, periodsPerYear) {
  if (i < window) return NaN;
  let s = 0;
  for (let j = i - window + 1; j <= i; j += 1) s += Math.log(c[j] / c[j - 1]) ** 2;
  return Math.sqrt((s / window) * periodsPerYear);
}

/** target weight = min(1, targetVol / realizedVol); 0 if vol is not finite/positive. */
export function volTargetWeight(targetVol, vol) {
  if (!Number.isFinite(vol) || vol <= 0) return 0;
  return Math.min(1, targetVol / vol);
}

/** No-trade band: snap fully to target only when the gap exceeds the buffer; else hold. */
export function applyBuffer(prevWeight, targetWeight, buffer) {
  if (!(buffer > 0)) return targetWeight;
  return Math.abs(targetWeight - prevWeight) > buffer ? targetWeight : prevWeight;
}

const EMPTY_W = { bars: 0, netCagr: 0, bhCagr: 0, sharpe: 0, maxDD: 0, bhMaxDD: 0, turnoverPerYear: 0, series: [] };

/**
 * Weighted long/flat engine: same next-open-fill decision timing as runBinaryFilter, but the
 * position is a continuous weight in [0,1] driven by volTargetWeight()+applyBuffer() while
 * want[] is long, 0 while flat. Cost is charged on |Δweight| (spot-portfolio.js's convention),
 * not a fixed per-switch cost.
 */
export function runWeightedFilter(bars, want, opts = {}) {
  const { costPerSide = 0, fromMs = -Infinity, toMs = Infinity, barHours = 24, targetVol = 0.4, buffer = 0.1, volWindow = 20 } = opts;
  const periodsPerYear = (24 / barHours) * 365;
  const ann = Math.sqrt(periodsPerYear);
  let w = 0, eq = 1, bh = 1, peak = null, dd = 0, bpeak = null, bdd = 0;
  let totalBars = 0, inBars = 0, turnoverSum = 0;
  let windowStartEq = null, windowStartBh = null;
  const rets = [], series = [];

  for (let j = 1; j < bars.n; j += 1) {
    const decision = want[j - 1];
    const vol = realizedVol(bars.c, j - 1, volWindow, periodsPerYear);
    const rawTarget = decision ? volTargetWeight(targetVol, vol) : 0;
    const newW = applyBuffer(w, rawTarget, buffer);
    const bhFactor = bars.c[j] / bars.c[j - 1];
    const before = eq;
    eq *= 1 + w * (bhFactor - 1);
    const turn = Math.abs(newW - w);
    if (turn > 1e-12) eq *= 1 - turn * costPerSide;
    bh *= bhFactor;

    const inWindow = bars.t[j] >= fromMs && bars.t[j] < toMs;
    if (inWindow) {
      if (windowStartEq == null) { windowStartEq = before; windowStartBh = bh / bhFactor; peak = before; bpeak = windowStartBh; }
      totalBars += 1;
      if (newW > 0) inBars += 1;
      turnoverSum += turn;
      rets.push(eq / before - 1);
      peak = Math.max(peak, eq); dd = 1 - eq / peak;
      bpeak = Math.max(bpeak, bh); bdd = 1 - bh / bpeak;
      series.push({ t: bars.t[j], weight: newW, eqNet: eq / windowStartEq, eqBh: bh / windowStartBh, dd, bhDd: bdd });
    }
    w = newW;
  }

  if (!series.length) return { ...EMPTY_W, costPerSide, targetVol, buffer };
  const yrs = (totalBars * barHours) / (24 * 365);
  const netEnd = series[series.length - 1].eqNet, bhEnd = series[series.length - 1].eqBh;
  const netCagr = netEnd ** (1 / yrs) - 1, bhCagr = bhEnd ** (1 / yrs) - 1;
  const maxDD = Math.max(...series.map((s) => s.dd)), bhMaxDD = Math.max(...series.map((s) => s.bhDd));

  return {
    costPerSide, targetVol, buffer, bars: totalBars, netCagr, bhCagr, sharpe: sharpeOf(rets, ann), maxDD, bhMaxDD,
    exposure: inBars / totalBars, turnoverPerYear: turnoverSum / yrs, series
  };
}

// ---------------------------------------------------------------------- DCA accounting (Card 4.1)

/** True iff the bar's UTC open is the first bar of a Monday (00:00 UTC) — works for both 1D and 4H grids. */
export function isMondayUtcOpen(tMs) {
  const d = new Date(tMs);
  return d.getUTCDay() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
}

/**
 * Weekly-contribution DCA simulation, cash/units accounting (not equity-index like the engines
 * above — a contribution-funded arm needs actual dollar amounts). Same decision timing as
 * runBinaryFilter: want[j-1] (decided at close j-1) drives the action taken at bar j's open.
 *
 * @param {ReturnType<typeof import('./lib.js').loadBars>} bars
 * @param {(boolean|null)[]} want - null/false both mean "not long" (plain DCA arm passes an all-true array)
 * @param {{contribution?:number, costPerSide?:number, fromMs?:number, toMs?:number}} opts
 */
export function simulateDCA(bars, want, opts = {}) {
  const { contribution = 100, costPerSide = 0, fromMs = -Infinity, toMs = Infinity } = opts;
  let cash = 0, units = 0, contributed = 0, costPaid = 0;
  const rows = [], cashflows = [];

  for (let j = 0; j < bars.n; j += 1) {
    if (bars.t[j] < fromMs || bars.t[j] >= toMs) continue;
    if (isMondayUtcOpen(bars.t[j])) {
      cash += contribution; contributed += contribution;
      cashflows.push({ t: bars.t[j], amount: -contribution });
    }
    const decision = j > 0 ? want[j - 1] : null;
    const wantLong = !!decision;
    const price = bars.o[j];
    if (wantLong && cash > 1e-9) {
      const notional = cash, fee = notional * costPerSide;
      units += (notional - fee) / price; costPaid += fee; cash = 0;
    } else if (!wantLong && units > 1e-9) {
      const notional = units * price, fee = notional * costPerSide;
      cash += notional - fee; costPaid += fee; units = 0;
    }
    rows.push({ t: bars.t[j], value: cash + units * bars.c[j], cash, units });
  }

  const finalValue = rows.length ? rows[rows.length - 1].value : 0;
  if (rows.length) cashflows.push({ t: rows[rows.length - 1].t, amount: finalValue });
  let peak = -Infinity, maxDD = 0;
  for (const r of rows) { peak = Math.max(peak, r.value); if (peak > 0) maxDD = Math.max(maxDD, 1 - r.value / peak); }

  return { contributed, finalValue, costPaid, maxDD, irr: xirr(cashflows), rows, cashflows };
}

/** Money-weighted return (annualized) solving NPV(cashflows, r) = 0 by bisection. Null if no sign-change bracket. */
export function xirr(cashflows, lo = -0.999, hi = 50) {
  if (!cashflows.length) return null;
  const t0 = cashflows[0].t;
  const npv = (r) => cashflows.reduce((s, cf) => s + cf.amount / (1 + r) ** ((cf.t - t0) / (365 * 86400000)), 0);
  let a = lo, b = hi, fa = npv(a), fb = npv(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) return null;
  for (let k = 0; k < 200; k += 1) {
    const m = (a + b) / 2, fm = npv(m);
    if (Math.abs(fm) < 1e-9) return m;
    if (fa * fm < 0) { b = m; fb = fm; } else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

// ---------------------------------------------------------------------- break-even (item 5)

/**
 * Bisects costPerSide in [lo,hi] for the cost at which runFn(cost).netCagr crosses `target`
 * (a number, or a function of the runFn(0) baseline for "beat B&H"). Assumes net return is
 * monotonically non-increasing in cost (true for these turnover-cost models).
 */
export function breakEvenCost(runFn, targetFn, lo = 0, hi = 0.05, tol = 1e-7) {
  const f = (c) => { const r = runFn(c); return r.netCagr - targetFn(r); };
  const f0 = f(lo);
  if (f0 <= 0) return 0; // no edge even at zero cost
  const fHi = f(hi);
  if (fHi > 0) return Infinity; // still ahead at the top of the search range
  let a = lo, b = hi;
  for (let k = 0; k < 60; k += 1) {
    const m = (a + b) / 2, fm = f(m);
    if (Math.abs(fm) < tol) return m;
    if (f(a) * fm <= 0) b = m; else a = m;
  }
  return (a + b) / 2;
}

export default {
  smaWantSeries, emaWantSeries, donchianWantSeries, eligibleStartIdx,
  runBinaryFilter, realizedVol, volTargetWeight, applyBuffer, runWeightedFilter,
  isMondayUtcOpen, simulateDCA, xirr, breakEvenCost
};
