/**
 * Deterministic tests for lib/modelEvidence.js (review fix pass, items 2-4 + nit 15):
 * Stoch history offset, most-recent divergence selection, stale divergence excluded
 * from confluence, channel breakoutRisk for fades and for no direction, and the weekly
 * `unavailable` reasons. Every behaviour is checked long and short (mirrored series).
 *
 * Run: node test-model-evidence.js
 */

import {
  buildDivergenceEvidence,
  buildChannelEvidence,
  buildMaEvidence,
  buildModelEvidence
} from './lib/modelEvidence.js';
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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const T0 = Date.UTC(2026, 8, 23, 0, 0, 0);

/**
 * Flat 100 baseline candles (no pivots) with dips (swing lows) and spikes (swing highs)
 * at the given indexes. `invert` mirrors every price around 100 (lows <-> highs).
 */
function series(count, { dips = {}, spikes = {} } = {}, invert = false) {
  const closes = new Array(count).fill(100);
  for (const [i, low] of Object.entries(dips)) {
    const idx = Number(i);
    closes[idx] = low;
    closes[idx - 1] = Math.min(closes[idx - 1], (100 + low) / 2);
    closes[idx + 1] = Math.min(closes[idx + 1], (100 + low) / 2);
  }
  for (const [i, high] of Object.entries(spikes)) {
    const idx = Number(i);
    closes[idx] = high;
    closes[idx - 1] = Math.max(closes[idx - 1], (100 + high) / 2);
    closes[idx + 1] = Math.max(closes[idx + 1], (100 + high) / 2);
  }
  return closes.map((c0, i) => {
    const c = invert ? 200 - c0 : c0;
    return { timestamp: T0 + i * 60000, open: c, high: c + 0.5, low: c - 0.5, close: c, closeTime: T0 + (i + 1) * 60000 };
  });
}

/** Stoch history of `length` entries, default k=50, with overrides by HISTORY index. */
function stoch(length, overrides = {}, invert = false) {
  return Array.from({ length }, (_, i) => {
    const k = overrides[i] ?? 50;
    return { k: invert ? 100 - k : k, d: 50 };
  });
}

function divergence1m(candles, history, cfg) {
  return buildDivergenceEvidence({ closedByTf: { '1m': candles }, seriesByTf: { '1m': { stochHistory: history } }, cfg });
}

