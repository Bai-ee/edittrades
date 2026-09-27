#!/usr/bin/env node
/**
 * WP5 item 4 (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md): average annualized funding
 * for BTC/ETH/SOL longs by calendar year, spot-vs-perp context for Card 6. Reads Hyperliquid
 * hourly funding (fetch-venue.js; full history available here, 2023-05 -> now) and OKX (fetch-
 * venue.js; ~3-month depth on this host, reported as a recent snapshot only, not "by year").
 *
 * A positive rate = longs pay shorts (the case reported here, "cost for a long"). Annualized =
 * mean hourly rate x 24 x 365, in percent.
 *
 * Command: node scripts/research/edge/funding-by-year.js
 * Output:  var/research/funding-by-year/{REPORT.md,rows.json}
 */
import fs from 'node:fs';
import path from 'node:path';

const SYMBOLS = ['BTC', 'ETH', 'SOL'];
const FUNDING_DIR = 'var/edge/venues/funding';

function byYear(events) {
  const buckets = new Map();
  for (const e of events) {
    const y = new Date(e.time).getUTCFullYear();
    if (!buckets.has(y)) buckets.set(y, []);
    buckets.get(y).push(e.rate);
  }
  const out = {};
  for (const [y, rates] of buckets) {
    const mean = rates.reduce((s, x) => s + x, 0) / rates.length;
    out[y] = { n: rates.length, meanHourlyPct: mean * 100, annualizedPct: mean * 24 * 365 * 100 };
  }
  return out;
}

function main() {
  const outDir = 'var/research/funding-by-year';
  fs.mkdirSync(outDir, { recursive: true });
  const rows = { hyperliquid: {}, okx: {} };
  for (const sym of SYMBOLS) {
    const hlFile = path.join(FUNDING_DIR, `hyperliquid_${sym}.json`);
    if (fs.existsSync(hlFile)) rows.hyperliquid[sym] = byYear(JSON.parse(fs.readFileSync(hlFile, 'utf8')).events);
    const okxFile = path.join(FUNDING_DIR, `okx_${sym}.json`);
    if (fs.existsSync(okxFile)) rows.okx[sym] = byYear(JSON.parse(fs.readFileSync(okxFile, 'utf8')).events);
  }

  const years = [...new Set(Object.values(rows.hyperliquid).flatMap((y) => Object.keys(y)))].sort();
  const out = [];
  out.push('## Average annualized funding for BTC/ETH/SOL longs, by year (Hyperliquid, hourly)\n');
  out.push('Positive = longs pay shorts (a carry cost for a long). Annualized = mean hourly rate x 24 x 365. 2023 and 2026 are partial years (data starts 2023-05-12; captured through 2026-09-27).\n');
  out.push('| year | BTC n | BTC annualized | ETH n | ETH annualized | SOL n | SOL annualized |');
  out.push('|---|---|---|---|---|---|---|');
  for (const y of years) {
    const b = rows.hyperliquid.BTC?.[y], e = rows.hyperliquid.ETH?.[y], s = rows.hyperliquid.SOL?.[y];
    out.push(`| ${y}${(y === '2023' || y === '2026') ? ' (partial)' : ''} | ${b?.n ?? '—'} | ${b ? b.annualizedPct.toFixed(2) + '%' : '—'} | ${e?.n ?? '—'} | ${e ? e.annualizedPct.toFixed(2) + '%' : '—'} | ${s?.n ?? '—'} | ${s ? s.annualizedPct.toFixed(2) + '%' : '—'} |`);
  }
  out.push('');
  out.push('## OKX, recent snapshot only (~3-month depth on this host, not a full year)\n');
  out.push('| symbol | n | window | annualized (extrapolated from the ~3-month sample) |');
  out.push('|---|---|---|---|');
  for (const sym of SYMBOLS) {
    const y2026 = rows.okx[sym]?.['2026'];
    if (y2026) out.push(`| ${sym} | ${y2026.n} | 2026-06-22 -> 2026-09-27 | ${y2026.annualizedPct.toFixed(2)}% |`);
  }
  out.push('');
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), `${out.join('\n')}\n`);
  fs.writeFileSync(path.join(outDir, 'rows.json'), JSON.stringify(rows, null, 1));
  console.log(out.join('\n'));
  console.log(`\n[funding-by-year] wrote ${outDir}/{REPORT.md,rows.json}`);
}

main();
export default { byYear };
