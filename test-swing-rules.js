/**
 * Tests for the S0 swing-trade research harness (docs/PROMPT_S0_SWING_RESEARCH.md,
 * Agent S0-A): the shared contract's own requirements ("every rule module returns null
 * on insufficient history, mirrors long/short, never uses candles after i") plus the
 * harness's own pure scoring functions (statsFor, splitHalves) and its walkOutcome
 * wiring (scoreSignal), hand-built where a number needs to be exact.
 *
 * Sections 1-3 run against the two legacy rules over the real deep60 fixture (skipped
 * with a clear message if the fixture is missing - see docs/PROMPT_S0_SWING_RESEARCH.md
 * for how to symlink it into a worktree). Section 4 is fixture-free (hand-built candles).
 *
 * Run: node test-swing-rules.js
 */

import { existsSync } from 'node:fs';
import {
  buildCtx, closeTimeOf, closedWindow, firstIndexAfter, scoreSignal, statsFor, splitHalves
} from './scripts/swing/run.js';
import { loadHistoryDir } from './scripts/replay.js';
import * as legacySwing from './scripts/swing/rules/legacy-swing.js';
import * as legacyTrend4h from './scripts/swing/rules/legacy-trend4h.js';
import { walkOutcome } from './scripts/tracker/walk-outcome.js';

const HISTORY_DIR = 'test/fixtures/history/deep60-2026-09-24';
const HAS_FIXTURE = existsSync(HISTORY_DIR);
const SYMBOLS = ['BTC', 'SOL', 'ETH'];

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

const RULES = [
  { id: 'legacy-swing', mod: legacySwing },
  { id: 'legacy-trend4h', mod: legacyTrend4h }
];

