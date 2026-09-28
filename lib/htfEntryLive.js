/**
 * Live HTF-anchored entry wiring (T-20, docs/PROMPT_T20_HTF_ENTRY.md, owner-approved
 * "ships live-capable" 2026-09-27). Runs the SAME `lib/htfEntryRule.js` functions
 * (`htfDirectionAt`, `checkHtfTrigger`, `buildHtfPlan`) against LIVE closed candles instead
 * of a research fixture, so `api/telegram-cron.js` can alert the owner the moment direction
 * changes or a trigger fires, and `api/telegram-webhook.js` can route an `open:<ref>` tap
 * for an HTF entry through its OWN dedicated intent builder (never `candidateLevels`/
 * `orderIntentFromCandidate` - those stay exactly as they are for the flag family, and
 * retest1h's Open refusal is untouched).
 *
 * Isolation (test-telegram.js): api/telegram-cron.js and lib/telegram.js must never import
 * anything under lib/execution/. `fetchClosedCandles`/`positionIdHash` are re-exported from
 * lib/retest1hLive.js (that module already duplicates lib/execution/audit.js's `idHash`
 * byte-for-byte using only Node's built-in `crypto`, precisely for this isolation reason;
 * reusing it here keeps a single duplicate, not two).
 *
 * Cadence split (mirrors lib/retest1hLive.js's own split of cheap-per-tick vs
 * full-per-new-close work):
 *   - Direction (4h+1D EMA21/EMA200 stack): recomputed only once per NEWLY closed 1h candle
 *     (`evaluateHtfDirectionFull`) - the cron's own `evaluateHtfEntry` orchestrator (in
 *     api/telegram-cron.js) gates this behind the same `latestClosed1hCandle` cheap check
 *     retest1h uses, and remembers the result in `state.htf.direction[symbol]`.
 *   - Trigger (1m/3m/5m flag reaching `triggering`): checked every cron tick
 *     (`evaluateHtfTriggerFull`) whenever a direction is already on file - 3m/5m are only
 *     actually fetched on their own aligned close (`closesAt`, lib/htfEntryRule.js), so a
 *     1-minute cron cadence never re-fetches a 5m candle 5 times for the same close.
 */

import { calculateAllIndicators } from '../services/indicators.js';
import { buildGeometryContext } from './geometry.js';
import { getCandlesWithProvenance } from '../services/marketData.js';
import { positionPlan } from './riskEngine.js';
import { ENGINE_CONFIG } from '../config/engine.js';
import {
  htfDirectionAt, checkHtfTrigger, buildHtfPlan, htfCandidateId, isHtfCandidateId,
  htfStructureHoldRule, LIVE_TRIGGER_TIMEFRAMES, HOLD_MAX_HOURS, COOLDOWN_MS, closesAt,
  swingAnchorAndTarget, htfStop, stopPct as ruleStopPct, grossRR as ruleGrossRR, STOP_SWING_BUFFER_ATR
} from './htfEntryRule.js';
import { fetchClosedCandles, positionIdHash } from './retest1hLive.js';
import { escapeHtml, fmtPrice, dirArrow, shortRef } from './telegram.js';

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export const HTF_DIRECTION_KIND = 'HTF_DIRECTION';
export const HTF_ENTRY_KIND = 'HTF_ENTRY';
export const HTF_EXIT_KIND = 'HTF_EXIT';
export const HTF_SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL']);
export const HTF_CANDLE_LIMIT = 720; // Kraken's public OHLC cap regardless of requested count (see lib/retest1hLive.js)
export const HTF_TF = '1h';
export const HTF_HOLD_MAX_HOURS = HOLD_MAX_HOURS;
export const HTF_COOLDOWN_MS = COOLDOWN_MS;
/** Minimum closed candles calculateAllIndicators needs for a usable EMA200 (mirrors config/engine.js replay.minComputeCandles). */
export const MIN_INDICATOR_CANDLES = 200;

export { isHtfCandidateId, htfCandidateId };
export { positionIdHash };

