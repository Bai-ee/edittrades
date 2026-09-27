#!/usr/bin/env node
/**
 * WP10 item 2 — R11 WAIT / no-trade outcome scoring ("missed trades").
 *
 * For every capture row whose recommendation is not actionable (class WATCH or BAD - the
 * tracker's own vocabulary never emits a literal "WAIT"/"NO_TRADE" string; see
 * `docs/research/harness/WP10_TRACKER_EVIDENCE.md` §R11 for why those two map to "WAIT /
 * no-trade / not actionable"), walk the engine's own leaned direction forward from the
 * decision price with no entry zone (immediately "in": R11 measures opportunity cost of
 * NOT trading, which the tracker's existing candidate-zone walk in `data/outcomes.jsonl`
 * does not - that walk requires the price to return to a breakout zone before it counts as
 * filled). "Missed" = +1R-equivalent (MFE) reached before -1R (MAE), using the plan's own
 * stop or, failing that, a 1xATR(15m) proxy stop (`riskBasisWithAtrFallback`), checked
 * with the tracker's own vendored `walkOutcome` (`prefilled: true`, no lookahead) over a
 * 4h hold. Compared against the actionable-call hit rate already scored in the tracker's
 * `data/outcomes.jsonl` (GOOD-class recs and ready-status plans).
 *
 * Read-only. Usage: node scripts/research/tracker-evidence/wait-scoring.js [--data <dir>] [--out <dir>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildHorizonRows } from './horizon-backfill.js';
import { loadCandleSets, walkOutcome, round, mean, median, dayBlockBootstrapCI, readTrackerOutcomes, dedupeByCandidateId } from './lib.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { data: '../edittrades-tracker/data', out: 'var/research/wp10-tracker-evidence' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

const MAX_HOLD_4H_1M_CANDLES = 240; // R12's outer horizon, in 1m candles

/**
 * "Missed" walk for one enriched row: prefilled at `refPrice`, target/stop at +-1R via
 * `riskPct`, in the row's leaned direction, over the stored 1m candles for its symbol.
 * `null` when the row has no direction, no risk basis, or no 1m candles at/after decision
 * time (mirrors `walkOutcome`'s own `not_filled`/`invalid_levels`, surfaced as `null` here
 * since there is nothing to classify as missed or not).
 * @returns {'missed'|'avoided'|'open'|null}
 */
export function classifyWaitRow(row, candles1mForSymbol) {
  if (!row.direction || !row.riskPct || !row.refPrice) return null;
  const riskAbs = row.refPrice * (row.riskPct / 100);
  const long = row.direction === 'long';
  const stop = long ? row.refPrice - riskAbs : row.refPrice + riskAbs;
  const target = long ? row.refPrice + riskAbs : row.refPrice - riskAbs;
  const fromMs = Date.parse(row.closedThrough);
  const result = walkOutcome({
    candles1m: candles1mForSymbol,
    fromMs,
    direction: row.direction,
    entryMin: row.refPrice,
    entryMax: row.refPrice,
    stop,
    target,
    fillWindowCandles: 1,
    maxHoldCandles: MAX_HOLD_4H_1M_CANDLES,
    prefilled: true
  });
  if (result.status === 'win') return 'missed';
  if (result.status === 'loss') return 'avoided';
  if (result.status === 'open') return 'open';
  return null; // not_filled / invalid_levels: no candles or bad levels, not classifiable
}

/** Actionable-call hit rate from the tracker's own `data/outcomes.jsonl` (already scored). */
export function actionableHitRate(outcomeRows) {
  const good = outcomeRows.filter((r) => r.kind === 'rec' && r.class === 'GOOD' && (r.outcome === 'tp1' || r.outcome === 'stop'));
  const readyPlans = outcomeRows.filter((r) => r.kind === 'plan' && (r.outcome === 'tp1' || r.outcome === 'stop'));
  const hitRate = (rows) => (rows.length ? round((rows.filter((r) => r.outcome === 'tp1').length / rows.length) * 100, 2) : null);
  return {
    good: { n: good.length, tp1Rate: hitRate(good) },
    readyPlans: { n: readyPlans.length, tp1Rate: hitRate(readyPlans) }
  };
}

export { dedupeByCandidateId };

function scoreSet(waitRows, c1m) {
  const classified = waitRows.map((r) => ({ row: r, verdict: classifyWaitRow(r, c1m[r.symbol] || []) }));
  const scorable = classified.filter((c) => c.verdict !== null);
  const missed = scorable.filter((c) => c.verdict === 'missed');
  const avoided = scorable.filter((c) => c.verdict === 'avoided');
  const openStill = scorable.filter((c) => c.verdict === 'open');
  const missedFlags = scorable.map((c) => (c.verdict === 'missed' ? 1 : 0));
  const days = scorable.map((c) => c.row.day);
  const missedRate = scorable.length ? round((missed.length / scorable.length) * 100, 2) : null;
  const missedRateCI = dayBlockBootstrapCI(missedFlags, days, { seed: 11 });
  return { classified, scorable, missed, avoided, openStill, missedRate, missedRateCI };
}

