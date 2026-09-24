#!/usr/bin/env node
/**
 * EditTrades call tracker - breakout entry shadow scoring (T4 P4,
 * docs/PLAN_FLAG_PATHS.md "P4 - More opportunities").
 *
 * SHADOW MODE, never traded: for every `data/paths.jsonl` row that reached a breakout
 * close (`breakoutAt != null`), reconstructs the breakout-close entry the live payload
 * only ever exposes for one build (`lib/breakoutEntry.js`'s `breakoutEntry` field,
 * visible only on the candidate's own breakout-candle build, built by a concurrent
 * workstream - read-only here, never edited) using the same pure
 * `shadowEntryFromBreakout` / `walkShadow` `scripts/tracker/breakout-entry.js` publishes,
 * and walks it forward on stored 1m candles. Also walks the retest-hold entry
 * (`lib/flagTradePlan.js`'s own entry type: entry at `breakoutLevel`, filled at the
 * candidate's realised retest) from the same stop/target, for a side-by-side comparison,
 * whenever the candidate's realised path carried a retest-hold (`paths.jsonl`'s own
 * `retestAt`). Neither leg ever feeds `flagTradePlan`, `flagRecommendation`, class logic,
 * or any gate - this is a tracker-only measurement, not a change to what the engine
 * trades.
 *
 * Unlike the live payload field (`lib/breakoutEntry.js`, gated on `pathOutlook.chase`
 * being elevated/high so it only ever shows a runner-prone flag), this script computes a
 * shadow entry for EVERY breakout close regardless of chase - `chase` is recorded on each
 * row purely to bucket the summary (`shadowSummary` below), not to gate publication. This
 * gives a genuinely comparable base rate: how often does a chase-gated live entry help,
 * against a chase-blind one.
 *
 * Config values (`SHADOW_CFG`): the tracker repo carries no `config/` checkout, so the
 * numbers below are hard-coded copies of THIS repo's `config/engine.json` -
 * `flagPlan.minRR`, `scalp.maxStopDistancePct`, `risk.feeBps`, `risk.slippageBps` (the
 * exact same fields `lib/breakoutEntry.js` reads off `ENGINE_CONFIG` for the live field).
 * test-tracker.js asserts they still match `config/engine.json`; if that file ever
 * changes these values, the test starts failing as the signal to update `SHADOW_CFG` here
 * - the same pattern `scripts/tracker/breakout-entry.js`'s own vendored `netRiskReward`
 * uses to stay in step with `lib/flagTradePlan.js` (a parity test, not a shared import).
 *
 * Read-only with respect to the rest of the store: never touches data/outcomes.jsonl,
 * data/aggregates.json, or data/paths.jsonl - purely an additional read plus two new
 * output files (`data/shadow-outcomes.jsonl`, one row per candidate; `data/shadow.json`,
 * the summary). Idempotent like score.js/paths.js: a row whose shadow leg and retest leg
 * (each either not applicable, or resolved to a terminal outcome - tp1/stop/expired) is
 * kept exactly as written on a later run.
 *
 * Usage: node shadow.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readJsonl, writeJsonl, writeJson } from './store.js';
import { isFiniteNumber } from './walk-outcome.js';
import { pathsFile, readAllTfCandles, extractTighteningPoints } from './paths.js';
import { shadowEntryFromBreakout, walkShadow } from './breakout-entry.js';

// Same values config/engine.json publishes in THIS repo (see this file's header) -
// flagPlan.minRR, scalp.maxStopDistancePct, risk.feeBps, risk.slippageBps. Kept in step by
// test-tracker.js's own parity assertion against config/engine.json.
export const SHADOW_CFG = Object.freeze({
  minRR: 3.0,
  maxStopPct: 3.0,
  feeBps: 5,
  slippageBps: 5
});

// Candidate flag timeframes only (config/engine.json flag.timeframes); mirrors the
// private TF_MS map in paths.js (not exported there) - 15m is never a candidate tf.
const TF_MS = { '1m': 60_000, '3m': 180_000, '5m': 300_000 };
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h walk window, both legs

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function shadowOutcomesFile(dataDir) {
  return path.join(dataDir, 'shadow-outcomes.jsonl');
}

export function shadowSummaryFile(dataDir) {
  return path.join(dataDir, 'shadow.json');
}

/** The close of the candle at exactly `breakoutAtMs` on `tf` for `symbol`, or null. */
export function breakoutCloseAt(symbol, tf, breakoutAtMs, candlesByTf) {
  const list = candlesByTf && candlesByTf[tf] && candlesByTf[tf][symbol];
  if (!Array.isArray(list) || !isFiniteNumber(breakoutAtMs)) return null;
  const c = list.find((x) => x.timestamp === breakoutAtMs);
  return c && isFiniteNumber(c.close) ? c.close : null;
}

