#!/usr/bin/env node
/**
 * WP10 item 4 — R14 reason-code attribution.
 *
 * Only 6 rows in the whole capture history ever reach class GOOD (ready flag plan), so
 * "incremental net R with vs without a code" cannot be computed on executed trades alone -
 * there is nothing to split. Instead this attributes each structured code to the row's own
 * forward 1h return, R-equivalent, in the row's leaned direction (the same per-row dataset
 * `horizon-backfill.js` builds): for every row carrying code X anywhere in
 * `flagTradePlan.reasonCode`, `flagRecommendation.primaryReason.code`, `.opposes`,
 * `.supports`, or the primary candidate's `qual.reasons`, compare its mean forward R against
 * every row of the same class NOT carrying X. This answers "does seeing this code change
 * the row's own forward outcome" - closer to R14's intent ("which components actually
 * improve outcomes") than restricting to the handful of executed trades, but it is a
 * correlational split over candidate/recommendation state, not a trade-level cost
 * comparison. Both framings are stated explicitly in the output; do not conflate them.
 *
 * Codes matching /^(rr:|level:)/ are excluded (continuous/price-specific, not a
 * structured category). Day-block bootstrap CI per `dayBlockBootstrapCI`; n<30 flagged.
 *
 * Read-only. Usage: node scripts/research/tracker-evidence/reason-attribution.js [--data <dir>] [--out <dir>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildHorizonRows } from './horizon-backfill.js';
import { mean, dayBlockBootstrapCI, isFiniteNumber, round } from './lib.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { data: '../edittrades-tracker/data', out: 'var/research/wp10-tracker-evidence' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

// Excludes two shapes of continuous/price-specific token, neither a structured category:
// an explicit rr:/level: prefix, and any code ending in `:<plain number>` (a bare price or
// ratio embedded in the token itself, e.g. `tp1_capped:84042.1`, `level:15m:84200.8`,
// `rr:2.09`). A fraction like `a200:4/7` or `td:bull:3/4` is NOT excluded (the "/7"/"/4"
// makes it a genuine small-cardinality category, not a near-unique price).
const EXCLUDE = /^(rr:|level:)|:\d+(\.\d+)?$/;

/** Every structured code a row carries (deduped set), the granular ones filtered out. */
export function codesOf(row) {
  const set = new Set();
  if (row.planReasonCode) set.add(`plan:${row.planReasonCode}`);
  if (row.primaryReasonCode) set.add(`primary:${row.primaryReasonCode}`);
  for (const c of row.supports) if (!EXCLUDE.test(c)) set.add(`supports:${c}`);
  for (const c of row.opposes) if (!EXCLUDE.test(c)) set.add(`opposes:${c}`);
  for (const c of row.qualReasons) if (!EXCLUDE.test(c)) set.add(`qual:${c}`);
  return set;
}

/** The row's own 1h forward return, R-equivalent, in its leaned direction (null if unscorable). */
export function forwardR1h(row) {
  if (!row.direction || row.horizons['1h'].state === 'unscorable') return null;
  const v = row.direction === 'long' ? row.horizons['1h'].closeReturnR_long : row.horizons['1h'].closeReturnR_short;
  return isFiniteNumber(v) ? v : null;
}

/**
 * With-vs-without table for every code seen at least `minN` times, over rows that have a
 * computable forward R.
 */
export function attributeCodes(rows, minN = 5) {
  const scorable = rows.filter((r) => forwardR1h(r) !== null);
  const rByRow = new Map(scorable.map((r) => [r, forwardR1h(r)]));
  const codeSets = new Map(scorable.map((r) => [r, codesOf(r)]));
  const allCodes = new Set();
  for (const set of codeSets.values()) for (const c of set) allCodes.add(c);

  const results = [];
  for (const code of allCodes) {
    const withRows = scorable.filter((r) => codeSets.get(r).has(code));
    const withoutRows = scorable.filter((r) => !codeSets.get(r).has(code));
    if (withRows.length < minN) continue;
    const withR = withRows.map((r) => rByRow.get(r));
    const withoutR = withoutRows.map((r) => rByRow.get(r));
    const withMean = mean(withR);
    const withoutMean = mean(withoutR);
    const delta = isFiniteNumber(withMean) && isFiniteNumber(withoutMean) ? round(withMean - withoutMean, 4) : null;
    const ci = withRows.length >= 5 ? dayBlockBootstrapCI(withR, withRows.map((r) => r.day), { seed: 14 }) : null;
    results.push({
      code,
      nWith: withRows.length,
      nWithout: withoutRows.length,
      meanRWith: withMean,
      meanRWithout: withoutMean,
      deltaR: delta,
      ci90With: ci,
      insufficientN: withRows.length < 30
    });
  }
  results.sort((a, b) => (b.deltaR ?? -Infinity) - (a.deltaR ?? -Infinity));
  return { scorableN: scorable.length, results };
}

export function run(dataDir) {
  const { rows, dayFiles } = buildHorizonRows(dataDir);
  const overall = attributeCodes(rows, 5);
  const byClass = {};
  for (const cls of ['GOOD', 'WATCH', 'BAD']) {
    byClass[cls] = attributeCodes(rows.filter((r) => r.class === cls), 5);
  }
  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    dayFiles,
    method: 'Forward 1h R-equivalent in the row\'s leaned direction, with-vs-without split per code; not a trade-level executed-cost comparison (only 6 GOOD rows exist).',
    overall,
    byClass
  };
}

function main() {
  const opts = parseArgs();
  const result = run(opts.data);
  mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'reason-attribution.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`[wp10:reason-attribution] scorable=${result.overall.scorableN} codes=${result.overall.results.length} -> ${outFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
