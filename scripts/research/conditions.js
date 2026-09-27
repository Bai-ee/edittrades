#!/usr/bin/env node
/**
 * S1 Agent B - conditions study (docs/PROMPT_S1_EDGE_SEARCH.md "B - conditions study").
 * Research only: no product change, no deploy, no engine change. Read-only imports of
 * lib/services/config only - nothing under lib/, services/, config/, api/,
 * scripts/tracker/ is modified here.
 *
 * Owner question: which SUBSET of the live rules' GOOD calls (the same L0 config
 * `scripts/replay-rules.js` scores - live minRR 2.5, net gate off, own-timeframe
 * room_at_entry, retest-hold readiness) has positive net expectancy. This script replays
 * that exact production pipeline (`buildScalpContext`, same as `scripts/replay.js`'s
 * `buildAt`/`replaySymbol` and `scripts/replay-rules.js`'s config gate - no detector, no
 * geometry, no flag-plan math re-implemented here) over stored history, and for every
 * first-ready flagTradePlan records the SELECTION-FIELD context the payload already
 * carries at that close: symbol, direction, timeframe, hour-of-day (UTC),
 * `flagRecommendation.clarity.gate.passable`, `qualityBand`, `setup.shadowNF.ready`,
 * planned net R:R, `topDown.sentiment`/`.aligned`, `room` state, the candidate's
 * `ema21Hold`, a stop-distance bucket, a 15m-ATR percentile regime (14-day trailing
 * window), and the A/B/C tier from `lib/tier.js`.
 *
 * Two production-payload notes (verified against services/scalpContext.js before writing
 * this script):
 *   - `s.flagRecommendation` (the COMPACT record) is always present regardless of
 *     `include*` options and already carries `clarity.gate`, `qualityBand`,
 *     `setup.shadowNF`, `room` unstripped - no `includeModel` needed for those fields.
 *   - `s.topDown` (`{sentiment, aligned, score, leans, weekly, above200}`, lib/topDown.js
 *     `buildTopDown`) is only attached when `buildScalpContext` runs with
 *     `includeBias: true` (scalpContext.js ~line 1786). That bias/alignment pass is
 *     comparatively expensive and GOOD calls are rare (~1.3/day owner estimate), so the
 *     main replay loop below runs WITHOUT `includeBias` (same cost profile as
 *     `scripts/replay-rules.js`'s L0/V0), and only re-builds the SAME close a second time
 *     WITH `includeBias: true` on the rare close where a fresh `ready` flagTradePlan
 *     candidateId is found - a few hundred extra builds over an 85-day x 3-symbol replay,
 *     not hundreds of thousands.
 *
 * Scoring (owner instruction, this study only): fill window (`FILL_WINDOW_CANDLES`,
 * `scripts/tracker/walk-outcome.js`) / stop / TP1, with `scripts/swing/run.js`'s own
 * `scoreSignal` extension - a trade still open at the 24h hold limit is CLOSED at that
 * candle's close and scored mark-to-market (`timeout`), never dropped as an unresolved
 * `open` the way `scripts/replay-rules.js`'s own walk (`walkOutcome` with no timeout
 * close-out) would. Net R uses `scripts/tracker/costs.js` `netR(entry, stop, grossR,
 * direction)` - direction-dependent round-trip cost, 0.34% long / 0.14% short (the owner's
 * D-cost decision), not the flat 0.20% sensitivity band `replay-rules.js` also publishes.
 *
 * No lookahead: every field recorded for a GOOD call is read off the payload built AT that
 * call's own close, or (ATR regime) from a series accumulated only from closes at or
 * before it.
 *
 * Usage:
 *   node scripts/research/conditions.js --history <dir> [--symbols BTC,SOL,ETH] [--step 1]
 *     [--out var/research/conditions/<tag>.<SYM>.jsonl] [--doc docs/CONDITIONS_STUDY_2026-09-26.md] [--append]
 *   node scripts/research/conditions.js --rows a.jsonl,b.jsonl,c.jsonl --history <dir>
 *     --doc docs/CONDITIONS_STUDY_2026-09-26.md
 *     (analyze-only: skip the replay, load previously-scored rows, e.g. from parallel
 *     per-symbol runs, and just build the study doc - --history is used only to read the
 *     span from manifest.json for the OOS-halves boundary.)
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINE_CONFIG } from '../../config/engine.js';
import { buildScalpContext, dropUnclosedCandles, SYMBOLS, TIMEFRAMES } from '../../services/scalpContext.js';
import { loadHistoryDir, closedRows, clockCloses, makeReplayFetch } from '../replay.js';
import { scoreSignal } from '../swing/run.js';
import { FILL_WINDOW_CANDLES, round, median, isFiniteNumber } from '../tracker/walk-outcome.js';
import { netR } from '../tracker/costs.js';
import { classifyTier } from '../../lib/tier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

/** 24h of 1m candles - same convention as scripts/replay-rules.js HOLD_24H_CANDLES. */
export const HOLD_24H_CANDLES = 1440;
/** geometryTimeframeFor('1m'|'3m'|'5m') resolves to '15m' (ENGINE_CONFIG.geometry.timeframes) - same STRUCTURE_TF replay-rules.js uses. */
const STRUCTURE_TF = '15m';
/** ATR percentile regime lookback: trailing 14 calendar days of the 15m geometry ATR series. */
const ATR_WINDOW_MS = 14 * 86400000;
/** Minimum trailing samples before an ATR percentile is trusted rather than reading 'insufficient_history'. */
const MIN_ATR_SAMPLES = 20;

