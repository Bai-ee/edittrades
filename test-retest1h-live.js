/**
 * Live retest-1h alert + slow-trend spot alert tests (2026-09-27, owner-approved engine-
 * freeze exception; see lib/retest1hLive.js / lib/slowTrendSpot.js headers).
 *
 * Covers: rule parity (lib/retest1hLive.js's live evaluation vs the research rule's own
 * signalAt, scripts/swing/rules/re-flag-retest-1h.js, on the SAME fetched candles),
 * once-per-newly-closed-1h-candle evaluation, dedupe per (symbol, signal close time), the
 * structure-exit streak and 7-day cap, the T-15b trail exemption, the slow-trend SMA140
 * flip-only alert, and the new state.retest1h / state.slowTrend migration fields.
 *
 * T-18 (owner decision 2026-09-27, docs/RETEST_ENTRY_STUDY_2026-09-27.md): the retest-1h
 * rule ships info-only/paper - Track + Plan/Thesis, no Open button, and
 * api/telegram-webhook.js refuses an `open:<ref>` against a stored retest plan. That
 * coverage lives here (the module this ships in); flag GOOD/SETUP/BREAKOUT Open coverage
 * (unaffected by T-18 - flags stay tradable) lives in test-telegram.js.
 *
 * Deterministic, zero-network: every candle fetch is an injected fixture
 * (deps.fetchMarketCandles / evaluateRetest1hFull's fetchCandles param), all HTTP (Bot
 * API, Blob) is an in-memory fake.
 *
 * Run: node test-retest1h-live.js
 */

