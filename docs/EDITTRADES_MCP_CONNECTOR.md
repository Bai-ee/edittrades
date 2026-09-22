# EditTrades MCP Connector and Scalp Stop-Distance Guard

Last updated: 2026-09-22 (docs sync after Phase 8; Phase 8b in progress)
Branch: `upgrade-signal-engine`
Payload: `schemaVersion` 1.8.0, `configVersion` 2026.09.22-6
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
| `lib/patternDetector.js` | 1m/3m/5m flag detector, long and short (Phase 4) |
| `lib/geometry.js` | Pivots, horizontal zones, ATR, room, EMA slope, diagonals, channel, confluence (Phases 7–8) |
| `services/walletTracker.js` | Read-only tracked wallet: margin, holdings, gas, performance. No keypair. |
| `openapi/scalp-context.yaml` | REST Action schema for the Custom GPT (source of truth for field-level detail) |
| `CHATGPT_ACTION_SETUP.md` | REST Action setup |

Tests:

| Command | File | Passing (2026-09-22) |
| --- | --- | --- |
| `npm run test:sltp` | `test-strategy-sltp.js` (section 6b = call-path guard tests) | 50 |
| `npm run test:scalp` | `test-scalp-context.js` | 94 |
| `npm run test:mcp` | `test-edittrades-mcp.js` | 51 |
| `npm run test:wallet` | `test-wallet-tracker.js` | 28 |
| `npm run test:config` | `test-engine-config.js` | 14 |
| `npm run test:risk` | `test-risk-engine.js` | 24 |
| `npm run test:pattern` | `test-pattern-detector.js` (fixtures `test/fixtures/flagFixtures.js`) | 23 |
| `npm run test:geometry` | `test-geometry.js` (snapshot `test/fixtures/geometryPhase7Snapshot.json`, builders `test/fixtures/geometryFixtures.js`) | 35 |
| `npm run test:chart` | `test-chart-render.js` (sample `test/fixtures/chart-sample-btc-4h.png`) | 18 |
| `npm run test:replay` | `test-replay.js` (replay harness, metrics, miss log `test/fixtures/misses/`) | 20 |

The first four are the deploy gate; the rest are the per-module suites added by the engine phases. Run all ten before a deploy.

Replay (Phase 10, dev only, never on the request path): `npm run replay -- --capture BTC,SOL,ETH --out test/fixtures/history/<date>/ [--backfill-1m 360]` saves a live pull; `npm run replay -- --history <dir> --symbols BTC --out btc.jsonl` runs `buildScalpContext()` once per closed candle with no lookahead; `npm run replay:metrics -- btc.jsonl` prints candidate counts, visual-gate rate by code, lifetime and label precision/recall. Details: master plan, Phase 10.

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
- `include` tokens: `timeframes`, `strategies`, `candidates` (→ `candidateSetups`), `geometry` (→ `geometryContext`), `trace` (→ `decisionTrace`), `account`, `config`. `price`, `source`, `structure`, `bestSignal` are always kept.
- `compact: true`: every `timeframes.<tf>.candles` becomes `[]`; indicator summaries stay.
- Unknown values are ignored with one `payload controls: ...` line in `warnings`, never rejected. If every requested value is unknown the filter is treated as absent. These warnings are added after `dataStatus` is computed and do not change it.
- Measured 2026-09-22, live BTC/SOL/ETH: full ~77 KB, compact ~31 KB. The builder logs a soft warning above 80 KB.

### Confirmation chart (Phase 8b)

- `chart: "BTC:1m"` (REST `?chart=BTC:1m`): one PNG, 900×500, of that symbol/timeframe, rendered by `lib/chartRender.js` (pure JS, `pureimage`, bundled `assets/fonts/IBMPlexMono-Regular.ttf`, OFL). Never in the default response.
- MCP: `content` = `[text summary + " chart=BTC:1m", {type:"image", mimeType:"image/png", data}]`, `structuredContent` as usual. REST: `200 image/png` instead of JSON. REST auth unchanged; the param is read after auth.
- One chart per call. Two charts, an unknown symbol/timeframe, or a malformed value: MCP `isError`, REST 400 JSON. No candles for that timeframe in the build: MCP `isError`, REST 503. Rejected before the build runs.
- Draws the published candle window, EMA21/EMA200, horizontal zones (bands), diagonals, channel, candidate flag levels (dashed). 1m/3m/5m: candles + EMAs + candidate only.

