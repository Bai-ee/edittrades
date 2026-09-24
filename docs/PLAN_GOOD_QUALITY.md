> **Superseded 2026-09-24 by `docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`** (Steps A/B/C = T6 Phases 0/1/5). Kept for reference; do not execute from this file.

# (former T5) — GOOD call quality: net-of-cost gate, higher-timeframe flags, path-informed gating

Last updated: 2026-09-24
Status: plan approved by owner, not started. Three steps, each with a hard stop for owner review. Step B needs the owner to pick a variant from Step A's table. Step C only runs if its evidence gate passes.
Branch: `upgrade-signal-engine`. Tracker repo: `../edittrades-tracker`.

## Problem (evidence, 2026-09-24 tracker data)

207 captures, 46 flag plans with levels, 1 GOOD in ~12 h (BTC 1m short, stopped out).

| Flag TF | plans | median stop % | gross ≥ 3R | net ≥ 1 |
| --- | --- | --- | --- | --- |
| 1m | 22 | 0.16 | 1 | 0 |
| 3m | 15 | 0.29 | 0 | 1 |
| 5m | 9 | 0.37 | 0 | 1 |

- Round-trip cost in the engine is `2 × (feeBps 5 + slippageBps 5)` = **0.20 % of price** (`lib/flagTradePlan.js` `netRiskReward`, `config/engine.json` `risk`).
- At the gross 3R gate (`flagPlan.minRR = 3`), net R:R ≥ 1.5 needs stop ≥ ~0.33 % of price; net ≥ 2 needs ~0.6 %. 1m/3m/5m flag stops are mostly below that, so almost every plan that passes the gross gate is uneconomic after costs. The one GOOD had net R:R 0.066.
- Flags are only detected on `flag.timeframes = ['1m','3m','5m']` (`config/engine.json`), although `model.flagTimeframes` already lists 15m/1h/4h.
- GOOD = a `ready` flagTradePlan (`lib/flagRecommendation.js` → `finish('GOOD', 'ready_flag_plan', …)`); `ready` is gated on the 3 % scalp stop cap and gross R:R only (`lib/flagTradePlan.js` ~L250–260).

## Hard rules (all steps)

- Scalp stop guard stays ≤ 3 % from entry mid; never raise it. MCP stays one read-only tool; no execution imports. REST auth 401/401/405/200 unchanged. No secrets in code, logs, payload.
- Direction symmetry: every change handles long and short through one path, with mirrored tests.
- Payload/schema changes are additive minor bumps; keep `openapi/scalp-context.yaml` in step; bump `configVersion` for any config change.
- Do not lower `feeBps`/`slippageBps` to manufacture calls. Cost realism is a separate, evidence-based decision (Out of scope).
- Replay has no lookahead: use `scripts/replay.js` (production `buildScalpContext()` per close) — never re-implement detectors.
- `CLAUDE.md` test gate before any deploy: all eleven suites plus `test:tracker`, `test:served`, `test:journal`, and every T4 suite in `package.json` (`test:outlook`, `test:breakout`, …). `npm run check:gpt` whenever `docs/GPT_INSTRUCTIONS.md` changes (≤ 7,990 units).
- Use `git --no-optional-locks` for read-only git; other sessions commit on this branch.

---

## Step A — Replay study (research only; no engine, config or deploy change)

Goal: measure, on existing history, how each rule variant changes GOOD count and net quality, so the owner picks with evidence instead of waiting 14 days.

### Data
- `test/fixtures/history/deep-2026-09-24/` — 15 days (2026-09-09 → 09-24), BTC/ETH/SOL, 1m (21.6k), 5m, 15m, 1h, 4h, 1d; 3m derived from 1m in production code. Check `manifest.json` per file.
- Verify each variant's timeframes meet `replay.minComputeCandles` at the replay start; if 1h/15m depth is short, start the replay later (warm-up) or extend history with `node scripts/replay.js --capture BTC,SOL,ETH --out test/fixtures/history/<new>/` (Kraken OHLC gives 720 rows/tf: 1h ≈ 30 days). Do not commit new history > what `.vercelignore`/`.gitignore` already allow; check them.

