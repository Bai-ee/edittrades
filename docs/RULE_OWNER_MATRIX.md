# EditTrades Rule-to-Owner Matrix — Phase 0

Date: 2026-09-22
Branch: `upgrade-signal-engine` (commit `2a25f3a`)
Plan: `docs/MASTER_PLAN_ENGINE_REFINEMENT.md`
Rules source: `~/Downloads/EditTrades_Master_Orchestration_Handoff_v1.md` §1–§22
Code baseline: this repo, read on the date above. No code was changed in this phase.

## Owner legend

| Owner | Meaning |
| --- | --- |
| API | Deterministic computation in this repo, published in the payload |
| GPT | Interpretation, synthesis, uncertainty language, output format |
| CONFIG | Tunable value; belongs in `config/engine.json` (Phase 1) |
| VISUAL | Screenshot fallback path |
| TEST | Fixture, regression test, or replay harness |

Handoff rules owned by "orchestration/logging" map to **API** when the artefact is a payload field
(`decisionTrace`, `needsVisualConfirmation`) and to **TEST** when the artefact is a repo fixture
(miss log, replay).

Status values: **yes** (in the payload or enforced today), **partial** (computed but not published,
or published at coarser granularity than the rule asks), **no** (absent).

---

## Measurements

All numbers measured 2026-09-22 against live Kraken data, `buildScalpContext()` with defaults
(3 symbols × 7 timeframes).

### Candle depth: fetch vs publish

| TF | Closed candles fetched (compute window) | Published `candles[]` | Publish limit |
| --- | --- | --- | --- |
| 1m | 499 | 30 | `CANDLE_LIMITS` (`services/scalpContext.js:19`) |
| 3m | 239 | 30 | derived from 1m inside `marketData`; Kraken 720-row cap ÷ 3 |
| 5m | 499 | 30 | |
| 15m | 499 | 24 | |
| 1h | 499 | 24 | |
| 4h | 499 | 20 | |
| 1d | 499 | 10 | |

`FETCH_LIMIT = 500` (`services/scalpContext.js:48`). Indicators and the strategy engine run on the
full closed array, not on the trimmed publish slice (`services/scalpContext.js` → `calculateAllIndicators(closed)`).

### Function duration

| Measurement | Value |
| --- | --- |
| Local `buildScalpContext()` incl. wallet RPC | 749 ms |
| Prod `GET /api/scalp-context` wall clock, cold | 1.70 s |
| Prod, warm | 0.70 s |
| Vercel limit | 10 s (Hobby default; no `maxDuration` override in `vercel.json`) |

`Cache-Control: no-store` (`api/scalp-context.js:36`) — every call is a real build.

### Payload bytes

| Slice | Bytes |
| --- | --- |
| Whole payload (prod) | 61,007 |
| Whole payload (local) | 60,957 |
| BTC symbol | 19,939 |
| SOL symbol | 19,552 |
| ETH symbol | 20,253 |
| `account` | 998 |
| BTC `timeframes` (7 blocks) | ~17,500 (88% of the symbol) |
| BTC `timeframes['1m']` | 3,000 |
| BTC `strategies` (5 strategies) | 1,687 |
| BTC `structure` | 644 |

Budget headroom to the 80 KB warn line in Phase 5: ~19 KB, i.e. ~6.3 KB per symbol for
`decisionTrace` + `candidateSetups` + `geometryContext` combined unless `compact` lands first.

---

## Matrix

### §1 Non-negotiable data contract

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Load fresh context before SIGNAL/SCAN/CHECK/POSITION/SCALP | GPT | yes | endpoint is uncached | — |
| Latest closed candles only | API | yes | `dropUnclosedCandles` `services/scalpContext.js:118` | — |
| Expose `generatedAt`, `closedThrough`, `dataStatus`, `warnings`, `account.status` | API | yes | payload top level | — |
| Never reuse stale prices/indicators/wallet from conversation | GPT | n/a | — | — |
| `dataStatus=unavailable` ⇒ no signal | GPT (API supplies) | yes | `dataStatus` set at `scalpContext.js` end of build | — |
| `dataStatus=partial` ⇒ name what is missing, reduce confidence | GPT (API supplies) | yes | `warnings[]` carries per-symbol/TF reasons | — |
| `account.status` unavailable/partial/disabled ≠ $0 | API + GPT | yes | `emptySnapshot` `services/walletTracker.js:111` (all nulls) | — |
| Never claim execution unless confirmed | GPT | yes (structurally) | no execution import in MCP path | — |
| Scan BTC, ETH, SOL before surfacing the strongest setup | API | yes | `SYMBOLS` `services/scalpContext.js:16` | — |

