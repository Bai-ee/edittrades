#!/usr/bin/env node
/**
 * V-B shadow scoring (T6 completion plan D-variant, docs/OWNER_DECISIONS_2026-09-24.md,
 * owner-approved 2026-09-24): owner chose to stay on V1c live and run V-B (gross minRR
 * 2.5, `flagPlan.minNetRR` unchanged at 2.0) as a shadow variant instead. The variant
 * itself is computed by the engine (`lib/flagTradePlan.js`'s `buildFlagTradePlan`
 * `shadowVariants` option - real ATR, real retest-hold, no tracker-side approximation)
 * and published on `flagTradePlan.shadow.vB` only when it differs from the live plan.
 * SHADOW MODE, never traded: this script only measures what V-B *would* have called,
 * same convention as breakout-entry.js/shadow.js for the breakout-close entry - never
 * feeds flagTradePlan, flagRecommendation, class logic, or any gate.
 *
 * One row per candidateId, keyed off the FIRST captured row whose shadow.vB.status is
 * 'ready' - the tracker's own ready close for the variant, same convention score.js
 * uses for the real plan (filled at that close, prefilled, walked forward on 1m
 * candles via walkShadow). A later re-flip (ready -> conditional -> ready) on the same
 * candidateId is not re-walked - the first ready moment is the one entry fill.
 *
 * Idempotent: a resolved row (tp1/stop/expired) is kept exactly as written on a later
 * run. Read-only with respect to the rest of the store - never touches
 * data/outcomes.jsonl, data/aggregates.json, or data/shadow(-outcomes).json{,l} (the
 * breakout-entry shadow, an unrelated feature); purely an additional read plus two new
 * output files.
 *
 * Cannot backfill: `flagTradePlan.shadow` only exists on rows captured after this
 * ships, so accrual starts at deploy, not before. Revisit 2026-10-07 - n >= 20 scored
 * plans each side (V1c live vs this), docs/OWNER_DECISIONS_2026-09-24.md D-variant. If
 * V-B still beats V1c on net expectancy out of sample, the owner signs the gross minRR
 * 2.5 rule change; otherwise V1c stays as shipped.
 *
 * Usage: node vb-shadow.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJsonl, writeJson } from './store.js';
import { isFiniteNumber } from './walk-outcome.js';
import { walkShadow } from './breakout-entry.js';
import { costR } from './costs.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// T6 completion plan B2, D-cost (docs/OWNER_DECISIONS_2026-09-24.md, owner-approved
// 2026-09-24): positions are funded from USDC/USDT, so a long pays the 0.34%
// round-trip swap-in/out rate and a short pays 0.14%; an unresolved direction falls
// back to the shipped flat 0.20% (costs.js's costR). Same numbers
// scripts/replay-rules.js's netR_sensDir uses for the offline replay research.
const DIR_COST_PCT_LONG = 0.0034;
const DIR_COST_PCT_SHORT = 0.0014;

function costRAtPct(entry, stop, pct) {
  if (!isFiniteNumber(entry) || !isFiniteNumber(stop) || entry <= 0) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return (pct * entry) / risk;
}

/** Net R at the shipped flat 0.20% cost, and at the owner's answered per-direction cost. Null grossR (open/expired) -> both null. */
function netRs(entry, stop, direction, walk) {
  const grossR = walk.outcome === 'stop' ? -1 : walk.outcome === 'tp1' ? walk.r : null;
  if (!isFiniteNumber(grossR)) return { netR: null, netRDirCost: null };
  const flat = costR(entry, stop);
  const dirPct = direction === 'long' ? DIR_COST_PCT_LONG : direction === 'short' ? DIR_COST_PCT_SHORT : 0.0020;
  const dir = costRAtPct(entry, stop, dirPct);
  return {
    netR: flat === null ? null : roundN(grossR - flat, 4),
    netRDirCost: dir === null ? null : roundN(grossR - dir, 4)
  };
}

export function vbShadowOutcomesFile(dataDir) {
  return path.join(dataDir, 'vb-shadow-outcomes.jsonl');
}

export function vbShadowSummaryFile(dataDir) {
  return path.join(dataDir, 'vb-shadow.json');
}

/** A row is terminal once its walk resolves (tp1/stop) or the 24h tracking window expires. */
function isTerminal(outcome) {
  return outcome === 'tp1' || outcome === 'stop' || outcome === 'expired';
}

/**
 * One row per candidateId first seen ready under `flagTradePlan.shadow.vB`, walked
 * forward on 1m candles from that ready close.
 * @param {Array<Object>} callRows - readAllCalls output (any order in)
 * @param {Object<string, Array<Object>>} candlesBySymbol - readCandles(dataDir, '1m') output
 * @param {Array<Object>} [previous=[]] - existing vb-shadow-outcomes.jsonl rows
 * @param {number} [nowMs=Date.now()]
 * @returns {Array<Object>}
 */
