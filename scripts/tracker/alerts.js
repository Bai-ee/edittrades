#!/usr/bin/env node
/**
 * EditTrades call tracker - GOOD-call alerts.
 *
 * After collect, finds GOOD recommendation calls captured in the last ALERT_MAX_AGE_MIN
 * minutes (cron or served) that have not been alerted yet, appends them to
 * data/alerts.jsonl (one line per alert, keyed by symbol + candidate) and writes the new
 * ones to --file as JSON [{key, title, body}]. The track workflow opens one GitHub issue
 * per alert; the issue @-mentions the repo owner, so GitHub emails them. No mail
 * service, no extra secret.
 *
 * The age guard stops a first run (or a restored history) from alerting on old calls.
 *
 * Usage: node alerts.js [--data ./data] [--file alerts-new.json] [--mention <github user>]
 *                       [--page <tracker url>] [--now <iso>]
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl, appendJsonl, readAllCalls } from './store.js';

export const ALERT_MAX_AGE_MIN = 90;
export const PAGE_URL = 'https://edittrades-tracker.vercel.app';

export const alertsFile = (dataDir) => path.join(dataDir, 'alerts.jsonl');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v) => (isNum(v) ? String(Math.round(v * 10000) / 10000) : '–');

/** One alert per symbol + candidate (falls back to the close when no candidate id). */
export function alertKey(row) {
  const rec = row.flagRecommendation || {};
  const plan = row.flagTradePlan || {};
  const id = rec.candidateId || plan.candidateId || (rec.candidate && rec.candidate.candidateId) || row.closedThrough;
  return `${row.symbol}|${id}`;
}

/** New GOOD rows (oldest first), at most one per key. */
export function findNewGood(rows, alertedKeys, nowMs) {
  const since = nowMs - ALERT_MAX_AGE_MIN * 60_000;
  const seen = new Set(alertedKeys);
  const out = [];
  const sorted = [...rows].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  for (const row of sorted) {
    if (!row || !row.flagRecommendation || row.flagRecommendation.class !== 'GOOD') continue;
    const t = Date.parse(row.capturedAt);
    if (!Number.isFinite(t) || t < since || t > nowMs + 60_000) continue;
    const key = alertKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, row });
  }
  return out;
}

export function formatAlert({ key, row }, { mention = null, page = PAGE_URL } = {}) {
  const rec = row.flagRecommendation || {};
  const plan = row.flagTradePlan || {};
  const cand = rec.candidate || {};
  const dir = (plan.direction || cand.direction || '').toUpperCase() || '–';
  const tf = plan.timeframe || cand.timeframe || '–';
  const via = row.source === 'served' ? 'chat' : 'tracker';
  const title = `GOOD call · ${row.symbol} ${dir} ${tf} · entry ${fmt(plan.entry)} · stop ${fmt(plan.stop)} · TP1 ${fmt(plan.tp1)}`;
  const reason = rec.primaryReason && (rec.primaryReason.text || rec.primaryReason.code);
  const lines = [
    `**${row.symbol} ${dir} · ${tf}** · engine class **GOOD** · plan **${plan.status || '–'}**`,
    '',
    '| Entry | Stop | TP1 | TP2 | Gross R:R | Net R:R |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${fmt(plan.entry)} | ${fmt(plan.stop)} | ${fmt(plan.tp1)} | ${fmt(plan.tp2)} | ${fmt(plan.grossRR)} | ${fmt(plan.netRR)} |`,
    ''
  ];
  if (plan.entryCondition) lines.push(`Entry condition: ${plan.entryCondition}`, '');
  if (reason) lines.push(`Why: ${reason}`, '');
  lines.push(
    `Price ${fmt(row.price)} · closed through ${row.closedThrough || '–'} · seen via ${via} at ${row.capturedAt}`,
    '',
    `Check it in the GPT (\`signals\`) before acting: levels move with each close. Tracker: ${page}`,
    '',
    '_Provisional; not evidence of an edge. Not financial advice. The engine never executes trades._'
  );
  if (mention) lines.push('', `cc @${mention}`);
  lines.push('', `<!-- alert-key: ${key} -->`);
  return { key, title, body: lines.join('\n') };
}

export function runAlerts(dataDir, { nowMs = Date.now(), mention = null, page = PAGE_URL } = {}) {
  const alerted = readJsonl(alertsFile(dataDir)).map((a) => a.key);
  const fresh = findNewGood(readAllCalls(dataDir), alerted, nowMs);
  const alerts = fresh.map((f) => formatAlert(f, { mention, page }));
  if (fresh.length) {
    appendJsonl(alertsFile(dataDir), fresh.map(({ key, row }) => ({
      key, alertedAt: new Date(nowMs).toISOString(), symbol: row.symbol, capturedAt: row.capturedAt, source: row.source || 'cron'
    })));
  }
  return alerts;
}

function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const mention = typeof opts.mention === 'string' ? opts.mention : (process.env.GITHUB_REPOSITORY_OWNER || null);
  const alerts = runAlerts(opts.data, { nowMs, mention, page: typeof opts.page === 'string' ? opts.page : PAGE_URL });
  const out = typeof opts.file === 'string' ? opts.file : 'alerts-new.json';
  writeFileSync(out, JSON.stringify(alerts));
  console.log(`[tracker:alerts] ${alerts.length} new GOOD call(s) -> ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (err) {
    console.error(`[tracker:alerts] ${err.message}`);
    process.exit(1);
  }
}
