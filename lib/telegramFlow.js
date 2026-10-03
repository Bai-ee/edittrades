/**
 * Telegram side of the flag flow (docs/PLAN_FLAG_FLOW.md, section C): the cron's LOCK_OPPORTUNITY
 * diff over `payload.flagBoard`, the /signals board message, and the 24h pulse inputs.
 * Scoring, ranking and card formatting are lib/flagFlow.js; the lock is lib/telegramLock.js.
 *
 * state.flow = { found:{id:atIso}, opps:{id:atIso}, breaking:{id:atIso}, lastFoundAt:{'SYM|tf':atIso} }, pruned to 24h.
 * state.buttons[ref] = snapshotOf(entry) for every sent LOCK_OPPORTUNITY, so 🔒 Lock resolves it.
 * Imports telegram.js (never the other way round), same pattern as telegramLock.js.
 */
import { BUTTON_MEMORY, tradeOverlayFor } from './telegram.js';
import { normalizeLocks, openLocks, checklistLine, timeframesAbove } from './tradeLock.js';
import {
  FLOW_DEFAULTS, rankFlags, snapshotOf, breakingOf, formatBreakingCard, formatOpportunityCard, formatBoard, flowKeyboard, pulseOf
} from './flagFlow.js';

const FLOW_WINDOW_MS = 24 * 3_600_000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Alert kinds the flow replaces in flow mode (their sends are dropped; classic bookkeeping still runs). */
export const FLOW_DROPS = Object.freeze([
  'WATCH', 'TRIGGERING', 'BREAKOUT', 'SETUP', 'GOOD', 'GOOD_ENDED', 'TRACK', 'NUDGE',
  'HTF_DIRECTION', 'HTF_ENTRY', 'HTF_EXIT', 'RETEST_1H', 'RETEST_1H_EXIT', 'SLOW_TREND'
]);

/** Drop the classic kinds from an alert list (flow mode only). LOCK, MARK, DATA, DATA_OK, FOCUS, EXEC stay. */
export function dropClassicAlerts(alerts) {
  return (Array.isArray(alerts) ? alerts : []).filter((a) => !FLOW_DROPS.includes(a && a.kind));
}

/** state.flow of any shape -> {found, opps, lastFoundAt} (a pre-opps `ready` map counts as opps), entries older than 24h dropped. */
export function normalizeFlow(raw, nowMs) {
  const f = isObj(raw) ? raw : {};
  const cutoff = nowMs - FLOW_WINDOW_MS;
  const keep = (m) => Object.fromEntries(Object.entries(isObj(m) ? m : {}).filter(([, at]) => Date.parse(at) >= cutoff));
  // Older states (before `since` existed) start counting at their earliest recorded flag.
  const stamps = [f.found, f.opps, f.ready, f.breaking].flatMap((m) => Object.values(isObj(m) ? m : {})).filter((at) => Number.isFinite(Date.parse(at))).sort();
  const since = typeof f.since === 'string' && Number.isFinite(Date.parse(f.since)) ? f.since : (stamps[0] || null);
  return { since, found: keep(f.found), opps: keep({ ...(isObj(f.ready) ? f.ready : {}), ...(isObj(f.opps) ? f.opps : {}) }), breaking: keep(f.breaking), lastFoundAt: keep(f.lastFoundAt) };
}

/** Locks created in the last 24h (any status), for the pulse line. */
export function lockedCount24h(state, nowMs) {
  const cutoff = nowMs - FLOW_WINDOW_MS;
  return normalizeLocks(state && state.locks, nowMs).filter((l) => Date.parse(l.lockedAt) >= cutoff).length;
}

/** The 24h pulse for the board: found / opps from state.flow, locked from state.locks. */
export function flowPulse(state, nowMs) {
  return pulseOf({ ...normalizeFlow(state && state.flow, nowMs), locked: lockedCount24h(state, nowMs) }, nowMs);
}

function keepNewest(buttons) {
  const entries = Object.entries(isObj(buttons) ? buttons : {}).filter(([, v]) => isObj(v));
  entries.sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
  return Object.fromEntries(entries.slice(-BUTTON_MEMORY));
}

/** Checklist detail logged with every flow alert (the tracker's tuning table buckets on it). */
const flowMetaOf = (e) => {
  const up = timeframesAbove(e.tf, 1)[0];
  const upRow = up && e.check && Array.isArray(e.check.rows) ? e.check.rows.find((r) => r.tf === up) : null;
  return {
    score: e.score, of: e.of, rr: e.levels.rr, stage: e.stage, tfs: checklistLine(e.check),
    vol: e.evidence ? e.evidence.volume.quality : null, volx: e.evidence ? e.evidence.volume.breakoutRelVol : null,
    rsi: e.evidence ? e.evidence.rsi : null, div: e.evidence ? e.evidence.divergence.type : null, ev: e.evidence ? e.evidence.verdict : null,
    nextTf: !upRow ? null : (upRow.mark === '✅' ? 'agrees' : (upRow.mark === '❌' ? 'disagrees' : 'mixed'))
  };
};

