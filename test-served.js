/**
 * Deterministic tests for served-call recording (T3, docs/PLAN_SERVED_CALLS.md):
 * lib/servedCalls.js (strip + guard, dedupe, manifest, timeout, kill switch) and the
 * hook in api/scalp-context.js (JSON 200 only, unfiltered payload, response unchanged).
 * Blob put/get are injected in-memory fakes; no network.
 *
 * Run: node test-served.js
 */

import { readFileSync } from 'node:fs';
import {
  recordServedCalls, servedRowsFromPayload, servedKey, findSecretLike,
  SERVED_MANIFEST_PATH, SERVED_MANIFEST_SCHEMA, SERVED_TIMEOUT_MS
} from './lib/servedCalls.js';
import { handleScalpContext } from './api/scalp-context.js';

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

const T0 = Date.parse('2026-09-24T10:15:30.000Z');
const BASE = 'https://fakestore.public.blob.vercel-storage.com';
const ENV = { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_fakestore_notasecret' };
const API_KEY = 'test-served-key-0123456789';
const BEARER_VALUE = 'sk-live-should-never-be-stored';

/** In-memory Vercel Blob with ETags (same contract as test-journal.js). */
function fakeBlob() {
  const files = new Map();
  let n = 0;
  const state = { files, puts: [] };
  state.get = async (pathname) => {
    const f = files.get(pathname);
    if (!f) return null;
    return { statusCode: 200, stream: new Response(f.text).body, blob: { etag: f.etag, url: `${BASE}/${pathname}` } };
  };
  state.put = async (pathname, body, opts) => {
    state.puts.push({ pathname, opts });
    assertEqual(opts.access, 'public', 'access');
    assertEqual(opts.addRandomSuffix, false, 'addRandomSuffix');
    const cur = files.get(pathname);
    if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) {
      const err = new Error('Precondition failed'); err.name = 'BlobPreconditionFailedError'; throw err;
    }
    files.set(pathname, { text: String(body), etag: `"e${++n}"` });
    return { url: `${BASE}/${pathname}`, pathname };
  };
  return state;
}

const lines = (text) => String(text || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function symbolBlock(symbol, cls, planStatus) {
  return {
    price: 100,
    mark: { price: 100.1, driftBps: 10, status: 'ok' },
    flagTradePlan: planStatus ? { status: planStatus, candidateId: `${symbol}-c1`, timeframe: '15m', direction: 'long', entry: 101, stop: 99, tp1: 105 } : null,
    flagRecommendation: { class: cls, candidateId: `${symbol}-c1`, primaryReason: { code: 'test_reason' }, supports: [], opposes: [], unknowns: [] },
    candidateSetups: [{ candidateId: `${symbol}-c1`, timeframe: '15m', direction: 'long', state: 'forming', breakoutLevel: 101, invalidation: 99, measuredRR: 2, qual: 'ok', walletAddress: 'x' }],
    decisionTrace: { bias: { htf: 'up' } },
    timeframes: { '1m': { candles: [] } }
  };
}

/** A payload shaped like buildScalpContext's, with account data and a bearer-looking key. */
function payload(overrides = {}) {
  return {
    schemaVersion: '1.10.0',
    configVersion: 'cfg-test',
    dataStatus: 'complete',
    closedThrough: '2026-09-24T10:15:00.000Z',
    authorization: `Bearer ${BEARER_VALUE}`,
    account: { status: 'available', address: 'WalletAddr111', margin: { usd: 500 }, holdingsUsd: 200, performance: { netPnlUsd: 5 } },
    symbols: {
      BTC: symbolBlock('BTC', 'GOOD', 'ready'),
      ETH: symbolBlock('ETH', 'WATCH', null),
      SOL: symbolBlock('SOL', 'BAD', 'rejected')
    },
    warnings: [],
    ...overrides
  };
}

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.headers['content-type'] = this.headers['content-type'] || 'application/json'; this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end(b) { if (b !== undefined) this.body = b; return this; }
  };
}

