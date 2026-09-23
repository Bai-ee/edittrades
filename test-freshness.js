/**
 * Deterministic tests for lib/freshness.js (signal-reliability minimum plan, work
 * package 1). No network, no candles - pure function over closedThrough/now/interval.
 *
 * Run: node test-freshness.js
 */

import { assessFreshness, assessFreshnessAll } from './lib/freshness.js';

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
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const ONE_MIN = 60000;

async function run() {
  console.log('\nlib/freshness.js\n');

  await test('fresh: closedThrough exactly now is fresh (age 0)', () => {
    const r = assessFreshness({ closedThroughIso: new Date(NOW).toISOString(), now: NOW, intervalMs: ONE_MIN, graceMs: 5000 });
    assert(r.fresh, 'expected fresh');
    assertEqual(r.ageMs, 0, 'age');
  });

  await test('fresh: closedThrough one interval old, inside the grace period, is fresh (boundary)', () => {
    const closedThroughMs = NOW - ONE_MIN - 4000; // 1 interval + 4s, grace is 5s
    const r = assessFreshness({ closedThroughIso: new Date(closedThroughMs).toISOString(), now: NOW, intervalMs: ONE_MIN, graceMs: 5000 });
    assert(r.fresh, `expected fresh at the grace boundary, got ${JSON.stringify(r)}`);
  });

  await test('stale: one interval old plus more than the grace period', () => {
    const closedThroughMs = NOW - ONE_MIN - 6000; // 1 interval + 6s, grace is 5s
    const r = assessFreshness({ closedThroughIso: new Date(closedThroughMs).toISOString(), now: NOW, intervalMs: ONE_MIN, graceMs: 5000 });
    assert(!r.fresh, 'expected stale');
    assertEqual(r.reason, 'stale', 'reason');
  });

  await test('stale: many intervals old (a genuinely dead feed) is stale, not just over by a hair', () => {
    const closedThroughMs = NOW - 20 * ONE_MIN;
    const r = assessFreshness({ closedThroughIso: new Date(closedThroughMs).toISOString(), now: NOW, intervalMs: ONE_MIN, graceMs: 5000 });
    assert(!r.fresh, 'expected stale');
    assertEqual(r.reason, 'stale', 'reason');
  });

  await test('fails closed: missing closedThrough (null/undefined/empty)', () => {
    for (const bad of [null, undefined, '']) {
      const r = assessFreshness({ closedThroughIso: bad, now: NOW, intervalMs: ONE_MIN, graceMs: 5000 });
      assert(!r.fresh, `expected fail-closed for ${JSON.stringify(bad)}`);
      assertEqual(r.reason, 'missing_closed_through', 'reason');
    }
  });

  await test('fails closed: unparseable closedThrough string', () => {
    const r = assessFreshness({ closedThroughIso: 'not-a-date', now: NOW, intervalMs: ONE_MIN, graceMs: 5000 });
    assert(!r.fresh, 'expected fail-closed');
    assertEqual(r.reason, 'invalid_closed_through', 'reason');
  });

  await test('fails closed: unknown interval (missing/non-finite intervalMs)', () => {
    const r = assessFreshness({ closedThroughIso: new Date(NOW).toISOString(), now: NOW, intervalMs: NaN, graceMs: 5000 });
    assert(!r.fresh, 'expected fail-closed');
    assertEqual(r.reason, 'unknown_interval', 'reason');
  });

  await test('fails closed: closedThrough in the future (clock skew / bad data)', () => {
    const r = assessFreshness({ closedThroughIso: new Date(NOW + ONE_MIN).toISOString(), now: NOW, intervalMs: ONE_MIN, graceMs: 5000 });
    assert(!r.fresh, 'expected fail-closed');
    assertEqual(r.reason, 'closed_through_in_future', 'reason');
  });

  await test('assessFreshnessAll: fresh only when every requirement is fresh', () => {
    const fresh = new Date(NOW).toISOString();
    const stale = new Date(NOW - 20 * ONE_MIN).toISOString();
    const allFresh = assessFreshnessAll(
      [{ tf: '1m', closedThroughIso: fresh, intervalMs: ONE_MIN }, { tf: '15m', closedThroughIso: fresh, intervalMs: 15 * ONE_MIN }],
      NOW, 5000
    );
    assert(allFresh.fresh, 'expected all-fresh');

    const oneStale = assessFreshnessAll(
      [{ tf: '1m', closedThroughIso: fresh, intervalMs: ONE_MIN }, { tf: '15m', closedThroughIso: stale, intervalMs: 15 * ONE_MIN }],
      NOW, 5000
    );
    assert(!oneStale.fresh, 'expected not fresh when one requirement is stale');
    assertEqual(oneStale.tf, '15m', 'the stale requirement is named');
    assertEqual(oneStale.reason, 'stale', 'reason');
  });

  await test('assessFreshnessAll: empty requirement list is vacuously fresh', () => {
    const r = assessFreshnessAll([], NOW, 5000);
    assert(r.fresh, 'expected fresh for no requirements');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