/** The latest CLOSED 1h candle for `symbol`, or null - the cheap once-per-tick check. */
export async function latestClosedHtfCandle(symbol, opts = {}) {
  const candles = await fetchClosedCandles(symbol, HTF_TF, opts);
  return candles.length ? candles[candles.length - 1] : null;
}

/** Production geometry (buildGeometryContext, real indicators) for `tf`. Null short of MIN_INDICATOR_CANDLES or on any compute error. */
export function buildGeometryFor(tf, candles) {
  if (!Array.isArray(candles) || candles.length < MIN_INDICATOR_CANDLES) return null;
  try {
    const ind = calculateAllIndicators(candles);
    return buildGeometryContext({
      timeframe: tf, candles,
      ema21History: ind.ema.ema21History, ema200History: ind.ema.ema200History,
      stochHistory: ind.stochRSI && ind.stochRSI.history
    });
  } catch {
    return null;
  }
}

/**
 * The T-20 direction for `symbol`, from live 4h/1D closed candles. Only worth calling once
 * a new 1h close has already been detected (the caller's own cheap gate); this function
 * itself does not check that.
 * @returns {Promise<{direction:'long'|'short'|null, candles4h:Array, candles1d:Array}>}
 */
export async function evaluateHtfDirectionFull(symbol, { fetchCandles = getCandlesWithProvenance, nowMs = Date.now() } = {}) {
  const opts = { fetchCandles, nowMs, limit: HTF_CANDLE_LIMIT };
  const [c4h, c1d] = await Promise.all([
    fetchClosedCandles(symbol, '4h', opts),
    fetchClosedCandles(symbol, '1d', opts)
  ]);
  const direction = htfDirectionAt({ candles4h: c4h, candles1d: c1d });
  return { direction, candles4h: c4h, candles1d: c1d };
}

/**
 * The DIRECTION card's own numbers (structureStop / stopPct / tp1 / grossRR): the SAME
 * 1h swing anchor + impulse-projected target `buildHtfPlan` uses, but with no trigger yet
 * - so there is no real entry to price a plan against. Uses the latest closed 1h candle's
 * close as a geometric entry stand-in (paired with the chart's `hideEntryMarker: true`;
 * see this module's header and lib/chartRender.js) purely so `swingAnchorAndTarget`'s own
 * stop/target math (identical to a real plan's) has a reference point - never published as
 * an "entry" anywhere in the DIRECTION card's text. Never gates on R:R (this is a preview,
 * not a trade); returns null only when there is no confirmed 1h swing yet.
 * @returns {Promise<{structureStop:number, stop:number|null, stopPct:number|null, tp1:number, grossRR:number|null, currentPrice:number}|null>}
 */
export async function previewHtfDirection(symbol, direction, { fetchCandles = getCandlesWithProvenance, nowMs = Date.now() } = {}) {
  const opts = { fetchCandles, nowMs, limit: HTF_CANDLE_LIMIT };
  const [c1h, c15m] = await Promise.all([fetchClosedCandles(symbol, '1h', opts), fetchClosedCandles(symbol, '15m', opts)]);
  if (!c1h.length) return null;
  const currentPrice = c1h[c1h.length - 1].close;
  const swing = swingAnchorAndTarget(c1h, direction);
  if (!swing) return null;
  const geometry1h = buildGeometryFor('1h', c1h);
  const geometry15m = buildGeometryFor('15m', c15m);
  const atr1h = geometry1h && isFiniteNumber(geometry1h.atr) ? geometry1h.atr : null;
  const atr15m = geometry15m && isFiniteNumber(geometry15m.atr) ? geometry15m.atr : null;
  const sign = direction === 'short' ? -1 : 1;
  // Preview only - no RR/scalp-cap gate (unlike buildHtfPlan): a wide preview stop or a
  // sub-2.5R target is still worth showing the owner ("nothing yet" either way), whereas a
  // real trigger's plan would reject it outright.
  const structureStop = swing.anchor.price - sign * STOP_SWING_BUFFER_ATR * (atr1h ?? 0);
  const stop = isFiniteNumber(atr1h) ? htfStop({ direction, entry: currentPrice, anchorPrice: swing.anchor.price, atr1h, atr15m }) : structureStop;
  const finalStopPct = ruleStopPct(currentPrice, stop);
  const grossRR = ruleGrossRR(direction, currentPrice, stop, swing.target);
  return { structureStop, stop, stopPct: finalStopPct, tp1: swing.target, grossRR, currentPrice };
}

