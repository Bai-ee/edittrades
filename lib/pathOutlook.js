/**
 * T4 P1 (docs/PLAN_FLAG_PATHS.md "P1 - pathOutlook in the payload"): a measured-history
 * read on the symbol's live flag candidate - what usually happens from here, with a
 * sample size, never an invented probability. Pure: no fs, no network, no `Date.now()`.
 * Imports only `config/engine.js` and `scripts/tracker/flag-paths.js`'s `featuresAt`
 * (precedent: `lib/servedCalls.js` importing `scripts/tracker/records.js` - a lib module
 * reading a small, already-pure `scripts/` helper). `scripts/tracker/flag-paths.js`
 * itself stays pure (see its own header); nothing here changes that.
 *
 * Info only: this module never reads or changes `flagTradePlan`, `strategies`,
 * `bestSignal`, class logic, any gate/threshold, or the 3% scalp stop guard. It only
 * describes the candidate those already decided about.
 */

import { ENGINE_CONFIG } from '../config/engine.js';
import { featuresAt } from '../scripts/tracker/flag-paths.js';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// A candidate state maps 1:1 onto which measured table applies (docs/PLAN_FLAG_PATHS.md
// "Path outcomes" is labelled from the tightening point for `forming`/`proto`; a
// `triggering`/`confirmed` candidate has already broken out, so only the `broken` table
// - measured on rows that broke out - describes it (fail_first cannot happen after a
// breakout close, by the path rule's own definition).
const AT_BY_STATE = { forming: 'tightening', proto: 'tightening', triggering: 'broken', confirmed: 'broken' };
const LIVE_STATES = Object.keys(AT_BY_STATE);

// Nearest-candidate fallback rank (documented in `pickCandidate` below): the same order
// `lib/flagRecommendation.js`'s `selectWatchCandidate` uses for a no-plan WATCH
// (triggering > forming > proto), with `confirmed` appended last - reachable only when
// `buildFlagTradePlan` threw despite a confirmed candidate existing (services/
// scalpContext.js wraps that call in try/catch). Duplicated rather than imported so this
// module's import list stays exactly {config, flag-paths} (purity test).
const WATCH_RANK = { triggering: 0, forming: 1, proto: 2, confirmed: 3 };
const TF_RANK = { '1m': 0, '3m': 1, '5m': 2 };

// Default backoff feature order (matches scripts/build-path-table.js's KEYS). Overridden
// by `cfg.pathOutlook.keys` when present - this is only the fallback if a caller passes
// a `cfg` whose pathOutlook table omits it.
const DEFAULT_KEYS = ['tf', 'structureSteps', 'roomR', 'compression'];

const PATH_KEYS = ['retest_go', 'runner', 'false_break', 'fail_first', 'chop'];

/** Contract lean is 'even' within this many percentage points either way. */
const LEAN_EVEN_BAND = 5;

/**
 * The nearest opposing horizontal-zone edge strictly ahead of `entry`, in R. Small,
 * deliberately reimplemented here rather than imported - the same call
 * `scripts/replay-paths.js`'s `roomRAhead` makes (see its own header for why that one is
 * not `lib/flagTradePlan.js`'s private `nearestRoomAhead`); this copy exists only so
 * `lib/pathOutlook.js` need not import a `scripts/` file that touches fs.
 * @param {'long'|'short'} direction
 * @param {number} entry
 * @param {number} r
 * @param {Object|null} geometryContext
 * @returns {number|null}
 */
function roomRAhead(direction, entry, r, geometryContext) {
  if (!isFiniteNumber(entry) || !(r > 0)) return null;
  const sign = direction === 'short' ? -1 : 1;
  let nearest = null;
  for (const g of Object.values(geometryContext || {})) {
    if (!g) continue;
    const zones = direction === 'long' ? g.horizontalResistanceZones : g.horizontalSupportZones;
    for (const z of zones || []) {
      const edge = direction === 'long' ? z.low : z.high;
      if (!isFiniteNumber(edge)) continue;
      if (sign * (edge - entry) <= 0) continue; // must sit strictly ahead of entry
      if (nearest === null || sign * (edge - nearest) < 0) nearest = edge;
    }
  }
  return nearest === null ? null : (sign * (nearest - entry)) / r;
}

/**
 * A candidateSetups[] entry by id, only when it is still in a live state (the four
 * `AT_BY_STATE` keys) - a failed/expired hit is treated as "not found", same as a
 * missing id.
 * @param {Array<Object>|null} candidateSetups
 * @param {string|null|undefined} id
 * @returns {Object|null}
 */
function findLive(candidateSetups, id) {
  if (!id) return null;
  const c = (candidateSetups || []).find((x) => x && x.candidateId === id);
  return c && LIVE_STATES.includes(c.state) ? c : null;
}

/**
 * Nearest live 1m/3m/5m flag candidate, ranked triggering > forming > proto > confirmed
 * (see the `WATCH_RANK` comment above), then highest detector confidence, then smaller
 * timeframe, then candidateId - a total order, so the same candidate set always picks
 * the same one.
 * @param {Array<Object>|null} candidateSetups
 * @returns {Object|null}
 */