async function run() {
  console.log('\nscripts/swing/run.js + scripts/swing/rules/legacy-*\n');

  console.log('1) rule interface shape\n');
  for (const { id, mod } of RULES) {
    await test(`${id}: exports meta with the required fields`, () => {
      assert(mod.meta && typeof mod.meta === 'object', 'meta missing');
      for (const key of ['id', 'label', 'source', 'tf', 'holdMaxHours', 'stopKind', 'notes']) {
        assert(key in mod.meta, `meta.${key} missing`);
      }
      assertEqual(mod.meta.id, id, 'meta.id must match the file name');
      assert(mod.meta.tf === '4h' || mod.meta.tf === '1d', 'meta.tf must be 4h or 1d');
      assert(Number.isFinite(mod.meta.holdMaxHours) && mod.meta.holdMaxHours > 0, 'meta.holdMaxHours must be a positive number');
      assert(['atr', 'structure', 'pct'].includes(mod.meta.stopKind), 'meta.stopKind must be atr|structure|pct');
      assert(Array.isArray(mod.meta.notes) && mod.meta.notes.length > 0, 'meta.notes must be a non-empty array');
    });
    await test(`${id}: exports signalAt(ctx) as a function`, () => {
      assert(typeof mod.signalAt === 'function', 'signalAt missing');
    });
  }

  console.log('\n2) insufficient history -> null\n');
  await test('legacy-swing: null when 1D history is under 9 candles (footing for 3 x 3D buckets)', () => {
    const sig = legacySwing.signalAt({
      symbol: 'BTC',
      candlesByTf: { '1d': [{ timestamp: 0, open: 1, high: 1, low: 1, close: 1, closeTime: 86400000 }] }
    });
    assertEqual(sig, null, 'expected null with a single 1D candle');
  });
  await test('legacy-swing: null when candlesByTf carries no timeframes at all', () => {
    assertEqual(legacySwing.signalAt({ symbol: 'BTC', candlesByTf: {} }), null);
  });
  await test('legacy-trend4h: null when 4h/1h are missing from candlesByTf', () => {
    assertEqual(legacyTrend4h.signalAt({ symbol: 'BTC', candlesByTf: {} }), null);
  });
  await test('legacy-trend4h: null when candlesByTf has only a couple of 4h candles', () => {
    const two = [
      { timestamp: 0, open: 1, high: 1.1, low: 0.9, close: 1, closeTime: 14400000 },
      { timestamp: 14400000, open: 1, high: 1.1, low: 0.9, close: 1.02, closeTime: 28800000 }
    ];
    assertEqual(legacyTrend4h.signalAt({ symbol: 'BTC', candlesByTf: { '4h': two, '1h': two } }), null);
  });

  if (!HAS_FIXTURE) {
    console.log(`\n(sections 3-4 skipped: fixture missing at ${HISTORY_DIR} - see docs/PROMPT_S0_SWING_RESEARCH.md's worktree setup)\n`);
  } else {
    const historyByTf = loadHistoryDir(HISTORY_DIR, SYMBOLS);

    console.log('\n3) no lookahead\n');
    await test('buildCtx: candlesByTf never includes a candle closing after the cut, with or without future rows in the underlying array', () => {
      const full = historyByTf.BTC;
      const i = 260; // well past the 200-candle floor, well before the end of the 4h series
      const cutMs = closeTimeOf(full['4h'][i], '4h');

      const ctxFull = buildCtx({ symbol: 'BTC', tf: '4h', i, historyByTf: full });
      for (const [tf, candles] of Object.entries(ctxFull.candlesByTf)) {
        for (const c of candles) assert(closeTimeOf(c, tf) <= cutMs, `${tf} candle closes after the cut`);
      }

      // Truncate every native timeframe's underlying array to strictly before the cut,
      // then rebuild ctx at the SAME cut - a rule fed the truncated history must see the
      // identical candlesByTf/signal, proving the harness never reached past `i` even
      // when the full array had more rows available.
      const truncated = {};
      for (const [tf, candles] of Object.entries(full)) {
        truncated[tf] = candles.filter((c) => closeTimeOf(c, tf) <= cutMs);
      }
      const ctxTruncated = buildCtx({ symbol: 'BTC', tf: '4h', i: truncated['4h'].length - 1, historyByTf: truncated });

      for (const tf of Object.keys(ctxFull.candlesByTf)) {
        assertEqual(ctxTruncated.candlesByTf[tf].length, ctxFull.candlesByTf[tf].length, `${tf} candlesByTf length differs with future rows present`);
        assertEqual(ctxTruncated.candlesByTf[tf].map((c) => c.timestamp).join(','), ctxFull.candlesByTf[tf].map((c) => c.timestamp).join(','), `${tf} candlesByTf timestamps differ with future rows present`);
      }

      const sigFull = legacyTrend4h.signalAt(ctxFull);
      const sigTruncated = legacyTrend4h.signalAt(ctxTruncated);
      assertEqual(JSON.stringify(sigFull), JSON.stringify(sigTruncated), 'legacy-trend4h signal differs when future candles exist in the underlying history');
    });

    console.log('\n4) mirrors long/short (empirical, real fixture)\n');
    await test('legacy-trend4h: fires both long and short across the fixture, and every signal keeps stop/entry/tp1 on the correct side for its direction', () => {
      const seen = { long: 0, short: 0 };
      let checked = 0;
      for (const symbol of SYMBOLS) {
        const candles = historyByTf[symbol]['4h'];
        for (let i = 200; i < candles.length; i++) {
          const ctx = buildCtx({ symbol, tf: '4h', i, historyByTf: historyByTf[symbol] });
          const sig = legacyTrend4h.signalAt(ctx);
          if (!sig) continue;
          checked++;
          seen[sig.direction] = (seen[sig.direction] || 0) + 1;
          if (sig.direction === 'long') {
            assert(sig.stop < sig.entry && sig.entry < sig.tp1, `long signal ${symbol}@${i} has stop/entry/tp1 out of order (${sig.stop}/${sig.entry}/${sig.tp1})`);
          } else {
            assert(sig.direction === 'short', `unexpected direction ${sig.direction}`);
            assert(sig.tp1 < sig.entry && sig.entry < sig.stop, `short signal ${symbol}@${i} has stop/entry/tp1 out of order (${sig.stop}/${sig.entry}/${sig.tp1})`);
          }
        }
      }
      assert(checked > 0, 'expected at least one signal across the fixture');
      assert(seen.long > 0, 'expected at least one long signal across the fixture');
      assert(seen.short > 0, 'expected at least one short signal across the fixture');
    });

    await test('legacy-swing: produces no signal anywhere in the fixture (documented finding - SWING\'s gate/confidence floor never all align in this 60-day window), and never returns a malformed one', () => {
      let nonNull = 0;
      for (const symbol of SYMBOLS) {
        const candles = historyByTf[symbol]['4h'];
        for (let i = 200; i < candles.length; i++) {
          const ctx = buildCtx({ symbol, tf: '4h', i, historyByTf: historyByTf[symbol] });
          const sig = legacySwing.signalAt(ctx);
          if (!sig) continue;
          nonNull++;
          if (sig.direction === 'long') assert(sig.stop < sig.entry && sig.entry < sig.tp1, 'long signal has stop/entry/tp1 out of order');
          else assert(sig.tp1 < sig.entry && sig.entry < sig.stop, 'short signal has stop/entry/tp1 out of order');
        }
      }
      assertEqual(nonNull, 0, 'legacy-swing produced a signal in the deep60 fixture - update this test and docs/SWING_STUDY_2026-09-26.md together');
    });
  }

  console.log('\n5) harness scoring - pure functions, hand-built inputs\n');
  await test('scoreSignal: matches a direct walkOutcome call on the same window (binary-search slice does not change the outcome)', () => {
    const start = Date.UTC(2026, 8, 1, 0, 0, 0);
    const candles1m = [];
    for (let i = 0; i < 400; i++) {
      const t = start + i * 60000;
      // Long entry at 100, drifts up, touches 103 (target) at minute 50 - well after fill.
      const price = i < 50 ? 100 + i * 0.01 : 103;
      candles1m.push({ timestamp: t, high: price + 0.05, low: price - 0.05, closeTime: t + 60000 });
    }
    const fromMs = start;
    const args = { direction: 'long', entryMin: 100, entryMax: 100, stop: 98, target: 103, fillWindowCandles: 15, maxHoldCandles: 120 };
    const direct = walkOutcome({ candles1m, fromMs, ...args });
    const viaHarness = scoreSignal({ candles1m, fromMs, direction: 'long', entry: 100, stop: 98, target: 103, fillWindowCandles: 15, maxHoldCandles: 120 });
    assertEqual(viaHarness.status, direct.status, 'status differs');
    assertEqual(viaHarness.r, direct.r, 'r differs');
    assertEqual(viaHarness.holdCandles, direct.holdCandles, 'holdCandles differs');
  });

  await test('statsFor: exact numbers on 4 hand-built resolved rows (3 win, 1 loss)', () => {
    const rows = [
      { outcome: { status: 'win', r: 2, holdCandles: 60 }, netDir: 1.5, netSens: 1.7 },
      { outcome: { status: 'loss', holdCandles: 30 }, netDir: -1.2, netSens: -1.1 },
      { outcome: { status: 'win', r: 3, holdCandles: 120 }, netDir: 2.7, netSens: 2.85 },
      { outcome: { status: 'not_filled' }, netDir: null, netSens: null }
    ];
    const s = statsFor(rows);
    assertEqual(s.n, 4, 'n');
    assertEqual(s.resolved, 3, 'resolved');
    assertEqual(s.winPct, 66.67, 'winPct');
    assertEqual(s.grossExpR, Math.round(((2 - 1 + 3) / 3) * 10000) / 10000, 'grossExpR');
    assertEqual(s.netExpR, Math.round(((1.5 - 1.2 + 2.7) / 3) * 10000) / 10000, 'netExpR');
    assertEqual(s.maxLosingStreak, 1, 'maxLosingStreak');
    assertEqual(s.medianHoldHours, Math.round((60 / 60) * 100) / 100, 'medianHoldHours (median of 60,30,120 = 60min = 1h)');
  });

  await test('statsFor: max losing streak counts consecutive losses in row order, not total losses', () => {
    const rows = [
      { outcome: { status: 'loss', holdCandles: 1 }, netDir: -1, netSens: -1 },
      { outcome: { status: 'loss', holdCandles: 1 }, netDir: -1, netSens: -1 },
      { outcome: { status: 'win', r: 1, holdCandles: 1 }, netDir: 0.8, netSens: 0.8 },
      { outcome: { status: 'loss', holdCandles: 1 }, netDir: -1, netSens: -1 }
    ];
    assertEqual(statsFor(rows).maxLosingStreak, 2, 'longest run, not total count (3)');
  });

  await test('splitHalves: first/second half net R averages split at the midpoint', () => {
    const rows = [
      { netDir: 1 }, { netDir: -1 }, { netDir: 2 }, { netDir: -0.5 }
    ];
    const { firstHalf, secondHalf } = splitHalves(rows);
    assertEqual(firstHalf, 0, 'first half (1, -1) averages to 0');
    assertEqual(secondHalf, 0.75, 'second half (2, -0.5) averages to 0.75');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
