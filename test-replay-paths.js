/**
 * Deterministic, zero-network tests for scripts/replay-paths.js (T4 P0 item 2,
 * docs/PLAN_FLAG_PATHS.md). Everything here is synthetic and fast - no real history
 * directory, no full production build. `labelPath`/`featuresAt`/`baseRates` themselves
 * are already exhaustively tested in test-flag-paths.js and are not re-tested here; this
 * suite covers replay-paths.js's OWN orchestration:
 *   - `roomRAhead` (a small function this file owns, deliberately not
 *     lib/flagTradePlan.js's private nearestRoomAhead - see scripts/replay-paths.js's
 *     header)
 *   - `buildRow`'s wiring of a candidate + payload into a labelled row, including that
 *     its "as of the tightening point" candle read (ATR / flagCandles, via
 *     `closedRows(fullByTf[tf], tf, fromMs, 500)`) never sees a candle that closes after
 *     `fromMs` - the no-lookahead property this file is responsible for (labelPath's own
 *     forward-walk no-lookahead is test-flag-paths.js's job)
 *   - `runSymbol`'s first-tightening dedup: only the FIRST tick a candidateId reads
 *     forming/proto is ever labelled, via an injectable build function (no real pipeline)
 *   - `computeTicks`'s from/to/step filtering over an explicit close list (the real
 *     eligibility scan against a live history directory is exercised by the actual
 *     P0 replay run on test/fixtures/history/*, not re-tested here with a synthetic
 *     200+ candle fixture - see docs/FLAG_PATHS_BASE_RATES.md)
 *   - `buildReport`'s aggregation (overall / by tf+direction / by feature / top 2-feature
 *     combos) and the calibrated/uncalibrated split at a given minN
 *   - `parseArgs`
 *
 * Run: node test-replay-paths.js
 */

import {
  roomRAhead, tp1Ahead, mergeZones, buildRow, runSymbol, computeTicks, buildReport, parseArgs
} from './scripts/replay-paths.js';
import { PATHS } from './scripts/tracker/flag-paths.js';

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
const FIVE_MIN = 5 * MIN;
const T0 = Date.parse('2026-09-24T04:00:00.000Z');

/** `n` 5m candles ending just before `endMs`, flat-ish with small noise (ATR seed). */
function flat5mBefore(endMs, n, base = 199.5, noise = 0.3) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const ts = endMs - i * FIVE_MIN;
    const wobble = (i % 3) * noise;
    out.push({ timestamp: ts, open: base + wobble, high: base + wobble + noise, low: base + wobble - noise, close: base + wobble, volume: 1 });
  }
  return out;
}

/** 1m candles from `startMs`; `rows` = [{o,h,l,c}, ...]. */
function m1Candles(startMs, rows) {
  return rows.map((r, i) => ({ timestamp: startMs + i * MIN, open: r.o, high: r.h, low: r.l, close: r.c }));
}

