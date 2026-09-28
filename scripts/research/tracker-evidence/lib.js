/**
 * WP10 — forward-evidence suite over the tracker's recorded captures (read-only).
 * docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md WP10; EXTERNAL_HARNESS_REFERENCES.md
 * R10+, R11, R12, R14, R15; 4.3.
 *
 * Shared IO + math for every script in this directory. Pure where practical; the only fs
 * access is reading `../edittrades-tracker/data` (read-only, path arg) and the engine
 * repo's own `var/edge/4h-long/*.json` long-history candles (also read-only). Nothing here
 * writes outside `var/research/wp10-tracker-evidence/`.
 *
 * Reuses the tracker's own pure modules (never edited, never copied): `readAllCalls`,
 * `readCandles` (scripts/tracker/store.js), `walkOutcome`/`isFiniteNumber`/`round`/`median`
 * (scripts/tracker/walk-outcome.js), `costR`/`netR` (scripts/tracker/costs.js).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readAllCalls, readCandles, readJson } from '../../tracker/store.js';
import { walkOutcome, isFiniteNumber, round, median } from '../../tracker/walk-outcome.js';
import { costR, netR } from '../../tracker/costs.js';

export { isFiniteNumber, round, median, walkOutcome, costR, netR };

/** Horizons this suite backfills, in minutes (R12: "15m/1h/4h"). */
export const HORIZONS = Object.freeze({ '15m': 15, '1h': 60, '4h': 240 });

// --------------------------------------------------------------- capture rows

/**
 * Every stored call row, deduped per symbol+closedThrough (R12: "deduped per decision
 * time"). A cron row wins over a served row at the same key (the tracker can hold more
 * than one served row per close when class/plan status differ, T3 store.js; we only need
 * one decision snapshot per symbol+closedThrough for forward scoring, so the first-seen
 * row is kept unless a later cron row for the same key arrives, which then wins).
 * @param {string} dataDir
 * @returns {Array<Object>} ascending by closedThrough, then symbol
 */
export function loadDedupedCallRows(dataDir) {
  const rows = readAllCalls(dataDir);
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.symbol}|${row.closedThrough}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, row); continue; }
    if (existing.source !== 'cron' && row.source === 'cron') byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => (Date.parse(a.closedThrough) - Date.parse(b.closedThrough)) || String(a.symbol).localeCompare(String(b.symbol)));
}

