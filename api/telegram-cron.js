/**
 * Vercel Serverless Function: Telegram alert cron (T-1, docs/PLAN_TELEGRAM.md)
 * GET /api/telegram-cron - run every minute by Vercel Cron (vercel.json `crons`)
 *
 * Builds the context once, compares it with the last alert state in Blob
 * `telegram/state.json` (lib/telegram.js diffAlerts) and sends only transitions: NEW GOOD
 * (with the plan timeframe's chart), NEW SETUP, GOOD ended, and data / mark problems that
 * last over 5 minutes (repeated at most every 30 minutes), and at alert level `watch` new
 * forming/triggering flag candidates. Nothing changed -> nothing sent. The owner's alert
 * level and quiet hours live in the same state (`prefs`, set with /alerts); during quiet
 * hours (America/Chicago, every day) alerts send with disable_notification, never dropped.
 *
 * Idempotent under overlapping runs: the new state is written with the blob ETag
 * (ifMatch) BEFORE anything is sent. A run that loses the write race re-reads the
 * winner's state and recomputes against it, so the same transition is claimed once;
 * if the state cannot be written at all, nothing is sent (at most once, never twice).
 *
 * State versioning: parseState/migrateState never throw; an older deploy's state migrates
 * forward (stateVersion 2), an unreadable one resets to defaults and logs
 * `reason=state_reset`. State failures log `reason=state_write_<name> msg="<err.message>"`.
 * Health: consecutive failures live in Blob `telegram/health.json` (written with
 * allowOverwrite, no ETag, so a stuck state write cannot block it). The 3rd consecutive
 * failure sends ALERTS CRON FAILING to the allowed users, then at most hourly; the first
 * success after that sends ALERTS CRON RECOVERED once.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it when CRON_SECRET is
 * set), else 401. Missing CRON_SECRET, bot token, allowlist or Blob store -> 503 with a
 * reason. Read-only toward the engine; never imports execution, signing or wallet code.
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet, head as blobHead } from '@vercel/blob';
import { buildScalpContext, filterPayload } from '../services/scalpContext.js';
import { renderContextChart } from '../lib/chartRender.js';
import { updateBlob, readBlob } from '../lib/blobJsonl.js';
import {
  createBotClient, parseAllowedIds, migrateState, diffAlerts, inQuietHours, escapeHtml, TELEGRAM_STATE_PATH,
  TELEGRAM_HEALTH_PATH, parseHealth, nextCronHealth, errText
} from '../lib/telegram.js';

/**
 * Record one cron outcome in telegram/health.json and send the FAILING / RECOVERED
 * message when due. Never throws: a health read or write failure is logged and ignored.
 */
async function recordHealth({ get, put, bot, chats, nowMs, outcome, log }) {
  try {
    let prev;
    try {
      const blob = await readBlob(get, TELEGRAM_HEALTH_PATH);
      prev = parseHealth(blob ? blob.text : null);
    } catch {
      prev = parseHealth(null);
    }
    const { health, message, write } = nextCronHealth(prev, outcome, nowMs);
    if (write) {
      await put(TELEGRAM_HEALTH_PATH, `${JSON.stringify(health, null, 2)}\n`, {
        access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60
      });
    }
    if (message) for (const chatId of chats) await bot.sendMessage(chatId, message);
    return { health, message };
  } catch (err) {
    log('health', ` reason=health_write_${err && err.name ? err.name : 'Error'} msg=${JSON.stringify(errText(err))}`);
    return { health: null, message: null };
  }
}

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
    build = buildScalpContext, put = blobPut, get = blobGet, head = (deps.get || deps.put ? undefined : blobHead), fetchImpl = globalThis.fetch,
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

  const bot = createBotClient({ token: env.TELEGRAM_BOT_TOKEN, fetchImpl });
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.CRON_SECRET, env.BLOB_READ_WRITE_TOKEN];
  let alerts = [];
  let prefs = null;
  let written = false;
  let resetReason = null;
  let migratedFrom = null;
  try {
    const out = await updateBlob({ get, put, head }, TELEGRAM_STATE_PATH, 'application/json', (text) => {
      const m = migrateState(text);
      resetReason = m.reset ? m.reason : null;
      migratedFrom = m.migrated ? m.fromVersion : null;
      let diff;
      try {
        diff = diffAlerts(m.state, compact, nowMs);
      } catch {
        // A stored state the diff cannot use: start over (owner prefs kept) instead of dying.
        resetReason = 'diff_error';
        diff = diffAlerts({ prefs: m.state.prefs }, compact, nowMs);
      }
      alerts = diff.alerts;
      prefs = diff.state.prefs;
      return diff.changed || m.migrated || resetReason ? `${JSON.stringify(diff.state, null, 2)}\n` : null;
    });
    written = out.written;
  } catch (err) {
    // Could not claim the transition: send nothing rather than risk a duplicate.
    const reason = `state_write_${err && err.name ? err.name : 'Error'}`;
    const h = await recordHealth({ get, put, bot, chats, nowMs, outcome: { ok: false, reason }, log });
    log(503, ` reason=${reason} msg=${JSON.stringify(errText(err, secrets))}${h.health ? ` failures=${h.health.failures}` : ''}${h.message ? ' healthAlert=sent' : ''}`);
    return res.status(503).json({ error: 'Telegram state store unavailable' });
  }
  if (resetReason) log('state', ` reason=state_reset cause=${resetReason}`);
  if (migratedFrom !== null) log('state', ` reason=state_migrated from=${migratedFrom}`);
  const health = await recordHealth({ get, put, bot, chats, nowMs, outcome: { ok: true }, log });

  const silent = inQuietHours(prefs && prefs.quiet, nowMs);
  let sent = 0;
  let failed = 0;
  for (const alert of alerts) {
    let png = null;
    if (alert.chart) {
      try { png = (await render(payload, alert.chart)).png; } catch { png = null; }
    }
    for (const chatId of chats) {
      const r = await bot.sendMessage(chatId, alert.text, { silent, replyMarkup: alert.replyMarkup || null });
      if (r.ok) sent++; else failed++;
      if (png) {
        const p = await bot.sendPhoto(chatId, png, `${escapeHtml(alert.chart.symbol)} ${escapeHtml(alert.chart.timeframe)} · ${escapeHtml(alert.kind)}`, { silent });
        if (p.ok) sent++; else failed++;
      }
    }
  }

  const kinds = alerts.map((a) => `${a.kind}${a.symbol ? `:${a.symbol}` : ''}`);
  log(200, ` dataStatus=${compact && compact.dataStatus} alerts=${alerts.length} kinds=${kinds.join(',') || '-'} sent=${sent} failed=${failed} silent=${silent} stateWritten=${written}${health.message ? ' healthAlert=recovered' : ''}`);
  return res.status(200).json({ ok: true, alerts: alerts.length, kinds, sent, failed, silent, stateWritten: written });
}
