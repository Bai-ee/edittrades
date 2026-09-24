/**
 * Deterministic tests for scripts/tracker/flag-paths.js (T4 P0, docs/PLAN_FLAG_PATHS.md):
 * labelPath's path table (long and short mirrored), no-lookahead, window expiry, parity
 * of the vendored observeRetestHold against lib/flagTradePlan.js's exported original,
 * featuresAt bucket edges and 'unknown' defaults, baseRates' calibrated flag, and that
 * flag-paths.js imports nothing (it is copied flat into the tracker repo, no lib/ dir
 * there).
 *
 * Run: node test-flag-paths.js
 */

import { readFileSync } from 'node:fs';
import {
  PATHS, DEFAULT_PATH_OPTS, observeRetestHold as vendoredRetestHold, labelPath, featuresAt, baseRates,
  COMPRESSION_BUCKET_EDGES, DURATION_BUCKET_EDGES, IMPULSE_BUCKET_EDGES,
  LEVEL_TESTS_BUCKET_EDGES, STRUCTURE_STEPS_BUCKET_EDGES, STRUCTURE_STEPS_BUCKET_LABELS,
  ROOM_R_BUCKET_EDGES, HOUR_UTC_BUCKET_EDGES
} from './scripts/tracker/flag-paths.js';
import { observeRetestHold as sourceRetestHold } from './lib/flagTradePlan.js';

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
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const MIN = 60_000;
const T0 = Date.parse('2026-09-24T04:00:00.000Z');

/** TF candles (5m) from `startMs`; `rows` = [{o,h,l,c}, ...]. */
function tfCandles(startMs, rows, stepMs = 5 * MIN) {
  return rows.map((r, i) => ({ timestamp: startMs + i * stepMs, open: r.o, high: r.h, low: r.l, close: r.c }));
}

/** 1m candles from `startMs`; `rows` = [{o,h,l,c}, ...]. */
function m1Candles(startMs, rows) {
  return rows.map((r, i) => ({ timestamp: startMs + i * MIN, open: r.o, high: r.h, low: r.l, close: r.c }));
}

