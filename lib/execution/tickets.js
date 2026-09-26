/**
 * Order tickets (T-3, docs/PLAN_TELEGRAM_EXECUTION.md "Contract between agents").
 *
 * Blob `execution/tickets.json` {schemaVersion, tickets:{<nonce>: {nonce, order, ownerHash,
 * createdAt, expiresAt, usedAt}}}. The store is public: the ticket carries `ownerHash`
 * (idHash of the Telegram user id, a pseudonym, not a secret), never the id itself. Nonce = 8 hex chars, TTL 60 s, single use. Every write
 * is ETag-guarded (updateBlob) WITHOUT the forced-overwrite fallback, so two confirms
 * racing on one nonce cannot both consume it. Tickets older than PRUNE_AFTER_MS are
 * dropped on each write. Orders hold no secret (no key, no PIN, no wallet).
 */

import crypto from 'crypto';
import { readBlobFresh, updateBlob } from '../blobJsonl.js';
import { idHash } from './audit.js';

export const TICKETS_PATH = 'execution/tickets.json';
export const TICKETS_SCHEMA = 'execution-tickets-1';
export const TICKET_TTL_MS = 60_000;
export const PRUNE_AFTER_MS = 10 * 60_000;
export const NONCE_RE = /^[0-9a-f]{8}$/;

export const newNonce = (randomBytes = crypto.randomBytes) => Buffer.from(randomBytes(4)).toString('hex');

function parse(text) {
  let s = null;
  try { s = text ? JSON.parse(text) : null; } catch { s = null; }
  const tickets = s && s.tickets && typeof s.tickets === 'object' && !Array.isArray(s.tickets) ? s.tickets : {};
  return { schemaVersion: TICKETS_SCHEMA, tickets };
}

function prune(doc, nowMs) {
  const tickets = {};
  for (const [k, t] of Object.entries(doc.tickets)) {
    if (t && Date.parse(t.expiresAt) > nowMs - PRUNE_AFTER_MS) tickets[k] = t;
  }
  return { ...doc, tickets };
}

const write = (doc) => `${JSON.stringify(doc)}\n`;

/**
 * Tickets this process wrote, by nonce (TTL = the ticket's own). The Blob store is
 * eventually consistent across regions: on 2026-09-26 a fresh read (get + head + refetch)
 * still returned a body without a ticket written 22 s and 44 s earlier, so a valid
 * /confirm answered nonce_unknown. A warm function instance usually serves both the
 * /order and the /confirm, so the ticket it just stored is the first place to look; a
 * cold instance falls back to the fresh read with a few retries (READ_RETRIES).
 */
const recent = new Map();
export const READ_RETRIES = 3;
export const READ_RETRY_MS = 700;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function rememberTicket(t) { recent.set(t.nonce, t); }
function recentTicket(nonce, nowMs) {
  for (const [k, t] of recent) if (!(Date.parse(t.expiresAt) > nowMs - PRUNE_AFTER_MS)) recent.delete(k);
  return recent.get(nonce) || null;
}
/** Test hook: forget every remembered ticket (simulates a cold instance). */
export function forgetRecentTickets() { recent.clear(); }
const readDefaults = { retries: READ_RETRIES, retryMs: READ_RETRY_MS };
/** Test hook: retry count / delay for the fresh read (tests pass retryMs 0). */
export function configureTicketReads({ retries, retryMs } = {}) {
  if (Number.isInteger(retries) && retries >= 0) readDefaults.retries = retries;
  if (Number.isFinite(retryMs) && retryMs >= 0) readDefaults.retryMs = retryMs;
}

/** Fresh read of the tickets doc; when `nonce` is absent, re-read up to `retries` times. */
async function readTicketsDoc(store, nonce, { retries = readDefaults.retries, retryMs = readDefaults.retryMs } = {}) {
  let doc = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0 && retryMs > 0) await sleep(retryMs);
    const blob = await readBlobFresh(store, TICKETS_PATH);
    doc = parse(blob ? blob.text : null);
    if (doc.tickets[nonce]) break;
  }
  return doc;
}

