# Documentation Index

**Last updated:** 2026-09-23
**Branch:** `upgrade-signal-engine`
**Current product:** EditTrades scalp context — closed-candle BTC/SOL/ETH context, legacy strategy engine, and 21/200 flag recommendation, served to ChatGPT via REST Action (`GET /api/scalp-context`) and MCP (`POST /api/mcp`). Payload schema 1.8.0 live on Vercel; schema 1.14.0 local on this branch.

Docs are in two tiers. **Current** docs are maintained with the code. **Legacy** docs describe the Nov–Dec 2025 system (dashboard, `/api/analyze*`, scanner, AI agent, Jupiter swaps/perps) and carry a banner saying so. That code still exists, but those docs were not re-audited for the September 2026 engine work. When a legacy doc and a current doc disagree, the current doc and the code win.

---

## Current

### Start here
- **[../CLAUDE.md](../CLAUDE.md)** (local only, untracked) — project guide, hard rules, tests, deploy.
- **[MASTER_PLAN_ENGINE_REFINEMENT.md](./MASTER_PLAN_ENGINE_REFINEMENT.md)** — phased engine plan with status. Phases 0–8, 8b, 9, 9b, 10, 11 done; then 8c, 3b.
- **[MASTER_PLAN_TRADING_MODEL.md](./MASTER_PLAN_TRADING_MODEL.md)** — the owner's trading model (M-1..M-9) and the phased plan to build it (`FLAG_21`). **[PLAN_TRADING_MODEL_QUICK_PASS.md](./PLAN_TRADING_MODEL_QUICK_PASS.md)** — the Q1-Q5 quick pass (done 2026-09-23, schema 1.11.0) that pre-built parts of M1/M2/M2b/M4/M10.
- **[TRADING_MODEL_DECISION_CONTRACT.md](./TRADING_MODEL_DECISION_CONTRACT.md)** — draft owner-review contract for M-1..M-9, provenance, hard-veto behavior, and implementation choices in schema 1.14.0.
- **[FLAG_RECOMMENDATION_REVIEW_SHEET.md](./FLAG_RECOMMENDATION_REVIEW_SHEET.md)** — representative GOOD/WATCH/BAD/DATA_UNAVAILABLE outputs, fixture coverage, manual GPT update checklist, and unresolved interpretations.
- **[PLAN_FLAG_DETECTION_COVERAGE.md](./PLAN_FLAG_DETECTION_COVERAGE.md)** — F1, flag detection coverage (done 2026-09-23, schema 1.12.0): proto/expired states, EMA21 reclaim, failed/expired TTL visibility, stable candidate identity, cheap geometry fields, `qual` trade qualification. Fixes `test/fixtures/misses/MISS_003.json`.
- **[PLAN_CALL_TRACKER.md](./PLAN_CALL_TRACKER.md)** — T1, call tracker (built 2026-09-23): every flag plan and 21/200 recommendation captured every 10 min from `/api/scalp-context`, scored on stored 1m candles, one review page; lives in `Bai-ee/edittrades-tracker`, scripts in `scripts/tracker/`.
- **[PLAN_TRADE_JOURNAL.md](./PLAN_TRADE_JOURNAL.md)** — T2, trade journal (built 2026-09-24, not deployed): `POST`/`GET /api/journal` (bearer `JOURNAL_API_KEY`, Vercel Blob), GPT commands `log <text>` / `journal`, tracker pulls it into "your trades" beside the engine's calls.
- **[PLAN_PYTH_MARK_PRICE.md](./PLAN_PYTH_MARK_PRICE.md)** — P1, Pyth mark price beside the Kraken price (done 2026-09-23, schema 1.16.0, not deployed): `symbols.<SYM>.mark`, `decisionTrace.bias` `mark:` token, `lib/pythMark.js`.

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
| 21/200 recommendation (`flagRecommendation`) | `lib/flagRecommendation.js` |
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
| Trade journal (T2, REST only, never MCP) | `api/journal.js`, `lib/journalSchema.js` |
| Miss log (schema + one JSON per miss) | `test/fixtures/misses/README.md` |

Unreachable from `buildScalpContext()` and not to be revived without a recorded decision: `lib/signalEngine.js`, `services/strategy-refactored.js`, `lib/chartAnalysis.js`, `lib/advancedChartAnalysis.js`, `lib/levels.js`.

### Tests

`test:sltp` (50), `test:scalp` (117), `test:mcp` (52), `test:wallet` (28) are the deploy gate. `test:config` (14), `test:risk` (24), `test:pattern` (32), `test:geometry` (36), `test:chart` (18), `test:replay` (36), `test:bias` (15), `test:topdown` (15), `test:freshness` (10), `test:flagplan` (42), `test:flagrec` (17), `test:ledger` (12), `test:evidence` (8, `test-model-evidence.js`: Stoch offset, divergence selection/staleness, channel breakoutRisk), `test:mark` (12, `test-pyth-mark.js`: mock Hermes, one request, no key → no request, failures → unavailable, drift sign, stale), `test:tracker` (31, `test-tracker.js`: call tracker strip/dedupe/candles/scorer/aggregates/page/charts, T2 journal pull/score/page), `test:journal` (16, `test-journal.js`: journal schema, auth, method gate, body cap, rate limit, idempotency, GET ordering, MCP isolation) cover the engine modules; `npm run check:gpt` gates the GPT instruction length separately. Counts as of 2026-09-24 (T2 trade journal; `test:pattern` 33, `test:flagplan` 43, `test:flagrec` 18 on this run).

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