### Variant runner
New `scripts/replay-rules.js` (+ `npm run replay:rules`): for each variant, run the production pipeline over the history with an **in-process config override** (deep-merge into `ENGINE_CONFIG` before `buildScalpContext`; read `config/engine.js` first to see how config is loaded/frozen; if it is frozen, add a test-only override hook there, default off, covered by `test:config`). Step every 5 min of the 1m clock (`--step 5`) unless compute allows 1.
For each close collect the per-symbol `flagTradePlan` + `flagRecommendation`; dedupe calls per symbol+candidateId (first `ready` only); score each GOOD with the tracker's walk (`scripts/tracker/walk-outcome.js` / `scripts/replay-outcomes.js` `walkOutcome`: entry fill rules as in production, TP1 vs stop, 24 h window).

Report R both gross and **net** (net R per trade = (exit − entry)·sign − cost, divided by (risk + cost), cost = entry × 0.20 %; stop = −(risk+cost)/(risk+cost) = −1 net R; TP1 = net reward/net risk).

### Variants
| id | change |
| --- | --- |
| V0 | baseline (current config) |
| V1a / V1b / V1c | GOOD also requires `netRR ≥ 1.0 / 1.5 / 2.0` (plan rejected with new reason `net_rr_below_min`) |
| V2 | `flag.timeframes` + `15m`, `1h` (gates unchanged) |
| V3a / V3b | V2 + net gate 1.5 / 2.0 |
| V4 (optional) | V3a with `flagPlan.minRR` 2.5 (only if V3 leaves too few calls) |

Implement the net gate for the study as the same code Step B will ship (a config key, default off = baseline), so Step B is a config flip plus tests, not a rewrite.

### Metrics per variant (overall, per symbol, per flag TF, long vs short)
GOOD calls/day, fill rate, win rate at TP1, **net expectancy R**, gross expectancy R, max losing streak, median stop %, median minutes to resolution, share of days with ≥ 1 GOOD.
**Out-of-sample:** report days 1–10 and days 11–15 separately; a variant only "passes" if net expectancy > 0 in BOTH halves and n ≥ 20 scored GOOD calls overall.

### Output
`docs/GOOD_QUALITY_REPLAY.md`: method, history span, one comparison table (variants × metrics), OOS table, per-TF table, 3 example GOOD charts per passing variant are optional (skip if slow), and a **recommendation** (one variant) with the reasoning. Raw JSONL to a gitignored path.
Tests: `test:rules` (new) for the runner's override, dedupe and net-R math (long/short mirrored), and that V0 reproduces current production output on a small fixture.

### Stop A
Commit (no deploy). Report the table and recommendation. **Wait for the owner to choose the variant.**

---

## Step B — Ship the chosen variant + restart the testing window

Inputs: the owner's chosen variant id from Step A.

### Engine
- `config/engine.json`: `flagPlan.minNetRR` (new, from the variant; null = off), `flag.timeframes` per variant. `configVersion` bump.
- `lib/flagTradePlan.js`: after the gross gate, `netRR < minNetRR` → `status: 'rejected'`, `reasonCode: 'net_rr_below_min'` (same shape as `rr_below_min`, levels kept). Mirrored tests in `test:flagplan`.
- `lib/flagRecommendation.js`: treat `net_rr_below_min` like other rejections (BAD/WATCH per existing mapping); `changeConditions` text names the net requirement. Tests in `test:flagrec` + fixtures.
- If the variant adds 15m/1h flags: check `lib/patternDetector.js` config assumptions (impulse/flag candle counts are per-TF candles, fine), `lib/patternLifecycle.js` `geometryTimeframeFor` (15m→15m, 1h→1h is OK), `lib/pathOutlook.js` bucket backoff for unseen TFs (must fall back, never throw), `candidateQualifier`, alerts/chart timeframe (tracker `alerts.js` already accepts 15m/1h), payload size (measure default 3-symbol payload before/after; `compact` must still trim), build time (log p50 over 20 builds; must stay well under the 10 s Hobby limit).
- `services/scalpContext.js`: no logic change expected beyond config; verify `candidateSetups` include the new TFs and `decisionTrace` tokens render.
- Schema: additive minor bump if any payload field/enum changes (new reasonCode value counts). `openapi/scalp-context.yaml`.
- `docs/GPT_INSTRUCTIONS.md`: replace "1m/3m/5m" flag wording with the new TF list and add one clause that GOOD requires net R:R ≥ X after costs, within 7,990 units (`npm run check:gpt`). Update the test-sheet lines that mention 1m/3m/5m. **Owner must paste the new instructions into the Custom GPT** — say so in the report.