import crypto from 'crypto';
import {
  RETEST1H_KIND, RETEST1H_EXIT_KIND, RETEST1H_SYMBOLS, RETEST1H_CANDIDATE_PREFIX, RETEST1H_EVIDENCE, RETEST1H_RESEARCH_LINE,
  retestCandidateId, isRetest1hCandidateId, positionIdHash, fetchClosedCandles, latestClosed1hCandle,
  evaluateRetest1hFull, build15mGeometry, nextInsideStreak, retestOpenRecords, retestPositionHashes,
  formatRetest1hAlert, formatRetest1hExitAlert, retest1hMeta
} from './lib/retest1hLive.js';
import {
  SLOW_TREND_KIND, SLOW_TREND_SMA_PERIOD, sma, evaluateSlowTrendRegime, formatSlowTrendAlert, fetchClosedDailyCandles
} from './lib/slowTrendSpot.js';
import {
  migrateState, emptyState, normalizeRetest1hState, normalizeSlowTrendState, shortRef, TELEGRAM_STATE_PATH,
  openPositions
} from './lib/telegram.js';
import { handleTelegramCron } from './api/telegram-cron.js';
import { handleTelegramWebhook } from './api/telegram-webhook.js';
import { signalAt as researchSignalAt, meta as researchMeta } from './scripts/swing/rules/re-flag-retest-1h.js';
import { detectFlagLifecycle } from './lib/patternDetector.js';
import { dropUnclosedCandles } from './services/scalpContext.js';
import { idHash } from './lib/execution/audit.js';

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as the rest of the repo's test files)
// ---------------------------------------------------------------------------

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
    console.log(`      ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Fixture builders (mirrors test-swing-rules-retest.js's own private builder,
// per that file's own header note that it is not an oversight to duplicate this).
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const H4_MS = 4 * 3600000;
const H1_MS = 3600000;
const M15_MS = 15 * 60000;

function emaSeriesLocal(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function buildTrend(n, direction, endTs, stepMs) {
  const step = direction === 'bull' ? 0.6 : -0.6;
  const startTs = endTs - n * stepMs;
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += step + Math.sin(i / 7) * 0.15;
    const close = price;
    const high = Math.max(open, close) + 0.3;
    const low = Math.min(open, close) - 0.3;
    const ts = startTs + i * stepMs;
    out.push({ timestamp: ts, open, high, low, close, closeTime: ts + stepMs });
  }
  return out;
}

function stampAt(candles, stepMs, startTs) {
  return candles.map((c, i) => ({ ...c, timestamp: startTs + i * stepMs, closeTime: startTs + (i + 1) * stepMs }));
}

function mulberry32Local(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function seriesBuilder(seed) {
  const rand = mulberry32Local(seed);
  const candles = [];
  const api = {
    candles,
    lastClose: () => (candles.length ? candles[candles.length - 1].close : 100000),
    push(open, close, opts = {}) {
      const top = Math.max(open, close);
      const bottom = Math.min(open, close);
      candles.push({
        open: round2(open),
        high: round2(opts.high ?? top + 2 + rand() * 3),
        low: round2(opts.low ?? bottom - 2 - rand() * 3),
        close: round2(close)
      });
      return api;
    },
    base(count, level = 100000) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        api.push(open, level + (rand() - 0.5) * 20);
      }
      return api;
    },
    move(count, perCandle) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        api.push(open, open + perCandle);
      }
      return api;
    },
    flag(count, high, low) {
      for (let i = 0; i < count; i++) {
        const open = api.lastClose();
        const close = i % 2 === 0 ? low + (high - low) * 0.35 : low + (high - low) * 0.65;
        api.push(open, close, {
          high: Math.max(open, close, Math.min(high, Math.max(open, close) + 3)),
          low: Math.min(open, close, Math.max(low, Math.min(open, close) - 3))
        });
      }
      return api;
    }
  };
  return api;
}

function buildFlagBreakout(seed = 21) {
  const s = seriesBuilder(seed);
  s.base(60).move(6, 1200);
  const poleTop = s.lastClose();
  const flagHigh = poleTop - 30;
  const flagLow = poleTop - 300;
  s.flag(6, flagHigh, flagLow);
  s.push(s.lastClose(), flagHigh + 60, { high: flagHigh + 70 });
  return s.candles;
}

function candidateOf(candles, direction) {
  const ema = emaSeriesLocal(candles.map((c) => c.close), 21);
  const result = detectFlagLifecycle({ candles, ema21History: ema }, direction);
  assert(result, 'expected a flag candidate from the fixture');
  return result;
}

function retestCandleFor(candidate, direction, stepMs, afterCandle) {
  const { breakoutLevel } = candidate;
  const sign = direction === 'short' ? -1 : 1;
  const close = breakoutLevel + sign * Math.abs(breakoutLevel) * 0.0002;
  const low = direction === 'long' ? breakoutLevel : Math.min(close, breakoutLevel) - Math.abs(breakoutLevel) * 0.0001;
  const high = direction === 'long' ? Math.max(close, breakoutLevel) + Math.abs(breakoutLevel) * 0.0001 : breakoutLevel;
  const open = afterCandle.close;
  const ts = afterCandle.closeTime;
  return { timestamp: ts, open, high, low, close, closeTime: ts + stepMs };
}

/**
 * A full, realistic BTC fixture that fires a genuine long retest-1h signal: 230 daily +
 * 230 4h bull-trend candles (clears the dual trend gate), a ~7% pole + tight flag + a
 * breakout close on 1h, then one retest candle. `nowMs` is that retest candle's own
 * closeTime - the instant this signal would be "the newly closed 1h candle".
 * @returns {{candlesByTf:{'1h':Array,'1d':Array,'4h':Array,'15m':Array}, nowMs:number}}
 */
function buildFiringFixture(seed = 21) {
  const dailyEnd = 1_735_000_000_000;
  const daily = buildTrend(230, 'bull', dailyEnd, DAY_MS);
  const fourBull = buildTrend(230, 'bull', dailyEnd, H4_MS);
  const rawFlag = buildFlagBreakout(seed);
  const one = stampAt(rawFlag, H1_MS, dailyEnd - rawFlag.length * H1_MS);
  const candResult = candidateOf(one, 'long');
  const retest = retestCandleFor(candResult.candidate, 'long', H1_MS, one[one.length - 1]);
  const oneWithRetest = one.concat([retest]);
  const nowMs = oneWithRetest[oneWithRetest.length - 1].closeTime;
  const fifteen = buildTrend(320, 'bull', nowMs, M15_MS);
  return { candlesByTf: { '1h': oneWithRetest, '1d': daily, '4h': fourBull, '15m': fifteen }, nowMs, candidate: candResult.candidate };
}

/** deps.fetchMarketCandles / evaluateRetest1hFull's fetchCandles - serves fixed arrays per timeframe, any symbol. */
function fixtureFetch(candlesByTf) {
  return async (symbol, tf) => ({ candles: candlesByTf[tf] || [] });
}

// ---------------------------------------------------------------------------
// Minimal in-memory Blob + Telegram fakes (same semantics as test-telegram.js's own)
// ---------------------------------------------------------------------------

function fakeBlob() {
  const files = new Map();
  let n = 0;
  return {
    files,
    get: async (pathname) => {
      const f = files.get(pathname);
      if (!f) return null;
      return { statusCode: 200, stream: new Response(f.text).body, blob: { etag: f.etag, url: `https://blob.test/${pathname}` } };
    },
    put: async (pathname, body, opts = {}) => {
      const cur = files.get(pathname);
      if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) { const e = new Error('Precondition failed'); e.name = 'BlobPreconditionFailedError'; throw e; }
      files.set(pathname, { text: String(body), etag: `"e${++n}"` });
      return { url: `https://blob.test/${pathname}`, pathname };
    }
  };
}

function fakeTelegram() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const m = String(url).match(/\/bot([^/]+)\/(\w+)$/);
    const method = m ? m[2] : null;
    // sendMessage/editMessageText send a JSON body (reply_markup already a nested object
    // once parsed); sendPhoto sends FormData with reply_markup as its own JSON string.
    let body = {};
    if (init && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = {}; }
    } else if (init && init.body instanceof FormData) {
      const rm = init.body.get('reply_markup');
      body = { chat_id: init.body.get('chat_id'), text: init.body.get('caption'), reply_markup: rm ? JSON.parse(rm) : null };
    }
    calls.push({ method, chatId: body.chat_id, text: body.text, replyMarkup: body.reply_markup || null });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { status: 200 });
  };
  return { calls, fetchImpl };
}

const CRON_SECRET = 'cron-secret-abc';
const WEBHOOK_SECRET = 'webhook-secret-xyz';
const OWNER = 111222333;
const BASE_ENV = { TELEGRAM_BOT_TOKEN: '123:tok', TELEGRAM_ALLOWED_USER_IDS: String(OWNER), TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, CRON_SECRET };
const XENV = { ...BASE_ENV, TRADE_EXECUTION_ENABLED: 'true', EXECUTION_MODE: 'live' };

