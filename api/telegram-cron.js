/**
 * Vercel Serverless Function: Telegram alert cron (T-1, docs/PLAN_TELEGRAM.md)
 * GET /api/telegram-cron - run every minute by Vercel Cron (vercel.json `crons`)
 *
 * Builds the context once, compares it with the last alert state in Blob
 * `telegram/state.json` (lib/telegram.js diffAlerts) and sends only transitions: NEW GOOD
 * (with the plan timeframe's chart), NEW SETUP, GOOD ended, and data / mark problems that
 * last over 5 minutes (repeated at most every 30 minutes), and at alert level `watch` new
 * forming/triggering flag candidates, plus every transition of a tracked candidate (Track /
 * Took it) at any level. A close reminder (NUDGE) is dropped when the journal already
 * holds a close for that trade (the journal is read only when a reminder is due).
 * Nothing changed -> nothing sent. The owner's alert
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
 * Tracked record (lib/telegramLog.js): after the sends, one line per sent alert goes to Blob
 * telegram/alerts/YYYY-MM-DD.jsonl and one line per candidate state / plan status change to
 * telegram/transitions/YYYY-MM-DD.jsonl (each with a day manifest), best effort and capped
 * at 2 s; a log failure never blocks or repeats a send. TRACK_TELEGRAM_LOG=false disables it.
 * Health: consecutive failures live in Blob `telegram/health.json` (written with
 * allowOverwrite, no ETag, so a stuck state write cannot block it). The 3rd consecutive
 * failure sends ALERTS CRON FAILING to the allowed users, then at most hourly; the first
 * success after that sends ALERTS CRON RECOVERED once.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends it when CRON_SECRET is
 * set), else 401. Missing CRON_SECRET, bot token, allowlist or Blob store -> 503 with a
 * reason. Read-only toward the engine; never signs, sends or builds a transaction, and
 * never imports a signing or wallet module.
 * With TRADE_EXECUTION_ENABLED=true, a GOOD/GET IN NOW alert gets an `Open @ plan` button
 * and a SETUP, BREAKOUT or tracked-setup alert with entry/stop/TP1 on file gets
 * `Open (early)` (open:<ref>, handled by the webhook, which re-runs every gate before
 * anything is sent). The cron's only touch on the executor is the read-only
 * `listPositions()` call (via the webhook's `resolveExecutor` factory, T-7 focus mode)
 * cached in `state.livePositions` (reused under 60 s old); it never builds a ticket.
 *
 * Focus mode (T-7, `prefs.focus`, default 'auto'): while a live position is open, every
 * alert not on that symbol (and not a tracked candidate on it, or a health/data alert) is
 * held back and logged `delivered:false, suppressed:'focus'` instead of sent; the moment
 * the last position closes, one resume line goes out unfiltered. `prefs.focus = 'off'`
 * (`/alerts focus off`, the Focus button, or the alerts picker) disables the filter.
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet, head as blobHead } from '@vercel/blob';
import { buildScalpContext, filterPayload } from '../services/scalpContext.js';
import { renderContextChart } from '../lib/chartRender.js';
import { updateBlob, readBlob } from '../lib/blobJsonl.js';
import { readRecent } from './journal.js';
import { alertLogLine, recordTelegramLogs } from '../lib/telegramLog.js';
import {
  withOpenButton, openEligible, candidateLevels, liveView, focusRelated, LIVE_POSITIONS_CACHE_MS,
  createBotClient, parseAllowedIds, migrateState, diffAlerts, inQuietHours, escapeHtml, TELEGRAM_STATE_PATH,
  TELEGRAM_HEALTH_PATH, parseHealth, nextCronHealth, errText, openPositions, positionRef
} from '../lib/telegram.js';
// Read-only door to the executor's live position read (T-7 focus mode): the same
// resolveExecutor factory the webhook uses (TRADE_EXECUTION_ENABLED gate, deps.executor /
// deps.importExecutor injection for tests). This cron never builds, signs or sends a
// transaction; it only calls listPositions() to know which symbols are open.
import { resolveExecutor } from './telegram-webhook.js';

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

/**
 * Live-position snapshot for focus mode (T-7): {snapshot, previous} where `previous` is
 * whatever was cached in telegram/state.json before this run (peeked separately, since
 * updateBlob's change() callback must stay synchronous) and `snapshot` is what this run
 * decides to persist -- the cache reused as-is when younger than LIVE_POSITIONS_CACHE_MS,
 * else a fresh executor.listPositions() read, falling back to `previous` (age keeps
 * growing) on any failure or when the executor is unavailable. A failed read is NEVER
 * read as "no positions": symbols/positionIds stay whatever they last were.
 */
