# Spot EMA20 trend — P3 paper → live (plan only, not approved for build)

Owner decision 2026-09-28 (`docs/OWNER_DECISIONS_2026-09-28.md`). P1/P2 (paper ledger + flip alerts) are live on `spot.html` (`scripts/tracker/spot-trend.js`, `lib/slowTrendSpot.js`). This is the smallest safe path to real spot execution; nothing here is built.

## Objective
Hold BTC/ETH/SOL spot while each coin's daily close is above its EMA20, otherwise USDC, at the vol-targeted weight the paper ledger already computes, with one Telegram card per flip and the same tap + PIN discipline as perps.

## Current relevant architecture
- Rule + paper ledger: `scripts/tracker/spot-trend.js` (tracker repo, self-contained), decided on the UTC daily close, applied next day, 0.15% switch cost, VOL_TARGET 0.4.
- Engine alert: `lib/slowTrendSpot.js` (daily SMA140 regime flip, info-only) — a stand-in, NOT the EMA20 rule. P3 must alert on the EMA20 rule itself, not SMA140.
- Execution: `lib/execution/*` is perps-only (Jupiter Perps). There is no spot swap path.
- Wallet: the bot wallet holds SOL + USDC; `services/walletTracker.js` is read-only.

## Proposed direction (smallest safe path)
1. **Rule parity in the engine** — port EMA20/vol-target from `spot-trend.js` into `lib/spotTrendRule.js` (one implementation, tests check parity with the tracker's numbers). Replace the SMA140 stand-in alert with the EMA20 flip card. No orders yet. Card carries a fixed WHAT TO DO caption: "Flip to IN: buy X USDC of SOL at market. Flip to OUT: sell all SOL to USDC."
2. **Spot swap adapter** — `lib/execution/spotSwap.js` behind the SAME gates (`TRADE_EXECUTION_ENABLED`, `EXECUTION_MODE=live`, PIN, kill switch, caps). Jupiter Swap API (not perps), exact-in, slippage cap 0.5%, sized from the paper weight × spot allocation cap (new env `SPOT_MAX_USD`, default 0). Two-phase: quote → ticket → confirm PIN → swap → verify balance via walletTracker. Exactly-once by actionId, same as perps.
3. **Cards** — flip card gets an `Open` row only when spot execution is enabled; result card shows fill, cost, new balance; `/spot` command shows state per coin, weight, last flip, and paper vs live equity.
4. **Tracker** — `spot.html` gains a live ledger next to the paper one (from journal spot records), same curve construction rules.

## Keep vs change
- Keep: paper rule and ledger unchanged; perps executor untouched; MCP read-only; walletTracker read-only.
- Change: one new rule lib, one new adapter under `lib/execution/`, alert kind SPOT_FLIP replaces SLOW_TREND, `/spot` command, tracker live ledger.

## Files likely involved
`lib/spotTrendRule.js` (new), `lib/execution/spotSwap.js` (new), `lib/execution/executor.js` (dispatch only), `api/telegram-cron.js`, `api/telegram-webhook.js`, `lib/telegram.js`, `scripts/tracker/spot-page.js`, `scripts/tracker/spot-trend.js` (export only), tests for each, `openapi`, connector doc, CHANGELOG.

## Risks
- Spot swaps move real coins, not margin; a wrong direction is a full-position error. Mitigation: caps, PIN, dry-run mode first (`EXECUTION_MODE=dry` already exists), and the first flips run at `SPOT_MAX_USD` = $25.
- Vol-target weights change daily even without a flip; P3 should rebalance only on flips (weight fixed at entry), not daily, to keep cost and touch count low. Paper ledger differs slightly — document, do not chase.
- Jupiter Swap API differs from the perps client; new dependency surface. Pin version, patch-package if needed.
- Frequency is low (a few flips a year per coin): live proof will take months. This is a hold strategy, not a signal stream.

## Recommended phase order
- P3a: rule parity + EMA20 flip card (info-only). Tests. Deploy. ~1 phase.
- P3b: spot swap adapter, dry mode only, ticket/PIN/verify path tested against the real quote API with no send. ~1 phase.
- P3c: live at `SPOT_MAX_USD=25`, first real flip observed, then raise by owner decision.
- P3d: tracker live ledger.

## Approval recommendation
Approve P3a only. P3b touches `lib/execution/` and needs its own review before coding.
