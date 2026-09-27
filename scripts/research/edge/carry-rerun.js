#!/usr/bin/env node
/**
 * WP5 item 3 (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md; Card 6.2 in
 * docs/research/BREAKEVEN_COSTS_2026-09-27.md): re-cost the break-even table's "borrow kills"
 * edge-search configs with REAL historical perp funding instead of the static 0.02%/h Jupiter
 * borrow proxy, and against the owner-supplied real Jupiter measurements (2026-09-27):
 *   - Jupiter measured  ~0.0015%/h (perps-api.jup.ag/v1/pool-info, ~10% utilization)
 *   - Jupiter stress     ~0.004%/h (~80% utilization)
 * Trades come from var/edge/train-r1.json (round 1) and var/edge/train.json (round 2, from
 * --main), each {entryTime, exitTime, dir, sym, riskPct, grossR, hours}. Funding events come
 * from var/edge/venues/funding/<venue>_<SYM>.json (scripts/research/edge/fetch-venue.js).
 *
 * "Borrow kills" configs are re-derived here with the same free/with-borrow break-even logic as
 * breakeven.js (not imported, to keep this script's own dependency small and because breakeven.js
 * is a shared CLI, not a module) - see FIXED_BORROW_PER_H below.
 *
 * Command: node scripts/research/edge/carry-rerun.js [--main ../snapshot_tradingview]
 * Output:  var/research/carry-rerun/{REPORT.md,rows.json}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sumFundingOverHold, mergeFundingEvents } from './fetch-venue.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const MAIN = args.main || '../snapshot_tradingview';
const FUNDING_DIR = args.funding || 'var/edge/venues/funding';

// Hourly-rate scenarios, %/h (percent-of-notional units, matching lib.js/breakeven.js convention).
const HOURLY_SCENARIOS = {
  jupiterStatic_0_02: 0.02, // the original break-even-table proxy (docs/research/BREAKEVEN_COSTS_2026-09-27.md)
  jupiterMeasured_0_0015: 0.0015, // owner-measured, ~10% utilization, perps-api.jup.ag/v1/pool-info, 2026-09-27
  jupiterStress_0_004: 0.004 // owner-measured, ~80% utilization stress case
};
const FEE_SCENARIOS = {
  actual: { long: 0.20, short: 0.14, label: '0.20L/0.14S RT (actual)' },
  cexTaker: { long: 0.11, short: 0.11, label: '0.11 RT flat (CEX taker variant)' }
};

// ---------------------------------------------------------------------- load trades, classify "borrow kills"

function loadTrades() {
  const out = {}; // id -> trades[]
  for (const f of ['var/edge/train-r1.json', path.join(MAIN, 'var/edge/train.json')]) {
    if (!fs.existsSync(f)) { console.error(`skip missing ${f}`); continue; }
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const [id, tr] of Object.entries(d.trades)) {
      out[id] = tr.filter((x) => Number.isFinite(x.grossR) && x.riskPct > 0 && Number.isFinite(x.entryTime) && Number.isFinite(x.exitTime));
    }
  }
  return out;
}

/** Same break-even shape as breakeven.js's perTrade(), used only to reproduce its "borrow kills" verdict. */
function classify(trades, fee, borrowPerH) {
  const sumG = trades.reduce((s, x) => s + x.grossR, 0);
  const sumInv = trades.reduce((s, x) => s + 1 / x.riskPct, 0);
  const sumB = trades.reduce((s, x) => s + (borrowPerH * x.hours) / x.riskPct, 0);
  const longShare = trades.filter((x) => x.dir === 'long').length / trades.length;
  const actualRt = longShare * fee.long + (1 - longShare) * fee.short;
  const beFree = sumG / sumInv;
  const beBorrow = (sumG - sumB) / sumInv;
  return { beFree, beBorrow, actualRt, longShare, verdict: beFree <= 0 ? 'no gross edge' : beFree < actualRt ? 'fees kill' : beBorrow < actualRt ? 'borrow kills' : trades.length < 30 ? 'survives (n<30)' : 'survives' };
}

// ---------------------------------------------------------------------- funding lookup

function loadFundingIndex(venue) {
  const idx = {};
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    const f = path.join(FUNDING_DIR, `${venue}_${sym}.json`);
    if (!fs.existsSync(f)) { idx[sym] = null; continue; }
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    idx[sym] = mergeFundingEvents(d.events);
  }
  return idx;
}

function meanNetR(trades, feePct) {
  // feePct: fn(trade) -> % round-trip cost for that trade's direction
  const rs = trades.map((t) => t.grossR - feePct(t) / t.riskPct);
  return rs.reduce((s, x) => s + x, 0) / rs.length;
}