export function computeVbShadowRows(callRows, candlesBySymbol, previous = [], nowMs = Date.now()) {
  const sorted = [...(Array.isArray(callRows) ? callRows : [])]
    .filter((r) => r && r.symbol && r.closedThrough && r.flagTradePlan && r.flagTradePlan.shadow && r.flagTradePlan.shadow.vB)
    .sort((a, b) => Date.parse(a.closedThrough) - Date.parse(b.closedThrough));

  const firstReady = new Map(); // candidateId -> capture row
  for (const row of sorted) {
    const vb = row.flagTradePlan.shadow.vB;
    if (vb.status !== 'ready' || !vb.candidateId) continue;
    if (!firstReady.has(vb.candidateId)) firstReady.set(vb.candidateId, row);
  }

  const prevById = new Map((previous || []).map((r) => [r.candidateId, r]));
  const nowIso = new Date(nowMs).toISOString();
  const out = [];

  for (const [candidateId, row] of firstReady) {
    const prev = prevById.get(candidateId);
    if (prev && isTerminal(prev.outcome)) { out.push(prev); continue; }

    const vb = row.flagTradePlan.shadow.vB;
    const candles1m = (candlesBySymbol && candlesBySymbol[row.symbol]) || [];
    const fromMs = Date.parse(row.closedThrough);
    const walk = walkShadow({ dir: vb.direction, entry: vb.entry, stop: vb.stop, tp1: vb.tp1 }, candles1m, fromMs, WINDOW_MS);
    const { netR, netRDirCost } = netRs(vb.entry, vb.stop, vb.direction, walk);

    out.push({
      candidateId,
      symbol: row.symbol,
      timeframe: vb.timeframe ?? null,
      direction: vb.direction ?? null,
      readyAt: row.closedThrough,
      entry: isFiniteNumber(vb.entry) ? vb.entry : null,
      stop: isFiniteNumber(vb.stop) ? vb.stop : null,
      tp1: isFiniteNumber(vb.tp1) ? vb.tp1 : null,
      grossRR: isFiniteNumber(vb.grossRR) ? vb.grossRR : null,
      netRR: isFiniteNumber(vb.netRR) ? vb.netRR : null,
      outcome: walk.outcome,
      r: walk.r,
      netR,
      netRDirCost,
      resolvedAt: isFiniteNumber(walk.resolvedAt) ? new Date(walk.resolvedAt).toISOString() : null,
      computedAt: isTerminal(walk.outcome) ? nowIso : null
    });
  }

  return out.sort((a, b) => Date.parse(a.readyAt) - Date.parse(b.readyAt) || a.candidateId.localeCompare(b.candidateId));
}

/**
 * n / win rate / gross expectancy / net expectancy (flat 0.20% and dir-cost) over
 * resolved (tp1/stop) rows; open/expired counted separately.
 * @param {Array<Object>} rows - vb-shadow-outcomes.jsonl rows
 * @returns {Object}
 */
export function vbShadowSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const decided = list.filter((r) => r.outcome === 'tp1' || r.outcome === 'stop');
  const wins = decided.filter((r) => r.outcome === 'tp1').length;
  const rs = decided.map((r) => r.r).filter(isFiniteNumber);
  const netRsFlat = decided.map((r) => r.netR).filter(isFiniteNumber);
  const netRsDir = decided.map((r) => r.netRDirCost).filter(isFiniteNumber);
  const avg = (arr) => (arr.length ? roundN(arr.reduce((a, b) => a + b, 0) / arr.length, 4) : null);
  return {
    n: list.length,
    resolvedN: decided.length,
    open: list.filter((r) => r.outcome === 'open').length,
    expired: list.filter((r) => r.outcome === 'expired').length,
    winRate: decided.length ? roundN(wins / decided.length, 4) : null,
    grossExpectancyR: avg(rs),
    netExpectancyR: avg(netRsFlat),
    netExpectancyR_dirCost: avg(netRsDir)
  };
}

/** Read calls + 1m candles + previous outcomes from `dataDir`, write both output files. */
export function vbShadowDataDir(dataDir, nowMs = Date.now()) {
  const callRows = readAllCalls(dataDir);
  const candlesBySymbol = readCandles(dataDir, '1m');
  const previous = readJsonl(vbShadowOutcomesFile(dataDir));
  const rows = computeVbShadowRows(callRows, candlesBySymbol, previous, nowMs);
  writeJsonl(vbShadowOutcomesFile(dataDir), rows);
  const summary = { generatedAt: new Date(nowMs).toISOString(), ...vbShadowSummary(rows) };
  writeJson(vbShadowSummaryFile(dataDir), summary);
  return { rows, summary };
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const { rows, summary } = vbShadowDataDir(opts.data, nowMs);
  console.log(`[tracker:vb-shadow] ${rows.length} candidate(s) -> ${vbShadowOutcomesFile(opts.data)} n=${summary.n} resolvedN=${summary.resolvedN} netExp=${summary.netExpectancyR ?? '-'} netExpDirCost=${summary.netExpectancyR_dirCost ?? '-'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:vb-shadow] ${err.message}`);
    process.exit(1);
  }
}

export default { vbShadowOutcomesFile, vbShadowSummaryFile, computeVbShadowRows, vbShadowSummary, vbShadowDataDir };