/**
 * The T-20 trigger + plan for `symbol` in `direction`, from live candles. Fetches 1m
 * always; 3m/5m only on their own aligned close (`closesAt`) - a 1-minute cron tick never
 * re-fetches a 5m candle for the same still-open 5-minute window. Requires 1h (swing
 * anchor/target) and 15m (NF floor ATR) geometry, built from real indicators exactly as
 * production's own flag/retest paths do.
 * @returns {Promise<{trigger:Object|null, plan:Object|null, latest1h:Object|null}>}
 */
export async function evaluateHtfTriggerFull(symbol, direction, { fetchCandles = getCandlesWithProvenance, nowMs = Date.now() } = {}) {
  const opts = { fetchCandles, nowMs, limit: HTF_CANDLE_LIMIT };
  const c1m = await fetchClosedCandles(symbol, '1m', opts);
  if (!c1m.length) return { trigger: null, plan: null, latest1h: null };
  const cutMs = c1m[c1m.length - 1].closeTime;

  const fetches = { '1m': Promise.resolve(c1m) };
  for (const tf of ['3m', '5m']) {
    fetches[tf] = closesAt(tf, cutMs) ? fetchClosedCandles(symbol, tf, opts) : Promise.resolve([]);
  }
  const [c3m, c5m, c1h, c15m] = await Promise.all([fetches['3m'], fetches['5m'], fetchClosedCandles(symbol, '1h', opts), fetchClosedCandles(symbol, '15m', opts)]);

  const trigger = checkHtfTrigger({ candlesByTf: { '1m': c1m, '3m': c3m, '5m': c5m }, tfs: LIVE_TRIGGER_TIMEFRAMES, direction, cutMs });
  const latest1h = c1h.length ? c1h[c1h.length - 1] : null;
  if (!trigger) return { trigger: null, plan: null, latest1h };

  const geometry1h = buildGeometryFor('1h', c1h);
  const geometry15m = buildGeometryFor('15m', c15m);
  const c4h = await fetchClosedCandles(symbol, '4h', opts);
  const geometry4h = buildGeometryFor('4h', c4h);
  const atr1h = geometry1h && isFiniteNumber(geometry1h.atr) ? geometry1h.atr : null;
  const atr15m = geometry15m && isFiniteNumber(geometry15m.atr) ? geometry15m.atr : null;
  if (!isFiniteNumber(atr1h)) return { trigger, plan: null, latest1h };

  const plan = buildHtfPlan({ direction, entry: trigger.entry, candles1h: c1h, atr1h, atr15m, geometry1h, geometry4h });
  return { trigger, plan, latest1h };
}

/** journal `openPositions()` rows whose engineRef.candidateId is an HTF-entry id. */
export function htfOpenRecords(records) {
  return (Array.isArray(records) ? records : []).filter((r) => r && isHtfCandidateId(r.engineRef && r.engineRef.candidateId));
}

/** Set of `execRef.positionIdHash` for currently-open HTF positions (T-15 trail exemption is NOT applied to HTF - unlike retest1h, HTF entries DO get the +1R auto-trail per the prompt ("the existing +1R auto-trail applies (do NOT exempt it)"). Exported anyway for the "max one open HTF trade per symbol" and exit-tracking checks. */
export function htfPositionHashes(records) {
  return new Set(htfOpenRecords(records).map((r) => r.execRef && r.execRef.positionIdHash).filter((x) => typeof x === 'string' && x));
}

// ---------------------------------------------------------------------------
// Dedicated Open intent builder (never candidateLevels/orderIntentFromCandidate)
// ---------------------------------------------------------------------------