const REPLAY_ACCOUNT = Object.freeze({ status: 'unavailable', margin: { usd: null, byAsset: {} } });

/** Swallows the production pipeline's console noise. `fn` is async - must be awaited here, or the `finally` restores console.log before the pipeline's own logging inside it ever runs. */
async function quietly(fn) {
  const { log, warn, error } = console;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
}

async function servedCount(historyByTf, tf, cutMs) {
  const env = await makeReplayFetch(historyByTf, cutMs)(null, tf, 500);
  return dropUnclosedCandles(env.candles, tf, cutMs).length;
}

/** One production build, no bias/model extras - same cost profile as scripts/replay.js's buildAt. */
async function buildPlain(symbol, historyByTf, cutMs, timeframes) {
  return quietly(() => buildScalpContext({
    symbols: [symbol], timeframes, now: cutMs,
    fetchCandles: makeReplayFetch(historyByTf, cutMs),
    fetchAccount: async () => REPLAY_ACCOUNT
  }));
}

/** Same close, WITH includeBias - only called on the rare close a fresh GOOD call is found (for s.topDown). */
async function buildWithBias(symbol, historyByTf, cutMs, timeframes) {
  return quietly(() => buildScalpContext({
    symbols: [symbol], timeframes, now: cutMs, includeBias: true,
    fetchCandles: makeReplayFetch(historyByTf, cutMs),
    fetchAccount: async () => REPLAY_ACCOUNT
  }));
}

// ---------------------------------------------------------------------------
// bucketing helpers (unit-tested in test-conditions-study.js)
// ---------------------------------------------------------------------------

/** First `[upperExclusive, label]` pair (ascending) whose upper bound exceeds `value`. */
export function bucketByEdges(value, edges) {
  if (!isFiniteNumber(value)) return 'n/a';
  for (const [upper, label] of edges) if (value < upper) return label;
  return edges[edges.length - 1][1];
}

export const STOP_EDGES = [[0.5, '<0.5%'], [1.0, '0.5-1%'], [1.5, '1-1.5%'], [2.0, '1.5-2%'], [2.5, '2-2.5%'], [3.0, '2.5-3%'], [Infinity, '>=3%']];
export const NETRR_EDGES = [[0, '<0R'], [0.5, '0-0.5R'], [1.0, '0.5-1R'], [1.5, '1-1.5R'], [2.0, '1.5-2R'], [Infinity, '>=2R']];

/** `flagRecommendation.clarity.gate.passable` -> a bucket label. */
export function clarityBucket(rec) {
  if (!rec || !rec.clarity || !rec.clarity.gate) return 'unknown';
  return rec.clarity.gate.passable === true ? 'passable' : 'blocked';
}

/** `flagRecommendation.qualityBand` -> a bucket label ('high'|'medium'|'low'|'none'). */
export function qualityBandBucket(rec) {
  return (rec && rec.qualityBand) || 'none';
}

/** `flagRecommendation.setup.shadowNF` -> 'ready' | 'not_ready' | 'absent' (T-13 field is optional, per lib/flagTradePlan.js - only present when a SETUP-tier candidate also exists). */
export function shadowNfBucket(rec) {
  const nf = rec && rec.setup && rec.setup.shadowNF;
  if (!nf) return 'absent';
  return nf.ready === true ? 'ready' : 'not_ready';
}

