# Changelog

## 2026-09-24 — Fix: Blob appends after a day's first write (served calls, journal)

`get()` returns a weak ETag (`W/"..."`) and `put({ifMatch})` only matches the strong form, so every append after a day's first write failed "Precondition failed: ETag mismatch" and was swallowed. Served calls recorded only 3 rows on 2026-09-24 (the first write); journal appends could 503. `lib/blobJsonl.js` `readBlob` now strips the `W/` prefix (`strongEtag`). Regression test in `test-served.js` (20).

## 2026-09-24 — T4 P0 flag paths (branch `upgrade-signal-engine`)

`docs/PLAN_FLAG_PATHS.md`. Measurement only: no engine, payload, schema, config or threshold change; MCP untouched.

- **Labeller:** `scripts/tracker/flag-paths.js` (pure) labels a flag from its tightening point: retest_go / runner / false_break / fail_first / chop, plus bucketed features and base rates. A retest only counts after the breakout candle closes.
- **Replay:** `scripts/replay-paths.js` (`npm run replay:paths`) runs the production pipeline per close, no lookahead. `scripts/replay.js --backfill-1m` is now resumable (checkpoint, rate-limit backoff) and derives 5m/15m depth from backfilled 1m (`--derive-deep`, automatic with backfill).
- **Results:** `docs/FLAG_PATHS_BASE_RATES.md`, 10,997 flags over 15 days: 47.9% fail before breakout; among breakouts, runner (30%) about as common as retest_go (32%); the SOL 2026-09-24 case is labelled runner.
- **Tracker:** `paths.js` step, `data/paths.jsonl`, `#flag-paths-section`; additive candidate fields; scoring untouched.
- `lib/flagTradePlan.js`: `observeRetestHold` exported (no logic change) for a parity test.
- **Tests:** new `test:paths` 22, `test:replay-paths` 19; `test:replay` 36 → 41; `test:tracker` 43 → 52.

## 2026-09-24 — T3 served calls (branch `upgrade-signal-engine`)

`docs/PLAN_SERVED_CALLS.md`. No payload, schema, config or engine change; MCP untouched.

- **Engine:** `GET /api/scalp-context` records the unfiltered payload's calls (one row per symbol with a `flagRecommendation`) to Vercel Blob `served/YYYY-MM-DD.jsonl` + `served/manifest.json` before sending a JSON 200. Awaited with a 1500 ms cap; errors logged without secrets and swallowed; response unchanged. Not on 401/405/500/503 or `?chart`. Kill switch `TRACK_SERVED_CALLS=false`; off without `BLOB_READ_WRITE_TOKEN`. New `lib/servedCalls.js`.
- **Refactors (behaviour-identical):** journal Blob helpers moved to `lib/blobJsonl.js`; tracker row builder and sensitive-key strip moved to `scripts/tracker/records.js` (`collect.js` re-exports).
- **Tracker:** `pullServed` adds served rows to `data/calls/` as `source: 'served'` (cron duplicates dropped); `dims.source`; served rows scored like cron, excluded from run/capture-health counts; page `#activity-served-row`, call-log Via column, `Via` equity filter.
- **Tests:** new `test:served` (18); `test:tracker` 31 → 42; `test:journal` 17.
- **Follow-up:** the tracker's own cron GET sends `X-EditTrades-Client: tracker` and is not recorded as a served call (it was adding a Blob write per run and could label a routine capture "chat"). `test:served` 18 → 19.

## 2026-09-22 — Scalp context engine (branch `upgrade-signal-engine`)

Payload schema 1.1.0 → 1.8.0, live in production. Details: `docs/MASTER_PLAN_ENGINE_REFINEMENT.md`, `docs/EDITTRADES_MCP_CONNECTOR.md`.

- **2026-09-21:** read-only MCP connector (`get_scalp_context`), tracked-wallet `account` block (schema 1.1.0), scalp stop-distance guard (3% max from entry mid for SCALP_1H and MICRO_SCALP), `stopSource`.
- **Phase 1:** `config/engine.json` + `configVersion`; engine constants (thresholds, R:R, stop buffers, scalp max stop) moved out of code.
- **Phase 2:** per-symbol `decisionTrace` (1.3.0).
- **Phase 3:** `lib/riskEngine.js` — leverage cap from stop distance, loss at stop, per-signal `risk` block (1.4.0).
- **Phase 4:** `lib/patternDetector.js` — 1m/3m/5m flag detector, long and short, `candidateSetups[]` (1.5.0).
- **Phase 5:** payload controls `symbols` / `include` / `compact`, config snapshot, `lossAtStopPctOfWallet` (1.6.0).
- **Phase 6:** compute-depth assertion, build-duration log.
- **Phase 7:** `lib/geometry.js` — pivots, horizontal zones, shared ATR, room to level, EMA slope, candidate risk (1.7.0).
- **Phase 8:** diagonals, channel, confluence zones (1.8.0).
- **Phase 10:** replay harness `scripts/replay.js` (production pipeline per closed candle, no lookahead, live capture with 1m trade backfill), `scripts/replay-metrics.js` (candidate counts, visual-gate rate, lifetime, label precision/recall), miss log `test/fixtures/misses/` (MISS_001, MISS_002). No payload change; configVersion 2026.09.22-8 (`replay.minComputeCandles`).
- **Phase 9b:** `lib/biasMatrix.js` — per-timeframe bias matrix, alignment (with/counter-trend, room to the nearest HTF zone), decisionInputs (scalp/swing directional triples), opt-in via `include: bias`; `decisionTrace.bias` summary; failed trace strings carry `failReason`; visual gate: `lifecycle.nearMissGate` (default false) and visualTarget prefers triggering/confirmed (replay gate rate 0.54 → 0.05). Schema 1.9.0 → 1.10.0, configVersion 2026.09.22-9.
- **Phase 11:** GPT instruction trim + payload headroom. `docs/GPT_INSTRUCTIONS.md` is now the Custom GPT instructions source of truth (7990 → 7836 UTF-16 units), gated by `scripts/check-gpt-instructions.js` / `npm run check:gpt`; trimmed rules the payload already carries (flag-pattern anatomy, stop-distance-driven leverage narrative, geometry field shapes) and added coverage for `decisionTrace.bias` grammar, the `failReason` trace token, and `include=bias` MCP-only gating. `decisionTrace.window` drops `from`; `decisionTrace.geometry` strings round to 2 decimals and drop `na` tokens. No schema/config bump; 729 bytes recovered on the default 3-symbol payload.
- **In progress:** Phase 8b, on-demand confirmation chart (`lib/chartRender.js`).

