# EditTrades MCP Connector and Scalp Stop-Distance Guard

Last updated: 2026-09-23 (owner decisions 1 + 4, schema 1.17.0)
Branch: `upgrade-signal-engine`
Payload: `schemaVersion` 1.8.0, `configVersion` 2026.09.22-6 live; 1.17.0 / 2026.09.23-6 local (Phases 9, 10, 9b, trading-model quick pass Q1-Q3, F1 flag detection coverage, signal-reliability minimum plan, 21/200 decision clarity, review fix pass, P1 Pyth mark, owner decisions 1 + 4), not deployed
Commits: `06ddb1d` (connector, wallet tracking, guard, call-path tests), `843c16f` (`stopSource` on SCALP_1H); engine phases 1–8 per `docs/MASTER_PLAN_ENGINE_REFINEMENT.md`
Shared spec page: https://claude.ai/code/artifact/0fa3fa7e-96f1-4931-b09f-565282bb9215
Thread handoff (local, outside repo): `~/Documents/ChatGPT/EditTrades/THREAD_HANDOFF.md`

## What this is

One read-only MCP tool, `get_scalp_context`, served stateless at `POST /api/mcp`, beside the existing Bearer-protected `GET /api/scalp-context` Custom GPT Action. Both read the same `buildScalpContext()` in `services/scalpContext.js` and narrow it with the same `filterPayload()`. Neither proxies the other.

ChatGPT uses it to decide TAKE / WAIT / PASS independently from the engine recommendation plus raw data. Trade execution is out of scope and unreachable from this path.

## Files

| File | Role |
| --- | --- |
| `services/editTradesMcp.js` | McpServer factory, single tool registration, `TOOL_INPUT_SCHEMA`, `runGetScalpContext`, summary text |
| `lib/mcpHttp.js` | Stateless Streamable HTTP dispatch, per-request server/transport, CORS, 405/500 handling |
| `api/scalp-context.js` | Shared Vercel function; branches to MCP on `__mcp=1`; parses `symbols`/`include`/`compact` query params |
| `vercel.json` | `/api/mcp` rewrites to `api/scalp-context.js?__mcp=1`; unmatched `/api/*` falls to `?__unknown=1` and is logged (Hobby 12-function cap) |
| `services/scalpContext.js` | Builds the payload: timeframes, strategies, `decisionTrace`, risk blocks, `candidateSetups`, `geometryContext`, `flagTradePlan`, `flagRecommendation`, config snapshot, `account`; `filterPayload` |
| `services/strategy.js` | Strategy engine and the scalp stop-distance policy (see below) |
| `config/engine.json`, `config/engine.js` | Versioned, frozen engine constants; `configVersion` (Phase 1) |
| `lib/riskEngine.js` | Leverage cap from stop distance, loss at stop (Phase 3) |
| `lib/patternDetector.js` | 1m/3m/5m flag detector, long and short (Phase 4); proto/reclaim/expired states, cheap geometry fields (F1) |
| `lib/patternLifecycle.js` | Geometry snap, coil resolution, visual gate (Phase 9); `identifyCandidate` stable identity (F1) |
| `lib/candidateQualifier.js` | Trade qualification (`qual`: quality/decision/reasons) layered on candidates, never a detection input (F1) |
| `lib/freshness.js` | Pure closed-candle freshness gate (one interval + grace period); feeds `flagTradePlan`'s fail-closed check, never `dataStatus` (signal-reliability minimum plan) |
| `lib/flagTradePlan.js` | The one engine-owned flag trade plan per symbol: entry/stop/tp1/tp2, net R:R, ready/conditional/rejected + reasonCode (signal-reliability minimum plan) |
| `lib/modelEvidence.js` | Opt-in 21/200 evidence: EMA21/EMA200 map, higher-timeframe flags, channels/levels, Stoch RSI divergence |
| `lib/flagRecommendation.js` | Deterministic GOOD/WATCH/BAD/DATA_UNAVAILABLE recommendation record built from `flagTradePlan` plus model evidence |
| `scripts/paper-ledger.js` | Local, append-only forward-paper ledger (`record`/`score`); never account/wallet data, never a server write API (signal-reliability minimum plan) |
| `lib/geometry.js` | Pivots, horizontal zones, ATR, room, EMA slope, diagonals, channel, confluence (Phases 7–8) |
| `services/walletTracker.js` | Read-only tracked wallet: margin, holdings, gas, performance. No keypair. |
| `lib/pythMark.js` | Read-only Pyth mark (P1): one Hermes request per build, Bearer `PYTH_API_KEY`, never throws; `symbols.<SYM>.mark` beside `price` |
| `openapi/scalp-context.yaml` | REST Action schema for the Custom GPT (source of truth for field-level detail) |
| `CHATGPT_ACTION_SETUP.md` | REST Action setup |

Tests:

