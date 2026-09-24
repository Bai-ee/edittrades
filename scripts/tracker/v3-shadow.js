#!/usr/bin/env node
/**
 * 3R shadow scoring (former live rule) - T6 completion plan "D-variant revised"
 * (docs/OWNER_DECISIONS_2026-09-24.md, owner decision 2026-09-24, supersedes the
 * original D-variant): the owner moved the live rule to gross minRR 2.5 with the net
 * gate off (lean toward producing GOOD calls so the strategy can be tracked and
 * tweaked). The former live rule (gross minRR 3.0, `flagPlan.minNetRR` 2.0) is now the
 * shadow comparator instead, renamed `v3` (was `vB` when 2.5 was the shadow and 3.0
 * was live - the two variants swapped roles, not the mechanism). Computed by the
 * engine (`lib/flagTradePlan.js`'s `buildFlagTradePlan` `shadowVariants` option - real
 * ATR, real retest-hold, no tracker-side approximation) and published on
 * `flagTradePlan.shadow.v3` only when it differs from the live plan. SHADOW MODE,
 * never traded: this script only measures what the stricter 3R rule *would* have
 * called, same convention as breakout-entry.js/shadow.js for the breakout-close entry
 * - never feeds flagTradePlan, flagRecommendation, class logic, or any gate.
 *
 * One row per candidateId, keyed off the FIRST captured row whose shadow.v3.status is
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
 * ships, so accrual restarts at this deploy. Revisit per the owner's own schedule for
 * the "D-variant revised" decision - if 3R would have done meaningfully better out of
 * sample, that is the signal to reconsider, not a scheduled reversal.
 *
 * Usage: node v3-shadow.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readCandles, readJsonl, writeJsonl, writeJson } from './store.js';
import { isFiniteNumber } from './walk-outcome.js';
import { walkShadow } from './breakout-entry.js';
import { netR as netRAt } from './costs.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Net R at the shipped flat 0.20% cost, and at the owner-answered per-direction cost
 * (T6 completion plan C1, D-cost decision, `docs/OWNER_DECISIONS_2026-09-24.md` -
 * `costs.js`'s `netR`, the same helper `aggregate.js` now uses for the live rule's
 * real GOOD-call net expectancy, so this shadow tile and the live numbers stay
 * comparable).
 */
function netRs(entry, stop, direction, walk) {
  const grossR = walk.outcome === 'stop' ? -1 : walk.outcome === 'tp1' ? walk.r : null;
  if (!isFiniteNumber(grossR)) return { netR: null, netRDirCost: null };
  const flat = netRAt(entry, stop, grossR);
  const dir = netRAt(entry, stop, grossR, direction);
  return {
    netR: flat === null ? null : roundN(flat, 4),
    netRDirCost: dir === null ? null : roundN(dir, 4)
  };
}

export function v3ShadowOutcomesFile(dataDir) {
  return path.join(dataDir, 'v3-shadow-outcomes.jsonl');
}

export function v3ShadowSummaryFile(dataDir) {
  return path.join(dataDir, 'v3-shadow.json');
}

/** A row is terminal once its walk resolves (tp1/stop) or the 24h tracking window expires. */
function isTerminal(outcome) {
  return outcome === 'tp1' || outcome === 'stop' || outcome === 'expired';
}

/**
 * One row per candidateId first seen ready under `flagTradePlan.shadow.v3`, walked
 * forward on 1m candles from that ready close.
 * @param {Array<Object>} callRows - readAllCalls output (any order in)
 * @param {Object<string, Array<Object>>} candlesBySymbol - readCandles(dataDir, '1m') output
 * @param {Array<Object>} [previous=[]] - existing v3-shadow-outcomes.jsonl rows
 * @param {number} [nowMs=Date.now()]
 * @returns {Array<Object>}
 */
export function computeV3ShadowRows(callRows, candlesBySymbol, previous = [], nowMs = Date.now()) {
  const sorted = [...(Array.isArray(callRows) ? callRows : [])]
    .filter((r) => r && r.symbol && r.closedThrough && r.flagTradePlan && r.flagTradePlan.shadow && r.flagTradePlan.shadow.v3)
    .sort((a, b) => Date.parse(a.closedThrough) - Date.parse(b.closedThrough));

  const firstReady = new Map(); // candidateId -> capture row
  for (const row of sorted) {
    const v3 = row.flagTradePlan.shadow.v3;
    if (v3.status !== 'ready' || !v3.candidateId) continue;
    if (!firstReady.has(v3.candidateId)) firstReady.set(v3.candidateId, row);
  }

  const prevById = new Map((previous || []).map((r) => [r.candidateId, r]));
  const nowIso = new Date(nowMs).toISOString();
  const out = [];

  for (const [candidateId, row] of firstReady) {
    const prev = prevById.get(candidateId);
    if (prev && isTerminal(prev.outcome)) { out.push(prev); continue; }

    const v3 = row.flagTradePlan.shadow.v3;
    const candles1m = (candlesBySymbol && candlesBySymbol[row.symbol]) || [];
    const fromMs = Date.parse(row.closedThrough);
    const walk = walkShadow({ dir: v3.direction, entry: v3.entry, stop: v3.stop, tp1: v3.tp1 }, candles1m, fromMs, WINDOW_MS);
    const { netR, netRDirCost } = netRs(v3.entry, v3.stop, v3.direction, walk);

    out.push({
      candidateId,
      symbol: row.symbol,
      timeframe: v3.timeframe ?? null,
      direction: v3.direction ?? null,
      readyAt: row.closedThrough,
      entry: isFiniteNumber(v3.entry) ? v3.entry : null,
      stop: isFiniteNumber(v3.stop) ? v3.stop : null,
      tp1: isFiniteNumber(v3.tp1) ? v3.tp1 : null,
      grossRR: isFiniteNumber(v3.grossRR) ? v3.grossRR : null,
      netRR: isFiniteNumber(v3.netRR) ? v3.netRR : null,
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
 * @param {Array<Object>} rows - v3-shadow-outcomes.jsonl rows
 * @returns {Object}
 */
export function v3ShadowSummary(rows) {
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
export function v3ShadowDataDir(dataDir, nowMs = Date.now()) {
  const callRows = readAllCalls(dataDir);
  const candlesBySymbol = readCandles(dataDir, '1m');
  const previous = readJsonl(v3ShadowOutcomesFile(dataDir));
  const rows = computeV3ShadowRows(callRows, candlesBySymbol, previous, nowMs);
  writeJsonl(v3ShadowOutcomesFile(dataDir), rows);
  const summary = { generatedAt: new Date(nowMs).toISOString(), ...v3ShadowSummary(rows) };
  writeJson(v3ShadowSummaryFile(dataDir), summary);
  return { rows, summary };
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const { rows, summary } = v3ShadowDataDir(opts.data, nowMs);
  console.log(`[tracker:v3-shadow] ${rows.length} candidate(s) -> ${v3ShadowOutcomesFile(opts.data)} n=${summary.n} resolvedN=${summary.resolvedN} netExp=${summary.netExpectancyR ?? '-'} netExpDirCost=${summary.netExpectancyR_dirCost ?? '-'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:v3-shadow] ${err.message}`);
    process.exit(1);
  }
}

export default { v3ShadowOutcomesFile, v3ShadowSummaryFile, computeV3ShadowRows, v3ShadowSummary, v3ShadowDataDir };
