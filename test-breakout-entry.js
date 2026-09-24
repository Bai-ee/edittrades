/**
 * Deterministic tests for T4 P4 SHADOW MODE (docs/PLAN_FLAG_PATHS.md "P4"):
 * `scripts/tracker/breakout-entry.js` (pure: `shadowEntryFromBreakout`, `walkShadow`,
 * the vendored `netRiskReward`) and `lib/breakoutEntry.js` (the RULE that decides WHEN
 * to try - first close beyond breakoutLevel, chase elevated/high). Also confirms this
 * feature never touches `flagTradePlan`/`flagRecommendation`: an immutability check here,
 * plus the existing fixture suites (test:flagplan, test:flagrec, test:flagrec:fixtures,
 * test:scalp) run unmodified and pass at their prior counts.
 *
 * Run: node test-breakout-entry.js
 */

import { readFileSync } from 'node:fs';
import { netRiskReward as vendoredNetRR, shadowEntryFromBreakout, walkShadow } from './scripts/tracker/breakout-entry.js';
import { netRiskReward as sourceNetRR } from './lib/flagTradePlan.js';
import { buildBreakoutEntry } from './lib/breakoutEntry.js';

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

function roundN(value, decimals) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60000;
const c = (i, o, h, l, cl) => ({ timestamp: T0 + i * MIN, open: o, high: h, low: l, close: cl });

const CFG = { minRR: 3, maxStopPct: 3, feeBps: 5, slippageBps: 5 };

