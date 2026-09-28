// WP8_QUATTRO (research only, docs/research/harness/WP8_QUATTRO_REGISTRATION.md — frozen registration, read
// that first). Reproduces `EstebanSP23/crypto_systematic_research` @ 5df0c43f "Quattro" Donchian breakout +
// daily EMA200 regime, single-unit and pyramid arms, both regime interpretations (code vs README), with
// `maxLeverage=1` (no leverage) as the one intentional deviation from source. Pure + CLI.
//
//   node scripts/research/edge/quattro.js [--out var/research/wp8-quattro]
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars, ema } from './lib.js';
import { runSma4h } from './sma4h-trend.js';

const MS_DAY = 24 * 3600e3;
const MS_H = 3600e3;
const ANNUALIZE_4H = Math.sqrt(6 * 365); // 6 four-hour bars/day

// ---------------------------------------------------------------------- indicators (pandas-exact)

/** Wilder ATR reproduced exactly as source: tr.ewm(alpha=1/p, adjust=False).mean(), seeded from bar 0. */
export function atrEwm(b, p = 14) {
  const out = new Float64Array(b.n).fill(NaN);
  const alpha = 1 / p;
  let prev = null;
  for (let i = 0; i < b.n; i += 1) {
    const tr = i === 0 ? b.h[i] - b.l[i] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
    prev = prev === null ? tr : tr * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** Highest high / lowest low of the N bars BEFORE i (excludes i) — same shape as lib.js donchian(). */
export function donchian(b, n) {
  const hi = new Float64Array(b.n).fill(NaN), lo = new Float64Array(b.n).fill(NaN);
  for (let i = n; i < b.n; i += 1) {
    let H = -Infinity, L = Infinity;
    for (let j = i - n; j < i; j += 1) { if (b.h[j] > H) H = b.h[j]; if (b.l[j] < L) L = b.l[j]; }
    hi[i] = H; lo[i] = L;
  }
  return { hi, lo };
}

/** Daily EMA200 + the README's exact rising-slope test: ema200[d] > ema200[d-20]. */
export function dailyRegimeArrays(daily) {
  const ema200 = ema(daily.c, 200);
  const slopeUp = new Float64Array(daily.n).fill(NaN);
  for (let i = 20; i < daily.n; i += 1) {
    if (Number.isFinite(ema200[i]) && Number.isFinite(ema200[i - 20])) slopeUp[i] = ema200[i] > ema200[i - 20] ? 1 : 0;
  }
  return { ema200, slopeUp };
}

/**
 * For each 4h bar, the daily index whose EMA200 is "available" (source: daily index shifted +1 day, ffilled).
 * Both `daily.t` and `bars.t` are UTC day-aligned, so this is: the latest daily bar strictly before the 4h
 * bar's own calendar day. Two-pointer, both arrays ascending.
 */
export function alignDailyToBars(daily, bars) {
  const idx = new Int32Array(bars.n).fill(-1);
  let di = -1;
  for (let j = 0; j < bars.n; j += 1) {
    const dayFloor = Math.floor(bars.t[j] / MS_DAY) * MS_DAY;
    while (di + 1 < daily.n && daily.t[di + 1] < dayFloor) di += 1;
    idx[j] = di;
  }
  return idx;
}

/** Precompute everything the engine needs once per (symbol, regime). */
export function buildQuattroSeries(bars, daily, { regime = 'A', entryLen = 20, exitLen = 10 } = {}) {
  const d20 = donchian(bars, entryLen);
  const d10 = donchian(bars, exitLen);
  const atr14 = atrEwm(bars, 14);
  const { ema200, slopeUp } = dailyRegimeArrays(daily);
  const dailyIdx = alignDailyToBars(daily, bars);
  const regimeOk = new Float64Array(bars.n).fill(NaN); // 1/0/NaN
  for (let j = 0; j < bars.n; j += 1) {
    const di = dailyIdx[j];
    if (di < 0 || !Number.isFinite(ema200[di])) continue;
    const above = bars.c[j] > ema200[di] ? 1 : 0;
    if (regime === 'A') { regimeOk[j] = above; continue; }
    const slope = slopeUp[di];
    if (!Number.isFinite(slope)) continue;
    regimeOk[j] = above && slope ? 1 : 0;
  }
  return { donchHigh20: d20.hi, donchLow10: d10.lo, atr14, regimeOk };
}

// ---------------------------------------------------------------------- engine (single-unit + pyramid, unified)

/**
 * Unified Quattro campaign engine. maxUnits=1 reproduces backtest_trend.py exactly (at maxLeverage=20);
 * maxUnits=4 reproduces backtest.py / quattro_v2_engine.py / backtest_multi_asset.py exactly (at maxLeverage=20).
 * The WP's official arms use maxLeverage=1 (no leverage) — see registration §2-3.
 *
 * Costs are charged on TRADED NOTIONAL (fill size x price), not on whole account equity, since units are
 * risk-sized fractions of equity (unlike runSma4h's always-100%-invested convention).
 */
export function runQuattroCampaign(bars, daily, opts = {}) {
  const {
    regime = 'A', maxUnits = 1, maxLeverage = 1, riskPct = 0.02, hardStopPct = 0.05,
    pyramidStep = 0.5, atrMult = 2, entryLen = 20, exitLen = 10,
    costPerSide = 0, borrowPerHour = 0, fromMs = -Infinity, toMs = Infinity
  } = opts;
  const { donchHigh20, donchLow10, atr14, regimeOk } = buildQuattroSeries(bars, daily, { regime, entryLen, exitLen });

  let account = 1; // unit-less starting equity (scale-free; see registration §4)
  let units = []; // [{entryPrice, size, entryBarIdx}]
  let originalEntry = null, originalAtr = null, commonStop = null, acctAtEntry = null;
  let pendingExit = false, pendingExitReason = null;
  const trades = [];
  const series = [];
  let windowStartEq = null;
  let peak = null, dd = 0;
  let inBarsWindow = 0, totalBarsWindow = 0;

  const totalSize = () => units.reduce((s, u) => s + u.size, 0);
  const notionalAt = (px) => units.reduce((s, u) => s + u.size * px, 0);
  const pnlAt = (px) => units.reduce((s, u) => s + (px - u.entryPrice) * u.size, 0);
  const payFee = (notional) => { const fee = costPerSide * notional; account -= fee; return fee; };
  const payBorrow = (notional, hours) => { const b = borrowPerHour * hours * notional; account -= b; return b; };

  function closeAll(exitPx, reason, i) {
    const gross = pnlAt(exitPx);
    payFee(totalSize() * exitPx);
    account += gross;
    const riskUnit = acctAtEntry * riskPct;
    const stopDistance = originalAtr * atrMult; // = entry - initial stop, before any trailing
    trades.push({
      entryTime: bars.t[units[0].entryBarIdx], exitTime: bars.t[i],
      entryPrice: units[0].entryPrice, exitPrice: exitPx, numUnits: units.length,
      grossR: gross / riskUnit, retPct: (gross / acctAtEntry) * 100,
      riskPct: (stopDistance / units[0].entryPrice) * 100,
      hours: (i - units[0].entryBarIdx) * 4, reason, account
    });
    units = []; originalEntry = originalAtr = commonStop = acctAtEntry = null;
  }

  const n = bars.n;
  for (let i = 0; i < n - 1; i += 1) {
    // Borrow settles at this bar's open for a position held from before the bar (mirrors funding settlement).
    if (units.length && units[0].entryBarIdx < i) payBorrow(totalSize() * bars.o[i], 4);

    if (pendingExit) {
      closeAll(bars.o[i], pendingExitReason, i);
      pendingExit = false; pendingExitReason = null;
    }

    if (units.length) {
      // 1) hard 5%-of-account-at-entry stop (wick-based)
      if (pnlAt(bars.l[i]) <= -hardStopPct * acctAtEntry) {
        const targetLoss = -hardStopPct * acctAtEntry;
        const wavg = units.reduce((s, u) => s + u.entryPrice * u.size, 0) / totalSize();
        closeAll(wavg + targetLoss / totalSize(), 'hard_stop_5pct', i);
      } else if (bars.l[i] <= commonStop) {
        // 2) trailing/common stop (wick-based, fills exactly at the stop level per source)
        closeAll(commonStop, 'atr_stop_trailing', i);
      } else {
        // 3) pyramiding (intrabar via bar high)
        while (units.length < maxUnits) {
          const trigger = originalEntry + pyramidStep * units.length * originalAtr;
          if (bars.h[i] < trigger) break;
          const unitEntry = trigger;
          const size = (acctAtEntry * riskPct) / (atrMult * originalAtr);
          const leverage = (notionalAt(bars.c[i]) + size * unitEntry) / account;
          if (leverage > maxLeverage) break;
          units.push({ entryPrice: unitEntry, size, entryBarIdx: i });
          payFee(size * unitEntry);
          const newStop = unitEntry - atrMult * originalAtr;
          if (newStop > commonStop) commonStop = newStop;
        }
        // 4) Donchian exit signal (this bar's close), fills at next bar's open
        if (bars.c[i] < donchLow10[i]) { pendingExit = true; pendingExitReason = 'donchian_exit'; }
      }
    } else if (Number.isFinite(donchHigh20[i]) && Number.isFinite(atr14[i]) && Number.isFinite(regimeOk[i])) {
      if (bars.c[i] > donchHigh20[i] && regimeOk[i] === 1) {
        const entryPx = bars.o[i + 1];
        const N = atr14[i];
        const stopPx = entryPx - atrMult * N;
        if (entryPx - stopPx > 0) {
          const rAmt = account * riskPct;
          const size = rAmt / (atrMult * N);
          const leverage = (size * entryPx) / account;
          if (leverage <= maxLeverage) {
            units = [{ entryPrice: entryPx, size, entryBarIdx: i + 1 }];
            originalEntry = entryPx; originalAtr = N; acctAtEntry = account; commonStop = stopPx;
          }
        }
      }
    }

    // Bar-close mark-to-market (for CAGR/Sharpe/maxDD/exposure), after this bar's events are applied.
    const eq = account + (units.length ? pnlAt(bars.c[i]) : 0);
    const inWindow = bars.t[i] >= fromMs && bars.t[i] < toMs;
    if (inWindow) {
      if (windowStartEq == null) { windowStartEq = eq; peak = eq; }
      totalBarsWindow += 1;
      if (units.length) inBarsWindow += 1;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, 1 - eq / peak);
      series.push({ t: bars.t[i], close: bars.c[i], eq, position: units.length > 0 });
    }
  }
  if (units.length) closeAll(bars.c[n - 1], 'still_open_at_end', n - 1);

  return summarize({ trades, series, windowStartEq, dd, inBarsWindow, totalBarsWindow, fromMs, toMs });
}

function summarize({ trades, series, windowStartEq, dd, inBarsWindow, totalBarsWindow }) {
  if (!series.length || windowStartEq == null) {
    return { n: 0, netCagr: 0, sharpe: 0, maxDD: 0, exposure: 0, trades: [], series: [], win: 0, avgWin: 0, avgLoss: 0, avgHoldHours: 0 };
  }
  const rets = [];
  for (let k = 1; k < series.length; k += 1) rets.push(series[k].eq / series[k - 1].eq - 1);
  const yrs = (totalBarsWindow * 4) / (24 * 365);
  const netEnd = series[series.length - 1].eq / windowStartEq;
  const netCagr = yrs > 0 ? netEnd ** (1 / yrs) - 1 : 0;
  const mu = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length ? Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / rets.length) : 0;
  const sharpe = sd ? (mu / sd) * ANNUALIZE_4H : 0;
  const inWindowTrades = trades.filter((t) => t.entryTime >= series[0].t);
  const wins = inWindowTrades.filter((t) => t.grossR > 0);
  const losses = inWindowTrades.filter((t) => t.grossR <= 0);
  return {
    n: inWindowTrades.length, netCagr, sharpe, maxDD: dd, exposure: totalBarsWindow ? inBarsWindow / totalBarsWindow : 0,
    win: inWindowTrades.length ? wins.length / inWindowTrades.length : 0,
    avgWin: wins.length ? wins.reduce((a, b) => a + b.grossR, 0) / wins.length : 0,
    avgLoss: losses.length ? -losses.reduce((a, b) => a + b.grossR, 0) / losses.length : 0,
    avgHoldHours: inWindowTrades.length ? inWindowTrades.reduce((a, b) => a + b.hours, 0) / inWindowTrades.length : 0,
    trades: inWindowTrades, series
  };
}

