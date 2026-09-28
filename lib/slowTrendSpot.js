/**
 * Slow-trend spot alert (2026-09-27, owner-approved engine-freeze exception,
 * docs/PROMPT_LIVE_RETEST1H.md). Alert only — no button, no execution, no position sizing.
 *
 * Research candidate: SLOW_SMA840_4H_V1 (≈ 20-week SMA on 4h closes, spot), the lead spot
 * candidate per docs research EDGE_EVIDENCE_SUMMARY_2026-09-27.md ("beats plain weekly DCA
 * on every symbol and window; widest cost headroom of any arm tested"). Kraken's public
 * OHLC endpoint caps history at ~720 candles per call (services/marketData.js), so 840
 * FOUR-HOUR candles (140 days) is unreachable live; this module stands in with SMA140 of
 * DAILY closes — the same ~140-day / 20-week window on the daily grid instead of the 4h
 * one. Documented once here and in docs/PLAN_TELEGRAM.md; every alert's footer repeats it
 * briefly so the owner is never left thinking this is the exact research arm.
 */

import { getCandlesWithProvenance } from '../services/marketData.js';
import { dropUnclosedCandles } from '../services/scalpContext.js';
import { escapeHtml, fmtPrice } from './telegram.js';

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export const SLOW_TREND_KIND = 'SLOW_TREND';
export const SLOW_TREND_SMA_PERIOD = 140; // ~20 weeks of daily closes (stand-in for SMA840 on 4h - see header)
export const SLOW_TREND_CANDLE_LIMIT = 720; // Kraken's practical OHLC cap per call
export const SLOW_TREND_FOOTNOTE = 'SMA140 daily (~20-week) stands in for the research SLOW_SMA840_4H_V1: Kraken caps 4h history at ~720 bars, too short for an 840-bar SMA live.';

/** Fetch closed daily candles for `symbol` (drops any still-forming day). */
export async function fetchClosedDailyCandles(symbol, { fetchCandles = getCandlesWithProvenance, limit = SLOW_TREND_CANDLE_LIMIT, nowMs = Date.now() } = {}) {
  let r;
  try { r = await fetchCandles(symbol, '1d', limit); } catch { return []; }
  const candles = r && Array.isArray(r.candles) ? r.candles : [];
  return dropUnclosedCandles(candles, '1d', nowMs);
}

/** Plain SMA of the last `period` closes, or null short of that many. */
export function sma(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const window = closes.slice(-period);
  const sum = window.reduce((s, v) => s + v, 0);
  return sum / period;
}

/**
 * `close > SMA140` -> 'long' (regime), else 'flat'. Null when there is not yet enough
 * daily history (SLOW_TREND_SMA_PERIOD closes).
 * @returns {{state:'long'|'flat', close:number, sma140:number, closedAtIso:string}|null}
 */
export function evaluateSlowTrendRegime(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const closes = candles.map((c) => c.close);
  const sma140 = sma(closes, SLOW_TREND_SMA_PERIOD);
  if (!isFiniteNumber(sma140)) return null;
  const last = candles[candles.length - 1];
  const closedAtIso = isFiniteNumber(last.closeTime) ? new Date(last.closeTime).toISOString() : null;
  if (!isFiniteNumber(last.close) || !closedAtIso) return null;
  return { state: last.close > sma140 ? 'long' : 'flat', close: last.close, sma140, closedAtIso };
}

/** "SLOW TREND · BTC LONG REGIME (close > SMA140)" / "FLAT REGIME" — alert only, no button. */
export function formatSlowTrendAlert(symbol, regime) {
  const label = regime.state === 'long' ? 'LONG REGIME (close > SMA140)' : 'FLAT REGIME (close ≤ SMA140)';
  return [
    `📈 <b>SLOW TREND · ${escapeHtml(symbol)} ${escapeHtml(label)}</b>`,
    `close ${fmtPrice(regime.close)} vs SMA140 ${fmtPrice(regime.sma140)} (daily)`,
    escapeHtml(SLOW_TREND_FOOTNOTE)
  ].join('\n');
}
