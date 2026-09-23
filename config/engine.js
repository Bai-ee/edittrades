/**
 * Engine configuration loader.
 *
 * `config/engine.json` is the single source of truth for tunable engine constants.
 * This module is the only thing that reads it: everything else imports the frozen
 * object from here, so a constant can never be edited in two places.
 *
 * Why a loader instead of `import engine from './engine.json' with { type: 'json' }`:
 * import attributes are a parse-level feature, so a runtime that does not support
 * them fails the whole module rather than one call. Reading the file through
 * `new URL(..., import.meta.url)` works on every Node version this project can be
 * deployed on, and Vercel's file tracer follows that pattern when bundling, so the
 * JSON ships with the function.
 *
 * The exported object is deep-frozen: config is read-only at runtime. Nothing in
 * the request path may mutate a threshold.
 *
 * `risk` block (phase 3, `lib/riskEngine.js`), one line each:
 *   - liquidationBufferPct (0.05): safety cushion, in percentage points, subtracted from
 *     a position's real distance-to-liquidation before a structural invalidation is
 *     accepted as reachable (stopHierarchy). Small on purpose - it is not the venue's
 *     maintenance margin, just a guard against rounding/latency at the boundary.
 *   - maintenanceMarginPct (0.3): conservative flat estimate used only by this module's
 *     own leverage-cap model for a NEW position (maxLeverageForStop). No live per-asset
 *     maintenance-margin tier exists in this repo; an existing position's real
 *     liquidation price is always a given input (Phase 3b), never derived from this.
 *   - maxWalletRiskPct (2): most of margin, in percent, positionPlan will size a new
 *     position to lose at its own stop - a standard 1-2% per-trade risk-of-ruin cap.
 *   - defaultMarginUsd (10): the "~$10, up to 100x" preference. `attachRisk`
 *     (services/scalpContext.js) sizes every position against
 *     min(defaultMarginUsd, account.margin.usd) - a slice of the wallet, never the
 *     whole balance - and publishes that as `risk.collateralUsd`.
 *   - maxLeverage (100): exchange/UI leverage ceiling; the hard cap every plan respects.
 *   - feeBps (5): one-sided taker-fee estimate in basis points; no live fee schedule is
 *     wired up, so this is a round conservative default.
 *   - slippageBps (5): execution-slippage estimate in basis points for a stop-market
 *     fill; same reasoning as feeBps.
 *   - defaultLossBudgetPctOfCollateral (5): fallback risk budget, percent of a position's
 *     own collateral, used by stopHierarchy when the caller supplies no lossBudgetUsd.
 *
 * `flag` block (phase 4, `lib/patternDetector.js`), one line each:
 *   - includeFailed (false, phase 5): whether `candidateSetups[]` publishes `state:
 *     failed` entries. `decisionTrace.candidateSetups` always keeps them regardless -
 *     see `filterFailedCandidateSetups` in services/scalpContext.js.
 *   - timeframes (1m, 3m, 5m): where the detector runs; the plan's scalp timeframes.
 *   - atrPeriod (14): Wilder's standard ATR length, the unit for impulse and chase.
 *   - minImpulseAtr (2.0): an impulse must span at least 2 ATR to be a pole, not noise.
 *   - maxImpulseCandles (20, F1 item 2; was 8): the pole is a burst, but 8 bars was too
 *     short for "a longer pump" (F1 incident, 2026-09-23: with 20, SOL/ETH/BTC 1m longs
 *     showed the real flag the old window missed entirely). 20 bars is ~20 min on 1m,
 *     ~100 min on 5m.
 *   - maxContractionRatio (0.5): flag range at most half the pole - a flag, not a range.
 *   - minCandles (3): fewer than 3 bars is a pause, not a consolidation; 1-2 pullback
 *     bars after a qualifying impulse are a `proto` candidate instead (F1 item 1).
 *   - maxFlagCandles (12): longer than 12 bars on a scalp timeframe is a new range.
 *   - wickToleranceAtr (0.2, phase 7; was wickTolerancePct 0.02): EMA21 band in ATRs of
 *     the prior candle - a touch counts as a hold, a real poke through counts as a wick.
 *     A percent-of-price band and an ATR band only coincide at one volatility, so the
 *     value was chosen on the fixtures: the phase 4 flag fixtures read identically for
 *     0.1-0.6 and the test:scalp synthetic symbols for 0.1-0.25; 0.2 sits inside both.
 *   - acceptanceCloses (2): two consecutive closes through EMA21 = acceptance, one = wick.
 *   - confirmCloses (2): a break is confirmed on its second close past the level.
 *   - maxBreakoutAge (5): a break older than 5 bars is no longer read fresh (`triggering`
 *     unconfirmed becomes `failed`/`stale`); it does not, by itself, drop a flag from
 *     the search window any more (see failedTtlCandles/expiredTtlCandles, F1 items 4-5).
 *   - chaseAtr (1.5): last close more than 1.5 ATR past the breakout = chasing.
 *   - reclaimCandles (2, F1 item 3): a flag whose first candle sits on the wrong side of
 *     EMA21 is still valid if a close within this many candles reclaims it
 *     (`ema21Hold: "reclaim"`); never reclaiming in that window means there was no flag.
 *   - failedTtlCandles (10, F1 item 4): a failed candidate's own timeframe candles after
 *     its failure candle during which it stays in the default `candidateSetups` with
 *     `failReason`/`failedAt` regardless of `includeFailed`. Detection itself is not
 *     capped at this age - "older failures follow includeFailed" - only default
 *     visibility is.
 *   - expiredTtlCandles (10, F1 item 5): candles past maxBreakoutAge a flag that would
 *     have stayed `confirmed` is instead published as `state: "expired"`,
 *     `chaseRisk: true`, before detection stops finding it at all (replaces the old
 *     silent drop at exactly maxBreakoutAge candles, the F1 incident's SOL 14:57 miss).
 *   - confidence.impulseFullAtr (4.0): impulse score saturates at 4 ATR.
 *   - confidence.weights: impulse 0.3, compression 0.25, ema21 0.3, stoch 0.15 (sum 1);
 *     structure first, Stoch RSI slope as a tiebreaker. A `reclaim` hold scores the same
 *     as `wick` (0.5): recovered, not as strong as never having left.
 *   - quality.highConfidence / .medConfidence (75 / 50, F1 item 8): bands `confidence`
 *     into the candidate's `qual.quality` (high/med/low) - the qualification layer's own
 *     evidence-amount read, reusing the detector's existing 0-100 score rather than a
 *     second competing one.
 *
 * `geometry` block (phase 7, `lib/geometry.js`), one line each:
 *   - timeframes (15m, 1h, 4h; phase 8 dropped 5m): where geometryContext is built and
 *     published. All seven measured 85 KB full payload against the 80 KB budget; phase 8
 *     dropped 5m (-3.4 KB) to make room for diagonals/channel/confluence on the other
 *     three (2026-09-22). 1m/3m/5m are covered by the flag detector, 1d by `structure`.
 *   - atrPeriod (14): Wilder's standard length; same unit as the flag detector's ATR.
 *   - pivotLeft / pivotRight (3 / 3): same fractal width as lib/structure.js findSwings,
 *     so per-timeframe pivots and the symbol-level 1h swings agree on what a swing is.
 *   - zoneToleranceAtr (0.5): pivots within half an ATR of each other are one zone -
 *     tight enough that a zone is a level, loose enough to absorb wick noise.
 *   - minTouches (2): one touch is a swing, two make a zone; nothing is published
 *     without that evidence.
 *   - maxZonesPerSide (3): nearest three support and three resistance zones, the same
 *     cap the symbol-level support/resistance lists use; keeps the payload bounded.
 *   - slopeCandles (5): EMA slope is measured over the last five closes - recent enough
 *     for a scalp read, long enough that one candle does not flip the sign.
 *   - extensionAtr.elevated / .high (1.5 / 3.0): price 1.5 ATR from EMA21 is stretched
 *     (1.5 matches flag.chaseAtr), 3 ATR is a chase.
 *
 * Geometry B (phase 8, same block). Precision over recall - a false line is worse than a
 * missed one - so every gate below errs toward `detected: false`:
 *   - diagonalMinTouches (3): two points define any line; a third touch is the first
 *     evidence. Separate from minTouches (2, zones) so phase 7 zones are unchanged.
 *   - maxDiagonalCandidates (10): lines are fit through pairs of the newest 10 pivots a
 *     side (45 pairs) - recent structure, bounded compute.
 *   - diagonalMinSpanCandles (20): touches must span 20 candles; three pivots bunched
 *     together are a wiggle, not a trendline.
 *   - diagonalMinBounceAtr (3.0): between touches price must close 3 ATR away from the
 *     line. Chosen on fixtures + live data: 0/60 lines on iid-noise fixtures (2.0 let 8
 *     through), and 2 of 18 live BTC/SOL/ETH 15m/1h/4h lines survived vs 18/18 with no
 *     bounce rule, many of those 15-20% from price.
 *   - diagonalFullTouches (5): confidence's touch score saturates at five touches.
 *   - maxSlopeDivergence (0.02): support and resistance slopes may differ by 2% of the
 *     channel width per candle (50 candles to change width by one width); steeper
 *     convergence is a triangle or wedge, not a channel.
 *   - channelFlatSlope (0.005): a channel whose mean slope moves under 0.5% of its width
 *     per candle is flat (200 candles to climb one width).
 *   - confluenceTolAtr (0.25): levels within a quarter ATR agree - half the zone
 *     tolerance, since confluence claims more than a single zone does.
 *   - maxConfluenceZones (2): the two best zones per timeframe; payload budget.
 *
 * `lifecycle` block (phase 9, `lib/patternLifecycle.js`), one line each:
 *   - snapTolAtr (1.0): a zone edge, diagonal or confluence edge within one ATR of the
 *     candidate's own timeframe is the same level as the flag edge - one bar's typical
 *     range, so a snap never moves a scalp stop or entry by more than a bar.
 *   - visualConfidenceFloor (60): a triggering/confirmed candidate under 60 has at most
 *     a middling impulse/compression/EMA21 read; worth a look before acting on it.
 *   - geometryConfidenceFloor (60): geometry confidence moves in steps of 20 (five
 *     evidence items); under 60 means at most two of zones, structure and slopes were
 *     measurable, so the levels behind the candidate are thin.
 *   - coilBreakAtr (0.5): price within half an ATR of a coil edge is one bar from
 *     choosing a side - the moment a chart is most useful.
 *   - coilOverlapPct (50): a bull and a bear flag sharing at least half of the narrower
 *     range are one consolidation read two ways, not two setups.
 *   - nearMissGate (false, phase 9b): a diagonal one touch short does not raise the gate on
 *     its own. The phase 10 replay (2026-09-22, 1,434 closes) had the gate on 54% of closes,
 *     ~65% of it from near-miss codes alone; a two-touch line is too common to be a reason
 *     to ask for a chart. Near-miss codes still ride along when another code raised it.
 *
 * `bias` block (phase 9b, `lib/biasMatrix.js`), one line each:
 *   - neutralBelow (20): under 20% net weighted agreement of a timeframe's signals, its
 *     lean is mixed and reads neutral.
 *   - channelEdgePct (20): the outer fifth of a detected channel counts as "at the edge"
 *     (bottom leans long, top leans short).
 *   - basisWeights: trend 2 (the engine's own trend label already combines price and EMA),
 *     structure 1.5 (pivots are the slowest-changing evidence), EMA stack / price vs EMA21 /
 *     EMA slopes / channel edge 1 each, Stoch 0.5 (fastest and noisiest).
 *   - contextTimeframes: the timeframes that judge "with or against the trend" for an idea
 *     executed on each timeframe - one to three steps up, never the execution timeframe.
 *   - contextWeights: slower context counts more (15m 1, 1h 2, 4h and 1d 3).
 *   - horizons: scalp reads 1m-1h with 15m doubled (the scalp context timeframe); swing
 *     reads 1h-1d with 4h and 1d doubled.
 *   - strategyTimeframes: each strategy's execution timeframe for alignment (SWING 1d,
 *     TREND_4H / TREND_RIDER 4h, SCALP_1H 1h, MICRO_SCALP 15m).
 *   - minRoomAtr (1.0): less than one ATR of the zone's timeframe to the nearest
 *     higher-timeframe zone ahead is inside one bar's range: roomTooSmall.
 *   - counterTrendPenalty (0.5): on the scalp horizon, a timeframe leaning against the
 *     swing horizon keeps half its strength; the other half moves to neutral.
 *
 * `replay` block (phase 10, `scripts/replay.js` only; never read on the request path):
 *   - minComputeCandles (200): the replay starts at the first close where every replayed
 *     timeframe (3m included, derived from 1m) has at least 200 closed candles - enough
 *     for EMA200 to exist, so early closes do not score a half-warmed pipeline.
 *   - outcomes.fillWindowCandles (15, trading-model quick pass Q4): a signal's entry zone
 *     must be touched within 15 1m candles of the close that produced it, or it reads
 *     "not filled". outcomes.maxHoldCandles (2880, ~2 days): a filled trade that touches
 *     neither stop nor TP1 by then reads "open" and is excluded from win/loss.
 *
 * `freshness` block (signal-reliability minimum plan work package 1, `lib/freshness.js`):
 *   - graceMs (5000): fixed provider grace period added on top of one full interval
 *     before a timeframe's `closedThrough` reads stale. Covers ordinary fetch/build
 *     lag, not a second candle's worth of staleness.
 *
 * `flagPlan` block (signal-reliability minimum plan work package 2, `lib/flagTradePlan.js`):
 *   - minNetRR (3.0): the flag trade plan's own net-of-fees R:R floor to TP1, required
 *     for `ready`/`conditional` (mirrors `riskReward.bySetupType.Scalp[0]`, kept as its
 *     own constant since the flag plan computes net R:R independently, after fees/
 *     slippage, not the legacy strategies' gross figure).
 *   - entryToleranceAtr (0.1): after a closed candle has closed through the entry level,
 *     the latest closed candle's low (high for a short) must reach within this many ATR
 *     of it and close on the hold side for `ready` (else `conditional`). Tight on
 *     purpose - the plan is a specific retest level, not a zone. `minNetRR` here is the
 *     only R:R floor; lib/flagRecommendation.js reads it too (no `model.minNetRR`).
 *
 * `mark.pyth` block (P1 Pyth mark, `lib/pythMark.js`, config 2026.09.23-5):
 *   - feedIds (BTC/ETH/SOL): Hermes price feed ids for Crypto.<SYM>/USD, resolved once
 *     and stored as constants so the request path never looks them up.
 *   - maxAgeSec (30): a mark older than this reads `status: "stale"`. Jupiter perps
 *     mark on the Pyth oracle, which publishes every few seconds; 30 s is a dead feed.
 *   - timeoutMs (4000): one Hermes request per build; a slower answer is `unavailable`.
 *
 * `model` block (trading-model quick pass Q3 + 21/200 decision clarity):
 *   - topDownWeights (1w 4, 1d 3, 4h 2, 1h 1): weighted vote over the four leans that
 *     decides `topDown.sentiment`; higher timeframes dominate (M-6b).
 *   - above200Weights (1m .1 … 1d 3): per-timeframe weight for `above200.weighted`,
 *     discounting lower timeframes the same way topDownWeights does.
 *   - weeklyMinWeeksForEma21 (21): fewer weekly candles than this and the weekly lean
 *     reads neutral with a reason instead of computing an EMA21 on thin data.
 *   - weeklySlopeLookbackWeeks (3): the weekly EMA21 slope compares the current value to
 *     this many weeks back.
 *   - policyVersion / flagTimeframes / maPullDistancePct / channelEdgePct /
 *     divergenceLookbackPivots / divergenceMaxAgeCandles / decisionWeights: decision
 *     record knobs for `lib/modelEvidence.js` and `lib/flagRecommendation.js`; they
 *     change explanation quality, never legacy strategy validity.
 */

