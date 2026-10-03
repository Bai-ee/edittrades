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

/**
 * The one snapshot every flag / lock message uses (owner 2026-10-02: same format everywhere, small
 * light markers, no TP2):
 *   🟢 BTC 1h ▲ · LOCK NOW
 *     86,400.00  Entry
 *     86,580.00  Valid to
 *     85,900.00  Invalidation
 *     85,900.00  SL
 *   Checklist 7/7
 *   ⏱ Enter now · ~6 h window
 * Status dots: 🟢 lock now / take · 🟡 forming, breaking, locked waiting · ⚪ watching · 🔵 in trade · ✅ / 🔴 done.
 * Rows are a plain inset (no markers). Telegram cannot color text; the website colors the values
 * (green entry, orange invalidation, red stop, blue no-chase limit).
 * @param {{dot:string, symbol:string, tf:string, dir:string, status:string,
 *   levels:{entry:number, invalidation:number, stop:number, validTo:number|null}, checklist:string|null, foot:string|null}} p
 */
export function snapshotCard({ dot, symbol, tf, dir, status, levels, checklist, foot }) {
  const arrow = dir === 'short' ? '▼' : '▲';
  const lv = levels || {};
  // Plain inset rows (owner: no symbols); the website colors the values, Telegram cannot.
  // Number first, then the label; numbers right-aligned to one width so the labels line up.
  const nums = [lv.entry, lv.validTo, lv.invalidation, lv.stop].filter(isNum).map((v) => fmtLvl(v));
  const w = Math.max(0, ...nums.map((x) => x.length));
  // Three-space inset puts the numbers under the ticker's first letter (after the status dot).
  const row = (label, v) => (isNum(v) ? `<code>${escapeHtml(`   ${fmtLvl(v).padStart(w)}  ${label}`)}</code>` : null);
  return [
    `${dot} <b>${escapeHtml(`${symbol} ${tf} ${arrow}`)}</b> · ${escapeHtml(status)}`,
    row('Entry', lv.entry),
    row('Valid to', lv.validTo),
    row('Invalidation', lv.invalidation),
    row('SL', lv.stop),
    checklist ? escapeHtml(checklist) : null,
    foot ? escapeHtml(foot) : null
  ].filter(Boolean).join('\n');
}

/** Short divider between snapshots (the 16-char RULE wraps in a phone bubble). */
export const SNAP_RULE = '──────────';

/** Dot, status word and last line for a scored flag, by stage. */
export function flagStatus(entry, nowMs) {
  const lv = entry.levels;
  if (entry.stage === 'lockable') {
    const span = fmtWindow(OPPORTUNITY_WINDOW_CANDLES * (LOCK_TF_MS[entry.tf] || 0));
    return { dot: '🟢', status: 'LOCK NOW', foot: `⏱ Enter now · ~${span} window` };
  }
  const b = breakingOf(entry, nowMs);
  if (b) return { dot: '🟡', status: 'BREAKING', foot: `⏳ ${entry.tf} close in ${fmtWindow(b.closeInMs)} decides it · not an entry yet` };
  if (entry.stage === 'found') return { dot: '🟡', status: 'FORMING', foot: `⏳ Needs a ${entry.tf} close ${dirWord(entry)} ${fmtLvl(lv.entry)}` };
  if (entry.stage === 'missed') return { dot: '🔴', status: 'MISSED', foot: `Ran past ${fmtLvl(lv.cap)} · no chase` };
  return { dot: '⚪', status: 'WATCHING', foot: 'Not ready' };
}

/** The snapshot for one scored flag (board row and every flag alert). */
export function flagSnapshot(entry, nowMs) {
  const lv = entry.levels;
  return snapshotCard({
    ...flagStatus(entry, nowMs), symbol: entry.symbol, tf: entry.tf, dir: entry.dir,
    levels: { entry: lv.entry, invalidation: lv.stop, stop: lv.stop, validTo: lv.cap },
    checklist: `Checklist ${checklistScore(entry)}`
  });
}

/** 🔍 FOUND (board-only; kept for completeness): the forming snapshot. */
export function formatFoundCard(entry, nowMs) {
  return flagSnapshot({ ...entry, stage: 'found' }, nowMs);
}

/** 🎯 LOCK OPPORTUNITY alert: the lock-now snapshot (Lock + Chart buttons carry the action). */
export function formatOpportunityCard(entry, nowMs) {
  return flagSnapshot({ ...entry, stage: 'lockable' }, nowMs);
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

/** ⏳ BREAKING heads-up: the breaking snapshot (Chart button only, no Lock). */
export function formatBreakingCard(entry, nowMs) {
  return flagSnapshot(entry, nowMs);
}

/** 🧭 FLAGS NOW: one header line with the pulse, then up to `boardSize` snapshots split by SNAP_RULE. */
export function formatBoard(ranked, pulse, nowMs, opts = {}) {
  const size = opts.boardSize || FLOW_DEFAULTS.boardSize;
  const list = (Array.isArray(ranked) ? ranked : []).slice(0, size);
  const title = `🧭 <b>FLAGS NOW</b>${pulse ? ` · ${escapeHtml(pulseLine(pulse))}` : ''}`;
  if (!list.length) return [title, SNAP_RULE, 'No flags passing the checklist right now.'].join('\n');
  return [title, ...list.flatMap((e) => [SNAP_RULE, flagSnapshot(e, nowMs)])].join('\n');
}

/** Buttons under an opportunity / board entry: 🔒 Lock · Chart. */
export function flowKeyboard(entry) {
  const chart = { text: `Chart ${entry.symbol} ${entry.tf}`, callback_data: `chart:${entry.symbol}:${entry.tf}` };
  // Lock only where the checklist passes: a watching (1/7) flag gets the chart, never a lock invitation.
  const lockable = entry.stage === 'lockable' || entry.stage === 'found';
  return { inline_keyboard: [lockable ? [{ text: `🔒 Lock ${entry.symbol} ${entry.tf}`, callback_data: `lock:${entry.ref}` }, chart] : [chart]] };
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
  // Counting starts when the flow first ran (state.flow.since); until a full day exists the label says "since HH:MMZ".
  const started = Date.parse(f.since);
  const partial = Number.isFinite(started) && started > cutoff;
  return {
    found: countSince(f.found, cutoff),
    opps: countSince(f.opps, cutoff),
    locked: isNum(f.locked) ? f.locked : countSince(f.locked, cutoff),
    since: new Date(partial ? started : cutoff).toISOString(),
    partial
  };
}

/** "24h: 12 found · 4 lock opps · 1 locked", or "since 01:31Z: …" while under a day of data. */
export function pulseLine(pulse) {
  const p = pulse || {};
  const n = (v) => (isNum(v) ? v : 0);
  const label = p.partial && p.since ? `since ${String(p.since).slice(11, 16)}Z` : '24h';
  return `${label}: ${n(p.found)} found · ${n(p.opps)} lock ${n(p.opps) === 1 ? 'opp' : 'opps'} · ${n(p.locked)} locked`;
}
