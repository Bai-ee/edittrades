// WP4 (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md), item 2: exact per-trade
// break-even for re-flag-retest-1h, from the per-signal records the swing harness
// (scripts/swing/run.js) writes - NOT the aggregate approximation
// scripts/research/edge/breakeven.js's `perTrade` uses for swing rows (grossExpR x
// medianStop). Same formula family as that script's own `perTrade` for edge-search rows,
// applied here per-trade to a swing rule's resolved signals.
//
// Per-trade net R at round-trip cost c (fraction) and borrow b (%/h) on a trade held
// `hours` with entry/stop defining `riskPct = |entry-stop|/entry`:
//   netR_i = grossR_i - (c + b*hours_i/100) * entry_i / |entry_i - stop_i|
//          = grossR_i - (c + b*hours_i/100) / riskPct_i     (riskPct as a fraction)
// Per-trade break-even round trip (net R_i = 0, solved for c, at a given b):
//   c*_i = grossR_i * riskPct_i - b*hours_i/100
// Aggregate (mean net R = 0) break-even, exact (not aggregate-approximate):
//   c* = (sum(grossR_i * riskPct_i) - b/100 * sum(hours_i)) / n   -- wrong, see below.
// Net R is per-trade in R units (already normalized by that trade's own risk), so it is
// NOT summed with weight 1/riskPct like breakeven.js's edge-search rows (those are $-risk
// weighted trades sized to a fixed % risk; swing signals are already R-normalized, one
// trade = 1R risk by construction). The aggregate break-even here solves
// mean_i(grossR_i - (c + b*hours_i/100)/riskPct_i) = 0 for c, i.e. matches
// scripts/research/edge/breakeven.js's own `perTrade` weighting exactly (1/riskPct sums),
// which is the correct treatment when cost is a % of notional entered at riskPct% stop
// distance. This script mirrors that formula per-trade, not via the aggregate
// grossExpR x medianStop shortcut breakeven.js falls back to for swing rows (its comment:
// "swing rules (aggregates only ... approximate)").
//
// Usage: node scripts/research/harness/breakeven-per-trade.js [--in <signals.json>] [--out-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const IN = args.in || 'var/research/wp4-matched/swing-deep2y/re-flag-retest-1h.json';
const OUT_DIR = args['out-dir'] || 'var/research/wp4-matched/breakeven';

// Actual EditTrades perps costs (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md
// "Governing rule"; WP4 COMMON RULES): 0.20% long / 0.14% short round trip.
export const ACTUAL = { long: 0.0020, short: 0.0014 };
export const BORROW_SCENARIOS = [
  { id: 'base_0.02', perH: 0.0002 }, // 0.02%/h
  { id: 'jupiter_0.024', perH: 0.00024 }, // 0.024%/h, Jupiter docs figure
  // Coordinator update (2026-09-27, WP4 mid-task): real Jupiter borrow measured today via
  // Jupiter's own API at ~0.0013-0.0015%/h, ~0.004%/h at 80% utilization - both far below
  // the two scenarios above. Reported alongside, not instead of, them.
  { id: 'measured_0.0015', perH: 0.000015 },
  { id: 'stress80pct_0.004', perH: 0.00004 }
];
const RESOLVED = new Set(['win', 'loss', 'timeout', 'structure_exit']);

export function loadTrades(studyJson) {
  const out = [];
  for (const [symbol, v] of Object.entries(studyJson.perSymbol || {})) {
    for (const s of v.signals || []) {
      if (!RESOLVED.has(s.outcome?.status)) continue;
      const grossR = s.outcome.status === 'loss' ? -1 : s.outcome.r;
      const riskPct = Math.abs(s.entry - s.stop) / s.entry; // fraction, e.g. 0.014
      const hours = (s.outcome.holdCandles || 0) / 60; // holdCandles are 1m candles (scoreSignal/walkOutcome)
      if (!(riskPct > 0) || !Number.isFinite(grossR)) continue;
      out.push({ symbol, direction: s.direction, entry: s.entry, stop: s.stop, closedThrough: s.closedThrough, grossR, riskPct, hours });
    }
  }
  return out;
}

