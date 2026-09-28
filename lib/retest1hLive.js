/**
 * Live retest-1h alert (2026-09-27, owner-approved engine-freeze exception,
 * docs/PROMPT_LIVE_RETEST1H.md). Runs the SAME rule as lib/retest1hRule.js
 * (re-flag-retest-1h, docs/PROMPT_S3_RETEST_ENTRY.md) against LIVE closed candles instead
 * of a research fixture, so api/telegram-cron.js can alert the owner the moment the
 * research signal fires for real, with an `Open @ plan` button through the existing
 * open:<ref> -> webhook -> executor path (unchanged gates: PIN, caps, fill-drift, kill
 * switch, and the executor's own universal 3% stop cap - see the module-level note below).
 *
 * Research evidence (docs research EDGE_EVIDENCE_SUMMARY_2026-09-27.md, WP4_MATCHED.md):
 * PAPER CANDIDATE, the lead perps candidate. Pooled significance carried by BTC and, to a
 * lesser extent, SOL; ETH alone does not clear conventional significance. RETEST1H_EVIDENCE
 * below carries the exact per-symbol numbers into every alert.
 *
 * IMPORTANT (report this before deploy): the executor's `checkIntent` applies a UNIVERSAL,
 * hardcoded 3% stop cap (`SCALP_STOP_CAP_PCT`, lib/execution/executor.js) to every order
 * regardless of source - "absolute: no plan can widen it" (CLAUDE.md hard rule: never
 * raise this threshold). This rule's structure/ATR-based stop is often wider than a scalp
 * stop, so many real retest-1h signals will show `Open @ plan` but come back `ORDER
 * REFUSED · stop_too_wide` when tapped. That is the existing gate working as designed, not
 * a bug here - this file does not touch it and does not special-case retest positions
 * against it.
 *
 * Isolation (test-telegram.js): api/telegram-cron.js and lib/telegram.js must never import
 * anything under lib/execution/. `positionIdHash` below duplicates (byte-for-byte)
 * lib/execution/audit.js's `idHash` — sha256, first 12 hex — using only Node's built-in
 * `crypto`, so the cron can match a live position (`ex.listPositions()`'s `positionId`)
 * against a journal open record's `execRef.positionIdHash` (T-15 trail exemption) without
 * an execution import.
 */

import crypto from 'crypto';
import { getCandlesWithProvenance } from '../services/marketData.js';
import { dropUnclosedCandles } from '../services/scalpContext.js';
import { calculateAllIndicators } from '../services/indicators.js';
import { buildGeometryContext } from './geometry.js';
import { maxLeverageForStop, positionPlan } from './riskEngine.js';
import { ENGINE_CONFIG } from '../config/engine.js';
import { getAccountSnapshot } from '../services/walletTracker.js';
import { signalAt as retest1hSignalAt, meta as retest1hMeta } from './retest1hRule.js';
import { HOLD_MAX_HOURS, STRUCTURE_EXIT_N } from './retestShared.js';
import { escapeHtml, fmtPrice, dirArrow } from './telegram.js';

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export const RETEST1H_KIND = 'RETEST_1H';
export const RETEST1H_EXIT_KIND = 'RETEST_1H_EXIT';
/** candidateId prefix: also how the trail exemption and the exit-check tell a retest-1h
 * position apart from any other (flag, manual /order) open position. */
export const RETEST1H_CANDIDATE_PREFIX = 'retest1h_';
/** Kraken's public OHLC endpoint hands back at most ~720 candles per call regardless of
 * the requested count (services/marketData.js fetchFromKraken) - the max history this
 * live path can use for 1D EMA200 (needs 206+) and the rest. */
export const RETEST_CANDLE_LIMIT = 720;
export const RETEST1H_SYMBOLS = Object.freeze(['BTC', 'ETH', 'SOL']);
export const RETEST1H_TF = '1h';
export const RETEST1H_HOLD_MAX_HOURS = HOLD_MAX_HOURS;
export const RETEST1H_STRUCTURE_EXIT_N = STRUCTURE_EXIT_N;
/** Minimum closed 15m candles calculateAllIndicators needs for a usable EMA200 (mirrors
 * config/engine.js replay.minComputeCandles); short of this the NF floor's ATR15m input
 * (and so the whole signal) is unavailable this tick, same as production's own gate. */
export const MIN_15M_INDICATOR_CANDLES = 200;

/**
 * WP4_MATCHED.md per-symbol matched-random significance (K=100 controls, day-block
 * bootstrap): BTC p≈0.018 (percentile 98.2, strongest), SOL p≈0.089 (91.1, moderate), ETH
 * p≈0.274 (72.6, not significant alone). Printed on every alert so the owner sizes/reads
 * each symbol differently, per the research doc's own caveat ("this should be weighed
 * against combining all three symbols into one PAPER CANDIDATE without a per-symbol
 * caveat").
 */
