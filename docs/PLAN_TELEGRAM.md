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
