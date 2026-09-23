/**
 * Deterministic, zero-network test suite for lib/biasMatrix.js (phase 9b).
 *
 * Every scenario is a hand-built market (per-timeframe fields + geometry) and its mirror:
 * prices reflected around PIVOT, trends/slopes/stoch/structure flipped, channel position
 * p -> 100 - p. The mirror must give the mirrored matrix, alignment and decision inputs
 * with identical numbers.
 *
 * Run: node test-bias-matrix.js
 */

import { readFileSync } from 'node:fs';
import { ENGINE_CONFIG } from './config/engine.js';
import {
  timeframeBias,
  buildBiasMatrix,
  buildAlignment,
  buildDecisionInputs,
  zonesFromGeometry,
  biasTraceSummary,
  BIAS_TIMEFRAMES
} from './lib/biasMatrix.js';

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
// Market builders
// ---------------------------------------------------------------------------

const PIVOT = 100;
const CFG = ENGINE_CONFIG.bias;

/** A timeframe leaning `dir` (1 long, -1 short, 0 flat) on every signal. */
function leaning(dir, over = {}) {
  const trend = dir === 1 ? 'UPTREND' : (dir === -1 ? 'DOWNTREND' : 'FLAT');
  return {
    tf: {
      trend,
      ema21: PIVOT - dir * 1,
      ema200: PIVOT - dir * 5,
      priceVs21Pct: dir * 1,
      stochRsi: { state: dir === 1 ? 'BULLISH' : (dir === -1 ? 'BEARISH' : 'NEUTRAL') },
      ...over.tf
    },
    g: {
      atr: 1,
      ema21Slope: dir * 0.02,
      ema200Slope: dir * 0.01,
      higherLows: { active: dir === 1, count: dir === 1 ? 2 : 0 },
      lowerHighs: { active: dir === -1, count: dir === -1 ? 2 : 0 },
      channel: { detected: false },
      horizontalSupportZones: [],
      horizontalResistanceZones: [],
      confluenceZones: [],
      ...over.g
    }
  };
}

function market(parts) {
  const timeframes = {};
  const geometry = {};
  for (const [tf, p] of Object.entries(parts)) {
    timeframes[tf] = p.tf;
    geometry[tf] = p.g;
  }
  return { price: PIVOT, timeframes, geometry };
}

const flipTrend = { UPTREND: 'DOWNTREND', DOWNTREND: 'UPTREND' };
const flipStoch = { BULLISH: 'BEARISH', BEARISH: 'BULLISH', OVERBOUGHT: 'OVERSOLD', OVERSOLD: 'OVERBOUGHT' };
const mz = (z) => ({ ...z, low: 2 * PIVOT - z.high, high: 2 * PIVOT - z.low });
const neg = (v) => (typeof v === 'number' ? -v : v);

/** Mirror a market around PIVOT: the short twin of a long market. */
function mirrorMarket(m) {
  const timeframes = {};
  const geometry = {};
  for (const [tf, t] of Object.entries(m.timeframes)) {
    timeframes[tf] = {
      ...t,
      trend: flipTrend[t.trend] || t.trend,
      ema21: 2 * PIVOT - t.ema21,
      ema200: 2 * PIVOT - t.ema200,
      priceVs21Pct: neg(t.priceVs21Pct),
      stochRsi: { ...t.stochRsi, state: flipStoch[t.stochRsi.state] || t.stochRsi.state }
    };
  }
  for (const [tf, g] of Object.entries(m.geometry)) {
    geometry[tf] = {
      ...g,
      ema21Slope: neg(g.ema21Slope),
      ema200Slope: neg(g.ema200Slope),
      higherLows: g.lowerHighs,
      lowerHighs: g.higherLows,
      channel: g.channel.detected ? { ...g.channel, positionPct: 100 - g.channel.positionPct } : g.channel,
      horizontalSupportZones: g.horizontalResistanceZones.map(mz),
      horizontalResistanceZones: g.horizontalSupportZones.map(mz),
      confluenceZones: g.confluenceZones.map(mz)
    };
  }
  return { price: 2 * PIVOT - m.price, timeframes, geometry };
}

