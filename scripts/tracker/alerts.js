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
 * Chart: with SCALP_CONTEXT_API_KEY set, each alert fetches the engine's confirmation
 * chart (`?chart=SYMBOL:TF`, the plan's timeframe) at alert time, saves it to
 * alerts/<file>.png (committed by the workflow; the repo is public) and embeds it in the
 * issue by its raw.githubusercontent.com URL, so the email shows it. Any chart failure
 * leaves the alert without an image; it never blocks the alert.
 *
 * Usage: node alerts.js [--data ./data] [--file alerts-new.json] [--mention <github user>]
 *                       [--page <tracker url>] [--now <iso>] [--charts alerts] [--no-charts]
 *                       [--test]   add one test alert (BTC 5m chart, not recorded) to check the email path
 */

import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl, appendJsonl, readAllCalls, ensureDir } from './store.js';
import { DEFAULT_URL } from './collect.js';

export const ALERT_MAX_AGE_MIN = 90;
export const PAGE_URL = 'https://edittrades-tracker.vercel.app';
export const CHART_TIMEFRAMES = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const CHART_MAX_BYTES = 200 * 1024;

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

export function formatAlert({ key, row }, { mention = null, page = PAGE_URL, chartUrl = null } = {}) {
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
  if (chartUrl) lines.push(`![${row.symbol} ${tf} chart at alert time](${chartUrl})`, '', `_Chart at alert time: candles, EMA21/200, zones, flag breakout and invalidation._`, '');
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

/** Timeframe to chart: the plan's, else the candidate's, else 5m. */
export function chartTimeframe(row) {
  const rec = row.flagRecommendation || {};
  const tf = (row.flagTradePlan && row.flagTradePlan.timeframe) || (rec.candidate && rec.candidate.timeframe);
  return CHART_TIMEFRAMES.includes(tf) ? tf : '5m';
}

/**
 * Fetch one confirmation chart PNG and save it under chartsDir. Returns the file name,
 * or null on any failure (bad status, not a PNG, too large, network).
 */
export async function saveChart({ symbol, timeframe, nowMs, chartsDir, url = DEFAULT_URL, key, fetchImpl = fetch }) {
  if (!key) return null;
  try {
    const res = await fetchImpl(`${url}?chart=${encodeURIComponent(`${symbol}:${timeframe}`)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'image/png', 'X-EditTrades-Client': 'tracker' },
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 || buf.length > CHART_MAX_BYTES || !buf.subarray(0, 4).equals(PNG_MAGIC)) return null;
    const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').slice(0, 13);
    const file = `${stamp}Z-${symbol}-${timeframe}-${createHash('sha1').update(buf).digest('hex').slice(0, 8)}.png`;
    ensureDir(chartsDir);
    writeFileSync(path.join(chartsDir, file), buf);
    return file;
  } catch {
    return null;
  }
}

export async function runAlerts(dataDir, { nowMs = Date.now(), mention = null, page = PAGE_URL, chart = null } = {}) {
  const alerted = readJsonl(alertsFile(dataDir)).map((a) => a.key);
  const fresh = findNewGood(readAllCalls(dataDir), alerted, nowMs);
  const alerts = [];
  for (const f of fresh) {
    let chartUrl = null;
    if (chart) {
      const file = await saveChart({ ...chart, symbol: f.row.symbol, timeframe: chartTimeframe(f.row), nowMs });
      if (file) chartUrl = `${chart.rawBase}/${file}`;
    }
    alerts.push({ ...formatAlert(f, { mention, page, chartUrl }), chartUrl });
  }
  if (fresh.length) {
    appendJsonl(alertsFile(dataDir), fresh.map(({ key, row }) => ({
      key, alertedAt: new Date(nowMs).toISOString(), symbol: row.symbol, capturedAt: row.capturedAt, source: row.source || 'cron'
    })));
  }
  return alerts;
}

async function main() {
  const opts = parseArgs();
  const nowMs = typeof opts.now === 'string' ? Date.parse(opts.now) : Date.now();
  const mention = typeof opts.mention === 'string' ? opts.mention : (process.env.GITHUB_REPOSITORY_OWNER || null);
  const repo = process.env.GITHUB_REPOSITORY || 'Bai-ee/edittrades-tracker';
  const chartsRel = typeof opts.charts === 'string' ? opts.charts : 'alerts';
  const chart = opts['no-charts'] ? null : {
    chartsDir: chartsRel,
    rawBase: `https://raw.githubusercontent.com/${repo}/main/${chartsRel.replace(/^\.\/?/, '')}`,
    url: typeof opts.url === 'string' ? opts.url : DEFAULT_URL,
    key: process.env.SCALP_CONTEXT_API_KEY || null
  };
  const alerts = await runAlerts(opts.data, { nowMs, mention, page: typeof opts.page === 'string' ? opts.page : PAGE_URL, chart });
  if (opts.test) {
    const file = chart ? await saveChart({ ...chart, symbol: 'BTC', timeframe: '5m', nowMs }) : null;
    const chartUrl = file ? `${chart.rawBase}/${file}` : null;
    alerts.push({
      key: 'test', chartUrl, title: 'Test alert · GOOD-call email check',
      body: ['Test of the GOOD-call email path, opened by the tracker bot. Real alerts carry the plan levels. Safe to close.', '',
        ...(chartUrl ? [`![BTC 5m chart at test time](${chartUrl})`, ''] : ['_(chart unavailable)_', '']),
        ...(mention ? [`cc @${mention}`] : [])].join('\n')
    });
  }
  const out = typeof opts.file === 'string' ? opts.file : 'alerts-new.json';
  writeFileSync(out, JSON.stringify(alerts));
  console.log(`[tracker:alerts] ${alerts.length} new GOOD call(s), ${alerts.filter((a) => a.chartUrl).length} with chart -> ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[tracker:alerts] ${err.message}`);
    process.exit(1);
  });
}