async function resolveLivePositions({ get, env, deps, nowMs, log }) {
  let previous = null;
  try {
    const peek = await readBlob(get, TELEGRAM_STATE_PATH);
    previous = migrateState(peek ? peek.text : null).state.livePositions;
  } catch { previous = null; }
  if (previous && Number.isFinite(Date.parse(previous.at)) && nowMs - Date.parse(previous.at) < LIVE_POSITIONS_CACHE_MS) {
    return { snapshot: previous, previous };
  }
  let ex = null;
  try { ex = await resolveExecutor(env, deps); } catch { ex = null; }
  if (!ex) return { snapshot: previous, previous };
  try {
    const r = await ex.listPositions();
    if (!r || r.ok === false) throw Object.assign(new Error('listPositions not ok'), { name: (r && r.error) || 'PositionsUnavailable' });
    const positions = Array.isArray(r.positions) ? r.positions : (Array.isArray(r) ? r : []);
    const snapshot = {
      at: new Date(nowMs).toISOString(),
      symbols: [...new Set(positions.map((p) => p && p.symbol).filter((s) => typeof s === 'string'))],
      positionIds: positions.map((p) => p && p.positionId).filter((s) => typeof s === 'string')
    };
    return { snapshot, previous };
  } catch (err) {
    log('positions', ` reason=positions_read_${err && err.name ? err.name : 'Error'}`);
    return { snapshot: previous, previous };
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

  // Live-position snapshot for focus mode (T-7): resolved BEFORE the guarded state
  // transaction below, since updateBlob's change() callback must stay synchronous. Never
  // touches state.livePositions when execution is off (livePositionsRead stays false), so
  // an earlier cached snapshot from an enabled period is left exactly as it was.
  let livePositions = null;
  let livePositionsPrev = null;
  let livePositionsRead = false;
  if (env.TRADE_EXECUTION_ENABLED === 'true') {
    const r = await resolveLivePositions({ get, env, deps, nowMs, log });
    livePositions = r.snapshot;
    livePositionsPrev = r.previous;
    livePositionsRead = true;
  }

  let alerts = [];
  let transitions = [];
  let trackedIds = new Set();
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
      transitions = diff.transitions || [];
      trackedIds = new Set((Array.isArray(m.state.tracked) ? m.state.tracked : []).map((t) => t && t.candidateId).filter(Boolean));
      prefs = diff.state.prefs;
      let livePositionsChanged = false;
      if (livePositionsRead) {
        livePositionsChanged = JSON.stringify(m.state.livePositions) !== JSON.stringify(livePositions);
        diff.state.livePositions = livePositions;
      }
      return diff.changed || m.migrated || resetReason || livePositionsChanged ? `${JSON.stringify(diff.state, null, 2)}\n` : null;
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

  // A reminder is only for a trade still open in the journal (a /log or GPT close counts).
  if (alerts.some((a) => a.kind === 'NUDGE')) {
    try {
      const open = new Set(openPositions(await readRecent({ get, put, head }, 50)).map(positionRef));
      alerts = alerts.filter((a) => a.kind !== 'NUDGE' || open.has(a.ref));
    } catch (err) {
      log('journal', ` reason=journal_read_${err && err.name ? err.name : 'Error'}`);
    }
  }
  const silent = inQuietHours(prefs && prefs.quiet, nowMs);

  // Focus mode (T-7, prefs.focus, default 'auto'): while a position is open, only that
  // symbol's alerts, its tracking and health/data alerts send; everything else is still
  // logged (delivered:false, suppressed:'focus') for the tracker, just not sent. The
  // transition from >=1 open position to 0 gets one unfiltered resume line.
  const hadOpenBefore = Boolean(livePositionsPrev && Array.isArray(livePositionsPrev.symbols) && livePositionsPrev.symbols.length);
  const hasOpenNow = Boolean(livePositions && Array.isArray(livePositions.symbols) && livePositions.symbols.length);
  if (hadOpenBefore && !hasOpenNow) alerts.push({ kind: 'FOCUS', symbol: null, text: '🔎 Focus off — position closed, all alerts resumed.' });
  const focusSuppressed = [];
  if (hasOpenNow && prefs && prefs.focus !== 'off') {
    const openSymbols = new Set(livePositions.symbols);
    const kept = [];
    for (const [i, a] of alerts.entries()) {
      if (focusRelated(a, openSymbols)) { kept.push(a); continue; }
      try {
        focusSuppressed.push(alertLogLine(a, { payload: compact, id: `${new Date(nowMs).toISOString()}#f${i}`, sentAtMs: nowMs, silent, level: prefs && prefs.level, trackedIds, delivered: false, suppressed: 'focus' }));
      } catch { /* best effort: the alert is still dropped even if its log line fails */ }
    }
    alerts = kept;
  }

  // Open (T-3, extended T-7): a ready GOOD/GET IN NOW plan gets "Open @ plan"; a SETUP,
  // BREAKOUT or tracked-setup alert with entry/stop/TP1 on file (never WATCH/TRIGGERING)
  // gets "Open (early)". Only when execution is enabled; the webhook gates the rest (PIN, caps, kill, re-preflight, drift, stop cap).
  if (env.TRADE_EXECUTION_ENABLED === 'true') {
    const syms = compact && compact.symbols ? compact.symbols : {};
    alerts = alerts.map((a) => {
      if (!openEligible(a) || !a.candidateId || !a.symbol) return a;
      const lv = candidateLevels(liveView(a.symbol, syms[a.symbol] || {}, a.candidateId, compact));
      return lv ? { ...a, replyMarkup: withOpenButton(a.replyMarkup, a.candidateId, lv.ready) } : a;
    });
  }
  let sent = 0;
  let failed = 0;
  const alertLines = [...focusSuppressed];
  for (const [i, alert] of alerts.entries()) {
    let delivered = false;
    let png = null;
    if (alert.chart) {
      try { png = (await render(payload, alert.chart)).png; } catch { png = null; }
    }
    for (const chatId of chats) {
      const r = await bot.sendMessage(chatId, alert.text, { silent, replyMarkup: alert.replyMarkup || null });
      if (r.ok) { sent++; delivered = true; } else failed++;
      if (png) {
        const p = await bot.sendPhoto(chatId, png, `${escapeHtml(alert.chart.symbol)} ${escapeHtml(alert.chart.timeframe)} · ${escapeHtml(alert.kind)}`, { silent });
        if (p.ok) sent++; else failed++;
      }
      // Follow-up cards (a tracked plan turning ready carries its Plan card).
      for (const more of Array.isArray(alert.more) ? alert.more : []) {
        const m = await bot.sendMessage(chatId, more, { silent });
        if (m.ok) sent++; else failed++;
      }
    }
    try {
      const sentAtMs = now();
      alertLines.push(alertLogLine(alert, { payload: compact, id: `${new Date(nowMs).toISOString()}#${i}`, sentAtMs, silent, level: prefs && prefs.level, trackedIds, delivered }));
    } catch { /* a line that cannot be built is skipped; the send already happened */ }
  }
  const logged = await recordTelegramLogs({ alerts: alertLines, transitions }, { store: { get, put, head }, env, nowMs });

  const kinds = alerts.map((a) => `${a.kind}${a.symbol ? `:${a.symbol}` : ''}`);
  log(200, ` dataStatus=${compact && compact.dataStatus} alerts=${alerts.length} kinds=${kinds.join(',') || '-'} sent=${sent} failed=${failed} silent=${silent} stateWritten=${written} logAlerts=${logged.alerts} logTransitions=${logged.transitions}${logged.skipped && logged.skipped !== 'nothing' ? ` logSkipped=${logged.skipped}` : ''}${health.message ? ' healthAlert=recovered' : ''}`);
  return res.status(200).json({ ok: true, alerts: alerts.length, kinds, sent, failed, silent, stateWritten: written });
}
