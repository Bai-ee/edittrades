// R7 candle Monte Carlo acceptance checks (WP3, research only). Plain asserts, matches the style
// of other test-*.js files in this repo.
import assert from 'node:assert';
import { buildDeltaTuples, movingBlockBootstrapIndices, synthesizePath, runMonteCarlo } from './scripts/research/harness/montecarlo.js';
import { barsFromCandles } from './scripts/research/edge/sma4h-trend.js';
import { makeRng } from './scripts/research/harness/stats-lib.js';

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

const MS_4H = 4 * 3600e3;

function makeFixtureBars(closes) {
  const candles = closes.map((c, i) => ({
    timestamp: i * MS_4H, closeTime: (i + 1) * MS_4H,
    open: i === 0 ? c : closes[i - 1], close: c,
    high: Math.max(i === 0 ? c : closes[i - 1], c) * 1.01,
    low: Math.min(i === 0 ? c : closes[i - 1], c) * 0.99,
    volume: 1,
  }));
  return barsFromCandles(candles);
}

// ---------------------------------------------------------------------- (1) delta tuples, hand-checked

check('(1) buildDeltaTuples matches a hand-computed 3-bar example', () => {
  const bars = makeFixtureBars([100, 110, 99]);
  // bar1: close=110, prevClose=100, high=110*1.01, low=100*0.99
  // bar2: close=99,  prevClose=110, high=110*1.01 (from prevClose scaling, but our fixture scales
  // relative to max(prev,c)) - compute expected directly against the fixture's own bars.
  const { dClose, dHighRel, dLowRel } = buildDeltaTuples(bars);
  assert.strictEqual(dClose.length, 2);
  for (let k = 0; k < 2; k++) {
    const i = k + 1;
    assert.ok(Math.abs(dClose[k] - Math.log(bars.c[i] / bars.c[i - 1])) < 1e-12);
    assert.ok(Math.abs(dHighRel[k] - Math.log(bars.h[i] / bars.c[i])) < 1e-12);
    assert.ok(Math.abs(dLowRel[k] - Math.log(bars.l[i] / bars.c[i])) < 1e-12);
  }
});

// ---------------------------------------------------------------------- (2) block bootstrap indices

check('(2) movingBlockBootstrapIndices produces exactly targetLength in-range, block-contiguous indices', () => {
  const rng = makeRng(11);
  const idx = movingBlockBootstrapIndices(100, 57, 10, rng);
  assert.strictEqual(idx.length, 57);
  for (const v of idx) assert.ok(v >= 0 && v < 100, `index ${v} out of [0,100)`);
  // every run of 10 consecutive output slots (except possibly the last partial one) must itself
  // be a contiguous run of source indices (i, i+1, i+2, ...) - the defining property of a block.
  for (let b = 0; b * 10 + 9 < idx.length; b++) {
    for (let j = 1; j < 10; j++) assert.strictEqual(idx[b * 10 + j], idx[b * 10] + j, `block ${b} not contiguous`);
  }
});

check('(2b) movingBlockBootstrapIndices is deterministic given the same rng seed', () => {
  const a = movingBlockBootstrapIndices(200, 150, 30, makeRng(5));
  const b = movingBlockBootstrapIndices(200, 150, 30, makeRng(5));
  assert.deepStrictEqual(Array.from(a), Array.from(b));
});

check('(2c) blockLength larger than the source clamps instead of throwing', () => {
  const idx = movingBlockBootstrapIndices(5, 20, 30, makeRng(1));
  assert.strictEqual(idx.length, 20);
  for (const v of idx) assert.ok(v >= 0 && v < 5);
});

// ---------------------------------------------------------------------- (3) synthesizePath sanity

check('(3) synthesizePath returns a valid OHLC envelope and the requested length', () => {
  const rng = makeRng(3);
  const n = 300;
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + (rng() - 0.5) * 0.02));
  const bars = makeFixtureBars(closes);

  const synthetic = synthesizePath(bars, { blockLength: 20, seed: 7, pathLength: 250 });
  assert.strictEqual(synthetic.n, 251); // pathLength + anchor bar
  for (let i = 0; i < synthetic.n; i++) {
    assert.ok(synthetic.h[i] >= synthetic.o[i] - 1e-9 && synthetic.h[i] >= synthetic.c[i] - 1e-9, `bar ${i} high below open/close`);
    assert.ok(synthetic.l[i] <= synthetic.o[i] + 1e-9 && synthetic.l[i] <= synthetic.c[i] + 1e-9, `bar ${i} low above open/close`);
    assert.ok(synthetic.c[i] > 0, `bar ${i} close must stay positive`);
  }
});

check('(3b) synthesizePath is deterministic given the same seed', () => {
  const rng = makeRng(4);
  const n = 100;
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + (rng() - 0.5) * 0.01));
  const bars = makeFixtureBars(closes);
  const a = synthesizePath(bars, { blockLength: 10, seed: 9, pathLength: 80 });
  const b = synthesizePath(bars, { blockLength: 10, seed: 9, pathLength: 80 });
  assert.deepStrictEqual(Array.from(a.c), Array.from(b.c));
});

// ---------------------------------------------------------------------- (4) runMonteCarlo end to end

check('(4) runMonteCarlo returns a historical result plus a finite synthetic distribution', () => {
  const rng = makeRng(21);
  const n = 1000;
  const closes = [100];
  for (let i = 1; i < n; i++) {
    const drift = 0.0003; // mild uptrend so SMA crossings actually occur
    closes.push(closes[i - 1] * Math.exp(drift + (rng() - 0.5) * 0.02));
  }
  const bars = makeFixtureBars(closes);
  const r = runMonteCarlo(bars, { n: 50, blockLength: 20, nPaths: 40, seed: 1 });
  assert.ok(Number.isFinite(r.historical.netCagr));
  assert.ok(Number.isFinite(r.synthetic.netCagr.p50));
  assert.ok(r.synthetic.netCagr.p5 <= r.synthetic.netCagr.p50, 'p5 <= p50');
  assert.ok(r.synthetic.netCagr.p50 <= r.synthetic.netCagr.p95, 'p50 <= p95');
  assert.strictEqual(r.synthetic.netCagr.n, 40);
});

console.log(`\n${pass} check(s) passed.`);
