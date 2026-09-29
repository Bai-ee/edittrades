# Documentation Index

**Last updated:** 2026-09-27
**Branch:** `upgrade-signal-engine`
**Current product:** EditTrades scalp context — closed-candle BTC/SOL/ETH context, legacy strategy engine, and 21/200 flag recommendation, served to ChatGPT via REST Action (`GET /api/scalp-context`) and MCP (`POST /api/mcp`), plus a Telegram bot with live perps execution (`docs/PLAN_TELEGRAM_EXECUTION.md`, on since 2026-09-26). Payload schema 1.28.0, configVersion 2026.09.27-2 (NF stop floor, automatic +1R trailing stop, G1/G2 risk guardrails) — merged and, per the owner's 2026-09-27 status, live; see `docs/EDITTRADES_MCP_CONNECTOR.md`'s header for the exact deploy history this session did not itself re-verify. Schema 1.29.0 / configVersion 2026.09.27-3 (T-20, HTF-anchored entries: `symbols.<SYM>.htfEntry`, DIRECTION/ENTRY/EXIT Telegram cards, tracker class `HTF_1M`) is built on worktree `snapshot_tradingview-htf` (branch `htf-entry`) - **not yet merged to `upgrade-signal-engine`, not deployed**.

Docs are in two tiers. **Current** docs are maintained with the code. **Legacy** docs describe the Nov–Dec 2025 system (dashboard, `/api/analyze*`, scanner, AI agent, Jupiter swaps/perps) and carry a banner saying so. That code still exists, but those docs were not re-audited for the September 2026 engine work. When a legacy doc and a current doc disagree, the current doc and the code win.

---

## Current

