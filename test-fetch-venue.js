// Unit tests for scripts/research/edge/fetch-venue.js pure helpers (research only). No network
// calls - pagination/merge, unfinished-candle drop, and funding summation are tested on hand
// fixtures, matching the style of other test-*.js files in this repo.
import assert from 'node:assert';
import {
  dedupeSortCandles, dropUnfinished, validateCandles,
  okxRowToCandle, bybitRowToCandle,
  mergeFundingEvents, sumFundingOverHold
} from './scripts/research/edge/fetch-venue.js';

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

// ---------------------------------------------------------------------- pagination merge / dedupe

check('dedupeSortCandles: two overlapping pages merge to one ascending series, later page wins on overlap', () => {
  // Page A (older, e.g. from an earlier "after" cursor) and page B (newer) share one timestamp
  // with a different close - simulates a provider returning a slightly revised value on refetch.
  const pageA = [
    { timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: MS_4H },
    { timestamp: MS_4H, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 2 * MS_4H }
  ];
  const pageB = [
    { timestamp: MS_4H, open: 1, high: 1.5, low: 1, close: 1.5, volume: 2, closeTime: 2 * MS_4H }, // revised
    { timestamp: 2 * MS_4H, open: 1.5, high: 2, low: 1.5, close: 2, volume: 1, closeTime: 3 * MS_4H }
  ];
  const merged = dedupeSortCandles([...pageA, ...pageB]);
  assert.strictEqual(merged.length, 3, 'three unique timestamps');
  assert.deepStrictEqual(merged.map((c) => c.timestamp), [0, MS_4H, 2 * MS_4H], 'ascending, no duplicates');
  assert.strictEqual(merged[1].close, 1.5, 'later page (map insertion order) wins on the shared timestamp');
});

check('dedupeSortCandles: out-of-order input pages sort correctly', () => {
  const shuffled = [
    { timestamp: 3 * MS_4H, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 4 * MS_4H },
    { timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: MS_4H },
    { timestamp: MS_4H, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 2 * MS_4H }
  ];
  const merged = dedupeSortCandles(shuffled);
  assert.deepStrictEqual(merged.map((c) => c.timestamp), [0, MS_4H, 3 * MS_4H]);
});

// ---------------------------------------------------------------------- unfinished-candle drop

check('dropUnfinished: OKX confirm="0" (still forming) is dropped even if timestamp looks closed', () => {
  const candles = [
    { timestamp: 0, closeTime: MS_4H, confirm: '1' },
    { timestamp: MS_4H, closeTime: 2 * MS_4H, confirm: '0' } // most recent bar, still forming
  ];
  const kept = dropUnfinished(candles, 3 * MS_4H);
  assert.strictEqual(kept.length, 1, 'only the confirmed bar survives');
  assert.strictEqual(kept[0].timestamp, 0);
});

check('dropUnfinished: no confirm flag (e.g. Bybit) falls back to the closed-bar cutoff', () => {
  const candles = [
    { timestamp: 0, closeTime: MS_4H },
    { timestamp: MS_4H, closeTime: 2 * MS_4H } // closeTime is after the cutoff -> still forming
  ];
  const kept = dropUnfinished(candles, MS_4H); // cutoff = only bar 0 has fully closed
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].timestamp, 0);
});

check('okxRowToCandle / bybitRowToCandle: field mapping', () => {
  const okx = okxRowToCandle(['1000', '10', '12', '9', '11', '5', 'x', 'y', '1'], MS_4H);
  assert.deepStrictEqual(okx, { timestamp: 1000, open: 10, high: 12, low: 9, close: 11, volume: 5, closeTime: 1000 + MS_4H, confirm: '1' });
  const bybit = bybitRowToCandle(['2000', '20', '22', '19', '21', '7', 'z'], MS_4H);
  assert.deepStrictEqual(bybit, { timestamp: 2000, open: 20, high: 22, low: 19, close: 21, volume: 7, closeTime: 2000 + MS_4H });
});

// ---------------------------------------------------------------------- validateCandles