const flipDir = { long: 'short', short: 'long', neutral: 'neutral' };
const flipToken = {
  'trend:up': 'trend:down', 'ema21>ema200': 'ema21<ema200', 'price>ema21': 'price<ema21', 'ema:rising': 'ema:falling',
  higherLows: 'lowerHighs', 'channel:bottom': 'channel:top', 'stoch:bullish': 'stoch:bearish'
};
for (const [a, b] of Object.entries(flipToken)) flipToken[b] = a;

function evaluate(m, candidates, strategies = {}, cfg = CFG) {
  const matrix = buildBiasMatrix(m.timeframes, m.geometry, cfg);
  const alignment = buildAlignment({ price: m.price, candidates, strategies, matrix, zonesByTf: zonesFromGeometry(m.geometry) }, cfg);
  const decisionInputs = buildDecisionInputs(matrix, cfg);
  return { matrix, alignment, decisionInputs };
}

/** Assert r2 is the mirror of r1: labels flipped, every number identical. */
function assertMirrored(r1, r2, label) {
  for (const tf of BIAS_TIMEFRAMES) {
    const a = r1.matrix[tf];
    const b = r2.matrix[tf];
    if (!a) { assertEqual(b, null, `${label} ${tf} null`); continue; }
    assertEqual(b.bias, flipDir[a.bias], `${label} ${tf} bias`);
    assertEqual(b.strength, a.strength, `${label} ${tf} strength`);
    assertEqual(JSON.stringify(b.basis), JSON.stringify(a.basis.map((t) => flipToken[t])), `${label} ${tf} basis`);
  }
  assertEqual(r2.alignment.length, r1.alignment.length, `${label} alignment length`);
  r1.alignment.forEach((a, i) => {
    const b = r2.alignment[i];
    assertEqual(b.direction, flipDir[a.direction], `${label} direction`);
    assertEqual(b.htfBias, flipDir[a.htfBias], `${label} htfBias`);
    for (const k of ['withTrend', 'counterTrend', 'htfBiasStrength', 'nearestHtfZoneDistancePct', 'room', 'roomTooSmall', 'executionTf']) {
      assertEqual(b[k], a[k], `${label} alignment.${k}`);
    }
  });
  for (const h of ['scalp', 'swing']) {
    const a = r1.decisionInputs.directionalBias[h];
    const b = r2.decisionInputs.directionalBias[h];
    assertEqual(JSON.stringify(b), JSON.stringify({ long: a.short, short: a.long, neutral: a.neutral }), `${label} ${h} triple`);
  }
}

/** HTF uptrend on 15m/1h/4h/1d with zones; `oneMinute` overrides the 1m read. */
function htfUptrend(oneMinute, zones = {}) {
  return market({
    '1m': oneMinute,
    '3m': leaning(0),
    '5m': leaning(0),
    '15m': leaning(1, { g: { atr: 0.3, horizontalSupportZones: zones.support15m || [{ low: 99.2, high: 99.4 }] } }),
    '1h': leaning(1, { g: { atr: 0.8, horizontalSupportZones: [{ low: 98.5, high: 99 }] } }),
    '4h': leaning(1, { g: { atr: 1.5, horizontalSupportZones: [{ low: 97, high: 97.5 }], horizontalResistanceZones: zones.resistance4h || [{ low: 110, high: 111 }] } }),
    '1d': leaning(1, { g: { atr: 3 } })
  });
}

