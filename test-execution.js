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
import { readExecutionConfig, pinMatches, KILL_PATH, AUTO_KILL_MS, autoKillUntil, recordWrongPin } from './lib/execution/gates.js';
import { readBlobFresh } from './lib/blobJsonl.js';
import { redact, appendAudit, auditDayPath, idHash } from './lib/execution/audit.js';
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

/**
 * T-3 F: closePerpPosition's fake mutates `j.positions` (shrinks or removes the matching
 * row) so a subsequent on-chain "verify" read in the SAME test sees the post-close state,
 * without the test itself needing to hand-simulate two different chain snapshots.
 */
function fakeJupiter(over = {}) {
  const calls = {
    open: [], close: [], update: [], quote: 0, custody: 0, markets: 0, positions: 0,
    buildOpen: [], waitForFill: [], buildStops: [], buildClose: [], cancel: []
  };
  const j = {
    calls,
    positions: [],
    getPerpMarkets: async () => { calls.markets++; return { BTCUSDT: {}, ETHUSDT: {}, SOLUSDT: {} }; },
    checkCustodyCapacity: async (market, size) => { calls.custody++; return { market, currentAssets: 1_000_000, headroomUsd: 500_000, requiredSize: size }; },
    getPerpQuote: async (market, direction, size, leverage) => { calls.quote++; return { market, direction, size, leverage, marginRequired: size / leverage, estimatedFees: size * 0.001, liquidationPrice: null }; },
    // legacy simple-signature wrappers: still the live close/update path (T-3 F only
    // rewired `open`; close/update land through the same sendSigned -> landTransaction).
    openPerpPosition: async (...args) => { calls.open.push(args); return { success: true, positionId: 'PosPda1111111111111111111111111111111111111', signature: '3xSig' + 'a'.repeat(80) }; },
    closePerpPosition: async (positionId, sizeUsd) => {
      calls.close.push([positionId, sizeUsd]);
      const idx = j.positions.findIndex((p) => p.positionId === positionId);
      if (idx !== -1) {
        if (sizeUsd && j.positions[idx].sizeUsd > sizeUsd) j.positions[idx] = { ...j.positions[idx], sizeUsd: j.positions[idx].sizeUsd - sizeUsd };
        else j.positions.splice(idx, 1);
      }
      return { success: true, signature: '3xCloseSig' + 'a'.repeat(76) };
    },
    updatePerpPosition: async (...args) => { calls.update.push(args); return { success: true, signature: '3xUpdateSig' + 'a'.repeat(75) }; },
    getPerpPositions: async () => { calls.positions++; return { ok: true, positions: j.positions, error: null }; },
    // T-3 F: two-phase live open (build/land/waitForFill/attach-stops), used by executeOpen.
    buildOpenPosition: async (o) => {
      calls.buildOpen.push(o);
      return {
        meta: { positionId: 'PosPda1111111111111111111111111111111111111', positionRequestId: 'ReqPda111111111111111111111111111111111111', triggers: {} },
        simulate: async () => ({ err: null }),
        send: async () => ({ signature: '3xOpenSig' + 'a'.repeat(76), simulated: false }),
      };
    },
    waitForFill: async (reqPda, posPda) => {
      calls.waitForFill.push([reqPda, posPda]);
      return { filled: true, position: { positionId: posPda, sizeUsd: 200, entryPrice: 84612, direction: 'long', symbol: 'BTC' } };
    },
    buildUpdateStops: async (o) => {
      calls.buildStops.push(o);
      return {
        meta: { triggers: { stopLoss: { positionRequestId: 'SlReq11111111111111111111111111111111111111' }, takeProfit: { positionRequestId: 'TpReq11111111111111111111111111111111111111' } } },
        simulate: async () => ({ err: null }),
        send: async () => ({ signature: '3xStopsSig' + 'a'.repeat(75), simulated: false }),
      };
    },
    buildClosePosition: async (o) => {
      calls.buildClose.push(o);
      return { meta: { positionId: o.positionId }, simulate: async () => ({ err: null }), send: async () => ({ signature: '3xEmergencySig' + 'a'.repeat(71), simulated: false }) };
    },
    buildCancelIncreaseRequest: async (o) => {
      calls.cancel.push(o);
      return { simulate: async () => ({ err: null }), send: async () => ({ signature: '3xCancelSig' + 'a'.repeat(74), simulated: false }) };
    },
    fetchAccountsExist: async (addrs) => addrs.map(() => true),
    createKitSigner: () => ({ fakeSigner: true }),
    ...over
  };
  return j;
}

