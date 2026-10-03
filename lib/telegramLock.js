/**
 * Telegram side of the trade lock (docs/OWNER_DECISIONS_2026-10-02_TRADE_LOCK.md, phase L2).
 * Lock card, lock keyboard, state.locks changes, the cron's per-tick lock diff, and the
 * suppression that keeps a locked candidate's generic / Track alerts from re-describing
 * the trade off the live rebuild. The lock model itself is lib/tradeLock.js.
 *
 * callback_data (<ref> = 8-hex shortRef):
 *   lock:<ref>    lock the candidate the ref resolves to (levels freeze now)
 *   lnow:<ref>    "now?": the lock's state, verdict, checklist and delta since the lock
 *   ltook:<ref>   I'm in: the lock becomes filled at the mark (frozen stop / TP1 tracked)
 *   unlock:<ref>  end the lock
 */
import { escapeHtml, msgHeader, codeBlock, joinSections, fmtLvl as lvl, fmtAge } from './telegram.js';
import {
  createLock, evaluateLock, fillLock, unlockLock, lockVerdict, checklistLine, confluenceDelta, lockR,
  normalizeLocks, openLocks, LOCK_DEFAULTS, LOCK_TIMEFRAMES
} from './tradeLock.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Alert kinds a lock replaces for its own candidate (the lock's card is the one message). */
export const LOCK_SUPPRESSES = Object.freeze(['WATCH', 'TRIGGERING', 'BREAKOUT', 'SETUP', 'GOOD', 'GOOD_ENDED', 'TRACK']);

const VERDICT_DOT = { TAKE: '🟢', WAIT: '🟡', PASS: '🔴', 'IN TRADE': '🔵', DONE: '⚪' };
/** Flow vocabulary (docs/PLAN_FLAG_FLOW.md): open states `LOCK · X` / `IN`, terminal states `DONE · X`. */
const STATUS_TITLE = {
  armed: 'LOCK · ARMED', confirmed: 'LOCK · CONFIRMED', filled: 'IN', missed: '❌ DONE · MISSED', invalidated: '❌ DONE · INVALIDATED',
  expired: '⚪ DONE · EXPIRED', stopped: '❌ DONE · STOPPED', tp1: '✅ DONE · TARGET HIT', unlocked: 'LOCK · UNLOCKED', ended: 'LOCK · ENDED'
};
/** A DONE title carries its own marker; every other title gets the 🔒 prefix. */
const withLockMark = (t) => (/^(✅|❌|⚪)/u.test(t) ? t : `🔒 ${t}`);

/** The live price a lock card reads: the mark when ok, else the 1m close. */
const livePx = (s) => (isObj(s) && isObj(s.mark) && s.mark.status === 'ok' && isNum(s.mark.price) ? s.mark.price : (isObj(s) && isNum(s.price) ? s.price : null));

/**
 * The lock card (also the "now?" answer, D4): verdict line, frozen levels, checklist across
 * every timeframe, delta since the lock, thesis warning, time left.
 * @param {Object} lock
 * @param {Object|null} s - payload symbols.<SYM> for the live price (optional)
 * @param {number} nowMs
 * @param {string} [title] - header kind, default `LOCK · <STATUS>`
 */