/** `flagRecommendation.room` -> 'capped' (tp1_cap) | 'open' (measured_target) | 'none'. */
export function roomBucket(rec) {
  const room = rec && rec.room;
  if (!room) return 'none';
  return room.toLevel === 'tp1_cap' ? 'capped' : 'open';
}

/** The candidate's `ema21Hold` (lib/patternDetector.js EMA21_HOLD_LABELS, mirrored long/short) -> a direction-agnostic bucket. */
export function ema21HoldBucket(candidate) {
  const h = candidate && typeof candidate.ema21Hold === 'string' ? candidate.ema21Hold : '';
  if (h === 'hold' || h === 'hold_below') return 'hold';
  if (h === 'wick' || h === 'wick_above') return 'wick';
  if (h.startsWith('acceptance')) return 'acceptance';
  if (h === 'reclaim') return 'reclaim';
  return 'none';
}

/**
 * Percentile rank of `current` within `windowVals` (which already includes `current`,
 * self-inclusive - the caller pushes the new sample before calling this), bucketed into
 * terciles. 'insufficient_history' below MIN_ATR_SAMPLES trailing points.
 */
export function atrPercentileRegime(current, windowVals) {
  if (!isFiniteNumber(current) || !Array.isArray(windowVals) || windowVals.length < MIN_ATR_SAMPLES) return 'insufficient_history';
  const rank = windowVals.filter((v) => v <= current).length / windowVals.length;
  if (rank < 1 / 3) return 'low';
  if (rank < 2 / 3) return 'mid';
  return 'high';
}

// ---------------------------------------------------------------------------
// replay: one symbol, L0 (live config, no override) -> scored GOOD-call rows
// ---------------------------------------------------------------------------

/**
 * Replay one symbol's L0 GOOD calls (first-ready close per candidateId, mirrors
 * scripts/replay-rules.js's makeConfigCollector dedupe), each annotated with every
 * selection field and scored fill-window/stop/TP1/24h-timeout-close-out, net of
 * direction-dependent cost (0.34% long / 0.14% short).
 */
export async function replayConditions({ symbol, historyByTf, timeframes = TIMEFRAMES, step = 1 }) {
  const { closes } = clockCloses(historyByTf, timeframes);
  const min = ENGINE_CONFIG.replay.minComputeCandles;
  let first = -1;
  for (let i = 0; i < closes.length; i++) {
    let ok = true;
    for (const tf of timeframes) { if ((await servedCount(historyByTf, tf, closes[i])) < min) { ok = false; break; } }
    if (ok) { first = i; break; }
  }
  const rows = [];
  if (first === -1) return { rows, firstEligible: null };

  const selected = closes.slice(first);
  const seen = new Set();
  const atrSeries = []; // { ts, atr } - one entry per distinct 15m close, ascending
  let lastAtr15mClose = null;
  const candles1m = historyByTf['1m'];

  for (let i = 0; i < selected.length; i += Math.max(1, step)) {
    const cut = selected[i];
    const payload = await buildPlain(symbol, historyByTf, cut, timeframes);
    const s = payload.symbols[symbol];
    if (!s) continue;

    const g15 = s.geometryContext && s.geometryContext[STRUCTURE_TF];
    const closedThrough15 = s.timeframes && s.timeframes[STRUCTURE_TF] && s.timeframes[STRUCTURE_TF].closedThrough;
    if (g15 && isFiniteNumber(g15.atr) && closedThrough15 && closedThrough15 !== lastAtr15mClose) {
      atrSeries.push({ ts: Date.parse(closedThrough15), atr: g15.atr });
      lastAtr15mClose = closedThrough15;
    }

    const plan = s.flagTradePlan;
    if (!plan || plan.status !== 'ready' || !plan.candidateId || seen.has(plan.candidateId)) continue;
    seen.add(plan.candidateId);

    const rec = s.flagRecommendation || null;
    const candidate = (s.candidateSetups || []).find((c) => c && c.candidateId === plan.candidateId) || null;

    // Rare path: rebuild the SAME close with includeBias:true, only to read s.topDown.
    const biasPayload = await buildWithBias(symbol, historyByTf, cut, timeframes);
    const topDown = (biasPayload.symbols[symbol] && biasPayload.symbols[symbol].topDown) || null;

    const scored = scoreSignal({
      candles1m, fromMs: cut, direction: plan.direction, entry: plan.entry, stop: plan.stop, target: plan.tp1,
      fillWindowCandles: FILL_WINDOW_CANDLES, maxHoldCandles: HOLD_24H_CANDLES
    });
    const resolved = scored.status === 'win' || scored.status === 'loss' || scored.status === 'timeout';
    const grossR = scored.status === 'loss' ? -1 : (resolved ? scored.r : null);
    const net = resolved ? round(netR(plan.entry, plan.stop, grossR, plan.direction), 4) : null;

    const windowVals = atrSeries.filter((p) => p.ts <= cut && p.ts >= cut - ATR_WINDOW_MS).map((p) => p.atr);
    const atrRegime = atrPercentileRegime(g15 && g15.atr, windowVals);

    rows.push({
      symbol,
      candidateId: plan.candidateId,
      closedThrough: new Date(cut).toISOString(),
      direction: plan.direction,
      timeframe: plan.timeframe,
      hourUTC: new Date(cut).getUTCHours(),
      clarity: clarityBucket(rec),
      qualityBand: qualityBandBucket(rec),
      shadowNF: shadowNfBucket(rec),
      netRRBucket: bucketByEdges(plan.netRR, NETRR_EDGES),
      topDownSentiment: topDown ? topDown.sentiment : 'unknown',
      topDownAligned: topDown ? String(topDown.aligned) : 'unknown',
      room: roomBucket(rec),
      ema21Hold: ema21HoldBucket(candidate),
      stopBucket: bucketByEdges(plan.stopDistancePct, STOP_EDGES),
      atrRegime,
      tier: classifyTier(rec),
      status: scored.status,
      grossR,
      netR: net,
      holdCandles: isFiniteNumber(scored.holdCandles) ? scored.holdCandles : null,
      timeToTP1Candles: isFiniteNumber(scored.timeToTP1Candles) ? scored.timeToTP1Candles : null
    });
  }
  return { rows, firstEligible: new Date(closes[first]).toISOString() };
}

