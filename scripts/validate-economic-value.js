#!/usr/bin/env node
/**
 * Bitcoin Economic Value — validation harness
 *
 *   node scripts/validate-economic-value.js
 *
 * Runs the live provider -> calculation path and checks it against
 * independent recomputation and published external reference values.
 *
 * This is a REVIEW TOOL, not a pass/fail gate on truth. External references
 * are quoted from third parties and carry their own methodology differences,
 * so a deviation inside tolerance is agreement, a deviation outside it is a
 * prompt to go look — not proof that either side is wrong.
 *
 * Exit codes: 0 all checks inside tolerance, 1 something needs a human.
 */

import 'dotenv/config';
import * as providers from '../services/bitcoinDataProviders.js';
import {
  calculateHistoricalEconomicValue,
  calculate200WeekMA,
  normalizeDailySeries,
  estimateMinerProductionCost,
  ECONOMIC_VALUE_CONFIG
} from '../services/bitcoinEconomicValue.js';

/**
 * Published reference points, with the source that reported them.
 *
 * Tolerances are wide on purpose: providers disagree on exchange composition
 * for price, and on UTXO handling for realized cap. The goal is to catch a
 * unit error or a decimal-place slip, not to force agreement to the dollar.
 */
const PRICE_REFERENCES = [
  { date: '2017-12-17', price: 19650, tolerance: 0.08, note: '2017 cycle high' },
  { date: '2021-11-10', price: 69000, tolerance: 0.08, note: '2021 cycle high' },
  { date: '2022-11-21', price: 15750, tolerance: 0.08, note: '2022 cycle low' },
  { date: '2024-03-14', price: 73750, tolerance: 0.08, note: '2024 pre-halving high' }
];

const ONCHAIN_REFERENCES = [
  {
    date: '2026-08-08',
    realizedPrice: 52330,
    mvrv: 1.24,
    tolerance: 0.12,
    source: 'AhaSignals / market reports, Aug 2026'
  }
];

/** Cambridge CBECI-scale sanity band for implied network electricity draw. */
const CONSUMPTION_BAND_TWH = { min: 80, max: 320 };

let issues = 0;
let checks = 0;

const fmt = (value, decimals = 2) =>
  Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: decimals }) : 'n/a';

function report(name, ok, detail) {
  checks++;
  if (!ok) issues++;
  console.log(`  ${ok ? 'PASS' : 'CHECK'}  ${name}${detail ? '  —  ' + detail : ''}`);
}