/** Mean net R and coverage under one hourly-rate scenario (static %/h on the trade's own hold). */
function scenarioHourly(trades, fee, hourlyPerH) {
  const netR = meanNetR(trades, (t) => (t.dir === 'long' ? fee.long : fee.short) + hourlyPerH * t.hours);
  return { netR, verdict: netR > 0 ? 'survives' : 'fails' };
}

/** Mean net R and coverage under real per-trade funding from one venue's event index. */
function scenarioFunding(trades, fee, fundingIdx) {
  let covered = 0, uncovered = 0, eventTotal = 0;
  const netRs = [];
  const longFundingPct = []; const longHours = [];
  for (const t of trades) {
    const events = fundingIdx[t.sym];
    if (!events) { uncovered += 1; continue; }
    const { fundingPct, count } = sumFundingOverHold(events, t.entryTime, t.exitTime, t.dir);
    eventTotal += count;
    covered += 1;
    const feePct = t.dir === 'long' ? fee.long : fee.short;
    netRs.push(t.grossR - (feePct + fundingPct) / t.riskPct);
    if (t.dir === 'long') { longFundingPct.push(fundingPct); longHours.push(t.hours); }
  }
  const netR = netRs.length ? netRs.reduce((s, x) => s + x, 0) / netRs.length : null;
  const sumLongFundingPct = longFundingPct.reduce((s, x) => s + x, 0);
  const sumLongHours = longHours.reduce((s, x) => s + x, 0);
  const avgLongCarryPctPerH = sumLongHours > 0 ? sumLongFundingPct / sumLongHours : null;
  return { netR, verdict: netR == null ? 'n/a' : netR > 0 ? 'survives' : 'fails', covered, uncovered, avgEventsPerTrade: covered ? eventTotal / covered : 0, avgLongCarryPctPerH };
}

// ---------------------------------------------------------------------- main

