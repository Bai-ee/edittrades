/**
 * Trade locks for the REST payload (phase L3, docs/OWNER_DECISIONS_2026-10-02_TRADE_LOCK.md).
 *
 * Reads the Telegram state blob (where the owner's locks live), re-judges every open lock
 * read-only against this request's own build (the cron owns stored transitions), and
 * returns the compact shape the GPT reads: open locks plus locks closed in the last hour
 * (so "now?" can say MISSED / stopped). Never throws; null when the store is unreadable
 * or slow, so the response simply has no `locks` key.
 *
 * REST only: api/scalp-context.js calls this after the bearer check, and the MCP path is
 * dispatched before any REST logic, so the anonymous MCP endpoint never sees a lock.
 */
import { readBlob } from './blobJsonl.js';
import { evaluateLock, compactLock, normalizeLocks, LOCK_OPEN } from './tradeLock.js';

export const LOCK_STATE_PATH = 'telegram/state.json';
export const LOCK_FEED_TIMEOUT_MS = 1200;
export const LOCK_FEED_CLOSED_MS = 60 * 60_000;

/**
 * The stored lock list, read with a time cap. Start it in parallel with the build.
 * @param {Object} p
 * @param {Function} p.get - @vercel/blob get (injectable)
 * @param {number} [p.timeoutMs]
 * @returns {Promise<Array<Object>|null>} raw state.locks ([] when the blob has none), null on failure / timeout
 */
export async function readStoredLocks({ get, timeoutMs = LOCK_FEED_TIMEOUT_MS }) {
  if (typeof get !== 'function') return null;
  let timer;
  try {
    const blob = await Promise.race([
      readBlob(get, LOCK_STATE_PATH),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); })
    ]);
    if (blob === 'timeout') return null;
    const state = blob && blob.text ? JSON.parse(blob.text) : {};
    return Array.isArray(state.locks) ? state.locks : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compact feed from stored locks + this request's FULL build: open locks re-judged
 * read-only, plus locks closed within LOCK_FEED_CLOSED_MS. Null in -> null out.
 * @returns {Array<Object>|null}
 */
export function lockFeed(storedLocks, payload, nowMs) {
  if (!Array.isArray(storedLocks)) return null;
  try {
    const syms = payload && payload.symbols && typeof payload.symbols === 'object' ? payload.symbols : {};
    return normalizeLocks(storedLocks, nowMs)
      .map((l) => (LOCK_OPEN.includes(l.status) && syms[l.symbol] ? evaluateLock(l, syms[l.symbol], nowMs).lock : l))
      .filter((l) => LOCK_OPEN.includes(l.status) || nowMs - Date.parse(l.endedAt || l.statusAt) < LOCK_FEED_CLOSED_MS)
      .map(compactLock);
  } catch {
    return null;
  }
}