/**
 * Chase tag for one candidate's breakout (docs/PLAN_FLAG_PATHS.md P4 plan, as scoped for
 * this script): the first stored capture row whose live `breakoutEntry.id` names this
 * candidate (source 'engine' - the live engine itself decided to publish a shadow entry,
 * which only happens when `pathOutlook.chase` was elevated/high on that same build, so
 * that build's own `pathOutlook.chase` is read off the SAME row); else the latest capture
 * row's `pathOutlook.chase` for this candidate strictly before the breakout candle's open
 * time (source 'reconstructed' - the engine's own read on the candidate just before it
 * broke out, even though it never triggered `lib/breakoutEntry.js`'s own live field);
 * else 'unknown'.
 * @param {string} candidateId
 * @param {number} breakoutAtMs
 * @param {Array<Object>} callRows - readAllCalls output (ascending by closedThrough)
 * @returns {{chase:string, source:'engine'|'reconstructed'|'unknown'}}
 */
export function chaseTagFor(candidateId, breakoutAtMs, callRows) {
  const rows = Array.isArray(callRows) ? callRows : [];

  const engineRow = rows.find((r) => r && r.breakoutEntry && r.breakoutEntry.id === candidateId);
  if (engineRow) {
    const po = engineRow.pathOutlook;
    if (po && po.id === candidateId && typeof po.chase === 'string' && po.chase) {
      return { chase: po.chase, source: 'engine' };
    }
  }

  let latest = null;
  for (const row of rows) {
    const po = row && row.pathOutlook;
    if (!po || po.id !== candidateId || typeof po.chase !== 'string' || !po.chase) continue;
    const ms = Date.parse(row.closedThrough);
    if (!isFiniteNumber(ms) || ms >= breakoutAtMs) continue;
    latest = row; // rows are ascending by closedThrough, so the last assignment is latest
  }
  if (latest) return { chase: latest.pathOutlook.chase, source: 'reconstructed' };

  return { chase: 'unknown', source: 'unknown' };
}

/**
 * The retest-hold comparison leg: entry at `breakoutLevel`, filled at the retest candle's
 * own close time (`retestAtMs + 60_000` - `retestAt` is always a 1m-candle open time, see
 * `flag-paths.js`'s `labelPath`), same stop/target as the shadow leg, walked the same way.
 * No RR/stop-cap gate (informational comparison only, not a published entry); only the
 * basic direction sanity checks (stop on the right side, target ahead) apply.
 */
function retestLegFor(direction, breakoutLevel, invalidation, measuredTarget, retestAtMs, candles1m) {
  if (!isFiniteNumber(breakoutLevel) || !isFiniteNumber(invalidation) || !isFiniteNumber(measuredTarget) || !isFiniteNumber(retestAtMs)) return null;
  const sign = direction === 'short' ? -1 : 1;
  const entry = breakoutLevel;
  const stop = invalidation;
  const tp1 = measuredTarget;
  if (!(sign * (entry - stop) > 0) || !(sign * (tp1 - entry) > 0)) return null;

  const grossRisk = Math.abs(entry - stop);
  if (!(grossRisk > 0)) return null;
  const grossRR = roundN(Math.abs(tp1 - entry) / grossRisk, 3);

  const fromMs = retestAtMs + 60_000;
  const walk = walkShadow({ dir: direction, entry, stop, tp1 }, candles1m, fromMs, WINDOW_MS);
  return { entry: roundN(entry, 2), stop: roundN(stop, 2), tp1: roundN(tp1, 2), grossRR, ...walk };
}

