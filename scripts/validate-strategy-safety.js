#!/usr/bin/env node

/**
 * Strategy Engine — safety invariants.
 *
 * Offline and deterministic: every fixture is a hand-built multi-timeframe
 * object in the exact shape the API layer produces, so no network and no
 * candle history is required.
 *
 * Each section pins a defect that was live and reproducible on a BTC-only
 * path. The unifying rule they enforce:
 *
 *   A signal the engine cannot justify must be WITHHELD, never emitted with a
 *   confident-looking number attached.
 *
 * Run: npm run validate:strategy-safety
 */

import {
  evaluateAllStrategies,
  calculateConfidenceWithHierarchy,
  resolveStop,
  ATR_STOP_FALLBACK_MULTIPLE
} from '../services/strategy.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}\n${'-'.repeat(name.length)}`);
}

/**
 * Build one timeframe in the exact shape api/analyze.js assembles:
 *   { indicators: { price, ema, stochRSI, analysis, metadata }, structure, ... }
 *
 * Getting this shape right is the point — several defects in this engine came
 * from code reading `indicators.swingLow` when swing points actually live at
 * `structure.swingLow`, and a fixture that mirrored the buggy read rather than
 * the real payload would have hidden them.
 */
function tf({
  price,
  trend = 'flat',
  pullbackState = 'NEUTRAL',
  distanceFrom21EMA = 0,
  ema21 = price,
  ema200 = price,
  stochK = 50,
  stochD = 50,
  stochCondition = 'NEUTRAL',
  swingHigh = null,
  swingLow = null
}) {
  return {
    indicators: {
      price: { current: price, high: price * 1.01, low: price * 0.99 },
      ema: { ema21, ema200, ema21History: [ema21], ema200History: [ema200] },
      stochRSI: { k: stochK, d: stochD, condition: stochCondition, history: [] },
      analysis: { trend, pullbackState, distanceFrom21EMA },
      metadata: { candleCount: 500, lastBarClosed: true }
    },
    structure: { swingHigh, swingLow },
    candleCount: 500,
    lastCandle: { open: price, high: price, low: price, close: price, volume: 1 }
  };
}

/** Collect every strategy slot that came back claiming a tradeable signal. */
function validSignals(result) {
  const out = [];
  for (const [name, s] of Object.entries(result.strategies || {})) {
    if (s && s.valid === true) out.push({ name, ...s });
  }
  return out;
}

