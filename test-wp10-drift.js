/**
 * WP10 (docs/research/harness/WP10_TRACKER_EVIDENCE.md) - unit tests for
 * scripts/research/tracker-evidence/drift.js (R10+ drift-baseline report).
 *
 * Run: node test-wp10-drift.js
 */

import { driftState, resolvedRows, statsOf, MIN_N, THRESHOLDS } from './scripts/research/tracker-evidence/drift.js';

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

console.log('WP10 drift.js');

test('resolvedRows: only kind:plan rows with a resolved tp1/stop outcome and finite r', () => {
  const rows = [
    { kind: 'plan', outcome: 'tp1', r: 2 },
    { kind: 'plan', outcome: 'stop', r: -1 },
    { kind: 'plan', outcome: 'not_filled', r: null },
    { kind: 'rec', class: 'GOOD', outcome: 'tp1', r: 2 }, // excluded: rec kind, would double-count the same event
    { kind: 'plan', outcome: 'tp1', r: null } // excluded: r not finite
  ];
  const out = resolvedRows(rows);
  assert(out.length === 2, `expected 2 resolved plan rows, got ${out.length}`);
});

test('statsOf: n=0 gives nulls, not NaN/division errors', () => {
  const s = statsOf([]);
  assert(s.n === 0 && s.tp1Rate === null && s.meanGrossR === null, 'expected nulls on empty input');
});

test('statsOf: tp1 rate, gross/net R, cost drag over a small hand set', () => {
  const rows = [
    { outcome: 'tp1', r: 2, entry: 100, stop: 99, direction: 'long', calledAt: '2026-01-01T00:00:00.000Z' },
    { outcome: 'stop', r: -1, entry: 100, stop: 99, direction: 'long', calledAt: '2026-01-02T00:00:00.000Z' }
  ];
  const s = statsOf(rows);
  assert(s.n === 2, 'expected n=2');
  assert(s.tp1Rate === 50, `expected 50% tp1 rate, got ${s.tp1Rate}`);
  assert(s.meanGrossR === 0.5, `expected mean gross R 0.5, got ${s.meanGrossR}`);
  // costR(100,99,'long') = 34bps / (1/100) = 0.34/0.01 = 0.34R per trade
  assert(s.meanNetR < s.meanGrossR, 'expected net R below gross R after cost drag');
  assert(s.costDragR > 0, 'expected positive cost drag');
  assert(s.dayCount === 2, `expected 2 distinct call days, got ${s.dayCount}`);
});

test('driftState: INSUFFICIENT when either side has n<MIN_N', () => {
  const state = driftState({ n: MIN_N - 1, meanNetR: -1, tp1Rate: 30 }, { n: 50, meanNetR: -1, tp1Rate: 30 });
  assert(state.state === 'INSUFFICIENT', `expected INSUFFICIENT, got ${state.state}`);
});

test('driftState: OK when current matches or beats baseline', () => {
  const state = driftState({ n: 40, meanNetR: 0.1, tp1Rate: 40 }, { n: 40, meanNetR: 0.15, tp1Rate: 42 });
  assert(state.state === 'OK', `expected OK, got ${state.state}`);
});

test('driftState: WATCH when expectancy drop crosses the watch threshold', () => {
  const state = driftState({ n: 40, meanNetR: 0.1, tp1Rate: 40 }, { n: 40, meanNetR: 0.1 - THRESHOLDS.watchExpectancyDropR - 0.01, tp1Rate: 40 });
  assert(state.state === 'WATCH', `expected WATCH, got ${state.state}`);
});

test('driftState: ALERT when expectancy drop crosses the alert threshold', () => {
  const state = driftState({ n: 40, meanNetR: 0.1, tp1Rate: 40 }, { n: 40, meanNetR: 0.1 - THRESHOLDS.alertExpectancyDropR - 0.01, tp1Rate: 40 });
  assert(state.state === 'ALERT', `expected ALERT, got ${state.state}`);
});

test('driftState: ALERT when TP1 rate drop crosses the alert threshold even if R holds up', () => {
  const state = driftState({ n: 40, meanNetR: 0.1, tp1Rate: 50 }, { n: 40, meanNetR: 0.1, tp1Rate: 50 - THRESHOLDS.alertTp1RateDropPct - 1 });
  assert(state.state === 'ALERT', `expected ALERT, got ${state.state}`);
});

test('driftState: never mutates its inputs', () => {
  const baseline = { n: 40, meanNetR: 0.1, tp1Rate: 40 };
  const current = { n: 40, meanNetR: -0.5, tp1Rate: 20 };
  const before = JSON.stringify([baseline, current]);
  driftState(baseline, current);
  assert(JSON.stringify([baseline, current]) === before, 'expected inputs unchanged');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', failures.join(', ')); process.exit(1); }
