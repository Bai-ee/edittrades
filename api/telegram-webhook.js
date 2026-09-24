/**
 * Vercel Serverless Function: Telegram bot webhook (T-1, docs/PLAN_TELEGRAM.md)
 * POST /api/telegram-webhook - one Telegram update per call
 *
 * Read commands plus journal logging, answered with the Bot API (lib/telegram.js).
 * Read-only toward the engine: it builds the same context as /api/scalp-context and the
 * MCP tool, and writes only journal lines through api/journal.js's own append path. It
 * never imports or reaches an execution, signing or wallet-writing module, and there is
 * no /buy, /sell, /open or /close command.
 *
 * Gates, in order: POST only (405); TELEGRAM_WEBHOOK_SECRET and TELEGRAM_BOT_TOKEN
 * configured (else 503 with a reason); `X-Telegram-Bot-Api-Secret-Token` equals the
 * secret (else 403); sender id in TELEGRAM_ALLOWED_USER_IDS (else 200 and silence).
 * Every accepted update answers 200 so Telegram does not redeliver it. Secrets, message
 * text and user ids are never logged.
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet } from '@vercel/blob';
import { buildScalpContext, filterPayload } from '../services/scalpContext.js';
import { parseChartArg, renderContextChart, ChartRequestError } from '../lib/chartRender.js';
import { validateJournalEntry } from '../lib/journalSchema.js';
import { readBlob } from '../lib/blobJsonl.js';
import { appendRecord, readRecent } from './journal.js';
import {
  createBotClient, parseAllowedIds, isAllowed, parseCommand, parseSymbol, parseJournalN, parseLogText,
  formatSignals, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatHelp, formatGoodAlert,
  parseState, escapeHtml, TELEGRAM_STATE_PATH
} from '../lib/telegram.js';

function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

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
  const msg = update && (update.message || update.edited_message);
  const fromId = msg && msg.from ? msg.from.id : null;
  const chatId = msg && msg.chat ? msg.chat.id : null;
  if (!msg || chatId === null) {
    log(200, ' ignored=no_message');
    return res.status(200).json({ ok: true });
  }
  if (!isAllowed(fromId, parseAllowedIds(env.TELEGRAM_ALLOWED_USER_IDS))) {
    log(200, ' allowed=false');
    return res.status(200).json({ ok: true });
  }

  const bot = createBotClient({ token: env.TELEGRAM_BOT_TOKEN, fetchImpl });
  const reply = (text) => bot.sendMessage(chatId, text);
  const hasStore = Boolean(deps.put || deps.get || env.BLOB_READ_WRITE_TOKEN);
  const store = { put, get };
  const parsed = parseCommand(typeof msg.text === 'string' ? msg.text : '');
  const cmd = parsed ? parsed.cmd : null;

  try {
    if (!parsed) {
      await reply('Send /help for the command list.');
    } else if (!parsed.known) {
      await reply(`Unknown command /${escapeHtml(cmd)}. Send /help.`);
    } else if (cmd === 'help' || cmd === 'start') {
      await reply(formatHelp());
    } else if (cmd === 'signals') {
      const payload = filterPayload(await build(), { compact: true });
      await reply(formatSignals(payload, now()));
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
      else await reply(formatFlags(filterPayload(await build(), { compact: true }), sym));
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
    log(200, ` cmd=${cmd || 'none'}`);
  } catch (err) {
    log(200, ` cmd=${cmd || 'none'} error=${JSON.stringify(String(err && err.name ? err.name : 'Error'))}`);
    await reply('Something failed on the server; try again in a minute.');
  }
  return res.status(200).json({ ok: true });
}
