/**
 * Flag flow (owner-approved 2026-10-02, docs/PLAN_FLAG_FLOW.md): the four-step Telegram UX.
 *
 *   FOUND  a flag passing the confluence gate on any timeframe 1m-4h, before its trigger (board only, never pushed)
 *   LOCK OPPORTUNITY  (stage `lockable`) the flag triggering or confirmed with the gate passing and
 *          price still inside the no-chase cap: the only pushed stage
 *   LOCK   the existing trade lock (lib/tradeLock.js)
 *   DONE   the existing lock terminal states
 *
 * This module is the pure part: it scores the engine's `flagBoard` entries, ranks them, builds
 * the button snapshot a Lock resolves from, and formats the opportunity / FOUND / board cards.
 * Levels are structural: entry = breakout level, stop = flag invalidation, target = measured
 * move = TP1, TP2 = the next geometry level beyond it (R:R is information, no 3% cap here). The cap is the lock's no-chase distance
 * (capAtr x ATR of the trigger timeframe), shown on the card and used for MISSED.
 *
 * Pure functions, no I/O. Direction-symmetric: every comparison runs through `dir` (+1/-1).
 */
import { confluenceChecklist, closedCandles, simpleAtr, checklistLine, LOCK_TF_MS } from './tradeLock.js';
import { escapeHtml, msgHeader, codeBlock, joinSections, fmtLvl, shortRef } from './telegram.js';

export const FLOW_DEFAULTS = Object.freeze({ capAtr: 1.5, boardSize: 3, foundCooldownMs: 15 * 60_000 });
export const FLOW_STATE_RANK = Object.freeze({ confirmed: 4, triggering: 3, forming: 2, proto: 1 });

