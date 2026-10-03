/**
 * Trade lock (owner decisions 2026-10-02, docs/OWNER_DECISIONS_2026-10-02_TRADE_LOCK.md).
 *
 * The owner locks a setup they are hunting. From that moment its levels are frozen:
 * trigger, invalidation, entry, stop, TP1 and the MISSED cap (trigger +/- 1.5 ATR of the
 * trigger timeframe, measured once at lock time). Later builds never move them; they only
 * judge the frozen conditions on closed candles of the trigger timeframe:
 *
 *   armed      waiting for a trigger-TF close beyond the trigger
 *   confirmed  that close happened; the entry is valid until a terminal state (a pullback
 *              to the trigger is the entry, not a reset)
 *   filled     the owner took it; tracks to stop / TP1 on the frozen levels
 *   missed     a close past the cap before a fill (no chasing, no new entry)
 *   invalidated a close beyond the invalidation before a fill
 *   expired    6 trigger-TF candles after the lock, unfilled
 *   stopped / tp1   a filled lock reached its stop / TP1
 *
 * A higher-timeframe close on the wrong side of EMA200 (one of the 1-2 TFs above the
 * trigger TF, right side at lock) raises a thesis warning and never moves a level.
 * Confluence is a per-timeframe checklist (1m-1D, EMA21/EMA200 model, Stoch RSI, volume),
 * gated at confirmation and re-scored on every evaluation; the verdict is TAKE / WAIT / PASS.
 *
 * Constants live here, not in config/engine.json: a lock manages a trade the owner chose and
 * changes no signal, so configVersion (and the tracker's epochs) stays put.
 *
 * Pure functions, no I/O. Direction-symmetric: every comparison runs through `dir` (+1/-1).
 */

