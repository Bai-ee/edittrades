/**
 * WP4 (docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md, R3b in
 * docs/research/EXTERNAL_HARNESS_REFERENCES.md): matched-random entry controls for
 * `re-flag-retest-1h` (Card 6.3 in docs/research/BREAKEVEN_COSTS_2026-09-27.md - the only
 * short-hold perps setup whose gross edge cleared fees+borrow).
 *
 * For every REAL resolved signal the rule fired (from a `scripts/swing/run.js` study
 * JSON), draw K seeded control "opportunities": other 1h candle closes for the SAME
 * symbol, SAME side, SAME timeframe/cadence (1h closes), matched on:
 *   - UTC-hour bucket (4 buckets: 0-5, 6-11, 12-17, 18-23)
 *   - trailing-vol tercile (mean |log return| over the trailing 24h, tercile boundaries
 *     from an EXPANDING, causal prefix recomputed every 168 candles - never uses a
 *     boundary derived from data after the candle being classified)
 *   - HTF trend state (1D+4h EMA21/EMA200 stack+slope agreement, bull/bear - the SAME
 *     gate `re-flag-retest-1h.js` uses, recomputed at control time from past data only)
 * within the same date range the real study covered (same 1m-coverage bounds
 * `scripts/swing/run.js`'s own `runRuleOnSymbol` applies).
 *
 * Level construction on a control candle: the rule's own retest/flag level logic
 * (`detectFlagLifecycle` + `retestPrintAt`) is NOT recomputed, because it is only defined
 * AT a qualifying flag-retest print - by construction, most matched control candles are
 * not one. Per the WP4 brief's own fallback ("else same stop distance % and same R
 * multiple - state which"), a control instead reuses the MATCHED REAL TRADE's own stop
 * distance (% of entry) and R multiple (|tp1-entry|/risk), anchored to the control
 * candle's own close. Exit is stop / target / the same 168h hard cap - WITHOUT the real
 * rule's structure-exit box (there is no flag range to reference off-pattern), which is
 * the one mechanic this script does not reproduce; flagged wherever it matters.
 *
 * Scoring reuses `scoreSignal` from `scripts/swing/run.js` verbatim (same walkOutcome
 * call, same fill window, same 1m candles) - read-only import, not reimplemented.
 *
 * Costs: perps 0.20% long / 0.14% short round trip, +0.02%/h and +0.024%/h (Jupiter docs)
 * borrow scenarios (WP4 COMMON RULES / docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md
 * governing rule) - computed locally here, NOT the tracker's own 34bps-long cost model
 * (`scripts/tracker/costs.js`), so real and control trades are costed identically and on
 * the same basis this WP was asked to report.
 *
 * Usage:
 *   node scripts/research/harness/matched-controls.js \
 *     --study var/research/wp4-matched/swing-deep2y/re-flag-retest-1h.json \
 *     --history test/fixtures/history/deep2y-2026-09-26 \
 *     --out-dir var/research/wp4-matched/controls-deep2y \
 *     [--k 100] [--sims 2000] [--boot 2000] [--seed edittrades-wp4]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHistoryDir } from '../../replay.js';
import {
  closeTimeOf, firstIndexAfter, firstAtOrAfter, scoreSignal
} from '../../swing/run.js';
import {
  emaSeries, isFiniteNumber, isValidCandle, candleTime,
  fnv1a, mulberry32,
  EMA_FAST_PERIOD, EMA_SLOW_PERIOD, TREND_SLOPE_LOOKBACK, MIN_TREND_CANDLES,
  HOLD_MAX_HOURS
} from '../../swing/retestShared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

export const ACTUAL_COST = { long: 0.0020, short: 0.0014 };
export const BORROW_SCENARIOS = [
  { id: 'base_0.02', perH: 0.0002 },
  { id: 'jupiter_0.024', perH: 0.00024 },
  // Coordinator update (2026-09-27, WP4 mid-task): real Jupiter borrow measured today via
  // Jupiter's own API at ~0.0013-0.0015%/h, and ~0.004%/h at 80% utilization - both far
  // below the 0.02/0.024%/h scenarios above (which predate that measurement). Reported
  // alongside, not instead of, the original two scenarios.
  { id: 'measured_0.0015', perH: 0.000015 },
  { id: 'stress80pct_0.004', perH: 0.00004 }
];
export const HOUR_BUCKETS = 4;
export const VOL_WINDOW = 24; // trailing hours for the vol proxy
export const VOL_RECOMPUTE_STRIDE = 168; // recompute tercile boundaries weekly (causal)
export const OWN_TF = '1h';
export const TREND_TF_D = '1d';
export const TREND_TF_4H = '4h';
export const RESOLVED = new Set(['win', 'loss', 'timeout', 'structure_exit', 'data_end']);

// --------------------------------------------------------------------------------------
// Seeded draws (fnv1a -> mulberry32, imported verbatim from retestShared.js - the same
// technique ctl-random-4h.js / re-random-4h.js already use for reproducible controls).
// --------------------------------------------------------------------------------------
export function drawIndex(seed, key, k, poolLen) {
  const hash = fnv1a(`${seed}:${key}:${k}`);
  const r = mulberry32(hash)();
  return Math.min(poolLen - 1, Math.floor(r * poolLen));
}

// --------------------------------------------------------------------------------------
// HTF trend state (bull/bear/null), vectorized: the SAME EMA21/EMA200 stack + slope read
// `trendFromStack` (retestShared.js) applies per-call to a clipped array - computed ONCE
// per full candle array instead of per query, because EMA is causal (truncating the input
// to length k+1 cannot change the EMA value at index k, so this is not a different
// computation, only a faster one). Documented simplification vs. the live rule: the real
// rule reads a ROLLING 499-candle window (production's own fetch cap, `run.js`
// PRODUCTION_FETCH_WINDOW) that re-seeds its EMA as time rolls forward; this uses one
// EXPANDING window from the start of the fixture. Both are 100% causal (no lookahead);
// they can disagree near EMA200's slow-converging seed early in a window. Flagged in the
// WP4 report, not silently assumed away.
// --------------------------------------------------------------------------------------
export function trendSeries(candles) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < MIN_TREND_CANDLES || !candles.every(isValidCandle)) return out;
  const closes = candles.map((c) => c.close);
  const ema21 = emaSeries(closes, EMA_FAST_PERIOD);
  const ema200 = emaSeries(closes, EMA_SLOW_PERIOD);
  for (let last = 0; last < n; last++) {
    const priorIdx = last - TREND_SLOPE_LOOKBACK;
    const e21 = ema21[last];
    const e200 = ema200[last];
    const e21p = priorIdx >= 0 ? ema21[priorIdx] : null;
    if (!isFiniteNumber(e21) || !isFiniteNumber(e200) || !isFiniteNumber(e21p)) continue;
    const close = closes[last];
    const slope = e21 - e21p;
    if (close > e21 && e21 > e200 && slope > 0) out[last] = 'bull';
    else if (close < e21 && e21 < e200 && slope < 0) out[last] = 'bear';
  }
  return out;
}

/** Last index of `candles` whose close time is <= cutMs, or -1. */
function lastAtOrBefore(candles, tf, cutMs) {
  return firstIndexAfter(candles, tf, cutMs) - 1;
}

