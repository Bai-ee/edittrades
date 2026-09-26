# T-3 — Place and manage Jupiter perp trades from Telegram (owner-approved 2026-09-24)

Status: LIVE since 2026-09-26 (bot wallet JEAzPi…TjwT2; T1–T4 of docs/PLAN_LIVE_PERPS_TEST.md passed on real trades; T5 kill/arm drill pending owner). Risk policy (T-8) live; profiles (T-9 v2) in progress on branch risk-profiles.
Goal: from a GOOD / Plan card, tap Open → see the exact order → confirm with a PIN → the engine wallet places the Jupiter perp with SL/TP → the trade is journaled, tracked, and manageable (close, move SL/TP) from Telegram. MCP and the GPT never get this path.

## Non-negotiables
- Execution path = `api/telegram-webhook.js` → `lib/execution/*` → `services/jupiterPerps.js`. `services/editTradesMcp.js`, `lib/mcpHttp.js`, `services/scalpContext.js` and the GPT Action never import or reach it (tests assert).
- Gates, all server-side, all required: `TRADE_EXECUTION_ENABLED=true`, `EXECUTION_MODE=dry|live` (default dry), owner Telegram id allowlist, `EXECUTION_PIN` (4–8 digits) on every confirm, per-order nonce (60 s expiry, single use), kill switch (`EXECUTION_KILL=true` env OR Blob flag `execution/kill.json` set by `/kill`), caps: `EXECUTION_MAX_SIZE_USD`, `EXECUTION_MAX_LEVERAGE`, `EXECUTION_MAX_LOSS_USD_PER_TRADE`, `EXECUTION_MAX_DAILY_LOSS_USD`, `EXECUTION_MAX_OPEN_POSITIONS` (default 2). Any missing cap → refuse.
- Every order requires an engine plan (ready) or an explicit `/order` with SL and TP; no market orders without a stop. Stop distance ≤ 3% (scalp cap, absolute — no plan can widen it; re-checked at the live fill); liquidation buffer check from riskEngine.
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

