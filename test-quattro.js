// WP8_QUATTRO tests (research only). Node asserts, no test runner dep.
//   node test-quattro.js
import assert from 'node:assert/strict';
import {
  atrEwm, donchian, dailyRegimeArrays, alignDailyToBars, buildQuattroSeries, runQuattroCampaign, perTradeBreakeven
} from './scripts/research/edge/quattro.js';

function makeBars(rows) {
  // rows: [timestamp, open, high, low, close]
  const n = rows.length;
  const b = { n, t: new Float64Array(n), ct: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  rows.forEach((r, i) => { b.t[i] = r[0]; b.ct[i] = r[0] + 4 * 3600e3; b.o[i] = r[1]; b.h[i] = r[2]; b.l[i] = r[3]; b.c[i] = r[4]; b.v[i] = 0; });
  return b;
}

function makeDaily(rows) {
  const n = rows.length;
  const b = { n, t: new Float64Array(n), ct: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n) };
  rows.forEach((r, i) => { b.t[i] = r[0]; b.ct[i] = r[0] + 24 * 3600e3; b.o[i] = r[1]; b.h[i] = r[1]; b.l[i] = r[1]; b.c[i] = r[1]; b.v[i] = 0; });
  return b;
}

const MS_DAY = 24 * 3600e3;
const MS_4H = 4 * 3600e3;

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}`); console.error(e); process.exitCode = 1; }
}

// ---------------------------------------------------------------------- 1. causality: append-future invariance

check('causality: signals/trades up to time T are unchanged when future bars are appended', () => {
  const day0 = Date.UTC(2020, 0, 1);
  const dailyRows = [];
  for (let d = 0; d < 400; d += 1) dailyRows.push([day0 + d * MS_DAY, 100 + d * 0.5]); // steadily rising close -> EMA200 rising
  const daily = makeDaily(dailyRows);

  const bar0 = day0 + 300 * MS_DAY; // well past EMA200 warmup
  const barRows = [];
  let price = 250;
  for (let i = 0; i < 200; i += 1) {
    // occasional breakout spikes so entries actually fire
    const spike = i % 25 === 24 ? 8 : 0;
    const o = price, h = price + 1 + spike, l = price - 1, c = price + 0.5 + spike * 0.5;
    barRows.push([bar0 + i * MS_4H, o, h, l, c]);
    price = c;
  }
  const barsFull = makeBars(barRows);
  const barsTruncated = makeBars(barRows.slice(0, 150));

  const optsA = { regime: 'A', maxUnits: 1, maxLeverage: 1, fromMs: -Infinity, toMs: Infinity };
  const rFull = runQuattroCampaign(barsFull, daily, optsA);
  const rTrunc = runQuattroCampaign(barsTruncated, daily, optsA);

  const cutoffT = barsTruncated.t[barsTruncated.n - 1];
  const fullTradesBeforeCutoff = rFull.trades.filter((tr) => tr.entryTime <= cutoffT);
  const truncTrades = rTrunc.trades;
  // Every trade that started at/before the truncation point must be identical (same entry time/price),
  // proving the decision at any bar i never depended on bars after i (no look-ahead).
  assert.equal(truncTrades.length >= fullTradesBeforeCutoff.length - 1, true, 'truncated run should find at least as many trades up to the cutoff (last one may be pending in the full run)');
  for (let k = 0; k < Math.min(truncTrades.length, fullTradesBeforeCutoff.length); k += 1) {
    assert.equal(truncTrades[k].entryTime, fullTradesBeforeCutoff[k].entryTime, `trade ${k} entryTime must match regardless of future bars`);
    assert.equal(truncTrades[k].entryPrice, fullTradesBeforeCutoff[k].entryPrice, `trade ${k} entryPrice must match`);
  }
});

// ---------------------------------------------------------------------- 2. EMA A vs B difference on fixture

check('regime A vs B: B implies A, and they differ when EMA200 is falling while price is above it', () => {
  const day0 = Date.UTC(2021, 0, 1);
  // Rise 300 days (build up EMA200), decline 40 days (pulls the 20-day-ago comparison down), then spike sharply
  // back up: for a few days after the spike, close is back above EMA200 (which reacts slowly) while the 20-day
  // EMA200 comparison is still negative (it is still summing the recent decline) -> A true, B false.
  const n = 420;
  const dailyRows = [];
  let c = 100;
  for (let d = 0; d < 300; d += 1) { c = 100 + d; dailyRows.push([day0 + d * MS_DAY, c]); }
  const peak = c;
  for (let d = 300; d < 340; d += 1) { c = peak - (d - 299) * 3; dailyRows.push([day0 + d * MS_DAY, c]); }
  const trough = c;
  for (let d = 340; d < n; d += 1) { c = trough + (d - 339) * 40; dailyRows.push([day0 + d * MS_DAY, c]); }
  const daily = makeDaily(dailyRows);
  const { ema200, slopeUp } = dailyRegimeArrays(daily);

  let diTarget = -1;
  for (let i = 300; i < daily.n; i += 1) {
    if (Number.isFinite(slopeUp[i]) && slopeUp[i] === 0 && daily.c[i] > ema200[i]) { diTarget = i; break; }
  }
  assert.ok(diTarget > 0, 'fixture must produce at least one day where close > EMA200 but the 20-day EMA200 slope is down');

  // A single 4h bar, on the calendar day right after diTarget (so alignDailyToBars resolves to diTarget),
  // with close equal to that day's close (so A is true by construction; B requires the slope, which is false).
  const barT = daily.t[diTarget] + MS_DAY + 2 * 3600e3; // a bar within the next calendar day
  const bars = makeBars([[barT - MS_4H, daily.c[diTarget] - 1, daily.c[diTarget] + 1, daily.c[diTarget] - 1, daily.c[diTarget]]]);
  const seriesA = buildQuattroSeries(bars, daily, { regime: 'A' });
  const seriesB = buildQuattroSeries(bars, daily, { regime: 'B' });
  assert.equal(seriesA.regimeOk[0], 1, 'regime A must be true (close above EMA200)');
  assert.equal(seriesB.regimeOk[0], 0, 'regime B must be false (EMA200 not rising over the last 20 days)');
});

// ---------------------------------------------------------------------- 3. hand-computed small trade

check('hand-computed trade: entry, ATR stop, and Donchian exit match manual arithmetic', () => {
  const day0 = Date.UTC(2022, 0, 1);
  const dailyRows = [];
  for (let d = 0; d < 260; d += 1) dailyRows.push([day0 + d * MS_DAY, 100]); // flat EMA200 = 100
  const daily = makeDaily(dailyRows);

  const bar0 = day0 + 250 * MS_DAY;
  // 25 quiet bars (regime A true: close 110 > EMA200 100) to build ATR + Donchian-20 history, then a clean
  // breakout bar, then 14 bars holding in a tight range (so the 10-bar exit channel is entirely inside the
  // hold range and old quiet-phase lows have rolled off, and ATR has relaxed back toward the hold range).
  const barRows = [];
  for (let i = 0; i < 25; i += 1) barRows.push([bar0 + i * MS_4H, 110, 111, 109, 110]);
  barRows.push([bar0 + 25 * MS_4H, 110, 120, 110, 118]); // breakout bar (index 25)
  barRows.push([bar0 + 26 * MS_4H, 119, 121, 118, 120]); // fill bar (index 26): entry at this bar's open
  for (let i = 27; i < 40; i += 1) barRows.push([bar0 + i * MS_4H, 120, 121, 119, 120]); // hold, low=119 throughout
  const bars0 = makeBars(barRows);
  const s0 = buildQuattroSeries(bars0, daily, { regime: 'A' });
  assert.equal(bars0.c[25] > s0.donchHigh20[25], true, 'breakout bar must close above the prior-20-bar high');

  const expectedEntryPx = bars0.o[26];
  const expectedAtrN = s0.atr14[25];
  const expectedStopPx = expectedEntryPx - 2 * expectedAtrN;
  assert.ok(expectedStopPx < 119, 'fixture sanity: the ATR stop must sit below the hold range low (119), never touched while holding');

  // Now append the breakdown: close below the (now ~119) 10-bar low, with a low comfortably above the ATR
  // stop and shallow enough to stay well within the 5%-of-account hard stop.
  const donchLowAtBreak = 119; // min low of the preceding 10 hold bars
  const breakdownLow = Math.max(expectedStopPx + 1, donchLowAtBreak - 3);
  const rows2 = [...barRows,
    [bar0 + 40 * MS_4H, 118, 119, breakdownLow, breakdownLow + 0.5], // close < donchLow10 -> pending exit
    [bar0 + 41 * MS_4H, breakdownLow, breakdownLow + 1, breakdownLow - 1, breakdownLow], // fills the pending exit at this bar's open
    [bar0 + 42 * MS_4H, breakdownLow, breakdownLow + 1, breakdownLow - 1, breakdownLow] // trailing bar: gives the engine's loop (which, like source's `range(warmup, n-1)`, never processes the very last bar as a decision bar) room to actually execute the pending-exit fill at bar 41's open
  ];
  const bars = makeBars(rows2);
  const s = buildQuattroSeries(bars, daily, { regime: 'A' });
  assert.ok(bars.c[40] < s.donchLow10[40], 'breakdown bar must close below the prior-10-bar low');
  assert.ok(bars.l[40] > expectedStopPx, 'fixture sanity: breakdown bar low must not touch the ATR stop');

  const r = runQuattroCampaign(bars, daily, { regime: 'A', maxUnits: 1, maxLeverage: 1 });
  assert.equal(r.trades.length, 1, 'exactly one trade expected in this fixture');
  const tr = r.trades[0];
  assert.equal(tr.entryPrice, expectedEntryPx, 'entry price must equal next bar open');

  const impliedStop = tr.entryPrice - (tr.riskPct / 100) * tr.entryPrice;
  assert.ok(Math.abs(impliedStop - expectedStopPx) < 1e-6, `implied stop ${impliedStop} must match hand-computed ${expectedStopPx}`);

  assert.equal(tr.reason, 'donchian_exit', 'exit should be the Donchian-10 close exit, not the ATR stop, in this fixture');
  const expectedExitPx = bars.o[41]; // pending exit decided at bar 40's close, fills at bar 41's open
  assert.equal(tr.exitPrice, expectedExitPx, 'exit price must equal the fill-bar open for a Donchian exit');

  const expectedGrossR = (expectedExitPx - expectedEntryPx) / (2 * expectedAtrN);
  assert.ok(Math.abs(tr.grossR - expectedGrossR) < 1e-6, `grossR ${tr.grossR} must match hand-computed ${expectedGrossR}`);
});

// ---------------------------------------------------------------------- 4. perTradeBreakeven sanity

check('perTradeBreakeven: zero-cost break-even equals mean grossR-weighted formula on a tiny synthetic set', () => {
  const trades = [
    { grossR: 1, riskPct: 2, hours: 24 },
    { grossR: -0.5, riskPct: 2, hours: 12 },
    { grossR: 2, riskPct: 4, hours: 48 }
  ];
  const be = perTradeBreakeven(trades, { actualRt: 0.20, borrowPerH: 0.02 });
  const sumG = 1 + -0.5 + 2;
  const sumInv = 1 / 2 + 1 / 2 + 1 / 4;
  assert.ok(Math.abs(be.beFree - sumG / sumInv) < 1e-9, 'beFree must match the closed-form formula');
  assert.equal(be.n, 3);
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) { console.error('SOME CHECKS FAILED'); }
