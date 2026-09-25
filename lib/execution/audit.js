/**
 * Execution audit log (T-3, docs/PLAN_TELEGRAM_EXECUTION.md "Audit log").
 *
 *   execution/YYYY-MM-DD.jsonl   one line per event (preflight, ticket, confirm, fill,
 *                                close, adjust, pin_wrong, kill, arm, error), UTC day of `at`
 *   execution/manifest.json      {schemaVersion:'execution-manifest-1', baseUrl, days[], updatedAt}
 *
 * Every line passes `redact` first: keys that name a secret (key, seed, secret, private,
 * mnemonic, pin, token, bearer, authorization, rpc, url, password) are replaced, string
 * values that look like a URL, a bearer, a long base58/hex blob or a 64-byte array are
 * replaced, and the live values of SOLANA_PRIVATE_KEY, EXECUTION_PIN, TELEGRAM_BOT_TOKEN,
 * SOLANA_RPC_URL, BLOB_READ_WRITE_TOKEN are replaced wherever they appear. `nonceTail`
 * (4 hex chars of a spent ticket nonce) is exempt from the exact-value PIN match, so a
 * tail that happens to equal the PIN is not singled out as `[redacted]`.
 *
 * The Blob store is public, so lines never carry a Telegram user id, a full position id
 * or a full tx signature: those go in as `positionIdHash` / `txSignatureHash` (idHash:
 * sha256, first 12 hex). The full values live only in the Telegram result message and
 * the journal. appendAudit never throws.
 */

import crypto from 'crypto';
import { appendJsonlDay } from '../blobJsonl.js';

export const AUDIT_MANIFEST_PATH = 'execution/manifest.json';
export const AUDIT_MANIFEST_SCHEMA = 'execution-manifest-1';
export const AUDIT_SCHEMA = 'execution-audit-1';
export const AUDIT_TIMEOUT_MS = 3000;
export const auditDayPath = (day) => `execution/${day}.jsonl`;

const SECRET_KEY_RE = /key|seed|secret|private|mnemonic|pin|token|bearer|authori[sz]ation|rpc|url|password|passphrase/i;
/** Keys kept verbatim when the value matches the pattern (never a secret). */
const KEEP_KEYS = new Map([['nonceTail', /^[0-9a-f]{4}$/]]);

/** sha256(value), first 12 hex chars; null for an empty value. For ids on public blobs. */
export function idHash(value) {
  if (value === undefined || value === null || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}
const REDACTED = '[redacted]';
const SECRET_ENV = ['SOLANA_PRIVATE_KEY', 'EXECUTION_PIN', 'TELEGRAM_BOT_TOKEN', 'SOLANA_RPC_URL', 'BLOB_READ_WRITE_TOKEN', 'TRADE_EXECUTION_API_KEY', 'TELEGRAM_WEBHOOK_SECRET'];

function secretValues(env) {
  const out = [];
  for (const k of SECRET_ENV) {
    const v = env && env[k];
    if (typeof v === 'string' && v.trim().length >= 4) out.push(v.trim());
  }
  return out;
}

function redactString(s, secrets) {
  let v = s;
  for (const sec of secrets) {
    if (sec.length >= 12 ? v.includes(sec) : v === sec) return REDACTED;
  }
  if (/https?:\/\/|wss?:\/\//i.test(v)) v = v.replace(/(https?|wss?):\/\/\S+/gi, '[redacted-url]');
  if (/\bbearer\s+\S+/i.test(v)) v = v.replace(/\bbearer\s+\S+/gi, 'Bearer [redacted]');
  if (/[1-9A-HJ-NP-Za-km-z]{60,}/.test(v)) v = v.replace(/[1-9A-HJ-NP-Za-km-z]{60,}/g, REDACTED);
  if (/[0-9a-fA-F]{64,}/.test(v)) v = v.replace(/[0-9a-fA-F]{64,}/g, REDACTED);
  return v;
}

const looksLikeKeyBytes = (arr) => arr.length >= 32 && arr.every((x) => Number.isInteger(x) && x >= 0 && x <= 255);

/**
 * Deep copy of `value` with secret-looking keys and values replaced. Pure.
 * @param {*} value
 * @param {Object} [env=process.env] - live secret values to scrub
 */
export function redact(value, env = process.env, secrets = secretValues(env), depth = 0) {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return looksLikeKeyBytes(value) ? REDACTED : value.map((v) => redact(v, env, secrets, depth + 1));
  if (value instanceof Uint8Array) return REDACTED;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (KEEP_KEYS.has(k) && typeof v === 'string' && KEEP_KEYS.get(k).test(v)) { out[k] = v; continue; }
      out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(v, env, secrets, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** One audit line (redacted). */
export function auditLine(event, fields, { id, nowMs, mode = null, env = process.env }) {
  return redact({ id, schemaVersion: AUDIT_SCHEMA, at: new Date(nowMs).toISOString(), event: String(event), mode, ...(fields || {}) }, env);
}

/**
 * Append one audit line. Never throws; resolves within `timeoutMs`.
 * @param {{get:Function, put:Function, head?:Function}} store
 * @param {string} event
 * @param {Object} fields
 * @param {Object} o
 * @param {number} o.nowMs
 * @param {string} o.id
 * @param {string|null} [o.mode]
 * @param {Object} [o.env]
 * @returns {Promise<{ok:boolean, id:string, line:Object|null, skipped:string|null}>}
 */
export async function appendAudit(store, event, fields, { nowMs, id, mode = null, env = process.env, timeoutMs = AUDIT_TIMEOUT_MS }) {
  let line = null;
  try {
    line = auditLine(event, fields, { id, nowMs, mode, env });
    if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') return { ok: false, id, line, skipped: 'no_store' };
    const day = line.at.slice(0, 10);
    const work = appendJsonlDay(store, {
      day, dayPath: auditDayPath(day), manifestPath: AUDIT_MANIFEST_PATH, manifestSchema: AUDIT_MANIFEST_SCHEMA,
      rows: [line], keyOf: (r) => r.id, nowIso: line.at
    });
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    let r;
    try { r = await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
    if (!r) { work.catch(() => {}); return { ok: false, id, line, skipped: 'timeout' }; }
    return { ok: true, id, line, skipped: null };
  } catch (err) {
    return { ok: false, id, line, skipped: `error:${String((err && err.name) || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 40)}` };
  }
}
