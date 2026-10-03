/**
 * scripts/replay-flag-flow.js: no lookahead, rows in the called-flag-outcomes shape, strict vs loose runs.
 * Synthetic 1m series (seeded, trend + flag cycles); every other timeframe is bucketed from it.
 */
import { replaySymbol, completeHistory, scoreAlerts, summarizeRows } from './scripts/replay-flag-flow.js';
import { calibrateCalledFlags } from './scripts/tracker/called-flags.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const DAYS = 14;

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 1m candles: impulse legs with short low-volatility pullbacks, the shape the flag detector looks for. */
function synthetic1m(days, seed = 7) {
  const r = rng(seed);
  const out = [];
  let price = 1000;
  let dir = 1;
  let phase = 'impulse';
  let left = 40;
  for (let i = 0; i < days * 1440; i++) {
    const drift = phase === 'impulse' ? dir * 0.6 : -dir * 0.12;
    const vol = phase === 'impulse' ? 0.5 : 0.18;
    const open = price;
    const close = open + drift + (r() - 0.5) * 2 * vol;
    out.push({ timestamp: T0 + i * MIN, open, high: Math.max(open, close) + r() * vol, low: Math.min(open, close) - r() * vol, close, volume: 5 + r() * 10 + (phase === 'impulse' ? 8 : 0), closeTime: T0 + (i + 1) * MIN });
    price = close;
    if (--left <= 0) {
      if (phase === 'impulse') { phase = 'flag'; left = 8 + Math.floor(r() * 10); } else { phase = 'impulse'; left = 25 + Math.floor(r() * 30); if (r() < 0.3) dir = -dir; }
    }
  }
  return out;
}

const raw = synthetic1m(DAYS);
const START = T0 + 4 * DAY; // 4 days of warm-up before the first evaluated close
const END = T0 + DAYS * DAY;
const CUT = T0 + 9 * DAY;

function run(candles, { endMs }) {
  const sights = [];
  const res = replaySymbol({ symbol: 'BTC', hist: completeHistory({ '1m': candles }), startMs: START, endMs, onSight: (tf, dir, st, t, id, row) => sights.push(`${tf}|${dir}|${st}|${t}|${id}|${row.brk}|${row.tgt}`) });
  return { ...res, sights };
}

const full = run(raw, { endMs: END });

await test('the synthetic series produces candidates and alerts', () => {
  assert(full.sights.length > 50, `sightings ${full.sights.length}`);
  assert(full.alerts[1].length > 0, 'no loose alerts');
});

await test('no lookahead: corrupting every candle after the cut leaves everything up to the cut unchanged', () => {
  const r = rng(99);
  const corrupt = raw.map((c) => {
    if (c.timestamp < CUT) return c;
    const p = 500 + r() * 1500;
    return { ...c, open: p, high: p + 3, low: p - 3, close: p + (r() - 0.5) * 4, volume: 1 + r() * 100 };
  });
  const alt = run(corrupt, { endMs: END });
  const before = (list) => list.filter((s) => Number(s.split('|')[3]) <= CUT);
  assert(before(full.sights).length > 20, 'too few sightings before the cut to prove anything');
  assert(JSON.stringify(before(full.sights)) === JSON.stringify(before(alt.sights)), 'sightings before the cut differ');
  for (const k of [0, 1]) {
    const pre = (a) => a.filter((x) => Date.parse(x.sentAt) <= CUT);
    assert(k === 0 || pre(full.alerts[k]).length > 0, `run ${k}: no alerts before the cut`);
    assert(JSON.stringify(pre(full.alerts[k])) === JSON.stringify(pre(alt.alerts[k])), `run ${k}: alerts before the cut differ`);
  }
});

await test('no lookahead: ending the replay at the cut gives the same alerts as the full run up to the cut', () => {
  const head = run(raw.filter((c) => c.closeTime <= CUT), { endMs: CUT });
  const pre = (a) => a.filter((x) => Date.parse(x.sentAt) <= CUT);
  for (const k of [0, 1]) assert(JSON.stringify(pre(full.alerts[k])) === JSON.stringify(head.alerts[k]), `run ${k} differs`);
});

await test('strict run only alerts at >= 5/7 of the scored timeframes; the loose run alerts at lower scores too', () => {
  assert(full.alerts[0].every((a) => a.flow.score / a.flow.of >= 5 / 7 - 1e-9), 'strict alert below 5/7');
  assert(full.alerts[1].some((a) => a.flow.score / a.flow.of < 5 / 7), 'loose run has no sub-5/7 alert');
  for (const a of [...full.alerts[0], ...full.alerts[1]]) assert(Date.parse(a.sentAt) > START && Date.parse(a.sentAt) <= END, 'alert outside window');
});

await test('one alert per candidateId, and at most one per symbol+timeframe per 15 minutes', () => {
  for (const list of full.alerts) {
    const ids = list.map((a) => a.candidateId);
    assert(new Set(ids).size === ids.length, 'duplicate candidateId');
    const last = {};
    for (const a of list) {
      const k = `${a.symbol}|${a.timeframe}`;
      assert(last[k] === undefined || Date.parse(a.sentAt) - last[k] >= 15 * MIN, `cooldown broken ${k}`);
      last[k] = Date.parse(a.sentAt);
    }
  }
});

await test('rows come out in the called-flag-outcomes shape and calibrate', () => {
  const rows = scoreAlerts(full.alerts[1], raw, raw[raw.length - 1].closeTime);
  assert(rows.length === full.alerts[1].length, 'one row per alert');
  const keys = ['callId', 'calledAt', 'symbol', 'candidateId', 'timeframe', 'direction', 'entry', 'stop', 'tp1', 'flow', 'outcome', 'atr', 'anchor', 'entryOffsetAtr', 'resolvedAt', 'maxFavorableAtr', 'maxAdverseAtr', 'scoredAt'];
  for (const r of rows) {
    for (const k of keys) assert(k in r, `row missing ${k}`);
    assert(r.callId === `flag|${r.symbol}|${r.candidateId}`, 'callId');
    assert(['right', 'wrong', 'flat', 'open', 'no_data'].includes(r.outcome), `outcome ${r.outcome}`);
    assert(Number.isFinite(r.flow.score) && r.flow.of >= 1 && r.flow.of <= 7, 'flow score/of');
    assert(['agrees', 'mixed', 'disagrees', null].includes(r.flow.nextTf), 'flow.nextTf');
    const next = raw.find((c) => c.timestamp === Date.parse(r.calledAt));
    assert(next && Math.abs(r.anchor - next.open) < 1e-5, 'anchor = open of the 1m candle right after the alert close');
  }
  const cal = calibrateCalledFlags(rows, END, { target: 70, minN: 1, windowDays: 400 });
  assert(cal.buckets && cal.recommended && cal.scored === rows.filter((r) => r.outcome === 'right' || r.outcome === 'wrong').length, 'calibration did not read the rows');
  assert(summarizeRows(rows).overall.called === rows.length, 'summary count');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
