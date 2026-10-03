/**
 * lib/myTrades.js + the fee line (lib/flagFlow.js feeLine): journal rows for taken locks that closed,
 * net R after fees, stats, /mytrades text, the Unlock exit price, and the lock card's fee / net line.
 */
import { myTradeOf, recordMyTrades, myTradesStats, formatMyTrades, normalizeMyTrades, MY_TRADES_MAX, ALERT_BASELINE_NET_R } from './lib/myTrades.js';
import { feeLine, feeR, FEE_MAX_R } from './lib/flagFlow.js';
import { unlockLock, fillLock } from './lib/tradeLock.js';
import { applyLockChange, formatLockCard } from './lib/telegramLock.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, eps = 0.011) => typeof a === 'number' && Math.abs(a - b) <= eps;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const T0 = Date.parse('2026-10-03T14:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** A filled lock: long entry 100,000, stop 99,000 (1% risk). */
const lockOf = (over = {}) => ({
  ref: 'a1b2c3d4', symbol: 'BTC', candidateId: 'c1', source: 'flag', timeframe: '1h', direction: 'long',
  lockedAt: iso(T0 - 3_600_000), expiresAt: iso(T0 + 3_600_000 * 6),
  levels: { trigger: 100000, invalidation: 99000, entry: 100000, stop: 99000, tp1: 102000, cap: 101500 },
  status: 'filled', statusAt: iso(T0), confirmedAt: iso(T0 - 600_000), filledAt: iso(T0), fillPrice: 100000,
  endedAt: null, endPrice: null, history: [], conf: { score: 5, of: 7, gate: true, rows: [] },
  ...over
});
const closed = (status, endPrice, over = {}) => lockOf({ status, endPrice, endedAt: iso(T0 + 7_200_000), statusAt: iso(T0 + 7_200_000), ...over });

console.log('fee line');
await test('feeR: long 0.34% round trip on a 1% stop = 0.34R; short 0.14%', () => {
  assert(near(feeR(100000, 99000, 'long'), 0.34), `long ${feeR(100000, 99000, 'long')}`);
  assert(near(feeR(100000, 101000, 'short'), 0.14), `short ${feeR(100000, 101000, 'short')}`);
});
await test('feeLine: above the 0.25R limit says skip; under it does not; missing levels -> null', () => {
  assert(FEE_MAX_R === 0.25, 'limit 0.25R');
  assert(feeLine(100000, 99000, 'long') === 'Fees 0.34R of risk · stop too tight, skip', feeLine(100000, 99000, 'long'));
  assert(feeLine(100000, 101000, 'short') === 'Fees 0.14R of risk', feeLine(100000, 101000, 'short'));
  assert(feeLine(100000, 100000, 'long') === null && feeLine(null, 1, 'long') === null, 'no risk -> null');
});

console.log('journal rows');
await test('target hit: gross +2R, net = 2 - 0.34', () => {
  const r = myTradeOf(closed('tp1', 102000));
  assert(r && r.how === 'tp1' && near(r.grossR, 2) && near(r.feeR, 0.34) && near(r.netR, 1.66), JSON.stringify(r));
});
await test('stopped: net = -1 - fees; short side uses the short cost', () => {
  const l = closed('stopped', 101000, { direction: 'short', levels: { trigger: 100000, invalidation: 101000, entry: 100000, stop: 101000, tp1: 98000, cap: 98500 } });
  const r = myTradeOf(l);
  assert(r && r.dir === 'short' && near(r.grossR, -1) && near(r.netR, -1.14), JSON.stringify(r));
});
await test('R is measured from the fill, not the planned entry', () => {
  const r = myTradeOf(closed('tp1', 102000, { fillPrice: 100500 }));
  assert(near(r.grossR, 1500 / 1500) && r.fill === 100500, JSON.stringify(r));
});
await test('not taken or still open -> no row; unlocked with no exit price -> row with null R', () => {
  assert(myTradeOf(closed('missed', 101600, { filledAt: null, fillPrice: null })) === null, 'missed before fill');
  assert(myTradeOf(lockOf()) === null, 'still filled/open');
  const r = myTradeOf(closed('unlocked', null));
  assert(r && r.netR === null && r.grossR === null, JSON.stringify(r));
});
await test('recordMyTrades: adds once per ref, keeps order, caps at MY_TRADES_MAX', () => {
  const state = {};
  const a = closed('tp1', 102000);
  assert(recordMyTrades(state, [a]).length === 1 && recordMyTrades(state, [a]).length === 0, 'once per ref');
  assert(state.myTrades.length === 1, 'one row');
  const many = Array.from({ length: MY_TRADES_MAX + 5 }, (_, i) => closed('stopped', 99000, { ref: (0x10000000 + i).toString(16) }));
  recordMyTrades(state, many);
  assert(state.myTrades.length === MY_TRADES_MAX, `capped ${state.myTrades.length}`);
  assert(normalizeMyTrades([{ ref: 'bad' }, null, state.myTrades[0]]).length === 1, 'malformed rows dropped');
});

