#!/usr/bin/env node
/**
 * Flag-flow backtest: replays the LIVE flag-flow alert logic over stored candle history and
 * scores every LOCK OPPORTUNITY it would have sent with the tracker's called-flag rule.
 *
 * Reused as-is (nothing re-implemented):
 *   candidates   lib/patternDetector.js detectFlagLifecycle (both directions), lib/patternLifecycle.js
 *                identifyCandidate / snapCandidateLevels / geometryTimeframeFor, measuredMoveFor,
 *                lib/geometry.js buildGeometryContext + buildGeometryB, lib/structure.js buildStructure
 *   scoring/alert lib/telegramFlow.js diffFlow (-> lib/flagFlow.js rankFlags/scoreFlag ->
 *                lib/tradeLock.js confluenceChecklist): one LOCK_OPPORTUNITY per candidateId, max one
 *                per symbol+tf per 15 min, 5/7 rule via opts.minScore
 *   outcome      scripts/tracker/called-flags.js calledFlagsFromAlerts + scoreCalledFlags (anchored at the
 *                alert price: the open of the 1m candle right after the evaluation close)
 *
 * Approximations (see docs/FLAG_FLOW_BACKTEST_2026-10-03.md):
 *   - A candidate's timeframe is re-detected at that timeframe's closes; between closes its state and
 *     levels are frozen and only the checklist (other timeframes' closed candles) and price move,
 *     re-evaluated at every 1m close. That is what the live cron does between closes.
 *   - Price = close of the newest closed 1m candle (live uses the mark price).
 *   - Indicators use the same library calls over the same 499-closed-candle window the live build sees.
 *
 * No lookahead: at time t only candles with closeTime <= t are read.
 *
 * Usage: node scripts/replay-flag-flow.js --days 200 --symbols BTC,ETH,SOL --out <dir>
 *          [--history <dir>] [--end <iso>] [--min-score 5] [--sample1m <n>] [--suffix <str>]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMA, StochasticRSI } from 'technicalindicators';
import { ENGINE_CONFIG } from '../config/engine.js';
import { INTERVAL_MS, deriveStochRsi } from '../services/scalpContext.js';
import { aggregateToBuckets } from '../services/marketData.js';
import { DIRECTIONS, detectFlagLifecycle, measuredMoveFor } from '../lib/patternDetector.js';
import { geometryTimeframeFor, snapCandidateLevels, identifyCandidate } from '../lib/patternLifecycle.js';
import { buildGeometryContext, buildGeometryB } from '../lib/geometry.js';
import { buildStructure } from '../lib/structure.js';
import { diffFlow } from '../lib/telegramFlow.js';
import { calledFlagsFromAlerts, scoreCalledFlags, calibrateCalledFlags } from './tracker/called-flags.js';

export const CHECKLIST_TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'];
const DAY = 86_400_000;
const WINDOW = 499; // closed candles the live pipeline sees per timeframe (limit 500, newest unclosed)
const WARMUP = 520; // candles before the first evaluated close, so every window is a full 499
const TRIGGER_STATES = new Set(['triggering', 'confirmed']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const closeOf = (c, tf) => (isNum(c.closeTime) ? c.closeTime : c.timestamp + INTERVAL_MS[tf]);

function readCandleFile(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.candles;
  const byTs = new Map();
  for (const c of list) byTs.set(c.timestamp, c);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** tf -> ascending candles for one symbol from `<dir>/<SYM>_<tf>.json`; 3m is bucketed from 1m, a short 1d is extended from 1m. */
export function loadSymbolHistory(dir, symbol) {
  const h = {};
  for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d']) {
    const f = path.join(dir, `${symbol}_${tf}.json`);
    if (existsSync(f)) h[tf] = readCandleFile(f);
  }
  return completeHistory(h);
}