// --------------------------------------------------------------------------------------
// Trailing-vol terciles, causal: boundaries come only from a PREFIX of trailing-vol values
// seen strictly before the candle being classified (recomputed every VOL_RECOMPUTE_STRIDE
// candles from all trailing-vol values known up to that recompute point).
// --------------------------------------------------------------------------------------
export function volTerciles(candles1h) {
  const n = candles1h.length;
  const closes = candles1h.map((c) => c.close);
  const trailingVol = new Array(n).fill(null);
  for (let i = VOL_WINDOW; i < n; i++) {
    let sum = 0;
    for (let k = i - VOL_WINDOW + 1; k <= i; k++) sum += Math.abs(Math.log(closes[k] / closes[k - 1]));
    trailingVol[i] = sum / VOL_WINDOW;
  }
  const tercile = new Array(n).fill(null);
  let boundaries = null;
  let nextRecompute = 0;
  const priorValues = [];
  for (let i = 0; i < n; i++) {
    if (trailingVol[i] == null) continue;
    if (boundaries) {
      const v = trailingVol[i];
      tercile[i] = v <= boundaries[0] ? 'low' : v <= boundaries[1] ? 'mid' : 'high';
    }
    priorValues.push(trailingVol[i]);
    if (priorValues.length >= VOL_WINDOW && i >= nextRecompute) {
      const sorted = [...priorValues].sort((a, b) => a - b);
      const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
      boundaries = [q(1 / 3), q(2 / 3)];
      nextRecompute = i + VOL_RECOMPUTE_STRIDE;
    }
  }
  return { trailingVol, tercile };
}

