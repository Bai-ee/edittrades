/**
 * Flag flow (owner-approved 2026-10-02, docs/PLAN_FLAG_FLOW.md): the four-step Telegram UX.
 *
 *   FOUND  a flag passing the confluence gate on any timeframe 1m-4h, before its trigger
 *   READY  that flag confirmed (trigger-TF close past the breakout), still inside the no-chase cap
 *   LOCK   the existing trade lock (lib/tradeLock.js)
 *   DONE   the existing lock terminal states
 *
 * This module is the pure part: it scores the engine's `flagBoard` entries, ranks them, builds
 * the button snapshot a Lock resolves from, and formats the FOUND / READY / board cards.
 * Levels are structural: entry = breakout level, stop = flag invalidation, target = measured
 * move (R:R is information, no 3% cap here). The cap is the lock's no-chase distance
 * (capAtr x ATR of the trigger timeframe), shown on the card and used for MISSED.
 *
 * Pure functions, no I/O. Direction-symmetric: every comparison runs through `dir` (+1/-1).
 */
import { confluenceChecklist, closedCandles, simpleAtr, checklistLine, LOCK_TF_MS } from './tradeLock.js';
import { escapeHtml, msgHeader, codeBlock, joinSections, fmtLvl, shortRef } from './telegram.js';

export const FLOW_DEFAULTS = Object.freeze({ capAtr: 1.5, boardSize: 3, foundCooldownMs: 15 * 60_000 });
export const FLOW_STATE_RANK = Object.freeze({ confirmed: 4, triggering: 3, forming: 2, proto: 1 });

const PULSE_WINDOW_MS = 24 * 3_600_000;
const STAGE_RANK = Object.freeze({ ready: 3, found: 2, watch: 1 });
const FOUND_STATES = Object.freeze(['triggering', 'forming', 'proto']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const dirOf = (direction) => (direction === 'short' ? -1 : (direction === 'long' ? 1 : 0));
const tfMs = (tf) => LOCK_TF_MS[tf] || 0;

/**
 * One board entry for a flagBoard candidate, scored against that symbol's payload timeframes.
 * @param {string} symbol
 * @param {{id:string, tf:string, dir:string, st:string, brk:number, inv:number, tgt:number|null, rr:number|null}} c
 * @param {Object} timeframes - payload.symbols[sym].timeframes (full build: candles present)
 * @param {number|null} price - live price
 */
export function scoreFlag(symbol, c, timeframes, price, opts = {}) {
  const cfg = { ...FLOW_DEFAULTS, ...opts };
  const dir = dirOf(c.dir);
  const tfs = timeframes && typeof timeframes === 'object' ? timeframes : {};
  const atr = simpleAtr(closedCandles(tfs[c.tf], c.tf));
  const cap = isNum(atr) && atr > 0 && isNum(c.brk) ? Math.round((c.brk + dir * cfg.capAtr * atr) * 100) / 100 : null;
  const check = confluenceChecklist(tfs, c.dir, c.tf);
  const confirmed = c.st === 'confirmed';
  const missed = confirmed && isNum(price) && isNum(cap) && (price - cap) * dir > 0;
  let stage = 'watch';
  if (missed) stage = 'missed';
  else if (confirmed && check.gate) stage = 'ready';
  else if (FOUND_STATES.includes(c.st) && check.gate) stage = 'found';
  return {
    symbol, id: c.id, ref: shortRef(c.id), tf: c.tf, dir: c.dir, st: c.st,
    levels: { entry: c.brk, stop: c.inv, target: isNum(c.tgt) ? c.tgt : null, rr: isNum(c.rr) ? c.rr : null, cap },
    check, gate: check.gate, score: check.score, of: check.of, stage
  };
}

/**
 * All symbols' entries, best first. Stage (ready > found > watch; missed dropped), then
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
      if (c && c.id) out.push(scoreFlag(sym, c, s.timeframes, price, opts));
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
    entry: lv.entry, stop: lv.stop, tp1: lv.target, breakoutLevel: lv.entry, invalidation: lv.stop,
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

/** 🎯 READY card: trigger hit, levels, cap, one Lock prompt. */
export function formatReadyCard(entry, nowMs) {
  const lv = entry.levels;
  const head = msgHeader('🟢', entry.symbol, entry.tf, entry.dir, '🎯 READY');
  const call = `<b>Trigger hit</b> — entry ${escapeHtml(fmtLvl(lv.entry))} · stop ${escapeHtml(fmtLvl(lv.stop))} · target ${escapeHtml(fmtLvl(lv.target))} (${escapeHtml(fmtRR(lv.rr))}).`;
  const levels = codeBlock([
    ['entry', fmtLvl(lv.entry)], ['stop', fmtLvl(lv.stop)], ['target', fmtLvl(lv.target)],
    ['R:R', fmtRR(lv.rr)], ['no-chase cap', fmtLvl(lv.cap)]
  ]);
  return joinSections([head, call, levels, checkRow(entry), 'Tap 🔒 Lock to freeze these levels.']);
}

const STAGE_TAG = Object.freeze({ ready: '🎯 READY', found: '🔍 FOUND', watch: '· watching' });

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
      `<code>${escapeHtml(`trig ${fmtLvl(lv.entry)} · stop ${fmtLvl(lv.stop)} · tgt ${fmtLvl(lv.target)} · ${fmtRR(lv.rr)}`)}</code>`,
      `checklist ${checklistScore(e)}`
    ].join('\n');
  });
  return joinSections([title, pl, ...blocks]);
}

/** Buttons under a FOUND / READY card: 🔒 Lock · Chart. */
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
 * 24h pulse from state.flow ({found:{id:atIso}, ready:{id:atIso}, locked: number | {id:atIso} | [atIso]}).
 * A numeric `locked` is taken as already scoped to 24h.
 */
export function pulseOf(flowState, nowMs) {
  const f = flowState && typeof flowState === 'object' ? flowState : {};
  const cutoff = nowMs - PULSE_WINDOW_MS;
  return {
    found: countSince(f.found, cutoff),
    ready: countSince(f.ready, cutoff),
    locked: isNum(f.locked) ? f.locked : countSince(f.locked, cutoff),
    since: new Date(cutoff).toISOString()
  };
}

/** "24h: 12 flags found · 4 ready · 1 locked". */
export function pulseLine(pulse) {
  const p = pulse || {};
  const n = (v) => (isNum(v) ? v : 0);
  return `24h: ${n(p.found)} ${n(p.found) === 1 ? 'flag' : 'flags'} found · ${n(p.ready)} ready · ${n(p.locked)} locked`;
}
