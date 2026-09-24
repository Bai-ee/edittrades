/**
 * Vercel Serverless Function: Trade journal (T2, docs/PLAN_TRADE_JOURNAL.md)
 * POST /api/journal - record one line the user told the GPT ("took BTC long ...")
 * GET  /api/journal - the last N records, newest first (?limit=, default 10, max 50)
 *
 * Bearer JOURNAL_API_KEY or SCALP_CONTEXT_API_KEY (one Action, one bearer). Records text the user
 * said; it never executes, signs, reads a wallet, or imports anything that can. Storage
 * is Vercel Blob (public store, unguessable URLs; owner accepted a public journal):
 *   journal/YYYY-MM-DD.jsonl   one record per line, UTC day of receivedAt; appended by
 *                              read-modify-write guarded by the blob ETag (ifMatch)
 *   journal/manifest.json      {baseUrl, days[]} so the tracker can fetch the day files
 *                              with plain HTTP (no list call, no token)
 * Idempotent on `id`: a record whose id is already in today's or yesterday's file is
 * not written again (200, duplicate:true). Body cap 4 KB (413). Rate limit 10 requests
 * per minute per key, in memory: best effort on serverless (each warm instance counts
 * on its own; a cold start resets it).
 */

import crypto from 'crypto';
import { put as blobPut, get as blobGet } from '@vercel/blob';
import {
  validateJournalEntry, journalDay, journalDayPath, parseJournalLines,
  JOURNAL_MANIFEST_PATH, MAX_RECORD_BYTES, byteLength
} from '../lib/journalSchema.js';
import { readBlob, updateBlob, updateManifest, baseUrlOf } from '../lib/blobJsonl.js';

export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const hits = new Map(); // key hash -> [timestamps]

/** Test hook: clear the in-memory rate limiter. */
export function resetRateLimit() {
  hits.clear();
}

function rateLimited(keyHash, nowMs) {
  const recent = (hits.get(keyHash) || []).filter((t) => nowMs - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(keyHash, recent);
    return Math.ceil((RATE_WINDOW_MS - (nowMs - recent[0])) / 1000);
  }
  recent.push(nowMs);
  hits.set(keyHash, recent);
  return 0;
}

function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// ---------------------------------------------------------------- blob store

/** Append `record` to its day file unless its id is already stored. */
async function appendRecord(store, record) {
  const day = journalDay(record.receivedAt);
  const prevDay = new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const prev = await readBlob(store.get, journalDayPath(prevDay));
  if (prev && parseJournalLines(prev.text).some((r) => r.id === record.id)) return { duplicate: true, day };

  let duplicate = false;
  const { written, result } = await updateBlob(store, journalDayPath(day), 'text/plain; charset=utf-8', (text) => {
    if (text && parseJournalLines(text).some((r) => r.id === record.id)) { duplicate = true; return null; }
    const base = text && !text.endsWith('\n') ? `${text}\n` : (text || '');
    return `${base}${JSON.stringify(record)}\n`;
  });
  if (!written) return { duplicate, day };

  await updateManifest(store, {
    manifestPath: JOURNAL_MANIFEST_PATH,
    manifestSchema: 'journal-manifest-1',
    baseUrl: baseUrlOf(result && result.url),
    day,
    updatedAt: record.receivedAt
  });
  return { duplicate: false, day };
}

/** Last `limit` records, newest first (by receivedAt). */
async function readRecent(store, limit) {
  const manifestBlob = await readBlob(store.get, JOURNAL_MANIFEST_PATH);
  let manifest = null;
  try { manifest = manifestBlob ? JSON.parse(manifestBlob.text) : null; } catch { manifest = null; }
  const days = Array.isArray(manifest && manifest.days) ? [...manifest.days].sort().reverse() : [];
  const records = [];
  for (const day of days) {
    const blob = await readBlob(store.get, journalDayPath(day));
    if (blob) records.push(...parseJournalLines(blob.text));
    if (records.length >= limit) break;
  }
  records.sort((a, b) => (Date.parse(b.receivedAt) || 0) - (Date.parse(a.receivedAt) || 0));
  return records.slice(0, limit);
}

// ---------------------------------------------------------------- request

