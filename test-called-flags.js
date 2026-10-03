/**
 * scripts/tracker/called-flags.js: called-flag scoring (1 ATR(14) of own timeframe, 12 candles).
 */
import {
  calledFlagsFromAlerts, scoreCalledFlag, scoreCalledFlags, summarizeCalledFlags, bucketCandles, atrOf
} from './scripts/tracker/called-flags.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const MIN = 60_000;
const TF = 5 * MIN;
const T0 = Date.parse('2026-10-02T12:00:00Z'); // 5m-aligned alert time
const iso = (ms) => new Date(ms).toISOString();

/** 1m candle flat at price p, range +/- half. */
const c1 = (ts, p, half = 0.5) => ({ timestamp: ts, open: p, high: p + half, low: p - half, close: p });

/** 20 history 5m bars (100 1m candles) before T0: every 5m bar has range 10 -> ATR 10 (flat closes at 100). */
function history() {
  const out = [];
  for (let i = 100; i >= 1; i--) {
    const ts = T0 - i * MIN;
    const first = i % 5 === 0; // first minute of a 5m bucket carries the full range
    out.push({ timestamp: ts, open: 100, high: first ? 105 : 100, low: first ? 95 : 100, close: 100 });
  }
  return out;
}
/** forward 1m path: map minute offset -> {high, low}; rest sits at 100. */
function forward(n, spec = {}) {
  const out = [];
  for (let m = 0; m < n; m++) {
    const o = spec[m];
    out.push({ timestamp: T0 + m * MIN, open: 100, high: o ? o.high : 100, low: o ? o.low : 100, close: 100 });
  }
  return out;
}
const call = (direction) => ({ callId: `flag|BTC|c-${direction}`, calledAt: iso(T0), symbol: 'BTC', candidateId: `c-${direction}`, timeframe: '5m', direction, entry: 100, stop: 95, tp1: 110 });
const afterWindow = T0 + 13 * TF;

await test('ATR comes from bucketed 1m candles (5m), 14 true ranges', () => {
  const bars = bucketCandles(history(), TF, T0);
  assert(bars.length === 20, `bars ${bars.length}`);
  assert(atrOf(bars) === 10, `atr ${atrOf(bars)}`);
  assert(atrOf(bars.slice(0, 10)) === null, 'needs 15 bars');
});

await test('no lookahead: candles after the alert never change ATR', () => {
  const base = scoreCalledFlag(call('long'), [...history(), ...forward(60, { 1: { high: 200, low: 0 } })], afterWindow);
  const alt = scoreCalledFlag(call('long'), [...history(), ...forward(60, { 1: { high: 110, low: 90 } })], afterWindow);
  assert(base.atr === 10 && alt.atr === 10, `${base.atr} ${alt.atr}`);
});

await test('long RIGHT: +1 ATR first', () => {
  const r = scoreCalledFlag(call('long'), [...history(), ...forward(60, { 3: { high: 110, low: 99 }, 8: { high: 100, low: 90 } })], afterWindow);
  assert(r.outcome === 'right' && r.resolvedAt === iso(T0 + 4 * MIN), JSON.stringify(r));
});

await test('short RIGHT mirrored: -1 ATR first', () => {
  const r = scoreCalledFlag(call('short'), [...history(), ...forward(60, { 3: { high: 101, low: 90 }, 8: { high: 110, low: 100 } })], afterWindow);
  assert(r.outcome === 'right', JSON.stringify(r));
});

await test('long WRONG: -1 ATR first', () => {
  const r = scoreCalledFlag(call('long'), [...history(), ...forward(60, { 2: { high: 101, low: 90 }, 5: { high: 110, low: 100 } })], afterWindow);
  assert(r.outcome === 'wrong' && r.maxAdverseAtr === 1, JSON.stringify(r));
});

await test('short WRONG mirrored: +1 ATR first', () => {
  const r = scoreCalledFlag(call('short'), [...history(), ...forward(60, { 2: { high: 110, low: 99 }, 5: { high: 100, low: 90 } })], afterWindow);
  assert(r.outcome === 'wrong', JSON.stringify(r));
});

await test('both bands in one 1m candle -> WRONG (long and short)', () => {
  const spec = { 4: { high: 111, low: 89 } };
  assert(scoreCalledFlag(call('long'), [...history(), ...forward(60, spec)], afterWindow).outcome === 'wrong', 'long');
  assert(scoreCalledFlag(call('short'), [...history(), ...forward(60, spec)], afterWindow).outcome === 'wrong', 'short');
});

await test('FLAT: neither band within 12 candles; a touch after the window does not count', () => {
  const r = scoreCalledFlag(call('long'), [...history(), ...forward(80, { 61: { high: 120, low: 100 } })], afterWindow);
  assert(r.outcome === 'flat' && r.resolvedAt === iso(T0 + 60 * MIN), JSON.stringify(r));
});

await test('OPEN: window unfinished and no band touched', () => {
  const r = scoreCalledFlag(call('long'), [...history(), ...forward(20)], T0 + 20 * MIN);
  assert(r.outcome === 'open' && r.resolvedAt === null, JSON.stringify(r));
});

await test('RIGHT resolves before the window ends', () => {
  const r = scoreCalledFlag(call('long'), [...history(), ...forward(10, { 5: { high: 110, low: 100 } })], T0 + 10 * MIN);
  assert(r.outcome === 'right', JSON.stringify(r));
});

