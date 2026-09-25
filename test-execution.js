/**
 * T-3 A tests: guarded executor, gates, tickets, audit, and the on-chain position read
 * (docs/PLAN_TELEGRAM_EXECUTION.md). No network, no key: Jupiter, wallet, Blob, journal,
 * clock and env are all injected fakes. Asserts the context path (scalpContext, MCP,
 * flagRecommendation) never reaches lib/execution.
 *
 * Run: node test-execution.js
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import jupPerpsClient from './services/jup-perps-wrapper.cjs';
import { createExecutor, checkIntent, baseSymbol } from './lib/execution/executor.js';
import { readExecutionConfig, pinMatches, KILL_PATH, AUTO_KILL_MS } from './lib/execution/gates.js';
import { redact, appendAudit, auditDayPath } from './lib/execution/audit.js';
import { TICKETS_PATH, consumeTicket, storeTicket } from './lib/execution/tickets.js';
import { validateJournalEntry } from './lib/journalSchema.js';
import {
  derivePerpPositionCandidates, decodePerpPositionAccount, getPerpPositions, DEFAULT_PERP_CUSTODIES, POSITION_SIDE_SEED
} from './services/jupiterPerps.js';

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
    console.log(`  ✗ ${name}\n    ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n    ') : err}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const has = (arr, v, m) => { if (!Array.isArray(arr) || !arr.includes(v)) throw new Error(`${m}: ${JSON.stringify(arr)} lacks ${v}`); };

// ---------------------------------------------------------------- fakes

const BASE = 'https://fakestore.public.blob.vercel-storage.com';
function fakeBlob() {
  const files = new Map();
  let n = 0;
  const s = { files, failGet: false, failPut: false };
  s.get = async (pathname) => {
    if (s.failGet) { const e = new Error('blob down'); e.name = 'BlobServiceNotAvailable'; throw e; }
    const f = files.get(pathname);
    if (!f) return null;
    return { statusCode: 200, stream: new Response(f.text).body, blob: { etag: f.etag, url: `${BASE}/${pathname}` } };
  };
  s.put = async (pathname, body, opts) => {
    if (s.failPut) { const e = new Error('put down'); e.name = 'BlobServiceNotAvailable'; throw e; }
    const cur = files.get(pathname);
    if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) { const e = new Error('Precondition failed'); e.name = 'BlobPreconditionFailedError'; throw e; }
    if (!opts.ifMatch && opts.allowOverwrite === false && cur) { const e = new Error('This blob already exists'); e.name = 'BlobAccessError'; throw e; }
    files.set(pathname, { text: String(body), etag: `"e${++n}"` });
    return { url: `${BASE}/${pathname}`, pathname };
  };
  s.text = (p) => (files.get(p) ? files.get(p).text : null);
  s.all = () => [...files.values()].map((f) => f.text).join('\n');
  return s;
}

const T0 = Date.parse('2026-09-25T14:00:00Z');
const OWNER = 777001;
const FAKE_KEY = '5'.repeat(20) + 'KeyLikeBase58StringThatIsVeryLongAndLooksSecretXyzABCDEFGHJKLMNPQRSTUVWXYZabcdefghij';
const FAKE_RPC = 'https://mainnet.helius-rpc.com/?api-key=fake-rpc-secret-1234';
const FAKE_BOT = '123456789:AAFakeBotTokenValueForTestsOnly_xyz';
const PIN = '4821';

function baseEnv(over = {}) {
  return {
    TRADE_EXECUTION_ENABLED: 'true', EXECUTION_MODE: 'dry', EXECUTION_OWNER_IDS: String(OWNER), EXECUTION_PIN: PIN,
    EXECUTION_MAX_SIZE_USD: '500', EXECUTION_MAX_LEVERAGE: '10', EXECUTION_MAX_LOSS_USD_PER_TRADE: '20',
    EXECUTION_MAX_DAILY_LOSS_USD: '50', SOLANA_PRIVATE_KEY: FAKE_KEY, SOLANA_RPC_URL: FAKE_RPC, TELEGRAM_BOT_TOKEN: FAKE_BOT,
    ...over
  };
}

function fakeJupiter(over = {}) {
  const calls = { open: [], close: [], update: [], quote: 0, custody: 0, markets: 0, positions: 0 };
  const j = {
    calls,
    positions: [],
    getPerpMarkets: async () => { calls.markets++; return { BTCUSDT: {}, ETHUSDT: {}, SOLUSDT: {} }; },
    checkCustodyCapacity: async (market, size) => { calls.custody++; return { market, currentAssets: 1_000_000, requiredSize: size }; },
    getPerpQuote: async (market, direction, size, leverage) => { calls.quote++; return { market, direction, size, leverage, marginRequired: size / leverage, estimatedFees: size * 0.001, liquidationPrice: null }; },
    openPerpPosition: async (...args) => { calls.open.push(args); return { success: true, positionId: 'PosPda1111111111111111111111111111111111111', signature: '3xSig' + 'a'.repeat(80) }; },
    closePerpPosition: async (...args) => { calls.close.push(args); return { success: true, signature: 'placeholder_signature' }; },
    updatePerpPosition: async (...args) => { calls.update.push(args); return { success: true, signature: 'placeholder_signature' }; },
    getPerpPositions: async () => { calls.positions++; return { ok: true, positions: j.positions, error: null }; },
    ...over
  };
  return j;
}

function setup({ env = baseEnv(), jupiter = fakeJupiter(), capabilities, nowMs = T0 } = {}) {
  const store = fakeBlob();
  const clock = { t: nowMs };
  const journal = [];
  let seq = 0;
  const ex = createExecutor({
    env, jupiter, store, capabilities,
    wallet: { getAddress: async () => '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
    appendJournal: async (record) => { journal.push(record); return { duplicate: false }; },
    now: () => clock.t,
    randomBytes: (n) => { seq++; return Buffer.alloc(n, seq); }
  });
  return { ex, store, clock, journal, jupiter, env };
}

const intent = (over = {}) => ({ symbol: 'BTC', direction: 'long', sizeUsd: 200, leverage: 5, entry: 84600, stop: 84390, tp1: 85146, planId: 'plan_abc', candidateId: 'cand_1', recClass: 'GOOD', source: 'telegram', ...over });
const ctx = { userId: OWNER };
const auditRows = (store, day = '2026-09-25') => String(store.text(auditDayPath(day)) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------- isolation

/** Relative-import graph from `start`, returns every reachable repo file. */
function reachable(start) {
  const seen = new Set();
  const stack = [path.join(root, start)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      let p = path.resolve(path.dirname(f), m[1]);
      if (!existsSync(p) && existsSync(`${p}.js`)) p = `${p}.js`;
      stack.push(p);
    }
  }
  return [...seen].map((f) => path.relative(root, f));
}

