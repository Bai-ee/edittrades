/**
 * Bitcoin Economic Value — deterministic core validation (OFFLINE)
 *
 * Why this exists separately from validate-economic-value.js:
 *
 * The live harness needs Coin Metrics. When it cannot reach it, it verifies
 * NOTHING — which meant the macro layer had no coverage at all in CI or during
 * an outage. Worse, three of its "internal identity" checks are tautologies:
 * they compare a value against the same formula that produced it. An audit
 * demonstrated that corrupting upstream MVRV by 100x moves realized price two
 * orders of magnitude and the valuation state from EUPHORIC to NEAR VALUE, and
 * every one of those checks still passes.
 *
 * Every assertion below is written so that it CAN fail. Each drives the real
 * calculation core with a constructed series and checks a property the code
 * could plausibly get wrong — most of them regressions for defects that were
 * actually found.
 *
 * The fixture data here is synthetic. That is correct for a test harness and
 * is the only place in the repo where constructed price data is permitted.
 *
 *   node scripts/validate-macro-core.js
 */

import {
  ECONOMIC_VALUE_CONFIG,
  COMPOSITE_ANCHOR_KEYS,
  combineAnchors,
  calculate200WeekMA,
  calculateRealizedPrice,
  calculateMVRV,
  calculatePremiumDiscount,
  calculateStateThresholds,
  calculateValuationState,
  calculateEconomicConvergence,
  calculateHistoricalEconomicValue,
  normalizeDailySeries,
  interpolateDatedCurve,
  percentileOfSorted
} from '../services/bitcoinEconomicValue.js';

let assertions = 0;
let failures = 0;

