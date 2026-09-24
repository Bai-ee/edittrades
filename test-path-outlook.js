/**
 * Deterministic tests for lib/pathOutlook.js (T4 P1, docs/PLAN_FLAG_PATHS.md "P1 -
 * pathOutlook in the payload"): candidate selection precedence, backoff key resolution,
 * tightening vs broken table choice, lean/likely/chase rules, null cases, the SOL-shaped
 * case against the real measured table in config/engine.json, and purity (this module
 * imports only config/engine.js and scripts/tracker/flag-paths.js).
 *
 * Run: node test-path-outlook.js
 */

import { readFileSync } from 'node:fs';
import { buildPathOutlook, pickCandidate } from './lib/pathOutlook.js';
import { ENGINE_CONFIG } from './config/engine.js';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(over = {}) {
  return {
    candidateId: over.candidateId || 'BTC:5m:long:2026-01-01T00:00:00.000Z',
    type: 'flag',
    timeframe: '5m',
    direction: 'long',
    state: 'proto',
    compressionScore: 0.8, // tight
    durationCandles: 0,
    impulseStrength: 3,
    breakoutLevel: 100,
    invalidation: 99,
    measuredTarget: 103,
    ema200Side: 'above',
    chaseRisk: false,
    confidence: 80,
    firstDetectedAt: '2026-01-01T00:00:00.000Z',
    ...over
  };
}

function makePieces(candidates, over = {}) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const tf = list[0] ? list[0].timeframe : '5m';
  return {
    candidateSetups: list,
    flagRecommendation: null,
    flagTradePlan: null,
    geometryContext: {},
    tfEntries: { [tf]: { stochRsi: {} } },
    closedByTf: { [tf]: [] },
    marketByTf: { [tf]: { atr: 1 } },
    topDown: null,
    ...over
  };
}

/** `w` with every PATHS key defaulted to 0. */
function weights(over = {}) {
  return { retest_go: 0, runner: 0, false_break: 0, fail_first: 0, chop: 0, ...over };
}

/** A synthetic `pathOutlook` config: `table.tightening`/`table.broken` are `{key: {n, w}}` maps. */
function makeCfg({ tightening = {}, broken = {}, minN = 100, keys } = {}) {
  return { pathOutlook: { minN, keys, tightening, broken } };
}

