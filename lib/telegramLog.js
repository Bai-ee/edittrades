/**
 * Telegram tracked record (docs/PLAN_TELEGRAM.md "Sent-alert and transition logs"): the
 * cron's sends and the engine's per-minute candidate transitions, appended to the public
 * Blob store so the tracker can pull them like the journal and served calls.
 *
 *   telegram/alerts/YYYY-MM-DD.jsonl       one line per alert the cron sent (alerts,
 *                                          tracked transitions, TP1/stop hits, nudges),
 *                                          plus one kind EXEC line per execution message
 *                                          the webhook sent (ticket, refused, result, PIN,
 *                                          /exec, /kill, /arm; T-3); never other command
 *                                          replies or health messages
 *   telegram/alerts/manifest.json          {schemaVersion:'telegram-alerts-manifest-1', baseUrl, days[], updatedAt}
 *   telegram/transitions/YYYY-MM-DD.jsonl  one line per candidate whose state or plan status
 *                                          changed since the previous run (diffCandidates)
 *   telegram/transitions/manifest.json     {schemaVersion:'telegram-transitions-manifest-1', ...}
 *
 * Lines are built field by field (no account, wallet, sizing or user fields); the sizing
 * rows of an alert's PLAN section are cut from the text excerpt, and a line with any
 * sensitive or credential-looking key is refused. Best effort: recordTelegramLogs never
 * throws and is capped at `timeoutMs`; it runs after the sends, so a failed log never
 * blocks one. TRACK_TELEGRAM_LOG=false disables it.
 */

import { appendJsonlDay } from './blobJsonl.js';
import { candidateSnapshot, alertSignature, roomOwnerId } from './telegram.js';
import { findSensitiveKeys } from '../scripts/tracker/records.js';
import { findSecretLike } from './servedCalls.js';

export const ALERTS_MANIFEST_PATH = 'telegram/alerts/manifest.json';
export const ALERTS_MANIFEST_SCHEMA = 'telegram-alerts-manifest-1';
export const TRANSITIONS_MANIFEST_PATH = 'telegram/transitions/manifest.json';
export const TRANSITIONS_MANIFEST_SCHEMA = 'telegram-transitions-manifest-1';
export const TELEGRAM_LOG_TIMEOUT_MS = 2000;
export const ALERT_TEXT_CHARS = 200;

export const alertsDayPath = (day) => `telegram/alerts/${day}.jsonl`;
export const transitionsDayPath = (day) => `telegram/transitions/${day}.jsonl`;
export const alertLogKey = (row) => row.id;
export const transitionKey = (row) => `${row.candidateId}|${row.at}`;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (isNum(v) ? v : null);

/** Bold verdict and its eta from an alert's HTML ("<b>BE READY (3m)</b>"), else nulls. */
export function verdictOf(text) {
  const m = String(text || '').match(/<b>(GET IN NOW|BE READY|WAIT|STAND DOWN)(?: \((\d+)m\))?<\/b>/);
  return { verdict: m ? m[1] : null, etaMin: m && m[2] ? Number(m[2]) : null };
}