// ---------------------------------------------------------------------- cost survival (breakeven.js perTrade family)

/**
 * Per-trade break-even round trip and max tolerable borrow, same formula family as breakeven.js's perTrade():
 * netR_i = grossR_i - (c + b*h_i)/riskPct_i  =>  c* = (sum grossR - sum b*h/riskPct) / sum (1/riskPct).
 */
export function perTradeBreakeven(trades, { actualRt = 0.20, borrowPerH = 0.02 } = {}) {
  const t = trades.filter((x) => Number.isFinite(x.grossR) && x.riskPct > 0);
  if (!t.length) return null;
  const sumG = t.reduce((s, x) => s + x.grossR, 0);
  const sumInv = t.reduce((s, x) => s + 1 / x.riskPct, 0);
  const sumB = t.reduce((s, x) => s + (borrowPerH * x.hours) / x.riskPct, 0);
  const sumH = t.reduce((s, x) => s + x.hours / x.riskPct, 0);
  const medRisk = [...t].sort((a, b) => a.riskPct - b.riskPct)[Math.floor(t.length / 2)].riskPct;
  const beFree = sumG / sumInv;
  const beBorrow = (sumG - sumB) / sumInv;
  return {
    n: t.length, grossR: sumG / t.length, medStopPct: medRisk,
    beFree, beBorrow, actualRt, margin: beBorrow > 0 ? beBorrow / actualRt : null,
    maxBorrowPerH: sumH > 0 ? (sumG - actualRt * sumInv) / sumH : null
  };
}

