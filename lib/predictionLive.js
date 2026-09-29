/**
 * T-24 live prediction writer (docs/PROMPT_T24_PREDICTION_TRACKER.md, "Agent D — live
 * writer + cron wiring"). Info-only: never sends a Telegram message, never touches an
 * alert, never changes a threshold, the engine config, or the payload schema.
 *
 * Per symbol x timeframe (PREDICTION_SYMBOLS x PREDICTION_TIMEFRAMES), on every NEWLY
 * closed candle: first appends the RESULT row for the previous prediction of that
 * (symbol, timeframe) cell if one is pending (read from `prevState`, never re-derived from
 * Blob), then calls `predictNextCandle` for the fresh close and appends a new PREDICTION
 * row. Both row kinds land in the same public Blob JSONL store the trade journal and
 * served-calls recorder already use (lib/blobJsonl.js `appendJsonlDay`) - one file per UTC
 * day of the row's OWN `closedAt` (a PREDICTION and its later RESULT can land in different
 * day files when the close crosses UTC midnight), deduped on `id + kind`.
 *
 * `lib/predictionRule.js` does not exist in this worktree yet - agent A owns it in a
 * sibling worktree (pred-rule). `./predictionRule.js` here is a local stub carrying the
 * exported names this file needs (see that file's own header); the orchestrator swaps it
 * for agent A's real file on merge with no call-site change in this module.
 *
 * Isolation (test-telegram.js): imports nothing under lib/execution/, services/walletTracker.js,
 * lib/jupiter*, or the MCP modules - only `./predictionRule.js` (pure, no I/O) and
 * `./blobJsonl.js` (the same public Blob helper every other read-only log already uses).
 */

import { predictNextCandle, PREDICTION_TIMEFRAMES, PREDICTION_SYMBOLS, HIGHER_TF } from './predictionRule.js';
import { appendJsonlDay } from './blobJsonl.js';

export { PREDICTION_TIMEFRAMES, PREDICTION_SYMBOLS, HIGHER_TF };

export const PREDICTIONS_MANIFEST_PATH = 'predictions/manifest.json';
export const PREDICTIONS_MANIFEST_SCHEMA = 'predictions-manifest-1';
/** pred-1 rows (2026-09-29 before 04:40Z) were written with BTC candles for ETH and SOL (short-symbol fetch bug, lib/retest1hLive.js candlePairOf); the tracker ignores that version. */
export const RULE_VERSION = 'pred-1.1';

export const predictionsDayPath = (day) => `predictions/${day}.jsonl`;
/** Dedupe key = id + kind (contract). */
export const predictionRowKey = (row) => `${row.id}|${row.kind}`;

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function isDirection(v) { return v === 'over' || v === 'under' || v === 'no_call'; }

/** `<SYM>:<tf>:<closeIso>` — the prediction row id (also half of the id+kind dedupe key). */
export function predictionId(symbol, tf, closedIso) {
  return `${symbol}:${tf}:${closedIso}`;
}

/** A candle's own close time (closeTime, else timestamp) as an ISO string, or null. */
export function candleCloseIso(candle) {
  if (!candle) return null;
  const ms = isFiniteNumber(candle.closeTime) ? candle.closeTime : (isFiniteNumber(candle.timestamp) ? candle.timestamp : null);
  return isFiniteNumber(ms) ? new Date(ms).toISOString() : null;
}

/** 'over' | 'under' | 'flat' | null — a candle's own close vs its own open (the RESULT
 * row's `lastCandleDir`, the "same as last" baseline input). */
export function candleDir(candle) {
  if (!candle || !isFiniteNumber(candle.open) || !isFiniteNumber(candle.close)) return null;
  if (candle.close > candle.open) return 'over';
  if (candle.close < candle.open) return 'under';
  return 'flat';
}

function emptyGrid(fill) {
  const out = {};
  for (const sym of PREDICTION_SYMBOLS) {
    out[sym] = {};
    for (const tf of PREDICTION_TIMEFRAMES) out[sym][tf] = fill;
  }
  return out;
}

/** A fresh `state.predictions` — every (symbol, timeframe) cell empty. */
export function emptyPredictionsState() {
  return { pending: emptyGrid(null), lastClose: emptyGrid(null) };
}