/** Does this signal have coherent long/short geometry? */
function geometryOk(s) {
  if (!s.entryZone || !Number.isFinite(s.entryZone.min) || !Number.isFinite(s.entryZone.max)) return false;
  if (!Number.isFinite(s.stopLoss)) return false;
  const mid = (s.entryZone.min + s.entryZone.max) / 2;
  const targets = (s.targets || []).filter((t) => Number.isFinite(t));
  if (targets.length === 0) return false;
  if (Math.abs(mid - s.stopLoss) <= 0) return false;

  if (s.direction === 'long') {
    if (s.stopLoss >= s.entryZone.min) return false;
    if (targets.some((t) => t <= s.entryZone.max)) return false;
  } else if (s.direction === 'short') {
    if (s.stopLoss <= s.entryZone.max) return false;
    if (targets.some((t) => t >= s.entryZone.min)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
section('1. No strategy may emit incoherent stop/target geometry');
// ---------------------------------------------------------------------------

{
  /* The reproduced case: BTC consolidating just above a lagging 4H EMA21, with
   * the 20-bar rolling "swing low" sitting ABOVE the current price. calculateSLTP
   * computes `risk = entry - stop` unsigned, so the stop lands above entry and
   * both targets land below it — a LONG that profits when price falls.
   *
   * On identical data TREND_4H was correctly rejected while TREND_RIDER shipped
   * the same geometry as a valid LONG at 84% confidence and won bestSignal,
   * because only one of the two paths reached the validator. */
  const price = 110000;
  const data = {
    '1M': tf({ price, trend: 'uptrend' }),
    '1w': tf({ price, trend: 'uptrend' }),
    '3d': tf({ price, trend: 'uptrend', pullbackState: 'OVEREXTENDED', distanceFrom21EMA: -10, swingLow: 109000, swingHigh: 115000 }),
    '1d': tf({ price, trend: 'uptrend', pullbackState: 'RETRACING', distanceFrom21EMA: -2, ema21: 108800, swingLow: 109000, swingHigh: 114000 }),
    '4h': tf({ price, trend: 'uptrend', pullbackState: 'RETRACING', distanceFrom21EMA: 1.38, ema21: 108500, ema200: 105000, stochCondition: 'BULLISH', stochK: 45, stochD: 40, swingLow: 109000, swingHigh: 112000 }),
    '1h': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.5, ema21: 109500, ema200: 107000, stochCondition: 'BULLISH', stochK: 40, stochD: 35, swingLow: 109200, swingHigh: 111000 }),
    '15m': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.1, ema21: 109900, stochCondition: 'OVERSOLD', stochK: 15, stochD: 12, swingLow: 109800, swingHigh: 110500 }),
    '5m': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.05, ema21: 109950, stochCondition: 'OVERSOLD', stochK: 12, stochD: 10, swingLow: 109900, swingHigh: 110200 })
  };

  for (const mode of ['STANDARD', 'AGGRESSIVE']) {
    const result = evaluateAllStrategies('BTCUSDT', data, mode);
    const signals = validSignals(result);
    const broken = signals.filter((s) => !geometryOk(s));

    assert(broken.length === 0,
      `${mode}: every emitted signal has coherent geometry`,
      broken.length
        ? broken.map((b) => `${b.name} ${b.direction} entry~${((b.entryZone.min + b.entryZone.max) / 2).toFixed(0)} stop ${b.stopLoss} targets ${JSON.stringify(b.targets)}`).join(' | ')
        : '');

    // The engine must not simultaneously reject and accept the same geometry.
    const bestName = result.bestSignal || null;
    if (bestName && result.strategies[bestName] && result.strategies[bestName].valid) {
      assert(geometryOk(result.strategies[bestName]),
        `${mode}: bestSignal itself has coherent geometry`,
        `${bestName} ${JSON.stringify(result.strategies[bestName].targets)}`);
    } else {
      assert(true, `${mode}: bestSignal is not a broken signal (none selected)`);
    }
  }
}

// ---------------------------------------------------------------------------
section('2. SCALP_1H must not throw (temporal dead zone regression)');
// ---------------------------------------------------------------------------

{
  /* A `const htfBias` re-declaration sat below an earlier read of htfBias in
   * the same block, so every SCALP_1H evaluation that reached it threw
   * `ReferenceError: Cannot access 'htfBias' before initialization`. The throw
   * was caught upstream and rewritten first to "Internal error" and then to the
   * generic "No trade setup available" — so a permanently broken strategy
   * reported to the user as a clean no-setup.
   *
   * We cannot assert SCALP_1H produces a signal (that depends on the rest of
   * the engine), but we CAN assert the reason it gives is never an internal
   * error, which is what a TDZ throw laundered into. */
  const price = 110000;
  const data = {
    '1M': tf({ price, trend: 'uptrend' }),
    '1w': tf({ price, trend: 'uptrend' }),
    '3d': tf({ price, trend: 'uptrend', swingLow: 100000, swingHigh: 120000 }),
    '1d': tf({ price, trend: 'uptrend', ema21: 108000, swingLow: 104000, swingHigh: 118000 }),
    '4h': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.4, ema21: 109560, ema200: 106000, stochCondition: 'BULLISH', stochK: 45, stochD: 42, swingLow: 107000, swingHigh: 112000 }),
    '1h': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.45, ema21: 109507, ema200: 107500, stochCondition: 'BULLISH', stochK: 44, stochD: 40, swingLow: 108500, swingHigh: 111000 }),
    '15m': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.09, ema21: 109901, stochCondition: 'BULLISH', stochK: 42, stochD: 38, swingLow: 109500, swingHigh: 110400 }),
    '5m': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.02, ema21: 109978, stochCondition: 'BULLISH', stochK: 40, stochD: 36, swingLow: 109800, swingHigh: 110100 })
  };

  for (const mode of ['STANDARD', 'AGGRESSIVE']) {
    let threw = null;
    let result = null;
    try {
      result = evaluateAllStrategies('BTCUSDT', data, mode);
    } catch (err) {
      threw = err;
    }
    assert(threw === null, `${mode}: evaluateAllStrategies does not throw`, threw ? String(threw && threw.message) : '');

    if (result) {
      const scalp = result.strategies && result.strategies.SCALP_1H;
      const reason = (scalp && scalp.reason) || '';
      assert(!/internal error/i.test(reason),
        `${mode}: SCALP_1H reason is not a laundered internal error`,
        reason);
    }
  }
}