function main() {
  const outDir = 'var/research/carry-rerun';
  fs.mkdirSync(outDir, { recursive: true });
  const tradesById = loadTrades();
  const fundingByVenue = { hyperliquid: loadFundingIndex('hyperliquid'), okx: loadFundingIndex('okx') };

  // OKX funding depth check (reported, not silently skipped): does it overlap ANY trade window?
  const okxWindow = { from: null, to: null };
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    const ev = fundingByVenue.okx[sym];
    if (ev && ev.length) {
      okxWindow.from = okxWindow.from == null ? ev[0].time : Math.min(okxWindow.from, ev[0].time);
      okxWindow.to = okxWindow.to == null ? ev[ev.length - 1].time : Math.max(okxWindow.to, ev[ev.length - 1].time);
    }
  }

  const rows = [];
  for (const [id, trades] of Object.entries(tradesById)) {
    if (!trades.length) continue;
    const cls = classify(trades, FEE_SCENARIOS.actual, HOURLY_SCENARIOS.jupiterStatic_0_02);
    if (cls.verdict !== 'borrow kills') continue; // WP5 scope: only the break-even table's "borrow kills" group

    const row = { id, n: trades.length, longSharePct: cls.longShare * 100, originalVerdict: cls.verdict, byFee: {} };
    for (const [feeKey, fee] of Object.entries(FEE_SCENARIOS)) {
      const hourly = {};
      for (const [scKey, rate] of Object.entries(HOURLY_SCENARIOS)) hourly[scKey] = scenarioHourly(trades, fee, rate);
      const hl = scenarioFunding(trades, fee, fundingByVenue.hyperliquid);
      const okx = scenarioFunding(trades, fee, fundingByVenue.okx);
      row.byFee[feeKey] = { label: fee.label, hourly, hyperliquidReal: hl, okxReal: okx };
    }
    rows.push(row);
  }
  // Rank by how much the verdict improves under real funding (biggest flips first), then by n.
  rows.sort((a, b) => (b.byFee.actual.hyperliquidReal.netR ?? -Infinity) - (a.byFee.actual.hyperliquidReal.netR ?? -Infinity));

  // ---------------------------------------------------------------- report

  const pct = (x, d = 3) => (x == null ? '—' : `${(x >= 0 ? '+' : '')}${x.toFixed(d)}`);
  const out = [];
  out.push('## Card 6.2 carry re-cost — "borrow kills" edge-search configs (real funding vs Jupiter)\n');
  out.push(`Trades: var/edge/train-r1.json (round 1) + ${path.join(MAIN, 'var/edge/train.json')} (round 2). Funding: var/edge/venues/funding/ (fetch-venue.js). ${rows.length} of 16 "borrow kills" configs classified (same free/with-borrow logic as breakeven.js, actual fees).\n`);
  out.push(`OKX funding coverage: ${okxWindow.from ? `${new Date(okxWindow.from).toISOString()} -> ${new Date(okxWindow.to).toISOString()}` : 'none'} — does **not** overlap the edge-search trade window (2024-10-01 -> 2026-01-13), so OKX real-funding net R is reported as n/a below (0 covered trades). Hyperliquid funding covers 2023-05-12 -> now, full coverage of every trade.\n`);
  out.push('Net R columns are the mean net R per trade under that cost model, at **actual fees** (0.20% long / 0.14% short round trip). "Jupiter static" reproduces the original break-even-table proxy; "Jupiter measured"/"Jupiter stress" use the owner-measured real Jupiter borrow rates (2026-09-27, perps-api.jup.ag/v1/pool-info: ~0.0015%/h at ~10% utilization, ~0.004%/h at ~80%). "Hyperliquid real" replaces the static %/h with each trade\'s own summed funding over its actual hold. Verdict: survives = mean net R > 0.\n');
  out.push('| config | n | long% | Jupiter static 0.02%/h | Jupiter measured 0.0015%/h | Jupiter stress 0.004%/h | Hyperliquid real funding | avg long carry %/h (HL) | verdict change (static -> HL real) |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const a = r.byFee.actual;
    const carry = a.hyperliquidReal.avgLongCarryPctPerH;
    out.push(`| ${r.id} | ${r.n} | ${r.longSharePct.toFixed(0)}% | ${pct(a.hourly.jupiterStatic_0_02.netR)} (${a.hourly.jupiterStatic_0_02.verdict}) | ${pct(a.hourly.jupiterMeasured_0_0015.netR)} (${a.hourly.jupiterMeasured_0_0015.verdict}) | ${pct(a.hourly.jupiterStress_0_004.netR)} (${a.hourly.jupiterStress_0_004.verdict}) | ${pct(a.hyperliquidReal.netR)} (${a.hyperliquidReal.verdict}) | ${carry == null ? '—' : carry.toFixed(4)} | ${a.hourly.jupiterStatic_0_02.verdict} -> ${a.hyperliquidReal.verdict} |`);
  }
  out.push('');
  out.push('### CEX taker fee variant (0.11% round trip flat, both directions)\n');
  out.push('| config | Jupiter measured 0.0015%/h | Jupiter stress 0.004%/h | Hyperliquid real funding |');
  out.push('|---|---|---|---|');
  for (const r of rows) {
    const c = r.byFee.cexTaker;
    out.push(`| ${r.id} | ${pct(c.hourly.jupiterMeasured_0_0015.netR)} (${c.hourly.jupiterMeasured_0_0015.verdict}) | ${pct(c.hourly.jupiterStress_0_004.netR)} (${c.hourly.jupiterStress_0_004.verdict}) | ${pct(c.hyperliquidReal.netR)} (${c.hyperliquidReal.verdict}) |`);
  }
  out.push('');
  const survivors = rows.filter((r) => r.byFee.actual.hyperliquidReal.verdict === 'survives');
  out.push(`### Summary\n`);
  out.push(`- ${survivors.length}/${rows.length} "borrow kills" configs flip to net-positive under Hyperliquid real funding at actual fees: ${survivors.length ? survivors.map((r) => r.id).join(', ') : 'none'}.`);
  const measuredSurvivors = rows.filter((r) => r.byFee.actual.hourly.jupiterMeasured_0_0015.verdict === 'survives');
  out.push(`- ${measuredSurvivors.length}/${rows.length} flip to net-positive at the owner-measured real Jupiter rate (0.0015%/h): ${measuredSurvivors.length ? measuredSurvivors.map((r) => r.id).join(', ') : 'none'}.`);
  const stressSurvivors = rows.filter((r) => r.byFee.actual.hourly.jupiterStress_0_004.verdict === 'survives');
  out.push(`- ${stressSurvivors.length}/${rows.length} still survive at the 0.004%/h stress rate: ${stressSurvivors.length ? stressSurvivors.map((r) => r.id).join(', ') : 'none'}.`);
  out.push('- Funding ≠ Jupiter borrow: funding is a CEX perp mechanism (periodic payment between longs and shorts, can be negative); Jupiter borrow is a pool-utilization interest rate charged to the position holder regardless of sign. They are reported side by side as reference bands, not substitutes. See docs/research/harness/WP5_VENUES.md for the full caveat.');
  out.push('');

  fs.writeFileSync(path.join(outDir, 'REPORT.md'), `${out.join('\n')}\n`);
  fs.writeFileSync(path.join(outDir, 'rows.json'), JSON.stringify({ generatedAt: new Date().toISOString(), hourlyScenarios: HOURLY_SCENARIOS, feeScenarios: FEE_SCENARIOS, okxWindow, rows }, null, 1));
  console.log(out.join('\n'));
  console.log(`\n[carry-rerun] wrote ${outDir}/{REPORT.md,rows.json}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export default { classify, scenarioHourly, scenarioFunding, loadFundingIndex, HOURLY_SCENARIOS, FEE_SCENARIOS };
