/**
 * Deterministic, zero-network test suite for lib/geometry.js and the phase 7/8 payload
 * wiring (geometryContext incl. diagonals/channel/confluence, decisionTrace.geometry,
 * candidate risk).
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
  geometryTraceSummary,
  fitDiagonal,
  channel,
  confluenceZones,
  buildGeometryB
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
import {
  GEOMETRY_PIVOT,
  GEOMETRY_NOW,
  r4,
  mirrorAround,
  legs,
  regression002Confluence
} from './test/fixtures/geometryFixtures.js';

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

const PIVOT = GEOMETRY_PIVOT;
const STEP_4H = INTERVAL_MS['4h'];
const NOW = GEOMETRY_NOW;

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

/**
 * Rising channel: lower line 80 + 0.25/candle, upper line 10 above it, price alternating
 * between them every 8 candles. The last leg stops halfway, so price sits mid-channel.
 */
function risingChannel() {
  const points = [];
  for (let k = 0; k <= 8; k++) points.push(r4(80 + 0.25 * k * 8 + (k % 2 ? 10 : 0)));
  return legs(points, 8).slice(0, -4);
}

/** Only two rising lows: a line a trader might draw, but not evidence (needs 3). */
function twoTouchLine() {
  return legs([100, 90, 106, 93, 108, 104], 12);
}

/** Deterministic iid noise: closes uniform in 100 +/- 5, random wicks. */
function noiseCandles(seed, n = 300) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const close = r4(100 + (rnd() - 0.5) * 10);
    const t = NOW - (n - i) * STEP_4H;
    out.push({ timestamp: t, open: prev, high: r4(Math.max(prev, close) + rnd() * 2), low: r4(Math.min(prev, close) - rnd() * 2), close, volume: 100, closeTime: t + STEP_4H });
    prev = close;
  }
  return out;
}

/** Geometry B for a candle series, the way buildScalpContext computes it (no EMA/session levels). */
function geometryB(candles) {
  const g = buildGeometryContext({ timeframe: '4h', candles });
  return buildGeometryB({ candles, geometry: g });
}

/**
 * Inputs for the phase 7 snapshot (test/fixtures/geometryPhase7Snapshot.json). The
 * snapshot was produced by the phase 7 lib/geometry.js (commit 19cce68) on exactly these
 * inputs; phase 8 must reproduce it byte for byte.
 */