/** Per-trade break-even round trip (fraction of notional) at a given hourly borrow. */
export function perTradeBreakeven(t, borrowPerH) {
  return t.grossR * t.riskPct - borrowPerH * t.hours; // c* solving netR_i = 0
}

/** Max tolerable hourly borrow at zero round-trip fee (netR_i = 0 solved for b). */
export function perTradeMaxBorrow(t) {
  return t.hours > 0 ? (t.grossR * t.riskPct) / t.hours : null;
}

export function netRAt(t, costFrac, borrowPerH) {
  return t.grossR - (costFrac + borrowPerH * t.hours) / t.riskPct;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

function aggregateBreakeven(trades, borrowPerH) {
  // Same weighting scripts/research/edge/breakeven.js's perTrade() uses (sum grossR /
  // sum 1/riskPct, borrow term weighted the same way) - the exact per-trade analogue of
  // that script's edge-search treatment, not the swing-row aggregate approximation.
  const sumG = trades.reduce((s, t) => s + t.grossR, 0);
  const sumInv = trades.reduce((s, t) => s + 1 / t.riskPct, 0);
  const sumBH = trades.reduce((s, t) => s + (borrowPerH * t.hours) / t.riskPct, 0);
  return (sumG - sumBH) / sumInv;
}

/** Aggregate max tolerable borrow %/h at actual fees (mean net R = 0), same formula as
 * scripts/research/edge/breakeven.js's perTrade().maxBorrow, computed here exactly
 * (per-trade hours/riskPct, not the swing-row aggregate median-based approximation). */
function aggregateMaxBorrow(trades, actualRt) {
  const sumG = trades.reduce((s, t) => s + t.grossR, 0);
  const sumInv = trades.reduce((s, t) => s + 1 / t.riskPct, 0);
  const sumH = trades.reduce((s, t) => s + t.hours / t.riskPct, 0);
  return sumH > 0 ? (sumG - actualRt * sumInv) / sumH : null;
}

function main() {
  const inPath = path.isAbsolute(IN) ? IN : path.join(process.cwd(), IN);
  const study = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const trades = loadTrades(study);

  const perTrade = trades.map((t) => {
    const row = { ...t };
    for (const sc of BORROW_SCENARIOS) {
      row[`beWithBorrow_${sc.id}`] = perTradeBreakeven(t, sc.perH);
      const actualRt = t.direction === 'long' ? ACTUAL.long : ACTUAL.short;
      row[`netR_actual_${sc.id}`] = netRAt(t, actualRt, sc.perH);
    }
    row.beNoBorrow = t.grossR * t.riskPct;
    row.maxBorrowPerHAtZeroFee = perTradeMaxBorrow(t);
    return row;
  });

  const longShare = trades.filter((t) => t.direction === 'long').length / trades.length;
  const actualRtWeighted = longShare * ACTUAL.long + (1 - longShare) * ACTUAL.short;

  const summary = {
    source: inPath,
    n: trades.length,
    longShare,
    actualRtWeighted,
    beNoBorrow_aggregate: aggregateBreakeven(trades, 0),
    maxTolerableBorrowPerH_aggregate: aggregateMaxBorrow(trades, actualRtWeighted),
    perScenario: {}
  };
  for (const sc of BORROW_SCENARIOS) {
    const beAgg = aggregateBreakeven(trades, sc.perH);
    const netRs = trades.map((t) => netRAt(t, actualRtWeighted, sc.perH));
    const beRows = perTrade.map((r) => r[`beWithBorrow_${sc.id}`]);
    summary.perScenario[sc.id] = {
      borrowPerH: sc.perH,
      beWithBorrow_aggregate: beAgg,
      margin: beAgg / actualRtWeighted,
      meanNetR_atActual: mean(netRs),
      medianNetR_atActual: median(netRs),
      shareNetRPositive: netRs.filter((x) => x > 0).length / netRs.length,
      perTrade_beMean: mean(beRows),
      perTrade_beMedian: median(beRows)
    };
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'per-trade.json'), JSON.stringify(perTrade, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) main();
