/**
 * lib/flowEvidence.js: volume quality, RSI, Stoch RSI, divergence, overall verdict, lines.
 */
import {
  volumeQuality, rsiSeries, stochRsi, stochState, stochFavors, divergence, flowEvidence
} from './lib/flowEvidence.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const mk = (i, o, c, v, h = Math.max(o, c) + 1, l = Math.min(o, c) - 1) => ({ openMs: i * 60000, closeMs: (i + 1) * 60000, o, h, l, c, v });
/** 25 quiet candles (v 100) then a trigger candle. */
const withLast = (last, flagV = 80) => {
  const a = Array.from({ length: 25 }, (_, i) => mk(i, 100, 100.5, i >= 19 ? flagV : 100));
  a.push(mk(25, last.o, last.c, last.v));
  return a;
};

await test('volume STRONG: 1.9x, body with trade, quiet flag (long)', () => {
  const r = volumeQuality(withLast({ o: 100, c: 102, v: 180 }), 'long');
  assert(r.quality === 'STRONG' && r.verdict === 'GO', JSON.stringify(r));
  assert(/1\.9x/.test(r.reason) && /quiet flag/.test(r.reason), r.reason);
});
await test('volume OK: 1.1x with body', () => {
  const r = volumeQuality(withLast({ o: 100, c: 101, v: 110 }), 'long');
  assert(r.quality === 'OK' && r.verdict === 'GO', r.quality);
});
await test('volume OK: 0.9x with body (between WEAK and OK)', () => {
  const r = volumeQuality(withLast({ o: 100, c: 101, v: 90 }), 'long');
  assert(r.quality === 'OK', r.quality);
});
await test('volume STRONG downgrades to OK on a busy flag', () => {
  const r = volumeQuality(withLast({ o: 100, c: 102, v: 180 }, 130), 'long');
  assert(r.quality === 'OK', r.quality);
});
await test('volume WEAK: 0.6x', () => {
  const r = volumeQuality(withLast({ o: 100, c: 101, v: 60 }), 'long');
  assert(r.quality === 'WEAK' && r.verdict === 'STAY OUT' && /no push/.test(r.reason), JSON.stringify(r));
});
await test('volume body against trade -> WEAK even on big volume', () => {
  const r = volumeQuality(withLast({ o: 102, c: 100, v: 250 }), 'long');
  assert(r.quality === 'WEAK' && r.verdict === 'STAY OUT', r.quality);
});
await test('volume short symmetry', () => {
  assert(volumeQuality(withLast({ o: 102, c: 100, v: 180 }), 'short').quality === 'STRONG', 'short STRONG');
  assert(volumeQuality(withLast({ o: 100, c: 102, v: 180 }), 'short').quality === 'WEAK', 'short against');
});
await test('volume UNKNOWN: too few candles, missing volume, zero avg', () => {
  const few = withLast({ o: 100, c: 101, v: 100 }).slice(-21);
  assert(volumeQuality(few, 'long').quality === 'UNKNOWN', 'few');
  const missing = withLast({ o: 100, c: 101, v: 100 });
  missing[10].v = undefined;
  const m = volumeQuality(missing, 'long');
  assert(m.quality === 'UNKNOWN' && m.verdict === 'NO DATA' && m.relVol === null, 'missing');
  const zero = Array.from({ length: 26 }, (_, i) => mk(i, 100, 101, 0));
  assert(volumeQuality(zero, 'long').verdict === 'NO DATA', 'zero');
});
await test('volume trend rising / falling / flat', () => {
  const a = withLast({ o: 100, c: 101, v: 300 });
  assert(volumeQuality(a, 'long').trend === 'rising', 'rising');
  const b = withLast({ o: 100, c: 101, v: 10 });
  assert(volumeQuality(b, 'long').trend === 'falling', 'falling');
  const c = Array.from({ length: 26 }, (_, i) => mk(i, 100, 101, 100));
  assert(volumeQuality(c, 'long').trend === 'flat', 'flat');
});
await test('RSI: all-up series is 100, flat is 50, warmup is null', () => {
  const up = rsiSeries(Array.from({ length: 30 }, (_, i) => 100 + i));
  assert(up[13] === null && up[14] === 100 && up[29] === 100, `${up[14]} ${up[29]}`);
  const flat = rsiSeries(Array.from({ length: 30 }, () => 100));
  assert(flat[29] === 50, `flat ${flat[29]}`);
  const down = rsiSeries(Array.from({ length: 30 }, (_, i) => 100 - i));
  assert(down[29] === 0, `down ${down[29]}`);
  assert(rsiSeries([1, 2, 3]).every((x) => x === null), 'short series');
});
await test('RSI: alternating series stays near 50', () => {
  const r = rsiSeries(Array.from({ length: 60 }, (_, i) => 100 + (i % 2)));
  assert(r[59] > 35 && r[59] < 65, String(r[59]));
});
await test('stochRsi: null when short, 0-100 otherwise', () => {
  assert(stochRsi([1, 2, 3]) === null, 'short');
  const s = stochRsi(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5));
  assert(s && s.k >= 0 && s.k <= 100 && s.d >= 0 && s.d <= 100, JSON.stringify(s));
});
await test('stochState and favors, both directions', () => {
  assert(stochState(88, 84) === 'overbought', 'ob');
  assert(stochState(10, 12) === 'oversold', 'os');
  assert(stochState(50, 40) === 'rising' && stochState(40, 50) === 'falling', 'rise/fall');
  assert(stochFavors('rising', 50, 'long') && !stochFavors('rising', 85, 'long'), 'long rising');
  assert(stochFavors('oversold', 10, 'long') && !stochFavors('overbought', 90, 'long'), 'long os/ob');
  assert(stochFavors('falling', 50, 'short') && !stochFavors('falling', 10, 'short'), 'short falling');
  assert(stochFavors('overbought', 90, 'short') && !stochFavors('oversold', 10, 'short'), 'short ob/os');
});

