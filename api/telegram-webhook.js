/**
 * Vercel Serverless Function: Telegram bot webhook (T-1, docs/PLAN_TELEGRAM.md)
 * POST /api/telegram-webhook - one Telegram update per call
 *
 * Read commands plus journal logging, answered with the Bot API (lib/telegram.js).
 * Read-only toward the engine: it builds the same context as /api/scalp-context and the
 * MCP tool, and writes journal lines through api/journal.js's own append path and the
 * owner's alert prefs (`/alerts`) into the cron's `telegram/state.json`.
 *
 * Execution (T-3, docs/PLAN_TELEGRAM_EXECUTION.md): Open / /order / /confirm / /stops /
 * position buttons / /exec / /kill / /arm / /mode reach lib/execution/executor.js, and
 * only through resolveExecutor: TRADE_EXECUTION_ENABLED must be 'true' and the module
 * must load (a lazy import, so nothing else in this file pulls it in); otherwise every
 * execution button and command answers `Execution off` and nothing else changes. The
 * executor owns every gate (caps, kill, mode, nonce, PIN); this file only builds the
 * intent, renders tickets and results, and deletes the owner's /confirm and /arm
 * messages so the PIN does not stay in the chat. Position-action tickets (close / stops)
 * are single-use Telegram-side nonces in `telegram/exec-tickets.json` (60 s). Every
 * execution message is logged as a kind EXEC line (lib/telegramLog.js).
 *
 * Gates, in order: POST only (405); TELEGRAM_WEBHOOK_SECRET and TELEGRAM_BOT_TOKEN
 * configured (else 503 with a reason); `X-Telegram-Bot-Api-Secret-Token` equals the
 * secret (else 403); sender id in TELEGRAM_ALLOWED_USER_IDS (else 200 and silence).
 * Every accepted update answers 200 so Telegram does not redeliver it. Secrets, message
 * text and user ids are never logged.
 *
 * /flags (the Flags label, and Charts -> All flags) sends the text summary, then chart
 * albums of every live flag (sendFlagAlbums), from one full build.
 *
 * Buttons: plain replies carry the persistent reply keyboard (lib/telegram.js MENU_ROWS;
 * a tapped label maps to its command). Inline buttons arrive as `callback_query` updates
 * (setWebhook allowed_updates ["message","callback_query"]): the same allowlist applies,
 * answerCallbackQuery is sent first, then the button runs as its command. Took it /
 * Skipped journal the alert's plan (state.buttons, else the live plan with that ref).
 * Plan / Thesis / Track resolve the button's ref against live data first, then the
 * snapshot in state (buttons, tracked); an unknown ref replies `[expired — send /signals]`.
 * Track / Untrack / Took it / Still in write `state.tracked` with the same ETag-guarded
 * update as `/alerts`. Closed here / Partial / Close @ mark journal a close or adjust
 * against the open trade (journal opens with no close, `/positions`).
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet, head as blobHead } from '@vercel/blob';
import { buildScalpContext, filterPayload } from '../services/scalpContext.js';
import { parseChartArg, renderContextChart, ChartRequestError } from '../lib/chartRender.js';
import { validateJournalEntry } from '../lib/journalSchema.js';
import { readBlob, updateBlob } from '../lib/blobJsonl.js';
import { appendRecord, readRecent } from './journal.js';
import {
  createBotClient, parseAllowedIds, isAllowed, parseCommand, parseSymbol, parseJournalN, parseLogText,
  formatSignals, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatHelp, formatGoodAlert,
  migrateState, parseHealth, errText, TELEGRAM_HEALTH_PATH, escapeHtml, TELEGRAM_STATE_PATH, parseAlertsArgs, applyPrefsChange, formatAlertPrefs, fmtQuiet,
  parseMenuLabel, menuKeyboard, chartsKeyboard, alertsKeyboard, signalsKeyboard, parseCallbackData, buttonLogBody, findButtonSnapshot,
  collectLiveFlags, capFlagCharts, formatFlagCaption, formatNoLiveFlags, chunkMediaGroup, albumSeries, MAX_FLAG_CHARTS, FLAG_CHART_BUDGET_MS,
  resolveRef, formatPlanCard, formatThesisCard, tradeKeyboard, swapTrackButton, candidateSnapshot, trackEntry, applyTrackChange, formatTrackingList,
  trackingKeyboard, signalsSnapshots, applyButtonSnapshots, openPositions, positionRef, formatPositions, positionsKeyboard, closeBody, livePrice,
  EXPIRED_REPLY, TRACK_MAX, formatMarket, fmtTag, fmtLvl, RULE,
  EXEC_OFF_REPLY, ORDER_USAGE, CONFIRM_USAGE, STOPS_USAGE, EXEC_TICKETS_PATH, EXEC_TICKET_TTL_MS, isOpenReady, withOpenButton, execCaps, execMode,
  orderIntentFromPlan, parseOrderArgs, parseConfirmArgs, parseStopsArgs, quoteFill, formatRefusedCard, formatTicketCard, ticketKeyboard, confirmPrompt,
  formatResultCard, formatConfirmFail, formatOpenPhaseCard, formatEmergencyCloseCard, normalizeChainPositions, formatChainPositions, chainPositionsKeyboardRows, formatManageTicket, formatManageResult,
  formatExecStatus, formatKilled, formatArmed, formatModeCard, putExecTicket, findExecTicket, takeExecTicket
} from '../lib/telegram.js';
import { execLogLine, recordTelegramLogs } from '../lib/telegramLog.js';

// 300 s (Vercel Pro ceiling): the live two-phase open runs inside one confirm request —
// worst case 45 s land + 60 s keeper fill + 2 x 45 s stop landings + 45 s emergency close
// + 45 s close retries (landing / fill-wait ceilings in the perps service, executor
// EMERGENCY_CLOSE_MAX_MS) ≈ 285 s. /flags (9 charts, several Bot API calls) fits easily.
export const config = { maxDuration: 300 };

function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

const isObjLike = (v) => v !== null && typeof v === 'object';

function readUpdate(req) {
  let raw = req.body;
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

export default function handler(req, res) {
  return handleTelegramWebhook(req, res);
}

/**
 * A GOOD-shaped sample for /testalert: the first symbol with any candidate (its live plan
 * when one exists, else levels read off the candidate), or a synthetic BTC 5m card from
 * the price. Always rendered with `test: true`, so the card says TEST - NOT A SIGNAL.
 * @returns {{symbol:string, sample:Object, chart:{symbol:string, timeframe:string}}}
 */