function selectNearestLiveCandidate(candidateSetups) {
  const pool = (candidateSetups || []).filter((c) => c && c.type === 'flag'
    && (c.direction === 'long' || c.direction === 'short')
    && WATCH_RANK[c.state] !== undefined
    && TF_RANK[c.timeframe] !== undefined);
  if (pool.length === 0) return null;
  return pool.slice().sort((a, b) => {
    const st = WATCH_RANK[a.state] - WATCH_RANK[b.state];
    if (st !== 0) return st;
    const conf = (isFiniteNumber(b.confidence) ? b.confidence : -1) - (isFiniteNumber(a.confidence) ? a.confidence : -1);
    if (conf !== 0) return conf;
    const tf = TF_RANK[a.timeframe] - TF_RANK[b.timeframe];
    if (tf !== 0) return tf;
    return String(a.candidateId).localeCompare(String(b.candidateId));
  })[0];
}

/**
 * Candidate choice (documented rule, T4 P1):
 *   1. `flagRecommendation.candidateId`'s own candidate, if it is still present in
 *      `candidateSetups` with a live state.
 *   2. else `flagTradePlan.candidateId`'s own candidate, same liveness check. In the
 *      normal path these two ids are identical - `flagRecommendation.candidateId`
 *      always mirrors `flagTradePlan.candidateId` (`lib/flagRecommendation.js`) - so
 *      step 2 only differs from step 1 when the recommendation build failed (caught,
 *      logged) but the trade plan build did not.
 *   3. else the nearest live forming/proto/triggering/confirmed 1m/3m/5m flag candidate
 *      (`selectNearestLiveCandidate` above). This is the only reachable branch when
 *      `flagTradePlan` is null for the ordinary reason (no confirmed candidate exists at
 *      all) - `confirmed` is included in the rank anyway for the one edge case where
 *      `buildFlagTradePlan` itself threw.
 * Returns null when no live flag candidate exists at all.
 * @param {Object} p
 * @param {Array<Object>|null} p.candidateSetups
 * @param {{candidateId:?string}|null} p.flagRecommendation
 * @param {{candidateId:?string}|null} p.flagTradePlan
 * @returns {Object|null}
 */
export function pickCandidate({ candidateSetups, flagRecommendation, flagTradePlan }) {
  return findLive(candidateSetups, flagRecommendation && flagRecommendation.candidateId)
    || findLive(candidateSetups, flagTradePlan && flagTradePlan.candidateId)
    || selectNearestLiveCandidate(candidateSetups);
}

/**
 * The backoff key sequence for one candidate's features, from the full-depth key down
 * to `tf=<tf>` alone, ending with the literal fallback key `'all'`.
 * @param {Object} features - flag-paths.js featuresAt(...) output
 * @param {Array<string>} keys
 * @returns {Array<string>}
 */
function backoffKeys(features, keys) {
  const out = [];
  for (let depth = keys.length; depth >= 1; depth--) {
    out.push(keys.slice(0, depth).map((k) => `${k}=${features[k]}`).join('|'));
  }
  out.push('all');
  return out;
}

/** First stored bucket among `keys`, or null when the table has none of them (including no `'all'`). */
function resolveBucket(table, keys) {
  for (const k of keys) {
    if (table && table[k]) return { key: k, ...table[k] };
  }
  return null;
}

/**
 * Integer-percent weights for all five paths, defaulting a missing key to 0 (the
 * `broken` table never stores `fail_first`-bearing counts by construction, but this
 * guards any other absent key the same way).
 * @param {Object|null} w
 * @param {'tightening'|'broken'} at
 * @returns {Object}
 */
function normalizeWeights(w, at) {
  const out = {};
  for (const p of PATH_KEYS) out[p] = isFiniteNumber(w && w[p]) ? w[p] : 0;
  if (at === 'broken') out.fail_first = 0; // never a real state after a breakout close
  return out;
}

/**
 * Build the `pathOutlook` contract object for one symbol, or null when no live flag
 * candidate exists (see `pickCandidate`) or the configured table cannot resolve any
 * bucket for it (an empty/malformed `cfg.pathOutlook`, never thrown).
 *
 * @param {Object} pieces
 * @param {Array<Object>|null} pieces.candidateSetups - the symbol's full (un-slimmed)
 *   candidateSetups, same array `flagTradePlan`/`flagRecommendation` were built from.
 * @param {Object|null} pieces.flagRecommendation - the FULL or compact recommendation
 *   record (only `.candidateId` is read).
 * @param {Object|null} pieces.flagTradePlan
 * @param {Object|null} pieces.geometryContext - the symbol's geometryContext (all timeframes)
 * @param {Object|null} pieces.tfEntries - the symbol's per-timeframe entries (`.stochRsi` read)
 * @param {Object|null} pieces.closedByTf - tf -> full closed candles for this build
 * @param {Object|null} pieces.marketByTf - `{ [tf]: { price, atr } }` (services/scalpContext.js, internal)
 * @param {{sentiment:string}|null} [pieces.topDown] - services/scalpContext.js's per-build topDown model (read regardless of includeBias)
 * @param {Object} [cfg=ENGINE_CONFIG]
 * @returns {Object|null}
 */