// ---------------------------------------------------------------------- B&H / SMA comparison helpers

export function buyAndHold(bars, fromMs = -Infinity, toMs = Infinity) {
  const idx = [];
  for (let i = 0; i < bars.n; i += 1) if (bars.t[i] >= fromMs && bars.t[i] < toMs) idx.push(i);
  if (idx.length < 2) return { cagr: 0, maxDD: 0 };
  const c0 = bars.c[idx[0]];
  let peak = c0, dd = 0;
  for (const i of idx) { peak = Math.max(peak, bars.c[i]); dd = Math.max(dd, 1 - bars.c[i] / peak); }
  const yrs = ((idx[idx.length - 1] - idx[0]) * 4) / (24 * 365);
  const cagr = yrs > 0 ? (bars.c[idx[idx.length - 1]] / c0) ** (1 / yrs) - 1 : 0;
  return { cagr, maxDD: dd };
}

// ---------------------------------------------------------------------- reference CSV reproduction check

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
  });
}

/** Compares our engine's trade dates/exit reasons against a source reference CSV. Returns a diff summary. */
export function compareToReference(ourTrades, csvPath) {
  if (!existsSync(csvPath)) return { available: false };
  const ref = parseCsv(readFileSync(csvPath, 'utf8'));
  const refDates = ref.map((r) => new Date(r.entry_date).getTime());
  const ourDates = ourTrades.map((t) => t.entryTime);
  let matched = 0;
  const tolMs = 4 * MS_H; // one 4h bar tolerance for ms-format/timezone rounding
  for (const rd of refDates) if (ourDates.some((od) => Math.abs(od - rd) < tolMs)) matched += 1;
  return { available: true, refN: ref.length, ourN: ourTrades.length, matched, matchRate: ref.length ? matched / ref.length : 0 };
}

