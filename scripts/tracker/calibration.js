#!/usr/bin/env node
/**
 * EditTrades call tracker - path outlook calibration check (T4 P3,
 * docs/PLAN_FLAG_PATHS.md "P3 - Calibration check").
 *
 * Compares each resolved `data/paths.jsonl` row's realised path against the
 * `pathOutlook` prediction(s) the tracker actually saw for that candidateId in stored
 * capture rows (`data/calls`, cron or served; `scripts/tracker/records.js`
 * `pathOutlook`, itself a whitelisted copy of `lib/pathOutlook.js`'s payload field). Two
 * predictions can exist per candidate - one from while it was still `forming`/`proto`
 * (`at: 'tightening'`), one from after it broke out (`at: 'broken'`) - so each resolved
 * candidate contributes up to two joined rows, one per phase.
 *
 * Read-only with respect to the rest of the store: never touches data/outcomes.jsonl,
 * data/aggregates.json or data/paths.jsonl itself - purely an additional read + a new
 * output file (data/calibration.json). Measure only: nothing here feeds back into a rule,
 * threshold, weight table or the payload.
 *
 * Baseline (documented per docs/PLAN_FLAG_PATHS.md P3: "weights that don't calibrate are
 * withdrawn"): the tracker repo has no config/ and does not vendor `lib/pathOutlook.js`'s
 * frozen table, so the naive baseline compared against is not that table's `all` bucket -
 * it is the realised path frequency *within the same joined set* (per phase), applied as
 * one constant prediction to every row in that set. A model that cannot beat "always
 * guess the set's own base rate" is not adding information.
 *
 * Usage: node calibration.js [--data ./data] [--now <iso>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readAllCalls, readJsonl, writeJson } from './store.js';
import { isFiniteNumber } from './walk-outcome.js';
import { PATHS } from './flag-paths.js';
import { pathsFile } from './paths.js';

function roundN(value, decimals) {
  if (!isFiniteNumber(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function calibrationFile(dataDir) {
  return path.join(dataDir, 'calibration.json');
}

/**
 * The first `data/calls` capture (by stored order - `readAllCalls`'s own
 * closedThrough-ascending sort) whose `pathOutlook.id` names each candidateId, split by
 * `pathOutlook.at`. Only the FIRST sighting of each phase is kept per candidateId - a
 * later, different-looking capture of the same candidate never overwrites it (mirrors
 * `paths.js`'s `extractTighteningPoints` "fixed fact" rule).
 * @param {Array<Object>} callRows - `readAllCalls` output, any source (cron or served)
 * @returns {Map<string, {tightening?: Object, broken?: Object}>}
 */
export function firstPathOutlookSightings(callRows) {
  const byCandidate = new Map();
  for (const row of Array.isArray(callRows) ? callRows : []) {
    const po = row && row.pathOutlook;
    if (!po || typeof po !== 'object') continue;
    if (typeof po.id !== 'string' || !po.id) continue;
    if (po.at !== 'tightening' && po.at !== 'broken') continue;
    if (!byCandidate.has(po.id)) byCandidate.set(po.id, {});
    const entry = byCandidate.get(po.id);
    if (!entry[po.at]) entry[po.at] = po;
  }
  return byCandidate;
}

/**
 * Join every resolved `paths.jsonl` row with the `pathOutlook` prediction(s) seen for its
 * candidateId (docs/PLAN_FLAG_PATHS.md P3). A `tightening` prediction is always compared
 * (that table covers all five paths, `fail_first` included). A `broken` prediction is
 * compared only when the candidate actually broke out - realised path is not
 * `fail_first` (that table's `fail_first` weight is always forced to 0 upstream in
 * `lib/pathOutlook.js`, so a candidate that never broke out cannot fairly score it).
 * @param {Array<Object>} pathsRows - `data/paths.jsonl` rows
 * @param {Array<Object>} callRows - `readAllCalls` output
 * @returns {Array<{phase:'tightening'|'broken', candidateId:string, realised:string, predicted:Object, likely:?string, chase:?string}>}
 */