### §2 Timeframe model

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| 1m/3m/5m/15m/1h/4h/1d all available | API | yes | `TIMEFRAMES` `scalpContext.js:17` | — |
| Per-timeframe features computed | API | yes | `tfEntries[tf]` | — |
| HTF context, LTF timing composition | GPT | n/a | — | — |
| Pattern/flag search across timeframes, 1m prioritised with 3m/5m support | API | no | no detector exists | 4 |

### §3 Momentum continuation flag

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Sequence impulse → flag → EMA21 hold/reclaim → higher low → flag-high break → close/retest | API | no | — | 4 |
| Prefer flag above or riding a **rising** EMA21 | API | partial | `ema21` published; EMA **slope** not published (`ema21History` computed, dropped) | 7 (see Gaps) |
| Wick below EMA21 does not invalidate | API | no | — | 4 (`ema21Hold: wick`) |
| Acceptance below EMA21 ≠ wick | API | no | — | 4 (`acceptance_below`) |
| Prefer EMA21 > EMA200 for bullish alignment | API | yes | `ema21`, `ema200`, `priceVs21Pct`, `priceVs200Pct` per TF | — |
| EMA200 is context, not a trigger | GPT | n/a | — | — |
| Stoch RSI resets in flag, reaccelerates on continuation | API | partial | `stochRsi.k/d/state/cross/slopeK/slopeD` per TF; no acceleration term | 4 consumes; accel in Gaps |
| Overbought alone ≠ short, oversold alone ≠ long | GPT | n/a | — | — |
| Do not chase an extended breakout | API + GPT | no | — | 4 (`chaseRisk`), 7 (`extensionRisk`) |
| Engine NO_TRADE does not mean no flag exists | API | no | `strategies.*` is the only channel today | 4 |
| Pattern lifecycle NONE→FORMING→TRIGGERING→CONFIRMED→FAILED | API | no | — | 4 (per-TF), 9 (unified) |

### §4 Required market features

| Feature | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Raw closed OHLCV | API | yes | `candles[]` per TF (trimmed) | — |
| EMA21, EMA200 | API | yes | per TF | — |
| EMA slopes | API | no | history computed in `services/indicators.js:261` block, not published | 7 (see Gaps) |
| Price distance from each EMA | API | yes | `priceVs21Pct`, `priceVs200Pct` | — |
| Stoch RSI K/D | API | yes | `deriveStochRsi` `scalpContext.js:~160` | — |
| Stoch RSI cross state | API | yes | `stochRsi.cross` | — |
| Stoch RSI slopes | API | yes | `slopeK`, `slopeD` | — |
| Stoch RSI acceleration/deceleration | API | no | — | Gaps |
| Trend | API | yes | `trend` per TF from `indicators.analysis.trend` | — |
| Swing highs/lows | API | partial | symbol-level only, from **1h** candles, fractal lookback 3, last 5 each (`lib/structure.js:120,166`) | 7 (per-TF pivots) |
| Higher-low / lower-high structure flags | API | no | — | 7 |
| Session high/low | API | yes | `structure.sessionHigh/Low`, UTC day from 1h (15m fallback) | — |
| Previous-day high/low | API | yes | `structure.prevDayHigh/Low` from 1d | — |
| Horizontal S/R **zones** | API | partial | single prices, max 3 each, nearest-first (`lib/structure.js:109`), not clustered zones | 7 |
| ATR / recent volatility | API | no | `calculateATR` exists (`lib/advancedIndicators.js:98`) but is **not** on the scalp path | 7 |
| Strategy outputs and engine confidence | API | yes | `strategies.*`, `bestSignal` | — |
| Room / distance to next S/R | API | no | derivable from `support`/`resistance` but not published | 7 |
| Extension / chase risk | API | no | `priceVs21Pct` is the only proxy | 7 |