/** Engine build fake: symbols.X.mark / price, mutable per test; counts builds. */
function fakeMarket() {
  const m = {
    builds: 0,
    symbols: {
      BTC: { mark: { status: 'ok', price: 84600, driftBps: 1 }, price: 84610 },
      ETH: { mark: { status: 'ok', price: 3000 }, price: 3001 },
      SOL: { mark: { status: 'ok', price: 150 }, price: 150.1 }
    }
  };
  m.build = async () => { m.builds++; if (m.fail) throw new Error('build down'); return { symbols: m.symbols }; };
  return m;
}

function setup({ env = baseEnv(), jupiter = fakeJupiter(), capabilities, nowMs = T0, market = fakeMarket(), onAlert } = {}) {
  const store = fakeBlob();
  const clock = { t: nowMs };
  const journal = [];
  const alerts = [];
  let seq = 0;
  const ex = createExecutor({
    env, jupiter, store, capabilities, buildContext: market.build,
    wallet: { getAddress: async () => '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
    signer: { fakeSigner: true }, // T-3 F: skip walletManager/createKitSigner in tests
    sleep: async (ms) => { clock.t += ms; }, // T-3 F: instant retry loops, still advances now()
    onAlert: onAlert || (async (text, meta) => { alerts.push({ text, meta }); }),
    appendJournal: async (record) => { journal.push(record); return { duplicate: false }; },
    now: () => clock.t,
    randomBytes: (n) => { seq++; return Buffer.alloc(n, seq); }
  });
  return { ex, store, clock, journal, jupiter, env, market, alerts };
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
  await test('stop cap 3% is absolute (planMaxStopPct ignored); caps and liquidation buffer', () => {
    const caps = readExecutionConfig(baseEnv()).caps;
    has(checkIntent(intent({ stop: 82000, sizeUsd: 50, leverage: 2 }), caps).reasons, 'stop_too_wide', '3.07% stop');
    has(checkIntent(intent({ stop: 82000, sizeUsd: 50, leverage: 2, planMaxStopPct: 4 }), caps).reasons, 'stop_too_wide', 'a plan cannot widen the 3% cap');
    eq(checkIntent(intent(), caps).derived.stopCapPct, 3, 'cap 3');
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
  await test('live mode: openWithStops is on by default (T-3 F); the gate still exists and can be forced off', async () => {
    eq((await setup({ env: baseEnv({ EXECUTION_MODE: 'live' }) }).ex.preflight(intent(), ctx)).ok, true, 'live default now passes (LIVE_CAPABILITIES.openWithStops = true)');
    has((await setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), capabilities: { openWithStops: false } }).ex.preflight(intent(), ctx)).reasons, 'live_sl_tp_unsupported', 'forcing the capability off still refuses');
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
  const filledPos = { positionId: 'PosPda1111111111111111111111111111111111111', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84612 };
  await test('T-3 F live open happy path: two-phase (build no-stops -> land -> waitForFill -> attach stops -> verify), all four phase audits, journal only after verified', async () => {
    const { ex, journal, jupiter, store } = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }) });
    jupiter.positions = [filledPos]; // chain state once the keeper has filled + stops landed
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, true, `ok ${r.reasons}`);
    eq(r.mode, 'live', 'mode');
    eq(jupiter.calls.open.length, 0, 'the legacy single-shot openPerpPosition is never called');
    eq(jupiter.calls.buildOpen[0].stopLoss, null, 'the increase is built WITHOUT stops');
    eq(jupiter.calls.buildOpen[0].takeProfit, null, 'the increase is built WITHOUT stops');
    eq(jupiter.calls.waitForFill.length, 1, 'waitForFill polled once (mocked to resolve immediately)');
    eq(jupiter.calls.buildStops[0].stop, 84390, 'stops built from the order SL');
    eq(jupiter.calls.buildStops[0].tp, 85146, 'stops built from the order TP1');
    eq(r.fillPrice, 84612, 'fill price comes from waitForFill\'s on-chain read, not the pre-fill estimate');
    eq(journal[0].kind, 'open', 'journal open');
    eq(journal[0].source, 'execution', 'source');
    eq(journal[0].entry, 84612, 'journaled entry = venue fill');
    eq(journal[0].engineRef.candidateId, 'cand_1', 'engineRef');
    const phases = auditRows(store).filter((l) => l.event === 'phase').map((l) => l.phase);
    eq(JSON.stringify(phases), JSON.stringify(['submitted', 'landed', 'filled', 'stops_attached', 'verified']), 'every phase audited in order');
    const fill = auditRows(store).find((l) => l.event === 'fill');
    eq(fill.txSignatureHash, idHash(r.txSignature), 'tx signature hashed in audit');
    eq(fill.positionIdHash, idHash(r.position.positionId), 'position id hashed in audit');
    assert(!('txSignature' in fill) && !('positionId' in fill), 'no raw ids in audit');
    assert(!store.all().includes(r.txSignature) && !store.all().includes(r.position.positionId), 'no full tx / position id anywhere in Blob');
    eq(fill.mode, 'live', 'audit live');
  });
  await test('T-3 F live open: simulation failure before any land, no journal, error audited without RPC URL', async () => {
    const { ex, journal, store } = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({ buildOpenPosition: async () => ({ meta: {}, simulate: async () => ({ err: `boom at ${FAKE_RPC} key ${FAKE_KEY}` }), send: async () => { throw new Error('must not be reached'); } }) })
    });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, false, 'failed');
    has(r.reasons, 'open_failed', 'reason');
    eq(journal.length, 0, 'no journal');
    const all = store.all();
    assert(!all.includes('fake-rpc-secret') && !all.includes(FAKE_KEY), 'no secrets in blob');
    assert(!String(r.error).includes('fake-rpc-secret'), 'no RPC URL in result');
  });
  await test('T-3 F live open: waitForFill timeout cancels the unfilled increase request, nothing journaled', async () => {
    const { ex, journal, jupiter, store } = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({ waitForFill: async () => ({ filled: false, reason: 'timeout' }) })
    });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, false, 'not ok');
    has(r.reasons, 'fill_failed', 'reason');
    has(r.reasons, 'timeout', 'timeout reason surfaced');
    eq(r.cancelled, true, 'the unfilled increase request was cancelled');
    eq(jupiter.calls.cancel.length, 1, 'buildCancelIncreaseRequest called on timeout');
    eq(journal.length, 0, 'never opened, never journaled');
    const phase = auditRows(store).find((l) => l.event === 'phase' && l.phase === 'fill_failed');
    eq(phase.reason, 'timeout', 'fill_failed phase audited with the reason');
  });
  await test('T-3 F live open: waitForFill rejected does not attempt a cancel (nothing to cancel)', async () => {
    const { ex, jupiter } = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({ waitForFill: async () => ({ filled: false, reason: 'rejected' }) })
    });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    has(r.reasons, 'rejected', 'rejected surfaced');
    eq(jupiter.calls.cancel.length, 0, 'no cancel attempted for an already-rejected request');
  });
  await test('T-3 F live open: stops-attach failure triggers an emergency close; open never counts as ok', async () => {
    const { ex, journal, jupiter, store } = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({ buildUpdateStops: async () => { throw new Error('stops build failed'); } })
    });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, false, 'never ok');
    has(r.reasons, 'stops_failed', 'stops failed');
    has(r.reasons, 'emergency_closed', 'emergency close ran');
    eq(r.emergencyClose.ok, true, 'emergency close succeeded');
    eq(jupiter.calls.buildClose.length, 1, 'one emergency close built');
    eq(journal.length, 0, 'never journaled as open');
    const emergency = auditRows(store).find((l) => l.event === 'emergency_close' && l.ok === true);
    assert(emergency, 'emergency_close audited');
  });
  await test('T-3 F live open: emergency close itself failing engages the kill switch, alerts, retries every 5s up to EMERGENCY_CLOSE_MAX_MS', async () => {
    const { ex, jupiter, store, clock, alerts } = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({
        buildUpdateStops: async () => { throw new Error('stops build failed'); },
        buildClosePosition: async () => ({ meta: {}, simulate: async () => ({ err: null }), send: async () => { throw new Error('close send failed'); } }),
      })
    });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, false, 'not ok');
    has(r.reasons, 'emergency_close_failed', 'emergency close failed');
    has(r.reasons, 'kill_engaged', 'kill engaged');
    assert(r.emergencyClose.attempts > 1, `retried more than once (attempts=${r.emergencyClose.attempts})`);
    eq(clock.t - T0, 45_000, 'retried for exactly EMERGENCY_CLOSE_MAX_MS (fake sleep advances the clock)');
    const kill = JSON.parse(store.text(KILL_PATH));
    eq(kill.reason, 'emergency_close_failed', 'kill switch engaged with the emergency-close reason');
    assert(alerts.length >= 2, `at least a kill-engaged alert and a final-failure alert (got ${alerts.length})`);
  });
  await test('T-3 F exactly-once: a prior terminal actionId result is replayed verbatim, nothing rebuilt or resent', async () => {
    const { ex, store, jupiter } = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }) });
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const priorResult = { ok: true, mode: 'live', txSignature: 'PreviouslyLandedSig', position: { positionId: 'PosPda1111111111111111111111111111111111111' }, fillPrice: 84600, journal: 'x_previous', reasons: [] };
    // Simulate a crash-recovery scenario: this actionId already reached a terminal state
    // (e.g. the process crashed after recording it but before the caller saw the result).
    store.files.set('execution/actions.json', { text: `${JSON.stringify({ schemaVersion: 'execution-actions-1', actions: { [`open_${t.nonce}`]: priorResult } })}\n`, etag: '"a1"' });
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(JSON.stringify(r), JSON.stringify(priorResult), 'the recorded terminal result is returned verbatim');
    eq(jupiter.calls.buildOpen.length, 0, 'nothing was rebuilt');
    eq(jupiter.calls.waitForFill.length, 0, 'nothing was resent/awaited again');
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
  await test('live close / update: capability off refuses; a placeholder signature is still rejected (capability on by default, T-3 F)', async () => {
    const live = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), capabilities: { close: false, update: false } });
    live.jupiter.positions = [openPos];
    has((await live.ex.closePosition('PosAAA', null, PIN, ctx)).reasons, 'live_close_unsupported', 'close');
    has((await live.ex.updateStops('PosAAA', 84600, null, PIN, ctx)).reasons, 'live_update_unsupported', 'update');
    const forced = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({
        closePerpPosition: async () => ({ success: true, signature: 'placeholder_signature' }),
        updatePerpPosition: async () => ({ success: true, signature: 'placeholder_signature' }),
      })
    });
    forced.jupiter.positions = [openPos];
    has((await forced.ex.closePosition('PosAAA', null, PIN, ctx)).reasons, 'close_failed', 'placeholder close rejected');
    has((await forced.ex.updateStops('PosAAA', 84600, null, PIN, ctx)).reasons, 'update_failed', 'placeholder update rejected');
    eq(forced.journal.length, 0, 'nothing journaled');
  });
  await test('T-3 F live close / update: verify after send -- a close/update that lands but does not reflect on chain is rejected before journaling', async () => {
    const noVerifyClose = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      // closePerpPosition returns a real signature but (unlike the default fake) does NOT
      // remove/shrink the position -- simulating a send that landed without taking effect.
      jupiter: fakeJupiter({ closePerpPosition: async () => ({ success: true, signature: '3xRealButNoEffect' + 'a'.repeat(63) }) })
    });
    noVerifyClose.jupiter.positions = [openPos];
    const c = await noVerifyClose.ex.closePosition('PosAAA', null, PIN, ctx);
    has(c.reasons, 'close_failed', 'close rejected when it does not verify on chain');
    eq(noVerifyClose.journal.length, 0, 'nothing journaled');

    const updateJupiter = fakeJupiter();
    updateJupiter.updatePerpPosition = async (positionId) => {
      const idx = updateJupiter.positions.findIndex((p) => p.positionId === positionId);
      if (idx !== -1) updateJupiter.positions.splice(idx, 1); // simulates the update accidentally closing the position
      return { success: true, signature: '3xRealButNoEffect' + 'a'.repeat(63) };
    };
    const noVerifyUpdate = setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), jupiter: updateJupiter });
    noVerifyUpdate.jupiter.positions = [openPos];
    const u = await noVerifyUpdate.ex.updateStops('PosAAA', 84600, null, PIN, ctx);
    has(u.reasons, 'update_failed', 'update rejected when the position no longer verifies on chain');
    eq(noVerifyUpdate.journal.length, 0, 'nothing journaled');
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
  await test('T-3 F listPositions: attaches stop/tp from the most recent execution open/adjust journal record (F4 "/positions" stops line)', async () => {
    const { ex, jupiter, store } = setup();
    jupiter.positions = [{ ...openPos, positionId: 'PosBBB' }];
    const before = await ex.listPositions();
    eq(before.positions[0].stop, undefined, 'no journal record yet -> no stop attached');
    const openRow = { id: 'x_open1', kind: 'open', source: 'execution', stop: 84200, tp1: 85000, execRef: { positionIdHash: idHash('PosBBB') } };
    store.files.set('journal/2026-09-25.jsonl', { text: `${JSON.stringify(openRow)}\n`, etag: '"j1"' });
    const after = await ex.listPositions();
    eq(after.positions[0].stop, 84200, 'stop from the open record');
    eq(after.positions[0].tp, 85000, 'tp from the open record (tp1 field)');
    // A later adjust supersedes the open record.
    const adjustRow = { id: 'x_adj1', kind: 'adjust', source: 'execution', stop: 84600, tp1: 86000, execRef: { positionIdHash: idHash('PosBBB') } };
    store.files.set('journal/2026-09-25.jsonl', { text: `${JSON.stringify(openRow)}\n${JSON.stringify(adjustRow)}\n`, etag: '"j2"' });
    const latest = await ex.listPositions();
    eq(latest.positions[0].stop, 84600, 'the later adjust wins');
    eq(latest.positions[0].tp, 86000, 'the later adjust tp wins');
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
    eq(s.liveCapabilities.openWithStops, true, 'caps flag (T-3 F: on by default)');
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

  console.log('Review fixes 2026-09-25');
  await test('F1 arm refuses during a wrong-PIN auto-kill without evaluating the PIN; counter not reset', async () => {
    const { ex, store, jupiter } = setup();
    jupiter.positions = [{ positionId: 'PosAAA', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84600, markPrice: 84800, liquidationPrice: 68000 }];
    for (let i = 0; i < 3; i++) await ex.closePosition('PosAAA', null, '1111', ctx);
    const k = JSON.parse(store.text(KILL_PATH));
    eq(k.reason, 'wrong_pin_x3', 'auto-kill');
    eq(k.wrongPin.count, 3, 'counter kept after the kill');
    const before = store.text(KILL_PATH);
    const a = await ex.arm(PIN, ctx);
    eq(a.ok, false, 'right PIN refused');
    has(a.reasons, 'auto_kill_active', 'reason');
    has((await ex.arm('0000', ctx)).reasons, 'auto_kill_active', 'wrong PIN not evaluated either');
    eq(store.text(KILL_PATH), before, 'no counter write, no clear');
  });
  await test('F1 each further 3 wrong PINs extend the auto-kill by 1 h; a manual kill is never downgraded', async () => {
    eq(autoKillUntil(2, null, T0), null, '2 -> none');
    eq(autoKillUntil(3, null, T0), T0 + AUTO_KILL_MS, '3 -> 1 h');
    eq(autoKillUntil(6, T0 + AUTO_KILL_MS, T0), T0 + 2 * AUTO_KILL_MS, '6 -> extends');
    const store = fakeBlob();
    store.files.set(KILL_PATH, { text: JSON.stringify({ killed: true, reason: 'wrong_pin_x3', until: new Date(T0 + AUTO_KILL_MS).toISOString(), wrongPin: { count: 5, since: new Date(T0).toISOString() } }), etag: '"k"' });
    const w = await recordWrongPin(store, T0 + 1000);
    eq(w.count, 6, 'count 6');
    eq(Date.parse(JSON.parse(store.text(KILL_PATH)).until), T0 + 2 * AUTO_KILL_MS, 'extended by 1 h');
    const m = fakeBlob();
    m.files.set(KILL_PATH, { text: JSON.stringify({ killed: true, reason: 'telegram', until: null, wrongPin: { count: 2, since: new Date(T0).toISOString() } }), etag: '"m"' });
    await recordWrongPin(m, T0 + 1000);
    const mk = JSON.parse(m.text(KILL_PATH));
    eq(mk.reason, 'telegram', 'manual kill kept');
    eq(mk.until, null, 'manual kill does not lapse');
  });
  await test('F1 wrong PIN counts in memory when the Blob write fails; 3rd kills this instance', async () => {
    const { ex, store, jupiter } = setup();
    jupiter.positions = [{ positionId: 'PosAAA', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84600, markPrice: 84800, liquidationPrice: 68000 }];
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let last;
    try {
      store.failPut = true;
      for (let i = 0; i < 3; i++) last = await ex.closePosition('PosAAA', null, '1111', ctx);
    } finally { console.warn = orig; }
    has(last.reasons, 'auto_killed', 'third wrong kills');
    assert(warns.some((w) => w.includes('reason=pin_count_write_failed')), 'logged');
    store.failPut = false;
    has((await ex.preflight(intent(), ctx)).reasons, 'kill_switch', 'in-memory kill honored');
    has((await ex.arm(PIN, ctx)).reasons, 'auto_kill_active', 'arm refused during in-memory kill');
  });
  await test('F2 fill = live mark; drift over 15 bps refuses; env override; Kraken close when mark not ok', async () => {
    const s = setup();
    const ok = await s.ex.preflight(intent(), ctx);
    eq(ok.ok, true, `ok ${ok.reasons}`);
    eq(ok.order.expectedFill, 84600, 'fill = mark');
    eq(ok.order.fillSource, 'mark', 'source mark');
    s.market.symbols.BTC.mark.price = 84750; // 17.7 bps
    has((await s.ex.preflight(intent(), ctx)).reasons, 'fill_drift', 'drift refused');
    const wide = setup({ env: baseEnv({ EXECUTION_MAX_ENTRY_DRIFT_BPS: '25' }) });
    wide.market.symbols.BTC.mark.price = 84750;
    eq((await wide.ex.preflight(intent(), ctx)).ok, true, 'env 25 bps allows');
    const k = setup();
    k.market.symbols.BTC.mark = { status: 'stale', price: 90000 };
    k.market.symbols.BTC.price = 84605;
    const r = await k.ex.preflight(intent(), ctx);
    eq(r.order.fillSource, 'kraken_close', 'stale mark -> Kraken close');
    eq(r.order.expectedFill, 84605, 'close price');
    const f = setup();
    f.market.fail = true;
    has((await f.ex.preflight(intent(), ctx)).reasons, 'fill_unavailable', 'no fill refuses');
  });
  await test('F2 ctx.mark is used without a build; stop side / 3% cap / max loss re-checked at the fill', async () => {
    const s = setup();
    const r = await s.ex.preflight(intent(), { ...ctx, mark: { symbol: 'BTC', status: 'ok', price: 84605, close: 84610 } });
    eq(r.ok, true, `ok ${r.reasons}`);
    eq(s.market.builds, 0, 'no engine build');
    eq(r.order.expectedFill, 84605, 'ctx mark');
    const b = setup({ env: baseEnv({ EXECUTION_MAX_ENTRY_DRIFT_BPS: '1000' }) });
    b.market.symbols.BTC.mark.price = 84380; // below the long stop 84390
    has((await b.ex.preflight(intent(), ctx)).reasons, 'stop_wrong_side_at_fill', 'stop side at fill');
    b.market.symbols.BTC.mark.price = 87100; // stop 84390 is 3.1% away
    has((await b.ex.preflight(intent(), ctx)).reasons, 'stop_too_wide_at_fill', 'stop cap at fill');
    const l = setup({ env: baseEnv({ EXECUTION_MAX_ENTRY_DRIFT_BPS: '1000', EXECUTION_MAX_LOSS_USD_PER_TRADE: '5' }) });
    eq(checkIntent(intent({ sizeUsd: 500, leverage: 2 }), readExecutionConfig(l.env).caps).reasons.length, 0, 'passes at plan entry ($2.94)');
    l.market.symbols.BTC.mark.price = 85100; // loss at fill ~$5.87 > $5
    const lr = await l.ex.preflight(intent({ sizeUsd: 500, leverage: 2 }), ctx);
    has(lr.reasons, 'loss_over_cap_at_fill', 'max loss at fill');
    assert(lr.order.maxLossUsd > 5, 'order carries the worse (fill) max loss');
  });
  await test('F2 confirm re-prices: mark moves after the ticket -> fill_drift, nothing sent', async () => {
    const { ex, market, journal } = setup();
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    market.symbols.BTC.mark.price = 84800;
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, false, 'refused');
    has(r.reasons, 'fill_drift', 'drift at confirm');
    eq(journal.length, 0, 'nothing journaled');
  });
  await test('F3 kill read: head ETag mismatch -> fresh body; unresolved mismatch or head error -> killed', async () => {
    const s = setup();
    s.store.files.set(KILL_PATH, { text: JSON.stringify({ killed: false }), etag: '"old"' });
    s.store.head = async () => ({ etag: '"new"', url: `${BASE}/${KILL_PATH}` });
    s.store.fetchImpl = async () => new Response(JSON.stringify({ killed: true, reason: 'telegram' }));
    has((await s.ex.preflight(intent(), ctx)).reasons, 'kill_switch', 'fresh body says killed');
    s.store.fetchImpl = async () => { throw new Error('cdn down'); };
    has((await s.ex.preflight(intent(), ctx)).reasons, 'kill_state_unavailable', 'unresolved mismatch fails closed');
    s.store.head = async () => { throw new Error('head down'); };
    has((await s.ex.preflight(intent(), ctx)).reasons, 'kill_state_unavailable', 'head error fails closed');
    s.store.head = async () => ({ etag: '"old"', url: `${BASE}/${KILL_PATH}` });
    eq((await s.ex.preflight(intent(), ctx)).ok, true, 'matching etag reads get body');
    const n = setup();
    n.store.head = async () => { const e = new Error('nf'); e.name = 'BlobNotFoundError'; throw e; };
    eq((await n.ex.preflight(intent(), ctx)).ok, true, 'missing blob on get and head = not killed');
    eq(await readBlobFresh({ get: n.store.get, head: n.store.head }, 'nope.json'), null, 'readBlobFresh null');
    // Live @vercel/blob head() throws a plain Error for a missing blob (2026-09-25: every order refused).
    n.store.head = async () => { throw new Error('Vercel Blob: The requested blob does not exist'); };
    eq((await n.ex.preflight(intent(), ctx)).ok, true, 'plain not-found Error from head = not killed');
    eq(await readBlobFresh({ get: n.store.get, head: n.store.head }, 'nope.json'), null, 'readBlobFresh null on plain not-found Error');
    n.store.head = async () => { throw new Error('Vercel Blob: something else broke'); };
    has((await n.ex.preflight(intent(), ctx)).reasons, 'kill_state_unavailable', 'any other head error still fails closed');
  });
  await test('F4 custody headroom: over headroom refuses; no numbers -> live custody_unknown, dry warns', async () => {
    const a = setup({ jupiter: fakeJupiter({ checkCustodyCapacity: async () => ({ currentAssets: 10, headroomUsd: 100 }) }) });
    has((await a.ex.preflight(intent(), ctx)).reasons, 'custody_capacity', '$200 > $100 headroom');
    const noNums = () => fakeJupiter({ checkCustodyCapacity: async () => ({ market: 'BTCUSDT', currentAssets: 5_000_000, note: 'limit enforced by protocol' }) });
    const d = await setup({ jupiter: noNums() }).ex.preflight(intent(), ctx);
    eq(d.ok, true, `dry allowed ${d.reasons}`);
    has(d.reasons, 'warn:custody_unknown', 'dry warns');
    const l = await setup({ env: baseEnv({ EXECUTION_MODE: 'live' }), capabilities: { openWithStops: true }, jupiter: noNums() }).ex.preflight(intent(), ctx);
    eq(l.ok, false, 'live refused');
    has(l.reasons, 'custody_unknown', 'live reason');
    const m = await setup({ jupiter: fakeJupiter({ checkCustodyCapacity: async () => ({ currentAssets: 900, maxAssets: 1000 }) }) }).ex.preflight(intent(), ctx);
    has(m.reasons, 'custody_capacity', 'max - current = $100 < $200');
  });
  await test('F6 tickets store an owner hash and a position id hash, never the ids', async () => {
    const { ex, store, jupiter } = setup();
    jupiter.positions = [{ positionId: 'PosAAA', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84600, markPrice: 84800, liquidationPrice: 68000 }];
    await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const pc = await ex.prepareClose('PosAAA', null, ctx);
    const tc = await ex.createTicket(pc.order, ctx);
    const text = store.text(TICKETS_PATH);
    assert(!text.includes(String(OWNER)), 'no Telegram user id');
    assert(!text.includes('PosAAA'), 'no position id');
    const doc = JSON.parse(text);
    eq(doc.tickets[tc.nonce].ownerHash, idHash(String(OWNER)), 'owner hash');
    eq(doc.tickets[tc.nonce].order.positionIdHash, idHash('PosAAA'), 'position hash');
    eq((await ex.confirm(tc.nonce, PIN, ctx)).ok, true, 'close resolves the hash against the chain read');
    assert(!store.all().includes('PosAAA') && !store.all().includes(String(OWNER)), 'no raw ids anywhere in Blob');
  });
  await test('F7 journal linkage: live open carries positionIdHash, fill, recClass, nonce, actionId; close links the open', async () => {
    const { ex, journal, jupiter, store } = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({
        buildOpenPosition: async () => ({ meta: { positionId: 'PosLive1', positionRequestId: 'ReqLive1', triggers: {} }, simulate: async () => ({ err: null }), send: async () => ({ signature: `5Real${'b'.repeat(80)}`, simulated: false }) }),
        waitForFill: async () => ({ filled: true, position: { positionId: 'PosLive1', sizeUsd: 200, entryPrice: 84612 } }),
      })
    });
    jupiter.positions = [{ positionId: 'PosLive1', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84612 }];
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, true, `open ${r.reasons}`);
    const open = journal[0];
    eq(open.entry, 84612, 'entry = venue fill');
    eq(open.engineRef.recClass, 'GOOD', 'recClass');
    eq(open.execRef.positionIdHash, idHash('PosLive1'), 'position hash');
    eq(open.execRef.ticketNonce, t.nonce, 'ticket nonce');
    eq(open.execRef.fillSource, 'venue', 'fill source');
    assert(open.execRef.actionId === `open_${t.nonce}`, `actionId recorded (got ${open.execRef.actionId})`);
    store.files.set('journal/2026-09-25.jsonl', { text: `${JSON.stringify(open)}\n`, etag: '"j1"' });
    jupiter.positions = [{ positionId: 'PosLive1', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84612, markPrice: 84700, liquidationPrice: 68000, unrealizedPnlUsd: 0.2 }];
    const c = await ex.closePosition('PosLive1', null, PIN, ctx);
    eq(c.ok, true, `close ${c.reasons}`);
    const close = journal.at(-1);
    eq(close.kind, 'close', 'close');
    eq(close.execRef.openJournalId, open.id, 'links the open');
    eq(close.execRef.positionIdHash, idHash('PosLive1'), 'position hash');
  });
  await test('T-3 F journal entry always uses the on-chain fill from waitForFill, never the pre-fill mark estimate', async () => {
    const { ex, journal, jupiter } = setup({
      env: baseEnv({ EXECUTION_MODE: 'live' }),
      jupiter: fakeJupiter({ waitForFill: async (reqPda, posPda) => ({ filled: true, position: { positionId: posPda, sizeUsd: 200, entryPrice: 84811 } }) }) // differs from the pre-fill mark (84600)
    });
    jupiter.positions = [{ positionId: 'PosPda1111111111111111111111111111111111111', symbol: 'BTC', direction: 'long', sizeUsd: 200, entryPrice: 84811 }];
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    const r = await ex.confirm(t.nonce, PIN, ctx);
    eq(r.ok, true, `ok ${r.reasons}`);
    eq(journal[0].entry, 84811, 'entry = the actual on-chain fill, not the 84600 pre-fill mark');
    eq(journal[0].execRef.fillSource, 'venue', 'fill source is always venue for a two-phase open');
  });
  await test('F7 execRef only for source execution (GPT / Telegram records unchanged)', () => {
    const body = { text: 'x', execRef: { ticketNonce: 'abcd1234' } };
    const gpt = validateJournalEntry(body, { now: T0, newId: () => 'x_12345678' }).record;
    assert(!('execRef' in gpt), 'GPT path ignores execRef');
    eq(validateJournalEntry(body, { now: T0, newId: () => 'x_12345678', source: 'execution' }).record.execRef.ticketNonce, 'abcd1234', 'execution keeps it');
    eq(validateJournalEntry({ text: 'x', execRef: { ticketNonce: 'bad nonce!' } }, { now: T0, newId: () => 'x_12345678', source: 'execution' }).ok, false, 'validated');
  });
  await test('F8 cancelTicket consumes the ticket without acting; owner only; audited', async () => {
    const { ex, store, journal } = setup();
    const t = await ex.createTicket((await ex.preflight(intent(), ctx)).order, ctx);
    has((await ex.cancelTicket(t.nonce, { userId: 5 })).reasons, 'not_owner', 'stranger');
    eq((await ex.cancelTicket(t.nonce, ctx)).ok, true, 'cancelled');
    has((await ex.confirm(t.nonce, PIN, ctx)).reasons, 'nonce_used', 'confirm after cancel refused');
    eq(journal.length, 0, 'nothing journaled');
    eq(auditRows(store).filter((l) => l.event === 'cancel').length, 1, 'cancel audited');
  });
  await test('F9 nonceTail survives redaction even when it equals the PIN; other PIN echoes do not', () => {
    const out = redact({ nonceTail: PIN, echoed: PIN, nonceTailBad: 'zz' }, baseEnv());
    eq(out.nonceTail, PIN, 'nonceTail kept');
    eq(out.echoed, '[redacted]', 'PIN echo redacted');
    eq(redact({ nonceTail: FAKE_KEY }, baseEnv()).nonceTail, '[redacted]', 'non-hex tail not exempt');
  });
  await test('F5 RPC URL: walletManager logs only the host; no console line prints the raw URL', async () => {
    const { rpcHostForLog } = await import('./services/walletManager.js');
    eq(rpcHostForLog(FAKE_RPC), 'mainnet.helius-rpc.com', 'host only');
    eq(rpcHostForLog('not a url'), 'invalid-url', 'invalid');
    for (const f of ['services/walletManager.js', 'services/jupiterPerps.js', 'services/walletTracker.js', 'test-perps-connection.js']) {
      const src = readFileSync(path.join(root, f), 'utf8');
      assert(!/console\.[a-z]+\([^)]*\brpcUrl\b(?!\))/.test(src.replace(/rpcHostForLog\(rpcUrl\)/g, '')), `${f} logs rpcUrl`);
    }
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