/**
 * Arbitrary stored `state.predictions` -> a normalized shape; malformed cells reset to
 * empty, unknown symbols/timeframes dropped, never throws. Mirrors lib/telegram.js's own
 * normalizeXState convention (e.g. normalizeHtfState) so the two stay shape-compatible —
 * lib/telegram.js keeps its own copy of this normalizer (its isolation contract lets it
 * import only ./trackStory.js), duplicated on purpose rather than imported from here.
 */
export function normalizePredictionsState(raw) {
  const r = isObj(raw) ? raw : {};
  const rawPending = isObj(r.pending) ? r.pending : {};
  const rawLastClose = isObj(r.lastClose) ? r.lastClose : {};
  const pending = {};
  const lastClose = {};
  for (const sym of PREDICTION_SYMBOLS) {
    pending[sym] = {};
    lastClose[sym] = {};
    const rp = isObj(rawPending[sym]) ? rawPending[sym] : {};
    const rl = isObj(rawLastClose[sym]) ? rawLastClose[sym] : {};
    for (const tf of PREDICTION_TIMEFRAMES) {
      const p = rp[tf];
      pending[sym][tf] = (isObj(p) && typeof p.id === 'string' && isDirection(p.direction) && isFiniteNumber(p.refClose))
        ? { id: p.id, direction: p.direction, refClose: p.refClose, prevCandleDir: ['over', 'under', 'flat'].includes(p.prevCandleDir) ? p.prevCandleDir : null }
        : null;
      lastClose[sym][tf] = typeof rl[tf] === 'string' && Number.isFinite(Date.parse(rl[tf])) ? rl[tf] : null;
    }
  }
  return { pending, lastClose };
}

/** UTC calendar day (YYYY-MM-DD) of an ISO timestamp string. */
function utcDay(iso) {
  return String(iso).slice(0, 10);
}

/** Group `rows` by the UTC day of their OWN `closedAt`, appending each day's rows to its
 * own Blob day file (lib/blobJsonl.js appendJsonlDay, id+kind dedupe), then listing each
 * touched day in the shared predictions manifest. Propagates any store error to the
 * caller (which swallows it) rather than partially updating in-memory state past a
 * failure. */
async function appendPredictionRows(store, rows, nowIso) {
  const byDay = new Map();
  for (const row of rows) {
    const day = utcDay(row.closedAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row);
  }
  let added = 0;
  for (const [day, dayRows] of byDay) {
    const r = await appendJsonlDay(store, {
      day, dayPath: predictionsDayPath(day), manifestPath: PREDICTIONS_MANIFEST_PATH,
      manifestSchema: PREDICTIONS_MANIFEST_SCHEMA, rows: dayRows, keyOf: predictionRowKey, nowIso
    });
    added += r.added;
  }
  return added;
}

/**
 * Per (symbol, timeframe) cell: detect a newly closed candle (`candlesByTf[symbol][tf]`'s
 * own latest close vs `prevState.lastClose[symbol][tf]`); on a new close, first build the
 * RESULT row for that cell's pending prediction (if any), then call `predict`
 * (`predictNextCandle` by default — injectable so callers/tests never depend on the T-24
 * stub's own fixed decisions) for the fresh PREDICTION row. Every row built this tick is
 * appended to the shared public Blob store (predictions/YYYY-MM-DD.jsonl + manifest)
 * before this resolves.
 *
 * A Blob failure is swallowed: this returns the PREVIOUS `state.predictions` unchanged (so
 * the same "new" close is retried next tick — Blob's own id+kind dedupe makes retrying a
 * partially-succeeded prior attempt safe) and empty `rows`. Never throws.
 *
 * @param {Object} o
 * @param {Object} o.payload — this tick's build (only `configVersion` is read)
 * @param {Object<string,Object<string,Array<Object>>>} o.candlesByTf — `candlesByTf[symbol][tf]`,
 *   closed candles oldest->newest; must include every PREDICTION_TIMEFRAMES entry plus
 *   each one's HIGHER_TF (5m needs 15m, 15m needs 1h, 1h needs 4h, 4h needs 1d)
 * @param {Object} o.prevState — the stored `state.predictions` (or any malformed value —
 *   normalized internally, never throws)
 * @param {number} [o.nowMs]
 * @param {{get:Function, put:Function, head?:Function}} o.store — the same public Blob
 *   store the journal/served-calls recorder use
 * @param {Function} [o.predict=predictNextCandle]
 * @returns {Promise<{state:Object, rows:Array<Object>}>}
 */