| Command | File | Passing (2026-09-23, P1) |
| --- | --- | --- |
| `npm run test:sltp` | `test-strategy-sltp.js` (section 6b = call-path guard tests) | 50 |
| `npm run test:scalp` | `test-scalp-context.js` | 117 |
| `npm run test:mcp` | `test-edittrades-mcp.js` | 52 |
| `npm run test:wallet` | `test-wallet-tracker.js` | 28 |
| `npm run test:config` | `test-engine-config.js` | 14 |
| `npm run test:risk` | `test-risk-engine.js` | 24 |
| `npm run test:pattern` | `test-pattern-detector.js` (fixtures `test/fixtures/flagFixtures.js`) | 32 |
| `npm run test:geometry` | `test-geometry.js` (snapshot `test/fixtures/geometryPhase7Snapshot.json`, builders `test/fixtures/geometryFixtures.js`) | 36 |
| `npm run test:chart` | `test-chart-render.js` (sample `test/fixtures/chart-sample-btc-4h.png`) | 18 |
| `npm run test:replay` | `test-replay.js` (replay harness, metrics, miss log `test/fixtures/misses/`, outcome scoring, MISS_003, exact-plan scoring) | 36 |
| `npm run test:bias` | `test-bias-matrix.js` (bias matrix, alignment, decision inputs, mirrors, td:/a200: trace grammar) | 15 |
| `npm run test:topdown` | `test-top-down.js` (weekly aggregation/lean, top-down vote, above/below-200; trading-model quick pass Q3) | 15 |
| `npm run test:freshness` | `test-freshness.js` (`lib/freshness.js`; signal-reliability minimum plan work package 1) | 10 |
| `npm run test:flagplan` | `test-flag-trade-plan.js` (`lib/flagTradePlan.js`; hand-built cases + full-pipeline 4h-flat/parity, work package 2) | 42 |
| `npm run test:flagrec` | `test-flag-recommendation.js` (`lib/flagRecommendation.js`; GOOD/WATCH/BAD/DATA_UNAVAILABLE, mirrored long/short, reason fidelity) | 17 |
| `npm run test:ledger` | `test-paper-ledger.js` (`scripts/paper-ledger.js`; append-only forward-paper ledger, work package 3) | 12 |
| `npm run test:evidence` | `test-model-evidence.js` (`lib/modelEvidence.js`; EMA map, channels, divergence) | 8 |
| `npm run test:mark` | `test-pyth-mark.js` (`lib/pythMark.js`; mock Hermes: expo/conf, one request, no key → no request, failures → unavailable, drift sign, stale; `dataStatus` untouched) | 12 |

The first four are the deploy gate; the rest are the per-module suites added by the engine phases. Run all eighteen before a deploy.

Replay (Phase 10, dev only, never on the request path): `npm run replay -- --capture BTC,SOL,ETH --out test/fixtures/history/<date>/ [--backfill-1m 360]` saves a live pull; `npm run replay -- --history <dir> --symbols BTC --out btc.jsonl` runs `buildScalpContext()` once per closed candle with no lookahead; `npm run replay:metrics -- btc.jsonl` prints candidate counts, visual-gate rate by code, lifetime and label precision/recall; `npm run replay:outcomes -- btc.jsonl <historyDir>` (trading-model quick pass Q4; signal-reliability minimum plan work package 3 added exact-`flagTradePlan` scoring alongside the existing strategy/`FLAG_MEASURED` rows, plus a rejection-reason breakdown) walks the same JSONL forward on 1m candles and scores every valid strategy signal, confirmed flag candidate, and selected flag trade plan: fill rate, win rate, average win R, expectancy, max losing streak, median time to TP1. Details: master plan, Phase 10; `docs/PLAN_TRADING_MODEL_QUICK_PASS.md` Q4.

Forward-paper ledger (signal-reliability minimum plan work package 3, dev only, local file, never on the request path): `npm run ledger:record -- <context.json> [--out paper-ledger/calls.jsonl]` appends one row per symbol from a saved `buildScalpContext` payload (every `flagTradePlan`, including a genuine no-trade `null`) - append-only, refuses a duplicate `planId`/no-plan id, never carries `account`. `npm run ledger:score -- <ledger.jsonl> <historyDir> [--out outcomes.jsonl]` walks only the `ready`/`conditional` rows forward against saved 1m history (same `walkOutcome` as `replay:outcomes`) and writes a separate outcomes file - the ledger file itself is never rewritten. `paper-ledger/` is gitignored.

## Endpoint

| Item | MCP | REST |
| --- | --- | --- |
| URL | `POST https://snapshottradingview.vercel.app/api/mcp` | `GET https://snapshottradingview.vercel.app/api/scalp-context` |
| Transport | MCP Streamable HTTP, stateless, protocol 2025-03-26 | JSON |
| Auth | None (data approved for public read-only exposure) | Bearer `SCALP_CONTEXT_API_KEY` |
| Headers | `Content-Type: application/json`, `Accept: application/json, text/event-stream` | `Authorization: Bearer` |
| Options | tool args `symbols`, `include`, `compact`, `chart` | query `?symbols=BTC,SOL&include=strategies,geometry&compact=1`; `?chart=BTC:1m` returns `image/png` |
| Response | JSON-RPC in SSE frame; payload in `structuredContent` + `requestId` | Raw payload |
| `dataStatus: unavailable` | Tool error (`isError: true`) | 200 with status in body |
| Wrong method | 405 JSON-RPC `-32000` | 405 |
| OPTIONS | 200, CORS `*` | n/a |
| Handler failure | 500 JSON-RPC `-32603`, `data.requestId`, no stack text | 500 |