/** UTC day (`YYYY-MM-DD`) of an ISO timestamp, for day-block bootstrap grouping. */
export function utcDay(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** The decision-time reference price for a capture row: `price`, else `mark.price`. */
export function refPriceOf(row) {
  if (isFiniteNumber(row && row.price)) return row.price;
  if (row && row.mark && isFiniteNumber(row.mark.price)) return row.mark.price;
  return null;
}

/**
 * The engine's directional lean for a capture row, in priority order: the flag trade
 * plan's own direction (even a rejected plan still names one), the flag recommendation's
 * nearest candidate, then the first candidate in `candidateSetups`. `null` when the row
 * carries no directional evidence at all (a bare `no_setup` capture).
 */
export function leanDirectionOf(row) {
  const plan = row && row.flagTradePlan;
  if (plan && (plan.direction === 'long' || plan.direction === 'short')) return plan.direction;
  const cand = row && row.flagRecommendation && row.flagRecommendation.candidate;
  if (cand && (cand.direction === 'long' || cand.direction === 'short')) return cand.direction;
  const first = row && Array.isArray(row.candidateSetups) ? row.candidateSetups[0] : null;
  if (first && (first.dir === 'long' || first.dir === 'short')) return first.dir;
  return null;
}

/**
 * The candidateId a row's leaned direction/plan traces back to, in priority order: the
 * flag trade plan's own candidateId (present even on a rejected plan), the flag
 * recommendation's nearest candidate, else the first `candidateSetups` entry's id. Used to
 * de-duplicate repeated captures of the SAME forming/rejected candidate into one
 * "opportunity" for opportunity-level (not capture-row-level) rates - a candidate that
 * stays `forming` for 20 minutes is otherwise counted once per 1-10 minute capture cadence,
 * which inflates any row-level rate by re-sampling one real event many times.
 */
export function candidateIdOf(row) {
  const plan = row && row.flagTradePlan;
  if (plan && plan.candidateId) return plan.candidateId;
  const cand = row && row.flagRecommendation && row.flagRecommendation.candidate;
  if (cand && cand.candidateId) return cand.candidateId;
  const first = row && Array.isArray(row.candidateSetups) ? row.candidateSetups[0] : null;
  if (first && first.id) return first.id;
  return null;
}

/**
 * The candidate entry in `row.candidateSetups` matching the flag recommendation's own
 * `candidate.candidateId` (falls back to the first candidate). Used to read `qual` for a
 * row without re-deriving qualification.
 */
export function primaryCandidateOf(row) {
  const list = Array.isArray(row && row.candidateSetups) ? row.candidateSetups : [];
  if (!list.length) return null;
  const wantId = row.flagRecommendation && row.flagRecommendation.candidate && row.flagRecommendation.candidate.candidateId;
  if (wantId) {
    const match = list.find((c) => c && c.id === wantId);
    if (match) return match;
  }
  return list[0];
}

/**
 * Risk basis for R-conversion (R11: "the plan's ... stop"; R12: "in R if a plan stop
 * exists"): entry/stop from `flagTradePlan` when both are numeric (present even on
 * rejected plans, per `docs/PLAN_CALL_TRACKER.md`), regardless of plan status - this is a
 * risk *reference*, not a claim the plan was tradable.
 * @returns {{entry:number, stop:number, riskPct:number}|null}
 */
export function planRiskBasis(row) {
  const plan = row && row.flagTradePlan;
  if (!plan || !isFiniteNumber(plan.entry) || !isFiniteNumber(plan.stop) || plan.entry <= 0) return null;
  const riskPct = (Math.abs(plan.entry - plan.stop) / plan.entry) * 100;
  if (!(riskPct > 0)) return null;
  return { entry: plan.entry, stop: plan.stop, riskPct };
}

/**
 * First capture per distinct candidateId (earliest closedThrough) among enriched rows - so
 * a candidate that stays forming/rejected across many 1-10 minute captures counts once,
 * as one "opportunity"/decision, not once per capture. Rows with no candidateId are kept
 * as-is (each is its own opportunity by construction). Shared by `wait-scoring.js` (R11)
 * and `confidence-calibration.js` (R15's qual-band secondary table) - both would otherwise
 * over-weight whichever candidates happened to get captured most often.
 * @param {Array<{candidateId:?string, closedThrough:string}>} rows
 */
export function dedupeByCandidateId(rows) {
  const byId = new Map();
  const out = [];
  for (const r of rows) {
    if (!r.candidateId) { out.push(r); continue; }
    const existing = byId.get(r.candidateId);
    if (!existing || Date.parse(r.closedThrough) < Date.parse(existing.closedThrough)) byId.set(r.candidateId, r);
  }
  out.push(...byId.values());
  return out;
}

// --------------------------------------------------------------- candles / ATR proxy

/** `readCandles(dataDir, '1m')` and `readCandles(dataDir, '15m')`, ascending per symbol. */
export function loadCandleSets(dataDir) {
  return { c1m: readCandles(dataDir, '1m'), c15m: readCandles(dataDir, '15m') };
}

/**
 * R11's "1×ATR15m-proxy stop": a simple (not Wilder-smoothed) average true range over the
 * last `period` CLOSED 15m candles strictly before `atMs` - no lookahead. `null` when
 * fewer than 2 prior candles exist (can't form even one true-range pair).
 * @param {Array<{timestamp:number,high:number,low:number,close:number}>} candles15m - one symbol, ascending
 * @param {number} atMs
 * @param {number} [period=14]
 * @returns {number|null} ATR in absolute price units
 */
export function atrProxy15m(candles15m, atMs, period = 14) {
  if (!Array.isArray(candles15m) || !candles15m.length) return null;
  const prior = candles15m.filter((c) => c.timestamp < atMs);
  const bars = prior.slice(-(period + 1));
  if (bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i];
    const p = bars[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (!trs.length) return null;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/**
 * Risk basis fallback chain for R11 ("use the plan's or a 1×ATR15m-proxy stop"): the
 * plan's own entry/stop first, else one ATR(15m) as the stop distance from `refPrice`.
 * @returns {{riskPct:number, source:'plan'|'atr15m'}|null}
 */
export function riskBasisWithAtrFallback(row, candles15mForSymbol, atMs, refPrice) {
  const plan = planRiskBasis(row);
  if (plan) return { riskPct: plan.riskPct, source: 'plan' };
  if (!isFiniteNumber(refPrice) || refPrice <= 0) return null;
  const atr = atrProxy15m(candles15mForSymbol, atMs, 14);
  if (!isFiniteNumber(atr) || atr <= 0) return null;
  return { riskPct: (atr / refPrice) * 100, source: 'atr15m' };
}

// --------------------------------------------------------------- forward metrics

/**
 * R12's per-horizon forward metrics from a capture row's decision time: close return,
 * MFE, MAE, both directions, in %. No lookahead beyond `fromMs + horizonMin` minutes of
 * already-closed 1m candles.
 *
 * Completeness (R12 "pending/complete/partial/unscorable"):
 *  - `unscorable`: no reference price, or the symbol has zero 1m candles anywhere at/after
 *    `fromMs` even though the data collection window has moved well past the horizon end
 *    (a genuine capture gap, not a tail effect).
 *  - `pending`: the horizon's end is beyond the last 1m candle this dataset has captured
 *    for the symbol - the outcome hasn't happened yet in the data we hold, not a gap.
 *  - `complete`: at least 90% of the expected 1-candle-per-minute count is present in the
 *    window.
 *  - `partial`: some but fewer than 90% of expected candles (a mid-window data gap).
 *
 * @param {Array<{timestamp:number,high:number,low:number,close:number}>} candles1m - one symbol, ascending
 * @param {number} fromMs - decision time (row.closedThrough), ms
 * @param {number} horizonMin
 * @param {number|null} refPrice
 * @returns {Object}
 */
export function forwardMetrics(candles1m, fromMs, horizonMin, refPrice) {
  const list = Array.isArray(candles1m) ? candles1m : [];
  const horizonMs = horizonMin * 60000;
  const endMs = fromMs + horizonMs;
  const lastKnownTs = list.length ? list[list.length - 1].timestamp : null;
  const inWindow = list.filter((c) => c.timestamp >= fromMs && c.timestamp < endMs);
  const expected = horizonMin;

  let state;
  if (!isFiniteNumber(refPrice) || refPrice <= 0) state = 'unscorable';
  else if (lastKnownTs === null || endMs > lastKnownTs + 60000) state = 'pending';
  else if (inWindow.length >= expected * 0.9) state = 'complete';
  else if (inWindow.length > 0) state = 'partial';
  else state = 'unscorable';

  if (!inWindow.length || !isFiniteNumber(refPrice) || refPrice <= 0) {
    return { state, n: inWindow.length, expected, closeReturnPct: null, mfeLongPct: null, maeLongPct: null, mfeShortPct: null, maeShortPct: null, maxHigh: null, minLow: null, lastClose: null };
  }
  const maxHigh = Math.max(...inWindow.map((c) => c.high));
  const minLow = Math.min(...inWindow.map((c) => c.low));
  const lastClose = inWindow[inWindow.length - 1].close;
  const pct = (x) => round(((x - refPrice) / refPrice) * 100, 4);
  return {
    state,
    n: inWindow.length,
    expected,
    closeReturnPct: pct(lastClose),
    mfeLongPct: pct(maxHigh),
    maeLongPct: pct(minLow),
    mfeShortPct: round(((refPrice - minLow) / refPrice) * 100, 4),
    maeShortPct: round(((refPrice - maxHigh) / refPrice) * 100, 4),
    maxHigh: round(maxHigh, 6),
    minLow: round(minLow, 6),
    lastClose: round(lastClose, 6)
  };
}

/** `pctMove / riskPct`, or null if riskPct is missing/non-positive. R-equivalent of a % move. */
export function toR(pctMove, riskPct) {
  if (!isFiniteNumber(pctMove) || !isFiniteNumber(riskPct) || !(riskPct > 0)) return null;
  return round(pctMove / riskPct, 4);
}

// --------------------------------------------------------------- stats / bootstrap

export function mean(values) {
  const v = values.filter(isFiniteNumber);
  if (!v.length) return null;
  return round(v.reduce((a, b) => a + b, 0) / v.length, 4);
}

export function stdev(values) {
  const v = values.filter(isFiniteNumber);
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
  return round(Math.sqrt(variance), 4);
}

/** Binary-outcome Brier score: mean of (probability - outcome)^2, probability in [0,1]. */
export function brier(pairs) {
  const v = pairs.filter((p) => isFiniteNumber(p.p) && (p.o === 0 || p.o === 1));
  if (!v.length) return null;
  return round(v.reduce((a, p) => a + (p.p - p.o) ** 2, 0) / v.length, 4);
}

// Seeded RNG (mulberry32) - same implementation as scripts/research/risk-sim.js, kept
// dependency-free and reproducible.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Day-block bootstrap CI on the mean of `values` (grouped by `days[i]`, same length):
 * resample whole days with replacement (preserves any within-day dependence), recompute
 * the mean each time, report the requested percentile interval. This is the CI method
 * R14/R11 call for ("CI via day-block bootstrap"); with few distinct days the interval is
 * necessarily wide - report the day count alongside it.
 * @param {Array<number>} values
 * @param {Array<string>} days - same length as `values`, the day-key per value
 * @param {Object} [opts]
 * @param {number} [opts.iterations=2000]
 * @param {number} [opts.seed=1]
 * @param {number} [opts.alpha=0.1] - 0.1 -> 90% CI
 * @returns {{lo:number, hi:number, iterations:number, days:number}|null}
 */
export function dayBlockBootstrapCI(values, days, opts = {}) {
  const { iterations = 2000, seed = 1, alpha = 0.1 } = opts;
  const byDay = new Map();
  for (let i = 0; i < values.length; i++) {
    if (!isFiniteNumber(values[i]) || !days[i]) continue;
    if (!byDay.has(days[i])) byDay.set(days[i], []);
    byDay.get(days[i]).push(values[i]);
  }
  const dayKeys = [...byDay.keys()];
  if (!dayKeys.length) return null;
  const rng = makeRng(seed);
  const means = [];
  for (let iter = 0; iter < iterations; iter++) {
    const sample = [];
    for (let i = 0; i < dayKeys.length; i++) {
      const day = dayKeys[Math.floor(rng() * dayKeys.length)];
      sample.push(...byDay.get(day));
    }
    if (sample.length) means.push(sample.reduce((a, b) => a + b, 0) / sample.length);
  }
  if (!means.length) return null;
  means.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * means.length);
  const hiIdx = Math.min(means.length - 1, Math.ceil((1 - alpha / 2) * means.length) - 1);
  return { lo: round(means[loIdx], 4), hi: round(means[hiIdx], 4), iterations: means.length, days: dayKeys.length };
}

// --------------------------------------------------------------- 4h regime (item 5)

/**
 * BTC 4h close vs SMA200 regime series from the engine repo's own long-history capture
 * (`var/edge/4h-long/BTC_4h.json`, WP7/WP8 fetch; not the tracker's data). Read-only,
 * pinned path, no network. Returns ascending {timestamp, close, sma200, regime} where
 * `regime` is `'bull'` (close > sma200), `'bear'` (close < sma200) or `null` for the
 * first 199 bars (no SMA200 yet).
 * @param {string} [repoRoot] - defaults to this file's own repo root
 * @returns {Array<{timestamp:number, close:number, sma200:number|null, regime:string|null}>}
 */
export function loadBtc4hRegime(repoRoot) {
  const root = repoRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
  const file = path.join(root, 'var', 'edge', '4h-long', 'BTC_4h.json');
  if (!existsSync(file)) return [];
  const data = readJson(file, null);
  const candles = data && Array.isArray(data.candles) ? data.candles : [];
  const out = [];
  const window = [];
  for (const c of candles) {
    window.push(c.close);
    if (window.length > 200) window.shift();
    const sma200 = window.length === 200 ? window.reduce((a, b) => a + b, 0) / 200 : null;
    out.push({ timestamp: c.timestamp, close: c.close, sma200: sma200 === null ? null : round(sma200, 4), regime: sma200 === null ? null : (c.close > sma200 ? 'bull' : 'bear') });
  }
  return out;
}

/** The regime row in effect at `atMs`: the last regime entry with `timestamp <= atMs`. */
export function regimeAt(regimeSeries, atMs) {
  let result = null;
  for (const r of regimeSeries) {
    if (r.timestamp > atMs) break;
    result = r;
  }
  return result;
}

// --------------------------------------------------------------- misc

/** List of `data/calls/*.jsonl` day filenames present (diagnostic: data coverage). */
export function callsDayFiles(dataDir) {
  const dir = path.join(dataDir, 'calls');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
}

/** Read the tracker's own `data/outcomes.jsonl` (already-scored actionable/candidate rows). */
export function readTrackerOutcomes(dataDir) {
  const file = path.join(dataDir, 'outcomes.jsonl');
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn last line */ }
  }
  return out;
}
