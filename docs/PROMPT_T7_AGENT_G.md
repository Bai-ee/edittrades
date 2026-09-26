# Master prompt — Agent G (Sonnet): focus mode + Open from any levelled alert (T-7)

Paste everything below this line into a fresh Sonnet session opened in `/Users/bballi/Documents/Repos/snapshot_tradingview` on branch `upgrade-signal-engine`.

---

You are Agent G. Read `CLAUDE.md`, then `docs/PLAN_TELEGRAM.md`, `docs/PLAN_TELEGRAM_EXECUTION.md` (incl. "Live flow"), `lib/telegram.js`, `api/telegram-cron.js`, `api/telegram-webhook.js`, `lib/execution/executor.js` (only `listPositions`, `preflight`, `createTicket`), `test-telegram.js`. Baseline: the current HEAD of `upgrade-signal-engine` (≥ 520b064; live perps trading works end to end as of 2026-09-26).

Owner request (2026-09-26, verbatim intent): "when I'm in a position all other alerts should stop that aren't related to that position. I should be able to turn this off in Telegram. Otherwise if I enter a position it's only the tracking alerts that get sent until that position closes. Also make sure the alerts that come through have the ability to place the trade according to those SL and TP."

Working tree note: files dirty from another session (`config/engine.*`, `lib/volumeContext.js`, `test-volume-context.js`, `services/scalpContext.js`, `openapi/`, several docs, `PRODUCT.md`) — never stage, edit, revert or commit them. Stage your files by name; never `git add -A` / `git add .`. Code and tests only: no deploy, no env, no secrets, no network in tests.

## Deliverables

G1 **Focus mode (state + pref).** `state.prefs.focus`: `'auto'` (default) | `'off'`. `normalizePrefs` (lib/telegram.js ~2191) handles missing/malformed → `'auto'`. `applyPrefs`/`/alerts` parser (~line 235–240) gains `/alerts focus auto|off`; callback `alerts:focus:auto` / `alerts:focus:off`; `/alerts` usage line updated. `/status` (formatStatus ~1088) and `/exec` show a `Focus` row: `auto (SOL open)` / `auto (no position)` / `off`. Persistent menu: add a `Focus` button that toggles and replies with the new state.

G2 **Live-position snapshot for the cron.** In `api/telegram-cron.js`, when `TRADE_EXECUTION_ENABLED === 'true'`, read live positions once per run through the executor (`listPositions`, `lib/execution/executor.js:960`; inject via the existing executor factory/mocks used by tests) and cache `{at, symbols:[...], positionIds:[...]}` in `state.livePositions`. Reuse the cache if `< 60 s` old or if the read fails (log `positions_read_<ErrName>`; never treat a failed read as "no positions" — keep the last snapshot and its age in the status row). Read-only; no signing, no imports beyond the executor API.

G3 **Focus filter.** In the cron, after `diffAlerts` and the existing level/timeframe/quiet/tracked filtering (~line 175–195) and BEFORE `withOpenButton`: if `prefs.focus === 'auto'` and the snapshot has ≥ 1 live position, keep only alerts where (a) `a.symbol` is an open position's symbol, or (b) `a.kind === 'TRACK'` for a tracked candidate whose symbol is open, or (c) health/exec/system alerts (whatever kinds today bypass the level filter — reuse that predicate). Every dropped alert is still written to the alert log line with `delivered:false, suppressed:'focus'` (extend `alertLogLine`; the tracker reads these). Transitions of the OPEN position's tracked candidate (TP1/stop hit, void, get_in_now) always pass. When the snapshot goes from ≥1 to 0 positions, send one line `🔎 Focus off — position closed, all alerts resumed.` (suppressed by `focus:'off'`).

G4 **Open from any levelled alert.** Today `withOpenButton` (lib/telegram.js ~2770) is attached only to GOOD / tracked get_in_now when `isOpenReadySymbol` (cron ~187–192, webhook `/plan` ~716). Extend: when execution is enabled and the alert carries `entry`, `stop`, `tp1` (SETUP, BREAKOUT, tracked transitions with a plan; NOT WATCH/TRIGGERING unless the owner says otherwise), attach `Open` too. Labels: `Open @ plan` when `isOpenReady`, else `Open (early)`. The webhook's `open:<ref>` handler already re-runs preflight (caps, drift ≤ 15 bps, stop ≤ 3 %, kill, PIN) — do not weaken any gate; an early open that fails a gate must show the normal refusal card. The ticket card gets one extra line `from <KIND> <symbol> <tf> · <ref>` so the journal `engineRef` links the alert. Confirm the executor's `intent` gets that alert's `entry/stop/tp1` (not the live mark) as the plan levels; the fill drift check stays against `entry`.

G5 **Tests** (`test-telegram.js`, mocked executor/blob, no network): focus auto with a live SOL position drops BTC/ETH alerts and keeps SOL + tracked-SOL transitions + health; focus off sends everything; snapshot cache reuse < 60 s and on read failure (keeps last, never "no positions"); "position closed, alerts resumed" line once; `/alerts focus`, `/status` + `/exec` rows, menu button; Open on SETUP/BREAKOUT with levels (`Open (early)` vs `Open @ plan`), no Open without levels or with execution off, WATCH has none; ticket card `from` line; alert log lines carry `suppressed:'focus'`. All 14 `npm run test:*` suites green; `git diff --check`.

G6 **Docs**: `docs/PLAN_TELEGRAM.md` (focus mode section + Open button rules), `docs/EDITTRADES_MCP_CONNECTOR.md` commands table row, `CHANGELOG.md`, and the tracker how-to source if it lives in this repo (`scripts/tracker/` or `docs/`; otherwise say so in the handback).

## Hard rules
Never import execution code from `services/scalpContext.js`, `services/editTradesMcp.js`, `lib/mcpHttp.js`; `api/telegram-webhook.js`, `lib/telegram.js`, `api/telegram-cron.js` must not mention `jupiterPerps`, `walletManager`, `signTransaction`, `Keypair` (a test scans for these). Never log or return keys/bearers/RPC URLs. Do not change caps, gates, the 3 % stop guard, the 15 bps drift guard, or engine rules (frozen until 2026-10-08). Presentation and routing only.

## Commits
One per deliverable group: `feat(telegram): focus mode …`, `feat(telegram): open from levelled alerts …`, `test: …`, `docs: …`. Do not push. Stop after G6.

## Handback (exactly this, compact)
- Commits (hash + subject)
- Test counts per suite before → after
- Which alert kinds now carry Open, and the exact label rule
- What "related to the position" means in code (the predicate), and what still bypasses focus
- Anything not implemented and why
