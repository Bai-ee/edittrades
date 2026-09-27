/**
 * WP10 (docs/research/harness/WP10_TRACKER_EVIDENCE.md) - unit tests for
 * scripts/research/tracker-evidence/reason-attribution.js (R14).
 *
 * Run: node test-wp10-reason-attribution.js
 */

import { codesOf, forwardR1h, attributeCodes } from './scripts/research/tracker-evidence/reason-attribution.js';

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

console.log('WP10 reason-attribution.js');

function row({ day, direction, r1h, planReasonCode = null, primaryReasonCode = null, supports = [], opposes = [], qualReasons = [] }) {
  return {
    day, direction, planReasonCode, primaryReasonCode, supports, opposes, qualReasons,
    horizons: { '1h': { state: 'complete', closeReturnR_long: direction === 'long' ? r1h : -r1h, closeReturnR_short: direction === 'short' ? r1h : -r1h } }
  };
}

test('codesOf: collects prefixed codes, excludes rr:/level:/bare-number noise, keeps fractions', () => {
  const r = row({
    day: 'd1', direction: 'long', r1h: 1,
    planReasonCode: 'chase', primaryReasonCode: 'rr_below_min',
    supports: ['divergence_agrees', 'a200:4/7'],
    opposes: ['ct:4h', 'rr:2.09', 'tp1_capped:84042.1'],
    qualReasons: ['ema200:counter', 'level:15m:100']
  });
  const codes = codesOf(r);
  assert(codes.has('plan:chase'), 'expected plan:chase');
  assert(codes.has('primary:rr_below_min'), 'expected primary:rr_below_min');
  assert(codes.has('supports:divergence_agrees'), 'expected supports:divergence_agrees');
  assert(codes.has('supports:a200:4/7'), 'expected a fraction-style code (a200:4/7) to be KEPT, not treated as a bare number');
  assert(codes.has('opposes:ct:4h'), 'expected opposes:ct:4h');
  assert(!codes.has('opposes:rr:2.09'), 'expected rr: code excluded');
  assert(!codes.has('opposes:tp1_capped:84042.1'), 'expected a bare-price-suffixed code (tp1_capped:84042.1) excluded');
  assert(codes.has('qual:ema200:counter'), 'expected qual:ema200:counter');
  assert(!codes.has('qual:level:15m:100'), 'expected level: code excluded');
});

test('forwardR1h: reads the leaned-direction R, null when unscorable', () => {
  const r = row({ day: 'd1', direction: 'short', r1h: 0.8 });
  assert(forwardR1h(r) === 0.8, `expected 0.8, got ${forwardR1h(r)}`);
  const unscorable = { direction: 'long', horizons: { '1h': { state: 'unscorable' } } };
  assert(forwardR1h(unscorable) === null, 'expected null for unscorable');
  const noDir = { direction: null, horizons: { '1h': { state: 'complete' } } };
  assert(forwardR1h(noDir) === null, 'expected null for no direction');
});

test('attributeCodes: with-code mean differs from without-code mean, n and CI reported, n<30 flagged', () => {
  const rows = [];
  // 10 rows carrying code X with a strong positive forward R, spread across 3 days
  for (let i = 0; i < 10; i++) rows.push(row({ day: `d${i % 3}`, direction: 'long', r1h: 2, opposes: ['ct:4h'] }));
  // 10 rows without code X, forward R near zero
  for (let i = 0; i < 10; i++) rows.push(row({ day: `d${i % 3}`, direction: 'long', r1h: 0, opposes: [] }));
  const { scorableN, results } = attributeCodes(rows, 5);
  assert(scorableN === 20, `expected 20 scorable rows, got ${scorableN}`);
  const ctCode = results.find((r) => r.code === 'opposes:ct:4h');
  assert(ctCode, 'expected opposes:ct:4h in results');
  assert(ctCode.nWith === 10 && ctCode.nWithout === 10, `expected 10/10 split, got ${ctCode.nWith}/${ctCode.nWithout}`);
  assert(Math.abs(ctCode.meanRWith - 2) < 1e-6, `expected meanRWith ~2, got ${ctCode.meanRWith}`);
  assert(Math.abs(ctCode.meanRWithout - 0) < 1e-6, `expected meanRWithout ~0, got ${ctCode.meanRWithout}`);
  assert(Math.abs(ctCode.deltaR - 2) < 1e-6, `expected deltaR ~2, got ${ctCode.deltaR}`);
  assert(ctCode.insufficientN === true, 'expected insufficientN (nWith=10 < 30)');
  assert(ctCode.ci90With && ctCode.ci90With.lo <= ctCode.ci90With.hi, 'expected a valid CI');
});

test('attributeCodes: a code seen fewer than minN times is excluded', () => {
  const rows = [row({ day: 'd1', direction: 'long', r1h: 1, opposes: ['rare:code'] })];
  const { results } = attributeCodes(rows, 5);
  assert(!results.find((r) => r.code === 'opposes:rare:code'), 'expected rare code excluded below minN');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', failures.join(', ')); process.exit(1); }