// ---------------------------------------------------------------------------
// stats / grouping / conjunctions
// ---------------------------------------------------------------------------

const RESOLVED = new Set(['win', 'loss', 'timeout']);

/**
 * L0's 1m/3m/5m flag invalidation stop has no ATR/price floor (only replay-rules.js's
 * research-only V6 adds one), so a small share of stops sit a fraction of a percent from
 * entry. The fixed round-trip cost (0.34%/0.14% of entry) divided by that near-zero risk
 * blows the loss's net R up by two-three orders of magnitude (worst observed on deep60:
 * -2193R on a single 1m stop-out) - a real property of these calls' economics, not a
 * scoring bug, but it means the MEAN net R below can be dominated by a single row in a
 * small bucket. `medianNetExpR` is the robust companion figure; read it alongside the mean
 * rather than the mean alone (see the doc's own "reading the tables" note).
 */
export function statsFor(rows) {
  const resolved = rows.filter((r) => RESOLVED.has(r.status));
  const wins = resolved.filter((r) => r.grossR > 0);
  const avg = (arr) => (arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 4) : null);
  return {
    n: rows.length,
    resolved: resolved.length,
    winPct: resolved.length ? round((wins.length / resolved.length) * 100, 2) : null,
    grossExpR: avg(resolved.map((r) => r.grossR)),
    netExpR: avg(resolved.map((r) => r.netR)),
    medianNetExpR: resolved.length ? median(resolved.map((r) => r.netR).filter(isFiniteNumber)) : null,
    medianHoldMinutes: resolved.length ? median(resolved.map((r) => r.holdCandles).filter(isFiniteNumber)) : null
  };
}

/** First 2/3 of `spanFromMs..spanToMs` vs the last 1/3 (same convention as scripts/replay-rules.js splitHalves). */
export function splitHalves(rows, spanFromMs, spanToMs) {
  if (!isFiniteNumber(spanFromMs) || !isFiniteNumber(spanToMs)) return { first: statsFor([]), second: statsFor([]) };
  const boundary = spanFromMs + Math.round((spanToMs - spanFromMs) * (2 / 3));
  const first = rows.filter((r) => Date.parse(r.closedThrough) < boundary);
  const second = rows.filter((r) => Date.parse(r.closedThrough) >= boundary);
  return { first: statsFor(first), second: statsFor(second) };
}