/** Fill 3m (and any missing / short higher timeframe) by bucketing 1m, the production derivation. */
export function completeHistory(h) {
  const m1 = h['1m'];
  const m1End = closeOf(m1[m1.length - 1], '1m');
  const derive = (tf) => aggregateToBuckets(m1, 60_000, INTERVAL_MS[tf]);
  const out = { ...h, '3m': derive('3m') };
  for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
    if (!out[tf] || out[tf].length === 0) { out[tf] = derive(tf); continue; }
    // extend a native series that stops before the 1m data does (the 1d file ends a day or two early)
    const last = closeOf(out[tf][out[tf].length - 1], tf);
    const tail = derive(tf).filter((c) => closeOf(c, tf) > last && closeOf(c, tf) <= m1End);
    if (tail.length) out[tf] = [...out[tf], ...tail];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-timeframe precomputed series
// ---------------------------------------------------------------------------

/** Closed candles of one timeframe up to toMs, with a warm-up margin before fromMs (so every evaluated window is a full 499). */
function prepTimeframe(candles, tf, fromMs, toMs) {
  const first = candles.findIndex((c) => closeOf(c, tf) > fromMs);
  let end = candles.length;
  while (end > 0 && closeOf(candles[end - 1], tf) > toMs) end--;
  const start = Math.max(0, (first === -1 ? 0 : first) - WARMUP);
  const cs = candles.slice(start, end);
  return { tf, candles: cs, n: cs.length, closeT: cs.map((c) => closeOf(c, tf)) };
}

/** Index of the newest candle with closeTime <= t, else -1. */
function lastClosedIdx(p, t) {
  let lo = 0;
  let hi = p.n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (p.closeT[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo - 1;
}

// ---------------------------------------------------------------------------
// Symbol replay
// ---------------------------------------------------------------------------

const nullEntry = () => ({ candles: [], ema21: null, ema200: null, priceVs21Pct: null, priceVs200Pct: null, trend: null, stochRsi: { k: null, d: null, state: null, cross: null, slopeK: null, slopeD: null }, closedThrough: null, candleCount: 0 });

/**
 * Replay one symbol. `hist` = completeHistory() output. Returns alert rows per run plus counters.
 * @param {Object} o
 * @param {string} o.symbol
 * @param {Object} o.hist
 * @param {number} o.startMs - evaluated closes are > startMs
 * @param {number} o.endMs - last evaluated close
 * @param {number[]} [o.minScores] - one flow state per entry over the same candidates (default 5/7 and 1/7)
 * @param {number} [o.sample1m=1] - evaluate 1m candidates only on days where dayIndex % n === 0
 * @param {Function} [o.onSight] - (tf, dir, state, closeMs, candidateId, boardRow) for every triggering/confirmed sighting (test hook)
 */
export function replaySymbol({ symbol, hist, startMs, endMs, minScores = [5 / 7, 1 / 7], sample1m = 1, onSight = null, onProgress = null }) {
  const P = {};
  for (const tf of CHECKLIST_TFS) P[tf] = prepTimeframe(hist[tf], tf, startMs, endMs);
  const flagTfs = ENGINE_CONFIG.model.flagTimeframes;
  const states = minScores.map(() => ({ flow: undefined, locks: [], buttons: {} }));
  const alerts = minScores.map(() => []);
  const alerted = minScores.map(() => new Set());
  const entryCache = {};
  const geoCache = new Map();
  const active = {}; // tf -> board entries live between that timeframe's closes
  const stats = { sightings: {}, evaluations: 0 };

  /** The engine's indicator histories for the closed window ending at candle i (same library calls, same 499-candle window). */
  const indCache = {};
  const indOf = (tf, i, a) => {
    const hit = indCache[tf];
    if (hit && hit.i === i) return hit.ind;
    const closes = P[tf].candles.slice(a, i + 1).map((c) => c.close);
    const ind = {
      e21: closes.length >= 21 ? EMA.calculate({ period: 21, values: closes }) : [],
      e200: closes.length >= 200 ? EMA.calculate({ period: 200, values: closes }) : [],
      st: closes.length >= 28 ? StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 }) : []
    };
    indCache[tf] = { i, ind };
    return ind;
  };

  const entryFor = (tf, i) => {
    const hit = entryCache[tf];
    if (hit && hit.i === i) return hit.entry;
    const p = P[tf];
    let entry = nullEntry();
    if (i >= 1) {
      const a = Math.max(0, i - WINDOW + 1);
      const ind = indOf(tf, i, a);
      const ema21 = round2(ind.e21[ind.e21.length - 1]);
      const ema200 = round2(ind.e200[ind.e200.length - 1]);
      const last = p.candles[i].close;
      const hs = ind.st.slice(-2);
      entry = {
        candles: p.candles.slice(Math.max(a, i - 19), i + 1).map((c) => ({ t: new Date(c.timestamp).toISOString(), o: round2(c.open), h: round2(c.high), l: round2(c.low), c: round2(c.close), v: round2(c.volume) })),
        ema21, ema200,
        priceVs21Pct: ema21 !== null ? round2(((last - ema21) / ema21) * 100) : null,
        priceVs200Pct: ema200 !== null ? round2(((last - ema200) / ema200) * 100) : null,
        stochRsi: deriveStochRsi(hs), closedThrough: new Date(p.closeT[i]).toISOString(), candleCount: i - a + 1
      };
    }
    entryCache[tf] = { i, entry };
    return entry;
  };

  const windowOf = (tf, t) => {
    const p = P[tf];
    const i = lastClosedIdx(p, t);
    if (i < 0) return null;
    const a = Math.max(0, i - WINDOW + 1);
    return { p, i, a, closed: p.candles.slice(a, i + 1) };
  };

  /** geometryContext[tf] as buildScalpContext builds it (context + B with structure levels), cached per geometry/1h/1d close. */
  const geometryFor = (gtf, t, price) => {
    const w = windowOf(gtf, t);
    if (!w) return null;
    const i1h = lastClosedIdx(P['1h'], t);
    const k = `${gtf}|${w.i}|${i1h}|${lastClosedIdx(P['1d'], t)}`;
    if (geoCache.has(k)) return geoCache.get(k);
    const { i, a, closed } = w;
    const ind = indOf(gtf, i, a);
    let g = buildGeometryContext({ timeframe: gtf, candles: closed, ema21History: ind.e21, ema200History: ind.e200, stochHistory: ind.st });
    if (g) {
      const w1d = windowOf('1d', t);
      const w1h = windowOf('1h', t);
      const w15 = windowOf('15m', t);
      const h1 = indOf('1h', w1h.i, w1h.a);
      const structure = buildStructure({
        candles1d: w1d ? w1d.closed : [], candles1h: w1h ? w1h.closed : [], candles15m: w15 ? w15.closed : [], price,
        ema21: round2(h1.e21[h1.e21.length - 1]), ema200: round2(h1.e200[h1.e200.length - 1]), now: t
      });
      const b = buildGeometryB({
        candles: closed, geometry: g, ema21: round2(ind.e21[ind.e21.length - 1]), ema200: round2(ind.e200[ind.e200.length - 1]),
        levels: { sessionHigh: structure.sessionHigh, sessionLow: structure.sessionLow, prevDayHigh: structure.prevDayHigh, prevDayLow: structure.prevDayLow }
      });
      if (b) g = { ...g, ...b };
    }
    if (geoCache.size > 64) geoCache.clear();
    geoCache.set(k, g);
    return g;
  };

  /** The flag board rows (lib/flagFlow.js input) one timeframe's close produces: triggering / confirmed only. */
  const detectAt = (tf, t, price) => {
    const w = windowOf(tf, t);
    if (!w || w.closed.length < 2) return [];
    const { p, i, a, closed } = w;
    const out = [];
    const input = { candles: closed, ema21History: indOf(tf, i, a).e21, stochRsi: entryFor(tf, i).stochRsi };
    for (const direction of DIRECTIONS) {
      const found = detectFlagLifecycle(input, direction);
      if (!found || !TRIGGER_STATES.has(found.candidate.state)) continue;
      const c = identifyCandidate({ timeframe: tf, ...found.candidate }, { symbol, closedThroughIso: new Date(p.closeT[i]).toISOString(), intervalMs: INTERVAL_MS[tf] });
      if (c.candidateId == null) continue;
      const gtf = geometryTimeframeFor(tf);
      const s = snapCandidateLevels(c, gtf ? geometryFor(gtf, t, price) : null, found.atr);
      let { measuredTarget, measuredRR } = s;
      if (s.type === 'flag' && isNum(s.poleHeight)) {
        ({ measuredTarget, measuredRR } = measuredMoveFor({ breakoutLevel: s.breakoutLevel, invalidation: s.invalidation, poleHeight: s.poleHeight, sign: s.direction === 'short' ? -1 : 1 }));
      }
      stats.sightings[`${tf}|${direction}`] = (stats.sightings[`${tf}|${direction}`] || 0) + 1;
      const row = {
        id: s.candidateId, tf, dir: s.direction, st: s.state, brk: round2(s.breakoutLevel), inv: round2(s.invalidation),
        tgt: round2(measuredTarget), rr: round2(measuredRR), conf: round2(s.confidence), at: s.firstDetectedAt ?? null, chase: s.chaseRisk === true
      };
      if (onSight) onSight(tf, direction, s.state, t, s.candidateId, row);
      out.push(row);
    }
    return out;
  };

  const m1 = P['1m'];
  const i0 = lastClosedIdx(m1, startMs) + 1;
  for (let i = i0; i < m1.n && m1.closeT[i] <= endMs; i++) {
    const t = m1.closeT[i];
    const price = m1.candles[i].close;
    for (const tf of flagTfs) {
      if (t % INTERVAL_MS[tf] !== 0) continue;
      if (tf === '1m' && sample1m > 1 && Math.floor((t - startMs) / DAY) % sample1m !== 0) { active[tf] = []; continue; }
      active[tf] = detectAt(tf, t, price);
    }
    const board = flagTfs.flatMap((tf) => active[tf] || []).filter((e) => !alerted.every((s) => s.has(e.id)));
    if (board.length === 0) continue;
    stats.evaluations++;
    const timeframes = {};
    for (const tf of CHECKLIST_TFS) timeframes[tf] = entryFor(tf, lastClosedIdx(P[tf], t));
    const geometryContext = {};
    for (const tf of ['15m', '1h', '4h']) { const g = geometryFor(tf, t, price); if (g) geometryContext[tf] = g; }
    const payload = { dataStatus: 'complete', flagBoard: { [symbol]: board }, symbols: { [symbol]: { timeframes, geometryContext, price } } };
    states.forEach((state, k) => {
      const res = diffFlow(state, payload, t, { minScore: minScores[k] });
      for (const a of res.alerts) {
        if (a.kind !== 'LOCK_OPPORTUNITY') continue;
        alerted[k].add(a.candidateId);
        alerts[k].push({
          kind: 'LOCK_OPPORTUNITY', sentAt: new Date(t).toISOString(), symbol: a.symbol, candidateId: a.candidateId,
          direction: a.trackLevels.direction, timeframe: a.trackLevels.timeframe, entry: a.trackLevels.entry, stop: a.trackLevels.stop, tp1: a.trackLevels.tp1, flow: a.flow
        });
      }
    });
    if (onProgress && i % 20000 === 0) onProgress(t);
  }
  return { alerts, stats };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const TF_MS = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };

/**
 * Called-flag outcome rows (scripts/tracker/called-flags.js shape) for alert rows, each scored on a
 * 1m slice around the alert. `nowMs` = end of the 1m data, so a window past it stays `open`.
 */
export function scoreAlerts(alertRows, candles1m, nowMs) {
  const calls = calledFlagsFromAlerts(alertRows);
  const ts = candles1m.map((c) => c.timestamp);
  const lowerBound = (x) => { let lo = 0; let hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < x) lo = m + 1; else hi = m; } return lo; };
  const rows = [];
  for (const call of calls) {
    const at = Date.parse(call.calledAt);
    const ms = TF_MS[call.timeframe];
    const slice = candles1m.slice(lowerBound(at - 18 * ms), lowerBound(at + 12 * ms + 120_000));
    rows.push(...scoreCalledFlags([call], { [call.symbol]: slice }, [], nowMs));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_HISTORY = '/Users/bballi/Documents/Repos/snapshot_tradingview/test/fixtures/history/deep2y-2026-09-26';

function argsOf(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return o;
}

/** Hit-rate table of outcome rows by a key: called / right / wrong / flat / open / no_data and rate = right / (right + wrong). */
export function breakdown(rows, keyOf) {
  const out = {};
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null || k === undefined) continue;
    const b = out[k] || (out[k] = { called: 0, right: 0, wrong: 0, flat: 0, open: 0, no_data: 0 });
    b.called++;
    b[r.outcome]++;
  }
  for (const b of Object.values(out)) b.rate = b.right + b.wrong ? Math.round((b.right / (b.right + b.wrong)) * 1000) / 10 : null;
  return out;
}

