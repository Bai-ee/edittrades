# Master prompt — Agent H (Sonnet): wallet-aware risk policy (T-8)

Paste everything below this line into a fresh Sonnet session. Work in a worktree: `cd /Users/bballi/Documents/Repos/snapshot_tradingview && git worktree add ../snapshot_tradingview-risk-policy -b risk-policy && cd ../snapshot_tradingview-risk-policy && ln -s ../snapshot_tradingview/node_modules node_modules`.

---

You are Agent H. Read `CLAUDE.md`, `docs/AGENT_SESSION_RULES.md`, `docs/PLAN_TELEGRAM_EXECUTION.md` (incl. "Live flow"), `lib/execution/gates.js`, `lib/execution/executor.js` (`preflight`, `dailyLossUsd`, `readPositions`, `status`), `lib/riskEngine.js`, `services/walletTracker.js` (read-only, never change its contract), `lib/telegram.js` (`formatTicketCard`, `formatExecStatus`, the Plan card sizing at ~867–880 and ~1400), `test-execution.js`, `test-telegram.js`, `test-risk.js`.

Owner goal: "track wallet with a risk management feature" so trades can be taken from calls efficiently and safely. Live trading works end to end (2026-09-26). The executor's env caps (EXECUTION_MAX_*) are hard floors and stay as they are. This phase adds a wallet-relative policy on top, read-only toward the chain.

## Deliverables

H1 **Policy module** `lib/execution/riskPolicy.js` (pure, no I/O). Input: `{ equityUsd, openPositions:[{symbol, sizeUsd, collateralUsd, unrealizedPnlUsd}], dailyPnlUsd, weekPnlUsd, intent:{symbol, sizeUsd, leverage, entry, stop}, policy }`. Policy defaults (env, all optional): `RISK_PCT_PER_TRADE` 0.5 (% of equity at the stop), `RISK_MAX_EXPOSURE_PCT` 25 (sum of open notional / equity), `RISK_MAX_PER_SYMBOL_PCT` 15, `RISK_DAILY_DRAWDOWN_PCT` 3, `RISK_WEEKLY_DRAWDOWN_PCT` 8, `RISK_MIN_FREE_GAS_SOL` 0.05. Output: `{ ok, reasons:[...], suggestedSizeUsd, suggestedLeverage, riskUsd, riskPct, exposurePct, drawdown:{dayPct, weekPct}, notes:[] }`. Reason codes: `risk_pct_over`, `exposure_over`, `symbol_exposure_over`, `daily_drawdown`, `weekly_drawdown`, `gas_low`, `equity_unavailable` (refuse: an unreadable wallet is never "infinite equity"). Sizing: `suggestedSizeUsd = min(env cap, equity × riskPct / stopDistancePct)`, leverage from `lib/riskEngine.js` `maxLeverageForStop` capped by env.

H2 **Equity source.** Equity = the SIGNING wallet's value (SOL + stables + open-position collateral ± unrealized PnL), not the tracked wallet: reuse `services/walletTracker.js` snapshot logic pointed at the executor's `walletAddress()` (inject; never import a key). Cache 60 s in the executor. `status()` exposes `equityUsd`, `equitySource`, `equityAgeSec`, and the policy numbers.

H3 **Executor wiring.** `preflight` calls the policy after the env caps and before quoting; policy reasons refuse like any gate (audit `preflight` carries `risk: {...}`); the order object carries `riskUsd`, `riskPct`, `exposurePct`, `suggestedSizeUsd`. Drawdown breach also engages the kill switch with reason `risk_daily_drawdown` / `risk_weekly_drawdown` (arm clears it; the env kill still wins). `dailyPnlUsd`/`weekPnlUsd` from the journal + live audit closes (extend `dailyLossUsd` into a `pnlWindow(store, nowMs, days)`).

H4 **Telegram.** Ticket card gets `risk  $0.08 (0.5 % eq) · exposure 3 % → 5 %`; when the intent size exceeds the suggestion, the card says `suggested $X` and the Open flow uses the suggestion unless the owner typed an explicit `size`. `/exec` shows equity, drawdown day/week, exposure, policy line. New `/risk` shows the policy and `/risk pct 0.5` etc. writes overrides to `state.prefs.risk` (bounded: never above env caps, never above 2 % per trade). Refusal cards render the reason codes in words.

H5 **Tests**: policy math (all reason codes, sizing, mirrored long/short), equity unavailable refuses, cache, drawdown kill + arm, ticket/exec/risk rendering, prefs bounds. All 14 suites green; `git diff --check`.

H6 **Docs**: `docs/PLAN_TELEGRAM_EXECUTION.md` "Risk policy" section, connector doc env rows + commands, CHANGELOG, tracker how-to line if it lives in this repo.

## Hard rules
`services/walletTracker.js` stays read-only and its exports unchanged. No new libraries. Never weaken env caps, the 3 % stop guard, the drift guard, kill, PIN. Never log keys, bearers, RPC URLs, or the signing address in full (hash or first-6 only, as `audit.js` `idHash` does). No deploy, no env, no orders. Stage by name; commit per deliverable; do not push; stop after H6.

## Handback
Commits · test counts before → after · the exact policy defaults and where each is enforced · what refuses vs what only warns · anything skipped and why.