### Start here
- **[../CLAUDE.md](../CLAUDE.md)** (local only, untracked) — project guide, hard rules, tests, deploy. Its own "Read first" pointer can't be updated from here since the file isn't tracked, so this line stands in for it: **[STATUS_2026-09-27.md](./STATUS_2026-09-27.md)** is the latest site + docs status (T-17); read it first for "what does the site say right now."
- **[STATUS_2026-09-27.md](./STATUS_2026-09-27.md)** / **[STATUS_2026-09-26.md](./STATUS_2026-09-26.md)** — wrap-up manager status logs: what shipped, what's stale, what got fixed, what's still open, one dated file per pass.
- **[MASTER_PLAN_ENGINE_REFINEMENT.md](./MASTER_PLAN_ENGINE_REFINEMENT.md)** — phased engine plan with status. Phases 0–8, 8b, 9, 9b, 10, 11 done; then 8c, 3b.
- **[MASTER_PLAN_TRADING_MODEL.md](./MASTER_PLAN_TRADING_MODEL.md)** — the owner's trading model (M-1..M-9) and the phased plan to build it (`FLAG_21`). **[PLAN_TRADING_MODEL_QUICK_PASS.md](./PLAN_TRADING_MODEL_QUICK_PASS.md)** — the Q1-Q5 quick pass (done 2026-09-23, schema 1.11.0) that pre-built parts of M1/M2/M2b/M4/M10.
- **[TRADING_MODEL_DECISION_CONTRACT.md](./TRADING_MODEL_DECISION_CONTRACT.md)** — draft owner-review contract for M-1..M-9, provenance, hard-veto behavior, and implementation choices in schema 1.14.0.
- **[FLAG_RECOMMENDATION_REVIEW_SHEET.md](./FLAG_RECOMMENDATION_REVIEW_SHEET.md)** — representative GOOD/WATCH/BAD/DATA_UNAVAILABLE outputs, fixture coverage, manual GPT update checklist, and unresolved interpretations.
- **[PLAN_FLAG_DETECTION_COVERAGE.md](./PLAN_FLAG_DETECTION_COVERAGE.md)** — F1, flag detection coverage (done 2026-09-23, schema 1.12.0): proto/expired states, EMA21 reclaim, failed/expired TTL visibility, stable candidate identity, cheap geometry fields, `qual` trade qualification. Fixes `test/fixtures/misses/MISS_003.json`.
- **[PLAN_CALL_TRACKER.md](./PLAN_CALL_TRACKER.md)** — T1, call tracker (built 2026-09-23): every flag plan and 21/200 recommendation captured every 10 min from `/api/scalp-context`, scored on stored 1m candles, one review page; lives in `Bai-ee/edittrades-tracker`, scripts in `scripts/tracker/`.
- **[PLAN_SERVED_CALLS.md](./PLAN_SERVED_CALLS.md)** — T3, served calls (built 2026-09-24): every call the GPT is served through `GET /api/scalp-context` is recorded to Blob `served/` (1500 ms cap, response unchanged, `TRACK_SERVED_CALLS=false` kill switch) and scored by the tracker as `source: served`.
- **[PLAN_TRADE_JOURNAL.md](./PLAN_TRADE_JOURNAL.md)** — T2, trade journal (built 2026-09-24, not deployed): `POST`/`GET /api/journal` (bearer `JOURNAL_API_KEY`, Vercel Blob), GPT commands `log <text>` / `journal`, tracker pulls it into "your trades" beside the engine's calls.
- **[PLAN_TELEGRAM.md](./PLAN_TELEGRAM.md)** — T-1, Telegram alerts + read commands (built 2026-09-24, not deployed): `POST /api/telegram-webhook` (secret header + owner allowlist), `GET /api/telegram-cron` every minute (`CRON_SECRET`), alert state in Blob `telegram/state.json`, `/log` through the journal's append path. Read-only; never execution.
- **[PLAN_ALERT_CLARITY.md](./PLAN_ALERT_CLARITY.md)** — Alert clarity Phase A (built 2026-09-25, deployed 2026-09-26, schema 1.27.0): `flagRecommendation.clarity` (gate / killIf / otherSide in the default payload; context in words in the full record); Telegram WATCH/TRIGGERING verdicts never say BE READY on a flag that cannot pass the plan gates (rr/room WAIT, chase STAND DOWN); GPT prints gate text, Kill if, Other side. Presentation only. Phase B (probe counts, defended extreme, `failed_breakdown`) is a separate thread.
- **[AGENT_SESSION_RULES.md](./AGENT_SESSION_RULES.md)** — rules for every agent session while live trading is on (no orders, no deploys, no env, stage by name, worktrees for shared files).
- **[PLAN_LIVE_PERPS_TEST.md](./PLAN_LIVE_PERPS_TEST.md)** — T-3 F: live Jupiter perps flow (transaction landing, keeper-fill two-phase open, executor wiring, timeout budget) and the tiny-cap live test protocol T1–T5; T1–T4 passed on real trades 2026-09-26, owner runbook at the end.
- **[FREQUENCY_STUDY_2026-09-26.md](./FREQUENCY_STUDY_2026-09-26.md)** — research only: GOOD-call frequency vs expectancy for relaxed rule variants over 85 days (all net-negative; retest-hold off is the only route to 10/day and the worst).
- **[COST_GATE_STUDY_2026-09-26.md](./COST_GATE_STUDY_2026-09-26.md)** — research only: min-stop / cost-to-risk gates over L0, L1b, V6 (85 days); only V6 with stop ≥ 0.8% passes the split (n=45, longs only); 2026-09-27 addendum re-scores longs at a leverage-aware Jupiter cost.
- **[RISK_SIZING_STUDY_2026-09-26.md](./RISK_SIZING_STUDY_2026-09-26.md)** — research only: `scripts/research/risk-sim.js` drawdown/streak simulator (risk %, daily cap, pause, kill switch); sizing cannot fix negative edge, 0.5% per trade keeps p95 DD near 15%.
- **[CONDITIONS_STUDY_2026-09-26.md](./CONDITIONS_STUDY_2026-09-26.md)** — research only: which subset of the live rules' GOOD calls has positive net expectancy, by selection field; 95% of GOOD calls carry a stop under 0.5% of entry, the dominant driver of net loss.
- **[EXITS_STUDY_2026-09-26.md](./EXITS_STUDY_2026-09-26.md)** — research only: six exit-management variants re-walked on the same 881 live-rule signals; a +1R trailing stop is the only one that flips net R positive on both OOS halves - the evidence behind T-15.
- **[VARIANTS_STUDY_2026-09-26.md](./VARIANTS_STUDY_2026-09-26.md)** — research only: 15 rule-variant hypotheses tested side by side on the live flag calls; NF-live + a 1R trailing stop is the only one that turns median net R positive on both halves (61% win rate) - shipped as T-15.
- **[SWING_STUDY_2026-09-26.md](./SWING_STUDY_2026-09-26.md)** — research only: nine swing-timeframe rule modules (`scripts/swing/`) on 85 days; none shows a usable edge, and the flag/1D SWING strategy is confirmed dead code in production.
- **[MEANREV_STUDY_2026-09-26.md](./MEANREV_STUDY_2026-09-26.md)** — research only: mean-reversion-at-zones rule family; none of three variants clears net-positive in both OOS halves or beats a random control.
- **[HISTORY_2Y_2026-09-26.md](./HISTORY_2Y_2026-09-26.md)** — research only: the `deep2y-2026-09-26` 2-year 1-minute fixture (build, validation, and its coverage limits); a corrected ~522-day rerun of the live rules reaches the same net-negative conclusion as the 85-day study.
- **[RETEST_ENTRY_STUDY_2026-09-27.md](./RETEST_ENTRY_STUDY_2026-09-27.md)** — research only (S3): retest-of-breakout entries with an NF-floored stop and a structure exit, tested on 2 years of data; every rule, including its random control, is net-median-negative in both OOS halves.
- **[PREDICTION_STUDY_2026-09-28.md](./PREDICTION_STUDY_2026-09-28.md)** — T-24 replay of the next-candle over/under rule (pred-1) over 2 years, 3 symbols × 4 timeframes: 48.2% vs coin flip 50.0% and same-as-last 48.5%; no edge, tracked live anyway.
- **[PROMPT_T24_PREDICTION_TRACKER.md](./PROMPT_T24_PREDICTION_TRACKER.md)** — T-24 build prompt and shared row contract (PREDICTION / PREDICTION_RESULT, aggregate shape).
- **[ELEVATIONS_2026-09-28.md](./ELEVATIONS_2026-09-28.md)** — owner elevation list: E1 price provenance, E2 tracker chat, E3 prediction tracker (shipped), E4 live numbers.
- **[HTF_ENTRY_STUDY_2026-09-27.md](./HTF_ENTRY_STUDY_2026-09-27.md)** — T-20 replay, numbers only, no recommendation: HTF-anchored entries (4h+1D direction, 1m/5m trigger, 1h swing stop/target) on 2 years of data, plus a random-direction control and a 15m-structure-stop control. Unlike the RETEST_ENTRY_STUDY above, this one does not gate the release - the owner shipped the rule live in the same phase (`docs/OWNER_DECISIONS_2026-09-27.md` "T-20").
- **[EDGE_SEARCH_2026-09-27.md](./EDGE_SEARCH_2026-09-27.md)** — research only: 76 perps rule configs on 2-year data, none net-positive (borrow + costs, near-zero gross edge); **found: spot daily EMA20 trend filter** (long or cash), out of sample 2017–2024 beats buy & hold on all three coins, portfolio Sharpe 1.39 vs 0.92, max DD 56% vs 88% (37% with a 40% vol target).
- **[research/RESEARCH_BACKLOG.md](./research/RESEARCH_BACKLOG.md)** — parked research bucket: one card per strategy study (verdict, what exists, work items, open questions); nothing approved. Card 1: **[research/EXTERNAL_4H_SMA200_STATUS.md](./research/EXTERNAL_4H_SMA200_STATUS.md)** — 4H SMA200 long/flat, PAPER CANDIDATE spot only, REJECT perps, ~90% overlap with daily EMA20. Card 2: Quattro (parked). Card 3: **[research/EXTERNAL_HARNESS_REFERENCES.md](./research/EXTERNAL_HARNESS_REFERENCES.md)** — verified review of Jesse/Freqtrade/Nautilus/CCXT/Hummingbot/FinRL/ai-hedge-fund/Eliza; 8 borrowable validation concepts, prioritized, none approved. Card 6: **[research/BREAKEVEN_COSTS_2026-09-27.md](./research/BREAKEVEN_COSTS_2026-09-27.md)** — break-even cost for 79 studied strategies + spot trend rules; Jupiter borrow (not fees) kills every slower perps edge; `re-flag-retest-1h` is the one short-hold survivor. Card 7: owner-supplied strategy-repo report reviewed; slow-trend candidates (Quattro, Trend Atlas) spot/low-carry only; day/night and PeterLP z-buffer dropped on evidence. Card 8: **[research/EDGE_EVIDENCE_SUMMARY_2026-09-27.md](./research/EDGE_EVIDENCE_SUMMARY_2026-09-27.md)** — WP1–WP11 build results (harness: causality, warm-up, significance, matched controls, Monte Carlo, trial ledger, venues/funding, measured Jupiter borrow ≈0.0015%/h, spot vs DCA, Quattro, MACD/OBV, tracker evidence); leads SLOW_SMA840_4H_V1 (spot) and re-flag-retest-1h (perps).
- **[PLAN_SPOT_TREND_2026-09-27.md](./PLAN_SPOT_TREND_2026-09-27.md)** — plan only: paper-track the daily EMA20 spot trend filter in the tracker (signal, ledger, parity test, flip alerts, `spot.html`); no engine/Telegram/executor change; execution is a later, separate plan.
- **[PLAN_RISK_GUARDRAILS_2026-09-27.md](./PLAN_RISK_GUARDRAILS_2026-09-27.md)** — plan only: G1 execution policy (steady 0.5%, peak-drawdown kill switch), G2 engine min stop 0.1% after the freeze (branch risk-guardrails-g2); G3 dropped (2-year re-run: shorts not a loser, long edge did not repeat).
- **[OWNER_DECISIONS_2026-09-27.md](./OWNER_DECISIONS_2026-09-27.md)** — T-15 (worktree `nf-live`, not yet deployed, schema 1.28.0 / configVersion 2026.09.27-1): the rule freeze lifted for exactly this change - the T-13 net floor (`flagPlan.stopFloor`) goes live in `lib/flagTradePlan.js`, plus a new PIN-less, tighten-only executor write `trailStops` for an automatic +1R trailing stop. Also T-18 (retest-1h ships paper) and T-20 (worktree `htf-entry`, not yet merged, schema 1.29.0 / configVersion 2026.09.27-3: HTF-anchored entries ship live-capable without a prior study, replay attached; three flagged decision points on the DIRECTION chart's entry stand-in, the replay's structure-exit approximation, and the ENTRY card's display-only tier/risk).
- **[PLAN_TELEGRAM_EXECUTION.md](./PLAN_TELEGRAM_EXECUTION.md)** — T-3, place and manage Jupiter perp trades from Telegram (live since 2026-09-26): executor contract, gates/caps/kill switch, risk policy (T-8), wallet strategy profiles (T-9 v2), automatic +1R trailing stop (T-15).
- **[GAP_CHECK_2026-09-26.md](./GAP_CHECK_2026-09-26.md)** — why the tracker counted ~1.3 GOOD/day while replay shows ~10: 10-minute capture cadence vs 2–5 minute GOOD windows; led to T-12 (1-minute alert-log scoring).
- **[CODEBASE_AUDIT_2026-09-26.md](./CODEBASE_AUDIT_2026-09-26.md)** — T-14 tidy-up audit: legacy API/services/lib, orphan tests, plan status, stale branches, deletions made, next-step list.
- **PROMPT_T*_AGENT_*.md / PROMPT_WRAPUP_MANAGER.md** — dispatch prompts for the agent phases T-3 D/F, T-7, T-8, T-9 v2, T-10–T-14 and the wrap-up manager; historical record of what each phase was asked to build.
- **[PLAN_PYTH_MARK_PRICE.md](./PLAN_PYTH_MARK_PRICE.md)** — P1, Pyth mark price beside the Kraken price (done 2026-09-23, schema 1.16.0, not deployed): `symbols.<SYM>.mark`, `decisionTrace.bias` `mark:` token, `lib/pythMark.js`.
- **[PLAN_FLAG_PATHS.md](./PLAN_FLAG_PATHS.md)** — T4 plan: measured scenario weights (retest_go / runner / false_break / fail_first / chop) at the moment a flag tightens; P0 done, P1–P4 not approved.
- **[MASTER_PLAN_T6_FEE_AWARE_FLAGS.md](./MASTER_PLAN_T6_FEE_AWARE_FLAGS.md)** — T6 master plan (current workstream): fee-aware stops/targets and net gate, swing horizon from lower-timeframe flags, four-layer state model, `?track=`, FAILED_FLAG_REVERSAL scouts, GPT rewrite, 60-day recalibration. Phase 0: **[GOOD_QUALITY_REPLAY.md](./GOOD_QUALITY_REPLAY.md)**. Phase 1 code shipped 2026-09-24 (owner decision D1, variant V1c): `flagPlan.minNetRR` 2.0, schema 1.21.0, configVersion 2026.09.24-3 - committed and pushed, **not yet deployed** (Vercel daily deploy cap).
- **[BREAKOUT_ENTRY_SHADOW.md](./BREAKOUT_ENTRY_SHADOW.md)** — T4 P4 shadow breakout-close entry: replay results vs the retest entry (net negative after fees; not promoted), live shadow tracking in the tracker.
- **[FLAG_PATHS_BASE_RATES.md](./FLAG_PATHS_BASE_RATES.md)** — T4 P0, flag-path base rates (provisional, measure-only, dev-only): `scripts/replay-paths.js` + `scripts/tracker/flag-paths.js`, path mix and feature base rates from replayed history, no production change.
- **[PLAN_DIVERGENCE_OPPORTUNITIES.md](./PLAN_DIVERGENCE_OPPORTUNITIES.md)** — T5 plan: does divergence at a level give an early-entry edge; P0 (measure-only) done, P1–P3 not approved. Results: **[DIVERGENCE_OPPORTUNITIES_BASE_RATES.md](./DIVERGENCE_OPPORTUNITIES_BASE_RATES.md)** (provisional, measure-only, dev-only): `scripts/replay-early-entry.js` + the new `featuresAt` fields (`divergence`/`atLevel`/`sweepReclaim`/`counterTrend`), early-vs-retest entry net expectancy, no production change.

### API and connector
- **[EDITTRADES_MCP_CONNECTOR.md](./EDITTRADES_MCP_CONNECTOR.md)** — MCP tool and REST parity, payload controls, payload schema 1.8.0 map, scalp stop guard, security boundary, env, prod verification, test suites.
- **[../openapi/scalp-context.yaml](../openapi/scalp-context.yaml)** — field-level schema for the REST Action (source of truth for payload fields).
- **[../CHATGPT_ACTION_SETUP.md](../CHATGPT_ACTION_SETUP.md)** — Custom GPT Action setup, query parameters, wallet `account` block.
- **[GPT_INSTRUCTIONS.md](./GPT_INSTRUCTIONS.md)** — Custom GPT Instructions-box source of truth (Phase 11): fenced instruction text, payload field → instruction rule table, GPT test sheet, change log. `npm run check:gpt` gates its length.

### Engine
- **[SIGNAL_GENERATION_SPECIFICATION.md](./SIGNAL_GENERATION_SPECIFICATION.md)** — strategy engine (`services/strategy.js`): priority, stops, R:R, scalp stop policy. Stops/targets updated 2026-09-22; gatekeeper and confidence sections from Dec 2025.
- **[RULE_OWNER_MATRIX.md](./RULE_OWNER_MATRIX.md)** — Phase 0 rule-to-owner matrix and baseline measurements, with a status note.
- **[../config/engine.json](../config/engine.json)** — tunable constants; bump `configVersion` on any change (`npm run test:config`).

### Code map (scalp-context path)

| Concern | File |
| --- | --- |
| Payload builder, `filterPayload` | `services/scalpContext.js` |
| Strategies, scalp stop policy | `services/strategy.js` |
| Config | `config/engine.json`, `config/engine.js` |
| Risk (leverage, loss at stop) | `lib/riskEngine.js` |
| Flag detector (`candidateSetups`) | `lib/patternDetector.js` |
| Flag lifecycle (geometry snap, coils, visual gate, stable identity F1) | `lib/patternLifecycle.js` |
| Trade qualification (`qual`, F1) | `lib/candidateQualifier.js` |
| Data-freshness gate (signal-reliability minimum plan) | `lib/freshness.js` |
| Flag trade plan (`flagTradePlan`, signal-reliability minimum plan) | `lib/flagTradePlan.js` |
| 21/200 model evidence (`include=model`) | `lib/modelEvidence.js` |
| 21/200 recommendation (`flagRecommendation`, `clarity`) | `lib/flagRecommendation.js` |
| Tracked-trade story (Telegram TRACK lines) | `lib/trackStory.js` |
| Recommendation acceptance fixtures (Phase 2, `test:flagrec:fixtures`) | `test-flag-recommendation-fixtures.js` |
| Geometry (zones, ATR, diagonals, channel, confluence) | `lib/geometry.js` |
| Structure | `lib/structure.js`, `lib/candleFeatures.js` |
| Indicators | `services/indicators.js` |
| Wallet (read-only) | `services/walletTracker.js` |
| Pyth mark (`mark`, P1, read-only) | `lib/pythMark.js` |
| MCP | `services/editTradesMcp.js`, `lib/mcpHttp.js` |
| HTTP entry | `api/scalp-context.js` (REST, MCP via `__mcp=1`) |
| Chart render (Phase 8b, in progress) | `lib/chartRender.js` |
| Bias matrix, alignment, decision inputs (Phase 9b) | `lib/biasMatrix.js` |
| Top-down sentiment, above/below-200 (trading-model quick pass Q3) | `lib/topDown.js` |
| Replay harness + metrics (Phase 10, dev only) | `scripts/replay.js`, `scripts/replay-metrics.js` |
| Replay outcome scoring (trading-model quick pass Q4, dev only) | `scripts/replay-outcomes.js` |
| GPT instruction length gate (Phase 11, dev only) | `scripts/check-gpt-instructions.js` |
| Forward-paper ledger (signal-reliability minimum plan, dev only, local file) | `scripts/paper-ledger.js` |
| Call tracker (T1, runs in the separate private repo `Bai-ee/edittrades-tracker` via GitHub Actions; synced with `npm run tracker:sync`) | `scripts/tracker/` (`collect.js`, `store.js`, `score.js`, `aggregate.js`, `build-page.js`, vendored `walk-outcome.js`, `sync.js`, `repo-template/`) |
| Trade journal (T2, REST only, never MCP) | `api/journal.js`, `lib/journalSchema.js`, `lib/blobJsonl.js` (shared Blob JSONL helpers) |
| Telegram bot (T-1, never MCP, never execution) | `api/telegram-webhook.js`, `api/telegram-cron.js`, `lib/telegram.js`, `lib/telegramLog.js` (sent-alert + transition logs) |
| Served calls (T3, REST side effect, never MCP) | `lib/servedCalls.js`, `lib/blobJsonl.js`, `scripts/tracker/records.js` (shared tracker row builder + strip) |
| Architecture map (source of the tracker's system map page `changelog.html`; `npm run test:archmap` keeps it in step with the code) | `docs/ARCHITECTURE_MAP.json`, `test-architecture-map.js`, `scripts/tracker/changelog-page.js`, `scripts/tracker/build-changelog.js` |
| Miss log (schema + one JSON per miss) | `test/fixtures/misses/README.md` |

Unreachable from `buildScalpContext()` and not to be revived without a recorded decision: `lib/signalEngine.js`, `lib/advancedChartAnalysis.js`, `lib/levels.js`. (`services/strategy-refactored.js` removed 2026-09-26, zero importers anywhere. `lib/chartAnalysis.js` removed from this list 2026-09-26 — it's actually reachable via `services/indicators.js`, imported by the live `lib/geometry.js`/`lib/topDown.js`.)

### Tests

`test:sltp` (50), `test:scalp` (117), `test:mcp` (52), `test:wallet` (28) are the deploy gate. `test:config` (14), `test:risk` (24), `test:pattern` (32), `test:geometry` (36), `test:chart` (18), `test:replay` (36), `test:bias` (15), `test:topdown` (15), `test:freshness` (10), `test:flagplan` (42), `test:flagrec` (17), `test:ledger` (12), `test:evidence` (8, `test-model-evidence.js`: Stoch offset, divergence selection/staleness, channel breakoutRisk), `test:mark` (12, `test-pyth-mark.js`: mock Hermes, one request, no key → no request, failures → unavailable, drift sign, stale), `test:replay` (41 after T4 backfill resume/derive), `test:tracker` (52, `test-tracker.js`: call tracker strip/dedupe/candles/scorer/aggregates/page/charts, T2 journal pull/score/page, T3 served pull/scoring/page, T4 paths step), `test:paths` (22, `test-flag-paths.js`: path labeller + features), `test:replay-paths` (19, `test-replay-paths.js`), `test:served` (19, `test-served.js`: served-call recorder and REST hook), `test:journal` (17, `test-journal.js`: journal schema, auth, method gate, body cap, rate limit, idempotency, GET ordering, MCP isolation), `test:telegram` (32, `test-telegram.js`: T-1 Telegram formatters, alert transitions, webhook/cron gates, `/log` through the journal path, no execution import) cover the engine modules; `test:archmap` (10, `test-architecture-map.js`: architecture map covers every file, schemaVersion has a CHANGELOG entry, test names exist); `npm run check:gpt` gates the GPT instruction length separately. Counts as of 2026-09-24 (T2 trade journal; `test:pattern` 33, `test:flagplan` 43, `test:flagrec` 18 on this run).

---

## Legacy (Nov–Dec 2025, not re-audited)

Each file below starts with a "Legacy" banner. Use for background on the dashboard and older endpoints only.

**Architecture and data (dashboard / `/api/analyze*` path):** [SYSTEM_CONTEXT.md](./SYSTEM_CONTEXT.md), [SYSTEM_WORKFLOW.md](./SYSTEM_WORKFLOW.md), [DATA_PIPELINE_ARCHITECTURE.md](./DATA_PIPELINE_ARCHITECTURE.md), [COMPLETE_DATA_REFERENCE.md](./COMPLETE_DATA_REFERENCE.md), [MARKETDATA_MODULE.md](./MARKETDATA_MODULE.md), [technical-data-requirements.md](./technical-data-requirements.md), [INTEGRATION_CONFIRMATION.md](./INTEGRATION_CONFIRMATION.md), [THIRD_PARTY_DOCUMENTATION_PACKAGE.md](./THIRD_PARTY_DOCUMENTATION_PACKAGE.md), [prd.txt](./prd.txt)

**Strategy and indicator guides:** [STRATEGY_IMPLEMENTATION_GUIDE.md](./STRATEGY_IMPLEMENTATION_GUIDE.md), [STRATEGY_INTEGRATION_GUIDE.md](./STRATEGY_INTEGRATION_GUIDE.md), [STRATEGY_MODES.md](./STRATEGY_MODES.md), [STRATEGY_SYSTEM_AUDIT.md](./STRATEGY_SYSTEM_AUDIT.md), [ADDING_STRATEGIES.md](./ADDING_STRATEGIES.md), [ADDING_INDICATORS.md](./ADDING_INDICATORS.md), [INDICATOR_ARCHITECTURE.md](./INDICATOR_ARCHITECTURE.md), [INDICATOR_REFERENCE.md](./INDICATOR_REFERENCE.md), [INDICATOR_DOCUMENTATION_INDEX.md](./INDICATOR_DOCUMENTATION_INDEX.md), [INDICATOR_INTEGRATION_CHECKLIST.md](./INDICATOR_INTEGRATION_CHECKLIST.md), [MODULE_DEVELOPMENT_GUIDE.md](./MODULE_DEVELOPMENT_GUIDE.md), [DEVELOPMENT_PROCEDURE.md](./DEVELOPMENT_PROCEDURE.md), [BACKTEST_GUIDE.md](./BACKTEST_GUIDE.md), [templates/](./templates/)

**Chart analysis (dashboard):** [CHART_ANALYSIS_GUIDE.md](./CHART_ANALYSIS_GUIDE.md), [CHART_ANALYSIS_DATA_POINTS.md](./CHART_ANALYSIS_DATA_POINTS.md), [FRONTEND_CHART_ANALYSIS_SUMMARY.md](./FRONTEND_CHART_ANALYSIS_SUMMARY.md)

**AI agent:** [AI_SYSTEM_DOCUMENTATION.md](./AI_SYSTEM_DOCUMENTATION.md)

**Trading execution, Jupiter, perps (execution is off by default; never reachable from MCP):** [JUPITER_TRADING_INTEGRATION.md](./JUPITER_TRADING_INTEGRATION.md), [JUPITER_SWAP_FIXES.md](./JUPITER_SWAP_FIXES.md), [SWAP_TECHNICAL_FLOW.md](./SWAP_TECHNICAL_FLOW.md), [SWAP_TROUBLESHOOTING.md](./SWAP_TROUBLESHOOTING.md), [JUPITER_PERPETUALS_INTEGRATION.md](./JUPITER_PERPETUALS_INTEGRATION.md), [JUPITER_PERPETUALS_RESEARCH.md](./JUPITER_PERPETUALS_RESEARCH.md), [JUPITER_PERPS_INTEGRATION_STATUS.md](./JUPITER_PERPS_INTEGRATION_STATUS.md), [JUPITER_PERPS_WORKAROUND.md](./JUPITER_PERPS_WORKAROUND.md), [PERPS_IMPLEMENTATION_STATUS.md](./PERPS_IMPLEMENTATION_STATUS.md), [PERPS_IMPLEMENTATION_SUCCESS.md](./PERPS_IMPLEMENTATION_SUCCESS.md), [PERPS_TRADING_STATUS.md](./PERPS_TRADING_STATUS.md), [PERPS_TRANSACTION_BUILDING_RESEARCH.md](./PERPS_TRANSACTION_BUILDING_RESEARCH.md), [PERPS_ALTERNATIVES_RESEARCH.md](./PERPS_ALTERNATIVES_RESEARCH.md), [PERPS_PDA_RESOLUTION.md](./PERPS_PDA_RESOLUTION.md), [POSITION_REQUEST_PDA_ISSUE.md](./POSITION_REQUEST_PDA_ISSUE.md), [POSITION_REQUEST_PDA_RESOLVED.md](./POSITION_REQUEST_PDA_RESOLVED.md), [POSITION_REQUEST_FINAL_APPROACH.md](./POSITION_REQUEST_FINAL_APPROACH.md), [PROVIDER_INTEGRATION.md](./PROVIDER_INTEGRATION.md), [SIGNER_ADAPTER_FIX.md](./SIGNER_ADAPTER_FIX.md), [CUSTODY_LIMIT_HANDLING.md](./CUSTODY_LIMIT_HANDLING.md), [CUSTODY_LIMIT_RESOURCES.md](./CUSTODY_LIMIT_RESOURCES.md), [MARKET_CAPACITY_ANALYSIS.md](./MARKET_CAPACITY_ANALYSIS.md), [USDT_COLLATERAL_SUCCESS.md](./USDT_COLLATERAL_SUCCESS.md), [FUNDING_WALLET_USDC.md](./FUNDING_WALLET_USDC.md), [SOLANA_WALLET_SETUP.md](./SOLANA_WALLET_SETUP.md), [VERCEL_TRADING_ENV_SETUP.md](./VERCEL_TRADING_ENV_SETUP.md), [PRODUCTION_TRADE_EXECUTION_FIX.md](./PRODUCTION_TRADE_EXECUTION_FIX.md), [RPC_OPTIMIZATION.md](./RPC_OPTIMIZATION.md)

**Troubleshooting:** [TROUBLESHOOTING_GUIDE.md](./TROUBLESHOOTING_GUIDE.md)

**Old indexes:** [README.md](./README.md) (docs index, Dec 2025), [archive/](./archive/) (superseded strategy notes)

**Repo root, Nov–Dec 2025 work notes and guides:** `README.md` (project README; top section current, rest legacy), `CHANGELOG.md` (2026 entry current), and the remaining root `*.md` files (`AI_*`, `API_QUICK_REFERENCE`, `COMPACT_SCHEMA`, `DEPLOYMENT*`, `QUICKSTART`, `START_HERE`, `VERCEL_*`, fix and summary notes). They record one-off changes from that period.

**Scratch files with no content value:** `docs/3asdfasdf.txt`, `docs/asdfasdfasdfasdfasdfasdf.txt`, `docs/mbkjUntitled 3.txt` — candidates for deletion.

---

## Keeping this current

After each engine phase: update the phase map in the master plan, the schema map and test table in `EDITTRADES_MCP_CONNECTOR.md`, `openapi/scalp-context.yaml`, and this index if a doc or module is added.