// ---------------------------------------------------------------------------
section('3. Missing evidence must lower confidence, never earn it');
// ---------------------------------------------------------------------------

{
  /* Every absent confidence layer used to default to a 1.0 multiplier —
   * identical to perfect alignment — so a total market-data blackout produced
   * a fully specified SWING signal at confidence 80, clear of its own 60 gate,
   * built on no evidence at all.
   *
   * Absent layers now forfeit their weight, so a blackout cannot clear a gate. */
  const price = 110000;

  // Only the two timeframes the engine hard-requires, everything else absent:
  // no macro series, no execution series, no microstructure.
  const starved = {
    '4h': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.4, ema21: 109560, ema200: 106000, stochCondition: 'BULLISH', stochK: 45, stochD: 42, swingLow: 107000, swingHigh: 112000 }),
    '1h': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.45, ema21: 109507, ema200: 107500, stochCondition: 'BULLISH', stochK: 44, stochD: 40, swingLow: 108500, swingHigh: 111000 })
  };

  const full = {
    ...starved,
    '1M': tf({ price, trend: 'uptrend' }),
    '1w': tf({ price, trend: 'uptrend' }),
    '3d': tf({ price, trend: 'uptrend', swingLow: 100000, swingHigh: 120000 }),
    '1d': tf({ price, trend: 'uptrend', ema21: 108000, swingLow: 104000, swingHigh: 118000 }),
    '15m': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.09, ema21: 109901, stochCondition: 'BULLISH', stochK: 42, stochD: 38, swingLow: 109500, swingHigh: 110400 }),
    '5m': tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.02, ema21: 109978, stochCondition: 'BULLISH', stochK: 40, stochD: 36, swingLow: 109800, swingHigh: 110100 })
  };

  const starvedBest = Math.max(0, ...validSignals(evaluateAllStrategies('BTCUSDT', starved, 'STANDARD')).map((s) => s.confidence));
  const fullBest = Math.max(0, ...validSignals(evaluateAllStrategies('BTCUSDT', full, 'STANDARD')).map((s) => s.confidence));

  assert(starvedBest <= fullBest,
    'a starved payload never scores above a complete one (end to end)',
    `starved=${starvedBest} full=${fullBest}`);

  /* The end-to-end comparison above is a useful invariant but it does NOT
   * isolate this defect: the two payloads admit different strategies, so a
   * difference could come from strategy selection rather than from evidence
   * weighting. Assert the rule directly on the confidence function, where the
   * only thing that varies is how much evidence exists. */
  const aligned4h1h = {
    '4h': tf({ price, trend: 'uptrend', stochCondition: 'BULLISH', stochK: 45, stochD: 42 }),
    '1h': tf({ price, trend: 'uptrend', stochCondition: 'BULLISH', stochK: 44, stochD: 40 })
  };
  const withMacroAndExec = {
    ...aligned4h1h,
    '1d': tf({ price, trend: 'uptrend' }),
    '3d': tf({ price, trend: 'uptrend' }),
    '15m': tf({ price, trend: 'uptrend', stochCondition: 'BULLISH', stochK: 42, stochD: 38 }),
    '5m': tf({ price, trend: 'uptrend', stochCondition: 'BULLISH', stochK: 40, stochD: 36 })
  };

  const cPartial = calculateConfidenceWithHierarchy(aligned4h1h, 'long', 'STANDARD', 'SWING').confidence;
  const cComplete = calculateConfidenceWithHierarchy(withMacroAndExec, 'long', 'STANDARD', 'SWING').confidence;
  const cNothing = calculateConfidenceWithHierarchy({}, 'long', 'STANDARD', 'SWING').confidence;

  // Under the old defaults every absent layer contributed a 1.0 multiplier —
  // identical to perfect alignment — so all three of these were equal at 80.
  assert(cPartial < cComplete,
    'absent macro and execution layers score STRICTLY below aligned ones',
    `partial=${cPartial} complete=${cComplete}`);

  assert(cNothing < cPartial,
    'no evidence at all scores strictly below partial evidence',
    `nothing=${cNothing} partial=${cPartial}`);

  assert(cNothing < 60,
    'a total data blackout cannot clear the 60 admission gate',
    `blackout confidence=${cNothing}`);
}

