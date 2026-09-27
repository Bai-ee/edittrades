#!/usr/bin/env node
/**
 * WP1 — R1 + R1+ causality auditor (docs/research/EXTERNAL_HARNESS_REFERENCES.md R1,
 * "Reconciliation" R1+; docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md WP1).
 * Research only. Reads production code and rule modules; changes nothing.
 *
 * Freqtrade `lookahead-analysis` concept, reimplemented (GPL-3.0 source, MIT-clean
 * reimplementation per docs/research/EXTERNAL_HARNESS_REFERENCES.md R1): rerun a
 * decision function with the data truncated to what was closed at decision time and
 * compare with the full-history result. Same tamper-and-compare pattern independently
 * verified in `0xpg/crypto-trend-following` @ 4aaa229f5bc9f1b762ba4f6ba5d83c9f5cfef294
 * (MIT), `tests/test_engine.py::TestSignalTiming.test_no_lookahead_in_signal`: mutate
 * every value after a cut bar, assert the signal frame up to the cut is byte-identical.
 * No code copied; the pattern (tamper the tail, diff the head) is the same one built
 * here for three different interfaces (swing rules, runSma4h, edge-search families).
 *
 * Three checks per decision point, each targeting a different failure mode:
 *   1. Windowing regression (`windowingRegressionCheck`) — swing rules only. Calls
 *      `scripts/swing/run.js`'s real `buildCtx` twice: once on the untouched history,
 *      once on history pre-filtered to `closeTime <= cutMs` for every native timeframe.
 *      `buildCtx` re-windows internally via `closedWindow`/`firstIndexAfter` regardless
 *      of input, so this is a regression test of THAT windowing logic (does it ever let
 *      a future candle through), not of individual rule bodies — buildCtx's own
 *      contract (every `candlesByTf[tf]` is exactly sliced to `ctx.i`) makes a rule-body
 *      leak on its own timeframe structurally unreachable through this comparison. It
 *      should always pass; a failure here is a P0 harness bug, not a rule bug.
 *   2. HTF availability (`htfAvailabilityCheck`) — asserts every candle in every
 *      `ctx.candlesByTf[*]` closed at or before `ctx.cutMs`. Item R1+ "HTF availability
 *      per timeframe: latest completed HTF bar only."
 *   3. Own-timeframe defensive-slice probe (`ownTfProbeCheck`) — the one check that CAN
 *      catch a rule body reading past its own decision index, because it does not go
 *      through `buildCtx`'s renumbering: it appends a few real future candles onto the
 *      END of `ctx.candlesByTf[ctx.tf]` while leaving `ctx.i` unchanged (so `ctx.i` no
 *      longer equals `array.length - 1`, a state `buildCtx` itself can never produce).
 *      A rule that only ever reads `<= ctx.i` (directly, or by defensively re-slicing to
 *      `ctx.i` first, the documented pattern in most rules here) is unaffected. A rule
 *      that reads `array[array.length - 1]` or `array[ctx.i + 1]` without bounding to
 *      `ctx.i` will see a different candle. This is reported SEPARATELY from the PASS/
 *      FAIL verdict (which checks 1+2 alone decide) because a handful of rules
 *      (ctl-donchian-20d, ctl-ema-pullback-1d) document, on purpose, reading their own
 *      timeframe "as given, not re-sliced by index" — a real design choice that trusts
 *      buildCtx's contract rather than a bug, but a documented reliance worth flagging
 *      (a future buildCtx change could turn it into a real leak).
 *
 * Applies the same tamper-and-compare idea, without buildCtx, to:
 *   - `runSma4h` (scripts/research/edge/sma4h-trend.js): "position at bar i unchanged
 *     when bars after i+1 are removed" — literal per the work package.
 *   - edge-search families (scripts/research/edge/families.js): `signal(ctx, i)` takes
 *     an explicit absolute bar index into arrays that are NOT re-windowed by the
 *     interface itself, so truncating the tail (removing rows after i, never touching
 *     index i's own position) is a clean, zero-false-positive test of both the family's
 *     signal function and the shared indicator helpers in `scripts/research/edge/lib.js`
 *     (ema/sma/atr/rsi/donchian — all causal recurrences by inspection; this is the
 *     empirical proof).
 *
 * Plus three small standalone helpers used by the checks above and reusable elsewhere:
 *   - `assertTimestampChain` — generic monotone-timestamp-chain assertion for trade
 *     records (bar close -> decision -> fill -> exit), applied here to `runSma4h` trades.
 *   - `purge` — label-purge helper for a future labelled/ML study (train/valid boundary).
 *   - the injected-leak self-test lives in test-causality-audit.js, not here: a fixture
 *     rule reading `ctx.candlesByTf[ctx.tf][ctx.i + 1]` directly, asserted caught by
 *     `ownTfProbeCheck` and (by design, per the note above) NOT caught by
 *     `windowingRegressionCheck` — both facts are asserted, since buildCtx's contract
 *     makes the latter a documented, expected miss for this specific leak shape.
 *
 * CLI:
 *   node scripts/research/harness/causality-audit.js [--history <dir>] [--symbols BTC,SOL,ETH]
 *     [--rules <ids>] [--sample-cap 200] [--seed 42] [--out-dir var/research/wp1-causality]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildCtx, closeTimeOf, firstIndexAfter, loadRules } from '../../swing/run.js';
import { loadHistoryDir, NATIVE_TIMEFRAMES } from '../../replay.js';
import { SYMBOLS } from '../../../services/scalpContext.js';
import { runSma4h, barsFromCandles } from '../edge/sma4h-trend.js';
import { loadBars, lastClosedIdx } from '../edge/lib.js';
import { makeCtx, buildConfigs } from '../edge/families.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIN_COMPUTE_CANDLES = 200; // mirrors scripts/swing/run.js's own (unexported) gate

// --------------------------------------------------------------------- seeded sampling

/** mulberry32: deterministic PRNG from a 32-bit seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, combines any number of parts into one 32-bit seed. */
export function hashSeed(...parts) {
  const str = parts.join(':');
  let h = 0x811c9dc5;
  for (let k = 0; k < str.length; k++) {
    h ^= str.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic sample of `k` distinct elements from `arr` (order-preserving, ascending). */
export function seededPick(arr, k, seed) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (arr.length <= k) return arr.slice().sort((a, b) => a - b);
  const rnd = mulberry32(seed);
  const pool = arr.slice();
  const out = [];
  for (let j = 0; j < k && pool.length; j++) {
    const idx = Math.floor(rnd() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out.sort((a, b) => a - b);
}

// --------------------------------------------------------------------- swing rules

/** Every candle in every `ctx.candlesByTf[*]` must have closed at or before `ctx.cutMs`. */
export function htfAvailabilityCheck(ctx) {
  const violations = [];
  for (const [tf, candles] of Object.entries(ctx.candlesByTf || {})) {
    if (!Array.isArray(candles)) continue;
    for (const c of candles) {
      const ct = closeTimeOf(c, tf);
      if (ct > ctx.cutMs) violations.push({ tf, timestamp: c.timestamp, closeTime: ct, cutMs: ctx.cutMs });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** { direction, entry, stop, tp1, tp2 } deep-equal within a float epsilon. `reason`/`holdRule` text excluded (not decision-relevant). */
export function signalsEqual(a, b, eps = 1e-9) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.direction !== b.direction) return false;
  const eq = (x, y) => (x == null && y == null) || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= eps);
  return eq(a.entry, b.entry) && eq(a.stop, b.stop) && eq(a.tp1, b.tp1) && eq(a.tp2, b.tp2);
}

/** Filter every native tf's candles to `closeTime <= cutMs` (no PRODUCTION_FETCH_WINDOW cap — the point is to remove future rows, not to re-cap depth). */
export function buildTruncatedHistory(historyByTf, cutMs, nativeTimeframes = NATIVE_TIMEFRAMES) {
  const out = {};
  for (const tf of nativeTimeframes) {
    const arr = historyByTf[tf];
    if (!arr) continue;
    const idx = firstIndexAfter(arr, tf, cutMs);
    out[tf] = arr.slice(0, idx);
  }
  return out;
}

/** Check 1 (windowing regression) + ctxRef used by checks 2/3. */
export function windowingRegressionCheck({ rule, symbol, tf, i, historyByTf, nativeTimeframes = NATIVE_TIMEFRAMES }) {
  const ctxRef = buildCtx({ symbol, tf, i, historyByTf });
  let resultRef = null, error = null;
  try { resultRef = rule.signalAt(ctxRef); } catch (err) { error = err.message; }

  const truncated = buildTruncatedHistory(historyByTf, ctxRef.cutMs, nativeTimeframes);
  const iTrunc = truncated[tf] ? truncated[tf].length - 1 : null;
  let resultTrunc = null, errorTrunc = null, ctxTrunc = null;
  if (iTrunc != null && iTrunc >= 0) {
    ctxTrunc = buildCtx({ symbol, tf, i: iTrunc, historyByTf: truncated });
    try { resultTrunc = rule.signalAt(ctxTrunc); } catch (err) { errorTrunc = err.message; }
  }

  const pass = !error && !errorTrunc && ctxTrunc != null && signalsEqual(resultRef, resultTrunc);
  return { ctxRef, ctxTrunc, resultRef, resultTrunc, pass, error, errorTrunc };
}

/** Check 3 (own-timeframe defensive-slice probe): append real future candles past ctx.i, keep ctx.i fixed. */
export function ownTfProbeCheck({ rule, ctxRef, resultRef, historyByTf, revealCount = 3 }) {
  const tf = ctxRef.tf;
  const base = ctxRef.candlesByTf && ctxRef.candlesByTf[tf];
  const fullTf = historyByTf[tf];
  if (!Array.isArray(base) || base.length === 0 || !Array.isArray(fullTf)) return { skipped: true, reason: 'no own-tf window' };
  const globalIdx = fullTf.indexOf(base[base.length - 1]); // same object reference (closedWindow slices, doesn't copy)
  if (globalIdx === -1) return { skipped: true, reason: 'decision candle not found by reference in historyByTf' };
  const future = fullTf.slice(globalIdx + 1, globalIdx + 1 + revealCount);
  if (future.length === 0) return { skipped: true, reason: 'no future candles left in fixture to reveal' };

  const probeCtx = { ...ctxRef, candlesByTf: { ...ctxRef.candlesByTf, [tf]: base.concat(future) } };
  let resultProbe = null, error = null;
  try { resultProbe = rule.signalAt(probeCtx); } catch (err) { error = err.message; }
  const differs = error != null || !signalsEqual(resultRef, resultProbe);
  return { skipped: false, differs, resultProbe, error };
}

/** Walk every eligible decision index for one (rule, symbol); classify signal vs non-signal (no scoring). */
export function classifyRuleSymbol({ rule, symbol, historyByTf, minComputeCandles = MIN_COMPUTE_CANDLES }) {
  const tf = rule.meta.tf;
  const candles = historyByTf[tf];
  const signalIdx = [];
  const nonSignalIdx = [];
  if (!Array.isArray(candles)) return { signalIdx, nonSignalIdx };
  for (let i = 0; i < candles.length; i++) {
    if (i + 1 < minComputeCandles) continue;
    const ctx = buildCtx({ symbol, tf, i, historyByTf });
    let signal = null;
    try { signal = rule.signalAt(ctx); } catch { signal = null; } // classification only; real errors surface in windowingRegressionCheck
    if (signal && (signal.direction === 'long' || signal.direction === 'short')) signalIdx.push(i);
    else nonSignalIdx.push(i);
  }
  return { signalIdx, nonSignalIdx };
}

/**
 * Full audit of one rule module across symbols. Samples all signal points plus an equal
 * count of seeded random non-signal points, capped at `sampleCap` total (split across
 * symbols, then split signal/non-signal within each symbol).
 */
export function auditSwingRule({ rule, historyByTf, symbols, sampleCap = 200, revealCount = 3, seed = 42, minComputeCandles = MIN_COMPUTE_CANDLES }) {
  const perSymbolCap = Math.max(2, Math.floor(sampleCap / symbols.length));
  const evidence = [];
  let totalPoints = 0, htfFail = 0, windowFail = 0, probeDiffer = 0, probeSkipped = 0;

  for (const symbol of symbols) {
    if (!historyByTf[symbol]) continue;
    const { signalIdx, nonSignalIdx } = classifyRuleSymbol({ rule, symbol, historyByTf: historyByTf[symbol], minComputeCandles });
    const halfCap = Math.max(1, Math.floor(perSymbolCap / 2));
    const sampledSignals = seededPick(signalIdx, halfCap, hashSeed(seed, rule.meta.id, symbol, 'sig'));
    const nonSignalTarget = sampledSignals.length || halfCap;
    const sampledNonSignals = seededPick(nonSignalIdx, nonSignalTarget, hashSeed(seed, rule.meta.id, symbol, 'non'));
    const points = [...sampledSignals, ...sampledNonSignals];

    for (const i of points) {
      totalPoints++;
      const wr = windowingRegressionCheck({ rule, symbol, tf: rule.meta.tf, i, historyByTf: historyByTf[symbol] });
      const htf = htfAvailabilityCheck(wr.ctxRef);
      if (!htf.ok) {
        htfFail++;
        evidence.push({ type: 'htf', symbol, i, cutMs: wr.ctxRef.cutMs, violations: htf.violations });
      }
      if (!wr.pass) {
        windowFail++;
        evidence.push({ type: 'windowing', symbol, i, cutMs: wr.ctxRef.cutMs, resultRef: wr.resultRef, resultTrunc: wr.resultTrunc, error: wr.error, errorTrunc: wr.errorTrunc });
      }
      const probe = ownTfProbeCheck({ rule, ctxRef: wr.ctxRef, resultRef: wr.resultRef, historyByTf: historyByTf[symbol], revealCount });
      if (probe.skipped) probeSkipped++;
      else if (probe.differs) {
        probeDiffer++;
        evidence.push({ type: 'probe', symbol, i, cutMs: wr.ctxRef.cutMs, resultRef: wr.resultRef, resultProbe: probe.resultProbe, error: probe.error });
      }
    }
  }

  return {
    ruleId: rule.meta.id,
    tf: rule.meta.tf,
    totalPoints,
    htfFail,
    windowFail,
    probeDiffer,
    probeSkipped,
    verdict: (htfFail === 0 && windowFail === 0) ? 'PASS' : 'FAIL',
    evidence: evidence.slice(0, 8)
  };
}

export async function loadRuleModules(rulesDir, filterIds) {
  const files = loadRules(rulesDir, filterIds);
  const rules = [];
  for (const { path: rulePath } of files) {
    const mod = await import(pathToFileURL(rulePath).href);
    if (!mod.meta || typeof mod.signalAt !== 'function') continue;
    rules.push({ meta: mod.meta, signalAt: mod.signalAt });
  }
  return rules;
}

// --------------------------------------------------------------------- runSma4h

/** Slice a typed-array `bars` object (loadBars/barsFromCandles shape) to its first `k` rows. */
export function sliceBars(bars, k) {
  const n = Math.max(0, Math.min(k, bars.n));
  return { n, t: bars.t.slice(0, n), ct: bars.ct.slice(0, n), o: bars.o.slice(0, n), h: bars.h.slice(0, n), l: bars.l.slice(0, n), c: bars.c.slice(0, n), v: bars.v.slice(0, n) };
}

/** "Positions at bar i unchanged when bars after i+1 are removed" (per the work package). */
export function auditSma4h(bars, { cap = 200, seed = 42, runOpts = {} } = {}) {
  const full = runSma4h(bars, runOpts);
  const fullByT = new Map(full.series.map((s) => [s.t, s]));
  const eligible = [];
  for (let i = MIN_COMPUTE_CANDLES; i < bars.n - 2; i++) eligible.push(i);
  const sampled = seededPick(eligible, cap, seed);

  const failures = [];
  let checked = 0;
  for (const i of sampled) {
    const truncBars = sliceBars(bars, i + 2); // keep [0, i+1]; remove i+2 onward
    const truncResult = runSma4h(truncBars, runOpts);
    for (const s of truncResult.series) {
      const ref = fullByT.get(s.t);
      if (!ref) continue;
      checked++;
      const posMismatch = ref.position !== s.position;
      const smaMismatch = Number.isFinite(ref.sma) !== Number.isFinite(s.sma) || (Number.isFinite(ref.sma) && Math.abs(ref.sma - s.sma) > 1e-9);
      if (posMismatch || smaMismatch) {
        failures.push({ truncationAt: i, t: s.t, refPosition: ref.position, truncPosition: s.position, refSma: ref.sma, truncSma: s.sma });
      }
    }
  }
  return { sampled: sampled.length, checked, failures, verdict: failures.length === 0 ? 'PASS' : 'FAIL' };
}

// --------------------------------------------------------------------- edge families

/** Truncate every timeframe in a `makeCtx`-shaped bars object to closes <= cutMs (tail only; earlier indices unaffected). */
export function truncateBarsAt(bars, cutMs) {
  const out = {};
  for (const tf of Object.keys(bars)) {
    const b = bars[tf];
    const idx = lastClosedIdx(b, cutMs);
    const k = idx + 1;
    out[tf] = { n: k, t: b.t.slice(0, k), ct: b.ct.slice(0, k), o: b.o.slice(0, k), h: b.h.slice(0, k), l: b.l.slice(0, k), c: b.c.slice(0, k), v: b.v.slice(0, k) };
  }
  return out;
}

export function familySpecsEqual(a, b, eps = 1e-9) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.dir !== b.dir) return false;
  const eq = (x, y) => (x == null && y == null) || (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= eps);
  return eq(a.stop, b.stop) && eq(a.target, b.target) && eq(a.trailAtr, b.trailAtr) && eq(a.trailMult, b.trailMult) && eq(a.maxHoldH, b.maxHoldH);
}

export function classifyFamilyConfig({ cfg, bars, minIdx = MIN_COMPUTE_CANDLES }) {
  const ctx = makeCtx(bars);
  const b = bars[cfg.tf];
  const signalIdx = [], nonSignalIdx = [];
  for (let i = minIdx; i < b.n; i++) {
    let spec = null;
    try { spec = cfg.signal(ctx, i); } catch { spec = null; }
    if (spec && spec.dir) signalIdx.push(i); else nonSignalIdx.push(i);
  }
  return { signalIdx, nonSignalIdx };
}

/** Same absolute index `i` in both full and tail-truncated bars — no renumbering needed (item 1, families). */
export function auditFamilyConfig({ cfg, bars, sampleCap = 200, seed = 42, minIdx = MIN_COMPUTE_CANDLES }) {
  const { signalIdx, nonSignalIdx } = classifyFamilyConfig({ cfg, bars, minIdx });
  const half = Math.max(1, Math.floor(sampleCap / 2));
  const sampledSignals = seededPick(signalIdx, half, hashSeed(seed, cfg.id, 'sig'));
  const sampledNonSignals = seededPick(nonSignalIdx, sampledSignals.length || half, hashSeed(seed, cfg.id, 'non'));
  const points = [...sampledSignals, ...sampledNonSignals];

  const ctxFull = makeCtx(bars);
  const evidence = [];
  let fails = 0;
  for (const i of points) {
    const cutMs = bars[cfg.tf].ct[i];
    const truncBars = truncateBarsAt(bars, cutMs);
    const ctxTrunc = makeCtx(truncBars);
    let specFull = null, specTrunc = null, err = null;
    try { specFull = cfg.signal(ctxFull, i); } catch (e) { err = `full:${e.message}`; }
    try { specTrunc = cfg.signal(ctxTrunc, i); } catch (e) { err = `${err ? `${err};` : ''}trunc:${e.message}`; }
    if (err || !familySpecsEqual(specFull, specTrunc)) {
      fails++;
      evidence.push({ i, t: bars[cfg.tf].t[i], specFull, specTrunc, err });
    }
  }
  return { id: cfg.id, family: cfg.family, tf: cfg.tf, points: points.length, fails, verdict: fails === 0 ? 'PASS' : 'FAIL', evidence: evidence.slice(0, 5) };
}

// --------------------------------------------------------------------- timestamp chain + label purge

/**
 * Generic monotone-timestamp-chain assertion. `stages`: ordered
 * `[{ name, get: (record) => msOrNull }]`. A stage missing for a record (null/undefined)
 * is skipped, not failed - not every record carries every stage.
 */
export function assertTimestampChain(records, stages) {
  const violations = [];
  records.forEach((r, idx) => {
    let prevName = null, prevMs = null;
    for (const stage of stages) {
      const ms = stage.get(r);
      if (ms == null) continue;
      if (!Number.isFinite(ms)) {
        violations.push({ index: idx, stage: stage.name, reason: 'non-finite timestamp', value: ms });
        continue;
      }
      if (prevMs != null && ms < prevMs) {
        violations.push({ index: idx, from: prevName, to: stage.name, fromMs: prevMs, toMs: ms, reason: 'out of order' });
      }
      prevName = stage.name; prevMs = ms;
    }
  });
  return { ok: violations.length === 0, violations, n: records.length };
}

/** Concrete chain for runSma4h trades: bar close (decision) -> fill (next bar open) -> exit. */
export function sma4hTimestampChain(result, { intervalMs = 4 * 3600e3 } = {}) {
  const records = result.trades.map((t) => {
    const fillMs = Date.parse(t.entryTime);
    return { decisionMs: fillMs - intervalMs, fillMs, exitMs: Date.parse(t.exitTime) };
  });
  return assertTimestampChain(records, [
    { name: 'decision (prior bar close)', get: (r) => r.decisionMs },
    { name: 'fill (this bar open)', get: (r) => r.fillMs },
    { name: 'exit', get: (r) => r.exitMs }
  ]);
}

/**
 * Label-purge helper for a future labelled/ML study: drop training rows whose label
 * horizon [t, t+horizonMs) extends into or past the validation start, so no training
 * label is computed from data that overlaps the validation window.
 */
export function purge(trainRows, validStart, horizonMs, { getTime = (r) => r.t } = {}) {
  if (!Number.isFinite(validStart) || !Number.isFinite(horizonMs)) {
    throw new Error('purge: validStart and horizonMs must be finite numbers');
  }
  return trainRows.filter((r) => {
    const t = getTime(r);
    return Number.isFinite(t) && t + horizonMs <= validStart;
  });
}

// --------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = {
    history: 'test/fixtures/history/deep60-2026-09-24', symbols: SYMBOLS, rules: null,
    sampleCap: 200, seed: 42, outDir: 'var/research/wp1-causality'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--history') args.history = argv[++i];
    else if (a === '--symbols') args.symbols = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--rules') args.rules = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--sample-cap') args.sampleCap = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--out-dir') args.outDir = argv[++i];
  }
  return args;
}

