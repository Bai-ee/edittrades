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
import { buildAt, closedRows, makeReplayFetch, parseArgs, replaySymbol, toReplayLine, tradesTo1m } from './scripts/replay.js';
import { computeMetrics, formatMetrics } from './scripts/replay-metrics.js';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIN = 60_000;
const H4 = INTERVAL_MS['4h'];
const STRATEGY_NAMES = ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP'];
const LINE_KEYS = ['candidateLifecycle', 'candidates', 'closedThrough', 'confluence', 'dataStatus', 'gate', 'geometry', 'strategies', 'symbol'];

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
      for (const c of line.candidates) assert(/^(1m|3m|5m):(long|short|neutral):(forming|triggering|confirmed|failed):\d+$/.test(c), `candidate ${c}`);
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
      assertEqual(seq.join('→'), 'forming→triggering→confirmed', 'lifecycle on the replayed closes');
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