const offsetBand = (o) => (o === null || o === undefined ? 'none' : o < 0 ? 'below entry' : o < 0.25 ? '0-0.25 ATR' : o < 0.5 ? '0.25-0.5 ATR' : o < 1 ? '0.5-1 ATR' : o < 1.5 ? '1-1.5 ATR' : '1.5+ ATR');

/** Hit rate if alerts were only sent while the alert price was within X ATR of entry (offset <= X; `abs` also drops price still below entry by more than X). */
export function capSweep(rows, caps = [0.25, 0.5, 1, 1.5]) {
  const pick = (f) => breakdown(rows.filter(f), () => 'all').all || { called: 0, right: 0, wrong: 0, flat: 0, rate: null };
  return Object.fromEntries(caps.map((x) => [x, {
    within: pick((r) => r.entryOffsetAtr !== null && r.entryOffsetAtr !== undefined && r.entryOffsetAtr <= x),
    withinAbs: pick((r) => r.entryOffsetAtr !== null && r.entryOffsetAtr !== undefined && Math.abs(r.entryOffsetAtr) <= x)
  }]));
}

const rrBand = (rr) => (rr === null || rr === undefined ? 'none' : rr < 1 ? '<1R' : rr < 2 ? '1-2R' : '2R+');

/** All the tables the backtest doc reports for one run's rows. */
export function summarizeRows(rows) {
  return {
    overall: breakdown(rows, () => 'all').all || null,
    byScore: breakdown(rows, (r) => `${r.flow.score}/7`),
    byTimeframe: breakdown(rows, (r) => r.timeframe),
    byRR: breakdown(rows, (r) => rrBand(r.flow.rr)),
    byNextTf: breakdown(rows, (r) => r.flow.nextTf || 'none'),
    bySymbol: breakdown(rows, (r) => r.symbol),
    byDirection: breakdown(rows, (r) => r.direction),
    byOffset: breakdown(rows, (r) => offsetBand(r.entryOffsetAtr)),
    capSweep: capSweep(rows),
    bySymbolTimeframe: breakdown(rows, (r) => `${r.symbol} ${r.timeframe}`)
  };
}

