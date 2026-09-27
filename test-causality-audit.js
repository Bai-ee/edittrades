/**
 * Tests for scripts/research/harness/causality-audit.js (WP1 — R1 + R1+ causality auditor).
 *
 * Section 1: pure helpers (seeded sampling, signal comparison, purge, timestamp chain) —
 * fixture-free.
 * Section 2: htfAvailabilityCheck / windowingRegressionCheck / ownTfProbeCheck against a
 * real rule over the real deep60 fixture (skipped with a message if missing).
 * Section 3: the item-7 self-test — a deliberately leaky fixture rule (reads
 * ctx.candlesByTf[ctx.tf][ctx.i + 1] directly) must be caught by ownTfProbeCheck, and,
 * by documented design (buildCtx's own contract makes this leak shape unreachable
 * through it), must NOT be caught by windowingRegressionCheck. A clean control rule
 * (bounded to ctx.i) must pass both.
 * Section 4: auditSma4h against real var/edge/4h-long bars (skipped if missing).
 * Section 5: auditFamilyConfig against the real edge-search fixture (skipped if missing).
 *
 * Run: node test-causality-audit.js
 */

import { existsSync } from 'node:fs';
import { loadHistoryDir } from './scripts/replay.js';
import {
  mulberry32, hashSeed, seededPick, signalsEqual, htfAvailabilityCheck,
  buildTruncatedHistory, windowingRegressionCheck, ownTfProbeCheck,
  auditSwingRule, sliceBars, auditSma4h, sma4hTimestampChain, truncateBarsAt,
  familySpecsEqual, auditFamilyConfig, assertTimestampChain, purge
} from './scripts/research/harness/causality-audit.js';
import { buildCtx } from './scripts/swing/run.js';
import * as ctlRandom4h from './scripts/swing/rules/ctl-random-4h.js';
import { runSma4h } from './scripts/research/edge/sma4h-trend.js';
import { loadBars } from './scripts/research/edge/lib.js';
import { buildConfigs } from './scripts/research/edge/families.js';

const HISTORY_DIR = 'test/fixtures/history/deep60-2026-09-24';
const HAS_FIXTURE = existsSync(HISTORY_DIR);
const HAS_EDGE_LONG = existsSync('var/edge/4h-long/BTC_4h.json');
const HAS_EDGE_DEEP2Y = existsSync('test/fixtures/history/deep2y-2026-09-26/BTC_4h.json');

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
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function skip(name, reason) {
  console.log(`  - ${name} (skipped: ${reason})`);
}

// --------------------------------------------------------------------- fixture rules (item 7)

/** Deliberately leaky: reads the candle AFTER the decision index directly. */
const leakyRule = {
  meta: { id: 'fixture-leaky-i-plus-1', tf: '4h' },
  signalAt(ctx) {
    const { candlesByTf, tf, i } = ctx || {};
    const arr = candlesByTf && candlesByTf[tf];
    if (!Array.isArray(arr) || i == null) return null;
    const future = arr[i + 1]; // LOOKAHEAD BUG, on purpose: the audit target for item 7
    const current = arr[i];
    if (!future || !current || !Number.isFinite(future.close) || !Number.isFinite(current.close)) return null;
    const direction = future.close > current.close ? 'long' : 'short';
    return {
      direction,
      entry: current.close,
      stop: direction === 'long' ? current.close * 0.99 : current.close * 1.01,
      tp1: direction === 'long' ? current.close * 1.02 : current.close * 0.98
    };
  }
};

/** Clean control: bounded strictly to ctx.i and ctx.i - 1. */
const cleanRule = {
  meta: { id: 'fixture-clean-bounded', tf: '4h' },
  signalAt(ctx) {
    const { candlesByTf, tf, i } = ctx || {};
    const arr = candlesByTf && candlesByTf[tf];
    if (!Array.isArray(arr) || i == null || i < 1 || i >= arr.length) return null;
    const current = arr[i];
    const prior = arr[i - 1];
    if (!current || !prior || !Number.isFinite(current.close) || !Number.isFinite(prior.close)) return null;
    const direction = current.close > prior.close ? 'long' : 'short';
    return {
      direction,
      entry: current.close,
      stop: direction === 'long' ? current.close * 0.99 : current.close * 1.01,
      tp1: direction === 'long' ? current.close * 1.02 : current.close * 0.98
    };
  }
};