await test('not enough history: open inside the window, no_data after; empty candles after window -> no_data', () => {
  const few = [...history().slice(-40), ...forward(60)];
  assert(scoreCalledFlag(call('long'), few, T0 + 10 * MIN).outcome === 'open', 'open');
  assert(scoreCalledFlag(call('long'), few, afterWindow).outcome === 'no_data', 'no_data atr');
  assert(scoreCalledFlag(call('long'), history(), afterWindow).outcome === 'no_data', 'no_data walk');
});

await test('dedupe by symbol+candidateId; only LOCK_OPPORTUNITY with usable levels', () => {
  const row = (id, extra = {}) => ({ id, kind: 'LOCK_OPPORTUNITY', sentAt: iso(T0), symbol: 'BTC', timeframe: '5m', direction: 'long', candidateId: 'x1', entry: 100, stop: 95, tp1: 110, ...extra });
  const calls = calledFlagsFromAlerts([
    row('a'), row('b', { sentAt: iso(T0 + MIN) }), row('c', { kind: 'GOOD', candidateId: 'x2' }),
    row('d', { candidateId: 'x3', entry: null }), row('e', { candidateId: 'x4', symbol: 'SOL', direction: 'short' })
  ]);
  assert(calls.length === 2, `calls ${calls.length}`);
  assert(calls[0].calledAt === iso(T0) && calls[0].symbol === 'BTC' && calls[0].tp1 === 110, JSON.stringify(calls[0]));
  assert(calls[1].symbol === 'SOL' && calls[1].direction === 'short', JSON.stringify(calls[1]));
});

await test('idempotent: final outcomes are kept even if candles change; open is re-scored', () => {
  const rightCandles = { BTC: [...history(), ...forward(60, { 3: { high: 110, low: 100 } })] };
  const first = scoreCalledFlags([call('long')], rightCandles, [], afterWindow);
  assert(first[0].outcome === 'right', first[0].outcome);
  const wrongCandles = { BTC: [...history(), ...forward(60, { 1: { high: 100, low: 80 } })] };
  const second = scoreCalledFlags([call('long')], wrongCandles, first, afterWindow + MIN);
  assert(second[0].outcome === 'right' && second[0].scoredAt === first[0].scoredAt, 'final kept');
  const open = scoreCalledFlags([call('long')], { BTC: [...history(), ...forward(5)] }, [], T0 + 5 * MIN);
  assert(open[0].outcome === 'open', 'open');
  const later = scoreCalledFlags([call('long')], rightCandles, open, afterWindow);
  assert(later[0].outcome === 'right', 're-scored');
});

await test('summary: windows, per-direction counts, rate excludes flat/open', () => {
  const NOW = T0 + 40 * 86_400_000;
  const mk = (daysAgo, direction, outcome, i) => ({ calledAt: iso(NOW - daysAgo * 86_400_000 - i), symbol: 'BTC', timeframe: '5m', direction, outcome });
  const rows = [
    mk(0.5, 'long', 'right', 1), mk(0.4, 'long', 'wrong', 2), mk(0.3, 'short', 'right', 3), mk(0.2, 'short', 'flat', 4), mk(0.1, 'long', 'open', 5),
    mk(3, 'short', 'wrong', 6), mk(20, 'long', 'right', 7), mk(35, 'long', 'wrong', 8)
  ];
  const s = summarizeCalledFlags(rows, NOW);
  assert(s.windows['24h'].total.called === 5 && s.windows['24h'].total.right === 2 && s.windows['24h'].total.wrong === 1, JSON.stringify(s.windows['24h']));
  assert(s.windows['24h'].rate === 67, `rate ${s.windows['24h'].rate}`);
  assert(s.windows['24h'].long.called === 3 && s.windows['24h'].short.flat === 1 && s.windows['24h'].long.open === 1, 'sides');
  assert(s.windows['7d'].total.called === 6 && s.windows['7d'].rate === 50, JSON.stringify(s.windows['7d']));
  assert(s.windows['30d'].total.called === 7 && s.windows['30d'].rate === 60, JSON.stringify(s.windows['30d']));
  assert(s.since === rows[7].calledAt && typeof s.rule === 'string' && s.rule.length > 20, 'since/rule');
});

await test('recent keeps the newest 20, newest last', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ calledAt: iso(T0 + i * MIN), symbol: 'ETH', timeframe: '1h', direction: 'long', outcome: 'open' }));
  const s = summarizeCalledFlags(rows, T0 + 30 * MIN);
  assert(s.recent.length === 20 && s.recent[19].calledAt === rows[24].calledAt && s.recent[0].calledAt === rows[5].calledAt, 'recent');
  assert(Object.keys(s.recent[0]).join() === 'calledAt,symbol,timeframe,direction,outcome', 'recent keys');
});

await test('empty input -> zeros, null rate, null since', () => {
  const s = summarizeCalledFlags([], T0);
  assert(s.since === null && s.recent.length === 0, 'since/recent');
  for (const k of ['24h', '7d', '30d']) {
    const w = s.windows[k];
    assert(w.rate === null && w.total.called === 0 && w.long.right === 0 && w.short.open === 0, k);
  }
  assert(calledFlagsFromAlerts([]).length === 0 && calledFlagsFromAlerts(undefined).length === 0, 'calls empty');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
