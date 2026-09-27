// Re-score replay calls at alternative long costs (leverage-aware swap fee). Short cost fixed 0.14%.
// usage: node scripts/research/rescore-long-cost.js <calls.jsonl> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const [file, outDir] = process.argv.slice(2);
const name = path.basename(file, '.calls.jsonl');
const calls = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((c) => c.grossR !== null && c.grossR !== undefined && (c.outcome === 'win' || c.outcome === 'loss' || c.outcome === 'timeout'))
  .sort((a, b) => a.firstReadyAt.localeCompare(b.firstReadyAt));

const LONG_COSTS = { 'L034': 0.34, 'L020_3x': 0.20, 'L015_10x': 0.15 };
const SHORT_COST = 0.14;
const MIN_STOPS = [0, 0.1, 0.3, 0.5, 0.8, 1.0];
const costR = (c, pct) => (pct / 100) * c.entry / Math.abs(c.entry - c.stop);
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const f = (x, d = 3) => Number.isFinite(x) ? x.toFixed(d) : '-';

const t0 = Date.parse(calls[0]?.firstReadyAt), t1 = Date.parse(calls.at(-1)?.firstReadyAt);
const mid = (t0 + t1) / 2, days = Math.max(1, (t1 - t0) / 864e5);

console.log(`\n### ${name} (${calls.length} resolved, ${days.toFixed(1)} days)\n`);
console.log('| long cost | min stop % | n | /day | win % | avg net R | median net R | avg win R | avg loss R | BE win % | OOS 1st / 2nd | pass |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
fs.mkdirSync(outDir, { recursive: true });
for (const [label, lc] of Object.entries(LONG_COSTS)) {
  for (const ms of MIN_STOPS) {
    const sel = calls.filter((c) => c.stopDistancePct >= ms && c.entry !== c.stop);
    const net = sel.map((c) => c.grossR - costR(c, c.direction === 'long' ? lc : SHORT_COST));
    const wins = net.filter((x) => x > 0), losses = net.filter((x) => x <= 0).map((x) => -x);
    const aw = avg(wins), al = avg(losses);
    const h1 = avg(net.filter((_, i) => Date.parse(sel[i].firstReadyAt) < mid));
    const h2 = avg(net.filter((_, i) => Date.parse(sel[i].firstReadyAt) >= mid));
    const pass = sel.length >= 30 && h1 > 0 && h2 > 0;
    console.log(`| ${lc}% | ${ms || 'none'} | ${sel.length} | ${f(sel.length / days, 1)} | ${f(100 * wins.length / (sel.length || 1), 1)} | ${f(avg(net))} | ${f(med(net))} | ${f(aw, 2)} | ${f(al, 2)} | ${f(100 * al / (aw + al), 1)} | ${f(h1, 2)} / ${f(h2, 2)} | ${pass ? 'PASS' : 'fail'} |`);
    // Emit a sim-ready file: risk-sim reads netR_sens034 for longs, netR_sens014 for shorts.
    if (ms === 0.8) {
      const rows = sel.map((c, i) => JSON.stringify({ ...c, netR_sens034: c.direction === 'long' ? +net[i].toFixed(4) : c.netR_sens034, netR_sens014: c.direction === 'short' ? +net[i].toFixed(4) : c.netR_sens014 }));
      fs.writeFileSync(path.join(outDir, `${name}.${label}.min${ms}.calls.jsonl`), rows.join('\n') + '\n');
    }
  }
}