export function joinCalibrationRows(pathsRows, callRows) {
  const sightings = firstPathOutlookSightings(callRows);
  const out = [];
  for (const row of Array.isArray(pathsRows) ? pathsRows : []) {
    if (!row || row.status !== 'resolved' || !PATHS.includes(row.path)) continue;
    const seen = sightings.get(row.candidateId);
    if (!seen) continue;
    if (seen.tightening) {
      out.push({ phase: 'tightening', candidateId: row.candidateId, realised: row.path, predicted: seen.tightening.w, likely: seen.tightening.likely, chase: seen.tightening.chase });
    }
    if (seen.broken && row.path !== 'fail_first') {
      out.push({ phase: 'broken', candidateId: row.candidateId, realised: row.path, predicted: seen.broken.w, likely: seen.broken.likely, chase: seen.broken.chase });
    }
  }
  return out;
}

/**
 * Multi-class Brier score: mean over `rows` of sum over the five paths of
 * `(predicted probability - outcome)^2`, `probability = w/100`, `outcome` a one-hot on
 * `row.realised`. null on an empty set (no score to report, not 0 - 0 would read as
 * "perfectly calibrated").
 * @param {Array<{predicted:Object, realised:string}>} rows
 * @returns {number|null}
 */
export function multiClassBrier(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let sum = 0;
  for (const row of rows) {
    for (const p of PATHS) {
      const prob = row.predicted && isFiniteNumber(row.predicted[p]) ? row.predicted[p] / 100 : 0;
      const outcome = row.realised === p ? 1 : 0;
      sum += (prob - outcome) ** 2;
    }
  }
  return roundN(sum / rows.length, 4);
}

/**
 * Naive baseline weights for a joined set (see this file's header for why this, not the
 * live config table, is the baseline): the realised path frequency within `rows` itself,
 * as integer-ish percentages summing to ~100 (0 on an empty set - `baselineBrier` never
 * scores it, see `phaseStats`).
 * @param {Array<{realised:string}>} rows
 * @returns {Object<string, number>}
 */
export function baselineWeights(rows) {
  const n = Array.isArray(rows) ? rows.length : 0;
  const out = {};
  for (const p of PATHS) {
    const count = n > 0 ? rows.filter((row) => row.realised === p).length : 0;
    out[p] = n > 0 ? roundN((count / n) * 100, 2) : 0;
  }
  return out;
}

/** The Brier score of predicting `baselineWeights(rows)` for every row in `rows`. */
export function baselineBrier(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const baseline = baselineWeights(rows);
  return multiClassBrier(rows.map((row) => ({ ...row, predicted: baseline })));
}

/** n, Brier, baseline Brier and the baseline weights themselves for one phase's rows. */
export function phaseStats(rows) {
  return { n: rows.length, brier: multiClassBrier(rows), baselineBrier: baselineBrier(rows), baseline: baselineWeights(rows) };
}

const RELIABILITY_BUCKETS = Object.freeze(Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i * 10 + 10, label: `${i * 10}-${i * 10 + 10}` })));

/**
 * Reliability table for one path (docs/PLAN_FLAG_PATHS.md P3 "a reliability table per
 * weight decile"): rows grouped by their predicted probability for `pathKey` into ten
 * 10-point buckets (0-10 ... 90-100, the top bucket inclusive of 100), each reporting n,
 * the mean predicted probability actually seen in that bucket, and the realised rate (the
 * share of that bucket's rows whose realised path was `pathKey`). All ten buckets are
 * always returned, empty ones with null means/rates, so the page renders a stable table.
 * @param {Array<{predicted:Object, realised:string}>} rows - pooled across both phases
 * @param {string} pathKey - one of PATHS
 * @returns {Array<{bucket:string, n:number, meanPredicted:number|null, realisedRate:number|null}>}
 */
