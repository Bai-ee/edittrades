# T-3 — Place and manage Jupiter perp trades from Telegram (owner-approved 2026-09-24)

Status: plan; implementers start on the orchestrator's go. Ships in DRY-RUN first; the owner flips LIVE.
Goal: from a GOOD / Plan card, tap Open → see the exact order → confirm with a PIN → the engine wallet places the Jupiter perp with SL/TP → the trade is journaled, tracked, and manageable (close, move SL/TP) from Telegram. MCP and the GPT never get this path.

## Non-negotiables
- Execution path = `api/telegram-webhook.js` → `lib/execution/*` → `services/jupiterPerps.js`. `services/editTradesMcp.js`, `lib/mcpHttp.js`, `services/scalpContext.js` and the GPT Action never import or reach it (tests assert).
- Gates, all server-side, all required: `TRADE_EXECUTION_ENABLED=true`, `EXECUTION_MODE=dry|live` (default dry), owner Telegram id allowlist, `EXECUTION_PIN` (4–8 digits) on every confirm, per-order nonce (60 s expiry, single use), kill switch (`EXECUTION_KILL=true` env OR Blob flag `execution/kill.json` set by `/kill`), caps: `EXECUTION_MAX_SIZE_USD`, `EXECUTION_MAX_LEVERAGE`, `EXECUTION_MAX_LOSS_USD_PER_TRADE`, `EXECUTION_MAX_DAILY_LOSS_USD`, `EXECUTION_MAX_OPEN_POSITIONS` (default 2). Any missing cap → refuse.
- Every order requires an engine plan (ready) or an explicit `/order` with SL and TP; no market orders without a stop. Stop distance ≤ 3% (scalp cap) unless the plan says otherwise; liquidation buffer check from riskEngine.
- Audit log: `execution/YYYY-MM-DD.jsonl` on Blob: intent, preflight result, quote, confirm, tx signature or dry-run id, fills, errors (no keys, no seed, no RPC URL). The tracker ingests it.
- Never log `SOLANA_PRIVATE_KEY`, `EXECUTION_PIN`, bot token, or RPC URL. PIN compared constant-time, never echoed; the confirm message is deleted from the chat after use (Bot API deleteMessage) so the PIN doesn't sit in history.
- Dry-run mode does everything except sign/send: same preflight, same quote, same audit line with `mode:"dry"`, and journals as `note` ("DRY order …"), never `open`.

## Contract between agents (fixed)
`lib/execution/executor.js` exports:
- `preflight(intent, ctx)` → `{ ok, reasons[], quote, order }`. `intent = { symbol, direction, sizeUsd, leverage, entry, stop, tp1, tp2?, planId?, candidateId?, source:'telegram' }`. Checks: gates/caps, kill switch, open positions count, daily loss so far (from audit + journal closes), custody capacity (`checkCustodyCapacity`), quote (`getPerpQuote`), stop/liquidation buffer (riskEngine), SL/TP sides sane, fees estimate (dir-cost).
- `createTicket(order)` → `{ nonce, expiresAt, summaryText }` stored in Blob `execution/tickets.json` (short TTL).
- `confirm(nonce, pin, ctx)` → `{ ok, mode, txSignature|dryRunId, position?, error? }`: re-runs preflight, checks PIN + nonce + kill, then `openPerpPosition(market, direction, size, leverage, stop, tp)` in live mode; writes audit; journals `open` (live) with `source:'execution'` and engineRef.
- `closePosition(positionId, sizeUsd|null, pin)` / `updateStops(positionId, stop, tp, pin)` → same guards, `closePerpPosition` / `updatePerpPosition`, journal `close` / `adjust`.
- `listPositions()` → real on-chain read (implement `getPerpPositions`: derive position PDAs for the wallet across BTC/ETH/SOL custodies, both sides, decode size, collateral, entry, liquidation, unrealized PnL); used by `/positions` (live) and the tracker (3b-lite reconcile).
- `status()` → mode, kill, caps, today's realized loss, open count, wallet margin.

## Telegram UX (agent B)
- GOOD alerts and Plan cards gain `Open` (only when `action.call` is GET IN NOW or the plan is ready). `/order BTC long size 200 lev 5 sl 84390 tp 85146` for manual orders (still preflighted, still needs SL+TP).
- Open → ticket card: `⚡ ORDER · ₿ BTC 5m ▲ LONG` with side, size, leverage, expected fill (quote), SL, TP1, max loss $, fees, mode banner `DRY RUN` or `LIVE`, buttons `Confirm` / `Cancel`. Confirm prompts `Reply: /confirm <nonce> <PIN>`; wrong PIN 3× → auto-kill for 1 h.
- Result card: filled price, size, position id, SL/TP set, `Tracking on`; the trade appears in `/positions` with live PnL from chain, buttons `Close`, `Close 50%`, `Move SL to BE`, `Set SL/TP`. Each requires `/confirm <nonce> <PIN>`.
- `/exec` shows mode/caps/kill/daily loss; `/kill` (immediate, no PIN) and `/arm <PIN>` (clears the Blob kill flag; env kill stays). `/mode` shows dry|live (changing mode is env-only, deliberately).
- Every execution message logged to the Telegram alert log; audit ingested by the tracker; page gets an "Execution" section (orders, fills, dry vs live, PnL) — tracker work can follow in a later pass.

## Phases and agents
- **A (executor + positions read)** and **B (Telegram UX against the contract, with a mocked executor)** run in parallel. Both: tests mocked, no network in tests, no deploy.
- **C (security review, read-only)**: gates enforced server-side, nonce single-use, PIN constant-time and deleted, kill switch honored on every path, caps computed from live data, no key/RPC/PIN in logs or audit, MCP/GPT isolation test, dry-run cannot sign. Findings fixed before deploy.
- **D (deploy dry-run)**: orchestrator sets env (`EXECUTION_MODE=dry`, caps, `EXECUTION_PIN` supplied by the owner in Telegram? NO — owner sets the PIN value in Vercel himself or sends it to the orchestrator), deploys from a clean checkout, owner runs a dry order end to end.
- **E (go live)**: after the owner has done ≥ 3 dry orders and reviewed the audit: `EXECUTION_MODE=live` with tiny caps (e.g. size $50, lev 3, loss $5/trade, $15/day). Raise caps by owner decision only.

## Out of scope
Auto-execution of GOOD calls without a tap (never in this plan). Spot swaps. Anything the GPT or MCP can trigger.
