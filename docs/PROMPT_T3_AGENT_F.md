# Master prompt — Agent F (Sonnet): make live Jupiter perp trades work end to end

Paste everything below this line into a fresh Sonnet session opened in `/Users/bballi/Documents/Repos/snapshot_tradingview` on branch `upgrade-signal-engine`.

---

You are Agent F. Read `CLAUDE.md`, then `docs/PLAN_LIVE_PERPS_TEST.md` (your source of truth), then `docs/PLAN_TELEGRAM_EXECUTION.md`, `services/jupiterPerps.js`, `lib/execution/executor.js`, `lib/execution/audit.js`, `lib/execution/tickets.js`, `lib/telegram.js`, `api/telegram-webhook.js`, `lib/blobJsonl.js`, and the tests `test-jupiter-perps.js`, `test-execution.js`, `test-telegram.js`. Baseline is commit b583bdb.

Goal: implement plan items F1–F6 so the executor can open, protect, update and close a Jupiter perp position on a live wallet safely. Code and tests only. You do NOT run anything against mainnet, you do NOT touch `.env`, `.env.local`, Vercel, or any key. All tests mock the RPC connection and the builders.

Working tree note: 16 files are dirty from another session's volume-context feature (`config/engine.*`, `lib/volumeContext.js`, `test-volume-context.js`, `services/scalpContext.js`, `openapi/`, several docs, `PRODUCT.md`). Do not stage, edit, revert or commit them. Stage your files by name; never `git add -A` or `git add .`.

Reference pattern for landing (read it, port the state machine, do not copy code wholesale): `/Users/bballi/Documents/Repos/game_concepts/critter-dash-market-poc/server/trading/executionFlow.js` and `docs/EXECUTION_CONTRACT.md` in that repo. Key points: rebroadcast identical signed bytes every 2 s while status unknown; EXPIRED only when the finalized block height passed `lastValidBlockHeight` AND a fresh `getSignatureStatuses` lookup is empty; exactly-once apply guarded by an action id; constants `rebroadcastEveryMs = 2000`, `observePollMs = 1000`.

## Deliverables

F1 `landTransaction(signedTx, connection, opts)` in `services/jupiterPerps.js`. Returns `{ status: 'confirmed'|'expired'|'failed', signature, slot, err, logs }`. `sendSigned` uses it. Never resign; rebroadcast the same bytes. `maxWaitMs` default 90000.

F2 `waitForFill(positionRequestPDA, positionPDA, connection, opts)` in `services/jupiterPerps.js`. Poll every 1 s up to 60 s. Filled = request account gone or marked executed AND position account decodes with size > 0. Not filled = timeout or request rejected. If the IDL exposes a cancel/close for an unfilled increase request, add `buildCancelIncreaseRequest` and use it on timeout; if it does not, say so in the handback and leave the request outstanding with a loud audit event.

F3 Executor live paths in `lib/execution/executor.js`:
- open: preflight → `buildOpenPosition` WITHOUT stops → simulate (refuse on error) → land → `waitForFill` → build SL and TP trigger requests → simulate → land each → verify via `getPerpPositions` plus trigger request accounts → audit phase events `submitted`, `filled`, `stops_attached`, `verified`. Journal `open` only after `verified`, with the fill price from the position account.
- If stop attachment fails after fill: `buildClosePosition` full → land → audit `emergency_close` → Telegram alert. If that close fails: engage the kill switch, alert, retry the close every 5 s for up to 2 min, audit each attempt.
- close and update: build → simulate → land → verify → journal.
- Exactly-once: every ticket confirm gets an `actionId`; terminal state recorded in Blob `execution/actions.json` through `updateBlob` (ETag guarded) before journal/audit finalize. A retry or a second webhook delivery for the same ticket must not send again or double-journal.
- Flip `LIVE_CAPABILITIES` to `{ openWithStops: true, close: true, update: true }`. Remove the `live_*_unsupported` refusals for what is now implemented. Keep every existing gate (enabled, mode, owner ids, PIN, kill, caps, entry drift). Do not change caps or defaults.
- `JUPITER_SIMULATE_ONLY=true` must still stop before any send in live mode and report the simulation result.

F4 Telegram: the result card edits one message in place as phases arrive (`submitted → filled @price → stops attached → verified`); emergency close renders a 🛑 card; `/positions` shows per position `stops: SL ✔ TP ✔` or `⚠ none`. Keep the existing card style (dot, glyph, ▲▼, two-line format).

F5 Tests (extend the three existing suites; add fixtures, no network):
- landing: dropped then rebroadcast then confirmed; expired path; failed with logs; no resign.
- waitForFill: filled, timeout, rejected.
- open happy path with all four phase audits and journal after verified only.
- stops failure → emergency close; close failure → kill + alert + retry.
- exactly-once on actionId (second confirm returns the recorded terminal result, sends nothing).
- simulate-only in live mode sends nothing.
- Telegram phase card and `/positions` stops line.
Run all fourteen `npm run test:*` scripts; all green. `git diff --check` on touched files.

F6 Docs: add a "Live flow" section to `docs/PLAN_TELEGRAM_EXECUTION.md` (phases, failure handling, exactly-once); env rows in `docs/EDITTRADES_MCP_CONNECTOR.md` for `EXECUTION_MODE=live` prerequisites (`SOLANA_PRIVATE_KEY`, `SOLANA_RPC_URL`, `JUPITER_SIMULATE_ONLY`); CHANGELOG entry; update the F-status line at the top of `docs/PLAN_LIVE_PERPS_TEST.md`.

## Hard rules (repeat of CLAUDE.md, non-negotiable)
Never import execution code from `services/scalpContext.js`, `services/editTradesMcp.js` or `lib/mcpHttp.js`. Never log or return a private key, bearer or RPC URL. Never register an execution tool in MCP. `services/walletTracker.js` stays read-only. Do not enable trading in any env, do not touch Vercel.

## Commits
One commit per deliverable group, message prefix `feat(execution):` or `feat(jupiter):` or `test:`/`docs:`. Do not push. Stop after F6.

## Handback (reply with exactly this, compact)
- Commits (hash + subject)
- Test counts per suite before → after
- Assumptions about the Jupiter IDL you could not verify (list each with the line where it matters)
- Whether an unfilled increase request can be cancelled, and what happens if not
- Anything in the plan you could not implement and why
