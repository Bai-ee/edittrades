/**
 * lib/trackStory.js: plain-language tracked-flag story (probe counting, watch/trade
 * story, failure zone, fail words). Includes a replay of the 2026-09-25 SOL failed
 * breakdown (MISS_004 candles) through updateProbes.
 */
import { readFileSync } from 'node:fs';
import { updateProbes, watchStory, tradeStory, storyText, failWords, failureZone, rBucket } from './lib/trackStory.js';

let passed = 0;
let failed = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const f = (v) => v.toFixed(2);

console.log('\ntrackStory');

await test('updateProbes: a close past the trigger that comes back counts one probe; extreme tracks the deepest close', () => {
  let m;
  for (const p of [121.0, 120.87, 120.85, 120.95, 120.88, 121.1]) m = updateProbes(m, { price: p, trigger: 120.89, direction: 'short' });
  assert(m.probes === 2 && m.extreme === 120.85 && m.beyond === false, JSON.stringify(m));
  const l = updateProbes(updateProbes(undefined, { price: 101, trigger: 100, direction: 'long' }), { price: 99, trigger: 100, direction: 'long' });
  assert(l.probes === 1 && l.extreme === 101, JSON.stringify(l));
  assert(updateProbes({ probes: 3 }, { price: null, trigger: 1 }).probes === 3, 'no price: unchanged');
});

await test('SOL 2026-09-25 replay: 1m closes 21:57–22:14Z vs trigger 120.89 closes alone catch 1 rejected probe; the other pokes were wicks (engine-side counting needed)', () => {
  const rows = JSON.parse(readFileSync('test/fixtures/episodes/SOL_2026-09-25_1m.json', 'utf8')).candles
    .filter((c) => c.timestamp >= Date.parse('2026-09-25T21:57:00Z') && c.timestamp <= Date.parse('2026-09-25T22:14:00Z'));
  assert(rows.length >= 15, `rows ${rows.length}`);
  let m;
  for (const c of rows) m = updateProbes(m, { price: c.close, trigger: 120.89, direction: 'short' });
  const lowest = Math.min(...rows.map((c) => c.low));
  console.log(`      closes=${rows.length} probes=${m.probes} deepestClose=${m.extreme} lowestWick=${lowest}`);
  assert(m.probes >= 1 && lowest < 120.89 && rows.at(-1).close > 120.89, 'probed, wicked under, ended back above');
});

await test('watchStory (short, forming, 2 probes, counter-trend): now / wait / line / next in plain words', () => {
  const st = watchStory({
    tf: '3m', direction: 'short', state: 'forming', trigger: 120.89, voidLevel: 121.18, price: 121.02, probes: 2, extreme: 120.85, etaMin: 2,
    path: { w: { retest_go: 17, runner: 11, false_break: 4, fail_first: 34, chop: 34 } },
    geometryContext: { '15m': { confluenceZones: [{ low: 121.1769, high: 121.45 }], horizontalSupportZones: [{ low: 120.2, high: 120.3 }] } },
    rec: { opposes: ['ct:4h', 'room:blocked-15m'] }, fmt: f
  });
  const txt = storyText(st).join('\n');
  assert(st.now.includes('dipped under 120.89 2×') && st.now.includes('buyers are defending it') && st.now.includes('against the 4h trend'), st.now);
  assert(st.wait.includes('3m candle to CLOSE below 120.89') && st.wait.includes('past 120.85') && st.wait.includes('~2 min') && st.wait.includes("wick through doesn't count"), st.wait);
  assert(st.line === 'A close above 121.18 kills the short idea. If that happens, walk away.', st.line);
  assert(st.next.includes('fails before it ever breaks (34%') && st.next.includes('121.18–121.45 (15m confluence)'), st.next);
  assert(txt.startsWith('📍 ') && txt.includes('\n⏳ ') && txt.includes('\n🚫 ') && txt.includes('\n🔮 '), txt);
  assert(!/acceptance_|invalidation_close|ct:4h/.test(txt), 'no engine codes leak');
});

await test('watchStory: triggering / confirmed wording; long mirror', () => {
  assert(watchStory({ tf: '5m', direction: 'long', state: 'triggering', trigger: 100, price: 100.5, probes: 0, fmt: f }).wait.includes("hold above it. Don't chase"), 'triggering');
  assert(watchStory({ tf: '5m', direction: 'long', state: 'confirmed', trigger: 100, price: 100.5, probes: 0, fmt: f }).wait.startsWith('Break confirmed'), 'confirmed');
  const l = watchStory({ tf: '5m', direction: 'long', state: 'forming', trigger: 100, voidLevel: 98, price: 99.5, probes: 1, fmt: f });
  assert(l.now.includes('poked above 100.00 1×') && l.now.includes('sellers') && l.line.includes('close below 98.00 kills the long'), JSON.stringify(l));
});

await test('failureZone: nearest zone beyond price in the failure direction; null when none', () => {
  const g = { '15m': { confluenceZones: [{ low: 122, high: 122.3 }], horizontalResistanceZones: [{ low: 121.3, high: 121.4 }], horizontalSupportZones: [{ low: 119, high: 119.2 }] } };
  assert(failureZone(g, 'short', 121).low === 121.3, 'short fails upward');
  assert(failureZone(g, 'long', 121).high === 119.2, 'long fails downward');
  assert(failureZone(g, 'short', 130) === null && failureZone(null, 'short', 1) === null, 'none');
});

await test('tradeStory + failWords + rBucket', () => {
  const t = tradeStory({ direction: 'short', entry: 120.8, stop: 121.2, tp1: 119.6, price: 119.9, r: 2.25, fmt: f });
  assert(t.now.includes('+2.25R') && t.wait.includes('Close to TP1') && t.line.includes('Price above it'), JSON.stringify(t));
  assert(tradeStory({ direction: 'long', entry: 1, stop: 0.9, tp1: 1.3, price: 0.93, r: -0.7, fmt: f }).wait.includes("Don't widen"), 'near stop');
  assert(failWords('acceptance_above', 'short').startsWith('Buyers pushed price back above'), 'acceptance_above');
  assert(failWords('stale').includes('went stale') && failWords('???') === 'The flag failed.', 'others');
  assert(rBucket(0.74) === 0.5 && rBucket(-0.2) === -0.5 && rBucket(null) === null, 'buckets');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
