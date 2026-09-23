/**
 * Deterministic, zero-network test suite for the phase 10 replay harness
 * (scripts/replay.js), replay metrics (scripts/replay-metrics.js) and the miss log
 * (test/fixtures/misses/).
 *
 * Every regression is replayed on its fixture and on the fixture's mirror.
 *
 * Run: node test-replay.js
 */

import { readFileSync, readdirSync } from 'node:fs';
import { ENGINE_CONFIG } from './config/engine.js';
import { buildScalpContext, dropUnclosedCandles, INTERVAL_MS, TIMEFRAMES } from './services/scalpContext.js';
import { getCandlesWithProvenance } from './services/marketData.js';
import { buildAt, closedRows, loadHistoryDir, makeReplayFetch, parseArgs, replaySymbol, toReplayLine, tradesTo1m } from './scripts/replay.js';
import { computeMetrics, formatMetrics } from './scripts/replay-metrics.js';
import { walkOutcome, extractStrategySignals, extractCandidateSignals, extractFlagPlanSignals, aggregateOutcomes, scoreSymbol } from './scripts/replay-outcomes.js';
import { regression001History, regression002History, REPLAY_END } from './test/fixtures/replayHistories.js';

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as the other suites)
// ---------------------------------------------------------------------------

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
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : String(err);
    console.log(`      ${msg}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, tolerance, msg) {
  assert(typeof actual === 'number' && Number.isFinite(actual), `${msg}: actual is not a finite number (${JSON.stringify(actual)})`);
  assert(Math.abs(actual - expected) <= tolerance, `${msg}: expected ${expected} +/- ${tolerance}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIN = 60_000;
const H4 = INTERVAL_MS['4h'];
const STRATEGY_NAMES = ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP'];
const LINE_KEYS = ['candidateLifecycle', 'candidates', 'closedThrough', 'confluence', 'dataStatus', 'flagTradePlan', 'gate', 'geometry', 'strategies', 'symbol'];

/** Deep copy of a history where every candle closing after `cutMs` is scrambled. */
function scrambleAfter(history, cutMs) {
  const out = {};
  for (const [tf, candles] of Object.entries(history)) {
    out[tf] = candles.map((c) => (c.closeTime > cutMs
      ? { ...c, open: c.open * 3, high: c.high * 5, low: c.low * 0.2, close: c.close * 4, volume: 1e9 }
      : { ...c }));
  }
  return out;
}

/** Whole payload as text. generatedAt/evaluatedAt are the cut, so two builds at one cut compare byte for byte. */
function comparable(payload) {
  return JSON.stringify(payload);
}

// --- Miss-file schema -------------------------------------------------------

const MISS_CLASSES = ['MISSED_FLAG', 'MISSED_DIAGONAL_SUPPORT', 'MISSED_DIAGONAL_RESISTANCE', 'MISSED_HORIZONTAL_ZONE', 'MISSED_CONFLUENCE', 'FALSE_BREAKOUT', 'WICK_VS_ACCEPTANCE_ERROR', 'MISSED_COMPRESSION', 'OVERWEIGHTED_ENGINE_SIGNAL', 'OVERCONFIDENT_WITHOUT_VISUAL', 'CHASED_EXTENSION', 'OTHER'];
const MISS_STATUS = ['proposed', 'implemented', 'validated', 'superseded'];
const MISS_TEXT_FIELDS = ['preImageRead', 'missingFeature', 'postImageRead', 'fixLocation', 'proposedFeature'];
const MISS_FIELDS = ['id', 'date', 'symbol', 'timeframe', ...MISS_TEXT_FIELDS, 'missClass', 'status', 'regressionTest'];
const MISS_OPTIONAL = ['source'];

/** Test titles declared in a suite file; a template title becomes a regex with `.+` for each placeholder. */
function testTitles(file) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  const titles = [];
  for (const m of src.matchAll(/await test\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const raw = m[2].replace(/\\(.)/g, '$1');
    if (m[1] === '`' && raw.includes('${')) {
      const pattern = raw.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+');
      titles.push(new RegExp(`^${pattern}$`));
    } else {
      titles.push(raw);
    }
  }
  return titles;
}

/** @returns {Array<string>} problems; empty when the miss file is valid */
function validateMiss(miss, fileName) {
  const errors = [];
  for (const k of MISS_FIELDS) if (!(k in miss)) errors.push(`missing ${k}`);
  for (const k of Object.keys(miss)) if (!MISS_FIELDS.includes(k) && !MISS_OPTIONAL.includes(k)) errors.push(`unknown field ${k}`);
  if (!/^MISS_\d{3}$/.test(miss.id)) errors.push(`bad id ${miss.id}`);
  if (fileName && `${miss.id}.json` !== fileName) errors.push(`id ${miss.id} does not match ${fileName}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(miss.date) || Number.isNaN(Date.parse(miss.date))) errors.push(`bad date ${miss.date}`);
  if (!['BTC', 'SOL', 'ETH'].includes(miss.symbol)) errors.push(`bad symbol ${miss.symbol}`);
  if (!TIMEFRAMES.includes(miss.timeframe)) errors.push(`bad timeframe ${miss.timeframe}`);
  for (const k of MISS_TEXT_FIELDS) if (typeof miss[k] !== 'string' || !miss[k].trim()) errors.push(`${k} must be non-empty text`);
  if (!MISS_CLASSES.includes(miss.missClass)) errors.push(`bad missClass ${miss.missClass}`);
  if (!MISS_STATUS.includes(miss.status)) errors.push(`bad status ${miss.status}`);
  if (!Array.isArray(miss.regressionTest)) {
    errors.push('regressionTest must be an array');
  } else {
    if (miss.status !== 'proposed' && miss.regressionTest.length === 0) errors.push(`status ${miss.status} needs a regression test`);
    for (const ref of miss.regressionTest) {
      if (!ref || typeof ref.file !== 'string' || typeof ref.name !== 'string') { errors.push(`bad regressionTest ref ${JSON.stringify(ref)}`); continue; }
      let titles;
      try { titles = testTitles(`./${ref.file}`); } catch { errors.push(`regression file not found: ${ref.file}`); continue; }
      if (!titles.some((t) => (typeof t === 'string' ? t === ref.name : t.test(ref.name)))) errors.push(`no test "${ref.name}" in ${ref.file}`);
    }
  }
  return errors;
}

const MISS_DIR = new URL('./test/fixtures/misses/', import.meta.url);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('\n1) No lookahead');

  const r001 = regression001History('long');
  // Mid-flag: the breakout and follow-through closes are in the future.
  const cut = REPLAY_END - 3 * MIN;

  await test('the replay fetch never serves a candle that closed after the cut, on any timeframe', async () => {
    const served = [];
    await buildAt('BTC', r001, cut, TIMEFRAMES, (tf, rows) => served.push([tf, rows]));
    assert(served.length >= TIMEFRAMES.length, `every timeframe fetched (${served.length})`);
    for (const [tf, rows] of served) {
      assert(rows.length > 0, `${tf} served rows`);
      for (const c of rows) assert(c.closeTime <= cut, `${tf} served a candle closing ${new Date(c.closeTime).toISOString()} after the cut`);
    }
  });

  await test('mutating every candle after the cut changes nothing: payload and JSONL line are byte-identical', async () => {
    const a = await buildAt('BTC', r001, cut);
    const b = await buildAt('BTC', scrambleAfter(r001, cut), cut);
    assertEqual(comparable(b), comparable(a), 'payload');
    assertEqual(JSON.stringify(toReplayLine(b, 'BTC', cut)), JSON.stringify(toReplayLine(a, 'BTC', cut)), 'line');
  });

  await test('control: mutating the candle that closes at the cut does change the payload', async () => {
    const a = await buildAt('BTC', r001, cut);
    const touched = scrambleAfter(r001, cut - MIN); // the cut candle itself now closes "after" cut - 1m
    const b = await buildAt('BTC', touched, cut);
    assert(comparable(a) !== comparable(b), 'the harness must see the cut candle');
  });

  await test('parity: Kraken-shaped rows (newest still forming) through production equal the replay build at the cut', async () => {
    const now = cut + 30_000;
    const krakenRows = (tf, limit) => {
      const rows = closedRows(r001[tf], tf, cut, limit - 1);
      const last = rows[rows.length - 1];
      const step = INTERVAL_MS[tf];
      const forming = { timestamp: last.closeTime, open: last.close, high: last.close * 2, low: last.close / 2, close: last.close * 1.5, volume: 1, closeTime: last.closeTime + step };
      return [...rows, forming];
    };
    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    let prod;
    try {
      prod = await buildScalpContext({
        symbols: ['BTC'],
        now,
        includeFailed: true,
        fetchCandles: (pair, tf, limit) => getCandlesWithProvenance(pair, tf, limit, { allowSynthetic: false, now, fetchKraken: async (p, t, l) => krakenRows(t, l) }),
        fetchAccount: async () => ({ status: 'unavailable', margin: { usd: null, byAsset: {} } })
      });
    } finally {
      console.log = log;
      console.warn = warn;
    }
    const replay = await buildAt('BTC', r001, cut);
    const strip = (p) => {
      const s = JSON.parse(JSON.stringify(p.symbols.BTC));
      delete s.source;
      delete s.decisionTrace.evaluatedAt;
      return JSON.stringify(s);
    };
    assertEqual(strip(replay), strip(prod), 'symbol payload');
    assertEqual(replay.symbols.BTC.timeframes['1m'].candleCount, 499, '1m closed candles, as production');
    assertEqual(replay.symbols.BTC.timeframes['3m'].candleCount, 239, '3m derived from 719 closed 1m, as production');
  });

  console.log('\n2) Harness: compute window, line shape, options');

  await test('the replay starts at the first close where every timeframe has replay.minComputeCandles closed candles', async () => {
    const min = ENGINE_CONFIG.replay.minComputeCandles;
    const first = [];
    const r = await replaySymbol({ symbol: 'BTC', historyByTf: r001, to: null, step: 100000, onPayload: (p) => first.push(p) });
    assertEqual(r.clockTf, '1m', 'clock');
    const start = Date.parse(r.firstEligible);
    for (const tf of TIMEFRAMES) {
      assert(first[0].symbols.BTC.timeframes[tf].candleCount >= min, `${tf} has ${first[0].symbols.BTC.timeframes[tf].candleCount} at the first close`);
    }
    const before = await makeReplayFetch(r001, start - MIN)(null, '3m', 500);
    assert(dropUnclosedCandles(before.candles, '3m', start - MIN).length < min, 'one close earlier, 3m is short of the window');
  });

  await test('JSONL line shape: keys, strategy map, candidate strings, geometry, gate', async () => {
    const r = await replaySymbol({ symbol: 'BTC', historyByTf: r001, from: REPLAY_END - 10 * MIN });
    assertEqual(r.lines.length, 11, 'one line per close in [from, end]');
    for (const line of r.lines) {
      assertEqual(JSON.stringify(Object.keys(line).sort()), JSON.stringify(LINE_KEYS), 'keys');
      assert(!Number.isNaN(Date.parse(line.closedThrough)), 'closedThrough is a time');
      assertEqual(line.symbol, 'BTC', 'symbol');
      assertEqual(JSON.stringify(Object.keys(line.strategies)), JSON.stringify(STRATEGY_NAMES), 'strategies');
      for (const s of Object.values(line.strategies)) {
        assertEqual(typeof s.valid, 'boolean', 'valid');
        assert(s.valid ? s.rejectedAt === null : typeof s.rejectedAt === 'string', 'rejectedAt');
      }
      for (const c of line.candidates) assert(/^(1m|3m|5m):(long|short|neutral):(proto|forming|triggering|confirmed|expired|failed):\d+$/.test(c), `candidate ${c}`);
      assertEqual(line.candidateLifecycle.length, line.candidates.length, 'one lifecycle entry per candidate');
      assertEqual(line.geometry.length, ENGINE_CONFIG.geometry.timeframes.length, 'geometry strings');
      assertEqual(typeof line.gate.needsVisualConfirmation, 'boolean', 'gate flag');
      assert(Array.isArray(line.gate.codes), 'gate codes');
    }
    const last = r.lines[r.lines.length - 1];
    assertEqual(last.closedThrough, new Date(REPLAY_END).toISOString(), 'last line is the last close');
  });

  await test('--step n emits every n-th close; --from/--to bound the range', async () => {
    const r = await replaySymbol({ symbol: 'BTC', historyByTf: r001, from: REPLAY_END - 20 * MIN, to: REPLAY_END - 10 * MIN, step: 5 });
    assertEqual(JSON.stringify(r.lines.map((l) => l.closedThrough)), JSON.stringify([20, 15, 10].map((m) => new Date(REPLAY_END - m * MIN).toISOString())), 'closes');
    const a = parseArgs(['--history', 'd', '--symbols', 'BTC,ETH', '--timeframes', '1m,4h', '--from', '2026-09-22T00:00:00Z', '--step', '240', '--out', 'x.jsonl']);
    assertEqual(JSON.stringify(a.symbols), '["BTC","ETH"]', 'symbols');
    assertEqual(JSON.stringify(a.timeframes), '["1m","4h"]', 'timeframes');
    assertEqual(a.step, 240, 'step');
    assertEqual(a.out, 'x.jsonl', 'out');
    const c = parseArgs(['--capture', 'BTC,SOL,ETH', '--out', 'dir/', '--backfill-1m', '360']);
    assertEqual(JSON.stringify(c.capture), '["BTC","SOL","ETH"]', 'capture');
    assertEqual(c.backfillMinutes, 360, 'backfill');
  });

  await test('the harness imports the pipeline, never a detector, strategy, wallet or execution module', () => {
    const src = readFileSync(new URL('./scripts/replay.js', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).filter((p) => p.startsWith('.'));
    assertEqual(JSON.stringify(imports.sort()), JSON.stringify(['../config/engine.js', '../services/marketData.js', '../services/scalpContext.js']), 'relative imports');
  });

  await test('trade backfill: trades bucket into 1m OHLCV; a minute without trades is flat at the previous close', () => {
    const t0 = Date.UTC(2026, 8, 22, 0, 0, 0);
    const s = (ms) => String(ms / 1000);
    const candles = tradesTo1m([
      ['100', '1', s(t0 + 1000)], ['105', '2', s(t0 + 20_000)], ['99', '1', s(t0 + 40_000)], ['101', '0.5', s(t0 + 59_000)],
      ['102', '1', s(t0 + 2 * MIN + 5000)]
    ], t0, t0 + 3 * MIN);
    assertEqual(candles.length, 3, 'three minutes');
    assertEqual(JSON.stringify(candles[0]), JSON.stringify({ timestamp: t0, open: 100, high: 105, low: 99, close: 101, volume: 4.5, closeTime: t0 + MIN }), 'first minute');
    assertEqual(JSON.stringify(candles[1]), JSON.stringify({ timestamp: t0 + MIN, open: 101, high: 101, low: 101, close: 101, volume: 0, closeTime: t0 + 2 * MIN }), 'gap minute');
    assertEqual(candles[2].close, 102, 'third minute');
  });

  await test('one symbol over 300 closes replays in under 60 s', async () => {
    const history = regression001History('long', 1000);
    const started = Date.now();
    const r = await replaySymbol({ symbol: 'BTC', historyByTf: history, from: REPLAY_END - 299 * MIN });
    const ms = Date.now() - started;
    assertEqual(r.lines.length, 300, 'closes');
    assert(ms < 60_000, `${ms} ms`);
    console.log(`      (300 closes in ${ms} ms, ${(ms / 300).toFixed(1)} ms/close)`);
  });

  console.log('\n3) Metrics on a hand-built replay');

  const t = (m) => new Date(Date.UTC(2026, 8, 22, 0, m, 0)).toISOString();
  const strat = Object.fromEntries(STRATEGY_NAMES.map((n) => [n, { valid: false, rejectedAt: 'setup-conditions' }]));
  const line = (m, lifecycle, gateCodes = []) => ({
    closedThrough: t(m),
    symbol: 'BTC',
    dataStatus: 'complete',
    strategies: strat,
    candidates: lifecycle.map((c) => `${c.ref}:${c.state}:70`),
    candidateLifecycle: lifecycle.map((c) => ({ startedAt: t(0), failReason: null, ...c })),
    geometry: [],
    confluence: [],
    gate: { needsVisualConfirmation: gateCodes.length > 0, codes: gateCodes }
  });
  // 1m long: forming ×2 → triggering → confirmed → failed (invalidation_close): lifetime 5, confirmed then failed.
  // 1m short: forming ×2, gone: lifetime 2. 5m long (a second candidate): confirmed at m=2..3: lifetime 1 5m candle.
  const sample = [
    line(1, [{ ref: '1m:long', state: 'forming' }, { ref: '1m:short', state: 'forming' }], ['15m:near_miss_support']),
    line(2, [{ ref: '1m:long', state: 'forming' }, { ref: '1m:short', state: 'forming' }, { ref: '5m:long', state: 'confirmed' }], ['15m:near_miss_support', '1m:low_confidence']),
    line(3, [{ ref: '1m:long', state: 'triggering' }, { ref: '5m:long', state: 'confirmed' }]),
    line(4, [{ ref: '1m:long', state: 'confirmed' }], ['15m:near_miss_support']),
    line(5, [{ ref: '1m:long', state: 'failed', failReason: 'invalidation_close' }])
  ];

  await test('counts by state and direction, distinct candidates, gate rate by code', () => {
    const m = computeMetrics(sample);
    assertEqual(m.closes, 5, 'closes');
    assertEqual(JSON.stringify(m.candidates.appearances.forming), JSON.stringify({ long: 2, short: 2, neutral: 0 }), 'forming');
    assertEqual(JSON.stringify(m.candidates.appearances.confirmed), JSON.stringify({ long: 3, short: 0, neutral: 0 }), 'confirmed');
    assertEqual(m.candidates.appearances.triggering.long, 1, 'triggering');
    assertEqual(m.candidates.appearances.failed.long, 1, 'failed');
    assertEqual(m.candidates.distinct, 3, 'distinct');
    assertEqual(m.gate.closesWithGate, 3, 'gated closes');
    assertEqual(m.gate.rate, 0.6, 'gate rate');
    assertEqual(m.gate.byCode['15m:near_miss_support'].rate, 0.6, 'near_miss rate');
    assertEqual(m.gate.byCode['1m:low_confidence'].closes, 1, 'low_confidence');
  });

  await test('lifetime in candles of the candidate timeframe, and confirmed → failReason', () => {
    const m = computeMetrics(sample);
    assertEqual(m.lifetime.byTimeframe['1m'], 3.5, '1m: (5 + 2) / 2');
    assertEqual(m.lifetime.byTimeframe['5m'], 1.2, '5m: 1 minute seen = 0.2 + 1');
    assertEqual(m.lifetime.avgCandles, 2.73, 'all: (5 + 2 + 1.2) / 3');
    assertEqual(m.confirmedThenFailed.confirmed, 2, 'confirmed candidates');
    assertEqual(m.confirmedThenFailed.laterFailed, 1, 'later failed');
    assertEqual(m.confirmedThenFailed.rate, 0.5, 'rate');
    assertEqual(m.confirmedThenFailed.byReason.invalidation_close, 1, 'reason');
  });

  await test('precision/recall against labels; "no labels yet" without them; table renders', () => {
    const none = computeMetrics(sample);
    assertEqual(none.labels.status, 'no labels yet', 'no labels');
    const labels = {
      BTC: [
        { closedThrough: t(1), timeframe: '1m', direction: 'long', expected: 'forming' }, // TP
        { closedThrough: t(3), timeframe: '1m', direction: 'long', expected: 'confirmed' }, // got triggering: FN + FP
        { closedThrough: t(4), timeframe: '1m', direction: 'short', expected: 'forming' }, // got none: FN
        { closedThrough: t(5), timeframe: '1m', direction: 'long', expected: 'none' }, // failed → none: TN
        { closedThrough: t(2), timeframe: '5m', direction: 'short', expected: 'none' }, // TN
        { closedThrough: t(9), timeframe: '1m', direction: 'long', expected: 'none' } // no such close
      ]
    };
    const m = computeMetrics(sample, labels);
    const l = m.labels;
    assertEqual(JSON.stringify([l.labels, l.matched, l.unmatched, l.tp, l.fp, l.fn, l.tn]), JSON.stringify([6, 5, 1, 1, 1, 2, 2]), 'counts');
    assertEqual(l.precision, 0.5, 'precision');
    assertEqual(l.recall, 0.3333, 'recall');
    const text = formatMetrics(m);
    assert(text.includes('Visual gate: 3/5 closes (rate 0.6)'), 'table gate line');
    assert(text.includes('precision 0.5 recall 0.3333'), 'table labels line');
  });

  console.log('\n4) Miss log');

  const missFiles = readdirSync(MISS_DIR).filter((f) => f.endsWith('.json')).sort();

  await test('every miss file validates against the schema and every referenced regression test exists', () => {
    assert(missFiles.includes('MISS_001.json') && missFiles.includes('MISS_002.json'), `seed misses present: ${missFiles}`);
    for (const f of missFiles) {
      const errors = validateMiss(JSON.parse(readFileSync(new URL(f, MISS_DIR), 'utf8')), f);
      assert(errors.length === 0, `${f}: ${errors.join('; ')}`);
    }
  });

  await test('seed misses: MISS_001 MISSED_FLAG → REGRESSION_001, MISS_002 → the MISS_002 risk fixture, both implemented', () => {
    const m1 = JSON.parse(readFileSync(new URL('MISS_001.json', MISS_DIR), 'utf8'));
    const m2 = JSON.parse(readFileSync(new URL('MISS_002.json', MISS_DIR), 'utf8'));
    assertEqual(m1.missClass, 'MISSED_FLAG', 'MISS_001 class');
    assertEqual(m1.status, 'implemented', 'MISS_001 status');
    assert(m1.regressionTest.some((r) => r.file === 'test-pattern-detector.js' && r.name.startsWith('REGRESSION_001')), 'MISS_001 → REGRESSION_001');
    assertEqual(m2.status, 'implemented', 'MISS_002 status');
    assert(m2.regressionTest.some((r) => r.file === 'test-risk-engine.js' && r.name.startsWith('MISS_002')), 'MISS_002 → risk fixture');
  });

  await test('the validator rejects a bad class, a bad status, a missing field and a test title that does not exist', () => {
    const good = JSON.parse(readFileSync(new URL('MISS_001.json', MISS_DIR), 'utf8'));
    const { postImageRead, ...missing } = good;
    assert(validateMiss({ ...good, missClass: 'MISSED_VIBES' }).length > 0, 'class');
    assert(validateMiss({ ...good, status: 'done' }).length > 0, 'status');
    assert(validateMiss(missing).length > 0, 'missing field');
    assert(validateMiss({ ...good, regressionTest: [{ file: 'test-pattern-detector.js', name: 'REGRESSION_999 does not exist' }] }).length > 0, 'unknown test');
    assert(validateMiss({ ...good, regressionTest: [] }).length > 0, 'implemented without a test');
    assertEqual(validateMiss({ ...good, status: 'proposed', regressionTest: [] }).length, 0, 'proposed may have none');
  });

  console.log('\n5) Regressions reproduced through the harness');

  for (const direction of ['long', 'short']) {
    await test(`REGRESSION_001 via replay (${direction}): forming → triggering → confirmed on the 1m clock while SCALP_1H stays NO_TRADE`, async () => {
      const r = await replaySymbol({ symbol: 'BTC', historyByTf: regression001History(direction), from: REPLAY_END - 20 * MIN });
      const states = r.lines.map((l) => {
        const c = l.candidates.find((x) => x.startsWith(`1m:${direction}:`));
        return c ? c.split(':')[2] : 'none';
      });
      const firstSeen = states.findIndex((s) => s !== 'none');
      assert(firstSeen > 0, `no 1m ${direction} candidate before the flag: ${states.join(',')}`);
      const seq = states.slice(firstSeen).filter((s, i, a) => i === 0 || s !== a[i - 1]);
      // F1 item 1: a proto reading (1-2 pullback candles after the impulse, before
      // minCandles) now precedes forming - it did not exist before this plan.
      assertEqual(seq.join('→'), 'proto→forming→triggering→confirmed', 'lifecycle on the replayed closes');
      assertEqual(states[states.length - 1], 'confirmed', 'confirmed on the last close');
      for (const l of r.lines) {
        assertEqual(l.strategies.SCALP_1H.valid, false, `SCALP_1H at ${l.closedThrough}`);
      }
    });
  }

  for (const direction of ['long', 'short']) {
    const side = direction === 'long' ? 'diagonalSupport' : 'diagonalResistance';
    await test(`REGRESSION_002 via replay (${direction}): 4h ${side} + horizontal zone confluence appears on the close the third touch confirms, not before`, async () => {
      const r = await replaySymbol({ symbol: 'BTC', historyByTf: regression002History(direction), from: REPLAY_END - 2 * H4, step: 240 });
      assertEqual(JSON.stringify(r.lines.map((l) => l.closedThrough)), JSON.stringify([2, 1, 0].map((k) => new Date(REPLAY_END - k * H4).toISOString())), '4h closes via --step 240');
      const zones = r.lines.map((l) => l.confluence.filter((z) => z.startsWith('4h:') && z.includes(side) && z.includes('horizontalZone')));
      assertEqual(zones[0].length + zones[1].length, 0, `no ${side} confluence before the third touch: ${JSON.stringify(r.lines.map((l) => l.confluence))}`);
      assertEqual(zones[2].length, 1, `one ${side} + horizontal zone on the last close`);
      const distancePct = Number(zones[2][0].split(':')[2]);
      assert(distancePct > 0, `current distance published (${distancePct})`);
    });
  }

  await test('MISS_003 via replay: ETH/SOL/BTC 1m longs are visible (never silently vanish) 14:45-15:03, SOL triggers at 14:52 (F1 fixture)', async () => {
    const dir = new URL('./test/fixtures/history/2026-09-23', import.meta.url).pathname;
    const history = loadHistoryDir(dir, ['BTC', 'ETH', 'SOL']);
    const from = Date.UTC(2026, 8, 23, 14, 45);
    const to = Date.UTC(2026, 8, 23, 15, 3);

    const byState = (lines) => lines.map((l) => {
      const c = l.candidates.find((x) => x.startsWith('1m:long:'));
      return { at: l.closedThrough, state: c ? c.split(':')[2] : 'none' };
    });

    for (const symbol of ['BTC', 'ETH', 'SOL']) {
      const r = await replaySymbol({ symbol, historyByTf: history[symbol], from, to });
      assertEqual(r.lines.length, 19, `${symbol}: one line per minute, 14:45-15:03 inclusive`);
      const states = byState(r.lines);
      const missing = states.filter((s) => s.state === 'none');
      assert(missing.length === 0, `${symbol}: closes with no 1m long candidate at all (silent vanish): ${JSON.stringify(missing)}`);
      assertEqual(states[states.length - 1].state, 'confirmed', `${symbol}: confirmed by 15:03`);
    }

    // The incident's own claim (docs/PLAN_FLAG_DETECTION_COVERAGE.md): with the wider
    // impulse lookback (item 2), SOL shows a flag triggering at 14:52 that production
    // never showed.
    const sol = await replaySymbol({ symbol: 'SOL', historyByTf: history.SOL, from, to });
    const at1452 = byState(sol.lines).find((s) => s.at === '2026-09-23T14:52:00.000Z');
    assertEqual(at1452.state, 'triggering', 'SOL 1m long triggers at 14:52');

    // Item 5: SOL's confirmed flag ages past maxBreakoutAge (5 candles past its 14:53
    // break) instead of vanishing the way it did in production - it reads expired.
    const at1457 = byState(sol.lines).find((s) => s.at === '2026-09-23T14:57:00.000Z');
    assertEqual(at1457.state, 'expired', 'SOL 1m long reads expired, not gone, past maxBreakoutAge');
  });

  console.log('\n6) Outcome scoring (Q4, scripts/replay-outcomes.js)');

  const OB = Date.UTC(2026, 8, 22, 0, 0, 0);
  const oc = (i, high, low) => ({ timestamp: OB + i * MIN, high, low });
  const outcomeCfg = { fillWindowCandles: 3, maxHoldCandles: 20 };

  await test('long win: fills inside the window, then TP1 first', () => {
    const candles1m = [oc(0, 99, 98), oc(1, 101, 100.5), oc(2, 105, 104), oc(3, 111, 109)];
    const r = walkOutcome({ candles1m, fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, ...outcomeCfg });
    assertEqual(r.status, 'win', 'win');
    assertEqual(r.holdCandles, 3, 'candle 1 (fill) through candle 3 (target) = 3');
    assertClose(r.r, Math.abs(110 - 101) / Math.abs(101 - 95), 1e-3, 'R = |target-entry| / |entry-stop|, entry = unfavorable zone edge (long: zoneHigh)');
  });

  await test('long loss: fills, then stop first', () => {
    const candles1m = [oc(0, 101, 100.5), oc(1, 100, 94)];
    const r = walkOutcome({ candles1m, fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, ...outcomeCfg });
    assertEqual(r.status, 'loss', 'loss');
    assertEqual(r.r, -1, 'loss is always -1R');
  });

  await test('short win and short loss mirror the long cases', () => {
    const win = walkOutcome({
      candles1m: [oc(0, 101, 100), oc(1, 96, 89)],
      fromMs: OB, direction: 'short', entryMin: 100, entryMax: 101, stop: 105, target: 90, ...outcomeCfg
    });
    assertEqual(win.status, 'win', 'short win');
    assertClose(win.r, Math.abs(90 - 100) / Math.abs(100 - 105), 1e-3, 'short R formula mirrors long (unfavorable edge is zoneLow for a short)');
    const loss = walkOutcome({
      candles1m: [oc(0, 101, 100), oc(1, 106, 100)],
      fromMs: OB, direction: 'short', entryMin: 100, entryMax: 101, stop: 105, target: 90, ...outcomeCfg
    });
    assertEqual(loss.status, 'loss', 'short loss');
    assertEqual(loss.r, -1, 'short loss is -1R too');
  });

  await test('not filled: entry zone never touched inside fillWindowCandles', () => {
    const candles1m = [oc(0, 90, 88), oc(1, 91, 89), oc(2, 92, 90), oc(3, 101, 100)]; // touches at i=3, outside the 3-candle window
    const r = walkOutcome({ candles1m, fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, ...outcomeCfg });
    assertEqual(r.status, 'not_filled', 'not filled');
  });

  await test('same-candle ambiguity: stop and target both touched in one candle → loss (conservative)', () => {
    const candles1m = [oc(0, 101, 100.5), oc(1, 112, 94)]; // one candle spans both 95 (stop) and 110 (target)
    const r = walkOutcome({ candles1m, fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, ...outcomeCfg });
    assertEqual(r.status, 'loss', 'ambiguous same-candle touch reads as a loss');
    assertEqual(r.ambiguous, true, 'ambiguous flag set');
  });

  await test('no false intrabar win: target touched on the SAME candle as the fill is not credited (order unknowable)', () => {
    // Candle 0 both fills the entry zone (low 100.5, inside [100,101]) AND reaches the
    // target (high 112 >= 110) - the pre-fix code returned an immediate 'win' here. The
    // very next candle reverses into the stop, showing why that credit was false: the
    // true entry/target order within candle 0 was never knowable from OHLC alone.
    const candles1m = [oc(0, 112, 100.5), oc(1, 100, 94)];
    const r = walkOutcome({ candles1m, fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, ...outcomeCfg });
    assertEqual(r.status, 'loss', 'the same-candle target touch must not have been credited as a win');
    assertEqual(r.r, -1, 'resolves as an honest loss once the next candle is unambiguous');
    assertEqual(r.holdCandles, 2, 'held through the candle that actually resolved it');
  });

  await test('a target touch on a LATER candle (after the fill candle) still credits a legitimate win', () => {
    // Candle 0 fills and also touches target (same ambiguity as above, not credited).
    // Candle 1 touches target again - now unambiguous, since the fill is settled
    // history by the time this candle is read.
    const candles1m = [oc(0, 112, 100.5), oc(1, 111, 105)];
    const r = walkOutcome({ candles1m, fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, ...outcomeCfg });
    assertEqual(r.status, 'win', 'a later, unambiguous target touch still wins');
    assertEqual(r.holdCandles, 2, 'held through candle 1');
    assertClose(r.r, Math.abs(110 - 101) / Math.abs(101 - 95), 1e-3, 'R uses the unfavorable entry edge');
  });

  await test('open: filled but neither stop nor target touched within maxHoldCandles', () => {
    const candles1m = [oc(0, 101, 100.5), oc(1, 102, 101), oc(2, 103, 102)];
    const r = walkOutcome({ candles1m, fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, fillWindowCandles: 3, maxHoldCandles: 3 });
    assertEqual(r.status, 'open', 'open, not counted as a win or a loss');
  });

  await test('invalid levels (missing stop/target) never throw', () => {
    assertEqual(walkOutcome({ candles1m: [oc(0, 101, 100)], fromMs: OB, direction: 'long', entryMin: 100, entryMax: 101, stop: null, target: 110, ...outcomeCfg }).status, 'invalid_levels', 'null stop');
  });

  await test('extractStrategySignals: a signal counts once until it changes, and re-arms after going invalid', () => {
    const lines = [
      { closedThrough: '2026-09-22T00:00:00.000Z', strategies: { SCALP_1H: { valid: true, direction: 'LONG', entryZone: { min: 100, max: 101 }, stopLoss: 95, targets: [110] } } },
      { closedThrough: '2026-09-22T00:01:00.000Z', strategies: { SCALP_1H: { valid: true, direction: 'LONG', entryZone: { min: 100, max: 101 }, stopLoss: 95, targets: [110] } } }, // identical, not a new signal
      { closedThrough: '2026-09-22T00:02:00.000Z', strategies: { SCALP_1H: { valid: false, direction: 'NO_TRADE' } } },
      { closedThrough: '2026-09-22T00:03:00.000Z', strategies: { SCALP_1H: { valid: true, direction: 'LONG', entryZone: { min: 100, max: 101 }, stopLoss: 95, targets: [110] } } } // re-armed after invalid, same numbers
    ];
    const signals = extractStrategySignals(lines);
    assertEqual(signals.length, 2, 'one at first appearance, one after re-arming; the repeat in between does not count');
    assertEqual(signals[0].signalCloseMs, Date.parse('2026-09-22T00:00:00.000Z'), 'first signal timestamp');
    assertEqual(signals[1].signalCloseMs, Date.parse('2026-09-22T00:03:00.000Z'), 'second signal timestamp');
  });

  await test('extractCandidateSignals: one entry per distinct (ref, startedAt) track, at its first confirmed close', () => {
    const lines = [
      { closedThrough: '2026-09-22T00:00:00.000Z', candidateLifecycle: [{ ref: '1m:long', startedAt: 't0', state: 'triggering' }] },
      { closedThrough: '2026-09-22T00:01:00.000Z', candidateLifecycle: [{ ref: '1m:long', startedAt: 't0', state: 'confirmed', breakoutLevel: 110, invalidation: 100, measuredTarget: 130 }] },
      { closedThrough: '2026-09-22T00:02:00.000Z', candidateLifecycle: [{ ref: '1m:long', startedAt: 't0', state: 'confirmed', breakoutLevel: 110, invalidation: 100, measuredTarget: 130 }] }
    ];
    const signals = extractCandidateSignals(lines);
    assertEqual(signals.length, 1, 'the same track is not re-counted on later confirmed closes');
    assertEqual(signals[0].entryMin, 110, 'entry = breakoutLevel');
    assertEqual(signals[0].stop, 100, 'stop = invalidation');
    assertEqual(signals[0].target, 130, 'target = Q1 measuredTarget');
  });

  await test('extractFlagPlanSignals: walks ready selected plans only, re-arms on a level change, counts rejections separately', () => {
    const lines = [
      { closedThrough: '2026-09-22T00:00:00.000Z', flagTradePlan: { candidateId: 'A', timeframe: '1m', direction: 'long', status: 'rejected', reasonCode: 'rr_below_min', entry: null, stop: null, tp1: null } },
      { closedThrough: '2026-09-22T00:01:00.000Z', flagTradePlan: { candidateId: 'A', timeframe: '1m', direction: 'long', status: 'rejected', reasonCode: 'rr_below_min', entry: null, stop: null, tp1: null } }, // same rejection, not double-counted
      { closedThrough: '2026-09-22T00:02:00.000Z', flagTradePlan: { candidateId: 'B', timeframe: '1m', direction: 'long', status: 'conditional', reasonCode: 'awaiting_retest', entry: 110, stop: 100, tp1: 130 } },
      { closedThrough: '2026-09-22T00:03:00.000Z', flagTradePlan: { candidateId: 'B', timeframe: '1m', direction: 'long', status: 'ready', reasonCode: null, entry: 110, stop: 100, tp1: 130 } }, // same levels, still one signal
      { closedThrough: '2026-09-22T00:04:00.000Z', flagTradePlan: null }
    ];
    const { signals, rejections } = extractFlagPlanSignals(lines);
    assertEqual(rejections.length, 1, 'the repeated identical rejection is not double-counted');
    assertEqual(rejections[0].reasonCode, 'rr_below_min', 'rejection reason');
    assertEqual(signals.length, 1, 'conditional is not walked; the ready snapshot becomes the one scored signal');
    assertEqual(signals[0].entryMin, 110, 'entry = plan.entry');
    assertEqual(signals[0].target, 130, 'target = plan.tp1');
  });

  await test('review fix 8: a ready plan is filled at the ready close, no touch search; target on the first later candle wins (long + short)', () => {
    const t0 = Date.parse('2026-09-22T00:00:00.000Z');
    const long = walkOutcome({ candles1m: [{ timestamp: t0, high: 135, low: 115 }], fromMs: t0, direction: 'long', entryMin: 110, entryMax: 110, stop: 100, target: 130, fillWindowCandles: 3, maxHoldCandles: 5, prefilled: true });
    assertEqual(long.status, 'win', 'long prefilled win');
    assertEqual(long.r, 2, 'long gross R from the entry level');
    const short = walkOutcome({ candles1m: [{ timestamp: t0, high: 105, low: 85 }], fromMs: t0, direction: 'short', entryMin: 110, entryMax: 110, stop: 120, target: 90, fillWindowCandles: 3, maxHoldCandles: 5, prefilled: true });
    assertEqual(short.status, 'win', 'short prefilled win');
    const touch = walkOutcome({ candles1m: [{ timestamp: t0, high: 135, low: 115 }], fromMs: t0, direction: 'long', entryMin: 110, entryMax: 110, stop: 100, target: 130, fillWindowCandles: 3, maxHoldCandles: 5 });
    assertEqual(touch.status, 'not_filled', 'without prefilled (strategies/candidates) the touch-fill walk is unchanged');
    const { signals } = extractFlagPlanSignals([{ closedThrough: '2026-09-22T00:00:00.000Z', flagTradePlan: { candidateId: 'E', timeframe: '1m', direction: 'short', status: 'ready', reasonCode: null, entry: 110, stop: 120, tp1: 90 } }]);
    assertEqual(signals[0].prefilled, true, 'ready plan signals are prefilled');
  });

  await test('scoreSymbol: flagPlan.outcomes/rejections are separate from the flagMeasuredMove diagnostic', () => {
    const candles1m = [oc(0, 111, 105), oc(1, 132, 128)]; // fills at 0 (>=110... wait long entry touch), wins at 1
    const lines = [
      { closedThrough: '2026-09-22T00:00:00.000Z', candidateLifecycle: [], flagTradePlan: { candidateId: 'C', timeframe: '1m', direction: 'long', status: 'ready', reasonCode: null, entry: 110, stop: 100, tp1: 130 } },
      { closedThrough: '2026-09-22T00:01:00.000Z', candidateLifecycle: [], flagTradePlan: { candidateId: 'D', timeframe: '1m', direction: 'long', status: 'rejected', reasonCode: 'chase', entry: null, stop: null, tp1: null } }
    ];
    const scored = scoreSymbol(lines, candles1m, { fillWindowCandles: 3, maxHoldCandles: 5 });
    assertEqual(scored.flagPlan.signalCount, 1, 'one walkable plan signal');
    assertEqual(scored.flagPlan.rejectionCount, 1, 'one rejection');
    assertEqual(scored.flagPlan.rejections[0].reasonCode, 'chase', 'rejection reason surfaced');
    assertEqual(scored.flagMeasuredMove.length, 0, 'the diagnostic is independent - no candidateLifecycle entries here');
  });

  await test('aggregateOutcomes: streak counting and expectancy arithmetic over a known win/loss sequence', () => {
    // Four signals, same (strategy, direction): win, loss, loss, win. Fixed R wins.
    // Each win's target touch falls on the candle AFTER the fill candle (i > fillIdx),
    // never the fill candle itself, so it survives the no-same-candle-credit rule.
    const candles1m = [
      oc(0, 101, 100.5), oc(1, 112, 109), // signal A (t=0): fills at 0, wins at 1, r = |110-101|/|101-95|
      oc(2, 101, 100.5), oc(3, 94, 90),   // signal B (t=2): fills then loses
      oc(4, 101, 100.5), oc(5, 94, 90),   // signal C (t=4): fills then loses
      oc(6, 101, 100.5), oc(7, 112, 109)  // signal D (t=6): fills then wins
    ];
    const signals = [0, 2, 4, 6].map((t) => ({
      strategy: 'SCALP_1H', direction: 'long', entryMin: 100, entryMax: 101, stop: 95, target: 110, signalCloseMs: OB + t * MIN
    }));
    const [row] = aggregateOutcomes(signals, candles1m, { fillWindowCandles: 1, maxHoldCandles: 2 });
    assertEqual(row.signals, 4, 'four signals');
    assertEqual(row.fills, 4, 'all four filled');
    assertEqual(row.wins, 2, 'win, loss, loss, win → 2 wins');
    assertEqual(row.losses, 2, '2 losses');
    assertEqual(row.maxConsecutiveLosses, 2, 'the middle loss,loss run is the longest');
    const r = Math.abs(110 - 101) / Math.abs(101 - 95);
    assertClose(row.avgWinR, r, 1e-3, 'both wins have the identical R (same levels)');
    const expected = 0.5 * r + 0.5 * -1;
    assertClose(row.expectancy, expected, 1e-3, 'expectancy = winRate*avgWinR + (1-winRate)*-1');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