export const RETEST1H_EVIDENCE = Object.freeze({
  BTC: 'evidence: BTC strongest (matched-random p≈0.02, top 2%, WP4) — PAPER CANDIDATE',
  SOL: 'evidence: SOL moderate (p≈0.09, WP4) — PAPER CANDIDATE, size small',
  ETH: 'evidence: ETH not significant alone (p≈0.27, WP4) — smallest size / treat as paper'
});

/** sha256(value), first 12 hex — see the isolation note above. Mirrors lib/execution/audit.js idHash exactly. */
export function positionIdHash(value) {
  if (value === undefined || value === null || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/** `retest1h_BTC_2026-09-27T15:00:00.000Z` — dedupes per (symbol, signal close time). */
export function retestCandidateId(symbol, closeIso) {
  return `${RETEST1H_CANDIDATE_PREFIX}${symbol}_${closeIso}`;
}

export function isRetest1hCandidateId(id) {
  return typeof id === 'string' && id.startsWith(RETEST1H_CANDIDATE_PREFIX);
}

/** Fetch `tf` candles for `symbol` and drop any still-forming one (closed candles only). Never throws. */
export async function fetchClosedCandles(symbol, tf, { fetchCandles = getCandlesWithProvenance, limit = RETEST_CANDLE_LIMIT, nowMs = Date.now() } = {}) {
  let r;
  try { r = await fetchCandles(symbol, tf, limit); } catch { return []; }
  const candles = r && Array.isArray(r.candles) ? r.candles : [];
  return dropUnclosedCandles(candles, tf, nowMs);
}

/** The latest CLOSED 1h candle for `symbol`, or null — the cheap once-per-tick check
 * (one Kraken call) used both to gate a full evaluation and to advance the exit streak. */
export async function latestClosed1hCandle(symbol, opts = {}) {
  const candles = await fetchClosedCandles(symbol, '1h', opts);
  return candles.length ? candles[candles.length - 1] : null;
}

/** Production 15m geometry (buildGeometryContext, real indicators) — the rule's ATR15m
 * (net-floor) input. Null short of MIN_15M_INDICATOR_CANDLES or on any compute error. */
export function build15mGeometry(candles15m) {
  if (!Array.isArray(candles15m) || candles15m.length < MIN_15M_INDICATOR_CANDLES) return null;
  try {
    const ind = calculateAllIndicators(candles15m);
    return buildGeometryContext({
      timeframe: '15m', candles: candles15m,
      ema21History: ind.ema.ema21History, ema200History: ind.ema.ema200History,
      stochHistory: ind.stochRSI && ind.stochRSI.history
    });
  } catch {
    return null;
  }
}

/**
 * Fetch 1h/1d/4h/15m closed candles for `symbol` and evaluate lib/retest1hRule.js's
 * `signalAt` against them — the SAME rule the research harness scores, on live data.
 * Only called once a new 1h close has already been detected (latestClosed1hCandle); this
 * function itself does not check that gate.
 * @returns {Promise<{candlesByTf, geometry, latestClosed1h, signal}|null>} null when 1h
 *   data is unavailable this tick.
 */
export async function evaluateRetest1hFull(symbol, { fetchCandles = getCandlesWithProvenance, nowMs = Date.now() } = {}) {
  const opts = { fetchCandles, nowMs };
  const [c1h, c1d, c4h, c15m] = await Promise.all([
    fetchClosedCandles(symbol, '1h', opts),
    fetchClosedCandles(symbol, '1d', opts),
    fetchClosedCandles(symbol, '4h', opts),
    fetchClosedCandles(symbol, '15m', opts)
  ]);
  if (!c1h.length) return null;
  const candlesByTf = { '1h': c1h, '1d': c1d, '4h': c4h };
  const geometry = { '15m': build15mGeometry(c15m) };
  const signal = retest1hSignalAt({ i: c1h.length - 1, candlesByTf, geometry });
  return { candlesByTf, geometry, latestClosed1h: c1h[c1h.length - 1], signal };
}

/**
 * {suggestedLeverage, collateralUsd} for a retest-1h Open tap, sized with the SAME pure
 * math the flag engine's own candidate risk block uses (lib/riskEngine.js
 * positionPlan/maxLeverageForStop, ENGINE_CONFIG.risk: ~$10 collateral slice, up to 100x,
 * 0.5% max wallet risk) — from a fresh READ-ONLY wallet snapshot
 * (services/walletTracker.js getAccountSnapshot; no keypair, no signing). Null when the
 * wallet is unavailable or the stop has zero width, matching the flag engine's own "no
 * risk block -> use /order" behavior (lib/telegram.js orderIntentFromCandidate).
 */
export async function retestOrderSizing({ entry, stop }, { getAccountSnapshot: fetchAccount = getAccountSnapshot } = {}) {
  if (!isFiniteNumber(entry) || entry <= 0 || !isFiniteNumber(stop)) return null;
  let account;
  try { account = await fetchAccount(); } catch { account = null; }
  const walletMarginUsd = account && account.margin && isFiniteNumber(account.margin.usd) && account.margin.usd > 0 ? account.margin.usd : null;
  if (walletMarginUsd === null) return null;
  const cfg = ENGINE_CONFIG.risk;
  const collateralUsd = Math.min(cfg.defaultMarginUsd, walletMarginUsd);
  const stopDistancePct = (Math.abs(entry - stop) / entry) * 100;
  if (!(stopDistancePct > 0)) return null;
  const plan = positionPlan({ marginUsd: collateralUsd, walletMarginUsd, stopDistancePct, leverageRequested: cfg.maxLeverage, maxWalletRiskPct: cfg.maxWalletRiskPct }, cfg);
  if (!plan || !isFiniteNumber(plan.leverage)) return null;
  return { suggestedLeverage: plan.leverage, collateralUsd: Math.round(collateralUsd * 100) / 100 };
}
// maxLeverageForStop is re-exported for tests that want to check the same stop-distance
// cap the sizing above is built on, without reaching into lib/riskEngine.js directly.
export { maxLeverageForStop };

/**
 * Structure-exit streak (docs research: "5 closed 1h candles back inside the flag range"):
 * called once per NEWLY closed 1h candle since entry. `holdRule` is the signal's own
 * `{insideLow, insideHigh, n, tfCandleMs}` (lib/retestShared.js structureHoldRule).
 * @returns {number} the new streak (0 when this close is outside the range).
 */
export function nextInsideStreak(close, holdRule, prevStreak) {
  const hr = holdRule || {};
  const inside = isFiniteNumber(close) && isFiniteNumber(hr.insideLow) && isFiniteNumber(hr.insideHigh) && close >= hr.insideLow && close <= hr.insideHigh;
  return inside ? (isFiniteNumber(prevStreak) ? prevStreak : 0) + 1 : 0;
}

/** journal `openPositions()` rows whose engineRef.candidateId is a retest-1h id — "the
 * open retest trade(s)" per the plan the webhook stored at Open time. */
export function retestOpenRecords(records) {
  return (Array.isArray(records) ? records : []).filter((r) => r && isRetest1hCandidateId(r.engineRef && r.engineRef.candidateId));
}

/** Set of `execRef.positionIdHash` for currently-open retest-1h positions (T-15 trail
 * exemption lookup: `retestHashes.has(positionIdHash(livePosition.positionId))`). */
export function retestPositionHashes(records) {
  return new Set(retestOpenRecords(records).map((r) => r.execRef && r.execRef.positionIdHash).filter((x) => typeof x === 'string' && x));
}

/**
 * "RETEST 1H · BTC LONG" alert text (HTML), the signal's entry/stop/TP1/R:R and the
 * per-symbol evidence note. Levels only — the Open button is attached by the caller
 * (api/telegram-cron.js, withOpenButton) exactly like every other alert kind.
 */
export function formatRetest1hAlert({ symbol, direction, entry, stop, tp1 }) {
  const grossRR = Math.abs(entry - stop) > 0 ? Math.round((Math.abs(tp1 - entry) / Math.abs(entry - stop)) * 100) / 100 : null;
  const evidence = RETEST1H_EVIDENCE[symbol] || '';
  return [
    `🟢 <b>RETEST 1H · ${escapeHtml(symbol)} ${dirArrow(direction)}</b>`,
    `entry ${fmtPrice(entry)} · stop ${fmtPrice(stop)} · TP1 ${fmtPrice(tp1)}${isFiniteNumber(grossRR) ? ` (${grossRR}R)` : ''}`,
    escapeHtml(evidence)
  ].join('\n');
}

/** "EXIT SIGNAL · RETEST 1H" alert — info only, no button; the owner closes manually. */
export function formatRetest1hExitAlert({ symbol, direction, reason }) {
  return `🔔 <b>EXIT SIGNAL · RETEST 1H · ${escapeHtml(symbol)} ${dirArrow(direction)}</b>\n${escapeHtml(reason)}. Structure/hold-cap exit per the research rule — this alert is informational; close it yourself via the usual close flow (this signal is not wired to auto-close).`;
}

export { retest1hMeta };