export function reliabilityTable(rows, pathKey) {
  const buckets = RELIABILITY_BUCKETS.map((b) => ({ ...b, items: [] }));
  for (const row of Array.isArray(rows) ? rows : []) {
    const p = row.predicted && isFiniteNumber(row.predicted[pathKey]) ? row.predicted[pathKey] : 0;
    const idx = Math.min(9, Math.max(0, Math.floor(p / 10)));
    buckets[idx].items.push({ predicted: p, hit: row.realised === pathKey ? 1 : 0 });
  }
  return buckets.map((b) => {
    const n = b.items.length;
    return {
      bucket: b.label,
      n,
      meanPredicted: n ? roundN(b.items.reduce((a, x) => a + x.predicted, 0) / n, 1) : null,
      realisedRate: n ? roundN((b.items.reduce((a, x) => a + x.hit, 0) / n) * 100, 1) : null
    };
  });
}

/** Share of `rows` (any phase) whose `likely` field matched the realised path. */
export function likelyHitRate(rows) {
  const withLikely = (Array.isArray(rows) ? rows : []).filter((row) => typeof row.likely === 'string' && row.likely);
  if (!withLikely.length) return { n: 0, hitRate: null };
  const hits = withLikely.filter((row) => row.likely === row.realised).length;
  return { n: withLikely.length, hitRate: roundN((hits / withLikely.length) * 100, 1) };
}

/**
 * Chase precision (docs/PLAN_FLAG_PATHS.md P3 "hit rate of ... chase"): the share of rows
 * whose `chase` read `high` or `elevated` that actually became a `runner`, against the
 * same share for `chase: 'low'` rows as a comparison baseline.
 * @param {Array<{chase:?string, realised:string}>} rows
 * @returns {{highElevated:{n:number, runnerRate:number|null}, low:{n:number, runnerRate:number|null}}}
 */
export function chaseStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const highElevated = list.filter((row) => row.chase === 'high' || row.chase === 'elevated');
  const low = list.filter((row) => row.chase === 'low');
  const runnerRate = (group) => (group.length ? roundN((group.filter((row) => row.realised === 'runner').length / group.length) * 100, 1) : null);
  return {
    highElevated: { n: highElevated.length, runnerRate: runnerRate(highElevated) },
    low: { n: low.length, runnerRate: runnerRate(low) }
  };
}

/**
 * The full calibration computation, pure (no fs). Brier/baseline are split by phase
 * (`tightening`/`broken`, since the tables they are scored against differ); the
 * reliability tables, likely hit rate and chase precision are pooled across both phases -
 * they read a prediction against an outcome the same way regardless of which table
 * produced it.
 * @param {Array<Object>} pathsRows - `data/paths.jsonl` rows
 * @param {Array<Object>} callRows - `readAllCalls` output
 * @returns {Object}
 */
export function computeCalibration(pathsRows, callRows) {
  const joined = joinCalibrationRows(pathsRows, callRows);
  const byPhase = (phase) => joined.filter((row) => row.phase === phase);
  return {
    n: joined.length,
    phases: { tightening: phaseStats(byPhase('tightening')), broken: phaseStats(byPhase('broken')) },
    reliability: { runner: reliabilityTable(joined, 'runner'), fail_first: reliabilityTable(joined, 'fail_first') },
    likely: likelyHitRate(joined),
    chase: chaseStats(joined)
  };
}

/** Read data/paths.jsonl + data/calls from `dataDir`, write data/calibration.json. */
export function calibrationDataDir(dataDir, nowMs = Date.now()) {
  const result = { generatedAt: new Date(nowMs).toISOString(), ...computeCalibration(readJsonl(pathsFile(dataDir)), readAllCalls(dataDir)) };
  writeJson(calibrationFile(dataDir), result);
  return result;
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const result = calibrationDataDir(opts.data, nowMs);
  console.log(`[tracker:calibration] n=${result.n} tightening=${result.phases.tightening.n} broken=${result.phases.broken.n} -> ${calibrationFile(opts.data)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:calibration] ${err.message}`);
    process.exit(1);
  }
}