export const FIELDS = [
  { key: 'symbol', label: 'symbol' },
  { key: 'direction', label: 'direction' },
  { key: 'timeframe', label: 'flag timeframe' },
  { key: 'hourUTC', label: 'hour of day (UTC)' },
  { key: 'clarity', label: 'flagRecommendation.clarity.gate.passable' },
  { key: 'qualityBand', label: 'qualityBand' },
  { key: 'shadowNF', label: 'setup.shadowNF.ready' },
  { key: 'netRRBucket', label: 'planned net R:R (flagTradePlan.netRR)' },
  { key: 'topDownSentiment', label: 'topDown.sentiment' },
  { key: 'topDownAligned', label: 'topDown.aligned (0-4)' },
  { key: 'room', label: 'room state' },
  { key: 'ema21Hold', label: 'ema21Hold' },
  { key: 'stopBucket', label: 'stop distance bucket' },
  { key: 'atrRegime', label: 'ATR(15m) percentile regime (14-day trailing)' },
  { key: 'tier', label: 'tier (lib/tier.js classifyTier)' }
];

export function groupBy(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

export function fieldTable(rows, field, spanFromMs, spanToMs) {
  const groups = groupBy(rows, field.key);
  const bucketRows = [...groups.entries()].map(([bucket, rs]) => {
    const s = statsFor(rs);
    const halves = splitHalves(rs, spanFromMs, spanToMs);
    return { bucket: String(bucket), ...s, oosFirstNetExpR: halves.first.netExpR, oosSecondNetExpR: halves.second.netExpR };
  }).sort((a, b) => b.n - a.n);
  return { field, rows: bucketRows, bucketsTested: bucketRows.length };
}

/** Every two-field (bucketA, bucketB) combination with n >= minN, ranked by net R desc; top 3 plus the total combos evaluated (multiple-comparisons count). */
export function twoFieldConjunctions(rows, fields, spanFromMs, spanToMs, minN = 30) {
  const qualifying = [];
  let combosEvaluated = 0;
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const fA = fields[i];
      const fB = fields[j];
      const combo = new Map();
      for (const r of rows) {
        const k = `${r[fA.key]}\u0000${r[fB.key]}`;
        if (!combo.has(k)) combo.set(k, []);
        combo.get(k).push(r);
      }
      for (const [k, rs] of combo) {
        combosEvaluated++;
        if (rs.length < minN) continue;
        const [bucketA, bucketB] = k.split('\u0000');
        const s = statsFor(rs);
        const halves = splitHalves(rs, spanFromMs, spanToMs);
        qualifying.push({
          fieldA: fA.label, bucketA, fieldB: fB.label, bucketB, ...s,
          oosFirstNetExpR: halves.first.netExpR, oosSecondNetExpR: halves.second.netExpR
        });
      }
    }
  }
  // Ranked by MEDIAN net R, not the mean: a single razor-thin-stop loss can print net R in
  // the hundreds (fixed round-trip cost / near-zero risk - see statsFor's own comment), so
  // the mean of a 30-59-row bucket is easily dominated by one such row. Median net R is
  // the robust "best" criterion here; mean net R stays in the table for comparison.
  qualifying.sort((a, b) => (b.medianNetExpR ?? -Infinity) - (a.medianNetExpR ?? -Infinity));
  return { top3: qualifying.slice(0, 3), combosEvaluated, qualifyingCombos: qualifying.length };
}

// ---------------------------------------------------------------------------
// span (manifest.json), doc rendering, CLI
// ---------------------------------------------------------------------------

function readSpan(historyDir, symbols) {
  const manifestFile = path.join(historyDir, 'manifest.json');
  if (!existsSync(manifestFile)) return null;
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  let fromMs = null;
  let toMs = null;
  for (const symbol of symbols) {
    const entry = manifest.files && manifest.files[`${symbol}_1m.json`];
    if (!entry) continue;
    const f = Date.parse(entry.from);
    const t = Date.parse(entry.closedThrough);
    if (fromMs === null || f < fromMs) fromMs = f;
    if (toMs === null || t > toMs) toMs = t;
  }
  return fromMs !== null && toMs !== null ? { fromMs, toMs } : null;
}

function fmtR(v) { return v === null || v === undefined ? '-' : v; }
function fmtPct(v) { return v === null || v === undefined ? '-' : `${v}%`; }

