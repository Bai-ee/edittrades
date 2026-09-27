/**
 * WP10 (docs/research/harness/WP10_TRACKER_EVIDENCE.md) - unit tests for
 * scripts/research/tracker-evidence/wait-scoring.js (R11 WAIT/no-trade scoring).
 *
 * Run: node test-wp10-wait-scoring.js
 */

import { classifyWaitRow, dedupeByCandidateId, actionableHitRate } from './scripts/research/tracker-evidence/wait-scoring.js';

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

const BASE = Date.parse('2026-02-01T00:00:00.000Z');
function minutes(n) { return BASE + n * 60000; }
function c(ts, o, h, l, close) { return { timestamp: ts, open: o, high: h, low: l, close, volume: 1 }; }

console.log('WP10 wait-scoring.js');

test('classifyWaitRow: long lean, price rallies +1R before -1R -> missed', () => {
  const row = { direction: 'long', riskPct: 1, refPrice: 100, closedThrough: new Date(minutes(0)).toISOString() };
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push(c(minutes(i), 100 + i, 100 + i + 0.2, 100 + i - 0.2, 100 + i));
  // by minute 1 the high already reaches 101.2 (+1.2%), well past +1R with no stop touch first
  assert(classifyWaitRow(row, candles) === 'missed', 'expected missed');
});

test('classifyWaitRow: long lean, price drops -1R before +1R -> avoided', () => {
  const row = { direction: 'long', riskPct: 1, refPrice: 100, closedThrough: new Date(minutes(0)).toISOString() };
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push(c(minutes(i), 100 - i, 100 - i + 0.2, 100 - i - 0.2, 100 - i));
  assert(classifyWaitRow(row, candles) === 'avoided', 'expected avoided');
});

test('classifyWaitRow: short lean mirrors long', () => {
  const row = { direction: 'short', riskPct: 1, refPrice: 100, closedThrough: new Date(minutes(0)).toISOString() };
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push(c(minutes(i), 100 - i, 100 - i + 0.2, 100 - i - 0.2, 100 - i)); // price falls -> good for a short
  assert(classifyWaitRow(row, candles) === 'missed', 'expected missed for a short into a falling market');
});

test('classifyWaitRow: null with no direction/risk/candles', () => {
  assert(classifyWaitRow({ direction: null, riskPct: 1, refPrice: 100, closedThrough: new Date(minutes(0)).toISOString() }, []) === null, 'expected null for missing direction');
  assert(classifyWaitRow({ direction: 'long', riskPct: null, refPrice: 100, closedThrough: new Date(minutes(0)).toISOString() }, []) === null, 'expected null for missing riskPct');
  assert(classifyWaitRow({ direction: 'long', riskPct: 1, refPrice: 100, closedThrough: new Date(minutes(0)).toISOString() }, []) === null, 'expected null with zero candles');
});

test('classifyWaitRow: still open when neither barrier is hit within the hold', () => {
  const row = { direction: 'long', riskPct: 10, refPrice: 100, closedThrough: new Date(minutes(0)).toISOString() };
  const candles = [];
  for (let i = 0; i < 5; i++) candles.push(c(minutes(i), 100, 100.1, 99.9, 100));
  assert(classifyWaitRow(row, candles) === 'open', 'expected open (neither +-10% barrier reachable in this tiny fixture)');
});

test('dedupeByCandidateId: keeps only the earliest capture per candidateId', () => {
  const rows = [
    { candidateId: 'A', closedThrough: '2026-01-01T00:10:00.000Z' },
    { candidateId: 'A', closedThrough: '2026-01-01T00:05:00.000Z' },
    { candidateId: 'A', closedThrough: '2026-01-01T00:15:00.000Z' },
    { candidateId: 'B', closedThrough: '2026-01-01T00:00:00.000Z' },
    { candidateId: null, closedThrough: '2026-01-01T00:00:00.000Z' } // no candidateId -> kept as its own row
  ];
  const out = dedupeByCandidateId(rows);
  const a = out.filter((r) => r.candidateId === 'A');
  assert(a.length === 1 && a[0].closedThrough === '2026-01-01T00:05:00.000Z', 'expected only the earliest A row');
  assert(out.length === 3, `expected 3 rows (A once, B once, null kept), got ${out.length}`);
});

test('actionableHitRate: tp1 rate over resolved GOOD-class recs and ready plans', () => {
  const outcomeRows = [
    { kind: 'rec', class: 'GOOD', outcome: 'tp1' },
    { kind: 'rec', class: 'GOOD', outcome: 'stop' },
    { kind: 'rec', class: 'GOOD', outcome: 'stop' },
    { kind: 'rec', class: 'WATCH', outcome: 'tp1' }, // excluded: not GOOD
    { kind: 'plan', outcome: 'tp1' },
    { kind: 'plan', outcome: 'not_filled' } // excluded: not a resolved outcome
  ];
  const rates = actionableHitRate(outcomeRows);
  assert(rates.good.n === 3 && rates.good.tp1Rate === 33.33, `expected good n=3 rate=33.33, got ${JSON.stringify(rates.good)}`);
  assert(rates.readyPlans.n === 1 && rates.readyPlans.tp1Rate === 100, `expected readyPlans n=1 rate=100, got ${JSON.stringify(rates.readyPlans)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:', failures.join(', ')); process.exit(1); }