export function run(dataDir) {
  const { rows, dayFiles } = buildHorizonRows(dataDir);
  const { c1m } = loadCandleSets(dataDir);
  const waitRows = rows.filter((r) => r.class === 'WATCH' || r.class === 'BAD');

  // Capture-row level (R12's own "every capture row" unit - inflated by repeated captures
  // of one persistent candidate) and opportunity level (deduped by candidateId) are both
  // reported; do not average or merge them.
  const perCapture = scoreSet(waitRows, c1m);
  const opportunityRows = dedupeByCandidateId(waitRows);
  const perOpportunity = scoreSet(opportunityRows, c1m);

  function byClassOf(cut) {
    const out = {};
    for (const cls of ['WATCH', 'BAD']) {
      const subset = cut.classified.filter((c) => c.row.class === cls && c.verdict !== null);
      const m = subset.filter((c) => c.verdict === 'missed').length;
      out[cls] = { n: subset.length, missed: m, missedRate: subset.length ? round((m / subset.length) * 100, 2) : null };
    }
    return out;
  }

  function summaryOf(cut, rowCount) {
    return {
      rowCount,
      scorableCount: cut.scorable.length,
      unscorableCount: rowCount - cut.scorable.length,
      openStillCount: cut.openStill.length,
      missed: { n: cut.missed.length, rate: cut.missedRate, ci90: cut.missedRateCI, insufficientN: cut.scorable.length < 30 },
      avoided: { n: cut.avoided.length },
      byClass: byClassOf(cut)
    };
  }

  // Forward MFE/MAE distribution (R11: "distribution of forward MFE/MAE") at 1h and 4h,
  // in the row's own leaned direction, in R where available. Computed on the opportunity
  // (candidate-deduped) set - the distribution's shape shouldn't be re-weighted toward
  // candidates that simply got captured more often.
  const dist = {};
  for (const label of ['1h', '4h']) {
    const withRisk = opportunityRows.filter((r) => r.horizons[label].state !== 'unscorable' && (r.direction === 'long' ? r.horizons[label].mfeR_long !== null : r.horizons[label].mfeR_short !== null));
    const mfe = withRisk.map((r) => (r.direction === 'long' ? r.horizons[label].mfeR_long : r.horizons[label].mfeR_short));
    const mae = withRisk.map((r) => (r.direction === 'long' ? r.horizons[label].maeR_long : r.horizons[label].maeR_short));
    dist[label] = { n: withRisk.length, meanMfeR: mean(mfe), medianMfeR: median(mfe), meanMaeR: mean(mae), medianMaeR: median(mae) };
  }

  const outcomeRows = readTrackerOutcomes(dataDir);
  const actionable = actionableHitRate(outcomeRows);

  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    dayFiles,
    perCaptureRow: summaryOf(perCapture, waitRows.length),
    perOpportunity: summaryOf(perOpportunity, opportunityRows.length),
    forwardDistribution: dist,
    actionableComparison: actionable,
    notes: [
      '"WAIT"/"NO_TRADE" have no literal value in this engine; WATCH and BAD classes stand in for "not actionable".',
      'missed = walkOutcome (prefilled, no lookahead) reaches +1R-equivalent before -1R, in the direction the engine leaned, over a 4h hold (240 1m candles).',
      'Risk basis: the row\'s own flagTradePlan entry/stop when present (even if rejected), else 1xATR(15m) computed only from candles strictly before the decision time.',
      'perCaptureRow scores every WATCH/BAD capture as its own opportunity (one per 1-10 minute cadence, so a candidate that stays forming for 20 minutes is counted many times - inflates n and re-samples one real event). perOpportunity de-duplicates by candidateId (first sighting only) and is the more defensible "missed-trade rate"; report both, do not average them.',
      'actionableComparison.good.n is the count of scored GOOD-class recs in data/outcomes.jsonl; treat n<30 as INSUFFICIENT for any rate comparison.'
    ]
  };
}

function main() {
  const opts = parseArgs();
  const result = run(opts.data);
  mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'wait-scoring.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`[wp10:wait-scoring] perCaptureRow missed=${result.perCaptureRow.missed.rate}% (n=${result.perCaptureRow.scorableCount}) | perOpportunity missed=${result.perOpportunity.missed.rate}% (n=${result.perOpportunity.scorableCount}) -> ${outFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
