/**
 * Deterministic tests for the Telegram bot (T-1, docs/PLAN_TELEGRAM.md): lib/telegram.js
 * formatters (every class, SETUP line, DATA block), the alert state machine (transitions,
 * dedup, data/mark persistence and rate limit, heartbeat), command and /log parsing (the
 * /log body must validate against the journal schema), api/telegram-webhook.js (method,
 * secret 403, allowlist silence, commands, /log through the journal's own append path)
 * and api/telegram-cron.js (401, 503 reasons, send-once under overlapping runs), alert
 * levels (good/setup/watch), WATCH dedup + cooldown, Chicago quiet hours (DST), the reply
 * keyboard and inline buttons (callback_query, Took it / Skipped journaling), the Plan /
 * Thesis cards, tracking (transitions, TP1/stop, nudge), /positions and close journaling,
 * timeframe focus, /market and the visual layout, plus
 * isolation: no execution, signing or wallet-writing import anywhere reachable.
 * All HTTP (Bot API, Blob) is an in-memory fake; no network.
 *
 * Run: node test-telegram.js
 */

import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  escapeHtml, fmtPrice, chunkMessage, parseAllowedIds, isAllowed, parseCommand, parseSymbol, parseJournalN, parseLogText,
  formatSignalLine, formatSetupBrief, formatSetupAlert, formatSignals, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatSetupLine,
  formatGoodAlert, emptyState, parseState, diffAlerts, createBotClient, inQuietHours, COMMANDS,
  formatWatchAlert, formatAlertPrefs, parseAlertsArgs, parseQuietSpec, normalizePrefs, applyPrefsChange, chicagoHour,
  WATCH_COOLDOWN_MS, WATCH_RECENT_IDS, DEFAULT_QUIET_HOURS, alertSignature, SIGNATURE_TTL_MS, SIGNATURE_TOLERANCE,
  collectLiveFlags, capFlagCharts, formatFlagLine, formatFlagCaption, formatNoLiveFlags, chunkMediaGroup, emaTailSeries, albumSeries,
  LIVE_FLAG_STATES, MAX_FLAG_CHARTS, MAX_MEDIA_GROUP, formatBreakoutAlert, BREAKOUT_RECENT_IDS, formatCall,
  MENU_ROWS, parseMenuLabel, menuKeyboard, chartsKeyboard, alertsKeyboard, shortRef, tradeButtonRows, tradeKeyboard, signalsKeyboard,
  parseCallbackData, MAX_CALLBACK_BYTES, BUTTON_MEMORY, ALLOWED_UPDATES, hitKeyboard,
  HEALTH_PERSIST_MS, HEALTH_REPEAT_MS, HEARTBEAT_WRITE_MS, MAX_MESSAGE_CHARS, TELEGRAM_STATE_PATH,
  migrateState, STATE_VERSION, TELEGRAM_HEALTH_PATH, parseHealth, nextCronHealth, errText, CRON_FAIL_ALERT_AFTER, CRON_FAIL_REPEAT_MS,
  RULE, MAX_CARD_CHARS, resolveRef, formatPlanCard, formatThesisCard, reasonPhrase, rMultiple, trackEntry, applyTrackChange, formatTrackingList, trackingKeyboard,
  diffTracked, openPositions, positionRef, formatPositions, positionsKeyboard, closeBody, candidateSnapshot, swapTrackButton, parseAlertTimeframes,
  TRACK_MAX, TRACK_TTL_MS, NUDGE_AFTER_MS, EXPIRED_REPLY, liveView, formatMarket, marketLean, formatHelp
} from './lib/telegram.js';
import { validateJournalEntry, RECORD_KEYS } from './lib/journalSchema.js';
import { handleTelegramWebhook, testAlertSample, sendFlagAlbums, config as webhookConfig } from './api/telegram-webhook.js';
import { handleTelegramCron } from './api/telegram-cron.js';
import { telegramStatusFromState, pullTelegramStatus } from './scripts/tracker/collect.js';
import { alertsFact } from './scripts/tracker/build-page.js';

const root = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- fixtures

const T0 = Date.parse('2026-09-24T14:05:30.000Z');
const MIN = 60_000;
const TOKEN = '123456:TEST-TOKEN-never-printed';
const SECRET = 'webhook-secret-xyz';
const CRON = 'cron-secret-abc';
const OWNER = 111222333;
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_USER_IDS: `${OWNER}, 444`, TELEGRAM_WEBHOOK_SECRET: SECRET, CRON_SECRET: CRON };
const BASE = 'https://fakestore.public.blob.vercel-storage.com';

const markOk = { price: 84610.2, driftBps: 1.2, status: 'ok' };
const setupEth = { candidateId: 'ETH:3m:short:2026-09-24T14:00:00.000Z', timeframe: '3m', direction: 'short', entry: 2601.5, stop: 2612, tp1: 2575, grossRR: 2.52, netRR: 1.9, entryCondition: '3m close below 2601.5 then a retest that holds under it' };

function goodSym(candidateId = 'BTC:5m:long:2026-09-24T13:50:00.000Z', closedThrough = '2026-09-24T14:05:00.000Z') {
  return {
    price: 84600,
    mark: markOk,
    candidateSetups: [{ candidateId, type: 'flag', timeframe: '5m', direction: 'long', state: 'confirmed', confidence: 72, breakoutLevel: 84600, invalidation: 84390, measuredTarget: 85200, qual: { decision: 'actionable' } }],
    flagTradePlan: { planId: `${candidateId}|${closedThrough}|cfg`, candidateId, status: 'ready', reasonCode: null, timeframe: '5m', direction: 'long', entry: 84600, stop: 84390, tp1: 85146, tp2: 85300, grossRR: 2.6, netRR: 2.1 },
    flagRecommendation: {
      class: 'GOOD', setupId: `${candidateId}|${closedThrough}|cfg`, candidateId, readiness: 'ready', qualityBand: 'high', setup: null,
      primaryReason: { code: 'ready_flag_plan', text: 'The engine-owned long flag plan is ready at 84600.' },
      changeConditions: [{ code: 'call_changes_on_invalidation', text: 'Call changes if price invalidates the plan at 84390, TP1 becomes blocked below 2.5R gross, or required data goes stale.' }]
    }
  };
}

function watchSym(setup = null, mark = markOk) {
  return {
    price: 2600, mark, candidateSetups: [], flagTradePlan: null,
    flagRecommendation: {
      class: 'WATCH', setupId: null, candidateId: null, readiness: 'no_plan', setup,
      primaryReason: { code: 'need_confirmed_flag_plan', text: 'A flag must form <and> confirm.' },
      changeConditions: [{ code: 'need_confirmed_flag_plan', text: 'A 3m flag must confirm above 2610.' }]
    }
  };
}

function badSym() {
  return {
    price: 150, mark: { price: 150.1, driftBps: 6.7, status: 'ok' }, candidateSetups: [],
    flagTradePlan: { planId: 'SOL:1m:long:x|t|cfg', candidateId: 'SOL:1m:long:x', status: 'rejected', reasonCode: 'rr_below_min', timeframe: '1m', direction: 'long', entry: 150, stop: 149, tp1: 151, grossRR: 1, netRR: 0.6 },
    flagRecommendation: {
      class: 'BAD', setupId: 'SOL:1m:long:x|t|cfg', candidateId: 'SOL:1m:long:x', readiness: 'rejected', setup: null,
      primaryReason: { code: 'rr_below_min', text: 'The engine rejected the flag plan: gross R:R to TP1 is 1, below the 2.5R floor.' },
      changeConditions: [{ code: 'new_valid_plan', text: 'A new plan with at least 2.5R gross.' }]
    }
  };
}

const TD_REC = { supports: ['td:bull:3/4'], opposes: [], unknowns: [] };
function cand(id, candState = 'forming', extra = {}) {
  return { candidateId: id, type: 'flag', timeframe: '3m', direction: 'long', state: candState, breakoutLevel: 84466.1, invalidation: 84331.6, measuredRR: 2.43, ...extra };
}
/** A WATCH-class symbol carrying flag candidates (default: one forming BTC 3m long). */
function formSym(cands = [cand('BTC:3m:long:2026-09-24T14:00:00.000Z')], setup = null) {
  const w = watchSym(setup);
  return { ...w, candidateSetups: cands, flagRecommendation: { ...w.flagRecommendation, ...TD_REC } };
}
const withPrefs = (level, quiet = { ...DEFAULT_QUIET_HOURS }) => ({ ...emptyState(), prefs: { level, quiet } });

function payload({ BTC = goodSym(), ETH = watchSym(), SOL = badSym(), closedThrough = '2026-09-24T14:05:00.000Z', dataStatus = 'complete' } = {}) {
  return {
    schemaVersion: '1.25.0', configVersion: '2026.09.24-5', generatedAt: '2026-09-24T14:05:20.000Z', closedThrough, dataStatus,
    account: { status: 'unavailable', reason: 'rpc down', margin: { usd: null }, holdingsUsd: null, gas: { sol: null }, performance: {} },
    symbols: { BTC, ETH, SOL }, warnings: []
  };
}

/** In-memory Vercel Blob with ETags, same semantics as test-journal.js's fake. */
function fakeBlob() {
  const files = new Map();
  let n = 0;
  const state = { files, puts: 0 };
  state.get = async (pathname) => {
    await Promise.resolve();
    const f = files.get(pathname);
    if (!f) return null;
    return { statusCode: 200, stream: new Response(f.text).body, blob: { etag: f.etag, url: `${BASE}/${pathname}` } };
  };
  state.put = async (pathname, body, opts) => {
    await Promise.resolve();
    state.puts++;
    const cur = files.get(pathname);
    if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) { const e = new Error('Precondition failed'); e.name = 'BlobPreconditionFailedError'; throw e; }
    if (!opts.ifMatch && opts.allowOverwrite === false && cur) { const e = new Error('This blob already exists'); e.name = 'BlobAccessError'; throw e; }
    files.set(pathname, { text: String(body), etag: `"e${++n}"` });
    return { url: `${BASE}/${pathname}`, pathname };
  };
  return state;
}

/** Fake Bot API: records every call (method, chat, text or multipart), answers ok. */
function fakeTelegram({ fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const m = String(url).match(/\/bot([^/]+)\/(\w+)$/);
    const entry = { tokenOk: m && m[1] === TOKEN, method: m ? m[2] : null };
    if (init.body instanceof FormData) {
      entry.chatId = init.body.get('chat_id');
      entry.caption = init.body.get('caption');
      entry.photo = init.body.get('photo');
      const media = init.body.get('media');
      if (media) {
        entry.media = JSON.parse(media);
        entry.files = entry.media.map((m) => init.body.get(m.media.replace('attach://', '')));
      }
    } else {
      const b = JSON.parse(init.body);
      Object.assign(entry, { chatId: String(b.chat_id), text: b.text, parseMode: b.parse_mode, silent: b.disable_notification, replyMarkup: b.reply_markup, callbackQueryId: b.callback_query_id });
    }
    calls.push(entry);
    if (fail) throw Object.assign(new Error('network down'), { name: 'TypeError' });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  return { calls, fetchImpl };
}

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; }
  };
}

const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const fakeRender = async () => ({ png: fakePng, bytes: fakePng.length, durationMs: 1 });

async function quiet(fn) {
  const logs = [];
  const [log, warn] = [console.log, console.warn];
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  try { return { value: await fn(), logs }; } finally { console.log = log; console.warn = warn; }
}

let updateSeq = 1000;
async function hook({ text, from = OWNER, secret = SECRET, method = 'POST', env = ENV, blob = fakeBlob(), tg = fakeTelegram(), build = async () => payload(), nowMs = T0, updateId, render = fakeRender }) {
  const update = { update_id: updateId ?? updateSeq++, message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } };
  const req = { method, headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) };
  const res = mockRes();
  const { logs } = await quiet(() => handleTelegramWebhook(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, render, now: () => nowMs, env }));
  return { res, tg, blob, logs };
}

/** A button tap: a callback_query update from `from`, on a message in the owner chat. */
async function tap({ data, from = OWNER, blob = fakeBlob(), tg = fakeTelegram(), build = async () => payload(), nowMs = T0, markup = null }) {
  const update = { update_id: updateSeq++, callback_query: { id: `cbq${updateSeq}`, from: { id: from }, message: { message_id: 9, chat: { id: from, type: 'private' }, ...(markup ? { reply_markup: markup } : {}) }, data } };
  const req = { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(update) };
  const res = mockRes();
  const { logs } = await quiet(() => handleTelegramWebhook(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, render: fakeRender, now: () => nowMs, env: ENV }));
  return { res, tg, blob, logs };
}

/** The KIND of a visual-layout message ("🟢 ₿ <b>BTC 5m ▲ LONG</b> · GOOD" -> GOOD). */
const kindOf = (t) => { const m = String(t || '').split('\n').find((l) => l.includes('</b> · ')); const k = m ? m.match(/<\/b> · ([A-Z][A-Z ]*?)(?: · |$)/) : null; return k ? k[1] : null; };
/** Status rows are padded monospace; collapse "Key:    value" to "Key: value" for substring checks. */
const unpad = (t) => String(t || '').replace(/: {2,}/g, ': ');
const allCallbackData = (markup) => (markup && markup.inline_keyboard ? markup.inline_keyboard.flat().map((b) => b.callback_data) : []);

async function cron({ auth = `Bearer ${CRON}`, env = ENV, blob = fakeBlob(), tg = fakeTelegram(), build = async () => payload(), nowMs = T0 }) {
  const req = { method: 'GET', headers: auth ? { authorization: auth } : {} };
  const res = mockRes();
  const { logs } = await quiet(() => handleTelegramCron(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, render: fakeRender, now: () => nowMs, env }));
  return { res, tg, blob, logs };
}

// ---------------------------------------------------------------- tests

