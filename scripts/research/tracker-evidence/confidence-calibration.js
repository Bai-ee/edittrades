#!/usr/bin/env node
/**
 * WP10 item 3 — R15 calibration of the headline confidence/probability field.
 *
 * "Find it in rows" (per the work package): the only continuous 0-100 confidence value the
 * engine emits into a served payload is `flagRecommendation.trace.score` (the deterministic
 * quality_score behind `qualityBand`, `lib/flagRecommendation.js` `scoreContext`/`finish`).
 * It is architecturally computed ONLY when a flag plan reaches `ready` (class GOOD,
 * `finish('GOOD', 'ready_flag_plan', scored)`) - for WATCH/BAD rows `score`/`qualityBand`
 * are always null. That is itself a finding, reported below, not worked around: decile
 * calibration on this field is INSUFFICIENT by construction until many more GOOD calls are
 * captured.
 *
 * As a secondary, much larger-n check, this script also buckets the per-candidate `qual`
 * band (`high`/`med`/`low` - itself a band of a 0-100 confidence never persisted to the
 * capture row, `lib/candidateQualifier.js`) against the row's own forward outcome. This is
 * coarser than deciles (three bands, not ten) and is reported as a distinct, explicitly
 * labeled table - never merged into the decile table.
 *
 * Read-only. Usage: node scripts/research/tracker-evidence/confidence-calibration.js [--data <dir>] [--out <dir>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildHorizonRows } from './horizon-backfill.js';
import { readTrackerOutcomes, round, mean, brier, isFiniteNumber, dedupeByCandidateId } from './lib.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { data: '../edittrades-tracker/data', out: 'var/research/wp10-tracker-evidence' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

const DECILES = Object.freeze(Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i * 10 + 10, label: `${i * 10}-${i * 10 + 10}` })));

/**
 * Decile table for `flagRecommendation.trace.score` on rows that carry it, joined to the
 * tracker's own scored outcome for that exact call (`data/outcomes.jsonl`, `kind:'rec'`,
 * matched by symbol+closedThrough). `directionalHit` = the joined row's outcome resolved
 * tp1 (proxy for "price moved the leaned direction far enough"); `tp1Rate` = tp1 / (tp1+stop).
 */
export function scoreDecileTable(rows, outcomeRows) {
  const byKey = new Map();
  for (const o of outcomeRows) {
    if (o.kind !== 'rec') continue;
    byKey.set(`${o.symbol}|${o.dims && o.dims.closedThrough}`, o);
  }
  const scored = rows
    .filter((r) => isFiniteNumber(r.headlineScore))
    .map((r) => ({ score: r.headlineScore, outcome: byKey.get(`${r.symbol}|${r.closedThrough}`) || null }));

  const buckets = DECILES.map((b) => ({ ...b, items: [] }));
  for (const s of scored) {
    const idx = Math.min(9, Math.max(0, Math.floor(s.score / 10)));
    buckets[idx].items.push(s);
  }
  const table = buckets.map((b) => {
    const n = b.items.length;
    const resolved = b.items.filter((x) => x.outcome && (x.outcome.outcome === 'tp1' || x.outcome.outcome === 'stop'));
    const tp1 = resolved.filter((x) => x.outcome.outcome === 'tp1');
    const netRs = resolved.map((x) => x.outcome.r).filter(isFiniteNumber);
    return {
      bucket: b.label,
      n,
      resolvedN: resolved.length,
      tp1Rate: resolved.length ? round((tp1.length / resolved.length) * 100, 1) : null,
      meanR: netRs.length ? mean(netRs) : null
    };
  });
  const brierPairs = scored
    .filter((s) => s.outcome && (s.outcome.outcome === 'tp1' || s.outcome.outcome === 'stop'))
    .map((s) => ({ p: s.score / 100, o: s.outcome.outcome === 'tp1' ? 1 : 0 }));
  return { n: scored.length, table, brier: brier(brierPairs), brierN: brierPairs.length };
}

/**
 * Coarse qual-band table (high/med/low) against each row's own 1h forward return, in the
 * row's leaned direction, in R where a risk basis exists. `directionalHitRate` = share of
 * rows where the 1h close return moved in the leaned direction (>0 R). Callers should pass
 * candidate-deduped rows (`dedupeByCandidateId`) - otherwise a candidate captured many
 * times over its forming/rejected life dominates its band's stats.
 */
export function qualBandTable(rows) {
  const bands = ['high', 'med', 'low'];
  return bands.map((band) => {
    const subset = rows.filter((r) => r.qualQuality === band && r.direction && r.horizons['1h'].state !== 'unscorable');
    const rVals = subset
      .map((r) => (r.direction === 'long' ? r.horizons['1h'].closeReturnR_long : r.horizons['1h'].closeReturnR_short))
      .filter(isFiniteNumber);
    const hits = rVals.filter((v) => v > 0).length;
    return {
      band,
      n: subset.length,
      rN: rVals.length,
      directionalHitRate: rVals.length ? round((hits / rVals.length) * 100, 1) : null,
      meanR1h: rVals.length ? mean(rVals) : null
    };
  });
}

export function run(dataDir) {
  const { rows, dayFiles } = buildHorizonRows(dataDir);
  const outcomeRows = readTrackerOutcomes(dataDir);
  const decile = scoreDecileTable(rows, outcomeRows);
  const qualBand = qualBandTable(dedupeByCandidateId(rows));
  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    dayFiles,
    headlineField: 'flagRecommendation.trace.score (0-100, quality_score behind qualityBand; lib/flagRecommendation.js scoreContext)',
    headlineFieldGap: 'Only populated when a flag plan reaches ready/GOOD; null on every WATCH/BAD row. Decile calibration is INSUFFICIENT by construction until far more GOOD calls are captured.',
    decile,
    qualBandSecondary: {
      note: 'high/med/low band of a 0-100 confidence never persisted to the capture row (lib/candidateQualifier.js qualityBand). Not deciles; a coarser, much larger-n supplementary check only.',
      table: qualBand
    },
    insufficientN: decile.n < 30
  };
}

function main() {
  const opts = parseArgs();
  const result = run(opts.data);
  mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'confidence-calibration.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`[wp10:confidence-calibration] headline-score n=${result.decile.n} (insufficient=${result.insufficientN}) -> ${outFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
