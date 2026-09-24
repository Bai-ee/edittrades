# T6 — Fee-aware GOOD calls, higher-timeframe flags, state model, failed-flag reversals

Last updated: 2026-09-24
Status: plan approved by owner. Phases run in order.
- **Phase 0 done** (2026-09-24, no deploy): `docs/GOOD_QUALITY_REPLAY.md`. Recommended
  V1c (net gate 2.0); V1b as the volume-weighted alternative.
- **Phase 1 shipped** (2026-09-24, owner decision D1: variant V1c): `flagPlan.minNetRR`
  null → 2.0, `flag.timeframes` unchanged. Deployed and verified - see
  `docs/EDITTRADES_MCP_CONNECTOR.md`'s history table and "Verify after any redeploy".
- Phases 2–4 next, back to back; each is deployed and verified before the next.
- Phase 5 is conditional (≥ 7 days after Phase 1, i.e. from 2026-10-01).

Supersedes `docs/PLAN_GOOD_QUALITY.md` (its Steps A/B/C are Phases 0/1/5 here).
Branch: `upgrade-signal-engine`. Tracker repo: `../edittrades-tracker`.
Inputs: T4 (`docs/PLAN_FLAG_PATHS.md`, `docs/FLAG_PATHS_BASE_RATES.md`, `docs/BREAKOUT_ENTRY_SHADOW.md`), T5 (`docs/PLAN_DIVERGENCE_OPPORTUNITIES.md`, `docs/DIVERGENCE_OPPORTUNITIES_BASE_RATES.md`), and the owner's `EditTrades_Opportunity_Workflow_Refinement.docx` (summarised in 1c).

## 1. Problems

### 1a. GOOD calls can't pay their costs (priority 1)

Tracker evidence, 2026-09-24: 207 captures, 46 flag plans with levels, 1 GOOD in about 12 h.

| Flag timeframe | Plans | Median stop % | Gross ≥ 3R | Net ≥ 1 |
| --- | --- | --- | --- | --- |
| 1m | 22 | 0.16 | 1 | 0 |
| 3m | 15 | 0.29 | 0 | 1 |
| 5m | 9 | 0.37 | 0 | 1 |

The one GOOD, a BTC 1m short:
- entry 83,409.4 / stop 83,464.3 / tp1 83,228
- stop **0.066%** from entry
- gross RR 3.30, net RR **0.07**
- result: −1R gross, **−4.0R net**

It was `ready` because the gate is gross-only (`lib/flagTradePlan.js` ~L250–260, owner decision 1a). GOOD = a ready plan (`lib/flagRecommendation.js` `finish('GOOD','ready_flag_plan',…)`). Replays agree: on 1m–5m flags the retest entry is −0.32R net per trade, the breakout-close entry −0.65R and the early entry −0.65R (T4 P4, T5 P0).

The fee math. Round-trip cost `c` = 2 × (5 fee + 5 slippage bps) = **0.20%** of price (`config/engine.json` `risk`, `netRiskReward`). With stop `s` (% of price) and gross target `G·s`:
- cost in R = `c / s`
- netRR = `(G·s − c) / (s + c)`
- minimum stop for net `N` at gross `G`: `s_min = c·(1 + N) / (G − N)`

At G = 3 and c = 0.20%: net ≥ 1.5 needs **0.33%**; net ≥ 2 needs **0.60%**; net ≥ 2.5 needs 1.40%. Size and leverage don't change fees in R, since both scale with notional.

The fix has two levers:
- a net gate
- flags on timeframes whose stops are naturally wide: **15m/1h detection**. `flag.timeframes` is `['1m','3m','5m']`, although `model.flagTimeframes` already lists 15m/1h/4h.

A third lever, stop and target taken from higher-timeframe structure, is tested as an alternative.

### 1b. Workflow gaps (owner docx)

