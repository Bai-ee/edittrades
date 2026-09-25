# T-3 F — Make live Jupiter perp trades work, then test on the real wallet with tiny caps

Last updated: 2026-09-25. Owner-approved direction: "good enough to start placing live perp trades".
Baseline: 8e98eae; F1–F6 (code + tests + docs) landed on top of b583bdb, not deployed. `LIVE_CAPABILITIES` is now `{openWithStops, close, update: true}`; transaction landing (rebroadcast/EXPIRED), the keeper-fill two-phase open, exactly-once, and the Telegram phase/emergency-close cards are all implemented — see `docs/PLAN_TELEGRAM_EXECUTION.md` "Live flow" for the mechanics and the open assumptions/blockers (most importantly: the two-phase open's worst-case wall-clock budget does not fit a normal serverless request, an owner decision needed before any live test below). NOT done: everything under "Live test protocol" — no env is set, nothing has run against a real wallet.

## Blockers, in order
1. **Keeper fill is asynchronous.** On Perps v2 `buildOpenPosition` submits an *increase position request*; a keeper fills it seconds later. The SL/TP trigger requests reference the filled position, so they cannot ride in the same transaction reliably. Two-phase open is required: submit → wait for fill → attach stops → verify.
2. **Naked-position risk.** If phase 2 (attach stops) fails, the account holds a position with no stop. The executor must close it immediately (market decrease) and alert; if the close also fails, kill + alert + keep retrying the close every 5 s for 45 s (budget: webhook maxDuration 300 s).
3. **Transaction landing.** One send is not enough on Solana. Adopt the proven pattern: rebroadcast the identical signed bytes every 2 s while status is unknown; declare EXPIRED only when finalized block height > lastValidBlockHeight and a fresh signature lookup finds nothing; exactly-once apply guarded by the action id before any journal/audit write.
4. **Executor wiring.** Live open/close/update call the builders: build → simulate (refuse on error) → send with landing → observe → audit each phase → journal only on confirmed fill.

## Build (single Sonnet pass, code-only, tests mocked; no network in tests)
F1 `services/jupiterPerps.js`: `landTransaction(signedTx, connection, { rebroadcastEveryMs: 2000, observePollMs: 1000, maxWaitMs: 90000 })` → `{ status: 'confirmed'|'expired'|'failed', signature, slot, err, logs }` using getSignatureStatuses + getBlockHeight vs lastValidBlockHeight. `sendSigned` uses it.
F2 `services/jupiterPerps.js`: `waitForFill(positionRequestPDA, positionPDA, connection, { pollMs: 1000, maxWaitMs: 60000 })` → `{ filled: true, position }` when the request account is closed/executed and the position account shows size > 0; `{ filled: false, reason }` on timeout or rejection (request account shows rejected/cancelled). Keep the request cancel builder if the IDL has one (`cancel` unfilled request on timeout) and use it.
F3 `lib/execution/executor.js` live paths:
   - open: preflight → build increase request (no stops) → simulate → land → waitForFill → build trigger requests (SL, TP) → simulate → land each → verify via getPerpPositions + trigger request accounts → audit `phase` events (submitted, filled, stops_attached, verified). On any stops failure: `buildClosePosition` full → land → audit `emergency_close`; on close failure: kill switch on + Telegram alert + retry close every 5 s up to 45 s. Journal `open` only after `verified` (fill price from the position account).
   - close / update: build → simulate → land → verify → journal `close`/`adjust`.
   - `LIVE_CAPABILITIES` → { openWithStops: true, close: true, update: true } once the above exists; keep `live_*_unsupported` only for anything not implemented.
   - Exactly-once: an `actionId` per ticket; a terminal-state record in Blob `execution/actions.json` guarded by ETag; a retry/crash cannot re-send or double-journal.
F4 Telegram (lib/telegram.js, api/telegram-webhook.js): result card shows phases live: `submitted → filled @price → stops attached → verified` updating one message (editMessageText) as events arrive from the webhook's await; on emergency close a 🛑 card; `/positions` shows on-chain SL/TP presence per position (`stops: SL ✔ TP ✔` or `⚠ none`).
F5 Tests: landing state machine (dropped → rebroadcast → confirmed; expired path; exactly-once), waitForFill states, two-phase open happy path, stops-failure → emergency close, close failure → kill + alert, exactly-once actionId, executor live wiring with mocked builders/connection, Telegram phase card. All suites green; `test:execution`, `test:jupiter`, `test:telegram` counts reported.
F6 Docs: docs/PLAN_TELEGRAM_EXECUTION.md "Live flow" section; connector doc env rows (`EXECUTION_MODE=live` prerequisites); CHANGELOG.

## Live test protocol (owner + orchestrator, after F1–F6 are reviewed and deployed)
Prereqs the owner sets in Vercel: `SOLANA_PRIVATE_KEY` (the trading wallet; funded with a small stable balance), `SOLANA_RPC_URL` (paid RPC strongly recommended), `EXECUTION_PIN`. Orchestrator sets: `EXECUTION_ENABLED=true`, `EXECUTION_MODE=live`, `EXECUTION_OWNER_IDS`, caps `EXECUTION_MAX_SIZE_USD=20`, `EXECUTION_MAX_LEVERAGE=2`, `EXECUTION_MAX_LOSS_USD_PER_TRADE=2`, `EXECUTION_MAX_DAILY_LOSS_USD=6`, `EXECUTION_MAX_OPEN_POSITIONS=1`, `JUPITER_SIMULATE_ONLY=false`.
T1 Dry: `/order SOL long size 20 lev 2 sl <mark-1.5%> tp <mark+3%>` in `EXECUTION_MODE=dry` → ticket → confirm → DRY OK; audit line present. (Also run once with `JUPITER_SIMULATE_ONLY=true` in live mode: simulation logs, nothing sent.)
T2 Live open: same order in live → phases card reaches `verified`; check `/positions` shows the position with SL ✔ TP ✔; check the tx on Solscan; journal `open` present with fill price; tracker shows the trade.
T3 Live update: `/stops` move SL to breakeven → verify on chain.
T4 Live close 50 % then close rest → journal closes with R; `/positions` empty; audit complete.
T5 Failure drill: start an open, `/kill` during phase 1 → confirm no send after kill; then `/arm`.
T6 Naked-position drill (simulated in tests only; NOT live): covered by F5.
Go/no-go: all of T1–T5 pass twice; then raise caps by owner decision only.

## Out of scope
Auto-execution, spot swaps, anything GPT/MCP-triggered, raising caps.

## Owner runbook (2026-09-25) — env, deploy, T1
The orchestrator session cannot write Vercel env or deploy (permission classifier), so the owner runs these from the repo root. Values are piped, never echoed. Master switch is `TRADE_EXECUTION_ENABLED` (gates.js), not `EXECUTION_ENABLED`.

```bash
# 1. wallet + RPC (values from local .env, never printed)
grep '^SOLANA_PRIVATE_KEY=' .env | cut -d= -f2- | npx vercel env add SOLANA_PRIVATE_KEY production --sensitive
grep '^SOLANA_RPC_URL=' .env     | cut -d= -f2- | npx vercel env add SOLANA_RPC_URL production --sensitive
# 2. PIN: type your own 6+ digit PIN in place of <PIN>
printf '%s' '<PIN>' | npx vercel env add EXECUTION_PIN production --sensitive
# 3. gates + tiny caps (dry first; flip EXECUTION_MODE to live only for T2+)
for kv in TRADE_EXECUTION_ENABLED=true EXECUTION_MODE=dry EXECUTION_OWNER_IDS=<your telegram user id> \
  EXECUTION_MAX_SIZE_USD=20 EXECUTION_MAX_LEVERAGE=2 EXECUTION_MAX_LOSS_USD_PER_TRADE=2 \
  EXECUTION_MAX_DAILY_LOSS_USD=6 EXECUTION_MAX_OPEN_POSITIONS=1 EXECUTION_MAX_ENTRY_DRIFT_BPS=15 \
  JUPITER_SIMULATE_ONLY=true; do printf '%s' "${kv#*=}" | npx vercel env add "${kv%%=*}" production; done
# 4. deploy HEAD (f140f33 or later) and verify
npx vercel --prod --yes
```
T1 (dry): in Telegram `/order SOL long size 20 lev 2 sl <mark-1.5%> tp <mark+3%>` → ticket → confirm with PIN → DRY OK card, audit line in `/status`.
T1b: set `EXECUTION_MODE=live` (keep `JUPITER_SIMULATE_ONLY=true`), redeploy, repeat → simulation card, nothing sent.
T2+: set `JUPITER_SIMULATE_ONLY=false`, redeploy, run T2–T5 from the protocol above. `/kill` at any point stops everything.
