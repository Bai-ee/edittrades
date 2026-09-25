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
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet } from '@vercel/blob';
import { buildScalpContext, filterPayload } from '../services/scalpContext.js';
import { parseChartArg, renderContextChart, ChartRequestError } from '../lib/chartRender.js';
import { validateJournalEntry } from '../lib/journalSchema.js';
import { readBlob, updateBlob } from '../lib/blobJsonl.js';
import { appendRecord, readRecent } from './journal.js';
import {
  createBotClient, parseAllowedIds, isAllowed, parseCommand, parseSymbol, parseJournalN, parseLogText,
  formatSignals, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatHelp, formatGoodAlert,
  parseState, escapeHtml, TELEGRAM_STATE_PATH, parseAlertsArgs, applyPrefsChange, formatAlertPrefs, fmtQuiet,
  parseMenuLabel, menuKeyboard, chartsKeyboard, alertsKeyboard, signalsKeyboard, parseCallbackData, buttonLogBody, findButtonSnapshot,
  collectLiveFlags, capFlagCharts, formatFlagCaption, formatNoLiveFlags, chunkMediaGroup, albumSeries, MAX_FLAG_CHARTS, FLAG_CHART_BUDGET_MS
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
    build = buildScalpContext, put = blobPut, get = blobGet, fetchImpl = globalThis.fetch,
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
  const store = { put, get };
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
      await reply(formatSignals(payload, now()), signalsKeyboard(payload) || menuKeyboard());
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
      if (hasStore) {
        try { const blob = await readBlob(get, TELEGRAM_STATE_PATH); state = parseState(blob ? blob.text : null); } catch { state = null; }
      }
      await reply(formatStatus(payload, state, now()));
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
        const blob = await readBlob(get, TELEGRAM_STATE_PATH);
        const prefs = parseState(blob ? blob.text : null).prefs;
        if (a.action === 'show') await reply(formatAlertPrefs(prefs), alertsKeyboard());
        else await reply(`Quiet hours: ${fmtQuiet(prefs.quiet)}`);
      } else {
        // Same ETag-guarded update as the cron, so a concurrent cron run cannot lose it.
        const change = a.action === 'level' ? { level: a.level } : { quiet: a.action === 'quiet_off' ? null : a.quiet };
        let prefs = null;
        await updateBlob(store, TELEGRAM_STATE_PATH, 'application/json', (text) => {
          const next = applyPrefsChange(text, change);
          prefs = parseState(next).prefs;
          return next;
        });
        await reply(`Saved.\n${formatAlertPrefs(prefs)}`, alertsKeyboard());
      }
    } else if (cmd === 'button_log') {
      if (!hasStore) await reply('Journal store unavailable.');
      else {
        let state = null;
        try { const blob = await readBlob(get, TELEGRAM_STATE_PATH); state = parseState(blob ? blob.text : null); } catch { state = null; }
        let snap = findButtonSnapshot(state, null, parsed.symbol, parsed.ref);
        if (!snap) snap = findButtonSnapshot(null, filterPayload(await build(), { compact: true }), parsed.symbol, parsed.ref);
        if (!snap) await reply(`That ${escapeHtml(parsed.symbol)} plan is no longer on file. Use /log to journal it by hand.`);
        else {
          const checked = validateJournalEntry(buttonLogBody(parsed.kind, snap, parsed.ref), { now: now(), newId: () => `tg_${parsed.kind}_${parsed.ref}`, source: 'telegram' });
          if (!checked.ok) await reply(`Not logged: ${escapeHtml(checked.errors.join('; '))}`);
          else {
            const { duplicate } = await appendRecord(store, checked.record);
            await reply(`[LOGGED ${escapeHtml(checked.record.id)}]${duplicate ? ' (already logged)' : ''}`);
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
    log(200, ` cmd=${via}${cmd || 'none'} error=${JSON.stringify(String(err && err.name ? err.name : 'Error'))}`);
    await reply('Something failed on the server; try again in a minute.');
  }
  return res.status(200).json({ ok: true });
}