## Payload schema 1.8.0

Field-level definitions live in `openapi/scalp-context.yaml`. This is the map.

Top level: `schemaVersion`, `configVersion`, `config`, `generatedAt`, `closedThrough`, `sessionTimezone`, `dataStatus` (complete | partial | unavailable), `account`, `symbols{BTC,SOL,ETH}`, `warnings[]`, `requestId` (MCP only).

`config` (Phase 5): snapshot of tunables from `config/engine.json` — `scalp.maxStopDistancePct`, `riskReward.bySetupType/byStrategy`, `risk.*`, `flag.includeFailed`.

`account`: `status` (available | partial | disabled | unavailable), `reason`, `address` (masked), `fetchedAt`, `margin{usd, byAsset}` (USDC/USDT = risk capital and P&L base), `holdings[]`, `holdingsUsd` (exposure, not P&L), `unpriced[]`, `gas{sol, minSol, sufficient}`, `performance{baselineUsd, netPnlUsd, returnPct, source}`. Unavailable is never zero. Never affects `dataStatus`.

`symbols.<SYM>`, in key order: `price`, `source{provider, pair, fetchedAt}`, `structure{sessionHigh, sessionLow, prevDayHigh, prevDayLow, swingHighs[5], swingLows[5], support[3], resistance[3], aboveEma21, aboveEma200}`, `timeframes{1m,3m,5m,15m,1h,4h,1d}`, `strategies{SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP}`, `bestSignal`, `candidateSetups[]`, `geometryContext`, `decisionTrace`.

`timeframes.<tf>`: `candles[]` (closed only; 30 for 1m/3m/5m, 24 for 15m/1h, 20 for 4h, 10 for 1d; compute runs on up to 499), `ema21`, `ema200`, `priceVs21Pct`, `priceVs200Pct`, `trend`, `stochRsi{k, d, state, cross, slopeK, slopeD}`, `closedThrough`, `candleCount`.

`strategies.<NAME>` canonical: `valid`, `direction` (long | short | NO_TRADE), `confidence` 0–100, `reason`, `entryZone{min,max}`, `stopLoss`, `invalidationLevel`, `stopSource` (5m | 15m | 4h | percentage | null), `targets[]`, `riskReward{tp1RR, tp2RR}`, `entryType`, and on valid signals `risk` (Phase 3). Invalid → NO_TRADE, all levels null, targets empty.

`risk` (Phase 3, valid strategies and triggering/confirmed candidates): `maxLeverage`, `suggestedLeverage`, `lossAtStopUsd`, `lossAtStopPct`, `lossAtStopPctOfWallet`, `collateralUsd`, `reason` (null when the numbers are populated).

`candidateSetups[]` (Phase 4): flag candidates on 1m/3m/5m, long and short, independent of `strategies` and `bestSignal`. `timeframe`, `type: flag`, `direction`, `state` (forming | triggering | confirmed | failed), `impulseStrength`, `compressionScore`, `flagHigh`, `flagLow`, `breakoutLevel`, `invalidation`, `ema21Hold`, `confidence`, `chaseRisk`, `risk`. Failed candidates are dropped unless `config.flag.includeFailed`.

`geometryContext.<tf>` (Phases 7–8; 15m, 1h, 4h by default, `null` when a timeframe lacks enough candles): `atr`, `atrPct`, `structure` (up | down | range), `higherLows`, `lowerHighs`, `horizontalSupportZones[]`, `horizontalResistanceZones[]`, `roomToNextSupport`, `roomToNextResistance`, `extensionRisk`, `ema21Slope`, `stochAccelK`, `confidence`, `diagonalSupport`, `diagonalResistance`, `channel`, `confluenceZones[]`.

`decisionTrace` (Phase 2): `configVersion`, `evaluatedAt`, `strategies[]` (`name`, `ran`, `valid`, `rejectedAt`, `reason` per strategy), `bestSignal`, `bestSignalReason`, `window` (per-timeframe closed-candle window), `candidateSetups[]` (`"1m:long:confirmed"` strings), `geometry[]` (`"1h:up:0.42:0.18:low"` strings).

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