export function testAlertSample(payload) {
  const syms = payload && payload.symbols ? payload.symbols : {};
  for (const k of ['BTC', 'ETH', 'SOL']) {
    const s = syms[k];
    const cands = s && Array.isArray(s.candidateSetups) ? s.candidateSetups.filter((c) => c && c.timeframe) : [];
    if (!s || !cands.length) continue;
    const c = cands[0];
    const plan = s.flagTradePlan || {
      timeframe: c.timeframe, direction: c.direction, entry: c.breakoutLevel, stop: c.invalidation,
      tp1: c.measuredTarget, grossRR: c.measuredRR ?? null, netRR: null
    };
    return { symbol: k, sample: { ...s, flagTradePlan: plan }, chart: { symbol: k, timeframe: plan.timeframe || c.timeframe } };
  }
  const btc = syms.BTC || {};
  const p = typeof btc.price === 'number' ? btc.price : 100000;
  const plan = { timeframe: '5m', direction: 'long', entry: p, stop: p * 0.995, tp1: p * 1.0125, grossRR: 2.5, netRR: 2.1 };
  return { symbol: 'BTC', sample: { ...btc, flagTradePlan: plan, flagRecommendation: { class: 'GOOD', changeConditions: [] } }, chart: { symbol: 'BTC', timeframe: '5m' } };
}

const EXECUTOR_FNS = Object.freeze(['preflight', 'createTicket', 'confirm', 'closePosition', 'updateStops', 'listPositions', 'status']);
const validExecutor = (x) => (x && EXECUTOR_FNS.every((k) => typeof x[k] === 'function') ? x : null);
/** Commands and buttons that need the executor (each answers `Execution off` without it). */
const EXEC_CMDS = new Set(['open', 'order', 'confirm', 'stops', 'exec', 'kill', 'arm', 'mode', 'xconfirm', 'xcancel', 'xmanage']);

/**
 * The executor (docs/PLAN_TELEGRAM_EXECUTION.md "Contract between agents"), or null:
 * TRADE_EXECUTION_ENABLED must be exactly 'true', and the module must load and export
 * every contract function. `deps.executor` (tests) replaces the import; `deps.importExecutor`
 * replaces the loader. Never throws.
 */
export async function resolveExecutor(env, deps = {}) {
  if (!env || env.TRADE_EXECUTION_ENABLED !== 'true') return null;
  if (Object.prototype.hasOwnProperty.call(deps, 'executor')) return validExecutor(deps.executor);
  try {
    const load = typeof deps.importExecutor === 'function' ? deps.importExecutor : () => import('../lib/execution/executor.js');
    const m = await load();
    return validExecutor(m && typeof m.preflight === 'function' ? m : m && m.default);
  } catch {
    return null;
  }
}

/** Resolves `promise`, or rejects with a TimeoutError after `ms`. */
function withBudget(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('chart budget exceeded'), { name: 'TimeoutError' })), ms); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/**
 * The /flags albums from one full (non-compact) payload: every live flag grouped per
 * symbol and timeframe, at most MAX_FLAG_CHARTS images, rendered in parallel with a
 * per-image budget, one media group per symbol. A symbol with no live flag gets the one
 * line "BTC · no live flags"; a chart that fails to render goes out as its caption text
 * plus [chart unavailable]. Never throws on a render failure.
 * @returns {Promise<{images:number, failed:number, dropped:number}>}
 */