export function hourBucketOf(ms) {
  return Math.floor(new Date(ms).getUTCHours() / (24 / HOUR_BUCKETS));
}

// --------------------------------------------------------------------------------------
// Per-symbol eligibility table: every 1h candle index with a defined HTF state, vol
// tercile and hour bucket, within the same 1m-coverage bounds run.js's own
// runRuleOnSymbol enforces (needs a full fillWindow+maxHold ahead, needs 1m coverage
// to have started).
// --------------------------------------------------------------------------------------
export function buildEligibility(symbol, historyByTf, holdMaxHours = HOLD_MAX_HOURS) {
  const candles1h = historyByTf[symbol][OWN_TF];
  const daily = historyByTf[symbol][TREND_TF_D];
  const fourH = historyByTf[symbol][TREND_TF_4H];
  const candles1m = historyByTf[symbol]['1m'];
  const fillWindowCandles = 60; // 1h in 1m candles
  const maxHoldCandles = holdMaxHours * 60;

  const dailyTrend = trendSeries(daily);
  const fourHTrend = trendSeries(fourH);
  const { tercile: volTercile } = volTerciles(candles1h);

  const oneMinStart = candles1m[0].timestamp;
  const oneMinEnd = candles1m[candles1m.length - 1].timestamp;

  const rows = new Array(candles1h.length).fill(null);
  for (let i = 0; i < candles1h.length; i++) {
    if (i + 1 < 200) continue; // mirrors run.js's MIN_COMPUTE_CANDLES gate
    const cutMs = closeTimeOf(candles1h[i], OWN_TF);
    if (cutMs < oneMinStart) continue;
    if (cutMs + (fillWindowCandles + maxHoldCandles) * 60000 > oneMinEnd) continue;

    const dIdx = lastAtOrBefore(daily, TREND_TF_D, cutMs);
    const fIdx = lastAtOrBefore(fourH, TREND_TF_4H, cutMs);
    const dTrend = dIdx >= 0 ? dailyTrend[dIdx] : null;
    const fTrend = fIdx >= 0 ? fourHTrend[fIdx] : null;
    const htfState = (dTrend && dTrend === fTrend) ? dTrend : null; // 'bull' | 'bear' | null
    if (!htfState) continue;
    const vt = volTercile[i];
    if (!vt) continue;

    rows[i] = { i, cutMs, htfState, hourBucket: hourBucketOf(cutMs), volTercile: vt };
  }
  return { rows, candles1h, candles1m, fillWindowCandles, maxHoldCandles };
}

function tierKey(tier, tuple) {
  if (tier === 1) return `${tuple.htfState}|${tuple.hourBucket}|${tuple.volTercile}`;
  if (tier === 2) return `${tuple.htfState}|${tuple.hourBucket}`;
  return `${tuple.htfState}`;
}

export function poolsByTierExport(rows) { return poolsByTier(rows); }

function poolsByTier(rows) {
  const pools = [new Map(), new Map(), new Map()];
  for (const r of rows) {
    if (!r) continue;
    for (let t = 1; t <= 3; t++) {
      const k = tierKey(t, r);
      if (!pools[t - 1].has(k)) pools[t - 1].set(k, []);
      pools[t - 1].get(k).push(r.i);
    }
  }
  return pools;
}