/** Relative-difference comparison against a reference value. */
function compare(name, actual, expected, tolerance, note) {
  if (!Number.isFinite(actual)) {
    report(name, false, `no value produced (expected ~${fmt(expected)})`);
    return;
  }
  const deviation = Math.abs(actual - expected) / expected;
  report(
    name,
    deviation <= tolerance,
    `got ${fmt(actual)}, reference ${fmt(expected)}, off by ${(deviation * 100).toFixed(1)}% ` +
      `(tolerance ${(tolerance * 100).toFixed(0)}%)${note ? ' · ' + note : ''}`
  );
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

async function main() {
  console.log('Bitcoin Economic Value — validation');
  console.log(`Methodology version ${ECONOMIC_VALUE_CONFIG.version}`);

  section('1. Provider health');
  const series = await providers.getBitcoinEconomicSeries({ forceRefresh: true });
  const spot = await providers.getBitcoinSpotPrice();

  for (const [name, info] of Object.entries(series.sources)) {
    const ok = info.status === 'ok' || info.status === 'unavailable';
    console.log(`  ${info.status.toUpperCase().padEnd(13)} ${name}${info.error ? ' — ' + info.error : ''}${info.reason ? ' — ' + info.reason : ''}`);
    if (info.status === 'failed') issues++;
  }
  report('spot price available', Number.isFinite(spot.price), spot.price ? `$${fmt(spot.price)}` : spot.error);

  if (!series.rows.length) {
    console.log('\nNo data retrieved. Cannot continue.');
    process.exit(1);
  }

  const result = calculateHistoricalEconomicValue(series.rows, { spotPrice: spot.price });
  const byDate = new Map(result.history.map((row) => [row.date, row]));
  const current = result.current;

  section('2. Coverage');
  console.log(`  rows            ${fmt(result.history.length, 0)}`);
  console.log(`  first / last    ${result.history[0].date} → ${result.history.at(-1).date}`);
  for (const [key, status] of Object.entries(result.anchorStatus)) {
    console.log(`  ${key.padEnd(18)}${status.available ? fmt(status.observations, 0) + ' observations' : 'unavailable'}`);
  }
  report('composite produced', Number.isFinite(current?.economicValue), current ? `$${fmt(current.economicValue)}` : '');
  report(
    'at least two anchors drive the composite',
    Object.values(current?.weightsApplied || {}).length >= 2,
    Object.keys(current?.weightsApplied || {}).join(', ')
  );

  section('3. Internal identities');
  // Realized Price must equal realized cap / supply on the raw row.
  const rawLast = series.rows.filter((r) => Number.isFinite(r.realizedCap) && Number.isFinite(r.supply)).at(-1);
  if (rawLast) {
    const expected = rawLast.realizedCap / rawLast.supply;
    const produced = byDate.get(rawLast.date)?.realizedPrice;
    compare('realized price = realized cap / supply', produced, expected, 0.001);
  } else {
    report('realized price identity', false, 'no realized cap / supply rows available');
  }

  // MVRV must equal price / realized price.
  if (current && Number.isFinite(current.context.mvrv)) {
    compare('MVRV = price / realized price', current.context.mvrv, current.price / current.anchors.realizedPrice, 0.001);
  }

  // Premium must equal (price - EV) / EV.
  if (current) {
    compare(
      'premium = (price − EV) / EV',
      current.premiumDiscount,
      ((current.price - current.economicValue) / current.economicValue) * 100,
      0.01
    );
  }

  section('4. 200-week MA, independently recomputed');
  // Deliberately a different implementation from the module's rolling one:
  // bucket by ISO week, take each week's last close, mean the last 200.
  const normalized = normalizeDailySeries(series.rows);
  const moduleMA = calculate200WeekMA(normalized);

  const weekly = new Map();
  for (const row of normalized) {
    if (!Number.isFinite(row.price)) continue;
    const date = new Date(row.timestamp);
    const offset = (date.getUTCDay() - 1 + 7) % 7;
    weekly.set(row.timestamp - offset * 86400000, row.price);
  }
  const weeklyCloses = [...weekly.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  // Drop the in-progress week: the module only averages completed weeks.
  const completed = weeklyCloses.slice(0, -1);
  const independentMA =
    completed.length >= 200
      ? completed.slice(-200).reduce((sum, value) => sum + value, 0) / 200
      : null;

  compare('200W MA matches independent recomputation', moduleMA.at(-1), independentMA, 0.02);
  report(
    '200W MA uses weekly closes, not daily periods',
    completed.length >= 200,
    `${fmt(completed.length, 0)} completed weekly closes available`
  );

  section('5. Price history vs published references');
  for (const reference of PRICE_REFERENCES) {
    const row = byDate.get(reference.date);
    compare(`price on ${reference.date}`, row?.price, reference.price, reference.tolerance, reference.note);
  }

  section('6. On-chain references');
  for (const reference of ONCHAIN_REFERENCES) {
    const row = byDate.get(reference.date);
    if (!row) {
      report(`on-chain reference ${reference.date}`, false, 'date not present in series');
      continue;
    }
    compare(`realized price on ${reference.date}`, row.realizedPrice, reference.realizedPrice, reference.tolerance, reference.source);
    compare(`MVRV on ${reference.date}`, row.mvrv, reference.mvrv, reference.tolerance, reference.source);
  }

  section('7. Miner cost assumptions');
  const minerRow = series.rows.filter((r) => Number.isFinite(r.hashRate) && Number.isFinite(r.issuanceNtv)).at(-1);
  if (minerRow) {
    const estimate = estimateMinerProductionCost({
      date: minerRow.date,
      hashRate: minerRow.hashRate,
      issuanceNtv: minerRow.issuanceNtv
    });
    if (estimate) {
      const twhPerYear = (estimate.kwhPerDay * 365) / 1e9;
      console.log(`  hashrate          ${fmt(minerRow.hashRate / 1e6, 0)} EH/s`);
      console.log(`  issuance          ${fmt(minerRow.issuanceNtv, 0)} BTC/day`);
      console.log(`  fleet efficiency  ${fmt(estimate.efficiencyJPerTh)} J/TH`);
      console.log(`  electricity       $${estimate.electricityUsdPerKwh}/kWh`);
      console.log(`  cost per BTC      $${fmt(estimate.costPerBtc)}`);
      console.log(`  implied draw      ${fmt(twhPerYear, 0)} TWh/yr`);

      report(
        'implied network consumption is CBECI-plausible',
        twhPerYear >= CONSUMPTION_BAND_TWH.min && twhPerYear <= CONSUMPTION_BAND_TWH.max,
        `${fmt(twhPerYear, 0)} TWh/yr vs band ${CONSUMPTION_BAND_TWH.min}–${CONSUMPTION_BAND_TWH.max}`
      );
      // A production cost estimate an order of magnitude away from spot means
      // a unit error somewhere, most likely in the hashrate scale.
      report(
        'miner cost is within an order of magnitude of spot',
        estimate.costPerBtc > current.price / 10 && estimate.costPerBtc < current.price * 10,
        `$${fmt(estimate.costPerBtc)} vs spot $${fmt(current.price)}`
      );
    } else {
      report('miner cost estimate', false, 'estimator returned null');
    }
  } else {
    report('miner cost inputs', false, 'no hashrate / issuance rows');
  }

  section('8. Series behaviour');
  // Economic Value must behave as a slow baseline, not a second price line.
  const withBoth = result.history.filter((r) => Number.isFinite(r.economicValue) && Number.isFinite(r.price));
  const meanAbsLogMove = (values) => {
    let total = 0;
    let count = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > 0 && values[i - 1] > 0) {
        total += Math.abs(Math.log(values[i] / values[i - 1]));
        count++;
      }
    }
    return count ? total / count : NaN;
  };
  const evMove = meanAbsLogMove(withBoth.map((r) => r.economicValue));
  const pxMove = meanAbsLogMove(withBoth.map((r) => r.price));
  report(
    'Economic Value moves more slowly than price',
    evMove < pxMove * 0.6,
    `EV ${(evMove * 100).toFixed(3)}%/day vs price ${(pxMove * 100).toFixed(3)}%/day`
  );
  report('Economic Value is strictly positive', withBoth.every((r) => r.economicValue > 0));
  report(
    'no fabricated values in gaps',
    result.history.every((r) => r.economicValue === null || Number.isFinite(r.economicValue))
  );

  section('9. Valuation state calibration');
  if (result.distribution.available) {
    console.log(`  observations    ${fmt(result.distribution.observations, 0)}`);
    console.log(`  median premium  ${fmt(result.distribution.median)}%`);
    console.log(`  observed range  ${fmt(result.distribution.range.min)}% → ${fmt(result.distribution.range.max)}%`);
    for (const [name, value] of Object.entries(result.distribution.thresholds)) {
      console.log(`  ${name.padEnd(15)} ${fmt(value)}%`);
    }
    const thresholds = Object.values(result.distribution.thresholds);
    report(
      'state thresholds increase monotonically',
      thresholds.every((value, i) => i === 0 || value >= thresholds[i - 1])
    );
  } else {
    report('state calibration', false, `only ${result.distribution.observations} observations`);
  }

  section('10. Current reading');
  console.log(`  date            ${current.date}`);
  console.log(`  BTC             $${fmt(current.price)} (${current.priceSource})`);
  console.log(`  Economic Value  $${fmt(current.economicValue)}`);
  console.log(`  Premium         ${fmt(current.premiumDiscount)}%  ${current.state}`);
  console.log(`  Convergence     ${current.convergence.label} · ${current.convergence.agreement}`);
  console.log(`  Realized Price  $${fmt(current.anchors.realizedPrice)}`);
  console.log(`  200W MA         $${fmt(current.anchors.ma200w)}`);
  console.log(`  Miner Cost      $${fmt(current.anchors.minerCost)}`);
  console.log(`  MVRV            ${fmt(current.context.mvrv)}`);
  console.log(`  Puell           ${fmt(current.context.puell)}`);
  report('on-chain feed is current', (current.dataAgeDays ?? 0) <= 3, `${current.dataAgeDays} days behind price feed`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(issues === 0
    ? `All ${checks} checks inside tolerance.`
    : `${issues} of ${checks} checks need review (see CHECK lines above).`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(issues === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nValidation failed to run:', error.message);
  console.error(error.stack);
  process.exit(1);
});