export const LOCK_TIMEFRAMES = Object.freeze(['1m', '3m', '5m', '15m', '1h', '4h', '1d']);
export const LOCK_TF_MS = Object.freeze({ '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 });

export const LOCK_DEFAULTS = Object.freeze({
  /** D9: MISSED cap distance past the trigger, in trigger-TF ATR, fixed at lock. */
  extensionAtr: 1.5,
  /** Cap fallback when ATR is unmeasurable: this many R (|trigger - invalidation|). */
  extensionRFallback: 1.0,
  /** D10: an unfilled lock expires this many trigger-TF candles after the lock. */
  expiryCandles: 6,
  atrPeriod: 14,
  /** D11: timeframes above the trigger TF watched for an EMA200 thesis break. */
  thesisTfsAbove: 2,
  /** D7: EMA21 and EMA200 count as "close together" within this % of price. */
  maTightPct: 0.6,
  /** Volume supports when the last closed candle beats the mean of this many before it. */
  volumeLookback: 10,
  /** Gate: trigger-TF MA stack + price side, plus at least this many supporting checks. */
  gateMinSupport: 2,
  /** Locks kept at once. */
  maxLocks: 5,
  /** A filled lock stops tracking after this long (daily swings fit inside). */
  filledMaxMs: 14 * 24 * 3_600_000
});

export const LOCK_SOURCES = Object.freeze(['flag', 'htf', 'retest1h', 'manual']);
export const LOCK_OPEN = Object.freeze(['armed', 'confirmed', 'filled']);
export const LOCK_TERMINAL = Object.freeze(['missed', 'invalidated', 'expired', 'stopped', 'tp1', 'unlocked', 'ended']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sgn = (v) => (v > 0 ? 1 : (v < 0 ? -1 : 0));
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const dirOf = (direction) => (direction === 'short' ? -1 : (direction === 'long' ? 1 : 0));

/** Timeframes strictly above `tf`, nearest first. */
export function timeframesAbove(tf, n = LOCK_TIMEFRAMES.length) {
  const i = LOCK_TIMEFRAMES.indexOf(tf);
  return i === -1 ? [] : LOCK_TIMEFRAMES.slice(i + 1, i + 1 + n);
}

/** Closed candles of a payload timeframe entry as {openMs, closeMs, o, h, l, c, v}, oldest first. */
export function closedCandles(tfEntry, tf) {
  const ms = LOCK_TF_MS[tf];
  const list = isObj(tfEntry) && Array.isArray(tfEntry.candles) ? tfEntry.candles : [];
  return list
    .map((k) => ({ openMs: Date.parse(k && k.t), o: k && k.o, h: k && k.h, l: k && k.l, c: k && k.c, v: k && k.v }))
    .filter((k) => isNum(k.openMs) && isNum(k.c))
    .map((k) => ({ ...k, closeMs: k.openMs + ms }))
    .sort((a, b) => a.openMs - b.openMs);
}

/** Wilder-free simple ATR over the last `period` true ranges; null with fewer than 2 candles. */
export function simpleAtr(candles, period = LOCK_DEFAULTS.atrPeriod) {
  const k = Array.isArray(candles) ? candles.filter((c) => isNum(c.h) && isNum(c.l) && isNum(c.c)) : [];
  if (k.length < 2) return null;
  const trs = [];
  for (let i = 1; i < k.length; i++) {
    const pc = k[i - 1].c;
    trs.push(Math.max(k[i].h - k[i].l, Math.abs(k[i].h - pc), Math.abs(k[i].l - pc)));
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

/**
 * Frozen levels for a lock from a candidate snapshot (lib/telegram.js candidateSnapshot
 * shape, an HTF/RETEST plan snapshot, or manual levels). The trigger is the breakout
 * level (else the entry); the invalidation is the candidate's void level (else the stop).
 * @returns {{trigger:number, invalidation:number, entry:number, stop:number, tp1:number|null}|null}
 */
export function lockLevels(snap) {
  if (!isObj(snap)) return null;
  const first = (...xs) => xs.find(isNum) ?? null;
  const trigger = first(snap.breakoutLevel, snap.trigger, snap.entry);
  const entry = first(snap.entry, trigger);
  const stop = first(snap.stop, snap.invalidation);
  const invalidation = first(snap.invalidation, snap.stop);
  const tp1 = first(snap.tp1, snap.measuredTarget);
  const dir = dirOf(snap.direction);
  if (!dir || !isNum(trigger) || !isNum(entry) || !isNum(stop) || !isNum(invalidation)) return null;
  // The stop and the invalidation must sit on the losing side of the trigger, TP1 on the winning side.
  if (sgn(trigger - invalidation) !== dir || sgn(entry - stop) !== dir) return null;
  return { trigger, invalidation, entry, stop, tp1: isNum(tp1) && sgn(tp1 - entry) === dir ? tp1 : null };
}

/** The side of EMA200 a timeframe's last close sits on relative to the trade: 1 with, -1 against, null unknown. */
function ema200Side(tfEntry, dir) {
  if (!isObj(tfEntry) || !isNum(tfEntry.priceVs200Pct)) return null;
  const s = sgn(tfEntry.priceVs200Pct);
  return s === 0 ? null : s * dir;
}

/**
 * Per-timeframe confluence checklist (D6/D7). Each row reads one payload timeframe entry:
 *   ma     EMA21 vs EMA200 in the trade's direction
 *   px     last close vs EMA21 in the trade's direction
 *   stoch  Stoch RSI state with (BULLISH long / BEARISH short) or against
 *   push   with = px and stoch both with; against = both against; else mixed
 *   mark   ✅ ma and px with (stoch not against) · ❌ ma and px against · ⚠️ otherwise
 * Plus on the trigger TF: the D7 model (EMA21/200 within maTightPct, close beyond 21 beyond
 * 200) and volume (last closed candle above the mean of the volumeLookback before it).
 * Gate: trigger-TF ma and px with, plus >= gateMinSupport of {next TF up ma, trigger stoch,
 * volume, model}.
 * @param {Object} timeframes - payload symbols.<SYM>.timeframes (compact works; volume then null)
 * @param {string} direction - long | short
 * @param {string} triggerTf
 */
export function confluenceChecklist(timeframes, direction, triggerTf, opts = {}) {
  const cfg = { ...LOCK_DEFAULTS, ...opts };
  const dir = dirOf(direction);
  const tfs = isObj(timeframes) ? timeframes : {};
  const rows = [];
  for (const tf of LOCK_TIMEFRAMES) {
    const e = tfs[tf];
    if (!isObj(e)) { rows.push({ tf, mark: null }); continue; }
    const ma = isNum(e.ema21) && isNum(e.ema200) && e.ema21 !== e.ema200 ? sgn(e.ema21 - e.ema200) * dir : null;
    const px = isNum(e.priceVs21Pct) && e.priceVs21Pct !== 0 ? sgn(e.priceVs21Pct) * dir : null;
    const st = isObj(e.stochRsi) ? e.stochRsi.state : null;
    const stoch = st === 'BULLISH' ? dir : (st === 'BEARISH' ? -dir : (st ? 0 : null));
    const push = px === 1 && stoch === 1 ? 'with' : (px === -1 && stoch === -1 ? 'against' : (px === null && stoch === null ? null : 'mixed'));
    let mark = null;
    if (ma !== null && px !== null) mark = ma === 1 && px === 1 && stoch !== -1 ? '✅' : (ma === -1 && px === -1 ? '❌' : '⚠️');
    rows.push({ tf, ma, px, stoch, push, mark });
  }
  const trig = rows.find((r) => r.tf === triggerTf) || { tf: triggerTf };
  const te = tfs[triggerTf];
  let model = null;
  if (isObj(te) && isNum(te.ema21) && isNum(te.ema200) && isNum(te.priceVs21Pct) && isNum(te.priceVs200Pct)) {
    const gapPct = Math.abs(te.ema21 - te.ema200) / Math.abs(te.ema200) * 100;
    const stacked = sgn(te.ema21 - te.ema200) === dir && sgn(te.priceVs21Pct) === dir && sgn(te.priceVs200Pct) === dir;
    model = { ok: stacked && gapPct <= cfg.maTightPct, gapPct: r2(gapPct), stacked };
  }
  let volume = null;
  const k = closedCandles(te, triggerTf).filter((c) => isNum(c.v));
  if (k.length > cfg.volumeLookback) {
    const last = k[k.length - 1];
    const prior = k.slice(-1 - cfg.volumeLookback, -1);
    const mean = prior.reduce((a, c) => a + c.v, 0) / prior.length;
    volume = { ok: mean > 0 && last.v > mean, ratio: mean > 0 ? r2(last.v / mean) : null };
  }
  const up = timeframesAbove(triggerTf, 1)[0];
  const upRow = rows.find((r) => r.tf === up);
  const primary = trig.ma === 1 && trig.px === 1;
  const support = [
    { name: `${up || 'next TF'} MAs`, ok: Boolean(upRow && upRow.ma === 1) },
    { name: `${triggerTf} Stoch`, ok: trig.stoch === 1 },
    { name: `${triggerTf} volume`, ok: Boolean(volume && volume.ok) },
    { name: '21/200 model', ok: Boolean(model && model.ok) }
  ];
  const supportCount = support.filter((s) => s.ok).length;
  const scored = rows.filter((r) => r.mark !== null);
  return {
    rows,
    model,
    volume,
    primary,
    support,
    gate: primary && supportCount >= cfg.gateMinSupport,
    score: scored.filter((r) => r.mark === '✅').length,
    of: scored.length,
    against: scored.filter((r) => r.mark === '❌').map((r) => r.tf)
  };
}

/**
 * One-line thesis from a full checklist (owner: "a short thesis"), shared by flag and lock cards:
 * "1h bull flag above EMA21 & 200, MAs tight, volume up · 4h agrees".
 * @param {Object} conf - confluenceChecklist() result (rows with ma/px/mark, model, volume)
 * @param {string} direction - long | short
 * @param {string} tf - the flag's timeframe
 */
export function thesisText(conf, direction, tf) {
  const c = isObj(conf) ? conf : {};
  const rows = Array.isArray(c.rows) ? c.rows : [];
  const trig = rows.find((r) => r.tf === tf) || {};
  const up = timeframesAbove(tf, 1)[0] || null;
  const upRow = rows.find((r) => r.tf === up);
  const parts = [`${tf} ${direction === 'short' ? 'bear' : 'bull'} flag ${trig.ma === 1 && trig.px === 1 ? `${direction === 'short' ? 'below' : 'above'} EMA21 & 200` : 'against part of the MA stack'}`];
  if (c.model && c.model.ok) parts.push('MAs tight');
  if (c.volume && c.volume.ok) parts.push('volume up');
  const agree = upRow && upRow.mark === '✅' ? 'agrees' : (upRow && upRow.mark === '❌' ? 'disagrees' : 'mixed');
  return up ? `${parts.join(', ')} · ${up} ${agree}` : parts.join(', ');
}

/** Per-TF mark changes between two checklists: ["15m ✅→⚠️", ...]. */
export function confluenceDelta(before, after) {
  const prev = new Map((before && Array.isArray(before.rows) ? before.rows : []).map((r) => [r.tf, r.mark]));
  const out = [];
  for (const r of after && Array.isArray(after.rows) ? after.rows : []) {
    const was = prev.get(r.tf);
    if (was && r.mark && was !== r.mark) out.push(`${r.tf} ${was}→${r.mark}`);
  }
  return out;
}

/**
 * Create a lock. Levels freeze here; so does the MISSED cap (trigger + dir x extensionAtr x
 * ATR of the trigger TF's published candles, else extensionRFallback x |trigger -
 * invalidation|), the expiry, and the EMA200 side of the thesis timeframes.
 * Already-past states at lock time are reported, not hidden: the returned lock starts
 * `confirmed` when the latest trigger-TF close is already beyond the trigger, `missed` when
 * it is already past the cap, `invalidated` when it is already through the invalidation.
 * @param {Object} p
 * @param {string} p.symbol
 * @param {Object} p.snap - candidate/plan snapshot (direction, timeframe, levels, candidateId)
 * @param {Object} p.timeframes - full payload symbols.<SYM>.timeframes (candles needed for ATR)
 * @param {number} p.nowMs
 * @param {string} [p.source] - flag | htf | retest1h | manual
 * @param {string} p.ref - 8-hex ref (lib/telegram.js shortRef of the candidateId)
 * @returns {{lock:Object|null, error:string|null}}
 */
export function createLock({ symbol, snap, timeframes, nowMs, source = 'flag', ref }, opts = {}) {
  const cfg = { ...LOCK_DEFAULTS, ...opts };
  if (!isObj(snap)) return { lock: null, error: 'no_setup' };
  const tf = snap.timeframe;
  if (!LOCK_TIMEFRAMES.includes(tf)) return { lock: null, error: 'bad_timeframe' };
  const levels = lockLevels(snap);
  if (!levels) return { lock: null, error: 'bad_levels' };
  const dir = dirOf(snap.direction);
  const tfs = isObj(timeframes) ? timeframes : {};
  const candles = closedCandles(tfs[tf], tf);
  const atr = simpleAtr(candles, cfg.atrPeriod);
  const capDist = isNum(atr) && atr > 0 ? cfg.extensionAtr * atr : cfg.extensionRFallback * Math.abs(levels.trigger - levels.invalidation);
  const cap = levels.trigger + dir * capDist;
  const thesisTfs = timeframesAbove(tf, cfg.thesisTfsAbove);
  const thesisBase = Object.fromEntries(thesisTfs.map((t) => [t, ema200Side(tfs[t], dir)]));
  const conf = confluenceChecklist(tfs, snap.direction, tf, cfg);
  const last = candles[candles.length - 1] || null;
  const lockedAt = new Date(nowMs).toISOString();
  const lock = {
    ref, symbol, candidateId: snap.candidateId || null, source: LOCK_SOURCES.includes(source) ? source : 'flag',
    timeframe: tf, direction: snap.direction, lockedAt,
    expiresAt: new Date(nowMs + cfg.expiryCandles * LOCK_TF_MS[tf]).toISOString(),
    levels: { ...levels, cap: r2(cap) ?? cap },
    atr: r2(atr), capSource: isNum(atr) && atr > 0 ? 'atr' : 'r',
    status: 'armed', statusAt: lockedAt, confirmedAt: null, filledAt: null, fillPrice: null, endedAt: null, endPrice: null,
    lastCandleOpen: last ? new Date(last.openMs).toISOString() : null,
    thesis: { base: thesisBase, broken: [] },
    confAtLock: compactConf(conf), conf: compactConf(conf),
    // The thesis as it stood at lock time (the compact checklist kept below cannot rebuild it later).
    thesisText: thesisText(conf, snap.direction, tf),
    history: [{ status: 'armed', at: lockedAt, price: last ? last.c : null }]
  };
  if (last) {
    const s = classifyClose(lock, last.c);
    if (s !== 'armed') setStatus(lock, s, lockedAt, last.c);
  }
  return { lock, error: null };
}

/** The minimum a lock keeps of a checklist (rows' marks, gate, score) - enough for the delta. */
function compactConf(c) {
  return {
    rows: c.rows.map((r) => ({ tf: r.tf, mark: r.mark })),
    gate: c.gate, primary: c.primary, score: c.score, of: c.of,
    support: c.support.filter((s) => s.ok).map((s) => s.name),
    missing: c.support.filter((s) => !s.ok).map((s) => s.name),
    model: c.model ? c.model.ok : null, volume: c.volume ? c.volume.ok : null
  };
}

/** What one trigger-TF close means for an unfilled lock (frozen levels only). */
function classifyClose(lock, close) {
  const dir = dirOf(lock.direction);
  const { trigger, invalidation, cap } = lock.levels;
  if (dir * (close - invalidation) < 0) return 'invalidated';
  if (dir * (close - cap) > 0) return 'missed';
  if (lock.status === 'armed' && dir * (close - trigger) > 0) return 'confirmed';
  return lock.status;
}

function setStatus(lock, status, atIso, price) {
  lock.status = status;
  lock.statusAt = atIso;
  if (status === 'confirmed') lock.confirmedAt = atIso;
  if (LOCK_TERMINAL.includes(status)) { lock.endedAt = atIso; lock.endPrice = isNum(price) ? price : null; }
  lock.history = [...(Array.isArray(lock.history) ? lock.history : []), { status, at: atIso, price: isNum(price) ? price : null }].slice(-12);
}

/** Mark a lock filled (owner took it). Price = the fill (mark at tap) when known, else the frozen entry. */
export function fillLock(lock, nowMs, price = null) {
  if (!isObj(lock) || !['armed', 'confirmed'].includes(lock.status)) return { lock, ok: false };
  const next = clone(lock);
  next.filledAt = new Date(nowMs).toISOString();
  next.fillPrice = isNum(price) ? price : next.levels.entry;
  setStatus(next, 'filled', next.filledAt, next.fillPrice);
  return { lock: next, ok: true };
}

/** End a lock by owner unlock. */
export function unlockLock(lock, nowMs) {
  if (!isObj(lock) || LOCK_TERMINAL.includes(lock.status)) return { lock, ok: false };
  const next = clone(lock);
  setStatus(next, 'unlocked', new Date(nowMs).toISOString(), null);
  return { lock: next, ok: true };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Judge a lock against a fresh build. Never touches `levels`.
 * Events (each at most once per evaluation): confirmed, missed, invalidated, expired,
 * stopped, tp1, ended (filled lock past filledMaxMs), thesis_broken (new TFs only),
 * gate_lost / gate_regained (confluence gate flipped while open).
 * @param {Object} lock
 * @param {Object} sym - payload symbols.<SYM> (full build: candles on the trigger TF)
 * @param {number} nowMs
 * @returns {{lock:Object, events:Array<{kind:string, at:string, price:number|null, detail?:Object}>}}
 */
export function evaluateLock(lock, sym, nowMs, opts = {}) {
  const cfg = { ...LOCK_DEFAULTS, ...opts };
  if (!isObj(lock) || !LOCK_OPEN.includes(lock.status)) return { lock, events: [] };
  const next = clone(lock);
  const events = [];
  const nowIso = new Date(nowMs).toISOString();
  const dir = dirOf(next.direction);
  const s = isObj(sym) ? sym : {};
  const tfs = isObj(s.timeframes) ? s.timeframes : {};
  const after = Date.parse(next.lastCandleOpen || 0) || 0;
  const fresh = closedCandles(tfs[next.timeframe], next.timeframe).filter((c) => c.openMs > after && c.closeMs <= nowMs);
  const emit = (kind, price, detail) => events.push({ kind, at: nowIso, price: isNum(price) ? price : null, ...(detail ? { detail } : {}) });

  for (const c of fresh) {
    next.lastCandleOpen = new Date(c.openMs).toISOString();
    const at = new Date(c.closeMs).toISOString();
    if (next.status === 'filled') {
      const { stop, tp1 } = next.levels;
      // Wick-level: a filled trade is stopped by any trade through its stop. Stop wins a tie (conservative).
      const adverse = dir === 1 ? c.l : c.h;
      const favorable = dir === 1 ? c.h : c.l;
      if (isNum(adverse) && dir * (adverse - stop) <= 0) { setStatus(next, 'stopped', at, stop); emit('stopped', stop); break; }
      if (isNum(tp1) && isNum(favorable) && dir * (favorable - tp1) >= 0) { setStatus(next, 'tp1', at, tp1); emit('tp1', tp1); break; }
      continue;
    }
    const st = classifyClose(next, c.c);
    if (st !== next.status) {
      setStatus(next, st, at, c.c);
      emit(st, c.c);
      if (LOCK_TERMINAL.includes(st)) break;
    }
  }

  // Between closes, a filled lock also checks the live price (1m close / mark) against its stop and TP1.
  if (next.status === 'filled') {
    const mk = isObj(s.mark) && s.mark.status === 'ok' && isNum(s.mark.price) ? s.mark.price : (isNum(s.price) ? s.price : null);
    if (mk !== null) {
      if (dir * (mk - next.levels.stop) <= 0) { setStatus(next, 'stopped', nowIso, mk); emit('stopped', mk); }
      else if (isNum(next.levels.tp1) && dir * (mk - next.levels.tp1) >= 0) { setStatus(next, 'tp1', nowIso, mk); emit('tp1', mk); }
    }
    if (next.status === 'filled' && nowMs - Date.parse(next.filledAt) >= cfg.filledMaxMs) { setStatus(next, 'ended', nowIso, mk); emit('ended', mk); }
  } else if (['armed', 'confirmed'].includes(next.status) && nowMs >= Date.parse(next.expiresAt)) {
    setStatus(next, 'expired', nowIso, isNum(s.price) ? s.price : null);
    emit('expired', s.price);
  }

  if (LOCK_OPEN.includes(next.status)) {
    // Thesis: a thesis TF that was with the trade at lock now closes on the wrong side of EMA200.
    const base = isObj(next.thesis && next.thesis.base) ? next.thesis.base : {};
    const broken = Object.keys(base).filter((t) => base[t] === 1 && ema200Side(tfs[t], dir) === -1);
    const newly = broken.filter((t) => !(next.thesis.broken || []).includes(t));
    next.thesis = { ...next.thesis, broken };
    if (newly.length) emit('thesis_broken', s.price, { timeframes: newly });
    // Confluence re-score; the gate flipping is the decay / recovery warning.
    const conf = confluenceChecklist(tfs, next.direction, next.timeframe, cfg);
    const prevGate = next.conf ? next.conf.gate : null;
    next.conf = compactConf(conf);
    if (prevGate === true && conf.gate === false) emit('gate_lost', s.price, { missing: next.conf.missing });
    if (prevGate === false && conf.gate === true && next.status !== 'armed') emit('gate_regained', s.price);
  }
  return { lock: next, events };
}

/**
 * TAKE / WAIT / PASS (D8) for a lock, with one plain reason. A filled lock reads IN TRADE.
 * TAKE   confirmed, confluence gate passes, no thesis break
 * WAIT   armed (trigger close not yet in), or confirmed with the gate partial / a thesis warning
 * PASS   missed / invalidated / expired, or the trigger TF's own MAs or price side are against
 */
export function lockVerdict(lock) {
  if (!isObj(lock)) return { verdict: 'PASS', reason: 'no lock' };
  const tf = lock.timeframe;
  const word = lock.direction === 'short' ? 'below' : 'above';
  const c = lock.conf || {};
  const thesis = lock.thesis && lock.thesis.broken && lock.thesis.broken.length ? lock.thesis.broken : [];
  switch (lock.status) {
    case 'missed': return { verdict: 'PASS', reason: `MISSED: price closed past the ${fmt(lock.levels.cap)} cap before a fill. No chase; wait for a new setup.` };
    case 'invalidated': return { verdict: 'PASS', reason: `INVALIDATED: ${tf} closed beyond ${fmt(lock.levels.invalidation)}.` };
    case 'expired': return { verdict: 'PASS', reason: `EXPIRED: no fill within ${LOCK_DEFAULTS.expiryCandles} ${tf} candles.` };
    case 'stopped': return { verdict: 'DONE', reason: `Stopped at ${fmt(lock.endPrice)}. Planned loss.` };
    case 'tp1': return { verdict: 'DONE', reason: `TP1 reached at ${fmt(lock.endPrice)}.` };
    case 'unlocked': return { verdict: 'DONE', reason: 'Unlocked by you.' };
    case 'ended': return { verdict: 'DONE', reason: 'Tracking limit reached.' };
    case 'filled': return { verdict: 'IN TRADE', reason: `Hold to stop ${fmt(lock.levels.stop)} or TP1 ${fmt(lock.levels.tp1)}. Levels are locked.${thesis.length ? ` Thesis warning: ${thesis.join('/')} closed past EMA200.` : ''}` };
    case 'armed': return { verdict: 'WAIT', reason: `Waiting for a ${tf} close ${word} ${fmt(lock.levels.trigger)}. Void on a close past ${fmt(lock.levels.invalidation)}.` };
    case 'confirmed':
      if (c.primary === false) return { verdict: 'PASS', reason: `${tf} EMA21/200 or price side turned against the trade.` };
      if (thesis.length) return { verdict: 'WAIT', reason: `Confirmed, but ${thesis.join('/')} closed past EMA200 (thesis warning). Levels unchanged.` };
      if (c.gate) return { verdict: 'TAKE', reason: `Confirmed. Enter between ${fmt(lock.levels.trigger)} and the ${fmt(lock.levels.cap)} cap; stop ${fmt(lock.levels.stop)}, TP1 ${fmt(lock.levels.tp1)}.` };
      return { verdict: 'WAIT', reason: `Confirmed, confluence partial (missing: ${(c.missing || []).join(', ') || 'n/a'}). Entry valid until the ${fmt(lock.levels.cap)} cap.` };
    default: return { verdict: 'WAIT', reason: lock.status };
  }
}

const fmt = (v) => (isNum(v) ? r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'n/a');

/** One-line checklist: "1m✅ 3m✅ 5m⚠️ 15m✅ 1h❌ 4h· 1d✅". */
export function checklistLine(conf) {
  const rows = conf && Array.isArray(conf.rows) ? conf.rows : [];
  return rows.map((r) => `${r.tf}${r.mark || '·'}`).join(' ');
}

/** R multiple of `price` against a lock's frozen entry (fill when filled) and stop. */
export function lockR(lock, price) {
  if (!isObj(lock) || !isNum(price)) return null;
  const dir = dirOf(lock.direction);
  const entry = isNum(lock.fillPrice) ? lock.fillPrice : lock.levels.entry;
  const risk = Math.abs(entry - lock.levels.stop);
  return risk > 0 ? r2((dir * (price - entry)) / risk) : null;
}

/**
 * Compact lock for the REST payload (`locks[]`) and the GPT. Frozen levels, status,
 * verdict, checklist and the delta since the lock.
 */
export function compactLock(lock) {
  if (!isObj(lock)) return null;
  const v = lockVerdict(lock);
  const lv = lock.levels || {};
  return {
    ref: lock.ref, sym: lock.symbol, tf: lock.timeframe, dir: lock.direction, src: lock.source,
    st: lock.status, verdict: v.verdict, why: v.reason,
    lv: { trg: lv.trigger, inv: lv.invalidation, ent: lv.entry, sl: lv.stop, tp1: lv.tp1 ?? null, cap: lv.cap },
    at: lock.lockedAt, exp: lock.expiresAt, conf_at: lock.confirmedAt, fill: lock.fillPrice ?? null,
    conf: { score: lock.conf ? `${lock.conf.score}/${lock.conf.of}` : null, gate: lock.conf ? lock.conf.gate : null, tfs: checklistLine(lock.conf), delta: confluenceDelta(lock.confAtLock, lock.conf) },
    thesis: lock.thesis && lock.thesis.broken && lock.thesis.broken.length ? lock.thesis.broken : []
  };
}

/** Normalize a stored lock list (drops malformed entries and closed locks older than a day). */
export function normalizeLocks(raw, nowMs) {
  const list = Array.isArray(raw) ? raw : [];
  return list.filter((l) => isObj(l) && /^[0-9a-f]{8}$/.test(String(l.ref)) && typeof l.symbol === 'string'
    && LOCK_TIMEFRAMES.includes(l.timeframe) && isObj(l.levels) && isNum(l.levels.trigger) && isNum(l.levels.cap)
    && [...LOCK_OPEN, ...LOCK_TERMINAL].includes(l.status)
    && (LOCK_OPEN.includes(l.status) || !isNum(nowMs) || nowMs - Date.parse(l.endedAt || l.statusAt) < 86_400_000))
    .slice(-(LOCK_DEFAULTS.maxLocks * 2));
}

/** Open (armed / confirmed / filled) locks. */
export const openLocks = (list) => (Array.isArray(list) ? list : []).filter((l) => isObj(l) && LOCK_OPEN.includes(l.status));