import { readFileSync } from 'node:fs';

/**
 * Recursively freeze an object and everything it holds.
 * @param {*} value
 * @returns {*} the same value, frozen
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

const raw = JSON.parse(readFileSync(new URL('./engine.json', import.meta.url), 'utf8'));

/** @type {Object} frozen engine configuration */
export const ENGINE_CONFIG = deepFreeze(raw);

/** @type {string} version stamped into every payload for reproducibility */
export const CONFIG_VERSION = ENGINE_CONFIG.configVersion;

/**
 * R:R multiples for a setup type, as used by calculateSLTP's callers.
 * @param {string} setupType - 'Swing', 'Scalp', or anything else (TREND_4H/4h)
 * @returns {Array<number>}
 */
export function rrForSetupType(setupType) {
  const table = ENGINE_CONFIG.riskReward.bySetupType;
  return table[setupType] || table.default;
}

/**
 * R:R multiples for a named strategy.
 * @param {string} strategyName - SCALP_1H, TREND_RIDER, MICRO_SCALP
 * @returns {Array<number>}
 */
export function rrForStrategy(strategyName) {
  return ENGINE_CONFIG.riskReward.byStrategy[strategyName] || ENGINE_CONFIG.riskReward.default;
}

export default ENGINE_CONFIG;