- **State clarity:** keep four layers separate: CONTEXT → PATTERN → TRIGGER → TRADE. A confirmed pattern is not an approved trade, and a failed long is not an automatic short.
- **Missing bridge:** a failed tracked flag should open a structured opposite-side **FAILED_FLAG_REVERSAL** scout. It requires a failed reclaim of the broken level, then its own room, R:R and net gates.
- **Live protocol:**
  - one tracked setup with one trigger, one thesis-null and a finite window
  - updates answer STATUS / FORMING / DELTA / TRIGGER-NULL / REVERSAL SCOUT / NEXT CHECK
  - WARNING (lower-timeframe damage) vs NULL (execution-timeframe invalidation)
  - every level tagged with its timeframe
  - MISSED / NO CHASE
  - stale triggers expire automatically
  - a direction change resets the tracker

### 1c. Carried over

- **60-day history:** `test/fixtures/history/deep60-2026-09-24/` is being captured (resumable). Phase 4 re-runs every measurement on it and rebuilds the `pathOutlook` table.
- **T5:** no early-entry OPPORTUNITY tier (net-negative). One net-positive combo (divergence agrees, not at a level, with the trend, retest entry, n=149) must be re-checked on 60 days.
- **Divergence alerts:** the owner wants to see divergence setups early. Ship them as **watch-only alerts** (no entry).

## 2. Hard rules (all phases; see also CLAUDE.md)

- **Stops and targets:**
  - Scalp stop guard ≤ 3% from entry mid; never raise it.
  - Gross `flagPlan.minRR` 3 is not lowered in any shipped variant. V4 below is research-only and needs an explicit owner decision.
  - The net gate is added, never a replacement.
- **Costs:** do not lower `feeBps`/`slippageBps` to manufacture calls. Cost realism is a separate decision based on real fills (journal) or the venue's fee schedule. Phase 0 may show a 0.14% sensitivity column for information only.
- **Serverless, MCP, security:**
  - No new `api/` file (12/12 functions).
  - MCP stays one read-only tool, with no execution imports.
  - REST auth unchanged (401/401/405/200).
  - No secrets in code, logs or payload.
  - No new dependencies.
- **Code shape:**
  - Long and short go through one path, with mirrored tests.
  - Payload and schema changes are additive minor bumps.
  - `openapi/scalp-context.yaml` stays in step.
  - `configVersion` is bumped for any config change.
- **Replay:**
  - No lookahead: production `buildScalpContext()` per close via `scripts/replay.js` primitives; never re-implement detectors.
  - Config variants use an in-process override hook (default off, covered by `test:config`).
  - Raw outputs go to gitignored paths.
  - `.vercelignore` keeps excluding `test/fixtures/history/`.
- **GPT instructions:** ≤ 7,990 units (`npm run check:gpt`; currently 7,984). Fund new rules by moving logic into engine-written fields and cutting redundant rules.
- **Repo and deploy:**
  - `public/index.html` untouched.
  - Read-only git uses `--no-optional-locks` (other sessions commit on this branch).
  - Test gate before any deploy: every `test:*` script in `package.json` + `npm run check:gpt` + `git diff --check`.
  - Deploy: commit, push, `npx vercel --prod --yes`, then `docs/EDITTRADES_MCP_CONNECTOR.md` "Verify after any redeploy" (401/401/405/200, schema/config, MCP tools/list = 1, build time).
  - Then `npm run tracker:sync`, push `../edittrades-tracker` with a normal commit so the page deploys, trigger `gh workflow run track -R Bai-ee/edittrades-tracker` once, and verify from git.
  - Never loop-poll https://edittrades-tracker.vercel.app (bot protection); at most one browser load.

## 3. Owner decisions

| # | Decision | Status |
| --- | --- | --- |
| D1 | Rule variant to ship | **Owner picks after Phase 0.** |
| D2 | Testing-window restart when Phase 1 ships | Approved: we're on day 2 and the only GOOD was invalid. |
| D3 | Venue cost realism | Keep 0.20% (no config change). Recorded 2026-09-24 from https://docs.jup.ag/user-docs/trade/perps/fees: open/close fee 0.06% each; price impact linear part negligible at small size (≈ $0.0008 per $10k SOL), plus an additive part only when open-interest imbalance exceeds a threshold (SOL cap 0.50%); borrow ≈ 0.024%/h at the doc's example utilization; swap fee 0.10% (non-stable) / 0.02% (stable) per swap when collateral differs from the position asset. Estimated round trip: ≈ 0.12–0.14% when collateral matches the position and holds are under 1 h; ≈ 0.32–0.34% when a long is funded with USDC (swap in and out); more under OI imbalance. So 0.20% sits mid-range and is not conservative for USDC-funded longs. Phase 0 reports a 0.14% and a 0.34% sensitivity column (information only). |
| D4 | Reversal scouts, divergence setups, breakout-close entry | Scout / watch / shadow only, never GO IN, until a replay is net-positive at n ≥ 100 in both out-of-sample halves AND the owner approves. |

