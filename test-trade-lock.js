/**
 * lib/tradeLock.js: frozen levels, closed-candle lifecycle (armed -> confirmed -> filled ->
 * stopped/tp1; missed / invalidated / expired), thesis warning, confluence checklist and
 * gate, TAKE / WAIT / PASS, delta since lock, compact payload shape. Includes the owner's
 * BTC 3m short of 2026-10-02 (trigger 86,357, void 86,394): the confirmation close at
 * 86,303 must read TAKE on the locked levels and never ask for a new retest.
 */
import {
  createLock, evaluateLock, fillLock, unlockLock, lockVerdict, lockLevels, confluenceChecklist, confluenceDelta,
  compactLock, normalizeLocks, openLocks, simpleAtr, timeframesAbove, checklistLine, lockR, LOCK_DEFAULTS
} from './lib/tradeLock.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const MIN = 60_000;
const T0 = Date.parse('2026-10-02T14:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** n candles of `tfMin` minutes ending (opening) at endOpenMs, closes from `closes` (oldest first), range +/- half. */
function candles(closes, tfMin, endOpenMs, { half = 10, v = 100 } = {}) {
  return closes.map((c, i) => {
    const open = endOpenMs - (closes.length - 1 - i) * tfMin * MIN;
    return { t: iso(open), o: c, h: c + half, l: c - half, c, v: Array.isArray(v) ? v[i] : v };
  });
}

/** A timeframe entry aligned for `dir` (+1 long, -1 short) unless overridden. */
function tfEntry(dir, over = {}) {
  return {
    candles: [], ema21: 100 + dir * 0.2, ema200: 100, priceVs21Pct: dir * 0.3, priceVs200Pct: dir * 0.5,
    stochRsi: { state: dir === 1 ? 'BULLISH' : 'BEARISH' }, ...over
  };
}
const allAligned = (dir) => Object.fromEntries(['1m', '3m', '5m', '15m', '1h', '4h', '1d'].map((tf) => [tf, tfEntry(dir)]));

// ---------------------------------------------------------------- owner BTC short replay

const btcSnap = { candidateId: 'BTC:3m:short:x', timeframe: '3m', direction: 'short', breakoutLevel: 86357, invalidation: 86394, entry: 86357, stop: 86394, tp1: 85950 };

function btcTimeframes(closes, endOpenMs) {
  const tfs = allAligned(-1);
  tfs['3m'] = { ...tfEntry(-1), ema21: 86380, ema200: 86420, priceVs21Pct: -0.05, priceVs200Pct: -0.1, candles: candles(closes, 3, endOpenMs, { half: 20 }) };
  return tfs;
}

console.log('\ntradeLock');

await test('BTC short 2026-10-02: lock above trigger -> 86,303 close CONFIRMS -> TAKE on the locked levels (no new retest); 86,226 is TAKE on the same levels or MISSED, never a new entry', () => {
  const pre = [86420, 86410, 86400, 86395, 86390, 86385, 86380, 86375, 86372, 86370, 86368, 86366, 86365, 86364, 86363, 86362];
  const lockAt = T0 + 16 * 3 * MIN;
  const { lock, error } = createLock({ symbol: 'BTC', snap: btcSnap, timeframes: btcTimeframes(pre, T0 + 15 * 3 * MIN), nowMs: lockAt, ref: 'aaaaaaaa' });
  assert(!error && lock.status === 'armed', `armed: ${error} ${lock && lock.status}`);
  assert(lock.levels.trigger === 86357 && lock.levels.invalidation === 86394, 'levels frozen');
  assert(lock.levels.cap < 86357 && lock.capSource === 'atr', `cap below trigger: ${lock.levels.cap}`);
  assert(lockVerdict(lock).verdict === 'WAIT', 'armed = WAIT');

  // Next 3m closes 86,303 (below 86,357): confirmed.
  const t1 = lockAt + 3 * MIN;
  const e1 = evaluateLock(lock, { price: 86303, timeframes: btcTimeframes([...pre, 86303], lockAt) }, t1 + 1000);
  assert(e1.lock.status === 'confirmed' && e1.events.some((e) => e.kind === 'confirmed'), JSON.stringify(e1.events));
  const v1 = lockVerdict(e1.lock);
  assert(v1.verdict === 'TAKE' && !/retest/i.test(v1.reason), `TAKE, no retest ask: ${v1.verdict} ${v1.reason}`);
  assert(e1.lock.levels.trigger === 86357 && e1.lock.levels.stop === 86394, 'levels untouched');

  // 86,226: still inside the cap? Depends on ATR; either still TAKE on the SAME levels, or MISSED - never a new entry.
  const e2 = evaluateLock(e1.lock, { price: 86226, timeframes: btcTimeframes([...pre, 86303, 86226], t1) }, t1 + 3 * MIN + 1000);
  const v2 = lockVerdict(e2.lock);
  assert(['TAKE', 'PASS'].includes(v2.verdict) && e2.lock.levels.trigger === 86357, `${v2.verdict} ${v2.reason}`);
  if (v2.verdict === 'PASS') assert(e2.lock.status === 'missed', 'a PASS here can only be MISSED');
  console.log(`      cap=${lock.levels.cap} atr=${lock.atr} after 86,226: ${e2.lock.status} ${v2.verdict}`);
});

await test('BTC short: run to 86,040 unfilled -> MISSED (terminal, PASS, says no chase); later evaluations are no-ops', () => {
  const pre = [86420, 86410, 86400, 86395, 86390, 86385, 86380, 86375, 86372, 86370, 86368, 86366, 86365, 86364, 86363, 86362];
  const lockAt = T0 + 16 * 3 * MIN;
  const { lock } = createLock({ symbol: 'BTC', snap: btcSnap, timeframes: btcTimeframes(pre, T0 + 15 * 3 * MIN), nowMs: lockAt, ref: 'aaaaaaaa' });
  const e = evaluateLock(lock, { price: 86040, timeframes: btcTimeframes([...pre, 86303, 86040], lockAt + 3 * MIN) }, lockAt + 6 * MIN + 1000);
  assert(e.lock.status === 'missed' && e.events.map((x) => x.kind).join() === 'confirmed,missed', JSON.stringify(e.events));
  const v = lockVerdict(e.lock);
  assert(v.verdict === 'PASS' && /MISSED/.test(v.reason) && /No chase/.test(v.reason), v.reason);
  const again = evaluateLock(e.lock, { price: 86500, timeframes: btcTimeframes([86500], lockAt + 9 * MIN) }, lockAt + 12 * MIN);
  assert(again.events.length === 0 && again.lock.status === 'missed', 'terminal stays');
});

// ---------------------------------------------------------------- lifecycle

const longSnap = { candidateId: 'ETH:5m:long:y', timeframe: '5m', direction: 'long', breakoutLevel: 100, invalidation: 98, entry: 100, stop: 98, tp1: 104 };
const longTfs = (closes, endOpen, over = {}) => ({ ...allAligned(1), '5m': { ...tfEntry(1), candles: candles(closes, 5, endOpen, { half: 0.4 }), ...over } });
const base = [99, 99.2, 99.1, 99.3, 99.4, 99.2, 99.5, 99.6, 99.5, 99.7, 99.6, 99.8, 99.7, 99.8, 99.9];

await test('long: invalidation close before confirmation -> INVALIDATED', () => {
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs(base, T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  const e = evaluateLock(lock, { price: 97.5, timeframes: longTfs([...base, 97.5], T0 + 5 * MIN) }, T0 + 10 * MIN + 1);
  assert(e.lock.status === 'invalidated' && lockVerdict(e.lock).verdict === 'PASS', e.lock.status);
});

await test('long: a pullback to the trigger after confirmation stays confirmed (one-shot, no reset)', () => {
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs(base, T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  const e1 = evaluateLock(lock, { timeframes: longTfs([...base, 100.3], T0 + 5 * MIN) }, T0 + 10 * MIN + 1);
  const e2 = evaluateLock(e1.lock, { timeframes: longTfs([...base, 100.3, 99.8], T0 + 10 * MIN) }, T0 + 15 * MIN + 1);
  assert(e1.lock.status === 'confirmed' && e2.lock.status === 'confirmed' && e2.events.length === 0, `${e2.lock.status} ${JSON.stringify(e2.events)}`);
});

await test('long: expiry after 6 trigger candles unfilled -> EXPIRED', () => {
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs(base, T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  assert(Date.parse(lock.expiresAt) - Date.parse(lock.lockedAt) === LOCK_DEFAULTS.expiryCandles * 5 * MIN, 'expiry = 6 x 5m');
  const e = evaluateLock(lock, { price: 99.9, timeframes: longTfs(base, T0) }, Date.parse(lock.expiresAt) + 1);
  assert(e.lock.status === 'expired' && e.events[0].kind === 'expired', e.lock.status);
});

await test('long: filled -> stop by wick on the frozen stop; TP1 by the live price; R measured from the fill', () => {
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs(base, T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  const c = evaluateLock(lock, { timeframes: longTfs([...base, 100.3], T0 + 5 * MIN) }, T0 + 10 * MIN + 1).lock;
  const f = fillLock(c, T0 + 11 * MIN, 100.5);
  assert(f.ok && f.lock.status === 'filled' && f.lock.fillPrice === 100.5 && lockVerdict(f.lock).verdict === 'IN TRADE', 'filled');
  assert(lockR(f.lock, 103) === 1.0, `R from fill: ${lockR(f.lock, 103)}`);
  const stopTfs = longTfs([...base, 100.3, 98.3], T0 + 10 * MIN);
  stopTfs['5m'].candles.at(-1).l = 97.9;
  const s = evaluateLock(f.lock, { price: 98.3, timeframes: stopTfs }, T0 + 15 * MIN + 1);
  assert(s.lock.status === 'stopped' && s.events[0].price === 98, `stopped at the frozen stop: ${JSON.stringify(s.events)}`);
  const t = evaluateLock(f.lock, { price: 104.2, mark: { status: 'ok', price: 104.1 }, timeframes: longTfs([...base, 100.3], T0 + 5 * MIN) }, T0 + 12 * MIN);
  assert(t.lock.status === 'tp1', t.lock.status);
});

await test('lock at a close already past the cap starts MISSED; already through the void starts INVALIDATED', () => {
  const m = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs([...base, 105], T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' }).lock;
  assert(m.status === 'missed', m.status);
  const i = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs([...base, 97], T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' }).lock;
  assert(i.status === 'invalidated', i.status);
});

await test('cap: 1.5 x ATR of the trigger TF at lock; falls back to 1R without candles; never re-measured', () => {
  const tfs = longTfs(base, T0);
  const atr = simpleAtr(tfs['5m'].candles.map((k) => ({ h: k.h, l: k.l, c: k.c })));
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: tfs, nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  assert(Math.abs(lock.levels.cap - (100 + 1.5 * atr)) < 0.01, `${lock.levels.cap} vs ${100 + 1.5 * atr}`);
  const r = createLock({ symbol: 'ETH', snap: longSnap, timeframes: allAligned(1), nowMs: T0, ref: 'bbbbbbbb' }).lock;
  assert(r.capSource === 'r' && r.levels.cap === 102, `R fallback: ${r.levels.cap}`);
  const wide = longTfs([...base, 100.3], T0 + 5 * MIN);
  wide['5m'].candles.forEach((k) => { k.h += 5; k.l -= 5; });
  const e = evaluateLock(lock, { timeframes: wide }, T0 + 10 * MIN + 1);
  assert(e.lock.levels.cap === lock.levels.cap, 'cap unchanged by a wider ATR later');
});

await test('levels: bad geometry refused (stop on the wrong side, unknown timeframe, no direction)', () => {
  assert(lockLevels({ ...longSnap, invalidation: 101, stop: 101 }) === null, 'stop above long trigger');
  assert(createLock({ symbol: 'ETH', snap: { ...longSnap, timeframe: '2h' }, timeframes: {}, nowMs: T0, ref: 'bbbbbbbb' }).error === 'bad_timeframe', 'tf');
  assert(createLock({ symbol: 'ETH', snap: { ...longSnap, direction: null }, timeframes: {}, nowMs: T0, ref: 'bbbbbbbb' }).error === 'bad_levels', 'dir');
  assert(lockLevels({ ...longSnap, tp1: 95 }).tp1 === null, 'TP1 on the wrong side dropped');
});

// ---------------------------------------------------------------- thesis + confluence

await test('thesis: a TF above (15m/1h for 5m) closing past EMA200 after the lock warns once and moves no level', () => {
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs(base, T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  assert(JSON.stringify(Object.keys(lock.thesis.base)) === '["15m","1h"]', JSON.stringify(lock.thesis.base));
  const tfs = longTfs([...base, 100.3], T0 + 5 * MIN);
  tfs['1h'] = { ...tfs['1h'], priceVs200Pct: -0.2 };
  const e = evaluateLock(lock, { timeframes: tfs }, T0 + 10 * MIN + 1);
  assert(e.events.some((x) => x.kind === 'thesis_broken' && x.detail.timeframes[0] === '1h'), JSON.stringify(e.events));
  assert(lockVerdict(e.lock).verdict === 'WAIT' && /thesis/i.test(lockVerdict(e.lock).reason), lockVerdict(e.lock).reason);
  assert(JSON.stringify(e.lock.levels) === JSON.stringify(lock.levels), 'levels unchanged');
  const again = evaluateLock(e.lock, { timeframes: tfs }, T0 + 10 * MIN + 2);
  assert(!again.events.some((x) => x.kind === 'thesis_broken'), 'warns once');
  assert(JSON.stringify(timeframesAbove('1d', 2)) === '[]', 'nothing above 1d');
});

await test('confluence: per-TF marks, D7 model, gate = trigger MAs + price + 2 supports; mirrored short gives the same score', () => {
  const tfs = allAligned(1);
  tfs['4h'] = tfEntry(-1);
  tfs['1d'] = tfEntry(1, { stochRsi: { state: 'BEARISH' } });
  const c = confluenceChecklist(tfs, 'long', '5m');
  assert(c.rows.find((r) => r.tf === '4h').mark === '❌' && c.rows.find((r) => r.tf === '1d').mark === '⚠️', checklistLine(c));
  assert(c.score === 5 && c.of === 7 && c.primary && c.gate, `${c.score}/${c.of} gate=${c.gate}`);
  assert(c.model && c.model.ok && c.model.gapPct === 0.2, JSON.stringify(c.model));
  const m = confluenceChecklist(Object.fromEntries(Object.entries(tfs).map(([k, e]) => [k, {
    ...e, ema21: 100 - (e.ema21 - 100), priceVs21Pct: -e.priceVs21Pct, priceVs200Pct: -e.priceVs200Pct,
    stochRsi: { state: e.stochRsi.state === 'BULLISH' ? 'BEARISH' : 'BULLISH' }
  }])), 'short', '5m');
  assert(m.score === c.score && m.gate === c.gate && checklistLine(m) === checklistLine(c), `${checklistLine(m)} vs ${checklistLine(c)}`);
});

await test('confluence: wide MAs fail the model; trigger MAs against -> confirmed lock reads PASS; gate loss warns', () => {
  const wide = confluenceChecklist({ ...allAligned(1), '5m': tfEntry(1, { ema21: 102, ema200: 100 }) }, 'long', '5m');
  assert(wide.model.ok === false && wide.model.gapPct === 2, JSON.stringify(wide.model));
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs(base, T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  const c = evaluateLock(lock, { timeframes: longTfs([...base, 100.3], T0 + 5 * MIN) }, T0 + 10 * MIN + 1).lock;
  assert(lockVerdict(c).verdict === 'TAKE', lockVerdict(c).reason);
  const against = longTfs([...base, 100.3], T0 + 5 * MIN, { ema21: 99, ema200: 100, priceVs21Pct: 0.1 });
  against['15m'] = tfEntry(-1);
  const e = evaluateLock(c, { timeframes: against }, T0 + 10 * MIN + 2);
  assert(e.events.some((x) => x.kind === 'gate_lost'), JSON.stringify(e.events));
  assert(lockVerdict(e.lock).verdict === 'PASS', lockVerdict(e.lock).reason);
  assert(JSON.stringify(e.lock.levels) === JSON.stringify(lock.levels), 'levels unchanged');
});

await test('volume: last closed trigger candle above the prior 10-candle mean counts as support', () => {
  const vols = [...Array(14).fill(100), 250];
  const tfs = { ...allAligned(1), '5m': { ...tfEntry(1), candles: candles(base, 5, T0, { v: vols }) } };
  const c = confluenceChecklist(tfs, 'long', '5m');
  assert(c.volume.ok && c.volume.ratio === 2.5, JSON.stringify(c.volume));
});

await test('delta since lock + compact payload shape + unlock + normalize', () => {
  const { lock } = createLock({ symbol: 'ETH', snap: longSnap, timeframes: longTfs(base, T0), nowMs: T0 + 5 * MIN, ref: 'bbbbbbbb' });
  const tfs = longTfs(base, T0);
  tfs['1h'] = tfEntry(-1);
  const e = evaluateLock(lock, { timeframes: tfs }, T0 + 6 * MIN);
  assert(JSON.stringify(confluenceDelta(e.lock.confAtLock, e.lock.conf)) === '["1h ✅→❌"]', JSON.stringify(confluenceDelta(e.lock.confAtLock, e.lock.conf)));
  const cl = compactLock(e.lock);
  assert(cl.ref === 'bbbbbbbb' && cl.st === 'armed' && cl.verdict === 'WAIT' && cl.lv.trg === 100 && cl.lv.cap === lock.levels.cap && cl.conf.delta[0] === '1h ✅→❌', JSON.stringify(cl));
  assert(JSON.stringify(cl).length < 700, `compact size ${JSON.stringify(cl).length}`);
  const u = unlockLock(e.lock, T0 + 7 * MIN);
  assert(u.ok && u.lock.status === 'unlocked' && !unlockLock(u.lock, T0).ok, 'unlock once');
  assert(openLocks([u.lock, lock]).length === 1, 'open filter');
  assert(normalizeLocks([u.lock, lock, { ref: 'zz' }], T0 + 8 * MIN).length === 2, 'normalize keeps valid');
  assert(normalizeLocks([u.lock], T0 + 2 * 86_400_000).length === 0, 'closed locks drop after a day');
  assert(!fillLock(u.lock, T0).ok, 'cannot fill an unlocked lock');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