## 2026-09-23 — Trading-model quick pass Q1-Q5 (branch `upgrade-signal-engine`)

Owner's trading model (`docs/MASTER_PLAN_TRADING_MODEL.md`, M-1..M-9), quick-pass subset per `docs/PLAN_TRADING_MODEL_QUICK_PASS.md`. Additive only; no strategy decision, stop, target, confidence, or `bestSignal` changed. Schema 1.10.0 → 1.11.0, configVersion 2026.09.22-9 → -10.

- **Q1 — measured-move flag targets (M-5b):** `lib/patternDetector.js` publishes `poleHeight`, `measuredTarget`, `measuredRR` on every flag candidate (not coils); `measuredMoveFor()` is called again after geometry snapping so a moved `breakoutLevel` keeps a consistent target. Never a target from a moving average.
- **Q2 — `ema200Side` on flag candidates (M-6):** `above` / `below` / `null` (EMA200 unavailable), computed in `services/scalpContext.js` from the candidate's own timeframe. Never filters - a short above the 200 or a long below it still publishes.
- **Q3 — top-down sentiment (M-1, M-2, M-6, M-6b):** new `lib/topDown.js` (pure, no I/O) - `weeklyFromDaily()`/`buildWeeklyLean()` (1W from the already-fetched 1D candles, Monday-aligned weeks; weekly EMA200 always null, not enough history), `buildTopDown()` (weighted vote over 1W/1D/4H/1H, config `model.topDownWeights`), `buildAboveBelow200()` (config `model.above200Weights`). Default payload: `decisionTrace.bias` gets two more tokens, `|td:<bull|bear|mixed>:<n>/4|a200:<count>/<of>`. Full `symbols.X.topDown` object opt-in via `include=bias`. Never gates or changes a strategy, candidate, or confidence.
- **Q4 — replay outcome scoring (M-9, master plan M1):** new `scripts/replay-outcomes.js` / `npm run replay:outcomes` - walks a replay JSONL forward on 1m candles with no lookahead, scoring every valid strategy signal and every confirmed flag candidate (using Q1's `measuredTarget` as TP1): fill rate, win rate, average win R, expectancy, max consecutive losses, median time to TP1. Dev-only script, no production code path.
- **Q5 — GPT instructions (budget-neutral):** `docs/GPT_INSTRUCTIONS.md` teaches `measuredTarget`/`measuredRR`/`ema200Side` and the `td:`/`a200:` trace tokens; trimmed an equal amount elsewhere (duplicated field lists, redundant phrasing) to hold 7990 → 7990 UTF-16 units.
- New config: `config/engine.json` `model` key (`topDownWeights`, `above200Weights`, `weeklyMinWeeksForEma21`, `weeklySlopeLookbackWeeks`) and `replay.outcomes` (`fillWindowCandles`, `maxHoldCandles`).
- New tests: `test-top-down.js` / `npm run test:topdown` (14). Additions to `test-pattern-detector.js`, `test-scalp-context.js`, `test-bias-matrix.js`, `test-replay.js`. All twelve suites green (412 passing); `npm run check:gpt` OK (0 headroom); `git diff --check` clean.
- **Payload budget (2026-09-23):** published candles on 1m/3m/5m 30 → 24 and candle volume rounded to 2 decimals; `poleHeight` no longer published (equals |measuredTarget − breakoutLevel|); EMA values rounded to 2 decimals in the payload. Live default 3-symbol payload 81.3 KB → 74.3 KB.

## 2026-09-23 — F1: Flag Detection Coverage (branch `upgrade-signal-engine`)

Single implementer pass per `docs/PLAN_FLAG_DETECTION_COVERAGE.md`, fixing the incident where BTC/SOL/ETH 1m longs went silent or vanished around a real flag's lifecycle (`test/fixtures/history/2026-09-23`; see `test/fixtures/misses/MISS_003.json`). Detection and trade qualification stay separate: a flag is reported because its geometry exists, not because a strategy wants to trade it. Additive only; long and short share the one oriented code path throughout. Schema 1.11.0 → 1.12.0, configVersion 2026.09.22-10 → 2026.09.23-1.

- **Item 1 — `proto` state:** an impulse that qualifies with 1 to `minCandles - 1` pullback candles (no new extreme past the impulse peak) publishes as `state: "proto"`, no entry call. Lifecycle order: proto → forming → triggering → confirmed → failed / expired.
- **Item 2 — wider impulse lookback:** `flag.maxImpulseCandles` 8 → 20, verified against both replay histories (gate rate stayed under 0.15; see Verification below).
- **Item 3 — EMA21 reclaim:** a flag whose first candle is off-side of EMA21 but closes back on-side within `flag.reclaimCandles` (default 2) is valid; `ema21Hold: "reclaim"` (scores like `wick`). The acceptance-fail rule is unchanged.
- **Item 4 — failed stays visible:** a failed candidate stays in the default `candidateSetups` for `flag.failedTtlCandles` (default 10) candles of its own timeframe past failure, carrying `failReason` and the new `failedAt`; older failures still follow `config.flag.includeFailed`. The search window itself now reaches `flag.maxBreakoutAge + max(failedTtlCandles, expiredTtlCandles)` candles back so a failure this old is still findable.
- **Item 5 — `expired` state:** a flag that would still read `confirmed` more than `flag.maxBreakoutAge` candles past its break instead reads `state: "expired"`, `chaseRisk: true`, for `flag.expiredTtlCandles` more candles, then is no longer found - replacing the old silent drop at exactly `maxBreakoutAge` candles (the incident's SOL 14:57 miss).
- **Item 6 — stable identity:** `candidateId` (`"<SYMBOL>:<tf>:<direction>:<impulseStart ISO>"`) and `firstDetectedAt`, derived from this request's own candle window (`lib/patternLifecycle.js` `identifyCandidate`), so the same flag run keeps the same id across forming → triggering → confirmed. `impulseStart`/`impulseEnd` are not separately published (byte budget - both are mechanically derivable from fields already kept: `impulseStart` is `candidateId`'s own last segment, `impulseEnd` is `firstDetectedAt` minus one candle).
- **Item 7 — cheap geometry:** `flagSlope` (least-squares slope of the flag's own closes, % per candle, real price space), `breakoutDistancePct`, `invalidationDistancePct` (signed % from the last close), rounded to 2-4 decimals.
- **Item 8 — trade qualification:** new `lib/candidateQualifier.js`. Every candidate (flag or coil) gets `qual: { quality: low|med|high, decision: watch|wait|dont|actionable, reasons: [] }`, built only from data already in the payload (the symbol's other candidates, its geometryContext, Stoch RSI, the 4h bias lean, and the candidate's own ema200Side/chaseRisk/measuredRR) - never a new detection signal, never a probability of profit.
- **Item 9 — payload:** default 3-symbol payload settled at ~75.3 KB (77068 B measured) after `CANDLE_LIMITS` on 1m/3m/5m went 24 → 20 (F1's new per-candidate fields, plus more candidates surviving longer via items 1/4/5, had pushed a busy-market default to ~79.3-83.3 KB). Build time ~840 ms (unchanged order of magnitude). `decisionTrace.candidateSetups` trace strings gained the `proto`/`expired` states.
- **Item 10 — GPT instructions:** `docs/GPT_INSTRUCTIONS.md` - `flags` now covers every state including proto/failed/expired plus `qual.decision`+`reasons`; `forming` includes proto; a data-freshness note that closed candles may trail the live chart by one candle; `confidence=pattern evidence only` disambiguates it from the new `qual.quality`. Funded by tightening existing wording (no rule removed); FORMAT/TRACK FORMAT/NO TRADE LINE untouched. 7988 → 7988 UTF-16 units (net zero); schema marker bumped to 1.12.x.
- **Item 11 — MISS_003:** `test/fixtures/misses/MISS_003.json`, `status: validated` - replaying `test/fixtures/history/2026-09-23` now shows a 1m long candidate at every close 14:45-15:03 for BTC/ETH/SOL (nothing reads "none"), SOL triggers at 14:52 exactly as the incident predicted, and SOL's confirmed flag reads `expired` at 14:57 instead of vanishing.
- **Verification:** all twelve suites green (423 passing, up from 412); `npm run check:gpt` OK (2 units headroom, same as before); `git diff --check` clean. Replay gate rate: 2026-09-22 history 0.0509 → 0.1353; 2026-09-23 history 0.0504 → 0.1485 (both under the 0.15 stop threshold). Flag-candidate expectancy moved in both directions across the six (symbol × direction) groups with materially more signals per group (more detection, the plan's intent); no group flipped from healthy to broken. Full before/after numbers: `docs/EDITTRADES_MCP_CONNECTOR.md`, implementer report.
- New config: `config/engine.json` `flag.reclaimCandles` (2), `flag.failedTtlCandles` (10), `flag.expiredTtlCandles` (10), `flag.quality` (`highConfidence` 75, `medConfidence` 50), `flag.maxImpulseCandles` 8 → 20.
- New module: `lib/candidateQualifier.js`.
- New tests: additions to `test-pattern-detector.js` (26 → 32), `test-replay.js` (30 → 31, incl. MISS_003), `test-scalp-context.js` (CANDLE_LIMITS 20), `scripts/replay-metrics.js` STATES list extended (proto, expired).

## 2026-09-23 — Signal-reliability minimum plan (branch `upgrade-signal-engine`)

Single implementer pass. A flag candidate, even `confirmed`, even `qual.actionable`, was never a trade call - no exact entry, no fees-adjusted R:R, no staleness gate, and the outcome-replay script could credit a same-candle fill+target touch as a win despite unknowable intrabar order. This pass adds the smallest dependable bridge from an existing 1m/3m/5m flag candidate to one reproducible engine-owned trade call, fixes the replay false-win bug, and adds a local paper ledger - not the full `FLAG_21` roadmap, no higher-timeframe flags, no execution. Additive only; `strategies.*`/`bestSignal` byte-identical; legacy strategy engine, MCP's one read-only tool, and the 3% scalp stop cap untouched. Schema 1.12.0 → 1.13.0, configVersion 2026.09.23-1 → -2.

- **Work package 1 — freshness gate:** new `lib/freshness.js` (`assessFreshness`/`assessFreshnessAll`, pure) - a timeframe's `closedThrough` is fresh for one interval plus a fixed provider grace period (`freshness.graceMs`, 5s); missing or unparseable timestamps, and a `closedThrough` in the future, fail closed. Feeds `flagTradePlan`'s own `stale_data`/`missing_data` rejection; `dataStatus` semantics unchanged. `trades` added as a COMMANDS alias of `signals` (never a third trade-call format).
- **Work package 2 — engine-owned flag trade plan:** new `lib/flagTradePlan.js`, wired into `services/scalpContext.js` as `symbols.<SYM>.flagTradePlan`. Considers only `type: flag`, `state: confirmed` candidates; publishes at most one selected plan per symbol. Entry = the candidate's own (geometry-snapped) `breakoutLevel`, read as a retest/hold trigger, never live price; stop = `invalidation`, never tightened; TP1 = `measuredTarget`, capped to the nearest horizontal zone edge ahead of entry (a zone touching entry itself is `room_at_entry`, not a cap); TP2 = the measured target when it still lies beyond a capped TP1. `netRR` nets `config.risk.feeBps`/`slippageBps` round-trip cost against both legs; required ≥ `flagPlan.minNetRR` (3.0) and stop distance ≤ `scalp.maxStopDistancePct` for `ready`/`conditional` - never satisfied by moving the stop. `ready` now requires the latest closed candle to retest and hold the valid side of the breakout level within tolerance; `conditional` uses `awaiting_retest_hold` or `awaiting_breakout`. Selection is deterministic: ready before conditional before rejected, then confidence, higher timeframe, stable `candidateId`. The 4h bias lean is never a gate here.
- **Work package 3 — replay and forward-paper ledger:** `scripts/replay-outcomes.js`'s `walkOutcome` now fills at the unfavorable zone edge (was the zone midpoint) and never credits a target touched on the same candle as the fill as a win (the order of entry vs. target within one candle is unknowable from OHLC alone) - only a later, unambiguous candle's touch counts. `extractFlagPlanSignals` now scores ready plans only; replay and ledger outcomes are explicitly labelled gross level-touch diagnostics until the scorer reproduces the complete closed-candle entry and net fee/slippage accounting. New `scripts/paper-ledger.js` (`npm run ledger:record` / `ledger:score`) is local, append-only JSONL, never carries `account`, and never rewrites the ledger.
- **Work package 4 — GPT contract:** `docs/GPT_INSTRUCTIONS.md` CANDIDATES - `flagTradePlan=trade authority` (ready/conditional/rejected + `entryCondition`/`reasonCode`), replacing the old unconditional "confirmed + chaseRisk=false = a setup despite NO_TRADE" permission with "Confirmed alone isn't a trade." COMMANDS - `trades = signals.`. Funded entirely by tightening existing wording (no rule dropped; FORMAT/TRACK FORMAT/NO TRADE LINE untouched); GPT test sheet grew an 11th prompt (`trades`). 7988 → 7987 UTF-16 units.
- New config: `config/engine.json` `freshness` (`graceMs` 5000), `flagPlan` (`minNetRR` 3.0, `entryToleranceAtr` 0.1).
- New modules: `lib/freshness.js`, `lib/flagTradePlan.js`, `scripts/paper-ledger.js`.
- New tests: `test-freshness.js` / `npm run test:freshness` (10), `test-flag-trade-plan.js` / `npm run test:flagplan` (34, incl. mirrored long/short, nearest-level cap, chase, stale, price-past-entry, net-RR boundary, 4h-flat policy, stable identity, legacy-output parity), `test-paper-ledger.js` / `npm run test:ledger` (10). Additions to `test-replay.js` (31 → 35: unfavorable-fill entries, no-false-intrabar-win, flag-plan signal extraction/scoring).
- **Verification and limitations:** replayed the two saved histories (`test/fixtures/history/2026-09-22`, `2026-09-23`) against the exact selected `flagTradePlan` per close; see the implementer report for sample sizes. Ten to twenty forward-paper calls (or two short saved-history replays) are a workflow smoke test, not an accuracy claim - green tests do not imply a profitable strategy or production readiness. The deployed GPT and its knowledge file were not available to verify against; see the implementer report for what remains unverified.

## 2026-09-23 — Review fix pass on packages 1+2 (branch `upgrade-signal-engine`)

Blocker fixes from the Phase 0 review (`docs/MASTER_PLAN_NEXT_STEPS.md`). Schema 1.14.0 → 1.15.0 (published field changes below), configVersion 2026.09.23-3 → -4. No strategy, `bestSignal`, scalp-guard, MCP, or wallet change.

- **Flag plan `ready`:** requires an earlier closed candle that closed through the breakout level, then the latest closed candle reaching the level within `flagPlan.entryToleranceAtr` ATR and closing on the hold side. Otherwise `conditional` with `awaiting_breakout` or `awaiting_retest` (renamed from `awaiting_retest_hold`). `entryCondition` states the sequence, entry rounded to 2 decimals.
- **Model evidence:** Stoch history offset from the candle series' end (pre-history pivots get no value); divergence picks the most recent bull/bear pivot pair; stale divergences (strength 0) no longer count toward confluence; a fade against sentiment at the channel edge is `breakoutRisk: high`; no direction → `unknown` and no levels ahead; weekly EMA21 gap no longer filed under `unavailable.ema200`.
- **Recommendation:** `price: null` → `DATA_UNAVAILABLE`; with no plan, missing/stale 1m/3m/5m → `DATA_UNAVAILABLE` with `unknowns` like `stale_data:1m`. R:R floor read from `flagPlan.minNetRR` only (`model.minNetRR` removed); weights use `??`.
- **Payload budget:** default `flagRecommendation` is codes + one-line primary/change-condition text (full record with refs/factorStates under `model.recommendation`, include=model); failed candidates publish identity + `failReason` fields only; `CANDLE_LIMITS` 15m/1h 24 → 20. Live default 84,095 → 76,889 B, compact 41,899 B. New fixture byte-cap test (default ≤ 79,000 B, compact ≤ 45,000 B).
- **Ledger / replay:** ledger id = `planId|status|reasonCode` (rejected → ready in one window keeps both rows); `ready` plans are filled at the ready close at the entry level (`walkOutcome` `prefilled`), R still labeled gross.
- **Tests:** new `npm run test:evidence` (8). `test:scalp` 109 → 113, `test:flagplan` 35 → 40, `test:flagrec` 12 → 17, `test:ledger` 10 → 12, `test:replay` 35 → 36.

## 2026-09-23 — 21/200 decision clarity follow-on (branch `upgrade-signal-engine`)

Follow-on work package from `EDITTRADES_21_200_DECISION_CLARITY_MASTER_PLAN.md`. This package is about faithful communication of the owner's EMA21/EMA200 flag model, not win-rate proof. Additive only; no execution, secrets, deploy, commit, push, or writable MCP tool. Schema 1.13.0 → 1.14.0, configVersion 2026.09.23-2 → -3.

- **Preflight fixes:** retest readiness now requires a closed candle to retest and hold the valid side of the breakout level; ready outranks conditional in selected-plan ranking; replay/paper-ledger plan scoring waits for `ready` and labels R as gross level-touch R, not exact net plan outcome.
- **Model evidence:** new `lib/modelEvidence.js` builds opt-in `include=model` evidence: per-timeframe EMA21/EMA200 map and pull read, higher-timeframe flags via the existing detector, channel/level context, breakout-risk basis, and Stoch RSI divergence from existing pivots/Stoch histories.
- **Recommendation engine:** new `lib/flagRecommendation.js` returns one deterministic `flagRecommendation` per symbol: `GOOD`, `WATCH`, `BAD`, or `DATA_UNAVAILABLE`; `supports[]`, `opposes[]`, `unknowns[]`, `changeConditions[]`, `factorStates[]`, `qualityBand`, `readiness`, `policyVersion`, and trace. It consumes `flagTradePlan`; it never recalculates plan levels/R:R and never promotes legacy `bestSignal` as the 21/200 recommendation.
- **Payload/API:** `flagRecommendation` is compact and always present. Bulky evidence is opt-in via `include=model` for REST/MCP. OpenAPI and connector docs updated.
- **Docs:** added `docs/TRADING_MODEL_DECISION_CONTRACT.md` (M-1..M-9 rule table, provenance, implementation choices) and `docs/FLAG_RECOMMENDATION_REVIEW_SHEET.md` (representative outputs, GPT manual update checklist, unresolved owner interpretations).
- **GPT instructions:** schema marker bumped to 1.14.x. GPT now treats `flagRecommendation` as the 21/200 call and `flagTradePlan` as the level/math authority; legacy strategies are explicitly legacy. `npm run check:gpt` passes at 7978 UTF-16 units.
- **Tests:** new `npm run test:flagrec` (12) covers GOOD/WATCH/BAD/DATA_UNAVAILABLE, aligned/mixed context, counter-EMA200, channel/level context, divergence agreement/conflict, missing weekly EMA200, stale data, no plan, low net R, byte stability, and mirrored short behavior. Updated `test:scalp`, `test:mcp`, `test:config`, `test:flagplan`, `test:replay`, and `test:ledger`.

## 2026-09-23 — P1: Pyth mark price beside the Kraken price (branch `upgrade-signal-engine`)

Plan: `docs/PLAN_PYTH_MARK_PRICE.md`. Schema 1.15.0 → 1.16.0, configVersion 2026.09.23-4 → -5. Additive only; candles, strategies, `bestSignal`, `flagTradePlan`, MCP registration and wallet unchanged.

- **Mark:** new `lib/pythMark.js` reads the live Pyth price for every symbol in one Hermes request (`/v2/updates/price/latest?ids[]=..&parsed=true`, `Authorization: Bearer $PYTH_API_KEY`, 4 s timeout). Never throws; no key → no request. The key and URL are never logged. Runs alongside the candle fetches.
- **Payload:** `symbols.<SYM>.mark = {price, conf, publishTime, source: "pyth", ageSec, driftBps, status}` beside `price` (still the closed 1m close). `status` ok | stale (> `mark.pyth.maxAgeSec` 30) | unavailable. Unavailable never changes `dataStatus` and adds no warning. Compact keeps `{price, driftBps, status}`. `decisionTrace.bias` appends `|mark:<driftBps>` or `|mark:na`. Injected-candle builds (tests, replay) read `unavailable` with no request.
- **Config:** `mark.pyth` block: BTC/ETH/SOL feed ids, `maxAgeSec` 30, `timeoutMs` 4000.
- **GPT instructions:** one RISK rule: stops, Thesis Eliminated and liquidation are hit on mark; check against `mark.price`, flag |driftBps| > 10.
- **Tests:** new `npm run test:mark` (12). `test:scalp` 113 → 117 (mark on every symbol, filterPayload default/compact, fetch failure leaves `dataStatus`, byte cap with ok marks: fixture default 77,063 B ≤ 79,000).

## 2026-09-23 — Owner decisions 1 and 4: gross 3R gate, own-timeframe room check (branch `upgrade-signal-engine`)

Source: `docs/OWNER_DECISIONS_2026-09-23.md` items 1a and 4a. Schema 1.16.0 → 1.17.0, configVersion 2026.09.23-5 → -6. Additive except the named renames; `strategies`, `bestSignal`, MCP registration and wallet unchanged.

- **3R is gross price R:** `flagTradePlan.grossRR` = `|tp1 − entry| / |entry − stop|` (3 decimals), published beside `netRR` (computed as before). The plan gate is `grossRR < flagPlan.minRR` → rejected `rr_below_min` (replaces `net_rr_below_3`). `netRR` is information only and never rejects.
- **Config:** `flagPlan.minNetRR` renamed `flagPlan.minRR` (3.0).
- **Recommendation:** BAD on `rr_below_min` (primary text cites `grossRR` and the floor). Ready/conditional plans get support `rr_ok` (gross) and, when `netRR < minRR`, a non-blocking oppose `net_rr_low` ("fees eat the edge"). `net_rr_ok` / `net_rr_unknown_or_low` / `net_rr` removed; net R:R never makes a plan BAD.
- **Room check:** `lib/candidateQualifier.js` `roomBlockedReasons` reads only the candidate's mapped geometry timeframe (`geometryTimeframeFor`, 1m/3m/5m → 15m); a zone only on 1h/4h no longer emits `room:blocked-<tf>`. `flagTradePlan`'s TP1 cap (all geometry timeframes) is unchanged.
- **Docs:** `openapi/scalp-context.yaml`, `docs/TRADING_MODEL_DECISION_CONTRACT.md` M-5b/M-9, `docs/FLAG_RECOMMENDATION_REVIEW_SHEET.md` samples, `docs/EDITTRADES_MCP_CONNECTOR.md`, `docs/GPT_INSTRUCTIONS.md` field map (outside the instruction block; `check:gpt` unchanged at 7976).
- **Tests:** `test:flagplan` 42 → 43 (gross exactly 3 passes with net < 3; gross 2.9 rejects `rr_below_min`; mirrored), `test:flagrec` 17 → 18 (`net_rr_low` never BAD, ready + conditional, mirrored), `test:pattern` 32 → 33 (own-tf room check, mirrored); `test:replay` fixtures renamed; schema asserts in scalp/pattern/geometry/config bumped.

## 2026-09-23 — Phase 2: recommendation completeness (branch `upgrade-signal-engine`)

Owner goal: every recommendation says what supports it, what opposes it, what is unknown, and what specific event changes the call. Additive only; class logic, `flagTradePlan`, strategies and `bestSignal` unchanged. Schema 1.17.0 → 1.18.0, configVersion 2026.09.23-6 → -7.

- **Context on every record** (`lib/flagRecommendation.js`, all classes except `market_data_unavailable`): `td:<sentiment>:<n>/4`, `a200:<above>/<of>`, `ema200:<tf>:<side>`, `ema200:1w:missing`, `4h:with` / `ct:4h` / `4h:flat`, `level:<geomTf>:<price>` or `level:none` (first level beyond the breakout on the candidate's own geometry timeframe; oppose when before the measured target), `tp1_capped:<price>`, `chan:<geomTf>:<edge>:<risk>`, the candidate's `conflict:`/`stoch:`/`rr:` qual codes, `divergence_*`, `data_fresh` / `data_partial`. Placed by direction; undirected context is `unknown`. Never a veto; unknown never improves a class.
- **WATCH names its candidate:** new `candidate{candidateId, timeframe, direction, state, breakout, invalidation, measuredRR}` (triggering > forming > proto, then confidence, then smaller timeframe); `changeConditions` reads e.g. `3m close above 84,466.10, then a retest that holds it, then plan ready; a close below 84,300.00 voids it`, or `a 1m/3m/5m flag must form (none detected)`.
- **BAD** lists the disqualifying reason first (`opposes[0]`) and a concrete remedy: chase → retest of the entry that holds; `rr_below_min` → a measured move ≥ 3R gross; `room_at_entry`, stop cap, invalid levels likewise. Mirrored for shorts.
- `services/scalpContext.js` passes `candidates` and `geometryContext` into `buildFlagRecommendation` (read-only).
- New suite `npm run test:flagrec:fixtures` (`test-flag-recommendation-fixtures.js`, 16 cases, pinned clock, mirrored, byte-stable). Payload on the saved 2026-09-23 fixture: default 76,864 → 78,003 B (cap 79,000), compact 41,459 → 42,598 B. GPT instructions unchanged (7,976 units). Not deployed.

## 2026-09-23 — T1: call tracker (branch `upgrade-signal-engine`)

Plan: `docs/PLAN_CALL_TRACKER.md`. No engine, payload, MCP, or Vercel change; schema stays 1.18.0. Owner decisions: 10-minute cadence; the tracker repo is self-contained.

- **`scripts/tracker/`** (Node ≥ 20, no dependencies, every script takes `--data <dir>`, page takes `--out <dir>`): `collect.js` (GET `/api/scalp-context` with `SCALP_CONTEXT_API_KEY` from env; one row per symbol to `data/calls/YYYY-MM-DD.jsonl`; strips `account`/`wallet`/`performance`/`margin`/`holdings*` and any key containing wallet/balance/address at any depth, then refuses the write if any survived; dedupe on symbol+closedThrough; closed 1m/5m/15m candles to `data/candles/<tf>.jsonl`), `store.js`, `score.js` (ready plans filled at the ready close; conditional plans scored only through the ready plan they became; rejected plans counted by reason; every recommendation class change scored as a call; 24 h window then `expired`; idempotent; gross R, plan netRR carried), `aggregate.js`, `build-page.js` (static `docs/index.html` + `docs/report.md`, "provisional; not evidence of an edge" on every section), `walk-outcome.js` (vendored copy of `scripts/replay-outcomes.js` `walkOutcome`, parity-tested), `sync.js` + `repo-template/` (README, package.json, collect/score workflows).
- npm scripts `test:tracker` (17), `tracker:collect`, `tracker:score`, `tracker:page`, `tracker:sync`.
- Tracker repo `Bai-ee/edittrades-tracker` (private): `collect.yml` every 10 min, `score.yml` hourly.
- **Charts (2026-09-23):** page gains an engine-call equity curve (cumulative gross R of scored ready plans, 11 client-side filters, by-filter table) and a wallet value chart from a new whitelisted `data/wallet.jsonl` (`t, status, marginUsd, holdingsUsd, totalUsd, baselineUsd, pnlUsd, pnlPct` only); scored calls carry `dims`; `scripts/tracker/charts.js`; `test:tracker` 25.

## 2026-09-24 — T2: trade journal (branch `upgrade-signal-engine`)

Plan: `docs/PLAN_TRADE_JOURNAL.md` (the deferred 8c). No payload, schema, config or MCP change. Not deployed.

- **`api/journal.js`** (new function; function count stays 12): `POST /api/journal` records one line the user told the GPT, `GET /api/journal?limit=` returns the last N (default 10, max 50) newest first. Bearer `JOURNAL_API_KEY`; 405 for other methods; 4 KB body cap (413); invalid JSON/record 400; 10 requests/min per key in memory (best effort on serverless); idempotent on `id` (same id in today's or yesterday's file → 200 `duplicate:true`). Storage: Vercel Blob (`@vercel/blob`, public store `edittrades-journal`), `journal/YYYY-MM-DD.jsonl` appended by ETag-guarded read-modify-write, plus `journal/manifest.json` (`baseUrl`, `days[]`) so the tracker fetches with plain HTTP. Imports only `crypto`, `@vercel/blob`, `lib/journalSchema.js`; never an MCP tool.
- **`lib/journalSchema.js`** (pure): `text` required; `kind` open/close/adjust/skip/note (default note); symbol, direction, entry/stop/tp1/sizeUsd/leverage/exitPrice (> 0), resultR/resultUsd optional; optional `engineRef` {candidateId, planId, recClass, reasonCode}; stored record built from an explicit key list.
- **Retired `api/crypto-news.js`** and its `vercel.json` route (unused; local `server.js` keeps its own inline route).
- **`openapi/scalp-context.yaml`**: `postJournal` / `getJournal` under `/api/journal`, second bearer scheme `journalKey`. The GPT Action needs a re-import.
- **`docs/GPT_INSTRUCTIONS.md`**: COMMANDS `log <text>` and `journal`; 7976 → 7982 units, funded by whitespace/wording only (no rule removed; FORMAT/TRACK FORMAT/NO TRADE LINE untouched). Test sheet prompts 12-13.
- **Tracker**: `collect.js` pulls the journal (manifest + day files, cache-busted; base URL from `--journal-base`, `JOURNAL_BLOB_BASE`, or the store id in `BLOB_READ_WRITE_TOKEN`) into `data/journal/` (dedupe by id, sensitive-key strip); `score.js` scores each `open` like a ready plan or takes a matching `close`'s reported R / exit price, `dims` from the linked engine call → `data/journal-outcomes.jsonl`; page: dashed "your trades" line on the equity chart under the same filters, entry/exit ticks on the wallet chart, "Engine vs you" block, journal log. Workflow passes `BLOB_READ_WRITE_TOKEN`.
- Tests: new `npm run test:journal` (16); `test:tracker` 25 → 31; `test:mcp` unchanged (52).

## 2025-11-27

### 📊 Professional Trading Indicators - VWAP, ATR, Bollinger, MA Stack

- **VWAP (Volume Weighted Average Price)** - Intraday timeframes (5m, 15m, 1h):
  - Value and distance percentage
  - Above/below detection and bias direction
  - AtVWAP flag (within 0.2%)
  - Reversion zone detection (> 2% away)
  - Trapped longs/shorts positioning logic
  
- **ATR (Average True Range)** - All timeframes:
  - ATR value and percentage of price
  - Volatility state classification (LOW/NORMAL/HIGH)
  - Guides position sizing and stop-loss placement
  
- **Bollinger Bands** - 4h, 1h, 15m:
  - Upper, middle, lower bands
  - Band width percentage
  - Squeeze detection (bandwidth < 2%)
  - Price position percentage (0-100 scale)
  - Overbought/oversold zones
  
- **MA Stack Analysis** - 4h & 1h:
  - EMA 50 added to existing 21 & 200
  - Bull/Bear/Flat stack detection
  - Trend structure confirmation
  
- **New Module**: `lib/advancedIndicators.js` with all calculations
- **Documentation**: `ADVANCED_INDICATORS_GUIDE.md` - Complete usage guide with thresholds

### 🎯 Advanced Candle Analysis & Price Action
- **Candle Metrics** (all timeframes):
  - Direction: bull/bear/doji
  - Body percentage (0-100%)
  - Upper/lower wick percentages
  - Close position within range
  - EMA21 relationship (above/below)
  - Full OHLC range

- **Price Action Patterns** (all timeframes):
  - Rejection Up/Down (wick-based reversals)
  - Engulfing Bull/Bear patterns
  - Inside Bar detection
  - Pattern detection from last 2 candles

- **Support & Resistance Levels** (4h & 1h only):
  - Nearest resistance/support prices
  - Distance to levels (percentage)
  - At level detection (within 0.5%)
  - Break detection (closed through level)

- **Recent Candles** (5m only):
  - Last 5 candles for LLM context
  - OHLC for each candle
  - Ordered oldest → newest

- **UI Updates**:
  - Removed colors from prices (EMAs, Swing High/Low)
  - Only trend indicators keep colors (UPTREND/DOWNTREND/FLAT)
  - Cleaner, more minimal appearance

- **New Modules**:
  - `lib/candleFeatures.js` - Candle analysis and pattern detection
  - `lib/levels.js` - Support/resistance calculation
  
- **Documentation**: `ENRICHED_SCHEMA.md` - Complete field reference and examples

### 📊 Expandable Detailed Timeframe Analysis
- **Show/Hide Details**: Click "Show" button on any coin to expand full timeframe breakdown
- **4 Detailed Cards**: Each timeframe (4h, 1h, 15m, 5m) displays:
  - Current Price
  - 21 EMA & 200 EMA
  - Stoch RSI (%K, %D, condition)
  - Pullback State (with distance from 21 EMA)
  - Swing High & Swing Low
  - Trend badge (color-coded border)
- **Responsive Grid**: 1 column on mobile, 2 on tablet, 4 on desktop
- **Color Indicators**: Green border for uptrend, red for downtrend, gray for flat
- **Collapsible**: Click "Hide" to collapse details and keep table compact

### 🚀 Auto-Run Homepage + Detailed Table View
- **Auto-Scan on Load**: Homepage automatically scans BTC, ETH, SOL on page load (no button click needed)
- **Detailed Table View**: Shows full trading info (price, signal, confidence, entry, stop loss, targets, timeframes)
- **Responsive Columns**: Hide less important columns on mobile (Entry on SM, Stop on MD, Targets on LG)
- **Click Row for Details**: Click any row to see full analysis in popup
- **Individual Copy**: Copy button for each coin in table
- **Copy All**: Export all 3 coins together
- **Unified UI**: Scanner page now matches homepage styling
- **Parallel Fetching**: All 3 coins fetched simultaneously (~3-4 seconds total)
- **Timeframe Badges**: Compact indicators showing trend for 4h, 1h, 15m, 5m

### 🎨 Major UI Redesign - Mobile-First Dark Theme
- **New Homepage**: Single-button scan for BTC, ETH, SOL
- **Dark Theme**: Pure black/off-white color scheme, no gradients or glows
- **Mobile-First**: Optimized for phone screens, minimal scrolling
- **Multi-Coin View**: Display all 3 coins in compact cards
- **Trade Opportunities Summary**: Quick overview of valid setups
- **Individual Copy Buttons**: Copy each coin separately
- **Copy All**: Export all 3 coins in single JSON
- **Compact Timeframe Display**: 2x2 grid on mobile, 4x1 on desktop
- **Visual Indicators**: Green/red left borders on cards with valid trades
- **Documentation**: `NEW_UI_GUIDE.md` with full design specs

### 📊 Added - Dashboard View JSON Copy Button
- **New Button**: 📊 View - Copies exactly what's displayed on dashboard as compact JSON
- **Auto-syncs**: Automatically includes any new fields we add to the dashboard
- **Size**: ~2-3KB (smaller than full API, includes all timeframes unlike LLM compact)
- **Use Cases**: Sharing analysis, trading journals, documentation, historical review
- **Documentation**: `DASHBOARD_VIEW_JSON.md` with examples and field reference

## [Previous] - 2025-11-27

### 🤖 Added - Compact API for LLM/ChatGPT Integration
- **New Endpoint**: `/api/analyze-compact/{symbol}` - Streamlined API response optimized for LLM ingestion
- **Size Reduction**: 99.75% smaller (470 bytes vs 192KB) - perfect for ChatGPT token limits
- **UI Integration**: Added 🤖 LLM button to dashboard and scanner for one-click copy to clipboard
- **Documentation**: 
  - `COMPACT_SCHEMA.md` - Complete JSON schema and field reference
  - `LLM_QUICK_START.md` - Quick start guide with ChatGPT prompt templates

### 🐛 Fixed - Mobile Error
- Added defensive null checks for `data.analysis` to prevent `Object.entries` error on mobile devices
- Enhanced error logging for better debugging across devices

### 📊 Features
- Compact response includes all essential trading data:
  - Trade signal (valid/invalid)
  - Direction (long/short/NO_TRADE)
  - Confidence score (0-100%)
  - Entry zone, stop loss, targets
  - Risk/reward ratio
  - 4H and 1H trend analysis
  - Key indicators (EMA21, EMA200, Stoch RSI)
  - Market structure (swing high/low)

### 📝 What's Removed (for size optimization)
- Raw candlestick OHLCV data
- 15m and 5m timeframe data
- Verbose nested indicator objects
- Debug information
- Redundant metadata

---

## Previous Updates

### 2025-11-26 - Copy Buttons for API Data
- Added copy-to-clipboard functionality for API endpoints
- Added copy buttons for full JSON responses
- Visual feedback for successful copies

### 2025-11-25 - Vercel Deployment
- Migrated from Express server to Vercel serverless functions
- Created `/api/analyze`, `/api/indicators`, `/api/scan` endpoints
- Added deployment protection configuration
- Fixed routing issues for path parameters

### Initial Release
- 4H Set & Forget trading strategy automation
- Multi-timeframe analysis (4h, 1h, 15m, 5m)
- Market scanner for finding opportunities
- Technical indicators: EMA, Stoch RSI, market structure
- Confidence scoring system