/**
 * Sizing for the ENTRY card's display line and its Open intent: ENGINE_CONFIG.risk's own
 * `positionPlan` (lib/riskEngine.js), sized against `defaultMarginUsd` directly - unlike
 * a flag candidate's payload-computed `risk` block (services/scalpContext.js attachRisk,
 * which sizes against a live wallet read), this is a display/Open-intent figure computed
 * at alert time with no live wallet fetch. Documented simplification (T-20 has no `risk`
 * key in its payload contract): `preflight` independently re-sizes and re-caps the real
 * order the moment Open is tapped, so this never under- or over-states what actually gets
 * risked - it only affects what the card DISPLAYS before that.
 * @returns {{leverage:number, lossAtStopUsd:number, lossAtStopPct:number}|null}
 */
export function htfRiskEstimate(stopPct, cfg = ENGINE_CONFIG.risk) {
  if (!isFiniteNumber(stopPct) || stopPct <= 0) return null;
  const marginUsd = cfg.defaultMarginUsd;
  const plan = positionPlan({ marginUsd, walletMarginUsd: marginUsd, stopDistancePct: stopPct, leverageRequested: cfg.maxLeverage, maxWalletRiskPct: cfg.maxWalletRiskPct }, cfg);
  if (!isFiniteNumber(plan.leverage) || !isFiniteNumber(plan.lossAtStopUsd)) return null;
  return { leverage: plan.leverage, lossAtStopUsd: plan.lossAtStopUsd, lossAtStopPct: plan.lossAtStopPct };
}

/**
 * The order intent for an Open tap on an HTF ENTRY card - a dedicated builder, never
 * `candidateLevels`/`orderIntentFromCandidate` (those gate on `v.source === 'live'` and
 * the flag/plan candidate shape; an HTF plan record has neither). Same {error} contract:
 * caller displays it via formatRefusedCard exactly as any other Open refusal.
 * @param {Object} planRecord - state.htf.plans[ref] (see api/telegram-cron.js evaluateHtfEntry)
 * @param {{maxSizeUsd?:number, maxLeverage?:number}} [caps]
 * @returns {{intent:Object}|{error:string}}
 */
export function orderIntentFromHtfPlan(planRecord, caps = {}) {
  const p = planRecord;
  if (!p || ![p.entry, p.stop, p.tp1].every(isFiniteNumber) || (p.direction !== 'long' && p.direction !== 'short')) {
    return { error: 'no entry, stop or TP1 on file for this HTF plan' };
  }
  const stopPct = Math.abs(p.entry - p.stop) / p.entry * 100;
  const risk = htfRiskEstimate(stopPct);
  if (!risk) return { error: 'could not size this HTF plan (invalid stop distance)' };
  const leverage = isFiniteNumber(caps.maxLeverage) ? Math.min(caps.maxLeverage, risk.leverage) : risk.leverage;
  const sizeUsd = Math.round(leverage * ENGINE_CONFIG.risk.defaultMarginUsd * 100) / 100;
  const intent = {
    symbol: p.symbol, direction: p.direction, sizeUsd: isFiniteNumber(caps.maxSizeUsd) ? Math.min(caps.maxSizeUsd, sizeUsd) : sizeUsd, leverage,
    entry: p.entry, stop: p.stop, tp1: p.tp1, ...(isFiniteNumber(p.tp2) ? { tp2: p.tp2 } : {}),
    candidateId: p.candidateId, recClass: 'HTF_ENTRY', source: 'telegram'
  };
  return { intent };
}

// ---------------------------------------------------------------------------
// Formatting: every card is a photo with a fixed WHAT TO DO caption (addendum)
// ---------------------------------------------------------------------------