### §5 Geometry context

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| `geometryContext` object per timeframe | API | no | — | 7, 8 |
| Pivots from closed candles | API | partial | 1h only, symbol-level | 7 |
| Diagonal support/resistance fit with touches + fit error | API | no | — | 8 |
| Multiple touches within ATR-normalised tolerance | API + CONFIG | no | — | 8 |
| Never expose a trendline without evidence (`minTouches`) | API + CONFIG | no | — | 8 |
| Cluster swing prices into horizontal zones | API | no | exact prices only today | 7 |
| Confluence scoring (diagonal + horizontal + EMA + swing + session/prev-day) | API | no | — | 8 |
| Impulse → compression detection for flags | API | no | — | 4 |
| Maintain pattern state over time | API | no | stateless serverless; plan derives state per request | 9 (KV store explicitly out of scope) |

### §6 Visual uncertainty gate

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Ask "could missing geometry change the call?" | GPT | n/a | — | 11 |
| Provisional numeric read + named blind spot when geometry weak | GPT | n/a | — | 11 |
| Request screenshot for the specific asset/timeframe | VISUAL | n/a | — | 11 |
| Screenshot refines, never auto-flips WAIT → GO IN | GPT | n/a | — | 11 |
| API exposes `needsVisualConfirmation` | API | no | — | 9 |
| API exposes `unresolvedGeometry[]` | API | no | — | 9 |

### §7 Screenshot-to-engine feedback loop

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Log pre-image read, missing feature, post-image read, miss class, proposed feature, status | TEST | no | — | 10 (`test/fixtures/misses/`) |
| Miss-class taxonomy (MISSED_FLAG … OTHER) | TEST | no | — | 10 |
| Each logged miss becomes a regression test | TEST | no | — | 10 |

Miss log is repo fixtures, never a write API (plan, Out of scope).

### §8 Engine output is input, not decision

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| `bestSignal` is an input | GPT | yes | `bestSignal` is a strategy **name** string (`services/strategy.js:4617`) | — |
| Strategy confidence = setup strength, not win probability | GPT | yes | `strategies.*.confidence` | 11 (wording) |
| GPT independently evaluates raw candles/geometry | GPT | n/a | — | — |
| `valid:false` / NO_TRADE must not erase a detected flag | API | no | only channel today is `strategies.*` | 4 |
| Surface and log engine-vs-raw disagreement | API | no | — | 2 (`decisionTrace`), 4 |
| Preserve independent feature channels | API | partial | timeframes and structure are independent; pattern channel missing | 4 |

### §9 Confidence model

| Field | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| `engineConfidence` | API | yes | `strategies.*.confidence` (named `confidence`) | — |
| `dataQualityConfidence` | API | partial | `dataStatus` + `warnings[]`, not a scored field | — (treat `dataStatus` as the field) |
| `geometryConfidence` | API | no | — | 7 (`geometryContext.confidence`) |
| `accountRiskAcceptability` | API | no | — | 3 (`risk.*` + `capReason`) |
| `setupQuality` | API | no | — | 4 (`candidateSetups[].confidence`) |
| `executionReadiness` | API | no | — | 4 (lifecycle `state`) + 9 |
| `directionalBias` | GPT | no | — | 11 |
| `decisionAllocation` GO_IN / HOLD_WAIT / DONT_DO_IT summing to 100 | GPT | no | — | 11 (see Gaps) |
| Never describe allocation as win probability | GPT | n/a | — | 11 |

### §10 Account and risk

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Wallet balance / holdings | API | yes | `account.holdings`, `holdingsUsd`, `unpriced` | — |
| `account.margin.usd` is risk capital | API + GPT | yes | `account.margin.usd` | — |
| Volatile holdings are exposure, not risk capital | GPT | yes (data present) | `holdings` vs `margin` already separate | — |
| Gas sufficiency | API | yes | `account.gas` (`MIN_GAS_SOL = 0.02`, `walletTracker.js:59`) | — |
| Baseline / net PnL / return | API | partial | `account.performance` from `ACCOUNT_BASELINE_USD` (`walletTracker.js:262`), not tracked trades | — |
| Available collateral, used/available margin | API | no | wallet tracker is balances only | Out of scope |
| Open positions, direction, size, leverage, avg entry, liquidation price | API | no | — | Out of scope |
| Unrealized/realized/daily/total PnL, completed trades, win rate | API | no | — | Out of scope |
| Dollar loss at structural invalidation is the controlling quantity | API | no | — | 3 (`lossAtStopUsd`) |
| Position size and leverage determined together | API | no | no `leverage` anywhere in `strategy.js`/`scalpContext.js`/`walletTracker.js` | 3 |
| Structural stop first, leverage second | API | partial | stop logic exists (`services/strategy.js:1072–1131`); leverage side absent | 3 |
| Never tighten a stop to justify 100x | API | yes (guard) | `MAX_SCALP_STOP_DISTANCE_PCT = 3.0` `services/strategy.js:962`; rejection → canonical NO_TRADE | 1 (value → config), 3 |
| Lower leverage on volatility/exposure/weak confirmation | API + CONFIG | no | — | 3 |
| Avoid liquidation near invalidation | API + CONFIG | no | — | 3 (`liquidationBufferPct`) |
| Never invent wallet metrics | API | yes | nulls only, `finiteOrNull` / `emptySnapshot` | — |
| Existing position ⇒ HOLD/REDUCE/EXIT/ADD analysis | GPT | no (no position data) | — | Out of scope |
| ~$10 margin, up-to-100x preference is a preference, not a mandate | CONFIG | no | — | 3 (`defaultMarginUsd: 10`, `maxLeverage: 100`) |