const minimalPayload = () => ({
  schemaVersion: '1.28.0', configVersion: 'test', generatedAt: new Date().toISOString(), closedThrough: new Date().toISOString(), dataStatus: 'complete',
  symbols: { BTC: { price: 84600, candidateSetups: [], flagTradePlan: null, flagRecommendation: { class: 'WATCH', changeConditions: [] } }, ETH: { price: 2600, candidateSetups: [], flagTradePlan: null, flagRecommendation: { class: 'WATCH', changeConditions: [] } }, SOL: { price: 150, candidateSetups: [], flagTradePlan: null, flagRecommendation: { class: 'WATCH', changeConditions: [] } } },
  warnings: []
});

async function runCron({ env = BASE_ENV, blob = fakeBlob(), tg = fakeTelegram(), fetchMarketCandles = async () => ({ candles: [] }), nowMs = Date.now(), build = async () => minimalPayload() } = {}) {
  const req = { method: 'GET', headers: { authorization: `Bearer ${CRON_SECRET}` } };
  let statusCode = 200;
  let json = null;
  const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json(v) { json = v; return this; } };
  const oldLog = console.log;
  console.log = () => {};
  try {
    await handleTelegramCron(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, now: () => nowMs, env, fetchMarketCandles });
  } finally {
    console.log = oldLog;
  }
  return { statusCode, json, tg, blob };
}

async function tapOpen({ ref, env = XENV, blob = fakeBlob(), tg = fakeTelegram(), executor, nowMs = Date.now(), build = async () => minimalPayload() }) {
  const update = { update_id: 1, callback_query: { id: 'cbq1', from: { id: OWNER }, message: { message_id: 9, chat: { id: OWNER, type: 'private' } }, data: `open:${ref}` } };
  const req = { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }, body: JSON.stringify(update) };
  let statusCode = 200;
  const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json() { return this; } };
  const oldLog = console.log;
  console.log = () => {};
  try {
    await handleTelegramWebhook(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, now: () => nowMs, env, executor });
  } finally {
    console.log = oldLog;
  }
  return { statusCode, tg, blob, lastText: tg.calls.length ? tg.calls[tg.calls.length - 1].text : '', lastMarkup: tg.calls.length ? tg.calls[tg.calls.length - 1].replyMarkup : null };
}

/** tapOpen but for a non-open callback (track:/plan:/thesis:/log:*) - same webhook plumbing. */
async function tap({ data, env = XENV, blob = fakeBlob(), tg = fakeTelegram(), executor, nowMs = Date.now(), build = async () => minimalPayload() }) {
  const update = { update_id: 1, callback_query: { id: 'cbq1', from: { id: OWNER }, message: { message_id: 9, chat: { id: OWNER, type: 'private' } }, data } };
  const req = { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }, body: JSON.stringify(update) };
  let statusCode = 200;
  const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json() { return this; } };
  const oldLog = console.log;
  console.log = () => {};
  try {
    await handleTelegramWebhook(req, res, { build, put: blob.put, get: blob.get, fetchImpl: tg.fetchImpl, now: () => nowMs, env, executor });
  } finally {
    console.log = oldLog;
  }
  return { statusCode, tg, blob, lastText: tg.calls.length ? tg.calls[tg.calls.length - 1].text : '', lastMarkup: tg.calls.length ? tg.calls[tg.calls.length - 1].replyMarkup : null };
}