/** "09-27 14:00z" from an ISO string - the addendum's own since/time label shape. */
export function sinceLabel(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'n/a';
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}z`;
}

function pct(v, decimals = 1) {
  return isFiniteNumber(v) ? `${(Math.round(v * 10 ** decimals) / 10 ** decimals).toFixed(decimals)} %` : 'n/a';
}

function rr(v) {
  return isFiniteNumber(v) ? `${(Math.round(v * 10) / 10).toFixed(1)}R` : 'n/a';
}

/**
 * DIRECTION card caption (addendum, verbatim shape):
 *   🧭 DIRECTION · SOL ▲ LONG (4h+1D stacks agree since 09-27 14:00z)
 *   WHAT TO DO: nothing yet. Longs only on SOL until this flips. Stop would be the 1h
 *   swing low 118.90 (1.6 %), target 125.40 (3.4R). Tap Track to get the entry when a
 *   1m/5m flag fires.
 */
export function formatHtfDirectionAlert({ symbol, direction, since, structureStop, stopPct: stopPercent, tp1, grossRR: gross }) {
  const long = direction === 'long';
  const swingWord = long ? 'swing low' : 'swing high';
  const sideWord = long ? 'Longs' : 'Shorts';
  return [
    `🧭 <b>DIRECTION · ${escapeHtml(symbol)} ${dirArrow(direction)}</b> (4h+1D stacks agree since ${escapeHtml(sinceLabel(since))})`,
    `WHAT TO DO: nothing yet. ${sideWord} only on ${escapeHtml(symbol)} until this flips. Stop would be the 1h ${swingWord} ${fmtPrice(structureStop)} (${pct(stopPercent)}), target ${fmtPrice(tp1)} (${rr(gross)}). Tap Track to get the entry when a 1m/5m flag fires.`
  ].join('\n');
}

/**
 * ENTRY card caption (addendum, verbatim shape):
 *   ⚡ ENTRY · SOL ▲ LONG · 5m flag @ 121.05
 *   Stop 118.90 (1h swing, 1.6 %) · TP1 125.40 · 2.9R gross / 2.5R net · tier A · risk $5.20 (1 %)
 *   WHAT TO DO: tap Open @ plan, reply /confirm <id> <PIN>. Expect hours, not minutes. The
 *   bot trails the stop after +1R. Stand down if the 1h closes below 118.90 first.
 * `took` (T-20 addendum, "cards for a trade the owner did NOT take"): when explicitly
 * false (the journal/tracked entry says the owner passed), the WHAT TO DO line reads
 * "nothing; you did not take this one" instead - `undefined`/`null` (not yet known, the
 * normal case right when the card is first sent) keeps the tap-to-Open instructions.
 */
export function formatHtfEntryAlert({ symbol, direction, tf, entry, stop, structureStop, stopPct: stopPercent, tp1, grossRR: gross, netRR: net, tier = 'B', took }) {
  const risk = htfRiskEstimate(stopPercent);
  const riskText = risk ? `risk ${fmtUsd(risk.lossAtStopUsd)} (${pct(risk.lossAtStopPct)})` : 'risk n/a';
  const whatToDo = took === false
    ? 'nothing; you did not take this one.'
    : `tap Open @ plan, reply /confirm <id> <PIN>. Expect hours, not minutes. The bot trails the stop after +1R. Stand down if the 1h closes below ${fmtPrice(structureStop)} first.`;
  return [
    `⚡ <b>ENTRY · ${escapeHtml(symbol)} ${dirArrow(direction)} · ${escapeHtml(tf)} flag @ ${fmtPrice(entry)}</b>`,
    `Stop ${fmtPrice(stop)} (1h swing, ${pct(stopPercent)}) · TP1 ${fmtPrice(tp1)} · ${rr(gross)} gross / ${rr(net)} net · tier ${escapeHtml(tier)} · ${riskText}`,
    `WHAT TO DO: ${whatToDo}`
  ].join('\n');
}

function fmtUsd(v) {
  return isFiniteNumber(v) ? `$${v.toFixed(2)}` : '$n/a';
}

/**
 * EXIT card caption (addendum, verbatim shape - note: plain "SOL LONG", no arrow, unlike
 * DIRECTION/ENTRY):
 *   🚪 EXIT · SOL LONG · structure
 *   1h closed below the swing that held the stop (118.90). WHAT TO DO: close now with
 *   Close on /positions (or let the on-chain stop take it). Log it; the tracker scores
 *   the exit at this close.
 * Time exits (`kind: 'time'`) say "72 h reached; close or move the stop to breakeven with
 * SL→BE" instead. `took === false` overrides WHAT TO DO to "nothing; you did not take
 * this one" for either kind, same convention as the ENTRY card.
 */
export function formatHtfExitAlert({ symbol, direction, kind, structureStop, took }) {
  const long = direction === 'long';
  const side = long ? 'below' : 'above';
  const reason = kind === 'time'
    ? '72 h hold cap reached.'
    : `1h closed ${side} the swing that held the stop (${fmtPrice(structureStop)}).`;
  const whatToDo = took === false
    ? 'nothing; you did not take this one.'
    : kind === 'time'
      ? '72 h reached; close or move the stop to breakeven with SL→BE.'
      : 'close now with Close on /positions (or let the on-chain stop take it). Log it; the tracker scores the exit at this close.';
  return [
    `🚪 <b>EXIT · ${escapeHtml(symbol)} ${direction ? direction.toUpperCase() : ''} · ${kind === 'time' ? 'time' : 'structure'}</b>`,
    `${reason} WHAT TO DO: ${whatToDo}`
  ].join('\n');
}

/**
 * `alert.chart` for a DIRECTION card (api/telegram-cron.js's existing generic
 * `alert.chart` -> render -> sendPhoto pipeline, same one GOOD alerts use): the 1h chart
 * with the planned stop/target and no entry marker (`hideEntryMarker`, lib/chartRender.js).
 */
export function directionChartRequest(symbol, direction, preview) {
  return { symbol, timeframe: HTF_TF, tradeOverlay: { direction, entry: preview.currentPrice, stop: preview.structureStop, tp1: preview.tp1, hideEntryMarker: true } };
}

/** `alert.chart` for an ENTRY card: the 1h chart (the plan's own stop/target timeframe) with the real levels. */
export function entryChartRequest(symbol, plan) {
  return { symbol, timeframe: HTF_TF, tradeOverlay: { direction: plan.direction, entry: plan.entry, stop: plan.stop, tp1: plan.tp1, ...(isFiniteNumber(plan.tp2) ? { tp2: plan.tp2 } : {}), grossRR: plan.grossRR, netRR: plan.netRR } };
}

/**
 * `/htf` - the three symbols' direction, since, stop, target (deliverable 2). Reads
 * `state.htf.direction[symbol]` only (the DIRECTION card's own cached preview numbers,
 * lib/htfEntryLive.js previewHtfDirection at the moment the regime started) - no live
 * re-fetch, so this command has the same zero-network cost as every other status command
 * in api/telegram-webhook.js.
 */
export function formatHtfStatus(htfState) {
  const st = htfState || {};
  const dir = st.direction || {};
  const lines = HTF_SYMBOLS.map((symbol) => {
    const d = dir[symbol];
    if (!d) return `${escapeHtml(symbol)}: no direction`;
    const stopText = isFiniteNumber(d.structureStop) ? `${fmtPrice(d.structureStop)}${isFiniteNumber(d.stopPct) ? ` (${(Math.round(d.stopPct * 10) / 10).toFixed(1)} %)` : ''}` : 'n/a';
    const tpText = isFiniteNumber(d.tp1) ? fmtPrice(d.tp1) : 'n/a';
    return `${escapeHtml(symbol)} ${dirArrow(d.direction)} since ${escapeHtml(sinceLabel(d.since))} · stop ${stopText} · target ${tpText}`;
  });
  return ['🧭 <b>HTF DIRECTION</b>', ...lines].join('\n');
}

export default {
  HTF_DIRECTION_KIND, HTF_ENTRY_KIND, HTF_EXIT_KIND, HTF_SYMBOLS, HTF_TF,
  latestClosedHtfCandle, buildGeometryFor, evaluateHtfDirectionFull, previewHtfDirection, evaluateHtfTriggerFull,
  htfOpenRecords, htfPositionHashes, htfRiskEstimate, orderIntentFromHtfPlan,
  sinceLabel, formatHtfDirectionAlert, formatHtfEntryAlert, formatHtfExitAlert, formatHtfStatus,
  directionChartRequest, entryChartRequest,
  htfCandidateId, isHtfCandidateId, positionIdHash
};