(async () => {
  console.log('flag-paths.js (T4 P0)');

  // ---- purity ----
  await test('flag-paths.js imports nothing (pure, no lib/ dependency)', () => {
    const src = readFileSync(new URL('./scripts/tracker/flag-paths.js', import.meta.url), 'utf8');
    assert(!/^\s*import\s/m.test(src), 'no import statements');
    assert(!/require\(/.test(src), 'no require() calls');
    assert(!/from\s+['"]node:/.test(src), 'no node: builtins');
  });

  // ---- exports ----
  await test('PATHS / DEFAULT_PATH_OPTS shape', () => {
    assertEqual(JSON.stringify(PATHS), JSON.stringify(['retest_go', 'runner', 'false_break', 'fail_first', 'chop']), 'PATHS');
    assertEqual(JSON.stringify(DEFAULT_PATH_OPTS), JSON.stringify({ windowCandles: 24, retestTolR: 0.15, targetR: 1 }), 'DEFAULT_PATH_OPTS');
  });

  // ============ labelPath: runner (the SOL case) ============
  await test('labelPath: SOL long - breakout 114.95, invalidation 114.71, runs to 115.42 with no retest -> runner', () => {
    const candidate = { direction: 'long', breakoutLevel: 114.95, invalidation: 114.71, measuredTarget: 115.43 };
    const candlesTf = tfCandles(T0, [
      { o: 114.80, h: 114.90, l: 114.70, c: 114.80 }, // forming
      { o: 114.82, h: 115.00, l: 114.80, c: 115.00 }, // breakout close
      { o: 115.00, h: 115.35, l: 114.98, c: 115.30 }
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 115.00, h: 115.05, l: 115.00, c: 115.03 },
      { o: 115.03, h: 115.12, l: 115.02, c: 115.10 },
      { o: 115.10, h: 115.20, l: 115.10, c: 115.18 }, // target touch (+1R = 115.19)
      { o: 115.18, h: 115.30, l: 115.15, c: 115.28 },
      { o: 115.28, h: 115.42, l: 115.25, c: 115.40 }
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'runner', 'runner');
    assertEqual(r.breakoutAt, T0 + 5 * MIN, 'breakoutAt');
    assertEqual(r.retestAt, null, 'no retest touch');
    assertEqual(r.resolvedAt, T0 + 7 * MIN, 'resolved at the target touch');
    assertEqual(r.targetR, 2, 'targetR from measuredTarget (0.48/0.24)');
    assertEqual(r.minutes, 7, 'minutes from fromMs (T0) to resolution (T0+7m)');
  });

  await test('labelPath: SOL short mirror - runner', () => {
    const candidate = { direction: 'short', breakoutLevel: 100, invalidation: 100.24, measuredTarget: 99.52 };
    const candlesTf = tfCandles(T0, [
      { o: 100.10, h: 100.20, l: 100.05, c: 100.10 },
      { o: 100.05, h: 100.10, l: 99.95, c: 99.95 }, // breakout close (below 100)
      { o: 99.95, h: 100.00, l: 99.85, c: 99.90 }
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 99.90, h: 99.90, l: 99.85, c: 99.87 },
      { o: 99.87, h: 99.88, l: 99.80, c: 99.82 },
      { o: 99.82, h: 99.83, l: 99.76, c: 99.78 }, // target touch (-1R = 99.76)
      { o: 99.78, h: 99.79, l: 99.65, c: 99.68 },
      { o: 99.68, h: 99.69, l: 99.53, c: 99.55 }
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'runner', 'runner (short)');
    assertEqual(r.retestAt, null, 'no retest touch (short)');
    assertEqual(r.targetR, 2, 'targetR (short)');
  });

  // ============ labelPath: retest_go ============
  await test('labelPath: long retest_go', () => {
    const candidate = { direction: 'long', breakoutLevel: 200, invalidation: 198 };
    const candlesTf = tfCandles(T0, [
      { o: 199.4, h: 199.7, l: 199.3, c: 199.5 },
      { o: 199.6, h: 200.6, l: 199.6, c: 200.5 }, // breakout close
      { o: 200.5, h: 200.8, l: 200.4, c: 200.6 }
    ]);
    const candles1m = m1Candles(T0 + 10 * MIN, [
      { o: 200.5, h: 200.60, l: 200.40, c: 200.50 },
      { o: 200.50, h: 200.45, l: 200.20, c: 200.25 }, // retest: low<=200.3, close 200.25>=200
      { o: 200.25, h: 201.00, l: 200.30, c: 200.90 },
      { o: 200.90, h: 202.00, l: 200.90, c: 201.90 } // target touch (+1R = 202)
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'retest_go', 'retest_go');
    assertEqual(r.breakoutAt, T0 + 5 * MIN, 'breakoutAt');
    assertEqual(r.retestAt, T0 + 11 * MIN, 'retestAt');
    assertEqual(r.resolvedAt, T0 + 13 * MIN, 'resolvedAt at target touch');
  });

  await test('labelPath: short retest_go mirror', () => {
    const candidate = { direction: 'short', breakoutLevel: 50, invalidation: 52 };
    const candlesTf = tfCandles(T0, [
      { o: 50.6, h: 50.7, l: 50.3, c: 50.5 },
      { o: 50.4, h: 50.4, l: 49.5, c: 49.5 }, // breakout close
      { o: 49.5, h: 49.6, l: 49.2, c: 49.4 }
    ]);
    const candles1m = m1Candles(T0 + 10 * MIN, [
      { o: 49.5, h: 49.65, l: 49.50, c: 49.60 },
      { o: 49.60, h: 49.75, l: 49.55, c: 49.65 }, // retest: high>=49.7, close 49.65<=50
      { o: 49.65, h: 49.70, l: 49.20, c: 49.30 },
      { o: 49.30, h: 49.30, l: 48.00, c: 48.10 } // target touch (-1R = 48)
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'retest_go', 'retest_go (short)');
    assertEqual(r.retestAt, T0 + 11 * MIN, 'retestAt (short)');
  });

  // ============ labelPath: false_break ============
  await test('labelPath: long false_break', () => {
    const candidate = { direction: 'long', breakoutLevel: 300, invalidation: 298 };
    const candlesTf = tfCandles(T0, [
      { o: 299.4, h: 299.6, l: 299.2, c: 299.5 },
      { o: 299.6, h: 300.6, l: 299.6, c: 300.5 }, // breakout close
      { o: 300.4, h: 300.5, l: 298.9, c: 299.0 }, // back inside the flag
      { o: 298.9, h: 298.9, l: 297.4, c: 297.5 } // invalidation close
    ]);
    const candles1m = m1Candles(T0 + 10 * MIN, [
      { o: 300.5, h: 300.55, l: 300.35, c: 300.45 },
      { o: 300.45, h: 300.45, l: 300.32, c: 300.35 },
      { o: 300.30, h: 300.40, l: 300.20, c: 300.30 } // retest: low<=300.3, close 300.30>=300
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'false_break', 'false_break');
    assertEqual(r.breakoutAt, T0 + 5 * MIN, 'breakoutAt');
    assertEqual(r.retestAt, T0 + 12 * MIN, 'retestAt before invalidation is still reported');
    assertEqual(r.resolvedAt, T0 + 15 * MIN, 'resolved at the invalidation close');
  });

  await test('labelPath: short false_break mirror', () => {
    const candidate = { direction: 'short', breakoutLevel: 150, invalidation: 152 };
    const candlesTf = tfCandles(T0, [
      { o: 150.4, h: 150.6, l: 150.3, c: 150.5 },
      { o: 150.3, h: 150.3, l: 149.4, c: 149.5 }, // breakout close
      { o: 149.5, h: 150.8, l: 149.5, c: 150.8 }, // back inside the flag
      { o: 150.9, h: 152.5, l: 150.9, c: 152.5 } // invalidation close
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 149.5, h: 149.60, l: 149.45, c: 149.50 },
      { o: 149.50, h: 149.70, l: 149.50, c: 149.60 },
      { o: 149.60, h: 149.75, l: 149.60, c: 149.65 } // retest: high>=149.7, close 149.65<=150
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'false_break', 'false_break (short)');
    assertEqual(r.resolvedAt, T0 + 15 * MIN, 'resolvedAt (short)');
  });

  await test('labelPath: touches inside the breakout candle are not a retest (SOL 2026-09-24 runner)', () => {
    // 5m breakout candle 114.95 -> 115.00 crosses the level from inside the flag; its own
    // 1m candles touch 114.95 and close above. No return to the level after it closes,
    // then +1R (115.19) -> runner, not retest_go.
    const candidate = { direction: 'long', breakoutLevel: 114.95, invalidation: 114.71 };
    const candlesTf = tfCandles(T0, [
      { o: 114.90, h: 114.95, l: 114.85, c: 114.92 },
      { o: 114.92, h: 115.02, l: 114.90, c: 115.00 }, // breakout close (T0+5..T0+10)
      { o: 115.00, h: 115.42, l: 115.00, c: 115.40 }
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 114.92, h: 114.96, l: 114.90, c: 114.95 }, // inside the breakout candle: touch + hold
      { o: 114.95, h: 114.99, l: 114.94, c: 114.98 },
      { o: 114.98, h: 115.00, l: 114.96, c: 114.99 },
      { o: 114.99, h: 115.01, l: 114.97, c: 115.00 },
      { o: 115.00, h: 115.02, l: 114.98, c: 115.00 },
      { o: 115.00, h: 115.10, l: 115.00, c: 115.08 }, // after the breakout close, stays above 114.986
      { o: 115.08, h: 115.25, l: 115.07, c: 115.22 } // +1R (115.19)
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'runner', 'runner');
    assertEqual(r.retestAt, null, 'no retest');
  });

  // ============ labelPath: fail_first ============
  await test('labelPath: long fail_first (invalidation close before any breakout close)', () => {
    const candidate = { direction: 'long', breakoutLevel: 400, invalidation: 398 };
    const candlesTf = tfCandles(T0, [
      { o: 399.2, h: 399.4, l: 398.8, c: 399.0 },
      { o: 398.8, h: 398.9, l: 397.3, c: 397.5 } // invalidation close, no breakout ever
    ]);
    const r = labelPath(candidate, candlesTf, [], { fromMs: T0 });
    assertEqual(r.path, 'fail_first', 'fail_first');
    assertEqual(r.breakoutAt, null, 'no breakout');
    assertEqual(r.retestAt, null, 'no retest');
    assertEqual(r.resolvedAt, T0 + 5 * MIN, 'resolved at the invalidation close');
  });

  await test('labelPath: short fail_first mirror', () => {
    const candidate = { direction: 'short', breakoutLevel: 250, invalidation: 252 };
    const candlesTf = tfCandles(T0, [
      { o: 250.8, h: 251.2, l: 250.6, c: 251.0 },
      { o: 251.2, h: 252.5, l: 251.2, c: 252.5 } // invalidation close, no breakout ever
    ]);
    const r = labelPath(candidate, candlesTf, [], { fromMs: T0 });
    assertEqual(r.path, 'fail_first', 'fail_first (short)');
    assertEqual(r.resolvedAt, T0 + 5 * MIN, 'resolvedAt (short)');
  });

  // ============ labelPath: chop ============
  await test('labelPath: long chop (breakout, then neither +1R nor invalidation within the data given)', () => {
    const candidate = { direction: 'long', breakoutLevel: 500, invalidation: 498 };
    const candlesTf = tfCandles(T0, [
      { o: 499.2, h: 499.4, l: 498.8, c: 499.0 },
      { o: 498.9, h: 500.5, l: 498.9, c: 500.5 }, // breakout close
      { o: 500.4, h: 501.0, l: 500.3, c: 500.8 }
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 500.5, h: 500.9, l: 500.6, c: 500.7 },
      { o: 500.7, h: 501.2, l: 500.6, c: 501.0 },
      { o: 501.0, h: 501.4, l: 500.9, c: 501.2 }
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'chop', 'chop');
    assertEqual(r.breakoutAt, T0 + 5 * MIN, 'breakoutAt still recorded');
    assertEqual(r.resolvedAt, null, 'never resolved');
    assertEqual(r.minutes, null, 'no minutes without a resolution');
  });

  await test('labelPath: no breakout and no invalidation at all -> chop', () => {
    const candidate = { direction: 'long', breakoutLevel: 700, invalidation: 698 };
    const candlesTf = tfCandles(T0, [
      { o: 699.0, h: 699.4, l: 698.6, c: 699.1 },
      { o: 699.1, h: 699.5, l: 698.7, c: 699.2 }
    ]);
    const r = labelPath(candidate, candlesTf, [], { fromMs: T0 });
    assertEqual(r.path, 'chop', 'chop, never broke out');
    assertEqual(r.breakoutAt, null, 'no breakout');
  });

  // ============ no-lookahead ============
  await test('labelPath: candles before fromMs are ignored', () => {
    const candidate = { direction: 'long', breakoutLevel: 600, invalidation: 598 };
    const candlesTf = tfCandles(T0 - 10 * MIN, [
      { o: 599.0, h: 599.2, l: 597.0, c: 597.2 }, // would be fail_first if read - before fromMs
      { o: 597.2, h: 597.4, l: 596.0, c: 596.5 }, // also before fromMs
      { o: 599.0, h: 599.2, l: 598.8, c: 599.0 }, // fromMs candle (forming)
      { o: 599.0, h: 600.5, l: 599.0, c: 600.5 }, // breakout close, at/after fromMs
      { o: 600.4, h: 600.8, l: 600.3, c: 600.6 }
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 600.5, h: 600.7, l: 600.5, c: 600.6 },
      { o: 600.6, h: 602.0, l: 600.6, c: 601.9 } // target touch (+1R = 602)
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'runner', 'runner, not fail_first - the earlier invalidation is out of window');
    assertEqual(r.breakoutAt, T0 + 5 * MIN, 'breakoutAt is the fromMs+1 candle');
  });

  await test('labelPath: a later candle cannot change an earlier resolution', () => {
    const candidate = { direction: 'long', breakoutLevel: 800, invalidation: 798 };
    const candlesTf = tfCandles(T0, [
      { o: 799.0, h: 799.2, l: 798.8, c: 799.0 },
      { o: 799.0, h: 800.5, l: 799.0, c: 800.5 }, // breakout close
      { o: 800.4, h: 800.6, l: 800.3, c: 800.5 },
      { o: 800.5, h: 800.5, l: 797.0, c: 797.2 } // later invalidation close - must not matter
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 800.5, h: 800.6, l: 800.5, c: 800.55 },
      { o: 800.55, h: 802.0, l: 800.55, c: 801.9 } // target touch (+1R = 802) resolves first
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0 });
    assertEqual(r.path, 'runner', 'runner - resolved at the target before the later invalidation close');
    assertEqual(r.resolvedAt, T0 + 6 * MIN, 'resolvedAt is the earlier target touch');
  });

  // ============ window expiry ============
  await test('labelPath: window expiry cuts a would-be resolution off into chop', () => {
    const candidate = { direction: 'long', breakoutLevel: 900, invalidation: 898 };
    const candlesTf = tfCandles(T0, [
      { o: 899.0, h: 899.2, l: 898.8, c: 899.0 },
      { o: 899.0, h: 900.5, l: 899.0, c: 900.5 } // breakout close, last candle allowed by windowCandles:2
    ]);
    const candles1m = m1Candles(T0 + 5 * MIN, [
      { o: 900.5, h: 900.6, l: 900.5, c: 900.55 }, // inside the window (ends at T0+10m)
      { o: 900.55, h: 900.7, l: 900.5, c: 900.6 },
      { o: 900.6, h: 900.8, l: 900.5, c: 900.7 },
      { o: 900.7, h: 900.9, l: 900.6, c: 900.8 },
      { o: 900.8, h: 900.9, l: 900.7, c: 900.85 },
      { o: 900.85, h: 902.5, l: 900.85, c: 902.4 } // target touch, but at T0+11m - outside the window
    ]);
    const r = labelPath(candidate, candlesTf, candles1m, { fromMs: T0, windowCandles: 2 });
    assertEqual(r.path, 'chop', 'window expired before the target touch could count');
    const full = labelPath(candidate, tfCandles(T0, [
      { o: 899.0, h: 899.2, l: 898.8, c: 899.0 },
      { o: 899.0, h: 900.5, l: 899.0, c: 900.5 },
      { o: 900.5, h: 900.6, l: 900.4, c: 900.5 }
    ]), candles1m, { fromMs: T0 });
    assertEqual(full.path, 'runner', 'sanity: the same touch resolves runner with default windowCandles');
  });

  // ============ observeRetestHold parity ============
  await test('observeRetestHold: vendored copy matches lib/flagTradePlan.js exactly', () => {
    const c = (ts, h, l, close) => ({ timestamp: ts, high: h, low: l, close });
    const long20 = [
      c(T0, 19.8, 19.6, 19.7),
      c(T0 + MIN, 20.5, 20.2, 20.4), // breakout close
      c(T0 + 2 * MIN, 20.45, 20.05, 20.10), // retest reached+held (tolerance 0.1*4=0.4)
      c(T0 + 3 * MIN, 20.6, 20.1, 20.5)
    ];
    const long20NoHold = [
      c(T0, 19.8, 19.6, 19.7),
      c(T0 + MIN, 20.5, 20.2, 20.4),
      c(T0 + 2 * MIN, 20.45, 20.05, 19.95) // reached but closed back under entry - no hold
    ];
    const short50 = [
      c(T0, 50.3, 50.1, 50.2),
      c(T0 + MIN, 49.8, 49.5, 49.6), // breakout close
      c(T0 + 2 * MIN, 49.95, 49.55, 49.7) // retest reached+held
    ];
    const cases = [
      { direction: 'long', entry: 20, candles: long20, fromMs: T0, currentPrice: 20.5, atrValue: 4, toleranceAtr: 0.1 },
      { direction: 'long', entry: 20, candles: long20NoHold, fromMs: T0, currentPrice: 19.95, atrValue: 4, toleranceAtr: 0.1 },
      { direction: 'short', entry: 50, candles: short50, fromMs: T0, currentPrice: 49.7, atrValue: 3, toleranceAtr: 0.1 },
      { direction: 'long', entry: 20, candles: long20.slice(0, 1), fromMs: T0, currentPrice: 19.7, atrValue: 4, toleranceAtr: 0.1 }, // no breakout yet
      { direction: 'long', entry: 20, candles: null, fromMs: T0, currentPrice: 20.5, atrValue: null, toleranceAtr: 0.1 } // falls to the ATR-less branch
    ];
    for (const args of cases) {
      assertEqual(JSON.stringify(vendoredRetestHold(args)), JSON.stringify(sourceRetestHold(args)), `parity ${JSON.stringify(args.direction)} ${args.candles ? args.candles.length : 'null'}`);
    }
  });

  // ============ featuresAt ============
  await test('featuresAt: bucket edges', () => {
    const cand = (over) => ({ direction: 'long', timeframe: '5m', breakoutLevel: 100, ...over });
    assertEqual(featuresAt(cand({ compressionScore: COMPRESSION_BUCKET_EDGES[0] - 0.01 })).compression, 'loose', 'below first compression edge');
    assertEqual(featuresAt(cand({ compressionScore: COMPRESSION_BUCKET_EDGES[0] })).compression, 'moderate', 'at first compression edge');
    assertEqual(featuresAt(cand({ compressionScore: COMPRESSION_BUCKET_EDGES[1] })).compression, 'tight', 'at second compression edge');

    assertEqual(featuresAt(cand({ durationCandles: DURATION_BUCKET_EDGES[0] - 1 })).duration, 'short', 'below duration edge');
    assertEqual(featuresAt(cand({ durationCandles: DURATION_BUCKET_EDGES[0] })).duration, 'medium', 'at duration edge');
    assertEqual(featuresAt(cand({ durationCandles: DURATION_BUCKET_EDGES[1] })).duration, 'long', 'at second duration edge');

    assertEqual(featuresAt(cand({ impulseStrength: IMPULSE_BUCKET_EDGES[0] - 0.1 })).impulseStrength, 'weak', 'below impulse edge');
    assertEqual(featuresAt(cand({ impulseStrength: IMPULSE_BUCKET_EDGES[1] })).impulseStrength, 'strong', 'at second impulse edge');

    const ctxLevel = (count) => ({ atrValue: 1, flagCandles: Array.from({ length: count }, () => ({ high: 100, low: 100 })) });
    assertEqual(featuresAt(cand({}), ctxLevel(LEVEL_TESTS_BUCKET_EDGES[0] - 1)).levelTests, 'none', 'level tests below edge');
    assertEqual(featuresAt(cand({}), ctxLevel(LEVEL_TESTS_BUCKET_EDGES[1])).levelTests, 'multiple', 'level tests at second edge');

    const ctxStruct = (lows) => ({ flagCandles: lows.map((l) => ({ low: l, high: 200 - l })) });
    assertEqual(featuresAt(cand({}), ctxStruct([10, 10])).structureSteps, 'none', 'no higher lows -> none');
    // one higher low = STRUCTURE_STEPS_BUCKET_EDGES[0] itself -> the second label
    const oneStep = Array.from({ length: STRUCTURE_STEPS_BUCKET_EDGES[0] + 1 }, (_, i) => 10 + i);
    assertEqual(featuresAt(cand({}), ctxStruct(oneStep)).structureSteps, STRUCTURE_STEPS_BUCKET_LABELS[1], 'at first structure edge');
    // count >= STRUCTURE_STEPS_BUCKET_EDGES[1] -> the last label
    const manySteps = Array.from({ length: STRUCTURE_STEPS_BUCKET_EDGES[1] + 2 }, (_, i) => 10 + i);
    assertEqual(featuresAt(cand({}), ctxStruct(manySteps)).structureSteps, STRUCTURE_STEPS_BUCKET_LABELS[STRUCTURE_STEPS_BUCKET_LABELS.length - 1], 'many higher lows');

    assertEqual(featuresAt(cand({}), { roomR: ROOM_R_BUCKET_EDGES[0] - 0.5 }).roomR, 'tight', 'room below edge');
    assertEqual(featuresAt(cand({}), { roomR: ROOM_R_BUCKET_EDGES[1] }).roomR, 'roomy', 'room at second edge');

    assertEqual(featuresAt(cand({}), { fromMs: Date.UTC(2026, 8, 24, 0, 0, 0) }).hourUtc, '00-06', 'hour 0');
    assertEqual(featuresAt(cand({}), { fromMs: Date.UTC(2026, 8, 24, HOUR_UTC_BUCKET_EDGES[0], 0, 0) }).hourUtc, '06-12', 'hour at first edge');
    assertEqual(featuresAt(cand({}), { fromMs: Date.UTC(2026, 8, 24, 23, 0, 0) }).hourUtc, '18-24', 'hour 23');
  });

  await test('featuresAt: missing candidate/ctx fields all bucket to unknown', () => {
    const f = featuresAt({}, {});
    for (const key of Object.keys(f)) {
      assert(f[key] === 'unknown', `${key} should be unknown, got ${f[key]}`);
    }
  });

  await test('featuresAt: ctx passthroughs (stochSide, stochSlope, tfAgreement, tdSide, ema200Side)', () => {
    const cand = { direction: 'long', timeframe: '5m' };
    const f1 = featuresAt(cand, { stochSide: 'bull', stochSlope: 0.4, sameDirOtherTf: true, tdSide: 'bull', ema200Side: 'above' });
    assertEqual(f1.stochSide, 'bull', 'stochSide passthrough');
    assertEqual(f1.stochSlope, 'rising', 'stochSlope bucketed from a positive number');
    assertEqual(f1.tfAgreement, 'agree', 'tfAgreement true -> agree');
    assertEqual(f1.tdSide, 'bull', 'tdSide passthrough');
    assertEqual(f1.ema200Side, 'above', 'ema200Side passthrough');

    const f2 = featuresAt(cand, { stochSlope: -0.2, sameDirOtherTf: false });
    assertEqual(f2.stochSlope, 'falling', 'negative slope -> falling');
    assertEqual(f2.tfAgreement, 'disagree', 'tfAgreement false -> disagree');

    const f3 = featuresAt(cand, { stochSlope: 'flat' });
    assertEqual(f3.stochSlope, 'flat', 'already-labelled string slope passes through');
  });

  // ============ baseRates ============
  await test('baseRates: calibrated flag and per-path shares', () => {
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push({ path: 'runner', tf: '5m' });
    for (let i = 0; i < 40; i++) rows.push({ path: 'retest_go', tf: '5m' });
    for (let i = 0; i < 30; i++) rows.push({ path: 'fail_first', tf: '15m' });
    const table = baseRates(rows, (r) => r.tf, 100);
    const fiveM = table.find((t) => t.key === '5m');
    const fifteenM = table.find((t) => t.key === '15m');
    assertEqual(fiveM.n, 100, '5m n');
    assertEqual(fiveM.calibrated, true, '5m calibrated at n=100');
    assertEqual(fiveM.shares.runner, 60, '5m runner share pct');
    assertEqual(fiveM.shares.retest_go, 40, '5m retest_go share pct');
    assertEqual(fiveM.shares.chop, 0, '5m chop share pct is 0, not missing');
    assertEqual(fifteenM.n, 30, '15m n');
    assertEqual(fifteenM.calibrated, false, '15m uncalibrated below minN');
    assertEqual(fifteenM.shares.fail_first, 100, '15m fail_first share pct');
  });

  await test('baseRates: rows with no usable key are skipped', () => {
    const table = baseRates([{ path: 'runner' }, null, { path: 'chop' }], (r) => (r ? undefined : null), 1);
    assertEqual(table.length, 0, 'no groups formed');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failed:', failures.join(', '));
    process.exit(1);
  }
})();