## 4. Phases

### Phase 0 — Replay study of rule variants (research; no deploy) → STOP for D1

**Data:**
- `test/fixtures/history/deep-2026-09-24/` (15 days, BTC/ETH/SOL; 3m derived).
- Check that each variant's timeframes reach `replay.minComputeCandles` at the start: warm up by starting later if 15m/1h is short.
- Use `deep60-2026-09-24/` if its `manifest.json` exists.

**Runner:** `scripts/replay-rules.js` (`npm run replay:rules`, tests `test:rules`).
- Deep-merge each variant's config into `ENGINE_CONFIG` through a new override hook in `config/engine.js` (default off).
- Step every 5 minutes of the 1m clock unless compute allows 1.
- Per close, per symbol: collect `flagTradePlan` + `flagRecommendation`; dedupe per symbol + candidateId (first `ready`).
- Score each GOOD with the tracker walk (`scripts/tracker/walk-outcome.js`, production fill rules, TP1 vs stop, 24 h).
- Gross and **net** R: cost = entry × 0.20%; net R = (move − cost) / (risk + cost); stop = −1 net; same as `scripts/tracker/costs.js`.

**Net gate as shippable code:** `flagPlan.minNetRR` (null = off).
- After the gross gate, `netRR < minNetRR` → `status: 'rejected'`, `reasonCode: 'net_rr_below_min'` (levels kept).
- With the default off, production is unchanged: all existing suites pass unchanged.

**Variants:**

| id | Change |
| --- | --- |
| V0 | baseline |
| V1a / b / c | net gate 1.0 / 1.5 / 2.0 |
| V2 | `flag.timeframes` + 15m, 1h (gates unchanged) |
| V3a / b | V2 + net gate 1.5 / 2.0 |
| V4 (research only) | V3a with gross minRR 2.5, only if V3 leaves too few calls; shipping it needs an explicit owner decision |
| V5 | 1m–5m trigger, stop beyond the nearest 15m structure / zone (+ buffer), target next 15m/1h level or measured move, gross ≥ 3 + net gate 1.5 (horizon `swing`) |
| V6 | V1b + ATR floor: stop ≥ 0.5 × ATR(15m), target 3 × stop |
| V7 (scout research) | FAILED_FLAG_REVERSAL: broken level fails to reclaim within N ∈ {1, 2, 3} candles; stop beyond the reclaim extreme; target the next opposing zone; net gate 1.5 |

**Metrics** (overall, per symbol, per flag timeframe, long vs short):
- GOOD calls/day, fill rate, win rate at TP1
- **net expectancy R**, gross expectancy R
- max losing streak, median stop %, median minutes to resolution
- share of days with ≥ 1 GOOD
- 0.14% and 0.34% cost sensitivity columns (information only; see D3)

**Out-of-sample rule:** report days 1–10 and 11–15 separately (60-day: first 40 / last 20). A variant **passes** only if net expectancy > 0 in BOTH halves and n ≥ 20 scored GOOD calls.

**Output:** `docs/GOOD_QUALITY_REPLAY.md`:
- method and span
- the variants × metrics table, the out-of-sample table, the per-timeframe table
- payload size and build time for V2/V3 (15m/1h detection) vs V0
- **one recommended variant** with reasons, and the V7 verdict

**Stop:** commit (no deploy) and report. **Wait for the owner's pick (D1).**

### Phase 1 — Ship the chosen variant + restart the window (engine + tracker; deploy)

- **Config:** `flagPlan.minNetRR`, `flag.timeframes` per the chosen variant, V5/V6 parameters if chosen; configVersion bump.
- **`lib/flagTradePlan.js`:**
  - net gate on
  - publish `costR`
  - reason codes `net_rr_below_min` and `stop_inside_costs` (cost ≥ 0.5R)
  - `horizon: 'scalp' | 'swing'` if V5 is chosen
  - every level tagged with its timeframe
