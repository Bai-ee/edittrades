// R4 applied: generates the two trades.jsonl inputs the WP3 brief asks risk-sim.js --shuffle to
// run on - SMA200 spot trades (via runSma4h) and the re-flag-retest-1h swing rule's per-signal
// net R - then leaves the actual shuffle run to risk-sim.js's CLI (see WP3_STATS.md "commands").
// Research only.
//
//   node scripts/research/harness/r4-apply.js [--out var/research/wp3]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from '../edge/lib.js';
import { runSma4h } from '../edge/sma4h-trend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const outDir = path.join(REPO_ROOT, args.out || 'var/research/wp3');
mkdirSync(outDir, { recursive: true });

// --- SMA200 trades (pct units - trade.ret is the compounded per-trade equity return) ---
for (const symbol of ['BTC', 'ETH', 'SOL']) {
  const bars = loadBars(symbol, '4h', path.join(REPO_ROOT, 'var/edge/4h-long'));
  const r = runSma4h(bars, { n: 200, costPerSide: 0.0015 });
  const closed = r.trades.filter((t) => !t.open); // drop the still-open trade at the end of history
  const lines = closed.map((t) => JSON.stringify({ ret: t.ret, entryTime: t.entryTime, exitTime: t.exitTime }));
  const outPath = path.join(outDir, `sma200-${symbol}-trades.jsonl`);
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`Wrote ${path.relative(REPO_ROOT, outPath)} (${closed.length} closed trades)`);
}

// --- re-flag-retest-1h signals' net R (R units - `netSens` is the study's own net-of-sensitivity-
// cost R field per docs/swing/re-flag-retest-1h.json's per-signal records) ---
const study = JSON.parse(readFileSync(path.join(REPO_ROOT, 'docs/swing/re-flag-retest-1h.json'), 'utf8'));
const netRLines = [];
for (const symbol of Object.keys(study.perSymbol)) {
  for (const sig of study.perSymbol[symbol].signals) {
    if (typeof sig.netSens === 'number' && Number.isFinite(sig.netSens)) {
      netRLines.push(JSON.stringify({ netR: sig.netSens, symbol, closedThrough: sig.closedThrough, direction: sig.direction }));
    }
  }
}
// Signals are combined across symbols in the STUDY's own chronological "combined" reporting
// convention (docs/swing/re-flag-retest-1h.json's `combined` block does the same); sort by
// closedThrough so the "historical" (unshuffled) path in risk-sim.js reflects a real chronology.
netRLines.sort((a, b) => (JSON.parse(a).closedThrough < JSON.parse(b).closedThrough ? -1 : 1));
const flagOutPath = path.join(outDir, 're-flag-retest-1h-netR.jsonl');
writeFileSync(flagOutPath, netRLines.join('\n') + '\n');
console.log(`Wrote ${path.relative(REPO_ROOT, flagOutPath)} (${netRLines.length} signals, all symbols combined)`);
