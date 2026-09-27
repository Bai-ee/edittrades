/**
 * Tests for scripts/research/harness/adaptive-walk.js (WP11-B,
 * docs/research/harness/WP11_VALIDATE.md): the adaptive same-bar stop/TP ordering variant
 * of the vendored scripts/tracker/walk-outcome.js `walkOutcome` (Nautilus
 * `bar_adaptive_high_low_ordering`, docs/research/external-refs/OTHER_REPOS_VERIFY.md).
 *
 * Section 1: a synthetic ambiguous bar (both stop and target inside one 1m candle's range)
 *   resolves per the level closer to that candle's open - and the vendored walkOutcome
 *   stays conservative (always stop-first) on the identical fixture.
 * Section 2: unambiguous bars (only one of stop/target ever touched, or neither) produce
 *   byte-identical results between the vendored walkOutcome and walkOutcomeAdaptive, across
 *   not_filled / win / loss / open / prefilled cases.
 * Section 3: the holdRule (structure-exit) adaptive variant mirrors the same ambiguity rule
 *   without disturbing the structure-exit boundary check.
 * Section 4: summarizeAmbiguity() over a hand-built docs/swing-shaped rule document.
 *
 * Run: node test-adaptive-walk.js
 */

import { walkOutcome } from './scripts/tracker/walk-outcome.js';
import {
  walkOutcomeAdaptive, scoreSignalWithHoldRuleAdaptive, rescoreAmbiguousSignal, summarizeAmbiguity
} from './scripts/research/harness/adaptive-walk.js';

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

