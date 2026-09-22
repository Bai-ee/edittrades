/**
 * Deterministic, zero-network test suite for lib/geometry.js and the phase 7 payload
 * wiring (geometryContext, decisionTrace.geometry, candidate risk).
 *
 * Every directional feature is checked on a fixture and on its mirror (prices reflected
 * around a pivot): the mirrored series must give the mirrored geometry.
 *
 * Run: node test-geometry.js
 */

import { readFileSync } from 'node:fs';
import { ENGINE_CONFIG } from './config/engine.js';
import { calculateATR } from './lib/advancedIndicators.js';
import {
  atr,
  swingPivots,
  higherLows,
  lowerHighs,
  swingStructure,
  horizontalZones,
  roomTo,
  extensionRisk,
  emaSlope,
  stochAcceleration,
  buildGeometryContext,
  geometryTraceSummary
} from './lib/geometry.js';
import { calculateEMA21 } from './services/indicators.js';
import { buildScalpContext, attachRisk, filterPayload, INTERVAL_MS } from './services/scalpContext.js';
import {
  FIXTURE_PIVOT,
  mirror,
  withTimes,
  regression001,
  wickReclaim,
  acceptanceBelow,
  extendedBreakout,
  noImpulse,
  formingFlag,
  triggeringFlag
} from './test/fixtures/flagFixtures.js';

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
// Fixtures
// ---------------------------------------------------------------------------

const PIVOT = 100;
const STEP_4H = INTERVAL_MS['4h'];
const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);

function r4(v) {
  return Math.round(v * 1e4) / 1e4;
}

/** Reflect a series around `pivot` (p -> 2*pivot - p, high/low swapped). */
function mirrorAround(candles, pivot = PIVOT) {
  return candles.map((c) => ({
    ...c,
    open: r4(2 * pivot - c.open),
    high: r4(2 * pivot - c.low),
    low: r4(2 * pivot - c.high),
    close: r4(2 * pivot - c.close)
  }));
}

/**
 * Candles walking straight between turning points, `steps` candles per leg, with a
 * 0.1 wick either side of the body. The candle that closes on a turning point is the
 * pivot, so its low (or high) is exactly the turning point -/+ 0.1.
 */
function legs(points, steps, stepMs = STEP_4H, startMs = NOW - 400 * STEP_4H) {
  const candles = [];
  let prev = points[0];
  for (let p = 1; p < points.length; p++) {
    const target = points[p];
    for (let s = 1; s <= steps; s++) {
      const close = r4(points[p - 1] + ((target - points[p - 1]) * s) / steps);
      const open = prev;
      const t = startMs + candles.length * stepMs;
      candles.push({
        timestamp: t,
        open,
        high: r4(Math.max(open, close) + 0.1),
        low: r4(Math.min(open, close) - 0.1),
        close,
        volume: 100,
        closeTime: t + stepMs
      });
      prev = close;
    }
  }
  return candles;
}

/**
 * REGRESSION_002 (partial): 4h demand zone. A smooth ramp (no pivots), then three
 * sell-offs that each bottom at ~95 (95.0, 95.3, 94.9) between rallies to 104 and 108.
 * Hand-marked zone: pivot lows 94.9, 95.2, 94.8 → support zone [94.8, 95.2], 3 touches.
 */
function regression002DemandZone() {
  return legs([80, 100, 95, 104, 95.3, 108, 94.9, 102], 6);
}

const DEMAND_ZONE = { low: 94.8, high: 95.2, touches: 3 };