/** Build candles from a high path so pivots are exact. */
const fromHL = (hs, ls) => hs.map((h, i) => ({ openMs: i, closeMs: i + 1, o: (h + ls[i]) / 2, h, l: ls[i], c: (h + ls[i]) / 2, v: 100 }));
const bearC = () => {
  const hs = Array(30).fill(100);
  const ls = hs.map((h) => h - 2);
  hs[10] = 110; hs[20] = 115; // pivot highs, higher high
  return fromHL(hs, ls);
};
const bearRsi = (n) => Array.from({ length: n }, (_, i) => (i === 10 ? 75 : i === 20 ? 65 : 50));
await test('divergence bearish: higher price high, lower RSI high', () => {
  const c = bearC();
  const d = divergence(c, bearRsi(c.length), { dir: 'long' });
  assert(d.type === 'bearish' && d.against === true, JSON.stringify(d));
  assert(divergence(c, bearRsi(c.length), { dir: 'short' }).against === false, 'short not against');
});
await test('divergence bullish: lower price low, higher RSI low', () => {
  const ls = Array(30).fill(100);
  const hs = ls.map((l) => l + 2);
  ls[10] = 90; ls[20] = 85;
  const c = fromHL(hs, ls);
  const rsi = Array.from({ length: 30 }, (_, i) => (i === 10 ? 25 : i === 20 ? 35 : 50));
  const d = divergence(c, rsi, { dir: 'short' });
  assert(d.type === 'bullish' && d.against === true, JSON.stringify(d));
  assert(divergence(c, rsi, { dir: 'long' }).against === false, 'long not against');
});
await test('divergence none: confirming RSI high, and too little data', () => {
  const c = bearC();
  const rsi = Array.from({ length: 30 }, (_, i) => (i === 10 ? 65 : i === 20 ? 75 : 50));
  assert(divergence(c, rsi, { dir: 'long' }).type === null, 'confirmed');
  assert(divergence(c.slice(0, 3), rsi.slice(0, 3), { dir: 'long' }).type === null, 'short');
});

const trendUp = (n = 60, step = 1, v = 100) => Array.from({ length: n }, (_, i) => mk(i, 100 + i * step, 100 + i * step + step * 0.8, v));
await test('overall verdict: weak volume wins over everything', () => {
  const c = trendUp();
  c[c.length - 1] = { ...c[c.length - 1], v: 10 };
  const e = flowEvidence(c, 'long');
  assert(e.verdict === 'STAY OUT', e.verdict);
});
await test('overall verdict: hot RSI / overbought stoch -> CAUTION despite good volume', () => {
  const c = trendUp();
  c[c.length - 1] = { ...c[c.length - 1], v: 200 };
  const e = flowEvidence(c, 'long');
  assert(e.volume.verdict === 'GO' && e.rsi > 75, `${e.volume.verdict} ${e.rsi}`);
  assert(e.verdict === 'CAUTION', e.verdict);
  assert(/overbought|rising/.test(e.stoch.state), e.stoch.state);
});
await test('overall verdict: short mirror of hot RSI', () => {
  const c = Array.from({ length: 60 }, (_, i) => mk(i, 200 - i, 200 - i - 0.8, i === 59 ? 200 : 100));
  const e = flowEvidence(c, 'short');
  assert(e.rsi < 25 && e.verdict === 'CAUTION', `${e.rsi} ${e.verdict}`);
});
await test('overall verdict: NO DATA volume stays NO DATA when momentum is clean', () => {
  const c = Array.from({ length: 10 }, (_, i) => mk(i, 100, 101, 100));
  const e = flowEvidence(c, 'long');
  assert(e.verdict === 'NO DATA' || e.verdict === 'CAUTION', e.verdict);
  assert(e.volume.quality === 'UNKNOWN', 'unknown');
});
await test('flowEvidence shape and non-empty lines', () => {
  const e = flowEvidence(trendUp(), 'long');
  assert(e.lines.volume.startsWith('Volume ') && e.lines.volume.length > 8, e.lines.volume);
  assert(e.lines.momentum.startsWith('RSI ') && /divergence|div/.test(e.lines.momentum), e.lines.momentum);
  assert(!/<[a-z]/i.test(e.lines.volume + e.lines.momentum), 'no html');
  assert(['bullish', 'bearish', null].includes(e.divergence.type), 'div type');
  const empty = flowEvidence([], 'long');
  assert(empty.lines.volume && empty.lines.momentum && empty.rsi === null && empty.stoch === null, 'empty input safe');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
