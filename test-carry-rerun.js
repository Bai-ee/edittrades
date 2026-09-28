// Unit tests for scripts/research/edge/carry-rerun.js's cost-model math (research only). Hand
// fixtures only - no network, no file reads of the real edge-search/funding data.
import assert from 'node:assert';
import carryRerun from './scripts/research/edge/carry-rerun.js';

const { classify, scenarioHourly, scenarioFunding } = carryRerun;

let pass = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`ok - ${name}`); }
  catch (err) { console.error(`FAIL - ${name}`); console.error(err.stack || err.message); process.exitCode = 1; }
}

const FEE = { long: 0.20, short: 0.14 };
const H = 3_600_000;

// Two long trades, 30h hold each, riskPct=2%, grossR=0.3 each (beFree = r*meanGrossR = 0.6%,
// clears the 0.20% actual fee). At the static 0.02%/h borrow proxy over a 30h hold, break-even
// with borrow = beFree - borrowPerH*meanHours = 0.6 - 0.02*30 = 0.0, below the 0.20% actual fee
// -> a hand-built "borrow kills" fixture (per-trade net R = 0.3 - (0.20+0.6)/2 = -0.1).
const trades = [
  { sym: 'BTC', dir: 'long', riskPct: 2, grossR: 0.3, hours: 30, entryTime: 0, exitTime: 30 * H },
  { sym: 'BTC', dir: 'long', riskPct: 2, grossR: 0.3, hours: 30, entryTime: 100 * H, exitTime: 130 * H }
];

check('classify: matches the hand-computed "borrow kills" verdict at 0.02%/h', () => {
  const c = classify(trades, FEE, 0.02);
  assert.ok(Math.abs(c.beFree - 0.6) < 1e-9, `beFree expected 0.6 got ${c.beFree}`);
  assert.ok(Math.abs(c.beBorrow - 0.0) < 1e-9, `beBorrow expected 0.0 got ${c.beBorrow}`);
  assert.strictEqual(c.verdict, 'borrow kills');
});

check('scenarioHourly: mean net R matches hand computation and flips to survives at the measured Jupiter rate', () => {
  const s02 = scenarioHourly(trades, FEE, 0.02);
  assert.ok(Math.abs(s02.netR - -0.1) < 1e-9, `expected -0.1, got ${s02.netR}`);
  assert.strictEqual(s02.verdict, 'fails');
  // net R = 0.3 - (0.20 + 0.0015*30)/2 = 0.3 - 0.245/2 = 0.1775
  const sMeasured = scenarioHourly(trades, FEE, 0.0015);
  assert.ok(Math.abs(sMeasured.netR - 0.1775) < 1e-9, `expected 0.1775, got ${sMeasured.netR}`);
  assert.strictEqual(sMeasured.verdict, 'survives');
});

check("scenarioFunding: real funding events replace the static rate, summed per trade's own hold", () => {
  // One funding event 5h into each trade's hold, rate 0.0002 (-> 0.02 in percent units).
  const events = [{ time: 5 * H, rate: 0.0002 }, { time: 105 * H, rate: 0.0002 }];
  const idx = { BTC: events };
  const r = scenarioFunding(trades, FEE, idx);
  // Each trade sees exactly one event -> fundingPct = 0.02 (long pays). netR = 0.3 - (0.20+0.02)/2 = 0.19
  assert.strictEqual(r.covered, 2);
  assert.strictEqual(r.uncovered, 0);
  assert.ok(Math.abs(r.netR - 0.19) < 1e-9, `expected 0.19, got ${r.netR}`);
  assert.strictEqual(r.verdict, 'survives');
  // avg long carry %/h = sum(fundingPct)/sum(hours) = (0.02+0.02)/(30+30) = 1/1500
  assert.ok(Math.abs(r.avgLongCarryPctPerH - 0.04 / 60) < 1e-9, `expected ${0.04 / 60}, got ${r.avgLongCarryPctPerH}`);
});

check('scenarioFunding: a symbol with no funding index is reported as uncovered, not zero-cost', () => {
  const r = scenarioFunding(trades, FEE, { BTC: null });
  assert.strictEqual(r.covered, 0);
  assert.strictEqual(r.uncovered, 2);
  assert.strictEqual(r.netR, null);
  assert.strictEqual(r.verdict, 'n/a');
});

console.log(`\n${pass} passed`);
if (process.exitCode) console.error('SOME TESTS FAILED');
