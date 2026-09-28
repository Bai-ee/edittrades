/**
 * WP10 (docs/research/harness/WP10_TRACKER_EVIDENCE.md) - unit tests for
 * scripts/research/tracker-evidence/confidence-calibration.js (R15).
 *
 * Run: node test-wp10-confidence-calibration.js
 */

import { scoreDecileTable, qualBandTable } from './scripts/research/tracker-evidence/confidence-calibration.js';

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
    console.log(`      ${err && err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

console.log('WP10 confidence-calibration.js');

test('scoreDecileTable: buckets by score, joins outcome by symbol+closedThrough, computes tp1 rate and Brier', () => {
  const rows = [
    { symbol: 'BTC', closedThrough: 't1', headlineScore: 82 },
    { symbol: 'BTC', closedThrough: 't2', headlineScore: 88 },
    { symbol: 'ETH', closedThrough: 't1', headlineScore: 25 },
    { symbol: 'SOL', closedThrough: 't1', headlineScore: null } // excluded: no score
  ];
  const outcomeRows = [
    { kind: 'rec', symbol: 'BTC', dims: { closedThrough: 't1' }, outcome: 'tp1', r: 2 },
    { kind: 'rec', symbol: 'BTC', dims: { closedThrough: 't2' }, outcome: 'stop', r: -1 },
    { kind: 'rec', symbol: 'ETH', dims: { closedThrough: 't1' }, outcome: 'tp1', r: 1.5 }
  ];
  const result = scoreDecileTable(rows, outcomeRows);
  assert(result.n === 3, `expected n=3 (scored rows), got ${result.n}`);
  const bucket80 = result.table.find((b) => b.bucket === '80-90');
  assert(bucket80.n === 2 && bucket80.tp1Rate === 50, `expected bucket 80-90 n=2 tp1Rate=50, got ${JSON.stringify(bucket80)}`);
  const bucket20 = result.table.find((b) => b.bucket === '20-30');
  assert(bucket20.n === 1 && bucket20.tp1Rate === 100, `expected bucket 20-30 n=1 tp1Rate=100, got ${JSON.stringify(bucket20)}`);
  // Brier over the 3 resolved pairs: (0.82-1)^2 + (0.88-0)^2 + (0.25-1)^2, mean of 3
  const expectedBrier = ((0.82 - 1) ** 2 + (0.88 - 0) ** 2 + (0.25 - 1) ** 2) / 3;
  assert(Math.abs(result.brier - expectedBrier) < 1e-4, `expected brier ~${expectedBrier}, got ${result.brier}`);
});

test('scoreDecileTable: empty input gives n=0 and null brier, all buckets present but empty', () => {
  const result = scoreDecileTable([], []);
  assert(result.n === 0, 'expected n=0');
  assert(result.brier === null, 'expected null brier');
  assert(result.table.length === 10, 'expected all 10 decile buckets present');
});

test('qualBandTable: directional hit rate and mean R per band, using leaned direction R at 1h', () => {
  const rows = [
    { qualQuality: 'high', direction: 'long', horizons: { '1h': { state: 'complete', closeReturnR_long: 1.2, closeReturnR_short: -1.2 } } },
    { qualQuality: 'high', direction: 'short', horizons: { '1h': { state: 'complete', closeReturnR_long: 0.5, closeReturnR_short: -0.5 } } },
    { qualQuality: 'low', direction: 'long', horizons: { '1h': { state: 'unscorable', closeReturnR_long: null, closeReturnR_short: null } } }
  ];
  const table = qualBandTable(rows);
  const high = table.find((b) => b.band === 'high');
  assert(high.rN === 2, `expected 2 scorable high-band rows, got ${high.rN}`);
  // row1: long lean, R=1.2 (hit); row2: short lean, R=-0.5 (miss) -> hit rate 50%
  assert(high.directionalHitRate === 50, `expected 50% hit rate, got ${high.directionalHitRate}`);
  const low = table.find((b) => b.band === 'low');
  assert(low.rN === 0 && low.directionalHitRate === null, 'expected unscorable low-band row excluded');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', failures.join(', ')); process.exit(1); }
