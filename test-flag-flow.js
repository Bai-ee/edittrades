/**
 * lib/flagFlow.js: stage rules (found / lockable / missed / watch, long and short), ATR cap,
 * ranking, snapshot -> lock levels, opportunity / FOUND / board cards, keyboard, 24h pulse.
 */
import {
  scoreFlag, rankFlags, snapshotOf, formatFoundCard, formatOpportunityCard, tp2For, formatBoard, flowKeyboard,
  pulseOf, pulseLine, FLOW_DEFAULTS, FLOW_STATE_RANK
} from './lib/flagFlow.js';
import { createLock, lockLevels } from './lib/tradeLock.js';
import { fmtLvl } from './lib/telegram.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const MIN = 60_000;
const T0 = Date.parse('2026-10-02T14:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
const TF_MIN = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

/** n flat candles (range +/- 10, so ATR 20) ending at T0, constant close. */
const flat = (tf, close, n = 20) => Array.from({ length: n }, (_, i) => ({
  t: iso(T0 - (n - 1 - i) * TF_MIN[tf] * MIN), o: close, h: close + 10, l: close - 10, c: close, v: 100
}));
const tfEntry = (dir, tf, close, over = {}) => ({
  candles: flat(tf, close), ema21: 100 + dir * 0.2, ema200: 100, priceVs21Pct: dir * 0.3, priceVs200Pct: dir * 0.5,
  stochRsi: { state: dir === 1 ? 'BULLISH' : 'BEARISH' }, ...over
});
/** All TFs aligned with `dir` (gate passes) or, with aligned=false, all against it. */
const timeframes = (dir, close, aligned = true) => Object.fromEntries(TFS.map((tf) => [tf, tfEntry(aligned ? dir : -dir, tf, close)]));

const cand = (dir, over = {}) => ({
  id: `BTC:1h:${dir === 1 ? 'long' : 'short'}:x`, tf: '1h', dir: dir === 1 ? 'long' : 'short', st: 'forming',
  brk: 86400, inv: 86400 - dir * 500, tgt: 86400 + dir * 1200, rr: 2.4, conf: 70, at: iso(T0), chase: false, ...over
});

console.log('\nflagFlow');

for (const dir of [1, -1]) {
  const side = dir === 1 ? 'long' : 'short';
  const tfs = timeframes(dir, 86400);
  await test(`${side}: forming/proto + gate -> found (not lockable)`, () => {
    for (const st of ['forming', 'proto']) assert(scoreFlag('BTC', cand(dir, { st }), tfs, 86400).stage === 'found', st);
  });
  await test(`${side}: triggering + gate -> lockable; confirmed inside cap -> lockable`, () => {
    assert(scoreFlag('BTC', cand(dir, { st: 'triggering' }), tfs, 86400).stage === 'lockable', 'triggering');
    const e = scoreFlag('BTC', cand(dir, { st: 'confirmed' }), tfs, 86400 + dir * 5);
    assert(e.stage === 'lockable', e.stage);
  });
  await test(`${side}: lockable needs a target; no target -> found`, () => {
    assert(scoreFlag('BTC', cand(dir, { st: 'triggering', tgt: null }), tfs, 86400).stage === 'found', 'no target');
  });
  await test(`${side}: confirmed past cap -> missed; at the cap is not missed`, () => {
    const cap = scoreFlag('BTC', cand(dir, { st: 'confirmed' }), tfs, 86400).levels.cap;
    assert(scoreFlag('BTC', cand(dir, { st: 'confirmed' }), tfs, cap + dir * 1).stage === 'missed', 'past');
    assert(scoreFlag('BTC', cand(dir, { st: 'confirmed' }), tfs, cap).stage === 'lockable', 'at cap');
    assert(scoreFlag('BTC', cand(dir, { st: 'triggering' }), tfs, cap + dir * 1).stage === 'missed', 'triggering past cap is missed too (never a late GO IN)');
  });
  await test(`${side}: gate not met -> watch (forming and confirmed)`, () => {
    const bad = timeframes(dir, 86400, false);
    assert(scoreFlag('BTC', cand(dir), bad, 86400).stage === 'watch', 'forming');
    assert(scoreFlag('BTC', cand(dir, { st: 'confirmed' }), bad, 86400).stage === 'watch', 'confirmed');
  });
  await test(`${side}: cap = brk + dir x 1.5 ATR (ATR 20 -> 30)`, () => {
    const e = scoreFlag('BTC', cand(dir), tfs, 86400);
    assert(Math.abs(e.levels.cap - (86400 + dir * 30)) < 0.5, `cap ${e.levels.cap}`);
  });
}

await test('cap is null without candles; confirmed then never missed', () => {
  const noCandles = Object.fromEntries(TFS.map((tf) => [tf, { ...tfEntry(1, tf, 86400), candles: [] }]));
  const e = scoreFlag('BTC', cand(1, { st: 'confirmed' }), noCandles, 99999);
  assert(e.levels.cap === null && e.stage !== 'missed', `${e.levels.cap} ${e.stage}`);
});

await test('entry shape: ref, levels, null target kept null', () => {
  const e = scoreFlag('BTC', cand(1, { tgt: null, rr: null }), timeframes(1, 86400), 86400);
  assert(/^[0-9a-f]{8}$/.test(e.ref) && e.levels.entry === 86400 && e.levels.stop === 85900, 'levels');
  assert(e.levels.target === null && e.levels.rr === null, 'nulls');
});

const board = (list, tfs) => ({ board: { BTC: list }, symbols: { BTC: { price: 86400, timeframes: tfs } } });

await test('rankFlags: lockable > found > watch, missed dropped', () => {
  const good = timeframes(1, 86400);
  const { board: b, symbols } = board([
    cand(1, { id: 'w', st: 'forming', tf: '4h' }),
    cand(1, { id: 'f', st: 'forming' }),
    cand(1, { id: 'r', st: 'confirmed' }),
    cand(1, { id: 'm', st: 'confirmed', brk: 80000, inv: 79500 })
  ], good);
  // make 'w' watch: gate fails for 4h by breaking the 4h entry
  symbols.BTC.timeframes = { ...good, '4h': tfEntry(-1, '4h', 86400) };
  const out = rankFlags(b, symbols);
  assert(out.map((e) => `${e.id}:${e.stage}`).join() === 'r:lockable,f:found,w:watch', out.map((e) => `${e.id}:${e.stage}`).join());
  assert(!out.some((e) => e.id === 'm'), 'missed dropped');
  assert(out[0].stage === 'lockable', 'lockable first');
});

await test('rankFlags: score, then state rank, then higher TF, then rr', () => {
  const tfs = timeframes(1, 86400);
  const rank = (list) => rankFlags({ BTC: list }, { BTC: { price: 86400, timeframes: tfs } }).map((e) => e.id).join();
  assert(rank([cand(1, { id: 'a', st: 'proto' }), cand(1, { id: 'b', st: 'triggering' })]) === 'b,a', 'state rank');
  assert(rank([cand(1, { id: 'a', tf: '15m' }), cand(1, { id: 'b', tf: '1h' })]) === 'b,a', 'higher tf');
  assert(rank([cand(1, { id: 'a', rr: 1.5 }), cand(1, { id: 'b', rr: 3 })]) === 'b,a', 'rr');
  // score: weaken 15m row so a 15m flag scores lower than a 1h flag with the same state (checklist differs per trigger TF only via gate; use whole-board score)
  const mixed = { ...tfs, '3m': tfEntry(-1, '3m', 86400) };
  const out = rankFlags({ BTC: [cand(1, { id: 'a', tf: '5m' })], ETH: [cand(1, { id: 'b', tf: '5m' })] },
    { BTC: { price: 1, timeframes: mixed }, ETH: { price: 1, timeframes: tfs } });
  assert(out[0].id === 'b' && out[0].score > out[1].score, `score order ${out.map((e) => e.score)}`);
});

await test('FLOW_DEFAULTS and FLOW_STATE_RANK', () => {
  assert(FLOW_DEFAULTS.capAtr === 1.5 && FLOW_DEFAULTS.boardSize === 3 && FLOW_DEFAULTS.foundCooldownMs === 900000, 'defaults');
  assert(FLOW_STATE_RANK.confirmed > FLOW_STATE_RANK.triggering && FLOW_STATE_RANK.forming > FLOW_STATE_RANK.proto, 'rank');
});

for (const dir of [1, -1]) {
  await test(`snapshotOf ${dir === 1 ? 'long' : 'short'}: field mapping and createLock accepts it`, () => {
    const tfs = timeframes(dir, 86400);
    const e = scoreFlag('BTC', cand(dir, { st: 'confirmed' }), tfs, 86400);
    const s = snapshotOf(e);
    assert(s.candidateId === e.id && s.timeframe === '1h' && s.direction === e.dir && s.state === 'confirmed', 'ids');
    assert(s.entry === 86400 && s.breakoutLevel === 86400 && s.stop === e.levels.stop && s.invalidation === e.levels.stop, 'entry/stop');
    assert(s.tp1 === e.levels.target && s.measuredTarget === s.tp1 && s.measuredRR === 2.4, 'target');
    assert(s.recClass === 'FLOW' && s.planStatus === 'lockable' && s.tp2 === e.levels.tp2, 'class/status');
    assert(lockLevels(s) !== null, 'lockLevels');
    const { lock, error } = createLock({ symbol: 'BTC', snap: s, timeframes: tfs, nowMs: T0 + 3600_000, ref: e.ref });
    assert(!error && lock.levels.entry === 86400 && lock.levels.stop === e.levels.stop, `createLock ${error}`);
  });
}

await test('FOUND card: trigger level, checklist score, <= 600 chars', () => {
  const e = scoreFlag('BTC', cand(1), timeframes(1, 86400), 86400);
  const t = formatFoundCard(e, T0);
  assert(t.includes('FOUND') && t.includes('Trigger on a 1h close above') && t.includes('86,400'), t);
  assert(t.includes(`checklist ${e.score}/${e.of}`) && t.includes('1m✅'), 'score/checklist');
  assert(t.length <= 600, `len ${t.length}`);
  assert(formatFoundCard(scoreFlag('BTC', cand(-1), timeframes(-1, 86400), 86400), T0).includes('close below'), 'short below');
});

for (const dir of [1, -1]) {
  const side = dir === 1 ? 'long' : 'short';
  const geo = (resLow, supHigh) => ({
    '1h': { horizontalResistanceZones: resLow === null ? [] : [{ low: resLow, high: resLow + 20 }], horizontalSupportZones: supHigh === null ? [] : [{ low: supHigh - 20, high: supHigh }], confluenceZones: [] },
    '15m': { horizontalResistanceZones: [{ low: 87700, high: 87720 }], horizontalSupportZones: [{ low: 85080, high: 85100 }], confluenceZones: [] } // nearer than the 1h level but below the flag's tf
  });
  const c1 = cand(dir, { tgt: 86400 + dir * 1200 }); // TP1 = 86400 +/- 1200
  await test(`${side}: TP2 = nearest zone edge beyond TP1 on timeframes >= the flag's; lower-TF levels ignored`, () => {
    const beyond = dir === 1 ? 88000 : 84800; // beyond TP1 (87600 / 85200)
    const e = scoreFlag('BTC', c1, timeframes(dir, 86400), 86400, {}, geo(dir === 1 ? beyond : null, dir === -1 ? beyond : null));
    assert(e.levels.tp2 === beyond && e.levels.tp2Source === 'level', `${e.levels.tp2} ${e.levels.tp2Source}`);
  });
  await test(`${side}: TP2 picks confluence zone edge when nearer; ignores levels at or before TP1`, () => {
    const g = {
      '4h': { horizontalResistanceZones: [{ low: 90000, high: 90100 }], horizontalSupportZones: [{ low: 82000, high: 82100 }],
        confluenceZones: [{ low: dir === 1 ? 88500 : 83900, high: dir === 1 ? 88600 : 84000, components: ['a', 'b'], score: 2 }] },
      '1h': { horizontalResistanceZones: [{ low: 87600, high: 87700 }], horizontalSupportZones: [{ low: 85100, high: 85200 }], confluenceZones: [] }
    };
    const e = scoreFlag('BTC', c1, timeframes(dir, 86400), 86400, {}, g);
    const want = dir === 1 ? 88500 : 84000;
    assert(e.levels.tp2 === want && e.levels.tp2Source === 'level', `${e.levels.tp2}`);
  });
  await test(`${side}: no level beyond TP1 -> 1.5x fallback; no geometry -> 1.5x`, () => {
    const want = 86400 + dir * 1800;
    const a = scoreFlag('BTC', c1, timeframes(dir, 86400), 86400, {}, geo(null, null));
    const b = scoreFlag('BTC', c1, timeframes(dir, 86400), 86400);
    assert(a.levels.tp2 === want && a.levels.tp2Source === '1.5x', `${a.levels.tp2}`);
    assert(b.levels.tp2 === want && b.levels.tp2Source === '1.5x', 'no geometry');
    assert(tp2For(cand(dir, { tgt: null }), null).tp2 === null, 'no target -> null');
  });
  await test(`${side}: opportunity card has the call format fields, no percentages, <= 700 chars`, () => {
    for (const st of ['triggering', 'confirmed']) {
      const e = scoreFlag('BTC', cand(dir, { st }), timeframes(dir, 86400), 86400);
      const t = formatOpportunityCard(e, T0);
      assert(t.includes('LOCK OPPORTUNITY') && t.includes('GO IN') && t.includes(`flag ${st}`), 'head');
      for (const k of ['entry', 'confirm', 'invalidation', 'stop', 'TP1', 'TP2', 'R:R', 'no-chase cap', '2.4R', '86,400', fmtLvl(e.levels.tp2)]) assert(t.includes(k), `missing ${k} (${st})`);
      assert(st === 'confirmed' ? !t.includes('close above') && !t.includes('close below') : t.includes(`1h close ${dir === 1 ? 'above' : 'below'} 86,400`), 'confirm row');
      assert(t.includes('Tap 🔒 Lock to freeze these levels.'), 'prompt');
      assert(!t.includes('%'), 'no percentages');
      assert(t.length <= 700, `len ${t.length}`);
    }
  });
}

await test('board: entries, tags, cap of 3, empty state with pulse line', () => {
  const tfs = timeframes(1, 86400);
  const ranked = rankFlags({ BTC: ['a', 'b', 'c', 'd'].map((id, i) => cand(1, { id, st: i === 0 ? 'confirmed' : 'forming' })) }, { BTC: { price: 86400, timeframes: tfs } });
  const pulse = { found: 12, opps: 4, locked: 1 };
  const t = formatBoard(ranked, pulse, T0);
  assert(t.includes('FLAGS NOW') && t.includes('24h: 12 flags found · 4 lock opportunities · 1 locked'), 'title/pulse');
  assert(t.includes('🎯 LOCK') && t.includes('🔍 FOUND') && t.includes('TP1') && t.includes('TP2'), 'tags');
  assert((t.match(/BTC 1h/g) || []).length === 3, 'three entries');
  const empty = formatBoard([], { found: 0, opps: 0, locked: 0 }, T0);
  assert(empty.includes('No flags passing the checklist right now.') && empty.includes('24h: 0 flags found'), empty);
});

await test('flowKeyboard: lock:<8hex>, chart:SYM:TF, <= 64 bytes', () => {
  const e = scoreFlag('SOL', cand(1, { id: 'SOL:15m:long:' + 'x'.repeat(80), tf: '15m' }), timeframes(1, 100), 100);
  const row = flowKeyboard(e).inline_keyboard[0];
  assert(/^lock:[0-9a-f]{8}$/.test(row[0].callback_data) && row[0].text.includes('Lock'), row[0].callback_data);
  assert(row[1].callback_data === 'chart:SOL:15m', row[1].callback_data);
  assert(row.every((b) => Buffer.byteLength(b.callback_data) <= 64), 'bytes');
});

await test('pulseOf counts only the last 24h; pulseLine formats', () => {
  const h = (n) => iso(T0 - n * 3_600_000);
  const p = pulseOf({ found: { a: h(1), b: h(23), c: h(25) }, opps: { a: h(2), c: h(30) }, locked: [h(3), h(50)] }, T0);
  assert(p.found === 2 && p.opps === 1 && p.locked === 1, JSON.stringify(p));
  assert(p.since === h(24), 'since');
  assert(pulseLine(p) === '24h: 2 flags found · 1 lock opportunity · 1 locked', pulseLine(p));
  const z = pulseOf(undefined, T0);
  assert(z.found === 0 && z.opps === 0 && z.locked === 0, 'empty');
  assert(pulseOf({ locked: 2 }, T0).locked === 2, 'numeric locked');
});

await test('timing line + BREAKING: ENTER NOW with cap and window; 15m/1h/4h forming past trigger breaks, 5m or not-past does not; triggering past cap is missed', async () => {
  const { timingLine, breakingOf, formatBreakingCard, fmtWindow } = await import('./lib/flagFlow.js');
  const e = { symbol: 'BTC', tf: '1h', dir: 'long', st: 'forming', stage: 'found', price: 86450, levels: { entry: 86400, stop: 85900, target: 87600, cap: 86580 }, check: { rows: [] }, score: 6, of: 7 };
  assert(timingLine({ ...e, st: 'triggering' }) === '⏱ ENTER NOW · valid until price passes 86,580.00 · ~6 h window (6 × 1h candles)', timingLine(e));
  assert(timingLine({ ...e, tf: '5m', levels: { ...e.levels, cap: null } }).endsWith('~30 min window (6 × 5m candles)'), 'no cap, 5m');
  const T = Date.parse('2026-10-02T14:48:00Z');
  const b = breakingOf(e, T);
  assert(b && b.closeInMs === 12 * 60_000, JSON.stringify(b));
  assert(formatBreakingCard(e, T).includes('close in 12 min') && formatBreakingCard(e, T).includes('Not an entry yet'), 'card');
  assert(breakingOf({ ...e, tf: '5m' }, T) === null, '5m never breaks');
  assert(breakingOf({ ...e, price: 86390 }, T) === null, 'not past trigger');
  assert(breakingOf({ ...e, dir: 'short', price: 86350, levels: { ...e.levels, entry: 86400 } }, T) !== null, 'short mirror');
  assert(breakingOf({ ...e, stage: 'lockable', st: 'triggering' }, T) === null, 'already an opportunity');
  assert(fmtWindow(90 * 60_000) === '1 h 30 min' && fmtWindow(4 * 86_400_000) === '4 d', 'fmtWindow');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
