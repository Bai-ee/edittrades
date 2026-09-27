#!/usr/bin/env node
/**
 * EditTrades call tracker - GOOD-call alerts.
 *
 * After collect, finds GOOD recommendation calls captured in the last ALERT_MAX_AGE_MIN
 * minutes (cron or served) that have not been alerted yet, appends them to
 * data/alerts.jsonl (one line per alert, keyed by symbol + candidate) and writes the new
 * ones to --file as JSON [{key, title, body}]; live spot-trend flips (data/spot-trend/flips.jsonl,
 * docs/PLAN_SPOT_TREND_2026-09-27.md P2) join the same list with a plain-text `telegram` field.
 * The track workflow sends the spot flips to Telegram (secrets TELEGRAM_BOT_TOKEN +
 * TELEGRAM_CHAT_ID; skipped when unset). GOOD calls reach Telegram from the engine's own
 * cron, so the workflow no longer opens GitHub issues for anything (owner, 2026-09-27).
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
import { spotDir } from './spot-trend.js';

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

// ---------------------------------------------------------------- spot trend flips (docs/PLAN_SPOT_TREND_2026-09-27.md P2)

/** Flips older than this (by recordedAt) never alert: a late daily signal still helps, a restored history does not. */
export const SPOT_ALERT_MAX_AGE_H = 24;
export const spotAlertKey = (flip) => `spot|${flip.symbol}|${flip.date}`;

/** Live flips (after the spot tracker's start day) not yet alerted, oldest first. */
export function findNewSpotFlips(flips, alertedKeys, nowMs) {
  const since = nowMs - SPOT_ALERT_MAX_AGE_H * 3600_000;
  const seen = new Set(alertedKeys);
  const out = [];
  for (const f of [...flips].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (!f || f.live !== true) continue;
    const t = Date.parse(f.recordedAt);
    if (!Number.isFinite(t) || t < since || t > nowMs + 60_000) continue;
    const key = spotAlertKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, flip: f });
  }
  return out;
}

export function formatSpotAlert({ key, flip }, { mention = null, page = PAGE_URL } = {}) {
  const into = flip.to === 'IN';
  const w = isNum(flip.weight) ? `${Math.round(flip.weight * 100)}%` : '–';
  const title = `SPOT ${flip.symbol} → ${into ? 'IN (hold the coin)' : 'OUT (hold USDC)'} · daily close ${fmt(flip.close)} vs EMA20 ${fmt(flip.ema20)}`;
  const lines = [
    `**${flip.symbol}: ${flip.from} → ${flip.to}** on the ${flip.date} UTC daily close.`,
    '',
    '| Daily close | EMA20 | Suggested weight (40% vol target) |',
    '| --- | --- | --- |',
    `| ${fmt(flip.close)} | ${fmt(flip.ema20)} | ${into ? w : '0%'} |`,
    '',
    into
      ? 'Rule: hold the coin while the daily close stays above EMA20.'
      : 'Rule: hold USDC until a daily close back above EMA20.',
    '',
    `Paper tracking only; no order is placed. Spot trend page: ${page}/spot.html`,
    '',
    '_Backtest evidence: docs/EDGE_SEARCH_2026-09-27.md in the engine repo. Not financial advice._'
  ];
  if (mention) lines.push('', `cc @${mention}`);
  lines.push('', `<!-- alert-key: ${key} -->`);
  // Plain-text Telegram message (sent by the track workflow's Telegram step; no parse mode).
  const telegram = [
    `SPOT ${flip.symbol}: ${flip.from} → ${flip.to} (${into ? 'hold the coin' : 'hold USDC'})`,
    `${flip.date} UTC close ${fmt(flip.close)} vs EMA20 ${fmt(flip.ema20)}`,
    into ? `Suggested weight ${w} (40% vol target)` : 'Suggested weight 0%',
    'Paper only, no order placed.',
    `${page}/spot.html`
  ].join('\n');
  return { key, title, body: lines.join('\n'), telegram };
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
  const spot = findNewSpotFlips(readJsonl(path.join(spotDir(dataDir), 'flips.jsonl')), alerted, nowMs);
  for (const f of spot) alerts.push({ ...formatSpotAlert(f, { mention, page }), chartUrl: null });
  if (spot.length) {
    appendJsonl(alertsFile(dataDir), spot.map(({ key, flip }) => ({
      key, alertedAt: new Date(nowMs).toISOString(), symbol: flip.symbol, capturedAt: flip.recordedAt, source: 'spot-trend'
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
      telegram: 'Test: EditTrades tracker -> Telegram path works. Spot trend flips will arrive here. Safe to ignore.',
      body: ['Test of the GOOD-call email path, opened by the tracker bot. Real alerts carry the plan levels. Safe to close.', '',
        ...(chartUrl ? [`![BTC 5m chart at test time](${chartUrl})`, ''] : ['_(chart unavailable)_', '']),
        ...(mention ? [`cc @${mention}`] : [])].join('\n')
    });
  }
  const out = typeof opts.file === 'string' ? opts.file : 'alerts-new.json';
  writeFileSync(out, JSON.stringify(alerts));
  const spotCount = alerts.filter((a) => String(a.key).startsWith('spot|')).length;
  console.log(`[tracker:alerts] ${alerts.length - spotCount} new GOOD call(s), ${spotCount} spot flip(s), ${alerts.filter((a) => a.chartUrl).length} with chart -> ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[tracker:alerts] ${err.message}`);
    process.exit(1);
  });
}
