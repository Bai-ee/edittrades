/**
 * Order tickets (T-3, docs/PLAN_TELEGRAM_EXECUTION.md "Contract between agents").
 *
 * Blob `execution/tickets.json` {schemaVersion, tickets:{<nonce>: {nonce, order, userId,
 * createdAt, expiresAt, usedAt}}}. Nonce = 8 hex chars, TTL 60 s, single use. Every write
 * is ETag-guarded (updateBlob) WITHOUT the forced-overwrite fallback, so two confirms
 * racing on one nonce cannot both consume it. Tickets older than PRUNE_AFTER_MS are
 * dropped on each write. Orders hold no secret (no key, no PIN, no wallet).
 */

import crypto from 'crypto';
import { readBlob, updateBlob } from '../blobJsonl.js';

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
      doc.tickets[nonce] = { nonce, order, userId: userId === null ? null : String(userId), createdAt: new Date(nowMs).toISOString(), expiresAt, usedAt: null };
      return write(doc);
    }, { forceOnExhaust: false });
    return { ok: true, nonce, expiresAt };
  } catch (err) {
    return { ok: false, error: String((err && err.name) || 'Error') };
  }
}

function checkTicket(t, { nowMs, userId }) {
  if (!t) return 'nonce_unknown';
  if (t.userId !== null && userId !== undefined && userId !== null && t.userId !== String(userId)) return 'nonce_unknown';
  if (t.usedAt) return 'nonce_used';
  if (!(Date.parse(t.expiresAt) > nowMs)) return 'nonce_expired';
  return null;
}

/** Read a ticket without consuming it. Never throws. */
export async function peekTicket(store, nonce, { nowMs, userId = null }) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'nonce_invalid' };
  try {
    const blob = await readBlob(store.get, TICKETS_PATH);
    const t = parse(blob ? blob.text : null).tickets[nonce];
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
export async function consumeTicket(store, nonce, { nowMs, userId = null }) {
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'nonce_invalid' };
  let reason = null;
  let order = null;
  try {
    const { written } = await updateBlob(store, TICKETS_PATH, 'application/json', (text) => {
      const doc = parse(text);
      const t = doc.tickets[nonce];
      reason = checkTicket(t, { nowMs, userId });
      if (reason) return null;
      order = t.order;
      doc.tickets[nonce] = { ...t, usedAt: new Date(nowMs).toISOString() };
      return write(prune(doc, nowMs));
    }, { forceOnExhaust: false });
    if (!written) return { ok: false, reason: reason || 'nonce_unknown' };
    return { ok: true, order };
  } catch {
    return { ok: false, reason: 'tickets_unavailable' };
  }
}