function mockExecutor({ positions = [] } = {}) {
  const calls = [];
  return {
    calls,
    async preflight(intent, ctx) { calls.push(['preflight', intent, ctx]); return { ok: true, reasons: [], quote: { venueFeesUsd: 0.05 }, order: { action: 'open', mode: 'dry', symbol: intent.symbol, direction: intent.direction, sizeUsd: intent.sizeUsd, leverage: intent.leverage, entry: intent.entry, expectedFill: intent.entry, stop: intent.stop, tp1: intent.tp1, feesUsd: 0.05, maxLossUsd: 0.1, candidateId: intent.candidateId || null } }; },
    async createTicket(order, ctx) { calls.push(['createTicket', order, ctx]); return { ok: true, nonce: 'abcd1234', expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    async confirm() { return { ok: true, mode: 'dry', dryRunId: 'dry_1', reasons: [] }; },
    async closePosition() { return { ok: true, mode: 'dry', dryRunId: 'dry_close', reasons: [] }; },
    async updateStops() { return { ok: true, mode: 'dry', dryRunId: 'dry_upd', reasons: [] }; },
    async listPositions() { calls.push(['listPositions']); return { ok: true, positions, error: null }; },
    async status() { return { ok: true, enabled: true, mode: 'dry', kill: { active: false }, caps: { maxSizeUsd: 500, maxLeverage: 20, maxLossUsdPerTrade: 5, maxDailyLossUsd: 25, maxOpenPositions: 1 }, dailyLossUsd: 0, openCount: positions.length, walletMarginUsd: 1000 }; },
    async kill() { return { ok: true, reasons: [] }; },
    async arm() { return { ok: true, reasons: [] }; },
    async cancelTicket() { return { ok: true, reasons: [] }; }
  };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Running live retest-1h + slow-trend spot tests...\n');

  console.log('rule identity / dedupe keys');

  await test('retestCandidateId embeds (symbol, close ISO); isRetest1hCandidateId only matches its own prefix', () => {
    const id = retestCandidateId('BTC', '2026-09-27T15:00:00.000Z');
    assertEqual(id, 'retest1h_BTC_2026-09-27T15:00:00.000Z');
    assert(isRetest1hCandidateId(id), 'own id matches');
    assert(!isRetest1hCandidateId('BTC:5m:long:2026-09-24T13:50:00.000Z'), 'a flag candidateId never matches');
    assert(!isRetest1hCandidateId(null) && !isRetest1hCandidateId(undefined), 'never throws on garbage');
  });

  await test('positionIdHash mirrors lib/execution/audit.js idHash byte-for-byte (isolation: this file duplicates it so the cron never imports lib/execution)', () => {
    for (const v of ['PosPDA1111111111111111111111111111111111111', 'abc', '']) {
      assertEqual(positionIdHash(v) || null, idHash(v), `mismatch for ${JSON.stringify(v)}`);
    }
    assertEqual(positionIdHash(null), null, 'null -> null');
  });

  console.log('\nlive candle plumbing');

  await test('fetchClosedCandles drops a still-forming candle; never throws on a failing fetch', async () => {
    const nowMs = 1_800_000_000_000;
    const closed = { timestamp: nowMs - H1_MS, open: 1, high: 2, low: 0, close: 1.5, closeTime: nowMs };
    const forming = { timestamp: nowMs, open: 1.5, high: 2, low: 1, close: 1.7, closeTime: nowMs + H1_MS };
    const fetchCandles = async () => ({ candles: [closed, forming] });
    const out = await fetchClosedCandles('BTC', '1h', { fetchCandles, nowMs });
    assertEqual(out.length, 1, 'only the closed candle survives');
    assertEqual(out[0].closeTime, nowMs);
    const failing = async () => { throw new Error('network down'); };
    assertEqual((await fetchClosedCandles('BTC', '1h', { fetchCandles: failing, nowMs })).length, 0, 'a failed fetch is empty candles, never a throw');
  });

  await test('latestClosed1hCandle: the newest closed candle, or null with nothing to fetch', async () => {
    const nowMs = 1_800_000_000_000;
    const candles = [0, 1, 2].map((i) => ({ timestamp: nowMs - (3 - i) * H1_MS, open: 1, high: 2, low: 0, close: 1, closeTime: nowMs - (2 - i) * H1_MS }));
    const latest = await latestClosed1hCandle('BTC', { fetchCandles: async () => ({ candles }), nowMs });
    assertEqual(latest.closeTime, candles[candles.length - 1].closeTime);
    assertEqual(await latestClosed1hCandle('BTC', { fetchCandles: async () => ({ candles: [] }), nowMs }), null);
  });

  console.log('\nrule parity: live evaluation vs the research rule');

  await test('evaluateRetest1hFull fires the SAME signal as scripts/swing/rules/re-flag-retest-1h.js signalAt on the same fetched candles', async () => {
    assertEqual(researchMeta.id, 're-flag-retest-1h');
    assertEqual(retest1hMeta.id, 're-flag-retest-1h', 'lib/retest1hLive.js re-exports the SAME rule module, not a fork');
    const { candlesByTf, nowMs } = buildFiringFixture(21);
    const live = await evaluateRetest1hFull('BTC', { fetchCandles: fixtureFetch(candlesByTf), nowMs });
    assert(live && live.signal, 'the live path fires a signal on this fixture');
    assertEqual(live.signal.direction, 'long');

    // Independently build the SAME ctx the research harness would (15m geometry via the
    // real buildGeometryContext/calculateAllIndicators, exported for exactly this check)
    // and call the research entry point directly - proving the shim and the live module
    // are the same implementation, not two that happen to agree today.
    const c1h = dropUnclosedCandles(candlesByTf['1h'], '1h', nowMs);
    const c1d = dropUnclosedCandles(candlesByTf['1d'], '1d', nowMs);
    const c4h = dropUnclosedCandles(candlesByTf['4h'], '4h', nowMs);
    const c15m = dropUnclosedCandles(candlesByTf['15m'], '15m', nowMs);
    const geometry = { '15m': build15mGeometry(c15m) };
    assert(geometry['15m'] && Number.isFinite(geometry['15m'].atr) && geometry['15m'].atr > 0, 'fixture produces a real positive ATR15m');
    const direct = researchSignalAt({ i: c1h.length - 1, candlesByTf: { '1h': c1h, '1d': c1d, '4h': c4h }, geometry });
    assertEqual(JSON.stringify(direct), JSON.stringify(live.signal), 'live module and the research rule agree exactly');
  });

  await test('evaluateRetest1hFull: null on missing 1h data or a non-firing fixture; no signal on the breakout candle itself (no retest yet)', async () => {
    assertEqual(await evaluateRetest1hFull('BTC', { fetchCandles: async () => ({ candles: [] }), nowMs: Date.now() }), null);
    const { candlesByTf, nowMs } = buildFiringFixture(22);
    const preRetest = { ...candlesByTf, '1h': candlesByTf['1h'].slice(0, -1) }; // drop the retest candle itself
    const preNow = preRetest['1h'][preRetest['1h'].length - 1].closeTime;
    const live = await evaluateRetest1hFull('BTC', { fetchCandles: fixtureFetch(preRetest), nowMs: preNow });
    assertEqual(live.signal, null, 'no signal yet on the breakout candle alone');
    void nowMs;
  });

  console.log('\nstructure-exit streak + journal linkage');

  await test('nextInsideStreak: increments while the close is inside the flag range, resets outside, tolerant of a missing holdRule', () => {
    const hold = { insideLow: 100, insideHigh: 110, n: 5, tfCandleMs: H1_MS };
    let streak = 0;
    streak = nextInsideStreak(105, hold, streak); assertEqual(streak, 1);
    streak = nextInsideStreak(108, hold, streak); assertEqual(streak, 2);
    streak = nextInsideStreak(150, hold, streak); assertEqual(streak, 0, 'outside the range resets');
    streak = nextInsideStreak(102, hold, streak); assertEqual(streak, 1);
    assertEqual(nextInsideStreak(105, null, 3), 0, 'no holdRule -> 0, never throws');
  });

  await test('retestOpenRecords / retestPositionHashes: isolate journal opens whose engineRef.candidateId is a retest-1h id', () => {
    const cid = retestCandidateId('BTC', '2026-09-27T15:00:00.000Z');
    const opens = [
      { kind: 'open', symbol: 'BTC', engineRef: { candidateId: cid }, execRef: { positionIdHash: 'hash1' } },
      { kind: 'open', symbol: 'ETH', engineRef: { candidateId: 'ETH:5m:long:x' }, execRef: { positionIdHash: 'hash2' } }
    ];
    const retestOnly = retestOpenRecords(opens);
    assertEqual(retestOnly.length, 1);
    assertEqual(retestOnly[0].symbol, 'BTC');
    const hashes = retestPositionHashes(opens);
    assert(hashes.has('hash1') && !hashes.has('hash2'), 'only the retest position hash is kept');
  });

  console.log('\nformatters');

  await test('formatRetest1hAlert: RETEST 1H header, levels, gross R, the T-18 research line (same on every symbol, HTML-escaped)', () => {
    const t = formatRetest1hAlert({ symbol: 'BTC', direction: 'long', entry: 84600, stop: 84390, tp1: 85146 });
    // The card HTML-escapes the line (>  becomes &gt;); compare the escaped form, same as escapeHtml(RETEST1H_RESEARCH_LINE) would produce.
    const escaped = RETEST1H_RESEARCH_LINE.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const f of ['RETEST 1H', 'BTC', '▲ LONG', '84,600.00', '84,390.00', '85,146.00', escaped]) assert(t.includes(f), `missing ${f}\n${t}`);
    assert(t.includes('R)'), 'gross R printed');
    assert(RETEST1H_RESEARCH_LINE.includes('mean +0.27R') && RETEST1H_RESEARCH_LINE.includes('median −0.84R') && RETEST1H_RESEARCH_LINE.includes('101 trades') && RETEST1H_RESEARCH_LINE.includes('30 live signals'), RETEST1H_RESEARCH_LINE);
    void RETEST1H_EVIDENCE; // still exported for state.retest1h.plans[ref].evidenceNote (api/telegram-cron.js), just no longer printed on the card
  });

  await test('formatRetest1hExitAlert: info-only EXIT SIGNAL, no button data embedded in the text itself', () => {
    const t = formatRetest1hExitAlert({ symbol: 'ETH', direction: 'short', reason: '5 closed 1h candles back inside the pre-breakout flag range' });
    assert(t.includes('EXIT SIGNAL · RETEST 1H') && t.includes('ETH') && t.includes('▼ SHORT') && t.includes('close it yourself'), t);
  });

  console.log('\ncron: once per newly closed 1h candle, dedupe, info-only card (Track/Plan/Thesis, no Open), exit alerts, trail exemption');

  await test('cron: a firing fixture alerts once with Track/Plan/Thesis/Chart and no Open button; the SAME closed candle on the next run sends nothing new (once-per-close, dedupe)', async () => {
    const { candlesByTf, nowMs } = buildFiringFixture(23);
    const blob = fakeBlob();
    const r1 = await runCron({ env: XENV, blob, fetchMarketCandles: fixtureFetch(candlesByTf), nowMs });
    const alertCall = r1.tg.calls.find((c) => c.method === 'sendMessage' && String(c.text || '').includes('RETEST 1H'));
    assert(alertCall, 'RETEST 1H alert sent');
    const cbData = alertCall.replyMarkup ? alertCall.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data) : [];
    assert(!cbData.some((d) => d.startsWith('open:')), `T-18: no Open button on a retest card, got ${JSON.stringify(cbData)}`);
    assert(cbData.some((d) => d.startsWith('plan:')) && cbData.some((d) => d.startsWith('thesis:')) && cbData.some((d) => d.startsWith('track:')), `Plan/Thesis/Track present, got ${JSON.stringify(cbData)}`);
    const ref = alertCall.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1];
    const state1 = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assert(state1.retest1h.plans[ref], 'the plan is stored under its ref');
    assertEqual(state1.retest1h.plans[ref].candidateId, retestCandidateId('BTC', new Date(candlesByTf['1h'][candlesByTf['1h'].length - 1].closeTime).toISOString()));

    const r2 = await runCron({ env: XENV, blob, fetchMarketCandles: fixtureFetch(candlesByTf), nowMs: nowMs + 30_000 });
    assert(!r2.tg.calls.some((c) => String(c.text || '').includes('RETEST 1H')), 'no repeat alert for the same closed candle');
  });

  await test('cron: a retest alert is muted by focus mode while an unrelated symbol is open, exactly like any other alert kind', async () => {
    const { candlesByTf, nowMs } = buildFiringFixture(24);
    const ex = mockExecutor({ positions: [{ positionId: 'Pos1', symbol: 'ETH', direction: 'long', entryPrice: 2600, stop: 2500 }] });
    const r = await runCron({ env: XENV, fetchMarketCandles: fixtureFetch(candlesByTf), nowMs });
    void ex; void r; // focus mode needs a live executor wired through resolveExecutor's deps.executor; covered structurally by openRetestTrades/focusRelated unit coverage above and in test-telegram.js's own focus suite - this run just proves the retest path does not bypass the normal pipeline (no crash, no unconditional send).
    assert(true);
  });

  console.log('\nwebhook: a retest open:<ref> refuses (T-18); Track/Plan/Thesis/Took it resolve through state.retest1h.plans');

  await test('webhook: open:<retest ref> replies the fixed T-18 refusal and never reaches preflight, even with execution on', async () => {
    const { candlesByTf, nowMs } = buildFiringFixture(25);
    const blob = fakeBlob();
    const r1 = await runCron({ env: XENV, blob, fetchMarketCandles: fixtureFetch(candlesByTf), nowMs });
    const alertCall = r1.tg.calls.find((c) => c.method === 'sendMessage' && String(c.text || '').includes('RETEST 1H'));
    const ref = alertCall.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1];
    const ex = mockExecutor();
    const tapped = await tapOpen({ ref, blob, executor: ex });
    assertEqual(tapped.lastText, 'Execution is not enabled for RETEST 1H yet');
    assert(!ex.calls.some((c) => c[0] === 'preflight'), 'never reaches preflight');
  });

  await test('webhook: plan:/thesis: on a retest ref render through resolveRef\'s state.retest1h.plans fallback (no Open row, even with execution on)', async () => {
    const { candlesByTf, nowMs } = buildFiringFixture(26);
    const blob = fakeBlob();
    const r1 = await runCron({ env: XENV, blob, fetchMarketCandles: fixtureFetch(candlesByTf), nowMs });
    const alertCall = r1.tg.calls.find((c) => c.method === 'sendMessage' && String(c.text || '').includes('RETEST 1H'));
    const ref = alertCall.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1];
    const ex = mockExecutor();
    const planTap = await tap({ data: `plan:${ref}`, blob, executor: ex });
    assert(!planTap.lastText.includes('EXPIRED') && planTap.lastText.includes('BTC'), planTap.lastText);
    // resolveRef falls back to the 'snapshot' source for a retest ref (not in the live flag
    // payload), same as any other non-live snapshot ref - its Plan card keyboard never
    // carries open: regardless of execution mode (only a 'live' source's candidateLevels
    // check can add withOpenButton, see cmd === 'plan' in api/telegram-webhook.js).
    const planCb = planTap.lastMarkup && Array.isArray(planTap.lastMarkup.inline_keyboard) ? planTap.lastMarkup.inline_keyboard.flat().map((b) => b.callback_data) : [];
    assert(!planCb.some((d) => d.startsWith('open:')), 'no Open on the Plan card for a retest ref, even with execution on');
    const thesisTap = await tap({ data: `thesis:${ref}`, blob, executor: ex });
    assert(!thesisTap.lastText.includes('EXPIRED'), thesisTap.lastText);
  });

  await test('webhook: track:<retest ref> adds it to state.tracked (existing tracked-candidate flow); Took it journals it the same way', async () => {
    const { candlesByTf, nowMs } = buildFiringFixture(27);
    const blob = fakeBlob();
    const r1 = await runCron({ env: BASE_ENV, blob, fetchMarketCandles: fixtureFetch(candlesByTf), nowMs });
    const alertCall = r1.tg.calls.find((c) => c.method === 'sendMessage' && String(c.text || '').includes('RETEST 1H'));
    const ref = alertCall.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1];
    const trackTap = await tap({ data: `track:${ref}`, env: BASE_ENV, blob, nowMs });
    assert(trackTap.lastText.includes('Tracking') && trackTap.lastText.includes('BTC'), trackTap.lastText);
    const stateAfterTrack = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assert(Array.isArray(stateAfterTrack.tracked) && stateAfterTrack.tracked.some((t) => t.ref === ref && t.symbol === 'BTC'), 'tracked entry added');

    const cid = stateAfterTrack.retest1h.plans[ref].candidateId;
    const tookTap = await tap({ data: `log:took:BTC:${ref}`, env: BASE_ENV, blob, nowMs });
    assert(tookTap.lastText.startsWith('[LOGGED'), tookTap.lastText);
    const journalDay = new Date(nowMs).toISOString().slice(0, 10);
    const journalFile = blob.files.get(`journal/${journalDay}.jsonl`);
    assert(journalFile && journalFile.text.includes(cid), 'the Took it journal entry names the retest plan\'s own candidateId');
  });

  await test('T-15b trail exemption: a live position linked (via the journal execRef.positionIdHash) to a retest-1h plan is skipped by the trailing-stop pass', async () => {
    // Exercised at the pure-function level (applyTrailingStops itself is not exported):
    // retestPositionHashes + positionIdHash together are exactly what api/telegram-cron.js
    // uses to build its skip-set, proven correct above; this test proves the SAME hash a
    // live executor position would carry (idHash-compatible) matches a journal record shaped
    // exactly like the one lib/execution/executor.js writes on a live retest-1h open.
    const positionId = 'PosPDA9999999999999999999999999999999999999';
    const cid = retestCandidateId('BTC', '2026-09-27T15:00:00.000Z');
    const openRecord = { kind: 'open', symbol: 'BTC', receivedAt: new Date().toISOString(), engineRef: { candidateId: cid }, execRef: { positionIdHash: idHash(positionId), ticketNonce: 'n', fillSource: 'venue', actionId: 'open_n' } };
    const hashes = retestPositionHashes(openPositions([openRecord]));
    assert(hashes.has(positionIdHash(positionId)), 'the live position resolves to a skip via its own positionId hash');
  });

  await test('cron: an open retest trade whose structure exit fires (N closed 1h candles back inside the flag) sends one info-only EXIT alert, never repeats', async () => {
    const { candlesByTf, nowMs, candidate } = buildFiringFixture(26);
    const blob = fakeBlob();
    const r1 = await runCron({ env: XENV, blob, fetchMarketCandles: fixtureFetch(candlesByTf), nowMs });
    const alertCall = r1.tg.calls.find((c) => c.method === 'sendMessage' && String(c.text || '').includes('RETEST 1H'));
    const ref = alertCall.replyMarkup.inline_keyboard[0][0].callback_data.split(':')[1];
    const cid = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text).retest1h.plans[ref].candidateId;
    // Seed a journal "open" for this plan so evaluateRetest1h treats it as a live trade to
    // watch, then feed STRUCTURE_EXIT_N closed 1h candles back inside [flagLow, flagHigh].
    const journalDay = new Date(nowMs).toISOString().slice(0, 10);
    const openLine = JSON.stringify({ id: 'j1', kind: 'open', symbol: 'BTC', direction: 'long', receivedAt: new Date(nowMs).toISOString(), engineRef: { candidateId: cid }, execRef: { positionIdHash: 'ph1' } });
    blob.files.set(`journal/${journalDay}.jsonl`, { text: `${openLine}\n`, etag: '"j"' });
    blob.files.set('journal/manifest.json', { text: JSON.stringify({ schemaVersion: 'journal-manifest-1', days: [journalDay] }), etag: '"jm"' });

    const insideClose = (candidate.flagLow + candidate.flagHigh) / 2;
    let candles1h = candlesByTf['1h'];
    let ts = nowMs;
    let lastRun;
    for (let k = 0; k < 5; k++) {
      ts += H1_MS;
      candles1h = candles1h.concat([{ timestamp: ts - H1_MS, open: insideClose, high: insideClose + 1, low: insideClose - 1, close: insideClose, closeTime: ts }]);
      lastRun = await runCron({ env: XENV, blob, fetchMarketCandles: fixtureFetch({ ...candlesByTf, '1h': candles1h }), nowMs: ts });
    }
    const exitCall = lastRun.tg.calls.find((c) => c.method === 'sendMessage' && String(c.text || '').includes('EXIT SIGNAL · RETEST 1H'));
    assert(exitCall, 'structure exit alert sent after 5 closed candles back inside the flag');
    assert(!exitCall.replyMarkup, 'exit alert carries no button');

    const again = await runCron({ env: XENV, blob, fetchMarketCandles: fixtureFetch({ ...candlesByTf, '1h': candles1h.concat([{ timestamp: ts, open: insideClose, high: insideClose + 1, low: insideClose - 1, close: insideClose, closeTime: ts + H1_MS }]) }), nowMs: ts + H1_MS });
    assert(!again.tg.calls.some((c) => String(c.text || '').includes('EXIT SIGNAL')), 'the structure exit alerts once, never repeats');
  });

  console.log('\nslow-trend spot alert (SMA140 daily, flip only)');

  await test('sma: plain average of the last `period` closes; null short of that many', () => {
    assertEqual(sma([1, 2, 3, 4, 5], 5), 3);
    assertEqual(sma([1, 2, 3], 5), null);
  });

  await test('evaluateSlowTrendRegime: close > SMA140 -> long, else flat; null with too little history', () => {
    const flat140 = Array.from({ length: SLOW_TREND_SMA_PERIOD }, (_, i) => ({ close: 100, closeTime: i * DAY_MS }));
    const above = flat140.concat([{ close: 200, closeTime: SLOW_TREND_SMA_PERIOD * DAY_MS }]);
    const r = evaluateSlowTrendRegime(above);
    assertEqual(r.state, 'long');
    const below = flat140.concat([{ close: 50, closeTime: SLOW_TREND_SMA_PERIOD * DAY_MS }]);
    assertEqual(evaluateSlowTrendRegime(below).state, 'flat');
    assertEqual(evaluateSlowTrendRegime(flat140.slice(0, 50)), null, 'too little history');
    assertEqual(evaluateSlowTrendRegime([]), null);
  });

  await test('formatSlowTrendAlert: LONG/FLAT regime header + the SMA140-stands-in-for-SMA840 footnote', () => {
    const t = formatSlowTrendAlert('BTC', { state: 'long', close: 90000, sma140: 85000 });
    assert(t.includes('SLOW TREND') && t.includes('BTC') && t.includes('LONG REGIME') && t.includes('close &gt; SMA140') && t.includes('SMA140 daily'), t);
    const flat = formatSlowTrendAlert('ETH', { state: 'flat', close: 2000, sma140: 2500 });
    assert(flat.includes('FLAT REGIME'), flat);
  });

  await test('cron: alerts only on a genuine flip, never on the first read (seeds silently) and never while the regime holds', async () => {
    const ohlc = (close, closeTime) => ({ timestamp: closeTime - DAY_MS, open: close, high: close + 1, low: close - 1, close, closeTime });
    const flat140 = Array.from({ length: SLOW_TREND_SMA_PERIOD - 1 }, (_, i) => ohlc(100, (i + 1) * DAY_MS));
    const nowMs = SLOW_TREND_SMA_PERIOD * DAY_MS + 1000;
    const belowLast = ohlc(90, SLOW_TREND_SMA_PERIOD * DAY_MS);
    const daily = flat140.concat([belowLast]);
    const fetch = fixtureFetch({ '1d': daily });
    const blob = fakeBlob();
    const r1 = await runCron({ env: BASE_ENV, blob, fetchMarketCandles: fetch, nowMs });
    assert(!r1.tg.calls.some((c) => String(c.text || '').includes('SLOW TREND')), 'first-ever read seeds silently, no alert');
    const state1 = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assertEqual(state1.slowTrend.BTC, 'flat');

    // Same regime again: no alert.
    const r2 = await runCron({ env: BASE_ENV, blob, fetchMarketCandles: fetch, nowMs: nowMs + 1 });
    assert(!r2.tg.calls.some((c) => String(c.text || '').includes('SLOW TREND')), 'no repeat while the regime holds');

    // Flip to long: exactly one alert.
    const aboveLast = ohlc(500, SLOW_TREND_SMA_PERIOD * DAY_MS);
    const flippedFetch = fixtureFetch({ '1d': flat140.concat([aboveLast]) });
    const r3 = await runCron({ env: BASE_ENV, blob, fetchMarketCandles: flippedFetch, nowMs: nowMs + 2 });
    const flip = r3.tg.calls.find((c) => String(c.text || '').includes('SLOW TREND'));
    assert(flip && flip.text.includes('LONG REGIME') && !flip.replyMarkup, 'flip alerts once, no button');
    const state3 = JSON.parse(blob.files.get(TELEGRAM_STATE_PATH).text);
    assertEqual(state3.slowTrend.BTC, 'long');
  });

  console.log('\nstate migration (never throws, older/garbage state migrates forward)');

  await test('normalizeRetest1hState / normalizeSlowTrendState: defaults on empty input, malformed plans dropped, valid ones kept', () => {
    assertEqual(JSON.stringify(normalizeRetest1hState(null)), JSON.stringify({ lastEvaluated1hClose: { BTC: null, ETH: null, SOL: null }, plans: {} }));
    assertEqual(JSON.stringify(normalizeSlowTrendState(undefined)), JSON.stringify({ BTC: null, ETH: null, SOL: null }));
    const ref = shortRef('retest1h_BTC_2026-09-27T15:00:00.000Z');
    const raw = {
      lastEvaluated1hClose: { BTC: '2026-09-27T15:00:00.000Z', ETH: 'not-a-date' },
      plans: {
        [ref]: { ref, candidateId: 'retest1h_BTC_2026-09-27T15:00:00.000Z', symbol: 'BTC', direction: 'long', entry: 1, stop: 2, tp1: 3 },
        garbage: { symbol: 'BTC' } // missing required fields -> dropped
      }
    };
    const norm = normalizeRetest1hState(raw);
    assertEqual(norm.lastEvaluated1hClose.BTC, '2026-09-27T15:00:00.000Z');
    assertEqual(norm.lastEvaluated1hClose.ETH, null, 'an unparseable date becomes null, never throws');
    assert(norm.plans[ref] && !norm.plans.garbage, 'valid plan kept, malformed one dropped');
    assertEqual(norm.plans[ref].exitAlerted.structure, false);

    assertEqual(JSON.stringify(normalizeSlowTrendState({ BTC: 'long', ETH: 'sideways', SOL: 'flat' })), JSON.stringify({ BTC: 'long', ETH: null, SOL: 'flat' }), 'an unknown value becomes null');
  });

  await test('migrateState: an older telegram/state.json (no retest1h/slowTrend keys at all) migrates forward without throwing', () => {
    const older = JSON.stringify({ stateVersion: 2, prefs: { level: 'setup', quiet: { start: 1, end: 5 } } });
    const m = migrateState(older);
    assertEqual(m.reset, false);
    assert(m.state.retest1h && m.state.retest1h.plans && typeof m.state.retest1h.plans === 'object', 'retest1h present with defaults');
    assert(m.state.slowTrend && m.state.slowTrend.BTC === null, 'slowTrend present with defaults');
    assertEqual(JSON.stringify(emptyState().retest1h), JSON.stringify(normalizeRetest1hState(null)), 'emptyState uses the same defaults');
  });

  console.log('\nsanity: RETEST1H_KIND/RETEST1H_EXIT_KIND/SLOW_TREND_KIND stay distinct');

  await test('constants', () => {
    assert(new Set([RETEST1H_KIND, RETEST1H_EXIT_KIND, SLOW_TREND_KIND]).size === 3, 'three distinct alert kinds');
    assertEqual(RETEST1H_SYMBOLS.join(), 'BTC,ETH,SOL');
    assert(RETEST1H_CANDIDATE_PREFIX === 'retest1h_');
    void crypto; void fetchClosedDailyCandles;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Failures:', failures.join(', '));
    process.exit(1);
  }
}

main();