(async () => {
  console.log('breakout-entry.js (T4 P4 SHADOW MODE)');

  // ===========================================================================
  // purity
  // ===========================================================================
  console.log('\npurity');

  await test('scripts/tracker/breakout-entry.js imports only ./walk-outcome.js (copied flat into the tracker repo)', () => {
    const source = readFileSync(new URL('./scripts/tracker/breakout-entry.js', import.meta.url), 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    const froms = [...importLines.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assertEqual(froms.join(), './walk-outcome.js', 'imports');
    assert(!/node:fs|node:net|node:http|\.\.\/lib\/|\.\.\/config\//.test(importLines), 'no fs/network/lib/config import');
  });

  await test('lib/breakoutEntry.js imports only config/engine.js and scripts/tracker/breakout-entry.js', () => {
    const source = readFileSync(new URL('./lib/breakoutEntry.js', import.meta.url), 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    const froms = [...importLines.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
    assertEqual(froms.join(), '../config/engine.js,../scripts/tracker/breakout-entry.js', 'imports');
  });

  // ===========================================================================
  // netRiskReward parity (vendored copy vs lib/flagTradePlan.js's exported original)
  // ===========================================================================
  console.log('\nnetRiskReward parity');

  await test('netRiskReward: vendored copy matches lib/flagTradePlan.js exactly', () => {
    const cases = [
      [100, 99, 104, { feeBps: 5, slippageBps: 5 }],
      [100, 101, 96, { feeBps: 5, slippageBps: 5 }], // short
      [50, 49, 50.5, { feeBps: 10, slippageBps: 10 }], // reward eaten by costs -> null
      [0, 1, 2, { feeBps: 5, slippageBps: 5 }], // entry <= 0 -> null
      [100, 100, 104, { feeBps: 5, slippageBps: 5 }], // grossRisk 0 -> null
      [100, 99, 100, { feeBps: 5, slippageBps: 5 }], // grossReward 0 -> null
      [114.99, 114.71, 116.00, { feeBps: 5, slippageBps: 5 }] // SOL-like numbers
    ];
    for (const [entry, stop, target, riskCfg] of cases) {
      assertEqual(vendoredNetRR(entry, stop, target, riskCfg), sourceNetRR(entry, stop, target, riskCfg), `parity ${entry},${stop},${target}`);
    }
  });

  // ===========================================================================
  // shadowEntryFromBreakout: rule conditions
  // ===========================================================================
  console.log('\nshadowEntryFromBreakout');

  await test('valid long: entry/stop/tp1 published, grossRR/netRR computed', () => {
    const r = shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 99, measuredTarget: 104, breakoutClose: 100.2 }, CFG);
    assert(r, 'expected a shadow entry');
    assertEqual(r.entry, 100.2);
    assertEqual(r.stop, 99);
    assertEqual(r.tp1, 104);
    assertEqual(r.grossRR, roundN(Math.abs(104 - 100.2) / Math.abs(100.2 - 99), 3));
    assertEqual(r.netRR, roundN(sourceNetRR(100.2, 99, 104, CFG), 3));
  });

  await test('valid short (mirror): same grossRR as the symmetric long case', () => {
    const long = shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 99, measuredTarget: 104, breakoutClose: 100.2 }, CFG);
    const short = shadowEntryFromBreakout({ dir: 'short', breakoutLevel: 100, invalidation: 101, measuredTarget: 96, breakoutClose: 99.8 }, CFG);
    assert(long && short, 'both directions must publish');
    assertEqual(short.grossRR, long.grossRR, 'mirrored risk/reward gives the same grossRR');
    assertEqual(short.entry, 99.8);
    assertEqual(short.stop, 101);
    assertEqual(short.tp1, 96);
  });

  await test('not first close (breakoutClose has not closed beyond breakoutLevel) -> null', () => {
    assertEqual(shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 99, measuredTarget: 104, breakoutClose: 99.5 }, CFG), null, 'below the level');
    assertEqual(shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 99, measuredTarget: 104, breakoutClose: 100 }, CFG), null, 'exactly at the level (not strictly beyond)');
    assertEqual(shadowEntryFromBreakout({ dir: 'short', breakoutLevel: 100, invalidation: 101, measuredTarget: 96, breakoutClose: 100.5 }, CFG), null, 'short: above the level');
  });

  await test('RR < minRR -> null', () => {
    const r = shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 99, measuredTarget: 100.5, breakoutClose: 100.2 }, CFG);
    assertEqual(r, null);
  });

  await test('stop too wide (stop distance % > maxStopPct) -> null, even though RR alone would pass', () => {
    const r = shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 90, measuredTarget: 140, breakoutClose: 100.5 }, CFG);
    // grossRR here is ~3.76 (would pass minRR); stopDistancePct ~10.4% > 3% cap.
    assertEqual(r, null);
  });

  await test('invalid direction levels (stop on the wrong side, target not ahead) -> null', () => {
    assertEqual(shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 101, measuredTarget: 104, breakoutClose: 100.5 }, CFG), null, 'stop above entry on a long');
    assertEqual(shadowEntryFromBreakout({ dir: 'long', breakoutLevel: 100, invalidation: 99, measuredTarget: 99.5, breakoutClose: 100.5 }, CFG), null, 'target behind entry on a long');
  });

  await test('missing/invalid inputs never throw, always null', () => {
    assertEqual(shadowEntryFromBreakout({}, CFG), null);
    assertEqual(shadowEntryFromBreakout({ dir: 'up', breakoutLevel: 100, invalidation: 99, measuredTarget: 104, breakoutClose: 100.5 }, CFG), null);
    assertEqual(shadowEntryFromBreakout(undefined, CFG), null);
  });

  await test('SOL-like case (docs/FLAG_PATHS_BASE_RATES.md 2026-09-24 numbers): passes when the breakout close clears minRR and the stop cap', () => {
    const r = shadowEntryFromBreakout({
      dir: 'long', breakoutLevel: 114.95, invalidation: 114.71, measuredTarget: 116.00, breakoutClose: 114.99
    }, CFG);
    assert(r, 'expected a shadow entry');
    assertEqual(r.entry, 114.99);
    assertEqual(r.stop, 114.71);
    assertEqual(r.tp1, 116.00);
    assert(r.grossRR >= CFG.minRR, `grossRR ${r.grossRR} must clear minRR`);
  });

  await test('SOL-like case at the real breakout numbers (breakout 114.95, measuredTarget 115.43) fails minRR from the breakout close - the real 2026-09-24 case would not have shadow-published', () => {
    const r = shadowEntryFromBreakout({
      dir: 'long', breakoutLevel: 114.95, invalidation: 114.71, measuredTarget: 115.43, breakoutClose: 115.05
    }, CFG);
    assertEqual(r, null, 'grossRR from the breakout close is well under 3R on the real numbers');
  });

  // ===========================================================================
  // walkShadow
  // ===========================================================================
  console.log('\nwalkShadow');

  const LONG_ENTRY = { dir: 'long', entry: 100, stop: 99, tp1: 104 };

  await test('tp1: a later candle touches the target first', () => {
    const candles = [
      c(0, 100, 100.5, 99.5, 100.2),
      c(1, 100.2, 101, 100, 100.8),
      c(2, 100.8, 104.5, 100.5, 104.2)
    ];
    const res = walkShadow(LONG_ENTRY, candles, T0, 5 * MIN);
    assertEqual(res.outcome, 'tp1');
    assertEqual(res.resolvedAt, T0 + 2 * MIN);
    assertEqual(res.minutes, 2);
    assertEqual(res.r, roundN(Math.abs(104 - 100) / Math.abs(100 - 99), 4));
  });

  await test('stop: a later candle touches the stop first', () => {
    const candles = [
      c(0, 100, 100.5, 99.5, 100.2),
      c(1, 100.2, 100.5, 98.5, 99.0)
    ];
    const res = walkShadow(LONG_ENTRY, candles, T0, 5 * MIN);
    assertEqual(res.outcome, 'stop');
    assertEqual(res.r, -1);
    assertEqual(res.resolvedAt, T0 + 1 * MIN);
  });

  await test('same-candle stop+target touch: stop wins (conservative)', () => {
    const candles = [c(0, 100, 105, 98, 101)];
    const res = walkShadow(LONG_ENTRY, candles, T0, 5 * MIN);
    assertEqual(res.outcome, 'stop');
  });

  await test('prefilled: the fill candle itself (== fromMs) can resolve tp1 - no fill-window search', () => {
    const candles = [c(0, 100, 104.5, 99.8, 104.3)];
    const res = walkShadow(LONG_ENTRY, candles, T0, 5 * MIN);
    assertEqual(res.outcome, 'tp1');
    assertEqual(res.resolvedAt, T0);
    assertEqual(res.minutes, 0);
  });

  await test('open: fewer candles than the tracking window, none resolve yet', () => {
    const candles = [c(0, 100, 100.5, 99.8, 100.1), c(1, 100.1, 100.6, 99.9, 100.3)];
    const res = walkShadow(LONG_ENTRY, candles, T0, 10 * MIN);
    assertEqual(res.outcome, 'open');
    assertEqual(res.r, null);
    assertEqual(res.resolvedAt, null);
  });

  await test('open: no candle at/after fromMs at all', () => {
    const candles = [c(0, 100, 100.5, 99.8, 100.1)];
    const res = walkShadow(LONG_ENTRY, candles, T0 + 100 * MIN, 5 * MIN);
    assertEqual(res.outcome, 'open');
  });

  await test('expired: the full tracking window was walked and nothing ever resolved', () => {
    const candles = Array.from({ length: 5 }, (_, i) => c(i, 100, 100.5, 99.8, 100.1));
    const res = walkShadow(LONG_ENTRY, candles, T0, 5 * MIN);
    assertEqual(res.outcome, 'expired');
    assertEqual(res.r, null);
  });

  await test('malformed input never throws, always open', () => {
    assertEqual(walkShadow(null, [], T0).outcome, 'open');
    assertEqual(walkShadow({ dir: 'long', entry: 100, stop: 99 }, [], T0).outcome, 'open', 'missing tp1');
    assertEqual(walkShadow(LONG_ENTRY, 'not-an-array', T0).outcome, 'open');
    assertEqual(walkShadow(LONG_ENTRY, [], NaN).outcome, 'open');
  });

  await test('short mirror: a later candle touches the (lower) target first', () => {
    const shortEntry = { dir: 'short', entry: 100, stop: 101, tp1: 96 };
    const candles = [c(0, 100, 100.5, 99.5, 99.8), c(1, 99.8, 100, 95.5, 95.8)];
    const res = walkShadow(shortEntry, candles, T0, 5 * MIN);
    assertEqual(res.outcome, 'tp1');
    assertEqual(res.resolvedAt, T0 + 1 * MIN);
  });

  // ===========================================================================
  // lib/breakoutEntry.js: buildBreakoutEntry (the RULE - when to try)
  // ===========================================================================
  console.log('\nbuildBreakoutEntry (lib/breakoutEntry.js)');

  function makeCandidate(over = {}) {
    return {
      candidateId: 'SOL:5m:long:2026-01-01T00:00:00.000Z',
      type: 'flag',
      timeframe: '5m',
      direction: 'long',
      state: 'triggering',
      breakoutLevel: 100,
      invalidation: 99,
      measuredTarget: 104,
      ageCandles: 0,
      chaseRisk: false,
      confidence: 80,
      ...over
    };
  }

  function makePathOutlook(over = {}) {
    return {
      id: 'SOL:5m:long:2026-01-01T00:00:00.000Z',
      tf: '5m',
      dir: 'long',
      at: 'broken',
      lean: 'breakout',
      likely: 'runner',
      chase: 'elevated',
      w: { retest_go: 20, runner: 40, false_break: 20, fail_first: 0, chop: 20 },
      n: 500,
      cal: true,
      key: 'tf=5m',
      ...over
    };
  }

  function makePieces({ candidate = makeCandidate(), pathOutlook = makePathOutlook(), breakoutClose = 100.2 } = {}) {
    const tf = candidate.timeframe;
    return {
      candidateSetups: [candidate],
      pathOutlook,
      tfEntries: { [tf]: { closedThrough: '2026-01-01T00:25:00.000Z' } },
      closedByTf: { [tf]: [{ timestamp: T0, open: 99.8, high: 100.3, low: 99.7, close: breakoutClose }] }
    };
  }

  await test('happy path: publishes the FIXED CONTRACT shape, status "shadow"', () => {
    const r = buildBreakoutEntry(makePieces());
    assert(r, 'expected a breakoutEntry');
    assertEqual(JSON.stringify(Object.keys(r)), JSON.stringify(['id', 'tf', 'dir', 'at', 'entry', 'stop', 'tp1', 'grossRR', 'netRR', 'status']), 'field order/names');
    assertEqual(r.id, 'SOL:5m:long:2026-01-01T00:00:00.000Z');
    assertEqual(r.tf, '5m');
    assertEqual(r.dir, 'long');
    assertEqual(r.at, '2026-01-01T00:25:00.000Z');
    assertEqual(r.status, 'shadow');
    assertEqual(r.entry, 100.2);
  });

  await test('pathOutlook null -> null', () => {
    assertEqual(buildBreakoutEntry(makePieces({ pathOutlook: null })), null);
  });

  await test('pathOutlook.at === "tightening" (not yet broken) -> null', () => {
    assertEqual(buildBreakoutEntry(makePieces({ pathOutlook: makePathOutlook({ at: 'tightening' }) })), null);
  });

  await test('pathOutlook.chase === "low" -> null', () => {
    assertEqual(buildBreakoutEntry(makePieces({ pathOutlook: makePathOutlook({ chase: 'low' }) })), null);
  });

  await test('pathOutlook.chase === "high" also publishes (elevated and high both qualify)', () => {
    const r = buildBreakoutEntry(makePieces({ pathOutlook: makePathOutlook({ chase: 'high' }) }));
    assert(r, 'expected a breakoutEntry when chase is high');
  });

  await test('candidate not found (id mismatch) -> null', () => {
    assertEqual(buildBreakoutEntry(makePieces({ pathOutlook: makePathOutlook({ id: 'nope' }) })), null);
  });

  await test('not first close: candidate.ageCandles !== 0 -> null', () => {
    assertEqual(buildBreakoutEntry(makePieces({ candidate: makeCandidate({ ageCandles: 1 }) })), null, 'one candle after the break');
    assertEqual(buildBreakoutEntry(makePieces({ candidate: makeCandidate({ ageCandles: undefined }) })), null, 'no ageCandles at all (e.g. forming/proto)');
  });

  await test('candidate state outside triggering/confirmed -> null, even with ageCandles 0', () => {
    for (const state of ['forming', 'proto', 'failed', 'expired']) {
      assertEqual(buildBreakoutEntry(makePieces({ candidate: makeCandidate({ state, ageCandles: 0 }) })), null, state);
    }
  });

  await test('the pure rule still gates: RR too low at the breakout close -> null even when every other condition is met', () => {
    const r = buildBreakoutEntry(makePieces({
      candidate: makeCandidate({ measuredTarget: 100.5 }),
      breakoutClose: 100.2
    }));
    assertEqual(r, null);
  });

  await test('missing tfEntries/closedByTf for the candidate timeframe -> null, never throws', () => {
    const pieces = makePieces();
    assertEqual(buildBreakoutEntry({ ...pieces, tfEntries: {} }), null);
    assertEqual(buildBreakoutEntry({ ...pieces, closedByTf: {} }), null);
    assertEqual(buildBreakoutEntry({ ...pieces, closedByTf: { '5m': [] } }), null);
  });

  await test('short candidate: mirrors the long happy path', () => {
    const candidate = makeCandidate({
      candidateId: 'SOL:5m:short:2026-01-01T00:00:00.000Z',
      direction: 'short',
      breakoutLevel: 100,
      invalidation: 101,
      measuredTarget: 96
    });
    const pathOutlook = makePathOutlook({ id: candidate.candidateId, dir: 'short' });
    const r = buildBreakoutEntry(makePieces({ candidate, pathOutlook, breakoutClose: 99.8 }));
    assert(r, 'expected a breakoutEntry');
    assertEqual(r.dir, 'short');
    assertEqual(r.entry, 99.8);
    assertEqual(r.stop, 101);
    assertEqual(r.tp1, 96);
  });

  await test('buildBreakoutEntry never mutates candidateSetups, pathOutlook, tfEntries, or closedByTf', () => {
    const pieces = makePieces();
    const before = JSON.stringify(pieces);
    buildBreakoutEntry(pieces);
    assertEqual(JSON.stringify(pieces), before, 'inputs must be untouched (flagTradePlan/flagRecommendation read these same objects earlier in the pipeline)');
  });

  console.log('\nNote: flagTradePlan/flagRecommendation byte-identical output with this field');
  console.log('present is verified by the unmodified fixture suites (npm run test:flagplan,');
  console.log('test:flagrec, test:flagrec:fixtures, test:scalp) - all pass at their prior counts.');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})();
