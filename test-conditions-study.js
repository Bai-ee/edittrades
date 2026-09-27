/**
 * Unit tests for the S1 Agent B conditions-study bucketing logic
 * (scripts/research/conditions.js, docs/PROMPT_S1_EDGE_SEARCH.md "B - conditions study").
 * No replay here (that needs history fixtures and is exercised manually via
 * `npm run study:conditions`) - this covers the pure bucketing/stats/grouping helpers.
 */

import {
  bucketByEdges, STOP_EDGES, NETRR_EDGES,
  clarityBucket, qualityBandBucket, shadowNfBucket, roomBucket, ema21HoldBucket, atrPercentileRegime,
  statsFor, splitHalves, fieldTable, twoFieldConjunctions, FIELDS
} from './scripts/research/conditions.js';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

(async () => {
  console.log('\n=== conditions-study bucketing tests ===\n');

  // ===== bucketByEdges =====
  await test('stop bucket: boundaries land in the lower bucket (< upper)', () => {
    assertEqual(bucketByEdges(0.49, STOP_EDGES), '<0.5%');
    assertEqual(bucketByEdges(0.5, STOP_EDGES), '0.5-1%');
    assertEqual(bucketByEdges(0.99, STOP_EDGES), '0.5-1%');
    assertEqual(bucketByEdges(1.0, STOP_EDGES), '1-1.5%');
    assertEqual(bucketByEdges(2.49, STOP_EDGES), '2-2.5%');
    assertEqual(bucketByEdges(2.5, STOP_EDGES), '2.5-3%');
    assertEqual(bucketByEdges(2.99, STOP_EDGES), '2.5-3%');
    assertEqual(bucketByEdges(3.0, STOP_EDGES), '>=3%');
    assertEqual(bucketByEdges(10, STOP_EDGES), '>=3%');
  });

  await test('stop bucket: non-finite values bucket to n/a', () => {
    assertEqual(bucketByEdges(null, STOP_EDGES), 'n/a');
    assertEqual(bucketByEdges(undefined, STOP_EDGES), 'n/a');
    assertEqual(bucketByEdges(NaN, STOP_EDGES), 'n/a');
  });

  await test('netRR bucket boundaries', () => {
    assertEqual(bucketByEdges(-0.5, NETRR_EDGES), '<0R');
    assertEqual(bucketByEdges(0, NETRR_EDGES), '0-0.5R');
    assertEqual(bucketByEdges(1.5, NETRR_EDGES), '1.5-2R');
    assertEqual(bucketByEdges(5, NETRR_EDGES), '>=2R');
  });

  // ===== clarityBucket / qualityBandBucket / shadowNfBucket / roomBucket / ema21HoldBucket =====
  await test('clarityBucket reads clarity.gate.passable, defaults to unknown', () => {
    assertEqual(clarityBucket({ clarity: { gate: { passable: true } } }), 'passable');
    assertEqual(clarityBucket({ clarity: { gate: { passable: false } } }), 'blocked');
    assertEqual(clarityBucket({ clarity: null }), 'unknown');
    assertEqual(clarityBucket(null), 'unknown');
  });

  await test('qualityBandBucket falls back to none', () => {
    assertEqual(qualityBandBucket({ qualityBand: 'high' }), 'high');
    assertEqual(qualityBandBucket({ qualityBand: null }), 'none');
    assertEqual(qualityBandBucket(null), 'none');
  });

  await test('shadowNfBucket: absent when setup.shadowNF is missing (T-13 field is optional)', () => {
    assertEqual(shadowNfBucket({ setup: { shadowNF: { ready: true } } }), 'ready');
    assertEqual(shadowNfBucket({ setup: { shadowNF: { ready: false } } }), 'not_ready');
    assertEqual(shadowNfBucket({ setup: { shadowNF: null } }), 'absent');
    assertEqual(shadowNfBucket({ setup: null }), 'absent');
    assertEqual(shadowNfBucket(null), 'absent');
  });

  await test('roomBucket: capped vs open vs none', () => {
    assertEqual(roomBucket({ room: { toLevel: 'tp1_cap' } }), 'capped');
    assertEqual(roomBucket({ room: { toLevel: 'measured_target' } }), 'open');
    assertEqual(roomBucket({ room: null }), 'none');
    assertEqual(roomBucket(null), 'none');
  });

  await test('ema21HoldBucket: mirrored long/short labels collapse to one bucket set', () => {
    assertEqual(ema21HoldBucket({ ema21Hold: 'hold' }), 'hold');
    assertEqual(ema21HoldBucket({ ema21Hold: 'hold_below' }), 'hold');
    assertEqual(ema21HoldBucket({ ema21Hold: 'wick' }), 'wick');
    assertEqual(ema21HoldBucket({ ema21Hold: 'wick_above' }), 'wick');
    assertEqual(ema21HoldBucket({ ema21Hold: 'acceptance_below' }), 'acceptance');
    assertEqual(ema21HoldBucket({ ema21Hold: 'acceptance_above' }), 'acceptance');
    assertEqual(ema21HoldBucket({ ema21Hold: 'reclaim' }), 'reclaim');
    assertEqual(ema21HoldBucket({ ema21Hold: 'something_else' }), 'none');
    assertEqual(ema21HoldBucket(null), 'none');
  });

  // ===== atrPercentileRegime =====
  await test('atrPercentileRegime: insufficient history below the minimum sample count', () => {
    assertEqual(atrPercentileRegime(5, [1, 2, 3]), 'insufficient_history');
    assertEqual(atrPercentileRegime(5, []), 'insufficient_history');
    assertEqual(atrPercentileRegime(null, Array(30).fill(1)), 'insufficient_history');
  });

  await test('atrPercentileRegime: low/mid/high terciles', () => {
    const window = Array.from({ length: 30 }, (_, i) => i + 1); // 1..30
    assertEqual(atrPercentileRegime(1, window), 'low'); // rank 1/30 ~ 0.033
    assertEqual(atrPercentileRegime(15, window), 'mid'); // rank 15/30 = 0.5
    assertEqual(atrPercentileRegime(30, window), 'high'); // rank 30/30 = 1.0
  });

  // ===== statsFor =====
  await test('statsFor: win/loss/timeout resolved, not_filled/open excluded', () => {
    const rows = [
      { status: 'win', grossR: 2, netR: 1.8, holdCandles: 30 },
      { status: 'loss', grossR: -1, netR: -1.2, holdCandles: 10 },
      { status: 'timeout', grossR: 0.4, netR: 0.2, holdCandles: 1440 },
      { status: 'not_filled', grossR: null, netR: null, holdCandles: null }
    ];
    const s = statsFor(rows);
    assertEqual(s.n, 4, 'n counts every row');
    assertEqual(s.resolved, 3, 'resolved excludes not_filled');
    // wins = grossR > 0: the win (2) and the timeout closed positive (0.4) both count; the
    // loss (-1) does not - 2 of 3 resolved rows.
    assertEqual(s.winPct, 66.67, 'win% is wins (grossR > 0) / resolved');
    assert(Math.abs(s.grossExpR - ((2 - 1 + 0.4) / 3)) < 1e-3, 'grossExpR averages resolved rows only');
    assert(Math.abs(s.netExpR - ((1.8 - 1.2 + 0.2) / 3)) < 1e-3, 'netExpR averages resolved rows only');
    assertEqual(s.medianNetExpR, 0.2, 'medianNetExpR is the median of the resolved rows netR (-1.2, 0.2, 1.8 -> 0.2)');
  });

  await test('statsFor: medianNetExpR is robust to a single extreme outlier row that dominates the mean', () => {
    // A near-zero-stop loss can print net R in the hundreds (see conditions.js statsFor's
    // own comment) - the mean should move a lot, the median should barely move.
    const rows = [
      { status: 'win', grossR: 1, netR: 0.9, holdCandles: 5 },
      { status: 'win', grossR: 1, netR: 1.0, holdCandles: 5 },
      { status: 'loss', grossR: -1, netR: -1.1, holdCandles: 5 },
      { status: 'loss', grossR: -1, netR: -450, holdCandles: 5 } // razor-thin-stop outlier
    ];
    const s = statsFor(rows);
    assert(s.netExpR < -100, 'mean net R is dragged deeply negative by the one outlier');
    assert(s.medianNetExpR > -1 && s.medianNetExpR < 1, 'median net R stays close to the typical outcome');
  });

  await test('statsFor: empty input has null rates, not NaN', () => {
    const s = statsFor([]);
    assertEqual(s.n, 0);
    assertEqual(s.resolved, 0);
    assertEqual(s.winPct, null);
    assertEqual(s.grossExpR, null);
    assertEqual(s.netExpR, null);
  });

  // ===== splitHalves =====
  await test('splitHalves: 2/3 boundary by calendar time, first vs second', () => {
    const spanFromMs = Date.parse('2026-01-01T00:00:00.000Z');
    const spanToMs = Date.parse('2026-01-31T00:00:00.000Z'); // 30 days
    const boundary = spanFromMs + Math.round((spanToMs - spanFromMs) * (2 / 3)); // day 20
    const before = new Date(boundary - 86400000).toISOString();
    const after = new Date(boundary + 86400000).toISOString();
    const rows = [
      { status: 'win', grossR: 1, netR: 1, closedThrough: before },
      { status: 'win', grossR: 1, netR: 1, closedThrough: before },
      { status: 'loss', grossR: -1, netR: -1.1, closedThrough: after }
    ];
    const halves = splitHalves(rows, spanFromMs, spanToMs);
    assertEqual(halves.first.n, 2, 'both early rows land in the first half');
    assertEqual(halves.second.n, 1, 'the late row lands in the second half');
  });

  await test('splitHalves: unknown span returns empty halves rather than throwing', () => {
    const halves = splitHalves([{ status: 'win', grossR: 1, netR: 1, closedThrough: new Date().toISOString() }], null, null);
    assertEqual(halves.first.n, 0);
    assertEqual(halves.second.n, 0);
  });

  // ===== fieldTable =====
  await test('fieldTable: groups by the field key and sorts by n desc', () => {
    const rows = [
      { direction: 'long', status: 'win', grossR: 1, netR: 0.9, closedThrough: '2026-01-05T00:00:00.000Z', holdCandles: 5 },
      { direction: 'long', status: 'loss', grossR: -1, netR: -1.1, closedThrough: '2026-01-06T00:00:00.000Z', holdCandles: 5 },
      { direction: 'short', status: 'win', grossR: 2, netR: 1.9, closedThrough: '2026-01-07T00:00:00.000Z', holdCandles: 5 }
    ];
    const t = fieldTable(rows, { key: 'direction', label: 'direction' }, Date.parse('2026-01-01'), Date.parse('2026-01-31'));
    assertEqual(t.bucketsTested, 2);
    assertEqual(t.rows[0].bucket, 'long', 'long has n=2, sorts first');
    assertEqual(t.rows[0].n, 2);
    assertEqual(t.rows[1].bucket, 'short');
    assertEqual(t.rows[1].n, 1);
  });

  // ===== twoFieldConjunctions =====
  await test('twoFieldConjunctions: filters by minN and ranks by net R desc', () => {
    const rows = [];
    // 40 rows at direction=long/tier=A, net R ~1 (should qualify, n>=30)
    for (let i = 0; i < 40; i++) {
      rows.push({ direction: 'long', tier: 'A', status: 'win', grossR: 1.2, netR: 1.0, closedThrough: `2026-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z` });
    }
    // 10 rows at direction=short/tier=B, net R ~2 (higher net R but under minN=30 - must be excluded)
    for (let i = 0; i < 10; i++) {
      rows.push({ direction: 'short', tier: 'B', status: 'win', grossR: 2.2, netR: 2.0, closedThrough: `2026-01-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z` });
    }
    const fields = [{ key: 'direction', label: 'direction' }, { key: 'tier', label: 'tier' }];
    const result = twoFieldConjunctions(rows, fields, Date.parse('2026-01-01'), Date.parse('2026-01-31'), 30);
    assertEqual(result.qualifyingCombos, 1, 'only the n=40 combo clears minN=30');
    assertEqual(result.top3.length, 1);
    assertEqual(result.top3[0].bucketA, 'long');
    assertEqual(result.top3[0].bucketB, 'A');
    assert(result.combosEvaluated >= 2, 'every distinct combo (including the excluded one) is counted for the multiple-comparisons total');
  });

  await test('twoFieldConjunctions: no qualifying combo returns an empty top3, not a throw', () => {
    const rows = [{ direction: 'long', tier: 'A', status: 'win', grossR: 1, netR: 1, closedThrough: '2026-01-05T00:00:00.000Z' }];
    const fields = [{ key: 'direction', label: 'direction' }, { key: 'tier', label: 'tier' }];
    const result = twoFieldConjunctions(rows, fields, Date.parse('2026-01-01'), Date.parse('2026-01-31'), 30);
    assertEqual(result.top3.length, 0);
    assertEqual(result.qualifyingCombos, 0);
  });

  // ===== FIELDS =====
  await test('FIELDS: matches the fifteen selection fields the prompt specifies', () => {
    assertEqual(FIELDS.length, 15);
    const keys = FIELDS.map((f) => f.key);
    for (const expected of [
      'symbol', 'direction', 'timeframe', 'hourUTC', 'clarity', 'qualityBand', 'shadowNF',
      'netRRBucket', 'topDownSentiment', 'topDownAligned', 'room', 'ema21Hold', 'stopBucket', 'atrRegime', 'tier'
    ]) {
      assert(keys.includes(expected), `FIELDS is missing ${expected}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failed:', failures.join(', '));
    process.exit(1);
  }
})();
