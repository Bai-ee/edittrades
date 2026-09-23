# EditTrades MCP Connector and Scalp Stop-Distance Guard

Last updated: 2026-09-23 (F1, flag detection coverage)
Branch: `upgrade-signal-engine`
Payload: `schemaVersion` 1.8.0, `configVersion` 2026.09.22-6 live; 1.12.0 / 2026.09.23-1 local (Phases 9, 10, 9b, trading-model quick pass Q1-Q3, F1 flag detection coverage), not deployed
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
| `services/scalpContext.js` | Builds the payload: timeframes, strategies, `decisionTrace`, risk blocks, `candidateSetups`, `geometryContext`, config snapshot, `account`; `filterPayload` |
| `services/strategy.js` | Strategy engine and the scalp stop-distance policy (see below) |
| `config/engine.json`, `config/engine.js` | Versioned, frozen engine constants; `configVersion` (Phase 1) |
| `lib/riskEngine.js` | Leverage cap from stop distance, loss at stop (Phase 3) |
| `lib/patternDetector.js` | 1m/3m/5m flag detector, long and short (Phase 4); proto/reclaim/expired states, cheap geometry fields (F1) |
| `lib/patternLifecycle.js` | Geometry snap, coil resolution, visual gate (Phase 9); `identifyCandidate` stable identity (F1) |
| `lib/candidateQualifier.js` | Trade qualification (`qual`: quality/decision/reasons) layered on candidates, never a detection input (F1) |
| `lib/geometry.js` | Pivots, horizontal zones, ATR, room, EMA slope, diagonals, channel, confluence (Phases 7–8) |
| `services/walletTracker.js` | Read-only tracked wallet: margin, holdings, gas, performance. No keypair. |
| `openapi/scalp-context.yaml` | REST Action schema for the Custom GPT (source of truth for field-level detail) |
| `CHATGPT_ACTION_SETUP.md` | REST Action setup |

Tests:

| Command | File | Passing (2026-09-23, F1) |
| --- | --- | --- |
| `npm run test:sltp` | `test-strategy-sltp.js` (section 6b = call-path guard tests) | 50 |
| `npm run test:scalp` | `test-scalp-context.js` | 108 |
| `npm run test:mcp` | `test-edittrades-mcp.js` | 52 |
| `npm run test:wallet` | `test-wallet-tracker.js` | 28 |
| `npm run test:config` | `test-engine-config.js` | 14 |
| `npm run test:risk` | `test-risk-engine.js` | 24 |
| `npm run test:pattern` | `test-pattern-detector.js` (fixtures `test/fixtures/flagFixtures.js`) | 32 |
| `npm run test:geometry` | `test-geometry.js` (snapshot `test/fixtures/geometryPhase7Snapshot.json`, builders `test/fixtures/geometryFixtures.js`) | 36 |
| `npm run test:chart` | `test-chart-render.js` (sample `test/fixtures/chart-sample-btc-4h.png`) | 18 |
| `npm run test:replay` | `test-replay.js` (replay harness, metrics, miss log `test/fixtures/misses/`, outcome scoring, MISS_003) | 31 |
| `npm run test:bias` | `test-bias-matrix.js` (bias matrix, alignment, decision inputs, mirrors, td:/a200: trace grammar) | 15 |
| `npm run test:topdown` | `test-top-down.js` (weekly aggregation/lean, top-down vote, above/below-200; trading-model quick pass Q3) | 15 |

The first four are the deploy gate; the rest are the per-module suites added by the engine phases. Run all twelve before a deploy.

