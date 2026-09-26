# Changelog

## 2026-09-26 — T-13: net-floor shadow (NF) + trade chart on entry / taken (shadow + presentation only)

Branch `net-floor` (Agent J). Live rules unchanged (gross `flagPlan.minRR` 2.5, room / chase / retest, alert levels, caps, dedup); NF is shadow only until the freeze ends 2026-10-08. No new library, no env, no deploy, no GPT text change (`check:gpt` unchanged). Additive fields, no schemaVersion bump on this branch (the orchestrator assigns one at merge).

- **NF shadow** (`lib/flagTradePlan.js` `netFloorStopDistance`, `services/scalpContext.js` `FLAG_PLAN_SHADOW_VARIANTS` NF): the live plan's own candidate (and the SETUP's) re-attempted with its stop floored at `max(0.5 x ATR(15m), 3 x round-trip cost)` (0.34 % long / 0.14 % short), TP1 unchanged, gross >= 2.5 and net >= 1.0, every other live gate unchanged. Published as `flagTradePlan.shadow.NF` `{candidateId, status, reasonCode, ready, stop, tp1, grossRR, netRR, stopPct, floorPct}` (always, include=model / served records only) and `flagRecommendation.setup.shadowNF` `{ready, netRR}` (default payload). Byte budget: the compact `flagRecommendation.trace` drops `symbol`/`class` (repeats; `model.recommendation` keeps them) - synthetic worst case 81,152 -> 81,182 B (cap 81,200, not raised); 2026-09-23 fixture build max 81,398 -> 81,307 B default, 46,255 -> 46,164 B compact.
- **Tracker** (`scripts/tracker/nf-shadow.js`, `npm run tracker:nf-shadow`, workflow step after vb-shadow): every live ready call (capture / served rows and the Telegram per-minute GOOD log), first ready moment per candidate, walked twice - own stop vs NF stop - with calls/day, fills, win %, gross and net expectancy side by side on the page (`#nf-shadow-section`) and in `report.md`. Rows without an engine NF are backfilled (ATR from stored 15m candles; labelled `backfill`). Backfill on the tracker data through 2026-09-26: 14 live calls (6.2/day), win 28.6 %, +0.32R gross, -3.52R net; NF would have taken 0 of 14 (the 3 x cost floor binds on every one).
- **Telegram**: `net floor:` line on the GOOD and Plan cards; trade chart (`lib/chartRender.js` `tradeOverlay`: 120 candles via the new `buildScalpContext` `chartWindow` option, entry / stop / TP lines, 15 % risk / reward bands, NF stop dashed, `R 1:x gross · 1:y net` legend) sent with every GOOD / TRACK · GET IN NOW (one photo, card + approach block as caption when it fits 1,000 chars), on Took it, on a live FILLED result (result card as caption) and via `/chart SYM [TF] trade`. 3-line approach block (Enter / Wrong if / Worth it net of fees). `sendPhoto` accepts `replyMarkup`. `/flags` albums and plain `/chart` unchanged.
- Tests: `test:flagplan` 69 -> 74, `test:scalp` 120 (+1 pre-existing failure: stale `clarity` compact key list, fixed) -> 122, `test:chart` 18 -> 22, `test:telegram` 135 -> 145, `test:tracker` 114 -> 119; `test:geometry` 36 (identity check now excludes `flagTradePlan.shadow`, stripped by design). `git diff --check` clean.

## 2026-09-26 — T-12: tracker GOOD calls sourced from the 1-minute Telegram alert log (tracker only, no engine/rule change)

Tracker (`scripts/tracker/`) and its tests only; no engine, alert-content or rule change (frozen until 2026-10-08); the tracker stays read-only toward the engine and wallet. `docs/GAP_CHECK_2026-09-26.md`: the 10-minute capture cadence missed most GOOD calls (a GOOD window runs 2–5 min, sometimes under 1) — a config-matched sample caught only 5/17 (29%). Master prompt: pasted by the owner, "Agent F4 (Sonnet): score GOOD calls from the per-minute alert log (T-12)".

