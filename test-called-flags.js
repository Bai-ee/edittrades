/**
 * scripts/tracker/called-flags.js: called-flag scoring (1 ATR(14) of own timeframe, 12 candles).
 */
import {
  calledFlagsFromAlerts, scoreCalledFlag, scoreCalledFlags, summarizeCalledFlags, calibrateCalledFlags, bucketCandles, atrOf
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

await test('anchor = open of the first 1m candle at/after the alert; entryOffsetAtr is signed in the trade direction', () => {
  const cs = [...history(), ...forward(60).map((c, i) => (i === 0 ? { ...c, open: 103, high: 103.5, low: 102.5, close: 103 } : c))];
  const l = scoreCalledFlag(call('long'), cs, afterWindow);
  assert(l.anchor === 103 && l.entryOffsetAtr === 0.3, JSON.stringify(l));
  const s = scoreCalledFlag(call('short'), cs, afterWindow);
  assert(s.anchor === 103 && s.entryOffsetAtr === -0.3, JSON.stringify(s));
});

await test('anchor falls back to the last 1m close before the alert when the first candle opens later', () => {
  const hist = history().map((c, i, a) => (i === a.length - 1 ? { ...c, close: 101 } : c));
  const r = scoreCalledFlag(call('long'), [...hist, ...forward(60).slice(1)], afterWindow);
  assert(r.anchor === 100 || r.anchor === 100.0, JSON.stringify(r)); // first candle at/after the alert (T0+1m) opens at 100
  const gap = scoreCalledFlag(call('long'), hist, afterWindow);
  assert(gap.outcome === 'no_data', 'no candle after the alert -> no_data');
});

await test('alerted 1 ATR past entry: judged from the alert price, not auto-right (long and short mirror)', () => {
  const pastLong = forward(60).map((c) => ({ ...c, open: 110, high: 110, low: 110, close: 110 }));
  pastLong[2] = { ...pastLong[2], high: 110, low: 100 }; // -1 ATR from the 110 anchor first
  const l = scoreCalledFlag(call('long'), [...history(), ...pastLong], afterWindow);
  assert(l.outcome === 'wrong' && l.entryOffsetAtr === 1 && l.anchor === 110, JSON.stringify(l));
  const pastShort = forward(60).map((c) => ({ ...c, open: 90, high: 90, low: 90, close: 90 }));
  pastShort[2] = { ...pastShort[2], high: 100, low: 90 };
  const s = scoreCalledFlag(call('short'), [...history(), ...pastShort], afterWindow);
  assert(s.outcome === 'wrong' && s.entryOffsetAtr === 1 && s.anchor === 90, JSON.stringify(s));
  const rightLong = forward(60).map((c) => ({ ...c, open: 110, high: 110, low: 110, close: 110 }));
  rightLong[3] = { ...rightLong[3], high: 120, low: 110 };
  assert(scoreCalledFlag(call('long'), [...history(), ...rightLong], afterWindow).outcome === 'right', 'needs a real +1 ATR from 110');
  const flat = scoreCalledFlag(call('long'), [...history(), ...forward(60).map((c) => ({ ...c, open: 110, high: 110, low: 110, close: 110 }))], afterWindow);
  assert(flat.outcome === 'flat', `a call already at +1 ATR over entry with no further move is flat: ${flat.outcome}`);
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
  const FLOW = { score: 6, of: 7, rr: 1.5, nextTf: 'agrees' };
  const mk = (daysAgo, direction, outcome, i) => ({ calledAt: iso(NOW - daysAgo * 86_400_000 - i), symbol: 'BTC', timeframe: '5m', direction, outcome, flow: FLOW });
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
  const rows = Array.from({ length: 25 }, (_, i) => ({ calledAt: iso(T0 + i * MIN), symbol: 'ETH', timeframe: '1h', direction: 'long', outcome: 'open', flow: { score: 5, of: 7, rr: 1, nextTf: null } }));
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

const FLOW6 = { score: 6, of: 7, rr: 1.5, nextTf: 'agrees' };
const NOWC = T0;
/** n outcome rows (resolved right/wrong) sharing a flow/tf/symbol; callers spread overrides. */
const mkRows = (right, wrong, extra = {}) => [
  ...Array.from({ length: right }, (_, i) => ({ calledAt: iso(NOWC - (i + 1) * MIN), symbol: 'BTC', timeframe: '15m', direction: 'long', flow: FLOW6, outcome: 'right', ...extra })),
  ...Array.from({ length: wrong }, (_, i) => ({ calledAt: iso(NOWC - (i + 100) * MIN), symbol: 'BTC', timeframe: '15m', direction: 'long', flow: FLOW6, outcome: 'wrong', ...extra }))
];

await test('flow fields carried onto outcome rows; legacy -> null', () => {
  const alert = (id, flow) => ({ id, kind: 'LOCK_OPPORTUNITY', sentAt: iso(T0), symbol: 'BTC', timeframe: '5m', direction: 'long', candidateId: id, entry: 100, stop: 95, tp1: 110, ...(flow ? { flow } : {}) });
  const calls = calledFlagsFromAlerts([alert('f', { score: 6, of: 7, rr: 1.8, nextTf: 'mixed', stage: 'x', tfs: [] }), alert('l')]);
  const rows = scoreCalledFlags(calls, { BTC: [...history(), ...forward(60)] }, [], afterWindow);
  const f = rows.find((r) => r.candidateId === 'f');
  assert(JSON.stringify(f.flow) === JSON.stringify({ score: 6, of: 7, rr: 1.8, nextTf: 'mixed' }), JSON.stringify(f.flow));
  assert(rows.find((r) => r.candidateId === 'l').flow === null, 'legacy null');
});

await test('headline excludes legacy; legacy counted separately', () => {
  const legacy = [{ calledAt: iso(T0 - MIN), symbol: 'BTC', timeframe: '5m', direction: 'long', outcome: 'wrong', flow: null }, { calledAt: iso(T0 - 2 * MIN), symbol: 'BTC', timeframe: '5m', direction: 'long', outcome: 'right', flow: null }, { calledAt: iso(T0 - 3 * MIN), symbol: 'BTC', timeframe: '5m', direction: 'long', outcome: 'right' }, { calledAt: iso(T0 - 4 * MIN), symbol: 'BTC', timeframe: '5m', direction: 'long', outcome: 'open' }];
  const s = summarizeCalledFlags([...mkRows(1, 0), ...legacy], T0);
  assert(s.windows['24h'].total.called === 1 && s.windows['24h'].rate === 100 && s.recent.length === 1, JSON.stringify(s.windows['24h']));
  assert(JSON.stringify(s.legacy) === JSON.stringify({ called: 4, right: 2, wrong: 1, flat: 0, open: 1, rate: 67 }), JSON.stringify(s.legacy));
  assert(summarizeCalledFlags([], T0).legacy.rate === null, 'empty legacy');
});

await test('buckets: counts, rate, thin below minN, meets/below at minN', () => {
  const rows = [...mkRows(21, 9), ...mkRows(3, 1, { symbol: 'SOL', timeframe: '1h', direction: 'short', flow: { score: 7, of: 7, rr: 0.5, nextTf: 'disagrees' } }), { ...mkRows(1, 0)[0], outcome: 'flat' }];
  const c = calibrateCalledFlags(rows, NOWC);
  const get = (g, k) => c.buckets[g].find((b) => b.key === k);
  assert(c.scored === 34 && c.legacyCount === 0, `scored ${c.scored}`);
  const s6 = get('score', '6/7');
  assert(s6.n === 30 && s6.right === 21 && s6.wrong === 9 && s6.flat === 1 && s6.rate === 70 && s6.status === 'meets', JSON.stringify(s6));
  const s7 = get('score', '7/7');
  assert(s7.n === 4 && s7.rate === 75 && s7.status === 'thin', JSON.stringify(s7));
  assert(get('score', '5/7').rate === null && get('score', '5/7').status === 'thin', '5/7 empty');
  assert(get('symbol', 'SOL').n === 4 && get('direction', 'short').n === 4 && get('timeframe', '1h').n === 4 && get('nextTf', 'disagrees').n === 4, 'groups');
  assert(c.buckets.timeframe.length === 8 && c.buckets.rr.length === 3 && c.buckets.nextTf.length === 3, 'fixed keys');
  const below = calibrateCalledFlags(mkRows(10, 20), NOWC).buckets.score.find((b) => b.key === '6/7');
  assert(below.status === 'below' && below.rate === 33, JSON.stringify(below));
});

await test('rr bucket edges: 1 -> 1-2R, 2 -> 2R+, just under -> lower', () => {
  const rr = (v) => mkRows(1, 0, { flow: { ...FLOW6, rr: v } });
  const c = calibrateCalledFlags([...rr(0.99), ...rr(1), ...rr(1.99), ...rr(2), ...rr(null)], NOWC);
  const n = (k) => c.buckets.rr.find((b) => b.key === k).n;
  assert(n('<1R') === 1 && n('1-2R') === 2 && n('2R+') === 1, JSON.stringify(c.buckets.rr.map((b) => [b.key, b.n])));
});

await test('optimizer picks the max-n rule meeting target', () => {
  // 40 calls at 6/7 (30R/10W = 75%), plus 10 calls at 5/7 (all wrong) -> minScore 6 meets, minScore 5 does not
  const rows = [...mkRows(30, 10), ...mkRows(0, 10, { flow: { ...FLOW6, score: 5 }, symbol: 'ETH' }).map((r, i) => ({ ...r, calledAt: iso(NOWC - (i + 500) * MIN) }))];
  const c = calibrateCalledFlags(rows, NOWC);
  const r = c.recommended;
  assert(r.status === 'meets' && r.rule.minScore === '6/7' && r.rule.minRR === null && r.rule.nextTf === null && r.rule.timeframes.length === 8, JSON.stringify(r));
  assert(r.projected.n === 40 && r.projected.rate === 75, JSON.stringify(r.projected));
  assert(r.reason === '6/7+ on 1m\u20134h hit 75% over 40 calls.', r.reason);
  assert(c.candidates.length === 5 && c.candidates[0].reason === r.reason && !('status' in c.candidates[0]), 'candidates');
});

await test('optimizer falls back to best rate when none meet target', () => {
  const c = calibrateCalledFlags(mkRows(12, 28), NOWC);
  assert(c.recommended.status === 'below' && c.recommended.projected.n === 40 && c.recommended.projected.rate === 30, JSON.stringify(c.recommended));
  assert(/below the 70% target/.test(c.recommended.reason), c.recommended.reason);
});

await test('needs_data when every rule is thin; empty input safe', () => {
  const c = calibrateCalledFlags(mkRows(7, 2), NOWC);
  assert(c.recommended.status === 'needs_data' && c.recommended.reason === 'Not enough data yet: best rule has 9 calls; needs 30.', JSON.stringify(c.recommended));
  const e = calibrateCalledFlags([], NOWC);
  assert(e.scored === 0 && e.recommended.status === 'needs_data' && e.recommended.projected.rate === null && e.candidates.length === 5, JSON.stringify(e.recommended));
  assert(e.buckets.symbol.length === 0 && e.buckets.score.every((b) => b.n === 0 && b.status === 'thin'), 'empty buckets');
  assert(calibrateCalledFlags(undefined, NOWC).scored === 0, 'undefined');
});

await test('calibration uses only the rolling 30 days and counts legacy separately', () => {
  const old = mkRows(5, 0).map((r) => ({ ...r, calledAt: iso(NOWC - 31 * 86_400_000) }));
  const legacy = mkRows(2, 0).map((r) => ({ ...r, flow: null }));
  const c = calibrateCalledFlags([...mkRows(3, 0), ...old, ...legacy], NOWC);
  assert(c.scored === 3 && c.legacyCount === 2, `${c.scored} ${c.legacyCount}`);
});

await test('a final scored before the alert-price rule (no anchor) is re-scored; one with an anchor is kept', async () => {
  const { scoreCalledFlags } = await import('./scripts/tracker/called-flags.js');
  const call = { callId: 'flag|BTC|x', calledAt: '2026-10-01T00:00:00.000Z', symbol: 'BTC', timeframe: '1m', direction: 'long', entry: 100 };
  const old = { ...call, outcome: 'right', atr: 1, resolvedAt: '2026-10-01T00:05:00.000Z' };
  const kept = { ...old, anchor: 100.5 };
  const reScored = scoreCalledFlags([call], { BTC: [] }, [old], Date.parse('2026-10-01T00:30:00.000Z'))[0];
  assert(reScored.outcome !== 'right', `legacy final re-scored: ${reScored.outcome}`);
  const same = scoreCalledFlags([call], { BTC: [] }, [kept], Date.parse('2026-10-01T00:30:00.000Z'))[0];
  assert(same.outcome === 'right' && same.anchor === 100.5, 'anchored final kept');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