export function buildPathOutlook(pieces = {}, cfg = ENGINE_CONFIG) {
  const { candidateSetups, flagRecommendation, flagTradePlan, geometryContext, tfEntries, closedByTf, marketByTf, topDown } = pieces;

  const candidate = pickCandidate({ candidateSetups, flagRecommendation, flagTradePlan });
  if (!candidate) return null;

  const at = AT_BY_STATE[candidate.state];
  if (!at) return null; // defensive; pickCandidate only ever returns a LIVE_STATES candidate

  const tableCfg = cfg && cfg.pathOutlook;
  const table = tableCfg && tableCfg[at];
  if (!table) return null;

  const tf = candidate.timeframe;
  const direction = candidate.direction;
  const r = isFiniteNumber(candidate.breakoutLevel) && isFiniteNumber(candidate.invalidation)
    ? Math.abs(candidate.breakoutLevel - candidate.invalidation) : null;
  const roomR = r !== null && r > 0 ? roomRAhead(direction, candidate.breakoutLevel, r, geometryContext) : null;

  const durationCandles = isFiniteNumber(candidate.durationCandles) ? candidate.durationCandles : 0;
  const flagLen = Math.max(1, durationCandles + 1);
  const tfCandles = closedByTf && Array.isArray(closedByTf[tf]) ? closedByTf[tf] : [];
  const flagCandles = tfCandles.slice(Math.max(0, tfCandles.length - flagLen));

  const atrValue = marketByTf && marketByTf[tf] && isFiniteNumber(marketByTf[tf].atr) ? marketByTf[tf].atr : null;
  const stochRsi = (tfEntries && tfEntries[tf] && tfEntries[tf].stochRsi) || {};
  const flagCandidatesAll = (candidateSetups || []).filter((c) => c && c.type === 'flag');
  const sameDirOtherTf = flagCandidatesAll.some((c) => c.timeframe !== tf && c.direction === direction && c.state !== 'failed');
  const tdSide = topDown && typeof topDown.sentiment === 'string' ? topDown.sentiment : undefined;
  const fromMs = typeof candidate.firstDetectedAt === 'string' ? Date.parse(candidate.firstDetectedAt) : NaN;

  const features = featuresAt(candidate, {
    flagCandles,
    atrValue,
    stochSide: typeof stochRsi.state === 'string' ? stochRsi.state.toLowerCase() : undefined,
    stochSlope: isFiniteNumber(stochRsi.slopeK) ? stochRsi.slopeK : undefined,
    sameDirOtherTf,
    tdSide,
    ema200Side: candidate.ema200Side || undefined,
    roomR: roomR !== null ? roomR : undefined,
    fromMs: isFiniteNumber(fromMs) ? fromMs : undefined
  });

  const keys = Array.isArray(tableCfg.keys) && tableCfg.keys.length ? tableCfg.keys : DEFAULT_KEYS;
  const bucket = resolveBucket(table, backoffKeys(features, keys));
  if (!bucket) return null;

  const w = normalizeWeights(bucket.w, at);

  const breakoutScore = w.retest_go + w.runner;
  const failureScore = w.false_break + w.fail_first;
  const diff = breakoutScore - failureScore;
  const lean = Math.abs(diff) <= LEAN_EVEN_BAND ? 'even' : (diff > 0 ? 'breakout' : 'failure');

  let likely = PATH_KEYS[0];
  let bestW = -Infinity;
  for (const p of PATH_KEYS) {
    if (w[p] > bestW) { bestW = w[p]; likely = p; }
  }

  const allBucket = table.all;
  const baselineRunner = isFiniteNumber(allBucket && allBucket.w && allBucket.w.runner) ? allBucket.w.runner : 0;
  // "high": the runner share dominates the clean-retest share (>= 1.2x), or the detector
  // already flagged this exact candidate as a chase. Guard: when the bucket's retest_go
  // is 0, ">= retest_go * 1.2" is trivially true even at runner 0, so that branch only
  // fires when runner is itself positive.
  const runnerDominant = w.retest_go > 0 ? w.runner >= w.retest_go * 1.2 : w.runner > 0;
  const chase = (runnerDominant || candidate.chaseRisk === true)
    ? 'high'
    : (w.runner > baselineRunner ? 'elevated' : 'low');

  const n = isFiniteNumber(bucket.n) ? bucket.n : 0;
  const minN = isFiniteNumber(tableCfg.minN) ? tableCfg.minN : 100;

  return {
    id: candidate.candidateId || null,
    tf,
    dir: direction,
    at,
    lean,
    likely,
    chase,
    w,
    n,
    cal: n >= minN,
    key: bucket.key
  };
}

export default { buildPathOutlook, pickCandidate };