### Tracker (window restart)
- `scripts/tracker/build-page.js`: `PHASE_NAME` → `'Phase 5 forward record (net-gated rules)'` (or per variant), `PHASE_START` → the deploy date (UTC), keep 14 days / 30 plans. Add a one-line note in the testing tile: "Window restarted <date>: GOOD now requires net R:R ≥ X and flags on <TFs>. Earlier calls kept for reference." Stable id `testing-phase-restart-note`.
- Aggregates already compute `phase` from `phaseStartMs`; confirm class check and hero use it. No data deletion.
- Tests: page renders the note; phase counts start at the new date.

### Deploy + verify
Full test gate → commit → push → `npx vercel --prod --yes` → `docs/EDITTRADES_MCP_CONNECTOR.md` "Verify after any redeploy" (401/401/405/200, schema, MCP one tool, build time) → `npm run tracker:sync` → push tracker repo (normal commit so the page deploys) → trigger `track` once → confirm the page shows the restart note and new PHASE_START. Do not loop-poll the Vercel tracker URL (bot protection); verify from git and at most one browser load.
Docs: CHANGELOG, connector doc (schema map, test counts), master plan phase map, DOCUMENTATION_INDEX, this plan's status line.

### Stop B
Report: files, exact behaviour change, before/after payload size and build time, test counts, deploy verification, and the reminder to paste GPT instructions.

---

## Step C — Path-informed gating (conditional on evidence)

Precondition (check first; if not met, write the numbers into this plan's status line and stop):
- ≥ 7 days since Step B's restart, and the tracker's `#path-calibration-section` (`scripts/tracker/calibration.js`) shows the path outlook beating baseline: Brier score below baseline and likely-path hit rate above base rate on ≥ 50 resolved flags, and chase/runner reliability published.

If met:
1. Replay study (reuse `scripts/replay-rules.js`) of gates on top of the Step B rules:
   - C1: GOOD also requires `pathOutlook.likely ∉ {fail_first, false_break}`.
   - C2: when `pathOutlook` is runner-prone (chase elevated/high) and a `breakoutEntry` shadow plan exists, score the breakout-close entry instead of waiting for the retest (P4 shadow, `lib/breakoutEntry.js`) — GOOD from either entry.
   - C3: C1 + C2.
   Same metrics, same OOS rule, compared against the Step B rules on the same span. Append to `docs/GOOD_QUALITY_REPLAY.md`.
2. Stop and report. The owner decides; shipping a C variant repeats Step B's ship + window-restart procedure (config flag, tests, GPT wording, deploy, restart note).

## Out of scope
Changing fee/slippage assumptions (needs real fills from the journal first); raising the 3 % stop cap; 4h/1d flags; auto-tuning; execution.

## Risks
- Fewer GOOD calls after the net gate on 1m–5m; 15m/1h flags are what should restore count — Step A measures whether they do.
- 15m/1h history is short (15 days ≈ 360 1h candles); OOS halves may be thin for 1h. Report n honestly; don't claim significance.
- Payload growth and build time with more flag TFs; measured in Step B.
- GPT instruction budget is nearly full (7,984/7,990); wording must be funded by trims elsewhere.
- Restarting the window resets the 14-day clock; accepted by the owner.