const trackLevelsOf = (entry) => ({
  timeframe: entry.tf, direction: entry.dir, breakoutLevel: entry.levels.entry, invalidation: entry.levels.stop,
  entry: entry.levels.entry, stop: entry.levels.stop, tp1: entry.levels.target
});

/**
 * One cron tick: LOCK_OPPORTUNITY once per candidateId (and at most one per symbol+tf per
 * foundCooldownMs). FOUND is never pushed; a staged `found` entry is only recorded in state.flow.found
 * for the pulse. A candidate with an open lock is skipped. Mutates state.flow and state.buttons;
 * reads the FULL build (timeframes need candles for the checklist and the cap).
 * @returns {{alerts:Array<Object>, changed:boolean}}
 */
export function diffFlow(state, payload, nowMs, opts = {}) {
  const cfg = { ...FLOW_DEFAULTS, ...opts };
  const before = JSON.stringify(state.flow ?? null);
  const flow = normalizeFlow(state.flow, nowMs);
  // When counting began: the pulse says "since HH:MMZ" until a full day of data exists.
  if (!flow.since) flow.since = new Date(nowMs).toISOString();
  const alerts = [];
  const dataOk = payload && payload.dataStatus !== 'unavailable' && isObj(payload.flagBoard);
  if (dataOk) {
    const nowIso = new Date(nowMs).toISOString();
    const locked = new Set(openLocks(normalizeLocks(state.locks, nowMs)).map((l) => l.candidateId).filter(Boolean));
    const snaps = {};
    for (const e of rankFlags(payload.flagBoard, payload.symbols, opts)) {
      if (locked.has(e.id)) continue;
      if (e.stage === 'found') {
        flow.found[e.id] = flow.found[e.id] || nowIso;
        // ⏳ BREAKING: a 15m/1h/4h flag already past its trigger before the close — one heads-up, no Lock.
        if (!flow.breaking[e.id] && breakingOf(e, nowMs)) {
          flow.breaking[e.id] = nowIso;
          alerts.push({
            kind: 'BREAKING', symbol: e.symbol, candidateId: e.id, ref: e.ref, text: formatBreakingCard(e, nowMs),
            replyMarkup: { inline_keyboard: [[{ text: `Chart ${e.tf}`, callback_data: `chart:${e.symbol}:${e.tf}` }]] }, trackLevels: trackLevelsOf(e), flow: flowMetaOf(e)
          });
        }
        continue;
      }
      if (e.stage !== 'lockable' || flow.opps[e.id]) continue;
      const key = `${e.symbol}|${e.tf}`;
      const last = Date.parse(flow.lastFoundAt[key]);
      if (Number.isFinite(last) && nowMs - last < cfg.foundCooldownMs) continue;
      flow.opps[e.id] = nowIso;
      flow.found[e.id] = flow.found[e.id] || nowIso;
      flow.lastFoundAt[key] = nowIso;
      snaps[e.ref] = { ...snapshotOf(e), at: nowIso };
      // One photo: the flag's own chart with entry / SL / TP drawn, the snapshot as its caption.
      const overlay = tradeOverlayFor({ direction: e.dir, entry: e.levels.entry, stop: e.levels.stop, tp1: e.levels.target }, { entryAt: nowIso });
      alerts.push({
        kind: 'LOCK_OPPORTUNITY', symbol: e.symbol, candidateId: e.id, ref: e.ref,
        text: formatOpportunityCard(e, nowMs), replyMarkup: flowKeyboard(e), trackLevels: trackLevelsOf(e), flow: flowMetaOf(e),
        ...(overlay && e.levels.target != null ? { chart: { symbol: e.symbol, timeframe: e.tf, tradeOverlay: overlay, indicators: ['rsi14'] } } : {})
      });
    }
    if (Object.keys(snaps).length) state.buttons = keepNewest({ ...state.buttons, ...snaps });
  }
  state.flow = flow;
  return { alerts, changed: JSON.stringify(flow) !== before };
}

/**
 * /signals in flow mode: the board text, one stacked Lock/Chart row per shown entry, and the
 * snapshots to store in state.buttons so those Lock taps resolve.
 * @returns {{text:string, replyMarkup:Object|null, snaps:Array<Object>}}
 */
export function flowBoardMessage(payload, state, nowMs, opts = {}) {
  const size = opts.boardSize || FLOW_DEFAULTS.boardSize;
  const ranked = rankFlags(payload && payload.flagBoard, payload && payload.symbols, opts);
  const shown = ranked.slice(0, size);
  return {
    text: formatBoard(ranked, flowPulse(state, nowMs), nowMs, opts),
    replyMarkup: shown.length ? { inline_keyboard: shown.map((e) => flowKeyboard(e).inline_keyboard[0]) } : null,
    snaps: shown.map(snapshotOf)
  };
}