function fieldMdTable(t) {
  const header = '| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |';
  const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const body = t.rows.map((r) => `| ${r.bucket} | ${r.n} | ${r.resolved} | ${fmtPct(r.winPct)} | ${fmtR(r.grossExpR)} | ${fmtR(r.netExpR)} | ${fmtR(r.medianNetExpR)} | ${fmtR(r.oosFirstNetExpR)} | ${fmtR(r.oosSecondNetExpR)} |`).join('\n');
  return [`### ${t.field.label}`, '', header, sep, body, ''].join('\n');
}

export function buildDoc({ rows, span, runLabel, historyDirLabel, symbols }) {
  const spanFromMs = span ? span.fromMs : null;
  const spanToMs = span ? span.toMs : null;
  const tables = FIELDS.map((f) => fieldTable(rows, f, spanFromMs, spanToMs));
  const bucketsTestedTotal = tables.reduce((sum, t) => sum + t.bucketsTested, 0);
  const conj = twoFieldConjunctions(rows, FIELDS, spanFromMs, spanToMs, 30);

  const parts = [];
  parts.push(`## ${runLabel}`, '');
  parts.push(`Fixture: \`${historyDirLabel}\`. Symbols: ${symbols.join(', ')}. Span: ${span ? `${new Date(span.fromMs).toISOString()} - ${new Date(span.toMs).toISOString()}` : 'unknown (no manifest.json)'}.`, '');
  parts.push(`L0 GOOD calls (first-ready close per candidateId, live config - minRR 2.5, net gate off): n = ${rows.length}.`, '');
  parts.push('Scoring: fill window (15 candles) / stop / TP1 / 24h timeout close-out (mark-to-market at the hold limit, `scripts/swing/run.js` `scoreSignal`), net of direction-dependent round-trip cost (0.34% long / 0.14% short, `scripts/tracker/costs.js` `netR`). OOS 1st/2nd = net exp R over the first 2/3 vs last 1/3 of the fixture span by calendar time (same convention as `scripts/replay-rules.js`).', '');

  parts.push('### Reading these tables: a stop-distance outlier problem', '');
  parts.push('L0\'s 1m/3m/5m flag invalidation stop has no ATR or price floor (only `scripts/replay-rules.js`\'s research-only V6 variant adds one) - the `stop distance bucket` table below shows the large majority of GOOD calls sit under 0.5% of entry, and a small number sit far tighter than that. The round-trip cost (0.34%/0.14% of entry, fixed) divided by a near-zero stop distance blows a losing trade\'s net R up by two to three orders of magnitude (worst single row on this fixture: -2193R on one 1m stop-out). That is a real property of these calls\' economics, not a scoring artifact, but it means the MEAN net R column below can be dominated by one row in a bucket as large as 30-60 calls. Every table also reports **median net R**, which is far more robust to this; read the two together rather than the mean alone, and the two-field conjunctions below are ranked by median, not mean.', '');

  parts.push('### Per-field tables', '');
  for (const t of tables) parts.push(fieldMdTable(t));

  parts.push('### Best three two-field conjunctions (n >= 30)', '');
  parts.push('Ranked by median net R (robust to the stop-distance outliers described above), not the mean.', '');
  if (conj.top3.length === 0) {
    parts.push(`No two-field conjunction reached n >= 30 (small-sample study: ${rows.length} total GOOD calls). ${conj.qualifyingCombos} combo(s) reached n >= 30 out of ${conj.combosEvaluated} combinations evaluated.`, '');
  } else {
    const header = '| field A | bucket A | field B | bucket B | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |';
    const sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
    const body = conj.top3.map((r) => `| ${r.fieldA} | ${r.bucketA} | ${r.fieldB} | ${r.bucketB} | ${r.n} | ${r.resolved} | ${fmtPct(r.winPct)} | ${fmtR(r.grossExpR)} | ${fmtR(r.netExpR)} | ${fmtR(r.medianNetExpR)} | ${fmtR(r.oosFirstNetExpR)} | ${fmtR(r.oosSecondNetExpR)} |`).join('\n');
    parts.push(header, sep, body, '');
    parts.push(`(${conj.qualifyingCombos} two-field combination(s) reached n >= 30, out of ${conj.combosEvaluated} combinations evaluated across ${FIELDS.length} fields.)`, '');
  }

  parts.push('### Multiple-comparisons caveat', '');
  const bonferroniP = (0.05 / Math.max(1, bucketsTestedTotal + conj.combosEvaluated)).toExponential(2);
  parts.push(`This run examined ${bucketsTestedTotal} single-field buckets (across ${FIELDS.length} fields) and ${conj.combosEvaluated} two-field bucket combinations - ${bucketsTestedTotal + conj.combosEvaluated} hypotheses total against ${rows.length} GOOD calls. At a naive 5% per-comparison significance level, a Bonferroni correction for this many comparisons would require roughly p < ${bonferroniP} per bucket before treating any single row as a real effect rather than noise - none of the per-bucket sample sizes here are anywhere near large enough to support that. Every "best" row above is an exploratory lead, not a confirmed edge: it should be read as a candidate for a fresh out-of-sample check (a longer or different history window, e.g. deep2y once available) before it changes any engine rule.`, '');

  return parts.join('\n');
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  const list = (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
  return {
    history: typeof opts.history === 'string' ? opts.history : null,
    symbols: list(opts.symbols),
    step: opts.step ? Number(opts.step) : 1,
    out: typeof opts.out === 'string' ? opts.out : null,
    rows: list(opts.rows),
    doc: typeof opts.doc === 'string' ? opts.doc : null,
    append: opts.append === true,
    runLabel: typeof opts['run-label'] === 'string' ? opts['run-label'] : 'deep60 (2026-07-01 to 2026-09-24)'
  };
}

function loadRowsFromFiles(files) {
  const rows = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbols = args.symbols || SYMBOLS;
  let rows = [];
  let historyDirLabel = args.history ? path.relative(REPO_ROOT, path.resolve(args.history)) : 'n/a';
  let span = null;

  if (args.rows) {
    rows = loadRowsFromFiles(args.rows);
    if (args.history) span = readSpan(path.isAbsolute(args.history) ? args.history : path.join(REPO_ROOT, args.history), symbols);
  } else {
    if (!args.history) throw new Error('need --history <dir> (or --rows <file1,file2,...>)');
    const historyDir = path.isAbsolute(args.history) ? args.history : path.join(REPO_ROOT, args.history);
    historyDirLabel = path.relative(REPO_ROOT, historyDir);
    const historyByTfAll = loadHistoryDir(historyDir, symbols);
    for (const symbol of symbols) {
      console.log(`[conditions] replaying ${symbol} over ${historyDirLabel} ...`);
      const t0 = Date.now();
      const { rows: symbolRows, firstEligible } = await replayConditions({ symbol, historyByTf: historyByTfAll[symbol], step: args.step });
      console.log(`[conditions] ${symbol}: ${symbolRows.length} GOOD calls in ${Date.now() - t0}ms (first eligible ${firstEligible})`);
      rows = rows.concat(symbolRows);
      if (args.out) {
        const perSymbolOut = symbols.length > 1 ? args.out.replace(/(\.jsonl)?$/, (m) => `.${symbol}${m || '.jsonl'}`) : args.out;
        mkdirSync(path.dirname(perSymbolOut), { recursive: true });
        writeFileSync(perSymbolOut, symbolRows.map((r) => JSON.stringify(r)).join('\n') + (symbolRows.length ? '\n' : ''));
      }
    }
    span = readSpan(historyDir, symbols);
  }

  if (args.doc) {
    const section = buildDoc({ rows, span, runLabel: args.runLabel, historyDirLabel, symbols });
    mkdirSync(path.dirname(args.doc), { recursive: true });
    if (args.append && existsSync(args.doc)) {
      appendFileSync(args.doc, `\n${section}\n`);
    } else {
      const header = [
        '# S1 Agent B - conditions study',
        '',
        'Which subset of the live L0 rules\' GOOD calls (`scripts/replay-rules.js` variant `L0`) has positive net expectancy, by selection field. Research only - no engine/config/lib change. `scripts/research/conditions.js`, `npm run study:conditions`.',
        ''
      ].join('\n');
      writeFileSync(args.doc, `${header}\n${section}\n`);
    }
    console.log(`[conditions] wrote ${args.doc}`);
  } else {
    console.log(buildDoc({ rows, span, runLabel: args.runLabel, historyDirLabel, symbols }));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[conditions] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

export default {
  replayConditions, statsFor, splitHalves, fieldTable, twoFieldConjunctions, buildDoc, parseArgs,
  bucketByEdges, clarityBucket, qualityBandBucket, shadowNfBucket, roomBucket, ema21HoldBucket, atrPercentileRegime,
  FIELDS, STOP_EDGES, NETRR_EDGES
};
