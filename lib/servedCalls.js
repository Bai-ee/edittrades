/**
 * Served calls (T3, docs/PLAN_SERVED_CALLS.md): every engine call served to the Custom GPT
 * through GET /api/scalp-context is appended to the journal's public Vercel Blob store so
 * the tracker can score it like a cron-captured call (`source: 'served'`).
 *
 *   served/YYYY-MM-DD.jsonl   one tracker capture row per (symbol, closedThrough, class,
 *                             planStatus) per UTC day of servedAt; repeats are not written
 *   served/manifest.json      {schemaVersion:'served-manifest-1', baseUrl, days[], updatedAt}
 *
 * Rows come from scripts/tracker/recordsFromPayload (explicit field list, sensitive keys
 * stripped, throw if any survive), then a second check refuses any credential-looking key
 * or value (findSecretLike): never account, wallet, margin, performance, a bearer or
 * an RPC URL. recordServedCalls never throws and never takes longer than `timeoutMs`; the
 * caller's response is not affected by anything here. TRACK_SERVED_CALLS=false disables
 * it; no BLOB_READ_WRITE_TOKEN disables it.
 */

import { put as blobPut, get as blobGet } from '@vercel/blob';
import { appendJsonlDay } from './blobJsonl.js';
import { recordsFromPayload, findSensitiveKeys, servedKey } from '../scripts/tracker/records.js';

export { servedKey };

export const SERVED_MANIFEST_PATH = 'served/manifest.json';
export const SERVED_MANIFEST_SCHEMA = 'served-manifest-1';
export const SERVED_TIMEOUT_MS = 1500;

export const servedDayPath = (day) => `served/${day}.jsonl`;

const SECRET_KEY_RE = /bearer|authorization|secret|private_?key|api_?key|rpc_?url/i;

/** Paths of credential-looking keys or values (a Bearer string, a URL with a query) in `value`. */
export function findSecretLike(value, at = '$', found = []) {
  if (typeof value === 'string') {
    if (/^bearer\s/i.test(value) || /^https?:\/\/[^\s]*[?&](api[-_]?key|token|key)=/i.test(value)) found.push(at);
  } else if (Array.isArray(value)) value.forEach((v, i) => findSecretLike(v, `${at}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) found.push(`${at}.${k}`);
      findSecretLike(v, `${at}.${k}`, found);
    }
  }
  return found;
}

/**
 * Tracker capture rows for a served payload, marked source 'served' with servedAt. Rows
 * without a flagRecommendation are dropped. Throws if a sensitive key survives the strip.
 * @param {Object} payload - the unfiltered scalp-context payload
 * @param {number} nowMs
 * @returns {Array<Object>}
 */
export function servedRowsFromPayload(payload, nowMs) {
  const servedAt = new Date(nowMs).toISOString();
  const rows = recordsFromPayload(payload, nowMs)
    .filter((r) => r.flagRecommendation && typeof r.flagRecommendation === 'object')
    .map((r) => ({ ...r, source: 'served', servedAt }));
  if (rows.some((r) => findSensitiveKeys(r).length || findSecretLike(r).length)) throw new Error('refusing to write: sensitive keys in a served row');
  return rows;
}

const defaultStore = { get: blobGet, put: blobPut };

function skipped(reason, startedAt) {
  console.log(`[Served] skipped=${reason} ms=${Date.now() - startedAt}`);
  return { recorded: 0, skipped: reason };
}

/**
 * Append the payload's calls to today's served file. Never throws.
 * @param {Object} payload
 * @param {Object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {Object} [opts.env=process.env]
 * @param {{get: Function, put: Function}} [opts.store] - @vercel/blob by default
 * @param {number} [opts.timeoutMs=1500]
 * @returns {Promise<{recorded:number, skipped:string|null}>}
 */
export async function recordServedCalls(payload, { now = Date.now(), env = process.env, store = defaultStore, timeoutMs = SERVED_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  try {
    if (env.TRACK_SERVED_CALLS === 'false') return skipped('disabled', startedAt);
    if (!env.BLOB_READ_WRITE_TOKEN) return skipped('no_store', startedAt);
    if (!payload || payload.dataStatus === 'unavailable') return skipped('unavailable', startedAt);

    let rows;
    try {
      rows = servedRowsFromPayload(payload, now);
    } catch {
      return skipped('sensitive_guard', startedAt);
    }
    if (!rows.length) return skipped('no_calls', startedAt);

    const day = new Date(now).toISOString().slice(0, 10);
    const write = appendJsonlDay(store, {
      day,
      dayPath: servedDayPath(day),
      manifestPath: SERVED_MANIFEST_PATH,
      manifestSchema: SERVED_MANIFEST_SCHEMA,
      rows,
      keyOf: servedKey,
      nowIso: new Date(now).toISOString()
    });
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    let result;
    try {
      result = await Promise.race([write, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!result) {
      write.catch(() => {}); // a late failure after the timeout stays silent
      return skipped('timeout', startedAt);
    }
    console.log(`[Served] recorded=${result.added} dup=${result.duplicates} ms=${Date.now() - startedAt}`);
    return { recorded: result.added, skipped: null };
  } catch (err) {
    return skipped(`error:${err && err.name ? String(err.name).replace(/[^A-Za-z]/g, '').slice(0, 40) : 'Error'}`, startedAt);
  }
}
