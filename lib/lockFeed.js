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
import { evaluateLock, compactLock, normalizeLocks, checklistLine, LOCK_OPEN } from './tradeLock.js';
import { rankFlags, pulseOf } from './flagFlow.js';

export const LOCK_STATE_PATH = 'telegram/state.json';
export const LOCK_FEED_TIMEOUT_MS = 1200;
export const LOCK_FEED_CLOSED_MS = 60 * 60_000;

/**
 * The stored Telegram state, read with a time cap. Start it in parallel with the build.
 * @param {Object} p
 * @param {Function} p.get - @vercel/blob get (injectable)
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{locks: Array<Object>, flow: Object}|null>} raw state.locks ([] when none) and state.flow ({} when none); null on failure / timeout
 */
export async function readStoredState({ get, timeoutMs = LOCK_FEED_TIMEOUT_MS }) {
  if (typeof get !== 'function') return null;
  let timer;
  try {
    const blob = await Promise.race([
      readBlob(get, LOCK_STATE_PATH),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); })
    ]);
    if (blob === 'timeout') return null;
    const state = blob && blob.text ? JSON.parse(blob.text) : {};
    return {
      locks: Array.isArray(state.locks) ? state.locks : [],
      flow: state.flow && typeof state.flow === 'object' ? state.flow : {}
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The stored lock list only (null on failure / timeout). Kept for existing callers. */
export async function readStoredLocks(opts) {
  const state = await readStoredState(opts);
  return state ? state.locks : null;
}

/** Whatever a store reader returned -> {locks, flow} or null. A bare array is a locks-only answer. */
export function asStoredState(raw) {
  if (Array.isArray(raw)) return { locks: raw, flow: {} };
  if (raw && typeof raw === 'object' && Array.isArray(raw.locks)) return { locks: raw.locks, flow: raw.flow && typeof raw.flow === 'object' ? raw.flow : {} };
  return null;
}

/**
 * 24h pulse from the stored state: flow counts via pulseOf, locked = locks created in 24h.
 * Null in -> null out; never throws.
 */
export function pulseFeed(state, nowMs) {
  if (!state) return null;
  try {
    const cutoff = nowMs - 24 * 3_600_000;
    const locked = normalizeLocks(state.locks, nowMs).filter((l) => Date.parse(l.lockedAt) >= cutoff).length;
    return pulseOf({ ...(state.flow || {}), locked }, nowMs);
  } catch {
    return null;
  }
}

/**
 * Compact top-N flag board for the REST payload, from the same rankFlags the Telegram board
 * uses. Always an array ([] when nothing ranks or on error). Stage is read verbatim.
 * @param {Object} payload - full build with `flagBoard`
 * @param {number} [size=3]
 */
export function boardFeed(payload, size = 3) {
  try {
    return rankFlags(payload && payload.flagBoard, payload && payload.symbols).slice(0, size).map((e) => {
      const lv = e.levels || {};
      return {
        ref: e.ref, sym: e.symbol, tf: e.tf, dir: e.dir, stage: e.stage, st: e.st,
        lv: {
          ent: lv.entry ?? null, stop: lv.stop ?? null, inv: lv.stop ?? null, tp1: lv.target ?? null,
          tp2: lv.tp2 ?? null, tp2src: lv.tp2Source ?? null, rr: lv.rr ?? null, cap: lv.cap ?? null
        },
        score: `${e.score}/${e.of}`, gate: e.gate, tfs: checklistLine(e.check)
      };
    });
  } catch {
    return [];
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