(async () => {
  console.log('replay-paths.js (T4 P0 item 2)');

  // ============ roomRAhead ============
  await test('roomRAhead: long - nearest resistance zone ahead of entry, in R', () => {
    const geometryContext = {
      '15m': { horizontalResistanceZones: [{ low: 210, high: 212 }, { low: 205, high: 206 }], horizontalSupportZones: [] }
    };
    const r = roomRAhead('long', 200, 2, geometryContext); // r=2, nearest ahead edge (low) is 205 -> (205-200)/2 = 2.5
    assertEqual(r, 2.5, 'nearest resistance edge ahead wins over the farther one');
  });

  await test('roomRAhead: short - nearest support zone ahead (mirror)', () => {
    const geometryContext = {
      '1h': { horizontalSupportZones: [{ low: 90, high: 92 }, { low: 95, high: 96 }], horizontalResistanceZones: [] }
    };
    const r = roomRAhead('short', 100, 2, geometryContext); // near edge = high; 96 is nearer than 92
    assertEqual(r, 2, '(100-96)/2 = 2');
  });

  await test('roomRAhead: a zone behind entry is ignored', () => {
    const geometryContext = { '1h': { horizontalResistanceZones: [{ low: 150, high: 151 }], horizontalSupportZones: [] } };
    const r = roomRAhead('long', 200, 2, geometryContext);
    assertEqual(r, null, 'zone entirely behind entry does not count as room ahead');
  });

  await test('roomRAhead: no zones -> null; invalid entry/r -> null', () => {
    assertEqual(roomRAhead('long', 200, 2, {}), null, 'no geometry');
    assertEqual(roomRAhead('long', 200, 2, null), null, 'null geometryContext');
    assertEqual(roomRAhead('long', NaN, 2, { a: { horizontalResistanceZones: [{ low: 205, high: 206 }] } }), null, 'invalid entry');
    assertEqual(roomRAhead('long', 200, 0, { a: { horizontalResistanceZones: [{ low: 205, high: 206 }] } }), null, 'r<=0');
  });

  // ============ tp1Ahead (T5 P0, docs/PLAN_DIVERGENCE_OPPORTUNITIES.md item 2) ============
  await test('tp1Ahead: long - nearest resistance edge short of measuredTarget caps TP1', () => {
    const geometryContext = { '15m': { horizontalResistanceZones: [{ low: 202, high: 203 }, { low: 206, high: 207 }] } };
    assertEqual(tp1Ahead('long', 200, 210, geometryContext), 202, 'nearest resistance edge ahead of entry and short of measuredTarget wins');
  });

  await test('tp1Ahead: long - no zone short of measuredTarget falls back to measuredTarget', () => {
    const geometryContext = { '15m': { horizontalResistanceZones: [{ low: 215, high: 216 }] } };
    assertEqual(tp1Ahead('long', 200, 210, geometryContext), 210, 'a zone beyond measuredTarget never caps it');
  });

  await test('tp1Ahead: short mirror - nearest support edge short of measuredTarget', () => {
    const geometryContext = { '1h': { horizontalSupportZones: [{ low: 97, high: 98 }, { low: 90, high: 91 }] } };
    assertEqual(tp1Ahead('short', 100, 90, geometryContext), 98, 'nearer support edge (98, not 91) wins');
  });

  await test('tp1Ahead: no zones -> measuredTarget; invalid entry/target -> null', () => {
    assertEqual(tp1Ahead('long', 200, 210, {}), 210, 'no zones -> measuredTarget');
    assertEqual(tp1Ahead('long', NaN, 210, {}), null, 'invalid entry -> null');
    assertEqual(tp1Ahead('long', 200, NaN, {}), null, 'invalid measuredTarget -> null');
  });

  // ============ mergeZones ============
  await test('mergeZones: flattens one zone key across every geometryContext timeframe', () => {
    const geometryContext = {
      '5m': { horizontalSupportZones: [{ low: 100, high: 101 }], horizontalResistanceZones: [{ low: 110, high: 111 }] },
      '15m': { horizontalSupportZones: [{ low: 95, high: 96 }], horizontalResistanceZones: [] },
      '1h': null
    };
    assertEqual(JSON.stringify(mergeZones(geometryContext, 'horizontalSupportZones')), JSON.stringify([{ low: 100, high: 101 }, { low: 95, high: 96 }]), 'support zones merged across timeframes, null tf skipped');
    assertEqual(JSON.stringify(mergeZones(geometryContext, 'horizontalResistanceZones')), JSON.stringify([{ low: 110, high: 111 }]), 'resistance zones merged');
    assertEqual(JSON.stringify(mergeZones(null, 'horizontalSupportZones')), '[]', 'null geometryContext -> empty array');
    assertEqual(JSON.stringify(mergeZones({}, 'horizontalSupportZones')), '[]', 'empty geometryContext -> empty array');
  });

  // ============ buildRow ============
  function baseCandidate(over = {}) {
    return {
      type: 'flag',
      candidateId: 'BTC:5m:long:2026-09-24T03:00:00.000Z',
      timeframe: '5m',
      direction: 'long',
      state: 'forming',
      confidence: 70,
      compressionScore: 0.6,
      durationCandles: 2,
      impulseStrength: 3,
      breakoutLevel: 200,
      invalidation: 198,
      measuredTarget: 204,
      ema200Side: 'above',
      ...over
    };
  }

  function baseSymbolPayload(over = {}) {
    return {
      timeframes: {
        '5m': { closedThrough: new Date(T0).toISOString(), stochRsi: { state: 'BULLISH', slopeK: 0.4 } }
      },
      geometryContext: {
        '15m': { horizontalResistanceZones: [{ low: 205, high: 206 }], horizontalSupportZones: [] }
      },
      topDown: { sentiment: 'bull' },
      ...over
    };
  }

  function retestGo5mCandles() {
    // Same shape as test-flag-paths.js's "long retest_go" fixture, on a 5m candidate tf.
    const pre = flat5mBefore(T0, 20);
    const post = [
      { timestamp: T0, open: 199.4, high: 199.7, low: 199.3, close: 199.5 }, // the tightening (forming) candle itself
      { timestamp: T0 + FIVE_MIN, open: 199.6, high: 200.6, low: 199.6, close: 200.5 }, // breakout close
      { timestamp: T0 + 2 * FIVE_MIN, open: 200.5, high: 200.8, low: 200.4, close: 200.6 }
    ];
    return [...pre, ...post];
  }

  // 1m walk starts after the 5m breakout candle closes (T0 + 2 * FIVE_MIN).
  const candles1mForLabel = m1Candles(T0 + 2 * FIVE_MIN, [
    { o: 200.5, h: 200.60, l: 200.40, c: 200.50 },
    { o: 200.50, h: 200.45, l: 200.20, c: 200.25 }, // retest
    { o: 200.25, h: 201.00, l: 200.30, c: 200.90 },
    { o: 200.90, h: 202.00, l: 200.90, c: 201.90 } // target touch (+1R = 202)
  ]);

  await test('buildRow: wires labelPath + featuresAt into one row', () => {
    const candidate = baseCandidate();
    const s = baseSymbolPayload();
    const fullByTf = { '5m': retestGo5mCandles(), '1m': candles1mForLabel };
    const row = buildRow('BTC', candidate, s, [candidate], fullByTf, {});
    assert(row !== null, 'row built');
    assertEqual(row.symbol, 'BTC');
    assertEqual(row.candidateId, candidate.candidateId);
    assertEqual(row.timeframe, '5m');
    assert(PATHS.includes(row.path), `path ${row.path} is one of PATHS`);
    assertEqual(row.path, 'retest_go', 'the fixture is the same shape as test-flag-paths.js\'s retest_go case');
    assertEqual(row.features.tf, '5m', 'features.tf passthrough');
    assertEqual(row.features.direction, 'long', 'features.direction passthrough');
    assertEqual(row.features.stochSide, 'bullish', 'stochRsi.state lowercased');
    assertEqual(row.features.stochSlope, 'rising', 'positive slopeK -> rising');
    assertEqual(row.features.tdSide, 'bull', 'topDown.sentiment passthrough');
    assertEqual(row.features.ema200Side, 'above', 'candidate.ema200Side passthrough');
    assertEqual(row.roomR, 2.5, '(205-200)/2 ahead resistance edge');
    assertEqual(row.features.roomR, 'moderate', 'roomR 2.5 buckets moderate (edges [1,3])');
    assert(typeof row.atrValue === 'number' && row.atrValue > 0, 'atrValue computed from the pre-tightening candles');
  });

  await test('buildRow: wires the T5 additions (divergence, atLevel, sweepReclaim, counterTrend) from s.model/s.geometryContext/s.biasMatrix', () => {
    const candidate = baseCandidate(); // invalidation 198, direction long
    const s = baseSymbolPayload({
      geometryContext: {
        '15m': { horizontalResistanceZones: [{ low: 205, high: 206 }], horizontalSupportZones: [{ low: 197.9, high: 198.0 }] }
      },
      model: { divergence: { byTimeframe: { '5m': { type: 'bullish', strength: 0.6 } } } },
      biasMatrix: { '4h': { bias: 'short', strength: 40, basis: [] } }
    });
    const fullByTf = { '5m': retestGo5mCandles(), '1m': candles1mForLabel };
    const row = buildRow('BTC', candidate, s, [candidate], fullByTf, {});
    assertEqual(row.features.divergence, 'agrees', 'long candidate + fresh bullish divergence on its own tf -> agrees');
    assertEqual(row.features.atLevel, 'yes', 'invalidation 198 sits inside the 197.9-198.0 support zone -> yes');
    assertEqual(row.features.sweepReclaim, 'no', 'none of the fixture candles wick below invalidation 198 -> no, not unknown');
    assertEqual(row.features.counterTrend, 'yes', '4h short vs a long candidate -> yes');
  });

  await test('buildRow: T5 additions default to unknown when s.model/s.biasMatrix are absent (includeModel/includeBias off)', () => {
    const candidate = baseCandidate();
    const s = baseSymbolPayload(); // no s.model, no s.biasMatrix
    const fullByTf = { '5m': retestGo5mCandles(), '1m': candles1mForLabel };
    const row = buildRow('BTC', candidate, s, [candidate], fullByTf, {});
    assertEqual(row.features.divergence, 'unknown', 'no s.model -> divergence unknown');
    assertEqual(row.features.counterTrend, 'unknown', 'no s.biasMatrix -> counterTrend unknown');
  });

  await test('buildRow: tighteningClose is the tightening candle\'s own close (candlesTfAsOf\'s last row, by CLOSE time)', () => {
    // closedRows cuts off by CLOSE time (candle.timestamp + intervalMs when no explicit
    // closeTime field, scripts/replay.js's closeTimeOf) - so the candle whose close time
    // equals fromMs (closedThrough) is one candle EARLIER (by timestamp) than fromMs
    // itself, not the candle whose own `timestamp` equals fromMs.
    const preCandles = flat5mBefore(T0 - FIVE_MIN, 20); // ends right before the tightening candle
    const tighteningCandle = { timestamp: T0 - FIVE_MIN, open: 199.0, high: 199.6, low: 198.8, close: 199.45 }; // closeTime = T0
    const post = [
      { timestamp: T0, open: 199.6, high: 200.6, low: 199.6, close: 200.5 }, // opens at fromMs, closes after it - excluded from "as of"
      { timestamp: T0 + FIVE_MIN, open: 200.5, high: 200.8, low: 200.4, close: 200.6 }
    ];
    const candlesTf = [...preCandles, tighteningCandle, ...post];
    const candidate = baseCandidate();
    const s = baseSymbolPayload();
    const row = buildRow('BTC', candidate, s, [candidate], { '5m': candlesTf, '1m': candles1mForLabel }, {});
    assertEqual(row.tighteningClose, 199.45, 'tighteningClose is the candle whose CLOSE time equals fromMs');
  });

  await test('buildRow: tp1Cap wires tp1Ahead(direction, breakoutLevel, measuredTarget, geometryContext)', () => {
    const candidate = baseCandidate(); // breakoutLevel 200, measuredTarget 204
    const s = baseSymbolPayload({ geometryContext: { '15m': { horizontalResistanceZones: [{ low: 202, high: 203 }], horizontalSupportZones: [] } } });
    const row = buildRow('BTC', candidate, s, [candidate], { '5m': retestGo5mCandles(), '1m': candles1mForLabel }, {});
    assertEqual(row.tp1Cap, 202, 'nearest resistance edge (202) sits short of measuredTarget (204) -> capped TP1');
  });

  await test('buildRow: missing/invalid closedThrough for the candidate\'s own timeframe -> null', () => {
    const candidate = baseCandidate();
    const s = baseSymbolPayload({ timeframes: { '5m': { closedThrough: null, stochRsi: {} } } });
    const row = buildRow('BTC', candidate, s, [candidate], { '5m': retestGo5mCandles(), '1m': candles1mForLabel }, {});
    assertEqual(row, null, 'no fromMs, no row');
  });

  await test('buildRow: tfAgreement true when another flag timeframe has a live same-direction candidate', () => {
    const candidate = baseCandidate();
    const other = { type: 'flag', timeframe: '1m', direction: 'long', state: 'triggering' };
    const s = baseSymbolPayload();
    const row = buildRow('BTC', candidate, s, [candidate, other], { '5m': retestGo5mCandles(), '1m': candles1mForLabel }, {});
    assertEqual(row.features.tfAgreement, 'agree', 'a live same-direction candidate on another tf');
  });

  await test('buildRow: tfAgreement disagree when the other timeframe candidate has failed', () => {
    const candidate = baseCandidate();
    const other = { type: 'flag', timeframe: '1m', direction: 'long', state: 'failed' };
    const s = baseSymbolPayload();
    const row = buildRow('BTC', candidate, s, [candidate, other], { '5m': retestGo5mCandles(), '1m': candles1mForLabel }, {});
    assertEqual(row.features.tfAgreement, 'disagree', 'a failed candidate on another tf is not "live" agreement');
  });

  await test('buildRow: no lookahead - a candle closing after fromMs never affects the "as of" ATR read', () => {
    const candidate = baseCandidate();
    const s = baseSymbolPayload();
    const baseline = retestGo5mCandles();
    const withFutureOutlier = [
      ...baseline,
      // opens exactly at fromMs (T0) -> closes at T0+5m, strictly after fromMs -> must be excluded
      { timestamp: T0, open: 9000, high: 9999, low: 8000, close: 9500 }
    ];
    const rowA = buildRow('BTC', candidate, s, [candidate], { '5m': baseline, '1m': candles1mForLabel }, {});
    const rowB = buildRow('BTC', candidate, s, [candidate], { '5m': withFutureOutlier, '1m': candles1mForLabel }, {});
    assertEqual(rowB.atrValue, rowA.atrValue, 'a future-closing candle must not change the tightening-point ATR read');
  });

  // ============ runSymbol: first-tightening dedup ============
  function flagCandidate(id, tf, direction, state, over = {}) {
    return { type: 'flag', candidateId: id, timeframe: tf, direction, state, breakoutLevel: 200, invalidation: 198, measuredTarget: 204, compressionScore: 0.5, durationCandles: 1, impulseStrength: 2, confidence: 60, ...over };
  }

  function payloadFor(symbol, candidates, closedThroughIso) {
    return {
      symbols: {
        [symbol]: {
          timeframes: { '5m': { closedThrough: closedThroughIso, stochRsi: {} } },
          geometryContext: {},
          topDown: null,
          candidateSetups: candidates
        }
      }
    };
  }

  await test('runSymbol: takes only the FIRST tick a candidateId reads forming/proto', async () => {
    const id = 'BTC:5m:long:2026-09-24T03:00:00.000Z';
    const tick0 = T0;
    const tick1 = T0 + FIVE_MIN;
    const byTick = new Map([
      [tick0, payloadFor('BTC', [flagCandidate(id, '5m', 'long', 'forming', { compressionScore: 0.11 })], new Date(tick0).toISOString())],
      // same candidateId, still forming one tick later, with a DIFFERENT compressionScore -
      // if this were picked instead, the test below would see 0.99, not 0.11
      [tick1, payloadFor('BTC', [flagCandidate(id, '5m', 'long', 'forming', { compressionScore: 0.99 })], new Date(tick1).toISOString())]
    ]);
    const buildFn = async (symbol, historyByTf, cutMs) => byTick.get(cutMs);
    const { rows } = await runSymbol('BTC', { '1m': [], '5m': retestGo5mCandles() }, [tick0, tick1], {}, buildFn);
    assertEqual(rows.length, 1, 'one row for the one distinct candidateId');
    assertEqual(rows[0].compressionScore, 0.11, 'the FIRST tightening tick\'s snapshot, not the second');
  });

  await test('runSymbol: a candidate that reaches confirmed without ever being seen forming/proto produces no row', async () => {
    const byTick = new Map([
      [T0, payloadFor('BTC', [flagCandidate('BTC:5m:long:x', '5m', 'long', 'confirmed')], new Date(T0).toISOString())]
    ]);
    const buildFn = async (symbol, historyByTf, cutMs) => byTick.get(cutMs);
    const { rows } = await runSymbol('BTC', { '1m': [], '5m': retestGo5mCandles() }, [T0], {}, buildFn);
    assertEqual(rows.length, 0, 'never seen forming/proto -> not labelled');
  });

  await test('runSymbol: non-flag candidates (coils) are ignored even if state is forming', async () => {
    const byTick = new Map([
      [T0, payloadFor('BTC', [{ type: 'coil', candidateId: 'c1', timeframe: '5m', direction: 'neutral', state: 'forming' }], new Date(T0).toISOString())]
    ]);
    const buildFn = async (symbol, historyByTf, cutMs) => byTick.get(cutMs);
    const { rows } = await runSymbol('BTC', { '1m': [], '5m': retestGo5mCandles() }, [T0], {}, buildFn);
    assertEqual(rows.length, 0, 'type:coil is never a flag path row');
  });

  await test('runSymbol: a candidate with no candidateId is skipped', async () => {
    const byTick = new Map([
      [T0, payloadFor('BTC', [flagCandidate(null, '5m', 'long', 'forming')], new Date(T0).toISOString())]
    ]);
    const buildFn = async (symbol, historyByTf, cutMs) => byTick.get(cutMs);
    const { rows } = await runSymbol('BTC', { '1m': [], '5m': retestGo5mCandles() }, [T0], {}, buildFn);
    assertEqual(rows.length, 0, 'no candidateId -> no stable identity to key on');
  });

  // ============ computeTicks ============
  await test('computeTicks: explicitCloses bypasses the eligibility scan and applies step', async () => {
    const closes = [T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN, T0 + 4 * MIN];
    const ticks = await computeTicks({}, { explicitCloses: closes, step: 2 });
    assertEqual(JSON.stringify(ticks), JSON.stringify([closes[0], closes[2], closes[4]]), 'every 2nd close');
  });

  await test('computeTicks: from/to bounds filter the explicit close list', async () => {
    const closes = [T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN, T0 + 4 * MIN];
    const ticks = await computeTicks({}, { explicitCloses: closes, from: closes[1], to: closes[3], step: 1 });
    assertEqual(JSON.stringify(ticks), JSON.stringify([closes[1], closes[2], closes[3]]), 'inclusive from/to');
  });

  // ============ buildReport ============
  await test('buildReport: overall/byTfDir/byFeature/topCombos shapes and the calibrated split', () => {
    const rows = [];
    const mk = (path, tf, direction, compression, roomRBucket) => ({ timeframe: tf, direction, path, features: { compression, tf, direction, roomR: roomRBucket } });
    for (let i = 0; i < 60; i++) rows.push(mk('runner', '5m', 'long', 'tight', 'roomy'));
    for (let i = 0; i < 40; i++) rows.push(mk('retest_go', '5m', 'long', 'tight', 'roomy'));
    for (let i = 0; i < 5; i++) rows.push(mk('chop', '1m', 'short', 'loose', 'tight'));

    const report = buildReport(rows, 100);
    assertEqual(report.rowCount, 105, 'rowCount');
    const overallAll = report.overall.find((t) => t.key === 'all');
    assertEqual(overallAll.n, 105, 'overall n');
    assertEqual(overallAll.calibrated, true, 'overall calibrated at n=105 >= 100');

    const fiveLong = report.byTfDir.find((t) => t.key === '5m:long');
    assertEqual(fiveLong.n, 100, '5m:long n');
    assertEqual(fiveLong.calibrated, true, '5m:long calibrated');
    const oneShort = report.byTfDir.find((t) => t.key === '1m:short');
    assertEqual(oneShort.calibrated, false, '1m:short uncalibrated (n=5 < 100)');

    assert(Object.keys(report.byFeature).includes('compression'), 'byFeature has a compression table');
    const tight = report.byFeature.compression.find((t) => t.key === 'tight');
    assertEqual(tight.n, 100, 'compression=tight n');
    assertEqual(tight.shares.runner, 60, 'compression=tight runner share pct');

    assert(report.topCombos.length > 0, 'top combos produced');
    assert(report.topCombos.every((c, i) => i === 0 || report.topCombos[i - 1].n >= c.n), 'topCombos sorted by n descending');
    const topCombo = report.topCombos[0];
    assertEqual(topCombo.n, 100, 'the largest combo bucket is the compression=tight/roomR=roomy 100-row group');
  });

  await test('buildReport: empty rows -> empty tables, no throw', () => {
    const report = buildReport([], 100);
    assertEqual(report.rowCount, 0, 'rowCount 0');
    assertEqual(report.overall.length, 0, 'no overall group for zero rows');
    assertEqual(Object.keys(report.byFeature).length, 0, 'no feature names to group on');
    assertEqual(report.topCombos.length, 0, 'no combos');
  });

  // ============ parseArgs ============
  await test('parseArgs: flags parsed, defaults applied', () => {
    const a = parseArgs(['--history', 'dir', '--symbols', 'BTC,SOL', '--step', '5', '--report', '--min-n', '50']);
    assertEqual(a.history, 'dir');
    assertEqual(JSON.stringify(a.symbols), JSON.stringify(['BTC', 'SOL']));
    assertEqual(a.step, 5);
    assertEqual(a.report, true);
    assertEqual(a.minN, 50);
    assertEqual(a.out, null, 'no --out given');
  });

  await test('parseArgs: defaults with no flags', () => {
    const a = parseArgs([]);
    assertEqual(a.step, 1, 'default step');
    assertEqual(a.minN, 100, 'default minN');
    assertEqual(a.report, false, 'default report');
    assertEqual(a.symbols, null, 'default symbols');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failed:', failures.join(', '));
    process.exit(1);
  }
})();