function phase7SnapshotInputs() {
  const fixtures = {
    regression002: regression002DemandZone(),
    triangle: triangle(),
    regression001: regression001(),
    triggeringFlag: triggeringFlag(),
    acceptanceBelow: acceptanceBelow()
  };
  for (const k of Object.keys(fixtures)) {
    fixtures[`${k}Mirror`] = k === 'regression002' || k === 'triangle' ? mirrorAround(fixtures[k]) : mirror(fixtures[k]);
  }
  return fixtures;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('\nlib/geometry.js\n');

  await test('config: every geometry constant lives in config/engine.json under "geometry"', () => {
    const g = ENGINE_CONFIG.geometry;
    for (const key of ['atrPeriod', 'pivotLeft', 'pivotRight', 'zoneToleranceAtr', 'minTouches', 'maxZonesPerSide', 'slopeCandles',
      'diagonalMinTouches', 'maxDiagonalCandidates', 'diagonalMinSpanCandles', 'diagonalMinBounceAtr', 'diagonalFullTouches',
      'maxSlopeDivergence', 'channelFlatSlope', 'confluenceTolAtr', 'maxConfluenceZones']) {
      assert(typeof g[key] === 'number' && Number.isFinite(g[key]), `geometry.${key} missing or not a number`);
    }
    assert(g.extensionAtr.elevated < g.extensionAtr.high, 'extension thresholds ordered');
    assert(g.diagonalMinTouches >= 3, 'a diagonal needs at least three touches');
    assertEqual(JSON.stringify(g.timeframes), JSON.stringify(['15m', '1h', '4h']), 'phase 8 budget: 5m dropped from the default geometry set');
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
  const GEOMETRY_B_KEYS = ['diagonalSupport', 'diagonalResistance', 'channel', 'confluenceZones'];

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
    assertEqual(JSON.stringify(geometryTraceSummary({ '1h': null })), JSON.stringify(['1h:na']), 'missing geometry collapses to one token (phase 11)');
  });

  await test('geometryTraceSummary (phase 11): rounds room values to 2 decimals, empty position for a missing individual field', () => {
    const g = { structure: 'up', roomToNextResistance: 0.4231, roomToNextSupport: null, extensionRisk: { level: 'low' } };
    assertEqual(geometryTraceSummary({ '1h': g })[0], '1h:up:0.42::low', 'roundN(0.4231,2)=0.42; null roomToNextSupport is an empty position');
  });

  // --- Geometry B (phase 8) --------------------------------------------------

  await test('phase 7 snapshot: buildGeometryContext output is byte-identical to phase 7 on every fixture (long + mirror)', () => {
    const snapshot = JSON.parse(readFileSync(new URL('./test/fixtures/geometryPhase7Snapshot.json', import.meta.url), 'utf8'));
    const inputs = phase7SnapshotInputs();
    assertEqual(JSON.stringify(Object.keys(inputs)), JSON.stringify(Object.keys(snapshot)), 'fixture set');
    for (const [name, c] of Object.entries(inputs)) {
      const closes = c.map((x) => x.close);
      const g = buildGeometryContext({
        timeframe: '4h',
        candles: c,
        ema21History: calculateEMA21(closes),
        ema200History: calculateEMA21(closes.map((x) => x * 1.01)),
        stochHistory: closes.map((_, i) => ({ k: (i * 37) % 100, d: (i * 23) % 100 }))
      });
      assertEqual(JSON.stringify(g), JSON.stringify(snapshot[name]), `${name} differs from phase 7`);
    }
  });

  await test('rising channel: diagonal support ≥ 3 touches, resistance, channel detected with positionPct in range', () => {
    const c = risingChannel();
    const b = geometryB(c);
    const s = b.diagonalSupport;
    const r = b.diagonalResistance;
    assert(s.detected && r.detected, `both lines expected, got ${JSON.stringify(b)}`);
    assert(s.touches >= 3, `support touches ${s.touches}`);
    assert(r.touches >= 3, `resistance touches ${r.touches}`);
    assert(s.slope > 0 && r.slope > 0, 'both rising');
    assertEqual(s.fitError, 0, 'exact line');
    // Turning point k closes candle 8k-1, so the line is 80 + 0.25(i+1) minus the 0.1 wick.
    assertClose(s.currentLevel, 80 + 0.25 * c.length - 0.1, 1e-3, 'support level at the newest candle');
    assertClose(s.currentDistancePct, ((c[c.length - 1].close - s.currentLevel) / c[c.length - 1].close) * 100, 1e-3, 'distance');
    assertEqual(typeof s.lastTouchAt, 'string', 'lastTouchAt ISO');
    assert(s.confidence > 0 && s.confidence <= 100, 'confidence 0-100');
    const ch = b.channel;
    assert(ch.detected, 'channel detected');
    assertEqual(ch.lower, s.currentLevel, 'lower = support');
    assertEqual(ch.upper, r.currentLevel, 'upper = resistance');
    assert(ch.positionPct >= 0 && ch.positionPct <= 100, `positionPct ${ch.positionPct}`);
    assertClose(ch.positionPct, 50, 1, 'mid-channel');
    assertEqual(ch.slope, 'rising', 'slope');
    assertClose(ch.widthPct, ((ch.upper - ch.lower) / c[c.length - 1].close) * 100, 1e-3, 'widthPct');
  });

  await test('falling channel (mirror): support and resistance swap, positionPct mirrors, slope falling', () => {
    const long = geometryB(risingChannel());
    const short = geometryB(mirrorAround(risingChannel()));
    assert(short.channel.detected, 'mirrored channel detected');
    assertEqual(short.channel.slope, 'falling', 'slope');
    assertEqual(short.diagonalResistance.touches, long.diagonalSupport.touches, 'resistance touches = support touches');
    assertEqual(short.diagonalSupport.touches, long.diagonalResistance.touches, 'support touches = resistance touches');
    assertClose(short.diagonalResistance.currentLevel, 2 * PIVOT - long.diagonalSupport.currentLevel, 1e-3, 'mirrored level');
    assertClose(short.channel.positionPct, 100 - long.channel.positionPct, 0.1, 'position mirrors');
    assertEqual(short.diagonalResistance.fitError, long.diagonalSupport.fitError, 'fitError');
    assertEqual(short.diagonalResistance.confidence, long.diagonalSupport.confidence, 'confidence');
    assert(short.diagonalResistance.slope < 0 && short.diagonalSupport.slope < 0, 'both falling');
  });

  await test('noisy data: no diagonal and no channel on 30 seeds of iid noise (both sides)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const c of [noiseCandles(seed), mirrorAround(noiseCandles(seed))]) {
        const b = geometryB(c);
        assertEqual(b.diagonalSupport.detected, false, `seed ${seed} support`);
        assertEqual(b.diagonalResistance.detected, false, `seed ${seed} resistance`);
        assertEqual(b.channel.detected, false, `seed ${seed} channel`);
        assertEqual(JSON.stringify(b.diagonalSupport), JSON.stringify({ detected: false }), 'not-detected shape carries nothing else');
      }
    }
  });

  await test('a line with only 2 touches is never exposed (long + mirror); lowering the gate proves it is the gate', () => {
    const c = twoTouchLine();
    const tol = atr(c, 14).atr;
    for (const [candles, side] of [[c, 'support'], [mirrorAround(c), 'resistance']]) {
      const ctx = { candles, atr: tol };
      const pivots = swingPivots(candles, 3, 3);
      assertEqual(fitDiagonal(pivots, side, ENGINE_CONFIG.geometry, ctx).detected, false, `${side}: 2 touches must not be exposed`);
      const loose = fitDiagonal(pivots, side, { ...ENGINE_CONFIG.geometry, diagonalMinTouches: 2 }, ctx);
      assert(loose.detected && loose.touches === 2, `${side}: with minTouches 2 the same line appears (${JSON.stringify(loose)})`);
    }
    // Property: nothing detected anywhere in this suite has fewer than diagonalMinTouches.
    for (const candles of [risingChannel(), regression002Confluence(), triangle(), regression002DemandZone(), c]) {
      for (const cc of [candles, mirrorAround(candles)]) {
        const b = geometryB(cc);
        for (const line of [b.diagonalSupport, b.diagonalResistance]) {
          if (line.detected) assert(line.touches >= ENGINE_CONFIG.geometry.diagonalMinTouches, `exposed line with ${line.touches} touches`);
        }
      }
    }
  });

  await test('REGRESSION_002 (full): rising diagonal support + horizontal demand form one confluence zone with current distance', () => {
    const c = regression002Confluence();
    const price = c[c.length - 1].close;
    const b = geometryB(c);
    const s = b.diagonalSupport;
    assert(s.detected && s.slope > 0 && s.touches >= 3, `rising diagonal support expected, got ${JSON.stringify(s)}`);
    const g = buildGeometryContext({ timeframe: '4h', candles: c });
    const demand = g.horizontalSupportZones.find((z) => z.touches >= 2);
    assert(demand, 'horizontal demand zone');
    assertClose(demand.low, 94.9, 1e-9, 'demand low');
    assertClose(demand.high, 95.1, 1e-9, 'demand high');
    const zone = b.confluenceZones.find((z) => z.components.includes('diagonalSupport') && z.components.includes('horizontalZone'));
    assert(zone, `one zone with both components, got ${JSON.stringify(b.confluenceZones)}`);
    assertEqual(b.confluenceZones.filter((z) => z.components.includes('diagonalSupport')).length, 1, 'exactly one zone carries the diagonal');
    assertEqual(zone.low, demand.low, 'zone spans the demand zone');
    assertEqual(zone.high, s.currentLevel, 'zone spans the diagonal level');
    assertEqual(zone.score, 2, 'two components');
    assertClose(zone.distancePct, ((price - zone.high) / price) * 100, 1e-3, 'current distance from price');
    assert(zone.distancePct > 0, 'price is above the zone');
  });

  await test('REGRESSION_002 short mirror: falling diagonal resistance + horizontal supply, same distance', () => {
    const long = geometryB(regression002Confluence());
    const short = geometryB(mirrorAround(regression002Confluence()));
    const r = short.diagonalResistance;
    assert(r.detected && r.slope < 0, 'falling diagonal resistance');
    assertEqual(r.touches, long.diagonalSupport.touches, 'touches');
    const lz = long.confluenceZones[0];
    const sz = short.confluenceZones.find((z) => z.components.includes('diagonalResistance') && z.components.includes('horizontalZone'));
    assert(sz, `mirrored confluence zone, got ${JSON.stringify(short.confluenceZones)}`);
    assertClose(sz.low, 2 * PIVOT - lz.high, 1e-3, 'mirrored low');
    assertClose(sz.high, 2 * PIVOT - lz.low, 1e-3, 'mirrored high');
    assertEqual(sz.score, lz.score, 'score');
    assert(sz.distancePct > 0, 'price is below the supply zone');
  });

  await test('confluence scoring prefers more components; one component alone is never a zone (long + mirror)', () => {
    const base = {
      price: 104,
      atr: 2,
      horizontalZones: [{ low: 99.8, high: 100.2 }, { low: 109.9, high: 110.1 }],
      ema21: 100.1,
      ema200: 110,
      levels: { prevDayHigh: 110.2, sessionLow: 90 }
    };
    const zones = confluenceZones(base);
    assertEqual(zones.length, 2, `two zones, got ${JSON.stringify(zones)}`);
    assertEqual(zones[0].score, 3, 'the three-component zone ranks first although it is farther');
    assertEqual(JSON.stringify(zones[0].components), JSON.stringify(['horizontalZone', 'ema200', 'prevDayHigh']), 'components');
    assertEqual(zones[1].score, 2, 'two-component zone second');
    assert(zones[0].distancePct > zones[1].distancePct, 'ranking is by score, not distance');
    assert(!zones.some((z) => z.low <= 90 && z.high >= 90), 'lone sessionLow is not a zone');

    const m = (v) => 2 * PIVOT - v;
    const mirrored = confluenceZones({
      price: m(104),
      atr: 2,
      horizontalZones: base.horizontalZones.map((z) => ({ low: m(z.high), high: m(z.low) })),
      ema21: m(100.1),
      ema200: m(110),
      levels: { prevDayLow: m(110.2), sessionHigh: m(90) }
    });
    assertEqual(mirrored[0].score, 3, 'mirror: score');
    assertEqual(JSON.stringify(mirrored[0].components), JSON.stringify(['horizontalZone', 'ema200', 'prevDayLow']), 'mirror: components');
    assertClose(mirrored[0].distancePct, zones[0].distancePct * (104 / m(104)), 1e-3, 'mirror: same price distance');
    assertEqual(JSON.stringify(confluenceZones({ price: 100, atr: 0 })), '[]', 'no ATR → no zones');
  });

  await test('channel: converging lines (triangle) and a missing side are not channels', () => {
    const line = (level, slope) => ({ detected: true, slope, touches: 3, currentLevel: level, currentDistancePct: 0, lastTouchAt: null, fitError: 0, confidence: 60 });
    assertEqual(channel(line(95, 0.5), line(105, -0.5), 100).detected, false, 'triangle (long view)');
    assertEqual(channel(line(95, -0.5), line(105, 0.5), 100).detected, false, 'broadening');
    assertEqual(channel(line(95, 0.1), { detected: false }, 100).detected, false, 'no resistance');
    assertEqual(channel({ detected: false }, line(105, 0.1), 100).detected, false, 'no support');
    assertEqual(channel(line(105, 0.1), line(95, 0.1), 100).detected, false, 'upper below lower');
    const flat = channel(line(95, 0), line(105, 0), 100);
    assert(flat.detected && flat.slope === 'flat' && flat.positionPct === 50, `flat channel ${JSON.stringify(flat)}`);
    const up = channel(line(95, 0.2), line(105, 0.2), 100);
    const down = channel(line(95, -0.2), line(105, -0.2), 100);
    assertEqual(up.slope, 'rising', 'rising');
    assertEqual(down.slope, 'falling', 'falling mirror');
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

  await test('payload: schema 1.18.0; geometryContext per configured timeframe with geometry B; trace summary ≤ 300 bytes', async () => {
    const payload = await build(regression001());
    assertEqual(payload.schemaVersion, '1.24.0', 'schemaVersion');
    const btc = payload.symbols.BTC;
    assertEqual(JSON.stringify(Object.keys(btc.geometryContext)), JSON.stringify(ENGINE_CONFIG.geometry.timeframes), 'geometry timeframes');
    const withB = [...GEOMETRY_KEYS, ...GEOMETRY_B_KEYS].sort();
    for (const tf of ENGINE_CONFIG.geometry.timeframes) {
      assertEqual(JSON.stringify(Object.keys(btc.geometryContext[tf]).sort()), JSON.stringify(withB), `${tf} keys`);
      assertEqual(btc.geometryContext[tf].timeframe, tf, `${tf} label`);
      assertEqual(typeof btc.geometryContext[tf].diagonalSupport.detected, 'boolean', `${tf} diagonalSupport.detected`);
      assertEqual(typeof btc.geometryContext[tf].channel.detected, 'boolean', `${tf} channel.detected`);
      assert(Array.isArray(btc.geometryContext[tf].confluenceZones), `${tf} confluenceZones array`);
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

  await test('OpenAPI: GeometryContext + Diagonal/Channel/ConfluenceZone schemas, CandidateSetup.risk, schema-safe constructs only', () => {
    const yaml = readFileSync(new URL('./openapi/scalp-context.yaml', import.meta.url), 'utf8');
    assert(/^ {4}GeometryContext:\s*$/m.test(yaml), 'GeometryContext schema');
    assert(/^ {4}GeometryZone:\s*$/m.test(yaml), 'GeometryZone schema');
    const candidate = yaml.slice(yaml.indexOf('    CandidateSetup:'), yaml.indexOf('    DecisionTrace:'));
    assert(/risk:[\s\S]*\$ref: "#\/components\/schemas\/Risk"/.test(candidate), 'CandidateSetup.risk refs Risk');
    assert(/geometryContext:/.test(yaml), 'Symbol.geometryContext documented');
    for (const name of ['Diagonal', 'Channel', 'ConfluenceZone']) assert(new RegExp(`^ {4}${name}:\\s*$`, 'm').test(yaml), `${name} schema`);
    const gc = yaml.slice(yaml.indexOf('    GeometryContext:'), yaml.indexOf('    ConfigSnapshot:'));
    for (const key of ['diagonalSupport', 'diagonalResistance', 'channel', 'confluenceZones']) assert(new RegExp(`\\n {8}${key}:`).test(gc), `GeometryContext.${key}`);
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