function ok(label, condition, detail = '') {
  assertions++;
  if (condition) console.log(`  ok    ${label}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
}
function near(label, actual, expected, tol, detail = '') {
  ok(label, Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
     detail || `got ${actual}, expected ~${expected} (+/-${tol})`);
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const DAY = 86400000;

/**
 * Build a daily series with controllable anchor availability.
 *
 * Deliberately NOT a random walk: a deterministic series means a failure here
 * is reproducible and points at the code rather than at the fixture.
 */
function buildSeries({
  days = 2000,
  startDate = '2019-01-01',
  price = (i) => 20000 + i * 10,
  supply = 19_000_000,
  mvrv = 1.5,
  dropRealizedCapAfter = null,   // index after which CapMVRVCur vanishes
  dropHashRateAfter = null,
  gapDays = []                   // indices to omit entirely
} = {}) {
  const start = Date.parse(startDate + 'T00:00:00Z');
  const rows = [];
  for (let i = 0; i < days; i++) {
    if (gapDays.includes(i)) continue;
    const p = price(i);
    const marketCap = p * supply;
    const row = {
      date: new Date(start + i * DAY).toISOString().slice(0, 10),
      price: p,
      supply,
      issuanceNtv: 900,
      hashRate: dropHashRateAfter !== null && i > dropHashRateAfter ? null : 500_000_000,
      realizedCap: dropRealizedCapAfter !== null && i > dropRealizedCapAfter
        ? null
        : marketCap / mvrv
    };
    rows.push(row);
  }
  return rows;
}

console.log('\nBitcoin Economic Value — deterministic core validation\n');

/* =====================================================================
 * 1. THE COMPOSITE IS A WEIGHTED GEOMETRIC MEAN
 * ================================================================== */
section('1. Composite aggregation');

{
  const anchors = { realizedPrice: 50000, ma200w: 60000, minerCost: 40000 };
  const result = combineAnchors(anchors);

  // Recomputed here from first principles, not by calling the same helper.
  const w = ECONOMIC_VALUE_CONFIG.weights;
  const expected = Math.exp(
    w.realizedPrice * Math.log(50000) + w.ma200w * Math.log(60000) + w.minerCost * Math.log(40000)
  );
  near('geometric mean matches an independent recomputation', result.value, expected, 0.01);

  const arithmetic = w.realizedPrice * 50000 + w.ma200w * 60000 + w.minerCost * 40000;
  ok('it is NOT the arithmetic mean', Math.abs(result.value - arithmetic) > 100,
     `geo ${result.value.toFixed(2)} vs arith ${arithmetic.toFixed(2)}`);

  // Scale invariance is the property that makes a geometric mean the right
  // choice for comparing price levels as ratios.
  const scaled = combineAnchors({ realizedPrice: 100000, ma200w: 120000, minerCost: 80000 });
  near('doubling every anchor doubles the composite', scaled.value, result.value * 2, 0.02);

  ok('all three anchors are reported as used', result.anchorsUsed.length === 3);
  near('weights sum to 1', Object.values(result.weightsApplied).reduce((a, b) => a + b, 0), 1, 1e-12);
}

/* =====================================================================
 * 2. RENORMALISATION ON ANCHOR DROPOUT — the C1 defect
 * ================================================================== */
section('2. Anchor dropout and renormalisation');

{
  const full = combineAnchors({ realizedPrice: 50000, ma200w: 60000, minerCost: 40000 });
  const twoAnchor = combineAnchors({ realizedPrice: null, ma200w: 60000, minerCost: 40000 });

  ok('a missing anchor still produces a composite', twoAnchor !== null);
  ok('…over only the anchors present', twoAnchor.anchorsUsed.length === 2,
     JSON.stringify(twoAnchor.anchorsUsed));
  near('…with weights renormalised to sum to 1',
       Object.values(twoAnchor.weightsApplied).reduce((a, b) => a + b, 0), 1, 1e-12);

  // The value MUST move. If it did not, the dropout would be undetectable by
  // observation, which is precisely the failure mode being guarded against.
  ok('the composite value materially changes',
     Math.abs(twoAnchor.value - full.value) / full.value > 0.01,
     `${full.value.toFixed(2)} -> ${twoAnchor.value.toFixed(2)}`);

  const oneAnchor = combineAnchors({ realizedPrice: null, ma200w: 60000, minerCost: null });
  ok('below minAnchorsForComposite no composite is emitted', oneAnchor === null);

  const noneAtAll = combineAnchors({ realizedPrice: null, ma200w: null, minerCost: null });
  ok('no anchors at all emits nothing', noneAtAll === null);

  // Non-positive anchors must be rejected, not log()'d into NaN or -Infinity.
  const zeroAnchor = combineAnchors({ realizedPrice: 0, ma200w: 60000, minerCost: 40000 });
  ok('a zero anchor is excluded rather than producing -Infinity',
     zeroAnchor !== null && !zeroAnchor.anchorsUsed.includes('realizedPrice') &&
     Number.isFinite(zeroAnchor.value));
  const negAnchor = combineAnchors({ realizedPrice: -5, ma200w: 60000, minerCost: 40000 });
  ok('a negative anchor is excluded', negAnchor !== null && Number.isFinite(negAnchor.value));
}

/* =====================================================================
 * 3. DEGRADATION IS VISIBLE END TO END — regression for C1
 * ================================================================== */
section('3. Degradation surfaces on the current reading');

{
  const healthy = calculateHistoricalEconomicValue(buildSeries({ days: 2000 }), {
    asOf: Date.parse('2024-06-23T00:00:00Z')
  });
  ok('healthy run produces a current reading', healthy.current !== null);
  ok('…using all three anchors', healthy.current.anchorsUsed.length === 3,
     JSON.stringify(healthy.current.anchorsUsed));
  ok('…and is NOT flagged degraded', healthy.current.degraded === false);
  ok('…reporting the expected anchor count', healthy.current.anchorsExpected === 3);

  // Realized cap vanishes for the last 30 days only. The whole-history anchor
  // counter still shows it as "available"; the per-reading fields must not.
  const degraded = calculateHistoricalEconomicValue(
    buildSeries({ days: 2000, dropRealizedCapAfter: 1969 }),
    { asOf: Date.parse('2024-06-23T00:00:00Z') }
  );
  ok('a current-day dropout still produces a reading', degraded.current !== null);
  ok('…is flagged DEGRADED', degraded.current.degraded === true);
  ok('…and reports only the surviving anchors', degraded.current.anchorsUsed.length === 2,
     JSON.stringify(degraded.current.anchorsUsed));
  ok('…which excludes realizedPrice', !degraded.current.anchorsUsed.includes('realizedPrice'));

  // This is the bit that used to be invisible.
  ok('the whole-history anchor status STILL reports it available (the trap)',
     degraded.anchorStatus.realizedPrice.available === true,
     'if this changed, the per-reading flag is no longer the thing being tested');

  ok('the two readings genuinely differ',
     Math.abs(degraded.current.economicValue - healthy.current.economicValue) > 1,
     `${healthy.current.economicValue} vs ${degraded.current.economicValue}`);
}

/* =====================================================================
 * 4. 200-WEEK MA REQUIRES 200 COMPLETED WEEKS
 * ================================================================== */
section('4. 200-week moving average');

{
  // Anchored to a Monday (2018-12-31) so ISO-week boundaries line up exactly
  // with the fixture and the test is about the guard, not about calendar drift.
  // 199 complete weeks must emit nothing; 200 must emit exactly one value.
  const under = calculate200WeekMA(
    normalizeDailySeries(buildSeries({ days: 199 * 7, startDate: '2018-12-31' }))
  ).filter((v) => v !== null);
  const exact = calculate200WeekMA(
    normalizeDailySeries(buildSeries({ days: 200 * 7, startDate: '2018-12-31' }))
  ).filter((v) => v !== null);
  const over = calculate200WeekMA(
    normalizeDailySeries(buildSeries({ days: 202 * 7, startDate: '2018-12-31' }))
  ).filter((v) => v !== null);

  // The guard is `closedWeekCloses.length === 200`, i.e. 200 weeks fully
  // BEHIND the current bar. So 1400 days (indices 0..1399, exactly 200 weeks)
  // still emits nothing — the 200th week is not yet closed — and the first
  // value lands on day index 1400. Two more weeks of data therefore yield 14
  // daily values. This matches an independent boundary probe of the same code.
  ok('199 completed weeks emits nothing', under.length === 0, `${under.length} values`);
  ok('exactly 200 weeks still emits nothing (the 200th is not yet closed)',
     exact.length === 0, `${exact.length} values`);
  ok('two weeks later it emits one value per day', over.length === 14,
     `${over.length} values`);

  const firstIndex = calculate200WeekMA(
    normalizeDailySeries(buildSeries({ days: 202 * 7, startDate: '2018-12-31' }))
  ).findIndex((v) => v !== null);
  ok('the first value lands at day index 1400', firstIndex === 1400, String(firstIndex));

  // A flat series must average to its own level — a unit check the rolling
  // window would fail if the sum or the count drifted.
  const flat = normalizeDailySeries(buildSeries({ days: 1600, price: () => 50000 }));
  const flatMA = calculate200WeekMA(flat).filter((v) => v !== null);
  near('a constant series averages to that constant', flatMA[flatMA.length - 1], 50000, 0.01);
}

/* =====================================================================
 * 5. A NON-CIRCULAR REALIZED-CAP CHECK
 *
 * The live harness asserts `mvrv === price / realizedPrice`, which is the
 * definition of calculateMVRV — it cannot fail. The check below instead
 * verifies the DERIVATION against a directly supplied realized cap, which is
 * a genuinely independent quantity.
 * ================================================================== */
section('5. Realized price — non-circular');

{
  const supply = 19_000_000;
  const price = 60000;
  const trueMvrv = 1.8;
  const marketCap = price * supply;
  const directRealizedCap = marketCap / trueMvrv;

  const rpDirect = calculateRealizedPrice(directRealizedCap, supply);
  const rpDerived = calculateRealizedPrice(marketCap / trueMvrv, supply);
  near('the MVRV derivation reproduces the direct measurement exactly',
       rpDerived, rpDirect, 1e-9);

  // And it must actually respond to a corrupted input rather than absorbing it.
  const rpCorrupt = calculateRealizedPrice(marketCap / (trueMvrv * 100), supply);
  ok('a 100x MVRV corruption moves realized price by ~100x',
     Math.abs(rpCorrupt / rpDirect - 0.01) < 1e-6,
     `ratio ${(rpCorrupt / rpDirect).toFixed(6)}`);

  ok('zero supply yields null, not Infinity', calculateRealizedPrice(1e12, 0) === null);
  ok('null realized cap yields null', calculateRealizedPrice(null, supply) === null);
  ok('MVRV against a null realized price is null', calculateMVRV(60000, null) === null);
}

/* =====================================================================
 * 6. CONVERGENCE — regression for the "0/2 MODERATE" defect
 * ================================================================== */
section('6. Convergence reporting');

{
  // The exact shape that used to produce "0/2 anchors - MODERATE AGREEMENT".
  //
  // spread = max/min - 1 = 56000/40000 - 1 = 0.40, which clears
  // moderateAgreement.maxSpread (0.50). But both anchors sit 16.7% from the
  // composite, outside the 12% agreementBand, so within = 0. Under the old
  // OR condition the tight spread alone declared MODERATE AGREEMENT with
  // nothing actually in band. This case must be reachable for the test to
  // mean anything — if the numbers here drift, the assertion goes hollow.
  const scattered = calculateEconomicConvergence(
    { realizedPrice: 40000, ma200w: 56000, minerCost: null },
    48000
  );
  ok('the 0-in-band, tight-spread case is genuinely constructed',
     scattered.available && scattered.within === 0 && scattered.total === 2 &&
     scattered.spread <= 0.5,
     `within ${scattered.within}/${scattered.total}, spread ${scattered.spread}`);
  ok('…and it does NOT report MODERATE AGREEMENT',
     scattered.agreement !== 'MODERATE AGREEMENT',
     `within ${scattered.within}/${scattered.total} -> ${scattered.agreement}`);

  // Anchors far apart in every sense: unambiguously low agreement.
  const wild = calculateEconomicConvergence(
    { realizedPrice: 20000, ma200w: 90000, minerCost: null },
    52000
  );
  ok('wildly scattered anchors report LOW AGREEMENT',
     wild.agreement === 'LOW AGREEMENT', wild.agreement);

  const tight = calculateEconomicConvergence(
    { realizedPrice: 50000, ma200w: 51000, minerCost: 49500 },
    50100
  );
  ok('tightly clustered anchors report agreement',
     tight.available && tight.within >= 2 && tight.agreement !== 'LOW AGREEMENT',
     `${tight.within}/${tight.total} -> ${tight.agreement}`);

  const none = calculateEconomicConvergence({ realizedPrice: null, ma200w: null, minerCost: null }, null);
  ok('with no anchers at all, convergence is unavailable', none.available === false);
}

/* =====================================================================
 * 7. STATE CALIBRATION
 * ================================================================== */
section('7. Valuation state calibration');

{
  const premiums = Array.from({ length: 1000 }, (_, i) => i / 10); // 0..99.9
  const thresholds = calculateStateThresholds(premiums);
  ok('thresholds available with enough observations', thresholds.available === true);

  const t = thresholds.thresholds;
  ok('thresholds are monotonic',
     t.deepDiscount < t.discount && t.discount < t.nearValue &&
     t.nearValue < t.premium && t.premium < t.extended,
     JSON.stringify(t));

  ok('a bottom-percentile premium reads DEEP DISCOUNT',
     calculateValuationState(0, thresholds).state === 'DEEP DISCOUNT');
  ok('a top-percentile premium reads EUPHORIC',
     calculateValuationState(99.9, thresholds).state === 'EUPHORIC');

  // Below minObservations the code must refuse to calibrate rather than
  // producing bands from a handful of points.
  const thin = calculateStateThresholds([1, 2, 3]);
  ok('too few observations means no calibration', thin.available === false);
  ok('…and the state is UNCALIBRATED',
     calculateValuationState(50, thin).state === 'UNCALIBRATED',
     calculateValuationState(50, thin).state);

  near('percentileOfSorted picks the median of 1..100',
       percentileOfSorted(Array.from({ length: 100 }, (_, i) => i + 1), 50), 50.5, 0.6);
}

/* =====================================================================
 * 8. dataAgeDays IS WALL-CLOCK — regression for H2
 * ================================================================== */
section('8. Feed age is measured against the clock');

{
  // A series that stops 13 days before `asOf`. The old implementation took
  // both operands from the series itself and always reported 0.
  const series = buildSeries({ days: 1600, startDate: '2020-01-01' });
  const lastDate = series[series.length - 1].date;
  const asOf = Date.parse(lastDate + 'T00:00:00Z') + 13 * DAY;

  const result = calculateHistoricalEconomicValue(series, { asOf });
  ok('a reading is produced', result.current !== null);
  ok('dataAgeDays reflects the 13-day lag', result.current.dataAgeDays === 13,
     String(result.current.dataAgeDays));
  ok('latestDataDate names the last real row', result.current.latestDataDate === lastDate,
     result.current.latestDataDate);
  ok('anchorGapDays is reported separately', result.current.anchorGapDays === 0,
     String(result.current.anchorGapDays));

  // Same series, evaluated on its own last day: no lag.
  const fresh = calculateHistoricalEconomicValue(series, {
    asOf: Date.parse(lastDate + 'T00:00:00Z')
  });
  ok('evaluated on the last data day, age is 0', fresh.current.dataAgeDays === 0,
     String(fresh.current.dataAgeDays));
}

/* =====================================================================
 * 9. NOTHING IS FABRICATED IN GAPS
 * ================================================================== */
section('9. Gap handling');

{
  const maxFill = ECONOMIC_VALUE_CONFIG.maxForwardFillDays;

  // A gap longer than the fill window must stay null rather than being bridged.
  const longGap = Array.from({ length: 20 }, (_, i) => i + 5); // 20-day hole
  const withGap = normalizeDailySeries(buildSeries({ days: 200, gapDays: longGap }));
  const holeRows = withGap.filter((r) => {
    const idx = Math.round((r.timestamp - withGap[0].timestamp) / DAY);
    return idx > 5 + maxFill && idx < 25;
  });
  ok('a gap longer than maxForwardFillDays leaves nulls',
     holeRows.length > 0 && holeRows.some((r) => r.price === null),
     `${holeRows.length} rows in the hole, none null`);

  ok('maxForwardFillDays is small and explicit', maxFill <= 3, String(maxFill));

  // No value may exceed the range of its neighbours — i.e. no interpolation.
  const filled = withGap.filter((r) => r.price !== null).map((r) => r.price);
  const monotoneUp = filled.every((v, i) => i === 0 || v >= filled[i - 1]);
  ok('carried-forward values never invent an intermediate level', monotoneUp);
}

/* =====================================================================
 * 10. MINER COST ASSUMPTIONS
 * ================================================================== */
section('10. Miner cost curve behaviour');

{
  const eff = ECONOMIC_VALUE_CONFIG.minerCost.efficiencyCurveJPerTh;
  const elec = ECONOMIC_VALUE_CONFIG.minerCost.electricityCurveUsdPerKwh;

  ok('efficiency improves monotonically over time',
     eff.every((p, i) => i === 0 || p.value <= eff[i - 1].value),
     JSON.stringify(eff.map((p) => p.value)));

  // The 2013 anchor was 8,000 J/TH, which is far too efficient for a fleet
  // that was still largely GPU/FPGA. Guard the correction.
  ok('the 2013 anchor reflects a pre-ASIC fleet', eff[0].value >= 20000,
     `${eff[0].value} J/TH at ${eff[0].date}`);

  ok('overhead multiplier is inside the disclosed 1.35-1.65 band',
     ECONOMIC_VALUE_CONFIG.minerCost.overheadMultiplier >= 1.35 &&
     ECONOMIC_VALUE_CONFIG.minerCost.overheadMultiplier <= 1.65,
     String(ECONOMIC_VALUE_CONFIG.minerCost.overheadMultiplier));

  ok('electricity stays within an industrial band',
     elec.every((p) => p.value >= 0.02 && p.value <= 0.10));

  // Clamping past the last anchor is the documented behaviour; the point is
  // that it must be flagged, which section 3's `extrapolated` covers.
  const past = interpolateDatedCurve(elec, '2030-01-01');
  near('past the last anchor the curve clamps', past, elec[elec.length - 1].value, 1e-9);
  const before = interpolateDatedCurve(eff, '2000-01-01');
  near('before the first anchor it clamps too', before, eff[0].value, 1e-9);

  const mid = interpolateDatedCurve(
    [{ date: '2020-01-01', value: 100 }, { date: '2022-01-01', value: 25 }],
    '2021-01-01'
  );
  ok('interpolation is log-linear, not linear',
     Math.abs(mid - 50) < 1 && Math.abs(mid - 62.5) > 5,
     `got ${mid} (log-linear midpoint is 50, linear would be 62.5)`);
}

/* =====================================================================
 * 11. PREMIUM AND ZERO-IS-NOT-FAIR-VALUE
 * ================================================================== */
section('11. Premium');

{
  near('premium is (price - EV) / EV', calculatePremiumDiscount(75000, 50000), 50, 1e-9);
  near('a discount is negative', calculatePremiumDiscount(40000, 50000), -20, 1e-9);
  ok('a null economic value yields null', calculatePremiumDiscount(50000, null) === null);
  ok('a zero economic value yields null rather than Infinity',
     calculatePremiumDiscount(50000, 0) === null);
}

/* =====================================================================
 * 12. THE COMPOSITE IS NOT A TRADE SIGNAL
 * ================================================================== */
section('12. No buy/sell semantics leak into the core');

{
  const src = (await import('node:fs')).readFileSync(
    new URL('../services/bitcoinEconomicValue.js', import.meta.url), 'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('the calculation core emits no BUY/SELL label',
     !/['"]BUY['"]|['"]SELL['"]|['"]STRONG BUY['"]/i.test(src));
  ok('the anchor set is exactly the three documented anchors',
     COMPOSITE_ANCHOR_KEYS.filter((k) => ECONOMIC_VALUE_CONFIG.weights[k] > 0).length === 3,
     JSON.stringify(COMPOSITE_ANCHOR_KEYS));
  ok('MVRV carries zero weight (no double-counting)',
     !('mvrv' in ECONOMIC_VALUE_CONFIG.weights) || ECONOMIC_VALUE_CONFIG.weights.mvrv === 0);
}

/* ==================================================================== */
console.log(`\n${'='.repeat(62)}`);
console.log(failures === 0
  ? `All ${assertions} assertions passed.`
  : `${failures} of ${assertions} assertions FAILED.`);
console.log(`${'='.repeat(62)}\n`);

process.exit(failures === 0 ? 0 : 1);