Replay (Phase 10, dev only, never on the request path): `npm run replay -- --capture BTC,SOL,ETH --out test/fixtures/history/<date>/ [--backfill-1m 360]` saves a live pull; `npm run replay -- --history <dir> --symbols BTC --out btc.jsonl` runs `buildScalpContext()` once per closed candle with no lookahead; `npm run replay:metrics -- btc.jsonl` prints candidate counts, visual-gate rate by code, lifetime and label precision/recall; `npm run replay:outcomes -- btc.jsonl <historyDir>` (trading-model quick pass Q4) walks the same JSONL forward on 1m candles and scores every valid strategy signal and confirmed flag candidate: fill rate, win rate, average win R, expectancy, max losing streak, median time to TP1. Details: master plan, Phase 10; `docs/PLAN_TRADING_MODEL_QUICK_PASS.md` Q4.

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
- `include` tokens: `timeframes`, `strategies`, `candidates` (→ `candidateSetups`), `geometry` (→ `geometryContext`), `trace` (→ `decisionTrace`), `account`, `config`, `bias` (→ `biasMatrix`, `alignment`, `decisionInputs`, `topDown`; Phase 9b, `topDown` schema 1.11.0). `price`, `source`, `structure`, `bestSignal` are always kept.
- `bias` is opt-in, unlike the other tokens: the bias objects are only built into the response when `include` lists `bias` (REST/MCP then call `buildScalpContext({ includeBias: true })`). Without it the only bias field is `decisionTrace.bias`. Measured 2026-09-22 on the replay capture: default 76.2 KB, default + bias 78.9 KB. Phase 11's `decisionTrace.window`/`geometry` string trims recovered 729 bytes off the default 3-symbol payload (76.2 KB → 75.4 KB, 78.9 KB → 78.2 KB with bias; target was ≥ 600 bytes). Prefer `compact` with `bias`. 2026-09-23: live default had grown to ~81.3 KB with busier markets; published candles on 1m/3m/5m went 30 → 24 (`CANDLE_LIMITS`, payload only, the engine still computes on the full closed window) and candle volume `v` rounds to 2 decimals → live default 74.3 KB.
- 2026-09-23 (F1, flag detection coverage): schema 1.12.0 added `qual`, `candidateId`, `firstDetectedAt`, `failedAt`, `flagSlope`, `breakoutDistancePct`, `invalidationDistancePct` to every flag candidate, plus the new `proto`/`expired` states and more candidates surviving longer (failedTtlCandles/expiredTtlCandles) - live default before any trim ranged ~79.3-83.3 KB with busier markets (multiple 1m/3m/5m proto/forming/failed candidates at once), over the 79 KB cap. `impulseStart`/`impulseEnd` were dropped from the payload as redundant (see `lib/patternLifecycle.js` `identifyCandidate` - `impulseStart` is `candidateId`'s own last segment, `impulseEnd` is always `firstDetectedAt` minus one candle) and `CANDLE_LIMITS` on 1m/3m/5m went 24 → 20; default settled at ~75.3 KB (77068 B measured), build ~840 ms.
- `compact: true`: every `timeframes.<tf>.candles` becomes `[]`; indicator summaries stay.
- Unknown values are ignored with one `payload controls: ...` line in `warnings`, never rejected. If every requested value is unknown the filter is treated as absent. These warnings are added after `dataStatus` is computed and do not change it.
- Measured 2026-09-23 (F1), live BTC/SOL/ETH: full ~75.3 KB (77068 B), compact ~38.9 KB (39831 B). The builder logs a soft warning above 80 KB.

### Confirmation chart (Phase 8b)

- `chart: "BTC:1m"` (REST `?chart=BTC:1m`): one PNG, 900×500, of that symbol/timeframe, rendered by `lib/chartRender.js` (pure JS, `pureimage`, bundled `assets/fonts/IBMPlexMono-Regular.ttf`, OFL). Never in the default response.
- MCP: `content` = `[text summary + " chart=BTC:1m", {type:"image", mimeType:"image/png", data}]`, `structuredContent` as usual. REST: `200 image/png` instead of JSON. REST auth unchanged; the param is read after auth.
- One chart per call. Two charts, an unknown symbol/timeframe, or a malformed value: MCP `isError`, REST 400 JSON. No candles for that timeframe in the build: MCP `isError`, REST 503. Rejected before the build runs.
- Draws the published candle window, EMA21/EMA200, horizontal zones (bands), diagonals, channel, candidate flag levels (dashed). 1m/3m/5m: candles + EMAs + candidate only.

## Payload schema 1.12.0

Field-level definitions live in `openapi/scalp-context.yaml`. This is the map.

Top level: `schemaVersion`, `configVersion`, `config`, `generatedAt`, `closedThrough`, `sessionTimezone`, `dataStatus` (complete | partial | unavailable), `account`, `symbols{BTC,SOL,ETH}`, `warnings[]`, `requestId` (MCP only).

`config` (Phase 5): snapshot of tunables from `config/engine.json` — `scalp.maxStopDistancePct`, `riskReward.bySetupType/byStrategy`, `risk.*`, `flag.includeFailed`.

`account`: `status` (available | partial | disabled | unavailable), `reason`, `address` (masked), `fetchedAt`, `margin{usd, byAsset}` (USDC/USDT = risk capital and P&L base), `holdings[]`, `holdingsUsd` (exposure, not P&L), `unpriced[]`, `gas{sol, minSol, sufficient}`, `performance{baselineUsd, netPnlUsd, returnPct, source}`. Unavailable is never zero. Never affects `dataStatus`.

`symbols.<SYM>`, in key order: `price`, `source{provider, pair, fetchedAt}`, `structure{sessionHigh, sessionLow, prevDayHigh, prevDayLow, swingHighs[5], swingLows[5], support[3], resistance[3], aboveEma21, aboveEma200}`, `timeframes{1m,3m,5m,15m,1h,4h,1d}`, `strategies{SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP}`, `bestSignal`, `candidateSetups[]`, `geometryContext`, `decisionTrace`, then with `include=bias` only: `biasMatrix`, `alignment[]`, `decisionInputs`, `topDown`.

`timeframes.<tf>`: `candles[]` (closed only; 20 for 1m/3m/5m (F1, was 24), 24 for 15m/1h, 20 for 4h, 10 for 1d; compute runs on up to 499 regardless - `CANDLE_LIMITS` is payload-only), `ema21`, `ema200`, `priceVs21Pct`, `priceVs200Pct`, `trend`, `stochRsi{k, d, state, cross, slopeK, slopeD}`, `closedThrough`, `candleCount`.

`strategies.<NAME>` canonical: `valid`, `direction` (long | short | NO_TRADE), `confidence` 0–100, `reason`, `entryZone{min,max}`, `stopLoss`, `invalidationLevel`, `stopSource` (5m | 15m | 4h | percentage | null), `targets[]`, `riskReward{tp1RR, tp2RR}`, `entryType`, and on valid signals `risk` (Phase 3). Invalid → NO_TRADE, all levels null, targets empty.

`risk` (Phase 3, valid strategies and triggering/confirmed candidates): `maxLeverage`, `suggestedLeverage`, `lossAtStopUsd`, `lossAtStopPct`, `lossAtStopPctOfWallet`, `collateralUsd`, `reason` (null when the numbers are populated).

`candidateSetups[]` (Phase 4, F1 flag detection coverage): flag candidates on 1m/3m/5m, long and short, independent of `strategies` and `bestSignal`. `timeframe`, `type: flag`, `direction`, `state` (schema 1.12.0: `proto` | `forming` | `triggering` | `confirmed` | `expired` | `failed`), `impulseStrength`, `compressionScore`, `flagHigh`, `flagLow`, `breakoutLevel`, `invalidation`, `measuredTarget`, `measuredRR` (schema 1.11.0, trading-model quick pass Q1: pole-length projection from `breakoutLevel`; a major level in front of it takes priority as the real TP1), `ema200Side` (schema 1.11.0, Q2: `above`/`below`/`null`, never filters), `ema21Hold` (schema 1.12.0 adds `reclaim`: the flag's first candle was off-side of EMA21 but reclaimed it within `flag.reclaimCandles`), `confidence`, `chaseRisk` (always `true` on an `expired` candidate), `flagSlope`, `breakoutDistancePct`, `invalidationDistancePct` (schema 1.12.0, cheap geometry: least-squares slope of the flag's own closes and signed percent distance from the last close), `candidateId`, `firstDetectedAt` (schema 1.12.0, stable identity derived from this request's own candle window - no stored state; `impulseStart`/`impulseEnd` are not separately published, see `lib/patternLifecycle.js` `identifyCandidate`), `failedAt` (schema 1.12.0, failed only), `qual` (schema 1.12.0: `{quality, decision, reasons}`, every candidate flag or coil - see below), `risk`. A `failed` candidate is dropped from the default payload unless `config.flag.includeFailed` **or** it is still inside `flag.failedTtlCandles` of its own timeframe (it then carries `failReason`/`failedAt` regardless); older failures follow `includeFailed` as before. A `confirmed` flag more than `flag.maxBreakoutAge` candles past its break reads `expired` for `flag.expiredTtlCandles` more, then is not found at all.

`candidateSetups[].qual` (F1 item 8, `lib/candidateQualifier.js`, every candidate): `quality` (low | med | high, banding the candidate's own `confidence`), `decision` (watch | wait | dont | actionable - never a probability of profit; proto/forming → watch, triggering → wait, failed/expired → dont, confirmed with no blocking reason → actionable else wait), `reasons[]` (`conflict:<tf>-<dir>`, `stoch:ob-cross`/`stoch:os-cross`, `room:blocked-<tf>`, `ema200:counter`, `ct:4h`, `chase`, `rr:<x>` - built only from data already elsewhere in the payload, never a new detection signal).

`geometryContext.<tf>` (Phases 7–8; 15m, 1h, 4h by default, `null` when a timeframe lacks enough candles): `atr`, `atrPct`, `structure` (up | down | range), `higherLows`, `lowerHighs`, `horizontalSupportZones[]`, `horizontalResistanceZones[]`, `roomToNextSupport`, `roomToNextResistance`, `extensionRisk`, `ema21Slope`, `stochAccelK`, `confidence`, `diagonalSupport`, `diagonalResistance`, `channel`, `confluenceZones[]`.

`decisionTrace` (Phase 2): `configVersion`, `evaluatedAt`, `strategies[]` (`name`, `ran`, `valid`, `rejectedAt`, `reason` per strategy), `bestSignal`, `bestSignalReason`, `window` (per-timeframe `{to, closedCandles}`; Phase 11 dropped `from`, the oldest candle's open time), `candidateSetups[]` (`"1m:long:confirmed"` strings; schema 1.12.0 adds the `proto` and `expired` states, e.g. `"1m:long:proto"`, `"5m:short:expired"`; a failed one adds its `failReason`, `"5m:short:failed:stale"`, Phase 9b - unaffected by the default payload's `failedTtlCandles`/`includeFailed` gating, so a hidden failure is still named here), `geometry[]` (`"1h:up:0.42:0.18:low"` strings, room values rounded to 2 decimals as of Phase 11; a missing individual field is an empty position, `"1h:up::0.18:"`; a timeframe with no geometry at all is one token, `"1h:na"`), `needsVisualConfirmation`, `visualTarget`, `unresolvedGeometry[]` (Phase 9 visual gate; since 9b a near-miss diagonal alone never raises it and `visualTarget` prefers triggering/confirmed), `bias` (Phase 9b, `"scalp:L14,S16,N70|swing:L74,S0,N26|tf:1m=S,…,1d=L|ct:2"`, ≤ 120 bytes through schema 1.10.0; schema 1.11.0 appends up to two more tokens, `"|td:bull:3/4|a200:5/7"` — see `topDown` below).

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

Missing wallet vars → `account.status: disabled`, market data unaffected.

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