/** Parsed JSON body or an {error,status}. Oversize (by header or measured) -> 413. */
function readBody(req) {
  const declared = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_RECORD_BYTES) return { status: 413, error: `Body exceeds ${MAX_RECORD_BYTES} bytes` };
  let raw;
  try { raw = req.body; } catch { return { status: 400, error: 'Body is not valid JSON' }; }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw === 'string') {
    if (byteLength(raw) > MAX_RECORD_BYTES) return { status: 413, error: `Body exceeds ${MAX_RECORD_BYTES} bytes` };
    try { return { body: JSON.parse(raw) }; } catch { return { status: 400, error: 'Body is not valid JSON' }; }
  }
  if (raw === undefined || raw === null) return { status: 400, error: 'Body is required' };
  if (byteLength(JSON.stringify(raw)) > MAX_RECORD_BYTES) return { status: 413, error: `Body exceeds ${MAX_RECORD_BYTES} bytes` };
  return { body: raw };
}

function parseLimit(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export default function handler(req, res) {
  return handleJournal(req, res);
}

/**
 * @param {Object} req
 * @param {Object} res
 * @param {Object} [deps] - injectable for tests
 * @param {Function} [deps.put] - @vercel/blob put
 * @param {Function} [deps.get] - @vercel/blob get
 * @param {Function} [deps.now] - () => ms
 * @param {Object} [deps.env] - process.env
 */
export async function handleJournal(req, res, deps = {}) {
  const { put = blobPut, get = blobGet, now = Date.now, env = process.env } = deps;
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const log = (status, extra = '') => console.log(`[Journal] requestId=${requestId} method=${req.method} status=${status} durationMs=${Date.now() - startedAt}${extra}`);

  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    log(405);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // A ChatGPT Action carries one bearer for every operation in its schema, so the journal
  // accepts the Action's SCALP_CONTEXT_API_KEY as well as its own JOURNAL_API_KEY. Both
  // only ever record text the user said; neither can execute or sign.
  const expectedKeys = [env.JOURNAL_API_KEY, env.SCALP_CONTEXT_API_KEY].filter((k) => typeof k === 'string' && k.length > 0);
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/) : null;
  const token = match ? match[1].trim() : null;
  if (expectedKeys.length === 0 || !token || !expectedKeys.some((k) => safeCompare(token, k))) {
    log(401, ` keyConfigured=${expectedKeys.length > 0} headerPresent=${typeof authHeader === 'string' && authHeader.length > 0}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const nowMs = now();
  const retryAfter = rateLimited(crypto.createHash('sha256').update(token).digest('hex'), nowMs);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    log(429);
    return res.status(429).json({ error: 'Rate limit: 10 requests per minute' });
  }

  if (!deps.put && !deps.get && !env.BLOB_READ_WRITE_TOKEN) {
    log(503, ' store=unconfigured');
    return res.status(503).json({ error: 'Journal store unavailable' });
  }
  const store = { put, get };

  try {
    if (req.method === 'GET') {
      const limit = parseLimit(req.query && req.query.limit);
      const records = await readRecent(store, limit);
      log(200, ` count=${records.length}`);
      return res.status(200).json({ records, count: records.length, limit });
    }

    const parsed = readBody(req);
    if (parsed.error) {
      log(parsed.status);
      return res.status(parsed.status).json({ error: parsed.error });
    }
    const checked = validateJournalEntry(parsed.body, { now: nowMs, newId: () => `j_${crypto.randomUUID().replace(/-/g, '')}` });
    if (!checked.ok) {
      log(400, ` errors=${checked.errors.length}`);
      return res.status(400).json({ error: 'Invalid journal record', details: checked.errors });
    }
    const { duplicate, day } = await appendRecord(store, checked.record);
    log(duplicate ? 200 : 201, ` kind=${checked.record.kind} day=${day} duplicate=${duplicate}`);
    return res.status(duplicate ? 200 : 201).json({ ok: true, id: checked.record.id, duplicate, ...(duplicate ? {} : { record: checked.record }) });
  } catch (err) {
    log(503, ` error=${JSON.stringify(String(err && err.name ? err.name : 'Error'))}`);
    return res.status(503).json({ error: 'Journal store unavailable' });
  }
}
