/**
 * scripts/replay-payoff.js: TP/SL walk on 1m candles, no lookahead, net-of-fee R.
 */
import { walkTrade, costInR, columns, statsOf, payoffForRows } from './scripts/replay-payoff.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const MIN = 60_000;
const T0 = Date.parse('2026-05-01T00:00:00Z');
/** 1m candles from T0-5m on; spec maps minute offset (from T0) -> {high, low}; the rest sit flat at `base`. */
function series(n, spec = {}, base = 100) {
  const out = [];
  for (let m = -5; m < n; m++) { const o = spec[m]; out.push({ timestamp: T0 + m * MIN, open: base, high: o ? o.high : base, low: o ? o.low : base, close: base }); }
  return columns(out);
}
const trade = (direction, over = {}) => ({ direction, entry: 100, stop: direction === 'long' ? 95 : 105, target: direction === 'long' ? 110 : 90, calledMs: T0, ...over });

await test('long: target first -> +reward/risk R measured from the alert price; stop first -> -1R', () => {
  const w = walkTrade(trade('long'), series(30, { 4: { high: 110, low: 99 } }));
  assert(w.status === 'resolved' && w.grossR === 2 && w.minutes === 5 && w.exit === 'target', JSON.stringify(w));
  const l = walkTrade(trade('long'), series(30, { 3: { high: 101, low: 95 }, 6: { high: 110, low: 100 } }));
  assert(l.grossR === -1 && l.exit === 'stop', JSON.stringify(l));
});

await test('short mirrors long', () => {
  assert(walkTrade(trade('short'), series(30, { 4: { high: 101, low: 90 } })).grossR === 2, 'win');
  assert(walkTrade(trade('short'), series(30, { 3: { high: 105, low: 99 }, 6: { high: 100, low: 90 } })).grossR === -1, 'loss');
});

await test('one candle touching both stop and target is a loss', () => {
  for (const d of ['long', 'short']) assert(walkTrade(trade(d), series(30, { 2: { high: 112, low: 88 } })).grossR === -1, d);
});

await test('reward is measured from the alert price, not the card entry; a target already passed is skipped', () => {
  const t = trade('long', { entry: 104, stop: 99, target: 110 }); // reward 6 over risk 5
  assert(walkTrade(t, series(30, { 2: { high: 110, low: 104 } })).grossR === 1.2, 'reward/risk from 104');
  assert(walkTrade(trade('long', { entry: 111 }), series(5)).why === 'target_passed', 'target passed');
  assert(walkTrade(trade('long', { entry: 94 }), series(5)).why === 'stop_passed', 'stop passed');
});

await test('no lookahead: candles before the alert are ignored and candles after the resolution never change it', () => {
  const base = walkTrade(trade('long'), series(30, { 4: { high: 110, low: 99 } }));
  const pre = walkTrade(trade('long'), series(30, { '-3': { high: 200, low: 0 }, 4: { high: 110, low: 99 } }));
  const post = walkTrade(trade('long'), series(30, { 4: { high: 110, low: 99 }, 5: { high: 500, low: 1 }, 20: { high: 100, low: 1 } }));
  assert(JSON.stringify(base) === JSON.stringify(pre) && JSON.stringify(base) === JSON.stringify(post), 'result moved');
});

await test('unresolved at the end of data is reported, not counted', () => {
  assert(walkTrade(trade('long'), series(30)).status === 'unresolved', 'unresolved');
});

await test('variant B: +1R takes half and moves the stop to breakeven', () => {
  const run = (spec) => walkTrade(trade('long'), series(60, spec, 103), 'B'); // flat at 103: between entry and +1R
  assert(run({ 3: { high: 105, low: 100.5 }, 8: { high: 110, low: 101 } }).grossR === 1.5, 'half at 1R then target 2R: 0.5 + 0.5*2');
  assert(run({ 3: { high: 105, low: 101 }, 8: { high: 103, low: 100 } }).grossR === 0.5, 'breakeven after half');
  assert(run({ 3: { high: 105, low: 99 } }).grossR === 0.5, 'same candle returns to entry: breakeven');
  assert(run({ 3: { high: 101, low: 95 } }).grossR === -1, 'stop before +1R');
});

await test('variant C: target is 2R from the alert price', () => {
  const t = trade('long', { target: 130 });
  assert(walkTrade(t, series(30, { 3: { high: 110, low: 100 } }), 'C').grossR === 2, 'hit 2R');
  assert(walkTrade(t, series(30, { 3: { high: 109.9, low: 100 } }), 'C').status === 'unresolved', 'short of 2R');
});

await test('cost in R: directional round-trip bps of the alert price over the stop distance; net = gross - cost', () => {
  assert(Math.abs(costInR(100, 95, 'long', { long: 34, short: 14 }) - 0.0034 * 100 / 5) < 1e-12, 'long');
  assert(Math.abs(costInR(100, 105, 'short', { long: 34, short: 14 }) - 0.0014 * 100 / 5) < 1e-12, 'short');
  const row = { calledAt: new Date(T0).toISOString(), symbol: 'BTC', direction: 'long', timeframe: '5m', anchor: 100, stop: 95, tp1: 110, flow: { score: 5, of: 7, rr: 2, nextTf: 'agrees' } };
  const res = payoffForRows([row], { BTC: series(30, { 4: { high: 110, low: 99 } }) });
  const a = res.A.overall;
  assert(a.n === 1 && a.expectancyGrossR === 2 && Math.abs(a.expectancyNetR - (2 - 0.068)) < 1e-3, JSON.stringify(a));
  assert(res.A.byTimeframe['5m'].n === 1 && res.A.byScore['5/7'].n === 1 && res.A.byRR['2R+'].n === 1, 'splits');
});

await test('stats: win rate, averages, expectancy and sequential max drawdown', () => {
  const t = (g, at) => ({ grossR: g, netR: g, minutes: 10, exitAt: at });
  const s = statsOf([t(2, 3), t(-1, 1), t(-1, 2), t(-1, 4), t(2, 5)]);
  assert(s.n === 5 && s.winRate === 0.4 && s.avgWinR === 2 && s.avgLossR === -1 && s.expectancyGrossR === 0.2, JSON.stringify(s));
  assert(s.maxDrawdownR === 2, `dd ${s.maxDrawdownR}`); // -1, -2, 0, -1, +1: peak 0 -> trough -2
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