async function run() {
  console.log('Isolation');
  for (const f of ['services/scalpContext.js', 'services/editTradesMcp.js', 'lib/mcpHttp.js', 'lib/flagRecommendation.js']) {
    await test(`${f} never reaches lib/execution, jupiterPerps or walletManager`, () => {
      const src = readFileSync(path.join(root, f), 'utf8');
      assert(!/lib\/execution|execution\/executor/.test(src), `${f} mentions lib/execution`);
      const bad = reachable(f).filter((r) => r.startsWith('lib/execution/') || r === 'services/jupiterPerps.js' || r === 'services/walletManager.js');
      eq(bad.length, 0, `${f} reaches ${bad.join(', ')}`);
    });
  }
  await test('lib/execution never imports jupiterPerps / walletManager at module scope', () => {
    for (const f of ['executor.js', 'gates.js', 'audit.js', 'tickets.js']) {
      const src = readFileSync(path.join(root, 'lib/execution', f), 'utf8');
      assert(!/^import[^;]*(jupiterPerps|walletManager)/m.test(src), `${f} statically imports a signing module`);
    }
  });

  console.log('Gates');
  await test('empty env refuses with every config reason; open-positions cap defaults to 2', () => {
    const c = readExecutionConfig({});
    for (const r of ['execution_disabled', 'pin_not_configured', 'owner_not_configured', 'cap_missing:EXECUTION_MAX_SIZE_USD', 'cap_missing:EXECUTION_MAX_LEVERAGE', 'cap_missing:EXECUTION_MAX_LOSS_USD_PER_TRADE', 'cap_missing:EXECUTION_MAX_DAILY_LOSS_USD']) has(c.reasons, r, 'reasons');
    eq(c.mode, 'dry', 'default mode');
    eq(c.caps.maxOpenPositions, 2, 'default open cap');
    assert(!JSON.stringify(readExecutionConfig(baseEnv())).includes(PIN), 'config never carries the PIN');
  });
  await test('mode must be dry|live; PIN must be 4-8 digits', () => {
    has(readExecutionConfig(baseEnv({ EXECUTION_MODE: 'yolo' })).reasons, 'mode_invalid', 'mode');
    has(readExecutionConfig(baseEnv({ EXECUTION_PIN: '12' })).reasons, 'pin_not_configured', 'short pin');
    has(readExecutionConfig(baseEnv({ EXECUTION_PIN: 'abcd' })).reasons, 'pin_not_configured', 'alpha pin');
    eq(readExecutionConfig(baseEnv()).reasons.length, 0, 'full env passes');
  });
  await test('pinMatches: constant-time equal only for the configured PIN', () => {
    assert(pinMatches(PIN, baseEnv()), 'right PIN');
    assert(!pinMatches('4822', baseEnv()), 'wrong PIN');
    assert(!pinMatches('', baseEnv()), 'empty');
    assert(!pinMatches(undefined, baseEnv()), 'undefined');
    assert(!pinMatches(PIN, baseEnv({ EXECUTION_PIN: '' })), 'unset PIN never matches');
  });
  for (const cap of ['EXECUTION_MAX_SIZE_USD', 'EXECUTION_MAX_LEVERAGE', 'EXECUTION_MAX_LOSS_USD_PER_TRADE', 'EXECUTION_MAX_DAILY_LOSS_USD']) {
    await test(`missing ${cap} refuses before any chain call`, async () => {
      const { ex, jupiter } = setup({ env: baseEnv({ [cap]: '' }) });
      const r = await ex.preflight(intent(), ctx);
      eq(r.ok, false, 'ok');
      has(r.reasons, `cap_missing:${cap}`, 'reason');
      eq(jupiter.calls.quote + jupiter.calls.positions + jupiter.calls.custody, 0, 'no chain calls');
    });
  }

  console.log('Preflight');
  await test('dry preflight passes with order, quote and a dry audit line', async () => {
    const { ex, store, jupiter } = setup();
    const r = await ex.preflight(intent(), ctx);
    eq(r.ok, true, `ok (${r.reasons})`);
    eq(r.order.action, 'open', 'action');
    eq(r.order.market, 'BTCUSDT', 'market');
    eq(r.order.mode, 'dry', 'mode');
    eq(r.order.maxLossUsd, 1.18, 'max loss = size x stop% + dir cost');
    eq(r.quote.marginRequiredUsd, 40, 'quote margin');
    eq(jupiter.calls.open.length, 0, 'no open');
    const a = auditRows(store);
    eq(a.length, 1, 'one audit line');
    eq(a[0].event, 'preflight', 'event');
    eq(a[0].mode, 'dry', 'mode');
  });
  await test('disabled / not owner refuse without touching chain', async () => {
    const d = setup({ env: baseEnv({ TRADE_EXECUTION_ENABLED: 'false' }) });
    has((await d.ex.preflight(intent(), ctx)).reasons, 'execution_disabled', 'disabled');
    eq(d.jupiter.calls.quote, 0, 'no quote');
    const o = setup();
    has((await o.ex.preflight(intent(), { userId: 1 })).reasons, 'not_owner', 'stranger');
    has((await o.ex.preflight(intent(), {})).reasons, 'not_owner', 'no user');
  });
  await test('kill switch: env, blob, lapsed blob, unreadable blob', async () => {
    has((await setup({ env: baseEnv({ EXECUTION_KILL: 'true' }) }).ex.preflight(intent(), ctx)).reasons, 'kill_switch', 'env kill');
    const s = setup();
    await s.ex.kill(ctx, 'test');
    has((await s.ex.preflight(intent(), ctx)).reasons, 'kill_switch', 'blob kill');
    s.store.files.set(KILL_PATH, { text: JSON.stringify({ killed: true, until: new Date(T0 - 1000).toISOString() }), etag: '"k"' });
    eq((await s.ex.preflight(intent(), ctx)).ok, true, 'lapsed auto-kill passes');
    const u = setup();
    u.store.failGet = true;
    has((await u.ex.preflight(intent(), ctx)).reasons, 'kill_state_unavailable', 'unreadable blob fails closed');
  });
  await test('SL/TP required and on the right side (long and short)', async () => {
    const { ex } = setup();
    has((await ex.preflight(intent({ stop: null }), ctx)).reasons, 'stop_required', 'no stop');
    has((await ex.preflight(intent({ tp1: undefined }), ctx)).reasons, 'tp_required', 'no tp');
    has((await ex.preflight(intent({ stop: 84700 }), ctx)).reasons, 'stop_wrong_side', 'long stop above');
    has((await ex.preflight(intent({ tp1: 84000 }), ctx)).reasons, 'tp_wrong_side', 'long tp below');
    has((await ex.preflight(intent({ direction: 'short' }), ctx)).reasons, 'stop_wrong_side', 'short stop below');
    eq((await ex.preflight(intent({ direction: 'short', stop: 84810, tp1: 84054 }), ctx)).ok, true, 'valid short');
  });
  await test('stop cap 3% unless the plan says otherwise; caps and liquidation buffer', () => {
    const caps = readExecutionConfig(baseEnv()).caps;
    has(checkIntent(intent({ stop: 82000, sizeUsd: 50, leverage: 2 }), caps).reasons, 'stop_too_wide', '3.07% stop');
    assert(!checkIntent(intent({ stop: 82000, sizeUsd: 50, leverage: 2, planMaxStopPct: 4 }), caps).reasons.includes('stop_too_wide'), 'plan cap 4%');
    has(checkIntent(intent({ stop: 82000, sizeUsd: 50, leverage: 2, planMaxStopPct: 4, planId: null }), caps).reasons, 'stop_too_wide', 'plan cap needs planId');
    has(checkIntent(intent({ sizeUsd: 600 }), caps).reasons, 'size_over_cap', 'size');
    has(checkIntent(intent({ leverage: 11 }), caps).reasons, 'leverage_over_cap', 'leverage');
    has(checkIntent(intent({ stop: 83000, sizeUsd: 500, leverage: 2 }), { ...caps, maxLossUsdPerTrade: 10 }).reasons, 'loss_over_cap', 'loss $11.16 > $10');
    has(checkIntent(intent({ stop: 82200, sizeUsd: 100, leverage: 40 }), { ...caps, maxLeverage: 100 }).reasons, 'liquidation_inside_stop', 'liq');
    eq(baseSymbol('btcusdt'), 'BTC', 'symbol normalize');
    has(checkIntent(intent({ symbol: 'DOGE' }), caps).reasons, 'symbol_unsupported', 'doge');
  });
  await test('open positions, positions read error, daily loss, custody, quote, market all fail closed', async () => {
    const a = setup();
    a.jupiter.positions = [{ positionId: 'p1' }, { positionId: 'p2' }];
    has((await a.ex.preflight(intent(), ctx)).reasons, 'max_open_positions', 'open cap');
    const b = setup({ jupiter: fakeJupiter({ getPerpPositions: async () => ({ ok: false, positions: [], error: 'rpc' }) }) });
    has((await b.ex.preflight(intent(), ctx)).reasons, 'positions_unavailable', 'positions');
    const c = setup();
    c.store.files.set('journal/2026-09-25.jsonl', { text: `${JSON.stringify({ id: 'j1', kind: 'close', resultUsd: -49.5 })}\n`, etag: '"j"' });
    has((await c.ex.preflight(intent(), ctx)).reasons, 'daily_loss_cap', 'daily loss');
    const d = setup({ jupiter: fakeJupiter({ checkCustodyCapacity: async () => { throw new Error(`down ${FAKE_RPC}`); } }) });
    has((await d.ex.preflight(intent(), ctx)).reasons, 'custody_unavailable', 'custody');
    const e = setup({ jupiter: fakeJupiter({ getPerpQuote: async () => { throw new Error('x'); } }) });
    has((await e.ex.preflight(intent(), ctx)).reasons, 'quote_unavailable', 'quote');
    const f = setup({ jupiter: fakeJupiter({ getPerpMarkets: async () => ({ SOLUSDT: {} }) }) });
    has((await f.ex.preflight(intent(), ctx)).reasons, 'market_unavailable', 'market');
  });
  await test('live mode refuses until on-chain SL/TP exists (capability gate)', async () => {
    has((await setup({ env: baseEnv({ EXECUTION_MODE: 'live' }) }).ex.preflight(intent(), ctx)).reasons, 'live_sl_tp_unsupported', 'live default');
    eq((await setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), capabilities: { openWithStops: true } }).ex.preflight(intent(), ctx)).ok, true, 'live with capability');
  });

  console.log('Tickets and confirm');
  await test('createTicket: 8-hex nonce, 60 s expiry, summary with mode banner', async () => {
    const { ex } = setup();
    const pf = await ex.preflight(intent(), ctx);
    const t = await ex.createTicket(pf.order, ctx);
    assert(/^[0-9a-f]{8}$/.test(t.nonce), `nonce ${t.nonce}`);
    eq(Date.parse(t.expiresAt) - T0, 60_000, 'ttl');
    assert(t.summaryText.includes('DRY RUN') && t.summaryText.includes(`/confirm ${t.nonce}`), 'summary');
    eq((await ex.createTicket({ action: 'withdraw' }, ctx)).ok, false, 'bad order refused');
  });
  await test('dry confirm: no signing call, dryRunId, audit mode dry, journal note source execution', async () => {
    const { ex, store, journal, jupiter } = setup();
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, true, `ok ${r.reasons}`);
    eq(r.mode, 'dry', 'mode');
    assert(/^dry_[0-9a-f]{16}$/.test(r.dryRunId), 'dryRunId');
    eq(jupiter.calls.open.length, 0, 'never opened');
    eq(journal.length, 1, 'journaled');
    eq(journal[0].kind, 'note', 'note, never open');
    eq(journal[0].source, 'execution', 'source');
    eq(journal[0].engineRef.planId, 'plan_abc', 'engineRef');
    assert(journal[0].text.startsWith('DRY order BTC long'), 'text');
    const fill = auditRows(store).find((l) => l.event === 'fill');
    eq(fill.mode, 'dry', 'audit mode');
    eq(fill.dryRunId, r.dryRunId, 'audit dryRunId');
  });
  await test('nonce is single use, expires after 60 s, bound to the user, validated', async () => {
    const { ex, clock } = setup();
    const order = (await ex.preflight(intent(), ctx)).order;
    const t = await ex.createTicket(order, ctx);
    eq((await ex.confirm(t.nonce, PIN, ctx)).ok, true, 'first');
    has((await ex.confirm(t.nonce, PIN, ctx)).reasons, 'nonce_used', 'second');
    const t2 = await ex.createTicket(order, ctx);
    clock.t += 61_000;
    has((await ex.confirm(t2.nonce, PIN, ctx)).reasons, 'nonce_expired', 'expired');
    const t3 = await ex.createTicket(order, ctx);
    has((await ex.confirm(t3.nonce, PIN, { userId: 999 })).reasons, 'not_owner', 'other user');
    has((await ex.confirm('zzzz', PIN, ctx)).reasons, 'nonce_invalid', 'invalid');
    has((await ex.confirm('0badc0de', PIN, ctx)).reasons, 'nonce_unknown', 'unknown');
  });
  await test('concurrent confirms on one nonce: exactly one consumes it (ETag-guarded)', async () => {
    const store = fakeBlob();
    const t = await storeTicket(store, { action: 'open' }, { nowMs: T0, userId: OWNER });
    const rs = await Promise.all([consumeTicket(store, t.nonce, { nowMs: T0, userId: OWNER }), consumeTicket(store, t.nonce, { nowMs: T0, userId: OWNER }), consumeTicket(store, t.nonce, { nowMs: T0, userId: OWNER })]);
    eq(rs.filter((r) => r.ok).length, 1, 'one winner');
    assert(rs.filter((r) => !r.ok).every((r) => r.reason === 'nonce_used' || r.reason === 'tickets_unavailable'), 'losers refused');
  });
  await test('wrong PIN keeps the ticket; 3 wrong PINs auto-kill for 1 h; kill lapses after', async () => {
    const { ex, store, clock } = setup();
    const order = (await ex.preflight(intent(), ctx)).order;
    const t = await ex.createTicket(order, ctx);
    has((await ex.confirm(t.nonce, '0000', ctx)).reasons, 'pin_wrong', 'wrong 1');
    eq((await ex.confirm(t.nonce, PIN, ctx)).ok, true, 'ticket survived, right PIN resets counter');
    for (let i = 0; i < 2; i++) {
      const tt = await ex.createTicket(order, ctx);
      has((await ex.confirm(tt.nonce, '1111', ctx)).reasons, 'pin_wrong', `wrong ${i + 1}`);
    }
    const t4 = await ex.createTicket(order, ctx);
    const third = await ex.confirm(t4.nonce, '2222', ctx);
    has(third.reasons, 'auto_killed', 'third wrong kills');
    const k = JSON.parse(store.text(KILL_PATH));
    eq(Date.parse(k.until) - T0, AUTO_KILL_MS, 'until = 1 h');
    has((await ex.preflight(intent(), ctx)).reasons, 'kill_switch', 'killed');
    has((await ex.confirm(t4.nonce, PIN, ctx)).reasons, 'kill_switch', 'confirm honors kill');
    clock.t += AUTO_KILL_MS + 1000;
    eq((await ex.preflight(intent(), ctx)).ok, true, 'lapsed');
    assert(!store.all().includes(PIN), 'PIN never stored');
  });
  await test('kill between ticket and confirm refuses and keeps the ticket unused', async () => {
    const { ex, store } = setup();
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    await ex.kill(ctx);
    has((await ex.confirm(t.nonce, PIN, ctx)).reasons, 'kill_switch', 'refused');
    eq(JSON.parse(store.text(TICKETS_PATH)).tickets[t.nonce].usedAt, null, 'unused');
  });
  await test('live confirm (capability on): openPerpPosition(market, dir, size, lev, stop, tp1), journal open', async () => {
    const { ex, journal, jupiter, store } = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), capabilities: { openWithStops: true } });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, true, `ok ${r.reasons}`);
    eq(r.mode, 'live', 'mode');
    eq(JSON.stringify(jupiter.calls.open[0]), JSON.stringify(['BTCUSDT', 'long', 200, 5, 84390, 85146]), 'open args');
    eq(journal[0].kind, 'open', 'journal open');
    eq(journal[0].source, 'execution', 'source');
    eq(journal[0].engineRef.candidateId, 'cand_1', 'engineRef');
    const fill = auditRows(store).find((l) => l.event === 'fill');
    eq(fill.txSignature, r.txSignature, 'txSignature kept in audit');
    eq(fill.mode, 'live', 'audit live');
  });
  await test('live open failure: no journal, error audited without RPC URL', async () => {
    const { ex, journal, store } = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), capabilities: { openWithStops: true }, jupiter: fakeJupiter({ openPerpPosition: async () => { throw new Error(`simulation failed at ${FAKE_RPC} key ${FAKE_KEY}`); } }) });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, false, 'failed');
    has(r.reasons, 'open_failed', 'reason');
    eq(journal.length, 0, 'no journal');
    const all = store.all();
    assert(!all.includes('fake-rpc-secret') && !all.includes(FAKE_KEY), 'no secrets in blob');
    assert(!String(r.error).includes('fake-rpc-secret'), 'no RPC URL in result');
  });

  console.log('Close and update');
  const openPos = { positionId: 'PosAAA', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84600, markPrice: 84800, liquidationPrice: 68000, unrealizedPnlUsd: 0.47 };
  await test('closePosition dry: PIN, kill, not found, partial size, journal note', async () => {
    const { ex, journal, jupiter } = setup();
    jupiter.positions = [openPos];
    has((await ex.closePosition('PosAAA', null, '9999', ctx)).reasons, 'pin_wrong', 'pin');
    has((await ex.closePosition('Nope', null, PIN, ctx)).reasons, 'position_not_found', 'missing');
    has((await ex.closePosition('PosAAA', 500, PIN, ctx)).reasons, 'size_over_position', 'too big');
    const r = await ex.closePosition('PosAAA', 100, PIN, ctx);
    eq(r.ok, true, `ok ${r.reasons}`);
    eq(jupiter.calls.close.length, 0, 'no chain close in dry');
    eq(journal.at(-1).kind, 'note', 'note');
    await ex.kill(ctx);
    has((await ex.closePosition('PosAAA', null, PIN, ctx)).reasons, 'kill_switch', 'kill honored');
  });
  await test('close / update via ticket + confirm', async () => {
    const { ex, jupiter } = setup();
    jupiter.positions = [openPos];
    const pc = await ex.prepareClose('PosAAA', null, ctx);
    eq(pc.ok, true, 'prepare');
    const tc = await ex.createTicket(pc.order, ctx);
    eq((await ex.confirm(tc.nonce, PIN, ctx)).ok, true, 'close confirmed');
    const pu = await ex.prepareUpdate('PosAAA', 84600, null, ctx);
    eq(pu.ok, true, `prepare update ${pu.reasons}`);
    const tu = await ex.createTicket(pu.order, ctx);
    eq((await ex.confirm(tu.nonce, PIN, ctx)).ok, true, 'update confirmed');
  });
  await test('live close / update refuse (unsupported) and never accept a placeholder signature', async () => {
    const live = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }) });
    live.jupiter.positions = [openPos];
    has((await live.ex.closePosition('PosAAA', null, PIN, ctx)).reasons, 'live_close_unsupported', 'close');
    has((await live.ex.updateStops('PosAAA', 84600, null, PIN, ctx)).reasons, 'live_update_unsupported', 'update');
    const forced = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), capabilities: { close: true, update: true } });
    forced.jupiter.positions = [openPos];
    has((await forced.ex.closePosition('PosAAA', null, PIN, ctx)).reasons, 'close_failed', 'placeholder close rejected');
    has((await forced.ex.updateStops('PosAAA', 84600, null, PIN, ctx)).reasons, 'update_failed', 'placeholder update rejected');
    eq(forced.journal.length, 0, 'nothing journaled');
  });
  await test('updateStops: side checks vs mark, liquidation, kill', async () => {
    const { ex, jupiter } = setup();
    jupiter.positions = [openPos];
    has((await ex.updateStops('PosAAA', 85000, null, PIN, ctx)).reasons, 'stop_wrong_side', 'stop above mark');
    has((await ex.updateStops('PosAAA', 67000, null, PIN, ctx)).reasons, 'stop_beyond_liquidation', 'below liq');
    has((await ex.updateStops('PosAAA', null, null, PIN, ctx)).reasons, 'stop_or_tp_required', 'nothing');
    eq((await ex.updateStops('PosAAA', 84600, 85500, PIN, ctx)).ok, true, 'BE + tp');
    const k = setup({ env: baseEnv({ EXECUTION_KILL: 'true' }) });
    k.jupiter.positions = [openPos];
    has((await k.ex.updateStops('PosAAA', 84600, null, PIN, ctx)).reasons, 'kill_switch', 'kill');
  });
  await test('kill / arm: owner only; arm needs PIN; env kill survives arm', async () => {
    const { ex } = setup({ env: baseEnv({ EXECUTION_KILL: 'true' }) });
    has((await ex.kill({ userId: 5 })).reasons, 'not_owner', 'stranger kill');
    eq((await ex.kill(ctx)).ok, true, 'owner kill');
    has((await ex.arm('0000', ctx)).reasons, 'pin_wrong', 'arm wrong pin');
    const a = await ex.arm(PIN, ctx);
    eq(a.ok, true, 'arm');
    eq(a.envKillStill, true, 'env kill still on');
    has((await ex.preflight(intent(), ctx)).reasons, 'kill_switch', 'still killed by env');
  });
  await test('status: mode, kill, caps, daily loss, open count, capabilities; no PIN', async () => {
    const { ex, jupiter } = setup();
    jupiter.positions = [openPos];
    const s = await ex.status();
    eq(s.mode, 'dry', 'mode');
    eq(s.kill.active, false, 'kill');
    eq(s.caps.maxOpenPositions, 2, 'caps');
    eq(s.dailyLossUsd, 0, 'loss');
    eq(s.openCount, 1, 'open');
    eq(s.liveCapabilities.openWithStops, false, 'caps flag');
    assert(!JSON.stringify(s).includes(PIN), 'no PIN');
  });

  console.log('Audit');
  await test('redact: key-like, URL, bearer, byte arrays and live secret values never survive', () => {
    const env = baseEnv();
    const input = {
      privateKey: FAKE_KEY, seed: 'x', rpcUrl: FAKE_RPC, note: `sent via ${FAKE_RPC}`, auth: 'Bearer abc.def', pinValue: PIN,
      echoed: PIN, blob: FAKE_KEY, nested: { arr: [FAKE_KEY, { token: FAKE_BOT }], bytes: Array.from({ length: 64 }, (_, i) => i) },
      botMsg: `token ${FAKE_BOT}`, hex: 'ab'.repeat(40), txSignature: '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn', price: 84600, stopPct: 0.25
    };
    const out = JSON.stringify(redact(input, env));
    for (const s of [FAKE_KEY, 'fake-rpc-secret', 'abc.def', FAKE_BOT, 'ab'.repeat(40)]) assert(!out.includes(s), `leaked ${s.slice(0, 12)}`);
    assert(!/"echoed":"4821"/.test(out), 'PIN value redacted');
    assert(out.includes('4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn'), 'txSignature kept');
    assert(out.includes('84600') && out.includes('0.25'), 'numbers kept');
  });
  await test('appendAudit never throws (store down, no store) and writes day file + manifest', async () => {
    const s = fakeBlob();
    s.failPut = true;
    const r = await appendAudit(s, 'x', { a: 1 }, { nowMs: T0, id: 'ex_1', env: baseEnv() });
    eq(r.ok, false, 'failed quietly');
    eq((await appendAudit(null, 'x', {}, { nowMs: T0, id: 'ex_2' })).skipped, 'no_store', 'no store');
    const ok = fakeBlob();
    eq((await appendAudit(ok, 'x', { a: 1 }, { nowMs: T0, id: 'ex_3', env: baseEnv() })).ok, true, 'ok');
    assert(ok.text('execution/manifest.json').includes('2026-09-25'), 'manifest day');
  });
  await test('full dry + wrong-PIN + error flow leaves no secret anywhere in Blob', async () => {
    const { ex, store } = setup({ jupiter: fakeJupiter({ getPerpQuote: async () => { throw new Error(`quote ${FAKE_RPC} ${FAKE_BOT}`); } }) });
    await ex.preflight(intent(), ctx);
    const s2 = setup();
    const t = await s2.ex.createTicket((await s2.ex.preflight(intent(), ctx)).order, ctx);
    await s2.ex.confirm(t.nonce, '0000', ctx);
    await s2.ex.confirm(t.nonce, PIN, ctx);
    for (const all of [store.all(), s2.store.all()]) {
      for (const sec of [FAKE_KEY, 'fake-rpc-secret', FAKE_BOT]) assert(!all.includes(sec), `leaked ${sec.slice(0, 10)}`);
      assert(!/"(pin|PIN)"\s*:\s*"4821"/.test(all), 'no PIN field');
    }
  });
  await test('journal accepts source execution; body cannot set it', () => {
    eq(validateJournalEntry({ text: 'x' }, { now: T0, newId: () => 'x_12345678', source: 'execution' }).record.source, 'execution', 'server source');
    eq(validateJournalEntry({ text: 'x', source: 'execution' }, { now: T0, newId: () => 'x_12345678' }).record.source, null, 'body ignored');
  });

  console.log('Positions read (services/jupiterPerps.js)');
  const W = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
  const C = DEFAULT_PERP_CUSTODIES;
  const encode = (o) => jupPerpsClient.getPositionEncoder().encode({
    owner: W, pool: POOL, custody: C.BTC, collateralCustody: C.USDC, openTime: 1790000000n, updateTime: 1790000100n, side: 1,
    price: 84_000_000_000n, sizeUsd: 200_000_000n, collateralUsd: 40_000_000n, realisedPnlUsd: 0n, cumulativeInterestSnapshot: 0n, lockedAmount: 0n, bump: 254, ...o
  });
  await test('PDA candidates: 3 markets x 2 sides x 3 collaterals, Side enum seeds (long=1, short=2)', async () => {
    const c = await derivePerpPositionCandidates(W, C);
    eq(c.length, 18, 'count');
    eq(new Set(c.map((x) => x.address)).size, 18, 'unique');
    eq(POSITION_SIDE_SEED.long, 1, 'long seed');
    const [manual] = PublicKey.findProgramAddressSync([
      Buffer.from('position'), new PublicKey(W).toBuffer(), new PublicKey(POOL).toBuffer(), new PublicKey(C.BTC).toBuffer(), new PublicKey(C.USDC).toBuffer(), Buffer.from([2])
    ], new PublicKey(jupPerpsClient.PERPETUALS_PROGRAM_ADDRESS));
    const hit = c.find((x) => x.symbol === 'BTC' && x.direction === 'short' && x.collateralCustody === C.USDC);
    eq(hit.address, manual.toBase58(), 'BTC short USDC matches manual derivation');
  });
  await test('decoder: fixture account built with the IDL encoder -> long row with estimate liq and PnL', () => {
    const row = decodePerpPositionAccount(encode({}), { positionId: 'P1', symbolByCustody: { [C.BTC]: 'BTC' }, markPrices: { BTC: 84840 } });
    eq(row.symbol, 'BTC', 'symbol');
    eq(row.market, 'BTCUSDT', 'market');
    eq(row.direction, 'long', 'direction');
    eq(row.sizeUsd, 200, 'size');
    eq(row.collateralUsd, 40, 'collateral');
    eq(row.leverage, 5, 'leverage');
    eq(row.entryPrice, 84000, 'entry');
    eq(row.liquidationPrice, 67452, 'liq = entry x (1 - (0.2 - 0.003))');
    eq(row.liquidationPriceSource, 'estimate', 'liq flagged');
    eq(row.unrealizedPnlUsd, 2, 'pnl');
    eq(row.openedAt, new Date(1790000000 * 1000).toISOString(), 'openedAt');
  });
  await test('decoder: short sign, closed account -> null, no mark -> null PnL', () => {
    const s = decodePerpPositionAccount(encode({ side: 2 }), { positionId: 'P2', symbolByCustody: { [C.BTC]: 'BTC' }, markPrices: { BTC: 84840 } });
    eq(s.direction, 'short', 'short');
    eq(s.unrealizedPnlUsd, -2, 'short pnl');
    eq(s.liquidationPrice, 100548, 'short liq');
    eq(decodePerpPositionAccount(encode({ sizeUsd: 0n }), { positionId: 'P3' }), null, 'closed');
    eq(decodePerpPositionAccount(encode({}), { positionId: 'P4' }).unrealizedPnlUsd, null, 'no mark');
  });
  await test('getPerpPositions: one batched getMultipleAccounts, decodes the hit, empty otherwise', async () => {
    const cands = await derivePerpPositionCandidates(W, C);
    const idx = cands.findIndex((x) => x.symbol === 'BTC' && x.direction === 'long' && x.collateralCustody === C.USDC);
    let calls = 0;
    let requested = null;
    const rpc = { getMultipleAccounts: (addrs) => ({ send: async () => { calls++; requested = addrs; return { value: addrs.map((_, i) => (i === idx ? { data: [Buffer.from(encode({})).toString('base64'), 'base64'] } : null)) }; } }) };
    const r = await getPerpPositions(W, { rpc, custodies: C, markPrices: { BTC: 84840 } });
    eq(calls, 1, 'one RPC call');
    eq(requested.length, 18, '18 addresses');
    eq(r.ok, true, 'ok');
    eq(r.positions.length, 1, 'one position');
    eq(r.positions[0].positionId, cands[idx].address, 'positionId = PDA');
    const empty = await getPerpPositions(W, { rpc: { getMultipleAccounts: () => ({ send: async () => ({ value: new Array(18).fill(null) }) }) }, custodies: C });
    eq(JSON.stringify(empty), JSON.stringify({ ok: true, positions: [], error: null }), 'empty');
  });
  await test('getPerpPositions never throws: RPC error -> {ok:false, positions:[], error} without URL', async () => {
    const r = await getPerpPositions(W, { rpc: { getMultipleAccounts: () => ({ send: async () => { throw new Error(`fetch failed ${FAKE_RPC}`); } }) }, custodies: C });
    eq(r.ok, false, 'ok false');
    eq(r.positions.length, 0, 'empty');
    assert(r.error && !r.error.includes('fake-rpc-secret'), 'no URL');
    const bad = await getPerpPositions('not-a-key', { rpc: {}, custodies: C });
    eq(bad.ok, false, 'bad address handled');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