- **`lib/flagRecommendation.js`:**
  - net rejections follow the existing rejection mapping
  - `changeConditions` names the net requirement
  - support / oppose tokens `net_rr_ok` / `fees_heavy`
  - GOOD still requires a ready plan
- **If 15m/1h flags ship:** check `lib/patternDetector.js` per-timeframe assumptions, `patternLifecycle.geometryTimeframeFor`, `lib/pathOutlook.js` backoff for unseen timeframes (must fall back, never throw), `candidateQualifier`, `lib/breakoutEntry.js`, tracker alerts / charts (15m/1h already accepted), payload size (compact must still trim; raise caps minimally, ≤ 80,500 B, with a comment) and build time (p50 of 20 builds, well under the 10 s Hobby limit).
- **Schema + openapi:** additive minor bump (a new reasonCode value counts).
- **GPT (minimal now; full rewrite in Phase 3):** the flag timeframe list, plus one clause "GOOD requires net R:R ≥ X after costs", within budget.
- **Tracker window restart:**
  - `scripts/tracker/build-page.js`: `PHASE_NAME` → "Phase 5 forward record (net-gated rules)", `PHASE_START` → the deploy date (UTC), keep 14 days / 30 plans.
  - Note id `testing-phase-restart-note`: "Window restarted <date>: GOOD now requires net R:R ≥ X and flags on <timeframes>. Earlier calls kept for reference."
  - Aggregates `phase` uses `phaseStartMs`; nothing deleted.
  - Ready plans split by `horizon`.
- **Tests:**
  - the BTC 0.066% short → rejected (`stop_inside_costs` / `net_rr_below_min`)
  - a passing plan
  - long and short mirrored
  - fixtures updated
  - the page shows the restart note
- **Deploy and verify** per section 2.
- **Docs:** CHANGELOG, connector schema map and test counts, openapi, DOCUMENTATION_INDEX, decisions doc (net gate supersedes decision 1a), this plan's status.

### Phase 2 — State model, tracking, reversal scouts, divergence alerts (engine + tracker; deploy)

**Engine** (the engine writes the text; the GPT prints it):

- `symbols.<SYM>.state = {context, setup, trigger, trade, label}`:
  - `context`: with/counter-trend vs 4h; room open / blocked to the nearest 15m/1h zone, with timeframe-tagged levels
  - `setup`: leading candidate id, timeframe, direction, pattern state
  - `trigger`: exactly one condition string, timeframe-tagged
  - `trade`: GO IN / HOLD-WAIT / DON'T, with the plan `reasonCode`
  - `label`: TRACKING | WARNING | FAILED | REVERSAL_SCOUT | REVERSAL_TRIGGERING | READY | MISSED | EXPIRED
- `lib/reversalScout.js` builds `symbols.<SYM>.reversalScouts[]` from candidates that failed within `failedTtlCandles` (`failReason` acceptance / invalidation_close):
  - `sourceCandidateId`, `failureReason`, `direction` (opposite), `state` (scouting / triggering / confirmed / rejected / expired)
  - `brokenLevel`, `reclaimWindow`, `entryCondition`, `invalidation`
  - `nearestTarget` (a real zone, never an EMA)
  - `grossRR`, `netRR`, `reasonCode`
  - Scout-only (D4); rules per the V7 verdict.
- **MISSED:** price reached the next zone without a valid trigger. The label says NO CHASE.
- **Tracking:** REST `GET /api/scalp-context?track=<candidateId>` (parsed after auth, like `chart`) adds `tracked = {id, status: alive | weakening | confirmed | failed | expired, delta (one line: what changed over the last N closed execution-timeframe candles), trigger, thesisNull, reversalScout, nextCheck, expiresAt}`. Stateless: the GPT carries the id from its previous reply. MCP args unchanged.

**Tracker:**
- Reversal scouts scored as their own class: realised path, net R on the scout's own levels.
- Watch-only divergence alerts in `scripts/tracker/alerts.js`: fresh divergence agreeing with a forming flag near a support/resistance zone. The text names the setup, trigger and thesis-null, and never gives an entry.

