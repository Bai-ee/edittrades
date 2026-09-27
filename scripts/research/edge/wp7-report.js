// WP7 spot trend arm evidence — CLI report (research only,
// docs/research/harness/WP7_SPOT_REGISTRATION.md — frozen registration, read that first).
//   node scripts/research/edge/wp7-report.js [--out var/research/wp7-spot]
// Reuses (read-only import, not modified): lib.js (sma/ema/donchian/loadBars),
// sma4h-trend.js (runSma4h), spot-trend.js (runFilter) — for parity cross-checks only.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from './lib.js';
import { runSma4h } from './sma4h-trend.js';
import { runFilter } from './spot-trend.js';
import {
  smaWantSeries, emaWantSeries, donchianWantSeries, eligibleStartIdx,
  runBinaryFilter, runWeightedFilter, simulateDCA, breakEvenCost
} from './wp7-engine.js';

const SYMBOLS = ['BTC', 'ETH', 'SOL'];
const S3 = 0.0015; // registered spot cost, 0.15%/side
const SPLIT = Date.parse('2024-01-01T00:00:00Z');
const pct = (x) => (x == null ? 'n/a' : x === Infinity ? '+inf' : x === -Infinity ? '-inf' : !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(2)}%`);
const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const money = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `$${x.toFixed(2)}`);
const sharpeArr = (rets) => { if (!rets.length) return 0; const mu = rets.reduce((a, b) => a + b, 0) / rets.length; const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / rets.length); return sd ? (mu / sd) * Math.sqrt(365) : 0; };
const monthKey = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

function main(outDir) {
  mkdirSync(outDir, { recursive: true });
  const bars4h = Object.fromEntries(SYMBOLS.map((s) => [s, loadBars(s, '4h', 'var/edge/4h-long')]));
  const barsD = Object.fromEntries(SYMBOLS.map((s) => [s, loadBars(s, '1d', 'var/edge/daily-long')]));

  const want = {};
  for (const s of SYMBOLS) {
    want[s] = {
      SMA200_4H: smaWantSeries(bars4h[s], 200),
      SLOW_SMA840_4H_V1: smaWantSeries(bars4h[s], 840),
      DONCHIAN_4W_V1: donchianWantSeries(barsD[s], 28),
      EMA20_DAILY: emaWantSeries(barsD[s], 20)
    };
  }
  const barsOf = { SMA200_4H: bars4h, SLOW_SMA840_4H_V1: bars4h, DONCHIAN_4W_V1: barsD, EMA20_DAILY: barsD };
  const hoursOf = { SMA200_4H: 4, SLOW_SMA840_4H_V1: 4, DONCHIAN_4W_V1: 24, EMA20_DAILY: 24 };
  const STRATS = ['SMA200_4H', 'SLOW_SMA840_4H_V1', 'DONCHIAN_4W_V1', 'EMA20_DAILY'];

  const commonFrom = {};
  for (const id of STRATS) {
    commonFrom[id] = Math.max(...SYMBOLS.map((s) => {
      const idx = eligibleStartIdx(want[s][id]);
      return idx >= 0 ? barsOf[id][s].t[idx] : Infinity;
    }));
  }

  const report = { generatedAt: new Date().toISOString(), commonFrom: Object.fromEntries(STRATS.map((id) => [id, new Date(commonFrom[id]).toISOString()])) };

  // ---------------------------------------------------------------- parity cross-checks (registration §strategies)
  report.parity = {};
  for (const s of SYMBOLS) {
    const trustedSma200 = runSma4h(bars4h[s], { n: 200, costPerSide: S3, borrowPerHour: 0 });
    const mineSma200 = runBinaryFilter(bars4h[s], want[s].SMA200_4H, { costPerSide: S3, barHours: 4 });
    const trustedSma840 = runSma4h(bars4h[s], { n: 840, costPerSide: S3, borrowPerHour: 0 });
    const mineSma840 = runBinaryFilter(bars4h[s], want[s].SLOW_SMA840_4H_V1, { costPerSide: S3, barHours: 4 });
    const trustedEma20 = runFilter(barsD[s], 20, -Infinity, Infinity); // hardcoded 0.15% cost inside runFilter
    const mineEma20 = runBinaryFilter(barsD[s], want[s].EMA20_DAILY, { costPerSide: S3, barHours: 24 });
    report.parity[s] = {
      sma200: { trustedNetCagr: trustedSma200.netCagr, mineNetCagr: mineSma200.netCagr, diff: mineSma200.netCagr - trustedSma200.netCagr },
      sma840: { trustedNetCagr: trustedSma840.netCagr, mineNetCagr: mineSma840.netCagr, diff: mineSma840.netCagr - trustedSma840.netCagr },
      ema20: { trustedCagr: trustedEma20.cagr, mineNetCagr: mineEma20.netCagr, diff: mineEma20.netCagr - trustedEma20.cagr }
    };
  }

  // ---------------------------------------------------------------- item 1: registered variants, all windows
  report.item1 = {};
  for (const s of SYMBOLS) {
    report.item1[s] = {};
    for (const id of STRATS) {
      const b = barsOf[id][s], h = hoursOf[id];
      const windows = {
        a_full_history: { fromMs: -Infinity, toMs: Infinity },
        b_common_window: { fromMs: commonFrom[id], toMs: Infinity },
        c1_2020_2023: { fromMs: -Infinity, toMs: SPLIT },
        c2_2024_2026: { fromMs: SPLIT, toMs: Infinity }
      };
      report.item1[s][id] = {};
      for (const [wn, w] of Object.entries(windows)) {
        const gross = runBinaryFilter(b, want[s][id], { costPerSide: 0, barHours: h, ...w });
        const net = runBinaryFilter(b, want[s][id], { costPerSide: S3, barHours: h, ...w });
        report.item1[s][id][wn] = {
          netCagr: net.netCagr, grossCagr: gross.netCagr, bhCagr: net.bhCagr, sharpe: net.sharpe,
          maxDD: net.maxDD, bhMaxDD: net.bhMaxDD, entries: net.entries, exposure: net.exposure,
          turnoverPerYear: net.turnoverPerYear, win: net.win
        };
      }
    }
  }

  // ---------------------------------------------------------------- item 2: DCA benchmark
  report.item2 = {};
  for (const s of SYMBOLS) {
    report.item2[s] = {};
    for (const id of STRATS) {
      const b = barsOf[id][s];
      const alwaysTrue = new Array(b.n).fill(true);
      const windows = { a_full_history: { fromMs: -Infinity, toMs: Infinity }, b_common_window: { fromMs: commonFrom[id], toMs: Infinity } };
      report.item2[s][id] = {};
      for (const [wn, w] of Object.entries(windows)) {
        const plain = simulateDCA(b, alwaysTrue, { contribution: 100, costPerSide: S3, ...w });
        const intoFilter = simulateDCA(b, want[s][id], { contribution: 100, costPerSide: S3, ...w });
        report.item2[s][id][wn] = {
          plain: { finalValue: plain.finalValue, contributed: plain.contributed, irr: plain.irr, maxDD: plain.maxDD, costPaid: plain.costPaid },
          intoFilter: { finalValue: intoFilter.finalValue, contributed: intoFilter.contributed, irr: intoFilter.irr, maxDD: intoFilter.maxDD, costPaid: intoFilter.costPaid },
          filterBeatsPlainIrr: intoFilter.irr != null && plain.irr != null ? intoFilter.irr > plain.irr : null
        };
      }
    }
  }

  // ---------------------------------------------------------------- item 3: vol-target + no-trade buffer overlay
  report.item3 = {};
  const OVERLAY_STRATS = ['SMA200_4H', 'EMA20_DAILY'];
  for (const s of SYMBOLS) {
    report.item3[s] = {};
    for (const id of OVERLAY_STRATS) {
      const b = barsOf[id][s], h = hoursOf[id];
      const volWindowBars = h === 24 ? 20 : 20 * 6; // trailing 20 DAYS regardless of bar granularity
      const windows = { a_full_history: { fromMs: -Infinity, toMs: Infinity }, b_common_window: { fromMs: commonFrom[id], toMs: Infinity } };
      report.item3[s][id] = {};
      for (const [wn, w] of Object.entries(windows)) {
        const binary = runBinaryFilter(b, want[s][id], { costPerSide: S3, barHours: h, ...w });
        const overlayDefault = runWeightedFilter(b, want[s][id], { costPerSide: S3, barHours: h, targetVol: 0.4, buffer: 0.1, volWindow: volWindowBars, ...w });
        const overlaySensitivity = runWeightedFilter(b, want[s][id], { costPerSide: S3, barHours: h, targetVol: 0.2, buffer: 0.1, volWindow: volWindowBars, ...w }); // SENSITIVITY: source repo's own targetVol
        report.item3[s][id][wn] = {
          binary: { netCagr: binary.netCagr, sharpe: binary.sharpe, maxDD: binary.maxDD, turnoverPerYear: binary.turnoverPerYear },
          overlay_targetVol40: { netCagr: overlayDefault.netCagr, sharpe: overlayDefault.sharpe, maxDD: overlayDefault.maxDD, turnoverPerYear: overlayDefault.turnoverPerYear },
          SENSITIVITY_overlay_targetVol20: { netCagr: overlaySensitivity.netCagr, sharpe: overlaySensitivity.sharpe, maxDD: overlaySensitivity.maxDD, turnoverPerYear: overlaySensitivity.turnoverPerYear }
        };
      }
    }
  }

  // ---------------------------------------------------------------- item 4: portfolio (common window, EMA20_DAILY per symbol)
  report.item4 = computePortfolio(barsD, want, commonFrom.EMA20_DAILY);

  // ---------------------------------------------------------------- item 5: break-even per side, common window
  report.item5 = {};
  for (const s of SYMBOLS) {
    report.item5[s] = {};
    for (const id of STRATS) {
      const b = barsOf[id][s], h = hoursOf[id];
      const fromMs = commonFrom[id];
      const runFn = (cost) => runBinaryFilter(b, want[s][id], { costPerSide: cost, barHours: h, fromMs, toMs: Infinity });
      const zero = breakEvenCost(runFn, () => 0);
      const beatBh = breakEvenCost(runFn, (r) => r.bhCagr);
      report.item5[s][id] = { breakEvenZero: zero, breakEvenBeatBh: beatBh, actual: S3, marginZero: zero === Infinity ? Infinity : zero / S3, marginBeatBh: beatBh === Infinity ? Infinity : beatBh / S3 };
    }
  }

  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(outDir, 'commands.txt'), 'node scripts/research/edge/wp7-report.js --out var/research/wp7-spot\nnode test-wp7-spot.js\n');
  writeFileSync(path.join(outDir, 'REPORT.md'), renderReport(report));
  console.log(`[wp7-report] wrote ${outDir}/{summary.json,REPORT.md,commands.txt}`);
}

// ---------------------------------------------------------------------- portfolio (Card 1.7, spot-portfolio.js close-to-close convention)

function computePortfolio(barsD, want, fromMs) {
  const idxByT = {};
  for (const s of SYMBOLS) { idxByT[s] = new Map(); for (let i = 0; i < barsD[s].n; i += 1) idxByT[s].set(barsD[s].t[i], i); }
  const days = [...idxByT.BTC.keys()].filter((t) => t >= fromMs && idxByT.ETH.has(t) && idxByT.SOL.has(t)).sort((a, b) => a - b);

  const volWeightBySymbolT = {};
  for (const s of SYMBOLS) {
    const r = runWeightedFilter(barsD[s], want[s].EMA20_DAILY, { costPerSide: 0, barHours: 24, targetVol: 0.4, buffer: 0.1, volWindow: 20, fromMs: -Infinity, toMs: Infinity });
    const m = new Map(); for (const row of r.series) m.set(row.t, row.weight);
    volWeightBySymbolT[s] = m;
  }

  function runWeighted(weightAtCloseFn, costPerSide) {
    let eq = 1, peak = 1, dd = 0, turnoverSum = 0;
    let w = { BTC: 0, ETH: 0, SOL: 0 };
    const rets = [];
    for (let k = 1; k < days.length; k += 1) {
      const t = days[k], tPrev = days[k - 1];
      let ret = 0;
      for (const s of SYMBOLS) { const i = idxByT[s].get(t), iPrev = idxByT[s].get(tPrev); ret += w[s] * (barsD[s].c[i] / barsD[s].c[iPrev] - 1); }
      const before = eq; eq *= 1 + ret;
      const newW = weightAtCloseFn(t);
      const turn = SYMBOLS.reduce((a, s) => a + Math.abs(newW[s] - w[s]), 0);
      if (turn > 1e-12) eq *= 1 - turn * costPerSide;
      turnoverSum += turn;
      w = newW;
      rets.push(eq / before - 1);
      peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak);
    }
    const yrs = (days.length - 1) / 365;
    return { cagr: eq ** (1 / yrs) - 1, sharpe: sharpeArr(rets), maxDD: dd, turnoverPerYear: turnoverSum / yrs };
  }

  const binaryWeightFn = (t) => {
    const longs = SYMBOLS.filter((s) => want[s].EMA20_DAILY[idxByT[s].get(t)]);
    const w = {}; for (const s of SYMBOLS) w[s] = longs.includes(s) ? 1 / longs.length : 0;
    return w;
  };
  const overlayWeightFn = (t) => { const w = {}; for (const s of SYMBOLS) w[s] = (volWeightBySymbolT[s].get(t) ?? 0) / 3; return w; };

  const binary = runWeighted(binaryWeightFn, S3);
  const overlay = runWeighted(overlayWeightFn, S3);

  // fixed-unit B&H
  const p0 = Object.fromEntries(SYMBOLS.map((s) => [s, barsD[s].c[idxByT[s].get(days[0])]]));
  const units = Object.fromEntries(SYMBOLS.map((s) => [s, 1 / 3 / p0[s]]));
  { let peak = 1, dd = 0, prevVal = 1; const rets = [];
    for (let k = 1; k < days.length; k += 1) {
      const t = days[k];
      let val = 0; for (const s of SYMBOLS) val += units[s] * barsD[s].c[idxByT[s].get(t)];
      rets.push(val / prevVal - 1); peak = Math.max(peak, val); dd = Math.max(dd, 1 - val / peak); prevVal = val;
    }
    var fixedBH = { cagr: prevVal ** (1 / ((days.length - 1) / 365)) - 1, sharpe: sharpeArr(rets), maxDD: dd, turnoverPerYear: 0 };
  }

  // monthly-rebalanced B&H
  { const val = { BTC: 1 / 3, ETH: 1 / 3, SOL: 1 / 3 }; let turnoverSum = 0, prevTotal = 1, peak = 1, dd = 0; const rets = [];
    let prevMonth = monthKey(days[0]);
    for (let k = 1; k < days.length; k += 1) {
      const t = days[k], tPrev = days[k - 1];
      for (const s of SYMBOLS) { const i = idxByT[s].get(t), iPrev = idxByT[s].get(tPrev); val[s] *= barsD[s].c[i] / barsD[s].c[iPrev]; }
      let total = SYMBOLS.reduce((a, s) => a + val[s], 0);
      const mk = monthKey(t);
      if (mk !== prevMonth) {
        const target = total / 3;
        const turn = SYMBOLS.reduce((a, s) => a + Math.abs(val[s] - target), 0) / total;
        total *= 1 - turn * S3;
        for (const s of SYMBOLS) val[s] = total / 3;
        turnoverSum += turn; prevMonth = mk;
      }
      rets.push(total / prevTotal - 1); peak = Math.max(peak, total); dd = Math.max(dd, 1 - total / peak); prevTotal = total;
    }
    var monthlyBH = { cagr: prevTotal ** (1 / ((days.length - 1) / 365)) - 1, sharpe: sharpeArr(rets), maxDD: dd, turnoverPerYear: turnoverSum / ((days.length - 1) / 365) };
  }

  return { fromMs, fromIso: new Date(fromMs).toISOString(), days: days.length, binary, overlay, fixedBH, monthlyBH };
}

// ---------------------------------------------------------------------- report rendering

function renderReport(r) {
  const L = [];
  L.push('# WP7 spot trend arm evidence — results (research only)');
  L.push('');
  L.push(`Generated ${r.generatedAt}. See docs/research/harness/WP7_SPOT_REGISTRATION.md for the frozen registration.`);
  L.push('');
  L.push('## Parity cross-checks (registration §Registered strategies)');
  L.push('');
  L.push('| symbol | SMA200 4h (trusted vs mine) | SMA840 4h (trusted vs mine) | EMA20 daily (trusted vs mine) |');
  L.push('|---|---|---|---|');
  for (const s of SYMBOLS) {
    const p = r.parity[s];
    L.push(`| ${s} | ${pct(p.sma200.trustedNetCagr)} vs ${pct(p.sma200.mineNetCagr)} (diff ${num(p.sma200.diff * 100, 4)}pp) | ${pct(p.sma840.trustedNetCagr)} vs ${pct(p.sma840.mineNetCagr)} (diff ${num(p.sma840.diff * 100, 4)}pp) | ${pct(p.ema20.trustedCagr)} vs ${pct(p.ema20.mineNetCagr)} (diff ${num(p.ema20.diff * 100, 4)}pp) |`);
  }
  L.push('');

  L.push('## Item 1 — registered slow-trend variants (Card 1.6/4.4)');
  for (const s of SYMBOLS) {
    L.push(`### ${s}`);
    L.push('| strategy | window | net CAGR | gross CAGR | B&H CAGR | Sharpe | maxDD | B&H maxDD | entries | exposure | turnover/yr | win% |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [id, wins] of Object.entries(r.item1[s])) {
      for (const [wn, v] of Object.entries(wins)) {
        L.push(`| ${id} | ${wn} | ${pct(v.netCagr)} | ${pct(v.grossCagr)} | ${pct(v.bhCagr)} | ${num(v.sharpe)} | ${pct(v.maxDD)} | ${pct(v.bhMaxDD)} | ${v.entries} | ${pct(v.exposure)} | ${num(v.turnoverPerYear, 1)} | ${pct(v.win)} |`);
      }
    }
    L.push('');
  }

  L.push('## Item 2 — DCA benchmark, $100/week Monday UTC (Card 4.1)');
  for (const s of SYMBOLS) {
    L.push(`### ${s}`);
    L.push('| strategy | window | arm | final value | contributed | IRR | maxDD (acct value) | cost paid |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const [id, wins] of Object.entries(r.item2[s])) {
      for (const [wn, v] of Object.entries(wins)) {
        L.push(`| ${id} | ${wn} | plain DCA | ${money(v.plain.finalValue)} | ${money(v.plain.contributed)} | ${pct(v.plain.irr)} | ${pct(v.plain.maxDD)} | ${money(v.plain.costPaid)} |`);
        L.push(`| ${id} | ${wn} | DCA-into-filter | ${money(v.intoFilter.finalValue)} | ${money(v.intoFilter.contributed)} | ${pct(v.intoFilter.irr)} | ${pct(v.intoFilter.maxDD)} | ${money(v.intoFilter.costPaid)} |`);
      }
    }
    L.push('');
  }

  L.push('## Item 3 — vol-target + no-trade-buffer overlay (Card 7.1)');
  L.push('targetVol=40% (registered default), buffer=0.10. SENSITIVITY row uses the source repo\'s own targetVol=20% (portfolio-level number, not registered here).');
  for (const s of SYMBOLS) {
    L.push(`### ${s}`);
    L.push('| strategy | window | arm | net CAGR | Sharpe | maxDD | turnover/yr |');
    L.push('|---|---|---|---|---|---|---|');
    for (const [id, wins] of Object.entries(r.item3[s])) {
      for (const [wn, v] of Object.entries(wins)) {
        L.push(`| ${id} | ${wn} | binary | ${pct(v.binary.netCagr)} | ${num(v.binary.sharpe)} | ${pct(v.binary.maxDD)} | ${num(v.binary.turnoverPerYear, 1)} |`);
        L.push(`| ${id} | ${wn} | overlay targetVol=40% | ${pct(v.overlay_targetVol40.netCagr)} | ${num(v.overlay_targetVol40.sharpe)} | ${pct(v.overlay_targetVol40.maxDD)} | ${num(v.overlay_targetVol40.turnoverPerYear, 1)} |`);
        L.push(`| ${id} | ${wn} | SENSITIVITY overlay targetVol=20% | ${pct(v.SENSITIVITY_overlay_targetVol20.netCagr)} | ${num(v.SENSITIVITY_overlay_targetVol20.sharpe)} | ${pct(v.SENSITIVITY_overlay_targetVol20.maxDD)} | ${num(v.SENSITIVITY_overlay_targetVol20.turnoverPerYear, 1)} |`);
      }
    }
    L.push('');
  }

  L.push('## Item 4 — equal-weight BTC/ETH/SOL portfolio (Card 1.7)');
  L.push(`Common window from ${r.item4.fromIso}, ${r.item4.days} trading days. Each symbol runs its own EMA20-daily filter; close-to-close accounting (spot-portfolio.js convention), cost 0.15% on notional traded.`);
  L.push('');
  L.push('| arm | CAGR | Sharpe | maxDD | turnover/yr |');
  L.push('|---|---|---|---|---|');
  L.push(`| binary equal-weight-among-longs (EMA20 filter) | ${pct(r.item4.binary.cagr)} | ${num(r.item4.binary.sharpe)} | ${pct(r.item4.binary.maxDD)} | ${num(r.item4.binary.turnoverPerYear, 1)} |`);
  L.push(`| vol-overlay equal-weight (EMA20 filter + targetVol 40%/buffer 0.1) | ${pct(r.item4.overlay.cagr)} | ${num(r.item4.overlay.sharpe)} | ${pct(r.item4.overlay.maxDD)} | ${num(r.item4.overlay.turnoverPerYear, 1)} |`);
  L.push(`| B&H fixed units, no rebalance | ${pct(r.item4.fixedBH.cagr)} | ${num(r.item4.fixedBH.sharpe)} | ${pct(r.item4.fixedBH.maxDD)} | 0 |`);
  L.push(`| B&H monthly-rebalanced | ${pct(r.item4.monthlyBH.cagr)} | ${num(r.item4.monthlyBH.sharpe)} | ${pct(r.item4.monthlyBH.maxDD)} | ${num(r.item4.monthlyBH.turnoverPerYear, 1)} |`);
  L.push('');

  L.push('## Item 5 — break-even per side vs actual 0.15%/side, common window per strategy (Card 6.5)');
  L.push('| symbol | strategy | break-even (net=0) | break-even (beat B&H) | actual | margin (net=0) | margin (beat B&H) |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of SYMBOLS) {
    for (const [id, v] of Object.entries(r.item5[s])) {
      L.push(`| ${s} | ${id} | ${pct(v.breakEvenZero)} | ${pct(v.breakEvenBeatBh)} | ${pct(v.actual)} | ${v.marginZero === Infinity ? '+inf' : `${num(v.marginZero)}x`} | ${v.marginBeatBh === Infinity ? '+inf' : `${num(v.marginBeatBh)}x`} |`);
    }
  }
  L.push('');
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
  main(args.out || 'var/research/wp7-spot');
}

export default { computePortfolio };