async function run() {
  console.log('\nlib/modelEvidence.js\n');

  await test('item 2: Stoch history shorter than candles is offset from the END; a pre-history pivot gets no value (long)', () => {
    // 40 candles, 25 Stoch values -> offset 15. Lows at 10 (pre-history), 22, 32.
    const candles = series(40, { dips: { 10: 95, 22: 94, 32: 93 } });
    const history = stoch(25, { [22 - 15]: 20, [32 - 15]: 40, 10: 60, 22: 70 });
    const div = divergence1m(candles, history).byTimeframe['1m'];
    assertEqual(div.type, 'bullish', 'type');
    assertEqual(div.kind, 'standard', 'kind');
    assertEqual(div.pivots.map((p) => p.index), [22, 32], 'pivot pair uses only pivots inside the Stoch history');
    assertEqual(div.pivots.map((p) => p.stoch), [20, 40], 'stoch read at candle index - offset, not candle index');
  });

  await test('item 2 mirror: inverted prices and Stoch -> bearish on the same offset pivots (short)', () => {
    const candles = series(40, { dips: { 10: 95, 22: 94, 32: 93 } }, true);
    const history = stoch(25, { [22 - 15]: 20, [32 - 15]: 40, 10: 60, 22: 70 }, true);
    const div = divergence1m(candles, history).byTimeframe['1m'];
    assertEqual(div.type, 'bearish', 'type');
    assertEqual(div.pivots.map((p) => p.index), [22, 32], 'pivots');
    assertEqual(div.pivots.map((p) => p.stoch), [80, 60], 'stoch');
  });

  await test('item 3: a newer bearish pair wins over an older bullish pair (most recent pivot pair)', () => {
    // Bullish lows pair ends at 20; bearish highs pair ends at 34.
    const candles = series(40, { dips: { 10: 95, 20: 94 }, spikes: { 26: 105, 34: 106 } });
    const history = stoch(40, { 10: 20, 20: 40, 26: 80, 34: 60 });
    const div = divergence1m(candles, history).byTimeframe['1m'];
    assertEqual(div.type, 'bearish', 'type');
    assertEqual(div.pivots.map((p) => p.index), [26, 34], 'pivots');
  });

  await test('item 3 mirror: inverted series -> the newer pair reads bullish', () => {
    const candles = series(40, { dips: { 10: 95, 20: 94 }, spikes: { 26: 105, 34: 106 } }, true);
    const history = stoch(40, { 10: 20, 20: 40, 26: 80, 34: 60 }, true);
    const div = divergence1m(candles, history).byTimeframe['1m'];
    assertEqual(div.type, 'bullish', 'type');
    assertEqual(div.pivots.map((p) => p.index), [26, 34], 'pivots');
  });

  await test('item 3: a stale divergence (strength 0) is reported but never counted as confluence (long + short)', () => {
    const cfg = { ...ENGINE_CONFIG.model, divergenceMaxAgeCandles: 3 };
    for (const invert of [false, true]) {
      const candles = series(40, { dips: { 10: 95, 20: 94 } }, invert);
      const history = stoch(40, { 10: 20, 20: 40 }, invert);
      const ev = divergence1m(candles, history, cfg);
      assertEqual(ev.byTimeframe['1m'].type, invert ? 'bearish' : 'bullish', 'type still reported');
      assertEqual(ev.byTimeframe['1m'].strength, 0, 'strength');
      assertEqual(ev.confluence, { bullish: 0, bearish: 0 }, 'confluence');
    }
    const fresh = divergence1m(series(40, { dips: { 10: 95, 20: 94 } }), stoch(40, { 10: 20, 20: 40 }));
    assertEqual(fresh.confluence, { bullish: 1, bearish: 0 }, 'fresh divergence counts');
  });

  const channelAt = (positionPct) => ({ '15m': { channel: { top: 110, bottom: 90, positionPct }, horizontalResistanceZones: [{ low: 105, high: 106 }], horizontalSupportZones: [{ low: 94, high: 95 }], confluenceZones: [] } });

  await test('item 4: fade against sentiment is high breakout risk (short at top in bull; long at bottom in bear)', () => {
    const shortTop = buildChannelEvidence({ direction: 'short', price: 108, geometryContext: channelAt(90), topDown: { sentiment: 'bull' } });
    assertEqual(shortTop.channels['15m'].breakoutRisk, 'high', 'short at top, bull sentiment');
    const longBottom = buildChannelEvidence({ direction: 'long', price: 92, geometryContext: channelAt(10), topDown: { sentiment: 'bear' } });
    assertEqual(longBottom.channels['15m'].breakoutRisk, 'high', 'long at bottom, bear sentiment');
    const shortTopBear = buildChannelEvidence({ direction: 'short', price: 108, geometryContext: channelAt(90), topDown: { sentiment: 'bear' } });
    assertEqual(shortTopBear.channels['15m'].breakoutRisk, 'low', 'short at top WITH bear sentiment is not a fade against it');
  });

  await test('item 4: no direction -> breakoutRisk unknown and no levels ahead (no long-side default)', () => {
    const ev = buildChannelEvidence({ direction: undefined, price: 100, geometryContext: channelAt(50), topDown: { sentiment: 'bull' } });
    assertEqual(ev.channels['15m'].breakoutRisk, 'unknown', 'breakoutRisk');
    assertEqual(ev.levelsAhead, [], 'levelsAhead');
    assertEqual(ev.nearestLevelAhead, null, 'nearestLevelAhead');
    const model = buildModelEvidence({ tfEntries: {}, seriesByTf: {}, closedByTf: {}, candidateSetups: [], flagTradePlan: null, geometryContext: channelAt(50), topDown: { sentiment: 'bull' }, price: 100, now: T0 });
    assertEqual(model.channels.nearestLevelAhead, null, 'buildModelEvidence with no plan and no candidate');
    assertEqual(model.channels.channels['15m'].breakoutRisk, 'unknown', 'buildModelEvidence breakoutRisk');
  });

  await test('nit 15: weekly EMA21 gap is filed under ema21, never under ema200', () => {
    const missing = buildMaEvidence({ tfEntries: {}, seriesByTf: {}, now: T0, topDown: { weekly: { close: 100, ema21: null, ema21Slope: null, reason: 'insufficient history for weekly EMA21' } } });
    assertEqual(missing.map['1w'].unavailable, { ema21: 'insufficient history for weekly EMA21', ema200: 'insufficient_weekly_history' }, 'EMA21 missing');
    const has21 = buildMaEvidence({ tfEntries: {}, seriesByTf: {}, now: T0, topDown: { weekly: { close: 100, ema21: 98, ema21Slope: 1, reason: 'insufficient history for weekly EMA200' } } });
    assertEqual(has21.map['1w'].unavailable, { ema21: null, ema200: 'insufficient history for weekly EMA200' }, 'EMA21 present');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\nFailed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
