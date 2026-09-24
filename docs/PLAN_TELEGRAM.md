# T-1 — Telegram alerts + read commands (owner-approved 2026-09-24)

Status: plan; implementer starts on the orchestrator's go. Read-only toward the engine; never execution.
Goal: the owner's phone gets a Telegram message the moment a GOOD or SETUP appears, and can ask the engine the same questions the GPT answers, plus chart snapshots and journal logging. No GPT in the loop.

## Boundaries (hard)
- Never calls, imports or exposes `api/execute-trade.js`, `services/jupiterPerps.js`, `services/walletManager.js`, or any signing code. `TRADE_EXECUTION_ENABLED` stays untouched. No `/buy`, `/sell`, `/open`, `/close` commands exist.
- Only the owner's Telegram user id (env `TELEGRAM_ALLOWED_USER_IDS`) gets answers; everyone else gets silence.
- Secrets: `TELEGRAM_BOT_TOKEN` (Vercel env, set by the orchestrator), webhook secret `TELEGRAM_WEBHOOK_SECRET`. Never logged.
- Vercel Pro: functions cap lifted; cron every minute allowed. Still keep functions minimal.
- No engine rule/threshold change (two-week freeze). Journal writes go through the existing `POST /api/journal` handler code path (import the same append function), same record schema, `source: "telegram"`.

## Build
1. `api/telegram-webhook.js` (POST, verifies `X-Telegram-Bot-Api-Secret-Token`): parses commands, replies via Bot API `sendMessage` / `sendPhoto`. Commands: `/signals`, `/why <SYM>`, `/flags [SYM]`, `/wallet`, `/journal [n]`, `/status`, `/chart <SYM> <tf>`, `/log <text>`, `/help`, `/testalert`. Text formatting in Telegram MarkdownV2 or HTML, one metric per line, matching the GPT's FORMAT where sensible (GO IN / HOLD / NO TRADE + SETUP lines).
2. `api/telegram-cron.js` (GET, guarded by `CRON_SECRET` header from Vercel cron): every minute builds the compact context, compares to the last alert state in Blob `telegram/state.json` (per symbol: recommendation class, setup id, plan id/status, GOOD readiness), and sends: NEW GOOD (full plan levels, gross/net R, change condition, mark drift, tracker link), NEW SETUP (trigger sentence), GOOD → rejected/void, DATA_UNAVAILABLE/stale for > 5 min, mark unavailable for > 5 min. Dedup by ids; quiet hours env optional. Attaches the chart image for GOOD alerts.
3. `lib/telegram.js`: pure formatter (payload → messages) with tests; Bot API client with 5 s timeout; never throws to the cron.
4. `vercel.json` `crons`: `/api/telegram-cron` `* * * * *`. Routes for both functions.
5. Tracker page: "Alerts" row in Status (last alert time, alerts today, cron health), read from `telegram/state.json` via the manifest pattern the journal uses.
6. Docs: connector doc endpoint table (both functions, auth), CHANGELOG, DOCUMENTATION_INDEX, ARCHITECTURE_MAP (Delivery stage), test:archmap green.
7. Tests: `test-telegram.js` (formatter cases per class incl. SETUP; dedup logic; allowlist rejects; webhook secret rejects; no execution import; commands parse). MCP tests unchanged.