### §11–§14 Discipline, no-trade output, trade contract, "s" orchestration

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Do not manufacture a trade / do not chase | GPT | n/a | — | — |
| Prefer confirmation (hold, reclaim, breakout+retest, momentum) | API + GPT | partial | `entryType`, `stopSource` published per strategy | 4 |
| No confirmation ⇒ WAIT; invalidated ⇒ PASS | GPT | n/a | — | — |
| Actionable checklist (direction, entry, confirmation, invalidation, stop, targets, RR, wallet risk, fresh data, no critical warnings) | API validates objective parts | partial | `entryZone`, `stopLoss`, `invalidationLevel`, `targets`, `riskReward` all published per strategy | 3 (wallet risk) |
| NO TRADE — reason \| LOOKING FOR \| CHECK BACK format | GPT | n/a | — | 11 |
| Include lifecycle state when a candidate exists | API supplies | no | — | 4, 9 |
| Full trade output contract (THESIS/CALL/TRADE/ACCOUNT/POSITION/PERFORMANCE/DATA) | GPT | n/a | all DATA fields exist in payload | 11 |
| Never count an alert as a trade; never infer win rate | GPT | yes (no trade log exists to misread) | — | Out of scope |
| "s" 16-step orchestration | GPT | n/a | steps 6, 10, 15 depend on API features | 4, 7–9, 11 |

### §17 Recommended module architecture

| Handoff module | Today | Where |
| --- | --- | --- |
| market_data_adapter | yes | `services/marketData.js`, `services/binance.js` |
| data_quality_validator | partial | inline in `buildScalpContext` (`dropUnclosedCandles`, warnings, `dataStatus`); `lib/dataValidation.js` exists but is off the scalp path |
| indicator_engine | yes | `services/indicators.js` |
| swing_structure_engine | partial | `lib/structure.js` (1h only) |
| geometry_engine | no | Phase 7–8 `lib/geometry.js` |
| pattern_state_engine | no | Phase 4/9 `lib/patternDetector.js` |
| strategy_engine | yes | `services/strategy.js` |
| account_adapter | partial | `services/walletTracker.js` (balances only) |
| risk_engine | no | Phase 3 `lib/riskEngine.js` |
| recommendation_feature_aggregator | yes | `services/scalpContext.js` |
| decision_orchestrator | GPT-side | GPT instructions |
| response_formatter | GPT-side | GPT instructions |
| refinement_logger | no | Phase 10 fixtures |
| regression_test_suite | partial | 4 root suites (`test-strategy-sltp.js`, `test-scalp-context.js`, `test-edittrades-mcp.js`, `test-wallet-tracker.js`); no fixture dir |

### §18–§20 Config, observability, testing