// --------------------------------------------------------------------------------------
// Real-signal loading (from a scripts/swing/run.js study JSON).
// --------------------------------------------------------------------------------------
export function loadRealSignals(study) {
  const out = [];
  for (const [symbol, v] of Object.entries(study.perSymbol || {})) {
    for (const s of v.signals || []) {
      if (!RESOLVED.has(s.outcome?.status)) continue;
      const grossR = s.outcome.status === 'loss' ? -1 : s.outcome.r;
      if (!isFiniteNumber(grossR)) continue;
      const risk = Math.abs(s.entry - s.stop);
      if (!(risk > 0)) continue;
      out.push({
        symbol, direction: s.direction, entry: s.entry, stop: s.stop, tp1: s.tp1,
        closedThrough: s.closedThrough, fromMs: Date.parse(s.closedThrough),
        grossR, holdCandles: s.outcome.holdCandles, status: s.outcome.status,
        riskFrac: risk / s.entry, rMultiple: Math.abs(s.tp1 - s.entry) / risk,
        stopFrac: risk / s.entry
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------
// Fill location + excursion (MFE/MAE), reusing the exact fill condition
// scoreSignal/walkOutcome use, applied over an already-known hold length so no exit logic
// needs to be reproduced.
// --------------------------------------------------------------------------------------
export function locateFill(candles1m, fromMs, entry, fillWindowCandles) {
  const start = firstAtOrAfter(candles1m, fromMs);
  if (start < 0) return -1;
  const end = Math.min(candles1m.length, start + fillWindowCandles);
  for (let i = start; i < end; i++) {
    if (candles1m[i].low <= entry && candles1m[i].high >= entry) return i;
  }
  return -1;
}

export function excursion(candles1m, fillIdx, holdCandles, direction, entry, risk) {
  let mfe = 0;
  let mae = 0;
  const end = Math.min(candles1m.length, fillIdx + holdCandles);
  for (let i = fillIdx; i < end; i++) {
    const c = candles1m[i];
    const fav = direction === 'long' ? c.high - entry : entry - c.low;
    const adv = direction === 'long' ? entry - c.low : c.high - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  return { mfeR: risk > 0 ? mfe / risk : null, maeR: risk > 0 ? mae / risk : null };
}

export function netRAt(grossR, riskFrac, hours, direction, borrowPerH) {
  const rt = direction === 'long' ? ACTUAL_COST.long : ACTUAL_COST.short;
  return grossR - (rt + borrowPerH * hours) / riskFrac;
}

// --------------------------------------------------------------------------------------
// Score one control candidate at 1h index `ctrlIdx`, using the matched real trade's own
// stop distance % and R multiple, anchored to the control candle's own close.
// --------------------------------------------------------------------------------------
export function scoreControl(elig, ctrlIdx, direction, stopFrac, rMultiple) {
  const c = elig.candles1h[ctrlIdx];
  const entry = c.close;
  const sign = direction === 'short' ? -1 : 1;
  const stop = entry - sign * stopFrac * entry;
  const risk = Math.abs(entry - stop);
  const tp1 = entry + sign * rMultiple * risk;
  const fromMs = closeTimeOf(c, OWN_TF);

  const out = scoreSignal({
    candles1m: elig.candles1m, fromMs, direction, entry, stop, target: tp1,
    fillWindowCandles: elig.fillWindowCandles, maxHoldCandles: elig.maxHoldCandles
  });
  if (!RESOLVED.has(out.status)) return null;
  const grossR = out.status === 'loss' ? -1 : out.r;
  if (!isFiniteNumber(grossR)) return null;

  const fillIdx = locateFill(elig.candles1m, fromMs, entry, elig.fillWindowCandles);
  const { mfeR, maeR } = fillIdx >= 0
    ? excursion(elig.candles1m, fillIdx, out.holdCandles, direction, entry, risk)
    : { mfeR: null, maeR: null };

  return {
    entry, stop, tp1, grossR, holdCandles: out.holdCandles, status: out.status,
    riskFrac: risk / entry, hours: out.holdCandles / 60, mfeR, maeR
  };
}

// --------------------------------------------------------------------------------------
// Per-signal control draws.
// --------------------------------------------------------------------------------------
export function drawControlsForSignal(real, elig, pools, K, seed) {
  let tier = 1;
  let key = tierKey(1, { htfState: real.direction === 'long' ? 'bull' : 'bear', hourBucket: real.hourBucket, volTercile: real.volTercile });
  let pool = pools[0].get(key) || [];
  if (pool.length < Math.max(5, Math.min(K, 20))) {
    tier = 2;
    key = tierKey(2, { htfState: real.direction === 'long' ? 'bull' : 'bear', hourBucket: real.hourBucket });
    pool = pools[1].get(key) || [];
  }
  if (pool.length < Math.max(5, Math.min(K, 20))) {
    tier = 3;
    key = tierKey(3, { htfState: real.direction === 'long' ? 'bull' : 'bear' });
    pool = pools[2].get(key) || [];
  }
  if (pool.length === 0) return { tier: 0, controls: [] };

  const controls = [];
  const selfKey = `${real.symbol}:${real.closedThrough}`;
  for (let k = 0; k < K; k++) {
    const draw = drawIndex(seed, `${selfKey}:${tier}:${key}`, k, pool.length);
    const ctrlIdx = pool[draw];
    if (ctrlIdx === real.i1h) continue; // never the real trade's own candle
    const scored = scoreControl(elig, ctrlIdx, real.direction, real.stopFrac, real.rMultiple);
    if (scored) controls.push(scored);
  }
  return { tier, poolSize: pool.length, controls };
}

// --------------------------------------------------------------------------------------
// Stats
// --------------------------------------------------------------------------------------
export function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function summarizeGroup(rows, netRKey) {
  const netRs = rows.map((r) => r[netRKey]).filter(isFiniteNumber);
  const mfes = rows.map((r) => r.mfeR).filter(isFiniteNumber);
  const maes = rows.map((r) => r.maeR).filter(isFiniteNumber);
  const tp1 = rows.filter((r) => r.status === 'win').length;
  return {
    n: rows.length,
    meanNetR: mean(netRs),
    medianNetR: median(netRs),
    tp1Rate: rows.length ? tp1 / rows.length : null,
    meanMFE: mean(mfes),
    meanMAE: mean(maes)
  };
}

/** Monte-Carlo null: S sims, each draws ONE control per real trade from that trade's own
 * K-set, computes the sim's mean net R. Percentile/p of the observed mean within this
 * null distribution (one-sided: share of sims >= observed = p that chance alone produces
 * the observed edge or better). */
export function monteCarloNull(perSignalControls, netRKey, S, seed) {
  const n = perSignalControls.length;
  const means = new Array(S);
  for (let s = 0; s < S; s++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const ctrls = perSignalControls[i].controls;
      if (!ctrls.length) continue;
      const draw = drawIndex(seed, `mc:${i}`, s, ctrls.length);
      const v = ctrls[draw][netRKey];
      if (isFiniteNumber(v)) { sum += v; count++; }
    }
    means[s] = count ? sum / count : null;
  }
  return means.filter(isFiniteNumber);
}

export function percentileAndP(observedMean, nullMeans) {
  const below = nullMeans.filter((x) => x <= observedMean).length;
  const aboveOrEqual = nullMeans.filter((x) => x >= observedMean).length;
  return {
    percentile: (below / nullMeans.length) * 100,
    pValueOneSided: aboveOrEqual / nullMeans.length
  };
}

/** Block bootstrap of the observed mean, blocked by UTC calendar day. */
export function blockBootstrapCI(realTrades, netRKey, B, seed) {
  const byDay = new Map();
  for (const t of realTrades) {
    const day = t.closedThrough.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }
  const days = [...byDay.keys()];
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    const vals = [];
    for (let d = 0; d < days.length; d++) {
      const draw = drawIndex(seed, `boot:${b}`, d, days.length);
      for (const t of byDay.get(days[draw])) vals.push(t[netRKey]);
    }
    means[b] = mean(vals);
  }
  const sorted = means.filter(isFiniteNumber).sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))))];
  return { n: sorted.length, days: days.length, p2_5: at(0.025), p50: at(0.5), p97_5: at(0.975) };
}