async function run() {
  console.log('formatters');

  await test('/signals lines: <b>VERDICT</b> · SYM · reason (GOOD, WATCH, BAD, DATA_UNAVAILABLE); SETUP line after its asset', () => {
    assertEqual(formatSignalLine('BTC', goodSym()), '<b>GET IN NOW</b> · BTC · 5m LONG · retest held · entry 84,600.00 · stop 84,390.00 · TP1 85,146.00 (2.6R) · net 2.1R', 'good');
    assertEqual(formatSignalLine('ETH', watchSym()), '<b>STAND DOWN</b> · ETH · no flag setup', 'watch, nothing forming');
    assertEqual(formatSignalLine('SOL', badSym()), '<b>STAND DOWN</b> · SOL · 1R room to 151.00; needs 2.5R', 'bad rr');
    assertEqual(formatSignalLine('SOL', { flagRecommendation: { class: 'DATA_UNAVAILABLE' } }), '<b>STAND DOWN</b> · SOL · market data unavailable', 'no data');
    assertEqual(formatSetupBrief('ETH', setupEth), 'SETUP · ETH 3m SHORT · entry 2,601.50 · stop 2,612.00 · TP1 2,575.00 (2.5R)', 'setup line');
    assertEqual(formatSetupBrief('ETH', null), null, 'no setup -> no line');
    assertEqual(formatSetupLine('ETH', setupEth), 'SETUP — ETH 3m SHORT — trigger: 3m close below 2601.5 then a retest that holds under it. Info; never GO IN.', '/why keeps the GPT SETUP line');
  });

  await test('/signals: GOOD first, then the rest, then DATA', () => {
    const t = formatSignals(payload({ ETH: watchSym(setupEth) }), T0);
    assert(t.indexOf('· BTC ·') < t.indexOf('· ETH ·') && t.indexOf('· ETH ·') < t.indexOf('· SOL ·'), 'order');
    assert(t.includes('\nSETUP · ETH 3m SHORT') && t.includes('<b>DATA</b>') && t.includes('Data: closed 14:05Z · complete · 1.25.0·2026.09.24-5') && !t.includes('Generated At') && !t.includes('Warnings:'), t);
    assert(formatSignals(payload({ dataStatus: 'unavailable' }), T0).includes('<b>STAND DOWN</b> · market data unavailable'), 'unavailable');
  });

  await test('/why, /flags, /wallet, /journal, /status formatters', () => {
    const why = formatWhy('BTC', { flagRecommendation: { class: 'WATCH', primaryReason: { code: 'x', text: 'why text' }, supports: ['td:bull:3/4'], opposes: [], unknowns: [{ code: 'u', text: 'unknown text' }], changeConditions: [{ code: 'c', text: 'change text' }], setup: setupEth } });
    for (const f of ['<b>BTC — WATCH</b>', 'why text', '• td:bull:3/4', '• unknown text', '• change text', 'SETUP — BTC 3m SHORT']) assert(why.includes(f), `why missing ${f}`);
    const flags = formatFlags(payload(), 'BTC');
    assert(flags.includes('5m LONG flag confirmed') && flags.includes('qual actionable') && !flags.includes('<b>ETH</b>'), flags);
    const w = formatWallet({ status: 'unavailable', reason: 'rpc down', margin: { usd: 0 }, holdingsUsd: 0, performance: { netPnlUsd: 0 } });
    assert(w.includes('Wallet Balance: Unavailable') && !w.includes('$0'), 'unavailable wallet is never $0');
    const w2 = formatWallet({ status: 'available', margin: { usd: 1011.5 }, holdingsUsd: 20, gas: { sol: 0.05, sufficient: true }, performance: { netPnlUsd: 11.5, returnPct: 1.2 } });
    assert(w2.includes('Wallet Balance: $1,011.50') && w2.includes('Realized PnL: $11.50 (1.2%)'), w2);
    const j = formatJournal([{ receivedAt: '2026-09-24T14:00:00Z', kind: 'open', symbol: 'BTC', direction: 'long', entry: 84600, stop: 84390, tp1: 85100, text: 'took it', source: 'telegram' }], T0);
    assert(j.includes('14:00 UTC · open BTC long $84,600.00 / $84,390.00 / $85,100.00 — took it [tg]'), j);
    assertEqual(formatJournal([], T0), 'Journal is empty.', 'empty journal');
    const st = formatStatus(payload(), { ...emptyState(), cron: { lastRunAt: '2026-09-24T14:05:00Z' }, alerts: { day: '2026-09-24', today: 3, last: { at: '2026-09-24T13:00:00Z', symbol: 'BTC', kind: 'GOOD' } } }, T0);
    for (const f of ['Schema/Config: 1.25.0 · 2026.09.24-5', 'Closed Through: 14:05 UTC (30s ago)', 'Data: complete', 'BTC: GOOD · Mark: $84,610.20', 'Last alert: GOOD BTC 13:00 UTC', 'Alerts today: 3', 'Cron last run: 14:05 UTC (30s ago']) assert(unpad(st).includes(f), `status missing ${f}\n${st}`);
    assert(st.startsWith('⚪ <b>STATUS</b>') && st.includes('<code>') && unpad(st).includes('Alert timeframes: 3m, 5m') && unpad(st).includes('Tracking: 0 of 10'), st);
  });

  await test('escapeHtml, fmtPrice, chunkMessage under 4,000 chars', () => {
    assertEqual(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c', 'escape');
    assertEqual(fmtPrice(84466.1), '$84,466.10', 'price');
    assertEqual(fmtPrice(0.12345), '$0.1235', 'small price');
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = chunkMessage(long);
    assert(parts.length > 1 && parts.every((p) => p.length <= MAX_MESSAGE_CHARS), 'chunks too big');
    assertEqual(parts.join('\n'), long, 'nothing lost');
    assert(chunkMessage('y'.repeat(9000)).every((p) => p.length <= MAX_MESSAGE_CHARS), 'one huge line split');
  });

  await test('GOOD alert: dot+glyph header, LEVELS, bold GET IN NOW, PLAN section; TEST label on samples', () => {
    const t = formatGoodAlert('BTC', goodSym(), payload(), { nowMs: T0 });
    assertEqual(t, [
      '🟢 ₿ <b>BTC 5m ▲ LONG</b> · GOOD', RULE,
      '<code>brk   84,600.00\nvoid  84,390.00\nmeas        n/a</code>', RULE,
      '<b>GET IN NOW</b> — retest held', RULE,
      '<code>entry          84,600.00\nstop           84,390.00\nstop dist          0.25%\nTP1            85,146.00\nTP2            85,300.00\nR gross·net  2.6R · 2.1R</code>', RULE,
      'Mark: $84,610.20 · drift 1.2 bps'
    ].join('\n'), 'good');
    const s = formatGoodAlert('BTC', goodSym(), payload(), { nowMs: T0, test: true });
    assert(s.startsWith('🧪 TEST — NOT A SIGNAL\n🟢 ₿ <b>BTC 5m ▲ LONG</b> · GOOD'), s.slice(0, 60));
  });

  // Schema 1.25.0 delivery pass: readiness call + room.
  const ACT_GOOD = { call: 'GET IN NOW', etaMin: 0, at: '2026-09-24T14:05:00.000Z', note: '5m long ready: entry 84,600.00, stop 84,390.00, TP1 85,146.00' };
  const ACT_READY = { call: 'BE READY', etaMin: 1, at: '2026-09-24T14:06:00.000Z', note: '3m close below 2601.5 then a retest that holds under it' };
  const ACT_WAIT = { call: 'WAIT', etaMin: 1, at: '2026-09-24T14:06:00.000Z', note: '3m close above 84,466.10, then a retest that holds it, then plan ready' };
  const ACT_DOWN = { call: 'STAND DOWN', etaMin: null, at: null, note: 'A new plan with at least 2.5R gross.' };
  const ROOM_GOOD = { toLevel: 'tp1_cap', levelPrice: 85146, levelSource: '15m resistance', pts: 546, r: 2.6, stop: 84390 };
  const ROOM_SETUP = { toLevel: 'measured_target', levelPrice: 2575, levelSource: 'measured move', pts: 26.5, r: 2.52, stop: 2612 };
  const ROOM_BAD = { toLevel: 'measured_target', levelPrice: 151, levelSource: 'measured move', pts: 1, r: 1, stop: 149 };
  const withRec = (sym, extra) => ({ ...sym, flagRecommendation: { ...sym.flagRecommendation, ...extra } });

  await test('1.25.0: formatCall reads action verbatim (eta only when > 0; null when absent)', () => {
    assertEqual(formatCall(ACT_GOOD), 'GET IN NOW', 'good');
    assertEqual(formatCall(ACT_READY), 'BE READY (1m)', 'ready');
    assertEqual(formatCall({ ...ACT_WAIT, etaMin: 4 }), 'WAIT (4m)', 'wait');
    assertEqual(formatCall(ACT_DOWN), 'STAND DOWN', 'down');
    assertEqual(formatCall(null), null, 'absent');
  });

  await test('1.25.0 /signals: each line leads with the bold action call; BE READY from a setup says the retest; STAND DOWN quotes own room', () => {
    const p = payload({
      BTC: withRec(goodSym(), { action: ACT_GOOD, room: ROOM_GOOD }),
      ETH: withRec(watchSym(setupEth), { action: ACT_READY, room: ROOM_SETUP }),
      SOL: withRec(badSym(), { action: ACT_DOWN, room: ROOM_BAD }),
      closedThrough: '2026-09-24T14:05:00.000Z'
    });
    const lines = formatSignals(p, T0).split('\n');
    assertEqual(lines.slice(0, 2).join('\n'), '🟢 ₿ <b>BTC 5m ▲ LONG</b> · SIGNAL\n<b>GET IN NOW</b> · BTC · 5m LONG · retest held · entry 84,600.00 · stop 84,390.00 · TP1 85,146.00 (2.6R) · net 2.1R', 'good block');
    assertEqual(lines.slice(2, 6).join('\n'), `${RULE}\n🟡 Ξ <b>ETH 3m ▼ SHORT</b> · SIGNAL\n<b>BE READY (1m)</b> · ETH · 3m SHORT · enter on a retest of 2,601.50 that holds below\nSETUP · ETH 3m SHORT · entry 2,601.50 · stop 2,612.00 · TP1 2,575.00 (2.5R)`, 'setup block');
    assertEqual(lines.slice(6, 9).join('\n'), `${RULE}\n🔴 ◎ <b>SOL 1m ▲ LONG</b> · SIGNAL\n<b>STAND DOWN</b> · SOL · 1R room to 151.00 (measured move); needs 2.5R`, 'bad block');
    const wait = formatSignalLine('BTC', withRec(formSym(), { action: { ...ACT_WAIT, etaMin: 2 }, candidate: { timeframe: '3m', direction: 'long', state: 'forming', breakout: 84900 } }));
    assertEqual(wait, '<b>WAIT (2m)</b> · BTC · 3m LONG forming · needs a 3m close above 84,900.00, then a retest that holds', 'wait line');
    const warned = formatSignals({ ...p, warnings: ['1h stale'] }, T0);
    assert(warned.includes('Warnings: 1h stale'), 'warnings line when non-empty');
  });

  // The five owner examples (2026-09-25), each a snapshot; mirrored long/short where marked.
  const tdRec = (code, extra = {}) => ({ supports: [], opposes: [code], unknowns: [], ...extra });
  const EX = {
    solBreakout() {
      const c = { candidateId: 'SOL:1m:short:X', timeframe: '1m', direction: 'short', state: 'confirmed', breakoutLevel: 117.29, invalidation: 117.62, measuredRR: 3.1 };
      const setup = { candidateId: c.candidateId, timeframe: '1m', direction: 'short', entry: 117.29, stop: 117.62, tp1: 116.27, grossRR: 3.09, netRR: 2.6 };
      const plan = { candidateId: c.candidateId, timeframe: '1m', direction: 'short', status: 'rejected', reasonCode: 'chase', entry: 117.29, stop: 117.62 };
      return { c, plan, rec: tdRec('td:bull:4/4', { setup }) };
    },
    btcBreakout() {
      const c = { candidateId: 'BTC:5m:long:X', timeframe: '5m', direction: 'long', state: 'confirmed', breakoutLevel: 84659.78, invalidation: 84479, measuredRR: 3.9 };
      const plan = { candidateId: c.candidateId, timeframe: '5m', direction: 'long', status: 'rejected', reasonCode: 'rr_below_min', entry: 84659.78, stop: 84479, tp1: 84771.3, grossRR: 0.62 };
      const room = { toLevel: 'tp1_cap', levelPrice: 84771.3, levelSource: '15m resistance', pts: 111.52, r: 0.67, stop: 84479 };
      return { c, plan, rec: { supports: ['td:bull:3/4'], opposes: [], unknowns: [], setup: null, room } };
    },
    ethGood() {
      const c = { candidateId: 'ETH:1m:long:X', timeframe: '1m', direction: 'long', state: 'confirmed', breakoutLevel: 2696.07, invalidation: 2690.19, measuredRR: 3.2 };
      const plan = { candidateId: c.candidateId, timeframe: '1m', direction: 'long', status: 'ready', entry: 2696.07, stop: 2690.19, tp1: 2714.3, grossRR: 3.0, netRR: 2.6 };
      return { c, plan, rec: { supports: ['td:bull:4/4'], opposes: [], unknowns: [], setup: null } };
    },
    btcWatch: () => ({ candidateId: 'BTC:3m:long:W', timeframe: '3m', direction: 'long', state: 'forming', breakoutLevel: 84900, invalidation: 84722.6, measuredRR: 2.43 }),
    ethTrig: () => ({ candidateId: 'ETH:1m:short:T', timeframe: '1m', direction: 'short', state: 'triggering', breakoutLevel: 2680.85, invalidation: 2684.5, measuredRR: 5.1 })
  };
  const ASOF_1M = '2026-09-24T14:05:00.000Z';
  const ASOF_3M = '2026-09-24T14:04:00.000Z';
  /** Sections of a visual-layout message; the header; the verdict section. */
  const secs = (t) => String(t).split(`\n${RULE}\n`);
  const verdictOf = (t) => secs(t).find((x) => /^<b>(GET IN NOW|BE READY|WAIT|STAND DOWN)/.test(x)) || null;
  const HEADER_RE = /^(🟢|🟡|🔴|⚪) (₿|Ξ|◎) <b>(BTC|ETH|SOL)( \w+)? (▲ LONG|▼ SHORT)<\/b> · /;
  const arrowOk = (t, dir) => headOf(t).includes(dir === 'short' ? '▼ SHORT' : '▲ LONG') && !headOf(t).includes(dir === 'short' ? '▲' : '▼');
  const headOf = (t) => secs(t)[0].split('\n').find((l) => HEADER_RE.test(l)) || secs(t)[0];
  const EXPECTED = {
    sol: ['🟡 ◎ <b>SOL 1m ▼ SHORT</b> · BREAKOUT', '<b>BE READY (1m)</b> — no chase; enter on a retest of 117.29 that holds below'],
    btc: ['🔴 ₿ <b>BTC 5m ▲ LONG</b> · BREAKOUT', '<b>STAND DOWN</b> — 0.67R room to 84,771.30 (15m resistance); needs 2.5R'],
    eth: ['🟢 Ξ <b>ETH 1m ▲ LONG</b> · BREAKOUT', '<b>GET IN NOW</b> — retest held'],
    watch: ['⚪ ₿ <b>BTC 3m ▲ LONG</b> · WATCH · forming', '<b>WAIT (2m)</b> — needs a 3m close above 84,900.00, then a retest that holds'],
    trig: ['🟡 Ξ <b>ETH 1m ▼ SHORT</b> · TRIGGERING', '<b>BE READY (1m)</b> — close below 2,680.85 confirms; then retest &amp; hold to enter']
  };
  const checkAlert = (t, [head, verdict], msg) => {
    assertEqual(headOf(t), head, `${msg}: header`);
    assertEqual(verdictOf(t), verdict, `${msg}: verdict`);
  };
  /** Mirror a fixture long <-> short around its breakout (levels reflect; R and eta unchanged). */
  const flip = (d) => (d === 'long' ? 'short' : 'long');
  const mirrorPx = (brk, v) => (typeof v === 'number' ? Math.round((2 * brk - v) * 100) / 100 : v);
  const REASON_CODE_RE = /\b[a-z]+(?:_[a-z0-9]+)+\b|plan rejected|Info; never|another candidate is selected|confirmed ·|\btd:/;

  await test('owner example 1: SOL 1m SHORT chase-rejected BREAKOUT with its setup -> BE READY, counter-trend; long mirror (full snapshots)', () => {
    const { c, plan, rec } = EX.solBreakout();
    const t = formatBreakoutAlert('SOL', c, plan, rec, { asOf: ASOF_1M, mark: { price: 117.2, driftBps: 1.3, status: 'ok' } });
    assertEqual(t, [
      '🟡 ◎ <b>SOL 1m ▼ SHORT</b> · BREAKOUT', RULE,
      '<code>brk   117.29\nvoid  117.62\nmeas    3.1R</code>', RULE,
      '<b>BE READY (1m)</b> — no chase; enter on a retest of 117.29 that holds below', RULE,
      '<code>entry             117.29\nstop              117.62\nstop dist          0.28%\nTP1               116.27\nR gross·net  3.1R · 2.6R</code>', RULE,
      'Counter-trend: top-down bull 4/4, against this ▼ SHORT\nMark: $117.20 · drift 1.3 bps'
    ].join('\n'), 'short snapshot');
    const b = c.breakoutLevel;
    const mc = { ...c, direction: 'long', invalidation: mirrorPx(b, c.invalidation) };
    const mrec = { ...tdRec('td:bear:4/4'), setup: { ...rec.setup, direction: 'long', stop: mirrorPx(b, rec.setup.stop), tp1: mirrorPx(b, rec.setup.tp1) } };
    assertEqual(formatBreakoutAlert('SOL', mc, { ...plan, direction: 'long' }, mrec, { asOf: ASOF_1M }), [
      '🟡 ◎ <b>SOL 1m ▲ LONG</b> · BREAKOUT', RULE,
      '<code>brk   117.29\nvoid  116.96\nmeas    3.1R</code>', RULE,
      '<b>BE READY (1m)</b> — no chase; enter on a retest of 117.29 that holds above', RULE,
      '<code>entry             117.29\nstop              116.96\nstop dist          0.28%\nTP1               118.31\nR gross·net  3.1R · 2.6R</code>', RULE,
      'Counter-trend: top-down bear 4/4, against this ▲ LONG'
    ].join('\n'), 'long mirror snapshot');
  });

  await test('owner example 2: BTC 5m LONG rr-rejected BREAKOUT -> STAND DOWN with own room (no PLAN section); short mirror says support-side room', () => {
    const { c, plan, rec } = EX.btcBreakout();
    const t = formatBreakoutAlert('BTC', c, plan, rec, { asOf: ASOF_1M });
    checkAlert(t, EXPECTED.btc, 'long');
    assert(secs(t)[1].includes('room  0.7R to 84,771.30') && !t.includes('entry '), t);
    const b = c.breakoutLevel;
    const room = { ...rec.room, levelPrice: mirrorPx(b, rec.room.levelPrice), levelSource: '15m support' };
    checkAlert(formatBreakoutAlert('BTC', { ...c, direction: 'short', invalidation: mirrorPx(b, c.invalidation) }, { ...plan, direction: 'short' }, { ...rec, supports: ['td:bear:3/4'], room }, { asOf: ASOF_1M }),
      ['🔴 ₿ <b>BTC 5m ▼ SHORT</b> · BREAKOUT', '<b>STAND DOWN</b> — 0.67R room to 84,548.26 (15m support); needs 2.5R'], 'short mirror');
  });

  await test('owner example 3: ETH 1m LONG own plan ready -> GET IN NOW with a PLAN section; short mirror', () => {
    const { c, plan, rec } = EX.ethGood();
    const t = formatBreakoutAlert('ETH', c, plan, rec, { asOf: ASOF_1M });
    checkAlert(t, EXPECTED.eth, 'long');
    assertEqual(secs(t)[3], '<code>entry           2,696.07\nstop            2,690.19\nstop dist          0.22%\nTP1             2,714.30\nR gross·net  3.0R · 2.6R</code>', 'plan section');
    const b = c.breakoutLevel;
    const m = formatBreakoutAlert('ETH', { ...c, direction: 'short', invalidation: mirrorPx(b, c.invalidation) },
      { ...plan, direction: 'short', stop: mirrorPx(b, plan.stop), tp1: mirrorPx(b, plan.tp1) }, { ...rec, supports: ['td:bear:4/4'] }, { asOf: ASOF_1M });
    checkAlert(m, ['🟢 Ξ <b>ETH 1m ▼ SHORT</b> · BREAKOUT', '<b>GET IN NOW</b> — retest held'], 'short mirror');
    assert(secs(m)[3].includes('TP1             2,677.84'), m);
  });

  await test('owner example 4: BTC 3m LONG forming -> ⚪ WATCH / WAIT (2m); short mirror', () => {
    const c = EX.btcWatch();
    checkAlert(formatWatchAlert('BTC', c, { supports: ['td:bull:3/4'] }, { asOf: ASOF_3M }), EXPECTED.watch, 'long');
    const m = formatWatchAlert('BTC', { ...c, direction: 'short', invalidation: mirrorPx(c.breakoutLevel, c.invalidation) }, { opposes: ['td:bull:3/4'] }, { asOf: ASOF_3M });
    checkAlert(m, ['⚪ ₿ <b>BTC 3m ▼ SHORT</b> · WATCH · forming', '<b>WAIT (2m)</b> — needs a 3m close below 84,900.00, then a retest that holds'], 'short mirror');
    assert(m.includes('Counter-trend: top-down bull 3/4, against this ▼ SHORT'), m);
  });

  await test('owner example 5: ETH 1m SHORT triggering, counter-trend -> 🟡 TRIGGERING / BE READY (1m); long mirror', () => {
    const c = EX.ethTrig();
    const t = formatWatchAlert('ETH', c, tdRec('td:bull:3/4'), { asOf: ASOF_1M });
    checkAlert(t, EXPECTED.trig, 'short');
    assert(t.includes('Counter-trend: top-down bull 3/4'), t);
    const m = formatWatchAlert('ETH', { ...c, direction: 'long', invalidation: mirrorPx(c.breakoutLevel, c.invalidation) }, { supports: ['td:bull:3/4'] }, { asOf: ASOF_1M });
    checkAlert(m, ['🟡 Ξ <b>ETH 1m ▲ LONG</b> · TRIGGERING', '<b>BE READY (1m)</b> — close above 2,680.85 confirms; then retest &amp; hold to enter'], 'long mirror');
    assert(!m.includes('Counter-trend') && m.includes('Top-down: bull 3/4'), 'aligned: no counter-trend note');
  });

  await test('every alert: dot+glyph header with the right arrow, rule separators, one bold verdict, under 1,000 chars; no reason code or remedy', () => {
    const verdict = /^<b>(GET IN NOW|BE READY( \(\d+m\))?|WAIT( \(\d+m\))?|STAND DOWN)<\/b>( — |$)/;
    const shape = (t, dir, msg) => {
      assert(HEADER_RE.test(t.split('\n')[0]), `${msg}: header ${t.split('\n')[0]}`);
      assert(arrowOk(t, dir), `${msg}: arrow`);
      assert(t.includes(`\n${RULE}\n`) && secs(t).length >= 3, `${msg}: rules`);
      assert(verdict.test(verdictOf(t) || '') && (verdictOf(t).match(/<b>/g) || []).length === 1, `${msg}: one bold verdict`);
      assert(t.length <= MAX_CARD_CHARS, `${msg}: ${t.length} chars`);
      assert(!REASON_CODE_RE.test(t), `${msg}: reason code in ${t}`);
    };
    const { c: sc, plan: sp, rec: sr } = EX.solBreakout();
    shape(formatBreakoutAlert('SOL', sc, sp, sr, { asOf: ASOF_1M }), 'short', 'sol');
    shape(formatBreakoutAlert('BTC', EX.btcBreakout().c, EX.btcBreakout().plan, EX.btcBreakout().rec, { asOf: ASOF_1M }), 'long', 'btc');
    shape(formatBreakoutAlert('ETH', EX.ethGood().c, EX.ethGood().plan, EX.ethGood().rec, { asOf: ASOF_1M }), 'long', 'eth');
    shape(formatWatchAlert('BTC', EX.btcWatch(), {}, { asOf: ASOF_3M }), 'long', 'watch');
    shape(formatWatchAlert('ETH', EX.ethTrig(), tdRec('td:bull:3/4'), { asOf: ASOF_1M }), 'short', 'trig');
    // Every rejection code renders as words; the remedy sentence never reaches the alert.
    const c = { candidateId: 'BTC:5m:long:K', timeframe: '5m', direction: 'long', state: 'confirmed', breakoutLevel: 84479, invalidation: 84349.7, measuredRR: 3.9 };
    const remedy = 'a flag whose measured move is >= 2.5R gross to TP1';
    const texts = ['rr_below_min', 'room_at_entry', 'chase', 'stop_distance_exceeds_cap', 'net_rr_below_min', 'stop_inside_costs', 'invalid_levels', 'stale_data', 'missing_data', 'some_new_code']
      .map((reasonCode) => formatBreakoutAlert('BTC', c, { candidateId: c.candidateId, timeframe: '5m', direction: 'long', status: 'rejected', reasonCode, entry: 84479, stop: 84349.7, tp1: 84700, grossRR: 1.2, stopDistancePct: 3.4 }, { action: { call: 'STAND DOWN', note: remedy } }, { asOf: ASOF_1M }));
    texts.push(formatBreakoutAlert('BTC', c, null, null, { asOf: ASOF_1M }));
    for (const t of texts) {
      shape(t, 'long', 'rejection');
      assert(!t.includes(remedy) && verdictOf(t).startsWith('<b>STAND DOWN</b> — ') && t.startsWith('🔴 '), t);
    }
    assertEqual(verdictOf(texts[1]), '<b>STAND DOWN</b> — entry 84,479.00 inside resistance', 'room at entry');
    assertEqual(verdictOf(texts[3]), '<b>STAND DOWN</b> — stop 3.4% &gt; 3% cap', 'stop cap (HTML-escaped)');
    assertEqual(verdictOf(texts[0]), '<b>STAND DOWN</b> — 1.2R room to 84,700.00; needs 2.5R', 'rr without own room: gross R to TP1');
    // A whole cron payload: every alert text and /signals passes the same check.
    const p = payload({ BTC: goodSym(), ETH: formSym([cand('ETH:3m:long:a'), cand('ETH:5m:long:b', 'triggering', { timeframe: '5m' })], setupEth), SOL: badSym() });
    const r = diffAlerts(withPrefs('watch'), p, T0);
    const kinds = r.alerts.filter((x) => ['GOOD', 'SETUP', 'BREAKOUT', 'WATCH', 'TRIGGERING'].includes(x.kind));
    assert(kinds.length >= 3, `alerts ${kinds.map((a) => a.kind)}`);
    for (const a of kinds) assert(!REASON_CODE_RE.test(a.text) && HEADER_RE.test(a.text.split('\n')[0]) && a.text.length <= MAX_CARD_CHARS, `${a.kind}: ${a.text}`);
    assert(!REASON_CODE_RE.test(formatSignals(p, T0)), formatSignals(p, T0));
  });

  await test('conditional plan and SETUP alert use the BE READY verdict; stop/TP1 move to the PLAN section', () => {
    const c = { candidateId: 'BTC:5m:long:K', timeframe: '5m', direction: 'long', state: 'confirmed', breakoutLevel: 84479, invalidation: 84349.7, measuredRR: 3.9 };
    const plan = { candidateId: c.candidateId, timeframe: '5m', direction: 'long', status: 'conditional', reasonCode: 'awaiting_retest', entry: 84479, stop: 84349.7, tp1: 84985 };
    const t = formatBreakoutAlert('BTC', c, plan, {}, { asOf: '2026-09-24T14:02:00.000Z' });
    assertEqual(verdictOf(t), '<b>BE READY (3m)</b> — enter on a retest of 84,479.00 that holds above', 'conditional');
    assert(/TP1 +84,985\.00/.test(secs(t)[3]), secs(t)[3]);
    const s = formatSetupAlert('ETH', setupEth, { supports: ['td:bear:2/4'] }, { asOf: '2026-09-24T14:04:00.000Z' });
    checkAlert(s, ['🟡 Ξ <b>ETH 3m ▼ SHORT</b> · SETUP', '<b>BE READY (2m)</b> — enter on a retest of 2,601.50 that holds below'], 'setup, no candidate on file');
    const withCand = formatSetupAlert('ETH', setupEth, {}, { asOf: '2026-09-24T14:04:00.000Z', candidates: [{ candidateId: setupEth.candidateId, timeframe: '3m', direction: 'short', state: 'forming', breakoutLevel: 2601.5, invalidation: 2613, measuredRR: 2.6 }] });
    assertEqual(verdictOf(withCand), '<b>BE READY (2m)</b> — needs a 3m close below 2,601.50, then a retest that holds', 'setup on a forming candidate');
    assert(secs(withCand)[1].includes('void  2,613.00') && /stop +2,612\.00/.test(secs(withCand)[3]), withCand);
  });

  console.log('\nalert state machine');

  await test('first GOOD alerts once with the plan-timeframe chart; the next candle (new planId) does not', () => {
    const a = diffAlerts(emptyState(), payload(), T0);
    const good = a.alerts.filter((x) => x.kind === 'GOOD');
    assertEqual(good.length, 1, 'one GOOD');
    assertEqual(JSON.stringify(good[0].chart), JSON.stringify({ symbol: 'BTC', timeframe: '5m' }), 'chart');
    assert(a.changed, 'state changed');
    const st = a.state.symbols.BTC;
    for (const k of ['class', 'primaryReason', 'setupId', 'planId', 'planStatus', 'lastAlertAt']) assert(k in st, `state.${k}`);
    const next = payload({ BTC: goodSym(undefined, '2026-09-24T14:06:00.000Z'), closedThrough: '2026-09-24T14:06:00.000Z' });
    const b = diffAlerts(a.state, next, T0 + MIN);
    assertEqual(b.alerts.length, 0, `no repeat: ${b.alerts.map((x) => x.kind)}`);
  });

  await test('GOOD -> BAD fires GOOD ENDED (rejected); GOOD -> WATCH says void; flicker back to the same GOOD stays quiet', () => {
    const a = diffAlerts(emptyState(), payload(), T0);
    const b = diffAlerts(a.state, payload({ BTC: { ...badSym(), mark: markOk } }), T0 + MIN);
    const ended = b.alerts.find((x) => x.kind === 'GOOD_ENDED');
    assert(ended && ended.text.includes('GOOD → BAD (rejected)') && ended.text.startsWith('🔴 ₿ <b>BTC 5m ▲ LONG</b> · GOOD ENDED'), ended && ended.text);
    const c = diffAlerts(b.state, payload(), T0 + 2 * MIN);
    assertEqual(c.alerts.filter((x) => x.kind === 'GOOD').length, 0, 'same candidate already alerted');
    const d = diffAlerts(c.state, payload({ BTC: watchSym() }), T0 + 3 * MIN);
    assert(d.alerts.find((x) => x.kind === 'GOOD_ENDED').text.includes('GOOD → WATCH (void)'), 'void');
    const e = diffAlerts(d.state, payload({ BTC: goodSym('BTC:5m:long:2026-09-24T14:10:00.000Z') }), T0 + 4 * MIN);
    assertEqual(e.alerts.filter((x) => x.kind === 'GOOD').length, 1, 'a new candidate alerts');
  });

  await test('NEW SETUP alerts once per candidate id, BREAKOUT shape with the BE READY trigger', () => {
    const a = diffAlerts(emptyState(), payload({ ETH: watchSym(setupEth) }), T0);
    const s = a.alerts.filter((x) => x.kind === 'SETUP');
    assertEqual(s.length, 1, 'one SETUP');
    checkAlert(s[0].text, ['🟡 Ξ <b>ETH 3m ▼ SHORT</b> · SETUP', '<b>BE READY (1m)</b> — enter on a retest of 2,601.50 that holds below'], 'setup alert');
    assert(/TP1 +2,575\.00/.test(secs(s[0].text)[3]), s[0].text);
    const b = diffAlerts(a.state, payload({ ETH: watchSym(setupEth) }), T0 + MIN);
    const c = diffAlerts(b.state, payload({ ETH: watchSym(null) }), T0 + 2 * MIN);
    const d = diffAlerts(c.state, payload({ ETH: watchSym(setupEth) }), T0 + 3 * MIN);
    assertEqual([...b.alerts, ...c.alerts, ...d.alerts].filter((x) => x.kind === 'SETUP').length, 0, 'deduped by candidate id');
  });

  await test('unchanged state writes only a heartbeat every 10 minutes', () => {
    const a = diffAlerts(emptyState(), payload(), T0);
    const b = diffAlerts(a.state, payload(), T0 + MIN);
    assertEqual(b.changed, false, 'nothing moved within 10 min');
    const c = diffAlerts(a.state, payload(), T0 + HEARTBEAT_WRITE_MS);
    assertEqual(c.changed, true, 'heartbeat due');
    assertEqual(c.alerts.length, 0, 'heartbeat sends nothing');
  });

  await test('DATA_UNAVAILABLE / stale alerts only after 5 min, then at most every 30 min, then DATA OK', () => {
    let st = diffAlerts(emptyState(), payload(), T0).state;
    const down = (ms) => payload({ dataStatus: 'unavailable', closedThrough: null });
    const at = (m) => T0 + m * MIN;
    const kinds = [];
    for (const m of [1, 3, 5.9, 6.1, 10, 20, 36.2, 37]) {
      const r = diffAlerts(st, down(), at(m));
      st = r.state;
      kinds.push(`${m}:${r.alerts.map((x) => x.kind).join('+')}`);
    }
    assertEqual(kinds.join(' '), '1: 3: 5.9: 6.1:DATA 10: 20: 36.2:DATA 37:', 'persist 5 min, repeat after 30');
    const ok = diffAlerts(st, payload({ closedThrough: new Date(at(38)).toISOString() }), at(38) + 20_000);
    assert(ok.alerts.some((x) => x.kind === 'DATA_OK'), 'recovery note');
    const stale = diffAlerts(emptyState(), payload({ closedThrough: '2026-09-24T13:50:00.000Z' }), T0);
    assert(stale.state.health.dataBadSince, 'stale closedThrough counts as a data problem');
    assertEqual(HEALTH_PERSIST_MS, 5 * MIN, 'persist');
    assertEqual(HEALTH_REPEAT_MS, 30 * MIN, 'repeat');
  });

  await test('mark unavailable alerts per symbol after 5 min, rate-limited', () => {
    const noMark = () => payload({ ETH: watchSym(null, { price: null, driftBps: null, status: 'unavailable' }) });
    let st = emptyState();
    const got = [];
    for (const m of [0, 4, 5, 6, 20, 35]) {
      const r = diffAlerts(st, noMark(), T0 + m * MIN);
      st = r.state;
      got.push(`${m}:${r.alerts.filter((x) => x.kind === 'MARK').map((x) => x.symbol).join('+')}`);
    }
    assertEqual(got.join(' '), '0: 4: 5:ETH 6: 20: 35:ETH', 'mark alerts');
  });

  await test('parseState survives garbage; alerts-today counter resets by UTC day', () => {
    assertEqual(parseState('not json').schemaVersion, 'telegram-state-1', 'garbage -> empty');
    const a = diffAlerts({ ...emptyState(), alerts: { day: '2026-09-23', today: 9, last: null } }, payload(), T0);
    assertEqual(a.state.alerts.day, '2026-09-24', 'day');
    assertEqual(a.state.alerts.today, a.alerts.length, 'reset then counted');
  });


  console.log('\nalert levels, watch, quiet hours');

  await test('level gating per class: good = GOOD only, setup adds SETUP, watch adds WATCH; health always', () => {
    const p = payload({ ETH: formSym([cand('ETH:3m:long:a')], setupEth) });
    const kinds = (level) => diffAlerts(withPrefs(level), p, T0).alerts.map((a) => a.kind).sort().join(',');
    assertEqual(kinds('good'), 'BREAKOUT,GOOD', 'good (BREAKOUT sends at every level)');
    assertEqual(kinds('setup'), 'BREAKOUT,GOOD,SETUP', 'setup');
    assertEqual(kinds('watch'), 'BREAKOUT,GOOD,SETUP,WATCH', 'watch');
    assertEqual(diffAlerts(emptyState(), p, T0).state.prefs.level, 'setup', 'default level is setup');
    // SETUP held back at level good is still remembered: raising the level does not replay it.
    const a = diffAlerts(withPrefs('good'), p, T0);
    const b = diffAlerts({ ...a.state, prefs: { ...a.state.prefs, level: 'setup' } }, p, T0 + MIN);
    assertEqual(b.alerts.filter((x) => x.kind === 'SETUP').length, 0, 'no replay');
    // GOOD ENDED and MARK still send at level good.
    const ended = diffAlerts(a.state, payload({ BTC: { ...badSym(), mark: markOk }, ETH: formSym([], setupEth) }), T0 + 2 * MIN);
    assert(ended.alerts.some((x) => x.kind === 'GOOD_ENDED'), 'GOOD ENDED at level good');
    let st = withPrefs('good');
    const noMark = () => payload({ ETH: watchSym(null, { price: null, driftBps: null, status: 'unavailable' }) });
    for (const m of [0, 5]) { const r = diffAlerts(st, noMark(), T0 + m * MIN); st = r.state; if (m === 5) assert(r.alerts.some((x) => x.kind === 'MARK'), 'MARK at level good'); }
  });

  await test('WATCH line format; proto/failed/expired/confirmed never alert; TRIGGERING line', () => {
    assertEqual(formatWatchAlert('BTC', cand('x'), TD_REC), ['⚪ ₿ <b>BTC 3m ▲ LONG</b> · WATCH · forming', RULE, '<code>brk   84,466.10\nvoid  84,331.60\nmeas       2.4R</code>', RULE,
      '<b>WAIT</b> — needs a 3m close above 84,466.10, then a retest that holds', RULE, 'Top-down: bull 3/4'].join('\n'), 'forming (no asOf -> no eta; aligned td -> no counter-trend)');
    checkAlert(formatWatchAlert('BTC', cand('x', 'triggering'), TD_REC, { asOf: '2026-09-24T14:05:00.000Z' }), ['🟡 ₿ <b>BTC 3m ▲ LONG</b> · TRIGGERING', '<b>BE READY (1m)</b> — close above 84,466.10 confirms; then retest &amp; hold to enter'], 'triggering');
    const bare = formatWatchAlert('ETH', cand('x', 'forming', { direction: 'short', measuredRR: null }), { supports: [] });
    checkAlert(bare, ['⚪ Ξ <b>ETH 3m ▼ SHORT</b> · WATCH · forming', '<b>WAIT</b> — needs a 3m close below 84,466.10, then a retest that holds'], 'no td, no R');
    assertEqual(secs(bare).length, 3, 'no context section without td or mark');
    const other = ['proto', 'failed', 'expired', 'confirmed'].map((st, i) => cand(`BTC:3m:long:o${i}`, st));
    const r = diffAlerts(withPrefs('watch'), payload({ BTC: formSym(other) }), T0);
    assertEqual(r.alerts.filter((x) => x.kind === 'WATCH' || x.kind === 'TRIGGERING').length, 0, 'only forming/triggering');
    assert(!r.alerts.some((x) => x.chart), 'no chart on watch');
  });

  await test('WATCH dedup by candidateId, 15-min per-symbol cooldown, triggering passes the cooldown once', () => {
    const A = cand('BTC:3m:long:A');
    const B = cand('BTC:5m:long:B', 'forming', { timeframe: '5m' });
    const run = (st, cands, m, sym = 'BTC') => diffAlerts(st, payload({ BTC: sym === 'BTC' ? formSym(cands) : watchSym(), ETH: sym === 'ETH' ? formSym(cands) : watchSym() }), T0 + m * MIN);
    const w = (r) => r.alerts.filter((x) => x.kind === 'WATCH' || x.kind === 'TRIGGERING').map((x) => `${x.kind}:${x.text.split('\n')[0].match(/<b>(.*?)<\/b>/)[1]}`).join('|');
    const r0 = run(withPrefs('watch'), [A, B], 0);
    assertEqual(w(r0), 'WATCH:BTC 3m ▲ LONG', 'first candidate alerts, second held by cooldown in the same run');
    const r1 = run(r0.state, [A, B], 1);
    assertEqual(w(r1), '', 'A deduped, B still cooling');
    const r2 = run(r1.state, [{ ...A, state: 'triggering' }, B], 2);
    assertEqual(w(r2), 'TRIGGERING:BTC 3m ▲ LONG', 'triggering passes the cooldown');
    const r3 = run(r2.state, [{ ...A, state: 'triggering' }, B], 3);
    assertEqual(w(r3), '', 'triggering passes only once');
    const r4 = run(r3.state, [{ ...A, state: 'forming' }, B], 16);
    assertEqual(w(r4), '', 'cooldown restarted at the TRIGGERING alert (min 2)');
    const r5 = run(r4.state, [A, B], 17.1);
    assertEqual(w(r5), 'WATCH:BTC 5m ▲ LONG', 'B alerts once the cooldown ends; A never repeats');
    // Cooldown is per symbol: ETH is not held by BTC's cooldown.
    const eth = diffAlerts(r5.state, payload({ BTC: formSym([A, B]), ETH: formSym([cand('ETH:3m:long:E')]) }), T0 + 18 * MIN);
    assertEqual(w(eth), 'WATCH:ETH 3m ▲ LONG', 'per-symbol cooldown');
    // A new id first seen triggering alerts TRIGGERING, under the cooldown.
    const t0 = run(withPrefs('watch'), [cand('BTC:5m:long:T', 'triggering', { timeframe: '5m' })], 0);
    assertEqual(w(t0), 'TRIGGERING:BTC 5m ▲ LONG', 'new triggering');
    assertEqual(WATCH_COOLDOWN_MS, 15 * MIN, 'cooldown');
  });

  await test('prod 2026-09-25 repro: shifting candidateId, same levels, 3 cron runs -> one WATCH; stays quiet past the cooldown until 60 min', () => {
    const lv = { breakoutLevel: 84900, invalidation: 84722.6 };
    const at = (m) => payload({ BTC: formSym([cand(`BTC:3m:long:2026-09-25T02:${String(10 + m).padStart(2, '0')}:00.000Z`, 'forming', lv)]) });
    const w = (r) => r.alerts.filter((x) => x.kind === 'WATCH' || x.kind === 'TRIGGERING').map((x) => x.kind);
    let st = withPrefs('watch');
    const sent = [];
    for (const m of [0, 1, 3]) { const r = diffAlerts(st, at(m), T0 + m * MIN); st = r.state; sent.push(...w(r)); }
    assertEqual(sent.join(), 'WATCH', 'three runs -> one send');
    // Past the 15-min cooldown the signature still holds (shifted id again).
    for (const m of [20, 45, 59]) { const r = diffAlerts(st, at(m), T0 + m * MIN); st = r.state; assertEqual(w(r).join(), '', `min ${m}`); }
    // Escalation passes once: the same levels triggering, then BREAKOUT; neither repeats.
    const trig = (m, id) => payload({ BTC: formSym([cand(id, 'triggering', lv)]) });
    let r = diffAlerts(st, trig(0, 'BTC:3m:long:T1'), T0 + 5 * MIN); st = r.state;
    assertEqual(w(r).join(), 'TRIGGERING', 'escalation passes the cooldown');
    r = diffAlerts(st, trig(0, 'BTC:3m:long:T2'), T0 + 6 * MIN); st = r.state;
    assertEqual(w(r).join(), '', 'triggering once per signature');
    const conf = (id) => payload({ BTC: formSym([cand(id, 'confirmed', lv)]) });
    r = diffAlerts(st, conf('BTC:3m:long:C1'), T0 + 7 * MIN); st = r.state;
    assertEqual(r.alerts.filter((x) => x.kind === 'BREAKOUT').length, 1, 'breakout once');
    r = diffAlerts(st, conf('BTC:3m:long:C2'), T0 + 8 * MIN); st = r.state;
    assertEqual(r.alerts.filter((x) => x.kind === 'BREAKOUT').length, 0, 'shifted confirmed id: no second BREAKOUT');
    // Different levels on the same symbol within 15 min: held by the per-symbol cooldown.
    r = diffAlerts(st, payload({ BTC: formSym([cand('BTC:3m:long:N', 'forming', { breakoutLevel: 85000 })]) }), T0 + 9 * MIN);
    assertEqual(w(r).join(), '', 'cooldown gates a new WATCH (last BTC watch-family alert at min 5)');
    // After 60 min the same signature may alert again.
    r = diffAlerts(st, at(61), T0 + 68 * MIN);
    assertEqual(w(r).join(), 'WATCH', 'signature expires 60 min after its last alert (BREAKOUT at min 7)');
    assertEqual(alertSignature('BTC', { timeframe: '3m', direction: 'long', breakoutLevel: 84900.004, invalidation: 84722.6 }), 'BTC|3m|long|84900.00', 'signature format (void not part of it)');
    assertEqual(SIGNATURE_TTL_MS, 60 * MIN, 'ttl');
    assertEqual(parseState(JSON.stringify(st)).watch.sigs.length, st.watch.sigs.length, 'signatures survive parseState');
  });

  await test('void drift and breakout drift < 0.05% are the same flag (no re-alert in 60 min); >= 0.05% is a new flag', () => {
    const w = (r) => r.alerts.filter((x) => ['WATCH', 'TRIGGERING', 'BREAKOUT'].includes(x.kind)).map((x) => x.kind).join();
    const run = (st, id, extra, m) => diffAlerts(st, payload({ BTC: formSym([cand(id, 'forming', { breakoutLevel: 84900, invalidation: 84722.6, ...extra })]) }), T0 + m * MIN);
    let r = run(withPrefs('watch'), 'BTC:3m:long:v0', {}, 0);
    assertEqual(w(r), 'WATCH', 'first');
    // New candidateId, void moved 40 pts, breakout moved 0.04%: past the 15-min cooldown, still the same flag.
    r = run(r.state, 'BTC:3m:long:v1', { invalidation: 84682.6 }, 20);
    assertEqual(w(r), '', 'void drift');
    r = run(r.state, 'BTC:3m:long:v2', { breakoutLevel: 84900 * 1.0004, invalidation: 84760 }, 40);
    assertEqual(w(r), '', 'breakout drift 0.04%');
    r = run(r.state, 'BTC:3m:long:v3', { breakoutLevel: 84900 * 0.9996 }, 55);
    assertEqual(w(r), '', 'breakout drift -0.04%');
    assertEqual(r.state.watch.sigs.filter((e) => e.sig.startsWith('BTC|3m|long|')).length, 1, 'one merged memory entry');
    r = run(r.state, 'BTC:3m:long:v4', { breakoutLevel: 84900 * 1.0006 }, 75);
    assertEqual(w(r), 'WATCH', '0.06% away is a different flag');
    // Old 5-part signatures (with the void level) from an earlier deploy still match.
    const legacy = { ...withPrefs('watch'), watch: { ids: [], lastAt: {}, sigs: [{ sig: 'BTC|3m|long|84900.00|84722.60', at: new Date(T0 - 20 * MIN).toISOString(), kinds: ['WATCH'] }] } };
    assertEqual(w(run(legacy, 'BTC:3m:long:L', { invalidation: 84700 }, 0)), '', 'legacy signature still dedups');
    assertEqual(SIGNATURE_TOLERANCE, 0.0005, 'tolerance');
  });

  await test('escalation passes through once each on drifted levels: forming -> triggering -> confirmed -> GOOD', () => {
    const lv = (i) => ({ breakoutLevel: 84900 + i * 5, invalidation: 84722.6 - i * 25 });
    const kinds = (r) => r.alerts.filter((x) => ['WATCH', 'TRIGGERING', 'BREAKOUT', 'GOOD'].includes(x.kind)).map((x) => x.kind).join();
    const step = (st, candState, i, m) => diffAlerts(st, payload({ BTC: formSym([cand(`BTC:3m:long:e${i}`, candState, lv(i))]) }), T0 + m * MIN);
    let r = step(withPrefs('watch'), 'forming', 0, 0);
    assertEqual(kinds(r), 'WATCH', 'forming');
    r = step(r.state, 'forming', 1, 1);
    assertEqual(kinds(r), '', 'forming again');
    r = step(r.state, 'triggering', 2, 2);
    assertEqual(kinds(r), 'TRIGGERING', 'triggering passes the cooldown');
    r = step(r.state, 'triggering', 3, 3);
    assertEqual(kinds(r), '', 'triggering once');
    r = step(r.state, 'confirmed', 4, 4);
    assertEqual(kinds(r), 'BREAKOUT', 'confirmed');
    r = step(r.state, 'confirmed', 5, 5);
    assertEqual(kinds(r), '', 'confirmed once');
    const g = goodSym('BTC:3m:long:e6');
    g.flagTradePlan = { ...g.flagTradePlan, timeframe: '3m', entry: 84960, stop: 84572.6 };
    g.candidateSetups = [cand('BTC:3m:long:e6', 'confirmed', lv(6))];
    r = diffAlerts(r.state, payload({ BTC: g }), T0 + 6 * MIN);
    assertEqual(kinds(r), 'GOOD', 'GOOD always passes (candidate-id dedup only); its BREAKOUT is the same flag');
  });

  await test('WATCH memory rolls at 200 ids and survives parseState; level setup tracks nothing', () => {
    let st = withPrefs('watch');
    for (let i = 0; i < 205; i++) st = diffAlerts(st, payload({ BTC: formSym([cand(`BTC:3m:long:${i}`, 'forming', { breakoutLevel: 84000 + i * 100 })]) }), T0 + i * 16 * MIN).state;
    assertEqual(st.watch.ids.length, WATCH_RECENT_IDS, 'rolling 200');
    assertEqual(st.watch.ids[0].id, 'BTC:3m:long:5', 'oldest dropped');
    assertEqual(parseState(JSON.stringify(st)).watch.ids.length, 200, 'round trip');
    const s2 = diffAlerts(withPrefs('setup'), payload({ BTC: formSym() }), T0).state;
    assertEqual(s2.watch.ids.length, 0, 'no watch tracking below level watch');
  });

  await test('quiet hours: America/Chicago wall clock every day, CDT and CST, weekend, wrap, off', () => {
    const q = { ...DEFAULT_QUIET_HOURS };
    assertEqual(JSON.stringify(q), '{"start":1,"end":5}', 'default 01-05');
    // CDT (UTC-5), Wed 2026-07-15: 07:30Z = 02:30 local quiet; 10:30Z = 05:30 local not quiet.
    assertEqual(chicagoHour(Date.parse('2026-07-15T07:30:00Z')), 2, 'CDT hour');
    assert(inQuietHours(q, Date.parse('2026-07-15T07:30:00Z')), 'CDT 02:30 quiet');
    assert(!inQuietHours(q, Date.parse('2026-07-15T10:30:00Z')), 'CDT 05:30 not quiet');
    assert(!inQuietHours(q, Date.parse('2026-07-15T05:30:00Z')), 'CDT 00:30 not quiet');
    // CST (UTC-6), Thu 2026-01-15: 10:30Z = 04:30 local quiet (would be 05:30 under CDT).
    assertEqual(chicagoHour(Date.parse('2026-01-15T10:30:00Z')), 4, 'CST hour');
    assert(inQuietHours(q, Date.parse('2026-01-15T10:30:00Z')), 'CST 04:30 quiet');
    assert(inQuietHours(q, Date.parse('2026-01-15T07:00:00Z')), 'CST 01:00 quiet (start inclusive)');
    assert(!inQuietHours(q, Date.parse('2026-01-15T11:00:00Z')), 'CST 05:00 not quiet (end exclusive)');
    // Weekend: Sat 2026-09-26 02:00 CDT and Sun 2026-01-18 03:00 CST are quiet too.
    assert(inQuietHours(q, Date.parse('2026-09-26T07:00:00Z')), 'Saturday quiet');
    assert(inQuietHours(q, Date.parse('2026-01-18T09:00:00Z')), 'Sunday quiet');
    // Wrap past midnight and the string form; off.
    assert(inQuietHours('22-06', Date.parse('2026-07-16T04:00:00Z')) && !inQuietHours('22-06', Date.parse('2026-07-16T12:00:00Z')), 'wrap');
    assert(!inQuietHours(null, Date.parse('2026-07-15T07:30:00Z')), 'off');
    assert(!inQuietHours(q, T0), 'T0 (09:05 CDT) not quiet');
  });

  await test('/alerts parsing: show, levels, quiet HH-HH / off / show, errors', () => {
    const j = (args) => JSON.stringify(parseAlertsArgs(args));
    assertEqual(j([]), '{"action":"show"}', 'show');
    assertEqual(j(['WATCH']), '{"action":"level","level":"watch"}', 'level');
    assertEqual(j(['quiet']), '{"action":"quiet_show"}', 'quiet show');
    assertEqual(j(['quiet', 'off']), '{"action":"quiet_off"}', 'off');
    assertEqual(j(['quiet', '01-05']), '{"action":"quiet_set","quiet":{"start":1,"end":5}}', 'set');
    assertEqual(j(['quiet', '22-24']), '{"action":"quiet_set","quiet":{"start":22,"end":0}}', '24 = midnight');
    for (const bad of [['loud'], ['quiet', '5-5'], ['quiet', '25-3'], ['quiet', 'late'], ['good', 'setup'], ['quiet', '1-5', 'x']]) assertEqual(parseAlertsArgs(bad).action, 'error', `error ${bad}`);
    assertEqual(parseQuietSpec('0-24'), null, '0-24 is equal ends');
    assert(COMMANDS.includes('alerts'), 'alerts is a command');
    assertEqual(parseCommand('/alerts quiet 01-05').args.join(' '), 'quiet 01-05', 'command args');
  });

  await test('prefs persist in state: normalize, apply, parseState keeps off, diffAlerts carries prefs', () => {
    assertEqual(JSON.stringify(normalizePrefs({ level: 'loud', quiet: { start: 3, end: 3 } })), '{"level":"setup","quiet":{"start":1,"end":5},"alertTimeframes":["3m","5m"]}', 'garbage -> defaults');
    const off = parseState(applyPrefsChange(null, { quiet: null }));
    assertEqual(off.prefs.quiet, null, 'off persists as null');
    const lv = parseState(applyPrefsChange(JSON.stringify({ ...emptyState(), symbols: { BTC: { goodIds: ['k'] } } }), { level: 'watch' }));
    assertEqual(`${lv.prefs.level}|${lv.symbols.BTC.goodIds[0]}`, 'watch|k', 'level saved, alert memory kept');
    const d = diffAlerts(withPrefs('good', null), payload(), T0);
    assertEqual(JSON.stringify(d.state.prefs), '{"level":"good","quiet":null,"alertTimeframes":["3m","5m"]}', 'diff keeps prefs');
    assert(formatAlertPrefs(d.state.prefs).includes('Alert level: <b>good</b>') && formatAlertPrefs(d.state.prefs).includes('Quiet hours: off'), 'prefs text');
  });

  await test('webhook /alerts: shows, saves level and quiet in telegram/state.json; /status and /help show them', async () => {
    const blob = fakeBlob();
    const show = await hook({ text: '/alerts', blob });
    assert(show.tg.calls[0].text.includes('Alert level: <b>setup</b>') && show.tg.calls[0].text.includes('01:00–05:00 America/Chicago, every day'), show.tg.calls[0].text);
    const set = await hook({ text: '/alerts watch', blob });
    assert(set.tg.calls[0].text.startsWith('Saved.') && set.tg.calls[0].text.includes('<b>watch</b>'), set.tg.calls[0].text);
    await hook({ text: '/alerts quiet 22-06', blob });
    let st = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assertEqual(JSON.stringify(st.prefs), '{"level":"watch","quiet":{"start":22,"end":6},"alertTimeframes":["3m","5m"]}', 'persisted');
    const q = await hook({ text: '/alerts quiet', blob });
    assertEqual(q.tg.calls[0].text, 'Quiet hours: 22:00–06:00 America/Chicago, every day (alerts arrive silently)', 'quiet show');
    await hook({ text: '/alerts quiet off', blob });
    st = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assertEqual(st.prefs.quiet, null, 'off persisted');
    const status = await hook({ text: '/status', blob });
    assert(unpad(status.tg.calls[0].text).includes('Alert level: watch') && unpad(status.tg.calls[0].text).includes('Quiet hours: off'), status.tg.calls[0].text);
    const bad = await hook({ text: '/alerts loud', blob });
    assert(bad.tg.calls[0].text.startsWith('Usage: /alerts'), bad.tg.calls[0].text);
    const help = await hook({ text: '/help' });
    for (const f of ['/alerts good|setup|watch', '/alerts quiet HH-HH', '/alerts quiet off']) assert(help.tg.calls[0].text.includes(f), `help missing ${f}`);
  });

  await test('cron: reads level from state (watch sends the WATCH line); quiet hours send silently, never drop', async () => {
    const blob = fakeBlob();
    await blob.put(TELEGRAM_STATE_PATH, JSON.stringify(withPrefs('watch')), { allowOverwrite: false });
    const build = async () => payload({ ETH: formSym([cand('ETH:3m:long:W')]) });
    const tg = fakeTelegram();
    const r = await cron({ blob, tg, build });
    assert(tg.calls.some((c) => c.text && c.text.startsWith('⚪ Ξ <b>ETH 3m ▲ LONG</b> · WATCH · forming')), JSON.stringify(tg.calls.map((c) => c.text && c.text.slice(0, 40))));
    assert(tg.calls.every((c) => c.silent === false || c.silent === undefined), 'T0 (09:05 CDT) is loud');
    assertEqual(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).prefs.level, 'watch', 'cron keeps prefs');
    assertEqual(r.res.body.silent, false, 'silent flag');
    const night = Date.parse('2026-09-26T07:00:00Z'); // Saturday 02:00 CDT
    const tq = fakeTelegram();
    const rq = await cron({ tg: tq, nowMs: night, build: async () => payload({ closedThrough: new Date(night - 30_000).toISOString() }) });
    const msgs = tq.calls.filter((c) => c.method === 'sendMessage');
    assert(msgs.length > 0 && msgs.every((c) => c.silent === true), 'sent, silently');
    assertEqual(`${rq.res.body.silent}|${tq.calls.filter((c) => c.method === 'sendPhoto').length}`, 'true|2', 'photos still sent');
  });

  console.log('\ncommands');

  await test('parseCommand: bot suffix, case, args, unknown; no trade commands exist', () => {
    const c = parseCommand('/Chart@EditTradesBot btc 5m');
    assertEqual(`${c.cmd}|${c.args.join(',')}|${c.known}`, 'chart|btc,5m|true', 'chart');
    assertEqual(parseCommand('hello'), null, 'not a command');
    assertEqual(parseCommand('/buy BTC').known, false, '/buy unknown');
    for (const bad of ['buy', 'sell', 'open', 'close', 'execute', 'trade']) assert(!COMMANDS.includes(bad), `${bad} must not be a command`);
    assertEqual(parseSymbol('btcusdt'), 'BTC', 'symbol');
    assertEqual(parseSymbol('doge'), null, 'unknown symbol');
    assertEqual(parseJournalN('99'), 50, 'cap');
    assertEqual(parseJournalN(undefined), 10, 'default');
    assertEqual(parseAllowedIds(' 1, x, 22 ,').join(), '1,22', 'ids');
    assert(isAllowed(22, ['1', '22']) && !isAllowed(3, ['1']) && !isAllowed(null, ['1']), 'allow');
    assert(!inQuietHours('', T0) && !inQuietHours(null, T0), 'no quiet hours -> never quiet');
  });

  await test('/log text maps to the journal schema (took=open, closed=close, skipped=skip, else note)', () => {
    const open = parseLogText('took BTC long entry 84,600 stop 84390 tp 85100 10x');
    assertEqual(JSON.stringify(open), JSON.stringify({ text: 'took BTC long entry 84,600 stop 84390 tp 85100 10x', kind: 'open', symbol: 'BTC', direction: 'long', entry: 84600, stop: 84390, tp1: 85100, leverage: 10 }), 'open');
    const bare = parseLogText('took SOL short 151.2 sl 152');
    assertEqual(`${bare.entry}|${bare.stop}`, '151.2|152', 'bare price after direction');
    const close = parseLogText('closed BTC long at 85100 +2.3R');
    assertEqual(`${close.kind}|${close.exitPrice}|${close.resultR}|${close.entry}`, 'close|85100|2.3|undefined', 'close');
    assertEqual(parseLogText('skipped the ETH short').kind, 'skip', 'skip');
    assertEqual(parseLogText('market feels heavy').kind, 'note', 'note');
    for (const body of [open, bare, close]) {
      const v = validateJournalEntry(body, { now: T0, newId: () => 'tg_12345678', source: 'telegram' });
      assert(v.ok, `invalid: ${v.errors}`);
      assertEqual(v.record.source, 'telegram', 'source stamped');
      assertEqual(Object.keys(v.record).join(), RECORD_KEYS.join(), 'journal record keys');
    }
    assertEqual(validateJournalEntry({ text: 'x', source: 'telegram' }, { now: T0, newId: () => 'j_12345678' }).record.source, null, 'a body cannot set source');
  });

  console.log('\nwebhook');

  await test('POST only; secret header required (403); missing secret or token config -> 503 with a reason', async () => {
    assertEqual((await hook({ text: '/help', method: 'GET' })).res.statusCode, 405, 'GET');
    const noHeader = await hook({ text: '/help', secret: null });
    assertEqual(noHeader.res.statusCode, 403, 'no header');
    assertEqual(noHeader.tg.calls.length, 0, 'no reply on 403');
    assertEqual((await hook({ text: '/help', secret: 'wrong' })).res.statusCode, 403, 'wrong secret');
    const noSecret = await hook({ text: '/help', env: { ...ENV, TELEGRAM_WEBHOOK_SECRET: '' } });
    assertEqual(noSecret.res.statusCode, 503, 'secret unset');
    assert(/TELEGRAM_WEBHOOK_SECRET/.test(noSecret.res.body.error), 'reason');
    const noToken = await hook({ text: '/help', env: { ...ENV, TELEGRAM_BOT_TOKEN: '' } });
    assertEqual(noToken.res.statusCode, 503, 'token unset');
    assert(/TELEGRAM_BOT_TOKEN missing/.test(noToken.res.body.error), 'token reason');
  });

  await test('a sender outside the allowlist gets 200 and silence (no Bot API call, no build)', async () => {
    let built = 0;
    const r = await hook({ text: '/signals', from: 999, build: async () => { built++; return payload(); } });
    assertEqual(r.res.statusCode, 200, 'status');
    assertEqual(r.tg.calls.length, 0, 'silent');
    assertEqual(built, 0, 'no build for strangers');
    assert(!r.logs.join('\n').includes('999'), 'sender id not logged');
  });

  await test('/signals replies in HTML to the owner chat; the token never leaks into logs or bodies', async () => {
    const r = await hook({ text: '/signals' });
    assertEqual(r.res.statusCode, 200, 'status');
    assertEqual(r.tg.calls.length, 1, 'one message');
    const c = r.tg.calls[0];
    assert(c.tokenOk && c.method === 'sendMessage' && c.chatId === String(OWNER) && c.parseMode === 'HTML', JSON.stringify(c));
    assert(c.text.startsWith('🟢 ₿ <b>BTC 5m ▲ LONG</b> · SIGNAL\n<b>GET IN NOW</b> · BTC') && c.text.includes('<b>DATA</b>'), c.text.slice(0, 200));
    const all = `${r.logs.join('\n')}${JSON.stringify(r.res.body)}`;
    for (const s of [TOKEN, SECRET]) assert(!all.includes(s), 'secret leaked');
  });

  await test('/log writes through the journal append path with source telegram; redelivery is idempotent', async () => {
    const blob = fakeBlob();
    const r = await hook({ text: '/log took BTC long entry 84600 stop 84390 tp 85100', blob, updateId: 777001 });
    assertEqual(r.tg.calls[0].text, '[LOGGED tg_777001]', 'reply');
    const day = blob.files.get('journal/2026-09-24.jsonl');
    assert(day, 'day file written');
    const rec = JSON.parse(day.text.trim());
    assertEqual(`${rec.id}|${rec.kind}|${rec.symbol}|${rec.entry}|${rec.source}`, 'tg_777001|open|BTC|84600|telegram', 'record');
    assert(blob.files.get('journal/manifest.json'), 'manifest updated like the REST path');
    const again = await hook({ text: '/log took BTC long entry 84600 stop 84390 tp 85100', blob, updateId: 777001 });
    assertEqual(again.tg.calls[0].text, '[LOGGED tg_777001] (already logged)', 'duplicate reply');
    assertEqual(blob.files.get('journal/2026-09-24.jsonl').text.trim().split('\n').length, 1, 'one line');
    const j = await hook({ text: '/journal 1', blob });
    assert(j.tg.calls[0].text.includes('open BTC long $84,600.00') && j.tg.calls[0].text.includes('[tg]'), j.tg.calls[0].text);
    const bad = await hook({ text: `/log ${'x'.repeat(1200)}`, blob });
    assert(bad.tg.calls[0].text.startsWith('Not logged:'), 'validation error surfaced');
  });

  await test('/chart sends a photo; /chart with a bad symbol explains usage; /status reads the alert state', async () => {
    const r = await hook({ text: '/chart eth 15m' });
    const photo = r.tg.calls.find((c) => c.method === 'sendPhoto');
    assert(photo && photo.chatId === String(OWNER) && photo.caption.startsWith('ETH 15m') && photo.photo, JSON.stringify(r.tg.calls));
    const bad = await hook({ text: '/chart doge 5m' });
    assert(bad.tg.calls[0].text.includes('Unknown chart symbol') && bad.tg.calls[0].text.includes('Usage: /chart BTC 5m'), bad.tg.calls[0].text);
    const blob = fakeBlob();
    await blob.put(TELEGRAM_STATE_PATH, JSON.stringify({ ...emptyState(), cron: { lastRunAt: '2026-09-24T14:05:00Z' } }), { allowOverwrite: false });
    const st = await hook({ text: '/status', blob });
    assert(unpad(st.tg.calls[0].text).includes('Cron last run: 14:05 UTC'), st.tg.calls[0].text);
  });

  await test('/testalert sends a TEST-labelled GOOD card and chart; synthetic when no candidate exists', async () => {
    const r = await hook({ text: '/testalert' });
    assert(r.tg.calls[0].text.startsWith('🧪 TEST — NOT A SIGNAL'), r.tg.calls[0].text.slice(0, 50));
    assert(r.tg.calls.some((c) => c.method === 'sendPhoto' && c.caption.startsWith('TEST')), 'chart');
    const synth = testAlertSample(payload({ BTC: watchSym(), ETH: watchSym(), SOL: badSym() }));
    assertEqual(`${synth.symbol}|${synth.chart.timeframe}`, 'BTC|5m', 'synthetic sample');
  });

  await test('unknown and plain text get a hint; /buy is not a command; a failing build still answers 200', async () => {
    const r = await hook({ text: '/buy BTC 1000' });
    assert(r.tg.calls[0].text.startsWith('Unknown command /buy'), r.tg.calls[0].text);
    const p = await hook({ text: 'hi' });
    assertEqual(p.tg.calls[0].text, 'Send /help for the command list.', 'hint');
    const f = await hook({ text: '/signals', build: async () => { throw new Error('kraken down'); } });
    assertEqual(f.res.statusCode, 200, '200 so Telegram does not retry');
    assert(f.tg.calls[0].text.startsWith('Something failed'), 'error reply');
  });


  console.log('\nbuttons');

  await test('reply keyboard: persistent, resized, the four owner rows; on /start, /menu and every plain reply', async () => {
    const kb = menuKeyboard();
    assertEqual(JSON.stringify(kb.keyboard.map((r) => r.map((b) => b.text))), JSON.stringify(MENU_ROWS), 'rows');
    assertEqual(JSON.stringify(MENU_ROWS), '[["Signals","Flags","Market"],["Why BTC","Why ETH","Why SOL"],["Charts","Wallet","Positions"],["Journal","Status","Alerts","Tracking"]]', 'owner layout');
    assert(kb.resize_keyboard === true && kb.is_persistent === true, 'flags');
    for (const text of ['/start', '/menu', '/help', '/status', '/wallet', 'hello']) {
      const r = await hook({ text });
      const last = r.tg.calls[r.tg.calls.length - 1];
      assert(last.replyMarkup && last.replyMarkup.is_persistent && last.replyMarkup.keyboard, `${text} has the keyboard`);
    }
  });

  await test('menu labels map to commands (case-insensitive, exact label only)', async () => {
    const m = (t) => { const p = parseMenuLabel(t); return p ? `${p.cmd}${p.args.length ? ` ${p.args.join(' ')}` : ''}` : null; };
    const want = { Signals: 'signals', Flags: 'flags', 'Why BTC': 'why BTC', 'Why ETH': 'why ETH', 'Why SOL': 'why SOL', Charts: 'charts', Wallet: 'wallet', Journal: 'journal', Status: 'status', Alerts: 'alerts', Positions: 'positions', Tracking: 'tracking', Market: 'market' };
    for (const label of MENU_ROWS.flat()) assertEqual(m(label), want[label], label);
    assertEqual(m('why btc'), 'why BTC', 'lower case');
    assertEqual(m('  SIGNALS '), 'signals', 'upper, padded');
    for (const no of ['Why DOGE', 'signals please', 'Chart', '']) assertEqual(m(no), null, `not a label: ${no}`);
    const sig = await hook({ text: 'signals' });
    assert(sig.tg.calls[0].text.startsWith('🟢 ₿ <b>BTC 5m ▲ LONG</b> · SIGNAL'), 'label runs /signals');
    const flags = await hook({ text: 'Flags' });
    assert(flags.tg.calls[0].text.includes('<b>BTC</b>'), 'label runs /flags');
  });

  await test('Charts label -> 3x5 inline grid (chart:SYM:TF); Alerts label -> level + quiet buttons', async () => {
    const c = await hook({ text: 'Charts' });
    const grid = c.tg.calls[0].replyMarkup.inline_keyboard;
    assertEqual(grid.map((r) => r.map((b) => b.callback_data).join(',')).join(' | '),
      'chart:BTC:1m,chart:BTC:3m,chart:BTC:5m,chart:BTC:15m,chart:BTC:1h | chart:ETH:1m,chart:ETH:3m,chart:ETH:5m,chart:ETH:15m,chart:ETH:1h | chart:SOL:1m,chart:SOL:3m,chart:SOL:5m,chart:SOL:15m,chart:SOL:1h | flags:all', 'grid');
    const a = await hook({ text: 'Alerts' });
    assertEqual(a.tg.calls[0].replyMarkup.inline_keyboard.map((r) => r.map((b) => `${b.text}=${b.callback_data}`).join(',')).join(' | '),
      'Good=alerts:good,Setup=alerts:setup,Watch=alerts:watch | Quiet on=alerts:quiet:on,Quiet off=alerts:quiet:off | 3m+5m=alerts:tf:3m5m,5m only=alerts:tf:5m,all=alerts:tf:all', 'alerts buttons');
    assert(a.tg.calls[0].text.includes('Alert level: <b>setup</b>'), 'shows prefs');
  });

  await test('callback parsing; every callback_data fits 64 bytes; allowed_updates value', () => {
    const j = (d) => { const p = parseCallbackData(d); return p ? `${p.cmd}:${p.args.join(' ')}${p.kind ? `:${p.kind}:${p.symbol}:${p.ref}` : ''}` : null; };
    assertEqual(j('chart:BTC:1m'), 'chart:BTC 1m', 'chart');
    assertEqual(j('why:SOL'), 'why:SOL', 'why');
    assertEqual(j('alerts:watch'), 'alerts:watch', 'level');
    assertEqual(j('alerts:quiet:on'), 'alerts:quiet 1-5', 'quiet on = default window');
    assertEqual(j('alerts:quiet:off'), 'alerts:quiet off', 'quiet off');
    assertEqual(j('log:took:BTC:dc2f0cdc'), 'button_log::open:BTC:dc2f0cdc', 'took');
    assertEqual(j('log:skip:ETH:0000abcd'), 'button_log::skip:ETH:0000abcd', 'skip');
    for (const bad of ['chart:DOGE:1m', 'why:btc', 'log:took:BTC:xyz', 'log:sell:BTC:dc2f0cdc', 'buy:BTC', '', null, 'plan:xyz', 'plan:dc2f0cdc0', 'sell:dc2f0cdc', 'alerts:tf:15m', 'track:DC2F0CDC']) assertEqual(j(bad), null, `reject ${bad}`);
    const r = (d) => { const p = parseCallbackData(d); return p ? `${p.cmd}:${p.ref}` : null; };
    for (const c of ['plan', 'thesis', 'track', 'untrack', 'closed', 'partial', 'stillin', 'pclose']) assertEqual(r(`${c}:dc2f0cdc`), `${c}:dc2f0cdc`, c);
    assertEqual(j('alerts:tf:3m5m'), 'alerts:tf 3m,5m', 'tf picker 3m+5m');
    assertEqual(j('alerts:tf:5m'), 'alerts:tf 5m', 'tf picker 5m only');
    assertEqual(j('alerts:tf:all'), 'alerts:tf all', 'tf picker all');
    const longId = `BTC:15m:short:2026-09-24T13:50:00.000Z:${'x'.repeat(80)}`;
    const all = [...allCallbackData(chartsKeyboard()), ...allCallbackData(alertsKeyboard()), ...allCallbackData(tradeKeyboard('BTC', '15m', longId)),
      ...allCallbackData(tradeKeyboard('BTC', '15m', longId, { tracked: true })), ...allCallbackData(hitKeyboard(shortRef(longId), 'tp1')),
      ...allCallbackData(trackingKeyboard([trackEntry({ symbol: 'BTC', candidateId: longId, timeframe: '15m', direction: 'short' }, T0)], T0)),
      ...allCallbackData(positionsKeyboard([{ id: `j_${'a'.repeat(62)}`, symbol: 'BTC', direction: 'short', engineRef: { candidateId: longId }, text: 'x 15m' }]))];
    assert(all.length >= 30, `callbacks ${all.length}`);
    for (const d of all) assert(Buffer.byteLength(d) <= MAX_CALLBACK_BYTES, `${d} over 64 bytes`);
    assertEqual(shortRef('BTC:5m:long:2026-09-24T13:50:00.000Z'), 'dc2f0cdc', 'stable ref');
    assertEqual(JSON.stringify(ALLOWED_UPDATES), '["message","callback_query"]', 'allowed_updates');
  });

  await test('every alert carries Plan · Thesis · Chart / Track · Took it · Skipped; /signals has two rows per symbol block with a flag', async () => {
    const d = diffAlerts(emptyState(), payload({ ETH: watchSym(setupEth) }), T0);
    const good = d.alerts.find((x) => x.kind === 'GOOD');
    const ref = shortRef('BTC:5m:long:2026-09-24T13:50:00.000Z');
    assertEqual(good.replyMarkup.inline_keyboard.map((row) => row.map((b) => `${b.text}=${b.callback_data}`).join(',')).join(' | '),
      `Plan=plan:${ref},Thesis=thesis:${ref},Chart=chart:BTC:5m | Track=track:${ref},Took it=log:took:BTC:${ref},Skipped=log:skip:BTC:${ref}`, 'GOOD buttons');
    const setup = d.alerts.find((x) => x.kind === 'SETUP');
    const sref = shortRef(setupEth.candidateId);
    assertEqual(allCallbackData(setup.replyMarkup).join(','), `plan:${sref},thesis:${sref},chart:ETH:3m,track:${sref},log:took:ETH:${sref},log:skip:ETH:${sref}`, 'SETUP buttons');
    const w = diffAlerts(withPrefs('watch'), payload({ BTC: formSym() }), T0).alerts.find((x) => x.kind === 'WATCH');
    assertEqual(allCallbackData(w.replyMarkup)[0], `plan:${shortRef('BTC:3m:long:2026-09-24T14:00:00.000Z')}`, 'WATCH buttons');
    assertEqual(d.state.buttons[ref].entry, 84600, 'plan snapshot stored');
    let st = d.state;
    for (let i = 0; i < 60; i++) st = diffAlerts(st, payload({ BTC: goodSym(`BTC:5m:long:c${i}`), ETH: watchSym() }), T0 + (i + 1) * MIN).state;
    assertEqual(Object.keys(st.buttons).length, BUTTON_MEMORY, 'snapshots capped at 50');
    const kb = signalsKeyboard(payload());
    assertEqual(kb.inline_keyboard.map((r) => r.map((b) => b.text).join(',')).join(' | '),
      'Plan BTC,Thesis BTC,Chart BTC 5m | Track BTC,Took it BTC,Skipped BTC | Why ETH,Chart ETH 5m | Plan SOL,Thesis SOL,Chart SOL 1m | Track SOL,Took it SOL,Skipped SOL', 'signals rows');
    const sig = await hook({ text: '/signals' });
    assertEqual(JSON.stringify(sig.tg.calls[0].replyMarkup), JSON.stringify(kb), '/signals sends the inline rows');
    const tg = fakeTelegram();
    await cron({ tg });
    const goodMsg = tg.calls.find((c) => kindOf(c.text) === 'GOOD');
    assert(goodMsg.replyMarkup && allCallbackData(goodMsg.replyMarkup).includes(`log:took:BTC:${ref}`), 'cron sends the buttons');
  });

  await test('Took it from a cron GOOD alert writes kind open with the plan levels and engineRef; double tap logs once; Skipped = skip', async () => {
    const blob = fakeBlob();
    const tg = fakeTelegram();
    await cron({ blob, tg });
    const took = allCallbackData(tg.calls.find((c) => kindOf(c.text) === 'GOOD').replyMarkup).find((x) => x.startsWith('log:took:'));
    // The live plan has moved on: the log must use the alert's plan from state, not a rebuild.
    const t = await tap({ data: took, blob, build: async () => payload({ BTC: watchSym() }) });
    assertEqual(t.tg.calls[0].method, 'answerCallbackQuery', 'answered first');
    const ref = took.split(':')[3];
    assertEqual(t.tg.calls[1].text, `[LOGGED tg_open_${ref}] · tracking BTC 5m ▲ LONG for TP1 / stop`, 'reply (Took it implies Track)');
    const tracked = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).tracked;
    assertEqual(`${tracked.length}|${tracked[0].ref}|${tracked[0].took}|${tracked[0].entry}|${tracked[0].stop}|${tracked[0].tp1}`, `1|${ref}|true|84600|84390|85146`, 'tracked with the plan levels');
    const rec = JSON.parse(blob.files.get('journal/2026-09-24.jsonl').text.trim());
    assertEqual(`${rec.kind}|${rec.symbol}|${rec.direction}|${rec.entry}|${rec.stop}|${rec.tp1}|${rec.source}`, 'open|BTC|long|84600|84390|85146|telegram', 'record');
    assertEqual(JSON.stringify(rec.engineRef), JSON.stringify({ candidateId: 'BTC:5m:long:2026-09-24T13:50:00.000Z', planId: 'BTC:5m:long:2026-09-24T13:50:00.000Z|2026-09-24T14:05:00.000Z|cfg', recClass: 'GOOD', reasonCode: 'ready_flag_plan' }), 'engineRef');
    assertEqual(Object.keys(rec).join(), RECORD_KEYS.join(), 'journal schema keys');
    const again = await tap({ data: took, blob });
    assertEqual(again.tg.calls[1].text, `[LOGGED tg_open_${ref}] (already logged) · tracking BTC 5m ▲ LONG for TP1 / stop`, 'double tap');
    const skip = await tap({ data: took.replace('log:took:', 'log:skip:'), blob });
    assertEqual(skip.tg.calls[1].text, `[LOGGED tg_skip_${ref}]`, 'skip reply');
    const lines = blob.files.get('journal/2026-09-24.jsonl').text.trim().split('\n').map((l) => JSON.parse(l));
    assertEqual(lines.map((r) => r.kind).join(), 'open,skip', 'two records');
  });

  await test('Took it with no stored snapshot falls back to the live plan with that ref; an unknown ref explains', async () => {
    const blob = fakeBlob();
    const ref = shortRef(setupEth.candidateId);
    const t = await tap({ data: `log:took:ETH:${ref}`, blob, build: async () => payload({ ETH: watchSym(setupEth) }) });
    assertEqual(t.tg.calls[1].text, `[LOGGED tg_open_${ref}] · tracking ETH 3m ▼ SHORT for TP1 / stop`, 'logged from live SETUP');
    const rec = JSON.parse(blob.files.get('journal/2026-09-24.jsonl').text.trim());
    assertEqual(`${rec.symbol}|${rec.direction}|${rec.entry}|${rec.stop}|${rec.tp1}|${rec.engineRef.recClass}|${rec.engineRef.planId}`, 'ETH|short|2601.5|2612|2575|WATCH|null', 'setup levels');
    const gone = await tap({ data: 'log:took:SOL:00000000' });
    assert(gone.tg.calls[1].text.includes('no longer on file'), gone.tg.calls[1].text);
  });

  await test('callbacks: chart photo, why, alerts level/quiet persisted; allowlist applies (no answer, no build)', async () => {
    const c = await tap({ data: 'chart:ETH:15m' });
    assertEqual(c.tg.calls.map((x) => x.method).join(), 'answerCallbackQuery,sendPhoto', 'answer then photo');
    assert(c.tg.calls[1].caption.startsWith('ETH 15m'), 'chart caption');
    const w = await tap({ data: 'why:BTC' });
    assert(w.tg.calls[1].text.startsWith('<b>BTC — GOOD</b>'), w.tg.calls[1].text.slice(0, 40));
    const blob = fakeBlob();
    await tap({ data: 'alerts:watch', blob });
    await tap({ data: 'alerts:quiet:off', blob });
    assertEqual(JSON.stringify(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).prefs), '{"level":"watch","quiet":null,"alertTimeframes":["3m","5m"]}', 'level + off');
    const on = await tap({ data: 'alerts:quiet:on', blob });
    assertEqual(JSON.stringify(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).prefs.quiet), '{"start":1,"end":5}', 'on = default');
    assert(on.tg.calls[1].replyMarkup.inline_keyboard, 'alerts buttons again');
    const stale = await tap({ data: 'bogus:1' });
    assert(stale.tg.calls[1].text.includes('no longer valid'), 'unknown button');
    let built = 0;
    const stranger = await tap({ data: 'log:took:BTC:dc2f0cdc', from: 999, build: async () => { built++; return payload(); } });
    assertEqual(`${stranger.res.statusCode}|${stranger.tg.calls.length}|${built}`, '200|0|0', 'stranger: silence');
    assert(!stranger.logs.join('\n').includes('999'), 'sender id not logged');
  });

  console.log('\ncron');

  await test('cron: 401 without or with a wrong bearer; 503 with a reason when not configured', async () => {
    assertEqual((await cron({ auth: null })).res.statusCode, 401, 'no auth');
    assertEqual((await cron({ auth: 'Bearer nope' })).res.statusCode, 401, 'wrong');
    const a = await cron({ env: { ...ENV, CRON_SECRET: '' } });
    assertEqual(a.res.statusCode, 503, 'cron secret unset');
    const b = await cron({ env: { ...ENV, TELEGRAM_BOT_TOKEN: '' } });
    assertEqual(`${b.res.statusCode}|${/TELEGRAM_BOT_TOKEN missing/.test(b.res.body.error)}`, '503|true', 'token unset');
    const c = await cron({ env: { ...ENV, TELEGRAM_ALLOWED_USER_IDS: '' } });
    assertEqual(c.res.statusCode, 503, 'no recipients');
    assertEqual(a.tg.calls.length + b.tg.calls.length + c.tg.calls.length, 0, 'nothing sent');
  });

  await test('cron: a new GOOD goes to every allowed chat with its chart; the next run sends nothing', async () => {
    const blob = fakeBlob();
    const tg = fakeTelegram();
    const r = await cron({ blob, tg });
    assertEqual(r.res.statusCode, 200, 'status');
    const goodMsgs = tg.calls.filter((c) => c.method === 'sendMessage' && kindOf(c.text) === 'GOOD');
    assertEqual(goodMsgs.map((c) => c.chatId).sort().join(), `${OWNER},444`, 'both chats');
    assertEqual(tg.calls.filter((c) => c.method === 'sendPhoto').length, 2, 'chart per chat');
    const state = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assertEqual(state.symbols.BTC.class, 'GOOD', 'state stored');
    const before = tg.calls.length;
    const r2 = await cron({ blob, tg, nowMs: T0 + MIN });
    assertEqual(tg.calls.length, before, 'no resend');
    assertEqual(r2.res.body.stateWritten, false, 'no state write inside the heartbeat window');
    for (const s of [TOKEN, CRON]) assert(!`${r.logs.join('\n')}${JSON.stringify(r.res.body)}${blob.files.get(TELEGRAM_STATE_PATH).text}`.includes(s), 'secret leaked');
  });

  await test('cron: overlapping runs claim a transition once (ETag on state)', async () => {
    const blob = fakeBlob();
    const tg = fakeTelegram();
    await Promise.all([cron({ blob, tg }), cron({ blob, tg }), cron({ blob, tg })]);
    const good = tg.calls.filter((c) => c.method === 'sendMessage' && kindOf(c.text) === 'GOOD');
    assertEqual(good.length, 2, `one GOOD per chat, got ${good.length}`);
  });

  await test('cron: a failing build is a data problem, a failing Bot API is counted, neither throws', async () => {
    const blob = fakeBlob();
    const r = await cron({ blob, build: async () => { throw new Error('boom'); } });
    assertEqual(r.res.statusCode, 200, 'status');
    assert(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).health.dataBadSince, 'data problem started');
    const down = await cron({ tg: fakeTelegram({ fail: true }) });
    assertEqual(`${down.res.statusCode}|${down.res.body.sent}|${down.res.body.failed > 0}`, '200|0|true', 'send failures counted');
    const client = createBotClient({ token: '', fetchImpl: async () => { throw new Error('never'); } });
    assertEqual((await client.sendMessage(1, 'x')).error, 'token_missing', 'no token -> no call');
  });

  console.log('\nstate versioning + cron health');

  /** A pre-versioning (v1) state: what the previous deploy wrote - no stateVersion, no prefs/watch/buttons. */
  const toV1 = (st) => {
    const v1 = JSON.parse(JSON.stringify(st));
    delete v1.stateVersion; delete v1.prefs; delete v1.watch; delete v1.buttons;
    for (const k of Object.keys(v1.symbols)) delete v1.symbols[k].breakoutIds;
    return v1;
  };
  const kindsOf = (d) => d.alerts.map((a) => `${a.kind}:${a.symbol}`).join();

  await test('state v1 (no stateVersion, no prefs) migrates to v2 and produces the same alerts as the current state', async () => {
    const first = diffAlerts(emptyState(), payload(), T0).state;
    const v1 = toV1(first);
    const m = migrateState(JSON.stringify(v1));
    assertEqual(`${m.fromVersion}|${m.migrated}|${m.reset}|${m.state.stateVersion}`, `1|true|false|${STATE_VERSION}`, 'migration flags');
    assertEqual(JSON.stringify(m.state.prefs), JSON.stringify({ level: 'setup', quiet: { start: 1, end: 5 }, alertTimeframes: ['3m', '5m'] }), 'default prefs');
    assertEqual(`${m.state.watch.ids.length}|${JSON.stringify(m.state.buttons)}|${m.state.symbols.BTC.breakoutIds.length}`, '0|{}|0', 'missing memory -> empty');
    const next = payload({ BTC: goodSym(), ETH: watchSym(setupEth), SOL: badSym() });
    const fromV1 = diffAlerts(m.state, next, T0 + MIN);
    const fromCurrent = diffAlerts({ ...first, buttons: {}, watch: { ...first.watch, sigs: [] }, symbols: { ...first.symbols, BTC: { ...first.symbols.BTC, breakoutIds: [] } } }, next, T0 + MIN);
    assertEqual(kindsOf(fromV1), kindsOf(fromCurrent), 'same alerts');
    assert(kindsOf(fromV1).includes('SETUP:ETH') && !kindsOf(fromV1).includes('GOOD:BTC'), `dedup memory carried: ${kindsOf(fromV1)}`);
    assertEqual(fromV1.state.stateVersion, STATE_VERSION, 'write stamps stateVersion');
    assertEqual(JSON.parse(applyPrefsChange(JSON.stringify(v1), { level: 'good' })).stateVersion, STATE_VERSION, '/alerts write stamps stateVersion');
    const withUnknown = migrateState(JSON.stringify({ ...v1, futureField: { x: 1 } }));
    assertEqual(JSON.stringify(withUnknown.state.futureField), '{"x":1}', 'unknown fields kept');
  });

  await test('parseState never throws: corrupt JSON / wrong type reset; malformed parts default', async () => {
    for (const [text, reason] of [['{not json', 'unparseable'], ['[]', 'wrong_type'], ['42', 'wrong_type'], ['"x"', 'wrong_type'], ['null', 'wrong_type']]) {
      const m = migrateState(text);
      assertEqual(`${m.reset}|${m.reason}|${m.state.stateVersion}`, `true|${reason}|${STATE_VERSION}`, text);
    }
    assertEqual(migrateState(null).reset, false, 'no blob is a first run, not a reset');
    const weird = JSON.stringify({ symbols: { BTC: 5, ETH: { goodIds: 'x', setupIds: [1, 'a'] } }, health: 'x', alerts: { last: 3, today: 'many' }, watch: { ids: 'x', lastAt: 7 }, cron: 'y', prefs: { level: 'loud', quiet: 'z' }, buttons: [] });
    const st = parseState(weird);
    assertEqual(`${Object.keys(st.symbols).join()}|${st.symbols.ETH.goodIds.length}|${st.symbols.ETH.setupIds.join()}|${st.alerts.last}|${st.alerts.today}|${st.prefs.level}`, 'ETH|0|a|null|0|setup', 'sanitized');
    const d = diffAlerts(st, payload(), T0);
    assert(d.alerts.some((a) => a.kind === 'GOOD'), 'diff runs on the sanitized state');
  });

  await test('cron: v1 state in Blob migrates (written, stamped, logged); corrupt state resets with reason=state_reset', async () => {
    const first = diffAlerts(emptyState(), payload(), T0).state;
    const blob = fakeBlob();
    await blob.put(TELEGRAM_STATE_PATH, JSON.stringify(toV1(first)), { allowOverwrite: true });
    const tg = fakeTelegram();
    const r = await cron({ blob, tg, nowMs: T0 + MIN });
    assertEqual(`${r.res.statusCode}|${r.res.body.stateWritten}`, '200|true', 'migrated state written');
    assertEqual(tg.calls.filter((c) => kindOf(c.text) === 'GOOD').length, 0, 'no replay of the remembered GOOD');
    assertEqual(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).stateVersion, STATE_VERSION, 'stamped');
    assert(r.logs.some((l) => l.includes('reason=state_migrated from=1')), 'migration logged');
    const bad = fakeBlob();
    await bad.put(TELEGRAM_STATE_PATH, '{"symbols": {', { allowOverwrite: true });
    const r2 = await cron({ blob: bad });
    assertEqual(r2.res.statusCode, 200, 'corrupt state does not stop the cron');
    assert(r2.logs.some((l) => l.includes('reason=state_reset cause=unparseable')), r2.logs.join('\n'));
    assertEqual(JSON.parse(bad.files.get(TELEGRAM_STATE_PATH).text).stateVersion, STATE_VERSION, 'fresh state written');
    const h = await hook({ text: '/alerts watch', blob: bad });
    assert(h.tg.calls[0].text.startsWith('Saved.'), '/alerts works on a reset state');
  });

  await test('health counter: increments on failure, resets on success, no write while healthy', async () => {
    let h = parseHealth('garbage');
    assertEqual(h.failures, 0, 'garbage -> empty');
    const r0 = nextCronHealth(h, { ok: true }, T0);
    assertEqual(`${r0.write}|${r0.message}`, 'false|null', 'healthy: no write');
    for (let i = 1; i <= 2; i++) {
      const r = nextCronHealth(h, { ok: false, reason: 'state_write_Error' }, T0 + i * MIN);
      assertEqual(`${r.health.failures}|${r.message}`, `${i}|null`, `failure ${i}`);
      h = r.health;
    }
    assertEqual(h.since, new Date(T0 + MIN).toISOString(), 'since = first failure');
    const ok = nextCronHealth(h, { ok: true }, T0 + 3 * MIN);
    assertEqual(`${ok.health.failures}|${ok.message}|${ok.write}|${ok.health.lastReason}`, '0|null|true|state_write_Error', 'reset, no RECOVERED below 3, reason kept');
  });

  await test('health alert: FAILING on the 3rd consecutive failure only, then hourly; RECOVERED once', async () => {
    let h = parseHealth(null);
    const msgs = [];
    const step = (outcome, t) => { const r = nextCronHealth(h, outcome, t); h = r.health; msgs.push(r.message); return r; };
    for (let i = 0; i < 5; i++) step({ ok: false, reason: 'state_write_Error' }, T0 + i * MIN);
    assertEqual(msgs.map((m) => (m ? 'M' : '-')).join(''), '--M--', 'third only');
    assert(msgs[2].includes('ALERTS CRON FAILING') && msgs[2].includes('state_write_Error') && msgs[2].includes('since 14:05 UTC'), msgs[2]);
    assertEqual(step({ ok: false, reason: 'x' }, T0 + 2 * MIN + CRON_FAIL_REPEAT_MS - 1).message, null, 'under an hour');
    assert(step({ ok: false, reason: 'x' }, T0 + 2 * MIN + CRON_FAIL_REPEAT_MS).message.includes('FAILING'), 'hourly repeat');
    const rec = step({ ok: true }, T0 + 2 * CRON_FAIL_REPEAT_MS);
    assert(rec.message.includes('ALERTS CRON RECOVERED'), 'recovered');
    assertEqual(step({ ok: true }, T0 + 2 * CRON_FAIL_REPEAT_MS + MIN).message, null, 'recovered once');
    assertEqual(CRON_FAIL_ALERT_AFTER, 3, 'threshold');
  });

  await test('cron: state write failing -> 503 with error text logged, health blob counts (overwrite, no ETag), alert on 3rd, recovered; /status shows it', async () => {
    const blob = fakeBlob();
    const realPut = blob.put;
    const healthOpts = [];
    let broken = true;
    blob.put = async (pathname, body, opts) => {
      if (pathname === TELEGRAM_STATE_PATH && broken) throw Object.assign(new Error(`store rejected write for ${TOKEN}`), { name: 'Error' });
      if (pathname === TELEGRAM_HEALTH_PATH) healthOpts.push(opts);
      return realPut(pathname, body, opts);
    };
    const tg = fakeTelegram();
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await cron({ blob, tg, nowMs: T0 + i * MIN }));
    assertEqual(runs.map((r) => r.res.statusCode).join(), '503,503,503,503', 'status');
    const line = runs[0].logs.find((l) => l.includes('status=503'));
    assert(line.includes('reason=state_write_Error msg="store rejected write for [redacted]"'), line);
    assert(!runs.flatMap((r) => r.logs).join('\n').includes(TOKEN), 'token never logged');
    assert(healthOpts.every((o) => o.allowOverwrite === true && !o.ifMatch), 'health: overwrite, no ETag');
    const failing = tg.calls.filter((c) => c.text && c.text.includes('ALERTS CRON FAILING'));
    assertEqual(failing.map((c) => c.chatId).sort().join(), `${OWNER},444`, 'one FAILING per allowed user');
    assertEqual(parseHealth(blob.files.get(TELEGRAM_HEALTH_PATH).text).failures, 4, 'counter');
    const st = await hook({ text: '/status', blob });
    assert(unpad(st.tg.calls[0].text).includes('Cron failures: 4 in a row · last failure: state_write_Error'), st.tg.calls[0].text);
    broken = false;
    const ok = await cron({ blob, tg, nowMs: T0 + 5 * MIN });
    assertEqual(ok.res.statusCode, 200, 'recovers');
    assertEqual(tg.calls.filter((c) => c.text && c.text.includes('ALERTS CRON RECOVERED')).length, 2, 'RECOVERED once per user');
    await cron({ blob, tg, nowMs: T0 + 6 * MIN });
    assertEqual(tg.calls.filter((c) => c.text && c.text.includes('ALERTS CRON RECOVERED')).length, 2, 'not repeated');
    assertEqual(errText(new Error('x'.repeat(500))).length, 200, 'msg capped at 200');
  });

  console.log('\ntracker');

  await test('tracker keeps only the heartbeat and alert counters, and the Status Alerts fact renders both states', async () => {
    const state = { ...emptyState(), cron: { lastRunAt: '2026-09-24T14:00:00Z' }, symbols: { BTC: { goodIds: ['secret-ish'] } }, alerts: { day: '2026-09-24', today: 4, last: { at: '2026-09-24T13:55:00Z', symbol: 'ETH', kind: 'SETUP' } } };
    const st = telegramStatusFromState(state);
    assertEqual(Object.keys(st).join(), 'cronLastRunAt,alertsDay,alertsToday,lastAlert', 'whitelist');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-status-'));
    const fetchImpl = async (url) => (String(url).startsWith(`${BASE}/telegram/state.json?t=`) ? new Response(JSON.stringify(state), { status: 200 }) : new Response('', { status: 404 }));
    const pulled = await pullTelegramStatus(dir, BASE, fetchImpl, 1);
    assertEqual(JSON.stringify(pulled), JSON.stringify(st), 'pulled');
    assert(!readFileSync(path.join(dir, 'telegram-status.json'), 'utf8').includes('secret-ish'), 'ids never reach the tracker');
    assertEqual(await pullTelegramStatus(dir, 'https://none.example', async () => new Response('', { status: 404 })), null, '404 -> null');
    const html = alertsFact(st, T0);
    assert(html.includes('id="system-alerts-fact"') && html.includes('SETUP ETH · 4 today') && html.includes('TELEGRAM CRON 6 MIN AGO'), html);
    assert(alertsFact(null, T0).includes('[NO ALERTS YET]'), 'graceful empty');
  });

  console.log('\nisolation');

  const BANNED = ['execute-trade', 'jupiterPerps', 'walletManager', 'tradeExecution', 'positionManager', 'jupiterSwap', 'perpsProvider', 'driftPerps', 'mangoPerps', 'jup-perps', '@solana/web3.js', 'bs58', 'bip39', 'ed25519-hd-key'];
  const importsOf = (rel) => [...readFileSync(path.join(root, rel), 'utf8').matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] || m[2] || m[3]);

  await test('the two Telegram functions and lib/telegram.js import no execution, signing or wallet-writing module', () => {
    for (const f of ['api/telegram-webhook.js', 'api/telegram-cron.js', 'lib/telegram.js']) {
      const src = readFileSync(path.join(root, f), 'utf8');
      for (const mod of BANNED) assert(!importsOf(f).some((i) => i.includes(mod)), `${f} imports ${mod}`);
      for (const env of ['SOLANA_PRIVATE_KEY', 'TRADE_EXECUTION_API_KEY', 'TRADE_EXECUTION_ENABLED', 'SOLANA_RPC_URL']) assert(!src.includes(env), `${f} references ${env}`);
    }
    assertEqual(importsOf('lib/telegram.js').length, 0, 'lib/telegram.js is import-free');
  });

  await test('nothing reachable from the Telegram functions (transitive relative imports) is an execution module', () => {
    const seen = new Set();
    const stack = ['api/telegram-webhook.js', 'api/telegram-cron.js'];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const i of importsOf(f)) {
        for (const mod of BANNED) assert(!i.includes(mod), `${f} imports ${i}`);
        if (!i.startsWith('.')) continue;
        const next = path.relative(root, path.resolve(path.dirname(path.join(root, f)), i));
        if (existsSync(path.join(root, next))) stack.push(next);
      }
    }
    assert(seen.has('services/scalpContext.js') && seen.has('api/journal.js'), 'walked the context and journal');
  });

  await test('MCP route does not import the Telegram code; vercel.json routes both functions before the catch-all and runs the cron every minute', () => {
    for (const f of ['lib/mcpHttp.js', 'services/editTradesMcp.js']) assert(!importsOf(f).some((i) => /telegram/i.test(i)), `${f} imports telegram`);
    const cfg = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    const catchAll = cfg.routes.findIndex((r) => r.src === '/api/(.*)');
    for (const dest of ['/api/telegram-webhook.js', '/api/telegram-cron.js']) {
      const i = cfg.routes.findIndex((r) => r.dest === dest);
      assert(i >= 0 && i < catchAll, `${dest} routed before the catch-all`);
    }
    assertEqual(JSON.stringify(cfg.crons), JSON.stringify([{ path: '/api/telegram-cron', schedule: '* * * * *' }]), 'crons');
    assertEqual(cfg.git && cfg.git.deploymentEnabled, false, 'git deploys stay off');
  });

  console.log('\nbreakout alerts');

  const chaseBtc = () => {
    const c = { candidateId: 'BTC:5m:long:2026-09-24T14:00:00.000Z', type: 'flag', timeframe: '5m', direction: 'long', state: 'confirmed', breakoutLevel: 84479, invalidation: 84349.7, measuredTarget: 84985, measuredRR: 3.91 };
    const setup = { candidateId: c.candidateId, timeframe: '5m', direction: 'long', entry: 84479, stop: 84349.7, tp1: 84985, grossRR: 3.91, netRR: 3.3, entryCondition: 'wait for a 5m retest of 84,479.00 that holds above it' };
    const w = watchSym(setup);
    return {
      ...w, candidateSetups: [c],
      flagTradePlan: { planId: `${c.candidateId}|t|cfg`, candidateId: c.candidateId, status: 'rejected', reasonCode: 'chase', timeframe: '5m', direction: 'long', entry: 84479, stop: 84349.7, tp1: null, grossRR: null, netRR: null, setup },
      flagRecommendation: { ...w.flagRecommendation, class: 'BAD', candidateId: c.candidateId, primaryReason: { code: 'chase', text: 'chase' }, setup }
    };
  };

  await test('BREAKOUT line format (own chase plan + setup -> BE READY; no setup -> STAND DOWN; another candidate selected)', () => {
    const s = chaseBtc();
    const t = formatBreakoutAlert('BTC', s.candidateSetups[0], s.flagTradePlan, s.flagRecommendation, { asOf: '2026-09-24T14:02:00.000Z' });
    checkAlert(t, ['🟡 ₿ <b>BTC 5m ▲ LONG</b> · BREAKOUT', '<b>BE READY (3m)</b> — no chase; enter on a retest of 84,479.00 that holds above'], 'chase with setup');
    assert(/TP1 +84,985\.00/.test(secs(t)[3]), 'setup levels in the PLAN section');
    assertEqual(verdictOf(formatBreakoutAlert('BTC', s.candidateSetups[0], s.flagTradePlan)), '<b>STAND DOWN</b> — ran past breakout', 'chase, no setup');
    checkAlert(formatBreakoutAlert('BTC', { ...s.candidateSetups[0], direction: 'short' }, null), ['🔴 ₿ <b>BTC 5m ▼ SHORT</b> · BREAKOUT', '<b>STAND DOWN</b> — another flag is the live plan'], 'short, not selected');
  });

  await test('BREAKOUT: once per candidateId at every level; carries its own SETUP (no second SETUP alert); trade buttons; no repeat per candle', () => {
    const p = () => payload({ BTC: chaseBtc(), ETH: watchSym(), SOL: watchSym() });
    for (const level of ['good', 'setup', 'watch']) {
      const r = diffAlerts(withPrefs(level), p(), T0);
      const kinds = r.alerts.map((a) => a.kind).join();
      assertEqual(kinds, 'BREAKOUT', `${level}: the BREAKOUT carries the setup's BE READY line`);
      assert(r.alerts[0].text.includes('<b>BE READY (5m)</b> — no chase; enter on a retest of 84,479.00'), r.alerts[0].text);
      assert(r.state.symbols.BTC.setupIds.includes('BTC:5m:long:2026-09-24T14:00:00.000Z'), `${level}: setup remembered`);
      const ref = shortRef('BTC:5m:long:2026-09-24T14:00:00.000Z');
      assertEqual(allCallbackData(r.alerts[0].replyMarkup).join(), `plan:${ref},thesis:${ref},chart:BTC:5m,track:${ref},log:took:BTC:${ref},log:skip:BTC:${ref}`, `${level}: buttons`);
      assertEqual(`${r.state.buttons[ref].entry}|${r.state.buttons[ref].stop}|${r.state.buttons[ref].tp1}|${r.state.buttons[ref].reasonCode}`, '84479|84349.7|84985|chase', `${level}: Took it snapshot (candidate target when the plan has no tp1)`);
      const again = diffAlerts(r.state, payload({ BTC: chaseBtc(), ETH: watchSym(), SOL: watchSym(), closedThrough: '2026-09-24T14:10:00.000Z' }), T0 + 5 * MIN);
      assertEqual(again.alerts.length, 0, `${level}: next candle sends nothing`);
    }
    const st = diffAlerts(emptyState(), payload({ BTC: formSym([cand('B:x', 'forming')]) }), T0).state;
    assertEqual(st.symbols.BTC.breakoutIds.length, 0, 'forming is not a breakout');
    const confirmedNow = diffAlerts(st, payload({ BTC: formSym([cand('B:x', 'confirmed')]) }), T0 + MIN);
    assertEqual(confirmedNow.alerts.map((a) => a.kind).join(), 'BREAKOUT', 'forming -> confirmed fires');
    assert(BREAKOUT_RECENT_IDS >= 20, 'memory');
  });

  await test('cron: BREAKOUT sends with its buttons to every allowed chat, once', async () => {
    const blob = fakeBlob();
    const build = async () => payload({ BTC: chaseBtc(), ETH: watchSym(), SOL: watchSym() });
    const first = await cron({ blob, build });
    const b = first.tg.calls.filter((c) => c.method === 'sendMessage' && kindOf(c.text) === 'BREAKOUT');
    assertEqual(b.length, 2, 'two chats');
    assert(b.every((c) => c.replyMarkup && c.replyMarkup.inline_keyboard.length === 2 && c.replyMarkup.inline_keyboard.every((row) => row.length === 3)), 'buttons');
    const second = await cron({ blob, build, nowMs: T0 + MIN });
    assertEqual(second.tg.calls.filter((c) => kindOf(c.text) === 'BREAKOUT').length, 0, 'once');
  });

  console.log('\nflag albums');

  const fc = (id, tf, dir, st, extra = {}) => ({ candidateId: id, type: 'flag', timeframe: tf, direction: dir, state: st, breakoutLevel: 84466.1, invalidation: 84331.6, measuredRR: 2.43, ...extra });
  const albumPayload = () => payload({
    BTC: formSym([
      fc('B1', '3m', 'long', 'forming', { qual: { decision: 'watch', reasons: ['room:blocked-15m'] } }),
      fc('B2', '3m', 'short', 'proto'),
      fc('B3', '1m', 'long', 'confirmed'),
      fc('B4', '5m', 'long', 'failed', { failReason: 'invalidated' }),
      fc('B5', '15m', 'short', 'expired')
    ]),
    ETH: formSym([fc('E1', '5m', 'short', 'triggering')]),
    SOL: formSym([fc('S1', '1m', 'long', 'failed')])
  });

  await test('collectLiveFlags: live states only (failed out), grouped per symbol and timeframe, tf order; /flags SYM limits', () => {
    assertEqual(LIVE_FLAG_STATES.join(), 'proto,forming,triggering,confirmed,expired', 'states');
    const g = collectLiveFlags(albumPayload());
    assertEqual(g.map((x) => `${x.symbol}:${x.charts.map((c) => `${c.timeframe}=${c.candidates.map((k) => k.candidateId).join('+')}`).join(',')}`).join(' | '),
      'BTC:1m=B3,3m=B1+B2,15m=B5 | ETH:5m=E1 | SOL:', 'grouping');
    assertEqual(collectLiveFlags(albumPayload(), 'ETH').map((x) => x.symbol).join(), 'ETH', 'only');
  });

  await test('caption: one line per candidate + closed through, HTML-safe, under 1,000 chars', () => {
    assertEqual(formatFlagLine('BTC', fc('x', '3m', 'long', 'forming', { qual: { decision: 'watch', reasons: ['room:blocked-15m'] } })),
      'BTC 3m · LONG forming · brk 84,466.10 · void 84,331.60 · 2.4R · qual watch (room:blocked-15m)', 'line');
    const chart = collectLiveFlags(albumPayload())[0].charts[1];
    const cap = formatFlagCaption(chart, '2026-09-24T14:05:00.000Z');
    assertEqual(cap.split('\n').length, 3, 'two candidates + tail');
    assert(cap.includes('SHORT proto') && cap.endsWith('closed through 14:05 UTC'), cap);
    const many = { symbol: 'BTC', timeframe: '3m', candidates: Array.from({ length: 40 }, (_, i) => fc(`m${i}`, '3m', 'long', 'forming', { qual: { decision: 'watch', reasons: ['a<b', 'room:blocked-15m', 'ct:4h'] } })) };
    const long = formatFlagCaption(many, '2026-09-24T14:05:00.000Z');
    assert(long.length <= 1000 && long.endsWith('UTC') && long.includes('a&lt;b'), `len ${long.length}`);
    assertEqual(formatNoLiveFlags('BTC'), 'BTC · no live flags', 'no-live line');
  });

  await test('media-group chunking (<= 10), 9-image cap across symbols, EMA tail series', () => {
    assertEqual(chunkMediaGroup(Array.from({ length: 23 }, (_, i) => i)).map((c) => c.length).join(), '10,10,3', 'chunks');
    assertEqual(MAX_MEDIA_GROUP, 10, 'group max');
    const groups = ['BTC', 'ETH', 'SOL'].map((symbol) => ({ symbol, charts: Array.from({ length: 5 }, (_, i) => ({ symbol, timeframe: `t${i}`, candidates: [] })) }));
    const { groups: capped, dropped } = capFlagCharts(groups, MAX_FLAG_CHARTS);
    assertEqual(`${capped.map((g) => g.charts.length).join()}|${dropped}|${capped[2].capped}`, '5,4,0|6|true', 'cap 9');
    const closes = [100, 101, 102, 101.5, 103];
    const k = 2 / 22;
    let e = 99; const fwd = closes.map((c) => (e = e + k * (c - e)));
    const back = emaTailSeries(closes, fwd[fwd.length - 1], 21);
    assert(back.every((v, i) => Math.abs(v - fwd[i]) < 0.01), JSON.stringify(back));
    assertEqual(emaTailSeries(closes, null, 21), null, 'no last ema');
    const p = { symbols: { BTC: { timeframes: { '3m': { candles: closes.map((c) => ({ c })), ema21: fwd[4], ema200: 100 } } } } };
    assertEqual(albumSeries(p, 'BTC', '3m').ema21.length, 5, 'album series');
    assertEqual(JSON.stringify(albumSeries(p, 'ETH', '3m')), '{}', 'missing tf');
  });

  await test('/flags: summary first, then one album per symbol (sendMediaGroup, attach:// parts), no-live line; one full build', async () => {
    let builds = 0;
    const r = await hook({ text: '/flags', build: async (o) => { builds++; assert(o === undefined, 'full build, no chart opt'); return albumPayload(); } });
    assertEqual(builds, 1, 'one build');
    assertEqual(r.tg.calls.map((c) => c.method).join(), 'sendMessage,sendMediaGroup,sendPhoto,sendMessage', 'order');
    assert(r.tg.calls[0].text.includes('<b>BTC</b>'), 'summary first');
    const album = r.tg.calls[1];
    assertEqual(album.media.length, 3, 'BTC 1m, 3m, 15m');
    assert(album.media.every((m, i) => m.type === 'photo' && m.media === `attach://photo${i}` && m.parse_mode === 'HTML'), JSON.stringify(album.media));
    assert(album.files.every((f) => f && f.size === fakePng.length), 'file parts');
    assert(album.media[1].caption.startsWith('BTC 3m · LONG forming') && album.media[1].caption.includes('BTC 3m · SHORT proto'), album.media[1].caption);
    assert(r.tg.calls[2].caption.startsWith('ETH 5m · SHORT triggering'), 'single ETH chart via sendPhoto');
    assertEqual(r.tg.calls[3].text, 'SOL · no live flags', 'SOL failed only -> no live flags');
    const one = await hook({ text: '/flags eth' });
    assertEqual(one.tg.calls.map((c) => c.method).join(), 'sendMessage,sendMessage', 'fixture ETH has no candidates');
    assertEqual(one.tg.calls[1].text, 'ETH · no live flags', 'no-live line');
  });

  await test('/flags: a failing or slow chart falls back to caption text + [chart unavailable]; the rest still sends', async () => {
    const render = async (p, req) => {
      if (req.timeframe === '3m') throw new Error('boom');
      return fakeRender();
    };
    const r = await hook({ text: '/flags BTC', build: async () => albumPayload(), render });
    assertEqual(r.tg.calls.map((c) => c.method).join(), 'sendMessage,sendMediaGroup,sendMessage', 'order');
    assertEqual(r.tg.calls[1].media.length, 2, '1m + 15m');
    assert(r.tg.calls[2].text.startsWith('BTC 3m · LONG forming') && r.tg.calls[2].text.endsWith('[chart unavailable]'), r.tg.calls[2].text);
    const tg = fakeTelegram();
    const bot = createBotClient({ token: TOKEN, fetchImpl: tg.fetchImpl });
    const replies = [];
    const out = await sendFlagAlbums({ bot, chatId: 1, payload: albumPayload(), only: 'ETH', render: () => new Promise(() => {}), reply: async (t) => replies.push(t), budgetMs: 20 });
    assertEqual(`${out.images}|${out.failed}`, '0|1', 'timed out');
    assert(replies[0].endsWith('[chart unavailable]'), replies[0]);
  });

  await test('/flags: 9-image cap with a limit line; Charts -> All flags runs the albums; allowlist still enforced; webhook maxDuration 60', async () => {
    const tfs = ['1m', '3m', '5m', '15m', '1h'];
    const five = (s) => formSym(tfs.map((tf) => fc(`${s}${tf}`, tf, 'long', 'forming')));
    let rendered = 0;
    const r = await hook({ text: '/flags', build: async () => payload({ BTC: five('B'), ETH: five('E'), SOL: five('S') }), render: async () => { rendered++; return fakeRender(); } });
    assertEqual(rendered, 9, 'nine renders');
    const sentImages = r.tg.calls.reduce((n, c) => n + (c.method === 'sendMediaGroup' ? c.media.length : c.method === 'sendPhoto' ? 1 : 0), 0);
    assertEqual(sentImages, 9, 'nine images');
    assert(r.tg.calls[r.tg.calls.length - 1].text.startsWith('+6 more flag charts over the 9-image limit'), r.tg.calls[r.tg.calls.length - 1].text);
    assert(!r.tg.calls.some((c) => c.text === 'SOL · no live flags'), 'capped symbol is not "no live flags"');
    assertEqual(JSON.stringify(parseCallbackData('flags:all')), JSON.stringify({ cmd: 'flags', args: [], rest: '', known: true }), 'callback');
    const t = await tap({ data: 'flags:all', build: async () => albumPayload() });
    assertEqual(t.tg.calls.map((c) => c.method).join(), 'answerCallbackQuery,sendMessage,sendMediaGroup,sendPhoto,sendMessage', 'button runs /flags');
    let built = 0;
    const stranger = await hook({ text: '/flags', from: 999, build: async () => { built++; return albumPayload(); } });
    assertEqual(`${stranger.tg.calls.length}|${built}`, '0|0', 'stranger: silence');
    const st = await tap({ data: 'flags:all', from: 999, build: async () => { built++; return albumPayload(); } });
    assertEqual(`${st.tg.calls.length}|${built}`, '0|0', 'stranger tap: silence');
    assertEqual(webhookConfig.maxDuration, 60, 'maxDuration');
  });

  // ---------------------------------------------------------------- Plan / Thesis / Track / Positions / Market

  console.log('\nplan, thesis, track, positions, market');

  const SOL_ID = 'SOL:3m:short:2026-09-24T13:57:00.000Z';
  const SOL_REF = shortRef(SOL_ID);
  const SOL_RISK = { maxLeverage: 25, suggestedLeverage: 20, lossAtStopUsd: 0.57, lossAtStopPct: 5.65, lossAtStopPctOfWallet: 0.11, collateralUsd: 10, reason: null };
  const SOL_MARK = { price: 116.72, driftBps: 1.7, status: 'ok' };
  /** SOL 3m SHORT flag at a candidate state, with an own plan of `plan` status (null = none) and optional SETUP. */
  function solSym({ state = 'confirmed', plan = 'ready', price = 116.7, mark = SOL_MARK, setup = false, risk = SOL_RISK } = {}) {
    const c = { candidateId: SOL_ID, type: 'flag', timeframe: '3m', direction: 'short', state, breakoutLevel: 116.77, invalidation: 117.1, measuredTarget: 115.6, measuredRR: 3.5, chaseRisk: false, ...(risk && (state === 'triggering' || state === 'confirmed') ? { risk } : {}) };
    const rej = plan === 'rejected';
    const planObj = plan ? {
      candidateId: SOL_ID, planId: `${SOL_ID}|t|cfg`, status: plan, reasonCode: rej ? 'rr_below_min' : plan === 'conditional' ? 'awaiting_retest' : null, timeframe: '3m', direction: 'short',
      entry: 116.77, stop: 117.1, tp1: rej ? 116.3 : 115.9, tp2: rej ? null : 115.6, grossRR: rej ? 1.42 : 2.64, netRR: rej ? 1.0 : 2.2, stopDistancePct: 0.283,
      entryCondition: 'a closed candle closes below 116.77, then a later closed candle\'s high reaches within 0.25 ATR of 116.77 and closes at or below it'
    } : null;
    const setupObj = setup ? { candidateId: SOL_ID, timeframe: '3m', direction: 'short', entry: 116.77, stop: 117.1, tp1: 115.9, grossRR: 2.64, netRR: 2.2, entryCondition: 'wait for a 3m retest of 116.77 that holds below it' } : null;
    return {
      price, mark, candidateSetups: [c], flagTradePlan: planObj,
      flagRecommendation: {
        class: plan === 'ready' ? 'GOOD' : rej ? 'BAD' : 'WATCH', setupId: planObj ? planObj.planId : null, candidateId: planObj ? SOL_ID : null, asOf: '2026-09-24T14:05:00.000Z', readiness: plan || 'no_plan',
        candidate: planObj ? null : { candidateId: SOL_ID, timeframe: '3m', direction: 'short', state, breakout: 116.77, invalidation: 117.1, measuredRR: 3.5 },
        setup: setupObj, action: null,
        room: planObj ? { toLevel: 'tp1_cap', levelPrice: planObj.tp1, levelSource: '15m support', pts: 0.87, r: planObj.grossRR, stop: 117.1 } : null,
        primaryReason: { code: rej ? 'rr_below_min' : 'ready_flag_plan', text: 'x' },
        supports: ['ready_flag_plan', 'rr_ok', 'net_rr_ok', 'ema21_flag_context', 'ema200:3m:below', 'divergence_agrees', 'data_fresh'],
        opposes: ['td:bull:3/4', 'ct:4h', 'level:15m:115.9', 'tp1_capped:115.9', 'conflict:5m-long', 'stoch:os-cross', 'rr:2.4', 'chan:15m:bottom:high'],
        unknowns: ['4h:flat', 'a200:unknown', 'room:blocked-15m', 'candidate:3m-short-forming', 'data_stale:1h', 'stale_data:1h', 'fees_heavy', 'unclassified_rejection', 'divergence_absent', 'level:none'],
        changeConditions: [{ code: 'call_changes_on_invalidation', text: 'Call changes if price invalidates the plan at 117.1, TP1 becomes blocked below 2.5R gross, or required data goes stale.' }]
      },
      pathOutlook: { id: SOL_ID, tf: '3m', dir: 'short', at: 'broken', lean: 'breakout', likely: 'retest_go', chase: 'low', w: {}, n: 412, cal: true }
    };
  }
  /** Long mirror of solSym around the breakout (levels reflect, R unchanged). */
  function solLong(opts = {}) {
    const s = solSym(opts);
    const m = (v) => (typeof v === 'number' ? Math.round((2 * 116.77 - v) * 100) / 100 : v);
    const id = SOL_ID.replace('short', 'long');
    const c = { ...s.candidateSetups[0], candidateId: id, direction: 'long', invalidation: m(117.1), measuredTarget: m(115.6) };
    const plan = s.flagTradePlan ? { ...s.flagTradePlan, candidateId: id, direction: 'long', stop: m(117.1), tp1: m(s.flagTradePlan.tp1), tp2: m(s.flagTradePlan.tp2) } : null;
    const rec = { ...s.flagRecommendation, candidateId: plan ? id : null, supports: ['td:bull:3/4', ...s.flagRecommendation.supports], opposes: [], room: s.flagRecommendation.room ? { ...s.flagRecommendation.room, levelPrice: m(s.flagRecommendation.room.levelPrice), levelSource: '15m resistance' } : null };
    return { ...s, price: m(116.7), mark: { ...SOL_MARK, price: m(116.72) }, candidateSetups: [c], flagTradePlan: plan, flagRecommendation: rec, pathOutlook: { ...s.pathOutlook, id, dir: 'long' } };
  }
  const solPayload = (sol, extra = {}) => payload({ BTC: watchSym(), ETH: watchSym(), SOL: sol, ...extra });
  const CARD_HEAD_RE = /^🧭 PLAN · (₿|Ξ|◎) <b>(BTC|ETH|SOL) \w+ (▲ LONG|▼ SHORT)<\/b>/;

  await test('Plan card: ready plan (short) full snapshot; long mirror; sizing = suggested x collateral; arrow in header; under 1,000 chars', () => {
    const v = resolveRef(SOL_REF, solPayload(solSym()), null);
    const t = formatPlanCard(v);
    assertEqual(t, [
      '🧭 PLAN · ◎ <b>SOL 3m ▼ SHORT</b>', RULE,
      '<b>LEVELS</b>\n<code>entry             116.77\nstop              117.10\nstop dist          0.28%\nTP1               115.90\nTP2               115.60\nR gross·net  2.6R · 2.2R</code>\nFlag confirmed · entry = retest of the breakout\nNet R is after short costs.', RULE,
      '<b>SIZING</b>\n<code>max lev           25x\nsuggested         20x\ncollateral     $10.00\nsize          $200.00\nloss at stop    $0.57\n% of wallet     0.11%</code>\nMark: $116.72 · Kraken close $116.70 · drift 1.7 bps', RULE,
      '<b>TIMING</b>\nExpect: n/a (no measured time-to-TP1 for this flag) · 3m candles\nPath history (estimate): likely retest &amp; go · lean breakout · n=412', RULE,
      '<b>VERDICT</b>\n<b>GET IN NOW</b> — retest held'
    ].join('\n'), 'short snapshot');
    assert(CARD_HEAD_RE.test(t) && t.length <= MAX_CARD_CHARS, t.length);
    const l = formatPlanCard(resolveRef(shortRef(SOL_ID.replace('short', 'long')), solPayload(solLong()), null));
    assert(l.startsWith('🧭 PLAN · ◎ <b>SOL 3m ▲ LONG</b>') && !l.includes('▼') && /TP1 +117\.64/.test(l) && /stop +116\.44/.test(l) && l.includes('after long costs') && l.includes('size          $200.00'), l);
  });

  await test('Plan card: rejected plan -> NOT A TRADE UNDER YOUR RULES + short reason, levels on file; no risk -> Sizing: unavailable (reason); no target never invented', () => {
    const noAcct = { ...SOL_RISK, maxLeverage: null, suggestedLeverage: null, lossAtStopUsd: null, lossAtStopPctOfWallet: null, collateralUsd: null, reason: 'account unavailable' };
    const r = formatPlanCard(resolveRef(SOL_REF, solPayload(solSym({ plan: 'rejected', risk: noAcct })), null));
    const lines = r.split('\n');
    assertEqual(lines[0], '🧭 PLAN · ◎ <b>SOL 3m ▼ SHORT</b>', 'header');
    assertEqual(lines[1], '🔴 <b>NOT A TRADE UNDER YOUR RULES — 1.42R room to 116.30 (15m support); needs 2.5R</b>', 'not-a-trade line');
    assert(/TP1 +116\.30/.test(r) && r.includes('Sizing: unavailable (account unavailable)') && r.includes('<b>STAND DOWN</b> — 1.42R room'), r);
    const f = formatPlanCard(resolveRef(SOL_REF, solPayload(solSym({ state: 'forming', plan: null })), null));
    assert(f.includes('🔴 <b>NOT A TRADE UNDER YOUR RULES — not broken out yet</b>') && /TP1 +none/.test(f) && f.includes('measured move 115.60 is a pattern projection, not a target'), f);
    assert(f.includes('Sizing: unavailable (no breakout yet; the engine sizes triggering and confirmed flags)') && f.includes('<b>WAIT (1m)</b>'), f);
    for (const x of [r, f]) assert(CARD_HEAD_RE.test(x) && x.length <= MAX_CARD_CHARS && x.includes(`\n${RULE}\n`), x);
    // A snapshot (flag gone from the live payload) still prints its levels as alerted.
    const st = { ...emptyState(), buttons: { [SOL_REF]: { symbol: 'SOL', candidateId: SOL_ID, timeframe: '3m', direction: 'short', entry: 116.77, stop: 117.1, tp1: 115.9, state: 'confirmed', at: '2026-09-24T13:58:00.000Z' } } };
    const snap = formatPlanCard(resolveRef(SOL_REF, solPayload(watchSym()), st));
    assert(snap.includes('NOT A TRADE UNDER YOUR RULES — flag no longer live') && snap.includes('levels as alerted') && snap.includes('<b>STAND DOWN</b> — flag no longer live (as alerted'), snap);
  });

  await test('Thesis card: ✔/✖/? sections as phrases (no raw reason code), counter-trend, To become GO IN; unmapped code -> itself; under 1,000 chars', () => {
    const t = formatThesisCard(resolveRef(SOL_REF, solPayload(solSym({ plan: 'conditional', setup: true })), null));
    assert(t.startsWith('🧠 THESIS · ◎ <b>SOL 3m ▼ SHORT</b>\n'), t);
    for (const f of ['<b>SUPPORTS</b>\n✔ valid plan', '<b>AGAINST</b>\n✖ top-down bull 3/4 aligned', '<b>UNKNOWN</b>\n? 4h lean flat', '<b>WHAT CHANGES THE CALL</b>\n• Call changes', '<b>TO BECOME GO IN</b>\na closed candle closes below 116.77',
      'This flag: confirmed · measured 3.5R · room 2.6R to 115.90 (15m support)', 'Counter-trend: the top-down trend is bull (3/4), against this ▼ SHORT.']) assert(t.includes(f) || t.includes(f.replace('valid plan', 'plan ready')), `missing ${f}\n${t}`);
    const body = t.replace(/<\/?(b|code)>/g, '');
    assert(!/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/.test(body) && !/\b(td|a200|ema200|ct|conflict|stoch|rr|level|chan|tp1_capped|room|candidate|data_stale|stale_data):/.test(body), `raw code in thesis:\n${t}`);
    assert(t.length <= MAX_CARD_CHARS && t.split(`\n${RULE}\n`).length === 7, t.length);
    const everyCode = [...solSym().flagRecommendation.supports, ...solSym().flagRecommendation.opposes, ...solSym().flagRecommendation.unknowns,
      'room_at_entry', 'stop_distance_exceeds_cap', 'chase', 'net_rr_below_min', 'stop_inside_costs', 'invalid_levels', 'td:unknown', 'ema200:1w:missing', 'ema200:counter', '4h:with', '4h:bull', 'stoch:ob-cross', 'divergence_missing', 'divergence_undirected', 'divergence_conflicts', 'data_partial', 'market_data_unavailable', 'top_down_context', 'first_level_ahead', 'level_context_missing', 'ma_context_missing', 'top_down_missing', 'a200:2/4', 'ema200:5m:unknown', 'missing_data:3m'];
    for (const code of everyCode) assert(reasonPhrase(code, 'oppose') !== code && !/_/.test(reasonPhrase(code, 'oppose')), `unmapped ${code} -> ${reasonPhrase(code)}`);
    assertEqual(reasonPhrase('brand_new_code'), 'brand_new_code', 'unknown code -> the code');
    assertEqual(reasonPhrase('ema21_flag_context', 'support'), 'price on the trade side of EMA21', 'side-aware');
    const ready = formatThesisCard(resolveRef(SOL_REF, solPayload(solSym()), null));
    assert(ready.includes('<b>TO BECOME GO IN</b>\nit already is: the retest held.'), ready);
    const forming = formatThesisCard(resolveRef(SOL_REF, solPayload(solSym({ state: 'forming', plan: null })), null));
    assert(forming.includes('needs a 3m close below 116.77, then a retest that holds, and the plan must pass your R and stop rules.'), forming);
  });

  await test('Plan / Thesis taps: live first, snapshot second; unknown ref (alert sent before this deploy) -> [expired — send /signals]', async () => {
    const live = await tap({ data: `plan:${SOL_REF}`, build: async () => solPayload(solSym()) });
    assertEqual(live.tg.calls.map((c) => c.method).join(), 'answerCallbackQuery,sendMessage', 'answer then card');
    assert(live.tg.calls[1].text.startsWith('🧭 PLAN · ◎ <b>SOL 3m ▼ SHORT</b>') && allCallbackData(live.tg.calls[1].replyMarkup).includes(`track:${SOL_REF}`), live.tg.calls[1].text);
    const th = await tap({ data: `thesis:${SOL_REF}`, build: async () => solPayload(solSym()) });
    assert(th.tg.calls[1].text.startsWith('🧠 THESIS · ◎ <b>SOL 3m ▼ SHORT</b>'), th.tg.calls[1].text);
    // Alert memory holds the snapshot; the live flag is gone.
    const blob = fakeBlob();
    await cron({ blob, build: async () => solPayload(solSym()) });
    const gone = await tap({ data: `plan:${SOL_REF}`, blob, build: async () => solPayload(watchSym()) });
    assert(gone.tg.calls[1].text.includes('flag no longer live'), gone.tg.calls[1].text);
    for (const d of ['plan:0badf00d', 'thesis:0badf00d', 'track:0badf00d']) {
      const x = await tap({ data: d });
      assertEqual(x.tg.calls[1].text, EXPIRED_REPLY, d);
    }
    assertEqual(EXPIRED_REPLY, '[expired — send /signals]', 'text');
    const old = await tap({ data: 'log:took:SOL:0badf00d' });
    assert(old.tg.calls[1].text.includes('no longer on file'), 'pre-deploy Took it still explains');
  });

  await test('Track: reply + Untrack swap on the tapped keyboard; cron alerts every transition (triggering, SETUP, GET IN NOW + Plan card) at any level; untrack; /tracking', async () => {
    const blob = fakeBlob();
    const markup = tradeKeyboard('SOL', '3m', SOL_ID);
    const t = await tap({ data: `track:${SOL_REF}`, blob, markup, build: async () => solPayload(solSym({ state: 'forming', plan: null })) });
    assertEqual(t.tg.calls[1].text, 'Tracking SOL 3m ▼ SHORT · brk 116.77 · alerts on every change', 'reply');
    assert(allCallbackData(t.tg.calls[1].replyMarkup).includes(`untrack:${SOL_REF}`), 'reply keyboard reads Untrack');
    const edit = t.tg.calls.find((c) => c.method === 'editMessageReplyMarkup');
    assert(edit && allCallbackData(edit.replyMarkup).includes(`untrack:${SOL_REF}`) && !allCallbackData(edit.replyMarkup).includes(`track:${SOL_REF}`), 'button becomes Untrack');
    let st = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assertEqual(`${st.tracked.length}|${st.tracked[0].lastState}|${st.tracked[0].took}`, '1|forming|false', 'tracked');
    st.prefs = { level: 'good', quiet: null }; // tracked transitions ignore the alert level
    const step = (sym, m) => { const r = diffAlerts(st, solPayload(sym), T0 + m * MIN); st = r.state; return r.alerts.filter((a) => a.kind === 'TRACK'); };
    assertEqual(step(solSym({ state: 'forming', plan: null }), 1).length, 0, 'no change, no alert');
    const trig = step(solSym({ state: 'triggering', plan: null }), 2);
    assertEqual(trig.length, 1, 'triggering');
    assert(trig[0].text.startsWith('🟡 ◎ <b>SOL 3m ▼ SHORT</b> · TRACK · TRIGGERING') && allCallbackData(trig[0].replyMarkup).includes(`untrack:${SOL_REF}`), trig[0].text);
    const su = step(solSym({ state: 'confirmed', plan: 'conditional', setup: true }), 3);
    assert(su.length === 1 && su[0].text.startsWith('🟡 ◎ <b>SOL 3m ▼ SHORT</b> · TRACK · SETUP'), su.map((a) => a.text).join('\n'));
    const r = diffAlerts(st, solPayload(solSym()), T0 + 4 * MIN);
    st = r.state;
    const go = r.alerts.filter((a) => a.kind === 'TRACK');
    assert(go.length === 1 && go[0].text.startsWith('🟢 ◎ <b>SOL 3m ▼ SHORT</b> · TRACK · GET IN NOW') && go[0].more[0].startsWith('🧭 PLAN · ◎ <b>SOL 3m ▼ SHORT</b>') && go[0].chart, 'GET IN NOW with the Plan card');
    assert(!r.alerts.some((a) => a.kind === 'GOOD'), 'one message per change (no second GOOD)');
    assertEqual(st.tracked[0].ready, true, 'now watching TP1/stop');
    // Cron delivers the follow-up Plan card.
    const blob2 = fakeBlob();
    await blob2.put(TELEGRAM_STATE_PATH, JSON.stringify({ ...st, tracked: [{ ...st.tracked[0], ready: false, lastState: 'confirmed', setupSeen: true }] }), { allowOverwrite: true });
    const c = await cron({ blob: blob2, build: async () => solPayload(solSym()), nowMs: T0 + 4 * MIN });
    assert(c.tg.calls.some((x) => x.text && x.text.startsWith('🧭 PLAN · ')), 'plan card sent');
    // /tracking lists it; Untrack removes it.
    const list = await hook({ text: '/tracking', blob });
    assert(list.tg.calls[0].text.startsWith('⚪ 🔔 <b>TRACKING</b> · 1 of 10') && list.tg.calls[0].text.includes('◎ <b>SOL 3m ▼ SHORT</b> · brk 116.77 · forming'), list.tg.calls[0].text);
    assertEqual(allCallbackData(list.tg.calls[0].replyMarkup).join(), `plan:${SOL_REF},thesis:${SOL_REF},untrack:${SOL_REF}`, '/tracking buttons');
    const un = await tap({ data: `untrack:${SOL_REF}`, blob, markup: tradeKeyboard('SOL', '3m', SOL_ID, { tracked: true }) });
    assertEqual(un.tg.calls[1].text, 'Untracked SOL 3m ▼ SHORT.', 'untrack reply');
    assert(allCallbackData(un.tg.calls.find((x) => x.method === 'editMessageReplyMarkup').replyMarkup).includes(`track:${SOL_REF}`), 'button back to Track');
    assertEqual(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).tracked.length, 0, 'untracked');
    const empty = await hook({ text: '/tracking', blob });
    assert(empty.tg.calls[0].text.startsWith('[NOT TRACKING ANYTHING]'), empty.tg.calls[0].text);
  });

  await test('Track: void (close through invalidation), gone, 6 h expiry; max 10 (Took it evicts the oldest untaken)', () => {
    const snap = candidateSnapshot('SOL', solSym({ state: 'forming', plan: null }), SOL_ID);
    const base = { ...emptyState(), tracked: [trackEntry(snap, T0)] };
    const v = diffAlerts(base, solPayload(solSym({ state: 'forming', plan: null, price: 117.2 })), T0 + MIN);
    assert(v.alerts.some((a) => a.kind === 'TRACK' && a.text.startsWith('🔴 ◎ <b>SOL 3m ▼ SHORT</b> · TRACK · VOID') && a.text.includes('Closed through void 117.10')) && v.state.tracked.length === 0, 'void');
    const g = diffAlerts(base, solPayload({ ...watchSym(), price: 116.7 }), T0 + MIN);
    assert(g.alerts.some((a) => a.text.includes('TRACK · GONE')) && g.state.tracked.length === 0, 'gone');
    const e = diffAlerts(base, solPayload(solSym({ state: 'forming', plan: null })), T0 + TRACK_TTL_MS);
    assert(e.alerts.some((a) => a.text.includes('TRACK ENDED') && a.text.includes('6 h limit')) && e.state.tracked.length === 0, 'expired');
    assertEqual(TRACK_TTL_MS, 6 * 60 * MIN, '6 h');
    let text = JSON.stringify(emptyState());
    for (let i = 0; i < TRACK_MAX; i++) text = applyTrackChange(text, { action: 'track', entry: trackEntry({ ...snap, candidateId: `SOL:3m:short:${i}` }, T0 + i) }, T0 + 20).text;
    const full = applyTrackChange(text, { action: 'track', entry: trackEntry({ ...snap, candidateId: 'SOL:3m:short:new' }, T0) }, T0 + 20);
    assertEqual(full.result, 'full', 'full at 10');
    const took = applyTrackChange(text, { action: 'track', entry: trackEntry({ ...snap, candidateId: 'SOL:3m:short:took' }, T0, { took: true }) }, T0 + 20);
    const ids = JSON.parse(took.text).tracked.map((t) => t.candidateId);
    assert(took.result === 'tracked' && ids.length === TRACK_MAX && !ids.includes('SOL:3m:short:0') && ids.includes('SOL:3m:short:took'), 'took evicts the oldest untaken');
    assertEqual(applyTrackChange(took.text, { action: 'track', entry: trackEntry({ ...snap, candidateId: 'SOL:3m:short:took' }, T0, { took: true }) }, T0 + 20).result, 'already', 'idempotent');
  });

  await test('TP1 / stop on the mark (Kraken close when the mark is not ok), long + short, R at exit; untaken plan ends; taken keeps with Closed here / Partial / Still in; one nudge after 10 min', () => {
    const run = (sym, entry, m, symbol = 'SOL') => diffAlerts({ ...emptyState(), tracked: [entry] }, payload({ BTC: watchSym(), ETH: watchSym(), SOL: watchSym(), [symbol]: sym }), T0 + m * MIN);
    const short = trackEntry({ symbol: 'SOL', candidateId: SOL_ID, timeframe: '3m', direction: 'short', entry: 116.77, stop: 117.1, tp1: 115.9 }, T0, { took: true });
    const tp = run({ ...watchSym(), price: 116.2, mark: { price: 115.88, driftBps: 2, status: 'ok' } }, short, 1);
    const a = tp.alerts.find((x) => x.kind === 'TRACK');
    assert(a.text.startsWith('🟢 ◎ <b>SOL 3m ▼ SHORT</b> · TRACK · TP1 HIT') && /mark +115\.88/.test(a.text) && /R at exit +\+2\.7R/.test(a.text), a.text);
    assertEqual(allCallbackData(a.replyMarkup).join(), `closed:${SOL_REF},partial:${SOL_REF},stillin:${SOL_REF}`, 'TP1 buttons');
    const hit = tp.state.tracked[0].hit;
    assertEqual(`${hit.kind}|${hit.price}|${hit.src}|${hit.r}`, 'tp1|115.88|mark|2.7', 'hit stored (mark)');
    const kraken = run({ ...watchSym(), price: 117.15, mark: { price: null, status: 'unavailable' } }, short, 1);
    const k = kraken.alerts.find((x) => x.kind === 'TRACK');
    assert(k.text.startsWith('🔴 ◎ <b>SOL 3m ▼ SHORT</b> · TRACK · STOP HIT') && /close +117\.15/.test(k.text) && /-1\.1R/.test(k.text), k.text);
    assertEqual(allCallbackData(k.replyMarkup).join(), `closed:${SOL_REF},stillin:${SOL_REF}`, 'stop buttons (no Partial)');
    const long = trackEntry({ symbol: 'BTC', candidateId: 'BTC:5m:long:L', timeframe: '5m', direction: 'long', entry: 84600, stop: 84390, tp1: 85146 }, T0, { took: true });
    const lt = run({ ...watchSym(), price: 85000, mark: { price: 85150, status: 'ok', driftBps: 1 } }, long, 1, 'BTC').alerts.find((x) => x.kind === 'TRACK');
    assert(lt.text.startsWith('🟢 ₿ <b>BTC 5m ▲ LONG</b> · TRACK · TP1 HIT') && lt.text.includes('+2.6R'), lt.text);
    const ls = run({ ...watchSym(), price: 84500, mark: { price: 84380, status: 'ok', driftBps: 1 } }, long, 1, 'BTC').alerts.find((x) => x.kind === 'TRACK');
    assert(ls.text.includes('TRACK · STOP HIT') && ls.text.includes('-1.0R'), ls.text);
    assertEqual(rMultiple('long', 84600, 84390, 85146), 2.6, 'R long');
    assertEqual(rMultiple('short', 116.77, 117.1, 115.9), 2.64, 'R short');
    assertEqual(rMultiple('short', 116.77, 117.1, 117.1), -1, 'R at stop');
    assertEqual(rMultiple('long', 1, 1, 2), null, 'zero-width stop');
    // Untaken (plan was ready, no Took it): the hit ends tracking, no close buttons.
    const ready = { ...short, took: false, ready: true };
    const rr = run({ ...watchSym(), price: 116.2, mark: { price: 115.88, driftBps: 2, status: 'ok' } }, ready, 1);
    assert(rr.alerts.find((x) => x.kind === 'TRACK').text.includes('Tracking ended') && !rr.alerts.find((x) => x.kind === 'TRACK').replyMarkup && rr.state.tracked.length === 0, 'untaken ends');
    // Nudge: one reminder 10 min after the hit, never twice.
    let st = tp.state;
    const quietRun = (m) => { const r = diffAlerts(st, payload({ BTC: watchSym(), ETH: watchSym(), SOL: { ...watchSym(), price: 116.2, mark: { price: 115.8, status: 'ok', driftBps: 1 } } }), T0 + m * MIN); st = r.state; return r.alerts.filter((x) => x.kind === 'NUDGE' || x.kind === 'TRACK'); };
    assertEqual(quietRun(5).length, 0, 'no nudge before 10 min');
    const n = quietRun(11);
    assert(n.length === 1 && n[0].kind === 'NUDGE' && n[0].text.startsWith('🟡 ◎ <b>SOL 3m ▼ SHORT</b> · REMINDER') && n[0].text.includes('no close journaled') && allCallbackData(n[0].replyMarkup).includes(`closed:${SOL_REF}`), n.map((x) => x.text).join());
    assertEqual(quietRun(30).length, 0, 'never twice');
    assertEqual(NUDGE_AFTER_MS, 10 * MIN, '10 min');
  });

  await test('Took it -> TP1 hit -> Closed here writes kind close (exit = hit mark, resultR vs logged entry/stop, engineRef); Partial = adjust; Still in re-arms; /positions + Close @ mark', async () => {
    const blob = fakeBlob();
    const build = async () => solPayload(solSym());
    const took = await tap({ data: `log:took:SOL:${SOL_REF}`, blob, build });
    assert(took.tg.calls[1].text.startsWith(`[LOGGED tg_open_${SOL_REF}] · tracking SOL 3m ▼ SHORT for TP1 / stop`), took.tg.calls[1].text);
    // /positions: the open trade with live mark and R.
    const pos = await hook({ text: '/positions', blob, build, nowMs: T0 + 20 * MIN });
    const pt = pos.tg.calls[0].text;
    assert(pt.startsWith('🟢 ◎ <b>▼ SOL SHORT</b> · OPEN') && /R now +\+0\.2R/.test(pt) && /to stop +1\.2R/.test(pt) && /to TP1 +2\.5R/.test(pt) && /age +20 min/.test(pt), pt);
    assertEqual(allCallbackData(pos.tg.calls[0].replyMarkup).join(), `pclose:${SOL_REF},chart:SOL:3m`, 'positions buttons');
    // The cron sees TP1 on the mark.
    const hitRun = await cron({ blob, build: async () => solPayload(solSym({ price: 116.2, mark: { price: 115.88, driftBps: 2, status: 'ok' } })), nowMs: T0 + 21 * MIN });
    assert(hitRun.tg.calls.some((c) => c.text && c.text.includes('TRACK · TP1 HIT')), 'TP1 alert');
    const partial = await tap({ data: `partial:${SOL_REF}`, blob, build });
    assert(partial.tg.calls[1].text.startsWith(`[LOGGED tg_adjust_${SOL_REF}]`) && partial.tg.calls[1].text.includes('partial at TP1'), partial.tg.calls[1].text);
    const still = await tap({ data: `stillin:${SOL_REF}`, blob, build });
    assertEqual(still.tg.calls[1].text, 'Still in · SOL 3m ▼ SHORT · watching TP1 115.90 and stop 117.10 again.', 'still in');
    assertEqual(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).tracked[0].hit, null, 're-armed');
    await cron({ blob, build: async () => solPayload(solSym({ price: 116.2, mark: { price: 115.85, driftBps: 2, status: 'ok' } })), nowMs: T0 + 22 * MIN });
    const closed = await tap({ data: `closed:${SOL_REF}`, blob, build });
    assert(closed.tg.calls[1].text.startsWith(`[LOGGED tg_close_${SOL_REF}]`), closed.tg.calls[1].text);
    const recs = blob.files.get('journal/2026-09-24.jsonl').text.trim().split('\n').map((l) => JSON.parse(l));
    const close = recs.find((r) => r.kind === 'close');
    assertEqual(`${close.symbol}|${close.direction}|${close.exitPrice}|${close.resultR}|${close.entry}|${close.stop}|${close.engineRef.candidateId}|${close.source}`, `SOL|short|115.85|2.79|116.77|117.1|${SOL_ID}|telegram`, 'close record');
    const adj = recs.find((r) => r.kind === 'adjust');
    assert(adj && adj.text.startsWith('partial at TP1') && adj.exitPrice === 115.88 && adj.resultR === null, JSON.stringify(adj));
    assertEqual(Object.keys(close).join(), RECORD_KEYS.join(), 'journal schema keys');
    assertEqual(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).tracked.length, 0, 'closing untracks');
    const none = await hook({ text: '/positions', blob, build });
    assertEqual(none.tg.calls[0].text, '[NO OPEN TRADES]', 'empty');
    const again = await tap({ data: `closed:${SOL_REF}`, blob, build });
    assert(again.tg.calls[1].text.includes('No open trade on file'), 'second close explains');
    // Close @ mark from /positions (a hand-logged BTC short, no candidate): exit = mark.
    await hook({ text: '/log took BTC short entry 84600 stop 84810 tp 84000', blob, build });
    const opens = openPositions(blob.files.get('journal/2026-09-24.jsonl').text.trim().split('\n').map((l) => JSON.parse(l)));
    assertEqual(opens.length, 1, 'one open');
    const pc = await tap({ data: `pclose:${positionRef(opens[0])}`, blob, build });
    const last = blob.files.get('journal/2026-09-24.jsonl').text.trim().split('\n').map((l) => JSON.parse(l)).pop();
    assertEqual(`${last.kind}|${last.exitPrice}|${last.resultR}`, 'close|84610.2|-0.05', 'Close @ mark (BTC mark 84,610.20)');
    assert(pc.tg.calls[1].text.includes('-0.0R') || pc.tg.calls[1].text.includes('+0.0R') || pc.tg.calls[1].text.includes('-0.1R'), pc.tg.calls[1].text);
  });

  await test('positions from journal opens/closes (by candidate, else symbol+direction); closeBody R long + short; cron drops a nudge whose trade is already closed', async () => {
    const r = (id, kind, extra) => ({ id, kind, receivedAt: `2026-09-24T1${id.length % 10}:00:00Z`, ...extra });
    const recs = [
      { id: 'o1', kind: 'open', symbol: 'BTC', direction: 'long', entry: 100, stop: 90, receivedAt: '2026-09-24T10:00:00Z', engineRef: { candidateId: 'A' } },
      { id: 'o2', kind: 'open', symbol: 'ETH', direction: 'short', entry: 50, stop: 55, receivedAt: '2026-09-24T10:05:00Z' },
      { id: 'o3', kind: 'open', symbol: 'BTC', direction: 'short', entry: 100, stop: 110, receivedAt: '2026-09-24T10:10:00Z', engineRef: { candidateId: 'B' } },
      { id: 'c1', kind: 'close', symbol: 'BTC', receivedAt: '2026-09-24T10:20:00Z', engineRef: { candidateId: 'A' } },
      { id: 'c2', kind: 'close', symbol: 'ETH', direction: 'short', receivedAt: '2026-09-24T10:30:00Z' },
      { id: 'n1', kind: 'note', symbol: 'BTC', receivedAt: '2026-09-24T10:40:00Z' }
    ];
    assertEqual(openPositions(recs).map((o) => o.id).join(), 'o3', 'only o3 open');
    assertEqual(positionRef(recs[0]), shortRef('A'), 'ref by candidate');
    assertEqual(positionRef(recs[1]), shortRef('o2'), 'ref by id');
    const lb = closeBody(recs[0], { exitPrice: 120, ref: 'aaaaaaaa' });
    const sb = closeBody(recs[2], { exitPrice: 95, ref: 'bbbbbbbb' });
    assertEqual(`${lb.resultR}|${sb.resultR}|${lb.id}|${lb.kind}`, '2|0.5|tg_close_aaaaaaaa|close', 'R long + short');
    void r;
    // Positions render: long + short, dots by R sign, arrows.
    const p = payload({ BTC: { ...watchSym(), price: 105, mark: { price: 105, status: 'ok' } }, ETH: { ...watchSym(), price: 52, mark: { price: null, status: 'unavailable' } } });
    const txt = formatPositions([recs[0], recs[1]], p, Date.parse('2026-09-24T10:30:00Z'));
    assert(txt.startsWith('🟢 ₿ <b>▲ BTC LONG</b> · OPEN') && txt.includes(`\n${RULE}\n🔴 Ξ <b>▼ ETH SHORT</b> · OPEN`) && /close +52\.00/.test(txt) && txt.length <= MAX_CARD_CHARS, txt);
    const loss = formatPositions([{ ...recs[0] }], payload({ BTC: { ...watchSym(), price: 95, mark: { price: 95, status: 'ok' } } }), Date.parse('2026-09-24T10:30:00Z'));
    assert(loss.startsWith('🔴 ₿ <b>▲ BTC LONG</b>') && loss.includes('-0.5R'), loss);
    // Cron: a nudge is dropped once the journal holds the close.
    const hitAt = new Date(T0 - 11 * MIN).toISOString();
    const entry = { ...trackEntry({ symbol: 'SOL', candidateId: SOL_ID, timeframe: '3m', direction: 'short', entry: 116.77, stop: 117.1, tp1: 115.9 }, T0 - 20 * MIN, { took: true }), hit: { kind: 'tp1', price: 115.88, src: 'mark', r: 2.7, at: hitAt, nudged: false } };
    const seeded = async (withClose) => {
      const blob = fakeBlob();
      await blob.put(TELEGRAM_STATE_PATH, JSON.stringify({ ...emptyState(), tracked: [entry] }), { allowOverwrite: true });
      await tap({ data: `log:took:SOL:${SOL_REF}`, blob, build: async () => solPayload(solSym()), nowMs: T0 - 20 * MIN });
      await blob.put(TELEGRAM_STATE_PATH, JSON.stringify({ ...emptyState(), tracked: [entry] }), { allowOverwrite: true });
      if (withClose) await hook({ text: '/log closed SOL short at 115.9', blob });
      return cron({ blob, build: async () => solPayload(solSym({ price: 116.2, mark: { price: 115.8, status: 'ok', driftBps: 1 } })) });
    };
    const open = await seeded(false);
    assertEqual(open.tg.calls.filter((c) => c.text && c.text.includes('REMINDER')).length, 2, 'nudge to both chats while open');
    const done = await seeded(true);
    assertEqual(done.tg.calls.filter((c) => c.text && c.text.includes('REMINDER')).length, 0, 'no nudge once closed');
  });

  await test('timeframe focus: default 3m,5m drops 1m WATCH; tracking a 5m LONG turns on 1m LONG alerts for that symbol only (line 0), not shorts, not other symbols; untrack ends it; /alerts tf', async () => {
    const one = (id, dir = 'long', st = 'forming') => cand(id, st, { timeframe: '1m', direction: dir });
    const p = () => payload({ BTC: formSym([one('BTC:1m:long:a'), one('BTC:1m:short:b', 'short')]), ETH: formSym([one('ETH:1m:long:c')]), SOL: watchSym() });
    const w = (r) => r.alerts.filter((a) => a.kind === 'WATCH' || a.kind === 'TRIGGERING' || a.kind === 'BREAKOUT');
    assertEqual(w(diffAlerts(withPrefs('watch'), p(), T0)).length, 0, 'default filter drops 1m');
    const tracked5m = trackEntry({ symbol: 'BTC', candidateId: 'BTC:5m:long:T', timeframe: '5m', direction: 'long', state: 'forming', entry: 84466.1, stop: 84331.6 }, T0);
    const focus = diffAlerts({ ...withPrefs('watch'), tracked: [tracked5m] }, p(), T0);
    const f = w(focus);
    assertEqual(f.map((a) => `${a.symbol}:${a.candidateId}`).join(), 'BTC:BTC:1m:long:a', 'only BTC 1m long');
    assert(f[0].text.startsWith('1m ENTRY · for your tracked BTC 5m ▲ LONG\n⚪ ₿ <b>BTC 1m ▲ LONG</b> · WATCH'), f[0].text);
    assertEqual(allCallbackData(f[0].replyMarkup).slice(0, 3).join(), `plan:${shortRef('BTC:1m:long:a')},thesis:${shortRef('BTC:1m:long:a')},chart:BTC:1m`, 'same buttons');
    const brk = diffAlerts({ ...withPrefs('good'), tracked: [tracked5m] }, payload({ BTC: formSym([one('BTC:1m:long:z', 'long', 'confirmed')]), ETH: watchSym(), SOL: watchSym() }), T0);
    assert(brk.alerts.some((a) => a.kind === 'BREAKOUT' && a.text.startsWith('1m ENTRY · for your tracked')), 'focus 1m BREAKOUT at level good');
    const after = diffAlerts({ ...withPrefs('watch'), tracked: [] }, payload({ BTC: formSym([one('BTC:1m:long:q')]), ETH: watchSym(), SOL: watchSym() }), T0);
    assertEqual(w(after).length, 0, 'untracked: 1m muted again');
    const all = diffAlerts({ ...emptyState(), prefs: { level: 'watch', quiet: null, alertTimeframes: null } }, p(), T0);
    assert(w(all).length >= 1, '/alerts tf all lets 1m through');
    assertEqual(JSON.stringify(parseAlertTimeframes('5m')), '["5m"]', '5m');
    assertEqual(JSON.stringify(parseAlertTimeframes('5m,3m')), '["3m","5m"]', 'sorted');
    assertEqual(parseAlertTimeframes('all'), null, 'all');
    assertEqual(parseAlertTimeframes('2m'), undefined, 'bad');
    assertEqual(JSON.stringify(parseAlertsArgs(['tf', '3m,5m'])), '{"action":"tf","alertTimeframes":["3m","5m"]}', 'parse');
    assertEqual(parseAlertsArgs(['tf']).action, 'error', 'tf needs a value');
    const blob = fakeBlob();
    const x = await tap({ data: 'alerts:tf:5m', blob });
    assert(unpad(x.tg.calls[1].text).includes('Timeframes: 5m') && JSON.stringify(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).prefs.alertTimeframes) === '["5m"]', x.tg.calls[1].text);
    await hook({ text: '/alerts tf all', blob });
    assertEqual(JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).prefs.alertTimeframes, null, 'all persisted as null');
    const status = await hook({ text: '/status', blob });
    assert(unpad(status.tg.calls[0].text).includes('Alert timeframes: all'), status.tg.calls[0].text);
  });

  /** A symbol with the fields /market reads (bias build): 24 1h candles, 15m/1h Stoch, bias matrix, top-down, geometry. */
  function mktSym({ price, change = 1, td = 'bull', aligned = 3, stoch = 'OVERBOUGHT', bias = 'long', support = null, resistance = null, candles1h = 24, candles4h = 20 } = {}) {
    const open = price / (1 + change / 100);
    const c1 = Array.from({ length: candles1h }, (_, i) => { const o = open + (price - open) * (i / candles1h); const c = open + (price - open) * ((i + 1) / candles1h); return { t: i, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 1 }; });
    const c4 = Array.from({ length: candles4h }, (_, i) => ({ t: i, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1 }));
    return {
      price, mark: { price: price * 1.0001, driftBps: 1, status: 'ok' },
      timeframes: { '15m': { stochRsi: { state: stoch } }, '1h': { stochRsi: { state: stoch }, candles: c1 }, '4h': { stochRsi: { state: 'NEUTRAL' }, candles: c4 } },
      biasMatrix: { '4h': { bias, strength: 60 }, '1h': { bias: 'neutral', strength: 10 } },
      topDown: { sentiment: td, aligned, leans: { '4h': td, '1h': 'neutral' }, above200: { count: 3, of: 4 } },
      geometryContext: { '1h': { horizontalSupportZones: support ? [{ low: support - 10, high: support }] : [], horizontalResistanceZones: resistance ? [{ low: resistance, high: resistance + 10 }] : [] }, '4h': { horizontalSupportZones: [], horizontalResistanceZones: [] } },
      flagRecommendation: { class: 'WATCH' }
    };
  }

  await test('/market: 24h card from engine fields; LEAN by rule (bull stretched / bear mirror); FLAGS from state counters; missing candles -> n/a; under 1,000 chars', async () => {
    const bull = { ...payload(), symbols: { BTC: mktSym({ price: 84600, support: 84000, resistance: 85500 }), ETH: mktSym({ price: 2600, change: 2, support: 2550 }), SOL: mktSym({ price: 116.7, change: -0.5, td: 'mixed', aligned: 2, stoch: 'NEUTRAL' }) } };
    const st = { ...emptyState(), alerts: { day: '2026-09-24', today: 5, last: null, byKind: { WATCH: 2, TRIGGERING: 1, BREAKOUT: 1, GOOD: 1 } } };
    const t = formatMarket(bull, st, T0);
    assert(t.startsWith(`🌐 MARKET · last 24h\n${RULE}\n₿ <b>BTC</b> $84,600.00 · +1% 24h\n<code>`), t);
    for (const f of ['td     bull 3/4', '4h/1h  long/neutral', 'a200   3/4', 'stoch  15m ob · 1h ob', 'drift  1 bps', '<b>LEAN</b> 🟢 bullish structure, stretched short-term (Stoch overbought)',
      '<b>FLAGS</b> formed 3 · confirmed 1 · SETUP 0 · GOOD 1 (alerts today, UTC)', '₿ BTC loses 84,000.00 (1h support)', 'Ξ ETH loses 2,550.00 (1h support)', '◎ SOL n/a']) assert(t.includes(f), `missing ${f}\n${t}`);
    assert(t.length <= MAX_CARD_CHARS && (t.match(new RegExp(RULE, 'g')) || []).length === 6, t.length);
    const bear = { ...payload(), symbols: { BTC: mktSym({ price: 84600, change: -1, td: 'bear', stoch: 'OVERSOLD', bias: 'short', resistance: 85200 }), ETH: mktSym({ price: 2600, change: -2, td: 'bear', aligned: 4, stoch: 'OVERSOLD', bias: 'short', resistance: 2650 }), SOL: mktSym({ price: 116.7, td: 'mixed', aligned: 2, stoch: 'NEUTRAL' }) } };
    const b = formatMarket(bear, null, T0);
    assert(b.includes('<b>LEAN</b> 🔴 bearish structure, stretched short-term (Stoch oversold)') && b.includes('₿ BTC clears 85,200.00 (1h resistance)') && b.includes('<b>FLAGS</b> n/a') && b.includes('-1% 24h'), b);
    assertEqual(marketLean([{ td: { sentiment: 'bull', aligned: 3 } }, { td: { sentiment: 'bear', aligned: 3 } }]).side, 'mixed', 'split -> mixed');
    // Missing 1h candles: 24h falls back to the last 6 4h candles, labeled; neither -> n/a, never invented.
    const few = { ...payload(), symbols: { BTC: mktSym({ price: 84600, candles1h: 20 }), ETH: mktSym({ price: 2600, candles1h: 0, candles4h: 0 }) } };
    const m = formatMarket(few, st, T0);
    assert(m.includes('(4h)') && m.includes('Ξ <b>ETH</b> $2,600.00 · 24h n/a') && /range +n\/a/.test(m), m);
    const bare = formatMarket({ ...payload(), symbols: { BTC: { price: 84600, mark: null, flagRecommendation: {} } } }, null, T0);
    for (const f of ['24h n/a', 'td     n/a', '4h/1h  n/a/n/a', 'a200   n/a', 'stoch  15m n/a · 1h n/a', 'drift  n/a', '₿ BTC n/a']) assert(bare.includes(f), `bare missing ${f}\n${bare}`);
    // Webhook: Market label runs it off a bias build; state counters come from the cron.
    const blob = fakeBlob();
    await cron({ blob });
    let asked = null;
    const h = await hook({ text: 'Market', blob, build: async (opts) => { asked = opts; return bull; } });
    assert(asked && asked.includeBias === true && h.tg.calls[0].text.startsWith('🌐 MARKET · last 24h') && h.tg.calls[0].text.includes('GOOD 1'), h.tg.calls[0].text);
  });

  await test('help and menu list the new commands; no execution import (Plan / Track / Positions are read + journal only)', () => {
    const help = formatHelp();
    for (const f of ['/positions', '/tracking', '/market', '/alerts tf', 'Plan (levels + sizing)', 'Took it (journals an open and tracks TP1 / stop)', 'Closed here / Partial / Still in']) assert(help.includes(f), `help missing ${f}`);
    for (const f of ['lib/telegram.js', 'api/telegram-webhook.js', 'api/telegram-cron.js']) {
      const src = readFileSync(path.join(root, f), 'utf8');
      assert(!/execute-trade|jupiterPerps|walletManager|signTransaction|Keypair/.test(src), `${f} reaches execution`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