export function formatLockCard(lock, s, nowMs, title = null) {
  const v = lockVerdict(lock);
  const lv = lock.levels || {};
  const px = livePx(s);
  const head = msgHeader(VERDICT_DOT[v.verdict] || '⚪', lock.symbol, lock.timeframe, lock.direction, escapeHtml(withLockMark(title || STATUS_TITLE[lock.status] || `LOCK · ${lock.status}`)));
  const call = `<b>${escapeHtml(v.verdict)}</b> — ${escapeHtml(v.reason)}`;
  const levels = codeBlock([
    ['trigger', lvl(lv.trigger)],
    ['void', lvl(lv.invalidation)],
    ['entry', lvl(lv.entry)],
    ['stop', lvl(lv.stop)],
    ['TP1', lvl(lv.tp1)],
    ['no-chase cap', `${lvl(lv.cap)}${lock.capSource === 'atr' ? ` (${LOCK_DEFAULTS.extensionAtr} ATR)` : ' (1R)'}`],
    lock.status === 'filled' ? ['fill', lvl(lock.fillPrice)] : null,
    px !== null ? ['now', lvl(px)] : null,
    lock.status === 'filled' && px !== null ? ['R now', fmtR(lockR(lock, px))] : null
  ]);
  const c = lock.conf || {};
  const delta = confluenceDelta(lock.confAtLock, lock.conf);
  const conf = [
    `Confluence ${isNum(c.score) ? `${c.score}/${c.of}` : 'n/a'} · gate ${c.gate ? 'pass' : 'not met'}`,
    `<code>${escapeHtml(checklistLine(c))}</code>`,
    c.support && c.support.length ? `with: ${escapeHtml(c.support.join(', '))}` : null,
    !c.gate && c.missing && c.missing.length ? `missing: ${escapeHtml(c.missing.join(', '))}` : null,
    `since lock: ${escapeHtml(delta.length ? delta.join(' · ') : 'no change')}`
  ].filter(Boolean).join('\n');
  const thesis = lock.thesis && lock.thesis.broken && lock.thesis.broken.length
    ? `⚠️ Thesis warning: ${escapeHtml(lock.thesis.broken.join('/'))} closed on the wrong side of EMA200. Levels stay locked; your call.`
    : null;
  const open = ['armed', 'confirmed'].includes(lock.status);
  const left = Date.parse(lock.expiresAt) - nowMs;
  const timing = open
    ? `Locked ${fmtAge(lock.lockedAt, nowMs)} · expires in ${fmtSpan(left)} unless filled`
    : `Locked ${fmtAge(lock.lockedAt, nowMs)}`;
  return joinSections([head, call, levels, conf, thesis, escapeHtml(timing)]);
}

/** 754_000 -> "12 min"; 5_400_000 -> "1 h 30 min"; 2 days -> "2 d"; <= 0 -> "under a minute". */
export function fmtSpan(ms) {
  if (!isNum(ms) || ms < 60_000) return 'under a minute';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} d`;
}

const fmtR = (v) => (isNum(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}R` : 'n/a');

/** Buttons under a lock card. Open + unfilled: Now? · I'm in · Unlock; filled: Now? · Unlock; closed: none. */
export function lockKeyboard(lock) {
  if (!isObj(lock) || !['armed', 'confirmed', 'filled'].includes(lock.status)) return null;
  const ref = lock.ref;
  const row = [{ text: 'Now?', callback_data: `lnow:${ref}` }];
  if (lock.status !== 'filled') row.push({ text: "I'm in", callback_data: `ltook:${ref}` });
  row.push({ text: 'Unlock', callback_data: `unlock:${ref}` });
  return { inline_keyboard: [row, [{ text: `Chart ${lock.timeframe}`, callback_data: `chart:${lock.symbol}:${lock.timeframe}` }]] };
}

/**
 * Apply a lock change to stored state text (same contract as applyTrackChange).
 *   lock    add `change.lock` (already open for the ref -> 'already'; LOCK_DEFAULTS.maxLocks open -> 'full')
 *   fill    ref -> filled at change.price      unlock  ref -> unlocked
 * @returns {{text:string, result:string, entry:Object|null}}
 */
export function applyLockChange(text, change, nowMs, parse) {
  const state = parse(text);
  const list = normalizeLocks(state.locks, nowMs);
  const ref = change.ref || (change.lock && change.lock.ref);
  const idx = list.findIndex((l) => l.ref === ref && ['armed', 'confirmed', 'filled'].includes(l.status));
  let result;
  let entry = idx === -1 ? null : list[idx];
  if (change.action === 'lock') {
    if (idx !== -1) result = 'already';
    else if (openLocks(list).length >= LOCK_DEFAULTS.maxLocks) result = 'full';
    else { list.push(change.lock); entry = change.lock; result = 'locked'; }
  } else if (change.action === 'fill' || change.action === 'unlock') {
    if (idx === -1) result = 'not_locked';
    else {
      const r = change.action === 'fill' ? fillLock(list[idx], nowMs, change.price) : unlockLock(list[idx], nowMs);
      result = r.ok ? (change.action === 'fill' ? 'filled' : 'unlocked') : 'noop';
      list[idx] = r.lock;
      entry = r.lock;
    }
  } else result = 'noop';
  state.locks = list;
  return { text: `${JSON.stringify(state, null, 2)}\n`, result, entry };
}

/** The alert title for one lock event. */
const EVENT_TITLE = {
  confirmed: 'LOCK · CONFIRMED', filled: 'IN', missed: '❌ DONE · MISSED', invalidated: '❌ DONE · INVALIDATED', expired: '⚪ DONE · EXPIRED',
  stopped: '❌ DONE · STOPPED', tp1: '✅ DONE · TARGET HIT', ended: 'LOCK · ENDED', thesis_broken: 'LOCK · THESIS WARNING',
  gate_lost: 'LOCK · CONFLUENCE FADING', gate_regained: 'LOCK · CONFLUENCE BACK'
};

