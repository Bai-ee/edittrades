/**
 * Vercel Serverless Function: Telegram alert cron (T-1, docs/PLAN_TELEGRAM.md)
 * GET /api/telegram-cron - run every minute by Vercel Cron (vercel.json `crons`)
 *
 * Builds the context once, compares it with the last alert state in Blob
 * `telegram/state.json` (lib/telegram.js diffAlerts) and sends only transitions: NEW GOOD
 * (with the plan timeframe's chart), NEW SETUP, GOOD ended, and data / mark problems that
 * last over 5 minutes (repeated at most every 30 minutes). Nothing changed -> nothing sent.
 *
 * Idempotent under overlapping runs: the new state is written with the blob ETag
 * (ifMatch) BEFORE anything is sent. A run that loses the write race re-reads the
 * winner's state and recomputes against it, so the same transition is claimed once;
 * if the state cannot be written at all, nothing is sent (at most once, never twice).
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it when CRON_SECRET is
 * set), else 401. Missing CRON_SECRET, bot token, allowlist or Blob store -> 503 with a
 * reason. Read-only toward the engine; never imports execution, signing or wallet code.
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet } from '@vercel/blob';
import { buildScalpContext, filterPayload } from '../services/scalpContext.js';
import { renderContextChart } from '../lib/chartRender.js';
import { updateBlob } from '../lib/blobJsonl.js';
import {
  createBotClient, parseAllowedIds, parseState, diffAlerts, inQuietHours, escapeHtml, TELEGRAM_STATE_PATH
} from '../lib/telegram.js';

function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export default function handler(req, res) {
  return handleTelegramCron(req, res);
}

/**
 * @param {Object} req
 * @param {Object} res
 * @param {Object} [deps] - injectable for tests
 * @param {Function} [deps.build=buildScalpContext]
 * @param {Function} [deps.put] - @vercel/blob put
 * @param {Function} [deps.get] - @vercel/blob get
 * @param {Function} [deps.fetchImpl] - Bot API fetch
 * @param {Function} [deps.render=renderContextChart]
 * @param {Function} [deps.now] - () => ms
 * @param {Object} [deps.env] - process.env
 */
export async function handleTelegramCron(req, res, deps = {}) {
  const {
    build = buildScalpContext, put = blobPut, get = blobGet, fetchImpl = globalThis.fetch,
    render = renderContextChart, now = Date.now, env = process.env
  } = deps;
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const log = (status, extra = '') => console.log(`[TelegramCron] requestId=${requestId} status=${status} durationMs=${Date.now() - startedAt}${extra}`);
  const fail = (status, error, reason) => { log(status, reason ? ` reason=${reason}` : ''); return res.status(status).json({ error }); };

  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return fail(405, 'Method not allowed');
  }
  if (!env.CRON_SECRET) return fail(503, 'Telegram cron not configured: CRON_SECRET missing', 'cron_secret_missing');
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/) : null;
  if (!match || !safeCompare(match[1].trim(), env.CRON_SECRET)) return fail(401, 'Unauthorized');
  if (!env.TELEGRAM_BOT_TOKEN) return fail(503, 'Telegram bot not configured: TELEGRAM_BOT_TOKEN missing', 'bot_token_missing');
  const chats = parseAllowedIds(env.TELEGRAM_ALLOWED_USER_IDS);
  if (!chats.length) return fail(503, 'Telegram cron not configured: TELEGRAM_ALLOWED_USER_IDS empty', 'no_recipients');
  if (!deps.put && !deps.get && !env.BLOB_READ_WRITE_TOKEN) return fail(503, 'Telegram state store unavailable', 'store_unconfigured');

  // One build per run. A build that throws is treated as unavailable data, which the
  // state machine turns into a DATA alert once it lasts over 5 minutes.
  let payload;
  try {
    payload = await build();
  } catch (err) {
    payload = { dataStatus: 'unavailable', closedThrough: null, symbols: {}, warnings: [`build failed: ${err && err.name ? err.name : 'Error'}`] };
  }
  const compact = filterPayload(payload, { compact: true });
  const nowMs = now();

  let alerts = [];
  let written = false;
  try {
    const out = await updateBlob({ get, put }, TELEGRAM_STATE_PATH, 'application/json', (text) => {
      const diff = diffAlerts(parseState(text), compact, nowMs);
      alerts = diff.alerts;
      return diff.changed ? `${JSON.stringify(diff.state, null, 2)}\n` : null;
    });
    written = out.written;
  } catch (err) {
    // Could not claim the transition: send nothing rather than risk a duplicate.
    return fail(503, 'Telegram state store unavailable', `state_write_${err && err.name ? err.name : 'Error'}`);
  }

  const bot = createBotClient({ token: env.TELEGRAM_BOT_TOKEN, fetchImpl });
  const silent = inQuietHours(env.TELEGRAM_QUIET_HOURS, nowMs);
  let sent = 0;
  let failed = 0;
  for (const alert of alerts) {
    let png = null;
    if (alert.chart) {
      try { png = (await render(payload, alert.chart)).png; } catch { png = null; }
    }
    for (const chatId of chats) {
      const r = await bot.sendMessage(chatId, alert.text, { silent });
      if (r.ok) sent++; else failed++;
      if (png) {
        const p = await bot.sendPhoto(chatId, png, `${escapeHtml(alert.chart.symbol)} ${escapeHtml(alert.chart.timeframe)} · ${escapeHtml(alert.kind)}`, { silent });
        if (p.ok) sent++; else failed++;
      }
    }
  }

  const kinds = alerts.map((a) => `${a.kind}${a.symbol ? `:${a.symbol}` : ''}`);
  log(200, ` dataStatus=${compact && compact.dataStatus} alerts=${alerts.length} kinds=${kinds.join(',') || '-'} sent=${sent} failed=${failed} stateWritten=${written}`);
  return res.status(200).json({ ok: true, alerts: alerts.length, kinds, sent, failed, stateWritten: written });
}