/** Plain-text excerpt: tags and sizing rows (size · lev, loss$) removed, entities decoded, `max` chars. */
export function textExcerpt(html, max = ALERT_TEXT_CHARS) {
  return String(html || '')
    .split('\n').filter((l) => !/size · lev|loss\$/.test(l)).join('\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .slice(0, max);
}

/**
 * One sent-alert log line.
 * @param {Object} alert - a diffAlerts alert ({kind, symbol, candidateId, text, event?, trackLevels?})
 * @param {Object} o
 * @param {Object} o.payload - the compact payload the alert came from
 * @param {string} o.id
 * @param {number} o.sentAtMs
 * @param {boolean} o.silent - quiet hours (disable_notification)
 * @param {string|null} o.level - prefs.level
 * @param {Set<string>} [o.trackedIds] - candidates tracked as of the previous run
 * @param {boolean} [o.delivered] - at least one sendMessage returned ok
 */
export function alertLogLine(alert, { payload, id, sentAtMs, silent, level, trackedIds = new Set(), delivered = true }) {
  const a = isObj(alert) ? alert : {};
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const s = a.symbol && isObj(syms[a.symbol]) ? syms[a.symbol] : null;
  const snap = s && a.candidateId ? candidateSnapshot(a.symbol, s, a.candidateId) : null;
  const tl = isObj(a.trackLevels) ? a.trackLevels : {};
  const rec = s && isObj(s.flagRecommendation) ? s.flagRecommendation : {};
  const plan = s && isObj(s.flagTradePlan) && s.flagTradePlan.candidateId === a.candidateId ? s.flagTradePlan : null;
  const setup = isObj(rec.setup) && rec.setup.candidateId === a.candidateId ? rec.setup : null;
  const levels = plan && isNum(plan.grossRR) ? plan : setup;
  const room = isObj(rec.room) && a.candidateId && roomOwnerId(rec, s && s.flagTradePlan) === a.candidateId ? rec.room : null;
  const pick = (k, tk = k) => (snap && isNum(snap[k]) ? snap[k] : num(tl[tk]));
  const timeframe = (snap && snap.timeframe) || tl.timeframe || null;
  const direction = (snap && snap.direction) || tl.direction || null;
  const breakout = pick('breakoutLevel');
  const { verdict, etaMin } = verdictOf(a.text);
  return {
    id,
    sentAt: new Date(sentAtMs).toISOString(),
    kind: typeof a.kind === 'string' ? a.kind : null,
    event: typeof a.event === 'string' ? a.event : null,
    symbol: typeof a.symbol === 'string' ? a.symbol : null,
    timeframe,
    direction,
    candidateId: typeof a.candidateId === 'string' ? a.candidateId : null,
    signature: a.symbol && timeframe && (breakout !== null || pick('entry') !== null)
      ? alertSignature(a.symbol, { timeframe, direction, breakoutLevel: breakout, entry: pick('entry') }) : null,
    verdict,
    etaMin,
    breakout,
    invalidation: pick('invalidation'),
    entry: pick('entry'),
    stop: pick('stop'),
    tp1: pick('tp1'),
    grossRR: levels ? num(levels.grossRR) : null,
    netRR: levels ? num(levels.netRR) : null,
    roomR: room ? num(room.r) : null,
    closedThrough: payload && typeof payload.closedThrough === 'string' ? payload.closedThrough : null,
    silent: Boolean(silent),
    level: typeof level === 'string' ? level : null,
    tracked: a.kind === 'TRACK' || a.kind === 'NUDGE' || Boolean(a.candidateId && trackedIds.has(a.candidateId)),
    delivered: Boolean(delivered),
    text: textExcerpt(a.text)
  };
}

/** Kinds a sent-alert line may carry: the cron's alert kinds plus EXEC (execution messages). */
export const EXEC_LOG_KIND = 'EXEC';

/**
 * Excerpt of an execution message: tags removed, then sizing / money rows (size, lev,
 * max loss, fees, margin, loss today, PnL) dropped, entities decoded, `max` chars. It never
 * carries a PIN (no card prints one).
 */
export function execExcerpt(html, max = ALERT_TEXT_CHARS) {
  return String(html || '').replace(/<[^>]*>/g, '')
    .split('\n').filter((l) => !/^\s*(size|lev|max loss|fees|margin|loss today|loss\/trade|loss\/day|max size|PnL)\b/i.test(l)).join('\n')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .slice(0, max);
}

/**
 * One kind EXEC sent-alert line for an execution message (same keys as alertLogLine,
 * plus `mode`). Levels only; no size, account or PIN field.
 * @param {Object} o - {id, sentAtMs, event, symbol?, timeframe?, direction?, candidateId?, entry?, stop?, tp1?, mode?, delivered?, text}
 */
export function execLogLine({ id, sentAtMs, event, symbol = null, timeframe = null, direction = null, candidateId = null, entry = null, stop = null, tp1 = null, mode = null, delivered = true, text = '' }) {
  return {
    id, sentAt: new Date(sentAtMs).toISOString(), kind: EXEC_LOG_KIND, event: typeof event === 'string' ? event : null,
    symbol: typeof symbol === 'string' ? symbol : null, timeframe: typeof timeframe === 'string' ? timeframe : null,
    direction: direction === 'long' || direction === 'short' ? direction : null,
    candidateId: typeof candidateId === 'string' ? candidateId : null, signature: null, verdict: null, etaMin: null,
    breakout: null, invalidation: null, entry: num(entry), stop: num(stop), tp1: num(tp1), grossRR: null, netRR: null, roomR: null,
    closedThrough: null, silent: false, level: null, tracked: false, delivered: Boolean(delivered),
    mode: mode === 'dry' || mode === 'live' ? mode : null,
    text: execExcerpt(text)
  };
}

/** Throws when a row carries a sensitive (account/wallet/...) or credential-looking key or value. */
export function assertSafeRows(rows) {
  for (const r of rows) {
    if (findSensitiveKeys(r).length || findSecretLike(r).length) throw new Error('refusing to write: sensitive keys in a telegram log row');
  }
  return rows;
}

function byDay(rows, timeKey) {
  const out = new Map();
  for (const r of rows) {
    const day = String(r[timeKey]).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!out.has(day)) out.set(day, []);
    out.get(day).push(r);
  }
  return out;
}