async function callHandler({ query = {}, method = 'GET', auth = `Bearer ${API_KEY}`, build, record, extraHeaders = {} }) {
  const res = mockRes();
  const headers = { ...(auth ? { authorization: auth } : {}), ...extraHeaders };
  await quiet(() => handleScalpContext({ method, url: '/api/scalp-context', query, headers, on() {} }, res, { build, record }));
  return res;
}

const stripRequestId = (body) => {
  const { requestId, ...rest } = body || {};
  return JSON.stringify(rest);
};

async function main() {
  console.log('Running test-served.js\n');
  process.env.SCALP_CONTEXT_API_KEY = API_KEY;

  console.log('rows');

  await test('rows: one per symbol with a recommendation, source served, servedAt, no account/wallet/bearer', () => {
    const rows = servedRowsFromPayload(payload(), T0);
    assertEqual(rows.length, 3, 'rows');
    for (const r of rows) {
      assertEqual(r.source, 'served', 'source');
      assertEqual(r.servedAt, new Date(T0).toISOString(), 'servedAt');
      assertEqual(r.closedThrough, '2026-09-24T10:15:00.000Z', 'closedThrough');
    }
    const text = JSON.stringify(rows);
    for (const bad of ['account', 'WalletAddr111', 'walletAddress', BEARER_VALUE, 'authorization', 'margin', 'performance', 'holdings']) {
      assert(!text.includes(bad), `row carries ${bad}`);
    }
  });

  await test('rows: symbols without a flagRecommendation are dropped', () => {
    const p = payload();
    p.symbols.ETH.flagRecommendation = null;
    assertEqual(servedRowsFromPayload(p, T0).map((r) => r.symbol).join(), 'BTC,SOL', 'symbols');
  });

  await test('guard: a bearer string inside a copied block throws; nothing is written', async () => {
    const p = payload();
    p.symbols.BTC.flagRecommendation.note = `Bearer ${BEARER_VALUE}`;
    let threw = false;
    try { servedRowsFromPayload(p, T0); } catch { threw = true; }
    assert(threw, 'guard must throw');
    const store = fakeBlob();
    const out = await quiet(() => recordServedCalls(p, { now: T0, env: ENV, store }));
    assertEqual(out.recorded, 0, 'recorded');
    assertEqual(out.skipped, 'sensitive_guard', 'skipped');
    assertEqual(store.puts.length, 0, 'no puts');
  });

  await test('findSecretLike: keys and token-bearing URLs are flagged, engine fields are not', () => {
    assert(findSecretLike({ a: { apiKey: 'x' } }).length === 1, 'apiKey key');
    assert(findSecretLike({ u: 'https://rpc.example.com/?api-key=abc' }).length === 1, 'rpc url with key');
    assertEqual(findSecretLike(servedRowsFromPayload(payload(), T0)).length, 0, 'clean rows');
  });

  console.log('\nstore');

  await test('first call writes 3 rows and lists the day in the manifest once', async () => {
    const store = fakeBlob();
    const out = await quiet(() => recordServedCalls(payload(), { now: T0, env: ENV, store }));
    assertEqual(out.recorded, 3, 'recorded');
    assertEqual(out.skipped, null, 'skipped');
    const rows = lines(store.files.get('served/2026-09-24.jsonl').text);
    assertEqual(rows.length, 3, 'day rows');
    const manifest = JSON.parse(store.files.get(SERVED_MANIFEST_PATH).text);
    assertEqual(manifest.schemaVersion, SERVED_MANIFEST_SCHEMA, 'schema');
    assertEqual(manifest.baseUrl, BASE, 'baseUrl');
    assertEqual(manifest.days.join(), '2026-09-24', 'days');
    const text = store.files.get('served/2026-09-24.jsonl').text;
    for (const bad of ['account', 'WalletAddr111', BEARER_VALUE]) assert(!text.includes(bad), `stored ${bad}`);
  });

  await test('dedupe: the same payload again writes nothing (no day or manifest put)', async () => {
    const store = fakeBlob();
    await quiet(() => recordServedCalls(payload(), { now: T0, env: ENV, store }));
    const puts = store.puts.length;
    const out = await quiet(() => recordServedCalls(payload(), { now: T0 + 60_000, env: ENV, store }));
    assertEqual(out.recorded, 0, 'recorded');
    assertEqual(store.puts.length, puts, 'no new puts');
    assertEqual(lines(store.files.get('served/2026-09-24.jsonl').text).length, 3, 'still 3 rows');
  });

  await test('dedupe key: a class change at the same closedThrough is a new row', async () => {
    const store = fakeBlob();
    await quiet(() => recordServedCalls(payload(), { now: T0, env: ENV, store }));
    const p = payload();
    p.symbols.ETH.flagRecommendation.class = 'GOOD';
    const out = await quiet(() => recordServedCalls(p, { now: T0 + 1000, env: ENV, store }));
    assertEqual(out.recorded, 1, 'recorded');
    const rows = lines(store.files.get('served/2026-09-24.jsonl').text);
    assertEqual(rows.length, 4, 'rows');
    assertEqual(new Set(rows.map(servedKey)).size, 4, 'distinct keys');
    assertEqual(JSON.parse(store.files.get(SERVED_MANIFEST_PATH).text).days.length, 1, 'manifest day once');
  });

  await test('next UTC day gets its own file and a second manifest day', async () => {
    const store = fakeBlob();
    await quiet(() => recordServedCalls(payload(), { now: T0, env: ENV, store }));
    await quiet(() => recordServedCalls(payload({ closedThrough: '2026-09-25T00:01:00.000Z' }), { now: Date.parse('2026-09-25T00:01:10Z'), env: ENV, store }));
    assertEqual(JSON.parse(store.files.get(SERVED_MANIFEST_PATH).text).days.join(), '2026-09-24,2026-09-25', 'days');
  });

  await test('kill switch, missing token and unavailable data skip without a store call', async () => {
    const store = fakeBlob();
    const off = await quiet(() => recordServedCalls(payload(), { now: T0, env: { ...ENV, TRACK_SERVED_CALLS: 'false' }, store }));
    assertEqual(off.skipped, 'disabled', 'kill switch');
    const noTok = await quiet(() => recordServedCalls(payload(), { now: T0, env: {}, store }));
    assertEqual(noTok.skipped, 'no_store', 'no token');
    const unavailable = await quiet(() => recordServedCalls(payload({ dataStatus: 'unavailable' }), { now: T0, env: ENV, store }));
    assertEqual(unavailable.skipped, 'unavailable', 'unavailable');
    assertEqual(store.puts.length, 0, 'no puts');
  });

  await test('a store error is swallowed', async () => {
    const store = { get: async () => { throw new Error('boom'); }, put: async () => ({}) };
    const out = await quiet(() => recordServedCalls(payload(), { now: T0, env: ENV, store }));
    assertEqual(out.recorded, 0, 'recorded');
    assert(/^error:/.test(out.skipped), `skipped ${out.skipped}`);
  });

  await test(`timeout: a store that never resolves returns within ~${SERVED_TIMEOUT_MS} ms`, async () => {
    const hang = { get: () => new Promise(() => {}), put: () => new Promise(() => {}) };
    const t = Date.now();
    const out = await quiet(() => recordServedCalls(payload(), { now: T0, env: ENV, store: hang }));
    const ms = Date.now() - t;
    assertEqual(out.skipped, 'timeout', 'skipped');
    assert(ms >= SERVED_TIMEOUT_MS - 50 && ms < SERVED_TIMEOUT_MS + 500, `took ${ms} ms`);
  });

  console.log('\nhandler');

  const build = async () => JSON.parse(JSON.stringify(payload()));

  await test('tracker client header: 200 with the same body, nothing recorded', async () => {
    const seen = [];
    const res = await callHandler({ build, record: async (p) => { seen.push(p); }, extraHeaders: { 'x-edittrades-client': 'tracker' } });
    const ref = await callHandler({ build, record: async () => {} });
    assertEqual(res.statusCode, 200, 'status');
    assertEqual(seen.length, 0, 'record calls');
    assertEqual(JSON.stringify(stripRequestId(res.body)), JSON.stringify(stripRequestId(ref.body)), 'same body');
  });

  await test('JSON 200 records once with the unfiltered payload, even with ?compact=1&symbols=BTC', async () => {
    const seen = [];
    const res = await callHandler({ query: { compact: '1', symbols: 'BTC' }, build, record: async (p) => { seen.push(p); } });
    assertEqual(res.statusCode, 200, 'status');
    assertEqual(seen.length, 1, 'record calls');
    assertEqual(Object.keys(seen[0].symbols).sort().join(), 'BTC,ETH,SOL', 'unfiltered symbols');
    assert(seen[0].symbols.ETH.flagRecommendation, 'plan fields present');
  });

  await test('response is identical with and without the hook (status, headers, body)', async () => {
    for (const query of [{}, { compact: '1', symbols: 'BTC' }]) {
      const withHook = await callHandler({ query, build, record: async () => ({ recorded: 3, skipped: null }) });
      const noHook = await callHandler({ query, build, record: async () => {} });
      const throwing = await callHandler({ query, build, record: async () => { throw new Error('boom'); } });
      for (const r of [noHook, throwing]) {
        assertEqual(r.statusCode, withHook.statusCode, 'status');
        assertEqual(JSON.stringify(r.headers), JSON.stringify(withHook.headers), 'headers');
        assertEqual(stripRequestId(r.body), stripRequestId(withHook.body), 'body');
      }
    }
  });

  await test('guard throw inside the real recorder: handler still 200 with the same body, nothing stored', async () => {
    const store = fakeBlob();
    const leaky = async () => {
      const p = payload();
      p.symbols.BTC.flagRecommendation.note = `Bearer ${BEARER_VALUE}`;
      return p;
    };
    const res = await callHandler({ build: leaky, record: (p) => recordServedCalls(p, { now: T0, env: ENV, store }) });
    const ref = await callHandler({ build: leaky, record: async () => {} });
    assertEqual(res.statusCode, 200, 'status');
    assertEqual(stripRequestId(res.body), stripRequestId(ref.body), 'body');
    assertEqual(store.puts.length, 0, 'no puts');
  });

  await test('hanging store: handler still 200 within the cap', async () => {
    const hang = { get: () => new Promise(() => {}), put: () => new Promise(() => {}) };
    const t = Date.now();
    const res = await callHandler({ build, record: (p) => recordServedCalls(p, { now: T0, env: ENV, store: hang }) });
    assertEqual(res.statusCode, 200, 'status');
    assert(Date.now() - t < SERVED_TIMEOUT_MS + 500, 'within cap');
  });

  await test('no record on 401, 405, build error, unavailable data or ?chart', async () => {
    let calls = 0;
    const record = async () => { calls++; };
    assertEqual((await callHandler({ auth: null, build, record })).statusCode, 401, '401 no header');
    assertEqual((await callHandler({ auth: 'Bearer wrong', build, record })).statusCode, 401, '401 wrong');
    assertEqual((await callHandler({ method: 'POST', build, record })).statusCode, 405, '405');
    assertEqual((await callHandler({ build: async () => { throw new Error('x'); }, record })).statusCode, 500, '500');
    assertEqual((await callHandler({ build: async () => payload({ dataStatus: 'unavailable' }), record })).statusCode, 503, '503');
    const chart = await callHandler({ query: { chart: 'BTC:1m' }, build, record });
    assert(chart.headers['content-type'] !== 'application/json' || chart.statusCode !== 200, 'chart path is not the JSON 200');
    assertEqual(calls, 0, 'record calls');
  });

  console.log('\nisolation');

  const importLines = (file) => readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').filter((l) => /^\s*import\b|\bfrom\s+['"]/.test(l)).join('\n');

  await test('servedCalls imports only @vercel/blob, lib/blobJsonl.js and scripts/tracker/records.js; records.js is pure', () => {
    const froms = [...importLines('./lib/servedCalls.js').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
    assertEqual(froms.join(), '../scripts/tracker/records.js,./blobJsonl.js,@vercel/blob', 'imports');
    assertEqual(importLines('./scripts/tracker/records.js'), '', 'records.js imports nothing');
  });

  await test('MCP route does not import the served recorder', () => {
    for (const f of ['./lib/mcpHttp.js', './services/editTradesMcp.js']) {
      assert(!/servedCalls|blobJsonl|@vercel\/blob/.test(importLines(f)), `${f} imports the recorder`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
}

main();
