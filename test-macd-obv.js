// WP9 (Card 5.1): correctness tests for macd() and obv() in scripts/research/edge/lib.js.
// Plain asserts, matches the style of other test-*.js files (e.g. test-sma4h-trend.js).
import assert from 'node:assert';
import { macd, obv, loadBars } from './scripts/research/edge/lib.js';

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

function near(a, b, eps = 1e-9, msg = '') {
  assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a} (diff ${Math.abs(a - b)})`);
}
function isNaN9(x, msg = '') {
  assert.ok(Number.isNaN(x), `${msg} expected NaN, got ${x}`);
}

// ---------------------------------------------------------------------- (i) hand-computed MACD fixture
//
// close = [10, 12, 15, 11, 14], macd(close, fast=1, slow=2, signal=2).
// EMA(x,1) = x itself (k=2/(1+1)=1, SMA-seed at i=0 is x[0]/1=x[0], then out[i]=x[i]*1+out[i-1]*0).
// EMA(x,2): k=2/3, SMA-seeded at i=1 with (x0+x1)/2, recursive after.
//   emaSlow = [NaN, 11, 41/3, 107/9, 359/27]  (41/3=13.666667, 107/9=11.888889, 359/27=13.296296)
// macd = emaFast - emaSlow, valid once BOTH are finite -> first valid index = 1 (fast is valid
// from i=0, slow only from i=1), so macd[0] is NaN even though the fast EMA has a value there.
//   macd = [NaN, 1, 4/3, -8/9, 19/27]
// signal = EMA(signal=2) of the macd line, SEEDED FROM macd's first valid index (1), not index 0:
// sub = macd.slice(1) = [1, 4/3, -8/9, 19/27] (sub-index 0..3 <-> orig index 1..4).
// EMA(sub,2): sub-index 0 -> NaN (SMA warmup), sub-index 1 -> (1+4/3)/2 = 7/6 => orig idx 2.
//   signal = [NaN, NaN, 7/6, -11/54, 65/162]
//   hist   = [NaN, NaN, 1/6, -37/54, 49/162]
check('(i) hand-computed macd(close, 1, 2, 2)', () => {
  const close = [10, 12, 15, 11, 14];
  const { macd: m, signal, hist } = macd(close, 1, 2, 2);
  isNaN9(m[0], 'macd[0]');
  near(m[1], 1, 1e-9, 'macd[1]');
  near(m[2], 4 / 3, 1e-9, 'macd[2]');
  near(m[3], -8 / 9, 1e-9, 'macd[3]');
  near(m[4], 19 / 27, 1e-9, 'macd[4]');

  isNaN9(signal[0], 'signal[0]');
  isNaN9(signal[1], 'signal[1] (only one macd value seen so far, EMA(2) needs two)');
  near(signal[2], 7 / 6, 1e-9, 'signal[2]');
  near(signal[3], -11 / 54, 1e-9, 'signal[3]');
  near(signal[4], 65 / 162, 1e-9, 'signal[4]');

  isNaN9(hist[0], 'hist[0]');
  isNaN9(hist[1], 'hist[1]');
  near(hist[2], 1 / 6, 1e-9, 'hist[2]');
  near(hist[3], -37 / 54, 1e-9, 'hist[3]');
  near(hist[4], 49 / 162, 1e-9, 'hist[4]');
});

// ---------------------------------------------------------------------- (ii) hand-computed OBV fixture
//
// close = [10, 12, 12, 9, 11], volume = [100, 150, 80, 200, 90].
// obv[0] = 0 (defined, not NaN). obv[1]: 12>10 -> +150 = 150. obv[2]: 12==12 -> unchanged = 150.
// obv[3]: 9<12 -> -200 = -50. obv[4]: 11>9 -> +90 = 40.
check('(ii) hand-computed obv()', () => {
  const bars = { n: 5, c: [10, 12, 12, 9, 11], v: [100, 150, 80, 200, 90] };
  const o = obv(bars);
  assert.deepStrictEqual(Array.from(o), [0, 150, 150, -50, 40]);
});

// ---------------------------------------------------------------------- (iii) append-future invariance
//
// Both indicators are strictly causal (index i only reads x[0..i]); appending future bars must
// not change any already-computed value at an earlier index.
function pseudoSeries(n, seed) {
  const c = [], v = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    c.push(100 + (x % 2000) / 100); // 100.00 - 119.99
    x = (x * 1103515245 + 12345) % 2147483648;
    v.push(1 + (x % 5000)); // 1 - 5000
  }
  return { c, v };
}

check('(iii) macd() append-future invariance', () => {
  const full = pseudoSeries(60, 7);
  const prefixLen = 40;
  const prefix = { c: full.c.slice(0, prefixLen), v: full.v.slice(0, prefixLen) };
  const mFull = macd(full.c, 12, 26, 9);
  const mPre = macd(prefix.c, 12, 26, 9);
  for (let i = 0; i < prefixLen; i++) {
    const a = mFull.macd[i], b = mPre.macd[i];
    if (Number.isFinite(a) || Number.isFinite(b)) near(a, b, 1e-9, `macd[${i}]`);
    else assert.strictEqual(Number.isNaN(a), Number.isNaN(b), `macd NaN-state[${i}]`);
    const sa = mFull.signal[i], sb = mPre.signal[i];
    if (Number.isFinite(sa) || Number.isFinite(sb)) near(sa, sb, 1e-9, `signal[${i}]`);
    else assert.strictEqual(Number.isNaN(sa), Number.isNaN(sb), `signal NaN-state[${i}]`);
  }
});

check('(iii) obv() append-future invariance', () => {
  const full = pseudoSeries(60, 13);
  const prefixLen = 40;
  const prefix = { n: prefixLen, c: full.c.slice(0, prefixLen), v: full.v.slice(0, prefixLen) };
  const fullBars = { n: full.c.length, c: full.c, v: full.v };
  const oFull = obv(fullBars);
  const oPre = obv(prefix);
  for (let i = 0; i < prefixLen; i++) near(oFull[i], oPre[i], 1e-9, `obv[${i}]`);
});

// ---------------------------------------------------------------------- (iv) real-data warmup boundary
//
// Structural sanity check on the fixture data used by the WP9 evidence script: default
// macd(close, 12, 26, 9) must be NaN through the combined warmup (slow=26 EMA needs 26 bars,
// signal=9 needs 9 more macd values) and finite immediately after, matching ema()'s SMA-seed
// convention (see comment above the (i) fixture).
check('(iv) default macd(close, 12, 26, 9) warmup boundary on real fixture data', () => {
  const b = loadBars('BTC', '4h');
  const { macd: m, signal, hist } = macd(b.c, 12, 26, 9);
  // slow EMA(26) first valid at index 25 -> macd first valid at 25.
  for (let i = 0; i < 25; i++) isNaN9(m[i], `macd[${i}]`);
  assert.ok(Number.isFinite(m[25]), 'macd[25] finite');
  // signal EMA(9) over the macd sub-series (starting at 25) first valid at sub-index 8 -> orig 33.
  for (let i = 25; i < 33; i++) isNaN9(signal[i], `signal[${i}]`);
  assert.ok(Number.isFinite(signal[33]), 'signal[33] finite');
  near(hist[33], m[33] - signal[33], 1e-9, 'hist[33] = macd - signal');
  assert.ok(Number.isFinite(m[m.length - 1]), 'macd finite at end of series (no trailing NaN)');
});

console.log(`\n${pass} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