// --------------------------------------------------------------------------------------
// End-to-end runner (exported so tests can call it on a small synthetic fixture).
// --------------------------------------------------------------------------------------
export function runMatchedControls({ studyPath, historyDir, symbols, K, sims, boot, seed, holdMaxHours = HOLD_MAX_HOURS }) {
  const study = JSON.parse(fs.readFileSync(studyPath, 'utf8'));
  const realSignals = loadRealSignals(study).filter((s) => !symbols || symbols.includes(s.symbol));

  const historyByTf = loadHistoryDir(historyDir, symbols || [...new Set(realSignals.map((s) => s.symbol))]);
  const eligBySymbol = {};
  const poolsBySymbol = {};
  for (const symbol of Object.keys(historyByTf)) {
    eligBySymbol[symbol] = buildEligibility(symbol, historyByTf, holdMaxHours);
    poolsBySymbol[symbol] = poolsByTier(eligBySymbol[symbol].rows);
  }

  // Attach each real signal's own 1h index + bucket tuple (for tier keys and audit).
  for (const real of realSignals) {
    const candles1h = eligBySymbol[real.symbol].candles1h;
    const idx = lastAtOrBefore(candles1h, OWN_TF, real.fromMs);
    real.i1h = idx;
    const row = idx >= 0 ? eligBySymbol[real.symbol].rows[idx] : null;
    real.hourBucket = row ? row.hourBucket : hourBucketOf(real.fromMs);
    real.volTercile = row ? row.volTercile : null;
    real.htfState = row ? row.htfState : (real.direction === 'long' ? 'bull' : 'bear');
  }

  const perSignal = realSignals.map((real) => {
    const elig = eligBySymbol[real.symbol];
    const pools = poolsBySymbol[real.symbol];
    const { tier, poolSize, controls } = drawControlsForSignal(real, elig, pools, K, seed);
    for (const c of controls) {
      for (const sc of BORROW_SCENARIOS) c[`netR_${sc.id}`] = netRAt(c.grossR, c.riskFrac, c.hours, real.direction, sc.perH);
    }
    return { real, tier, poolSize, controls };
  });

  for (const real of realSignals) {
    real.hours = real.holdCandles / 60;
    real.status = real.status; // (already set) resolved status, for tp1Rate
    const elig = eligBySymbol[real.symbol];
    const risk = Math.abs(real.entry - real.stop);
    const fillIdx = locateFill(elig.candles1m, real.fromMs, real.entry, elig.fillWindowCandles);
    const exc = fillIdx >= 0 ? excursion(elig.candles1m, fillIdx, real.holdCandles, real.direction, real.entry, risk) : { mfeR: null, maeR: null };
    real.mfeR = exc.mfeR;
    real.maeR = exc.maeR;
    for (const sc of BORROW_SCENARIOS) real[`netR_${sc.id}`] = netRAt(real.grossR, real.riskFrac, real.hours, real.direction, sc.perH);
  }

  const tierCounts = perSignal.reduce((acc, p) => { acc[p.tier] = (acc[p.tier] || 0) + 1; return acc; }, {});

  const report = { generatedAt: new Date().toISOString(), studyPath, historyDir, symbols: Object.keys(historyByTf), K, sims, boot, seed, nRealSignals: realSignals.length, tierCounts, perScenario: {} };

  for (const sc of BORROW_SCENARIOS) {
    const key = `netR_${sc.id}`;
    const observed = summarizeGroup(realSignals, key);
    const pooledControls = perSignal.flatMap((p) => p.controls.map((c) => ({ ...c, [key]: c[key] })));
    const control = summarizeGroup(pooledControls, key);
    const nullMeans = monteCarloNull(perSignal, key, sims, `${seed}:${sc.id}`);
    const { percentile, pValueOneSided } = percentileAndP(observed.meanNetR, nullMeans);
    const ci = blockBootstrapCI(realSignals, key, boot, `${seed}:${sc.id}`);
    report.perScenario[sc.id] = {
      borrowPerH: sc.perH, observed, control, nullSims: nullMeans.length, percentile, pValueOneSided, bootstrapCI: ci
    };
  }

  return { report, realSignals, perSignal };
}

