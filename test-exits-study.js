/**
 * Deterministic tests for scripts/research/exits.js (S1 agent C - exits study,
 * docs/PROMPT_S1_EDGE_SEARCH.md "C"). Hand-built 1m candle paths, every number checked
 * exactly. Each exit-variant walker is exercised on a LONG scenario and its mirror image
 * (entry held fixed, every price reflected through it: `mirrorLevel = 2*entry - value`,
 * candle highs/lows swapped so the mirrored candle's shape is the true reflection) run as
 * a SHORT - the two must produce the same status and the same R, proving no long/short
 * asymmetry snuck into the walk logic itself (direction-dependent COST is a separate,
 * already-tested concern in test-tracker.js / scripts/tracker/costs.js).
 *
 * Run: node test-exits-study.js
 */

import {
  walkFixed, walkBE1R, walkTrail1R, walkPartial50, walkTimeStop, walkTP2,
  statsFor, splitHalves, passesOOSRule, timeStopCutoffFromFixed
} from './scripts/research/exits.js';

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
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertClose(actual, expected, tolerance, msg) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${msg}: actual is not a finite number (${JSON.stringify(actual)})`);
  assert(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// candle / mirror helpers
// ---------------------------------------------------------------------------

const MIN = 60000;
function C(i, open, high, low, close) {
  return { timestamp: i * MIN, open, high, low, close };
}

function mirrorLevel(entry, v) { return 2 * entry - v; }

/** Reflects a whole LONG scenario into its SHORT mirror image (entry held fixed). */
function mirrorScenario({ entry, stop, target, candles }) {
  return {
    entry,
    stop: mirrorLevel(entry, stop),
    target: mirrorLevel(entry, target),
    candles: candles.map((c) => ({
      timestamp: c.timestamp,
      open: mirrorLevel(entry, c.open),
      high: mirrorLevel(entry, c.low),
      low: mirrorLevel(entry, c.high),
      close: mirrorLevel(entry, c.close)
    }))
  };
}

const FROM_MS = 0;

/** Runs `walker` on a long scenario and its mirror, asserting equal status and R. */
function assertMirrorMatch(walker, longScenario, extra, label) {
  const long = walker({ candles1m: longScenario.candles, fromMs: FROM_MS, direction: 'long', entry: longScenario.entry, stop: longScenario.stop, target: longScenario.target, ...extra });
  const mirrored = mirrorScenario(longScenario);
  const short = walker({ candles1m: mirrored.candles, fromMs: FROM_MS, direction: 'short', entry: mirrored.entry, stop: mirrored.stop, target: mirrored.target, ...extra });
  assertEqual(short.status, long.status, `${label}: mirrored status differs`);
  if (long.r === undefined) assert(short.r === undefined, `${label}: mirrored r should also be undefined`);
  else assertClose(short.r, long.r, 1e-9, `${label}: mirrored r differs`);
  if (Number.isFinite(long.holdCandles)) assertEqual(short.holdCandles, long.holdCandles, `${label}: mirrored holdCandles differs`);
  return { long, short };
}

console.log('\nscripts/research/exits.js\n');

// ---------------------------------------------------------------------------
// 1) fixed
// ---------------------------------------------------------------------------
console.log('1) fixed\n');

test('fixed: target hit later candle -> win, mirrored long/short match', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 105, 100, 105),
      C(2, 105, 116, 104, 116)
    ]
  };
  const { long } = assertMirrorMatch(walkFixed, scenario, {}, 'fixed win');
  assertEqual(long.status, 'win');
  assertClose(long.r, 3, 1e-9, 'rTarget = (115-100)/(100-95) = 3');
  assertEqual(long.holdCandles, 3);
  assertEqual(long.timeToTP1Candles, 3);
});

test('fixed: stop hit before target -> loss, mirrored long/short match', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 100, 94, 96)
    ]
  };
  const { long } = assertMirrorMatch(walkFixed, scenario, {}, 'fixed loss');
  assertEqual(long.status, 'loss');
  assertEqual(long.r, -1);
  assertEqual(long.holdCandles, 2);
});

test('fixed: same candle touches both stop and target -> stop wins (conservative)', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 116, 94, 100)
    ]
  };
  const { long } = assertMirrorMatch(walkFixed, scenario, {}, 'fixed ambiguous');
  assertEqual(long.status, 'loss');
  assertEqual(long.r, -1);
});

test('fixed: never resolved within hold limit -> open', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [C(0, 100, 101, 99, 100), C(1, 100, 102, 99, 101)]
  };
  const long = walkFixed({ candles1m: scenario.candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, target: 115, maxHoldCandles: 2 });
  assertEqual(long.status, 'open');
  assertEqual(long.holdCandles, 2);
});

// ---------------------------------------------------------------------------
// 2) be1r
// ---------------------------------------------------------------------------
console.log('\n2) be1r\n');

test('be1r: never reaches +1R, hits original stop -> full -1R', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [C(0, 100, 101, 99, 100), C(1, 100, 100, 94, 96)]
  };
  const { long } = assertMirrorMatch(walkBE1R, scenario, {}, 'be1r loss');
  assertEqual(long.status, 'loss');
  assertEqual(long.r, -1);
});

test('be1r: close reaches +1R then reverses to breakeven -> 0R, not -1', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 105), // close 105 = entry + 1R (risk 5) -> arms
      C(2, 105, 105, 99, 101) // dips through breakeven (100)
    ]
  };
  const { long } = assertMirrorMatch(walkBE1R, scenario, {}, 'be1r breakeven');
  assertEqual(long.status, 'breakeven');
  assertEqual(long.r, 0);
});

test('be1r: arms at +1R then continues to full target -> win at rTarget', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 105),
      C(2, 105, 116, 104, 116)
    ]
  };
  const { long } = assertMirrorMatch(walkBE1R, scenario, {}, 'be1r win');
  assertEqual(long.status, 'win');
  assertClose(long.r, 3, 1e-9);
});

// ---------------------------------------------------------------------------
// 3) trail1r
// ---------------------------------------------------------------------------
console.log('\n3) trail1r\n');

test('trail1r: arms at +1R, best close advances, then pulls back to the trailed stop', () => {
  const scenario = {
    entry: 100, stop: 95, target: 130, // target far away so trailing (not target) resolves this
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 105), // close 105 = +1R -> arm, trail stop = 105-5 = 100
      C(2, 105, 111, 104, 110), // best close 110 -> trail stop = 110-5 = 105
      C(3, 110, 110, 104, 106) // pulls back through 105
    ]
  };
  const { long } = assertMirrorMatch(walkTrail1R, scenario, {}, 'trail1r trailed exit');
  assertEqual(long.status, 'trail_stop');
  // exit at trailed stop 105 -> r = (105-100)/5 = 1
  assertClose(long.r, 1, 1e-9);
  assertEqual(long.holdCandles, 4);
});

test('trail1r: never arms (never reaches +1R), hits original stop -> full -1R', () => {
  const scenario = {
    entry: 100, stop: 95, target: 130,
    candles: [C(0, 100, 101, 99, 100), C(1, 100, 102, 94, 96)]
  };
  const { long } = assertMirrorMatch(walkTrail1R, scenario, {}, 'trail1r loss');
  assertEqual(long.status, 'loss');
  assertEqual(long.r, -1);
});

test('trail1r: still capped at the unchanged target if it is reached', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 105),
      C(2, 105, 116, 104, 116)
    ]
  };
  const { long } = assertMirrorMatch(walkTrail1R, scenario, {}, 'trail1r target cap');
  assertEqual(long.status, 'win');
  assertClose(long.r, 3, 1e-9);
});

// ---------------------------------------------------------------------------
// 4) partial50
// ---------------------------------------------------------------------------
console.log('\n4) partial50\n');

test('partial50: never reaches +1R, hits stop -> full -1R (no partial taken)', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [C(0, 100, 101, 99, 100), C(1, 100, 100, 94, 96)]
  };
  const { long } = assertMirrorMatch(walkPartial50, scenario, {}, 'partial50 loss');
  assertEqual(long.status, 'loss');
  assertEqual(long.r, -1);
});

test('partial50: arms at +1R then breakeven stop hit -> 0.5R (half booked, half scratched)', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 105), // +1R close -> arm
      C(2, 105, 105, 99, 101) // dips through breakeven
    ]
  };
  const { long } = assertMirrorMatch(walkPartial50, scenario, {}, 'partial50 be');
  assertEqual(long.status, 'partial_be');
  assertClose(long.r, 0.5, 1e-9);
});

test('partial50: arms at +1R then remainder hits target -> 0.5*1 + 0.5*rTarget', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 105),
      C(2, 105, 116, 104, 116)
    ]
  };
  const { long } = assertMirrorMatch(walkPartial50, scenario, {}, 'partial50 win');
  assertEqual(long.status, 'partial_win');
  assertClose(long.r, 0.5 * 1 + 0.5 * 3, 1e-9);
});

test('partial50: never arms, never resolved by hold limit -> open (not marked-to-market)', () => {
  const scenario = { entry: 100, stop: 95, target: 115, candles: [C(0, 100, 101, 99, 100), C(1, 100, 102, 99, 101)] };
  const long = walkPartial50({ candles1m: scenario.candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, target: 115, maxHoldCandles: 2 });
  assertEqual(long.status, 'open');
});

test('partial50: arms at +1R then hold limit reached -> marked-to-market remainder', () => {
  const scenario = {
    entry: 100, stop: 95, target: 130,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 105), // arms
      C(2, 105, 108, 104, 108) // hold limit hits here, last close 108
    ]
  };
  const long = walkPartial50({ candles1m: scenario.candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, target: 130, maxHoldCandles: 3 });
  assertEqual(long.status, 'partial_timeout');
  const remR = (108 - 100) / 5; // 1.6
  assertClose(long.r, 0.5 * 1 + 0.5 * remR, 1e-9, 'marked-to-market remainder R');
});

// ---------------------------------------------------------------------------
// 5) time
// ---------------------------------------------------------------------------
console.log('\n5) time\n');

test('time: resolves normally (win) before its cutoff, same as fixed', () => {
  const scenario = {
    entry: 100, stop: 95, target: 115,
    candles: [C(0, 100, 101, 99, 100), C(1, 100, 105, 100, 105), C(2, 105, 116, 104, 116)]
  };
  const { long } = assertMirrorMatch(walkTimeStop, scenario, { timeStopCandles: 10 }, 'time win before cutoff');
  assertEqual(long.status, 'win');
  assertClose(long.r, 3, 1e-9);
});

test('time: neither stop nor target hit by the cutoff -> forced close at market', () => {
  const scenario = {
    entry: 100, stop: 95, target: 130,
    candles: [
      C(0, 100, 101, 99, 100),
      C(1, 100, 106, 100, 104), // candle 2 (index 1) - cutoff = 2 candles
      C(2, 104, 120, 103, 118) // never reached: cutoff already closed the trade
    ]
  };
  const long = walkTimeStop({ candles1m: scenario.candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, target: 130, timeStopCandles: 2 });
  assertEqual(long.status, 'time_stop');
  assertClose(long.r, (104 - 100) / 5, 1e-9, 'marked-to-market at the cutoff candle close, not the later candle');
  assertEqual(long.holdCandles, 2);
});

test('time: falls back to the full hold when timeStopCandles is not finite', () => {
  const scenario = { entry: 100, stop: 95, target: 115, candles: [C(0, 100, 101, 99, 100), C(1, 100, 105, 100, 105), C(2, 105, 116, 104, 116)] };
  const long = walkTimeStop({ candles1m: scenario.candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, target: 115, timeStopCandles: null, maxHoldCandles: 24 });
  assertEqual(long.status, 'win');
});

// ---------------------------------------------------------------------------
// 6) tp2
// ---------------------------------------------------------------------------
console.log('\n6) tp2\n');

test('tp2: uses tp2 as target when present (farther than tp1)', () => {
  const candles = [
    C(0, 100, 101, 99, 100),
    C(1, 100, 116, 100, 116), // touches tp1 (115) but not tp2 (125)
    C(2, 116, 126, 115, 126) // touches tp2
  ];
  const long = walkTP2({ candles1m: candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, tp1: 115, tp2: 125 });
  assertEqual(long.status, 'win');
  assertClose(long.r, (125 - 100) / 5, 1e-9, 'rTarget computed against tp2, not tp1');
  assertEqual(long.holdCandles, 3, 'tp1 touch on candle 1 must not resolve this walk (target is tp2)');

  const mirrored = mirrorScenario({ entry: 100, stop: 95, target: 125, candles });
  const short = walkTP2({ candles1m: mirrored.candles, fromMs: FROM_MS, direction: 'short', entry: 100, stop: mirrored.stop, tp1: mirrorLevel(100, 115), tp2: mirrorLevel(100, 125) });
  assertEqual(short.status, 'win');
  assertClose(short.r, long.r, 1e-9, 'mirrored tp2 short must match long r');
});

test('tp2: falls back to tp1 when the plan carries no tp2 (null)', () => {
  const candles = [C(0, 100, 101, 99, 100), C(1, 100, 105, 100, 105), C(2, 105, 116, 104, 116)];
  const withTp2Null = walkTP2({ candles1m: candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, tp1: 115, tp2: null });
  const viaFixed = walkFixed({ candles1m: candles, fromMs: FROM_MS, direction: 'long', entry: 100, stop: 95, target: 115 });
  assertEqual(withTp2Null.status, viaFixed.status);
  assertClose(withTp2Null.r, viaFixed.r, 1e-9);
});

// ---------------------------------------------------------------------------
// 7) timeStopCutoffFromFixed
// ---------------------------------------------------------------------------
console.log('\n7) timeStopCutoffFromFixed\n');

test('timeStopCutoffFromFixed: 2x the median timeToTP1Candles among fixed winners', () => {
  const rows = [
    { outcomeStatus: 'win', timeToTP1Candles: 60 },
    { outcomeStatus: 'win', timeToTP1Candles: 100 },
    { outcomeStatus: 'loss', timeToTP1Candles: null },
    { outcomeStatus: 'open', timeToTP1Candles: null }
  ];
  assertEqual(timeStopCutoffFromFixed(rows), 160); // median(60,100)=80, 2x=160
});

test('timeStopCutoffFromFixed: null when there are no winners', () => {
  const rows = [{ outcomeStatus: 'loss', timeToTP1Candles: null }, { outcomeStatus: 'open', timeToTP1Candles: null }];
  assertEqual(timeStopCutoffFromFixed(rows), null);
});

// ---------------------------------------------------------------------------
// 8) statsFor / splitHalves / passesOOSRule
// ---------------------------------------------------------------------------
console.log('\n8) statsFor / splitHalves / passesOOSRule\n');

test('statsFor: n, resolved, win %, expectancy, max losing streak, median hold', () => {
  const rows = [
    { firstReadyAt: '2026-01-01T00:00:00.000Z', grossR: 3, netR: 2.5, holdCandles: 60 },
    { firstReadyAt: '2026-01-02T00:00:00.000Z', grossR: -1, netR: -1.1, holdCandles: 30 },
    { firstReadyAt: '2026-01-03T00:00:00.000Z', grossR: -1, netR: -1.1, holdCandles: 20 },
    { firstReadyAt: '2026-01-04T00:00:00.000Z', grossR: null, netR: null, holdCandles: null } // unresolved
  ];
  const s = statsFor(rows);
  assertEqual(s.n, 4);
  assertEqual(s.resolvedN, 3);
  assertEqual(s.unresolvedN, 1);
  assertClose(s.winRate, (1 / 3) * 100, 0.01);
  assertClose(s.grossExpectancyR, (3 - 1 - 1 + 0) / 4, 1e-9);
  assertClose(s.netExpectancyR, (2.5 - 1.1 - 1.1 + 0) / 4, 1e-9);
  assertEqual(s.maxLosingStreak, 2);
  assertClose(s.medianHoldHours, 30 / 60, 1e-9); // median(60,30,20)=30
});

test('splitHalves: boundary at 2/3 of the span, and passesOOSRule requires both halves positive and n>=20', () => {
  const spanFromMs = Date.parse('2026-01-01T00:00:00.000Z');
  const spanToMs = Date.parse('2026-01-31T00:00:00.000Z'); // 30 days
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({ firstReadyAt: new Date(spanFromMs + i * 86400000).toISOString(), grossR: 1, netR: 0.9, holdCandles: 60 }); // days 0-24 (first 2/3 = day 0..19)
  for (let i = 25; i < 30; i++) rows.push({ firstReadyAt: new Date(spanFromMs + i * 86400000).toISOString(), grossR: 1, netR: 0.9, holdCandles: 60 }); // days 25-29 (second third)
  const halves = splitHalves(rows, spanFromMs, spanToMs);
  assert(halves.first.n > 0 && halves.second.n > 0, 'both halves should be non-empty');
  assertEqual(halves.first.n + halves.second.n, rows.length);
  assert(passesOOSRule(rows, halves), 'both halves positive and n>=20 should pass');

  const rowsTooFew = rows.slice(0, 10);
  const halves2 = splitHalves(rowsTooFew, spanFromMs, spanToMs);
  assert(!passesOOSRule(rowsTooFew, halves2), 'n < 20 should fail regardless of sign');

  const rowsMixed = rows.map((r, i) => (i < 20 ? { ...r, grossR: 1, netR: 0.9 } : { ...r, grossR: -1, netR: -1.1 }));
  const halvesMixed = splitHalves(rowsMixed, spanFromMs, spanToMs);
  assert(!passesOOSRule(rowsMixed, halvesMixed), 'a negative second half should fail');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`Failures: ${failures.join(', ')}`);
  process.exitCode = 1;
}
