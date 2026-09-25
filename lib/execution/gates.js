/**
 * Execution gates (T-3, docs/PLAN_TELEGRAM_EXECUTION.md "Non-negotiables").
 *
 * Env parsing, caps, owner allowlist, PIN compare, and the kill switch. Server-side only;
 * nothing here signs or reads a wallet. Every check returns reasons, never throws.
 *
 * Env (all read per call, never cached):
 *   TRADE_EXECUTION_ENABLED=true          master switch (anything else = off)
 *   EXECUTION_MODE=dry|live               default dry; any other value refuses
 *   EXECUTION_OWNER_IDS                   comma list of Telegram user ids allowed to execute
 *   EXECUTION_PIN                         4-8 digits; compared constant-time, never logged
 *   EXECUTION_KILL=true                   env kill (cannot be cleared by /arm)
 *   EXECUTION_MAX_SIZE_USD, EXECUTION_MAX_LEVERAGE, EXECUTION_MAX_LOSS_USD_PER_TRADE,
 *   EXECUTION_MAX_DAILY_LOSS_USD          required; missing or invalid -> refuse
 *   EXECUTION_MAX_OPEN_POSITIONS          default 2
 *
 * Blob `execution/kill.json` (public store, fixed path):
 *   {schemaVersion, killed, reason, at, until|null, wrongPin:{count, since}}
 * `until` set = auto-kill that lapses (3 wrong PINs -> 1 h). A blob read failure counts
 * as killed (fail closed).
 */

import crypto from 'crypto';
import { readBlob, updateBlob } from '../blobJsonl.js';

export const KILL_PATH = 'execution/kill.json';
export const KILL_SCHEMA = 'execution-kill-1';
export const DEFAULT_MAX_OPEN_POSITIONS = 2;
export const WRONG_PIN_LIMIT = 3;
export const WRONG_PIN_WINDOW_MS = 60 * 60 * 1000;
export const AUTO_KILL_MS = 60 * 60 * 1000;
export const PIN_RE = /^\d{4,8}$/;

export const CAP_ENV = Object.freeze({
  maxSizeUsd: 'EXECUTION_MAX_SIZE_USD',
  maxLeverage: 'EXECUTION_MAX_LEVERAGE',
  maxLossUsdPerTrade: 'EXECUTION_MAX_LOSS_USD_PER_TRADE',
  maxDailyLossUsd: 'EXECUTION_MAX_DAILY_LOSS_USD',
  maxOpenPositions: 'EXECUTION_MAX_OPEN_POSITIONS'
});