function parseArgs(argv) {
  const a = { study: 'var/research/wp4-matched/swing-deep2y/re-flag-retest-1h.json', history: 'test/fixtures/history/deep2y-2026-09-26', outDir: 'var/research/wp4-matched/controls-deep2y', k: 100, sims: 2000, boot: 2000, seed: 'edittrades-wp4' };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--study') a.study = argv[++i];
    else if (x === '--history') a.history = argv[++i];
    else if (x === '--out-dir') a.outDir = argv[++i];
    else if (x === '--k') a.k = Number(argv[++i]);
    else if (x === '--sims') a.sims = Number(argv[++i]);
    else if (x === '--boot') a.boot = Number(argv[++i]);
    else if (x === '--seed') a.seed = argv[++i];
    else if (x === '--symbols') a.symbols = argv[++i].split(',');
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const studyPath = path.isAbsolute(args.study) ? args.study : path.join(REPO_ROOT, args.study);
  const historyDir = path.isAbsolute(args.history) ? args.history : path.join(REPO_ROOT, args.history);
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(REPO_ROOT, args.outDir);

  console.log(`[matched-controls] study=${studyPath} history=${historyDir} K=${args.k} sims=${args.sims} boot=${args.boot} seed=${args.seed}`);
  const t0 = Date.now();
  const { report, perSignal } = runMatchedControls({ studyPath, historyDir, symbols: args.symbols, K: args.k, sims: args.sims, boot: args.boot, seed: args.seed });
  report.runtimeMs = Date.now() - t0;

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'per-signal.json'), JSON.stringify(
    perSignal.map((p) => ({ symbol: p.real.symbol, direction: p.real.direction, closedThrough: p.real.closedThrough, hourBucket: p.real.hourBucket, volTercile: p.real.volTercile, htfState: p.real.htfState, tier: p.tier, poolSize: p.poolSize, nControls: p.controls.length })),
    null, 1
  ));
  console.log(JSON.stringify(report, null, 2));
  console.log(`[matched-controls] wrote ${outDir}/{report.json,per-signal.json} in ${report.runtimeMs}ms`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
