/**
 * Deterministic tests for the Telegram bot (T-1, docs/PLAN_TELEGRAM.md): lib/telegram.js
 * formatters (every class, SETUP line, DATA block), the alert state machine (transitions,
 * dedup, data/mark persistence and rate limit, heartbeat), command and /log parsing (the
 * /log body must validate against the journal schema), api/telegram-webhook.js (method,
 * secret 403, allowlist silence, commands, /log through the journal's own append path)
 * and api/telegram-cron.js (401, 503 reasons, send-once under overlapping runs), alert
 * levels (good/setup/watch), WATCH dedup + cooldown, Chicago quiet hours (DST), plus
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
  formatSymbolBlock, formatSignals, formatWhy, formatFlags, formatWallet, formatJournal, formatStatus, formatSetupLine,
  formatGoodAlert, emptyState, parseState, diffAlerts, createBotClient, inQuietHours, COMMANDS,
  formatWatchAlert, formatAlertPrefs, parseAlertsArgs, parseQuietSpec, normalizePrefs, applyPrefsChange, chicagoHour,
  WATCH_COOLDOWN_MS, WATCH_RECENT_IDS, DEFAULT_QUIET_HOURS,
  HEALTH_PERSIST_MS, HEALTH_REPEAT_MS, HEARTBEAT_WRITE_MS, MAX_MESSAGE_CHARS, TELEGRAM_STATE_PATH
} from './lib/telegram.js';
import { validateJournalEntry, RECORD_KEYS } from './lib/journalSchema.js';
import { handleTelegramWebhook, testAlertSample } from './api/telegram-webhook.js';
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
    schemaVersion: '1.24.0', configVersion: '2026.09.24-5', generatedAt: '2026-09-24T14:05:20.000Z', closedThrough, dataStatus,
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
    } else {
      const b = JSON.parse(init.body);
      Object.assign(entry, { chatId: String(b.chat_id), text: b.text, parseMode: b.parse_mode, silent: b.disable_notification });
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
async function hook({ text, from = OWNER, secret = SECRET, method = 'POST', env = ENV, blob = fakeBlob(), tg = fakeTelegram(), build = async () => payload(), nowMs = T0, updateId }) {
  const update = { update_id: updateId ?? updateSeq++, message: { message_id: 1, from: { id: from }, chat: { id: from, type: 'private' }, text } };
  const req = { method, headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) };
  const res = mockRes();
  const { logs } = await quiet(() => handleTelegramWebhook(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, render: fakeRender, now: () => nowMs, env }));
  return { res, tg, blob, logs };
}

async function cron({ auth = `Bearer ${CRON}`, env = ENV, blob = fakeBlob(), tg = fakeTelegram(), build = async () => payload(), nowMs = T0 }) {
  const req = { method: 'GET', headers: auth ? { authorization: auth } : {} };
  const res = mockRes();
  const { logs } = await quiet(() => handleTelegramCron(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, render: fakeRender, now: () => nowMs, env }));
  return { res, tg, blob, logs };
}

// ---------------------------------------------------------------- tests

async function run() {
  console.log('formatters');

  await test('GOOD block: header, GO IN, plan levels, gross/net R, change condition, mark', () => {
    const t = formatSymbolBlock('BTC', goodSym());
    for (const frag of ['<b>BTC — LONG — 5m</b>', '🟢 GO IN', 'Entry: $84,600.00', 'Stop Loss: $84,390.00', 'Take Profit 1: $85,146.00', 'Take Profit 2: $85,300.00', 'R:R gross 2.6R · net 2.1R', 'Quality: high', 'Changes if: Call changes if price invalidates', 'Mark: $84,610.20 (drift 1.2 bps)']) {
      assert(t.includes(frag), `missing "${frag}" in\n${t}`);
    }
  });

  await test('WATCH block: NO TRADE, HOLD / WAIT, reason (HTML-escaped) and confirmation', () => {
    const t = formatSymbolBlock('ETH', watchSym());
    for (const frag of ['<b>ETH — NO TRADE</b>', '🟡 HOLD / WAIT', 'Reason: A flag must form &lt;and&gt; confirm.', 'Confirmation: A 3m flag must confirm above 2610.']) assert(t.includes(frag), `missing "${frag}"`);
    assert(!t.includes('GO IN'), 'WATCH must never say GO IN');
  });

  await test("BAD block: DON'T DO IT with the rejection reason; DATA_UNAVAILABLE: NO DATA", () => {
    const b = formatSymbolBlock('SOL', badSym());
    assert(b.includes("🔴 DON'T DO IT") && b.includes('below the 2.5R floor'), b);
    const d = formatSymbolBlock('SOL', { mark: { status: 'unavailable' }, flagRecommendation: { class: 'DATA_UNAVAILABLE', primaryReason: { code: 'market_data_unavailable', text: 'SOL market data is unavailable' }, changeConditions: [] } });
    assert(d.includes('⚪ NO DATA') && d.includes('SOL market data is unavailable') && d.includes('Mark: unavailable'), d);
  });

  await test('SETUP line matches the GPT FORMAT and is appended after its asset', () => {
    assertEqual(formatSetupLine('ETH', setupEth), 'SETUP — ETH 3m SHORT — trigger: 3m close below 2601.5 then a retest that holds under it. Info; never GO IN.', 'setup line');
    const t = formatSymbolBlock('ETH', watchSym(setupEth));
    assert(t.trim().endsWith('Info; never GO IN.'), 'setup line last');
    assertEqual(formatSetupLine('ETH', null), null, 'no setup -> no line');
  });

  await test('/signals: GOOD first, then the rest, then DATA; no GOOD -> below-threshold header', () => {
    const t = formatSignals(payload({ ETH: watchSym(setupEth) }), T0);
    assert(t.indexOf('BTC — LONG') < t.indexOf('ETH — NO TRADE') && t.indexOf('ETH — NO TRADE') < t.indexOf('SOL — NO TRADE'), 'order');
    assert(t.includes('SETUP — ETH 3m SHORT') && t.includes('<b>DATA</b>') && t.includes('Schema/Config: 1.24.0 · 2026.09.24-5'), t);
    assert(!t.includes('below threshold'), 'GOOD present');
    const none = formatSignals(payload({ BTC: watchSym() }), T0);
    assert(none.startsWith('NO TRADE — BTC / ETH / SOL below threshold.'), none.slice(0, 80));
    assert(formatSignals(payload({ dataStatus: 'unavailable' }), T0).includes('market data unavailable'), 'unavailable');
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
    for (const f of ['Schema/Config: 1.24.0 · 2026.09.24-5', 'Closed Through: 14:05 UTC (30s ago)', 'Data: complete', 'BTC: GOOD · Mark: $84,610.20', 'Last alert: GOOD BTC 13:00 UTC', 'Alerts today: 3', 'Cron last run: 14:05 UTC (30s ago']) assert(st.includes(f), `status missing ${f}\n${st}`);
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

  await test('GOOD alert card: plan, change condition, mark, tracker link; TEST label on samples', () => {
    const t = formatGoodAlert('BTC', goodSym(), payload(), { nowMs: T0 });
    for (const f of ['NEW GOOD — BTC 5m LONG', 'Entry: $84,600.00', 'R:R gross 2.6R · net 2.1R', 'Changes if:', 'Mark: $84,610.20 (drift 1.2 bps)', 'Tracker: https://edittrades-tracker.vercel.app']) assert(t.includes(f), `missing ${f}`);
    const s = formatGoodAlert('BTC', goodSym(), payload(), { nowMs: T0, test: true });
    assert(s.startsWith('🧪 TEST — NOT A SIGNAL') && s.includes('SAMPLE GOOD'), s.slice(0, 60));
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
    assert(ended && ended.text.includes('GOOD → BAD (rejected)') && ended.text.includes('GOOD ENDED — BTC 5m LONG'), ended && ended.text);
    const c = diffAlerts(b.state, payload(), T0 + 2 * MIN);
    assertEqual(c.alerts.filter((x) => x.kind === 'GOOD').length, 0, 'same candidate already alerted');
    const d = diffAlerts(c.state, payload({ BTC: watchSym() }), T0 + 3 * MIN);
    assert(d.alerts.find((x) => x.kind === 'GOOD_ENDED').text.includes('GOOD → WATCH (void)'), 'void');
    const e = diffAlerts(d.state, payload({ BTC: goodSym('BTC:5m:long:2026-09-24T14:10:00.000Z') }), T0 + 4 * MIN);
    assertEqual(e.alerts.filter((x) => x.kind === 'GOOD').length, 1, 'a new candidate alerts');
  });

  await test('NEW SETUP alerts once per candidate id, with the trigger sentence', () => {
    const a = diffAlerts(emptyState(), payload({ ETH: watchSym(setupEth) }), T0);
    const s = a.alerts.filter((x) => x.kind === 'SETUP');
    assertEqual(s.length, 1, 'one SETUP');
    assert(s[0].text.includes('trigger: 3m close below 2601.5') && s[0].text.includes('Info; never GO IN.'), s[0].text);
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
    assertEqual(kinds('good'), 'GOOD', 'good');
    assertEqual(kinds('setup'), 'GOOD,SETUP', 'setup');
    assertEqual(kinds('watch'), 'GOOD,SETUP,WATCH', 'watch');
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
    assertEqual(formatWatchAlert('BTC', cand('x'), TD_REC), 'WATCH · BTC 3m LONG forming · break 84,466.10 / void 84,331.60 · 2.4R · td:bull:3/4', 'forming');
    assertEqual(formatWatchAlert('BTC', cand('x', 'triggering'), TD_REC), 'TRIGGERING · BTC 3m LONG triggering · break 84,466.10 / void 84,331.60 · 2.4R · td:bull:3/4', 'triggering');
    assertEqual(formatWatchAlert('ETH', cand('x', 'forming', { direction: 'short', measuredRR: null }), { supports: [] }), 'WATCH · ETH 3m SHORT forming · break 84,466.10 / void 84,331.60 · R n/a', 'no td, no R');
    const other = ['proto', 'failed', 'expired', 'confirmed'].map((st, i) => cand(`BTC:3m:long:o${i}`, st));
    const r = diffAlerts(withPrefs('watch'), payload({ BTC: formSym(other) }), T0);
    assertEqual(r.alerts.filter((x) => x.kind === 'WATCH' || x.kind === 'TRIGGERING').length, 0, 'only forming/triggering');
    assert(!r.alerts.some((x) => x.chart), 'no chart on watch');
  });

  await test('WATCH dedup by candidateId, 15-min per-symbol cooldown, triggering passes the cooldown once', () => {
    const A = cand('BTC:3m:long:A');
    const B = cand('BTC:5m:long:B', 'forming', { timeframe: '5m' });
    const run = (st, cands, m, sym = 'BTC') => diffAlerts(st, payload({ BTC: sym === 'BTC' ? formSym(cands) : watchSym(), ETH: sym === 'ETH' ? formSym(cands) : watchSym() }), T0 + m * MIN);
    const w = (r) => r.alerts.filter((x) => x.kind === 'WATCH' || x.kind === 'TRIGGERING').map((x) => `${x.kind}:${x.text.split(' · ')[1]}`).join('|');
    const r0 = run(withPrefs('watch'), [A, B], 0);
    assertEqual(w(r0), 'WATCH:BTC 3m LONG forming', 'first candidate alerts, second held by cooldown in the same run');
    const r1 = run(r0.state, [A, B], 1);
    assertEqual(w(r1), '', 'A deduped, B still cooling');
    const r2 = run(r1.state, [{ ...A, state: 'triggering' }, B], 2);
    assertEqual(w(r2), 'TRIGGERING:BTC 3m LONG triggering', 'triggering passes the cooldown');
    const r3 = run(r2.state, [{ ...A, state: 'triggering' }, B], 3);
    assertEqual(w(r3), '', 'triggering passes only once');
    const r4 = run(r3.state, [{ ...A, state: 'forming' }, B], 16);
    assertEqual(w(r4), '', 'cooldown restarted at the TRIGGERING alert (min 2)');
    const r5 = run(r4.state, [A, B], 17.1);
    assertEqual(w(r5), 'WATCH:BTC 5m LONG forming', 'B alerts once the cooldown ends; A never repeats');
    // Cooldown is per symbol: ETH is not held by BTC's cooldown.
    const eth = diffAlerts(r5.state, payload({ BTC: formSym([A, B]), ETH: formSym([cand('ETH:3m:long:E')]) }), T0 + 18 * MIN);
    assertEqual(w(eth), 'WATCH:ETH 3m LONG forming', 'per-symbol cooldown');
    // A new id first seen triggering alerts TRIGGERING, under the cooldown.
    const t0 = run(withPrefs('watch'), [cand('BTC:1m:long:T', 'triggering', { timeframe: '1m' })], 0);
    assertEqual(w(t0), 'TRIGGERING:BTC 1m LONG triggering', 'new triggering');
    assertEqual(WATCH_COOLDOWN_MS, 15 * MIN, 'cooldown');
  });

  await test('WATCH memory rolls at 200 ids and survives parseState; level setup tracks nothing', () => {
    let st = withPrefs('watch');
    for (let i = 0; i < 205; i++) st = diffAlerts(st, payload({ BTC: formSym([cand(`BTC:3m:long:${i}`)]) }), T0 + i * 16 * MIN).state;
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
    assertEqual(JSON.stringify(normalizePrefs({ level: 'loud', quiet: { start: 3, end: 3 } })), '{"level":"setup","quiet":{"start":1,"end":5}}', 'garbage -> defaults');
    const off = parseState(applyPrefsChange(null, { quiet: null }));
    assertEqual(off.prefs.quiet, null, 'off persists as null');
    const lv = parseState(applyPrefsChange(JSON.stringify({ ...emptyState(), symbols: { BTC: { goodIds: ['k'] } } }), { level: 'watch' }));
    assertEqual(`${lv.prefs.level}|${lv.symbols.BTC.goodIds[0]}`, 'watch|k', 'level saved, alert memory kept');
    const d = diffAlerts(withPrefs('good', null), payload(), T0);
    assertEqual(JSON.stringify(d.state.prefs), '{"level":"good","quiet":null}', 'diff keeps prefs');
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
    assertEqual(JSON.stringify(st.prefs), '{"level":"watch","quiet":{"start":22,"end":6}}', 'persisted');
    const q = await hook({ text: '/alerts quiet', blob });
    assertEqual(q.tg.calls[0].text, 'Quiet hours: 22:00–06:00 America/Chicago, every day (alerts arrive silently)', 'quiet show');
    await hook({ text: '/alerts quiet off', blob });
    st = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assertEqual(st.prefs.quiet, null, 'off persisted');
    const status = await hook({ text: '/status', blob });
    assert(status.tg.calls[0].text.includes('Alert level: watch') && status.tg.calls[0].text.includes('Quiet hours: off'), status.tg.calls[0].text);
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
    assert(tg.calls.some((c) => c.text && c.text.startsWith('WATCH · ETH 3m LONG forming')), JSON.stringify(tg.calls.map((c) => c.text && c.text.slice(0, 40))));
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
    assert(c.text.includes('🟢 GO IN') && c.text.includes('<b>DATA</b>'), c.text.slice(0, 200));
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
    assert(st.tg.calls[0].text.includes('Cron last run: 14:05 UTC'), st.tg.calls[0].text);
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
    const goodMsgs = tg.calls.filter((c) => c.method === 'sendMessage' && c.text.includes('NEW GOOD'));
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
    const good = tg.calls.filter((c) => c.method === 'sendMessage' && c.text.includes('NEW GOOD'));
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

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