| Rule | Owner | Today | Where | Phase |
| --- | --- | --- | --- | --- |
| Tunables in versioned config, not prose | CONFIG | no | no `config/` directory exists | 1 |
| `configVersion` in every recommendation | API | no | — | 1 |
| Machine-readable `decisionTrace` | API | no | reasons exist only in `console.log` + `strategies.*.reason` | 2 |
| Log API/schema/config versions | API | partial | `schemaVersion: '1.1.0'` published; no configVersion | 1 |
| Log exact candle IDs/ranges used | API | partial | `closedThrough` + `candleCount` per TF; window start not published | 2 (see Gaps) |
| Log rejected candidates and why | API | no | — | 2, 4 |
| Log whether a screenshot was requested / pre-post diff | TEST | no | — | 10 |
| Unit tests: EMA, pivots, trendline fit, zone clustering, compression, state, stoch, stop/risk/leverage | TEST | partial | stop/SL-TP covered by `test:sltp`; the rest absent | 3, 4, 7, 8, 9 |
| Regression: BTC 1m missed flag (REGRESSION_001) | TEST | no | — | 4 |
| Regression: BTC 4h confluence (REGRESSION_002) | TEST | no | — | 7 (partial), 8 (full) |
| Regression: wick vs acceptance below EMA21 | TEST | no | — | 4 |
| Regression: valid flag survives NO_TRADE | TEST | no | — | 4 |
| Regression: extended breakout flagged as chase | TEST | no | — | 4 |
| Regression: unavailable account never zero | TEST | yes | `test:wallet` | — |
| Replay over historical closes, no lookahead | TEST | no | `backtests/btc-4h-backtest.js` exists but is not the feature pipeline | 10 |
| Measure detection precision/recall separately from PnL | TEST | no | — | 10 |
| Track how often visual review changes the call | TEST | no | — | 10 |

---

## Corrections to the plan's architecture table

1. **`lib/levels.js` and `lib/advancedIndicators.js` are not on the scalp-context path.** They are
   imported only by `api/indicators.js`, `api/analyze.js`, `api/analyze-full.js`. The plan's
   "Structure" row should read `lib/structure.js` + `lib/candleFeatures.js` (the latter reached
   indirectly via `services/indicators.js:9`). Consequence: ATR exists in the repo
   (`lib/advancedIndicators.js:98`) but is unreachable from `buildScalpContext()`, so Phase 7 should
   either import it or reimplement it in `lib/geometry.js` — decide once, do not end with two ATRs.