- `collect.js` (pure): `goodCallsFromAlertLines` (first kind-`GOOD` line per symbol+candidateId is the call, levels from that line), `goodCallsFromCaptureRows` (same from stored captures), `mergeGoodCalls` (merge by symbol+candidateId — earlier `calledAt` wins, capture levels fill in only when the alert line has none, `sources` records every origin, no duplicates), `goodEndedTimesFromAlertLines` (a GOOD_ENDED line carries no candidateId of its own; matched to whichever candidate is open for its symbol → `endedAt`).
- `score.js` `scoreGoodCalls` / `scoreGoodCallsDataDir`: walks each merged call from its own `calledAt`, prefilled exactly like a captured ready plan, into `data/good-call-outcomes.jsonl` (continuous back to the alert log's first ingested day — no separate backfill step, the whole stored log is re-read every run); capture-only fallback when the alert log is empty or missing.
- `aggregate.js`: when `good-call-outcomes.jsonl` has rows in a window, `classCheck`'s GOOD row, `windowBlock`'s tradable/bySymbol/byTimeframe stats and the phase block's 30-plan target read from it instead of the capture-only ready-plan rows — the headline 7d tiles, the phase progress bar and the class-check GOOD row now count every GOOD the engine emitted, not just the ones a 10-minute poll caught. Empty/missing keeps the old capture-only behavior. New GOOD-row fields `oneMinLogCalls` / `capturedCalls` / `medianGoodWindowMin`; new top-level `goodCallLogSince`.
- Page + report: class-check table gains three GOOD-only columns (`Calls (1-min log)`, `Of which captured`, `Median GOOD window (min)`; dash elsewhere) and a one-line note under the table (`#class-check-good-log-note`): "GOOD calls come from the engine's 1-minute alert log since \<date\>; before that from 10-minute captures."
- Tests: `test:tracker` 114 → 120 (merge/dedup, alert-sourced scoring, backfill idempotent, capture-only fallback, GOOD window length, classCheck + phase target wiring, page/report rendering). `git diff --check` clean.

## 2026-09-25 — T-7: Telegram focus mode + Open from any levelled alert (presentation and routing only, nothing enabled)

Code and tests only; no engine rule, threshold, cap, gate or schema change (frozen until 2026-10-08). Master prompt: pasted by the owner, "Agent G (Sonnet): focus mode + Open from any levelled alert (T-7)". Baseline: HEAD of `upgrade-signal-engine` (live perps trading built T-3 F).

- **Focus mode** (`state.prefs.focus`, default `'auto'`): while a live position is open (`api/telegram-cron.js` reads it once per run via the executor's read-only `listPositions()`, `lib/telegram.js` `LIVE_POSITIONS_CACHE_MS` = 60 s cache in `state.livePositions`, never treats a failed read as "no positions"), every alert not on that symbol — and not a tracked candidate on it, or a health/data alert (`MARK`/`DATA`/`DATA_OK`, `focusRelated`) — is held back instead of sent, logged `delivered:false, suppressed:'focus'` (`alertLogLine` extended). The moment the last position closes, one unfiltered line goes out: `🔎 Focus off — position closed, all alerts resumed.` `/alerts focus auto|off`, the `alerts:focus:auto|off` inline buttons, and a new persistent-menu `Focus` button (toggles, replies with the new state) all change it; `/status` and `/exec` gain a `Focus` row (`auto (SOL open)` / `auto (no position)` / `off`).
- **Open from any levelled alert**: `withOpenButton` now labels `Open @ plan` (a ready GOOD / GET IN NOW plan, unchanged from before) or `Open (early)` (a SETUP, BREAKOUT, or tracked-setup transition that has entry/stop/TP1 on file but is not yet ready — never WATCH/TRIGGERING, and never a GOOD plan still pending its own readiness call). `orderIntentFromCandidate` (new; `orderIntentFromPlan` kept unchanged for the ready path and its existing tests) builds the early intent from the candidate's own breakout/invalidation/measured-target levels — never the live mark — sized off the same risk block as before, `{error}` with "use /order" when there is none. The webhook's `open:<ref>` handler and every gate it already ran (caps, kill, PIN, the 15 bps entry-drift guard, the 3% stop cap) are unchanged; an early Open that fails a gate shows the same refusal card. The ticket card gains one line, `from <KIND> <symbol> <tf> · <ref>`, so the journal's existing `engineRef` (candidateId/planId/recClass, already threaded through unchanged) can be traced back to the alert that offered it.
- Tests: `test:telegram` 114 → 128 (focus predicate and state normalization, live-position snapshot cache reuse/refresh/failure, focus auto suppressing unrelated symbols while keeping the open symbol + health, the resume line, SETUP/BREAKOUT Open labelling and ticket `from` line, `/alerts focus`, `/status` + `/exec` rows, the `Focus` menu button); `test:jupiter` and `test:execution` untouched (37, 64). All fourteen suites green; `git diff --check` clean.
## 2026-09-26 — Alert clarity Phase A reconciled on main: orchestrator decisions, openapi, schema 1.27.0 (not deployed)

One implementation on top of main's 95da792 (`buildClarity` in `lib/flagRecommendation.js`, the gate/context wiring in `lib/telegram.js`). Presentation only (`docs/PLAN_ALERT_CLARITY.md`): no rule, threshold, gate, config or MCP change; `configVersion` unchanged. Schema 1.25.0 → 1.27.0 (1.26.0 is reserved by the volume work).

- Orchestrator decisions (2026-09-26): WATCH/TRIGGERING verdict is `STAND DOWN` only for `chase` (or a dead flag); `rr` and `room:blocked` read `WAIT (eta) — <gate text>`; `BE READY` only when passable. The default payload's `flagRecommendation.clarity` carries `candidateId`, `gate`, `killIf`, `otherSide` only; `context` and `divergence` stay in `model.recommendation` (include=model). Live default payload 76,282 B; byte caps unchanged.
- `clarity.context` no longer repeats the gate blockers (they are in `gate.text`). `clarity.gate.minRR` publishes `flagPlan.minRR`; Telegram's gate reads the floor from it (`floorOf`) instead of the hardcoded 2.5 (kept only as the fallback when a record has no clarity, and for the rejected-plan stand-down reason).
- Telegram context block on the default payload: the candidate's non-blocking qual codes in words, top-down, one divergence line, then `Kill if:` / `Other side:` from `clarity` when it names the candidate.
- `openapi/scalp-context.yaml`: `RecommendationClarity` on `FlagRecommendation` and `FlagRecommendationFull` (gate.minRR; context/divergence full record only).
- `docs/ARCHITECTURE_MAP.json`: adds `lib/trackStory.js` (missed in a052b16).
- Tests: `test:flagrec` 33, `test:flagrec:fixtures` 19, `test:telegram` 135 (room → WAIT, compact-clarity context, record floor), `test:scalp` 121 (compact keys gain `clarity`); schema pins 1.25.0 → 1.27.0.

## 2026-09-25 — Execution T-3 F: live Jupiter perp trading — landing, keeper fill, two-phase open, Telegram phase card (not deployed, nothing enabled)

Code and tests only; no env change, no deploy, `EXECUTION_MODE` stays `dry` in every environment. Baseline b583bdb (`docs/PLAN_LIVE_PERPS_TEST.md`).

- `services/jupiterPerps.js`: `landTransaction(signedTx, connection, opts)` rebroadcasts the identical signed bytes every `rebroadcastEveryMs` (2 s) while the outcome is unknown and declares `expired` only once the finalized block height has passed the transaction's `lastValidBlockHeight` AND a fresh `getSignatureStatuses` lookup still finds nothing; `sendSigned` now lands through it instead of `sendAndConfirmTransactionFactory`. `waitForFill(positionRequestPDA, positionPDA, connection, opts)` polls the keeper fill (Perps v2 `buildOpenPosition` only submits a request; a keeper fills it seconds later): filled once the request account is gone/`executed:true` and the position decodes with `sizeUsd > 0`; `timeout` or `rejected` otherwise. New `buildCancelIncreaseRequest` (the IDL's `closePositionRequest`) cancels an unfilled request on timeout; new `fetchAccountsExist` backs the executor's post-open verify.
- `lib/execution/executor.js`: live open is now two-phase — build the increase WITHOUT stops → land → `waitForFill` → build + land the SL/TP trigger requests → verify (on-chain position + trigger-request read) → journal `open` only once verified, with the fill price read off the position account. A stops-attach or verify failure immediately submits a full market close (`emergencyClose`); if that close also fails the kill switch engages and the close retries every 5 s for up to 2 min, alerting at each turning point (`deps.onAlert`, injectable). Live close / update stay on the existing build → simulate → `sendSigned` path (now landing through the same rebroadcast/expiry machinery for free) plus a new post-send on-chain verify before journaling. `LIVE_CAPABILITIES` flips to `{openWithStops, close, update: true}` — the per-capability refusal gates stay in the code, testable via an explicit `capabilities` override. Exactly-once: every live open/close/update run gets a ticket-nonce-derived `actionId`; its terminal result is recorded in Blob `execution/actions.json` (ETag-guarded, ids hashed and secrets redacted before storage) the first time it is reached, and a second resolve of the same `actionId` replays the recorded result instead of resending or double-journaling. `listPositions()` now attaches `{stop, tp}` to each chain position from the most recent execution open/adjust journal record (the base Position account itself carries no SL/TP).
- `lib/journalSchema.js` `EXEC_REF_FIELDS` gains `actionId` (additive), linking a journal entry to its exactly-once ledger record.
- Telegram (`lib/telegram.js`, `api/telegram-webhook.js`): the order result card edits one message in place as the live open progresses (`submitted → filled @price → stops attached → verified`, via a new `ctx.onPhase` callback); a stops-attach/verify failure renders a distinct 🛑 EMERGENCY CLOSE card (flagging KILL ENGAGED when the close itself failed); `/positions` gains a `stops: SL ✔ TP ✔` / `⚠ none` line per position. Dry-run confirms are unaffected. `createBotClient` gains `editMessageText` (falls back to a fresh send) and `sendMessage` now returns `message_id`.
- Tests: `test:jupiter` 26 → 36 (landing state machine, `waitForFill`, `buildCancelIncreaseRequest`, `fetchAccountsExist`), `test:execution` 57 → 64 (two-phase open happy path + every failure branch, exactly-once, `listPositions` stops), `test:telegram` 107 → 113 (phase card, emergency-close card, `/positions` stops line). All fourteen `npm run test:*` suites green; `git diff --check` clean.
- Known limits, not yet resolved: `landTransaction`'s `logs` field is always `null` (`getSignatureStatuses` carries no program logs — a real log read would need `getTransaction` after confirmation); `buildCancelIncreaseRequest`'s account shape (self-serve cancel, `keeper` = the same wallet) and whether `closePositionRequest` tolerates a position that has never been filled are unverified against a live cluster; the two-phase open's total wall-clock budget (up to 90 s landing + 60 s fill wait + a possible 2 min emergency-close retry) does not fit a typical serverless request timeout and needs an owner decision before any live test (see the T-3 F handback).

## 2026-09-25 — Execution T-3 A: guarded Jupiter perp executor, tickets, audit, real position read (not deployed, nothing enabled)

No env change, no deploy, no rule / schema / config change. MCP, the GPT Action and `services/scalpContext.js` never reach `lib/execution` (`test:execution` walks their imports).

- `lib/execution/executor.js` (contract in `docs/PLAN_TELEGRAM_EXECUTION.md`): `preflight(intent, ctx)`, `createTicket(order, ctx)`, `confirm(nonce, pin, ctx)`, `closePosition(positionId, sizeUsd, pin, ctx)`, `updateStops(positionId, stop, tp, pin, ctx)`, `listPositions()`, `status()`, plus `prepareClose` / `prepareUpdate` (ticket orders for close / SL-TP), `kill(ctx)` and `arm(pin, ctx)`. Everything injected (`createExecutor(deps)`); signing modules load lazily past the gates. Never throws; every refusal returns `reasons[]`.
- Gates (`lib/execution/gates.js`): `TRADE_EXECUTION_ENABLED`, `EXECUTION_MODE` (dry default), `EXECUTION_OWNER_IDS`, `EXECUTION_PIN` (constant-time; 3 wrong in 1 h → auto-kill 1 h), kill switch (env or Blob `execution/kill.json`; unreadable = killed) checked in preflight, confirm, close and update; caps size / leverage / loss per trade / daily loss (missing → refuse), open positions (default 2). Preflight also: SL + TP required and on the right side, stop ≤ 3% unless the plan sets its own cap, liquidation buffer (`riskEngine.maxLeverageForStop`), direction cost, then live daily loss, open positions, market, custody and quote (any unavailable → refuse).
- Tickets (`lib/execution/tickets.js`): Blob `execution/tickets.json`, 8-hex nonce, 60 s, single use, ETag-guarded with no forced overwrite. Audit (`lib/execution/audit.js`): Blob `execution/YYYY-MM-DD.jsonl` + `execution/manifest.json`, every line redacted (key / seed / PIN / token / URL keys and values, long base58 / hex, byte arrays, live secret env values). Journal: dry → `note` "DRY order …", live → `open` / `close` / `adjust` with `source: 'execution'` (added to `lib/journalSchema.js` SOURCES) and engineRef.
- Live capability gate: `openPerpPosition` does not place SL/TP on chain, and `closePerpPosition` / `updatePerpPosition` are placeholders, so live open / close / update refuse (`live_sl_tp_unsupported`, `live_close_unsupported`, `live_update_unsupported`) until they are implemented; a placeholder signature is never accepted.
- `services/jupiterPerps.js` `getPerpPositions(wallet, opts)` is real: 18 Position PDAs (BTC/ETH/SOL × long/short × asset/USDC/USDT collateral, Side enum seeds 1/2), one `getMultipleAccounts`, decoded with the IDL decoder; returns `{ ok, positions, error }` and never throws. Liquidation price is an estimate (`liquidationPriceSource: 'estimate'`). New `test:execution` (42).

## 2026-09-25 — Tracking: Telegram sent-alert log and per-minute transition log, ingested by the tracker (not deployed)

Logging only; no rule, threshold, schema or config change; no execution import; no new dependency. GPT instructions untouched (check:gpt unchanged).

- Sent-alert log (`lib/telegramLog.js`, called by `api/telegram-cron.js` after the sends): one line per alert the cron sends (alerts, tracked transitions, TP1/stop hits, nudges; not command replies) to Blob `telegram/alerts/YYYY-MM-DD.jsonl` + `telegram/alerts/manifest.json` with id, sentAt, kind, event, symbol, timeframe, direction, candidateId, signature, verdict, etaMin, levels, gross/net R, room R, closedThrough, silent, level, tracked, delivered and a 200-char plain-text excerpt (sizing rows cut). No account or wallet fields; sensitive keys refused.
- Transition log: `diffAlerts` keeps `state.cands` and returns `transitions` (`diffCandidates`): one line per candidate whose state or plan status changed since the last run, to `telegram/transitions/YYYY-MM-DD.jsonl` + manifest. Nothing when nothing changed; first run seeds silently.
- Best effort: 2 s cap, never throws, never blocks or repeats a send; `TRACK_TELEGRAM_LOG=false` disables it.
- Tracker: `collect.js` `pullTelegramLogs` → `data/telegram-alerts/` (dedupe by id) and `data/transitions/` (candidateId+at); `score.js` `scoreAlerts` → `data/alert-outcomes.jsonl` (latencyMin from the producing candle close, outcome tp1 / stop / get_in_now / setup / confirmed / void / expired, laterGood, readyAfterMin, joined call); `aggregate.js` `alerts` (by kind / verdict per day, median latency, alerted → later GOOD, BE READY → GET IN NOW ≤ 30 min, transitions per hour by timeframe); page `#zone-alerts` (PROVISIONAL, renders empty), Status Alerts fact links to it. `test:telegram` 85 → 90, `test:tracker` 111 → 114.

## 2026-09-25 — Telegram: Plan / Thesis / Track buttons on every alert; tracked-candidate alerts (not deployed)

Delivery-only; no rule, threshold, schema or config change; no execution or signing import; no new dependency. GPT instructions untouched (check:gpt unchanged).

- Every WATCH / TRIGGERING / BREAKOUT / SETUP / GOOD alert and `/signals` block: `Plan · Thesis · Chart` / `Track · Took it · Skipped`. Plan card = engine levels, R gross/net, sizing from the candidate `risk` block, mark vs Kraken, expected length (n/a unless measured), call; anything not a trade says `NOT A TRADE UNDER YOUR RULES — <reason>`. Thesis card = supports / against / unknown / changes as plain phrases, To become GO IN. Refs resolve live first, then the stored snapshot, else `[expired — send /signals]`.
- Track (max 10, 6 h; Took it implies it): every transition alerts at any level (triggering, confirmed, SETUP, GET IN NOW + Plan card, void, gone, expired), then TP1 / stop on the mark with R; a taken trade gets Closed here / Partial / Still in and one reminder 10 min after a hit with no close journaled. `/tracking`, `/positions` (open trades with live R and Close @ mark), menu `Tracking`, `Positions`.
- Timeframe focus: `/alerts tf` (default 3m,5m) gates WATCH / TRIGGERING / BREAKOUT; a tracked symbol + direction turns on its 1m flags (`1m ENTRY · for your tracked …`).
- Visual layout on alerts, cards, `/signals`, `/status`, `/positions`, `/tracking`: dot + coin glyph + `▲ LONG` / `▼ SHORT` header, rule-separated LEVELS / VERDICT / PLAN / CONTEXT with monospace numbers, under 1,000 chars.
- `/market` (menu `Market`): 24h card from engine fields with a rule-based LEAN, alerts today by kind (`state.alerts.byKind`), and the 1h/4h level that would change it. The payload publishes 20 1h candles, so the 24h window falls back to the last 6 4h candles (labeled). `test:telegram` 73 → 85; all other suites unchanged.

## 2026-09-25 — Telegram two-line alerts with one bold verdict; void-drift dedup (not deployed)

Delivery-only; no rule, threshold, schema or config change. GPT instructions untouched.

- Every flag alert is two lines. Line 1: `KIND · SYM tf DIR [forming, WATCH only] · brk · void · meas <R>` plus `counter-trend (td:<s> n/4)` only when the top-down sentiment opposes the direction; "confirmed" dropped from BREAKOUT. Line 2: one bold verdict — `GET IN NOW` (own plan ready: entry · stop · TP1 (R) · net), `BE READY (Xm)` (conditional plan, own SETUP incl. chase-rejected "no chase; enter on a retest of X that holds below", or TRIGGERING), `WAIT (Xm)` (forming), `STAND DOWN` (`<r>R room to <level> (<source>); needs 2.5R` | `entry X inside support|resistance` | `stop N% > 3% cap` | plain words). No reason codes, remedy sentences or "plan rejected:" in any alert.
- GOOD alert uses the same shape (`GOOD · …` / `GET IN NOW …`) and keeps its chart; SETUP alert uses the BREAKOUT/BE READY shape. A BREAKOUT that already carries its own candidate's SETUP line no longer sends a second SETUP alert (remembered, not sent).
- `/signals`: one line per symbol `<b>VERDICT (Xm)</b> · SYM · reason`, a `SETUP · …` line when setup≠null, then the one-line DATA. `/why` keeps the GPT SETUP line.
- Dedup signature drops the void level: `symbol|tf|direction|breakout`; a breakout within 0.05% of a remembered one is the same flag (no re-alert for 60 min unless it escalates forming → triggering → confirmed; GOOD keeps candidate-id dedup). Older 5-part signatures in state still match. `test:telegram` 70 → 73 (five owner examples as long + short snapshots, void/breakout drift, escalation pass-through, no-reason-code regex).

## 2026-09-25 — Telegram alert fixes: signature dedup, per-alert readiness (not deployed)

Delivery-only; no rule, threshold, schema or config change.

- Dedup: WATCH/TRIGGERING/BREAKOUT/SETUP also key on `symbol|tf|direction|breakout|invalidation` (2 dp), kept in `telegram/state.json` `watch.sigs` for 60 min (last 200). A re-detected forming flag whose candidateId shifted no longer re-alerts (prod 2026-09-25 02:25–02:28Z: one BTC 3m WATCH sent 3×). TRIGGERING/BREAKOUT pass once each as escalations; SETUP once. The 15-min per-symbol cooldown still gates new WATCHes; a TRIGGERING on a signature that had a WATCH passes it. candidateId memory kept.
- Readiness per alert, not the symbol verdict: WATCH `WAIT (<eta>m)`, TRIGGERING/SETUP `BE READY (<eta>m)` (eta to that candidate timeframe's next close from asOf), BREAKOUT `GET IN NOW` (its plan ready) / `BE READY` (conditional or its SETUP) / `STAND DOWN — <short reason>` (rr, entry inside zone, chase retest, stop cap, else the code). The long remedy sentence is never the call line.
- WATCH line: `meas <R>` plus ` · room <r>R to <level> (<source>)` when the room belongs to that candidate; SETUP/BREAKOUT Room line only for their own candidate. GOOD alerts, buttons, health alerts and `/signals` unchanged. `test:telegram` 67 → 70.

## 2026-09-24 — Delivery pass: readiness call, room line, one-line DATA (schema 1.25.0, not deployed)

Owner asks 2026-09-24 evening. Additive, no rule/threshold/config change (two-week freeze), configVersion unchanged; schema 1.24.0 → **1.25.0**. MCP untouched.

- `flagRecommendation.action = {call, etaMin, at, note}` (`lib/flagRecommendation.js`, pure, from fields already computed): `GET IN NOW` on GOOD; `BE READY` for a conditional plan or a SETUP, `etaMin`/`at` = next close of that timeframe after `asOf` (the symbol's 1m closedThrough), note = the trigger sentence; `WAIT` for a WATCH naming a forming/triggering candidate (eta to its next close, note = change condition); `STAND DOWN` for BAD without a setup, DATA_UNAVAILABLE, or nothing forming (etaMin null).
- `flagRecommendation.room = {toLevel, levelPrice, levelSource, pts, r, stop}`: entry to the first level ahead (TP1 cap zone edge, e.g. `15m resistance`, else the measured move) in points and R vs the stop, for the live plan, else the SETUP, else a rejected plan with levels; null otherwise.
- GPT instructions (`docs/GPT_INSTRUCTIONS.md`, 7939 units / 7982 bytes): `[CALL] — ` prefix on asset lines, `Room:` on NO TRADE/SETUP lines, one-line DATA (`Data: closed HH:MMZ · status · schema·config`, `Warnings:` only when any), `getScalpContext(compact=true only)`, SETUP LINE only when `setup≠null`. Bytes freed by wording/arrow swaps, no rule dropped.
- Telegram: `/signals` mirrors the GPT format (call prefix, Room line, one-line DATA); GOOD, SETUP, WATCH, TRIGGERING and BREAKOUT alerts carry the readiness call and room line.
- `openapi/scalp-context.yaml`: `ReadinessAction`, `RoomAhead` schemas. Tests: `test:flagrec` 24 → 28, `test:flagrec:fixtures` 17 → 18, `test:telegram` 64 → 67; schemaVersion assertions updated.

## 2026-09-24 — Telegram alert levels + quiet hours (not deployed)

- Telegram incident fix (delivery-only): `telegram/state.json` carries `stateVersion` 2 and `parseState` never throws (v1 state migrates, prefs default, memory arrays default empty, unknown fields kept; corrupt or wrong-type state resets with `reason=state_reset`); cron and webhook log `msg="<err.message>"` (200 chars, secrets redacted) on state failures; `telegram/health.json` counts consecutive cron failures (overwrite, no ETag) and sends ALERTS CRON FAILING on the 3rd, then hourly, and ALERTS CRON RECOVERED once; `/status` shows the count and last reason. `test:telegram` 58 → 64.
- `/alerts good|setup|watch` (default `setup`; `watch` adds one-line WATCH/TRIGGERING for new forming/triggering flags, deduped over 200 ids, 15-min per-symbol cooldown) and `/alerts quiet HH-HH|off` (default 01-05 America/Chicago, every day, silent not dropped), saved in `telegram/state.json` `prefs`; `TELEGRAM_QUIET_HOURS` retired. Notification-only: no engine, threshold, schema or config change.
- Telegram BREAKOUT alert: once per candidate when it first confirms, every alert level, with Why/Chart/Took it/Skipped. Chase-rejected confirmed flags that clear every other gate now publish a retest SETUP (`wait for a <tf> retest of <entry> that holds above|below it`); live plan and class unchanged.
- Telegram `/flags` (Flags label, Charts → All flags) sends chart albums of every live flag after the text summary: one `sendMediaGroup` per symbol, one chart per symbol+timeframe, max 9 images, 6 s render budget each with a `[chart unavailable]` text fallback; webhook `maxDuration` 60.
- Telegram buttons: persistent reply keyboard, Charts/Alerts inline pickers, Why/Chart/Took it/Skipped on GOOD, SETUP and `/signals` (`callback_query`; setWebhook `allowed_updates` must be `["message","callback_query"]`).

## 2026-09-24 — T-1 Telegram alerts + read commands (branch `upgrade-signal-engine`, not deployed)

Plan: `docs/PLAN_TELEGRAM.md` (owner-approved 2026-09-24). Read-only toward the engine and
never execution: no engine rule, threshold, schema (1.24.0) or config (2026.09.24-5) change.

- `api/telegram-webhook.js` (new, `POST /api/telegram-webhook`): secret header
  (`TELEGRAM_WEBHOOK_SECRET`, else 403), owner allowlist (`TELEGRAM_ALLOWED_USER_IDS`, else
  200 and silence). Commands `/signals`, `/why SYM`, `/flags [SYM]`, `/chart SYM TF`,
  `/wallet`, `/journal [n]`, `/status`, `/log text`, `/testalert`, `/help`. No trade commands.
- `api/telegram-cron.js` (new, `GET /api/telegram-cron`, `vercel.json` `crons` every
  minute, `CRON_SECRET` bearer): one build per run; alerts only on transitions (NEW GOOD with
  chart, NEW SETUP, GOOD ended, data or mark problems over 5 min, repeated at most every
  30 min). State in Blob `telegram/state.json`, claimed with the ETag before sending.
- `lib/telegram.js` (new): pure formatters (GPT FORMAT lines incl. the SETUP line), the alert
  state machine (dedup by candidate id), Bot API client (HTML, chunked under 4,000 chars,
  5 s timeout, never throws).
- `api/journal.js`: `appendRecord`/`readRecent` exported so `/log` and `/journal` use the
  exact REST path. `lib/journalSchema.js`: records gain a server-stamped `source`
  (`"telegram"` from the bot, `null` from the GPT Action; never read from the body).
- Tracker: `collect.js` pulls `telegram/state.json` into a whitelisted
  `data/telegram-status.json`; the Status section gains an "Alerts" fact (last alert, alerts
  today, cron age; `[NO ALERTS YET]` before the first alert).
- `vercel.json`: routes for both functions before the catch-all, `crons` entry.
- Docs: connector doc endpoint/env/verify/test tables, `DOCUMENTATION_INDEX.md`,
  `ARCHITECTURE_MAP.json` (Delivery stage, `TELEGRAM` delivery chip on Calls and Trade plan),
  `openapi/scalp-context.yaml` `JournalRecord.source`.

Tests: new `test:telegram` 32; `test:journal` 19, `test:mcp` 52 unchanged. Owner steps: set
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`;
register the webhook with `secret_token`; `/start` then `/status`.

## 2026-09-24 — D-variant revised: minRR 2.5 live, net gate off, 3R shadow (branch `upgrade-signal-engine`)

Owner decision, supersedes D-variant (`docs/OWNER_DECISIONS_2026-09-24.md`): lean toward
producing GOOD calls so the strategy can be tracked and tweaked. Config-only; schema
unchanged at 1.24.0, configVersion 2026.09.24-4 → **2026.09.24-5**.

- `config/engine.json`: `flagPlan.minRR` 3.0 → **2.5** (the sign-off Step B2 deferred to
  2026-10-07 is granted directly). `flagPlan.minNetRR` 2.0 → **null** (net gate off);
  `netRR`/`costR` stay published on every plan.
- `lib/flagRecommendation.js`: with the net gate off, a thin net R:R no longer rejects
  (`fees_heavy`/BAD) - it's a non-blocking `net_rr_low` warning ("thin after fees") at a
  fixed 1.0R floor, independent of `minRR`/`minNetRR`. The net gate still rejects
  (`fees_heavy`) when `minNetRR` is explicitly set via override (research only now).
- `services/scalpContext.js`: shadow variants flip from V-B (`{id:'vB', minRR:2.5}`) to
  **v3** (`{id:'v3', minRR:3.0}`) - the former live rule is now the shadow comparator.
  `scripts/tracker/vb-shadow.js` renamed to `v3-shadow.js` (full symbol/file rename, same
  mechanism); `build-page.js`'s tile relabeled "3R shadow (former live rule)".
  `scripts/tracker/shadow.js`'s `SHADOW_CFG.minRR` (a hand-mirrored copy of
  `config/engine.json`, parity-tested) also moves 3.0 → 2.5.
- Tracking window continues unbroken from 2026-09-23 (`PHASE_START` unchanged, restart
  note removed); `aggregate.js`'s `configBoundary` (Step C) now carries this transition
  automatically, splitting before/after stats on the page.
- `docs/GPT_INSTRUCTIONS.md`: `flagTradePlan=trade authority` line drops the net R:R
  number, adds `net_rr_low(netRR<1.0)→non-blocking,say "thin after fees"`. 7987/7990 units.

Tests: `test:flagrec` 23 → 24 (net-gate-override case for `fees_heavy` added alongside
the revised default-off `net_rr_low` case); `test:flagplan`/`test:tracker`/
`test:flagrec:fixtures`/`test:config`/`test:archmap` fixtures updated for the new
thresholds and the vb→v3 rename, counts unchanged. 27 suites, all green; `check:gpt` OK
(7987/7990); `git diff --check` clean; payload bytes unaffected (values only, no shape
change). Details: `docs/OWNER_DECISIONS_2026-09-24.md` ("D-variant revised").

## 2026-09-24 — T6 completion plan Step C: SETUP tier, dir-cost, config-boundary marker (branch `upgrade-signal-engine`)

Owner-approved after Step A + B2 deployed live at schema 1.23.0. Not deployed - stops for the gate. Schema 1.23.0 → **1.24.0**, configVersion 2026.09.24-3 → **2026.09.24-4**.

- **C1 (D-cost applied live)**: `config/engine.json` risk.costBpsByDirection `{long:34, short:14}`.
  `lib/flagTradePlan.js`'s `costRFraction`/`netRiskReward` take an optional `direction` -
  `flagTradePlan.netRR`/`costR` are now direction-dependent on every plan and shadow
  variant (a long's cost is harsher than a short's at the same gross R:R - never assume
  symmetric net numbers). `scripts/tracker/costs.js` mirrors it so the tracker's real
  GOOD-call net expectancy and `vb-shadow.js` share the same cost model.
  `scripts/tracker/breakout-entry.js`'s own vendored `netRiskReward` deliberately
  untouched (frozen/unpublished T4 P4 feature).
- **C2 (SETUP tier)**: `flagRecommendation.setup` - the best still-conditional candidate
  in the pool, computed once in `buildFlagTradePlan` (reuses its own attempts pass),
  distinct from `flagTradePlan`, published in the default payload, informational only
  (never GO IN). Tracker: `score.js`'s `kind:'setup'`/`counterfactual_setup` what-if
  scoring, `aggregate.js` tiles `goodPerHour7d`/`setupsPerDay7d`, `charts.js`'s
  `setupEquityRows` in the equity filter table.
- **C3 (tracker)**: `aggregate.js`'s `configBoundary` - the most recent configVersion
  transition, gross+net stats before/after, on the page. Net R alongside gross
  wherever gross is shown: `chartKit`'s readouts and filter table gain a vendored
  dir-cost net column.
- **C4**: `FLAG_TF_RANK`/`FLAG_TF_ORDER` gain 15m/1h entries, inert today
  (`flag.timeframes` stays 1m/3m/5m), ready with no code change if ever widened.
- **C5**: GPT instructions - `SETUP LINE` in `signals`, `flagRecommendation.setup`
  rule, `dir-priced` net-R wording; mark rule (RISK) untouched. 7744 → 7988 units.

Tests: `test:flagplan` 59 → 67, `test:tracker` 93 → 110, `test:flagrec` 20 → 23,
`test:scalp` 120 → 121; `test:config`/`test:geometry`/`test:pattern` schemaVersion
assertions updated to 1.24.0, counts unchanged. 26 suites, all green; `check:gpt` OK
(7988/7990); `git diff --check` clean. Details: `docs/EDITTRADES_MCP_CONNECTOR.md`.

## 2026-09-24 — System map + changelog page (branch `upgrade-signal-engine`)

`docs/ARCHITECTURE_MAP.json` (every lib/services/api/config/scripts/tracker file, by pipeline stage) drives a generated tracker page `changelog.html` (`scripts/tracker/changelog-page.js`, `build-changelog.js`, `npm run tracker:changelog`); new suite `test:archmap` keeps the map, CHANGELOG schema entries and test names in step with the code. No engine, payload, schema, config or MCP change.

## 2026-09-24 — T6 completion plan Step B2: D-cost/D-variant answered, V-B engine-side shadow (branch `upgrade-signal-engine`)

`docs/OWNER_DECISIONS_2026-09-24.md`. Owner decisions: **D-cost** - net-R plans around a
direction-dependent cost (positions funded from USDC/USDT): a long pays the 0.34%
round-trip swap-in/out rate, a short pays 0.14% (fallback 0.20% for an unresolved
direction). **D-variant** - stay on V1c live; run V-B (gross minRR 2.5) as a shadow
instead of shipping it. Revisit 2026-10-07, n >= 20 scored plans each side; if V-B still
beats V1c on net expectancy out of sample, the owner signs the gross minRR 2.5 rule
change then.

- **`lib/flagTradePlan.js`**: `buildFlagTradePlan` takes an optional `shadowVariants`
  list (`[{id, minRR}]`). Each variant re-attempts the same candidate pool with
  `flagPlan.minRR` overridden - same ATR, same candles, same retest-hold rule as the
  live plan, no approximation - and publishes `shadow.<id>` only when that variant's
  selected outcome (status/reasonCode/candidateId) differs from the live plan.
- **`services/scalpContext.js`**: wires `shadowVariants: [{id:'vB', minRR:2.5}]` into
  the live call. `flagTradePlan.shadow` is stripped from every response (including the
  include-less default) unless `include=model` is explicitly requested; always captured
  in the served-call record (pre-filter payload), unconditionally. Schema 1.22.0 →
  **1.23.0** (additive - new optional `shadow` property on `FlagTradePlan`).
- **`scripts/replay-rules.js`**: `netR_sensDir` / `netExpectancyR_sensDirPct` - the
  same direction-dependent cost applied to the offline replay research, alongside the
  existing 0.14%/0.34% flat sensitivity columns. `docs/GOOD_QUALITY_REPLAY.md`'s Step B
  variant table gets the `dir-cost` column, recomputed from the existing
  `var/replay-rules/*.calls.jsonl` raw output (no re-sweep needed).
- **`scripts/tracker/vb-shadow.js`** (new): shadow-mode scoring for `flagTradePlan.shadow.vB`
  - one row per candidateId, keyed off the first captured `ready` close, walked via the
  existing `walkShadow` (breakout-entry.js), same dir-cost model as replay-rules.js.
  Never traded, never feeds any gate. **`build-page.js`**: new "V-B shadow · gross minRR
  2.5 (not traded)" tile beside the breakout-entry shadow tile, same table pattern (n <
  20 reads TOO FEW CALLS). **`track.yml`** (repo-template): new `node scripts/vb-shadow.js`
  pipeline step, between shadow.js and aggregate.js. Cannot backfill - only accrues from
  calls captured after this ships.

No production behavior changed for the live plan (V1c stays shipped as-is); no MCP
import surface change (`wantsModel` already existed for `sym.model`); no new library.
Tests: `test:flagplan` 53 → 59, `test:scalp` 117 → 120, `test:tracker` 85 → 93 (all new,
covering the shadow-variant diff logic, the payload gate, the dir-cost math, and the
tracker script end to end); `test:config`/`test:geometry`/`test:pattern` schemaVersion
assertions updated to 1.23.0, counts unchanged. Full gate green (`check:gpt` OK,
`git diff --check` clean). Not yet synced to the deployed tracker repo or deployed -
`docs/PLAN_T6_COMPLETION_V2.md` Step B's code is complete; sync/push/deploy is a
separate, explicit step.

## 2026-09-24 — Owner decision 4b: `room_at_entry` scoped to the candidate's own geometry timeframe (branch `upgrade-signal-engine`)

`docs/OWNER_DECISIONS_2026-09-24.md`. Answers the A7 open item from the Step A gate
report: `lib/flagTradePlan.js`'s `nearestRoomAhead` reads two different things from
geometry, now scoped differently on purpose -
- `touchesEntry` (hard `room_at_entry` rejection) - now the candidate's own mapped
  geometry timeframe only (`geometryTimeframeFor(candidate.timeframe)`), same scoping
  decision 4a already gave the qualifier's `room:blocked`. A zone on a farther timeframe
  (e.g. 4h) sitting on the entry price can no longer reject a 1m/3m/5m flag's plan
  outright.
- `nearestEdge` (the TP1 cap) - **unchanged**, still scans every geometry timeframe. A
  4h level ahead is exactly the kind of major S/R the owner's "major S/R overrides" rule
  means to cap a target at; decision 4a never scoped this.

No config or schema change (behavior only, no field added/removed). Tests:
`test:flagplan` 51 → 53 (two new mirrored cases: a farther-timeframe zone on entry no
longer rejects; the TP1 cap still reads a farther timeframe). Full gate green.

## 2026-09-24 — T6 completion plan Step A: review-pass fixes (branch `upgrade-signal-engine`)

`docs/PLAN_T6_COMPLETION_V2.md` (reviewer-consolidated, overrides T6 sequencing). Fix
pass, not deployed - stops for the gate. Schema 1.21.0 → **1.22.0**.

- **A1 (payload cap, real production incident - live had measured 79,863 B over the
  79,000 cap):** removed `breakoutEntry` from the payload (shadow-mode research,
  unpromoted; `lib/breakoutEntry.js` stays, just unwired) and dropped
  `flagSlope`/`breakoutDistancePct`/`invalidationDistancePct`/`levelSource` from every
  candidate (confirmed unread by the GPT, the tracker, or pathOutlook/flag-paths).
  Replaced the frozen-fixture cap test with a synthetic worst case (3 symbols x 6
  simultaneous failed-in-TTL candidates + 1 ready GOOD plan each); it still measured
  80,148 B after both trims, so the default cap moved 79,000 → **80,200 B** (owner
  decision, minimal, documented) rather than a deeper cut. Compact cap unchanged at
  45,000 B (passes at 44,743 B).
- **A2:** `net_rr_below_min`/`stop_inside_costs` direct `flagRecommendation` tests
  (primary reason + remedy text) - the hard-rejection mapping itself already shipped in
  phase 1.
- **A3 (correctness fix):** a retest candle whose wick reached through the plan's own
  stop before closing back on the hold side was counted as a valid hold - a live
  position would have stopped out on that wick. Fixed in `observeRetestHold`
  (`lib/flagTradePlan.js` and its vendored copy in `scripts/tracker/flag-paths.js`) and
  in `labelPath`'s own `retestReachedHeld` (a stop-wicked touch no longer mislabels a
  path `retest_go` instead of `runner`).
- **A4 (correctness fix):** the blob first-write race - two concurrent requests
  creating the same day's file both saw no existing blob, both wrote with no `ifMatch`,
  and the loser's row vanished with no error. `writeBlob` now asks `allowOverwrite:
  false` on a create; `updateBlob` retries the resulting `BlobAccessError` the same as
  an ETag conflict.
- **A5 (latency fix):** `api/scalp-context.js` awaited served-call recording before
  responding, adding real latency (up to the 1500 ms cap) to every request. The
  response now goes out first; recording happens after, still capped and swallowed.
- **A7:** `setConfigOverride` throws if an override touches `configVersion` or
  `thresholds` (both snapshotted once elsewhere at module load and would silently not
  apply); `test-replay-rules.js` fails, not skips, when its fixture is missing.
  **Open, needs an owner answer:** should the TP1 cap (`nearestRoomAhead`) read only
  the candidate's own geometry timeframe, matching decision 4a's scope for
  `room:blocked`? Left as-is pending that answer.
- **Tests:** `test:config` 14→19, `test:flagplan` 50→51, `test:flagrec` 18→20,
  `test:paths` 22→28, `test:served` 18→22, `test:journal` 17→19; `test:tracker`
  corrected to its true count (85, was stale at 42). 848 tests across 27 suites, all
  green; `check:gpt` OK; `git diff --check` clean.

## 2026-09-24 — T6 phase 1: fee-aware net gate ships on, V1c (branch `upgrade-signal-engine`)

`docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`, owner decision D1 from the phase 0 replay
study (`docs/GOOD_QUALITY_REPLAY.md`). Schema 1.20.0 → **1.21.0** (additive), configVersion
2026.09.24-2 → **2026.09.24-3**. Deploy approved for this step.

- **Config:** `flagPlan.minNetRR` null → 2.0. `flag.timeframes` unchanged (1m/3m/5m —
  V1c does not widen detection).
- **`lib/flagTradePlan.js`:** the net gate now rejects for real — `net_rr_below_min`,
  or the more specific `stop_inside_costs` when the round-trip cost alone is already
  ≥ 0.5R of the stop's own risk (the BTC 0.066%-stop incident from section 1a is
  `stop_inside_costs`: costR ≈ 3.0). New `costR` field published on every plan once
  entry/stop are known (exported `costRFraction`).
- **`lib/flagRecommendation.js`:** `net_rr_below_min`/`stop_inside_costs` join the
  existing hard-rejection mapping (BAD, not DATA_UNAVAILABLE). `net_rr_low` renamed/
  split: `net_rr_ok` (support, ready/conditional plan cleared the net floor) or —
  reachable only when the gate is off — `fees_heavy` (oppose).
- **GPT instructions:** `flagTradePlan=trade authority` now names the floor
  (`net R:R≥2.0 after costs`); funded by tightening wording elsewhere, 7984 → 7978
  units. New test-sheet prompt 17 (fee-rejected plan).
- **Tracker window restart:** `scripts/tracker/build-page.js` `PHASE_NAME` → "Phase 5
  forward record (net-gated rules)", `PHASE_START` → 2026-09-24, new
  `#testing-phase-restart-note`; 14-day/30-plan target unchanged, nothing deleted.
- **openapi:** `FlagTradePlan.costR` (additive), `reasonCode` enum +2 values,
  `FlagRecommendation` description updated.
- **Tests:** `test:flagplan` 43 → 50 (net gate on by default, `costR`,
  `stop_inside_costs`, the real BTC-incident fixture, long/short mirrored);
  `test:flagrec`/`test:flagrec:fixtures`/`test:tracker` unchanged in count, assertions
  updated. Full gate (every `test:*` + `check:gpt` + `git diff --check`) passes.
- **Deploy: blocked, not yet live.** `npx vercel --prod --yes` failed:
  `Error: Resource is limited - try again in 24 hours (more than 100, code:
  "api-deployments-free-per-day")` - Vercel Hobby's daily deployment cap, not a code
  issue. Code is committed and pushed; production still runs the pre-phase-1 config
  (net gate off) until a deploy succeeds. Tracker sync/restart intentionally held back
  until then - restarting the testing window before the rule is actually live would be
  misleading. Retry `npx vercel --prod --yes` after the cap resets, then run "Verify
  after any redeploy" and the tracker sync/push/trigger steps below.

## 2026-09-24 — T6 phase 0: fee-aware net gate + rule-variant replay (branch `upgrade-signal-engine`)

`docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`. Research phase, no deploy. ConfigVersion
2026.09.24-1 → **2026.09.24-2** (new `flagPlan.minNetRR` key, default `null` = off;
production byte-identical). No schema change.

- **Net gate (shippable, off by default):** `flagPlan.minNetRR` — `lib/flagTradePlan.js`
  checks it right after the existing gross `minRR` gate; below the floor the plan is
  `rejected`/`net_rr_below_min`, levels kept. `test:flagplan` +4 tests (47 total).
- **Config override hook:** `config/engine.js` `setConfigOverride`/live `ENGINE_CONFIG`
  binding (deep-merge onto the on-disk config, in-process only, default off) — lets a
  replay variant flip a threshold without touching every module that reads
  `ENGINE_CONFIG`. `test:config` +4 tests (18 total).
- **`scripts/replay-rules.js`** (`npm run replay:rules`, new `test:rules` suite, 25
  tests): replays 11 rule variants (net gate 1.0/1.5/2.0, `flag.timeframes` +15m/1h,
  combinations, an ATR-floored stop, a 15m/1h-structure stop/target, and a
  FAILED_FLAG_REVERSAL scout research pass) against `test/fixtures/history/deep-2026-09-24/`
  through the production pipeline, scored with the tracker's own `walkOutcome`/cost
  model. Results: `docs/GOOD_QUALITY_REPLAY.md`. Headline: the one real GOOD call in the
  problem statement (0.066% stop, −4.0R net) generalizes — the shipped-default (gross-
  only) gate averages **−2.31R net per call** over 15 days; a net gate at 2.0 (closest
  variant to passing the phase-0 OOS rule, though 3 calls short of n≥20) averages
  **+0.84R net**, and is the only variant that stays net-positive under the D3 0.34%
  cost-sensitivity case (real Jupiter Perps fee research, recorded the same day).
  Widening `flag.timeframes` to 15m/1h diluted every net-gated variant rather than
  helping. **Owner must pick a variant (D1) before phase 1 ships.**
- **Tests:** full gate — every `test:*` script + `check:gpt` + `git diff --check`; all
  pass unchanged plus the 8 new tests above.

## 2026-09-24 — T5 P0 divergence measurement, net R on the tracker (branch `upgrade-signal-engine`)

`docs/PLAN_DIVERGENCE_OPPORTUNITIES.md`. No engine, payload, config or threshold change.

- **S1:** tracker net R after fees + slippage (`scripts/tracker/costs.js`, parity-tested with `config/engine.json` `risk`): `netExpectancy`/`avgCostR` in stats, hero, window tables and the shadow tile. `outcomes.jsonl` untouched.
- **S2 (in progress):** `scripts/replay.js` backfill checkpoint stores 1m candles instead of raw trades (old checkpoints convert on load); 1h derived from 1m for 60-day depth.
- **T5 P0:** `featuresAt` gains `divergence`, `atLevel`, `sweepReclaim`, `counterTrend` (additive); `scripts/replay-early-entry.js` (`npm run replay:early`) compares an early entry at the tightening close with the confirmed retest entry, net of fees. 15 days, 10,997 flags: early entry −0.65R net; retest −0.32R net; divergence and support nudge fail_first down (47.9% → ~43.5%) but no early-entry combination is net-positive. Results: `docs/DIVERGENCE_OPPORTUNITIES_BASE_RATES.md`.
- **Tests:** `test:tracker` 85, `test:paths` 26, `test:replay-paths` 28, `test:replay` 45.

## 2026-09-24 — T4 P3 calibration + P4 shadow breakout entry (branch `upgrade-signal-engine`)

Schema 1.19.0 → 1.20.0 (additive). Nothing that drives a trade changed: `flagTradePlan`, `flagRecommendation`, GO IN, strategies, gates, minRR, the 3% scalp stop guard are byte-identical; the GPT instructions do not mention the shadow field.

- **P3:** capture rows keep whitelisted `pathOutlook` and `breakoutEntry`; tracker `calibration.js` compares each call's first tightening/broken prediction with the realised path: Brier vs baseline, likely-path hit rate, chase precision, runner/fail-first reliability. Page `#path-calibration-section`.
- **P4 (shadow):** `symbols.<SYM>.breakoutEntry` (`lib/breakoutEntry.js`, `scripts/tracker/breakout-entry.js`): on a runner-prone flag's breakout candle (chase elevated/high), entry at the close, stop = invalidation, tp1 = measured target, only if grossRR ≥ minRR and stop ≤ scalp max; `status: 'shadow'`. `lib/flagTradePlan.js` exports `netRiskReward` (no logic change). Replay (`npm run replay:breakout`, `docs/BREAKOUT_ENTRY_SHADOW.md`): gated shadow −0.65R net/trade, retest entry −0.35R net on the same flags; not promoted. Tracker `shadow.js` scores shadow vs retest live (`#breakout-shadow-section`).
- **Tests:** new `test:breakout` 33; `test:tracker` 52 → 76.

## 2026-09-24 — T4 P1 + P2 path outlook (branch `upgrade-signal-engine`)

`docs/PLAN_FLAG_PATHS.md`. Schema 1.18.0 → 1.19.0 (additive), configVersion 2026.09.23-7 → 2026.09.24-1. Information only: `flagTradePlan`, `flagRecommendation`, strategies, gates, thresholds and the scalp stop guard are unchanged.

- **P1:** `symbols.<SYM>.pathOutlook` (`lib/pathOutlook.js`, pure): for the symbol's live flag candidate, measured path weights (retest_go / runner / false_break / fail_first / chop), `lean`, `likely`, `chase`, `n`, `cal`, bucket `key`. Weights come from `config/engine.json` `pathOutlook` (built by `scripts/build-path-table.js` / `npm run paths:table` from 10,997 replayed flags, backoff `tf|structureSteps|roomR|compression` to n ≥ 100). Separate tables before and after breakout. Default payload 78,003 → 78,922 B, compact 42,598 → 43,517 B (caps unchanged).
- **P2:** `docs/GPT_INSTRUCTIONS.md` renders a fixed SCENARIO block from `pathOutlook`; the GPT never invents percentages; a runner without a retest is a missed entry, not confirmation. 7,984 / 7,990 units. **Owner must paste the new instructions into the Custom GPT.**
- **Tests:** new `test:outlook` 27; schemaVersion pins updated in config/geometry/pattern/scalp suites.

## 2026-09-24 — Fix: Blob appends after a day's first write (served calls, journal)

`get()` returns a weak ETag (`W/"..."`) and `put({ifMatch})` only matches the strong form, so every append after a day's first write failed "Precondition failed: ETag mismatch" and was swallowed. Served calls recorded only 3 rows on 2026-09-24 (the first write); journal appends could 503. `lib/blobJsonl.js` `readBlob` now strips the `W/` prefix (`strongEtag`). Regression test in `test-served.js` (20).

## 2026-09-24 — T4 P0 flag paths (branch `upgrade-signal-engine`)

`docs/PLAN_FLAG_PATHS.md`. Measurement only: no engine, payload, schema, config or threshold change; MCP untouched.

- **Labeller:** `scripts/tracker/flag-paths.js` (pure) labels a flag from its tightening point: retest_go / runner / false_break / fail_first / chop, plus bucketed features and base rates. A retest only counts after the breakout candle closes.
- **Replay:** `scripts/replay-paths.js` (`npm run replay:paths`) runs the production pipeline per close, no lookahead. `scripts/replay.js --backfill-1m` is now resumable (checkpoint, rate-limit backoff) and derives 5m/15m depth from backfilled 1m (`--derive-deep`, automatic with backfill).
- **Results:** `docs/FLAG_PATHS_BASE_RATES.md`, 10,997 flags over 15 days: 47.9% fail before breakout; among breakouts, runner (30%) about as common as retest_go (32%); the SOL 2026-09-24 case is labelled runner.
- **Tracker:** `paths.js` step, `data/paths.jsonl`, `#flag-paths-section`; additive candidate fields; scoring untouched.
- `lib/flagTradePlan.js`: `observeRetestHold` exported (no logic change) for a parity test.
- **Tests:** new `test:paths` 22, `test:replay-paths` 19; `test:replay` 36 → 41; `test:tracker` 43 → 52.

## 2026-09-24 — T3 served calls (branch `upgrade-signal-engine`)

`docs/PLAN_SERVED_CALLS.md`. No payload, schema, config or engine change; MCP untouched.

- **Engine:** `GET /api/scalp-context` records the unfiltered payload's calls (one row per symbol with a `flagRecommendation`) to Vercel Blob `served/YYYY-MM-DD.jsonl` + `served/manifest.json` before sending a JSON 200. Awaited with a 1500 ms cap; errors logged without secrets and swallowed; response unchanged. Not on 401/405/500/503 or `?chart`. Kill switch `TRACK_SERVED_CALLS=false`; off without `BLOB_READ_WRITE_TOKEN`. New `lib/servedCalls.js`.
- **Refactors (behaviour-identical):** journal Blob helpers moved to `lib/blobJsonl.js`; tracker row builder and sensitive-key strip moved to `scripts/tracker/records.js` (`collect.js` re-exports).
- **Tracker:** `pullServed` adds served rows to `data/calls/` as `source: 'served'` (cron duplicates dropped); `dims.source`; served rows scored like cron, excluded from run/capture-health counts; page `#activity-served-row`, call-log Via column, `Via` equity filter.
- **Tests:** new `test:served` (18); `test:tracker` 31 → 42; `test:journal` 17.
- **Follow-up:** the tracker's own cron GET sends `X-EditTrades-Client: tracker` and is not recorded as a served call (it was adding a Blob write per run and could label a routine capture "chat"). `test:served` 18 → 19.

## 2026-09-22 — Scalp context engine (branch `upgrade-signal-engine`)

Payload schema 1.1.0 → 1.8.0, live in production. Details: `docs/MASTER_PLAN_ENGINE_REFINEMENT.md`, `docs/EDITTRADES_MCP_CONNECTOR.md`.

- **2026-09-21:** read-only MCP connector (`get_scalp_context`), tracked-wallet `account` block (schema 1.1.0), scalp stop-distance guard (3% max from entry mid for SCALP_1H and MICRO_SCALP), `stopSource`.
- **Phase 1:** `config/engine.json` + `configVersion`; engine constants (thresholds, R:R, stop buffers, scalp max stop) moved out of code.
- **Phase 2:** per-symbol `decisionTrace` (1.3.0).
- **Phase 3:** `lib/riskEngine.js` — leverage cap from stop distance, loss at stop, per-signal `risk` block (1.4.0).
- **Phase 4:** `lib/patternDetector.js` — 1m/3m/5m flag detector, long and short, `candidateSetups[]` (1.5.0).
- **Phase 5:** payload controls `symbols` / `include` / `compact`, config snapshot, `lossAtStopPctOfWallet` (1.6.0).
- **Phase 6:** compute-depth assertion, build-duration log.
- **Phase 7:** `lib/geometry.js` — pivots, horizontal zones, shared ATR, room to level, EMA slope, candidate risk (1.7.0).
- **Phase 8:** diagonals, channel, confluence zones (1.8.0).
- **Phase 10:** replay harness `scripts/replay.js` (production pipeline per closed candle, no lookahead, live capture with 1m trade backfill), `scripts/replay-metrics.js` (candidate counts, visual-gate rate, lifetime, label precision/recall), miss log `test/fixtures/misses/` (MISS_001, MISS_002). No payload change; configVersion 2026.09.22-8 (`replay.minComputeCandles`).
- **Phase 9b:** `lib/biasMatrix.js` — per-timeframe bias matrix, alignment (with/counter-trend, room to the nearest HTF zone), decisionInputs (scalp/swing directional triples), opt-in via `include: bias`; `decisionTrace.bias` summary; failed trace strings carry `failReason`; visual gate: `lifecycle.nearMissGate` (default false) and visualTarget prefers triggering/confirmed (replay gate rate 0.54 → 0.05). Schema 1.9.0 → 1.10.0, configVersion 2026.09.22-9.
- **Phase 11:** GPT instruction trim + payload headroom. `docs/GPT_INSTRUCTIONS.md` is now the Custom GPT instructions source of truth (7990 → 7836 UTF-16 units), gated by `scripts/check-gpt-instructions.js` / `npm run check:gpt`; trimmed rules the payload already carries (flag-pattern anatomy, stop-distance-driven leverage narrative, geometry field shapes) and added coverage for `decisionTrace.bias` grammar, the `failReason` trace token, and `include=bias` MCP-only gating. `decisionTrace.window` drops `from`; `decisionTrace.geometry` strings round to 2 decimals and drop `na` tokens. No schema/config bump; 729 bytes recovered on the default 3-symbol payload.
- **In progress:** Phase 8b, on-demand confirmation chart (`lib/chartRender.js`).

## 2026-09-23 — Trading-model quick pass Q1-Q5 (branch `upgrade-signal-engine`)

Owner's trading model (`docs/MASTER_PLAN_TRADING_MODEL.md`, M-1..M-9), quick-pass subset per `docs/PLAN_TRADING_MODEL_QUICK_PASS.md`. Additive only; no strategy decision, stop, target, confidence, or `bestSignal` changed. Schema 1.10.0 → 1.11.0, configVersion 2026.09.22-9 → -10.

- **Q1 — measured-move flag targets (M-5b):** `lib/patternDetector.js` publishes `poleHeight`, `measuredTarget`, `measuredRR` on every flag candidate (not coils); `measuredMoveFor()` is called again after geometry snapping so a moved `breakoutLevel` keeps a consistent target. Never a target from a moving average.
- **Q2 — `ema200Side` on flag candidates (M-6):** `above` / `below` / `null` (EMA200 unavailable), computed in `services/scalpContext.js` from the candidate's own timeframe. Never filters - a short above the 200 or a long below it still publishes.
- **Q3 — top-down sentiment (M-1, M-2, M-6, M-6b):** new `lib/topDown.js` (pure, no I/O) - `weeklyFromDaily()`/`buildWeeklyLean()` (1W from the already-fetched 1D candles, Monday-aligned weeks; weekly EMA200 always null, not enough history), `buildTopDown()` (weighted vote over 1W/1D/4H/1H, config `model.topDownWeights`), `buildAboveBelow200()` (config `model.above200Weights`). Default payload: `decisionTrace.bias` gets two more tokens, `|td:<bull|bear|mixed>:<n>/4|a200:<count>/<of>`. Full `symbols.X.topDown` object opt-in via `include=bias`. Never gates or changes a strategy, candidate, or confidence.
- **Q4 — replay outcome scoring (M-9, master plan M1):** new `scripts/replay-outcomes.js` / `npm run replay:outcomes` - walks a replay JSONL forward on 1m candles with no lookahead, scoring every valid strategy signal and every confirmed flag candidate (using Q1's `measuredTarget` as TP1): fill rate, win rate, average win R, expectancy, max consecutive losses, median time to TP1. Dev-only script, no production code path.
- **Q5 — GPT instructions (budget-neutral):** `docs/GPT_INSTRUCTIONS.md` teaches `measuredTarget`/`measuredRR`/`ema200Side` and the `td:`/`a200:` trace tokens; trimmed an equal amount elsewhere (duplicated field lists, redundant phrasing) to hold 7990 → 7990 UTF-16 units.
- New config: `config/engine.json` `model` key (`topDownWeights`, `above200Weights`, `weeklyMinWeeksForEma21`, `weeklySlopeLookbackWeeks`) and `replay.outcomes` (`fillWindowCandles`, `maxHoldCandles`).
- New tests: `test-top-down.js` / `npm run test:topdown` (14). Additions to `test-pattern-detector.js`, `test-scalp-context.js`, `test-bias-matrix.js`, `test-replay.js`. All twelve suites green (412 passing); `npm run check:gpt` OK (0 headroom); `git diff --check` clean.
- **Payload budget (2026-09-23):** published candles on 1m/3m/5m 30 → 24 and candle volume rounded to 2 decimals; `poleHeight` no longer published (equals |measuredTarget − breakoutLevel|); EMA values rounded to 2 decimals in the payload. Live default 3-symbol payload 81.3 KB → 74.3 KB.

## 2026-09-23 — F1: Flag Detection Coverage (branch `upgrade-signal-engine`)

Single implementer pass per `docs/PLAN_FLAG_DETECTION_COVERAGE.md`, fixing the incident where BTC/SOL/ETH 1m longs went silent or vanished around a real flag's lifecycle (`test/fixtures/history/2026-09-23`; see `test/fixtures/misses/MISS_003.json`). Detection and trade qualification stay separate: a flag is reported because its geometry exists, not because a strategy wants to trade it. Additive only; long and short share the one oriented code path throughout. Schema 1.11.0 → 1.12.0, configVersion 2026.09.22-10 → 2026.09.23-1.

- **Item 1 — `proto` state:** an impulse that qualifies with 1 to `minCandles - 1` pullback candles (no new extreme past the impulse peak) publishes as `state: "proto"`, no entry call. Lifecycle order: proto → forming → triggering → confirmed → failed / expired.
- **Item 2 — wider impulse lookback:** `flag.maxImpulseCandles` 8 → 20, verified against both replay histories (gate rate stayed under 0.15; see Verification below).
- **Item 3 — EMA21 reclaim:** a flag whose first candle is off-side of EMA21 but closes back on-side within `flag.reclaimCandles` (default 2) is valid; `ema21Hold: "reclaim"` (scores like `wick`). The acceptance-fail rule is unchanged.
- **Item 4 — failed stays visible:** a failed candidate stays in the default `candidateSetups` for `flag.failedTtlCandles` (default 10) candles of its own timeframe past failure, carrying `failReason` and the new `failedAt`; older failures still follow `config.flag.includeFailed`. The search window itself now reaches `flag.maxBreakoutAge + max(failedTtlCandles, expiredTtlCandles)` candles back so a failure this old is still findable.
- **Item 5 — `expired` state:** a flag that would still read `confirmed` more than `flag.maxBreakoutAge` candles past its break instead reads `state: "expired"`, `chaseRisk: true`, for `flag.expiredTtlCandles` more candles, then is no longer found - replacing the old silent drop at exactly `maxBreakoutAge` candles (the incident's SOL 14:57 miss).
- **Item 6 — stable identity:** `candidateId` (`"<SYMBOL>:<tf>:<direction>:<impulseStart ISO>"`) and `firstDetectedAt`, derived from this request's own candle window (`lib/patternLifecycle.js` `identifyCandidate`), so the same flag run keeps the same id across forming → triggering → confirmed. `impulseStart`/`impulseEnd` are not separately published (byte budget - both are mechanically derivable from fields already kept: `impulseStart` is `candidateId`'s own last segment, `impulseEnd` is `firstDetectedAt` minus one candle).
- **Item 7 — cheap geometry:** `flagSlope` (least-squares slope of the flag's own closes, % per candle, real price space), `breakoutDistancePct`, `invalidationDistancePct` (signed % from the last close), rounded to 2-4 decimals.
- **Item 8 — trade qualification:** new `lib/candidateQualifier.js`. Every candidate (flag or coil) gets `qual: { quality: low|med|high, decision: watch|wait|dont|actionable, reasons: [] }`, built only from data already in the payload (the symbol's other candidates, its geometryContext, Stoch RSI, the 4h bias lean, and the candidate's own ema200Side/chaseRisk/measuredRR) - never a new detection signal, never a probability of profit.
- **Item 9 — payload:** default 3-symbol payload settled at ~75.3 KB (77068 B measured) after `CANDLE_LIMITS` on 1m/3m/5m went 24 → 20 (F1's new per-candidate fields, plus more candidates surviving longer via items 1/4/5, had pushed a busy-market default to ~79.3-83.3 KB). Build time ~840 ms (unchanged order of magnitude). `decisionTrace.candidateSetups` trace strings gained the `proto`/`expired` states.
- **Item 10 — GPT instructions:** `docs/GPT_INSTRUCTIONS.md` - `flags` now covers every state including proto/failed/expired plus `qual.decision`+`reasons`; `forming` includes proto; a data-freshness note that closed candles may trail the live chart by one candle; `confidence=pattern evidence only` disambiguates it from the new `qual.quality`. Funded by tightening existing wording (no rule removed); FORMAT/TRACK FORMAT/NO TRADE LINE untouched. 7988 → 7988 UTF-16 units (net zero); schema marker bumped to 1.12.x.
- **Item 11 — MISS_003:** `test/fixtures/misses/MISS_003.json`, `status: validated` - replaying `test/fixtures/history/2026-09-23` now shows a 1m long candidate at every close 14:45-15:03 for BTC/ETH/SOL (nothing reads "none"), SOL triggers at 14:52 exactly as the incident predicted, and SOL's confirmed flag reads `expired` at 14:57 instead of vanishing.
- **Verification:** all twelve suites green (423 passing, up from 412); `npm run check:gpt` OK (2 units headroom, same as before); `git diff --check` clean. Replay gate rate: 2026-09-22 history 0.0509 → 0.1353; 2026-09-23 history 0.0504 → 0.1485 (both under the 0.15 stop threshold). Flag-candidate expectancy moved in both directions across the six (symbol × direction) groups with materially more signals per group (more detection, the plan's intent); no group flipped from healthy to broken. Full before/after numbers: `docs/EDITTRADES_MCP_CONNECTOR.md`, implementer report.
- New config: `config/engine.json` `flag.reclaimCandles` (2), `flag.failedTtlCandles` (10), `flag.expiredTtlCandles` (10), `flag.quality` (`highConfidence` 75, `medConfidence` 50), `flag.maxImpulseCandles` 8 → 20.
- New module: `lib/candidateQualifier.js`.
- New tests: additions to `test-pattern-detector.js` (26 → 32), `test-replay.js` (30 → 31, incl. MISS_003), `test-scalp-context.js` (CANDLE_LIMITS 20), `scripts/replay-metrics.js` STATES list extended (proto, expired).

## 2026-09-23 — Signal-reliability minimum plan (branch `upgrade-signal-engine`)

Single implementer pass. A flag candidate, even `confirmed`, even `qual.actionable`, was never a trade call - no exact entry, no fees-adjusted R:R, no staleness gate, and the outcome-replay script could credit a same-candle fill+target touch as a win despite unknowable intrabar order. This pass adds the smallest dependable bridge from an existing 1m/3m/5m flag candidate to one reproducible engine-owned trade call, fixes the replay false-win bug, and adds a local paper ledger - not the full `FLAG_21` roadmap, no higher-timeframe flags, no execution. Additive only; `strategies.*`/`bestSignal` byte-identical; legacy strategy engine, MCP's one read-only tool, and the 3% scalp stop cap untouched. Schema 1.12.0 → 1.13.0, configVersion 2026.09.23-1 → -2.

- **Work package 1 — freshness gate:** new `lib/freshness.js` (`assessFreshness`/`assessFreshnessAll`, pure) - a timeframe's `closedThrough` is fresh for one interval plus a fixed provider grace period (`freshness.graceMs`, 5s); missing or unparseable timestamps, and a `closedThrough` in the future, fail closed. Feeds `flagTradePlan`'s own `stale_data`/`missing_data` rejection; `dataStatus` semantics unchanged. `trades` added as a COMMANDS alias of `signals` (never a third trade-call format).
- **Work package 2 — engine-owned flag trade plan:** new `lib/flagTradePlan.js`, wired into `services/scalpContext.js` as `symbols.<SYM>.flagTradePlan`. Considers only `type: flag`, `state: confirmed` candidates; publishes at most one selected plan per symbol. Entry = the candidate's own (geometry-snapped) `breakoutLevel`, read as a retest/hold trigger, never live price; stop = `invalidation`, never tightened; TP1 = `measuredTarget`, capped to the nearest horizontal zone edge ahead of entry (a zone touching entry itself is `room_at_entry`, not a cap); TP2 = the measured target when it still lies beyond a capped TP1. `netRR` nets `config.risk.feeBps`/`slippageBps` round-trip cost against both legs; required ≥ `flagPlan.minNetRR` (3.0) and stop distance ≤ `scalp.maxStopDistancePct` for `ready`/`conditional` - never satisfied by moving the stop. `ready` now requires the latest closed candle to retest and hold the valid side of the breakout level within tolerance; `conditional` uses `awaiting_retest_hold` or `awaiting_breakout`. Selection is deterministic: ready before conditional before rejected, then confidence, higher timeframe, stable `candidateId`. The 4h bias lean is never a gate here.
- **Work package 3 — replay and forward-paper ledger:** `scripts/replay-outcomes.js`'s `walkOutcome` now fills at the unfavorable zone edge (was the zone midpoint) and never credits a target touched on the same candle as the fill as a win (the order of entry vs. target within one candle is unknowable from OHLC alone) - only a later, unambiguous candle's touch counts. `extractFlagPlanSignals` now scores ready plans only; replay and ledger outcomes are explicitly labelled gross level-touch diagnostics until the scorer reproduces the complete closed-candle entry and net fee/slippage accounting. New `scripts/paper-ledger.js` (`npm run ledger:record` / `ledger:score`) is local, append-only JSONL, never carries `account`, and never rewrites the ledger.
- **Work package 4 — GPT contract:** `docs/GPT_INSTRUCTIONS.md` CANDIDATES - `flagTradePlan=trade authority` (ready/conditional/rejected + `entryCondition`/`reasonCode`), replacing the old unconditional "confirmed + chaseRisk=false = a setup despite NO_TRADE" permission with "Confirmed alone isn't a trade." COMMANDS - `trades = signals.`. Funded entirely by tightening existing wording (no rule dropped; FORMAT/TRACK FORMAT/NO TRADE LINE untouched); GPT test sheet grew an 11th prompt (`trades`). 7988 → 7987 UTF-16 units.
- New config: `config/engine.json` `freshness` (`graceMs` 5000), `flagPlan` (`minNetRR` 3.0, `entryToleranceAtr` 0.1).
- New modules: `lib/freshness.js`, `lib/flagTradePlan.js`, `scripts/paper-ledger.js`.
- New tests: `test-freshness.js` / `npm run test:freshness` (10), `test-flag-trade-plan.js` / `npm run test:flagplan` (34, incl. mirrored long/short, nearest-level cap, chase, stale, price-past-entry, net-RR boundary, 4h-flat policy, stable identity, legacy-output parity), `test-paper-ledger.js` / `npm run test:ledger` (10). Additions to `test-replay.js` (31 → 35: unfavorable-fill entries, no-false-intrabar-win, flag-plan signal extraction/scoring).
- **Verification and limitations:** replayed the two saved histories (`test/fixtures/history/2026-09-22`, `2026-09-23`) against the exact selected `flagTradePlan` per close; see the implementer report for sample sizes. Ten to twenty forward-paper calls (or two short saved-history replays) are a workflow smoke test, not an accuracy claim - green tests do not imply a profitable strategy or production readiness. The deployed GPT and its knowledge file were not available to verify against; see the implementer report for what remains unverified.

## 2026-09-23 — Review fix pass on packages 1+2 (branch `upgrade-signal-engine`)

Blocker fixes from the Phase 0 review (`docs/MASTER_PLAN_NEXT_STEPS.md`). Schema 1.14.0 → 1.15.0 (published field changes below), configVersion 2026.09.23-3 → -4. No strategy, `bestSignal`, scalp-guard, MCP, or wallet change.

- **Flag plan `ready`:** requires an earlier closed candle that closed through the breakout level, then the latest closed candle reaching the level within `flagPlan.entryToleranceAtr` ATR and closing on the hold side. Otherwise `conditional` with `awaiting_breakout` or `awaiting_retest` (renamed from `awaiting_retest_hold`). `entryCondition` states the sequence, entry rounded to 2 decimals.
- **Model evidence:** Stoch history offset from the candle series' end (pre-history pivots get no value); divergence picks the most recent bull/bear pivot pair; stale divergences (strength 0) no longer count toward confluence; a fade against sentiment at the channel edge is `breakoutRisk: high`; no direction → `unknown` and no levels ahead; weekly EMA21 gap no longer filed under `unavailable.ema200`.
- **Recommendation:** `price: null` → `DATA_UNAVAILABLE`; with no plan, missing/stale 1m/3m/5m → `DATA_UNAVAILABLE` with `unknowns` like `stale_data:1m`. R:R floor read from `flagPlan.minNetRR` only (`model.minNetRR` removed); weights use `??`.
- **Payload budget:** default `flagRecommendation` is codes + one-line primary/change-condition text (full record with refs/factorStates under `model.recommendation`, include=model); failed candidates publish identity + `failReason` fields only; `CANDLE_LIMITS` 15m/1h 24 → 20. Live default 84,095 → 76,889 B, compact 41,899 B. New fixture byte-cap test (default ≤ 79,000 B, compact ≤ 45,000 B).
- **Ledger / replay:** ledger id = `planId|status|reasonCode` (rejected → ready in one window keeps both rows); `ready` plans are filled at the ready close at the entry level (`walkOutcome` `prefilled`), R still labeled gross.
- **Tests:** new `npm run test:evidence` (8). `test:scalp` 109 → 113, `test:flagplan` 35 → 40, `test:flagrec` 12 → 17, `test:ledger` 10 → 12, `test:replay` 35 → 36.

## 2026-09-23 — 21/200 decision clarity follow-on (branch `upgrade-signal-engine`)

Follow-on work package from `EDITTRADES_21_200_DECISION_CLARITY_MASTER_PLAN.md`. This package is about faithful communication of the owner's EMA21/EMA200 flag model, not win-rate proof. Additive only; no execution, secrets, deploy, commit, push, or writable MCP tool. Schema 1.13.0 → 1.14.0, configVersion 2026.09.23-2 → -3.

- **Preflight fixes:** retest readiness now requires a closed candle to retest and hold the valid side of the breakout level; ready outranks conditional in selected-plan ranking; replay/paper-ledger plan scoring waits for `ready` and labels R as gross level-touch R, not exact net plan outcome.
- **Model evidence:** new `lib/modelEvidence.js` builds opt-in `include=model` evidence: per-timeframe EMA21/EMA200 map and pull read, higher-timeframe flags via the existing detector, channel/level context, breakout-risk basis, and Stoch RSI divergence from existing pivots/Stoch histories.
- **Recommendation engine:** new `lib/flagRecommendation.js` returns one deterministic `flagRecommendation` per symbol: `GOOD`, `WATCH`, `BAD`, or `DATA_UNAVAILABLE`; `supports[]`, `opposes[]`, `unknowns[]`, `changeConditions[]`, `factorStates[]`, `qualityBand`, `readiness`, `policyVersion`, and trace. It consumes `flagTradePlan`; it never recalculates plan levels/R:R and never promotes legacy `bestSignal` as the 21/200 recommendation.
- **Payload/API:** `flagRecommendation` is compact and always present. Bulky evidence is opt-in via `include=model` for REST/MCP. OpenAPI and connector docs updated.
- **Docs:** added `docs/TRADING_MODEL_DECISION_CONTRACT.md` (M-1..M-9 rule table, provenance, implementation choices) and `docs/FLAG_RECOMMENDATION_REVIEW_SHEET.md` (representative outputs, GPT manual update checklist, unresolved owner interpretations).
- **GPT instructions:** schema marker bumped to 1.14.x. GPT now treats `flagRecommendation` as the 21/200 call and `flagTradePlan` as the level/math authority; legacy strategies are explicitly legacy. `npm run check:gpt` passes at 7978 UTF-16 units.
- **Tests:** new `npm run test:flagrec` (12) covers GOOD/WATCH/BAD/DATA_UNAVAILABLE, aligned/mixed context, counter-EMA200, channel/level context, divergence agreement/conflict, missing weekly EMA200, stale data, no plan, low net R, byte stability, and mirrored short behavior. Updated `test:scalp`, `test:mcp`, `test:config`, `test:flagplan`, `test:replay`, and `test:ledger`.

## 2026-09-23 — P1: Pyth mark price beside the Kraken price (branch `upgrade-signal-engine`)

Plan: `docs/PLAN_PYTH_MARK_PRICE.md`. Schema 1.15.0 → 1.16.0, configVersion 2026.09.23-4 → -5. Additive only; candles, strategies, `bestSignal`, `flagTradePlan`, MCP registration and wallet unchanged.

- **Mark:** new `lib/pythMark.js` reads the live Pyth price for every symbol in one Hermes request (`/v2/updates/price/latest?ids[]=..&parsed=true`, `Authorization: Bearer $PYTH_API_KEY`, 4 s timeout). Never throws; no key → no request. The key and URL are never logged. Runs alongside the candle fetches.
- **Payload:** `symbols.<SYM>.mark = {price, conf, publishTime, source: "pyth", ageSec, driftBps, status}` beside `price` (still the closed 1m close). `status` ok | stale (> `mark.pyth.maxAgeSec` 30) | unavailable. Unavailable never changes `dataStatus` and adds no warning. Compact keeps `{price, driftBps, status}`. `decisionTrace.bias` appends `|mark:<driftBps>` or `|mark:na`. Injected-candle builds (tests, replay) read `unavailable` with no request.
- **Config:** `mark.pyth` block: BTC/ETH/SOL feed ids, `maxAgeSec` 30, `timeoutMs` 4000.
- **GPT instructions:** one RISK rule: stops, Thesis Eliminated and liquidation are hit on mark; check against `mark.price`, flag |driftBps| > 10.
- **Tests:** new `npm run test:mark` (12). `test:scalp` 113 → 117 (mark on every symbol, filterPayload default/compact, fetch failure leaves `dataStatus`, byte cap with ok marks: fixture default 77,063 B ≤ 79,000).

## 2026-09-23 — Owner decisions 1 and 4: gross 3R gate, own-timeframe room check (branch `upgrade-signal-engine`)

Source: `docs/OWNER_DECISIONS_2026-09-23.md` items 1a and 4a. Schema 1.16.0 → 1.17.0, configVersion 2026.09.23-5 → -6. Additive except the named renames; `strategies`, `bestSignal`, MCP registration and wallet unchanged.

- **3R is gross price R:** `flagTradePlan.grossRR` = `|tp1 − entry| / |entry − stop|` (3 decimals), published beside `netRR` (computed as before). The plan gate is `grossRR < flagPlan.minRR` → rejected `rr_below_min` (replaces `net_rr_below_3`). `netRR` is information only and never rejects.
- **Config:** `flagPlan.minNetRR` renamed `flagPlan.minRR` (3.0).
- **Recommendation:** BAD on `rr_below_min` (primary text cites `grossRR` and the floor). Ready/conditional plans get support `rr_ok` (gross) and, when `netRR < minRR`, a non-blocking oppose `net_rr_low` ("fees eat the edge"). `net_rr_ok` / `net_rr_unknown_or_low` / `net_rr` removed; net R:R never makes a plan BAD.
- **Room check:** `lib/candidateQualifier.js` `roomBlockedReasons` reads only the candidate's mapped geometry timeframe (`geometryTimeframeFor`, 1m/3m/5m → 15m); a zone only on 1h/4h no longer emits `room:blocked-<tf>`. `flagTradePlan`'s TP1 cap (all geometry timeframes) is unchanged.
- **Docs:** `openapi/scalp-context.yaml`, `docs/TRADING_MODEL_DECISION_CONTRACT.md` M-5b/M-9, `docs/FLAG_RECOMMENDATION_REVIEW_SHEET.md` samples, `docs/EDITTRADES_MCP_CONNECTOR.md`, `docs/GPT_INSTRUCTIONS.md` field map (outside the instruction block; `check:gpt` unchanged at 7976).
- **Tests:** `test:flagplan` 42 → 43 (gross exactly 3 passes with net < 3; gross 2.9 rejects `rr_below_min`; mirrored), `test:flagrec` 17 → 18 (`net_rr_low` never BAD, ready + conditional, mirrored), `test:pattern` 32 → 33 (own-tf room check, mirrored); `test:replay` fixtures renamed; schema asserts in scalp/pattern/geometry/config bumped.

## 2026-09-23 — Phase 2: recommendation completeness (branch `upgrade-signal-engine`)

Owner goal: every recommendation says what supports it, what opposes it, what is unknown, and what specific event changes the call. Additive only; class logic, `flagTradePlan`, strategies and `bestSignal` unchanged. Schema 1.17.0 → 1.18.0, configVersion 2026.09.23-6 → -7.

- **Context on every record** (`lib/flagRecommendation.js`, all classes except `market_data_unavailable`): `td:<sentiment>:<n>/4`, `a200:<above>/<of>`, `ema200:<tf>:<side>`, `ema200:1w:missing`, `4h:with` / `ct:4h` / `4h:flat`, `level:<geomTf>:<price>` or `level:none` (first level beyond the breakout on the candidate's own geometry timeframe; oppose when before the measured target), `tp1_capped:<price>`, `chan:<geomTf>:<edge>:<risk>`, the candidate's `conflict:`/`stoch:`/`rr:` qual codes, `divergence_*`, `data_fresh` / `data_partial`. Placed by direction; undirected context is `unknown`. Never a veto; unknown never improves a class.
- **WATCH names its candidate:** new `candidate{candidateId, timeframe, direction, state, breakout, invalidation, measuredRR}` (triggering > forming > proto, then confidence, then smaller timeframe); `changeConditions` reads e.g. `3m close above 84,466.10, then a retest that holds it, then plan ready; a close below 84,300.00 voids it`, or `a 1m/3m/5m flag must form (none detected)`.
- **BAD** lists the disqualifying reason first (`opposes[0]`) and a concrete remedy: chase → retest of the entry that holds; `rr_below_min` → a measured move ≥ 3R gross; `room_at_entry`, stop cap, invalid levels likewise. Mirrored for shorts.
- `services/scalpContext.js` passes `candidates` and `geometryContext` into `buildFlagRecommendation` (read-only).
- New suite `npm run test:flagrec:fixtures` (`test-flag-recommendation-fixtures.js`, 16 cases, pinned clock, mirrored, byte-stable). Payload on the saved 2026-09-23 fixture: default 76,864 → 78,003 B (cap 79,000), compact 41,459 → 42,598 B. GPT instructions unchanged (7,976 units). Not deployed.

## 2026-09-23 — T1: call tracker (branch `upgrade-signal-engine`)

Plan: `docs/PLAN_CALL_TRACKER.md`. No engine, payload, MCP, or Vercel change; schema stays 1.18.0. Owner decisions: 10-minute cadence; the tracker repo is self-contained.

- **`scripts/tracker/`** (Node ≥ 20, no dependencies, every script takes `--data <dir>`, page takes `--out <dir>`): `collect.js` (GET `/api/scalp-context` with `SCALP_CONTEXT_API_KEY` from env; one row per symbol to `data/calls/YYYY-MM-DD.jsonl`; strips `account`/`wallet`/`performance`/`margin`/`holdings*` and any key containing wallet/balance/address at any depth, then refuses the write if any survived; dedupe on symbol+closedThrough; closed 1m/5m/15m candles to `data/candles/<tf>.jsonl`), `store.js`, `score.js` (ready plans filled at the ready close; conditional plans scored only through the ready plan they became; rejected plans counted by reason; every recommendation class change scored as a call; 24 h window then `expired`; idempotent; gross R, plan netRR carried), `aggregate.js`, `build-page.js` (static `docs/index.html` + `docs/report.md`, "provisional; not evidence of an edge" on every section), `walk-outcome.js` (vendored copy of `scripts/replay-outcomes.js` `walkOutcome`, parity-tested), `sync.js` + `repo-template/` (README, package.json, collect/score workflows).
- npm scripts `test:tracker` (17), `tracker:collect`, `tracker:score`, `tracker:page`, `tracker:sync`.
- Tracker repo `Bai-ee/edittrades-tracker` (private): `collect.yml` every 10 min, `score.yml` hourly.
- **Charts (2026-09-23):** page gains an engine-call equity curve (cumulative gross R of scored ready plans, 11 client-side filters, by-filter table) and a wallet value chart from a new whitelisted `data/wallet.jsonl` (`t, status, marginUsd, holdingsUsd, totalUsd, baselineUsd, pnlUsd, pnlPct` only); scored calls carry `dims`; `scripts/tracker/charts.js`; `test:tracker` 25.

## 2026-09-24 — T2: trade journal (branch `upgrade-signal-engine`)

Plan: `docs/PLAN_TRADE_JOURNAL.md` (the deferred 8c). No payload, schema, config or MCP change. Not deployed.

- **`api/journal.js`** (new function; function count stays 12): `POST /api/journal` records one line the user told the GPT, `GET /api/journal?limit=` returns the last N (default 10, max 50) newest first. Bearer `JOURNAL_API_KEY`; 405 for other methods; 4 KB body cap (413); invalid JSON/record 400; 10 requests/min per key in memory (best effort on serverless); idempotent on `id` (same id in today's or yesterday's file → 200 `duplicate:true`). Storage: Vercel Blob (`@vercel/blob`, public store `edittrades-journal`), `journal/YYYY-MM-DD.jsonl` appended by ETag-guarded read-modify-write, plus `journal/manifest.json` (`baseUrl`, `days[]`) so the tracker fetches with plain HTTP. Imports only `crypto`, `@vercel/blob`, `lib/journalSchema.js`; never an MCP tool.
- **`lib/journalSchema.js`** (pure): `text` required; `kind` open/close/adjust/skip/note (default note); symbol, direction, entry/stop/tp1/sizeUsd/leverage/exitPrice (> 0), resultR/resultUsd optional; optional `engineRef` {candidateId, planId, recClass, reasonCode}; stored record built from an explicit key list.
- **Retired `api/crypto-news.js`** and its `vercel.json` route (unused; local `server.js` keeps its own inline route).
- **`openapi/scalp-context.yaml`**: `postJournal` / `getJournal` under `/api/journal`, second bearer scheme `journalKey`. The GPT Action needs a re-import.
- **`docs/GPT_INSTRUCTIONS.md`**: COMMANDS `log <text>` and `journal`; 7976 → 7982 units, funded by whitespace/wording only (no rule removed; FORMAT/TRACK FORMAT/NO TRADE LINE untouched). Test sheet prompts 12-13.
- **Tracker**: `collect.js` pulls the journal (manifest + day files, cache-busted; base URL from `--journal-base`, `JOURNAL_BLOB_BASE`, or the store id in `BLOB_READ_WRITE_TOKEN`) into `data/journal/` (dedupe by id, sensitive-key strip); `score.js` scores each `open` like a ready plan or takes a matching `close`'s reported R / exit price, `dims` from the linked engine call → `data/journal-outcomes.jsonl`; page: dashed "your trades" line on the equity chart under the same filters, entry/exit ticks on the wallet chart, "Engine vs you" block, journal log. Workflow passes `BLOB_READ_WRITE_TOKEN`.
- Tests: new `npm run test:journal` (16); `test:tracker` 25 → 31; `test:mcp` unchanged (52).

## 2025-11-27

### 📊 Professional Trading Indicators - VWAP, ATR, Bollinger, MA Stack

- **VWAP (Volume Weighted Average Price)** - Intraday timeframes (5m, 15m, 1h):
  - Value and distance percentage
  - Above/below detection and bias direction
  - AtVWAP flag (within 0.2%)
  - Reversion zone detection (> 2% away)
  - Trapped longs/shorts positioning logic
  
- **ATR (Average True Range)** - All timeframes:
  - ATR value and percentage of price
  - Volatility state classification (LOW/NORMAL/HIGH)
  - Guides position sizing and stop-loss placement
  
- **Bollinger Bands** - 4h, 1h, 15m:
  - Upper, middle, lower bands
  - Band width percentage
  - Squeeze detection (bandwidth < 2%)
  - Price position percentage (0-100 scale)
  - Overbought/oversold zones
  
- **MA Stack Analysis** - 4h & 1h:
  - EMA 50 added to existing 21 & 200
  - Bull/Bear/Flat stack detection
  - Trend structure confirmation
  
- **New Module**: `lib/advancedIndicators.js` with all calculations
- **Documentation**: `ADVANCED_INDICATORS_GUIDE.md` - Complete usage guide with thresholds

### 🎯 Advanced Candle Analysis & Price Action
- **Candle Metrics** (all timeframes):
  - Direction: bull/bear/doji
  - Body percentage (0-100%)
  - Upper/lower wick percentages
  - Close position within range
  - EMA21 relationship (above/below)
  - Full OHLC range

- **Price Action Patterns** (all timeframes):
  - Rejection Up/Down (wick-based reversals)
  - Engulfing Bull/Bear patterns
  - Inside Bar detection
  - Pattern detection from last 2 candles

- **Support & Resistance Levels** (4h & 1h only):
  - Nearest resistance/support prices
  - Distance to levels (percentage)
  - At level detection (within 0.5%)
  - Break detection (closed through level)

- **Recent Candles** (5m only):
  - Last 5 candles for LLM context
  - OHLC for each candle
  - Ordered oldest → newest

- **UI Updates**:
  - Removed colors from prices (EMAs, Swing High/Low)
  - Only trend indicators keep colors (UPTREND/DOWNTREND/FLAT)
  - Cleaner, more minimal appearance

- **New Modules**:
  - `lib/candleFeatures.js` - Candle analysis and pattern detection
  - `lib/levels.js` - Support/resistance calculation
  
- **Documentation**: `ENRICHED_SCHEMA.md` - Complete field reference and examples

### 📊 Expandable Detailed Timeframe Analysis
- **Show/Hide Details**: Click "Show" button on any coin to expand full timeframe breakdown
- **4 Detailed Cards**: Each timeframe (4h, 1h, 15m, 5m) displays:
  - Current Price
  - 21 EMA & 200 EMA
  - Stoch RSI (%K, %D, condition)
  - Pullback State (with distance from 21 EMA)
  - Swing High & Swing Low
  - Trend badge (color-coded border)
- **Responsive Grid**: 1 column on mobile, 2 on tablet, 4 on desktop
- **Color Indicators**: Green border for uptrend, red for downtrend, gray for flat
- **Collapsible**: Click "Hide" to collapse details and keep table compact

### 🚀 Auto-Run Homepage + Detailed Table View
- **Auto-Scan on Load**: Homepage automatically scans BTC, ETH, SOL on page load (no button click needed)
- **Detailed Table View**: Shows full trading info (price, signal, confidence, entry, stop loss, targets, timeframes)
- **Responsive Columns**: Hide less important columns on mobile (Entry on SM, Stop on MD, Targets on LG)
- **Click Row for Details**: Click any row to see full analysis in popup
- **Individual Copy**: Copy button for each coin in table
- **Copy All**: Export all 3 coins together
- **Unified UI**: Scanner page now matches homepage styling
- **Parallel Fetching**: All 3 coins fetched simultaneously (~3-4 seconds total)
- **Timeframe Badges**: Compact indicators showing trend for 4h, 1h, 15m, 5m

### 🎨 Major UI Redesign - Mobile-First Dark Theme
- **New Homepage**: Single-button scan for BTC, ETH, SOL
- **Dark Theme**: Pure black/off-white color scheme, no gradients or glows
- **Mobile-First**: Optimized for phone screens, minimal scrolling
- **Multi-Coin View**: Display all 3 coins in compact cards
- **Trade Opportunities Summary**: Quick overview of valid setups
- **Individual Copy Buttons**: Copy each coin separately
- **Copy All**: Export all 3 coins in single JSON
- **Compact Timeframe Display**: 2x2 grid on mobile, 4x1 on desktop
- **Visual Indicators**: Green/red left borders on cards with valid trades
- **Documentation**: `NEW_UI_GUIDE.md` with full design specs

### 📊 Added - Dashboard View JSON Copy Button
- **New Button**: 📊 View - Copies exactly what's displayed on dashboard as compact JSON
- **Auto-syncs**: Automatically includes any new fields we add to the dashboard
- **Size**: ~2-3KB (smaller than full API, includes all timeframes unlike LLM compact)
- **Use Cases**: Sharing analysis, trading journals, documentation, historical review
- **Documentation**: `DASHBOARD_VIEW_JSON.md` with examples and field reference

## [Previous] - 2025-11-27

### 🤖 Added - Compact API for LLM/ChatGPT Integration
- **New Endpoint**: `/api/analyze-compact/{symbol}` - Streamlined API response optimized for LLM ingestion
- **Size Reduction**: 99.75% smaller (470 bytes vs 192KB) - perfect for ChatGPT token limits
- **UI Integration**: Added 🤖 LLM button to dashboard and scanner for one-click copy to clipboard
- **Documentation**: 
  - `COMPACT_SCHEMA.md` - Complete JSON schema and field reference
  - `LLM_QUICK_START.md` - Quick start guide with ChatGPT prompt templates

### 🐛 Fixed - Mobile Error
- Added defensive null checks for `data.analysis` to prevent `Object.entries` error on mobile devices
- Enhanced error logging for better debugging across devices

### 📊 Features
- Compact response includes all essential trading data:
  - Trade signal (valid/invalid)
  - Direction (long/short/NO_TRADE)
  - Confidence score (0-100%)
  - Entry zone, stop loss, targets
  - Risk/reward ratio
  - 4H and 1H trend analysis
  - Key indicators (EMA21, EMA200, Stoch RSI)
  - Market structure (swing high/low)

### 📝 What's Removed (for size optimization)
- Raw candlestick OHLCV data
- 15m and 5m timeframe data
- Verbose nested indicator objects
- Debug information
- Redundant metadata

---

## Previous Updates

### 2025-11-26 - Copy Buttons for API Data
- Added copy-to-clipboard functionality for API endpoints
- Added copy buttons for full JSON responses
- Visual feedback for successful copies

### 2025-11-25 - Vercel Deployment
- Migrated from Express server to Vercel serverless functions
- Created `/api/analyze`, `/api/indicators`, `/api/scan` endpoints
- Added deployment protection configuration
- Fixed routing issues for path parameters

### Initial Release
- 4H Set & Forget trading strategy automation
- Multi-timeframe analysis (4h, 1h, 15m, 5m)
- Market scanner for finding opportunities
- Technical indicators: EMA, Stoch RSI, market structure
- Confidence scoring system