## Review fixes 2026-09-25 (agent C findings, fixed before any deploy)
1. **HIGH `/arm` brute force.** While a wrong-PIN auto-kill (`reason:"wrong_pin_x3"`) is active, `arm()` refuses with `auto_kill_active` without evaluating the PIN. The wrong-PIN counter is no longer reset when the auto-kill fires; every further 3 wrong PINs inside the 1 h window extend the kill by 1 h (`autoKillUntil`). A standing manual kill is never downgraded to a lapsing auto-kill. A wrong PIN counts even when the Blob write fails: the executor keeps an in-memory count for the instance, logs `reason=pin_count_write_failed`, and the 3rd sets an in-memory kill (plus a best-effort Blob kill).
2. **HIGH fill freshness.** Preflight (and so confirm, which re-runs it) prices the order at the symbol's live mark (`symbols.X.mark.price` when `mark.status==='ok'`, else the Kraken close), from `ctx.mark` (the webhook passes it on Open and `/order`) or the injected engine build (`deps.buildContext`, default `buildScalpContext`). Refuses `fill_drift` when |fill − intent.entry| > `EXECUTION_MAX_ENTRY_DRIFT_BPS` (default 15), `fill_unavailable` when there is no price, and re-checks stop side, the 3% stop cap and max loss at the fill (`*_at_fill`). The order carries `expectedFill`, `fillSource`, `fillDriftBps`, and the worse of plan/fill max loss (also used for the daily-loss cap). **The Jupiter quote (`getPerpQuote`) is still a placeholder estimate until agent D lands a real venue quote**; it feeds margin/fee display only, never the fill.
3. **MEDIUM kill read.** `readKillState` uses `readBlobFresh` (lib/blobJsonl.js: get + head ETag, fresh fetch from the blob URL on mismatch via `fetchFreshBody`). An unresolved mismatch, a head error or any read error = killed (`kill_state_unavailable`).
4. **MEDIUM custody.** Preflight compares size against custody headroom when `checkCustodyCapacity` returns numbers (`headroomUsd`, `availableUsd`, or `maxAssets − currentAssets`) → `custody_capacity`. No numbers (today's jupiterPerps returns only `currentAssets`): live refuses `custody_unknown`; dry allows with `warn:custody_unknown` in reasons (shown on the ticket card).
5. **MEDIUM RPC URL logging.** `services/walletManager.js` logs only the RPC host (`rpcHostForLog`); `test-perps-connection.js` likewise. No other `SOLANA_RPC_URL` log remains (test asserts).
6. **MEDIUM public Blob exposure.** Decision: the Blob store is public, so a separate "private" path buys nothing. Audit lines store `txSignatureHash` / `positionIdHash` (sha256, first 12 hex, `idHash`) instead of the full values and never a Telegram user id. Executor tickets store `ownerHash` (not the user id) and, for close/update, `positionIdHash` only (resolved against the chain read at execution). Telegram-side position tickets drop the full position id when the executor owns the ticket. Full tx signature and position id appear only in the Telegram result message and the journal; **the journal is public by owner decision** (it already holds the owner's trades).
7. **MEDIUM journal linkage.** Execution journal entries carry `execRef` (source `execution` only; GPT/Telegram records unchanged): live open = `{positionIdHash, ticketNonce, fillSource}` with `entry` = venue fill price when the open result has one, else the expected fill, and `engineRef.recClass` (Open passes `recClass` from the recommendation via `orderIntentFromPlan`). Close/adjust (and their dry notes) carry `{positionIdHash, openJournalId}`, found by scanning the last 7 journal days.
8. **LOW cancel.** `cancelTicket(nonce, ctx)` consumes the ticket (single use, owner only, audited `cancel`) without acting; the Cancel button calls it.
9. **LOW redaction.** `nonceTail` (4 hex) is exempt from the exact-value PIN match, so a tail equal to the PIN is not singled out as `[redacted]`.
10. **LOW misc.** Dry confirm tracks the candidate but does not mark `took` (live fill does). `isOpenReady` requires class GOOD and action `GET IN NOW` (a missing call is not ready). `planMaxStopPct` removed: the 3% cap is absolute. A failed delete of the owner's PIN message now tells the owner to delete it manually.

## Live flow (T-3 F, docs/PLAN_LIVE_PERPS_TEST.md, code-only pass, not deployed)

Landed the two blockers `PLAN_LIVE_PERPS_TEST.md` called out: transaction landing and the keeper-fill race. `LIVE_CAPABILITIES` is now `{openWithStops, close, update: true}`; live open/close/update are implemented, not refused.

**Transaction landing** (`services/jupiterPerps.js` `landTransaction`, used by `sendSigned` for every real send): rebroadcasts the identical signed bytes every 2 s while the outcome is unknown — never resigns, so a resend can only help a dropped send land, never execute twice. Declares `expired` only once the FINALIZED block height has passed the transaction's `lastValidBlockHeight` AND a fresh `getSignatureStatuses` lookup still finds nothing (a transaction with an expired blockhash cannot land in any future block, so nothing was charged). `failed` surfaces the on-chain `err` (and `slot`) straight from `getSignatureStatuses`; `logs` is always `null` — that RPC call carries no program logs, and a real log read would need a separate `getTransaction` call after confirmation (not implemented; see the F handback for this and the other open assumptions).

**Two-phase open** (Perps v2: `buildOpenPosition` only submits an increase-position *request*; a keeper fills it seconds later, so SL/TP cannot ride the same transaction reliably):
1. **submit** — build the increase WITHOUT stops, simulate (refuse on error), land.
2. **wait for fill** — `waitForFill` polls the position-request and position accounts (1 s, up to 60 s): filled once the request is gone/`executed:true` AND the position decodes with `sizeUsd > 0`; not filled on `timeout` (the unfilled request is cancelled via `buildCancelIncreaseRequest` when the IDL supports it — it does, `closePositionRequest`, self-serve) or `rejected` (both accounts gone, nothing to cancel).
3. **attach stops** — build + simulate + land the SL/TP trigger requests (`buildUpdateStops`) against the now-filled position.
4. **verify** — re-read the position on chain (size > 0) and confirm every trigger-request PDA `buildUpdateStops` created still exists (`fetchAccountsExist`).
5. **journal** — only after verified, `kind:'open'` with the fill price read off the position account (never the pre-fill expected/mark estimate).

Every phase audits `event:'phase'` (`submitted`, `landed`, `filled`, `stops_attached`, `verified`) and, when the caller passes `ctx.onPhase(phase, meta)`, calls it too — Telegram uses this to edit one message in place through the four owner-visible milestones (`submitted → filled @price → stops attached → verified`; see the Telegram section below).

**Naked-position handling.** If step 3 (attach stops) or step 4 (verify) fails, the position is filled but unprotected — the highest-priority risk in this plan. The executor immediately submits a full market close (`emergencyClose`, `buildClosePosition`). If that close also fails: the kill switch engages (`setKill`, reason `emergency_close_failed`), an alert fires (`ctx`/`deps.onAlert`), and the close retries every 5 s for up to 45 s, auditing (`event:'emergency_close'`) and alerting again on each attempt and on final failure. The open never journals in any of these paths.

**Live close / update** stay on the existing build → simulate → `sendSigned` path (the same legacy `closePerpPosition`/`updatePerpPosition` wrappers), which now lands through the same rebroadcast/expiry machinery automatically. Added: a post-send on-chain verify (position gone/reduced for close, still open for update) before journaling — a send that "succeeds" but doesn't verify is rejected as `close_failed`/`update_failed`, nothing is journaled.

**Exactly-once.** Every live open/close/update run gets an `actionId` (`${action}_${ticketNonce}`, or a fresh random id for a direct `closePosition`/`updateStops` call with no ticket). Before doing anything, the executor checks Blob `execution/actions.json` for a prior terminal result under that id and, if found, returns it verbatim — nothing is rebuilt, resent or re-journaled. The first time an action reaches a terminal state, its result (ids hashed, secrets redacted — same policy as the audit log) is recorded there, ETag-guarded, before the function returns.

**Telegram** (`lib/telegram.js`, `api/telegram-webhook.js`): the order ticket's Confirm still sends one card; in live mode that card is now edited in place (`bot.editMessageText`, falling back to a fresh send if the edit fails) at each of the four phases, then edited once more into the terminal FILLED / EMERGENCY CLOSE / refused card. Dry-run confirms are unchanged (no phases, one send). `formatEmergencyCloseCard` renders the naked-position 🛑 card, flagging `KILL ENGAGED` when the close itself failed. `/positions` gains a `stops: SL ✔ TP ✔` / `⚠ none` line per position, sourced from the most recent execution `open`/`adjust` journal record for that position — the on-chain Position account itself carries no SL/TP, and a pending trigger-request PDA cannot be enumerated from the position alone (its seed includes a random counter), so the journal is the only practical source of truth for this display; it reflects what the executor last *set*, not a fresh chain re-verification of each pending trigger.

**Known limits, owner decision needed before any live test:**
- Wall-clock budget (decided 2026-09-25): the webhook runs with `maxDuration: 300` (Vercel Pro). Landing ceiling 45 s, keeper-fill wait 60 s, emergency-close retries 45 s, so one open worst-cases at ≈285 s inside a single confirm request. Telegram may redeliver a slow update; the ticket is single-use and the actionId is exactly-once, so a redelivery cannot send twice. A queued/background model is deferred until tiny-cap live tests pass.
- `buildCancelIncreaseRequest` (`closePositionRequest`) and the "rejected" branch of `waitForFill` (both accounts gone with no fill) are inferred from the IDL's account/field shapes, not verified against a live cluster — see the F handback for the exact assumptions.

## Risk policy (T-8, `docs/PROMPT_T8_AGENT_H.md`, 2026-09-26)

A wallet-relative layer on top of the env caps above (`EXECUTION_MAX_*` stay hard floors, unchanged). Pure math lives in `lib/execution/riskPolicy.js` (`evaluateRiskPolicy`); it never touches the chain or Blob itself.

**Equity** (`lib/execution/executor.js` `walletEquitySnapshot`): the SIGNING wallet's own SOL + stablecoin value, read via `services/walletTracker.js` `getAccountSnapshot()` pointed at an explicit `{ address }` (the executor's own `walletAddress()`, never `TRACKED_WALLET_ADDRESS`, never a key) — `walletTracker.js` stays read-only and its exports unchanged. Cached 60 s (`EQUITY_CACHE_MS`). Open-position collateral ± unrealized PnL (from `readPositions()`, already fresh per call) is added on top (`fullEquityUsd`). An unreadable signing wallet is `equity_unavailable` — refused, never treated as infinite equity.

**Defaults** (env, all optional; `lib/execution/riskPolicy.js` `RISK_ENV` / `RISK_DEFAULTS`):

| Env | Default | Meaning |
| --- | --- | --- |
| `RISK_PCT_PER_TRADE` | 0.5 | % of equity risked at the stop |
| `RISK_MAX_EXPOSURE_PCT` | 25 | sum of open notional / equity |
| `RISK_MAX_PER_SYMBOL_PCT` | 15 | one symbol's notional / equity |
| `RISK_DAILY_DRAWDOWN_PCT` | 3 | today's realized loss / day-start equity |
| `RISK_WEEKLY_DRAWDOWN_PCT` | 8 | last-7-day realized loss / week-start equity |
| `RISK_MIN_FREE_GAS_SOL` | 0.05 | free SOL floor |

**Enforcement** (`preflight`, after the env caps and intent-shape checks, before the market/custody/quote calls): `evaluateRiskPolicy` reasons (`risk_pct_over`, `exposure_over`, `symbol_exposure_over`, `daily_drawdown`, `weekly_drawdown`, `gas_low`, `equity_unavailable`) push into the same `reasons` array as every other gate — a refusal, not a warning. The order carries `equityUsd`, `equitySource`, `riskUsd`, `riskPct`, `exposurePctBefore`/`exposurePct`, `symbolExposurePct`, `suggestedSizeUsd`, `suggestedLeverage`; the audit `preflight` line carries a `risk:{}` block. `dailyPnlUsd`/`weekPnlUsd` come from `pnlWindow(store, nowMs, days)` (generalized from the old single-day `dailyLossUsd`, kept as a thin wrapper). A `daily_drawdown` / `weekly_drawdown` breach also engages the kill switch (reason `risk_daily_drawdown` / `risk_weekly_drawdown`) — every later call refuses `kill_switch` until `/arm` (the env kill still wins); the drawdown itself is unaffected by arming, so it can refuse again on its own merits next call.

**Owner overrides** (`/risk`, `state.prefs.risk`): tighten-only — an override is accepted only when it does not exceed the deployed env default for that knob, and `pctPerTrade` additionally never above 2% absolute (`RISK_PCT_PER_TRADE_MAX`), checked via the executor's `riskPrefBound(key)` (a sync, side-effect-free passthrough to `riskPolicy.js` — the webhook never imports `lib/execution/riskPolicy.js` directly; the executor stays its one sanctioned door into `lib/execution`). `normalizePrefs` (`lib/telegram.js`) carries `prefs.risk` through an unrelated `/alerts` write instead of dropping it.

**Telegram**: the order ticket gets a `risk $X (Y% eq) · exposure B% → A%` line and, when the intent's own size exceeds the suggestion, a `suggested $X` note (Open uses the suggestion unless the owner typed an explicit `size` in `/order`). `/exec` adds equity, exposure, drawdown day/week and a policy summary line. New `/risk` shows the effective policy (env default vs. owner override) and the same live snapshot; `/risk pct|exposure|symbolexposure|dailydd|weeklydd|gas VALUE` sets one override, `/risk reset` clears all. Refusal cards render every reason code (existing ones plus the risk-policy ones) as plain words, unchanged mechanism.

Tests: `test-risk-policy.js` (pure math, all reason codes, sizing, mirrored long/short, prefs bounds), `test-execution.js` (equity source, 60 s cache, drawdown kill + arm, order/audit risk fields), `test-telegram.js` (ticket/exec/risk rendering, `/risk` end to end, prefs survive `/alerts`).

## Profiles (T-9 v2, wallet strategy profiles, 2026-09-26)

**30-trade Steady evaluation — STARTED 2026-09-26T22:08Z** (prod 507cace, the first deploy with profiles live). Starting equity: $523.14 on bot wallet `JEAzPi…TjwT2` (504.30 USDC margin + $18.71 SOL/BTC/ETH holdings; `ACCOUNT_BASELINE_USD=523`). Active profile: `steady` (default). Rule: judge after 30 scored trades (live-taken + as-if-taken shown separately on strategies.html); move to `aggressive` only at ≥ 40 % wins and ≥ 2.5R net; env caps size $150 / loss $5 / day $25 / 1 open / 100x bind throughout.

Two wallet-management profiles (`lib/execution/riskPolicy.js` `PROFILES`), `steady` (default) and `aggressive`, defined and tracked in parallel on every call; only the ACTIVE profile ever sizes a real order.

| Knob | `steady` | `aggressive` |
| --- | --- | --- |
| Risk per trade (default) | 1% | 2.5% |
| Risk per trade (owner override ceiling) | 2% | 3% |
| Max exposure (all open) | 25% | 50% |
| Max exposure (one symbol) | 15% | 30% |
| Daily drawdown → kill | 3% | 6% |
| Weekly drawdown → kill | 8% | 15% |
| Min stop, long / short (fee floor) | 1.5% / 1.0% | 1.0% / 0.7% |
| Tier multiplier A / B / C | 1.5x / 1x / 0.5x | 2x / 1x / 0.5x |
| Boost cap (one-time, next tier) | 1.5x | 2x |
| Leverage, non-A tiers | half the stop-allowed max | the full stop-allowed max |
| Goal (descriptive, never gates a trade) | +2%/10 trades, +5–10%/mo | +25%/10 trades (owner target, expected to fail on a 30%/3R edge — tracked to test it) |
| Judged after | 30 scored trades | 30 scored trades |

**Tier** (`lib/tier.js` `classifyTier`, pure, off a flagRecommendation record's own fields, never re-scored): `readiness==='ready'` + `qualityBand==='high'` + `clarity.gate.passable` + (T-13 net-floor `setup.shadowNF.ready` when that field is present) = **A**; `readiness==='ready'` otherwise = **B**; everything else, including a manual `/order` (no record at all) = **C**. A tier scales that profile's `pctPerTrade` budget by its multiplier (`tieredPolicyConfig`) and, for `leverageRule: 'half'`, halves `suggestedLeverage` for non-A tiers (`applyLeverageRule`).

**Switch** (`state.prefs.risk.profile`, default `steady` when absent — never written until the owner switches): `/risk profile steady|aggressive` prompts `Reply /risk profile aggressive PIN within 60 s`; `/risk profile aggressive PIN` (or the same text typed directly) executes it. Owner + PIN, same auto-kill guard as `/arm` (`lib/execution/executor.js` `switchProfile`) — refuses without ever evaluating the PIN while an auto-kill is active. `/risk` also carries `[Steady ✔] [Aggressive]` inline buttons (`riskProfileKeyboard`) that trigger the same prompt. `/risk pct` overrides `pctPerTrade` bounded by the ACTIVE profile's own ceiling (2%/3% above), every other knob stays tighten-only against that profile's default; `/risk reset` clears numeric overrides only — the active profile itself is untouched ("returns to the profile", not to steady).

**Parallel tracking** (P3): every `preflight`/`createTicket` call evaluates the SAME intent against BOTH profiles (`evaluateAllProfiles`), stamping `order.profile` / `order.tier` / `order.profiles` (`{steady, aggressive}`, each `{tier, riskUsd, sizeUsd, leverage, ok, reasons}`) on the order, the audit `preflight`/`ticket`/`fill` lines, and the journal open record's `execRef.profiles` (`lib/journalSchema.js`, sanitized, additive). Informational only — it never gates the order; only the ACTIVE profile's own `evaluateRiskPolicy` call does that.

**Boost** (P4, `lib/execution/executor.js` `boostTicket`): single-use, replaces an open ticket with one sized at the next tier's multiplier — scaling the ORIGINAL requested size by (next tier's multiplier ÷ this ticket's own tier multiplier), never the wallet-based `suggestedSizeUsd` (which is sized off the stop distance alone and routinely runs to several multiples of equity on a tight stop — appropriate as a ceiling note, not a size to boost toward, since it would blow through `maxExposurePct` on most calls). The boosted ticket runs the full preflight gate again; a refusal (drawdown, exposure, equity-unavailable, already at tier A, or a close/update ticket) leaves the original ticket untouched — only a gate-passing boost consumes it. A ⚡ Boost button rides the ticket card (`ticketKeyboard(nonce, {boost: true})`) whenever the order is not already tier A.

**Goal** (P4, `/risk goal EQUITY_USD by DATE` / `/risk goal off`): a straight-line pace check, descriptive only — `startEquityUsd`/`startAt` are stamped from a fresh equity read the moment the goal is set (`lib/telegram.js` `normalizeRiskGoal`), and `goalAheadFraction` (`lib/execution/riskPolicy.js`) compares current equity's fraction of the target against elapsed time's fraction of the deadline. At **≥25% ahead** of pace, `applyGoalPaceTightening` scales BOTH drawdown caps by `(1 - aheadFraction)` for that profile — tightened, never loosened (behind pace changes nothing).

**Website** (`scripts/tracker/strategies-page.js`, `scripts/tracker/profiles.js`, `scripts/tracker/profileConfig.js`): `strategies.html` — the profile table above, which profile is live (`data/telegram-status.json` `riskProfile`, an owner-facing preference added to the `telegramStatusFromState` whitelist), an equity-curve chart (the real wallet, reconstructed from execution journal closes' `resultUsd` starting at the documented `BOT_WALLET_START_EQUITY_USD`, overlaid with both profiles' VIRTUAL live curves sized off `execRef.profiles[profile].riskUsd`), trades toward each profile's 30-trade evaluation (live-taken vs. as-if-taken on every scored GOOD call, counted separately), and the evaluation rule (≥40% wins and ≥2.5R net to move up). A teaser tile on `index.html` links to it. As-if sizing uses tier B (multiplier 1) as a documented simplification — the qualityBand/clarity.gate fields a real A/B/C read needs are not carried through the scored-call row shape. `profileConfig.js` is a vendored, dependency-free copy of `PROFILES`/`tieredPolicyConfig` (parity-tested against `lib/execution/riskPolicy.js`) so the standalone tracker repo can build without an engine checkout.

`strategies.html` was originally going to be `risk.html`, but merging into `upgrade-signal-engine` hit an add/add conflict: T-14 (tidy-up) had independently built a different, static "Risk & sizing" reference page at that same path. Resolved by keeping both as separate pages — `risk.html` stays T-14's static reference, this dashboard moved to `strategies.html` — cross-linked from every tracker page's nav.

Tests: `test-risk-policy.js` (profile math, tier scaling, leverage rule, boost multiplier, goal pace — additive, all pre-T-9 assertions unchanged), `test-execution.js` (profile/tier/profiles stamped on the order/audit/journal, `switchProfile`, `boostTicket`), `test-telegram.js` (parsing, formatting, keyboards, callback data), `test-tracker.js` (`computeProfileCurves`, `renderStrategies`, `buildPage` strategies.html + teaser, vendored profileConfig.js parity).

**Status (2026-09-26):** merged into `upgrade-signal-engine` (commit `16f8def`), all `test:*` + `check:gpt` green, guard scan and `git diff --check` clean. Synced to the tracker repo and live on the tracker site (`strategies.html`, `risk.html` both 200). **Not yet deployed to Vercel prod** — the deploy step was blocked by this session's permission classifier (denied reading `.vercel`); needs the owner to run it or grant that permission. Steady stays the default either way (no behavior change until the owner acts), so nothing is at risk from the delay. The 30-trade evaluation clock starts once this is live in prod — do not backdate it before then.
