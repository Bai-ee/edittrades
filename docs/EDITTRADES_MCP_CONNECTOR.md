# EditTrades MCP Connector and Scalp Stop-Distance Guard

Last updated: 2026-09-22
Branch: `upgrade-signal-engine`
Commits: `06ddb1d` (connector, wallet tracking, guard, call-path tests), `843c16f` (`stopSource` on SCALP_1H)
Shared spec page: https://claude.ai/code/artifact/0fa3fa7e-96f1-4931-b09f-565282bb9215
Thread handoff (local, outside repo): `~/Documents/ChatGPT/EditTrades/THREAD_HANDOFF.md`

## What this is

One read-only MCP tool, `get_scalp_context`, served stateless at `POST /api/mcp`, beside the existing Bearer-protected `GET /api/scalp-context` Custom GPT Action. Both read the same `buildScalpContext()` in `services/scalpContext.js`. Neither proxies the other.

ChatGPT uses it to decide TAKE / WAIT / PASS independently from the engine recommendation plus raw data. Trade execution is out of scope and unreachable from this path.

## Files

| File | Role |
| --- | --- |
| `services/editTradesMcp.js` | McpServer factory, single tool registration, `runGetScalpContext`, summary text |
| `lib/mcpHttp.js` | Stateless Streamable HTTP dispatch, per-request server/transport, CORS, 405/500 handling |
| `api/scalp-context.js` | Shared Vercel function; branches to MCP on `__mcp=1` |
| `vercel.json` | `/api/mcp` rewrites to `api/scalp-context.js?__mcp=1` (Hobby 12-function cap) |
| `services/walletTracker.js` | Read-only tracked wallet: margin, holdings, gas, performance. No keypair. |
| `services/scalpContext.js` | Builds payload schema 1.1.0 with `account` block |
| `services/strategy.js` | Scalp stop-distance policy (see below) |
| `openapi/scalp-context.yaml` | REST Action schema for the Custom GPT |
| `CHATGPT_ACTION_SETUP.md` | REST Action setup |
| `test-edittrades-mcp.js` | `npm run test:mcp` |
| `test-wallet-tracker.js` | `npm run test:wallet` |
| `test-strategy-sltp.js` | `npm run test:sltp`, section 6b = call-path guard tests |
| `test-scalp-context.js` | `npm run test:scalp` |

## Endpoint

