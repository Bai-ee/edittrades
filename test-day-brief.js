/**
 * lib/dayBrief.js: 24h Brief (last 24h + likely next 24h per asset).
 * Run: npm run test:brief
 */
import { formatDayBrief, nextLean, expectedRange, volumeVsPrior, trendOf, last24h } from './lib/dayBrief.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const H = 3_600_000;
const END = Date.parse('2026-10-04T08:00:00.000Z');
const candles = (n, stepMs, start, drift, vol) => Array.from({ length: n }, (_, i) => {
  const o = start + i * drift;
  return { t: new Date(END - (n - i) * stepMs).toISOString(), o, h: o + Math.abs(drift) + 10, l: o - 10, c: o + drift, v: vol(i) };
});
const sym = (dir) => ({
  price: dir === 1 ? 2700 : 2500,
  timeframes: {
    '1h': { trend: dir === 1 ? 'UPTREND' : 'DOWNTREND', candles: candles(20, H, 2600, dir * 5, () => 10) },
    '4h': { trend: dir === 1 ? 'UPTREND' : 'DOWNTREND', ema200: 2600, stochRsi: { state: 'OVERBOUGHT' }, candles: candles(20, 4 * H, 2500, dir * 10, (i) => (i >= 14 ? 200 : 100)) },
    '1d': { trend: dir === 1 ? 'UPTREND' : 'FLAT', candles: candles(10, 24 * H, 2400, dir * 30, () => 1000) }
  },
  geometryContext: { '4h': { horizontalSupportZones: [{ low: 2640, high: 2650 }], horizontalResistanceZones: [{ low: 2760, high: 2770 }] } }
});

console.log('24h brief');

test('trend, volume vs prior 24h, lean and expected range from published fields', () => {
  const s = sym(1);
  assert(trendOf(s, '4h') === 'up' && trendOf(s, '1d') === 'up', 'trend');
  assert(volumeVsPrior(s).ratio === 2, JSON.stringify(volumeVsPrior(s)));
  const l = nextLean(s);
  assert(l.side === 'up' && l.score === 4 && l.of === 4, JSON.stringify(l));
  assert(nextLean(sym(-1)).side === 'down', 'down lean');
  const r = expectedRange(s);
  assert(r && r.low < 2700 && r.high > 2700 && r.pct > 0, JSON.stringify(r));
  assert(expectedRange({ price: 1, timeframes: {} }) === null, 'no 1d -> null');
});

test('last 24h range always contains the live price; change runs to it', () => {
  const s = { ...sym(1), price: 2000 };
  const m = last24h(s);
  assert(m.low === 2000 && m.changePct < 0, JSON.stringify(m));
});

test('brief text: last 24h and next 24h sections per asset, levels, stretch, disclaimer', () => {
  const t = formatDayBrief({ symbols: { ETH: sym(1) }, flagBoard: {} }, END);
  assert(t.includes('24H BRIEF') && t.includes('<b>ETH</b>') && t.includes('Last 24h') && t.includes('Next 24h (likely)'), t);
  assert(t.includes('volume 2x prior 24h') && t.includes('Trend 4h ▲ up · 1d ▲ up'), t);
  assert(t.includes('🟢 Up-lean (+4/4 structure)') && t.includes('Likely range') && t.includes('1 day ATR'), t);
  assert(t.includes('resistance 2,760.00 (4h)') && t.includes('support 2,650.00 (4h)'), t);
  assert(t.includes('4h Stoch overbought'), t);
  assert(t.includes('not a forecast'), 'disclaimer');
  assert(formatDayBrief({ symbols: {} }).includes('unavailable'), 'empty');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