// ---------------------------------------------------------------------- CLI

const SCENARIOS = {
  gross: { costPerSide: 0, borrowPerHour: 0 },
  spot_015: { costPerSide: 0.0015, borrowPerHour: 0 }, // spot, 0.15%/side
  perp_borrow0015: { costPerSide: 0.0010, borrowPerHour: 0.000015 }, // 0.20% RT, real Jupiter borrow (measured 2026-09-27) — base verdict
  perp_borrow004: { costPerSide: 0.0010, borrowPerHour: 0.00004 }, // 0.20% RT, Jupiter stress case (~80% utilization)
  perp_borrow02: { costPerSide: 0.0010, borrowPerHour: 0.0002 }, // 0.20% RT, prior static assumption (superseded)
  perp_borrow024: { costPerSide: 0.0010, borrowPerHour: 0.00024 }, // 0.20% RT, prior static "harsh" assumption (superseded)
  source_fee_only: { costPerSide: 0.0006, borrowPerHour: 0 } // source's 0.06%/fill, funding not modeled
};

const ARMS = [
  { id: 'QUATTRO_1U_A', regime: 'A', maxUnits: 1 },
  { id: 'QUATTRO_1U_B', regime: 'B', maxUnits: 1 },
  { id: 'QUATTRO_PYR_A', regime: 'A', maxUnits: 4 },
  { id: 'QUATTRO_PYR_B', regime: 'B', maxUnits: 4 }
];