| Item | MCP | REST |
| --- | --- | --- |
| URL | `POST https://snapshottradingview.vercel.app/api/mcp` | `GET https://snapshottradingview.vercel.app/api/scalp-context` |
| Transport | MCP Streamable HTTP, stateless, protocol 2025-03-26 | JSON |
| Auth | None (data approved for public read-only exposure) | Bearer `SCALP_CONTEXT_API_KEY` |
| Headers | `Content-Type: application/json`, `Accept: application/json, text/event-stream` | `Authorization: Bearer` |
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
| Input | `{}` |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` |
| Build timeout | 25 s → tool error |

Success: `content[0].text` = one-line summary (`generatedAt closedThrough dataStatus warnings symbols requestId`); `structuredContent` = full payload + `requestId`.

Errors (`isError: true`, sanitized text, no structured content): build threw/timed out; empty payload; `dataStatus === 'unavailable'` ("Do not trade on this run"). `partial` + warnings pass through as success.

## Payload schema 1.1.0

Top level: `schemaVersion`, `generatedAt`, `closedThrough`, `sessionTimezone`, `dataStatus` (complete | partial | unavailable), `warnings[]`, `account`, `symbols{BTC,SOL,ETH}`, `requestId` (MCP only).

`account`: `status` (available | partial | disabled | unavailable), `reason`, `address` (masked), `fetchedAt`, `margin{usd, byAsset}` (USDC/USDT = risk capital and P&L base), `holdings[]`, `holdingsUsd` (exposure, not P&L), `unpriced[]`, `gas{sol, minSol, sufficient}`, `performance{baselineUsd, netPnlUsd, returnPct, source}`. Unavailable is never zero. Never affects `dataStatus`.

`symbols.<SYM>`: `price`, `source{provider, pair, fetchedAt}`, `structure{sessionHigh, sessionLow, prevDayHigh, prevDayLow, swingHighs[5], swingLows[5], support[3], resistance[3], aboveEma21, aboveEma200}`, `timeframes{1m,3m,5m,15m,1h,4h,1d}`, `strategies{SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP}`, `bestSignal`.

`timeframes.<tf>`: `candles[30]` (closed only), `ema21`, `ema200`, `priceVs21Pct`, `priceVs200Pct`, `trend`, `stochRsi{k, d, state, cross, slopeK, slopeD}`, `closedThrough`, `candleCount`.

`strategies.<NAME>` canonical: `valid`, `direction` (long | short | NO_TRADE), `confidence` 0–100, `reason`, `entryZone{min,max}`, `stopLoss`, `invalidationLevel`, `stopSource` (5m | 15m | 4h | percentage | null), `targets[]`, `riskReward{tp1RR, tp2RR}`, `entryType`. Invalid → NO_TRADE, all levels null, targets empty.

## Scalp stop-distance policy (`services/strategy.js`)

- `MAX_SCALP_STOP_DISTANCE_PCT = 3`. `validateScalpStopDistance(entry, stop)` measures from the entry mid with `1e-9` epsilon.
- `applyScalpStopPolicy()` builds the stop via `calculateSLTP(..., 'Scalp', ...)` and enforces the gate. Both `SCALP_1H` (PRIORITY 4 in `evaluateStrategy`) and `evaluateMicroScalp` route through it. Rejection → canonical NO_TRADE with reason `Setup rejected: scalp stop distance X% exceeds 3.00% maximum`.
- Percentage fallback: for `setupType === 'Scalp'` anchors at the entry mid so it lands exactly at the policy distance. If the mid-anchored stop cannot clear the entry zone (zone wider than 3%), it falls to the edge anchor, which the gate rejects → NO_TRADE. Swing / 4H / TrendRider keep the original edge anchor, unchanged.
- MICRO_SCALP rejection sets `result.reason`; `evaluateAllStrategies` surfaces it over the generic "conditions not met".
- `normalizeToCanonical` carries `stopSource`, nulls it on invalid signals. SCALP_1H raw signal emits it.
- Tests: section 6b of `test-strategy-sltp.js` drives `evaluateStrategy` and `evaluateMicroScalp` directly, long + short × wide / tight / no-structure. Mutation check: disabling either guard fails two tests. Fallback-anchor revert fails seven.

## Security boundary

- `services/editTradesMcp.js` and `lib/mcpHttp.js` import only `buildScalpContext`. No execution, position, or signing-wallet module reachable.
- `walletTracker.js` reads a public address over JSON-RPC; no keypair.
- Logs: `requestId`, method, status, duration, reason code only. No RPC URL, bearer, or upstream error text.
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

## Production verification (2026-09-22)

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

Suites: `test:sltp` 50, `test:scalp` 41, `test:mcp` 35, `test:wallet` 28.

## Verify after any redeploy

```bash
U=https://snapshottradingview.vercel.app
curl -s -o /dev/null -w "%{http_code}\n" $U/api/scalp-context                       # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $KEY" $U/api/scalp-context   # 200
curl -s -X POST $U/api/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                                # one tool
```

## Open items

- Re-run the Custom GPT `SIGNAL` workflow once through the REST Action.
- `public/index.html` dashboard edits are separate user work, uncommitted at time of writing.

## Work log

| Date | What |
| --- | --- |
| 2026-09-21 | Connector, wallet tracker, MCP dispatcher built. Blocker found: 3% guard rejected its own percentage fallback (edge-anchored 3% measured from mid ≈ 3.1–3.3%). MICRO_SCALP had no guard. |
| 2026-09-22 | Fallback re-anchored at mid for Scalp only. Shared `applyScalpStopPolicy` wired into SCALP_1H and MICRO_SCALP. Call-path tests added and mutation-verified. JSDoc placement fixed. Dead SCALP_1H branch in 4H block removed. `stopSource` published on SCALP_1H. Two prod deploys, verified. Wallet env vars added to Vercel by user. |
