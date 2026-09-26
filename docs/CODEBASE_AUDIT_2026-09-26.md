# Codebase audit — 2026-09-26 (Agent K, T-14, tidy-up worktree)

Read-only audit for the owner's "tidy things up" request. Part A2 (safe deletions) is a
separate commit from this report. All findings below were grep/read-verified in this
worktree, not assumed from docs.

**Test run before/after A2**: ran every registered `test:*` script (32 total). Three
pre-existing failures, none caused by A2's deletions (verified against a clean `HEAD`
checkout before making any edit): `test:scalp` ("review fix 6a" — a `flagRecommendation`
shape assertion, unrelated to anything touched here; likely mid-flight from the concurrent
volume-context/schema-1.26 session per `docs/AGENT_SESSION_RULES.md`'s queue), `test:rules`
(fixture `test/fixtures/history/deep-2026-09-24` missing — gitignored local data this fresh
worktree never generated, not a code bug), and `test:archmap` ("every covered file appears
exactly once" — already failing on clean `HEAD` at 99 files before any edit here; after A2's
two deletions it's 97 files, same pre-existing failure, unrelated delta only). Everything
else: green. The committed `docs/ARCHITECTURE_MAP.verify.json` will show `"ok": false` after
this commit because of that last pre-existing bug, not because of anything in this task.

## 1. Half-built / legacy code

Current product path: `api/scalp-context.js`, `api/mcp` rewrite (→ `scalp-context.js`),
`api/journal.js`, `api/telegram-webhook.js`, `api/telegram-cron.js`, `api/health.js`,
`api/execute-trade.js` (gated, live-adjacent — see note), `lib/execution/*`,
`services/jupiterPerps.js`, `services/walletTracker.js`, `services/walletManager.js`.

### `api/*.js`

| File | Does | Imports (services/lib) | Routed? | Recommendation |
| --- | --- | --- | --- | --- |
| `analyze.js` | Full legacy multi-indicator analysis endpoint | marketData, indicators, strategy, candleFeatures, levels, advancedIndicators, volumeAnalysis, confluenceScoring, momentumAlignment | yes (`/api/analyze/(.*)`) | Archive — superseded by scalp-context; delete the route in the same commit as the file |
| `analyze-compact.js` | Compact variant | marketData, indicators, strategy | yes | Archive, same reasoning |
| `analyze-full.js` | Analysis + old signal engine + trade readiness | marketData, indicators, strategy, advancedChartAnalysis, dataValidation, signalEngine, tradeReadiness | yes | Archive |
| `indicators.js` | Raw indicator dump | marketData, indicators, candleFeatures, levels, advancedIndicators, volumeAnalysis, confluenceScoring | yes | Archive |
| `scan.js` | Multi-symbol scanner | services/scanner.js | yes | Archive — scanner.js has no other caller |
| `agent-review.js` | ChatGPT trade-reasoning agent, self-contained (845 lines, no shared imports) | none | yes | Archive as a unit |
| `parse-trade-image.js` | OpenAI Vision image→trade parser, self-contained | none | yes | Archive |
| `review-trade.js` | Post-trade review endpoint, self-contained | none | **no route** | **Delete — Part A2** |
| `trade-status.js` | — | — | routed to `/api/trade-status.js`, **file does not exist** | Bonus finding: dead route, 404s today. Not deleted here (route-table edit is out of this task's scope) — flagged below |
| `execute-trade.js` | Gated legacy execution (`TRADE_EXECUTION_ENABLED`), dynamic-imports `tradeExecution.js` + `positionManager.js` | crypto + dynamic imports | yes | **Keep (hard rule)**. Confirms it is a *second, separate* execution stack from the live Telegram path (`lib/execution/executor.js` + `jupiterPerps.js`) — legacy, not the live order path, but never delete it |

### `services/`

| Module | Live-path importer? | Recommendation |
| --- | --- | --- |
| `positionManager.js` | only `api/execute-trade.js` + tests | Archive with execute-trade's legacy stack |
| `tradeExecution.js` | only `api/execute-trade.js`, `positionManager.js` + tests | Archive |
| `perpsProvider.js` | only `tradeExecution.js` + tests | Archive |
| `driftPerps.js` | only `perpsProvider.js` + tests | Archive |
| `mangoPerps.js` | only `perpsProvider.js` + tests | Archive |
| `jupiterSwap.js` | only `tradeExecution.js`, `server.js` + tests | Archive (server.js is also legacy-but-wired, see note) |
| `tokenMapping.js` | only `tradeExecution.js` + tests | Archive |
| `jup-perps-wrapper.cjs` | **no live importer** — `services/jupiterPerps.js:20` comment confirms it replaced this file's `require('jup-perps-client')` with an ESM import on 2026-09-25 (the old file did `require`, breaking on Vercel) | **Keep, not a safe deletion** — still imported by `test-execution.js:14` and `test-jupiter-perps.js:20`, both registered npm scripts (`test:execution`, `test:jupiter`). Deleting it breaks the deploy-gate test run |
| `scanner.js` | only `api/scan.js`, `server.js` | Archive |
| `indicators.js` | **live** — imported by `lib/geometry.js` and `lib/topDown.js`, both imported by `services/scalpContext.js` (the live payload builder), in addition to the legacy `api/analyze*.js`/`api/indicators.js` | **Keep — on the live path**, contrary to an initial pass assuming it was analyze*-only |
| `binance.js`, `coingecko.js`, `dflow.js` | yes — all feed `services/marketData.js`, imported by `scalpContext.js` | **Keep** |
| `marketData.js`, `strategy.js` | yes — imported directly by `scalpContext.js` | **Keep** |
| `strategy-refactored.js` | **zero importers anywhere in the repo** (verified: no hits outside itself) | **Delete — Part A2** |

### `lib/`

| Module | Importers | Recommendation |
| --- | --- | --- |
| `advancedChartAnalysis.js` | `server.js`, `api/analyze-full.js` only | Archive with analyze-full |
| `advancedIndicators.js` | **live** — also imported by `lib/patternDetector.js`, `lib/geometry.js`, not just the analyze*/indicators legacy endpoints | **Keep — on the live path** |
| `chartAnalysis.js` | `services/indicators.js` only, which is itself live (see above) — `chartAnalysis.detectCandlestickPatterns`/`analyzeWickBodyRatios` run on every live payload | **Keep — transitively live**. Note: `docs/DOCUMENTATION_INDEX.md:79` currently lists this file as "unreachable from `buildScalpContext()`" — that line is factually wrong; corrected in the same commit as the Part A2 deletions since it's a one-line fix on a line already being edited for `strategy-refactored.js` |

**Scope note**: `server.js` (Express dev server, 1331 lines; `npm start`/`npm run dev` still
point at it) is not part of the Vercel prod build (`vercel.json` only builds `api/**` +
`public/**`) but is a live local-dev entry point importing several of the legacy services
above. Flagged as "legacy but still wired to package.json scripts," not a safe delete.

**Dead route (bonus finding, not fixed here)**: `vercel.json` routes `/api/trade-status/(.*)`
to `api/trade-status.js`, which does not exist in this checkout — a standing 404, not
introduced by this audit. Left alone since editing `vercel.json` wasn't in this task's
authorized scope; worth a follow-up.

### TODOs

- `services/tokenMapping.js:17` — `// TODO: Verify actual WBTC token address on Solana mainnet` — moot if `tokenMapping.js` is archived with the legacy execution stack.
- `services/tokenMapping.js:22` — `// TODO: Verify actual WETH token address on Solana mainnet` — same.
- `services/jupiterPerps.js:841` — `// TODO(T-3 E follow-up, owner 2026-09-25): SL/TP trigger requests ride in the same tx as the increase, before the keeper has filled the position; likely an ordering bug, fix in a later phase.` — **live-path, real open item**.
- `services/jupiterPerps.js:1505` — `// TODO: Query position from on-chain program` — **live-path, real open item**.

## 2. Orphan tests

Cross-checked every root `test-*.js` file (51 total) against every `test:*` npm script (31
mapped). The orphan set matches the master prompt's known list exactly, plus none found
beyond it:

`test-ai-agent.js`, `test-analyze-full.js`, `test-htfbias-tdz-fix.js`,
`test-jupiter-integration.js`, `test-market-capacity.js`, `test-open-perp-position.js`,
`test-perp-trade.js`, `test-perps-connection.js`, `test-perps-wrapper.js`,
`test-position-request-pda.js`, `test-position-request-seeds.js`,
`test-provider-integration.js`, `test-query-perpetuals.js`, `test-query-position-request.js`,
`test-reverse-engineer-pda.js`, `test-simple-transaction.js`, `test-strategy-override.js`,
`test-risk-policy.js`.

All 18 exercise the legacy Solana/Jupiter/perps integration surface (network- or
key-dependent: live RPC calls, on-chain PDA derivation, or a funded wallet) except
`test-risk-policy.js`, which is pure-math (`lib/execution/riskPolicy.js`) and just needs its
`test:riskpolicy` script line added — not a network/key test, keep-as-script once the
volume-context commit lands (per the master prompt, that's another session's call, not
touched here). The other 17: keep-as-script (they're real coverage of the legacy
execution/perps stack, useful if that stack is ever revived) rather than delete, since
deleting a test isn't "safe" in the same sense as deleting dead source — nothing forces
re-verifying it before the code path is reactivated. Recommendation: leave as-is; they cost
nothing sitting unregistered.

## 3. Plans

| Doc | Status | Remains | Worth doing |
| --- | --- | --- | --- |
| `MASTER_PLAN_ENGINE_REFINEMENT.md` | Phases 0–8, 8b live; 9, 9b, 10, 11 done locally, not deployed | deploy Phase 11 | yes — deploy is the only step left |
| `MASTER_PLAN_T6_FEE_AWARE_FLAGS.md` | Phase 0 done, Phase 1 shipped/deploy pending, rest gated on the `deep60-2026-09-24` capture completing | finish the 60-day capture, re-run replay, then Phases 2+ | yes, later — blocked on data capture, not code |
| `MASTER_PLAN_TRADING_MODEL.md` | plan only, no phase started | all of it | later — parent of `PLAN_TRADING_MODEL_QUICK_PASS.md` and `PLAN_FLAG_DETECTION_COVERAGE.md`, drives them, supersedes nothing |
| `PLAN_ALERT_CLARITY.md` | approved; Phase A merged to `main` 2026-09-26 | probe/defense telemetry section explicitly deferred "after the freeze" | later — freeze runs until 2026-10-08 |
| `PLAN_CALL_TRACKER.md` (T1) | built and live | flag-paths section it references is itself done | done, keep as reference |
| `PLAN_DIVERGENCE_OPPORTUNITIES.md` (T5) | P0 done: no early-entry combo net-positive after fees, so P1–P3 not approved | S2 60-day capture in progress elsewhere | drop P1–P3 unless the capture reverses the finding |
| `PLAN_FLAG_DETECTION_COVERAGE.md` (F1) | **doc says "plan only, not started" but F1 already shipped** (7119ab1, deployed, per `MASTER_PLAN_NEXT_STEPS.md`) — doc is stale | nothing — mark the doc done | fix the status line only, no code work |
| `PLAN_FLAG_PATHS.md` (T4) | P0–P4 done; P4 breakout-entry is shadow-only, replay says don't promote | nothing active | done, keep as reference; don't promote P4 without new replay evidence |
| `PLAN_GOOD_QUALITY.md` | **superseded** by `MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`; header says do not execute | Step C may run as research after 2026-10-01 | reference only |
| `PLAN_LIVE_PERPS_TEST.md` (T-3F) | code landed (F1–F6); live-test protocol not yet run on a real wallet | full live-test protocol, owner-gated | later — real money, not a code task |
| `PLAN_PYTH_MARK_PRICE.md` (P1) | unblocked, key supplied, done locally per its own status line | verify still live | check merged/deployed status; likely done |
| `PLAN_SERVED_CALLS.md` (T3) | built, phases 1–3 done | none | done |
| `PLAN_STRATEGY_DOCS_ALIGNMENT.md` | plan only, not started | full docs-alignment pass incl. Miss 004 | later — docs-only, no urgency vs. live feature work |
| `PLAN_T6_COMPLETION_V2.md` | reviewer-consolidated, overrides T6 sequencing | tracks the same 60-day capture gate as the T6 master plan | duplicate tracking — fold into the T6 doc once the capture completes |
| `PLAN_TELEGRAM_EXECUTION.md` (T-3) | plan; implementers already executing against it | live-flow pieces still marked open in the doc itself | in progress elsewhere, not this task |
| `PLAN_TELEGRAM.md` (T-1) | mostly built (focus mode, Open buttons, tests 90→128 per its own body) but the header still says "plan; implementer starts on the orchestrator's go" | update the Status line | doc-hygiene only |
| `PLAN_TRADE_JOURNAL.md` (T2 / 8c) | plan only, owner approval needed | deferred per `MASTER_PLAN_ENGINE_REFINEMENT.md` 8c | later — explicitly deferred |
| `PLAN_TRADING_MODEL_QUICK_PASS.md` | plan only, not started | Q1–Q5 | later — no urgency signal found |
| `PROMPT_T*_AGENT_*.md` (9 files) | dispatch records for worked/in-progress worktrees | none — historical | keep as history |

**Stale local branches** (git log verified, delete-candidates only, none deleted here):

| Branch | Last commit | Call |
| --- | --- | --- |
| `feature/jupiter-perps-integration` | 2025-12-05 | delete-candidate — 9+ months stale |
| `optimization` | 2025-11-29 | delete-candidate — 10 months stale |
| `restore-working-system` | 2025-12-08 ("Save current working state before signal engine upgrade") | delete-candidate — pre-upgrade safety snapshot, 9+ months stale |
| `map-board` | 2026-09-24 | **not stale** — 2 days old, keep |

**Worktrees**: all 7 sibling worktrees (`alert-clarity`, `frequency-study`, `gap-check`,
`net-floor`, `risk-policy`, `tracker-1min`, `upgrade-signal-engine`) show commits within the
last ~12 hours — every one active, none stale. This `tidy-up` worktree is the 8th.

## ⚠ Production finding: tracker workflow still runs the pre-rename shadow script

`CHANGELOG.md:132` records `scripts/tracker/vb-shadow.js` renamed to `v3-shadow.js` as a
completed rename. But `scripts/tracker/repo-template/.github/workflows/track.yml:47` was
never updated and still ran `node scripts/vb-shadow.js --data data` — and the **live**
tracker repo (`/Users/bballi/Documents/Repos/edittrades-tracker`) still has a stale leftover
`scripts/vb-shadow.js` sitting next to `scripts/v3-shadow.js` (sync only adds/overwrites
files, it never deletes one that's no longer in this repo). So the tracker's GitHub Action
has likely been scoring shadow variants with the **pre-rename logic**, not the current
`v3-shadow.js` pipeline `build-page.js` actually reads from — silently, since the stale file
still runs without erroring.

Fixed in this commit: `scripts/tracker/repo-template/.github/workflows/track.yml` now calls
`v3-shadow.js`. **Not fixed** (out of scope — "do not touch the tracker repo"): the stale
`vb-shadow.js` file already living in `edittrades-tracker/scripts/`. The next `npm run
tracker:sync` will push the corrected `track.yml`, but someone still needs to delete
`edittrades-tracker/scripts/vb-shadow.js` by hand (or a future sync should learn to remove
files no longer in the source tracker dir) for the fix to fully take effect. Flagging for the
orchestrator.

## 4. Forgot / beneficial next

- `docs/DOCUMENTATION_INDEX.md:79` lists `lib/chartAnalysis.js` as unreachable from `buildScalpContext()` — it's actually reachable via `lib/geometry.js`/`lib/topDown.js` → `services/indicators.js` (verified above). Fixed in the Part A2 commit since it's the same line being edited for `strategy-refactored.js`'s removal.
- `vercel.json` routes `/api/trade-status/(.*)` to a file that doesn't exist (`api/trade-status.js`) — a standing dead route, not fixed here (out of this task's authorized scope).
- `PLAN_FLAG_DETECTION_COVERAGE.md`'s status line is stale (says not started; F1 shipped) — cheap fix, prevents a future agent re-doing shipped work.
- `PLAN_TELEGRAM.md`'s header Status line hasn't caught up to its own body (focus mode / Open buttons described as built).
- `PLAN_T6_COMPLETION_V2.md` and `MASTER_PLAN_T6_FEE_AWARE_FLAGS.md` both gate on the same `deep60-2026-09-24` capture — worth merging into one tracking point.
- `package.json` has a dead script, `tracker:vb-shadow` → `scripts/tracker/vb-shadow.js`, which does not exist (the real file is `v3-shadow.js`) — removed in the Part A2 commit.
- Three branches (`feature/jupiter-perps-integration`, `optimization`, `restore-working-system`) are 9–10 months stale and pre-date the current engine architecture — safe deletion candidates, report only.
- No test or script currently catches a plan doc's status line drifting from the actual shipped state (this recurred twice in this scan: F1, focus mode) — a lightweight "grep the master plan for phases marked done vs. what a plan doc still calls unstarted" check would catch this class of drift cheaply, but that's a new tool, out of scope here.
