/**
 * Vercel Serverless Function: Telegram bot webhook (T-1, docs/PLAN_TELEGRAM.md)
 * POST /api/telegram-webhook - one Telegram update per call
 *
 * Read commands plus journal logging, answered with the Bot API (lib/telegram.js).
 * Read-only toward the engine: it builds the same context as /api/scalp-context and the
 * MCP tool, and writes only journal lines through api/journal.js's own append path and
 * the owner's alert prefs (`/alerts`) into the cron's `telegram/state.json`. It
 * never imports or reaches an execution, signing or wallet-writing module, and there is
 * no /buy, /sell, /open or /close command.
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
  EXPIRED_REPLY, TRACK_MAX, formatMarket, fmtTag, fmtLvl
} from '../lib/telegram.js';

// /flags renders up to 9 charts and sends several Bot API requests (5 s each at most)
// after one build; 60 s keeps that inside the function limit (Pro allows it).
export const config = { maxDuration: 60 };

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

  try {
    if (!parsed) {
      await reply(cq ? 'That button is no longer valid. Send /menu.' : 'Send /help for the command list.');
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
        const kb = v.source === 'live' ? tradeKeyboard(v.symbol, v.candidate.timeframe, v.candidateId, { tracked }) : menuKeyboard();
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
        const opens = openPositions(await readRecent(store, 50));
        const payload = opens.length ? filterPayload(await build(), { compact: true }) : null;
        await reply(formatPositions(opens, payload, now()), positionsKeyboard(opens) || menuKeyboard());
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