check('validateCandles: flags a gap, a duplicate, and an OHLC-bound violation', () => {
  const candles = [
    { timestamp: 0, open: 1, high: 1, low: 1, close: 1 },
    { timestamp: 0, open: 1, high: 1, low: 1, close: 1 }, // duplicate
    { timestamp: 3 * MS_4H, open: 1, high: 1, low: 1, close: 1 }, // gap (skips MS_4H, 2*MS_4H)
    { timestamp: 4 * MS_4H, open: 5, high: 4, low: 1, close: 5 } // high < max(open,close)
  ];
  const v = validateCandles(candles, MS_4H);
  assert.strictEqual(v.ok, false);
  assert.ok(v.issues.some((m) => m.includes('duplicate timestamp')));
  assert.ok(v.issues.some((m) => m.includes('high < max')));
  assert.strictEqual(v.gapCount, 1);
  assert.strictEqual(v.largestGapCandles, 2);
});

check('validateCandles: a clean run reports ok with no gaps', () => {
  const candles = [0, 1, 2, 3].map((i) => ({ timestamp: i * MS_4H, open: 10, high: 11, low: 9, close: 10 }));
  const v = validateCandles(candles, MS_4H);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.gapCount, 0);
});

// ---------------------------------------------------------------------- funding: merge + summation

check('mergeFundingEvents: dedupes by time and sorts ascending', () => {
  const merged = mergeFundingEvents([
    { time: 3000, rate: 0.0003 },
    { time: 1000, rate: 0.0001 },
    { time: 1000, rate: 0.00011 }, // duplicate timestamp (e.g. overlapping pages), later wins
    { time: 2000, rate: 0.0002 }
  ]);
  assert.deepStrictEqual(merged.map((e) => e.time), [1000, 2000, 3000]);
  assert.strictEqual(merged[0].rate, 0.00011);
});

// Hand fixture: hourly funding events at 0h,1h,2h,3h,4h (ms), rates in fraction-of-notional
// (0.0001 = 0.01%, Hyperliquid's own units). A long held [1h, 3h) sees the 1h and 2h events only.
check('sumFundingOverHold: long pays positive funding, window is [entry, exit)', () => {
  const H = 3_600_000;
  const events = [
    { time: 0, rate: 0.0001 },
    { time: H, rate: 0.0002 },
    { time: 2 * H, rate: -0.0001 },
    { time: 3 * H, rate: 0.0003 }, // excluded: at/after exit
    { time: 4 * H, rate: 0.0005 }
  ];
  const r = sumFundingOverHold(events, H, 3 * H, 'long');
  // sum(0.0002, -0.0001) = 0.0001 -> *100 = 0.01 (percent units)
  assert.strictEqual(r.count, 2);
  assert.ok(Math.abs(r.fundingPct - 0.01) < 1e-9, `expected 0.01, got ${r.fundingPct}`);
});

check('sumFundingOverHold: short receives when funding is positive (cost sign flips)', () => {
  const H = 3_600_000;
  const events = [{ time: H, rate: 0.0002 }, { time: 2 * H, rate: -0.0001 }];
  const r = sumFundingOverHold(events, H, 3 * H, 'short');
  assert.ok(Math.abs(r.fundingPct - -0.01) < 1e-9, `expected -0.01, got ${r.fundingPct}`);
});

check('sumFundingOverHold: no events in window -> zero cost, zero count', () => {
  const H = 3_600_000;
  const events = [{ time: 10 * H, rate: 0.0009 }];
  const r = sumFundingOverHold(events, H, 3 * H, 'long');
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.fundingPct, 0);
});

check('sumFundingOverHold: entry-time event included, exit-time event excluded (half-open window)', () => {
  const H = 3_600_000;
  const events = [{ time: H, rate: 0.0004 }, { time: 3 * H, rate: 0.0004 }];
  const r = sumFundingOverHold(events, H, 3 * H, 'long');
  assert.strictEqual(r.count, 1);
  assert.ok(Math.abs(r.fundingPct - 0.04) < 1e-9);
});

console.log(`\n${pass} passed`);
if (process.exitCode) console.error('SOME TESTS FAILED');