const writeRows = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

async function main() {
  const o = argsOf(process.argv.slice(2));
  const days = Number(o.days || 200);
  const symbols = String(o.symbols || 'BTC,ETH,SOL').split(',');
  if (!o.out) throw new Error('--out <dir> required');
  const out = o.out;
  const dir = o.history || DEFAULT_HISTORY;
  const strict = Number(o['min-score'] || 5);
  const sample1m = Number(o.sample1m || 1);
  const suffix = typeof o.suffix === 'string' ? o.suffix : '';
  const endMs = Date.parse(o.end || '2026-09-26T00:00:00Z');
  const startMs = endMs - days * DAY;
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const perSymbol = {};
  const all = { strict: [], loose: [] };
  for (const symbol of symbols) {
    const ts = Date.now();
    const hist = loadSymbolHistory(dir, symbol);
    const dataEnd = closeOf(hist['1m'][hist['1m'].length - 1], '1m');
    const { alerts, stats } = replaySymbol({
      symbol, hist, startMs, endMs, minScores: [strict / 7, 1 / 7], sample1m,
      onProgress: (t) => console.error(`[${symbol}] ${new Date(t).toISOString()} ${((Date.now() - ts) / 60000).toFixed(1)}m`)
    });
    const strictRows = scoreAlerts(alerts[0], hist['1m'], dataEnd);
    const looseRows = scoreAlerts(alerts[1], hist['1m'], dataEnd);
    writeRows(path.join(out, `${symbol}-outcomes-min${strict}${suffix}.jsonl`), strictRows);
    writeRows(path.join(out, `${symbol}-outcomes-min1${suffix}.jsonl`), looseRows);
    all.strict.push(...strictRows);
    all.loose.push(...looseRows);
    perSymbol[symbol] = { minutes: Math.round((Date.now() - ts) / 600) / 100, strict: strictRows.length, min1: looseRows.length, stats };
    console.error(`[${symbol}] done ${JSON.stringify(perSymbol[symbol])}`);
  }
  // Calibration over the whole window (the live tracker uses a rolling 30 days), same target and minimum as live.
  const summary = { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString(), days, sample1m };
  for (const [label, rows] of [[`min${strict}`, all.strict], ['min1', all.loose]]) {
    rows.sort((a, b) => Date.parse(a.calledAt) - Date.parse(b.calledAt) || a.callId.localeCompare(b.callId));
    writeRows(path.join(out, `outcomes-${label}${suffix}.jsonl`), rows);
    writeFileSync(path.join(out, `calibration-${label}${suffix}.json`), JSON.stringify(calibrateCalledFlags(rows, endMs, { target: 70, minN: 30, windowDays: days + 1 }), null, 2));
    summary[label] = summarizeRows(rows);
  }
  writeFileSync(path.join(out, `summary${suffix}.json`), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(out, `run-stats${suffix}.json`), JSON.stringify({ startMs, endMs, days, sample1m, strict, perSymbol, totalMinutes: (Date.now() - t0) / 60000 }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