(async () => {
  console.log('pathOutlook.js (T4 P1)');

  // -------------------------------------------------------------------------
  console.log('\ncandidate selection precedence (pickCandidate)');
  // -------------------------------------------------------------------------

  await test('flagRecommendation.candidateId wins over a higher-ranked nearest-live candidate', () => {
    const c1 = makeCandidate({ candidateId: 'A', state: 'forming', timeframe: '1m' });
    const c2 = makeCandidate({ candidateId: 'B', state: 'triggering', timeframe: '5m' });
    const picked = pickCandidate({ candidateSetups: [c1, c2], flagRecommendation: { candidateId: 'A' }, flagTradePlan: null });
    assertEqual(picked.candidateId, 'A', 'flagRecommendation id is authoritative even though B ranks higher on state');
  });

  await test('falls to flagTradePlan.candidateId when flagRecommendation id is missing/dead', () => {
    const c1 = makeCandidate({ candidateId: 'A', state: 'forming' });
    const picked = pickCandidate({ candidateSetups: [c1], flagRecommendation: { candidateId: 'NOT_FOUND' }, flagTradePlan: { candidateId: 'A' } });
    assertEqual(picked.candidateId, 'A', 'flagTradePlan id used once flagRecommendation id does not resolve');
  });

  await test('falls to the nearest live candidate when neither id is set: triggering beats forming', () => {
    const forming = makeCandidate({ candidateId: 'F', state: 'forming', timeframe: '1m', confidence: 99 });
    const triggering = makeCandidate({ candidateId: 'T', state: 'triggering', timeframe: '5m', confidence: 1 });
    const picked = pickCandidate({ candidateSetups: [forming, triggering], flagRecommendation: null, flagTradePlan: null });
    assertEqual(picked.candidateId, 'T', 'triggering outranks forming regardless of confidence');
  });

  await test('nearest-live tie-break: same state and confidence -> smaller timeframe wins', () => {
    const a = makeCandidate({ candidateId: 'A5', state: 'proto', timeframe: '5m', confidence: 50 });
    const b = makeCandidate({ candidateId: 'B1', state: 'proto', timeframe: '1m', confidence: 50 });
    const picked = pickCandidate({ candidateSetups: [a, b], flagRecommendation: null, flagTradePlan: null });
    assertEqual(picked.candidateId, 'B1', '1m ranks ahead of 5m at equal state/confidence');
  });

  await test('a failed candidate is never picked, by id or by fallback', () => {
    const failed = makeCandidate({ candidateId: 'X', state: 'failed' });
    const picked = pickCandidate({ candidateSetups: [failed], flagRecommendation: { candidateId: 'X' }, flagTradePlan: { candidateId: 'X' } });
    assertEqual(picked, null, 'a failed-state hit is treated as not-found');
  });

  // -------------------------------------------------------------------------
  console.log('\nbackoff key resolution');
  // -------------------------------------------------------------------------
  // Fixed candidate shape (tf=5m, compression=tight, structureSteps=unknown [duration 0
  // -> flagCandles.length<2], roomR=unknown [no geometryContext zones]) reused across
  // every backoff scenario below - only the synthetic table's stored keys change.

  await test('exact 4-feature key is used when the table stores it', () => {
    const key = 'tf=5m|structureSteps=unknown|roomR=unknown|compression=tight';
    const cfg = makeCfg({ tightening: { [key]: { n: 150, w: weights({ retest_go: 40, chop: 60 }) }, all: { n: 1000, w: weights({ chop: 100 }) } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.key, key, 'full-depth key chosen');
    assertEqual(out.n, 150, 'n from the matched bucket');
    assertEqual(out.cal, true, 'n >= minN');
  });

  await test('drops the last feature (compression) when the full key is not stored', () => {
    const key3 = 'tf=5m|structureSteps=unknown|roomR=unknown';
    const cfg = makeCfg({ tightening: { [key3]: { n: 120, w: weights({ runner: 100 }) }, all: { n: 1000, w: weights({ chop: 100 }) } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.key, key3, 'backed off to the 3-feature key');
  });

  await test('backs off all the way to tf=<tf> alone', () => {
    const cfg = makeCfg({ tightening: { 'tf=5m': { n: 300, w: weights({ false_break: 100 }) }, all: { n: 1000, w: weights({ chop: 100 }) } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.key, 'tf=5m', 'backed off to the tf-only key');
  });

  await test("backs off to the literal 'all' fallback when nothing else is stored", () => {
    const cfg = makeCfg({ tightening: { all: { n: 42, w: weights({ chop: 100 }) } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.key, 'all', 'fell back to all');
    assertEqual(out.cal, false, "n (42) < minN (100) -> not calibrated, even though 'all' is always stored");
  });

  // -------------------------------------------------------------------------
  console.log('\ntightening vs broken table choice (at)');
  // -------------------------------------------------------------------------

  await test('forming/proto -> tightening table, at:"tightening"', () => {
    for (const state of ['forming', 'proto']) {
      const cfg = makeCfg({ tightening: { all: { n: 500, w: weights({ retest_go: 100 }) } }, broken: { all: { n: 500, w: weights({ runner: 100 }) } } });
      const out = buildPathOutlook(makePieces(makeCandidate({ state })), cfg);
      assertEqual(out.at, 'tightening', `${state} -> tightening`);
      assertEqual(out.likely, 'retest_go', `${state} reads the tightening table, not broken`);
    }
  });

  await test('triggering/confirmed -> broken table, at:"broken", fail_first forced to 0', () => {
    for (const state of ['triggering', 'confirmed']) {
      // Malformed fixture on purpose: a nonzero fail_first in a broken bucket must never
      // survive - fail_first cannot happen after a breakout close (docs/PLAN_FLAG_PATHS.md).
      const cfg = makeCfg({
        tightening: { all: { n: 500, w: weights({ fail_first: 100 }) } },
        broken: { all: { n: 500, w: weights({ runner: 60, fail_first: 40 }) } }
      });
      const out = buildPathOutlook(makePieces(makeCandidate({ state, chaseRisk: false })), cfg);
      assertEqual(out.at, 'broken', `${state} -> broken`);
      assertEqual(out.w.fail_first, 0, `${state}: fail_first is forced to 0 on the broken table`);
      assertEqual(out.likely, 'runner', `${state} reads the broken table, not tightening`);
    }
  });

  // -------------------------------------------------------------------------
  console.log('\nlean / likely / chase rules');
  // -------------------------------------------------------------------------

  await test('lean "even" within the 5-point band', () => {
    // breakoutScore = 20+20=40, failureScore = 20+15=35, diff=5 (== band edge, still even)
    const w = weights({ retest_go: 20, runner: 20, false_break: 20, fail_first: 15, chop: 25 });
    const cfg = makeCfg({ tightening: { all: { n: 200, w } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.lean, 'even', 'diff of exactly 5 stays within the even band');
  });

  await test('lean "breakout" when retest_go+runner clearly leads', () => {
    const w = weights({ retest_go: 40, runner: 20, false_break: 10, fail_first: 10, chop: 20 });
    const cfg = makeCfg({ tightening: { all: { n: 200, w } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.lean, 'breakout', 'retest_go+runner (60) clearly beats false_break+fail_first (20)');
  });

  await test('lean "failure" when false_break+fail_first clearly leads', () => {
    const w = weights({ retest_go: 5, runner: 5, false_break: 40, fail_first: 40, chop: 10 });
    const cfg = makeCfg({ tightening: { all: { n: 200, w } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.lean, 'failure', 'false_break+fail_first (80) clearly beats retest_go+runner (10)');
  });

  await test('likely picks the strict-max path, first-listed wins a tie', () => {
    // retest_go and runner tie at 30; retest_go is listed first in PATHS order.
    const w = weights({ retest_go: 30, runner: 30, false_break: 20, fail_first: 10, chop: 10 });
    const cfg = makeCfg({ tightening: { all: { n: 200, w } } });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out.likely, 'retest_go', 'tie broken by PATHS order');
  });

  await test('chase "high": runner >= retest_go * 1.2', () => {
    const w = weights({ retest_go: 10, runner: 15, false_break: 5, fail_first: 5, chop: 65 }); // 15 >= 12
    const cfg = makeCfg({ tightening: { all: { n: 200, w } } });
    const out = buildPathOutlook(makePieces(makeCandidate({ chaseRisk: false })), cfg);
    assertEqual(out.chase, 'high', 'runner dominates retest_go by >= 1.2x');
  });

  await test('chase "high": candidate.chaseRisk true overrides a low runner share', () => {
    const w = weights({ retest_go: 30, runner: 5, false_break: 5, fail_first: 5, chop: 55 }); // 5 < 36, not ratio-dominant
    const cfg = makeCfg({ tightening: { all: { n: 200, w } } });
    const out = buildPathOutlook(makePieces(makeCandidate({ chaseRisk: true })), cfg);
    assertEqual(out.chase, 'high', 'candidate.chaseRisk alone forces high');
  });

  await test('chase "elevated": runner share above the table-wide baseline, not ratio-dominant, not chaseRisk', () => {
    const cfg = makeCfg({
      tightening: {
        all: { n: 1000, w: weights({ retest_go: 20, runner: 10, chop: 70 }) }, // baseline runner 10
        'tf=5m': { n: 200, w: weights({ retest_go: 30, runner: 20, chop: 50 }) } // 20 < 30*1.2=36 (not ratio), 20 > 10 (baseline)
      }
    });
    const out = buildPathOutlook(makePieces(makeCandidate({ chaseRisk: false })), cfg);
    assertEqual(out.key, 'tf=5m', 'sanity: resolved the intended bucket');
    assertEqual(out.chase, 'elevated', 'runner (20) above baseline (10), not ratio-dominant, not flagged');
  });

  await test('chase "low": runner at or below the table-wide baseline', () => {
    const cfg = makeCfg({
      tightening: {
        all: { n: 1000, w: weights({ retest_go: 20, runner: 20, chop: 60 }) }, // baseline runner 20
        'tf=5m': { n: 200, w: weights({ retest_go: 50, runner: 5, chop: 45 }) }
      }
    });
    const out = buildPathOutlook(makePieces(makeCandidate({ chaseRisk: false })), cfg);
    assertEqual(out.chase, 'low', 'runner (5) at/below baseline (20), no override');
  });

  await test('chase ratio guard: retest_go 0 does not trivially force high at runner 0', () => {
    const w = weights({ retest_go: 0, runner: 0, false_break: 0, fail_first: 0, chop: 100 });
    const cfg = makeCfg({ tightening: { all: { n: 200, w } } });
    const out = buildPathOutlook(makePieces(makeCandidate({ chaseRisk: false })), cfg);
    assertEqual(out.chase, 'low', 'both zero is not a chase signal');
  });

  // -------------------------------------------------------------------------
  console.log('\nnull cases');
  // -------------------------------------------------------------------------

  await test('null: no candidates at all', () => {
    const cfg = makeCfg({ tightening: { all: { n: 200, w: weights({ chop: 100 }) } } });
    const out = buildPathOutlook(makePieces([]), cfg);
    assertEqual(out, null);
  });

  await test('null: ids point nowhere and no other live candidate exists', () => {
    const cfg = makeCfg({ tightening: { all: { n: 200, w: weights({ chop: 100 }) } } });
    const out = buildPathOutlook(makePieces([], { flagRecommendation: { candidateId: 'NOPE' }, flagTradePlan: { candidateId: 'ALSO_NOPE' } }), cfg);
    assertEqual(out, null);
  });

  await test('null: a live candidate exists but cfg carries no pathOutlook table at all', () => {
    const out = buildPathOutlook(makePieces(makeCandidate()), {});
    assertEqual(out, null);
  });

  await test("null: a live candidate exists but the relevant table has no 'all' and no matching bucket", () => {
    const cfg = makeCfg({ tightening: {} });
    const out = buildPathOutlook(makePieces(makeCandidate()), cfg);
    assertEqual(out, null);
  });

  await test('does not throw on a missing pieces object', () => {
    const cfg = makeCfg({ tightening: { all: { n: 200, w: weights({ chop: 100 }) } } });
    const out = buildPathOutlook(undefined, cfg);
    assertEqual(out, null);
  });

  // -------------------------------------------------------------------------
  console.log('\nSOL-shaped case against the real measured table (config/engine.json)');
  // -------------------------------------------------------------------------

  await test('SOL 2026-09-24 04:35Z shape (5m long, tight compression, level tested once, room moderate) reads elevated or high chase', () => {
    assert(ENGINE_CONFIG.pathOutlook && ENGINE_CONFIG.pathOutlook.tightening, 'config/engine.json carries a built pathOutlook.tightening table');
    const candidate = makeCandidate({
      candidateId: 'SOL:5m:long:2026-09-24T02:55:00.000Z',
      timeframe: '5m',
      direction: 'long',
      state: 'proto',
      compressionScore: 0.77, // tight (edges [0.5, 0.75])
      durationCandles: 0, // flagLen 1 -> flagCandles too short -> structureSteps unknown
      impulseStrength: 2.17,
      breakoutLevel: 114.93,
      invalidation: 114.71,
      measuredTarget: 115.45,
      ema200Side: 'below',
      chaseRisk: false,
      firstDetectedAt: '2026-09-24T04:35:00.000Z'
    });
    const pieces = makePieces(candidate, {
      // One resistance zone ahead gives roomR ~1.6R -> the 'moderate' bucket, the same
      // shape docs/FLAG_PATHS_BASE_RATES.md's SOL case describes ("room moderate").
      geometryContext: { '15m': { horizontalResistanceZones: [{ low: 115.28, high: 115.30 }] } },
      tfEntries: { '5m': { stochRsi: { state: 'BULLISH', slopeK: 1 } } },
      topDown: { sentiment: 'bull' }
    });
    const out = buildPathOutlook(pieces, ENGINE_CONFIG);
    assert(out, 'a live proto candidate must produce a pathOutlook');
    assertEqual(out.at, 'tightening', 'proto reads the tightening table');
    assert(out.chase === 'elevated' || out.chase === 'high', `expected elevated or high chase, got ${out.chase} (bucket ${out.key}, w=${JSON.stringify(out.w)})`);
    assert(out.cal === true, `expected the resolved bucket to be calibrated (n=${out.n})`);
  });

  // -------------------------------------------------------------------------
  console.log('\npurity');
  // -------------------------------------------------------------------------

  await test('lib/pathOutlook.js imports only config/engine.js and scripts/tracker/flag-paths.js', () => {
    const source = readFileSync(new URL('./lib/pathOutlook.js', import.meta.url), 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    const froms = [...importLines.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
    assertEqual(froms.join(), '../config/engine.js,../scripts/tracker/flag-paths.js', 'imports');
    assert(!/node:fs|node:net|node:http/.test(importLines), 'no fs/network import');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})();