// ---------------------------------------------------------------------------
section('4. Degenerate inputs must not produce a confident signal');
// ---------------------------------------------------------------------------

{
  /* `currentPrice` fell back to `|| 0` when price was unavailable, and a price
   * of zero passes every `price < ema` comparison — producing a fully formed
   * SHORT at 83% confidence derived from nothing. */
  const zeroPrice = {
    '4h': tf({ price: 0, trend: 'downtrend', pullbackState: 'ENTRY_ZONE', ema21: 109560, ema200: 106000, stochCondition: 'BEARISH', swingLow: 107000, swingHigh: 112000 }),
    '1h': tf({ price: 0, trend: 'downtrend', pullbackState: 'ENTRY_ZONE', ema21: 109507, ema200: 107500, stochCondition: 'BEARISH', swingLow: 108500, swingHigh: 111000 }),
    '15m': tf({ price: 0, trend: 'downtrend', pullbackState: 'ENTRY_ZONE', ema21: 109901, stochCondition: 'BEARISH', swingLow: 109500, swingHigh: 110400 }),
    '5m': tf({ price: 0, trend: 'downtrend', pullbackState: 'ENTRY_ZONE', ema21: 109978, stochCondition: 'BEARISH', swingLow: 109800, swingHigh: 110100 })
  };

  let threw = null;
  let signals = [];
  try {
    signals = validSignals(evaluateAllStrategies('BTCUSDT', zeroPrice, 'AGGRESSIVE'));
  } catch (err) {
    threw = err;
  }

  assert(threw === null, 'a zero-price payload does not throw', threw ? String(threw && threw.message) : '');
  assert(signals.every((s) => geometryOk(s)),
    'a zero-price payload emits no geometrically incoherent signal',
    signals.filter((s) => !geometryOk(s)).map((s) => s.name).join(', '));
}

// ---------------------------------------------------------------------------
section('5. Empty and malformed payloads');
// ---------------------------------------------------------------------------

{
  for (const [label, payload] of [
    ['empty object', {}],
    ['nulls for every timeframe', { '4h': null, '1h': null, '15m': null, '5m': null }],
    ['indicators present but empty', { '4h': { indicators: {} }, '1h': { indicators: {} } }]
  ]) {
    let threw = null;
    let signals = [];
    try {
      signals = validSignals(evaluateAllStrategies('BTCUSDT', payload, 'AGGRESSIVE'));
    } catch (err) {
      threw = err;
    }
    assert(threw === null, `${label}: does not throw`, threw ? String(threw && threw.message) : '');
    assert(signals.length === 0, `${label}: emits no tradeable signal`, signals.map((s) => s.name).join(', '));
  }
}

// ---------------------------------------------------------------------------
section('6. Stop resolution: structure first, volatility second, never a literal');
// ---------------------------------------------------------------------------