function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}: expected ${e}, got ${a}`);
}

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60000;
function candle(i, { open, high, low, close }) {
  return { timestamp: T0 + i * MIN, open, high, low, close };
}

async function run() {
  console.log('\nscripts/research/harness/adaptive-walk.js\n');

  console.log('1) synthetic ambiguous bar resolves per the level closer to open\n');

  await test('ambiguous bar, target closer to open -> adaptive wins, conservative still loses', () => {
    // long: entry 100, stop 95, target 110. Fill on candle 0 (touches 100). Candle 1's
    // range [92,112] touches BOTH stop(95) and target(110); open=108 is closer to target
    // (|108-110|=2) than to stop (|108-95|=13).
    const candles1m = [
      candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
      candle(1, { open: 108, high: 112, low: 92, close: 105 })
    ];
    const params = {
      candles1m, fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100,
      stop: 95, target: 110, fillWindowCandles: 5, maxHoldCandles: 10
    };
    const conservative = walkOutcome(params);
    const adaptive = walkOutcomeAdaptive(params);
    assertEqual(conservative.status, 'loss', 'vendored walkOutcome always resolves stop-first');
    assertEqual(conservative.ambiguous, true, 'vendored flags the co-touch');
    assertEqual(adaptive.status, 'win', 'adaptive: target is closer to this candle\'s open');
    assertEqual(adaptive.adaptiveResolved, 'target');
    assert(Math.abs(adaptive.r - conservative.r) > 0.5, 'adaptive R should differ materially from the -1R conservative loss');
  });

  await test('ambiguous bar, stop closer to open -> both conservative and adaptive agree (loss)', () => {
    const candles1m = [
      candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
      candle(1, { open: 97, high: 112, low: 92, close: 105 }) // open=97 closer to stop(95) than target(110)
    ];
    const params = {
      candles1m, fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100,
      stop: 95, target: 110, fillWindowCandles: 5, maxHoldCandles: 10
    };
    const conservative = walkOutcome(params);
    const adaptive = walkOutcomeAdaptive(params);
    assertEqual(conservative.status, 'loss');
    assertEqual(adaptive.status, 'loss', 'stop is closer to open -> adaptive also resolves stop-first');
    assertEqual(adaptive.adaptiveResolved, 'stop');
  });

  await test('ambiguous bar, exact tie (equidistant) -> adaptive keeps the conservative default (stop)', () => {
    // open=102.5 is exactly halfway between stop(95, dist 7.5) and target(110, dist 7.5).
    const candles1m = [
      candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
      candle(1, { open: 102.5, high: 112, low: 92, close: 105 })
    ];
    const params = {
      candles1m, fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100,
      stop: 95, target: 110, fillWindowCandles: 5, maxHoldCandles: 10
    };
    const adaptive = walkOutcomeAdaptive(params);
    assertEqual(adaptive.status, 'loss', 'tie goes to the conservative default (stop first), mirroring Nautilus\'s strict "<" swap condition');
  });

  await test('short direction: ambiguous bar resolves symmetrically', () => {
    // short: entry 100, stop 105, target 90. Candle 1 range [88,107] touches both;
    // open=91 is closer to target(90) than stop(105).
    const candles1m = [
      candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
      candle(1, { open: 91, high: 107, low: 88, close: 95 })
    ];
    const params = {
      candles1m, fromMs: T0, direction: 'short', entryMin: 100, entryMax: 100,
      stop: 105, target: 90, fillWindowCandles: 5, maxHoldCandles: 10
    };
    const conservative = walkOutcome(params);
    const adaptive = walkOutcomeAdaptive(params);
    assertEqual(conservative.status, 'loss');
    assertEqual(adaptive.status, 'win');
    assertEqual(adaptive.adaptiveResolved, 'target');
  });

  console.log('\n2) unambiguous bars: adaptive is byte-identical to the vendored walkOutcome\n');

  const UNAMBIGUOUS_CASES = [
    {
      name: 'not_filled (price never reaches the entry zone)',
      candles1m: [candle(0, { open: 50, high: 51, low: 49, close: 50.5 }), candle(1, { open: 50.5, high: 52, low: 50, close: 51 })],
      params: { fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100, stop: 95, target: 110, fillWindowCandles: 2, maxHoldCandles: 10 }
    },
    {
      name: 'clean win (target touched alone, later candle)',
      candles1m: [
        candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
        candle(1, { open: 101, high: 103, low: 100, close: 102 }),
        candle(2, { open: 102, high: 111, low: 101, close: 110 })
      ],
      params: { fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100, stop: 95, target: 110, fillWindowCandles: 3, maxHoldCandles: 10 }
    },
    {
      name: 'clean loss (stop touched alone, target never in range that bar)',
      candles1m: [
        candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
        candle(1, { open: 100, high: 101, low: 94, close: 96 })
      ],
      params: { fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100, stop: 95, target: 110, fillWindowCandles: 2, maxHoldCandles: 10 }
    },
    {
      name: 'open (neither level ever touched within maxHoldCandles)',
      candles1m: [
        candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
        candle(1, { open: 100.5, high: 102, low: 100, close: 101 }),
        candle(2, { open: 101, high: 103, low: 100.5, close: 102 })
      ],
      params: { fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100, stop: 95, target: 110, fillWindowCandles: 3, maxHoldCandles: 3 }
    },
    {
      name: 'prefilled: target touch on the very first candle counts (no ambiguity - stop never in range)',
      candles1m: [candle(0, { open: 100, high: 111, low: 99.5, close: 105 })],
      params: { fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100, stop: 95, target: 110, fillWindowCandles: 3, maxHoldCandles: 5, prefilled: true }
    },
    {
      name: 'fill candle itself hits stop (never a creditable win there) - conservative either way, unaffected by adaptive ordering',
      candles1m: [candle(0, { open: 100, high: 100, low: 94, close: 96 })],
      params: { fromMs: T0, direction: 'long', entryMin: 100, entryMax: 100, stop: 95, target: 110, fillWindowCandles: 2, maxHoldCandles: 5 }
    },
    {
      name: 'short direction, clean loss',
      candles1m: [
        candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
        candle(1, { open: 100, high: 106, low: 99, close: 105 })
      ],
      params: { fromMs: T0, direction: 'short', entryMin: 100, entryMax: 100, stop: 105, target: 90, fillWindowCandles: 2, maxHoldCandles: 10 }
    }
  ];

  for (const { name, candles1m, params } of UNAMBIGUOUS_CASES) {
    await test(`unambiguous: ${name}`, () => {
      const conservative = walkOutcome({ candles1m, ...params });
      const adaptive = walkOutcomeAdaptive({ candles1m, ...params });
      assertDeepEqual(adaptive, conservative, 'adaptive must not diverge when no bar contains both levels');
    });
  }

  console.log('\n3) scoreSignalWithHoldRuleAdaptive: structure-exit path unaffected, ambiguity rule matches\n');

  await test('structure exit still fires when neither stop nor target is ambiguous', () => {
    const slice = [
      candle(0, { open: 100, high: 100.2, low: 99.8, close: 100 }),   // fill candle
      candle(1, { open: 100, high: 100.4, low: 99.6, close: 100.1 }), // inside flag [99,101], streak 1
      candle(2, { open: 100.1, high: 100.3, low: 99.9, close: 100.2 }) // streak 2 -> exit (n=2)
    ];
    const params = {
      slice, fromMs: T0, direction: 'long', entry: 100, stop: 90, target: 200,
      fillWindowCandles: 1, maxHoldCandles: 10,
      holdRule: { insideLow: 99, insideHigh: 101, n: 2, tfCandleMs: MIN }
    };
    const out = scoreSignalWithHoldRuleAdaptive(params);
    assertEqual(out.status, 'structure_exit');
  });

  await test('holdRule adaptive: ambiguous bar (stop+target both in range) flips to win when target is closer to open', () => {
    const slice = [
      candle(0, { open: 100, high: 100.2, low: 99.8, close: 100 }),
      candle(1, { open: 108, high: 112, low: 92, close: 105 }) // stop=95, target=110 both touched; open closer to target
    ];
    const params = {
      slice, fromMs: T0, direction: 'long', entry: 100, stop: 95, target: 110,
      fillWindowCandles: 1, maxHoldCandles: 10,
      holdRule: { insideLow: 0, insideHigh: 0, n: 999, tfCandleMs: MIN } // structure exit unreachable
    };
    const out = scoreSignalWithHoldRuleAdaptive(params);
    assertEqual(out.status, 'win');
    assertEqual(out.adaptiveResolved, 'target');
  });

  console.log('\n4) summarizeAmbiguity / rescoreAmbiguousSignal\n');

  await test('summarizeAmbiguity counts ambiguous===true losses only, per rule', () => {
    const ruleJson = {
      meta: { id: 'fixture-rule' },
      combined: { stats: { netExpR: 0.5, netExpR_sens020: 0.4 } },
      perSymbol: {
        BTC: { signals: [
          { outcome: { status: 'win', r: 2 } },
          { outcome: { status: 'loss', ambiguous: false } },
          { outcome: { status: 'loss', ambiguous: true } }
        ] },
        ETH: { signals: [
          { outcome: { status: 'loss', ambiguous: true } },
          { outcome: { status: 'not_filled' } }
        ] }
      }
    };
    const s = summarizeAmbiguity(ruleJson);
    assertEqual(s.n, 5);
    assertEqual(s.lossCount, 3);
    assertEqual(s.ambiguousCount, 2);
    assertEqual(s.ambiguityRatePctOfN, 40);
    assertEqual(s.ambiguityRatePctOfLosses, Math.round((2 / 3) * 100000) / 1000);
  });

  await test('summarizeAmbiguity: zero ambiguous signals -> 0% both rates (the real docs/swing corpus\'s actual shape)', () => {
    const ruleJson = {
      meta: { id: 'fixture-clean' },
      combined: { stats: { netExpR: 0.27, netExpR_sens020: 0.30 } },
      perSymbol: { BTC: { signals: [{ outcome: { status: 'loss', ambiguous: false } }, { outcome: { status: 'win', r: 1 } }] } }
    };
    const s = summarizeAmbiguity(ruleJson);
    assertEqual(s.ambiguousCount, 0);
    assertEqual(s.ambiguityRatePctOfN, 0);
    assertEqual(s.ambiguityRatePctOfLosses, 0);
  });

  await test('rescoreAmbiguousSignal: no-op (null) for any non-ambiguous recorded outcome', () => {
    assertEqual(rescoreAmbiguousSignal({ outcome: { status: 'win', r: 1 } }, [], 60), null);
    assertEqual(rescoreAmbiguousSignal({ outcome: { status: 'loss', ambiguous: false } }, [], 60), null);
    assertEqual(rescoreAmbiguousSignal({ outcome: { status: 'not_filled' } }, [], 60), null);
  });

  await test('rescoreAmbiguousSignal: re-locates the resolving candle and flips it when ambiguous===true', () => {
    const candles1m = [
      candle(0, { open: 100, high: 101, low: 99, close: 100.5 }),
      candle(1, { open: 108, high: 112, low: 92, close: 105 })
    ];
    const signal = {
      closedThrough: new Date(T0).toISOString(),
      direction: 'long', entry: 100, stop: 95, tp1: 110,
      outcome: { status: 'loss', r: -1, holdCandles: 2, ambiguous: true }
    };
    const result = rescoreAmbiguousSignal(signal, candles1m, 5);
    assert(result !== null);
    assertEqual(result.conservative.status, 'loss');
    assertEqual(result.adaptive.status, 'win');
    assertEqual(result.flipped, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
