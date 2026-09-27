// Edge-search runner (research only). docs/EDGE_SEARCH_2026-09-27.md.
//   node scripts/research/edge/run.js --phase train                 # all configs, entries before HOLDOUT_START
//   node scripts/research/edge/run.js --phase holdout --ids a,b,c   # named configs only, entries from HOLDOUT_START
// Writes var/edge/<phase>.json (per-config stats + trades) and prints a markdown table.
import fs from 'node:fs';
import { loadBars, simulate, netR, stats, COSTS } from './lib.js';
import { makeCtx, buildConfigs, buildOrbConfigs, orbSignals } from './families.js';

export const HOLDOUT_START = Date.parse('2026-01-01T00:00:00Z');
const SYMBOLS = ['BTC', 'SOL', 'ETH'];

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const phase = args.phase || 'train';
if (phase === 'holdout' && !args.ids) throw new Error('holdout needs --ids (pre-declared finalists only)');
const idFilter = args.ids ? new Set(String(args.ids).split(',')) : null;
const extraConfigs = args.extra ? (await import(new URL(args.extra, `file://${process.cwd()}/`).href)).default : [];
const inWindow = (t) => (phase === 'train' ? t < HOLDOUT_START : t >= HOLDOUT_START);

const configs = [...buildConfigs(), ...extraConfigs].filter((c) => !idFilter || idFilter.has(c.id));
const orbConfigs = buildOrbConfigs().filter((c) => !idFilter || idFilter.has(c.id));
const results = new Map([...configs, ...orbConfigs].map((c) => [c.id, { id: c.id, family: c.family, trades: [] }]));

for (const sym of SYMBOLS) {
  const bars = { '5m': loadBars(sym, '5m'), '1h': loadBars(sym, '1h'), '4h': loadBars(sym, '4h'), '1d': loadBars(sym, '1d') };
  const ctx = makeCtx(bars);
  for (const cfg of configs) {
    const b = bars[cfg.tf];
    let busyUntil = -Infinity;
    for (let i = 1; i < b.n; i++) {
      const tEntry = b.ct[i];
      if (tEntry < busyUntil || !inWindow(tEntry)) continue;
      const spec = cfg.signal(ctx, i);
      if (!spec) continue;
      const tr = simulate(bars['5m'], { ...spec, entryTime: tEntry });
      if (!tr) continue;
      busyUntil = tr.exitTime;
      results.get(cfg.id).trades.push(finish(tr, sym, spec.dir));
    }
  }
  for (const cfg of orbConfigs) {
    for (const spec of orbSignals(ctx, cfg)) {
      if (!inWindow(spec.entryTime)) continue;
      const tr = simulate(bars['5m'], spec);
      if (tr) results.get(cfg.id).trades.push(finish(tr, sym, spec.dir));
    }
  }
  process.stderr.write(`${sym} done\n`);
}

function finish(tr, sym, dir) {
  return { ...tr, sym, dir, netR: netR(tr, dir, COSTS.base), netR_harsh: netR(tr, dir, COSTS.harsh), netR_light: netR(tr, dir, COSTS.light) };
}

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const rows = [];
for (const r of results.values()) {
  const tr = r.trades.sort((a, b) => a.entryTime - b.entryTime);
  const s = stats(tr);
  if (!s.n) { rows.push({ id: r.id, family: r.family, n: 0 }); continue; }
  const mid = Math.floor(tr.length / 2);
  const bySym = Object.fromEntries(SYMBOLS.map((k) => [k, stats(tr.filter((t) => t.sym === k)).mean]));
  const byDir = Object.fromEntries(['long', 'short'].map((k) => [k, stats(tr.filter((t) => t.dir === k))]));
  rows.push({
    id: r.id, family: r.family, ...s,
    harsh: stats(tr, 'netR_harsh').mean, light: stats(tr, 'netR_light').mean, gross: stats(tr, 'grossR').mean,
    h1: stats(tr.slice(0, mid)).mean, h2: stats(tr.slice(mid)).mean, bySym,
    long: { n: byDir.long.n, mean: byDir.long.mean }, short: { n: byDir.short.n, mean: byDir.short.mean }
  });
}
rows.sort((a, b) => (b.mean ?? -99) - (a.mean ?? -99));
fs.mkdirSync('var/edge', { recursive: true });
fs.writeFileSync(`var/edge/${phase}.json`, JSON.stringify({ phase, holdoutStart: new Date(HOLDOUT_START).toISOString(), rows, trades: Object.fromEntries([...results].map(([k, v]) => [k, v.trades])) }));

console.log(`\n${phase}: ${phase === 'train' ? 'entries before' : 'entries from'} ${new Date(HOLDOUT_START).toISOString().slice(0, 10)} · cost base long 0.20% / short 0.14% + 0.02%/h borrow\n`);
console.log('| config | n | win % | avg win | avg loss | gross R | **net R** | t | median | harsh | light | half 1 / 2 | BTC / SOL / ETH | long / short | risk % | hold h | max loss run |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (!r.n) { console.log(`| ${r.id} | 0 |`); continue; }
  console.log(`| ${r.id} | ${r.n} | ${f(100 * r.win, 1)} | ${f(r.avgWin)} | ${f(r.avgLoss)} | ${f(r.gross, 3)} | **${f(r.mean, 3)}** | ${f(r.t, 1)} | ${f(r.median)} | ${f(r.harsh, 3)} | ${f(r.light, 3)} | ${f(r.h1)} / ${f(r.h2)} | ${f(r.bySym.BTC)} / ${f(r.bySym.SOL)} / ${f(r.bySym.ETH)} | ${f(r.long.mean)} (${r.long.n}) / ${f(r.short.mean)} (${r.short.n}) | ${f(r.riskPct)} | ${f(r.hours, 0)} | ${r.maxLossRun} |`);
}
