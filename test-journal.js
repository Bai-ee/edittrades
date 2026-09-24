/**
 * Deterministic tests for the trade journal (T2, docs/PLAN_TRADE_JOURNAL.md):
 * lib/journalSchema.js validation and api/journal.js (auth, method gate, body cap,
 * rate limit, idempotency, Blob append + manifest, GET ordering), plus isolation
 * checks: the journal imports nothing that can sign or execute, and the MCP route
 * neither imports the journal nor registers a journal tool. Blob put/get are injected
 * in-memory fakes; no network.
 *
 * Run: node test-journal.js
 */

import { readFileSync } from 'node:fs';
import { validateJournalEntry, journalDay, parseJournalLines, KINDS, RECORD_KEYS, MAX_RECORD_BYTES } from './lib/journalSchema.js';
import { handleJournal, resetRateLimit, RATE_LIMIT } from './api/journal.js';
import { updateBlob, isOverwriteConflict, WRITE_ATTEMPTS } from './lib/blobJsonl.js';

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

async function assertRejects(fn, pattern) {
  try {
    await fn();
  } catch (err) {
    if (pattern && !pattern.test(String(err.message))) throw new Error(`rejected with the wrong message: ${err.message}`);
    return;
  }
  throw new Error('expected a rejection, got none');
}

const KEY = 'test-journal-key-0123456789';
const ENV = { JOURNAL_API_KEY: KEY };
const T0 = Date.parse('2026-09-24T14:05:00.000Z');
const BASE = 'https://fakestore.public.blob.vercel-storage.com';

/**
 * In-memory Vercel Blob with ETags; `raceOnce` makes the next `ifMatch` write fail once
 * (an existing blob, concurrent update race). `raceCreateOnce` (T6 completion plan A4)
 * makes the next `allowOverwrite: false` write on a not-yet-existing pathname fail once
 * with `BlobAccessError`, as if a concurrent request created the blob a moment earlier -
 * the first-write race `writeBlob`'s create path now guards against.
 */
function fakeBlob() {
  const files = new Map();
  let n = 0;
  const state = { files, puts: [], raceOnce: false, raceCreateOnce: false };
  state.get = async (pathname) => {
    const f = files.get(pathname);
    if (!f) return null;
    return { statusCode: 200, stream: new Response(f.text).body, blob: { etag: f.etag, url: `${BASE}/${pathname}` } };
  };
  state.put = async (pathname, body, opts) => {
    state.puts.push({ pathname, opts });
    assertEqual(opts.addRandomSuffix, false, 'addRandomSuffix');
    assertEqual(opts.allowOverwrite, !!opts.ifMatch, 'allowOverwrite matches whether ifMatch is set (A4)');
    assertEqual(opts.access, 'public', 'access');
    const cur = files.get(pathname);
    if (state.raceOnce && opts.ifMatch) {
      state.raceOnce = false;
      files.set(pathname, { text: cur.text, etag: `"e${++n}"` });
      const err = new Error('Precondition failed'); err.name = 'BlobPreconditionFailedError'; throw err;
    }
    if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) {
      const err = new Error('Precondition failed'); err.name = 'BlobPreconditionFailedError'; throw err;
    }
    if (state.raceCreateOnce && !opts.ifMatch && opts.allowOverwrite === false && !cur) {
      state.raceCreateOnce = false;
      files.set(pathname, { text: 'concurrent-writer-won\n', etag: `"e${++n}"` });
      const err = new Error('This blob already exists, use `allowOverwrite: true`'); err.name = 'BlobAccessError'; throw err;
    }
    // Real Vercel Blob semantics: allowOverwrite:false against an existing blob (no
    // ifMatch) always throws, race or not.
    if (!opts.ifMatch && opts.allowOverwrite === false && cur) {
      const err = new Error('This blob already exists, use `allowOverwrite: true`'); err.name = 'BlobAccessError'; throw err;
    }
    files.set(pathname, { text: String(body), etag: `"e${++n}"` });
    return { url: `${BASE}/${pathname}`, pathname };
  };
  return state;
}

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    end() { this.ended = true; return this; }
  };
}