2. **Phase 6's premise is already met.** `FETCH_LIMIT = 500` and 499 closed candles per timeframe
   already reach the indicator and strategy layer. Phase 6 reduces to: a test asserting the compute
   window ≥ 200, an explicit note that 3m carries 239 (Kraken's 720-row cap ÷ 3), and duration
   logging. No fetch change is needed. Recommend re-titling Phase 6 "assert compute depth" and
   moving it ahead of Phase 7 as a 15-minute task.
3. **`structure` is symbol-level and 1h-derived, not per timeframe.** Swings come from 1h candles
   with fractal lookback 3, capped at the last 5 per side; `support`/`resistance` are capped at 3
   prices each, strictly below/above price. Phase 7 adds per-timeframe pivots; it must not silently
   change the existing symbol-level `structure` block (additive rule).
4. **Two different "swing" notions are live.** `lib/structure.js findSwings` (fractal, lookback 3,
   feeds the payload) and `services/indicators.js detectSwingPoints(closed, 20)` (rolling max/min
   over the last 20 candles, feeds the strategy engine via `mtfForStrategy[tf].structure`). They are
   not interchangeable; Phase 7 should name its own (`swingPivots`) and leave both in place.
5. **Payload is 88% candles.** 7 timeframe blocks ≈ 17.5 KB of a 19.9 KB symbol. Any geometry
   addition is cheap next to a `compact` mode; this supports keeping Phase 5 before Phase 7.

> Amendment 2026-09-22: items 1–5 are now in `docs/MASTER_PLAN_ENGINE_REFINEMENT.md` — Structure and Indicators rows corrected, Phase 6 retitled "Assert compute depth" and reordered before Phase 5, the single-ATR decision written into Phase 7, the swing-naming guard added to Phase 7, and dead modules named in governing rule 7.

## Duplicate or conflicting logic (handoff task C)

- Two indicator stacks: `services/indicators.js` (scalp path) vs `lib/advancedIndicators.js`
  (analyze endpoints). ATR, VWAP, Bollinger live only in the second.
- Two chart-analysis libraries, both off the scalp path: `lib/chartAnalysis.js`,
  `lib/advancedChartAnalysis.js`. Plus `lib/signalEngine.js` and `services/strategy-refactored.js`,
  neither reachable from `buildScalpContext()`. None should be revived by a geometry phase without
  an explicit decision.
- Two swing detectors (item 4 above).
- `lib/dataValidation.js` duplicates checks that `buildScalpContext` performs inline.
- 3m is the only derived timeframe and the only one with a shallower compute window (239 vs 499).
  EMA200 on 3m is valid but has the thinnest warm-up; note it wherever 3m feeds a detector (Phase 4).

## Gaps in the plan (no phase currently owns these)

| Item | Handoff ref | Recommendation | Status |
| --- | --- | --- | --- |
| EMA21/EMA200 **slope** per timeframe | §3, §4 | Add to Phase 7 `lib/geometry.js` output (cheap: histories already computed, currently dropped) | Adopted — Phase 7 `emaSlope` |
| Stoch RSI acceleration / deceleration | §3, §4 | Add to Phase 7, alongside slopes; one extra derivative from existing history | Adopted — Phase 7 `stochAcceleration` |
| `decisionTrace` candle **window bounds** (first/last timestamp per TF actually used) | §19 | Add to Phase 2 trace shape; `closedThrough` + `candleCount` alone do not pin the window | Adopted — Phase 2 `trace.window` |
| `decisionAllocation` (GO_IN / HOLD_WAIT / DONT_DO_IT) and `directionalBias` | §9, §13 | Leave GPT-owned; confirm in Phase 11 that they are computed from named API components, not re-derived prose | Unchanged — GPT, Phase 11 |
| `dataQualityConfidence` as a named field | §9 | Decide in Phase 2: either treat `dataStatus` as the field or add a scored one; do not leave both | Decided — `dataStatus` is the field, Phase 2 |

## Decisions recorded (so no cell reads "unknown")

- Account extras (positions, PnL, trade history, liquidation, win rate) are **out of scope** for this
  workstream per the plan; their matrix rows are marked "Out of scope", not "no phase".
- Cross-request pattern state (KV) stays out; lifecycle is derived per request (Phase 9).
- The miss log is repo fixtures under `test/fixtures/misses/`, never a write endpoint.
- Screenshot handling stays GPT/VISUAL; the API contribution is `needsVisualConfirmation` and
  `unresolvedGeometry` only.

## Config seed for Phase 1 (engine constants only)

Values as they stand today. Phase 1 moves these without changing a single one.

| Constant | Value | Where |
| --- | --- | --- |
| `maxScalpStopDistancePct` | 3.0 | `services/strategy.js:962` |
| `aggressiveEntryBuffer` | 0.0003 | `services/strategy.js:805` |
| `stochOverbought` / `stochOversold` | 80 / 20 | `services/scalpContext.js:173-174` |
| `rsiOverbought` / `rsiOversold` | 70 / 30 | `services/indicators.js:283` |
| `swingFractalLookback` | 3 | `lib/structure.js:120` |
| `swingsKeptPerSide` | 5 | `lib/structure.js:166` |
| `srLevelsKept` | 3 | `lib/structure.js:109` |
| `strategySwingLookback` | 20 | `services/indicators.js:307` |

Deliberately **not** config — these are transport, payload-shaping, or infrastructure values, and
moving them into `config/engine.json` would invite tuning the wrong dial:

| Constant | Value | Where | Why it stays in code |
| --- | --- | --- | --- |
| `CANDLE_LIMITS` | 30/30/30/24/24/20/10 | `services/scalpContext.js:19` | Payload shape; Phase 5 owns it |
| `FETCH_LIMIT` | 500 | `services/scalpContext.js:48` | Transport depth; Phase 6 asserts it |
| `MAX_CONCURRENCY` | 6 | `services/scalpContext.js:49` | Provider politeness |
| `MIN_GAS_SOL` | 0.02 | `services/walletTracker.js:59` | Wallet module; not a signal rule |
| `RPC_TIMEOUT_MS` | 5000 | `services/walletTracker.js:62` | Infrastructure |

Phase 3 adds new engine constants that have no current home: `liquidationBufferPct`,
`maintenanceMarginPct`, `maxWalletRiskPct`, `defaultMarginUsd: 10`, `maxLeverage: 100`.

---

## Phase 0 acceptance

- One row per handoff rule, §1–§20, with owner, status, location, and delivering phase. ✅
- Candle count at fetch vs publish recorded. ✅
- Function duration recorded (local, prod cold, prod warm, platform limit). ✅
- Payload bytes per symbol recorded, with the dominant slice identified. ✅
- No cell reads "unknown"; five items with no phase owner are listed explicitly under **Gaps**. ✅