## Owner steps
- BotFather → `/newbot` → send the token to the orchestrator (not in chat with the agent). `/start` the bot once, then `/status` to confirm.
- Orchestrator sets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` in Vercel and registers the webhook URL.

## Verification
All suites + test:telegram; check:gpt unchanged; prod: webhook 403 without secret, cron 401 without secret; `/status` answers on the phone; `/testalert` delivers a sample GOOD card with chart; cron sends nothing when nothing changed.

## Later (separate approval)
T-2 manage: position card from journal + mark, stop/TP proximity alerts, "protect to" hints. T-3 execution: only after the two-week record, behind allowlist + two-step confirm + size/loss caps + kill switch + separate key.

## Levels + quiet hours (owner spec 2026-09-24, notification-only)
Built in `lib/telegram.js` (`diffAlerts`, `parseAlertsArgs`, `inQuietHours`), `api/telegram-cron.js`, `api/telegram-webhook.js`; no engine, threshold, schema or config change; no new file or dependency.
- **Levels** in Blob `telegram/state.json` `prefs.level`: `good` (GOOD + GOOD ended), `setup` (adds SETUP; default), `watch` (adds new forming/triggering flag candidates). Data and mark health alerts always send. GOOD/SETUP detection and dedup are unchanged; a SETUP held back by level `good` is still remembered, so raising the level does not replay it.
- **Watch alerts**: once per new candidateId in state `forming` or `triggering` (never proto, failed, expired, confirmed); rolling memory of the last 200 ids (`state.watch.ids`); per-symbol cooldown 15 min (`state.watch.lastAt`). An alerted forming candidate that turns triggering passes the cooldown once. A candidate held back by the cooldown is not remembered, so it alerts when the cooldown ends if still live. One line, no chart: `WATCH · BTC 3m LONG forming · break 84,466.10 / void 84,331.60 · 2.4R · td:bull:3/4` (`TRIGGERING · …` for triggering; the td code is the symbol's top-down reason code, omitted when absent).
- **Quiet hours** in `prefs.quiet` (`{start, end}` hours, start inclusive, end exclusive, may wrap midnight; `null` = off): default 01:00–05:00 America/Chicago, every day. Clock via `Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' })`, so DST is handled. Alerts inside the window send with `disable_notification: true`; nothing is dropped. The old UTC `TELEGRAM_QUIET_HOURS` env is no longer read.
- **Commands**: `/alerts` (show), `/alerts good|setup|watch`, `/alerts quiet HH-HH`, `/alerts quiet off`, `/alerts quiet` (show). Saved with the same ETag-guarded `updateBlob` the cron uses, so a concurrent cron run cannot lose the change. `/status` shows level and quiet window; `/help` lists the commands.
- **Tests** (`test:telegram` 41): level gating per class, watch dedup + cooldown + triggering pass-through + 200-id roll, quiet hours CDT/CST/weekend/wrap/off, `/alerts` parsing, prefs persistence through webhook and cron.

## Buttons (owner priority 2026-09-24, notification-only)
- **Reply keyboard** (`ReplyKeyboardMarkup`, `resize_keyboard`, `is_persistent`) on `/start`, `/menu` and every plain reply: `Signals`, `Flags` / `Why BTC`, `Why ETH`, `Why SOL` / `Charts`, `Wallet` / `Journal`, `Status`, `Alerts`. A tapped label (exact, case-insensitive) runs its command. Replies that carry an inline picker (`/signals`, Charts, Alerts) use that instead; the persistent keyboard stays on screen.
- **Inline callback_data** (all ≤ 64 bytes): `chart:BTC:1m` (Charts grid BTC/ETH/SOL × 1m/3m/5m/15m/1h, and the Chart button at the plan timeframe), `why:BTC`, `alerts:good|setup|watch`, `alerts:quiet:on` (default 01-05) / `alerts:quiet:off`, `log:took:BTC:<ref>` / `log:skip:BTC:<ref>` where `<ref>` is the 8-hex FNV-1a of the candidateId.
- **Trade buttons** (`Why`, `Chart`, `Took it`, `Skipped`) on every GOOD and SETUP alert and per symbol on `/signals` (Took/Skipped only when the symbol has a GOOD plan or a SETUP). The cron stores the alert's plan snapshot in `telegram/state.json` `buttons[<ref>]` (last 50); a tap journals from that snapshot, else from the live plan whose candidateId hashes to the ref, else explains. Took it = kind `open`, Skipped = kind `skip`, with symbol, direction, entry/stop/tp1 and `engineRef` {candidateId, planId, recClass, reasonCode}; id `tg_open_<ref>` / `tg_skip_<ref>` (double tap logs once); `source: "telegram"`; same `appendRecord` path as `/log`.
- **Webhook**: handles `callback_query` (allowlist on the tapping user, `answerCallbackQuery` before any build). The orchestrator re-registers with `setWebhook` `allowed_updates: ["message","callback_query"]`.
- **Tests** (`test:telegram` 49): keyboard on replies, label→command mapping, Charts/Alerts pickers, callback parsing and 64-byte cap, alert/`/signals` buttons, Took it/Skipped records from state and live fallback, callback allowlist.
