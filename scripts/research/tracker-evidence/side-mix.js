#!/usr/bin/env node
/**
 * WP10 item 5 — 4.3 side-mix audit.
 *
 * Long/short share of actionable calls over time vs market regime (BTC 4h close vs
 * SMA200, `var/edge/4h-long/BTC_4h.json`), which gates/codes block which side, and whether
 * the engine is systematically fighting the trend.
 *
 * "Actionable" = class GOOD (ready flag plan) union rows whose flagTradePlan.status is
 * `ready` (a few extra rows where the plan reached ready but the recommendation snapshot on
 * that exact row was captured a beat earlier/later - both are "the engine was willing to
 * trade this", the union used only to raise n above the 6 pure-GOOD rows).
 *
 * For the "fighting the trend" question: among REJECTED rows (flagTradePlan.status ===
 * 'rejected') whose leaned direction opposes the prevailing 4h regime (short in a bull
 * regime, long in a bear regime) vs whose leaned direction agrees with it, which
 * reasonCode/opposes codes appear most often - a rejection-code mix that looks the same
 * regardless of trend alignment would suggest the engine is not asymmetrically fighting the
 * trend; a mix dominated by counter-trend-only codes would suggest it is.
 *
 * Read-only. Usage: node scripts/research/tracker-evidence/side-mix.js [--data <dir>] [--out <dir>]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildHorizonRows } from './horizon-backfill.js';
import { loadBtc4hRegime, regimeAt, round } from './lib.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = { data: '../edittrades-tracker/data', out: 'var/research/wp10-tracker-evidence' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

export function shareOf(rows, key) {
  const long = rows.filter((r) => r[key] === 'long').length;
  const short = rows.filter((r) => r[key] === 'short').length;
  const total = long + short;
  return { n: total, long, short, longSharePct: total ? round((long / total) * 100, 1) : null, shortSharePct: total ? round((short / total) * 100, 1) : null };
}

export function run(dataDir) {
  const { rows: enriched, dayFiles } = buildHorizonRows(dataDir);
  const regime = loadBtc4hRegime();

  const actionable = enriched.filter((r) => r.class === 'GOOD' || r.planStatus === 'ready');
  const overallMix = shareOf(actionable, 'direction');

  const byDay = new Map();
  for (const r of actionable) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const perDay = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, rows]) => ({ day, ...shareOf(rows, 'direction') }));

  // Regime-conditioned mix: attach each actionable row's regime at its own decision time.
  const withRegime = actionable.map((r) => ({ ...r, regime: regime.length ? (regimeAt(regime, Date.parse(r.closedThrough)) || {}).regime : null }));
  const byRegime = {};
  for (const reg of ['bull', 'bear']) {
    byRegime[reg] = shareOf(withRegime.filter((r) => r.regime === reg), 'direction');
  }
  const currentRegime = regime.length ? regime[regime.length - 1] : null;

  // Rejected rows: counter-trend vs trend-aligned reason-code mix.
  const rejected = enriched.filter((r) => r.planStatus === 'rejected' && r.direction);
  const rejectedWithRegime = rejected.map((r) => ({ ...r, regime: regime.length ? (regimeAt(regime, Date.parse(r.closedThrough)) || {}).regime : null }));
  const alignment = (r) => {
    if (!r.regime) return null;
    const trendDir = r.regime === 'bull' ? 'long' : 'short';
    return r.direction === trendDir ? 'aligned' : 'counter';
  };
  const codeMix = (subset) => {
    const counts = new Map();
    for (const r of subset) {
      const codes = new Set([r.planReasonCode, r.primaryReasonCode, ...(r.opposes || [])].filter(Boolean));
      for (const c of codes) counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([code, n]) => ({ code, n }));
  };
  const counterRejected = rejectedWithRegime.filter((r) => alignment(r) === 'counter');
  const alignedRejected = rejectedWithRegime.filter((r) => alignment(r) === 'aligned');

  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    dayFiles,
    currentRegime,
    actionable: { overallMix, perDay },
    byRegime,
    rejectionCodeMix: {
      counterTrendRejected: { n: counterRejected.length, topCodes: codeMix(counterRejected) },
      trendAlignedRejected: { n: alignedRejected.length, topCodes: codeMix(alignedRejected) }
    },
    notes: [
      'Actionable = class GOOD union flagTradePlan.status === ready.',
      'Regime = BTC 4h close vs SMA200 from var/edge/4h-long/BTC_4h.json, evaluated at each row\'s own decision time (no lookahead: the SMA200 window only uses candles up to and including the bar in effect).',
      `${overallMix.n} actionable rows total over ${dayFiles.length} capture day(s) - too few (n<30) to draw a side-mix-vs-regime conclusion; the mechanism is exercised and correct, the sample is not yet large enough.`
    ]
  };
}

function main() {
  const opts = parseArgs();
  const result = run(opts.data);
  mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'side-mix.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log(`[wp10:side-mix] actionable n=${result.actionable.overallMix.n} long=${result.actionable.overallMix.longSharePct}% short=${result.actionable.overallMix.shortSharePct}% -> ${outFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