/** 1m at the top of a channel with a lower high forming, stoch rolling over. */
const oneMinuteAtTop = leaning(0, { tf: { stochRsi: { state: 'BEARISH' } }, g: { channel: { detected: true, positionPct: 95 }, lowerHighs: { active: true, count: 1 }, higherLows: { active: false, count: 0 } } });
/** 1m at the bottom of a channel, on HTF support, higher low forming. */
const oneMinuteAtBottom = leaning(0, { tf: { stochRsi: { state: 'BULLISH' } }, g: { channel: { detected: true, positionPct: 5 }, higherLows: { active: true, count: 1 }, lowerHighs: { active: false, count: 0 } } });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('\n1) timeframeBias');

  await test('every signal long → long 100; every signal short → short 100; flat → neutral, no basis', () => {
    const up = timeframeBias(leaning(1).tf, leaning(1).g);
    assertEqual(up.bias, 'long', 'long');
    assertEqual(up.strength, 100, 'strength');
    assertEqual(JSON.stringify(up.basis), JSON.stringify(['trend:up', 'ema21>ema200', 'price>ema21', 'ema:rising', 'higherLows', 'stoch:bullish']), 'basis');
    const down = timeframeBias(leaning(-1).tf, leaning(-1).g);
    assertEqual(down.bias, 'short', 'short');
    assertEqual(down.strength, 100, 'strength');
    const flat = timeframeBias({ trend: 'FLAT', ema21: 100, ema200: 100, priceVs21Pct: 0, stochRsi: { state: 'NEUTRAL' } }, null);
    assertEqual(flat.bias, 'neutral', 'neutral');
    assertEqual(flat.strength, 0, 'flat strength');
    assertEqual(flat.basis.length, 0, 'no basis');
  });

  await test(`mixed signals under neutralBelow (${CFG.neutralBelow}) read neutral with their strength; missing inputs are left out of the denominator`, () => {
    // trend up (2) vs ema stack down (1) + price below ema21 (1): score 0 → neutral.
    const mixed = timeframeBias({ trend: 'UPTREND', ema21: 99, ema200: 100, priceVs21Pct: -0.1, stochRsi: null }, null);
    assertEqual(mixed.bias, 'neutral', 'mixed');
    assertEqual(mixed.strength, 0, 'strength');
    const trendOnly = timeframeBias({ trend: 'UPTREND' }, null);
    assertEqual(trendOnly.strength, 100, 'one measurable signal decides alone');
    assertEqual(timeframeBias(null, null), null, 'no data → null');
  });

  await test('channel edge: bottom leans long, top leans short, middle measured but no lean (mirror symmetric)', () => {
    const base = { trend: 'FLAT' };
    const at = (p) => timeframeBias(base, { channel: { detected: true, positionPct: p } });
    assert(at(CFG.channelEdgePct).basis.includes('channel:bottom'), 'bottom');
    assert(at(100 - CFG.channelEdgePct).basis.includes('channel:top'), 'top');
    assertEqual(at(50).basis.length, 0, 'middle');
    assertEqual(at(10).strength, at(90).strength, 'mirror strength');
  });

  console.log('\n2) Plan scenarios (each with its full mirror)');

  await test('4h uptrend + 1m at channel top with lower high → short candidate counterTrend, HTF support distance and room populated; swing long unchanged by the 1m', () => {
    const m = htfUptrend(oneMinuteAtTop);
    const r = evaluate(m, [{ timeframe: '1m', direction: 'short', state: 'forming' }]);
    assertEqual(r.matrix['4h'].bias, 'long', '4h long');
    assertEqual(r.matrix['1m'].bias, 'short', `1m leans short at the channel top: ${JSON.stringify(r.matrix['1m'])}`);
    const a = r.alignment[0];
    assertEqual(a.ref, '1m:short:forming', 'ref');
    assertEqual(a.counterTrend, true, 'counterTrend');
    assertEqual(a.withTrend, false, 'withTrend');
    assertEqual(a.htfBias, 'long', 'htfBias');
    assertEqual(JSON.stringify(a.contextTfs), JSON.stringify(['15m', '1h', '4h']), 'contextTfs');
    assertEqual(a.nearestHtfZoneDistancePct, 0.6, 'nearest HTF support below (15m zone top 99.4)');
    assertEqual(a.room, 2, '0.6 / 15m ATR 0.3');
    assertEqual(a.roomTooSmall, false, 'room ≥ minRoomAtr');
    const swing = r.decisionInputs.directionalBias.swing;
    assert(swing.long > swing.short, `swing long: ${JSON.stringify(swing)}`);
    const other = evaluate(htfUptrend(oneMinuteAtBottom), []);
    assertEqual(JSON.stringify(other.decisionInputs.directionalBias.swing), JSON.stringify(swing), 'swing horizon ignores the 1m');
    assertMirrored(r, evaluate(mirrorMarket(m), [{ timeframe: '1m', direction: 'long', state: 'forming' }]), 'mirror (4h downtrend, 1m at channel bottom, long counter-trend)');
  });

  await test('4h uptrend + 1m at channel bottom on HTF support → long candidate withTrend, room large (and mirror)', () => {
    const m = htfUptrend(oneMinuteAtBottom, { support15m: [{ low: 99.8, high: 100.1 }] });
    const r = evaluate(m, [{ timeframe: '1m', direction: 'long', state: 'triggering' }]);
    const a = r.alignment[0];
    assertEqual(a.withTrend, true, 'withTrend');
    assertEqual(a.counterTrend, false, 'counterTrend');
    assertEqual(a.nearestHtfZoneDistancePct, 10, 'nearest HTF resistance ahead (4h 110)');
    assertEqual(a.room, 6.67, '10 / 4h ATR 1.5');
    assert(a.room >= 5 * CFG.minRoomAtr, 'large room');
    assertEqual(a.roomTooSmall, false, 'roomTooSmall');
    assertMirrored(r, evaluate(mirrorMarket(m), [{ timeframe: '1m', direction: 'short', state: 'triggering' }]), 'mirror (4h downtrend, short with trend)');
  });

  await test('the two-sided statement in one payload: counter-trend 1m short + with-trend SCALP_1H long, swing long (and mirror)', () => {
    const m = htfUptrend(oneMinuteAtTop);
    const strategies = { SCALP_1H: { valid: true, direction: 'LONG' }, SWING: { valid: false, direction: 'NO_TRADE' } };
    const r = evaluate(m, [{ timeframe: '1m', direction: 'short', state: 'forming' }], strategies);
    assertEqual(r.alignment.length, 2, 'candidate + valid strategy only');
    const [short, long] = r.alignment;
    assertEqual(short.counterTrend, true, 'short counter-trend');
    assertEqual(long.source, 'strategy', 'strategy source');
    assertEqual(long.executionTf, CFG.strategyTimeframes.SCALP_1H, 'SCALP_1H execution timeframe');
    assertEqual(JSON.stringify(long.contextTfs), JSON.stringify(['4h', '1d']), 'context');
    assertEqual(long.withTrend, true, 'long with trend');
    const mStrategies = { SCALP_1H: { valid: true, direction: 'SHORT' }, SWING: { valid: false, direction: 'NO_TRADE' } };
    assertMirrored(r, evaluate(mirrorMarket(m), [{ timeframe: '1m', direction: 'long', state: 'forming' }], mStrategies), 'mirror');
  });

  await test(`HTF zone within minRoomAtr (${CFG.minRoomAtr}) of a counter-trend entry → roomTooSmall (and mirror)`, () => {
    const m = htfUptrend(oneMinuteAtTop, { support15m: [{ low: 99.8, high: 99.9 }] });
    const r = evaluate(m, [{ timeframe: '1m', direction: 'short', state: 'confirmed' }]);
    const a = r.alignment[0];
    assertEqual(a.counterTrend, true, 'counterTrend');
    assertEqual(a.nearestHtfZoneDistancePct, 0.1, 'distance');
    assertEqual(a.room, 0.33, '0.1 / 0.3');
    assertEqual(a.roomTooSmall, true, 'roomTooSmall');
    const inside = evaluate(htfUptrend(oneMinuteAtTop, { support15m: [{ low: 99.9, high: 100.2 }] }), [{ timeframe: '1m', direction: 'short', state: 'forming' }]).alignment[0];
    assertEqual(inside.nearestHtfZoneDistancePct, 0, 'price inside the zone → 0');
    assertEqual(inside.roomTooSmall, true, 'inside the zone');
    assertMirrored(r, evaluate(mirrorMarket(m), [{ timeframe: '1m', direction: 'long', state: 'confirmed' }]), 'mirror');
  });

  console.log('\n3) Alignment details');

  await test('failed candidates are skipped; a neutral coil is neither with nor against trend and has no room', () => {
    const r = evaluate(htfUptrend(oneMinuteAtTop), [
      { timeframe: '1m', direction: 'short', state: 'failed' },
      { timeframe: '3m', direction: 'neutral', state: 'forming', type: 'coil' }
    ]);
    assertEqual(r.alignment.length, 1, 'failed skipped');
    const c = r.alignment[0];
    assertEqual(JSON.stringify([c.withTrend, c.counterTrend, c.room, c.roomTooSmall, c.htfBias]), JSON.stringify([false, false, null, false, 'long']), 'coil');
  });

  await test('no zone ahead → distance and room null, roomTooSmall false; neutral HTF → neither with nor against', () => {
    const m = htfUptrend(oneMinuteAtBottom, { resistance4h: [] });
    const a = evaluate(m, [{ timeframe: '1m', direction: 'long', state: 'forming' }]).alignment[0];
    assertEqual(a.nearestHtfZoneDistancePct, null, 'distance');
    assertEqual(a.room, null, 'room');
    assertEqual(a.roomTooSmall, false, 'roomTooSmall');
    const flat = market({ '1m': leaning(1), '15m': leaning(0), '1h': leaning(0), '4h': leaning(0) });
    const f = evaluate(flat, [{ timeframe: '1m', direction: 'long', state: 'forming' }]).alignment[0];
    assertEqual(f.htfBias, 'neutral', 'neutral htf');
    assertEqual(f.withTrend || f.counterTrend, false, 'neither');
  });

  console.log('\n4) Decision inputs');

  await test('directionalBias triples are integers summing to 100 on both horizons over 500 seeded random markets; mirrors mirror', () => {
    let x = 7;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = () => [1, 0, -1][Math.floor(rnd() * 3)];
    for (let i = 0; i < 500; i++) {
      const parts = {};
      for (const tf of BIAS_TIMEFRAMES) {
        if (rnd() < 0.1) continue; // a missing timeframe
        parts[tf] = leaning(pick(), { tf: { trend: ['UPTREND', 'DOWNTREND', 'FLAT'][Math.floor(rnd() * 3)] }, g: { channel: rnd() < 0.3 ? { detected: true, positionPct: Math.round(rnd() * 100) } : { detected: false } } });
      }
      const m = market(parts);
      const r = evaluate(m, []);
      for (const h of ['scalp', 'swing']) {
        const t = r.decisionInputs.directionalBias[h];
        assert([t.long, t.short, t.neutral].every(Number.isInteger), `integers ${JSON.stringify(t)}`);
        assertEqual(t.long + t.short + t.neutral, 100, `market ${i} ${h}: ${JSON.stringify(t)}`);
      }
      assertMirrored(r, evaluate(mirrorMarket(m), []), `market ${i}`);
    }
  });

  await test('counter-trend penalty: a scalp-horizon lean against the swing horizon loses counterTrendPenalty of its strength to neutral', () => {
    const m = market({ '1m': leaning(-1), '3m': leaning(-1), '5m': leaning(-1), '15m': leaning(0), '1h': leaning(1), '4h': leaning(1), '1d': leaning(1) });
    const withPenalty = evaluate(m, []).decisionInputs.directionalBias.scalp;
    const without = evaluate(m, [], {}, { ...CFG, counterTrendPenalty: 0 }).decisionInputs.directionalBias.scalp;
    assert(withPenalty.short < without.short, `short share falls: ${JSON.stringify([withPenalty, without])}`);
    assert(withPenalty.neutral > without.neutral, 'neutral absorbs it');
    assertEqual(withPenalty.long, without.long, 'with-swing lean untouched');
    // 1m/3m/5m short at 100, weight 1 each, halved: short 1.5; 1h long weight 1; 15m neutral weight 2 + 1.5.
    assertEqual(JSON.stringify(withPenalty), JSON.stringify({ long: 17, short: 25, neutral: 58 }), 'exact numbers');
  });

  await test('trace summary: fixed format, ≤ 120 bytes even at its widest', () => {
    const m = htfUptrend(oneMinuteAtTop);
    const r = evaluate(m, [{ timeframe: '1m', direction: 'short', state: 'forming' }]);
    const s = biasTraceSummary(r.matrix, r.decisionInputs, r.alignment);
    assert(/^scalp:L\d+,S\d+,N\d+\|swing:L\d+,S\d+,N\d+\|tf:1m=S,3m=N,5m=N,15m=L,1h=L,4h=L,1d=L\|ct:1$/.test(s), s);
    const widest = biasTraceSummary(
      Object.fromEntries(BIAS_TIMEFRAMES.map((tf) => [tf, { bias: 'long', strength: 100, basis: [] }])),
      { directionalBias: { scalp: { long: 33, short: 33, neutral: 34 }, swing: { long: 33, short: 33, neutral: 34 } } },
      Array.from({ length: 99 }, () => ({ counterTrend: true }))
    );
    assert(Buffer.byteLength(widest, 'utf8') <= 120, `${Buffer.byteLength(widest, 'utf8')} bytes: ${widest}`);
  });

  await test('trace summary (quick pass Q3): topDown/above200 append td:/a200: tokens; omitted args keep the old string byte-identical', () => {
    const m = htfUptrend(oneMinuteAtTop);
    const r = evaluate(m, [{ timeframe: '1m', direction: 'short', state: 'forming' }]);
    const base = biasTraceSummary(r.matrix, r.decisionInputs, r.alignment);
    assertEqual(biasTraceSummary(r.matrix, r.decisionInputs, r.alignment, null, null), base, 'null args = old behavior');
    const withTopDown = biasTraceSummary(r.matrix, r.decisionInputs, r.alignment, { sentiment: 'bull', aligned: 3 }, null);
    assertEqual(withTopDown, `${base}|td:bull:3/4`, 'td: token appended alone');
    const withBoth = biasTraceSummary(r.matrix, r.decisionInputs, r.alignment, { sentiment: 'mixed', aligned: 1 }, { count: 5, of: 7 });
    assertEqual(withBoth, `${base}|td:mixed:1/4|a200:5/7`, 'td: then a200:, ct: before either');
    assert(/\|ct:\d+\|td:(bull|bear|mixed):\d\/4\|a200:\d+\/\d+$/.test(withBoth), `grammar: ${withBoth}`);
  });

  await test('config: every bias constant lives in config/engine.json under "bias"', () => {
    for (const k of ['neutralBelow', 'channelEdgePct', 'minRoomAtr', 'counterTrendPenalty']) assert(typeof CFG[k] === 'number', k);
    for (const k of ['basisWeights', 'contextTimeframes', 'contextWeights', 'horizons', 'strategyTimeframes']) assert(CFG[k] && typeof CFG[k] === 'object', k);
    for (const tf of BIAS_TIMEFRAMES) assert(Array.isArray(CFG.contextTimeframes[tf]), `contextTimeframes.${tf}`);
  });

  await test('OpenAPI: BiasEntry, Alignment, DecisionInputs, decisionTrace.bias, include token bias; ChatGPT-safe constructs only', () => {
    const yaml = readFileSync(new URL('./openapi/scalp-context.yaml', import.meta.url), 'utf8');
    for (const name of ['BiasEntry', 'Alignment', 'DecisionInputs', 'DirectionalTriple']) assert(new RegExp(`\\n {4}${name}:\\n {6}type: object`).test(yaml), name);
    assert(/enum: \[timeframes, strategies, candidates, geometry, account, trace, config, bias\]/.test(yaml), 'include enum');
    assert(/\n {8}bias:\n {10}description:/.test(yaml), 'decisionTrace.bias');
    assert(!/\b(oneOf|anyOf|allOf|not):/.test(yaml), 'no composition keywords');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailed:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