export async function sendFlagAlbums({ bot, chatId, payload, only = null, render, reply, budgetMs = FLAG_CHART_BUDGET_MS, maxCharts = MAX_FLAG_CHARTS }) {
  const { groups, dropped } = capFlagCharts(collectLiveFlags(payload, only), maxCharts);
  const closedThrough = payload && payload.closedThrough;
  const jobs = groups.flatMap((g) => g.charts);
  const settled = await Promise.allSettled(jobs.map((ch) => withBudget(
    Promise.resolve().then(() => render(payload, { symbol: ch.symbol, timeframe: ch.timeframe }, albumSeries(payload, ch.symbol, ch.timeframe))),
    budgetMs
  )));
  const results = new Map(jobs.map((ch, i) => [ch, settled[i]]));
  let images = 0;
  let failed = 0;
  for (const g of groups) {
    if (!g.charts.length) {
      if (!g.capped) await reply(formatNoLiveFlags(g.symbol)); // capped away: covered by the limit line
      continue;
    }
    const photos = [];
    const unavailable = [];
    for (const ch of g.charts) {
      const r = results.get(ch);
      const caption = formatFlagCaption(ch, closedThrough);
      if (r.status === 'fulfilled' && r.value && r.value.png) photos.push({ png: r.value.png, caption });
      else unavailable.push(`${caption}\n[chart unavailable]`);
    }
    for (const chunk of chunkMediaGroup(photos)) {
      const sent = await bot.sendMediaGroup(chatId, chunk);
      if (sent.ok) images += chunk.length;
      else unavailable.push(...chunk.map((p) => `${p.caption}\n[chart unavailable]`));
    }
    failed += unavailable.length;
    if (unavailable.length) await reply(unavailable.join('\n\n'));
  }
  if (dropped) await reply(`+${dropped} more flag chart${dropped === 1 ? '' : 's'} over the ${maxCharts}-image limit; send /flags BTC, /flags ETH or /flags SOL.`);
  return { images, failed, dropped };
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
 * @param {Object} [deps.executor] - execution contract mock (tests); see resolveExecutor
 * @param {Function} [deps.importExecutor] - loader for lib/execution/executor.js (tests)
 */
export async function handleTelegramWebhook(req, res, deps = {}) {
  const {
    build = buildScalpContext, put = blobPut, get = blobGet, head = (deps.get || deps.put ? undefined : blobHead), fetchImpl = globalThis.fetch,
    render = renderContextChart, now = Date.now, env = process.env
  } = deps;
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const log = (status, extra = '') => console.log(`[TelegramWebhook] requestId=${requestId} status=${status} durationMs=${Date.now() - startedAt}${extra}`);

  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    log(405);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    log(503, ' reason=webhook_secret_missing');
    return res.status(503).json({ error: 'Telegram webhook not configured: TELEGRAM_WEBHOOK_SECRET missing' });
  }
  const header = req.headers && (req.headers['x-telegram-bot-api-secret-token'] || req.headers['X-Telegram-Bot-Api-Secret-Token']);
  if (typeof header !== 'string' || !safeCompare(header, env.TELEGRAM_WEBHOOK_SECRET)) {
    log(403);
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!env.TELEGRAM_BOT_TOKEN) {
    log(503, ' reason=bot_token_missing');
    return res.status(503).json({ error: 'Telegram bot not configured: TELEGRAM_BOT_TOKEN missing' });
  }

  const update = readUpdate(req);
  const cq = update && isObjLike(update.callback_query) ? update.callback_query : null;
  const msg = cq ? null : update && (update.message || update.edited_message);
  const fromId = cq ? (cq.from ? cq.from.id : null) : (msg && msg.from ? msg.from.id : null);
  const chatId = cq
    ? (cq.message && cq.message.chat ? cq.message.chat.id : fromId)
    : (msg && msg.chat ? msg.chat.id : null);
  if ((!msg && !cq) || chatId === null || chatId === undefined) {
    log(200, ' ignored=no_message');
    return res.status(200).json({ ok: true });
  }
  if (!isAllowed(fromId, parseAllowedIds(env.TELEGRAM_ALLOWED_USER_IDS))) {
    log(200, ' allowed=false');
    return res.status(200).json({ ok: true });
  }

  const bot = createBotClient({ token: env.TELEGRAM_BOT_TOKEN, fetchImpl });
  // Every plain reply re-sends the persistent menu keyboard; inline pickers replace it.
  const reply = (text, markup = menuKeyboard()) => bot.sendMessage(chatId, text, { replyMarkup: markup });
  const hasStore = Boolean(deps.put || deps.get || env.BLOB_READ_WRITE_TOKEN);
  const store = { put, get, head };
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, env.BLOB_READ_WRITE_TOKEN];
  const errMsg = (err) => ` reason=state_read_${err && err.name ? err.name : 'Error'} msg=${JSON.stringify(errText(err, secrets))}`;
  /** State from Blob; never throws (read failure -> null, logged). Logs a reset/migration. */
  const readState = async () => {
    try {
      const blob = await readBlob(get, TELEGRAM_STATE_PATH);
      const m = migrateState(blob ? blob.text : null);
      if (m.reset) log('state', ` reason=state_reset cause=${m.reason}`);
      return m.state;
    } catch (err) {
      log('state', errMsg(err));
      return null;
    }
  };
  /**
   * ETag-guarded state change (the cron's own update path). `change(text)` returns new
   * text, or {text, result, entry}. Resolves {result, entry, before} or null on failure (logged).
   */
  const writeState = async (change) => {
    let out = null;
    try {
      await updateBlob(store, TELEGRAM_STATE_PATH, 'application/json', (text) => {
        const before = migrateState(text).state;
        const r = change(text);
        const next = typeof r === 'string' ? r : r.text;
        const ref = r && typeof r === 'object' ? (r.entry && r.entry.ref) : null;
        out = typeof r === 'string' ? { result: 'saved', entry: null, before: null } : { result: r.result, entry: r.entry, before: (before.tracked || []).find((t) => t && ref && t.ref === ref) || r.entry };
        return next;
      });
      return out;
    } catch (err) {
      log('state', ` reason=state_write_${err && err.name ? err.name : 'Error'} msg=${JSON.stringify(errText(err, secrets))}`);
      return null;
    }
  };
  /** Swap Track <-> Untrack on the tapped message's keyboard (best effort, callbacks only). */
  const swapOriginal = async (ref, tracked) => {
    const markup = cq && cq.message ? swapTrackButton(cq.message.reply_markup, ref, tracked) : null;
    if (markup && cq.message.message_id !== undefined) await bot.editMessageReplyMarkup(chatId, cq.message.message_id, markup);
  };
  let parsed;
  if (cq) {
    await bot.answerCallbackQuery(cq.id); // promptly, before any build
    parsed = parseCallbackData(cq.data);
  } else {
    const text = typeof msg.text === 'string' ? msg.text : '';
    parsed = parseCommand(text) || parseMenuLabel(text);
  }
  const cmd = parsed ? parsed.cmd : null;
  const via = cq ? 'cb:' : '';

  // ---- execution helpers (only used by execution commands and /positions, /plan)
  const ex = parsed && parsed.known && (EXEC_CMDS.has(cmd) || cmd === 'positions' || cmd === 'plan') ? await resolveExecutor(env, deps) : null;
  const ctx = (extra = {}) => ({ source: 'telegram', userId: String(fromId), chatId: String(chatId), nowMs: now(), requestId, ...extra });
  /** ctx.mark for preflight: the payload symbol's mark plus the Kraken close (executor picks mark when ok). */
  const markCtx = (symbol, s) => (s && typeof s === 'object' ? { symbol, status: s.mark && s.mark.status ? s.mark.status : 'unavailable', price: s.mark ? s.mark.price ?? null : null, close: typeof s.price === 'number' ? s.price : null } : null);
  let execSeq = 0;
  /**
   * Reply (or, with `editMessageId`, edit that message in place -- T-3 F: the live open
   * phase card's terminal edit), then log the message as a kind EXEC line (best effort,
   * never throws).
   */
  const execSend = async (text, markup, meta = {}, editMessageId = null) => {
    const r = editMessageId ? await bot.editMessageText(chatId, editMessageId, text, { replyMarkup: markup || null }) : await reply(text, markup || menuKeyboard());
    if (hasStore) {
      try {
        await recordTelegramLogs({ alerts: [execLogLine({ id: `exec_${requestId}_${execSeq++}`, sentAtMs: now(), text, delivered: Boolean(r && r.ok), ...meta })] }, { store, env, nowMs: now() });
      } catch { /* the log never blocks a reply */ }
    }
    return r;
  };
  const safeStatus = async () => { try { const st = await ex.status(); return st && st.ok !== false ? st : null; } catch { return null; } };
  const errName = (err) => (err && err.name ? String(err.name).replace(/[^A-Za-z]/g, '').slice(0, 40) : 'Error');
  const tickets = {
    put: async (t) => {
      try { await updateBlob(store, EXEC_TICKETS_PATH, 'application/json', (text) => putExecTicket(text, t, now())); return true; } catch (err) { log('exec', ` reason=ticket_write_${errName(err)}`); return false; }
    },
    find: async (nonce) => {
      try { const b = await readBlob(get, EXEC_TICKETS_PATH); return findExecTicket(b ? b.text : null, nonce, now()); } catch { return null; }
    },
    take: async (nonce) => {
      let taken = null;
      try {
        await updateBlob(store, EXEC_TICKETS_PATH, 'application/json', (text) => { const r = takeExecTicket(text, nonce, now()); taken = r.ticket; return r.ticket ? r.text : null; });
      } catch (err) { log('exec', ` reason=ticket_take_${errName(err)}`); return null; }
      return taken;
    }
  };
  /** Delete the owner's message (it may carry a PIN); on failure tell the owner to delete it. */
  const deleteOwn = async () => {
    if (!msg || msg.message_id === undefined) return;
    let r = null;
    try { r = await bot.deleteMessage(chatId, msg.message_id); } catch { r = null; }
    if (!r || r.ok !== true) {
      log('exec', ' reason=pin_message_delete_failed');
      await reply('⚠️ Could not delete your PIN message — delete your PIN message manually.');
    }
  };
  /** Preflight -> refused card, or createTicket -> ticket card with Confirm / Cancel. */
  const runOrder = async (intent, { timeframe = null, snap = null, mark = null } = {}) => {
    const status = await safeStatus();
    const mode = execMode(status);
    const meta = { symbol: intent.symbol, timeframe, direction: intent.direction, candidateId: intent.candidateId || null, entry: intent.entry, stop: intent.stop, tp1: intent.tp1, mode };
    let pf;
    try { pf = await ex.preflight(intent, ctx(mark ? { mark } : {})); } catch (err) { pf = { ok: false, reasons: [`preflight failed (${errName(err)})`] }; }
    if (!pf || pf.ok !== true) return execSend(formatRefusedCard(intent, pf && pf.reasons, { timeframe }), null, { ...meta, event: 'refused' });
    let ticket = null;
    try { ticket = await ex.createTicket(pf.order, ctx()); } catch (err) { log('exec', ` reason=ticket_${errName(err)}`); }
    if (!ticket || ticket.ok === false || typeof ticket.nonce !== 'string') return execSend(formatRefusedCard(intent, (ticket && ticket.reasons) || ['the order ticket could not be created'], { timeframe }), null, { ...meta, event: 'refused' });
    const expiresAt = Number.isFinite(Date.parse(ticket.expiresAt)) ? ticket.expiresAt : new Date(now() + EXEC_TICKET_TTL_MS).toISOString();
    if (hasStore) {
      await tickets.put({
        nonce: ticket.nonce, kind: 'order', expiresAt, symbol: intent.symbol, timeframe, direction: intent.direction,
        entry: intent.entry ?? null, stop: intent.stop, tp1: intent.tp1, sizeUsd: intent.sizeUsd, leverage: intent.leverage,
        fill: typeof (pf.order && pf.order.expectedFill) === 'number' ? pf.order.expectedFill : quoteFill(pf.quote),
        candidateId: intent.candidateId || null, snap
      });
    }
    return execSend(formatTicketCard(intent, pf, { ...ticket, expiresAt }, { mode, timeframe, nowMs: now() }), ticketKeyboard(ticket.nonce), { ...meta, event: 'ticket' });
  };
  /** Chain positions (normalized) or null when the read fails. */
  const chainPositions = async () => { try { return normalizeChainPositions(await ex.listPositions()); } catch (err) { log('exec', ` reason=positions_${errName(err)}`); return null; } };
  /**
   * A position-action ticket (close / half / be / stops) -> Confirm / Cancel card. When the
   * executor exposes prepareClose / prepareUpdate, its own nonce ticket is used (confirm
   * runs through executor.confirm); otherwise a single-use Telegram-side nonce is stored
   * and /confirm calls closePosition / updateStops with the PIN.
   */
  const manageTicket = async (action, p, { stop = null, tp = null } = {}) => {
    if (!hasStore) return reply('Ticket store unavailable.');
    const status = await safeStatus();
    const mode = execMode(status);
    const t = {
      nonce: null, kind: 'manage', viaExecutor: false, action, expiresAt: new Date(now() + EXEC_TICKET_TTL_MS).toISOString(), position: p,
      sizeUsd: action === 'half' && typeof p.sizeUsd === 'number' ? Math.round(p.sizeUsd * 50) / 100 : null,
      stop: action === 'be' ? p.entry : stop, tp: action === 'be' ? p.tp : tp
    };
    const meta = { symbol: p.symbol, direction: p.direction, mode };
    const refused = (reasons) => execSend(formatRefusedCard({ symbol: p.symbol, direction: p.direction }, reasons), null, { ...meta, event: 'refused' });
    const close = action === 'close' || action === 'half';
    const prepare = close ? ex.prepareClose : ex.prepareUpdate;
    if (typeof prepare === 'function') {
      let prep;
      try { prep = close ? await ex.prepareClose(p.positionId, t.sizeUsd, ctx()) : await ex.prepareUpdate(p.positionId, t.stop, t.tp, ctx()); } catch (err) { prep = { ok: false, reasons: [`prepare failed (${errName(err)})`] }; }
      if (!prep || prep.ok !== true) return refused(prep && prep.reasons);
      let ticket = null;
      try { ticket = await ex.createTicket(prep.order, ctx()); } catch (err) { log('exec', ` reason=ticket_${errName(err)}`); }
      if (!ticket || ticket.ok === false || typeof ticket.nonce !== 'string') return refused((ticket && ticket.reasons) || ['the ticket could not be created']);
      Object.assign(t, { nonce: ticket.nonce, viaExecutor: true, expiresAt: Number.isFinite(Date.parse(ticket.expiresAt)) ? ticket.expiresAt : t.expiresAt });
      // Display data for the result card; the executor owns the nonce and the position id
      // (public Blob: the full position id is not stored here).
      const { positionId: _omit, ...shown } = p;
      await tickets.put({ ...t, position: shown });
    } else {
      t.nonce = crypto.randomBytes(4).toString('hex');
      if (!(await tickets.put(t))) return reply('The ticket could not be saved; try again in a minute.');
    }
    return execSend(formatManageTicket(t, { mode, nowMs: now() }), ticketKeyboard(t.nonce), { ...meta, event: `ticket_${action}` });
  };

  try {
    if (!parsed) {
      await reply(cq ? 'That button is no longer valid. Send /menu.' : 'Send /help for the command list.');
    } else if (parsed.known && EXEC_CMDS.has(cmd) && !ex) {
      if ((cmd === 'confirm' || cmd === 'arm') && parsed.args.length) await deleteOwn();
      await execSend(EXEC_OFF_REPLY, null, { event: 'off' });
    } else if (cmd === 'open') {
      const payload = filterPayload(await build(), { compact: true });
      const state = hasStore ? await readState() : null;
      const v = resolveRef(parsed.ref, payload, state);
      if (!v) await reply(EXPIRED_REPLY);
      else {
        const tf = (v.plan && v.plan.timeframe) || (v.candidate && v.candidate.timeframe) || null;
        const built = orderIntentFromPlan(v, execCaps(await safeStatus(), env));
        if (built.error) await execSend(formatRefusedCard({ symbol: v.symbol, direction: (v.plan && v.plan.direction) || v.candidate.direction }, [built.error], { timeframe: tf }), null, { event: 'refused', symbol: v.symbol, timeframe: tf, candidateId: v.candidateId });
        else await runOrder(built.intent, { timeframe: tf, snap: built.snap, mark: markCtx(v.symbol, payload && payload.symbols ? payload.symbols[v.symbol] : null) });
      }
    } else if (cmd === 'order') {
      const o = parseOrderArgs(parsed.args);
      if (!o.ok) await execSend(escapeHtml(ORDER_USAGE), null, { event: 'usage' });
      else {
        // Market order: entry is the live mark (Kraken close when no mark); the executor quotes the fill.
        const payload = filterPayload(await build(), { compact: true });
        const sym = payload && payload.symbols ? payload.symbols[o.symbol] : null;
        const lp = livePrice(sym);
        await runOrder({ symbol: o.symbol, direction: o.direction, sizeUsd: o.sizeUsd, leverage: o.leverage, entry: lp ? lp.price : null, stop: o.stop, tp1: o.tp1, source: 'telegram' }, { mark: markCtx(o.symbol, sym) });
      }
    } else if (cmd === 'xconfirm') {
      await execSend(confirmPrompt(parsed.nonce), null, { event: 'confirm_prompt' });
    } else if (cmd === 'xcancel') {
      // Consume the executor ticket (single use, no action) and drop the Telegram-side one.
      if (typeof ex.cancelTicket === 'function') {
        try { await ex.cancelTicket(parsed.nonce, ctx()); } catch (err) { log('exec', ` reason=cancel_${errName(err)}`); }
      }
      if (hasStore) await tickets.take(parsed.nonce);
      if (cq && cq.message && cq.message.message_id !== undefined) await bot.editMessageReplyMarkup(chatId, cq.message.message_id, { inline_keyboard: [] });
      await execSend('Cancelled. Nothing was sent.', null, { event: 'cancel' });
    } else if (cmd === 'confirm') {
      if (parsed.args.length) await deleteOwn(); // the PIN must not stay in the chat
      const { nonce, pin } = parseConfirmArgs(parsed.args);
      if (!nonce || !pin) await execSend(escapeHtml(CONFIRM_USAGE), null, { event: 'usage' });
      else {
        const t = hasStore ? await tickets.find(nonce) : null;
        if (t && t.kind === 'manage' && t.viaExecutor) {
          let r;
          try { r = await ex.confirm(nonce, pin, ctx()); } catch (err) { r = { ok: false, error: `confirm failed (${errName(err)})` }; }
          const p = t.position || {};
          const meta = { symbol: p.symbol, direction: p.direction, mode: r && r.mode };
          if (!r || r.ok !== true) await execSend(formatConfirmFail(r), null, { ...meta, event: 'confirm_failed' });
          else {
            await tickets.take(nonce);
            await execSend(formatManageResult(r, t), null, { ...meta, event: `done_${t.action}` });
          }
        } else if (t && t.kind === 'manage') {
          const taken = await tickets.take(nonce); // single use, before the executor runs
          if (!taken) await execSend('That ticket expired or was used. Tap the position button again.', null, { event: 'expired' });
          else {
            const p = taken.position || {};
            let r;
            try {
              r = taken.action === 'close' || taken.action === 'half'
                ? await ex.closePosition(p.positionId, taken.action === 'half' ? taken.sizeUsd : null, pin, ctx())
                : await ex.updateStops(p.positionId, taken.stop, taken.tp, pin, ctx());
            } catch (err) { r = { ok: false, error: `failed (${errName(err)})` }; }
            const meta = { symbol: p.symbol, direction: p.direction, mode: r && r.mode };
            if (!r || r.ok !== true) await execSend(formatConfirmFail(r), null, { ...meta, event: 'confirm_failed' });
            else await execSend(formatManageResult(r, taken), null, { ...meta, event: `done_${taken.action}` });
          }
        } else {
          const tk = t || {};
          // T-3 F: in live mode, the phase card is sent once (on `submitted`) and then
          // edited in place for every later phase; dry mode has no phases (skip straight
          // to the result card).
          const status0 = await safeStatus();
          const mode0 = execMode(status0);
          let phaseMessageId = null;
          const onPhase = mode0 === 'live' ? async (phase, info) => {
            const text = formatOpenPhaseCard(phase, { symbol: tk.symbol, direction: tk.direction, sizeUsd: tk.sizeUsd, leverage: tk.leverage, ...info }, { mode: mode0, timeframe: tk.timeframe });
            try {
              if (phaseMessageId === null) {
                const sent = await bot.sendMessage(chatId, text, { replyMarkup: null });
                phaseMessageId = sent && typeof sent.message_id === 'number' ? sent.message_id : null;
              } else {
                await bot.editMessageText(chatId, phaseMessageId, text);
              }
            } catch (err) { log('exec', ` reason=phase_card_${errName(err)}`); }
          } : undefined;
          let r;
          try { r = await ex.confirm(nonce, pin, ctx({ onPhase })); } catch (err) { r = { ok: false, error: `confirm failed (${errName(err)})` }; }
          const meta = { symbol: tk.symbol || null, timeframe: tk.timeframe || null, direction: tk.direction || null, candidateId: tk.candidateId || null, entry: tk.entry, stop: tk.stop, tp1: tk.tp1, mode: r && r.mode };
          const reasons = Array.isArray(r && r.reasons) ? r.reasons : [];
          const emergencyClosed = reasons.includes('emergency_closed') || reasons.includes('emergency_close_failed');
          if (!r || r.ok !== true) {
            const text = emergencyClosed ? formatEmergencyCloseCard(r, { symbol: tk.symbol, direction: tk.direction }, { mode: meta.mode, timeframe: tk.timeframe }) : formatConfirmFail(r);
            await execSend(text, null, { ...meta, event: emergencyClosed ? 'emergency_close' : 'confirm_failed' }, phaseMessageId);
          } else {
            // Auto-track the candidate (the executor journals; no second journal write). Only a
            // live fill marks it taken; a dry run is tracked only.
            let tracking = null;
            if (tk.snap && tk.snap.candidateId && hasStore) {
              const out = await writeState((text) => applyTrackChange(text, { action: 'track', entry: trackEntry({ ...tk.snap, symbol: tk.symbol }, now(), { took: r.mode === 'live' && r.simulated !== true }) }, now()));
              tracking = !out ? false : out.result === 'full' ? 'full' : true;
            }
            if (hasStore) await tickets.take(nonce);
            await execSend(formatResultCard(r, tk, { tracking }), null, { ...meta, event: r.mode === 'dry' ? 'dry_ok' : r.simulated === true ? 'simulated' : 'filled' }, phaseMessageId);
          }
        }
      }
    } else if (cmd === 'xmanage' || cmd === 'stops') {
      const st = cmd === 'stops' ? parseStopsArgs(parsed.args) : null;
      if (st && !st.ok) await execSend(escapeHtml(STOPS_USAGE), null, { event: 'usage' });
      else {
        const positions = await chainPositions();
        const key = st ? st.pos : parsed.ref;
        const p = positions ? positions.find((x) => x.ref === key || x.positionId === key) : null;
        const action = st ? 'stops' : parsed.action;
        if (!positions) await reply('Position read from chain failed; try again in a minute.');
        else if (!p) await reply('That position is no longer open. /positions lists open ones.');
        else if (action === 'stops' && !st) await execSend(`Reply: <code>/stops ${escapeHtml(p.ref)} sl PRICE tp PRICE</code> for ${fmtTag(p.symbol, null, p.direction)} (SL now ${fmtLvl(p.stop)}, TP now ${fmtLvl(p.tp)}).`, null, { event: 'stops_prompt', symbol: p.symbol, direction: p.direction });
        else if (action === 'be' && typeof p.entry !== 'number') await reply('No entry price on chain for that position; use Set SL/TP.');
        else if (action === 'half' && typeof p.sizeUsd !== 'number') await reply('No size on chain for that position; use Close.');
        else await manageTicket(action, p, st ? { stop: st.stop, tp: st.tp } : {});
      }
    } else if (cmd === 'exec') {
      const status = await safeStatus();
      if (!status) await execSend('Execution status could not be read; try again in a minute.', null, { event: 'status_failed' });
      else await execSend(formatExecStatus(status, env), null, { event: 'status', mode: execMode(status) });
    } else if (cmd === 'mode') {
      const status = await safeStatus();
      await execSend(formatModeCard(status), null, { event: 'mode', mode: execMode(status) });
    } else if (cmd === 'kill') {
      let ok = false;
      try {
        const r = typeof ex.kill === 'function' ? await ex.kill(ctx(), 'telegram') : null;
        ok = Boolean(r && r.ok === true);
      } catch (err) { log('exec', ` reason=kill_${errName(err)}`); }
      await execSend(ok ? formatKilled() : '⛔ <b>KILL NOT SAVED</b> — set EXECUTION_KILL=true in Vercel now.', null, { event: ok ? 'killed' : 'kill_failed' });
    } else if (cmd === 'arm') {
      if (parsed.args.length) await deleteOwn(); // the PIN must not stay in the chat
      const pin = parsed.args.length === 1 && /^\d{4,8}$/.test(parsed.args[0]) ? parsed.args[0] : null;
      if (!pin) await execSend('Usage: /arm PIN (4–8 digits; the message is deleted after use)', null, { event: 'usage' });
      else if (typeof ex.arm !== 'function') await execSend('Arm is not available in this build; clear the kill flag in Blob or Vercel.', null, { event: 'arm_failed' });
      else {
        let r;
        try { r = await ex.arm(pin, ctx()); } catch (err) { r = { ok: false, error: `arm failed (${errName(err)})` }; }
        if (r && r.ok === true) await execSend(formatArmed(r), null, { event: 'armed' });
        else await execSend(formatConfirmFail(r), null, { event: 'arm_failed' });
      }
    } else if (!parsed.known) {
      await reply(`Unknown command /${escapeHtml(cmd)}. Send /help.`);
    } else if (cmd === 'help' || cmd === 'start') {
      await reply(formatHelp());
    } else if (cmd === 'menu') {
      await reply('Menu is on the keyboard below.');
    } else if (cmd === 'charts') {
      await reply('Pick a chart:', chartsKeyboard());
    } else if (cmd === 'signals') {
      const payload = filterPayload(await build(), { compact: true });
      const state = hasStore ? await readState() : null;
      await reply(formatSignals(payload, now()), signalsKeyboard(payload, state ? state.tracked : []) || menuKeyboard());
      // The blocks' buttons must outlive the flag: keep their snapshots (best effort).
      const snaps = signalsSnapshots(payload);
      if (hasStore && snaps.length) await writeState((text) => applyButtonSnapshots(text, snaps, now()));
    } else if (cmd === 'why') {
      const sym = parseSymbol(parsed.args[0]);
      if (!sym) await reply('Usage: /why BTC (BTC, ETH or SOL)');
      else {
        const payload = await build({ includeModel: true });
        await reply(formatWhy(sym, payload && payload.symbols ? payload.symbols[sym] : null));
      }
    } else if (cmd === 'flags') {
      const sym = parsed.args[0] ? parseSymbol(parsed.args[0]) : null;
      if (parsed.args[0] && !sym) await reply('Usage: /flags [BTC|ETH|SOL]');
      else {
        // One full build (candles for the charts); the text summary reads its compact view.
        const payload = await build();
        await reply(formatFlags(filterPayload(payload, { compact: true }), sym));
        await sendFlagAlbums({ bot, chatId, payload, only: sym, render, reply });
      }
    } else if (cmd === 'wallet') {
      const payload = await build();
      await reply(formatWallet(payload && payload.account));
    } else if (cmd === 'journal') {
      if (!hasStore) await reply('Journal store unavailable.');
      else await reply(formatJournal(await readRecent(store, parseJournalN(parsed.args[0])), now()));
    } else if (cmd === 'status') {
      const payload = filterPayload(await build(), { compact: true });
      let state = null;
      let health = null;
      if (hasStore) {
        state = await readState();
        try { const blob = await readBlob(get, TELEGRAM_HEALTH_PATH); health = parseHealth(blob ? blob.text : null); } catch (err) { log('health', errMsg(err)); health = null; }
      }
      await reply(formatStatus(payload, state, now(), health));
    } else if (cmd === 'chart') {
      let request;
      try {
        request = parseChartArg(`${parsed.args[0] || ''}:${parsed.args[1] || '5m'}`);
      } catch (err) {
        if (!(err instanceof ChartRequestError)) throw err;
        await reply(`${escapeHtml(err.message)}\nUsage: /chart BTC 5m`);
        request = null;
      }
      if (request) {
        let series;
        const payload = await build({ chart: { ...request, onSeries: (s) => { series = s; } } });
        try {
          const chart = await render(payload, request, series);
          const sent = await bot.sendPhoto(chatId, chart.png, `${escapeHtml(request.symbol)} ${escapeHtml(request.timeframe)} · closed through ${escapeHtml(payload && payload.closedThrough ? payload.closedThrough.slice(11, 16) : 'n/a')} UTC`);
          if (!sent.ok) await reply('Chart could not be sent.');
        } catch (err) {
          if (!(err instanceof ChartRequestError)) throw err;
          await reply(escapeHtml(err.message));
        }
      }
    } else if (cmd === 'log') {
      if (!parsed.rest) await reply('Usage: /log took BTC long entry 84600 stop 84390 tp 85100');
      else if (!hasStore) await reply('Journal store unavailable.');
      else {
        // The update id makes a Telegram redelivery idempotent (the journal dedupes by id).
        const updateId = update && Number.isFinite(update.update_id) ? update.update_id : null;
        const checked = validateJournalEntry(parseLogText(parsed.rest), {
          now: now(),
          newId: () => (updateId !== null ? `tg_${updateId}` : `j_${crypto.randomUUID().replace(/-/g, '')}`),
          source: 'telegram'
        });
        if (!checked.ok) await reply(`Not logged: ${escapeHtml(checked.errors.join('; '))}`);
        else {
          const { duplicate } = await appendRecord(store, checked.record);
          await reply(`[LOGGED ${escapeHtml(checked.record.id)}]${duplicate ? ' (already logged)' : ''}`);
        }
      }
    } else if (cmd === 'alerts') {
      const a = parseAlertsArgs(parsed.args);
      if (a.action === 'error') await reply(escapeHtml(a.message));
      else if (!hasStore) await reply('Alert settings store unavailable.');
      else if (a.action === 'show' || a.action === 'quiet_show') {
        const state = await readState();
        if (!state) {
          await reply('Alert settings could not be read; try again in a minute.');
          log(200, ` cmd=${via}${cmd}`);
          return res.status(200).json({ ok: true });
        }
        const prefs = state.prefs;
        if (a.action === 'show') await reply(formatAlertPrefs(prefs), alertsKeyboard());
        else await reply(`Quiet hours: ${fmtQuiet(prefs.quiet)}`);
      } else {
        // Same ETag-guarded update as the cron, so a concurrent cron run cannot lose it.
        const change = a.action === 'level' ? { level: a.level }
          : a.action === 'tf' ? { alertTimeframes: a.alertTimeframes }
            : { quiet: a.action === 'quiet_off' ? null : a.quiet };
        let prefs = null;
        let resetCause = null;
        let saved = true;
        try {
          await updateBlob(store, TELEGRAM_STATE_PATH, 'application/json', (text) => {
            const m = migrateState(text);
            resetCause = m.reset ? m.reason : null;
            const next = applyPrefsChange(text, change);
            prefs = migrateState(next).state.prefs;
            return next;
          });
        } catch (err) {
          saved = false;
          log('state', ` reason=state_write_${err && err.name ? err.name : 'Error'} msg=${JSON.stringify(errText(err, secrets))}`);
        }
        if (resetCause) log('state', ` reason=state_reset cause=${resetCause}`);
        if (saved) await reply(`Saved.\n${formatAlertPrefs(prefs)}`, alertsKeyboard());
        else await reply('Alert settings could not be saved; try again in a minute.');
      }
    } else if (cmd === 'button_log') {
      if (!hasStore) await reply('Journal store unavailable.');
      else {
        const state = await readState();
        let snap = findButtonSnapshot(state, null, parsed.symbol, parsed.ref);
        if (!snap) snap = findButtonSnapshot(null, filterPayload(await build(), { compact: true }), parsed.symbol, parsed.ref);
        if (!snap) await reply(`That ${escapeHtml(parsed.symbol)} plan is no longer on file. Use /log to journal it by hand.`);
        else {
          const checked = validateJournalEntry(buttonLogBody(parsed.kind, snap, parsed.ref), { now: now(), newId: () => `tg_${parsed.kind}_${parsed.ref}`, source: 'telegram' });
          if (!checked.ok) await reply(`Not logged: ${escapeHtml(checked.errors.join('; '))}`);
          else {
            const { duplicate } = await appendRecord(store, checked.record);
            let note = '';
            if (parsed.kind === 'open') {
              // Took it implies Track: TP1 / stop on this trade alert from now on.
              const out = await writeState((text) => applyTrackChange(text, { action: 'track', entry: trackEntry({ ...snap, symbol: parsed.symbol }, now(), { took: true }) }, now()));
              note = out && out.result === 'full' ? ` · tracking list full (${TRACK_MAX}); untrack one` : out ? ` · tracking ${fmtTag(parsed.symbol, snap.timeframe, snap.direction)} for TP1 / stop` : ' · tracking could not be saved';
              if (out && out.result !== 'full') await swapOriginal(parsed.ref, true);
            }
            await reply(`[LOGGED ${escapeHtml(checked.record.id)}]${duplicate ? ' (already logged)' : ''}${note}`);
          }
        }
      }
    } else if (cmd === 'plan' || cmd === 'thesis') {
      const payload = filterPayload(await build(), { compact: true });
      const state = hasStore ? await readState() : null;
      const v = resolveRef(parsed.ref, payload, state);
      if (!v) await reply(EXPIRED_REPLY);
      else {
        const tracked = Boolean(state && Array.isArray(state.tracked) && state.tracked.some((t) => t && t.ref === parsed.ref));
        let kb = v.source === 'live' ? tradeKeyboard(v.symbol, v.candidate.timeframe, v.candidateId, { tracked }) : menuKeyboard();
        if (cmd === 'plan' && ex && isOpenReady(v)) kb = withOpenButton(kb, v.candidateId);
        await reply(cmd === 'plan' ? formatPlanCard(v) : formatThesisCard(v), kb);
      }
    } else if (cmd === 'track' || cmd === 'untrack') {
      if (!hasStore) await reply('Tracking store unavailable.');
      else if (cmd === 'untrack') {
        const out = await writeState((text) => applyTrackChange(text, { action: 'untrack', ref: parsed.ref }, now()));
        if (!out) await reply('Tracking could not be saved; try again in a minute.');
        else {
          const e = out.before;
          await reply(out.result === 'untracked' && e ? `Untracked ${fmtTag(e.symbol, e.timeframe, e.direction)}.` : 'Not tracked.');
          await swapOriginal(parsed.ref, false);
        }
      } else {
        const payload = filterPayload(await build(), { compact: true });
        const state = await readState();
        const v = resolveRef(parsed.ref, payload, state);
        const snap = v ? (v.source === 'live' ? candidateSnapshot(v.symbol, v.s, v.candidateId) : v.snap) : null;
        if (!v || !snap) await reply(EXPIRED_REPLY);
        else {
          const entry = trackEntry({ ...snap, symbol: v.symbol, state: v.candidate.state || snap.state || snap.lastState }, now(), {
            ready: Boolean(v.plan && v.plan.status === 'ready'), setupSeen: Boolean(v.setup)
          });
          const out = await writeState((text) => applyTrackChange(text, { action: 'track', entry }, now()));
          const tag = fmtTag(entry.symbol, entry.timeframe, entry.direction);
          if (!out) await reply('Tracking could not be saved; try again in a minute.');
          else if (out.result === 'full') await reply(`Tracking list is full (${TRACK_MAX}). Untrack one in /tracking first.`);
          else {
            await reply(`${out.result === 'already' ? 'Already tracking' : 'Tracking'} ${tag} · brk ${fmtLvl(entry.breakoutLevel)} · alerts on every change`,
              tradeKeyboard(entry.symbol, entry.timeframe, entry.candidateId, { tracked: true }));
            await swapOriginal(parsed.ref, true);
          }
        }
      }
    } else if (cmd === 'market') {
      // Full build with bias (4h/1h lean, top-down, 1h/4h candles); the FLAGS line reads state.
      const payload = await build({ includeBias: true });
      const state = hasStore ? await readState() : null;
      await reply(formatMarket(payload, state, now()));
    } else if (cmd === 'tracking') {
      const state = hasStore ? await readState() : null;
      if (!state) await reply('Tracking store unavailable.');
      else await reply(formatTrackingList(state.tracked, now()), trackingKeyboard(state.tracked, now()) || menuKeyboard());
    } else if (cmd === 'positions') {
      if (!hasStore) await reply('Journal store unavailable.');
      else {
        let opens = openPositions(await readRecent(store, 50));
        if (!ex) {
          const payload = opens.length ? filterPayload(await build(), { compact: true }) : null;
          await reply(formatPositions(opens, payload, now()), positionsKeyboard(opens) || menuKeyboard());
        } else {
          // Live chain read first (manage buttons), then journal opens the chain does not already show.
          const [chain, status] = await Promise.all([chainPositions(), safeStatus()]);
          const onChain = new Set((chain || []).map((p) => `${p.symbol}|${p.direction}`));
          opens = opens.filter((o) => !(o.source === 'execution' && onChain.has(`${o.symbol}|${o.direction}`)));
          const payload = opens.length ? filterPayload(await build(), { compact: true }) : null;
          const chainText = chain ? formatChainPositions(chain, { mode: execMode(status) }) : '⛓ <b>ON CHAIN</b>\nChain read unavailable; try again in a minute.';
          const text = `${chainText}\n${RULE}\n<b>JOURNAL</b>\n${formatPositions(opens, payload, now())}`;
          const rows = [...chainPositionsKeyboardRows(chain || []), ...((positionsKeyboard(opens) || {}).inline_keyboard || [])];
          await execSend(text, rows.length ? { inline_keyboard: rows } : null, { event: 'positions', mode: execMode(status) });
        }
      }
    } else if (cmd === 'stillin') {
      if (!hasStore) await reply('Tracking store unavailable.');
      else {
        const out = await writeState((text) => applyTrackChange(text, { action: 'stillin', ref: parsed.ref }, now()));
        const e = out && out.entry;
        await reply(out && out.result === 'rearmed' && e
          ? `Still in · ${fmtTag(e.symbol, e.timeframe, e.direction)} · watching TP1 ${fmtLvl(e.tp1)} and stop ${fmtLvl(e.stop)} again.`
          : 'That trade is not tracked any more. /positions lists open trades.');
      }
    } else if (cmd === 'closed' || cmd === 'partial' || cmd === 'pclose') {
      if (!hasStore) await reply('Journal store unavailable.');
      else {
        const opens = openPositions(await readRecent(store, 50));
        const open = opens.find((o) => positionRef(o) === parsed.ref);
        const state = await readState();
        const t = state && Array.isArray(state.tracked) ? state.tracked.find((x) => x && x.ref === parsed.ref) : null;
        if (!open) await reply('No open trade on file for that button. /positions lists open trades; /log closes one by hand.');
        else {
          // Closed here / Partial: the hit price the alert quoted; Close @ mark: the live mark (Kraken close if no mark).
          let exit = cmd !== 'pclose' && t && t.hit ? { price: t.hit.price, src: t.hit.src || 'mark' } : null;
          if (!exit) {
            const payload = filterPayload(await build(), { compact: true });
            exit = livePrice(payload && payload.symbols ? payload.symbols[open.symbol] : null);
          }
          if (!exit) await reply(`No live price for ${escapeHtml(open.symbol)}; close it with /log.`);
          else {
            const kind = cmd === 'partial' ? 'adjust' : 'close';
            const body = closeBody(open, { kind, exitPrice: exit.price, src: exit.src, ref: parsed.ref, levels: t });
            const checked = validateJournalEntry(body, { now: now(), newId: () => body.id, source: 'telegram' });
            if (!checked.ok) await reply(`Not logged: ${escapeHtml(checked.errors.join('; '))}`);
            else {
              const { duplicate } = await appendRecord(store, checked.record);
              if (kind === 'close') await writeState((text) => applyTrackChange(text, { action: 'closed', ref: parsed.ref }, now()));
              await reply(`[LOGGED ${escapeHtml(checked.record.id)}]${duplicate ? ' (already logged)' : ''} · ${escapeHtml(checked.record.text)}`);
            }
          }
        }
      }
    } else if (cmd === 'testalert') {
      const payload = await build();
      const { symbol, sample, chart } = testAlertSample(payload);
      await reply(formatGoodAlert(symbol, sample, payload, { nowMs: now(), test: true }));
      try {
        const png = await render(payload, chart);
        await bot.sendPhoto(chatId, png.png, `TEST · ${escapeHtml(chart.symbol)} ${escapeHtml(chart.timeframe)} chart`);
      } catch (err) {
        if (!(err instanceof ChartRequestError)) throw err;
        await reply(`TEST chart unavailable: ${escapeHtml(err.message)}`);
      }
    }
    log(200, ` cmd=${via}${cmd || 'none'}`);
  } catch (err) {
    log(200, ` cmd=${via}${cmd || 'none'} error=${JSON.stringify(String(err && err.name ? err.name : 'Error'))} msg=${JSON.stringify(errText(err, secrets))}`);
    await reply('Something failed on the server; try again in a minute.');
  }
  return res.status(200).json({ ok: true });
}