/** Zigzag with hand-known pivot indices: rising lows and falling highs (a triangle). */
function triangle() {
  // Legs of 4 candles: turning points at candle index 3, 7, 11, 15, 19, 23 (0-based).
  return legs([100, 90, 110, 92, 108, 94, 106, 96], 4);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('\nlib/geometry.js\n');

  await test('config: every geometry constant lives in config/engine.json under "geometry"', () => {
    const g = ENGINE_CONFIG.geometry;
    for (const key of ['atrPeriod', 'pivotLeft', 'pivotRight', 'zoneToleranceAtr', 'minTouches', 'maxZonesPerSide', 'slopeCandles']) {
      assert(typeof g[key] === 'number' && Number.isFinite(g[key]), `geometry.${key} missing or not a number`);
    }
    assert(g.extensionAtr.elevated < g.extensionAtr.high, 'extension thresholds ordered');
    assert(Array.isArray(g.timeframes) && g.timeframes.length > 0, 'geometry.timeframes');
    assert(typeof ENGINE_CONFIG.flag.wickToleranceAtr === 'number', 'flag.wickToleranceAtr is an ATR multiple');
    assert(!('wickTolerancePct' in ENGINE_CONFIG.flag), 'flag.wickTolerancePct is gone');
  });

  // --- ATR: one implementation ---------------------------------------------

  await test('atr() returns calculateATR\'s value exactly on the same candles (no drift)', () => {
    for (const candles of [regression001(), mirror(regression001()), regression002DemandZone()]) {
      const mine = atr(candles, 14);
      const shared = calculateATR(candles, 14);
      assertEqual(mine.atr, shared.atr, 'atr');
      assertClose(mine.atrPct, (shared.atr / candles[candles.length - 1].close) * 100, 1e-4, 'atrPct');
    }
    assertEqual(atr(regression001().slice(0, 10), 14), null, 'too few candles → null');
  });

  // The Wilder ATR phase 4 shipped in lib/patternDetector.js, kept here verbatim as a
  // test oracle only: it ran against calculateATR on these candles before it was deleted,
  // and this keeps proving the replacement did not change the unit the detector measures in.
  function wilderReference(candles, period) {
    const out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    const tr = (i) => {
      const c = candles[i];
      const prevClose = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    };
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr(i);
    let a = sum / period;
    out[period] = a;
    for (let i = period + 1; i < candles.length; i++) {
      a = (a * (period - 1) + tr(i)) / period;
      out[i] = a;
    }
    return out;
  }

  await test('phase 4 wilderAtr and calculateATR agree at every index of every flag fixture (long + short)', () => {
    let compared = 0;
    for (const build of [regression001, wickReclaim, acceptanceBelow, extendedBreakout, noImpulse, formingFlag, triggeringFlag]) {
      for (const candles of [build(), mirror(build())]) {
        const ref = wilderReference(candles, ENGINE_CONFIG.flag.atrPeriod);
        for (let i = 0; i < candles.length; i++) {
          const shared = calculateATR(candles.slice(0, i + 1), ENGINE_CONFIG.flag.atrPeriod);
          if (ref[i] === null) { assertEqual(shared, null, `index ${i} warm-up`); continue; }
          // calculateATR rounds to 2 decimals; agreement is within that half-step.
          assertClose(shared.atr, ref[i], 0.005 + 1e-9, `index ${i}`);
          compared++;
        }
      }
    }
    assert(compared > 800, `expected a full comparison, got ${compared}`);
  });

  await test('exactly one ATR on the scalp path: no true-range code outside lib/advancedIndicators.js', () => {
    const trueRange = /Math\.abs\(\s*[\w.[\]]*high\s*-\s*[\w.[\]]*[cC]lose/;
    for (const file of ['lib/patternDetector.js', 'lib/geometry.js', 'services/scalpContext.js', 'services/indicators.js',
      'lib/structure.js', 'lib/candleFeatures.js', 'lib/riskEngine.js', 'services/strategy.js']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert(!trueRange.test(src), `${file} computes a true range`);
      assert(!/wilderAtr/.test(src), `${file} still references wilderAtr`);
    }
    for (const file of ['lib/patternDetector.js', 'lib/geometry.js']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      assert(/import \{ calculateATR \} from '\.\/advancedIndicators\.js'/.test(src), `${file} must import the shared calculateATR`);
    }
  });

  // --- Pivots and structure -------------------------------------------------

  await test('swingPivots finds the hand-marked turning points, and the mirror swaps highs and lows', () => {
    const c = triangle();
    const p = swingPivots(c, 3, 3);
    assertEqual(JSON.stringify(p.lows.map((x) => x.index)), JSON.stringify([3, 11, 19]), 'pivot low indices');
    assertEqual(JSON.stringify(p.highs.map((x) => x.index)), JSON.stringify([7, 15, 23]), 'pivot high indices');
    assertEqual(JSON.stringify(p.lows.map((x) => x.price)), JSON.stringify([89.9, 91.9, 93.9]), 'pivot low prices');
    assertEqual(JSON.stringify(p.highs.map((x) => x.price)), JSON.stringify([110.1, 108.1, 106.1]), 'pivot high prices');
    const m = swingPivots(mirrorAround(c), 3, 3);
    assertEqual(JSON.stringify(m.highs.map((x) => x.index)), JSON.stringify([3, 11, 19]), 'mirror pivot high indices');
    assertEqual(JSON.stringify(m.lows.map((x) => x.index)), JSON.stringify([7, 15, 23]), 'mirror pivot low indices');
    // The newest `right` candles can never be pivots.
    const last = c.length - 1;
    assert(p.highs.every((x) => x.index <= last - 3) && p.lows.every((x) => x.index <= last - 3), 'unconfirmed pivot');
  });

  await test('higherLows / lowerHighs: counts and booleans, mirrored', () => {
    const p = swingPivots(triangle(), 3, 3);
    const hl = higherLows(p);
    const lh = lowerHighs(p);
    assertEqual(hl.active, true, 'higherLows active');
    assertEqual(hl.count, 2, 'higherLows count');
    assertEqual(lh.active, true, 'lowerHighs active');
    assertEqual(lh.count, 2, 'lowerHighs count');
    // Mirror: the triangle reflected is still a triangle - rising lows and falling highs.
    const m = swingPivots(mirrorAround(triangle()), 3, 3);
    assertEqual(JSON.stringify(higherLows(m)), JSON.stringify(lh), 'mirror higherLows = lowerHighs');
    assertEqual(JSON.stringify(lowerHighs(m)), JSON.stringify(hl), 'mirror lowerHighs = higherLows');
    assertEqual(swingStructure(p), 'range', 'triangle is a range');
  });

  await test('swingStructure: rising zigzag is "up", its mirror is "down"', () => {
    const up = legs([100, 95, 105, 100, 110, 104, 115, 108], 4);
    assertEqual(swingStructure(swingPivots(up, 3, 3)), 'up', 'rising zigzag');
    assertEqual(swingStructure(swingPivots(mirrorAround(up), 3, 3)), 'down', 'mirror');
    assertEqual(swingStructure({ highs: [], lows: [] }), null, 'no pivots → null');
  });

  // --- Zones ---------------------------------------------------------------

  await test('REGRESSION_002 (partial): 4h demand zone with ≥ 2 touches matches the hand-marked zone', () => {
    const c = regression002DemandZone();
    const a = atr(c, ENGINE_CONFIG.geometry.atrPeriod).atr;
    const zones = horizontalZones(swingPivots(c, 3, 3), a * ENGINE_CONFIG.geometry.zoneToleranceAtr, 2);
    const demand = zones.find((z) => z.side === 'support');
    assert(demand, `expected a support zone, got ${JSON.stringify(zones)}`);
    assertClose(demand.low, DEMAND_ZONE.low, 1e-9, 'zone low');
    assertClose(demand.high, DEMAND_ZONE.high, 1e-9, 'zone high');
    assertEqual(demand.touches, DEMAND_ZONE.touches, 'touches');
    assert(demand.touches >= 2, 'at least two touches');
    assertEqual(demand.lastTouchAt, c[c.length - 1 - 6].closeTime, 'lastTouchAt is the newest touch');
    // The two single highs (104, 108) are 4 apart: no resistance zone without evidence.
    assertEqual(zones.filter((z) => z.side === 'resistance').length, 0, 'single touches are not zones');
  });

  await test('REGRESSION_002 short mirror: the same zone as supply, mirrored exactly', () => {
    const c = regression002DemandZone();
    const tol = atr(c, 14).atr * ENGINE_CONFIG.geometry.zoneToleranceAtr;
    const long = horizontalZones(swingPivots(c, 3, 3), tol, 2);
    const short = horizontalZones(swingPivots(mirrorAround(c), 3, 3), tol, 2);
    assertEqual(short.length, long.length, 'zone count');
    const flip = { support: 'resistance', resistance: 'support', both: 'both' };
    const reflected = long.map((z) => ({ low: r4(2 * PIVOT - z.high), high: r4(2 * PIVOT - z.low), touches: z.touches, side: flip[z.side] }))
      .sort((a, b) => a.low - b.low);
    const got = short.map((z) => ({ low: r4(z.low), high: r4(z.high), touches: z.touches, side: z.side }));
    assertEqual(JSON.stringify(got), JSON.stringify(reflected), 'mirrored zones');
  });

  await test('horizontalZones: a zone is never wider than 2 x tolerance; minTouches filters', () => {
    const pivots = { highs: [], lows: [100, 100.4, 100.8, 101.2, 101.6, 102.0].map((price, i) => ({ index: i, price, time: i })) };
    const zones = horizontalZones(pivots, 0.5, 2);
    for (const z of zones) assert(z.high - z.low <= 1.0 + 1e-9, `zone too wide: ${JSON.stringify(z)}`);
    assertEqual(horizontalZones(pivots, 0.5, 99).length, 0, 'minTouches 99 → nothing');
    assertEqual(horizontalZones(pivots, 0, 2).length, 0, 'zero tolerance → nothing');
  });

  await test('roomTo: nearest zone each side, 0 inside a zone, mirrored', () => {
    const zones = [
      { low: 94, high: 95, touches: 2, lastTouchAt: 1, side: 'support' },
      { low: 90, high: 91, touches: 3, lastTouchAt: 1, side: 'support' },
      { low: 104, high: 105, touches: 2, lastTouchAt: 1, side: 'resistance' }
    ];
    const r = roomTo(100, zones);
    assertEqual(r.nextSupport.low, 94, 'nearest support');
    assertEqual(r.nextResistance.low, 104, 'nearest resistance');
    assertClose(r.roomDownPct, 5, 1e-9, 'room down');
    assertClose(r.roomUpPct, 4, 1e-9, 'room up');
    const mirrored = zones.map((z) => ({ ...z, low: 2 * PIVOT - z.high, high: 2 * PIVOT - z.low }));
    const m = roomTo(100, mirrored);
    assertEqual(m.roomUpPct, r.roomDownPct, 'mirror room up = room down');
    assertEqual(m.roomDownPct, r.roomUpPct, 'mirror room down = room up');
    const inside = roomTo(94.2, [{ low: 94, high: 95, touches: 2, lastTouchAt: 1, side: 'support' }]);
    assertEqual(inside.roomUpPct, 0, 'price inside a zone whose midpoint is above → 0 room up');
    assertEqual(roomTo(100, []).roomUpPct, null, 'no zone → null');
  });

  // --- Extension, slopes, Stoch ----------------------------------------------

  await test('extensionRisk: signed ATR units, level by magnitude, symmetric', () => {
    const cfg = ENGINE_CONFIG.geometry.extensionAtr;
    assertEqual(extensionRisk(101, 100, 1).level, 'low', '1 ATR');
    assertEqual(extensionRisk(100 + cfg.elevated, 100, 1).level, 'elevated', 'elevated threshold');
    assertEqual(extensionRisk(100 + cfg.high, 100, 1).level, 'high', 'high threshold');
    const up = extensionRisk(102, 100, 1);
    const down = extensionRisk(98, 100, 1);
    assertEqual(up.atrFromEma21, 2, 'above');
    assertEqual(down.atrFromEma21, -2, 'below');
    assertEqual(up.level, down.level, 'same magnitude, same level');
    assertEqual(extensionRisk(100, null, 1), null, 'missing EMA → null');
  });

  await test('emaSlope: rising EMA21 → positive, flat → 0, falling → negative', () => {
    const rising = calculateEMA21(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5));
    const flat = calculateEMA21(Array.from({ length: 120 }, () => 100));
    const falling = calculateEMA21(Array.from({ length: 120 }, (_, i) => 200 - i * 0.5));
    assert(emaSlope(rising, 5) > 0, `rising slope ${emaSlope(rising, 5)}`);
    assertEqual(emaSlope(flat, 5), 0, 'flat slope');
    assert(emaSlope(falling, 5) < 0, `falling slope ${emaSlope(falling, 5)}`);
    assertEqual(emaSlope([1, 2, 3], 5), null, 'too short → null');
  });

  await test('stochAcceleration: reset then reaccelerate → positive; mirror → negative', () => {
    const reset = [{ k: 40 }, { k: 15 }, { k: 5 }, { k: 12 }];
    assertEqual(stochAcceleration(reset), 17, 'long reaccelerate'); // (12-5) - (5-15)
    const mirrored = reset.map((h) => ({ k: 100 - h.k }));
    assertEqual(stochAcceleration(mirrored), -17, 'short mirror');
    assertEqual(stochAcceleration([{ k: 1 }, { k: 2 }]), null, 'too short → null');
  });

  // --- Assembled context and trace ------------------------------------------

  const GEOMETRY_KEYS = ['timeframe', 'atr', 'atrPct', 'structure', 'higherLows', 'lowerHighs',
    'horizontalSupportZones', 'horizontalResistanceZones', 'roomToNextSupport', 'roomToNextResistance',
    'extensionRisk', 'ema21Slope', 'ema200Slope', 'stochAccelK', 'confidence'].sort();

  await test('buildGeometryContext: full shape; demand zone published as support; mirror gives supply', () => {
    const c = regression002DemandZone();
    const g = buildGeometryContext({ timeframe: '4h', candles: c, ema21History: calculateEMA21(c.map((x) => x.close)) });
    assertEqual(JSON.stringify(Object.keys(g).sort()), JSON.stringify(GEOMETRY_KEYS), 'keys');
    const z = g.horizontalSupportZones.find((x) => x.touches >= 2);
    assert(z, 'support zone published');
    assertEqual(typeof z.lastTouchAt, 'string', 'lastTouchAt is ISO');
    assert(g.horizontalSupportZones.length <= ENGINE_CONFIG.geometry.maxZonesPerSide, 'maxZonesPerSide');
    assertClose(g.roomToNextSupport, ((102 - 95.2) / 102) * 100, 1e-3, 'room to demand');
    const m = mirrorAround(c);
    const gm = buildGeometryContext({ timeframe: '4h', candles: m, ema21History: calculateEMA21(m.map((x) => x.close)) });
    assertEqual(gm.horizontalResistanceZones.length, g.horizontalSupportZones.length, 'mirror resistance count');
    assertClose(gm.roomToNextResistance, ((104.8 - 98) / 98) * 100, 1e-3, 'mirror room to supply');
    assertEqual(gm.horizontalResistanceZones[0].touches, g.horizontalSupportZones[0].touches, 'mirror touches');
    assertEqual(buildGeometryContext({ timeframe: '4h', candles: c.slice(0, 5) }), null, 'too few candles → null');
  });

  await test('geometryTraceSummary stays ≤ 300 bytes per symbol even for all seven timeframes', () => {
    const worst = {};
    for (const tf of ['1m', '3m', '5m', '15m', '1h', '4h', '1d']) {
      worst[tf] = { structure: 'range', roomToNextResistance: 123.456, roomToNextSupport: 123.456, extensionRisk: { level: 'elevated' } };
    }
    const bytes = Buffer.byteLength(JSON.stringify(geometryTraceSummary(worst)), 'utf8');
    assert(bytes <= 300, `worst-case trace summary ${bytes} bytes`);
    assertEqual(JSON.stringify(geometryTraceSummary({ '1h': null })), JSON.stringify(['1h:na:na:na:na']), 'missing geometry');
  });

  // --- Through buildScalpContext --------------------------------------------

  function quietCandles(interval, count) {
    const step = INTERVAL_MS[interval];
    const firstOpen = Math.floor(NOW / step) * step - count * step;
    return Array.from({ length: count }, (_, i) => {
      const wobble = ((i * 7919) % 17) - 8;
      const open = FIXTURE_PIVOT + wobble;
      const close = FIXTURE_PIVOT - wobble;
      return { timestamp: firstOpen + i * step, open, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, close, volume: 100, closeTime: firstOpen + (i + 1) * step };
    });
  }

  function build(candles1m, { marginUsd = 500, includeFailed } = {}) {
    return buildScalpContext({
      symbols: ['BTC'],
      now: NOW,
      includeFailed,
      fetchCandles: async (pair, interval) => (interval === '1m' ? withTimes(candles1m, NOW) : quietCandles(interval, 300)),
      fetchAccount: async () => (marginUsd === null
        ? { status: 'unavailable', margin: { usd: null, byAsset: {} } }
        : { status: 'ok', margin: { usd: marginUsd, byAsset: {} } })
    });
  }

  await test('payload: schema 1.7.0; geometryContext per configured timeframe; trace summary ≤ 300 bytes', async () => {
    const payload = await build(regression001());
    assertEqual(payload.schemaVersion, '1.7.0', 'schemaVersion');
    const btc = payload.symbols.BTC;
    assertEqual(JSON.stringify(Object.keys(btc.geometryContext)), JSON.stringify(ENGINE_CONFIG.geometry.timeframes), 'geometry timeframes');
    for (const tf of ENGINE_CONFIG.geometry.timeframes) {
      assertEqual(JSON.stringify(Object.keys(btc.geometryContext[tf]).sort()), JSON.stringify(GEOMETRY_KEYS), `${tf} keys`);
      assertEqual(btc.geometryContext[tf].timeframe, tf, `${tf} label`);
    }
    assert(Array.isArray(btc.decisionTrace.geometry), 'trace.geometry is an array');
    assertEqual(btc.decisionTrace.geometry.length, ENGINE_CONFIG.geometry.timeframes.length, 'one string per timeframe');
    const bytes = Buffer.byteLength(JSON.stringify(btc.decisionTrace.geometry), 'utf8');
    assert(bytes <= 300, `decisionTrace.geometry ${bytes} bytes`);
    assert(btc.structure && 'swingHighs' in btc.structure, 'symbol-level structure block unchanged');
  });

  await test('include: geometry gates geometryContext; other sections unaffected', async () => {
    const payload = await build(regression001());
    const without = filterPayload(payload, { include: ['timeframes', 'strategies'] });
    assert(!('geometryContext' in without.symbols.BTC), 'geometry dropped when not included');
    const only = filterPayload(payload, { include: ['geometry'] });
    assert('geometryContext' in only.symbols.BTC, 'geometry kept when included');
    assert(!('timeframes' in only.symbols.BTC), 'timeframes dropped');
    assertEqual(JSON.stringify(filterPayload(payload, {})), JSON.stringify(payload), '{} unchanged');
  });

  // --- Candidate risk (phase 6 item F, landed here) --------------------------

  /** What attachRisk would publish for a strategy entering at `entry` with stop `stop`. */
  function strategyRisk(entry, stop, marginUsd) {
    const s = { X: { valid: true, entryZone: { min: entry, max: entry }, stopLoss: stop } };
    attachRisk(s, { margin: { usd: marginUsd } });
    return s.X.risk;
  }

  for (const [label, fixture, direction, state] of [
    ['confirmed long', regression001(), 'long', 'confirmed'],
    ['confirmed short mirror', mirror(regression001()), 'short', 'confirmed'],
    ['triggering long', triggeringFlag(), 'long', 'triggering'],
    ['triggering short mirror', mirror(triggeringFlag()), 'short', 'triggering']
  ]) {
    await test(`candidate risk: ${label} gets the strategy risk shape, entry = breakout, stop = invalidation`, async () => {
      const payload = await build(fixture);
      const c = payload.symbols.BTC.candidateSetups.find((x) => x.timeframe === '1m' && x.direction === direction);
      assert(c, `expected a 1m ${direction} candidate`);
      assertEqual(c.state, state, 'state');
      assertEqual(c.chaseRisk, false, 'chaseRisk');
      assert(c.risk, 'risk block present');
      assertEqual(JSON.stringify(c.risk), JSON.stringify(strategyRisk(c.breakoutLevel, c.invalidation, 500)), 'same math as attachRisk');
      assertEqual(c.risk.reason, null, 'sized');
      assert(c.risk.maxLeverage > 0 && c.risk.collateralUsd === 10, 'numbers populated');
    });
  }

  await test('candidate risk: long and short mirror size identically', async () => {
    const long = (await build(regression001())).symbols.BTC.candidateSetups.find((x) => x.direction === 'long' && x.timeframe === '1m');
    const short = (await build(mirror(regression001()))).symbols.BTC.candidateSetups.find((x) => x.direction === 'short' && x.timeframe === '1m');
    assertEqual(short.risk.maxLeverage, long.risk.maxLeverage, 'maxLeverage');
    assertEqual(short.risk.suggestedLeverage, long.risk.suggestedLeverage, 'suggestedLeverage');
    // Same dollar stop distance, but the mirrored entry sits ~0.7% lower, so the percent
    // distance (and loss) differs by that ratio plus cent rounding.
    assertClose(Math.abs(short.breakoutLevel - short.invalidation), Math.abs(long.breakoutLevel - long.invalidation), 0.02, 'stop distance');
    assertClose(short.risk.lossAtStopUsd, long.risk.lossAtStopUsd, 0.02, 'lossAtStopUsd');
  });

  await test('candidate risk: forming, failed, and chase candidates have no risk key (long + short)', async () => {
    for (const [fixture, direction, state] of [
      [formingFlag(), 'long', 'forming'], [mirror(formingFlag()), 'short', 'forming'],
      [acceptanceBelow(), 'long', 'failed'], [mirror(acceptanceBelow()), 'short', 'failed']
    ]) {
      const payload = await build(fixture, { includeFailed: true });
      const c = payload.symbols.BTC.candidateSetups.find((x) => x.timeframe === '1m' && x.direction === direction);
      assert(c, `expected a 1m ${direction} ${state} candidate`);
      assertEqual(c.state, state, 'state');
      assert(!('risk' in c), `${direction} ${state} must not carry risk`);
    }
    for (const [fixture, direction] of [[extendedBreakout(), 'long'], [mirror(extendedBreakout()), 'short']]) {
      const c = (await build(fixture)).symbols.BTC.candidateSetups.find((x) => x.timeframe === '1m' && x.direction === direction);
      assertEqual(c.chaseRisk, true, `${direction} chase`);
      assert(!('risk' in c), `${direction} chase must not carry risk`);
    }
  });

  await test('candidate risk: margin unavailable → every number null with a reason (long + short)', async () => {
    for (const [fixture, direction] of [[regression001(), 'long'], [mirror(regression001()), 'short']]) {
      const payload = await build(fixture, { marginUsd: null });
      const c = payload.symbols.BTC.candidateSetups.find((x) => x.timeframe === '1m' && x.direction === direction);
      assertEqual(JSON.stringify(c.risk), JSON.stringify({
        maxLeverage: null, suggestedLeverage: null, lossAtStopUsd: null, lossAtStopPct: null,
        lossAtStopPctOfWallet: null, collateralUsd: null, reason: 'account unavailable'
      }), `${direction} null-shaped risk`);
      assertEqual(payload.dataStatus, 'complete', 'wallet never moves dataStatus');
    }
  });

  await test('OpenAPI: GeometryContext schema, CandidateSetup.risk, schema-safe constructs only', () => {
    const yaml = readFileSync(new URL('./openapi/scalp-context.yaml', import.meta.url), 'utf8');
    assert(/^ {4}GeometryContext:\s*$/m.test(yaml), 'GeometryContext schema');
    assert(/^ {4}GeometryZone:\s*$/m.test(yaml), 'GeometryZone schema');
    const candidate = yaml.slice(yaml.indexOf('    CandidateSetup:'), yaml.indexOf('    DecisionTrace:'));
    assert(/risk:[\s\S]*\$ref: "#\/components\/schemas\/Risk"/.test(candidate), 'CandidateSetup.risk refs Risk');
    assert(/geometryContext:/.test(yaml), 'Symbol.geometryContext documented');
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