/**
 * One cron tick over state.locks against the FULL build (trigger-TF candles needed).
 * Mutates state.locks; returns one alert per lock with events (the last event's title,
 * the card after all of them) plus the candidate ids that are locked (open) for suppression.
 * @returns {{alerts:Array<Object>, lockedIds:Set<string>, changed:boolean}}
 */
export function diffLocks(state, payload, nowMs) {
  const syms = payload && isObj(payload.symbols) ? payload.symbols : {};
  const dataOk = payload && payload.dataStatus !== 'unavailable';
  const list = normalizeLocks(state.locks, nowMs);
  const alerts = [];
  let changed = list.length !== (Array.isArray(state.locks) ? state.locks.length : 0);
  const next = list.map((lock) => {
    if (!['armed', 'confirmed', 'filled'].includes(lock.status)) return lock;
    const s = syms[lock.symbol];
    if (!dataOk || !isObj(s)) return lock;
    const { lock: l, events } = evaluateLock(lock, s, nowMs);
    if (JSON.stringify(l) !== JSON.stringify(lock)) changed = true;
    if (events.length) {
      const last = events[events.length - 1];
      alerts.push({
        kind: 'LOCK', symbol: l.symbol, candidateId: l.candidateId, ref: l.ref, event: last.kind,
        text: formatLockCard(l, s, nowMs, EVENT_TITLE[last.kind] || 'LOCK'),
        ...(lockKeyboard(l) ? { replyMarkup: lockKeyboard(l) } : {}),
        lockLevels: { ...l.levels, status: l.status, verdict: lockVerdict(l).verdict }
      });
    }
    return l;
  });
  state.locks = next;
  const lockedIds = new Set(openLocks(next).map((l) => l.candidateId).filter(Boolean));
  return { alerts, lockedIds, changed };
}

/** Drop generic and Track alerts for locked candidates (the lock card speaks for them). */
export function suppressLocked(alerts, lockedIds) {
  if (!(lockedIds instanceof Set) || !lockedIds.size) return alerts;
  return (Array.isArray(alerts) ? alerts : []).filter((a) => !(LOCK_SUPPRESSES.includes(a.kind) && a.candidateId && lockedIds.has(a.candidateId)));
}

/** /locks: every open lock as a card, or a one-liner when none. */
export function formatLocksList(locks, syms, nowMs) {
  const open = openLocks(normalizeLocks(locks, nowMs));
  if (!open.length) return ['🔒 [NO LOCKS] Tap 🔒 Lock on a signal card, or /lock BTC long 5m entry 100 stop 98 tp 104.'];
  return open.map((l) => formatLockCard(l, syms && syms[l.symbol], nowMs));
}

/**
 * `/lock SYM long|short TF entry X stop Y [tp Z] [trigger T] [void V]` -> a manual snapshot,
 * or {error}. Entry doubles as the trigger and the stop as the void unless given.
 */
export function parseManualLock(args, parseSymbol) {
  const a = (Array.isArray(args) ? args : []).map((x) => String(x).toLowerCase());
  const usage = 'Usage: /lock BTC long 5m entry 100 stop 98 tp 104 (tp/trigger/void optional)';
  const symbol = parseSymbol(a[0]);
  const direction = a[1] === 'long' || a[1] === 'short' ? a[1] : null;
  const timeframe = LOCK_TIMEFRAMES.includes(a[2]) ? a[2] : null;
  if (!symbol || !direction || !timeframe) return { error: usage };
  const kv = {};
  for (let i = 3; i + 1 < a.length; i += 2) kv[a[i]] = Number(String(a[i + 1]).replace(/,/g, ''));
  const entry = kv.entry;
  const stop = kv.stop ?? kv.sl;
  if (!isNum(entry) || !isNum(stop)) return { error: usage };
  return {
    symbol,
    snap: {
      candidateId: `${symbol}:${timeframe}:${direction}:manual:${entry}`, timeframe, direction,
      entry, stop, tp1: isNum(kv.tp ?? kv.tp1) ? (kv.tp ?? kv.tp1) : null,
      breakoutLevel: isNum(kv.trigger) ? kv.trigger : entry, invalidation: isNum(kv.void) ? kv.void : stop
    }
  };
}

export { createLock };