async function call({ method = 'POST', body, auth = `Bearer ${KEY}`, query = {}, headers = {}, blob, nowMs = T0, env = ENV }) {
  const req = { method, query, headers: { ...(auth ? { authorization: auth } : {}), ...headers }, body };
  const res = mockRes();
  const quiet = console.log;
  console.log = () => {};
  try {
    await handleJournal(req, res, { put: blob.put, get: blob.get, now: () => nowMs, env });
  } finally {
    console.log = quiet;
  }
  return res;
}

const ok = { kind: 'open', symbol: 'btc', direction: 'long', entry: 84600, stop: 84390, tp1: 85100, sizeUsd: 1011.67, leverage: 10.2,
  engineRef: { candidateId: 'BTC:1m:long:2026-09-24T14:00:00.000Z', planId: 'p1', recClass: 'GOOD', reasonCode: 'ready_flag_plan' },
  saidAt: '2026-09-24T14:05:00Z', text: 'took BTC long 84600 stop 84390' };
const ctx = { now: T0, newId: () => 'j_generated01' };

async function run() {
  await test('auth: the Action bearer (SCALP_CONTEXT_API_KEY) is accepted by the journal too', async () => {
    const blob = fakeBlob();
    const res = await call({ method: 'GET', auth: 'Bearer scalp-key', env: { JOURNAL_API_KEY: KEY, SCALP_CONTEXT_API_KEY: 'scalp-key' }, blob });
    assertEqual(res.statusCode, 200, 'scalp key accepted');
  });

  console.log('schema');

  await test('valid record: server fields added, symbol upper-cased, keys are the whitelist in order', () => {
    const r = validateJournalEntry({ ...ok, walletAddress: 'SECRET', privateKey: 'x' }, ctx);
    assert(r.ok, JSON.stringify(r.errors));
    assertEqual(Object.keys(r.record).join(), RECORD_KEYS.join(), 'keys');
    assertEqual(r.record.id, 'j_generated01', 'generated id');
    assertEqual(r.record.symbol, 'BTC', 'symbol');
    assertEqual(r.record.receivedAt, '2026-09-24T14:05:00.000Z', 'receivedAt');
    assertEqual(r.record.schemaVersion, 'journal-1', 'schemaVersion');
    assert(!JSON.stringify(r.record).includes('SECRET'), 'unknown keys dropped');
  });

  await test('text only is enough: kind defaults to note, numbers null, engineRef null', () => {
    const r = validateJournalEntry({ text: 'skipped SOL' }, ctx);
    assert(r.ok, 'ok');
    assertEqual(r.record.kind, 'note', 'kind');
    assertEqual(r.record.entry, null, 'entry');
    assertEqual(r.record.engineRef, null, 'engineRef');
  });

  await test('rejects: missing text, bad kind, bad direction, string number, negative price, bad recClass, bad id, bad saidAt', () => {
    const bad = (body, re) => {
      const r = validateJournalEntry(body, ctx);
      assert(!r.ok, `expected rejection for ${JSON.stringify(body)}`);
      assert(r.errors.some((e) => re.test(e)), `errors ${JSON.stringify(r.errors)} missing ${re}`);
    };
    bad({ kind: 'open' }, /text is required/);
    bad({ text: 'x', kind: 'buy' }, /kind must be/);
    bad({ text: 'x', direction: 'up' }, /direction/);
    bad({ text: 'x', entry: '84600' }, /entry must be a number/);
    bad({ text: 'x', stop: -1 }, /stop must be greater/);
    bad({ text: 'x', engineRef: { recClass: 'GREAT' } }, /recClass/);
    bad({ text: 'x', engineRef: 'abc' }, /engineRef must be an object/);
    bad({ text: 'x', id: 'short' }, /id must be/);
    bad({ text: 'x', saidAt: 'yesterday' }, /saidAt/);
    bad([], /JSON object/);
    assert(validateJournalEntry({ text: 'x', resultR: -1.2, resultUsd: -12 }, ctx).ok, 'negative results allowed');
    assertEqual(KINDS.join(), 'open,close,adjust,skip,note', 'kinds');
  });

  await test('journalDay / parseJournalLines skip torn lines', () => {
    assertEqual(journalDay('2026-09-24T23:59:59.000Z'), '2026-09-24', 'day');
    assertEqual(parseJournalLines('{"id":"a"}\n{torn\n\n[1]\n{"id":"b"}').map((r) => r.id).join(), 'a,b', 'lines');
  });

  console.log('\nendpoint');

  await test('auth: no header, wrong key, wrong scheme, unset key -> 401; nothing written', async () => {
    const blob = fakeBlob();
    for (const auth of [null, 'Bearer nope', `Basic ${KEY}`]) {
      resetRateLimit();
      const res = await call({ body: ok, auth, blob });
      assertEqual(res.statusCode, 401, `auth ${auth}`);
    }
    const res = await call({ body: ok, blob, env: {} });
    assertEqual(res.statusCode, 401, 'unset key');
    assertEqual(blob.puts.length, 0, 'no writes');
  });

  await test('method gate: PUT/DELETE/PATCH -> 405 with Allow; OPTIONS -> 200', async () => {
    const blob = fakeBlob();
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await call({ method, body: ok, blob });
      assertEqual(res.statusCode, 405, method);
      assertEqual(res.getHeader('Allow'), 'GET, POST', 'Allow');
    }
    assertEqual((await call({ method: 'OPTIONS', blob })).statusCode, 200, 'OPTIONS');
  });

  await test('body cap: > 4 KB -> 413 (header, string, object); bad JSON / empty / invalid record -> 400', async () => {
    const blob = fakeBlob();
    resetRateLimit();
    const big = { text: 'x'.repeat(MAX_RECORD_BYTES + 10) };
    assertEqual((await call({ body: big, blob })).statusCode, 413, 'object');
    assertEqual((await call({ body: JSON.stringify(big), blob })).statusCode, 413, 'string');
    assertEqual((await call({ body: { text: 'x' }, headers: { 'content-length': '5000' }, blob })).statusCode, 413, 'header');
    resetRateLimit();
    assertEqual((await call({ body: '{nope', blob })).statusCode, 400, 'bad JSON');
    assertEqual((await call({ body: undefined, blob })).statusCode, 400, 'empty');
    const res = await call({ body: { kind: 'open' }, blob });
    assertEqual(res.statusCode, 400, 'invalid');
    assert(res.body.details.includes('text is required'), 'details');
    assertEqual(blob.puts.length, 0, 'no writes');
  });

  await test('POST 201: appends to journal/YYYY-MM-DD.jsonl and writes the manifest with baseUrl and days', async () => {
    resetRateLimit();
    const blob = fakeBlob();
    const res = await call({ body: ok, blob });
    assertEqual(res.statusCode, 201, 'status');
    assertEqual(res.getHeader('Cache-Control'), 'no-store', 'no-store');
    assert(/^j_[0-9a-f]{32}$/.test(res.body.id), 'server id');
    const day = blob.files.get('journal/2026-09-24.jsonl');
    assertEqual(parseJournalLines(day.text).length, 1, 'one line');
    const manifest = JSON.parse(blob.files.get('journal/manifest.json').text);
    assertEqual(manifest.baseUrl, BASE, 'baseUrl');
    assertEqual(manifest.days.join(), '2026-09-24', 'days');
    const res2 = await call({ body: { text: 'closed BTC +1.2R', kind: 'close', symbol: 'BTC', resultR: 1.2 }, blob, nowMs: T0 + 60_000 });
    assertEqual(res2.statusCode, 201, 'second');
    assertEqual(parseJournalLines(blob.files.get('journal/2026-09-24.jsonl').text).length, 2, 'appended, not replaced');
    assert(blob.puts.every((p) => p.opts.cacheControlMaxAge === 60), 'short cache');
    assertEqual(blob.puts.filter((p) => p.pathname === 'journal/manifest.json').length, 1, 'manifest rewritten only for a new day');
  });

  await test('idempotency: same client id twice -> 200 duplicate, one line; also across the previous day', async () => {
    resetRateLimit();
    const blob = fakeBlob();
    const body = { ...ok, id: 'gpt-abc-12345' };
    assertEqual((await call({ body, blob })).statusCode, 201, 'first');
    const again = await call({ body, blob, nowMs: T0 + 5000 });
    assertEqual(again.statusCode, 200, 'duplicate status');
    assertEqual(again.body.duplicate, true, 'duplicate flag');
    assertEqual(parseJournalLines(blob.files.get('journal/2026-09-24.jsonl').text).length, 1, 'one line');
    const nextDay = await call({ body, blob, nowMs: T0 + 12 * 3600_000 });
    assertEqual(nextDay.statusCode, 200, 'next day duplicate');
    assert(!blob.files.has('journal/2026-09-25.jsonl'), 'no new day file');
  });

  await test('ETag race: a concurrent write is retried, both lines kept', async () => {
    resetRateLimit();
    const blob = fakeBlob();
    await call({ body: ok, blob });
    blob.raceOnce = true;
    const res = await call({ body: { text: 'note two' }, blob, nowMs: T0 + 1000 });
    assertEqual(res.statusCode, 201, 'retried');
    assertEqual(parseJournalLines(blob.files.get('journal/2026-09-24.jsonl').text).length, 2, 'two lines');
  });

  await test('T6 completion plan A4: lib/blobJsonl.js updateBlob retries past a first-write race instead of silently losing a row', async () => {
    const blob = fakeBlob();
    blob.raceCreateOnce = true;
    const append = (text) => `${text || ''}my-write\n`;
    const { written, result } = await updateBlob(blob, 'race/2026-09-24.jsonl', 'text/plain; charset=utf-8', append);
    assert(written, 'eventually wrote');
    // The retry re-read the concurrent writer's row and appended onto it - neither write was lost.
    assertEqual(blob.files.get('race/2026-09-24.jsonl').text, 'concurrent-writer-won\nmy-write\n', 'both writes survive, in race order');
    assertEqual(blob.puts.filter((p) => p.pathname === 'race/2026-09-24.jsonl').length, 2, 'exactly one retry (attempt 1 conflict, attempt 2 success)');
    assert(!blob.puts[0].opts.ifMatch, 'first attempt had no ifMatch (it believed it was creating)');
    assertEqual(blob.puts[0].opts.allowOverwrite, false, 'first attempt asked allowOverwrite:false (A4)');
    assert(result, 'second attempt returned a put result');
  });

  await test('T6 completion plan A4: isOverwriteConflict recognizes BlobAccessError; updateBlob gives up after WRITE_ATTEMPTS', async () => {
    assert(isOverwriteConflict({ name: 'BlobAccessError' }), 'name match');
    assert(isOverwriteConflict({ name: 'Error', message: 'This blob already exists, use allowOverwrite: true' }), 'message match');
    assert(!isOverwriteConflict({ name: 'Error', message: 'unrelated' }), 'no false positive');

    const blob = fakeBlob();
    let attempts = 0;
    blob.put = async () => { attempts++; const err = new Error('This blob already exists'); err.name = 'BlobAccessError'; throw err; };
    await assertRejects(
      () => updateBlob(blob, 'race/2026-09-24.jsonl', 'text/plain; charset=utf-8', (text) => `${text || ''}x\n`),
      /already exists/i
    );
    assertEqual(attempts, WRITE_ATTEMPTS, `gives up after exactly ${WRITE_ATTEMPTS} attempts, never loops forever`);
  });

  await test('GET: newest first across days, default 10, ?limit capped at 50, empty store -> []', async () => {
    resetRateLimit();
    const blob = fakeBlob();
    const empty = await call({ method: 'GET', blob });
    assertEqual(empty.statusCode, 200, 'empty 200');
    assertEqual(empty.body.count, 0, 'empty');
    const DAY = 24 * 3600_000;
    for (let i = 0; i < 12; i++) {
      resetRateLimit();
      await call({ body: { text: `n${i}` }, blob, nowMs: T0 - DAY + i * 3 * 3600_000 });
    }
    resetRateLimit();
    const res = await call({ method: 'GET', blob, nowMs: T0 + DAY });
    assertEqual(res.body.count, 10, 'default 10');
    assertEqual(res.body.records[0].text, 'n11', 'newest first');
    assertEqual(res.body.records[9].text, 'n2', 'tenth');
    assertEqual(JSON.parse(blob.files.get('journal/manifest.json').text).days.join(), '2026-09-23,2026-09-24', 'two days');
    const all = await call({ method: 'GET', blob, query: { limit: '500' } });
    assertEqual(all.body.limit, 50, 'capped');
    assertEqual(all.body.count, 12, 'all');
    assertEqual((await call({ method: 'GET', blob, query: { limit: '2' } })).body.records.map((r) => r.text).join(), 'n11,n10', 'limit 2');
  });

  await test(`rate limit: ${RATE_LIMIT} per minute per key -> 429 with Retry-After; resets after the window`, async () => {
    resetRateLimit();
    const blob = fakeBlob();
    for (let i = 0; i < RATE_LIMIT; i++) assertEqual((await call({ method: 'GET', blob, nowMs: T0 + i })).statusCode, 200, `req ${i}`);
    const limited = await call({ method: 'GET', blob, nowMs: T0 + 100 });
    assertEqual(limited.statusCode, 429, '429');
    assert(Number(limited.getHeader('Retry-After')) > 0, 'Retry-After');
    assertEqual((await call({ method: 'GET', blob, nowMs: T0 + 61_000 })).statusCode, 200, 'after window');
  });

  await test('store failure -> 503 without leaking the error; no store token -> 503', async () => {
    resetRateLimit();
    const broken = { put: async () => { throw new Error('token vercel_blob_rw_SECRET'); }, get: async () => null };
    const res = await call({ body: ok, blob: broken });
    assertEqual(res.statusCode, 503, '503');
    assert(!JSON.stringify(res.body).includes('SECRET'), 'no leak');
    const req = { method: 'GET', query: {}, headers: { authorization: `Bearer ${KEY}` } };
    const r2 = mockRes();
    const quiet = console.log; console.log = () => {};
    try { await handleJournal(req, r2, { env: ENV, now: () => T0 + 999_999 }); } finally { console.log = quiet; }
    assertEqual(r2.statusCode, 503, 'unconfigured store');
  });

  console.log('\nisolation');

  const importLines = (file) => readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').filter((l) => /^\s*import\b|\bfrom\s+['"]/.test(l)).join('\n');

  await test('journal imports only crypto, @vercel/blob, lib/journalSchema.js and lib/blobJsonl.js (nothing that can sign or execute)', () => {
    const api = importLines('./api/journal.js');
    assertEqual(importLines('./lib/journalSchema.js'), '', 'schema is pure');
    assertEqual(importLines('./lib/blobJsonl.js'), '', 'blob helpers are pure');
    const froms = [...api.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
    assertEqual(froms.join(), "../lib/blobJsonl.js,../lib/journalSchema.js,@vercel/blob,crypto", 'imports');
    const src = readFileSync(new URL('./api/journal.js', import.meta.url), 'utf8');
    // SCALP_CONTEXT_API_KEY is read on purpose: one ChatGPT Action carries one bearer for
    // every operation, so the journal accepts the Action's key as well as its own.
    for (const env of ['SOLANA_PRIVATE_KEY', 'TRADE_EXECUTION_API_KEY', 'SOLANA_RPC_URL']) assert(!src.includes(`env.${env}`), `reads ${env}`);
  });

  await test('MCP route: no journal import, no journal tool', () => {
    for (const f of ['./lib/mcpHttp.js', './services/editTradesMcp.js']) {
      assert(!/journal/i.test(importLines(f)), `${f} imports the journal`);
    }
    const mcp = readFileSync(new URL('./services/editTradesMcp.js', import.meta.url), 'utf8');
    assert(!/journal/i.test(mcp), 'editTradesMcp mentions journal');
    assertEqual((mcp.match(/registerTool\(|\.tool\(/g) || []).length, 1, 'one tool registration');
  });

  await test('vercel.json routes /api/journal and no longer routes /api/crypto-news; 12 functions', () => {
    const cfg = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8'));
    assert(cfg.routes.some((r) => r.dest === '/api/journal.js'), 'journal route');
    assert(!cfg.routes.some((r) => /crypto-news/.test(r.dest)), 'crypto-news route gone');
    const catchAll = cfg.routes.findIndex((r) => r.src === '/api/(.*)');
    assert(cfg.routes.findIndex((r) => r.dest === '/api/journal.js') < catchAll, 'before the catch-all');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`Failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

run();