{
  const entry = 110000;

  // A structural level on the correct side wins outright.
  const structural = resolveStop({ entry, direction: 'long', structuralCandidates: [108000, 107000], atr: 500 });
  assert(structural && structural.source === 'STRUCTURE' && structural.price === 108000,
    'long takes the tightest valid structural low',
    JSON.stringify(structural));

  const structuralShort = resolveStop({ entry, direction: 'short', structuralCandidates: [112000, 113000], atr: 500 });
  assert(structuralShort && structuralShort.source === 'STRUCTURE' && structuralShort.price === 112000,
    'short takes the tightest valid structural high',
    JSON.stringify(structuralShort));

  /* THE ROOT CAUSE OF THE INVERTED GEOMETRY. A rolling 20-bar "swing low" can
   * sit ABOVE the current price; used as a long's stop it produces a negative
   * R and targets below entry. A level on the wrong side of entry is a
   * windowing artefact, not an invalidation level, and must be discarded. */
  const wrongSide = resolveStop({ entry, direction: 'long', structuralCandidates: [111000], atr: 500 });
  assert(wrongSide && wrongSide.source === 'ATR',
    'a structural low ABOVE a long entry is rejected, not used',
    JSON.stringify(wrongSide));
  assert(wrongSide && wrongSide.price < entry,
    'the resulting long stop is below entry',
    JSON.stringify(wrongSide));

  const wrongSideShort = resolveStop({ entry, direction: 'short', structuralCandidates: [109000], atr: 500 });
  assert(wrongSideShort && wrongSideShort.price > entry,
    'a structural high BELOW a short entry is rejected; resulting stop is above entry',
    JSON.stringify(wrongSideShort));

  // Volatility fallback is scaled by ATR, not by a fixed percentage.
  const calm = resolveStop({ entry, direction: 'long', structuralCandidates: [], atr: 200 });
  const wild = resolveStop({ entry, direction: 'long', structuralCandidates: [], atr: 2000 });
  assert(calm && wild && (entry - calm.price) < (entry - wild.price),
    'a higher ATR produces a wider stop',
    `calm=${calm && calm.price} wild=${wild && wild.price}`);
  assert(calm && Math.abs((entry - calm.price) - 200 * ATR_STOP_FALLBACK_MULTIPLE) < 1e-6,
    'the ATR fallback distance is exactly the published multiple',
    JSON.stringify(calm));

  /* With neither structure nor volatility, the answer is NULL — not a
   * percentage. A stop sets the position size, so inventing one is fabricating
   * a risk level, the same class of defect as fabricating a candle. */
  assert(resolveStop({ entry, direction: 'long', structuralCandidates: [], atr: null }) === null,
    'no structure and no ATR yields null, never an invented percentage');
  assert(resolveStop({ entry, direction: 'long', structuralCandidates: [NaN, null, 0], atr: undefined }) === null,
    'unusable structural candidates do not become a stop');
  assert(resolveStop({ entry: 0, direction: 'long', structuralCandidates: [], atr: 500 }) === null,
    'a zero entry yields null');
}

// ---------------------------------------------------------------------------
section('7. A caller must supply the macro layer to get a STANDARD signal');
// ---------------------------------------------------------------------------

{
  /* Since a missing evidence layer forfeits its weight, any caller that omits
   * the macro timeframes caps a STANDARD signal at 60% of its table value —
   * below every strategy's own admission gate. The scanner used to default to
   * 4h/1h/15m/5m and would have returned NOTHING.
   *
   * This is a real constraint on callers, not an implementation detail, so it
   * is pinned here: if someone trims a timeframe list to save a round trip,
   * this fails loudly instead of the dashboard quietly going empty. */
  const price = 110000;
  const t = () => tf({ price, trend: 'uptrend', pullbackState: 'ENTRY_ZONE', distanceFrom21EMA: 0.4, ema21: 109500, ema200: 106000, stochCondition: 'BULLISH', stochK: 45, stochD: 42, swingLow: 108000, swingHigh: 112000 });

  const withoutMacro = { '4h': t(), '1h': t(), '15m': t(), '5m': t() };
  const withMacro = { ...withoutMacro, '1d': t(), '3d': t() };

  const none = validSignals(evaluateAllStrategies('BTCUSDT', withoutMacro, 'STANDARD'));
  const some = validSignals(evaluateAllStrategies('BTCUSDT', withMacro, 'STANDARD'));

  assert(none.length === 0,
    'omitting 1d/3d yields no STANDARD signal — evidence must be present to be scored',
    none.map((s) => `${s.name}=${s.confidence}`).join(' '));

  assert(some.length > 0,
    'supplying 1d/3d lets the same setup qualify',
    some.map((s) => `${s.name}=${s.confidence}`).join(' '));
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log(`Strategy safety: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  process.exit(1);
}
console.log('All strategy safety assertions passed.');