**Tests:**
- the docx BTC sequence: rejected breakout at 84,866.5 → WARNING → FAILED on acceptance below → REVERSAL_SCOUT → MISSED in the ~83.93k support
- scout gates
- `track`: auth unchanged, unknown id → `tracked: null`
- byte caps

### Phase 3 — GPT instructions rewrite (docs; owner pastes into the new GPT)

- Rewrite `docs/GPT_INSTRUCTIONS.md` around CONTEXT / PATTERN / TRIGGER / TRADE. Print `state`, `tracked`, `pathOutlook` SCENARIO and `reversalScouts` verbatim.
- Formats:
  - default update: STATUS / FORMING / DELTA / TRIGGER / THESIS NULL / REVERSAL SCOUT / NEXT CHECK
  - TRACK mode and REVERSAL TRACK mode per the docx
  - MISSED / NO CHASE; WARNING vs NULL
  - timeframe-tag every level
  - reset on direction change
  - never invent percentages; `breakoutEntry` is never mentioned
- Budget: fund it by deleting rules the engine now answers, until `npm run check:gpt` is OK.
- Test sheet: the docx BTC scenarios, a fee-rejected plan, a swing-horizon ready plan (if V5 ships), a 15m/1h flag (if V2/V3 ships), a MISSED case.
- Hand the owner a short test script for the new GPT: prompts plus pass criteria.

### Phase 4 — 60-day recalibration (analysis + config; deploy only if tables change)

- When `deep60-2026-09-24/manifest.json` exists: re-run `replay-rules` (the shipped variant vs V0, 60-day out-of-sample halves), `replay-paths`, `replay-early-entry` and `replay-breakout-entry`.
- Rebuild the table with `npm run paths:table`, including the new flag timeframes. Bump configVersion only if it changes.
- Update the base-rate docs.
- Re-check the T5 positive combo and the V7 verdict.
- Report candidates for promotion (net-positive, n ≥ 100, both halves). Promotion itself is an owner decision.

### Phase 5 — Path-informed gating (conditional; research only)

Precondition, checked first; if not met, record the numbers in this plan's status and stop:
- ≥ 7 days since the Phase 1 restart
- `#path-calibration-section` shows the Brier score below baseline and a likely-path hit rate above the base rate on ≥ 50 resolved flags, with chase/runner reliability published

If met, run `scripts/replay-rules.js` on top of the shipped rules:
- **C1:** GOOD also requires `pathOutlook.likely ∉ {fail_first, false_break}`.
- **C2:** runner-prone (chase elevated/high) → score the breakout-close entry (`lib/breakoutEntry.js`). Note: T4 P4 replay was net-negative.
- **C3:** C1 + C2.

Same metrics and out-of-sample rule. Append to `docs/GOOD_QUALITY_REPLAY.md`, recommend, stop. Shipping repeats Phase 1's procedure.

## 5. Out of scope

Changing cost assumptions without evidence; raising the 3% stop cap; 4h/1d flags; auto-tuning; execution.

## 6. Risks

- The net gate cuts GOOD count on 1m–5m; 15m/1h flags are meant to restore it, and Phase 0 measures whether they do.
- 15 days is about 360 1h candles, so the 1h out-of-sample halves are thin. Report n honestly and use 60 days in Phase 4.
- More flag timeframes means more payload and build time; measured in Phase 1.
- The GPT budget is nearly full; Phase 3 depends on moving logic into engine fields.
- The window restart resets the 14-day clock (approved, D2).

## 7. Definition of done

- A plan whose costs exceed its edge is never `ready` (the BTC 0.066% case proves it).
- GOOD calls come from the chosen, replay-validated rules, including 15m/1h flags if chosen, and the testing window has restarted.
- Every symbol carries the four-layer `state` with one trigger and timeframe-tagged levels.
- Failed flags produce reversal scouts; MISSED is explicit; `?track=` works.
- The new GPT prints all of it within budget.
- The tracker shows net-first stats, the restart note, the horizon split, reversal scouts, calibration and watch-only divergence alerts.
- Every phase deployed and verified; docs current.