function pct(x, d = 2) { return x == null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`; }
function num(x, d = 2) { return x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d); }

function main(outDir) {
  const symbols = ['BTC', 'ETH', 'SOL'];
  const bars4h = Object.fromEntries(symbols.map((s) => [s, loadBars(s, '4h', 'var/edge/4h-long')]));
  const daily = Object.fromEntries(symbols.map((s) => [s, loadBars(s, '1d', 'var/edge/daily-long')]));

  const eligibleStart = {};
  for (const s of symbols) {
    const { donchHigh20, atr14, regimeOk } = buildQuattroSeries(bars4h[s], daily[s], { regime: 'B' }); // B is the stricter gate
    let idx = -1;
    for (let i = 0; i < bars4h[s].n; i += 1) if (Number.isFinite(donchHigh20[i]) && Number.isFinite(atr14[i]) && Number.isFinite(regimeOk[i])) { idx = i; break; }
    eligibleStart[s] = idx >= 0 ? bars4h[s].t[idx] : Infinity;
  }

  const windows = {
    source_window: { fromMs: Date.UTC(2022, 0, 1), toMs: Infinity },
    full_history: { fromMs: -Infinity, toMs: Infinity },
    w2020_2023: { fromMs: Date.UTC(2020, 0, 1), toMs: Date.UTC(2024, 0, 1) },
    w2024_2026: { fromMs: Date.UTC(2024, 0, 1), toMs: Infinity }
  };

  const summary = { generatedAt: new Date().toISOString(), scenarios: SCENARIOS, arms: {}, comparisons: {}, reproduction: {} };

  for (const arm of ARMS) {
    summary.arms[arm.id] = { bySymbol: {} };
    for (const sym of symbols) {
      const bars = bars4h[sym], d = daily[sym];
      summary.arms[arm.id].bySymbol[sym] = { windows: {} };
      // Gross trades (for cost-survival / breakeven), full history, official (no-leverage) config.
      const grossFull = runQuattroCampaign(bars, d, { regime: arm.regime, maxUnits: arm.maxUnits, maxLeverage: 1, costPerSide: 0, borrowPerHour: 0 });
      // Real Jupiter borrow (measured 2026-09-27 via perps-api.jup.ag/v1/pool-info): 0.0015%/h BTC/ETH,
      // ~0.0015-0.0015%/h base; 0.004%/h stress (~80% utilization). Verdict is based on 0.0015; 0.02/0.024
      // were the prior static assumption (BREAKEVEN_COSTS_2026-09-27.md) and are kept for continuity.
      const beReal = perTradeBreakeven(grossFull.trades, { actualRt: 0.20, borrowPerH: 0.0015 });
      const beStress = perTradeBreakeven(grossFull.trades, { actualRt: 0.20, borrowPerH: 0.004 });
      const be = perTradeBreakeven(grossFull.trades, { actualRt: 0.20, borrowPerH: 0.02 });
      const beHarsh = perTradeBreakeven(grossFull.trades, { actualRt: 0.20, borrowPerH: 0.024 });
      const beSpot = perTradeBreakeven(grossFull.trades, { actualRt: 0.30, borrowPerH: 0 });
      summary.arms[arm.id].bySymbol[sym].breakeven = {
        perpBorrow0015: beReal, perpBorrow004: beStress, perpBorrow02: be, perpBorrow024: beHarsh, spot: beSpot
      };

      for (const [winName, win] of Object.entries(windows)) {
        const winOut = { scenarios: {} };
        for (const [scName, sc] of Object.entries(SCENARIOS)) {
          const r = runQuattroCampaign(bars, d, { regime: arm.regime, maxUnits: arm.maxUnits, maxLeverage: 1, ...sc, fromMs: win.fromMs, toMs: win.toMs });
          winOut.scenarios[scName] = {
            n: r.n, netCagr: r.netCagr, sharpe: r.sharpe, maxDD: r.maxDD, exposure: r.exposure,
            win: r.win, avgWin: r.avgWin, avgLoss: r.avgLoss, avgHoldHours: r.avgHoldHours
          };
        }
        const bh = buyAndHold(bars, win.fromMs, win.toMs);
        winOut.bh = bh;
        summary.arms[arm.id].bySymbol[sym].windows[winName] = winOut;
      }
    }
  }

  // vs SMA200 / SMA840 (runSma4h, same symbols/windows/cost models as Card 1/Card 4) — Quattro's own two
  // headline cost scenarios (spot 0.15%/side, perps at the real measured Jupiter borrow).
  summary.smaComparison = {};
  const smaCosts = { spot_015: SCENARIOS.spot_015, perp_borrow0015: SCENARIOS.perp_borrow0015 };
  for (const sym of symbols) {
    summary.smaComparison[sym] = {};
    for (const [winName, win] of Object.entries(windows)) {
      const row = { bh: buyAndHold(bars4h[sym], win.fromMs, win.toMs) };
      for (const [scName, sc] of Object.entries(smaCosts)) {
        for (const n of [200, 840]) {
          const r = runSma4h(bars4h[sym], { n, ...sc, fromMs: win.fromMs, toMs: win.toMs });
          row[`sma${n}_${scName}`] = { netCagr: r.netCagr, sharpe: r.sharpe, maxDD: r.maxDD, exposure: r.exposure, trades: r.entries };
        }
      }
      summary.smaComparison[sym][winName] = row;
    }
  }

  // Reproduction checks: maxLeverage=20 (source-fidelity), against the six reference CSVs.
  const refDir = 'var/research/wp8-quattro/reference';
  const refChecks = [
    { id: 'QUATTRO_1U_A (validation, ML=20)', sym: 'BTC', regime: 'A', maxUnits: 1, file: 'source_BTC_1U_regimeA.csv' },
    { id: 'QUATTRO_PYR_A (validation, ML=20)', sym: 'BTC', regime: 'A', maxUnits: 4, file: 'source_BTC_PYR_regimeA.csv' },
    { id: 'QUATTRO_PYR_B (validation, ML=20)', sym: 'BTC', regime: 'B', maxUnits: 4, file: 'source_BTC_PYR_regimeB.csv' },
    { id: 'QUATTRO_PYR_B (validation, ML=20)', sym: 'ETH', regime: 'B', maxUnits: 4, file: 'source_ETH_PYR_regimeB.csv' },
    { id: 'QUATTRO_PYR_B (validation, ML=20)', sym: 'SOL', regime: 'B', maxUnits: 4, file: 'source_SOL_PYR_regimeB.csv' }
  ];
  for (const c of refChecks) {
    const r = runQuattroCampaign(bars4h[c.sym], daily[c.sym], { regime: c.regime, maxUnits: c.maxUnits, maxLeverage: 20, fromMs: Date.UTC(2022, 0, 1), toMs: Infinity });
    const cmp = compareToReference(r.trades, path.join(refDir, c.file));
    summary.reproduction[`${c.id}_${c.sym}`] = { ourN: r.n, ...cmp };
  }

  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(summary));
  console.log(`[quattro] wrote ${outDir}/{summary.json,REPORT.md}`);
}

function renderReport(summary) {
  const lines = ['# WP8_QUATTRO — results (research only)', '', `Generated ${summary.generatedAt}. See docs/research/harness/WP8_QUATTRO_REGISTRATION.md for the frozen rules.`, ''];
  lines.push('## Reproduction vs source (maxLeverage=20, validation only)', '');
  lines.push('| check | ref n | our n | matched (±4h) | match rate |', '| --- | --- | --- | --- | --- |');
  for (const [k, v] of Object.entries(summary.reproduction)) {
    lines.push(`| ${k} | ${v.refN ?? 'n/a'} | ${v.ourN} | ${v.matched ?? 'n/a'} | ${v.matchRate != null ? pct(v.matchRate) : 'n/a'} |`);
  }
  lines.push('');
  lines.push('## vs SMA200 / SMA840 (runSma4h, same symbols/windows)', '');
  for (const [sym, wins] of Object.entries(summary.smaComparison)) {
    lines.push(`### ${sym}`, '');
    lines.push('| window | B&H CAGR | SMA200 net CAGR (spot) | SMA840 net CAGR (spot) | SMA200 net CAGR (perp@0.0015%/h) | SMA840 net CAGR (perp@0.0015%/h) |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const [winName, row] of Object.entries(wins)) {
      lines.push(`| ${winName} | ${pct(row.bh.cagr)} | ${pct(row.sma200_spot_015.netCagr)} | ${pct(row.sma840_spot_015.netCagr)} | ${pct(row.sma200_perp_borrow0015.netCagr)} | ${pct(row.sma840_perp_borrow0015.netCagr)} |`);
    }
    lines.push('');
  }
  for (const [armId, arm] of Object.entries(summary.arms)) {
    lines.push(`## ${armId}`, '');
    for (const [sym, s] of Object.entries(arm.bySymbol)) {
      lines.push(`### ${sym}`, '');
      lines.push('Break-even (full history, gross trades):');
      lines.push('| cost model | n | gross R/trade | break-even RT | actual | margin | max borrow %/h |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const [label, be] of Object.entries(s.breakeven)) {
        if (!be) { lines.push(`| ${label} | 0 | n/a | n/a | n/a | n/a | n/a |`); continue; }
        lines.push(`| ${label} | ${be.n} | ${num(be.grossR, 3)} | ${pct(be.beBorrow, 3)} | ${pct(be.actualRt)} | ${be.margin != null ? `${be.margin.toFixed(2)}x` : 'n/a'} | ${be.maxBorrowPerH == null ? 'n/a' : be.maxBorrowPerH <= 0 ? '0' : be.maxBorrowPerH.toFixed(4)} |`);
      }
      lines.push('');
      for (const [winName, win] of Object.entries(s.windows)) {
        lines.push(`#### ${sym} — ${winName} (B&H CAGR ${pct(win.bh.cagr)}, B&H maxDD ${pct(win.bh.maxDD)})`, '');
        lines.push('| scenario | n | net CAGR | Sharpe | maxDD | exposure | avg hold(h) | win% | avg win R | avg loss R |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const [scName, sc] of Object.entries(win.scenarios)) {
          lines.push(`| ${scName} | ${sc.n} | ${pct(sc.netCagr)} | ${num(sc.sharpe)} | ${pct(sc.maxDD)} | ${pct(sc.exposure)} | ${num(sc.avgHoldHours, 1)} | ${pct(sc.win)} | ${num(sc.avgWin)} | ${num(sc.avgLoss)} |`);
        }
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
  const outDir = args.out || 'var/research/wp8-quattro';
  mkdirSync(outDir, { recursive: true });
  main(outDir);
}

export default { atrEwm, donchian, dailyRegimeArrays, alignDailyToBars, buildQuattroSeries, runQuattroCampaign, perTradeBreakeven, buyAndHold, compareToReference };