console.log('stats and /mytrades');
await test('stats: win rate, avg win / loss net, net per trade, baseline weighted by own timeframes', () => {
  const rows = [closed('tp1', 102000, { ref: '00000001' }), closed('stopped', 99000, { ref: '00000002' }), closed('unlocked', null, { ref: '00000003' })].map(myTradeOf);
  const s = myTradesStats(rows);
  assert(s.n === 2 && s.unknown === 1 && s.winRate === 50, JSON.stringify(s));
  assert(near(s.avgWinR, 1.66) && near(s.avgLossR, -1.34) && near(s.netPerTrade, 0.16) && near(s.totalNetR, 0.32), JSON.stringify(s));
  assert(s.baseline === ALERT_BASELINE_NET_R['1h'] && s.byTf['1h'].n === 2, JSON.stringify(s));
});
await test('formatMyTrades: empty explains how to log; with trades shows net, baseline, small-sample note, last trades', () => {
  assert(/none yet/.test(formatMyTrades([])), 'empty');
  const t = formatMyTrades([closed('tp1', 102000)].map(myTradeOf));
  for (const s of ['MY TRADES · 1 closed', 'Net +1.66R per trade', 'Every alert, same timeframes: −0.17R', 'Small sample: 1/30', 'BTC 1h ▲ target +1.66R']) {
    assert(t.includes(s), `missing "${s}" in:\n${t}`);
  }
});

console.log('lock wiring');
await test('unlocking a taken lock keeps the exit price; unlocking an untaken one does not', () => {
  const u = unlockLock(lockOf(), T0 + 60_000, 100800).lock;
  assert(u.status === 'unlocked' && u.endPrice === 100800, JSON.stringify(u));
  const armed = { ...lockOf(), status: 'armed', filledAt: null, fillPrice: null };
  assert(unlockLock(armed, T0, 100800).lock.endPrice === null, 'armed unlock has no exit');
});
await test('applyLockChange unlock on a filled lock writes a myTrades row with net R', () => {
  const text = JSON.stringify({ locks: [lockOf()] });
  const out = applyLockChange(text, { action: 'unlock', ref: 'a1b2c3d4', price: 101000 }, T0 + 60_000, JSON.parse);
  const st = JSON.parse(out.text);
  assert(out.result === 'unlocked' && st.myTrades.length === 1 && near(st.myTrades[0].netR, 0.66), out.text);
});
await test('applyLockChange fill then later states: no row until it closes', () => {
  const armed = { ...lockOf(), status: 'confirmed', filledAt: null, fillPrice: null };
  const out = applyLockChange(JSON.stringify({ locks: [armed] }), { action: 'fill', ref: 'a1b2c3d4', price: 100100 }, T0, JSON.parse);
  const st = JSON.parse(out.text);
  assert(out.result === 'filled' && st.myTrades.length === 0, out.text);
  assert(fillLock(armed, T0, 100100).lock.fillPrice === 100100, 'fill price');
});
await test('lock card: open lock shows the fee line; closed taken lock shows net after fees', () => {
  const open = formatLockCard(lockOf(), null, T0, null);
  assert(open.includes('Fees 0.34R of risk · stop too tight, skip'), open);
  const done = formatLockCard(closed('tp1', 102000), null, T0 + 7_200_000, null);
  assert(done.includes('Net +1.66R after 0.34R fees'), done);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