function mdTable(header, rows) {
  const h = `| ${header.join(' | ')} |`;
  const sep = `| ${header.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return [h, sep, body].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const historyDir = path.isAbsolute(args.history) ? args.history : path.join(REPO_ROOT, args.history);
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(REPO_ROOT, args.outDir);
  mkdirSync(outDir, { recursive: true });

  const t0 = Date.now();
  console.log(`[causality-audit] swing rules: history=${historyDir} symbols=${args.symbols.join(',')} sampleCap=${args.sampleCap} seed=${args.seed}`);
  const historyByTf = loadHistoryDir(historyDir, args.symbols);
  const rulesDir = path.join(__dirname, '../../swing/rules');
  const rules = await loadRuleModules(rulesDir, args.rules);

  const swingResults = [];
  for (const rule of rules) {
    const t1 = Date.now();
    const result = auditSwingRule({ rule, historyByTf, symbols: args.symbols, sampleCap: args.sampleCap, seed: args.seed });
    result.runtimeMs = Date.now() - t1;
    swingResults.push(result);
    console.log(`[causality-audit] ${rule.meta.id}: ${result.verdict} (n=${result.totalPoints}, htfFail=${result.htfFail}, windowFail=${result.windowFail}, probeDiffer=${result.probeDiffer}/${result.totalPoints - result.probeSkipped}) in ${result.runtimeMs}ms`);
  }

  console.log('[causality-audit] runSma4h ...');
  const sma4hResults = {};
  for (const symbol of args.symbols) {
    const bars = loadBars(symbol, '4h', 'var/edge/4h-long');
    sma4hResults[symbol] = auditSma4h(bars, { cap: args.sampleCap, seed: args.seed });
    console.log(`[causality-audit] runSma4h ${symbol}: ${sma4hResults[symbol].verdict} (checked=${sma4hResults[symbol].checked})`);
    if (sma4hResults[symbol].verdict === 'PASS') {
      const full = runSma4h(bars, {});
      const chain = sma4hTimestampChain(full);
      sma4hResults[symbol].timestampChain = { ok: chain.ok, n: chain.n, violations: chain.violations.slice(0, 5) };
    }
  }

  console.log('[causality-audit] edge-search families (sample) ...');
  const allConfigs = buildConfigs();
  // one representative config per family (F1..F4) plus the plain (non-regime) N20 Donchian variant
  const sampleIds = ['F1-don-1h-N20-k2', 'F2-tsmom-1d-L20-k2', 'F3-mr-1h-rsi2-k1.5', 'F4-squeeze-4h-k2'];
  const sampledConfigs = allConfigs.filter((c) => sampleIds.includes(c.id));
  const familyResults = [];
  if (sampledConfigs.length) {
    const barsByTf = {};
    for (const tf of ['5m', '1h', '4h', '1d']) barsByTf[tf] = loadBars('BTC', tf);
    for (const cfg of sampledConfigs) {
      const r = auditFamilyConfig({ cfg, bars: barsByTf, sampleCap: args.sampleCap, seed: args.seed });
      familyResults.push(r);
      console.log(`[causality-audit] family ${cfg.id}: ${r.verdict} (n=${r.points})`);
    }
  }

  const runtimeMs = Date.now() - t0;
  const summary = { generatedAt: new Date().toISOString(), historyDir: path.relative(REPO_ROOT, historyDir), symbols: args.symbols, sampleCap: args.sampleCap, seed: args.seed, runtimeMs, swingResults, sma4hResults, familyResults };
  writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const lines = [];
  lines.push('# WP1 causality audit — CLI run');
  lines.push('');
  lines.push(`Generated ${summary.generatedAt}. Runtime ${runtimeMs}ms. See docs/research/harness/WP1_CAUSALITY.md for the full report.`);
  lines.push('');
  lines.push('## Swing rules');
  lines.push('');
  lines.push(mdTable(
    ['rule', 'tf', 'verdict', 'n', 'htfFail', 'windowFail', 'probeDiffer/checked'],
    swingResults.map((r) => [r.ruleId, r.tf, r.verdict, r.totalPoints, r.htfFail, r.windowFail, `${r.probeDiffer}/${r.totalPoints - r.probeSkipped}`])
  ));
  lines.push('');
  lines.push('## runSma4h');
  lines.push('');
  lines.push(mdTable(['symbol', 'verdict', 'sampled', 'checked'], Object.entries(sma4hResults).map(([s, r]) => [s, r.verdict, r.sampled, r.checked])));
  lines.push('');
  lines.push('## Edge-search families (sample)');
  lines.push('');
  lines.push(mdTable(['config', 'family', 'tf', 'verdict', 'n'], familyResults.map((r) => [r.id, r.family, r.tf, r.verdict, r.points])));
  lines.push('');
  writeFileSync(path.join(outDir, 'REPORT.md'), lines.join('\n'));
  console.log(`[causality-audit] wrote ${path.relative(REPO_ROOT, outDir)}/{summary.json,REPORT.md} in ${runtimeMs}ms`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