const PULSE_WINDOW_MS = 24 * 3_600_000;
const STAGE_RANK = Object.freeze({ lockable: 3, found: 2, watch: 1 });
const FOUND_STATES = Object.freeze(['triggering', 'forming', 'proto']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const dirOf = (direction) => (direction === 'short' ? -1 : (direction === 'long' ? 1 : 0));
const tfMs = (tf) => LOCK_TF_MS[tf] || 0;


/**
 * TP2: the nearest geometry level strictly beyond TP1 in the trade direction, from
 * geometryContext[tf] on timeframes >= the flag's. Levels: the near edge (facing price) of the
 * horizontal resistance zones (long) / support zones (short), and the near edge of every
 * confluenceZones entry. No level -> entry + dir * 1.5 * |target - entry|. Null without a target.
 * @returns {{tp2:number|null, source:'level'|'1.5x'|null}}
 */
export function tp2For(c, geometry) {
  const dir = dirOf(c.dir);
  if (!dir || !isNum(c.tgt) || !isNum(c.brk)) return { tp2: null, source: null };
  const need = tfMs(c.tf);
  let best = null;
  for (const [gtf, g] of Object.entries(geometry && typeof geometry === 'object' ? geometry : {})) {
    if (!g || tfMs(gtf) < need) continue;
    const zones = [
      ...(Array.isArray(dir === 1 ? g.horizontalResistanceZones : g.horizontalSupportZones) ? (dir === 1 ? g.horizontalResistanceZones : g.horizontalSupportZones) : []),
      ...(Array.isArray(g.confluenceZones) ? g.confluenceZones : [])
    ];
    for (const z of zones) {
      const near = z && (dir === 1 ? z.low : z.high);
      if (isNum(near) && (near - c.tgt) * dir > 0 && (best === null || (near - best) * dir < 0)) best = near;
    }
  }
  if (best !== null) return { tp2: Math.round(best * 100) / 100, source: 'level' };
  return { tp2: Math.round((c.brk + dir * 1.5 * Math.abs(c.tgt - c.brk)) * 100) / 100, source: '1.5x' };
}

/**
 * One board entry for a flagBoard candidate, scored against that symbol's payload timeframes.
 * @param {string} symbol
 * @param {{id:string, tf:string, dir:string, st:string, brk:number, inv:number, tgt:number|null, rr:number|null}} c
 * @param {Object} timeframes - payload.symbols[sym].timeframes (full build: candles present)
 * @param {number|null} price - live price
 * @param {Object} [opts]
 * @param {Object|null} [geometry] - payload.symbols[sym].geometryContext (TP2 levels)
 */
export function scoreFlag(symbol, c, timeframes, price, opts = {}, geometry = null) {
  const cfg = { ...FLOW_DEFAULTS, ...opts };
  const dir = dirOf(c.dir);
  const tfs = timeframes && typeof timeframes === 'object' ? timeframes : {};
  const atr = simpleAtr(closedCandles(tfs[c.tf], c.tf));
  const cap = isNum(atr) && atr > 0 && isNum(c.brk) ? Math.round((c.brk + dir * cfg.capAtr * atr) * 100) / 100 : null;
  const check = confluenceChecklist(tfs, c.dir, c.tf);
  const confirmed = c.st === 'confirmed';
  // Past the no-chase cap = missed, whether the break is one close old (triggering) or confirmed.
  const missed = (confirmed || c.st === 'triggering') && isNum(price) && isNum(cap) && (price - cap) * dir > 0;
  const { tp2, source } = tp2For(c, geometry);
  let stage = 'watch';
  if (missed) stage = 'missed';
  else if ((c.st === 'triggering' || confirmed) && check.gate && isNum(c.tgt)) stage = 'lockable';
  else if ((FOUND_STATES.includes(c.st) || confirmed) && check.gate) stage = 'found';
  return {
    symbol, id: c.id, ref: shortRef(c.id), tf: c.tf, dir: c.dir, st: c.st, price: isNum(price) ? price : null,
    levels: { entry: c.brk, stop: c.inv, target: isNum(c.tgt) ? c.tgt : null, tp2, tp2Source: source, rr: isNum(c.rr) ? c.rr : null, cap },
    check, gate: check.gate, score: check.score, of: check.of, stage
  };
}

/**
 * All symbols' entries, best first. Stage (lockable > found > watch; missed dropped), then
 * checklist score, state rank, higher timeframe, R:R.
 * @param {Object} flagBoard - payload.flagBoard
 * @param {Object} symbols - payload.symbols (for timeframes and price)
 */
export function rankFlags(flagBoard, symbols, opts = {}) {
  const out = [];
  for (const [sym, list] of Object.entries(flagBoard || {})) {
    const s = (symbols && symbols[sym]) || {};
    const price = s.mark && s.mark.status === 'ok' && isNum(s.mark.price) ? s.mark.price : (isNum(s.price) ? s.price : null);
    for (const c of Array.isArray(list) ? list : []) {
      if (c && c.id) out.push(scoreFlag(sym, c, s.timeframes, price, opts, s.geometryContext));
    }
  }
  return out
    .filter((e) => e.stage !== 'missed')
    .sort((a, b) => (STAGE_RANK[b.stage] - STAGE_RANK[a.stage])
      || (b.score - a.score) || (b.of - a.of)
      || ((FLOW_STATE_RANK[b.st] || 0) - (FLOW_STATE_RANK[a.st] || 0))
      || (tfMs(b.tf) - tfMs(a.tf))
      || ((b.levels.rr ?? -Infinity) - (a.levels.rr ?? -Infinity)));
}

/** Candidate-snapshot shape for state.buttons[ref], so Lock resolves it (satisfies lockLevels). */
export function snapshotOf(entry) {
  const lv = entry.levels;
  return {
    symbol: entry.symbol, candidateId: entry.id, timeframe: entry.tf, direction: entry.dir, state: entry.st,
    entry: lv.entry, stop: lv.stop, tp1: lv.target, tp2: lv.tp2, breakoutLevel: lv.entry, invalidation: lv.stop,
    measuredTarget: lv.target, measuredRR: lv.rr, recClass: 'FLOW', planStatus: entry.stage
  };
}

const fmtRR = (rr) => (isNum(rr) ? `${rr.toFixed(1)}R` : 'n/a');
const checklistScore = (e) => `${e.score}/${e.of}`;
const dirWord = (e) => (e.dir === 'short' ? 'below' : 'above');
const checkRow = (e) => `<code>${escapeHtml(checklistLine(e.check))}</code>`;

/** 🔍 FOUND card: a gate-passing flag before its trigger. */
export function formatFoundCard(entry, nowMs) {
  const lv = entry.levels;
  const head = msgHeader('🟡', entry.symbol, entry.tf, entry.dir, '🔍 FOUND');
  const call = `<b>Watch</b> — ${escapeHtml(entry.tf)} flag, checklist ${checklistScore(entry)}. Trigger on a ${escapeHtml(entry.tf)} close ${dirWord(entry)} ${escapeHtml(fmtLvl(lv.entry))}.`;
  const levels = codeBlock([['trigger', fmtLvl(lv.entry)], ['stop', fmtLvl(lv.stop)], ['target', fmtLvl(lv.target)], ['R:R', fmtRR(lv.rr)]]);
  return joinSections([head, call, levels, checkRow(entry)]);
}

/**
 * 🎯 LOCK OPPORTUNITY card (the shared call format): GO IN, levels block, checklist, Lock prompt.
 * No percentages (the engine has no odds). R:R is to TP1.
 */
export function formatOpportunityCard(entry, nowMs) {
  const lv = entry.levels;
  const confirmed = entry.st === 'confirmed';
  const head = msgHeader('🟢', entry.symbol, entry.tf, entry.dir, '🎯 LOCK OPPORTUNITY');
  const call = `<b>GO IN</b> — ${escapeHtml(entry.tf)} flag ${confirmed ? 'confirmed' : 'triggering'}, checklist ${checklistScore(entry)}.`;
  const confirm = confirmed ? 'confirmed' : `${entry.tf} close ${dirWord(entry)} ${fmtLvl(lv.entry)}`;
  const levels = codeBlock([
    ['entry', fmtLvl(lv.entry)], ['confirm', confirm], ['invalidation', fmtLvl(lv.stop)], ['stop', fmtLvl(lv.stop)],
    ['TP1', fmtLvl(lv.target)], ['TP2', fmtLvl(lv.tp2)], ['R:R', fmtRR(lv.rr)], ['no-chase cap', fmtLvl(lv.cap)]
  ], { alignValues: false });
  return joinSections([head, call, escapeHtml(timingLine(entry)), levels, checkRow(entry), 'Tap 🔒 Lock to freeze these levels.']);
}

/** Flag timeframes that get a ⏳ BREAKING heads-up before their close (slow closes only). */
export const BREAKING_TIMEFRAMES = Object.freeze(['15m', '1h', '4h']);
/** A lock opportunity stays valid this many candles of its own timeframe (matches the lock expiry). */
export const OPPORTUNITY_WINDOW_CANDLES = 6;

/** 754_000 -> "12 min"; 5_400_000 -> "1 h 30 min"; 2 days -> "2 d". */
export function fmtWindow(ms) {
  if (!isNum(ms) || ms < 60_000) return 'under a minute';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(h / 24)} d`;
}

/**
 * How actionable an opportunity is: always ENTER NOW (the confirming close already happened), valid
 * until price passes the no-chase cap, within a window of OPPORTUNITY_WINDOW_CANDLES of its own timeframe.
 * "⏱ ENTER NOW · valid until price passes 86,580.00 · ~6 h window (6 × 1h candles)"
 */
export function timingLine(entry) {
  const span = fmtWindow(OPPORTUNITY_WINDOW_CANDLES * (LOCK_TF_MS[entry.tf] || 0));
  const cap = isNum(entry.levels && entry.levels.cap) ? ` · valid until price passes ${fmtLvl(entry.levels.cap)}` : '';
  return `⏱ ENTER NOW${cap} · ~${span} window (${OPPORTUNITY_WINDOW_CANDLES} × ${entry.tf} candles)`;
}

/**
 * ⏳ BREAKING: a gate-passing 15m/1h/4h flag still forming whose live price is already past its
 * breakout level, before the candle closes. Returns {closeInMs} (time to that timeframe's close), or null.
 */
export function breakingOf(entry, nowMs) {
  if (!entry || !BREAKING_TIMEFRAMES.includes(entry.tf) || entry.stage !== 'found') return null;
  if (!FOUND_STATES.includes(entry.st) || entry.st === 'triggering') return null;
  const dir = dirOf(entry.dir);
  if (!isNum(entry.price) || !isNum(entry.levels && entry.levels.entry) || (entry.price - entry.levels.entry) * dir <= 0) return null;
  const ms = LOCK_TF_MS[entry.tf];
  return { closeInMs: Math.ceil((nowMs + 1) / ms) * ms - nowMs };
}

/** "⏳ BREAKING · BTC 1h above 86,400.00 now · the 1h close in 12 min decides it" — heads-up only, no Lock. */
export function formatBreakingCard(entry, nowMs) {
  const b = breakingOf(entry, nowMs);
  const head = msgHeader('🟡', entry.symbol, entry.tf, entry.dir, '⏳ BREAKING');
  const line = `<b>Heads-up</b> — price is ${dirWord(entry)} ${fmtLvl(entry.levels.entry)} now. The ${escapeHtml(entry.tf)} close${b ? ` in ${fmtWindow(b.closeInMs)}` : ''} decides it.`;
  const levels = codeBlock([['trigger', fmtLvl(entry.levels.entry)], ['now', fmtLvl(entry.price)], ['stop', fmtLvl(entry.levels.stop)], ['TP1', fmtLvl(entry.levels.target)]], { alignValues: false });
  return joinSections([head, line, levels, checkRow(entry), 'Not an entry yet. A 🎯 LOCK OPPORTUNITY follows if the close holds.']);
}

const STAGE_TAG = Object.freeze({ lockable: '🎯 LOCK', found: '🔍 FOUND', watch: '· watching' });

/** 🧭 FLAGS NOW: pulse line + the top `boardSize` entries, or the empty state. */
export function formatBoard(ranked, pulse, nowMs, opts = {}) {
  const size = opts.boardSize || FLOW_DEFAULTS.boardSize;
  const list = (Array.isArray(ranked) ? ranked : []).slice(0, size);
  const title = '🧭 <b>FLAGS NOW</b>';
  const pl = pulse ? escapeHtml(pulseLine(pulse)) : null;
  if (!list.length) return joinSections([title, 'No flags passing the checklist right now.', pl]);
  const blocks = list.map((e) => {
    const lv = e.levels;
    const arrow = e.dir === 'short' ? '▼' : '▲';
    return [
      `${STAGE_TAG[e.stage] || STAGE_TAG.watch}  <b>${escapeHtml(`${e.symbol} ${e.tf} ${arrow}`)}</b>`,
      `<code>${escapeHtml(`entry ${fmtLvl(lv.entry)} · stop ${fmtLvl(lv.stop)} · TP1 ${fmtLvl(lv.target)} · TP2 ${fmtLvl(lv.tp2)} · ${fmtRR(lv.rr)}`)}</code>`,
      `checklist ${checklistScore(e)}`
    ].join('\n');
  });
  return joinSections([title, pl, ...blocks]);
}

/** Buttons under an opportunity / board entry: 🔒 Lock · Chart. */
export function flowKeyboard(entry) {
  return {
    inline_keyboard: [[
      { text: '🔒 Lock', callback_data: `lock:${entry.ref}` },
      { text: `Chart ${entry.tf}`, callback_data: `chart:${entry.symbol}:${entry.tf}` }
    ]]
  };
}

const countSince = (map, cutoff) => {
  if (Array.isArray(map)) return map.filter((at) => Date.parse(at) >= cutoff).length;
  if (map && typeof map === 'object') return Object.values(map).filter((at) => Date.parse(at) >= cutoff).length;
  return 0;
};

/**
 * 24h pulse from state.flow ({found:{id:atIso}, opps:{id:atIso}, locked: number | {id:atIso} | [atIso]}).
 * A numeric `locked` is taken as already scoped to 24h.
 */
export function pulseOf(flowState, nowMs) {
  const f = flowState && typeof flowState === 'object' ? flowState : {};
  const cutoff = nowMs - PULSE_WINDOW_MS;
  return {
    found: countSince(f.found, cutoff),
    opps: countSince(f.opps, cutoff),
    locked: isNum(f.locked) ? f.locked : countSince(f.locked, cutoff),
    since: new Date(cutoff).toISOString()
  };
}

/** "24h: 12 flags found · 4 lock opportunities · 1 locked". */
export function pulseLine(pulse) {
  const p = pulse || {};
  const n = (v) => (isNum(v) ? v : 0);
  return `24h: ${n(p.found)} ${n(p.found) === 1 ? 'flag' : 'flags'} found · ${n(p.opps)} ${n(p.opps) === 1 ? 'lock opportunity' : 'lock opportunities'} · ${n(p.locked)} locked`;
}