export async function evaluatePredictions({ payload, candlesByTf, prevState, nowMs = Date.now(), store, predict = predictNextCandle }) {
  const prev = normalizePredictionsState(prevState);
  const next = { pending: {}, lastClose: {} };
  for (const sym of PREDICTION_SYMBOLS) {
    next.pending[sym] = { ...prev.pending[sym] };
    next.lastClose[sym] = { ...prev.lastClose[sym] };
  }

  const rows = [];
  const nowIso = new Date(nowMs).toISOString();
  const configVersion = payload && typeof payload.configVersion === 'string' ? payload.configVersion : null;
  const tfCandlesOf = (sym) => (candlesByTf && isObj(candlesByTf[sym])) ? candlesByTf[sym] : {};

  for (const sym of PREDICTION_SYMBOLS) {
    const tfCandles = tfCandlesOf(sym);
    for (const tf of PREDICTION_TIMEFRAMES) {
      const candles = Array.isArray(tfCandles[tf]) ? tfCandles[tf] : [];
      if (!candles.length) continue;
      const latest = candles[candles.length - 1];
      const closedIso = candleCloseIso(latest);
      if (!closedIso) continue;
      if (closedIso === prev.lastClose[sym][tf]) continue; // no new close this tick

      const pending = prev.pending[sym][tf];
      if (pending) {
        const nextClose = latest.close;
        const refClose = pending.refClose;
        const raw = isFiniteNumber(refClose) && refClose !== 0 ? ((nextClose - refClose) / refClose) * 1e4 : null;
        const moveBps = isFiniteNumber(raw) ? Math.round(raw * 10) / 10 : null;
        const hit = (pending.direction === 'no_call' || nextClose === refClose)
          ? null
          : (pending.direction === 'over' ? nextClose > refClose : nextClose < refClose);
        rows.push({
          id: pending.id, kind: 'PREDICTION_RESULT', symbol: sym, timeframe: tf, closedAt: closedIso,
          refClose, nextClose, moveBps, hit, lastCandleDir: pending.prevCandleDir || null, writtenAt: nowIso
        });
      }

      const higherTf = HIGHER_TF[tf];
      const higherCandles = Array.isArray(tfCandles[higherTf]) ? tfCandles[higherTf] : [];
      let rule;
      try {
        rule = predict({ symbol: sym, timeframe: tf, candles, higherCandles });
      } catch {
        rule = null;
      }
      const direction = rule && (rule.direction === 'over' || rule.direction === 'under') ? rule.direction : 'no_call';
      const confidence = rule && isFiniteNumber(rule.confidence) ? rule.confidence : 0;
      const inputs = rule && isObj(rule.inputs) ? rule.inputs : {};
      const reason = rule && typeof rule.reason === 'string' ? rule.reason : '';
      const id = predictionId(sym, tf, closedIso);
      const refClose = latest.close;
      rows.push({
        id, kind: 'PREDICTION', symbol: sym, timeframe: tf, closedAt: closedIso, refClose,
        direction, confidence, inputs, reason, configVersion, ruleVersion: RULE_VERSION, writtenAt: nowIso
      });

      next.pending[sym][tf] = { id, direction, refClose, prevCandleDir: candleDir(latest) };
      next.lastClose[sym][tf] = closedIso;
    }
  }

  if (!rows.length) return { state: prev, rows: [] };

  try {
    if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new Error('no_store');
    await appendPredictionRows(store, rows, nowIso);
  } catch {
    return { state: prev, rows: [] };
  }

  return { state: next, rows };
}

export default {
  PREDICTION_TIMEFRAMES, PREDICTION_SYMBOLS, HIGHER_TF, RULE_VERSION,
  PREDICTIONS_MANIFEST_PATH, PREDICTIONS_MANIFEST_SCHEMA,
  evaluatePredictions, normalizePredictionsState, emptyPredictionsState,
  predictionId, candleCloseIso, candleDir, predictionsDayPath, predictionRowKey
};
