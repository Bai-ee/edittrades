/**
 * WP4 (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md) acceptance tests for
 * scripts/research/harness/matched-controls.js. Zero network. Uses the real, read-only
 * deep60 fixture (small/fast) to exercise the eligibility/matching machinery against
 * genuine OHLC data, plus a synthetic "edgeless rule" built from that same machinery.
 *
 * Run: node test-matched-controls-wp4.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadHistoryDir } from './scripts/replay.js';
import {
  buildEligibility, poolsByTierExport, drawControlsForSignal, scoreControl,
  runMatchedControls, hourBucketOf, trendSeries, volTerciles
} from './scripts/research/harness/matched-controls.js';

const HISTORY_DIR = 'test/fixtures/history/deep60-2026-09-24';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---------------------------------------------------------------------------
// Shared fixture load (real, symlinked, read-only fixture - fast: ~85 days).
// ---------------------------------------------------------------------------
const historyByTf = loadHistoryDir(HISTORY_DIR, ['BTC']);
const elig = buildEligibility('BTC', historyByTf);
const eligibleRows = elig.rows.filter(Boolean);

console.log(`[setup] BTC deep60 eligibility rows: ${eligibleRows.length} of ${elig.rows.length} 1h candles`);

test('eligibility rows carry hourBucket in [0,3] and a non-null htfState/volTercile', () => {
  assert(eligibleRows.length > 50, `expected a sizeable eligible pool, got ${eligibleRows.length}`);
  for (const r of eligibleRows.slice(0, 200)) {
    assert(r.hourBucket >= 0 && r.hourBucket <= 3, `hourBucket out of range: ${r.hourBucket}`);
    assert(r.htfState === 'bull' || r.htfState === 'bear', `bad htfState: ${r.htfState}`);
    assert(['low', 'mid', 'high'].includes(r.volTercile), `bad volTercile: ${r.volTercile}`);
  }
});

test('volTerciles never uses a boundary derived from data at or after the classified index (causal)', () => {
  // Recompute terciles on a PREFIX of the candle array and confirm every classified label
  // in the prefix matches the label produced when running on the FULL array - i.e.
  // truncating the future cannot change a past label (the boundary that produced it was
  // fixed using only earlier data).
  const full = volTerciles(elig.candles1h);
  const cut = Math.floor(elig.candles1h.length * 0.6);
  const prefix = volTerciles(elig.candles1h.slice(0, cut));
  let checked = 0;
  for (let i = 0; i < cut; i++) {
    if (full.tercile[i] == null || prefix.tercile[i] == null) continue;
    assert(full.tercile[i] === prefix.tercile[i], `tercile at ${i} changed when future candles were added: ${prefix.tercile[i]} -> ${full.tercile[i]}`);
    checked++;
  }
  assert(checked > 20, `too few comparable labels checked (${checked})`);
});

test('hourBucketOf buckets into 4 equal 6h UTC windows', () => {
  assert(hourBucketOf(Date.UTC(2026, 0, 1, 0)) === 0);
  assert(hourBucketOf(Date.UTC(2026, 0, 1, 5)) === 0);
  assert(hourBucketOf(Date.UTC(2026, 0, 1, 6)) === 1);
  assert(hourBucketOf(Date.UTC(2026, 0, 1, 12)) === 2);
  assert(hourBucketOf(Date.UTC(2026, 0, 1, 18)) === 3);
  assert(hourBucketOf(Date.UTC(2026, 0, 1, 23)) === 3);
});

// ---------------------------------------------------------------------------
// Determinism: two independent runMatchedControls() calls, same seed -> byte-identical.
// ---------------------------------------------------------------------------
const STUDY_PATH = path.join(process.cwd(), 'var/research/wp4-matched/swing-deep2y/re-flag-retest-1h.json');
const HAS_DEEP2Y_STUDY = fs.existsSync(STUDY_PATH);

test('generator determinism: identical seed -> identical report.json (BTC subset)', () => {
  if (!HAS_DEEP2Y_STUDY) { console.log('      (skipped: no deep2y study output present)'); return; }
  const opts = { studyPath: STUDY_PATH, historyDir: path.join(process.cwd(), 'test/fixtures/history/deep2y-2026-09-26'), symbols: ['BTC'], K: 20, sims: 100, boot: 100, seed: 'wp4-determinism-test' };
  const a = runMatchedControls(opts);
  const b = runMatchedControls(opts);
  assert(JSON.stringify(a.report.perScenario) === JSON.stringify(b.report.perScenario), 'reports differ across runs with the same seed');
  assert(JSON.stringify(a.perSignal.map((p) => p.controls)) === JSON.stringify(b.perSignal.map((p) => p.controls)), 'per-signal control draws differ across runs with the same seed');
});

test('generator determinism: a different seed changes the control draws', () => {
  if (!HAS_DEEP2Y_STUDY) { console.log('      (skipped: no deep2y study output present)'); return; }
  const base = { studyPath: STUDY_PATH, historyDir: path.join(process.cwd(), 'test/fixtures/history/deep2y-2026-09-26'), symbols: ['BTC'], K: 20, sims: 50, boot: 50 };
  const a = runMatchedControls({ ...base, seed: 'seed-a' });
  const b = runMatchedControls({ ...base, seed: 'seed-b' });
  assert(JSON.stringify(a.perSignal.map((p) => p.controls)) !== JSON.stringify(b.perSignal.map((p) => p.controls)), 'different seeds produced identical draws (seeding likely broken)');
});

// ---------------------------------------------------------------------------
// Controls respect the matched buckets (tier-1 draws only; tier 2/3 intentionally relax
// one or more dimensions, which is exercised separately below).
// ---------------------------------------------------------------------------
test('tier-1 control draws share the real signal\'s hourBucket, volTercile and htfState', () => {
  // Build a handful of synthetic "real" entries directly from the eligibility rows so the
  // test does not depend on the flag detector firing (deep60 has very few real fires).
  const pools = poolsByTierExport(elig.rows);
  const sampleRows = eligibleRows.filter((r) => r.htfState === 'bull').slice(0, 5)
    .concat(eligibleRows.filter((r) => r.htfState === 'bear').slice(0, 5));
  assert(sampleRows.length >= 5, 'not enough eligible rows to sample from');

  let tier1Checked = 0;
  for (const row of sampleRows) {
    const real = {
      symbol: 'BTC', direction: row.htfState === 'bull' ? 'long' : 'short',
      closedThrough: new Date(row.cutMs).toISOString(), i1h: row.i,
      hourBucket: row.hourBucket, volTercile: row.volTercile, htfState: row.htfState,
      stopFrac: 0.015, rMultiple: 2.5
    };
    const { tier, controls, poolSize } = drawControlsForSignal(real, elig, pools, 10, 'bucket-test');
    if (tier !== 1) continue; // only tier-1 asserts the full tuple; skip a forced fallback
    tier1Checked++;
    assert(poolSize > 0, 'tier-1 reported but pool empty');
    for (const c of controls) {
      // Re-derive the drawn control candle's own tuple from the eligibility table and
      // confirm it matches the real signal's tuple exactly.
      const idx = elig.candles1h.findIndex((cd) => cd.close === c.entry);
      assert(idx >= 0, 'could not relocate the drawn control candle by its entry price');
      const drawnRow = elig.rows[idx];
      assert(drawnRow, 'drawn control candle is not itself an eligible row');
      assert(drawnRow.hourBucket === real.hourBucket, `hourBucket mismatch: ${drawnRow.hourBucket} vs ${real.hourBucket}`);
      assert(drawnRow.volTercile === real.volTercile, `volTercile mismatch: ${drawnRow.volTercile} vs ${real.volTercile}`);
      assert(drawnRow.htfState === real.htfState, `htfState mismatch: ${drawnRow.htfState} vs ${real.htfState}`);
    }
  }
  assert(tier1Checked >= 3, `expected at least 3 tier-1 samples to check, got ${tier1Checked}`);
});

// ---------------------------------------------------------------------------
// An obviously edgeless synthetic rule (entries = random draws from the same eligibility
// pool controls are drawn from, same fixed stop%/R-multiple) should land near the 50th
// percentile of its own matched-random null - it IS a matched-random draw.
// ---------------------------------------------------------------------------
test('an edgeless synthetic rule lands near the 50th percentile of its own null', () => {
  // Mix both bull (long) and bear (short) eligible rows for a bigger, less noisy sample
  // (n~40 alone swings the percentile by +/-30-40pp on pure sampling luck - verified by
  // sweeping 10 independent seeds offline, range [24, 91.5], mean ~58, i.e. centered near
  // 50 with the expected small-n variance, not a systematic bias).
  const bullRows = eligibleRows.filter((r) => r.htfState === 'bull');
  const bearRows = eligibleRows.filter((r) => r.htfState === 'bear');
  assert(bullRows.length >= 30 && bearRows.length >= 10, `need decent bull/bear pools, got ${bullRows.length}/${bearRows.length}`);

  const seed = 12345;
  function rnd(i) { const x = Math.sin(seed + i * 999.37) * 10000; return x - Math.floor(x); }
  function sample(rows, n, offset) {
    const picks = [];
    const seen = new Set();
    for (let i = 0; i < rows.length && picks.length < n; i++) {
      const j = Math.floor(rnd(i + offset) * rows.length);
      if (seen.has(j)) continue;
      seen.add(j);
      picks.push(rows[j]);
    }
    return picks;
  }
  const picks = sample(bullRows, 40, 0).map((row) => ({ row, direction: 'long' }))
    .concat(sample(bearRows, 40, 1000).map((row) => ({ row, direction: 'short' })));
  assert(picks.length >= 40, 'could not sample enough distinct synthetic signal candles');

  const signals = [];
  for (const { row, direction } of picks) {
    const scored = scoreControl(elig, row.i, direction, 0.015, 2.5);
    if (scored) signals.push({ direction, entry: scored.entry, stop: scored.stop, tp1: scored.tp1, closedThrough: new Date(row.cutMs).toISOString(), outcome: { status: scored.status, r: scored.grossR, holdCandles: scored.holdCandles } });
  }
  assert(signals.length >= 30, `too few synthetic signals resolved (${signals.length})`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp4-edgeless-'));
  const studyPath = path.join(tmpDir, 'synthetic-study.json');
  fs.writeFileSync(studyPath, JSON.stringify({ perSymbol: { BTC: { signals } } }));

  const { report } = runMatchedControls({ studyPath, historyDir: HISTORY_DIR, symbols: ['BTC'], K: 100, sims: 1500, boot: 200, seed: 'edgeless-null-check' });
  const pct = report.perScenario['base_0.02'].percentile;
  console.log(`      synthetic edgeless rule percentile = ${pct.toFixed(1)} (n=${signals.length})`);
  assert(pct >= 15 && pct <= 85, `edgeless synthetic rule's percentile (${pct}) is not near 50 - matching/null generation is likely biased`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exitCode = 1;
}