/** A leg is terminal (nothing left to walk) when it is not applicable (null) or resolved. */
function legTerminal(leg) {
  return leg === null || leg.outcome === 'tp1' || leg.outcome === 'stop' || leg.outcome === 'expired';
}

/**
 * Compute every shadow-outcomes row. A candidateId already `status: 'resolved'` in
 * `previous` is kept exactly as written (idempotent); only a new or still-pending
 * candidate is (re)computed.
 * @param {Array<Object>} pathsRows - data/paths.jsonl rows
 * @param {Array<Object>} callRows - readAllCalls output
 * @param {Object<string, Object<string, Array<Object>>>} candlesByTf - readAllTfCandles output
 * @param {Array<Object>} [previous=[]] - existing shadow-outcomes.jsonl rows
 * @param {number} [nowMs=Date.now()]
 * @returns {Array<Object>}
 */
export function computeShadowRows(pathsRows, callRows, candlesByTf, previous = [], nowMs = Date.now()) {
  const prevById = new Map((previous || []).map((r) => [r.candidateId, r]));
  const tighteningById = new Map(extractTighteningPoints(callRows).map((c) => [c.candidateId, c]));
  const nowIso = new Date(nowMs).toISOString();
  const out = [];

  for (const row of Array.isArray(pathsRows) ? pathsRows : []) {
    if (!row || !isFiniteNumber(row.breakoutAt)) continue;

    const prev = prevById.get(row.candidateId);
    if (prev && prev.status === 'resolved') { out.push(prev); continue; }

    const direction = row.direction === 'long' || row.direction === 'short' ? row.direction : null;
    const candidate = tighteningById.get(row.candidateId) || null;
    const breakoutLevel = candidate && isFiniteNumber(candidate.breakoutLevel) ? candidate.breakoutLevel : null;
    const invalidation = candidate && isFiniteNumber(candidate.invalidation) ? candidate.invalidation : null;
    const measuredTarget = candidate && isFiniteNumber(candidate.measuredTarget) ? candidate.measuredTarget : null;
    const candles1m = (candlesByTf && candlesByTf['1m'] && candlesByTf['1m'][row.symbol]) || [];
    const breakoutClose = breakoutCloseAt(row.symbol, row.tf, row.breakoutAt, candlesByTf);

    let shadow = null;
    if (direction && breakoutLevel !== null && invalidation !== null && measuredTarget !== null && isFiniteNumber(breakoutClose)) {
      const entryObj = shadowEntryFromBreakout({ dir: direction, breakoutLevel, invalidation, measuredTarget, breakoutClose }, SHADOW_CFG);
      if (entryObj) {
        const intervalMs = TF_MS[row.tf] || 60_000;
        const fromMs = row.breakoutAt + intervalMs; // breakout candle's own close time
        const walk = walkShadow({ dir: direction, entry: entryObj.entry, stop: entryObj.stop, tp1: entryObj.tp1 }, candles1m, fromMs, WINDOW_MS);
        shadow = { ...entryObj, ...walk };
      }
    }

    let retest = null;
    if (direction && isFiniteNumber(row.retestAt)) {
      retest = retestLegFor(direction, breakoutLevel, invalidation, measuredTarget, row.retestAt, candles1m);
    }

    const { chase, source: chaseSource } = chaseTagFor(row.candidateId, row.breakoutAt, callRows);
    const status = legTerminal(shadow) && legTerminal(retest) ? 'resolved' : 'pending';

    out.push({
      candidateId: row.candidateId,
      symbol: row.symbol,
      tf: row.tf,
      direction,
      breakoutAt: row.breakoutAt,
      retestAt: isFiniteNumber(row.retestAt) ? row.retestAt : null,
      chase,
      chaseSource,
      shadow,
      retest,
      status,
      computedAt: status === 'resolved' ? nowIso : null
    });
  }

  return out.sort((a, b) => a.breakoutAt - b.breakoutAt || a.candidateId.localeCompare(b.candidateId));
}