Fresh `McpServer` + transport per request, torn down on `res.close`. `sessionIdGenerator: undefined` = stateless mode, required on serverless.

## Tool

| Field | Value |
| --- | --- |
| Name | `get_scalp_context` |
| Input | all optional: `symbols: string[]`, `include: string[]`, `compact: boolean`, `chart: string`. `{}` returns the full payload unchanged. |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |
| Build timeout | 25 s → tool error |

Success: `content[0].text` = one-line summary (`generatedAt closedThrough dataStatus warnings symbols requestId`); `structuredContent` = filtered payload + `requestId`.

Errors (`isError: true`, sanitized text, no structured content): build threw/timed out; empty payload; `dataStatus === 'unavailable'` ("Do not trade on this run"). `partial` + warnings pass through as success.

### Payload controls (Phase 5)

- `symbols`: any of `BTC`, `SOL`, `ETH`, case-insensitive.
- `include` tokens: `timeframes`, `strategies`, `candidates` (→ `candidateSetups`), `geometry` (→ `geometryContext`), `trace` (→ `decisionTrace`), `account`, `config`, `bias` (→ `biasMatrix`, `alignment`, `decisionInputs`, `topDown`), `model` (→ bulky 21/200 model evidence). `price`, `mark`, `source`, `structure`, `bestSignal`, `flagTradePlan`, and compact `flagRecommendation` are always kept.
- `bias` and `model` are opt-in: the objects are only built into the response when `include` lists them (`includeBias` / `includeModel`). Without `model`, the compact `flagRecommendation` remains available. Prefer `compact` with `bias` or `model`.
- 2026-09-23 (F1, flag detection coverage): schema 1.12.0 added `qual`, `candidateId`, `firstDetectedAt`, `failedAt`, `flagSlope`, `breakoutDistancePct`, `invalidationDistancePct` to every flag candidate, plus the new `proto`/`expired` states and more candidates surviving longer (failedTtlCandles/expiredTtlCandles) - live default before any trim ranged ~79.3-83.3 KB with busier markets (multiple 1m/3m/5m proto/forming/failed candidates at once), over the 79 KB cap. `impulseStart`/`impulseEnd` were dropped from the payload as redundant (see `lib/patternLifecycle.js` `identifyCandidate` - `impulseStart` is `candidateId`'s own last segment, `impulseEnd` is always `firstDetectedAt` minus one candle) and `CANDLE_LIMITS` on 1m/3m/5m went 24 → 20; default settled at ~75.3 KB (77068 B measured), build ~840 ms.
- `compact: true`: every `timeframes.<tf>.candles` becomes `[]`; indicator summaries stay; `mark` narrows to `{price, driftBps, status}` (schema 1.16.0).
- Unknown values are ignored with one `payload controls: ...` line in `warnings`, never rejected. If every requested value is unknown the filter is treated as absent. These warnings are added after `dataStatus` is computed and do not change it.
- Measured 2026-09-23 (F1), live BTC/SOL/ETH: full ~75.3 KB (77068 B), compact ~38.9 KB (39831 B). The builder logs a soft warning above 80 KB.
- Measured 2026-09-23 (review fix pass, schema 1.15.0), live BTC/SOL/ETH: default 76,889 B (was 84,095 B measured before the pass; 82,463 → 77,011 B on one identical live snapshot), compact 41,899 B, `include=model` alone 33,005 B, full build with model 104,531 B; build ~725 ms live. Saved fixture `test/fixtures/history/2026-09-23`: default 76,586 B, compact 41,440 B. `test:scalp` asserts default ≤ 79,000 B and compact ≤ 45,000 B on that fixture.
- Measured 2026-09-23 (P1 Pyth mark, schema 1.16.0): saved fixture with injected ok marks default 77,063 B (+477 B vs 76,586), compact 41,658 B (+218 B). Live BTC/SOL/ETH with marks ok: default 75,814 B, compact 40,635 B (pre-P1 live on the same afternoon: 75,921 / 41,001 B, different market snapshot). Build ~533–736 ms live (pre-P1 531–789 ms): the Hermes read runs alongside the candle fetches.

### Confirmation chart (Phase 8b)

- `chart: "BTC:1m"` (REST `?chart=BTC:1m`): one PNG, 900×500, of that symbol/timeframe, rendered by `lib/chartRender.js` (pure JS, `pureimage`, bundled `assets/fonts/IBMPlexMono-Regular.ttf`, OFL). Never in the default response.
- MCP: `content` = `[text summary + " chart=BTC:1m", {type:"image", mimeType:"image/png", data}]`, `structuredContent` as usual. REST: `200 image/png` instead of JSON. REST auth unchanged; the param is read after auth.
- One chart per call. Two charts, an unknown symbol/timeframe, or a malformed value: MCP `isError`, REST 400 JSON. No candles for that timeframe in the build: MCP `isError`, REST 503. Rejected before the build runs.
- Draws the published candle window, EMA21/EMA200, horizontal zones (bands), diagonals, channel, candidate flag levels (dashed). 1m/3m/5m: candles + EMAs + candidate only.

## Payload schema 1.17.0

Field-level definitions live in `openapi/scalp-context.yaml`. This is the map.

Top level: `schemaVersion`, `configVersion`, `config`, `generatedAt`, `closedThrough`, `sessionTimezone`, `dataStatus` (complete | partial | unavailable), `account`, `symbols{BTC,SOL,ETH}`, `warnings[]`, `requestId` (MCP only).

`config` (Phase 5): snapshot of tunables from `config/engine.json` — `scalp.maxStopDistancePct`, `riskReward.bySetupType/byStrategy`, `risk.*`, `flag.includeFailed`.

`account`: `status` (available | partial | disabled | unavailable), `reason`, `address` (masked), `fetchedAt`, `margin{usd, byAsset}` (USDC/USDT = risk capital and P&L base), `holdings[]`, `holdingsUsd` (exposure, not P&L), `unpriced[]`, `gas{sol, minSol, sufficient}`, `performance{baselineUsd, netPnlUsd, returnPct, source}`. Unavailable is never zero. Never affects `dataStatus`.

`symbols.<SYM>`, in key order: `price`, `mark` (schema 1.16.0), `source{provider, pair, fetchedAt}`, `structure{sessionHigh, sessionLow, prevDayHigh, prevDayLow, swingHighs[5], swingLows[5], support[3], resistance[3], aboveEma21, aboveEma200}`, `timeframes{1m,3m,5m,15m,1h,4h,1d}`, `strategies{SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP}`, `bestSignal`, `candidateSetups[]`, `geometryContext`, `decisionTrace`, `flagTradePlan`, `flagRecommendation`, then with `include=bias` only: `biasMatrix`, `alignment[]`, `decisionInputs`, `topDown`; with `include=model` only: `model`.

`mark` (schema 1.16.0, P1, `lib/pythMark.js`): `{price, conf, publishTime, source: "pyth", ageSec, driftBps, status}`. Live Pyth price (Hermes, one request for all symbols, Bearer `PYTH_API_KEY`) beside `price`, which stays the closed 1m candle close. Jupiter perps mark, stop and liquidate on Pyth, so stops/Thesis Eliminated/liquidation are checked against `mark.price`. `driftBps` = (mark.price − price) / price × 10000, 1 decimal (null when `price` is null). `status`: `ok` | `stale` (`ageSec` > `config/engine.json` `mark.pyth.maxAgeSec`, 30) | `unavailable` (no key, HTTP error, timeout, feed missing; every other field null). Unavailable never changes `dataStatus` and adds no warning (same rule as `account`). Builds with injected candles (tests, replay) get `unavailable` and make no request: a live mark beside historical candles is wrong. Compact: `{price, driftBps, status}`.

`timeframes.<tf>`: `candles[]` (closed only; 20 for 1m/3m/5m (F1, was 24), 20 for 15m/1h (review fix pass, was 24), 20 for 4h, 10 for 1d; compute runs on up to 499 regardless - `CANDLE_LIMITS` is payload-only), `ema21`, `ema200`, `priceVs21Pct`, `priceVs200Pct`, `trend`, `stochRsi{k, d, state, cross, slopeK, slopeD}`, `closedThrough`, `candleCount`.

`strategies.<NAME>` canonical: `valid`, `direction` (long | short | NO_TRADE), `confidence` 0–100, `reason`, `entryZone{min,max}`, `stopLoss`, `invalidationLevel`, `stopSource` (5m | 15m | 4h | percentage | null), `targets[]`, `riskReward{tp1RR, tp2RR}`, `entryType`, and on valid signals `risk` (Phase 3). Invalid → NO_TRADE, all levels null, targets empty.

`risk` (Phase 3, valid strategies and triggering/confirmed candidates): `maxLeverage`, `suggestedLeverage`, `lossAtStopUsd`, `lossAtStopPct`, `lossAtStopPctOfWallet`, `collateralUsd`, `reason` (null when the numbers are populated).

`candidateSetups[]` (Phase 4, F1 flag detection coverage): flag candidates on 1m/3m/5m, long and short, independent of `strategies` and `bestSignal`. `timeframe`, `type: flag`, `direction`, `state` (schema 1.12.0: `proto` | `forming` | `triggering` | `confirmed` | `expired` | `failed`), `impulseStrength`, `compressionScore`, `flagHigh`, `flagLow`, `breakoutLevel`, `invalidation`, `measuredTarget`, `measuredRR` (schema 1.11.0, trading-model quick pass Q1: pole-length projection from `breakoutLevel`; a major level in front of it takes priority as the real TP1), `ema200Side` (schema 1.11.0, Q2: `above`/`below`/`null`, never filters), `ema21Hold` (schema 1.12.0 adds `reclaim`: the flag's first candle was off-side of EMA21 but reclaimed it within `flag.reclaimCandles`), `confidence`, `chaseRisk` (always `true` on an `expired` candidate), `flagSlope`, `breakoutDistancePct`, `invalidationDistancePct` (schema 1.12.0, cheap geometry: least-squares slope of the flag's own closes and signed percent distance from the last close), `candidateId`, `firstDetectedAt` (schema 1.12.0, stable identity derived from this request's own candle window - no stored state; `impulseStart`/`impulseEnd` are not separately published, see `lib/patternLifecycle.js` `identifyCandidate`), `failedAt` (schema 1.12.0, failed only), `qual` (schema 1.12.0: `{quality, decision, reasons}`, every candidate flag or coil - see below), `risk`. A `failed` candidate is dropped from the default payload unless `config.flag.includeFailed` **or** it is still inside `flag.failedTtlCandles` of its own timeframe (it then carries `failReason`/`failedAt` regardless); older failures follow `includeFailed` as before. Schema 1.15.0: a published `failed` candidate carries only `timeframe`, `type`, `direction`, `state`, `failReason`, `failedAt`, `candidateId`, `breakoutLevel`, `invalidation`, `confidence`, `qual` (`slimFailedCandidates`; `decisionTrace` tokens unchanged; the replay harness builds with `slimFailed: false`). A `confirmed` flag more than `flag.maxBreakoutAge` candles past its break reads `expired` for `flag.expiredTtlCandles` more, then is not found at all.

`candidateSetups[].qual` (F1 item 8, `lib/candidateQualifier.js`, every candidate): `quality` (low | med | high, banding the candidate's own `confidence`), `decision` (watch | wait | dont | actionable - never a probability of profit; proto/forming → watch, triggering → wait, failed/expired → dont, confirmed with no blocking reason → actionable else wait), `reasons[]` (`conflict:<tf>-<dir>`, `stoch:ob-cross`/`stoch:os-cross`, `room:blocked-<tf>` (schema 1.17.0: only the candidate's mapped geometry timeframe, `geometryTimeframeFor`, 1m/3m/5m → 15m), `ema200:counter`, `ct:4h`, `chase`, `rr:<x>` - built only from data already elsewhere in the payload, never a new detection signal).

`flagTradePlan` (schema 1.13.0, `lib/flagTradePlan.js`, signal-reliability minimum plan): the one trade call built from the symbol's confirmed directional flag candidates (`type: flag`, `state: confirmed` only - coils and proto/forming/triggering/failed/expired stay observation-only). `null` when none exists this build; otherwise `candidateId`, `planId`, `timeframe`, `direction`, `status` (ready | conditional | rejected), `reasonCode` (null only when `ready`; `awaiting_breakout`/`awaiting_retest` when `conditional` - schema 1.15.0 renamed `awaiting_retest_hold` to `awaiting_retest`; stable rejection codes when `rejected`), `entryType` (`retest`), `entryCondition` (breakout-then-retest-hold text, entry rounded to 2 decimals), `entry`, `stop`, `tp1`, `tp2`, `grossRR` (schema 1.17.0), `netRR`, `stopDistancePct`. Schema 1.17.0 (owner decision 1a): the gate is gross price R, `grossRR = |tp1 − entry| / |entry − stop|` ≥ `flagPlan.minRR` (3.0), else rejected `rr_below_min` (was `net_rr_below_3`); `netRR` after `config.risk` fees/slippage is information only and never rejects. Schema 1.15.0: `ready` requires an earlier closed candle that closed through the breakout level, then the latest closed candle's low (high for a short) within `flagPlan.entryToleranceAtr` ATR of the level and a close on the hold side; the breakout candle alone is `conditional`/`awaiting_retest`. Selection is deterministic: ready before conditional before rejected, then highest detector `confidence`, higher candidate timeframe, stable `candidateId`.

`flagRecommendation` (schema 1.15.0, `lib/flagRecommendation.js`): compact 21/200 decision record `{class, setupId, candidateId, asOf, primaryReason{code,text}, readiness, qualityBand, policyVersion, supports[codes], opposes[codes], unknowns[codes], changeConditions[{code,text}], trace}` - no `refs`, no `factorStates` (the full record is `model.recommendation`). Classes are `GOOD`, `WATCH`, `BAD`, `DATA_UNAVAILABLE`; a symbol with `price: null` is `DATA_UNAVAILABLE`, and with no plan a missing/stale 1m/3m/5m series is `DATA_UNAVAILABLE` with `unknowns` like `stale_data:1m`. The R:R floor is `flagPlan.minRR` only (renamed from `minNetRR` in 1.17.0). Schema 1.17.0: `rr_below_min` is BAD; a ready/conditional plan carries support `rr_ok` and, when `netRR` < `minRR`, the non-blocking oppose `net_rr_low` (fees eat the edge) - net R:R never makes it BAD. The recommendation consumes `flagTradePlan` and model evidence; it never recalculates levels/R:R and never treats legacy `bestSignal` as the 21/200 recommendation.

`model` (schema 1.15.0, `include=model`, `lib/modelEvidence.js`): bulky evidence behind `flagRecommendation`: `flags[]` including 15m/1h/4h detector reads, `ma.map` for EMA21/EMA200 value/side/distance/slope/provenance, `channels` with levels ahead and breakout risk (a fade against sentiment at the channel edge is `high`; no direction → `unknown` and no levels ahead), `divergence` from Stoch RSI pivot confirmation (Stoch history aligned to the candle series' end; most recent pivot pair wins; stale divergences not counted in confluence), and `recommendation` (the full recommendation record with refs and factorStates). Omitted by default for payload size.

`geometryContext.<tf>` (Phases 7–8; 15m, 1h, 4h by default, `null` when a timeframe lacks enough candles): `atr`, `atrPct`, `structure` (up | down | range), `higherLows`, `lowerHighs`, `horizontalSupportZones[]`, `horizontalResistanceZones[]`, `roomToNextSupport`, `roomToNextResistance`, `extensionRisk`, `ema21Slope`, `stochAccelK`, `confidence`, `diagonalSupport`, `diagonalResistance`, `channel`, `confluenceZones[]`.

`decisionTrace` (Phase 2): `configVersion`, `evaluatedAt`, `strategies[]` (`name`, `ran`, `valid`, `rejectedAt`, `reason` per strategy), `bestSignal`, `bestSignalReason`, `window` (per-timeframe `{to, closedCandles}`; Phase 11 dropped `from`, the oldest candle's open time), `candidateSetups[]` (`"1m:long:confirmed"` strings; schema 1.12.0 adds the `proto` and `expired` states, e.g. `"1m:long:proto"`, `"5m:short:expired"`; a failed one adds its `failReason`, `"5m:short:failed:stale"`, Phase 9b - unaffected by the default payload's `failedTtlCandles`/`includeFailed` gating, so a hidden failure is still named here), `geometry[]` (`"1h:up:0.42:0.18:low"` strings, room values rounded to 2 decimals as of Phase 11; a missing individual field is an empty position, `"1h:up::0.18:"`; a timeframe with no geometry at all is one token, `"1h:na"`), `needsVisualConfirmation`, `visualTarget`, `unresolvedGeometry[]` (Phase 9 visual gate; since 9b a near-miss diagonal alone never raises it and `visualTarget` prefers triggering/confirmed), `bias` (Phase 9b, `"scalp:L14,S16,N70|swing:L74,S0,N26|tf:1m=S,…,1d=L|ct:2"`, ≤ 120 bytes through schema 1.10.0; schema 1.11.0 appends up to two more tokens, `"|td:bull:3/4|a200:5/7"` — see `topDown` below; schema 1.16.0 appends `"|mark:<driftBps>"` or `"|mark:na"`, under 12 chars, e.g. `"|mark:1.2"`).

`biasMatrix.<tf>` (Phase 9b, opt-in): `bias` (long | short | neutral), `strength` 0–100, `basis[]` for 1m…1d. `alignment[]`: per non-failed candidate and valid strategy, `source`, `ref`, `direction`, `executionTf`, `contextTfs`, `withTrend`, `counterTrend`, `htfBias`, `htfBiasStrength`, `nearestHtfZoneDistancePct` (nearest HTF zone ahead: resistance for a long, support for a short), `room` (in that timeframe's ATR), `roomTooSmall`. `decisionInputs.directionalBias{scalp, swing}`: `{long, short, neutral}` summing to 100. Inputs for the GPT's own allocation; the API never emits GO IN / HOLD / DON'T.

`topDown` (schema 1.11.0, opt-in, trading-model quick pass Q3, M-1/M-2/M-6b): `sentiment` (bull | bear | mixed) from a weighted vote over `leans.{1w,1d,4h,1h}` (config `model.topDownWeights`; higher timeframes dominate), `aligned` (0-4, how many leans agree with `sentiment`), `score` (0-1 conviction), `leans{1w,1d,4h,1h}` (bull | bear | neutral each), `weekly{close, ema21, ema21Slope, ema200: null, reason}` (1W derived from the already-fetched 1D candles, Monday-aligned weeks; weekly EMA200 is always null - not enough weekly history exists - with a reason), `above200{count, of, weighted}` (of the timeframes with an EMA200, 1m-1D, how many sit above it; mirror `below200` is `of - count`). Never gates or changes a strategy, candidate, or confidence.

### Coming in Phase 8b (in progress)

Optional `chart: "BTC:1m"` tool arg / `?chart=BTC:1m` query returns exactly one server-rendered PNG (MCP `image` content block; REST `image/png`). Absent `chart`, responses stay byte-identical. See the master plan, Phase 8b. Update this section when it lands.

## Scalp stop-distance policy (`services/strategy.js`)

- `MAX_SCALP_STOP_DISTANCE_PCT` = `config/engine.json` `scalp.maxStopDistancePct` (3). `validateScalpStopDistance(entry, stop)` measures from the entry mid with `1e-9` epsilon.
- `applyScalpStopPolicy()` builds the stop via `calculateSLTP(..., 'Scalp', ...)` and enforces the gate. Both `SCALP_1H` (PRIORITY 4 in `evaluateStrategy`) and `evaluateMicroScalp` route through it. Rejection → canonical NO_TRADE with reason `Setup rejected: scalp stop distance X% exceeds 3.00% maximum`.
- Percentage fallback: for `setupType === 'Scalp'` anchors at the entry mid so it lands exactly at the policy distance. If the mid-anchored stop cannot clear the entry zone (zone wider than 3%), it falls to the edge anchor, which the gate rejects → NO_TRADE. Swing / 4H / TrendRider keep the original edge anchor, unchanged.
- MICRO_SCALP rejection sets `result.reason`; `evaluateAllStrategies` surfaces it over the generic "conditions not met".
- `normalizeToCanonical` carries `stopSource`, nulls it on invalid signals. SCALP_1H raw signal emits it.
- Tests: section 6b of `test-strategy-sltp.js` drives `evaluateStrategy` and `evaluateMicroScalp` directly, long + short × wide / tight / no-structure. Mutation check: disabling either guard fails two tests. Fallback-anchor revert fails seven.

## Security boundary

- `services/editTradesMcp.js` and `lib/mcpHttp.js` import only from `services/scalpContext.js` (`buildScalpContext`, `filterPayload`). No execution, position, or signing-wallet module reachable.
- `walletTracker.js` reads a public address over JSON-RPC; no keypair.
- Logs: `requestId`, method, status, duration, reason code, payload bytes, build duration only. No RPC URL, bearer, or upstream error text.
- Env var names not spelled in MCP sources; `test:mcp` greps for leaks.
- MCP has no network auth. A private GPT/plugin listing is UI privacy, not authentication.
- Trade execution stays behind `TRADE_EXECUTION_ENABLED` + `TRADE_EXECUTION_API_KEY`, separate from market-context auth. Never register an execution tool in MCP.

## Environment (Vercel production)

| Var | Purpose |
| --- | --- |
| `SCALP_CONTEXT_API_KEY` | REST Bearer |
| `TRACKED_WALLET_ADDRESS` | Public Solana address to inspect |
| `SOLANA_RPC_URL` | Read-only RPC |
| `ACCOUNT_BASELINE_USD` | Starting stablecoin margin for P&L |
| `PYTH_API_KEY` | Hermes Bearer for `mark` (P1); missing → `mark.status: unavailable` |

Missing wallet vars → `account.status: disabled`, market data unaffected. Missing `PYTH_API_KEY` → every `mark.status: unavailable`, no Hermes request, market data unaffected.

## Production verification (2026-09-22, first deploy, schema 1.1.0)

| Check | Result |
| --- | --- |
| REST no auth / bad key / POST / auth GET | 401 / 401 / 405 / 200 |
| dataStatus | complete, 0 warnings, no NaN/Infinity/undefined |
| account.status | available, margin reported |
| MCP initialize | 200, server `edittrades` |
| MCP tools/list | exactly one tool, `readOnlyHint: true` |
| MCP tools/call | 200, summary + `structuredContent` with BTC/SOL/ETH + account |
| BTC SCALP_1H | rejected, stop 6.18% > 3.00% |
| SOL / ETH SCALP_1H | valid, sub-1% stops (at first deploy) |

Not observed live: `stopSource` on a valid SCALP_1H, MICRO_SCALP guard. Covered by tests only.

Spot check 2026-09-22 evening, schema 1.8.0 live: REST no auth 401, POST 405; MCP `tools/list` one tool, `readOnlyHint: true`; `tools/call {}` → `schemaVersion` 1.8.0, `configVersion` 2026.09.22-6, `dataStatus` complete, geometry B fields present, ~78 KB response. Authed REST 200 not re-checked in this pass.

## Verify after any redeploy

```bash
U=https://snapshottradingview.vercel.app
curl -s -o /dev/null -w "%{http_code}\n" $U/api/scalp-context                       # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $KEY" $U/api/scalp-context   # 200
curl -s -H "Authorization: Bearer $KEY" $U/api/scalp-context | jq -r .schemaVersion           # 1.8.0
curl -s -X POST $U/api/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                                # one tool
```

## Open items

- Phase 8b (confirmation chart) in progress; then 9, 9b, 10, 11, 8c, 3b per the master plan.
- Re-run the Custom GPT `SIGNAL` workflow once through the REST Action, with the updated `openapi/scalp-context.yaml` re-imported.
- `vercel.json` still routes `/api/trade-status/*` to `api/trade-status.js`, which does not exist (falls to a 404 on Vercel).
- `public/index.html` dashboard edits are separate user work.

## Work log

| Date | What |
| --- | --- |
| 2026-09-21 | Connector, wallet tracker, MCP dispatcher built. Blocker found: 3% guard rejected its own percentage fallback (edge-anchored 3% measured from mid ≈ 3.1–3.3%). MICRO_SCALP had no guard. |
| 2026-09-22 | Fallback re-anchored at mid for Scalp only. Shared `applyScalpStopPolicy` wired into SCALP_1H and MICRO_SCALP. Call-path tests added and mutation-verified. JSDoc placement fixed. Dead SCALP_1H branch in 4H block removed. `stopSource` published on SCALP_1H. Two prod deploys, verified. Wallet env vars added to Vercel by user. |
| 2026-09-22 | Engine phases 0–8: config + `configVersion`, `decisionTrace`, risk engine, flag detector + `candidateSetups`, compute-depth assertion, payload controls (tool args), geometry A and B. Schema 1.1.0 → 1.8.0, live in production. |
| 2026-09-23 | F1 (flag detection coverage, `docs/PLAN_FLAG_DETECTION_COVERAGE.md`, single implementer pass): proto state, `maxImpulseCandles` 8→20, EMA21 reclaim, failed-visible-for-`failedTtlCandles`, `expired` state, stable `candidateId`/`firstDetectedAt`, cheap geometry fields, `qual` qualification layer (`lib/candidateQualifier.js`, new module). `CANDLE_LIMITS` 1m/3m/5m 24→20 to hold the payload under budget. Schema 1.11.0 → 1.12.0, configVersion → 2026.09.23-1. Not deployed. |
| 2026-09-23 | Signal-reliability minimum plan (single implementer pass): a confirmed flag candidate, `qual.actionable`, was never a trade - no exact entry, no fees-adjusted R:R, no staleness gate. Added `lib/freshness.js` (pure closed-candle freshness gate, one interval + grace) and `lib/flagTradePlan.js` (the one engine-owned flag trade plan per symbol: ready/conditional/rejected + reasonCode, entry/stop/tp1/tp2/entryCondition, net R:R after `config.risk` fees/slippage, deterministic selection across candidates), wired into `services/scalpContext.js` as `symbols.<SYM>.flagTradePlan` - additive only, `strategies`/`bestSignal` byte-identical, 4h-flat lean never gates it. Fixed `scripts/replay-outcomes.js`'s `walkOutcome`: unfavorable zone-edge fill (was the zone midpoint) and no same-candle fill+target win credit (the false-intrabar-win bug); added gross ready-level diagnostics alongside the existing replay output. Added `scripts/paper-ledger.js` (local, append-only `record`/`score` CLI; never account data; refuses duplicate plan ids). GPT instructions: added `flagTradePlan=trade authority` (CANDIDATES) and `trades = signals.` (COMMANDS), funded by tightening existing wording - see `docs/GPT_INSTRUCTIONS.md`'s own change log. Schema 1.12.0 → 1.13.0, configVersion → 2026.09.23-2. New suites `test:freshness`/`test:flagplan`/`test:ledger`; `test:replay` 31 → 35. Not deployed. |
| 2026-09-23 | 21/200 decision clarity follow-on: fixed retest readiness to require a closed-candle hold, made ready outrank conditional, relabeled replay/ledger scoring as gross ready-level diagnostics, added `lib/modelEvidence.js`, `lib/flagRecommendation.js`, `symbols.<SYM>.flagRecommendation`, opt-in `include=model`, docs `TRADING_MODEL_DECISION_CONTRACT.md` and `FLAG_RECOMMENDATION_REVIEW_SHEET.md`, and GPT schema 1.14.x language. Schema 1.13.0 → 1.14.0, configVersion → 2026.09.23-3. New suite `test:flagrec`. Not deployed. |
| 2026-09-23 | Review fix pass: flag plan `ready` = breakout close then retest-hold close (`awaiting_retest` replaces `awaiting_retest_hold`); Stoch history offset, most-recent divergence, stale divergence out of confluence; fade breakoutRisk `high`, no direction `unknown`; price-null / stale-flag-timeframe `DATA_UNAVAILABLE`; compact default `flagRecommendation` (full record under `model.recommendation`), slim failed candidates, 15m/1h candles 24 → 20, fixture byte-cap test; ledger id includes status + reasonCode; ready plans prefilled at the ready close in replay/ledger (gross R); `minNetRR` only in `flagPlan`. Schema 1.14.0 → 1.15.0, configVersion → 2026.09.23-4. Tests: scalp 109 → 113, flagplan 35 → 40, flagrec 12 → 17, ledger 10 → 12, replay 35 → 36, new `test:evidence` 8; others unchanged (sltp 50, mcp 52, wallet 28, config 14, risk 24, pattern 32, geometry 36, chart 18, bias 15, topdown 15, freshness 10). Not deployed. |
| 2026-09-23 | P1 Pyth mark (`docs/PLAN_PYTH_MARK_PRICE.md`): new `lib/pythMark.js` (one Hermes `/v2/updates/price/latest` request for all symbols, Bearer `PYTH_API_KEY`, 4 s timeout, never throws, key/URL never logged); `symbols.<SYM>.mark` beside `price` (`price` unchanged), `decisionTrace.bias` `|mark:<driftBps>`/`|mark:na`, compact mark `{price, driftBps, status}`; `mark.pyth` config block (feed ids, maxAgeSec 30, timeoutMs 4000). Schema 1.15.0 → 1.16.0, configVersion → 2026.09.23-5. Tests: scalp 113 → 117, new `test:mark` 12; others unchanged. Not deployed. |
| 2026-09-23 | Owner decisions 1a + 4a (`docs/OWNER_DECISIONS_2026-09-23.md`): `flagTradePlan.grossRR` published, plan gate on gross R:R ≥ `flagPlan.minRR` (renamed from `minNetRR`), reasonCode `rr_below_min` replaces `net_rr_below_3`, `netRR` information only; recommendation `rr_ok` support + non-blocking `net_rr_low` oppose, net never BAD; `room:blocked` reads only the candidate's mapped geometry timeframe. Schema 1.16.0 → 1.17.0, configVersion → 2026.09.23-6. Tests: flagplan 42 → 43, flagrec 17 → 18, pattern 32 → 33; others unchanged (sltp 50, scalp 117, mcp 52, wallet 28, config 14, risk 24, geometry 36, chart 18, replay 36, bias 15, topdown 15, freshness 10, ledger 12, evidence 8, mark 12). Live default 75,102 B, compact 39,948 B. Not deployed. |
