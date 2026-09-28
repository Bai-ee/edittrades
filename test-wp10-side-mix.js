/**
 * WP10 (docs/research/harness/WP10_TRACKER_EVIDENCE.md) - unit tests for
 * scripts/research/tracker-evidence/side-mix.js (4.3 side-mix audit).
 *
 * Run: node test-wp10-side-mix.js
 */

import { shareOf } from './scripts/research/tracker-evidence/side-mix.js';
import { regimeAt, loadBtc4hRegime } from './scripts/research/tracker-evidence/lib.js';

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

console.log('WP10 side-mix.js');

test('shareOf: counts long/short share by the given key', () => {
  const rows = [{ direction: 'long' }, { direction: 'long' }, { direction: 'short' }, { direction: null }];
  const s = shareOf(rows, 'direction');
  assert(s.n === 3, `expected n=3 (nulls excluded), got ${s.n}`);
  assert(s.long === 2 && s.short === 1, `expected long=2 short=1, got ${s.long}/${s.short}`);
  assert(Math.abs(s.longSharePct - 66.7) < 0.1, `expected ~66.7%, got ${s.longSharePct}`);
});

test('shareOf: n=0 gives null percentages, not NaN/division errors', () => {
  const s = shareOf([], 'direction');
  assert(s.n === 0 && s.longSharePct === null && s.shortSharePct === null, 'expected nulls on empty input');
});

test('regimeAt classifies bull/bear consistently with a synthetic SMA200 series', () => {
  const series = [
    { timestamp: 1000, close: 90, sma200: 100, regime: 'bear' },
    { timestamp: 2000, close: 110, sma200: 100, regime: 'bull' }
  ];
  assert(regimeAt(series, 1500).regime === 'bear', 'expected bear carried forward until the next bar');
  assert(regimeAt(series, 2500).regime === 'bull', 'expected bull at/after the second bar');
});

// Smoke test only: var/edge/4h-long/BTC_4h.json is a real, pinned, already-fetched
// long-history asset from a separate work package (not tracker data, not mutated here).
// This checks the loader's shape and no-lookahead SMA200 construction without asserting
// today's specific bull/bear label (which will change as the file is refreshed later).
test('loadBtc4hRegime: ascending series, no regime until 200 bars, regime always bull/bear/null after', () => {
  const series = loadBtc4hRegime();
  assert(Array.isArray(series) && series.length > 200, `expected a long series, got ${series.length}`);
  for (let i = 1; i < series.length; i++) {
    assert(series[i].timestamp >= series[i - 1].timestamp, 'expected ascending timestamps');
  }
  assert(series[0].regime === null, 'expected no regime on the very first bar');
  assert(series[198].regime === null, 'expected no regime before the 200th bar (index 198, 199 bars seen)');
  assert(series[199].regime === 'bull' || series[199].regime === 'bear', `expected a regime label once 200 bars are seen (index 199), got ${series[199].regime}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', failures.join(', ')); process.exit(1); }