async function appendAll(store, rows, { timeKey, dayPath, manifestPath, manifestSchema, keyOf, nowIso }) {
  let added = 0;
  for (const [day, dayRows] of byDay(rows, timeKey)) {
    const r = await appendJsonlDay(store, { day, dayPath: dayPath(day), manifestPath, manifestSchema, rows: dayRows, keyOf, nowIso });
    added += r.added;
  }
  return added;
}

/**
 * Append sent-alert and transition lines. Never throws; resolves within `timeoutMs`.
 * @param {{alerts?: Array<Object>, transitions?: Array<Object>}} lines
 * @param {Object} o
 * @param {{get: Function, put: Function, head?: Function}} o.store
 * @param {Object} [o.env=process.env]
 * @param {number} [o.nowMs=Date.now()]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{alerts:number, transitions:number, skipped:string|null}>}
 */
export async function recordTelegramLogs({ alerts = [], transitions = [] } = {}, { store, env = process.env, nowMs = Date.now(), timeoutMs = TELEGRAM_LOG_TIMEOUT_MS } = {}) {
  const none = (skipped) => ({ alerts: 0, transitions: 0, skipped });
  try {
    if (env && env.TRACK_TELEGRAM_LOG === 'false') return none('disabled');
    if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') return none('no_store');
    if (!alerts.length && !transitions.length) return none('nothing');
    try { assertSafeRows([...alerts, ...transitions]); } catch { return none('sensitive_guard'); }
    const nowIso = new Date(nowMs).toISOString();
    const work = (async () => ({
      alerts: alerts.length ? await appendAll(store, alerts, { timeKey: 'sentAt', dayPath: alertsDayPath, manifestPath: ALERTS_MANIFEST_PATH, manifestSchema: ALERTS_MANIFEST_SCHEMA, keyOf: alertLogKey, nowIso }) : 0,
      transitions: transitions.length ? await appendAll(store, transitions, { timeKey: 'at', dayPath: transitionsDayPath, manifestPath: TRANSITIONS_MANIFEST_PATH, manifestSchema: TRANSITIONS_MANIFEST_SCHEMA, keyOf: transitionKey, nowIso }) : 0,
      skipped: null
    }))();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
    let result;
    try { result = await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
    if (!result) { work.catch(() => {}); return none('timeout'); }
    return result;
  } catch (err) {
    return none(`error:${err && err.name ? String(err.name).replace(/[^A-Za-z]/g, '').slice(0, 40) : 'Error'}`);
  }
}