async function run() {
  console.log('\nscripts/research/harness/causality-audit.js\n');

  // ----------------------------------------------------------------- 1) pure helpers
  console.log('1) pure helpers (seeded sampling, signal comparison, purge, timestamp chain)\n');

  await test('mulberry32: deterministic for the same seed', () => {
    const a = mulberry32(42), b = mulberry32(42);
    for (let i = 0; i < 5; i++) assertEqual(a(), b());
  });

  await test('mulberry32: different seeds diverge', () => {
    const a = mulberry32(1)(), b = mulberry32(2)();
    assert(a !== b, 'expected different draws');
  });

  await test('hashSeed: deterministic and sensitive to every part', () => {
    assertEqual(hashSeed(42, 'a', 'b'), hashSeed(42, 'a', 'b'));
    assert(hashSeed(42, 'a', 'b') !== hashSeed(42, 'a', 'c'), 'expected different hash');
  });

  await test('seededPick: deterministic, ascending, distinct, respects k', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const a = seededPick(arr, 10, 7);
    const b = seededPick(arr, 10, 7);
    assertEqual(a.length, 10);
    assertEqual(new Set(a).size, 10, 'expected distinct picks');
    for (let i = 1; i < a.length; i++) assert(a[i] > a[i - 1], 'expected ascending order');
    assertEqual(JSON.stringify(a), JSON.stringify(b), 'expected reproducibility');
  });

  await test('seededPick: k >= length returns the whole (sorted) array', () => {
    const arr = [5, 3, 1];
    assertEqual(JSON.stringify(seededPick(arr, 10, 1)), JSON.stringify([1, 3, 5]));
  });

  await test('signalsEqual: null/null true, null/non-null false, direction/entry differences caught, epsilon tolerated', () => {
    assert(signalsEqual(null, null));
    assert(!signalsEqual(null, { direction: 'long', entry: 1, stop: 0.9, tp1: 1.1 }));
    const a = { direction: 'long', entry: 100, stop: 99, tp1: 102 };
    const b = { direction: 'short', entry: 100, stop: 99, tp1: 102 };
    assert(!signalsEqual(a, b), 'direction mismatch must fail');
    const c = { ...a, entry: 100 + 1e-11 };
    assert(signalsEqual(a, c), 'sub-epsilon float noise must pass');
    const d = { ...a, entry: 100.01 };
    assert(!signalsEqual(a, d), 'real entry difference must fail');
  });

  await test('assertTimestampChain: monotone chain passes, out-of-order chain fails with evidence', () => {
    const stages = [
      { name: 'decision', get: (r) => r.decisionMs },
      { name: 'fill', get: (r) => r.fillMs },
      { name: 'exit', get: (r) => r.exitMs }
    ];
    const good = [{ decisionMs: 0, fillMs: 100, exitMs: 200 }, { decisionMs: 300, fillMs: 300, exitMs: 500 }];
    const okResult = assertTimestampChain(good, stages);
    assert(okResult.ok, 'expected a clean chain to pass');
    assertEqual(okResult.violations.length, 0);

    const bad = [{ decisionMs: 100, fillMs: 50, exitMs: 200 }]; // fill BEFORE decision
    const badResult = assertTimestampChain(bad, stages);
    assert(!badResult.ok, 'expected an out-of-order chain to fail');
    assertEqual(badResult.violations.length, 1);
    assertEqual(badResult.violations[0].from, 'decision');
    assertEqual(badResult.violations[0].to, 'fill');
  });

  await test('assertTimestampChain: a missing (null) stage is skipped, not failed', () => {
    const stages = [{ name: 'a', get: (r) => r.a }, { name: 'b', get: (r) => r.b }, { name: 'c', get: (r) => r.c }];
    const rows = [{ a: 10, b: null, c: 5 }]; // b missing; a(10) -> c(5) alone would be a violation if compared, but chain compares to the last SEEN stage (a), so 5 < 10 must still be caught
    const result = assertTimestampChain(rows, stages);
    assert(!result.ok, 'a present stage out of order relative to the last seen stage must still be caught');
  });

  await test('purge: drops rows whose label horizon extends into/past validStart, keeps the rest', () => {
    const rows = [{ t: 0 }, { t: 50 }, { t: 90 }, { t: 100 }];
    const kept = purge(rows, 100, 10); // horizon 10ms; row must resolve (t+10 <= 100) before validStart
    assertEqual(JSON.stringify(kept.map((r) => r.t)), JSON.stringify([0, 50, 90]));
  });

  await test('purge: boundary is inclusive (t + horizon === validStart is kept)', () => {
    const rows = [{ t: 90 }];
    assertEqual(purge(rows, 100, 10).length, 1);
    assertEqual(purge(rows, 100, 11).length, 0);
  });

  await test('purge: throws on non-finite validStart/horizonMs', () => {
    let threw = false;
    try { purge([{ t: 0 }], NaN, 10); } catch { threw = true; }
    assert(threw, 'expected purge to throw on invalid validStart');
  });

  await test('familySpecsEqual: null handling, dir mismatch, numeric epsilon', () => {
    assert(familySpecsEqual(null, null));
    assert(!familySpecsEqual(null, { dir: 'long', stop: 1 }));
    const a = { dir: 'long', stop: 90, target: 110, maxHoldH: 24 };
    const b = { dir: 'short', stop: 90, target: 110, maxHoldH: 24 };
    assert(!familySpecsEqual(a, b));
    assert(familySpecsEqual(a, { ...a, stop: 90 + 1e-10 }));
    assert(!familySpecsEqual(a, { ...a, stop: 91 }));
  });

  // ----------------------------------------------------------------- 2) real-rule checks
  console.log('\n2) htfAvailabilityCheck / windowingRegressionCheck against a real rule (deep60 fixture)\n');

  let historyByTf = null;
  if (HAS_FIXTURE) {
    historyByTf = loadHistoryDir(HISTORY_DIR, ['BTC']);
  }

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'htfAvailabilityCheck: real ctx from buildCtx never has a future candle',
    () => {
      const tf = '4h';
      const i = historyByTf.BTC[tf].length - 50; // well within eligible range
      const ctx = buildCtx({ symbol: 'BTC', tf, i, historyByTf: historyByTf.BTC });
      const result = htfAvailabilityCheck(ctx);
      assert(result.ok, `expected no HTF violations, got ${JSON.stringify(result.violations)}`);
    }
  );

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'htfAvailabilityCheck: a synthetic future candle IS flagged',
    () => {
      const tf = '4h';
      const i = historyByTf.BTC[tf].length - 50;
      const ctx = buildCtx({ symbol: 'BTC', tf, i, historyByTf: historyByTf.BTC });
      const injected = { ...ctx, candlesByTf: { ...ctx.candlesByTf, [tf]: [...ctx.candlesByTf[tf], { timestamp: ctx.cutMs + 1, closeTime: ctx.cutMs + 3600000 }] } };
      const result = htfAvailabilityCheck(injected);
      assert(!result.ok, 'expected the injected future candle to be flagged');
      assertEqual(result.violations.length, 1);
    }
  );

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'buildTruncatedHistory: never leaves a candle with closeTime > cutMs',
    () => {
      const cutMs = historyByTf.BTC['4h'][300].closeTime;
      const truncated = buildTruncatedHistory(historyByTf.BTC, cutMs);
      for (const [tf, candles] of Object.entries(truncated)) {
        for (const c of candles) assert((c.closeTime ?? c.timestamp) <= cutMs, `${tf} candle past cutMs`);
      }
    }
  );

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'windowingRegressionCheck: passes for a real rule (ctl-random-4h) at several decision points',
    () => {
      const rule = { meta: ctlRandom4h.meta, signalAt: ctlRandom4h.signalAt };
      const tf = rule.meta.tf;
      const candles = historyByTf.BTC[tf];
      const sample = [250, 300, 350, 400, candles.length - 1];
      for (const i of sample) {
        const wr = windowingRegressionCheck({ rule, symbol: 'BTC', tf, i, historyByTf: historyByTf.BTC });
        assert(!wr.error && !wr.errorTrunc, `unexpected error: ${wr.error || wr.errorTrunc}`);
        assert(wr.pass, `windowing regression failed at i=${i}: ref=${JSON.stringify(wr.resultRef)} trunc=${JSON.stringify(wr.resultTrunc)}`);
      }
    }
  );

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'ownTfProbeCheck: a real rule (ctl-random-4h) is unaffected by revealed future candles',
    () => {
      const rule = { meta: ctlRandom4h.meta, signalAt: ctlRandom4h.signalAt };
      const tf = rule.meta.tf;
      const i = 300;
      const wr = windowingRegressionCheck({ rule, symbol: 'BTC', tf, i, historyByTf: historyByTf.BTC });
      const probe = ownTfProbeCheck({ rule, ctxRef: wr.ctxRef, resultRef: wr.resultRef, historyByTf: historyByTf.BTC });
      assert(!probe.skipped, 'expected the probe to run (fixture should have future candles at i=300)');
      assert(!probe.differs, `expected no difference; resultRef=${JSON.stringify(wr.resultRef)} resultProbe=${JSON.stringify(probe.resultProbe)}`);
    }
  );

  // ----------------------------------------------------------------- 3) item 7 self-test
  console.log('\n3) item 7 self-test: injected leaky fixture rule must be caught, clean rule must pass\n');

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'ownTfProbeCheck catches the leaky fixture rule (reads ctx.candlesByTf[tf][ctx.i + 1])',
    () => {
      const i = 300;
      const wr = windowingRegressionCheck({ rule: leakyRule, symbol: 'BTC', tf: '4h', i, historyByTf: historyByTf.BTC });
      const probe = ownTfProbeCheck({ rule: leakyRule, ctxRef: wr.ctxRef, resultRef: wr.resultRef, historyByTf: historyByTf.BTC });
      assert(!probe.skipped, 'expected the probe to run');
      assert(probe.differs, 'expected the probe to catch the i+1 read');
    }
  );

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'windowingRegressionCheck does NOT catch the same leaky rule (documented: buildCtx\'s own contract makes this leak shape unreachable through it)',
    () => {
      const i = 300;
      const wr = windowingRegressionCheck({ rule: leakyRule, symbol: 'BTC', tf: '4h', i, historyByTf: historyByTf.BTC });
      assert(wr.pass, 'expected windowingRegressionCheck to pass (both ctxRef and ctxTrunc give ctx.i === array.length-1, so arr[i+1] is undefined in both, by buildCtx\'s own guarantee)');
    }
  );

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'ownTfProbeCheck passes the clean control rule (bounded to ctx.i)',
    () => {
      const i = 300;
      const wr = windowingRegressionCheck({ rule: cleanRule, symbol: 'BTC', tf: '4h', i, historyByTf: historyByTf.BTC });
      const probe = ownTfProbeCheck({ rule: cleanRule, ctxRef: wr.ctxRef, resultRef: wr.resultRef, historyByTf: historyByTf.BTC });
      assert(wr.pass, 'expected windowingRegressionCheck to pass for the clean rule');
      assert(!probe.skipped && !probe.differs, 'expected the probe to find no difference for the clean rule');
    }
  );

  await (HAS_FIXTURE ? test : (n) => skip(n, 'no test/fixtures/history/deep60-2026-09-24'))(
    'auditSwingRule end-to-end: leaky rule flagged via probeDiffer, clean rule fully clean',
    () => {
      const smallHistory = { BTC: historyByTf.BTC };
      const leakyResult = auditSwingRule({ rule: leakyRule, historyByTf: smallHistory, symbols: ['BTC'], sampleCap: 30, minComputeCandles: 200 });
      assert(leakyResult.probeDiffer > 0, 'expected the leaky rule to show probe differences');
      assertEqual(leakyResult.windowFail, 0, 'expected windowFail to stay 0 for the leaky rule (documented miss)');
      assertEqual(leakyResult.htfFail, 0);

      const cleanResult = auditSwingRule({ rule: cleanRule, historyByTf: smallHistory, symbols: ['BTC'], sampleCap: 30, minComputeCandles: 200 });
      assertEqual(cleanResult.probeDiffer, 0, 'expected the clean rule to show zero probe differences');
      assertEqual(cleanResult.windowFail, 0);
      assertEqual(cleanResult.htfFail, 0);
      assertEqual(cleanResult.verdict, 'PASS');
    }
  );

  // ----------------------------------------------------------------- 4) auditSma4h
  console.log('\n4) auditSma4h against real var/edge/4h-long bars\n');

  await (HAS_EDGE_LONG ? test : (n) => skip(n, 'no var/edge/4h-long/BTC_4h.json'))(
    'auditSma4h: position/sma at bar i unchanged when bars after i+1 are removed',
    () => {
      const bars = loadBars('BTC', '4h', 'var/edge/4h-long');
      const result = auditSma4h(bars, { cap: 40, seed: 42 });
      assertEqual(result.verdict, 'PASS', `unexpected failures: ${JSON.stringify(result.failures.slice(0, 3))}`);
      assert(result.checked > 0, 'expected at least one comparison point');
    }
  );

  await (HAS_EDGE_LONG ? test : (n) => skip(n, 'no var/edge/4h-long/BTC_4h.json'))(
    'sliceBars: keeps exactly [0, k) rows across every field',
    () => {
      const bars = loadBars('BTC', '4h', 'var/edge/4h-long');
      const sliced = sliceBars(bars, 10);
      assertEqual(sliced.n, 10);
      for (const key of ['t', 'ct', 'o', 'h', 'l', 'c', 'v']) assertEqual(sliced[key].length, 10, `field ${key}`);
      assertEqual(sliced.c[9], bars.c[9]);
    }
  );

  await (HAS_EDGE_LONG ? test : (n) => skip(n, 'no var/edge/4h-long/BTC_4h.json'))(
    'sma4hTimestampChain: real trades satisfy decision <= fill <= exit',
    () => {
      const bars = loadBars('BTC', '4h', 'var/edge/4h-long');
      const result = runSma4h(bars, {});
      const chain = sma4hTimestampChain(result);
      assert(chain.ok, `unexpected chain violations: ${JSON.stringify(chain.violations.slice(0, 3))}`);
      assert(chain.n > 0, 'expected at least one trade');
    }
  );

  // ----------------------------------------------------------------- 5) auditFamilyConfig
  console.log('\n5) auditFamilyConfig against the real edge-search fixture\n');

  await (HAS_EDGE_DEEP2Y ? test : (n) => skip(n, 'no test/fixtures/history/deep2y-2026-09-26/BTC_4h.json'))(
    'auditFamilyConfig: F1 Donchian breakout is causal (same absolute index, tail truncated)',
    () => {
      const cfg = buildConfigs().find((c) => c.id === 'F1-don-1h-N20-k2');
      assert(cfg, 'expected F1-don-1h-N20-k2 to exist in buildConfigs()');
      const bars = { '1h': loadBars('BTC', '1h') };
      const result = auditFamilyConfig({ cfg, bars, sampleCap: 40, seed: 42 });
      assertEqual(result.verdict, 'PASS', `unexpected failures: ${JSON.stringify(result.evidence.slice(0, 2))}`);
    }
  );

  await (HAS_EDGE_DEEP2Y ? test : (n) => skip(n, 'no test/fixtures/history/deep2y-2026-09-26/BTC_4h.json'))(
    'truncateBarsAt: keeps the same index positions for rows at/before cutMs',
    () => {
      const bars = { '1h': loadBars('BTC', '1h') };
      const cutMs = bars['1h'].ct[500];
      const truncated = truncateBarsAt(bars, cutMs);
      assertEqual(truncated['1h'].c[500], bars['1h'].c[500]);
      assert(truncated['1h'].n <= 501, 'expected no rows past index 500 to survive');
    }
  );

  // ----------------------------------------------------------------- summary
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('Failed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

run();