/** n/wins/losses/open/winRate/expectancy/maxLosingStreak over a set of (possibly null) legs. */
function legStats(legs) {
  const list = (Array.isArray(legs) ? legs : []).filter(Boolean);
  const decided = list.filter((l) => l.outcome === 'tp1' || l.outcome === 'stop')
    .sort((a, b) => (a.resolvedAt || 0) - (b.resolvedAt || 0));
  const wins = decided.filter((l) => l.outcome === 'tp1').length;
  const losses = decided.length - wins;
  const open = list.filter((l) => l.outcome === 'open' || l.outcome === 'expired').length;
  let streak = 0;
  let maxLosingStreak = 0;
  for (const l of decided) {
    if (l.outcome === 'stop') { streak++; maxLosingStreak = Math.max(maxLosingStreak, streak); } else streak = 0;
  }
  const rs = decided.map((l) => (l.outcome === 'stop' ? -1 : l.r)).filter(isFiniteNumber);
  return {
    n: list.length,
    wins,
    losses,
    open,
    winRate: decided.length ? roundN(wins / decided.length, 4) : null,
    expectancy: rs.length ? roundN(rs.reduce((a, b) => a + b, 0) / rs.length, 4) : null,
    maxLosingStreak
  };
}

/**
 * Summary over shadow-outcomes rows (docs/PLAN_FLAG_PATHS.md P4 plan): overall and by
 * chase (high/elevated vs low/unknown) for the shadow leg and, separately, the retest
 * comparison leg. Read by build-page.js for the `#breakout-shadow-section` tile; never
 * written into data/aggregates.json - additive-only, out of aggregate.js entirely.
 * @param {Array<Object>} rows - shadow-outcomes.jsonl rows
 * @returns {{n:number, shadow:Object, retest:Object}}
 */
export function shadowSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const hiElevated = (r) => r.chase === 'high' || r.chase === 'elevated';
  const legBlock = (key) => ({
    overall: legStats(list.map((r) => r[key])),
    byChase: {
      highElevated: legStats(list.filter(hiElevated).map((r) => r[key])),
      lowUnknown: legStats(list.filter((r) => !hiElevated(r)).map((r) => r[key]))
    }
  });
  return { n: list.length, shadow: legBlock('shadow'), retest: legBlock('retest') };
}

/** Read data/paths.jsonl + data/calls + candles + existing shadow-outcomes.jsonl from `dataDir`, write both output files. */
export function shadowDataDir(dataDir, nowMs = Date.now()) {
  const pathsRows = readJsonl(pathsFile(dataDir));
  const callRows = readAllCalls(dataDir);
  const candlesByTf = readAllTfCandles(dataDir);
  const previous = readJsonl(shadowOutcomesFile(dataDir));
  const rows = computeShadowRows(pathsRows, callRows, candlesByTf, previous, nowMs);
  writeJsonl(shadowOutcomesFile(dataDir), rows);
  const summary = { generatedAt: new Date(nowMs).toISOString(), ...shadowSummary(rows) };
  writeJson(shadowSummaryFile(dataDir), summary);
  return { rows, summary };
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const { rows } = shadowDataDir(opts.data, nowMs);
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log(`[tracker:shadow] ${rows.length} candidate(s) -> ${shadowOutcomesFile(opts.data)} ${JSON.stringify(counts)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:shadow] ${err.message}`);
    process.exit(1);
  }
}