/**
 * Store a new ticket. Never throws.
 * @returns {Promise<{ok:boolean, nonce?:string, expiresAt?:string, error?:string}>}
 */
export async function storeTicket(store, order, { nowMs, userId = null, randomBytes = crypto.randomBytes }) {
  try {
    let nonce = newNonce(randomBytes);
    const expiresAt = new Date(nowMs + TICKET_TTL_MS).toISOString();
    await updateBlob(store, TICKETS_PATH, 'application/json', (text) => {
      const doc = prune(parse(text), nowMs);
      for (let i = 0; doc.tickets[nonce] && i < 5; i++) nonce = newNonce(randomBytes);
      if (doc.tickets[nonce]) throw new Error('nonce collision');
      doc.tickets[nonce] = { nonce, order, ownerHash: userId === null || userId === undefined ? null : idHash(String(userId)), createdAt: new Date(nowMs).toISOString(), expiresAt, usedAt: null };
      return write(doc);
    }, { forceOnExhaust: false });
    rememberTicket({ nonce, order, ownerHash: userId === null || userId === undefined ? null : idHash(String(userId)), createdAt: new Date(nowMs).toISOString(), expiresAt, usedAt: null });
    return { ok: true, nonce, expiresAt };
  } catch (err) {
    return { ok: false, error: String((err && err.name) || 'Error') };
  }
}

function checkTicket(t, { nowMs, userId }) {
  if (!t) return 'nonce_unknown';
  const owner = t.ownerHash ?? null;
  if (owner !== null && userId !== undefined && userId !== null && owner !== idHash(String(userId))) return 'nonce_unknown';
  if (t.usedAt) return 'nonce_used';
  if (!(Date.parse(t.expiresAt) > nowMs)) return 'nonce_expired';
  return null;
}

/** Read a ticket without consuming it. Never throws. */
export async function peekTicket(store, nonce, { nowMs, userId = null, retries, retryMs } = {}) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'nonce_invalid' };
  try {
    // This instance's own write first (see `recent`), then the fresh read with retries.
    let t = recentTicket(nonce, nowMs);
    if (!t) t = (await readTicketsDoc(store, nonce, { retries, retryMs })).tickets[nonce] || null;
    const reason = checkTicket(t, { nowMs, userId });
    return reason ? { ok: false, reason } : { ok: true, ticket: t };
  } catch {
    return { ok: false, reason: 'tickets_unavailable' };
  }
}

/**
 * Mark a ticket used, atomically (ETag-guarded, no forced overwrite). Exactly one caller
 * gets ok:true for a nonce. Never throws.
 * @returns {Promise<{ok:boolean, order?:Object, reason?:string}>}
 */
export async function consumeTicket(store, nonce, { nowMs, userId = null, retries, retryMs } = {}) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'nonce_invalid' };
  let reason = null;
  let order = null;
  try {
    // A remembered ticket that is already used on this instance answers without a write.
    const mine = recentTicket(nonce, nowMs);
    if (mine && mine.usedAt) return { ok: false, reason: 'nonce_used' };
    // Make sure the doc we are about to guard-write can see the nonce (stale bodies).
    if (!mine) await readTicketsDoc(store, nonce, { retries, retryMs });
    const { written } = await updateBlob(store, TICKETS_PATH, 'application/json', (text) => {
      const doc = parse(text);
      // The body may still lag the write this instance made: the remembered ticket is
      // authoritative for its own nonce (it is what we wrote), so put it back before the check.
      if (!doc.tickets[nonce] && mine) doc.tickets[nonce] = mine;
      const t = doc.tickets[nonce];
      reason = checkTicket(t, { nowMs, userId });
      if (reason) return null;
      order = t.order;
      doc.tickets[nonce] = { ...t, usedAt: new Date(nowMs).toISOString() };
      return write(prune(doc, nowMs));
    }, { forceOnExhaust: false });
    if (!written) return { ok: false, reason: reason || 'nonce_unknown' };
    if (mine) rememberTicket({ ...mine, usedAt: new Date(nowMs).toISOString() });
    return { ok: true, order };
  } catch {
    return { ok: false, reason: 'tickets_unavailable' };
  }
}
