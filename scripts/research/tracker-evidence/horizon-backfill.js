#!/usr/bin/env node
/**
 * WP10 item 1 — R12 fixed-horizon backfill for every capture row.
 *
 * For every deduped capture row (per symbol, per decision time = `closedThrough`), using
 * the tracker's own stored closed 1m candles, compute close return / MFE / MAE at
 * 15m/1h/4h, in both directions, in % and (when a plan stop exists) in R. Reports
 * completeness state per row per horizon and the unscored share.
 *
 * Read-only: reads `../edittrades-tracker/data` (path arg `--data`), writes only under
 * `var/research/wp10-tracker-evidence/` (`--out`).
 *
 * Usage: node scripts/research/tracker-evidence/horizon-backfill.js [--data <dir>] [--out <dir>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  loadDedupedCallRows, loadCandleSets, refPriceOf, leanDirectionOf, primaryCandidateOf,
  candidateIdOf, riskBasisWithAtrFallback, forwardMetrics, toR, HORIZONS, utcDay, callsDayFiles, round
} from './lib.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { data: '../edittrades-tracker/data', out: 'var/research/wp10-tracker-evidence' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

/**
 * Build the enriched per-row forward-outcome dataset every other WP10 script reuses.
 * @param {string} dataDir
 * @returns {{rows:Array<Object>, dayFiles:Array<string>}}
 */
export function buildHorizonRows(dataDir) {
  const rows = loadDedupedCallRows(dataDir);
  const { c1m, c15m } = loadCandleSets(dataDir);
  const out = [];
  for (const row of rows) {
    const fromMs = Date.parse(row.closedThrough);
    if (!Number.isFinite(fromMs)) continue;
    const refPrice = refPriceOf(row);
    const direction = leanDirectionOf(row);
    const symbol1m = c1m[row.symbol] || [];
    const symbol15m = c15m[row.symbol] || [];
    const risk = riskBasisWithAtrFallback(row, symbol15m, fromMs, refPrice);
    const primaryCandidate = primaryCandidateOf(row);

    const horizons = {};
    for (const [label, minutes] of Object.entries(HORIZONS)) {
      const m = forwardMetrics(symbol1m, fromMs, minutes, refPrice);
      horizons[label] = {
        state: m.state,
        n: m.n,
        expected: m.expected,
        closeReturnPct: m.closeReturnPct,
        mfeLongPct: m.mfeLongPct,
        maeLongPct: m.maeLongPct,
        mfeShortPct: m.mfeShortPct,
        maeShortPct: m.maeShortPct,
        // R-equivalents, only meaningful once a risk basis exists.
        closeReturnR_long: risk ? toR(m.closeReturnPct, risk.riskPct) : null,
        mfeR_long: risk ? toR(m.mfeLongPct, risk.riskPct) : null,
        maeR_long: risk ? toR(m.maeLongPct, risk.riskPct) : null,
        closeReturnR_short: risk ? toR(-1 * (m.closeReturnPct ?? NaN), risk.riskPct) : null,
        mfeR_short: risk ? toR(m.mfeShortPct, risk.riskPct) : null,
        maeR_short: risk ? toR(m.maeShortPct, risk.riskPct) : null
      };
    }

    out.push({
      symbol: row.symbol,
      closedThrough: row.closedThrough,
      day: utcDay(row.closedThrough),
      source: row.source || 'cron',
      class: row.flagRecommendation ? row.flagRecommendation.class : null,
      readiness: row.flagRecommendation ? row.flagRecommendation.readiness : null,
      planStatus: row.flagTradePlan ? row.flagTradePlan.status : null,
      planReasonCode: row.flagTradePlan ? row.flagTradePlan.reasonCode : null,
      primaryReasonCode: row.flagRecommendation && row.flagRecommendation.primaryReason ? row.flagRecommendation.primaryReason.code : null,
      candidateId: candidateIdOf(row),
      direction,
      refPrice,
      riskPct: risk ? round(risk.riskPct, 4) : null,
      riskSource: risk ? risk.source : null,
      qualQuality: primaryCandidate && primaryCandidate.qual ? primaryCandidate.qual.quality : null,
      qualReasons: primaryCandidate && primaryCandidate.qual && Array.isArray(primaryCandidate.qual.reasons) ? primaryCandidate.qual.reasons : [],
      supports: row.flagRecommendation && Array.isArray(row.flagRecommendation.supports) ? row.flagRecommendation.supports : [],
      opposes: row.flagRecommendation && Array.isArray(row.flagRecommendation.opposes) ? row.flagRecommendation.opposes : [],
      headlineScore: row.flagRecommendation && row.flagRecommendation.trace ? row.flagRecommendation.trace.score : null,
      horizons
    });
  }
  return { rows: out, dayFiles: callsDayFiles(dataDir) };
}

/** Coverage/completeness summary: counts per horizon per state, unscored share. */
export function summarize(rows) {
  const summary = {};
  for (const label of Object.keys(HORIZONS)) {
    const counts = { pending: 0, complete: 0, partial: 0, unscorable: 0 };
    for (const row of rows) counts[row.horizons[label].state] = (counts[row.horizons[label].state] || 0) + 1;
    const total = rows.length;
    const unscored = counts.partial + counts.unscorable;
    summary[label] = { ...counts, total, unscoredShare: total ? round((unscored / total) * 100, 2) : null };
  }
  return summary;
}

function main() {
  const opts = parseArgs();
  const { rows, dayFiles } = buildHorizonRows(opts.data);
  const summary = summarize(rows);
  mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'horizon-backfill.jsonl');
  writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const summaryFile = path.join(opts.out, 'horizon-backfill-summary.json');
  writeFileSync(summaryFile, JSON.stringify({ generatedAt: new Date().toISOString(), dataDir: opts.data, dayFiles, n: rows.length, summary }, null, 2) + '\n');
  console.log(`[wp10:horizon-backfill] n=${rows.length} days=${dayFiles.length} -> ${outFile}`);
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
