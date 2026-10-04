/**
 * lib/tradeUpdate.js: in-trade update cadence, confidence score and message.
 * Run: npm run test:tradeupdate
 */
import { updateIntervalMs, updateDue, tradeConfidence, formatTradeUpdate, lockEvidence } from './lib/tradeUpdate.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (err) { failed++; console.log(`  ✗ ${name}\n      ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const MIN = 60_000;
const T0 = Date.parse('2026-10-04T06:00:00.000Z');
const rows = (marks) => ['1m', '3m', '5m', '15m', '1h', '4h', '1d'].map((tf, i) => ({ tf, mark: marks[i] }));
const lock = (over = {}) => ({
  ref: 'abcd1234', symbol: 'ETH', timeframe: '1h', direction: 'long', status: 'filled',
  filledAt: new Date(T0).toISOString(), fillPrice: 2700, levels: { entry: 2690, stop: 2670, tp1: 2740, trigger: 2690, invalidation: 2670, cap: 2720 },
  conf: { rows: rows(['✅', '✅', '✅', '✅', '✅', '✅', '⚠️']) }, ...over
});
const sym = (price, ema21 = 2690) => ({ price, mark: { status: 'ok', price }, timeframes: { '1h': { ema21 } } });
const goodEv = { rsi: 58, stoch: { k: 40, d: 30, state: 'rising', favors: true }, divergence: { type: null, against: false }, volume: { quality: 'OK', breakoutRelVol: 1.1 }, lines: { volume: 'Volume OK · 1.1x avg → GO' } };
const badEv = { rsi: 80, stoch: { k: 90, d: 88, state: 'overbought', favors: false }, divergence: { type: 'bearish', against: true }, lines: { volume: 'Volume WEAK · 0.5x avg → STAY OUT' } };

console.log('trade update');

test('interval = one candle of the lock timeframe, clamped to 5-60 min', () => {
  assert(updateIntervalMs('1m') === 5 * MIN && updateIntervalMs('3m') === 5 * MIN && updateIntervalMs('5m') === 5 * MIN, 'fast tfs -> 5 min');
  assert(updateIntervalMs('15m') === 15 * MIN && updateIntervalMs('1h') === 60 * MIN && updateIntervalMs('4h') === 60 * MIN, '15m / 1h / 4h');
});

test('due one interval after the fill, then after the last update; never for an unfilled lock', () => {
  assert(!updateDue(lock(), T0 + 59 * MIN) && updateDue(lock(), T0 + 60 * MIN), 'first after the fill');
  assert(!updateDue(lock({ updAt: new Date(T0 + 60 * MIN).toISOString() }), T0 + 100 * MIN), 'spaced from the last');
  assert(!updateDue(lock({ status: 'confirmed' }), T0 + 120 * MIN), 'not filled');
});

test('confidence: aligned + momentum with you = HOLD; stretched, divergence, below EMA = EXIT?', () => {
  const good = tradeConfidence(lock(), sym(2710), goodEv);
  assert(good.verdict === 'HOLD' && good.score >= 65 && good.against.length === 0, JSON.stringify(good));
  const bad = tradeConfidence(lock({ conf: { rows: rows(['❌', '❌', '❌', '⚠️', '✅', '⚠️', '❌']) } }), sym(2680), badEv);
  assert(bad.verdict === 'EXIT?' && bad.score < 45, JSON.stringify(bad));
  assert(bad.against.some((a) => a.includes('bearish divergence')) && bad.against.some((a) => a.includes('below 1h EMA21')), bad.against.join());
});

test('short trades mirror: price under EMA21 counts for a short', () => {
  const sh = lock({ direction: 'short', fillPrice: 2700, levels: { entry: 2700, stop: 2720, tp1: 2650, trigger: 2700, invalidation: 2720, cap: 2680 } });
  const c = tradeConfidence(sh, sym(2680, 2695), { ...goodEv, stoch: { k: 60, d: 70, state: 'falling', favors: true } });
  assert(!c.against.some((a) => a.includes('EMA21')), c.against.join());
});

test('message: % and R since entry, TP / SL distance, confidence, volume line', () => {
  const t = formatTradeUpdate(lock(), sym(2710), goodEv, T0 + 70 * MIN);
  assert(t.includes('ETH 1h ▲') && t.includes('<b>+0.37%</b>') && t.includes('+0.33R') && t.includes('1 h 10 min in'), t);
  assert(t.includes('TP 2,740.00 (+1.11% to go)') && t.includes('SL 2,670.00 (-1.48% away)'), t);
  assert(t.includes('🟢 Confidence') && t.includes('📊 Volume OK · 1.1x avg') && !t.includes('→ GO'), t);
  assert(formatTradeUpdate(lock(), { timeframes: {} }, null, T0).includes('price unavailable'), 'no price');
});

test('lockEvidence picks the lock symbol / tf / direction', () => {
  const payload = { tfEvidence: { ETH: { '1h': { long: goodEv, short: badEv } } } };
  assert(lockEvidence(payload, lock()) === goodEv && lockEvidence(payload, lock({ direction: 'short' })) === badEv, 'direction');
  assert(lockEvidence({}, lock()) === null, 'missing');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