const posNum = (v) => {
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Parsed execution config. `reasons` lists every config problem (empty = usable).
 * Never includes the PIN value.
 * @param {Object} [env=process.env]
 */
export function readExecutionConfig(env = process.env) {
  const e = env || {};
  const reasons = [];
  const enabled = e.TRADE_EXECUTION_ENABLED === 'true';
  if (!enabled) reasons.push('execution_disabled');

  const rawMode = typeof e.EXECUTION_MODE === 'string' && e.EXECUTION_MODE.trim() ? e.EXECUTION_MODE.trim().toLowerCase() : 'dry';
  const mode = rawMode === 'dry' || rawMode === 'live' ? rawMode : null;
  if (!mode) reasons.push('mode_invalid');

  const pinConfigured = typeof e.EXECUTION_PIN === 'string' && PIN_RE.test(e.EXECUTION_PIN);
  if (!pinConfigured) reasons.push('pin_not_configured');

  const ownerIds = String(e.EXECUTION_OWNER_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  if (!ownerIds.length) reasons.push('owner_not_configured');

  const caps = {};
  for (const [k, name] of Object.entries(CAP_ENV)) {
    if (k === 'maxOpenPositions' && (e[name] === undefined || e[name] === '')) { caps[k] = DEFAULT_MAX_OPEN_POSITIONS; continue; }
    const n = posNum(e[name]);
    caps[k] = k === 'maxOpenPositions' && n !== null ? Math.floor(n) : n;
    if (caps[k] === null) reasons.push(`cap_missing:${name}`);
  }

  return { enabled, mode: mode || 'dry', modeValid: Boolean(mode), pinConfigured, ownerIds, caps, killEnv: e.EXECUTION_KILL === 'true', reasons };
}

/** Timing-safe string compare via SHA-256 digests (equal lengths, no length leak). */
export function safeCompare(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** True only when a PIN is configured and `provided` equals it (constant-time). */
export function pinMatches(provided, env = process.env) {
  const expected = env && env.EXECUTION_PIN;
  if (typeof expected !== 'string' || !PIN_RE.test(expected)) return false;
  const ok = safeCompare(typeof provided === 'string' || typeof provided === 'number' ? String(provided).trim() : '', expected);
  return ok && PIN_RE.test(String(provided).trim());
}

/** Telegram user id is on EXECUTION_OWNER_IDS. */
export function isOwner(cfg, userId) {
  if (userId === undefined || userId === null) return false;
  return cfg.ownerIds.includes(String(userId));
}

// ---------------------------------------------------------------- kill switch

function parseKill(text) {
  let s = null;
  try { s = text ? JSON.parse(text) : null; } catch { s = null; }
  const obj = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const wp = obj.wrongPin && typeof obj.wrongPin === 'object' ? obj.wrongPin : {};
  return {
    schemaVersion: KILL_SCHEMA,
    killed: obj.killed === true,
    reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 80) : null,
    at: typeof obj.at === 'string' ? obj.at : null,
    until: typeof obj.until === 'string' ? obj.until : null,
    wrongPin: { count: Number.isInteger(wp.count) && wp.count > 0 ? wp.count : 0, since: typeof wp.since === 'string' ? wp.since : null }
  };
}

const killText = (s) => `${JSON.stringify(s, null, 2)}\n`;

/** {ok, state} from Blob, or {ok:false, error}. Missing blob = not killed. */
export async function readKillState(store) {
  try {
    const blob = await readBlob(store.get, KILL_PATH);
    return { ok: true, state: parseKill(blob ? blob.text : null) };
  } catch (err) {
    return { ok: false, state: null, error: String((err && err.name) || 'Error') };
  }
}

/**
 * Is execution killed right now? Env kill wins; a blob `until` in the past lapses; an
 * unreadable blob counts as killed.
 * @returns {{active:boolean, source:'env'|'blob'|'unavailable'|null, reason:string|null, until:string|null}}
 */
export function killStatus(cfg, killRead, nowMs) {
  if (cfg.killEnv) return { active: true, source: 'env', reason: 'EXECUTION_KILL', until: null };
  if (!killRead || !killRead.ok) return { active: true, source: 'unavailable', reason: 'kill_state_unavailable', until: null };
  const s = killRead.state;
  if (!s.killed) return { active: false, source: null, reason: null, until: null };
  if (s.until && Date.parse(s.until) <= nowMs) return { active: false, source: null, reason: null, until: null };
  return { active: true, source: 'blob', reason: s.reason, until: s.until };
}

/** Set the blob kill flag (always lands: forced overwrite on repeated ETag races). */
export async function setKill(store, { reason = 'manual', untilMs = null } = {}, nowMs) {
  try {
    await updateBlob(store, KILL_PATH, 'application/json', (text) => {
      const s = parseKill(text);
      return killText({ ...s, killed: true, reason: String(reason).slice(0, 80), at: new Date(nowMs).toISOString(), until: untilMs ? new Date(untilMs).toISOString() : null });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.name) || 'Error') };
  }
}

/** Clear the blob kill flag and the wrong-PIN counter (env kill is unaffected). */
export async function clearKill(store, nowMs) {
  try {
    await updateBlob(store, KILL_PATH, 'application/json', (text) => {
      const s = parseKill(text);
      return killText({ ...s, killed: false, reason: null, at: new Date(nowMs).toISOString(), until: null, wrongPin: { count: 0, since: null } });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.name) || 'Error') };
  }
}

/**
 * Count a wrong PIN. The WRONG_PIN_LIMIT-th within WRONG_PIN_WINDOW_MS sets an auto-kill
 * for AUTO_KILL_MS and resets the counter.
 * @returns {Promise<{ok:boolean, count:number, killed:boolean}>}
 */
export async function recordWrongPin(store, nowMs) {
  let count = 0;
  let killed = false;
  try {
    await updateBlob(store, KILL_PATH, 'application/json', (text) => {
      const s = parseKill(text);
      const since = s.wrongPin.since && nowMs - Date.parse(s.wrongPin.since) < WRONG_PIN_WINDOW_MS ? s.wrongPin.since : null;
      count = (since ? s.wrongPin.count : 0) + 1;
      if (count >= WRONG_PIN_LIMIT) {
        killed = true;
        return killText({ ...s, killed: true, reason: 'wrong_pin_x3', at: new Date(nowMs).toISOString(), until: new Date(nowMs + AUTO_KILL_MS).toISOString(), wrongPin: { count: 0, since: null } });
      }
      return killText({ ...s, wrongPin: { count, since: since || new Date(nowMs).toISOString() } });
    });
    return { ok: true, count, killed };
  } catch {
    return { ok: false, count, killed };
  }
}

/** Reset the wrong-PIN counter after a correct PIN (no write when already zero). */
export async function resetWrongPin(store) {
  try {
    await updateBlob(store, KILL_PATH, 'application/json', (text) => {
      const s = parseKill(text);
      if (!s.wrongPin.count) return null;
      return killText({ ...s, wrongPin: { count: 0, since: null } });
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
